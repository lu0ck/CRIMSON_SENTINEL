import express from "express";
import path from "path";
import fs from "fs";
import { Mutex } from "async-mutex";
import { fileURLToPath } from "url";
import { scrapeProductInfo } from "./src/lib/gemini.ts";
import { 
  sendDiscordNotification, 
  sendTelegramNotification, 
  sendEmailNotification 
} from "./src/lib/notifications.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const safeLog = (msg: any) => {
  console.log(typeof msg === 'string' ? msg : JSON.stringify(msg));
};

function normalizeProductUrl(url: string): string {
  try {
    const parsed = new URL(url);
    
    const trackingParams = [
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'ref', 'affiliate', 'src', 'source', 'fbclid', 'gclid', 'msclkid',
      'cmp', 'abtest', 'utm_source', 'utm_medium', 'promo', 'category'
    ];
    trackingParams.forEach(param => parsed.searchParams.delete(param));
    
    parsed.hash = '';
    
    const productIdPatterns = [
      { pattern: /\/produto\/(\d+)/, format: (m: RegExpMatchArray) => `/produto/${m[1]}` },
      { pattern: /\/dp\/([A-Z0-9]+)/, format: (m: RegExpMatchArray) => `/dp/${m[1]}` },
      { pattern: /\/MLB-(\d+)/, format: (m: RegExpMatchArray) => `/MLB-${m[1]}` },
      { pattern: /\/p\/([a-z0-9]+)/i, format: (m: RegExpMatchArray) => `/p/${m[1]}` },
      { pattern: /\/product\/(\d+)/, format: (m: RegExpMatchArray) => `/product/${m[1]}` },
      { pattern: /\/(\d+)\/p/, format: (m: RegExpMatchArray) => `/${m[1]}/p` },
      { pattern: /\/sku\/([A-Z0-9]+)/i, format: (m: RegExpMatchArray) => `/sku/${m[1]}` },
    ];
    
    for (const { pattern, format } of productIdPatterns) {
      const match = parsed.pathname.match(pattern);
      if (match) {
        parsed.pathname = format(match);
        break;
      }
    }
    
    return parsed.toString();
  } catch {
    return url;
  }
}

