import { Page } from "playwright-core";
import { isValidPrice, sanitizePrice, isScientificNotation } from "./scraper";

export interface ScrapeResult {
  name: string;
  price: number;
  currency: string;
  available: boolean;
  imageUrl?: string;
  method?: string;
}

const PRICE_REGEX = /R?\$?\s*[\d.,]+\s*(?:reais?)?/i;
const NUMBER_REGEX = /[\d.,]+/;
const MAX_PRICE = 10_000_000;

function parseBrazilianPrice(text: string): number {
  if (!text || isScientificNotation(text)) return 0;

  const cleaned = text.replace(/[^\d.,]/g, "");
  const parts = cleaned.split(/[.,]/).filter(p => p);

  if (parts.length === 0) return 0;
  if (parts.length === 1) return sanitizePrice(parseFloat(parts[0]) || 0);

  if (parts.length === 2) {
    const hasCommaDecimal = text.includes(",") && text.lastIndexOf(",") > text.lastIndexOf(".");
    if (hasCommaDecimal) {
      return sanitizePrice(parseFloat(parts[0]) + parseFloat(parts[1]) / 100);
    }
    return sanitizePrice(parseFloat(parts[0] + "." + parts[1]) || 0);
  }

  const lastTwo = parts.slice(-2);
  const intPart = parts.slice(0, -2).join("");

  if (text.includes(",") && text.includes(".")) {
    const commaPos = text.lastIndexOf(",");
    const dotPos = text.lastIndexOf(".");
    if (commaPos > dotPos) {
      return sanitizePrice(parseFloat(intPart + lastTwo[0]) + parseFloat(lastTwo[1]) / 100);
    }
  }

  return sanitizePrice(parseFloat(intPart + "." + lastTwo.join("")) || 0);
}

function extractPriceFromText(text: string): number {
  if (!text || isScientificNotation(text)) return 0;

  const priceMatches = text.match(/R?\$?\s*[\d.,]+/g);
  if (!priceMatches || priceMatches.length === 0) return 0;

  const prices = priceMatches
    .map(m => parseBrazilianPrice(m))
    .filter(p => isValidPrice(p));

  if (prices.length === 0) return 0;

  return Math.min(...prices);
}

