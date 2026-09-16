#!/usr/bin/env tsx
/**
 * Import cookies from Firefox's cookies.sqlite into Playwright format.
 * Usage: npx tsx scripts/import-firefox-cookies.ts
 *
 * Copies the Firefox DB (avoids lock), filters trusted domains, converts
 * to Playwright cookie format, and saves to .cookies/<domain>.json.
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";

const DATA_DIR = process.env.USER_DATA_PATH || process.cwd();
const COOKIE_DIR = path.join(DATA_DIR, ".cookies");
const FIREFOX_DIR = path.join(
  process.env.HOME || "/home/lucas",
  ".mozilla/firefox"
);

// Domínios confiáveis (mesmo de trustedDomains.ts)
const TRUSTED_DOMAINS = [
  "mercadolivre.com.br",
  "mercadolivre.com",
  "amazon.com.br",
  "amazon.com",
  "kabum.com.br",
  "pichau.com.br",
  "terabyteshop.com.br",
  "magazineluiza.com.br",
  "casasbahia.com.br",
  "pontofrio.com.br",
  "extra.com.br",
  "fastshop.com.br",
  "girafa.com.br",
  "carrefour.com.br",
  "americanas.com.br",
  "aliexpress.com",
  "pt.aliexpress.com",
  "shopee.com.br",
];

// Firefox sameSite integer → Playwright string
function sameSiteMap(val: number): "None" | "Lax" | "Strict" {
  if (val === 2) return "Strict";
  if (val === 1) return "Lax";
  return "None";
}

function findFirefoxProfile(): string | null {
  if (!fs.existsSync(FIREFOX_DIR)) return null;
  const profiles = fs.readdirSync(FIREFOX_DIR).filter((f) => {
    const ini = path.join(FIREFOX_DIR, "profiles.ini");
    return fs.existsSync(ini);
  });

  // Read profiles.ini to find default-release profile
  const iniPath = path.join(FIREFOX_DIR, "profiles.ini");
  if (fs.existsSync(iniPath)) {
    const ini = fs.readFileSync(iniPath, "utf-8");
    // Find path= line under [Profile] with Default=1 or Name=default-release
    const lines = ini.split("\n");
    let currentPath = "";
    let isDefault = false;
    for (const line of lines) {
      if (line.startsWith("Path=")) {
        currentPath = line.slice(5);
        isDefault = false;
      }
      if (line.includes("Default=1") || line.includes("Name=default-release")) {
        isDefault = true;
      }
      if (currentPath && isDefault) {
        const fullPath = path.join(FIREFOX_DIR, currentPath);
        if (fs.existsSync(path.join(fullPath, "cookies.sqlite"))) {
          return fullPath;
        }
      }
    }
  }

  // Fallback: find any profile with cookies.sqlite
  const dirs = fs.readdirSync(FIREFOX_DIR);
  for (const dir of dirs) {
    const dbPath = path.join(FIREFOX_DIR, dir, "cookies.sqlite");
    if (fs.existsSync(dbPath)) return path.join(FIREFOX_DIR, dir);
  }
  return null;
}

function domainToFilename(domain: string): string {
  return domain.replace(/\./g, "_");
}

function matchDomain(host: string, domain: string): boolean {
  // host = ".mercadolivre.com.br", domain = "mercadolivre.com.br"
  const cleanHost = host.replace(/^\./, "");
  return (
    cleanHost === domain ||
    cleanHost.endsWith("." + domain) ||
    domain.endsWith("." + cleanHost) ||
    host === domain
  );
}

async function main() {
  console.log("[import-firefox-cookies] Procurando perfil Firefox...");
  const profileDir = findFirefoxProfile();
  if (!profileDir) {
    console.error("[import-firefox-cookies] Nenhum perfil Firefox encontrado!");
    process.exit(1);
  }

  const dbPath = path.join(profileDir, "cookies.sqlite");
  console.log(`[import-firefox-cookies] Perfil: ${profileDir}`);
  console.log(`[import-firefox-cookies] DB: ${dbPath}`);

  // Copy DB to avoid lock
  const tmpDb = path.join("/tmp/opencode", "firefox_cookies_import.sqlite");
  fs.mkdirSync(path.dirname(tmpDb), { recursive: true });
  fs.copyFileSync(dbPath, tmpDb);
  console.log("[import-firefox-cookies] DB copiado (evitando lock)");

  // Query cookies for trusted domains
  const hosts = TRUSTED_DOMAINS.map((d) => `'%' || '${d}' || '%'`).join(" OR ");
  const query = `
    SELECT host, name, value, path, expiry, isSecure, isHttpOnly, sameSite
    FROM moz_cookies
    WHERE expiry > ${Math.floor(Date.now() / 1000)}
    AND (host LIKE ${TRUSTED_DOMAINS.map((d) => `'%.${d}'`).join(" OR host LIKE ")})
    ORDER BY host;
  `;

  let rows: string;
  try {
    rows = execSync(`sqlite3 -json "${tmpDb}" "${query.replace(/"/g, '\\"')}"`, {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (e: any) {
    console.error("[import-firefox-cookies] Erro ao ler DB:", e.message);
    process.exit(1);
  }

  const cookies = JSON.parse(rows);
  console.log(`[import-firefox-cookies] ${cookies.length} cookies encontrados`);

  if (cookies.length === 0) {
    console.log("[import-firefox-cookies] Nenhum cookie para importar");
    process.exit(0);
  }

  // Group by domain
  const byDomain = new Map<string, any[]>();
  for (const cookie of cookies) {
    for (const domain of TRUSTED_DOMAINS) {
      if (matchDomain(cookie.host, domain)) {
        if (!byDomain.has(domain)) byDomain.set(domain, []);
        byDomain.get(domain)!.push({
          name: cookie.name,
          value: cookie.value,
          domain: cookie.host,
          path: cookie.path || "/",
          expires: cookie.expiry > 0 ? cookie.expiry : -1,
          httpOnly: cookie.isHttpOnly === 1,
          secure: cookie.isSecure === 1,
          sameSite: sameSiteMap(cookie.sameSite),
        });
        break;
      }
    }
  }

  // Save each domain
  if (!fs.existsSync(COOKIE_DIR)) fs.mkdirSync(COOKIE_DIR, { recursive: true });

  let total = 0;
  for (const [domain, domainCookies] of byDomain) {
    const filename = domainToFilename(domain);
    const filePath = path.join(COOKIE_DIR, `${filename}.json`);

    // Merge with existing cookies (avoid duplicates)
    let existing: any[] = [];
    if (fs.existsSync(filePath)) {
      try {
        existing = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      } catch {}
    }

    const merged = [...existing];
    for (const cookie of domainCookies) {
      const idx = merged.findIndex(
        (e) => e.name === cookie.name && e.domain === cookie.domain && e.path === cookie.path
      );
      if (idx >= 0) {
        merged[idx] = cookie; // replace
      } else {
        merged.push(cookie);
      }
    }

    fs.writeFileSync(filePath, JSON.stringify(merged, null, 2));
    console.log(`  ✓ ${domain}: ${domainCookies.length} cookies (${merged.length} total)`);
    total += domainCookies.length;
  }

  // Cleanup
  try { fs.unlinkSync(tmpDb); } catch {}

  console.log(`\n[import-firefox-cookies] Concluído! ${total} cookies importados para ${byDomain.size} domínios`);
}

main().catch((e) => {
  console.error("[import-firefox-cookies] Erro fatal:", e);
  process.exit(1);
});