function generateProductId(url: string): string {
  const normalized = normalizeProductUrl(url);
  let hash = 0;
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

// Use USER_DATA_PATH for Electron production, or current dir for dev
const DATA_DIR = process.env.USER_DATA_PATH || (process.env.NODE_ENV === 'production' ? '/tmp' : __dirname);

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DATA_FILE = path.join(DATA_DIR, "data.json");
const dataMutex = new Mutex();

// Initialize data file if it doesn't exist
if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({
    profiles: [],
    lists: [],
    products: [],
    notifications: []
  }, null, 2));
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API Routes
  app.get("/api/data", (req, res) => {
    safeLog('GET /api/data requested');
    try {
      if (!fs.existsSync(DATA_FILE)) {
        safeLog('Data file not found, returning empty state');
        return res.json({ profiles: [], lists: [], products: [] });
      }
      const content = fs.readFileSync(DATA_FILE, "utf-8");
      safeLog('Data file read success, size: ' + content.length);
      if (!content || !content.trim()) {
        return res.json({ profiles: [], lists: [], products: [] });
      }
      const data = JSON.parse(content);
      res.json(data);
    } catch (error) {
      safeLog("Error reading data file: " + error);
      res.status(500).json({ error: "Failed to read database" });
    }
  });

  app.post("/api/data", async (req, res) => {
    const release = await dataMutex.acquire();
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(req.body, null, 2));
      res.json({ status: "ok" });
    } catch (error) {
      safeLog("Error saving data: " + error);
      res.status(500).json({ error: "Failed to save data" });
    } finally {
      release();
    }
  });

  app.post("/api/products", async (req, res) => {
    const release = await dataMutex.acquire();
    try {
      const product = req.body;
      const content = fs.readFileSync(DATA_FILE, "utf-8");
      const data = JSON.parse(content || '{"profiles":[],"lists":[],"products":[]}');
      
if (!data.products) data.products = [];

// Prevent duplicates by normalized URL and listId
    const normalizedUrl = normalizeProductUrl(product.url);
    const normalizedId = generateProductId(product.url);

    safeLog("[Product] Checking: url=" + normalizedUrl + ", id=" + normalizedId);

    const exists = data.products.some((p: any) => {
      const normalizedExisting = normalizeProductUrl(p.url);
      const urlMatch = normalizedExisting === normalizedUrl;
      const idMatch = p.id === normalizedId;
      safeLog("[Product] Compare with existing: " + p.id + " vs " + normalizedId + " (idMatch=" + idMatch + ")");
      return (urlMatch || idMatch) && p.listId === product.listId;
    });

    if (!exists) {
      // Use normalized ID if not provided
      if (!product.id || product.id.length < 8) {
        product.id = normalizedId;
      }
      data.products.push(product);
      fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
      safeLog("Product added: " + product.name + " to list " + product.listId + " (ID: " + product.id + ")");
    } else {
      safeLog("Product already exists: " + normalizedUrl + " in list " + product.listId);
    }
      
      res.json({ status: "ok" });
    } catch (error) {
      safeLog("Error adding product: " + error);
      res.status(500).json({ error: "Failed to add product" });
    } finally {
      release();
    }
  });

  app.post("/api/test-discord", async (req, res) => {
    const { webhookUrl } = req.body;
    try {
      await sendDiscordNotification(webhookUrl, "🚀 Crimson Sentinel: Teste de Conexão Discord bem-sucedido!");
      res.json({ status: "ok" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/test-telegram", async (req, res) => {
    const { botToken, chatId } = req.body;
    try {
      await sendTelegramNotification(botToken, chatId, "🚀 Crimson Sentinel: Teste de Conexão Telegram bem-sucedido!");
      res.json({ status: "ok" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/test-email", async (req, res) => {
    const { user, pass, to } = req.body;
    try {
      await sendEmailNotification(user, pass, to, "Crimson Sentinel: Teste de Conexão", "🚀 Crimson Sentinel: Teste de Conexão Gmail bem-sucedido!");
      res.json({ status: "ok" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

app.post("/api/scrape", async (req, res) => {
  const { url, profileId } = req.body;
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
    const profile = data.profiles.find((p: any) => p.id === profileId);

    // Debug: Log profile configuration
    safeLog("[Scrape] Profile config: lmStudioUrl=" + (profile?.lmStudioUrl || "NOT SET") + 
            ", useAdvancedScraping=" + (profile?.useAdvancedScraping || false) +
            ", nvidiaApiKey=" + (profile?.nvidiaApiKey ? "SET" : "NOT SET"));

    let info;

    // Usar advanced scrape se LM Studio ou Advanced Pipeline estiver configurado
    if (profile?.lmStudioUrl || profile?.useAdvancedScraping) {
      safeLog("[Scrape] Using advanced pipeline with LM Studio: " + (profile?.lmStudioUrl || "not configured"));
      const { advancedScrape } = await import("./src/lib/scraper.ts");
      info = await advancedScrape(url, {
        lmStudioUrl: profile?.lmStudioUrl,
        nvidiaApiKey: profile?.nvidiaApiKey,
        geminiApiKey: profile?.geminiApiKey || process.env.GEMINI_API_KEY
      });
    } else {
      // Fallback para Gemini simples
      try {
        safeLog("[Scrape] Using simple Gemini scrape");
        info = await scrapeProductInfo(url, profile?.geminiApiKey, profileId);
      } catch (geminiError) {
        safeLog("Simple Gemini scrape failed, trying advanced fallback: " + geminiError);
        const { advancedScrape } = await import("./src/lib/scraper.ts");
        info = await advancedScrape(url, {
          lmStudioUrl: profile?.lmStudioUrl,
          nvidiaApiKey: profile?.nvidiaApiKey,
          geminiApiKey: profile?.geminiApiKey || process.env.GEMINI_API_KEY
        });
      }
    }
    res.json(info);
} catch (error: any) {
		console.error("[SCRAPE ERROR] Full error:", error);
		console.error("[SCRAPE ERROR] Message:", error.message);
		console.error("[SCRAPE ERROR] Stack:", error.stack);
		safeLog("Scraping failed: " + error);
		res.status(500).json({
			error: error.message || "Scraping failed",
			details: error.stack || "No stack trace",
			fullError: String(error)
		});
	}
});

let isComparing = false;
const MIN_SEARCH_INTERVAL = 5000; // Reduced to 5 seconds
let lastSearchTime = 0;

const TRUSTED_DOMAINS = [
  "mercadolivre.com.br", 
  "amazon.com.br", 
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
  "americanas.com.br"
];

async function searchWithSerper(query: string, apiKey: string) {
  // Use a more efficient store filter instead of long site: list
  const storeFilter = "Mercado Livre OR Amazon OR Kabum OR Pichau OR Terabyte OR Magalu OR Casas Bahia OR Fast Shop";
  const optimizedQuery = `${query} (${storeFilter})`;
  
  const response = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": apiKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ q: optimizedQuery, gl: "br", hl: "pt-br", num: 8 })
  });
  const data = await response.json();
  return data.organic?.map((item: any) => ({
    title: item.title,
    link: item.link,
    snippet: item.snippet
  })) || [];
}

async function searchWithTavily(query: string, apiKey: string) {
  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ 
      api_key: apiKey,
      query: query,
      search_depth: "basic",
      include_domains: TRUSTED_DOMAINS
    })
  });
  const data = await response.json();
  return data.results?.map((item: any) => ({
    title: item.title,
    link: item.url,
    snippet: item.content
  })) || [];
}

app.post("/api/compare", async (req, res) => {
    const { productName, profileId } = req.body;
    
    const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
    const profile = data.profiles.find((p: any) => p.id === profileId);
    const finalApiKey = profile?.geminiApiKey || process.env.GEMINI_API_KEY;
    
    // Global throttle to prevent concurrent searches and respect rate limits
    if (isComparing) {
      return res.status(429).json({ error: "SYSTEM BUSY: Another search is in progress. Please wait." });
    }

    const now = Date.now();
    const timeSinceLastSearch = now - lastSearchTime;
    if (timeSinceLastSearch < MIN_SEARCH_INTERVAL) {
      const waitRemaining = Math.ceil((MIN_SEARCH_INTERVAL - timeSinceLastSearch) / 1000);
      return res.status(429).json({ error: `COOLING DOWN: Please wait ${waitRemaining}s before next search.` });
    }

    isComparing = true;
    lastSearchTime = now;

    try {
      safeLog(`Comparing product: ${productName}`);

      const systemInstruction = `Você é o SENTINEL, um agente de inteligência de mercado de elite. 
      Sua missão é extrair preços REAIS e ATUAIS de produtos no mercado brasileiro com precisão cirúrgica.
      
      DIRETRIZES DE EXTRAÇÃO:
      1. FONTES CONFIÁVEIS: Mercado Livre, Amazon.com.br, Magalu, Casas Bahia, Terabyteshop, Pichau e Kabum.
      2. PROIBIDO: Shopee, AliExpress, sites de cupons, fóruns ou anúncios de usados.
      3. ESTOQUE: Extraia APENAS se o produto estiver claramente EM ESTOQUE.
      4. PREÇO À VISTA: Extraia o MENOR PREÇO PARA PAGAMENTO IMEDIATO (Pix ou Boleto). 
      5. PARCELAMENTO: IGNORE o valor total parcelado se houver um preço à vista menor. 
      6. ERROS COMUNS: Não confunda o valor da parcela (ex: 10x de R$ 50) com o preço total. Se o preço total não estiver claro, ignore o resultado.
      7. PREÇOS ANTIGOS: Ignore preços riscados ("De: R$ ...") ou "Preço Sugerido". Foque no "Por: R$ ...".
      
      Retorne um array JSON de objetos: {"site": string, "price": number, "url": string}.
      Se não houver resultados válidos, retorne [].`;

      const prompt = `Encontre o preço atual de "${productName}" em BRL em lojas brasileiras confiáveis.`;
      
      const { GoogleGenAI, Type } = await import("@google/genai");
      
      // Try Gemini Search first if no other keys or as default
      if (finalApiKey && !profile?.serperApiKey && !profile?.tavilyApiKey) {
        try {
          const ai = new GoogleGenAI({ apiKey: finalApiKey });
          const response = await ai.models.generateContent({
            model: "gemini-3-flash-preview",
            contents: prompt,
            config: {
              systemInstruction,
              tools: [{ googleSearch: {} }],
              responseMimeType: "application/json",
              responseSchema: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    site: { type: Type.STRING },
                    price: { type: Type.NUMBER },
                    url: { type: Type.STRING },
                  },
                  required: ["site", "price", "url"],
                }
              }
            }
          });
          
          const text = response.text || "[]";
          safeLog(`Gemini Search result received for ${productName}`);
          return res.json(JSON.parse(text));
        } catch (geminiError: any) {
          safeLog(`Gemini Search failed, checking fallbacks: ${geminiError.message}`);
          // If it's a quota error, we continue to fallbacks
        }
      }

      // Fallback Search Strategy: Serper or Tavily + LLM Extraction
      let searchResults = [];
      if (profile?.serperApiKey) {
        safeLog("Using Serper.dev for market analysis...");
        searchResults = await searchWithSerper(`${productName} preço brasil`, profile.serperApiKey);
      } else if (profile?.tavilyApiKey) {
        safeLog("Using Tavily for market analysis...");
        searchResults = await searchWithTavily(`${productName} preço brasil`, profile.tavilyApiKey);
      }

      if (searchResults.length > 0) {
        safeLog(`Found ${searchResults.length} search results, extracting prices...`);
        // Use LLM (Gemini or NVIDIA) to extract prices from snippets
        const extractionPrompt = `Extraia os preços dos produtos destes resultados de pesquisa para "${productName}". 
        Resultados: ${JSON.stringify(searchResults)}
        
        REGRAS DE EXTRAÇÃO:
        1. "site": Nome da loja (ex: "Amazon", "Mercado Livre").
        2. "price": Número representando o MENOR PREÇO À VISTA ATUAL (Pix/Boleto).
        3. "url": Link direto do produto.
        
        CRÍTICO: 
        - Verifique se o produto está EM ESTOQUE.
        - IGNORE preços parcelados (ex: 12x de...) se o preço à vista for diferente.
        - NÃO confunda o valor de uma única parcela com o preço total.
        - Se o preço parecer suspeito (ex: R$ 10 para uma placa de vídeo), ignore.
        
        Retorne APENAS um array JSON de objetos {site, price, url}.`;

    let extractedData = "[]";

    try {
      const urlSelectionPrompt = `Analise estes resultados de pesquisa para "${productName}".
Selecione as 3 URLs mais promissoras que parecem ser links diretos de produtos em grandes varejistas (Amazon, Mercado Livre, Kabum, Pichau, Terabyte, Magalu).

Resultados: ${JSON.stringify(searchResults)}

Retorne APENAS um array JSON de strings (as URLs).`;

let urlsToScrape: string[] = [];
      if (profile?.nvidiaApiKey) {
        const OpenAI = (await import("openai")).default;
        const client = new OpenAI({ baseURL: "https://integrate.api.nvidia.com/v1", apiKey: profile.nvidiaApiKey });
        const response = await client.chat.completions.create({
          model: "meta/llama-3.1-405b-instruct",
          messages: [{ role: "user", content: urlSelectionPrompt }],
          response_format: { type: "json_object" }
        });
        const parsed = JSON.parse(response.choices[0].message.content || "{}");
        urlsToScrape = Array.isArray(parsed) ? parsed : (parsed.urls || []);
      } else if (finalApiKey) {
        const ai = new GoogleGenAI({ apiKey: finalApiKey });
        const response = await ai.models.generateContent({
          model: "gemini-3-flash-preview",
          contents: urlSelectionPrompt,
          config: { responseMimeType: "application/json" }
        });
        const parsed = JSON.parse(response.text || "{}");
        urlsToScrape = Array.isArray(parsed) ? parsed : (parsed.urls || []);
      }

          // Limit to top 3 to avoid long waits
          urlsToScrape = urlsToScrape.slice(0, 3);
          safeLog(`Scraping top ${urlsToScrape.length} URLs for ${productName}...`);

          const results = [];
          const { advancedScrape } = await import("./src/lib/scraper.ts");
          
          for (const url of urlsToScrape) {
            try {
              const info = await advancedScrape(url, {
                geminiApiKey: finalApiKey,
                nvidiaApiKey: profile?.nvidiaApiKey,
                lmStudioUrl: profile?.lmStudioUrl
              });
              if (info && info.price > 0) {
                results.push({
                  site: new URL(url).hostname.replace("www.", "").split(".")[0].toUpperCase(),
                  price: info.price,
                  url: url,
                  imageUrl: info.imageUrl
                });
              }
            } catch (scrapeErr) {
              safeLog(`Failed to scrape ${url}: ${scrapeErr}`);
            }
          }

          if (results.length > 0) {
            return res.json(results);
          }

          // Fallback to snippet extraction if advanced scrape failed or returned nothing
          safeLog("Advanced scrape returned no results, falling back to snippet extraction...");
          
          const snippetPrompt = `Extraia os preços dos produtos destes resultados de pesquisa para "${productName}". 
          Resultados: ${JSON.stringify(searchResults)}
          
          REGRAS DE EXTRAÇÃO:
          1. "site": Nome da loja (ex: "Amazon", "Mercado Livre").
          2. "price": Número representando o MENOR PREÇO À VISTA ATUAL (Pix/Boleto).
          3. "url": Link direto do produto.
          
          Retorne APENAS um array JSON de objetos {site, price, url}.`;

          if (profile?.nvidiaApiKey) {
            const OpenAI = (await import("openai")).default;
            const client = new OpenAI({ baseURL: "https://integrate.api.nvidia.com/v1", apiKey: profile.nvidiaApiKey });
            const response = await client.chat.completions.create({
              model: "meta/llama-3.1-405b-instruct",
              messages: [{ role: "user", content: snippetPrompt }],
              response_format: { type: "json_object" }
            });
            extractedData = response.choices[0].message.content || "[]";
          } else if (finalApiKey) {
            const ai = new GoogleGenAI({ apiKey: finalApiKey });
            const response = await ai.models.generateContent({
              model: "gemini-3-flash-preview",
              contents: snippetPrompt,
              config: { responseMimeType: "application/json" }
            });
            extractedData = response.text || "[]";
          }
        } catch (extractError: any) {
          safeLog(`Extraction failed: ${extractError.message}`);
          extractedData = "[]";
        }

        safeLog(`Raw extraction data: ${extractedData.slice(0, 200)}...`);

        // Robust parsing
        let finalArray = [];
        try {
          let parsed = JSON.parse(extractedData);
          
          if (Array.isArray(parsed)) {
            finalArray = parsed;
          } else if (parsed.results && Array.isArray(parsed.results)) {
            finalArray = parsed.results;
          } else if (parsed.prices && Array.isArray(parsed.prices)) {
            finalArray = parsed.prices;
          } else if (parsed.products && Array.isArray(parsed.products)) {
            finalArray = parsed.products;
          } else {
            // Try to find any array in the object
            const firstArrayKey = Object.keys(parsed).find(key => Array.isArray(parsed[key]));
            if (firstArrayKey) finalArray = parsed[firstArrayKey];
          }
        } catch (parseError: any) {
          safeLog(`JSON Parse failed for extraction data: ${parseError.message}`);
        }

        // Sanitize and validate
        finalArray = finalArray.filter((item: any) => 
          item && typeof item === 'object' && 
          (typeof item.site === 'string' || typeof item.site === 'number') && 
          !isNaN(parseFloat(item.price)) &&
          typeof item.url === 'string'
        ).map((item: any) => ({
          site: String(item.site),
          price: parseFloat(item.price),
          url: item.url
        }));

        safeLog(`Extracted ${finalArray.length} valid price points for ${productName}`);
        
        // Final filter for zero prices and suspicious sources
        finalArray = finalArray.filter(item => item.price > 0);
        
        return res.json(finalArray);
      }

      // If we got here and still no results
      safeLog(`No search results found for ${productName} on any provider.`);
      return res.json([]);

    } catch (error: any) {
      const errorMessage = error?.message || String(error);
      safeLog(`Market analysis failed for ${productName}: ${errorMessage}`);
      res.status(500).json({ error: errorMessage });
    } finally {
      isComparing = false;
    }
  });

  app.post("/api/analyze", async (req, res) => {
    const { productName, currentPrice, currency, history, profileId } = req.body;
    
    try {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
      const profile = data.profiles.find((p: any) => p.id === profileId);
      const finalApiKey = profile?.geminiApiKey || process.env.GEMINI_API_KEY;

      const prompt = `Analise o histórico de preços para "${productName}".
Preço Atual: ${currency} ${currentPrice}
Histórico: ${history}

Forneça uma análise de mercado DIRETA e CONCISA (máximo 150 palavras) em Português.
Tom: Iron Man / SENTINEL / HUD.
Estrutura:
- TENDÊNCIA: [Alta/Baixa/Estável] + motivo breve.
- RECOMENDAÇÃO: [Comprar/Aguardar/Sugestão de Preço Alvo].
- RISCO: [Baixo/Médio/Alto].
Sem enrolação. Apenas os fatos.`;

      let analysis = "";

      // 1. Try Local LLM
      if (profile?.lmStudioUrl) {
        try {
          safeLog("Using Local LLM for analysis...");
          const OpenAI = (await import("openai")).default;
          const client = new OpenAI({
            baseURL: profile.lmStudioUrl,
            apiKey: "lm-studio",
          });
          const response = await client.chat.completions.create({
            model: "qwen",
            messages: [{ role: "user", content: prompt }]
          });
          analysis = response.choices[0].message.content || "";
        } catch (e) {
          safeLog("Local LLM analysis failed: " + e);
        }
      }

      // 2. Try NVIDIA API
      if (!analysis && profile?.nvidiaApiKey) {
        try {
          safeLog("Using NVIDIA API for analysis...");
          const OpenAI = (await import("openai")).default;
          const client = new OpenAI({
            baseURL: "https://integrate.api.nvidia.com/v1",
            apiKey: profile.nvidiaApiKey,
          });
          const response = await client.chat.completions.create({
            model: "meta/llama-3.1-405b-instruct",
            messages: [{ role: "user", content: prompt }]
          });
          analysis = response.choices[0].message.content || "";
        } catch (e) {
          safeLog("NVIDIA analysis failed: " + e);
        }
      }

      // 3. Try Gemini
      if (!analysis && finalApiKey) {
        try {
          safeLog("Using Gemini API for analysis...");
          const { GoogleGenAI } = await import("@google/genai");
          const ai = new GoogleGenAI({ apiKey: finalApiKey });
          const response = await ai.models.generateContent({
            model: "gemini-3-flash-preview",
            contents: prompt,
          });
          analysis = response.text || "";
        } catch (e) {
          safeLog("Gemini analysis failed: " + e);
        }
      }

      if (!analysis) {
        throw new Error("All analysis providers failed.");
      }

      res.json({ text: analysis });
    } catch (error: any) {
      safeLog("Analysis failed: " + error);
      res.status(500).json({ error: "Analysis failed" });
    }
  });



  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    // Use a dynamic import with an obfuscated string to bypass tsx static analysis
    const v = "v";
    const i = "i";
    const t = "t";
    const e = "e";
    const { createServer: createViteServer } = await import(v + i + t + e);
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // In Electron production, use APP_PATH or current dir
    const baseDir = process.env.APP_PATH || process.cwd();
    const distPath = path.join(baseDir, 'dist');
    
    safeLog('Production mode: serving from ' + distPath);
    
    if (!fs.existsSync(distPath)) {
      safeLog('CRITICAL: dist directory not found at ' + distPath);
    }

    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      const indexPath = path.join(distPath, 'index.html');
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        res.status(404).send('System Error: Frontend assets not found. Check dist folder.');
      }
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    safeLog(`Crimson Sentinel running on http://localhost:${PORT}`);
    
    // Background automation: Scan all products every 12 hours
    const SCAN_INTERVAL = 12 * 60 * 60 * 1000; // 12 hours
    
    setInterval(async () => {
      safeLog("Starting scheduled background market scan...");
      try {
        const content = fs.readFileSync(DATA_FILE, "utf-8");
        const data = JSON.parse(content);
        
        for (const product of data.products) {
          safeLog(`Background scanning: ${product.name}`);
          // We could implement a full scan here, but to avoid duplication 
          // and respect rate limits, we'll just do a basic scrape for now.
          // In a real app, we'd refactor the compare logic into a shared function.
          try {
            const profile = data.profiles.find((p: any) => p.id === product.profileId);
            const apiKey = profile?.geminiApiKey || process.env.GEMINI_API_KEY;
            if (apiKey) {
              const info = await scrapeProductInfo(product.url, apiKey, product.profileId);
              if (info && info.price) {
                const now = new Date().toISOString();
                const priceChanged = info.price !== product.currentPrice;
                
                product.previousPrice = priceChanged ? product.currentPrice : product.previousPrice;
                product.currentPrice = info.price;
                product.lastUpdated = now;
                if (priceChanged) {
                  product.priceHistory.push({ date: now, price: info.price });
                }
                safeLog(`Updated ${product.name}: ${info.price}`);
              }
            }
            // Small delay between products to avoid rate limits
            await new Promise(resolve => setTimeout(resolve, 5000));
          } catch (err) {
            safeLog(`Failed background scan for ${product.name}: ${err}`);
          }
        }
        
        fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
        safeLog("Scheduled background scan complete.");
      } catch (err) {
        safeLog("Background scan error: " + err);
      }
    }, SCAN_INTERVAL);
  });
}

startServer();