export const storeHandlers: Record<string, (page: Page) => Promise<Partial<ScrapeResult>>> = {
	"pichau.com.br": async (page: Page) => {
		console.log("[Handler] Using Pichau handler");

		await page.waitForTimeout(3000);
		await page.waitForSelector('[class*="price"], [data-price], .product-price', { timeout: 15000 }).catch(function() {});
		await page.waitForSelector("h1", { timeout: 5000 }).catch(function() {});

		await page.evaluate(`window.scrollTo(0, 800)`);
		await page.waitForTimeout(2000);

		const evaluateCode = `
(function() {
	var body = document.body.innerText;
	var bodyLower = body.toLowerCase();

	function parseBrazilianPrice(text) {
		if (!text) return 0;
		text = text.replace(/R\\$\\s?/gi, '').trim();
		if (/[eE][+-]?\\d+/i.test(text)) return 0;
		text = text.replace(/\\.(?=\\d{3})/g, '').replace(',', '.');
		var price = parseFloat(text);
		return isNaN(price) ? 0 : price;
	}

	function isValidPrice(p) {
		return p >= 10 && p <= 100000 && Number.isFinite(p);
	}

	var pixKeywords = ['pix', 'boleto', 'à vista', 'a vista', 'avista', 'débito', 'debito'];
	var parcelKeywords = ['x de r$', 'x r$', 'parcelado', 'vezes de', 'parc'];

	var lines = body.split('\\n');
	var pixPrices = [];
	var parcelPrices = [];
	var allPrices = [];

	for (var i = 0; i < lines.length; i++) {
		var line = lines[i].trim();
		var lineLower = line.toLowerCase();

		var isParcel = false;
		for (var j = 0; j < parcelKeywords.length; j++) {
			if (lineLower.indexOf(parcelKeywords[j]) !== -1) {
				isParcel = true;
				break;
			}
		}

		var priceMatches = line.match(/R?\\$\\s?[\\d.,]+/gi) || [];
		for (var k = 0; k < priceMatches.length; k++) {
			var price = parseBrazilianPrice(priceMatches[k]);
			if (isValidPrice(price)) {
				if (isParcel) {
					parcelPrices.push(price);
				} else {
					var nextLine = (i + 1 < lines.length) ? lines[i + 1].toLowerCase() : '';
					var hasPixKeyword = false;
					for (var m = 0; m < pixKeywords.length; m++) {
						if (lineLower.indexOf(pixKeywords[m]) !== -1 || nextLine.indexOf(pixKeywords[m]) !== -1) {
							hasPixKeyword = true;
							break;
						}
					}
					if (hasPixKeyword) {
						pixPrices.push(price);
					}
					allPrices.push(price);
				}
			}
		}
	}

	var finalPrice = 0;

	if (pixPrices.length > 0) {
		pixPrices.sort(function(a, b) { return a - b; });
		finalPrice = pixPrices[0];
	}

	if (!isValidPrice(finalPrice) && allPrices.length > 0) {
		var nonParcelPrices = [];
		for (var i = 0; i < allPrices.length; i++) {
			var isParcelPrice = false;
			for (var j = 0; j < parcelPrices.length; j++) {
				if (Math.abs(allPrices[i] - parcelPrices[j]) < 1) {
					isParcelPrice = true;
					break;
				}
			}
			if (!isParcelPrice) {
				nonParcelPrices.push(allPrices[i]);
			}
		}

		if (nonParcelPrices.length > 0) {
			nonParcelPrices.sort(function(a, b) { return a - b; });
			finalPrice = nonParcelPrices[0];
		}
	}

	if (!isValidPrice(finalPrice) && parcelPrices.length > 0) {
		parcelPrices.sort(function(a, b) { return a - b; });
		finalPrice = parcelPrices[0];
	}

	if (!isValidPrice(finalPrice) && allPrices.length > 0) {
		allPrices.sort(function(a, b) { return a - b; });
		finalPrice = allPrices[0];
	}

	finalPrice = Math.round(finalPrice * 100) / 100;

	var nameEl = document.querySelector("h1") || document.querySelector('[class*="title"]') || document.querySelector('[itemprop="name"]');
	var imageEl = document.querySelector('meta[property="og:image"]') || document.querySelector('meta[name="twitter:image"]') || document.querySelector("img[class*='product']") || document.querySelector("img[class*='main']");
	var available = bodyLower.indexOf("esgotado") === -1 && bodyLower.indexOf("indisponível") === -1 && bodyLower.indexOf("sem estoque") === -1;

	return {
	name: nameEl && nameEl.textContent && nameEl.textContent.trim() || "",
	price: finalPrice,
	currency: "BRL",
	available: available,
	imageUrl: imageEl && imageEl.getAttribute("content") || imageEl && imageEl.getAttribute("src") || undefined
	};
	})()
	`;

	const data = await page.evaluate(evaluateCode);

		const namePreview = data.name && data.name.length > 50 ? data.name.substring(0, 50) : (data.name || "");
		console.log("[Handler] Pichau extracted: name=\"" + namePreview + "\", price=" + data.price);
		return data;
},

	"kabum.com.br": async (page: Page) => {
		console.log("[Handler] Using Kabum handler");

		await page.waitForSelector(".product-price, #blocoValores, [class*='price']", { timeout: 15000 }).catch(function() {});
		await page.waitForSelector("h1", { timeout: 5000 }).catch(function() {});

		await page.evaluate(`window.scrollTo(0, 400)`);
		await page.waitForTimeout(1500);

		const kabumCode = `
(function() {
	var body = document.body.innerText;

	var priceEl =
		document.querySelector(".product-price .value") ||
		document.querySelector("#blocoValores .value") ||
		document.querySelector("[class*='price']") ||
		document.querySelector("[class*='Price']");

	var price = 0;
	if (priceEl) {
		var priceText = priceEl.textContent || "";
		var isSci = /[eE][+-]?\\d+/i.test(priceText);
		if (!isSci) {
			var numbers = priceText.match(/[\\d.,]+/g);
			if (numbers && numbers.length >= 2) {
				var intPart = numbers.slice(0, -1).join("").replace(/[.,]/g, "");
				var decPart = numbers[numbers.length - 1];
				price = parseFloat(intPart) + parseFloat(decPart) / 100;
			} else if (numbers) {
				price = parseFloat(numbers[0].replace(",", ".")) || 0;
			}
		}
	}

	if (!(price > 0 && price < 10000000 && Number.isFinite(price))) {
		var priceMatches = body.match(/R?\\$?\\s*[\\d.,]+/gi) || [];
		var prices = [];
		for (var i = 0; i < priceMatches.length; i++) {
			var m = priceMatches[i];
			var isSciMatch = /[eE][+-]?\\d+/i.test(m);
			if (isSciMatch) continue;
			var num = m.replace(/[^\\d.,]/g, "");
			var parts = num.split(/[.,]/);
			var parsed = 0;
			if (parts.length >= 2) {
				parsed = parseFloat(parts.slice(0, -1).join("")) + parseFloat(parts[parts.length - 1]) / 100;
			} else {
				parsed = parseFloat(num) || 0;
			}
			if (parsed > 0 && parsed < 10000000 && Number.isFinite(parsed)) {
				prices.push(parsed);
			}
		}
		if (prices.length > 0) {
			price = Math.min.apply(null, prices);
		}
	}

	price = Math.round(price * 100) / 100;

	var nameEl = document.querySelector("h1") || document.querySelector("title");
	var imageEl = document.querySelector('meta[property="og:image"]') || document.querySelector("img[class*='product']");
	var bodyLower = body.toLowerCase();
	var available = bodyLower.indexOf("esgotado") === -1;

	return {
		name: nameEl && nameEl.textContent && nameEl.textContent.trim() || "",
		price: price,
		currency: "BRL",
		available: available,
		imageUrl: imageEl && imageEl.getAttribute("content") || imageEl && imageEl.getAttribute("src") || undefined
	};
})()
		`;

const data = await page.evaluate(kabumCode);

		const namePreview = data.name && data.name.length > 50 ? data.name.substring(0, 50) : (data.name || "");
		console.log("[Handler] Kabum extracted: name=\"" + namePreview + "\", price=" + data.price);
		return data;
	},

	"terabytestore.com.br": async (page: Page) => {
    console.log("[Handler] Using Terabyte handler");

    // Aguardar JavaScript carregar completamente
    await page.waitForTimeout(4000);

    // Tentar múltiplos seletores de preço
    const selectors = [
      ".prodDetPreco",
      ".prodDetPreco .preco",
      ".preco",
      "[class*='preco']",
      "[class*='price']",
      ".product-price",
      "#preco"
    ];

    for (const selector of selectors) {
      try {
        await page.waitForSelector(selector, { timeout: 3000 });
        console.log("[Terabyte] Found selector: " + selector);
        break;
      } catch (e) {
        // Continue to next selector
      }
    }

    await page.waitForSelector("h1", { timeout: 5000 }).catch(function() {});

	// Scroll para carregar lazy content
	await page.evaluate(`window.scrollTo(0, 600)`);
	await page.waitForTimeout(2000);

	const data = await page.evaluate(`
	(function() {
	var body = document.body.innerText;

      // Função para fazer parse de preço brasileiro
      function parseBrazilianPrice(text) {
        if (!text) return 0;
        
        // Remove R$, espaços
        var clean = text.replace(/R\$\s?/gi, '').trim();
        
        // Verifica notação científica
        if (/[eE][+-]?\d+/i.test(clean)) return 0;
        
        // Remove pontos de milhar e troca vírgula por ponto
        // Formato esperado: "1.799,00" ou "1799,00" ou "1799"
        clean = clean.replace(/\.(?=\d{3})/g, '').replace(',', '.');
        
        var price = parseFloat(clean);
        return isNaN(price) ? 0 : price;
      }

      // Função para validar preço
      function isValidPrice(p) {
        return p > 10 && p < 100000 && Number.isFinite(p);
      }

      // Tentar múltiplos seletores de preço
      var priceSelectors = [
        ".prodDetPreco .preco",
        ".prodDetPreco",
        ".preco",
        "[class*='preco']",
        "[class*='price']",
        ".product-price",
        "#preco",
        "[itemprop='price']"
      ];

      var price = 0;
      var foundSelector = "";

      for (var i = 0; i < priceSelectors.length; i++) {
        var el = document.querySelector(priceSelectors[i]);
        if (el) {
          var text = el.textContent || "";
          console.log("[Terabyte] Trying selector " + priceSelectors[i] + ": " + text.substring(0, 50));
          
          var parsed = parseBrazilianPrice(text);
          if (isValidPrice(parsed)) {
            price = parsed;
            foundSelector = priceSelectors[i];
            console.log("[Terabyte] Valid price from selector: " + price);
            break;
          }
        }
      }

      // Se não encontrou preço válido, buscar no texto
      if (!isValidPrice(price)) {
        console.log("[Terabyte] No valid price from selectors, searching in body...");
        
        // Buscar padrões de preço brasileiro no texto
        var patterns = [
          /R?\$\s*[\d.,]+/gi,
          /\d{1,3}(?:\.\d{3})*,\d{2}/g,
          /\d+,\d{2}/g
        ];

        var allPrices = [];
        
        for (var p = 0; p < patterns.length; p++) {
          var matches = body.match(patterns[p]) || [];
          for (var m = 0; m < matches.length; m++) {
            var parsed = parseBrazilianPrice(matches[m]);
            if (isValidPrice(parsed)) {
              allPrices.push(parsed);
            }
          }
        }

        // Remover duplicatas e ordenar
        var uniquePrices = [];
        for (var i = 0; i < allPrices.length; i++) {
          if (uniquePrices.indexOf(allPrices[i]) === -1) {
            uniquePrices.push(allPrices[i]);
          }
        }
        uniquePrices.sort(function(a, b) { return a - b; });

        console.log("[Terabyte] Prices found in body: " + JSON.stringify(uniquePrices.slice(0, 5)));

        if (uniquePrices.length > 0) {
          // Pegar o menor preço (provavelmente à vista/Pix)
          price = uniquePrices[0];
        }
      }

      // Arredondar para 2 casas decimais
      price = Math.round(price * 100) / 100;

      console.log("[Terabyte] Final price: " + price);

      var nameEl = document.querySelector("h1") || document.querySelector("title");
      var imageEl = document.querySelector('meta[property="og:image"]');
      var bodyLower = body.toLowerCase();
      var available = bodyLower.indexOf("esgotado") === -1 && bodyLower.indexOf("indisponível") === -1;

	return {
	name: nameEl && nameEl.textContent && nameEl.textContent.trim() || "",
	price: price,
	currency: "BRL",
	available: available,
	imageUrl: imageEl && imageEl.getAttribute("content") || undefined,
	};
	})()
	`);

	const namePreview = data.name && data.name.length > 50 ? data.name.substring(0, 50) : (data.name || "");
	console.log("[Handler] Terabyte extracted: name=\"" + namePreview + "\", price=" + data.price);
    return data;
  },

  "amazon.com.br": async (page: Page) => {
    console.log("[Handler] Using Amazon BR handler");

    await page.waitForSelector("[class*='price'], .a-price", { timeout: 15000 }).catch(function() {});
    await page.waitForSelector("#productTitle", { timeout: 10000 }).catch(function() {});

    await page.waitForTimeout(2000);

	const data = await page.evaluate(`
	(function() {
	var body = document.body.innerText;

	var priceEl =
		document.querySelector(".a-price .a-offscreen") ||
        document.querySelector("[class*='price'] .a-offscreen") ||
        document.querySelector("[class*='price']");

      var price = 0;
      if (priceEl) {
        var priceText = priceEl.textContent || "";
        var isSci = /[eE][+-]?\d+/i.test(priceText);
        if (!isSci) {
          var numbers = priceText.match(/[\d.,]+/g);
          if (numbers && numbers.length >= 2) {
            price = parseFloat(numbers.slice(0, -1).join("").replace(/[.,]/g, "")) + parseFloat(numbers[numbers.length - 1]) / 100;
          } else if (numbers) {
            price = parseFloat(numbers[0].replace(",", ".")) || 0;
          }
        }
      }

      if (!(price > 0 && price < 10000000 && Number.isFinite(price))) {
        var priceMatches = body.match(/R?\$?\s*[\d.,]+/gi) || [];
        var prices = [];
        for (var i = 0; i < priceMatches.length; i++) {
          var m = priceMatches[i];
          var isSciMatch = /[eE][+-]?\d+/i.test(m);
          if (isSciMatch) continue;
          var num = m.replace(/[^\d.,]/g, "");
          var parts = num.split(/[.,]/);
          var parsed = 0;
          if (parts.length >= 2) {
            parsed = parseFloat(parts.slice(0, -1).join("")) + parseFloat(parts[parts.length - 1]) / 100;
          } else {
            parsed = parseFloat(num) || 0;
          }
          if (parsed > 0 && parsed < 10000000 && Number.isFinite(parsed)) {
            prices.push(parsed);
          }
        }
        if (prices.length > 0) {
          price = Math.min.apply(null, prices);
        }
      }

      price = Math.round(price * 100) / 100;

      var nameEl = document.querySelector("#productTitle");
      var imageEl =
        document.querySelector('meta[property="og:image"]') ||
        document.querySelector("#landingImage") ||
        document.querySelector("#main-image-container img");

      var bodyLower = body.toLowerCase();
      var outOfStockEl = document.querySelector("#outOfStock");
      var available = bodyLower.indexOf("indisponível") === -1 && !outOfStockEl;

	return {
	name: nameEl && nameEl.textContent && nameEl.textContent.trim() || "",
	price: price,
	currency: "BRL",
	available: available,
	imageUrl: imageEl && imageEl.getAttribute("content") || imageEl && imageEl.getAttribute("src") || undefined,
	};
	})()
	`);

	const namePreview = data.name && data.name.length > 50 ? data.name.substring(0, 50) : (data.name || "");
	console.log("[Handler] Amazon extracted: name=\"" + namePreview + "\", price=" + data.price);
    return data;
  },

  "mercadolivre.com.br": async (page: Page) => {
    console.log("[Handler] Using Mercado Livre handler");

    // Aguardar carregamento completo
    await page.waitForTimeout(4000);

    // Tentar múltiplos seletores
    var selectors = [
      ".ui-pdp-price",
      ".andes-money-amount",
      "[class*='price']",
      ".price-tag",
      ".ui-pdp-price__second-line"
    ];

    for (var i = 0; i < selectors.length; i++) {
      try {
        await page.waitForSelector(selectors[i], { timeout: 5000 });
        console.log("[ML] Found selector: " + selectors[i]);
        break;
      } catch (e) {
        // Continue
      }
    }

    await page.waitForSelector("h1", { timeout: 10000 }).catch(function() {});

	// Scroll
	await page.evaluate(`window.scrollTo(0, 500)`);
	await page.waitForTimeout(2000);

	const data = await page.evaluate(`
	(function() {
	var body = document.body.innerText;
	var bodyLower = body.toLowerCase();

      // Função para parsear preço
      function parseBrazilianPrice(text) {
        if (!text) return 0;
        text = text.replace(/R\$\s?/gi, '').trim();
        if (/[eE][+-]?\d+/i.test(text)) return 0;
        text = text.replace(/\.(?=\d{3})/g, '').replace(',', '.');
        var price = parseFloat(text);
        return isNaN(price) ? 0 : price;
      }

      function isValidPrice(p) {
        return p >= 10 && p <= 100000 && Number.isFinite(p);
      }

      // Mercado Livre mostra preço de forma simples: "R$ 60,13" ou "60,13"
      // ESTRATÉGIA 1: Seletores específicos do ML
      var priceSelectors = [
        ".ui-pdp-price .andes-money-amount__fraction",
        ".andes-money-amount .andes-money-amount__fraction",
        ".ui-pdp-price .andes-money-amount",
        ".andes-money-amount",
        "[class*='price'] .andes-money-amount__fraction",
        ".price-tag .andes-money-amount__fraction"
      ];

      var price = 0;

      for (var i = 0; i < priceSelectors.length; i++) {
        var el = document.querySelector(priceSelectors[i]);
        if (el) {
          var text = el.textContent || "";
          console.log("[ML] Selector " + priceSelectors[i] + ": " + text.substring(0, 50));

          // ML pode mostrar "60" (parte inteira) e "13" (centavos) separados
          var fractionEl = el.querySelector(".andes-money-amount__fraction");
          var centsEl = el.querySelector(".andes-money-amount__cents");

          if (fractionEl && centsEl) {
            var intPart = fractionEl.textContent || "";
            var decPart = centsEl.textContent || "";
            var fullPrice = intPart.replace(/[^\d]/g, '') + "." + decPart.replace(/[^\d]/g, '');
            price = parseFloat(fullPrice) || 0;
          } else {
            price = parseBrazilianPrice(text);
          }

          if (isValidPrice(price)) {
            console.log("[ML] Valid price from selector: " + price);
            break;
          }
          price = 0;
        }
      }

      // ESTRATÉGIA 2: Buscar no texto
      if (!isValidPrice(price)) {
        console.log("[ML] No valid price from selectors, searching in body...");

        // ML usa formato simples: R$ 60,13
        var patterns = [
          /R\$\s*\d{1,3}(?:\.\d{3})*,\d{2}/g,  // R$ 1.234,56
          /R\$\s*\d+,\d{2}/g,                    // R$ 60,13
          /\d{1,3}(?:\.\d{3})*,\d{2}/g           // 1.234,56
        ];

        var allPrices = [];

        for (var p = 0; p < patterns.length; p++) {
          var matches = body.match(patterns[p]) || [];
          for (var m = 0; m < matches.length; m++) {
            var parsed = parseBrazilianPrice(matches[m]);
            if (isValidPrice(parsed)) {
              allPrices.push(parsed);
            }
          }
        }

        // Remover duplicatas
        var uniquePrices = [];
        for (var i = 0; i < allPrices.length; i++) {
          if (uniquePrices.indexOf(allPrices[i]) === -1) {
            uniquePrices.push(allPrices[i]);
          }
        }
        uniquePrices.sort(function(a, b) { return a - b; });

        console.log("[ML] Prices found: " + JSON.stringify(uniquePrices.slice(0, 5)));

        if (uniquePrices.length > 0) {
          price = uniquePrices[0];
        }
      }

      price = Math.round(price * 100) / 100;
      console.log("[ML] Final price: " + price);

      var nameEl = document.querySelector("h1") || document.querySelector("title");
      var imageEl = document.querySelector('meta[property="og:image"]') || document.querySelector(".ui-pdp-gallery img");
      var available = bodyLower.indexOf("indisponível") === -1 && bodyLower.indexOf("pausadas") === -1;

	return {
	name: nameEl && nameEl.textContent && nameEl.textContent.trim() || "",
	price: price,
	currency: "BRL",
	available: available,
	imageUrl: imageEl && imageEl.getAttribute("content") || imageEl && imageEl.getAttribute("src") || undefined,
	};
	})()
	`);

	const namePreview = data.name && data.name.length > 50 ? data.name.substring(0, 50) : (data.name || "");
	console.log("[Handler] Mercado Livre extracted: name=\"" + namePreview + "\", price=" + data.price);
    return data;
},


  "magazineluiza.com.br": async (page: Page) => {
    console.log("[Handler] Using Magalu handler");

    await page.waitForSelector("[class*='price'], [data-testid='price']", { timeout: 15000 }).catch(function() {});
    await page.waitForSelector("h1", { timeout: 10000 }).catch(function() {});

	await page.evaluate(`window.scrollTo(0, 300)`);
	await page.waitForTimeout(1500);

	const data = await page.evaluate(`
	(function() {
	var body = document.body.innerText;

	var priceEl =
		document.querySelector("[data-testid='price']") ||
        document.querySelector("[class*='price']");

      var price = 0;
      if (priceEl) {
        var priceText = priceEl.textContent || "";
        var isSci = /[eE][+-]?\d+/i.test(priceText);
        if (!isSci) {
          var numbers = priceText.match(/[\d.,]+/g);
          if (numbers && numbers.length >= 2) {
            price = parseFloat(numbers.slice(0, -1).join("").replace(/[.,]/g, "")) + parseFloat(numbers[numbers.length - 1]) / 100;
          } else if (numbers) {
            price = parseFloat(numbers[0].replace(",", ".")) || 0;
          }
        }
      }

      if (!(price > 0 && price < 10000000 && Number.isFinite(price))) {
        var priceMatches = body.match(/R?\$?\s*[\d.,]+/gi) || [];
        var prices = [];
        for (var i = 0; i < priceMatches.length; i++) {
          var m = priceMatches[i];
          var isSciMatch = /[eE][+-]?\d+/i.test(m);
          if (isSciMatch) continue;
          var num = m.replace(/[^\d.,]/g, "");
          var parts = num.split(/[.,]/);
          var parsed = 0;
          if (parts.length >= 2) {
            parsed = parseFloat(parts.slice(0, -1).join("")) + parseFloat(parts[parts.length - 1]) / 100;
          } else {
            parsed = parseFloat(num) || 0;
          }
          if (parsed > 0 && parsed < 10000000 && Number.isFinite(parsed)) {
            prices.push(parsed);
          }
        }
        if (prices.length > 0) {
          price = Math.min.apply(null, prices);
        }
      }

      price = Math.round(price * 100) / 100;

      var nameEl = document.querySelector("h1") || document.querySelector("title");
      var imageEl = document.querySelector('meta[property="og:image"]');
      var bodyLower = body.toLowerCase();
      var available = bodyLower.indexOf("indisponível") === -1;

	return {
	name: nameEl && nameEl.textContent && nameEl.textContent.trim() || "",
	price: price,
	currency: "BRL",
	available: available,
	imageUrl: imageEl && imageEl.getAttribute("content") || undefined,
	};
	})()
	`);

	const namePreview = data.name && data.name.length > 50 ? data.name.substring(0, 50) : (data.name || "");
	console.log("[Handler] Magalu extracted: name=\"" + namePreview + "\", price=" + data.price);
    return data;
  },

  "casasbahia.com.br": async (page: Page) => {
    console.log("[Handler] Using Casas Bahia handler");

    await page.waitForSelector("[class*='price']", { timeout: 15000 }).catch(function() {});
    await page.waitForSelector("h1", { timeout: 10000 }).catch(function() {});

	await page.evaluate(`window.scrollTo(0, 300)`);
	await page.waitForTimeout(1500);

	const data = await page.evaluate(`
	(function() {
	var body = document.body.innerText;

	var priceEl = document.querySelector("[class*='price']");

      var price = 0;
      if (priceEl) {
        var priceText = priceEl.textContent || "";
        var isSci = /[eE][+-]?\d+/i.test(priceText);
        if (!isSci) {
          var numbers = priceText.match(/[\d.,]+/g);
          if (numbers && numbers.length >= 2) {
            price = parseFloat(numbers.slice(0, -1).join("").replace(/[.,]/g, "")) + parseFloat(numbers[numbers.length - 1]) / 100;
          } else if (numbers) {
            price = parseFloat(numbers[0].replace(",", ".")) || 0;
          }
        }
      }

      if (!(price > 0 && price < 10000000 && Number.isFinite(price))) {
        var priceMatches = body.match(/R?\$?\s*[\d.,]+/gi) || [];
        var prices = [];
        for (var i = 0; i < priceMatches.length; i++) {
          var m = priceMatches[i];
          var isSciMatch = /[eE][+-]?\d+/i.test(m);
          if (isSciMatch) continue;
          var num = m.replace(/[^\d.,]/g, "");
          var parts = num.split(/[.,]/);
          var parsed = 0;
          if (parts.length >= 2) {
            parsed = parseFloat(parts.slice(0, -1).join("")) + parseFloat(parts[parts.length - 1]) / 100;
          } else {
            parsed = parseFloat(num) || 0;
          }
          if (parsed > 0 && parsed < 10000000 && Number.isFinite(parsed)) {
            prices.push(parsed);
          }
        }
        if (prices.length > 0) {
          price = Math.min.apply(null, prices);
        }
      }

      price = Math.round(price * 100) / 100;

      var nameEl = document.querySelector("h1") || document.querySelector("title");
      var imageEl = document.querySelector('meta[property="og:image"]');
      var bodyLower = body.toLowerCase();
      var available = bodyLower.indexOf("indisponível") === -1;

	return {
	name: nameEl && nameEl.textContent && nameEl.textContent.trim() || "",
	price: price,
	currency: "BRL",
	available: available,
	imageUrl: imageEl && imageEl.getAttribute("content") || undefined,
	};
	})()
	`);

	const namePreview = data.name && data.name.length > 50 ? data.name.substring(0, 50) : (data.name || "");
	console.log("[Handler] Casas Bahia extracted: name=\"" + namePreview + "\", price=" + data.price);
    return data;
  },

  "pontofrio.com.br": async (page: Page) => {
    console.log("[Handler] Using Ponto handler");

    await page.waitForSelector("[class*='price']", { timeout: 15000 }).catch(function() {});
    await page.waitForSelector("h1", { timeout: 10000 }).catch(function() {});

	const data = await page.evaluate(`
	(function() {
	var body = document.body.innerText;

	var priceEl = document.querySelector("[class*='price']");
	var price = 0;

      if (priceEl) {
        var priceText = priceEl.textContent || "";
        var isSci = /[eE][+-]?\d+/i.test(priceText);
        if (!isSci) {
          var numbers = priceText.match(/[\d.,]+/g);
          if (numbers && numbers.length >= 2) {
            price = parseFloat(numbers.slice(0, -1).join("").replace(/[.,]/g, "")) + parseFloat(numbers[numbers.length - 1]) / 100;
          } else if (numbers) {
            price = parseFloat(numbers[0].replace(",", ".")) || 0;
          }
        }
      }

      if (!(price > 0 && price < 10000000 && Number.isFinite(price))) {
        var priceMatches = body.match(/R?\$?\s*[\d.,]+/gi) || [];
        var prices = [];
        for (var i = 0; i < priceMatches.length; i++) {
          var m = priceMatches[i];
          var isSciMatch = /[eE][+-]?\d+/i.test(m);
          if (isSciMatch) continue;
          var num = m.replace(/[^\d.,]/g, "");
          var parts = num.split(/[.,]/);
          var parsed = 0;
          if (parts.length >= 2) {
            parsed = parseFloat(parts.slice(0, -1).join("")) + parseFloat(parts[parts.length - 1]) / 100;
          } else {
            parsed = parseFloat(num) || 0;
          }
          if (parsed > 0 && parsed < 10000000 && Number.isFinite(parsed)) {
            prices.push(parsed);
          }
        }
        if (prices.length > 0) {
          price = Math.min.apply(null, prices);
        }
      }

      price = Math.round(price * 100) / 100;

      var nameEl = document.querySelector("h1") || document.querySelector("title");
      var imageEl = document.querySelector('meta[property="og:image"]');
      var bodyLower = body.toLowerCase();
      var available = bodyLower.indexOf("indisponível") === -1;

	return {
	name: nameEl && nameEl.textContent && nameEl.textContent.trim() || "",
	price: price,
	currency: "BRL",
	available: available,
	imageUrl: imageEl && imageEl.getAttribute("content") || undefined,
	};
	})()
	`);

	const namePreview = data.name && data.name.length > 50 ? data.name.substring(0, 50) : (data.name || "");
	console.log("[Handler] Ponto extracted: name=\"" + namePreview + "\", price=" + data.price);
    return data;
  },
};

