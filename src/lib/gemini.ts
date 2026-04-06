import { GoogleGenAI, Type } from "@google/genai";

export async function scrapeProductInfo(url: string, customApiKey?: string, profileId?: string) {
  const finalApiKey = customApiKey || process.env.GEMINI_API_KEY;

  if (!finalApiKey) {
    throw new Error("GEMINI_API_KEY is required for scraping.");
  }

  if (profileId) {
    try {
      const { advancedScrape } = await import("./scraper.ts");
      const fs = await import("fs");
      const path = await import("path");
      const DATA_FILE = path.join(process.cwd(), "data.json");

      if (fs.existsSync(DATA_FILE)) {
        const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
        const profile = data.profiles.find((p: any) => p.id === profileId);

        console.log("[Gemini] Attempting advanced scrape with profile:", profileId);

        const info = await advancedScrape(url, {
          geminiApiKey: finalApiKey,
          nvidiaApiKey: profile?.nvidiaApiKey,
          lmStudioUrl: profile?.lmStudioUrl
        });

        if (info && info.name && info.price && info.price > 0) {
          console.log("[Gemini] Advanced scrape successful:", info.name.substring(0, 50), "- R$", info.price);
          return info;
        }
      }
    } catch (err) {
      console.error("[Gemini] Advanced scrape failed, falling back to Gemini URL context:", err);
    }
  }

  console.log("[Gemini] Using Gemini URL context for:", url);

  const ai = new GoogleGenAI({ apiKey: finalApiKey });

  const prompt = `Você é um especialista em extração de dados de produtos de e-commerce brasileiro.

Analise esta URL: ${url}

DIRETRIZES CRÍTICAS:

1. **NOME DO PRODUTO**: Extraia o nome completo do produto. Inclua marca e modelo principais.

2. **PREÇO**:
   - Extraia o MENOR PREÇO disponível (geralmente Pix/Boleto/À vista)
   - IGNORE preços parcelados ou "sugeridos"
   - Retorne APENAS o número (sem R$, sem símbolos)
   - Exemplo: Se vê "R$ 2.999,00" ou "R$ 2.999,00 à vista", retorne: 2999.00

3. **MOEDA**: Sempre "BRL" para lojas brasileiras

4. **DISPONIBILIDADE**: 
   - true = produto em estoque, disponível para compra
   - false = esgotado, indisponível, sem estoque

5. **IMAGEM**: URL direta da imagem principal do produto (do og:image ou imagem de destaque)

Retorne APENAS um JSON válido com esta estrutura:
{
  "name": "Nome do Produto Completo",
  "price": 2999.00,
  "currency": "BRL",
  "available": true,
  "imageUrl": "https://..."
}

NÃO adicione explicações. APENAS o JSON.`;

  const maxRetries = 3;
  let lastError: any = null;

  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await ai.models.generateContent({
        model: "gemini-2.0-flash",
        contents: prompt,
        config: {
          systemInstruction: "You are a specialized product data extractor for Brazilian e-commerce. Be precise with price extraction. Always return the lowest available price.",
          tools: [{ urlContext: {} }],
          responseMimeType: "application/json",
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              name: { type: Type.STRING },
              price: { type: Type.NUMBER },
              currency: { type: Type.STRING },
              available: { type: Type.BOOLEAN },
              imageUrl: { type: Type.STRING },
            },
            required: ["name", "price", "currency", "available"],
          },
        },
      });

      const result = JSON.parse(response.text || "{}");
      
      if (result.price <= 0) {
        console.warn(`[Gemini] Attempt ${i + 1}: Invalid price extracted`);
        if (i < maxRetries - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        }
      }

      console.log(`[Gemini] Success: "${result.name?.substring(0, 50)}" - R$ ${result.price}`);
      return result;
    } catch (error: any) {
      lastError = error;
      console.error(`[Gemini] Attempt ${i + 1} failed:`, error.message || error);

      if (error.status === 503 || error.status === 429 || (error.message && error.message.includes("high demand"))) {
        const waitTime = Math.pow(2, i) * 1000;
        console.log(`[Gemini] Waiting ${waitTime}ms before retry...`);
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }

      throw error;
    }
  }

  throw lastError || new Error("Scraping failed after multiple attempts");
}