export function getStoreHandler(url: string): ((page: Page) => Promise<Partial<ScrapeResult>>) | null {
  try {
    var hostname = new URL(url).hostname.replace("www.", "").toLowerCase();

    var domainAliases = {
      'terabyteshop.com.br': 'terabytestore.com.br',
      'terabyte.com.br': 'terabytestore.com.br',
      'pichauarena.com.br': 'pichau.com.br',
      'magazineluiza.com.br': 'magazineluiza.com.br',
      'magalu.com.br': 'magazineluiza.com.br',
      'amazon.com.br': 'amazon.com.br',
      'amazon.br': 'amazon.com.br',
      'mercadolivre.com.br': 'mercadolivre.com.br',
      'ml.com.br': 'mercadolivre.com.br',
    };

    var normalizedDomain = domainAliases[hostname] || hostname;

    for (var domain in storeHandlers) {
      if (storeHandlers.hasOwnProperty(domain)) {
        var handler = storeHandlers[domain];
        if (normalizedDomain.indexOf(domain) !== -1 || hostname.indexOf(domain) !== -1 || domain.indexOf(hostname) !== -1) {
          console.log("[Handler] Matched: " + hostname + " -> " + domain);
          return handler;
        }
      }
    }
  } catch (e) {
    console.error("[Handler] Failed to parse URL:", e);
  }

  return null;
}
