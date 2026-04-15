/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { 
  LayoutDashboard, 
  ListPlus, 
  Settings, 
  Bell, 
  User, 
  Plus, 
  TrendingDown, 
  TrendingUp, 
  RefreshCw,
  ExternalLink,
  Trash2,
  Edit2,
  ChevronRight,
  ShieldAlert,
  Cpu,
  X,
  Minus,
  Square,
  History,
  AlertTriangle,
  Target,
  Wallet,
  BrainCircuit,
  Grid3X3,
  ArrowRight,
  Scan,
  Activity,
  Eye,
  EyeOff
} from "lucide-react";
import { Product, ProductList, Profile, AppData } from "./types";

declare global {
  interface Window {
    electronAPI?: {
      closeWindow: () => void;
      maximizeWindow: () => void;
      minimizeWindow: () => void;
    };
  }
}

import ReactMarkdown from "react-markdown";
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { 
  LineChart, 
  Line, 
  XAxis, 
  YAxis, 
  CartesianGrid, 
  Tooltip, 
  ResponsiveContainer 
} from 'recharts';

// Sound Service
const playSound = (type: 'click' | 'success' | 'error' | 'scan' | 'notify') => {
  try {
    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.connect(gain);
    gain.connect(ctx.destination);

    const now = ctx.currentTime;

    if (type === 'click') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, now);
      osc.frequency.exponentialRampToValueAtTime(440, now + 0.1);
      gain.gain.setValueAtTime(0.1, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
      osc.start(now);
      osc.stop(now + 0.1);
    } else if (type === 'scan') {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(110, now);
      osc.frequency.linearRampToValueAtTime(440, now + 0.5);
      gain.gain.setValueAtTime(0.05, now);
      gain.gain.linearRampToValueAtTime(0, now + 0.5);
      osc.start(now);
      osc.stop(now + 0.5);
    } else if (type === 'success') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(440, now);
      osc.frequency.setValueAtTime(880, now + 0.1);
      gain.gain.setValueAtTime(0.1, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
      osc.start(now);
      osc.stop(now + 0.3);
    } else if (type === 'error') {
      osc.type = 'square';
      osc.frequency.setValueAtTime(220, now);
      osc.frequency.setValueAtTime(110, now + 0.1);
      gain.gain.setValueAtTime(0.1, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.4);
      osc.start(now);
      osc.stop(now + 0.4);
    } else if (type === 'notify') {
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(660, now);
      osc.frequency.setValueAtTime(880, now + 0.15);
      gain.gain.setValueAtTime(0.1, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.5);
      osc.start(now);
      osc.stop(now + 0.5);
    }
  } catch (e) {
    // Audio context might be blocked by browser policy
  }
};

function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export default function App() {
  const [data, setData] = useState<AppData>({
    profiles: [],
    lists: [],
    products: []
  });
  const [activeProfileId, setActiveProfileId] = useState<string | null>(() => {
    return localStorage.getItem("activeProfileId");
  });

  useEffect(() => {
    if (activeProfileId) {
      localStorage.setItem("activeProfileId", activeProfileId);
    } else {
      localStorage.removeItem("activeProfileId");
    }
  }, [activeProfileId]);
  const [isCreatingProfile, setIsCreatingProfile] = useState(false);
  const [newProfileName, setNewProfileName] = useState("");
  const [activeTab, setActiveTab] = useState<"dashboard" | "lists" | "settings">("dashboard");
  const [selectedListId, setSelectedListId] = useState<string | null>(null);
  const [isAddingProduct, setIsAddingProduct] = useState(false);
  const [isAddingList, setIsAddingList] = useState(false);
  const [newUrls, setNewUrls] = useState<string[]>([""]);
  const [newListName, setNewListName] = useState("");
const [isLoading, setIsLoading] = useState(false);
const [isComparing, setIsComparing] = useState(false);
const [abortController, setAbortController] = useState<AbortController | null>(null);
const [comparisonResults, setComparisonResults] = useState<any[]>([]);
const [comparingProduct, setComparingProduct] = useState<string | null>(null);
const [selectedProductId, setSelectedProductId] = useState<string | null>(null);
const [aiInsight, setAiInsight] = useState<string | null>(null);
const [isGeneratingInsight, setIsGeneratingInsight] = useState(false);
const [lastSearchTime, setLastSearchTime] = useState<number>(0);
const SEARCH_COOLDOWN = 5000;
const [autoSaveTimeout, setAutoSaveTimeout] = useState<NodeJS.Timeout | null>(null);
const [showConfirmPurge, setShowConfirmPurge] = useState(false);
const [scanTimeout, setScanTimeout] = useState<number>(180);
const [scanController, setScanController] = useState<AbortController | null>(null);

  const testDiscord = async () => {
    if (!activeProfile?.discordWebhook) return;
    try {
      const response = await fetch("/api/test-discord", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ webhookUrl: activeProfile.discordWebhook })
      });
      if (response.ok) addToast("DISCORD TEST SIGNAL SENT", "success");
      else throw new Error("Test failed");
    } catch (e) {
      addToast("DISCORD SIGNAL FAILED", "error");
    }
  };

  const testTelegram = async () => {
    if (!activeProfile?.telegramToken || !activeProfile?.telegramChatId) return;
    try {
      const response = await fetch("/api/test-telegram", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          botToken: activeProfile.telegramToken,
          chatId: activeProfile.telegramChatId
        })
      });
      if (response.ok) addToast("TELEGRAM TEST SIGNAL SENT", "success");
      else throw new Error("Test failed");
    } catch (e) {
      addToast("TELEGRAM SIGNAL FAILED", "error");
    }
  };

  const testEmail = async () => {
    if (!activeProfile?.gmailUser || !activeProfile?.gmailPass) return;
    try {
      const response = await fetch("/api/test-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          user: activeProfile.gmailUser,
          pass: activeProfile.gmailPass,
          to: activeProfile.gmailUser
        })
      });
      if (response.ok) addToast("EMAIL TEST SIGNAL SENT", "success");
      else throw new Error("Test failed");
    } catch (e) {
      addToast("EMAIL SIGNAL FAILED", "error");
    }
  };
  const [showComparisonGrid, setShowComparisonGrid] = useState(false);
  const [systemMessage, setSystemMessage] = useState("SYSTEM ONLINE: READY TO TRACK");
  const [isDataLoaded, setIsDataLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
const [toasts, setToasts] = useState<{id: string, message: string, type: 'success' | 'error' | 'info', details?: string}[]>([]);

	const addToast = (message: string, type: 'success' | 'error' | 'info' = 'info', details?: string) => {
		const id = Math.random().toString(36).substr(2, 9);
		setToasts(prev => [...prev, { id, message, type, details }]);
		playSound(type === 'success' ? 'success' : type === 'error' ? 'error' : 'notify');
	};

	const removeToast = (id: string) => {
		setToasts(prev => prev.filter(t => t.id !== id));
	};

	const copyToastError = (toast: typeof toasts[0]) => {
		const errorText = `Error: ${toast.message}\n\nDetails: ${toast.details || 'No details available'}`;
		navigator.clipboard.writeText(errorText);
		addToast('Error copied to clipboard!', 'success');
	};

  const isElectron = navigator.userAgent.toLowerCase().includes('electron');

  const saveData = async (newData: AppData) => {
    try {
      await fetch("/api/data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newData)
      });
      setData(newData);
    } catch (error) {
      console.error("Failed to save data", error);
      addToast("SYNC FAILURE: DATA NOT PERSISTED", "error");
    }
  };

  const saveDataSilent = async (newData: AppData) => {
    try {
      await fetch("/api/data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newData)
      });
      setData(newData);
    } catch (error) {
      console.error("Failed to save data", error);
    }
  };

  const updateProfileSetting = (key: string, value: string | boolean | undefined) => {
    if (!activeProfileId) return;
    const newProfiles = data.profiles.map(p =>
      p.id === activeProfileId ? { ...p, [key]: value } : p
    );
    const newData = { ...data, profiles: newProfiles };
    setData(newData);
    
    if (autoSaveTimeout) clearTimeout(autoSaveTimeout);
    const timeout = setTimeout(() => {
      saveDataSilent(newData);
      addToast("CONFIG SYNCHRONIZED", "success");
    }, 1000);
    setAutoSaveTimeout(timeout);
  };

  const fetchData = async (retries = 5) => {
    console.log(`fetchData called, retries left: ${retries}`);
    try {
      const response = await fetch("/api/data");
      console.log(`fetchData response status: ${response.status}`);
      if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
      const json = await response.json();
      console.log('fetchData success, data received');
      setData(json);
      setIsDataLoaded(true);
    } catch (error) {
      console.error("Failed to fetch data", error);
      if (retries > 0) {
        setSystemMessage(`RETRYING CONNECTION... (${retries})`);
        setTimeout(() => fetchData(retries - 1), 1500);
      } else {
        setLoadError(error instanceof Error ? error.message : "DATABASE CONNECTION FAILED");
        setSystemMessage("ERROR: DATABASE CONNECTION FAILED");
      }
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const profileProducts = data.products.filter(p => p.profileId === activeProfileId);
  const profileLists = data.lists.filter(l => l.profileId === activeProfileId);

  const listHistoryData = React.useMemo(() => {
    const allDates = Array.from(new Set(
      profileProducts.flatMap(p => p.priceHistory.map(h => h.date))
    )).sort();

    return allDates.map(date => {
      const entry: any = { date: new Date(date).toLocaleDateString(), rawDate: date };
      profileLists.forEach(list => {
        const listProducts = profileProducts.filter(p => p.listId === list.id);
        const totalValue = listProducts.reduce((sum, product) => {
          const historyEntry = [...product.priceHistory]
            .reverse()
            .find(h => h.date <= date);
          return sum + (historyEntry ? historyEntry.price : 0);
        }, 0);
        entry[list.name] = totalValue;
      });
      return entry;
    });
  }, [profileProducts, profileLists]);

  const closeApp = () => {
    if (isElectron) {
      try {
        window.electronAPI?.closeWindow();
      } catch (e) {
        window.close();
      }
    }
  };

  const maximizeApp = () => {
    if (isElectron) {
      try {
        window.electronAPI?.maximizeWindow();
      } catch (e) {
        console.error("Failed to maximize", e);
      }
    }
  };

  const minimizeApp = () => {
    if (isElectron) {
      try {
        window.electronAPI?.minimizeWindow();
      } catch (e) {
        console.error("Failed to minimize", e);
      }
    }
  };

  const deleteProduct = (id: string) => {
    const newData = { ...data, products: data.products.filter(p => p.id !== id) };
    saveData(newData);
    setSystemMessage("PRODUCT REMOVED FROM DATABASE");
  };

  const updateProductTargetPrice = (id: string, targetPrice: number | undefined) => {
    const newData = { 
      ...data, 
      products: data.products.map(p => p.id === id ? { ...p, targetPrice } : p) 
    };
    saveData(newData);
    setSystemMessage("TARGET PRICE UPDATED");
  };

  const updateListBudget = (id: string, budget: number | undefined) => {
    const newData = { 
      ...data, 
      lists: data.lists.map(l => l.id === id ? { ...l, budget } : l) 
    };
    saveData(newData);
    setSystemMessage("ARCHIVE BUDGET UPDATED");
  };

  const deleteComparisonResult = (productId: string, index: number) => {
    const newProducts = data.products.map(p => {
      if (p.id === productId) {
        const newResults = (p.comparisonResults || []).filter((_, i) => i !== index);
        
        const bestPrice = newResults.length > 0 ? Math.min(...newResults.map((r: any) => r.price)) : p.currentPrice;
        const now = new Date().toISOString();

        return { 
          ...p, 
          comparisonResults: newResults,
          currentPrice: bestPrice,
          priceHistory: [...p.priceHistory, { date: now, price: bestPrice }],
          lastUpdated: now
        };
      }
      return p;
    });
    const newData = { ...data, products: newProducts };
    setData(newData);
    saveData(newData);
    
    if (selectedProductId === productId) {
      setComparisonResults(prev => {
        const base = prev.length > 0 ? prev : (data.products.find(p => p.id === productId)?.comparisonResults || []);
        return base.filter((_, i) => i !== index);
      });
    }
    setSystemMessage("MARKET NODE DELETED");
    addToast("MARKET NODE DELETED", "success");
  };

  const updateComparisonResult = (productId: string, index: number, updatedResult: any) => {
    const newProducts = data.products.map(p => {
      if (p.id === productId) {
        const newResults = [...(p.comparisonResults || [])];
        newResults[index] = updatedResult;
        
        const bestPrice = Math.min(...newResults.map((r: any) => r.price));
        const now = new Date().toISOString();

        return { 
          ...p, 
          comparisonResults: newResults,
          currentPrice: bestPrice,
          priceHistory: [...p.priceHistory, { date: now, price: bestPrice }],
          lastUpdated: now
        };
      }
      return p;
    });
    const newData = { ...data, products: newProducts };
    saveData(newData);
    // Also update local state if we are currently viewing this product
    if (selectedProductId === productId) {
      setComparisonResults(prev => {
        const base = prev.length > 0 ? prev : (data.products.find(p => p.id === productId)?.comparisonResults || []);
        const next = [...base];
        next[index] = updatedResult;
        return next;
      });
    }
    setSystemMessage("MARKET NODE UPDATED");
    addToast("MARKET NODE UPDATED", "success");
  };

  const addComparisonResult = (productId: string, newResult: any) => {
    const newProducts = data.products.map(p => {
      if (p.id === productId) {
        const newResults = [...(p.comparisonResults || []), newResult];
        
        const bestPrice = Math.min(...newResults.map((r: any) => r.price));
        const now = new Date().toISOString();

        return { 
          ...p, 
          comparisonResults: newResults,
          currentPrice: bestPrice,
          priceHistory: [...p.priceHistory, { date: now, price: bestPrice }],
          lastUpdated: now
        };
      }
      return p;
    });
    const newData = { ...data, products: newProducts };
    saveData(newData);
    // Also update local state if we are currently viewing this product
    if (selectedProductId === productId) {
      setComparisonResults(prev => {
        const base = prev.length > 0 ? prev : (data.products.find(p => p.id === productId)?.comparisonResults || []);
        return [...base, newResult];
      });
    }
    setSystemMessage("MARKET NODE ADDED");
    addToast("MARKET NODE ADDED", "success");
  };

  const generateAiInsight = async (product: Product) => {
    setIsGeneratingInsight(true);
    setAiInsight(null);
    setSystemMessage("CONSULTING AI CORE FOR MARKET ANALYSIS...");
    playSound('scan');

    try {
      const historyStr = product.priceHistory
        .map(h => `${h.date}: ${product.currency} ${h.price}`)
        .join("\n");

      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productName: product.name,
          currentPrice: product.currentPrice,
          currency: product.currency,
          history: historyStr,
          profileId: activeProfile?.id
        })
      });

      if (!response.ok) {
        throw new Error("Analysis request failed");
      }

      const result = await response.json();
      // Only update if we are still looking at the same product
      setSelectedProductId(currentId => {
        if (currentId === product.id) {
          setAiInsight(result.text);
          setSystemMessage("AI MARKET ANALYSIS COMPLETE");
        }
        return currentId;
      });
    } catch (error: any) {
      console.error("AI Insight error:", error);
      addToast("AI CORE COMMUNICATION FAILURE", "error");
      setAiInsight("### ⚠️ ALERTA DE SISTEMA: FALHA NA ANÁLISE\n\nNão foi possível conectar aos núcleos de IA (Gemini, NVIDIA ou Local). Verifique suas chaves de API nas configurações.");
    } finally {
      setIsGeneratingInsight(false);
    }
  };

  const deleteList = (id: string) => {
    const newData = { 
      ...data, 
      lists: data.lists.filter(l => l.id !== id),
      products: data.products.filter(p => p.listId !== id)
    };
    saveData(newData);
    setSelectedListId(null);
    setSystemMessage("LIST AND ASSOCIATED DATA PURGED");
  };

  const addList = () => {
    if (!newListName || !activeProfileId) return;
    const newList: ProductList = {
      id: Math.random().toString(36).substr(2, 9),
      name: newListName,
      createdAt: new Date().toISOString(),
      profileId: activeProfileId
    };
    const newData = { ...data, lists: [...data.lists, newList] };
    saveData(newData);
    setNewListName("");
    setIsAddingList(false);
    setSystemMessage(`NEW LIST CREATED: ${newList.name.toUpperCase()}`);
  };

  const addProduct = async () => {
    if (newUrls.every(u => !u.trim()) || !selectedListId || !activeProfileId) return;
    
    const urls = newUrls.map(u => u.trim()).filter(u => u.length > 0);
    if (urls.length === 0) return;

    setIsLoading(true);
    const controller = new AbortController();
    setAbortController(controller);
    
    setSystemMessage(`INITIATING SCRAPE SEQUENCE FOR ${urls.length} TARGETS...`);
    playSound('scan');
    
    let successCount = 0;
    let failCount = 0;

    try {
      const concurrencyLimit = 5; // Increased concurrency
      
      for (let i = 0; i < urls.length; i += concurrencyLimit) {
        if (controller.signal.aborted) break;
        
        const chunk = urls.slice(i, i + concurrencyLimit);
        setSystemMessage(`SCRAPING TARGETS ${i + 1}-${Math.min(i + concurrencyLimit, urls.length)}/${urls.length}...`);
        
        const results = await Promise.all(chunk.map(async (url) => {
          const individualController = new AbortController();
          const timeoutId = setTimeout(() => individualController.abort(), 60000); // 60s timeout per target
          
          try {
            const response = await fetch("/api/scrape", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ 
                url: url,
                profileId: activeProfileId 
              }),
              signal: individualController.signal
            });
            
            clearTimeout(timeoutId);
            
            if (!response.ok) {
              const errorData = await response.json().catch(() => ({}));
              throw new Error(errorData.error || "Scrape failed");
            }
            
const info = await response.json();

    if (info.method) {
      setSystemMessage(`DATA EXTRACTED VIA: ${info.method.toUpperCase()}`);
}

  // Generate ID based on URL for consistency (same logic as backend)
  const normalizeProductUrl = (url: string): string => {
    try {
      const parsed = new URL(url);
      const trackingParams = [
        'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
        'ref', 'affiliate', 'src', 'source', 'fbclid', 'gclid', 'msclkid',
        'cmp', 'abtest', 'promo', 'category', 'gad_source', 'gad_campaignid',
        'gclid', 'msclkid', 'fbclid'
      ];
      trackingParams.forEach(param => parsed.searchParams.delete(param));
      parsed.hash = '';

      // Extract product ID for known patterns - return standardized format
      const patterns = [
        { regex: /\/produto\/(\d+)/, format: (m: RegExpMatchArray) => `/produto/${m[1]}` }, // Terabyte, Pichau
        { regex: /\/dp\/([A-Z0-9]+)/, format: (m: RegExpMatchArray) => `/dp/${m[1]}` }, // Amazon
        { regex: /\/MLB-(\d+)/, format: (m: RegExpMatchArray) => `/MLB-${m[1]}` }, // Mercado Livre
        { regex: /\/p\/([a-z0-9]+)/i, format: (m: RegExpMatchArray) => `/p/${m[1]}` }, // Magalu
        { regex: /\/product\/(\d+)/, format: (m: RegExpMatchArray) => `/product/${m[1]}` }, // Generic
        { regex: /\/(\d+)\/p/, format: (m: RegExpMatchArray) => `/${m[1]}/p` }, // Alternative
        { regex: /\/sku\/([A-Z0-9]+)/i, format: (m: RegExpMatchArray) => `/sku/${m[1]}` }, // Kabum
      ];

      for (const { regex, format } of patterns) {
        const match = parsed.pathname.match(regex);
        if (match) {
          const normalizedPath = format(match);
          console.log(`[URL Normalization] ${parsed.pathname} -> ${normalizedPath}`);
          return `${parsed.origin}${normalizedPath}`;
        }
      }

      // Se não match, usar pathname completo sem trailing slash
      const cleanPath = parsed.pathname.replace(/\/$/, '') || '/';
      return `${parsed.origin}${cleanPath}`;
    } catch {
      return url;
    }
  };

  const generateProductIdFromUrl = (url: string): string => {
    const normalized = normalizeProductUrl(url);
    let hash = 0;
    for (let i = 0; i < normalized.length; i++) {
      const char = normalized.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
  };

  const product = {
    id: generateProductIdFromUrl(url),
      name: info.name || "UNKNOWN PRODUCT",
      url: url,
      currentPrice: info.price || 0,
      previousPrice: info.price || 0,
      currency: info.currency || "BRL",
      available: info.available ?? true,
      imageUrl: info.imageUrl,
      lastUpdated: new Date().toISOString(),
      lastScrapeMethod: info.method,
      priceHistory: [{ date: new Date().toISOString(), price: info.price || 0 }],
      listId: selectedListId,
      profileId: activeProfileId
    };

    // Save to server immediately
    const saveResponse = await fetch("/api/products", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(product)
    });
    
    const saveResult = await saveResponse.json();
    
    if (saveResult.action === "exists") {
      console.log(`Product already exists: ${product.name}`);
    } else if (saveResult.action === "updated") {
      console.log(`Product price updated: ${product.name}`);
    }
    
    return product;
    } catch (error: any) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') {
        console.error(`Scrape timed out for ${url}`);
        addToast(`TIMEOUT: ${url.substring(0, 30)}...`, "error");
      } else {
        console.error(`Failed to scrape ${url}:`, error);
        const errorMsg = error.message || "Falha no scraping";
        const errorDetails = error.details || error.fullError || error.stack || "Sem detalhes";
        addToast(`ERRO: ${errorMsg}`, "error", errorDetails);
      }
      failCount++;
      return null;
    }
        }));

        results.forEach(p => {
          if (p) {
            successCount++;
          }
        });
      }
      
      // Final re-fetch to ensure everything is in sync
      await fetchData();
      
      if (!controller.signal.aborted) {
        setNewUrls([""]);
        setIsAddingProduct(false);
        setSystemMessage(`SEQUENCE COMPLETE: ${successCount} ACQUIRED, ${failCount} FAILED`);
        if (successCount > 0) addToast(`${successCount} TARGETS LOGGED TO ARCHIVE`, "success");
        if (failCount > 0) addToast(`${failCount} TARGETS FAILED TO RESOLVE`, "error");
      }
    } catch (error) {
      setSystemMessage("ERROR: CORE SEQUENCE FAILURE");
    } finally {
      setIsLoading(false);
      setAbortController(null);
    }
  };

  const cancelScrape = () => {
    if (abortController) {
      abortController.abort();
      setAbortController(null);
      setIsLoading(false);
      setSystemMessage("SCRAPE SEQUENCE ABORTED");
      playSound('error');
    }
  };

  const activeProfile = data.profiles.find(p => p.id === activeProfileId);

  if (!isDataLoaded) {
    return (
      <div className="h-screen w-screen flex flex-col bg-[#0a0a0a] relative overflow-hidden items-center justify-center p-8 text-center">
        <div className="scanline" />
        {loadError ? (
          <motion.div 
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="flex flex-col items-center gap-6"
          >
            <ShieldAlert className="text-red-500 animate-pulse" size={64} />
            <div className="flex flex-col gap-2">
              <h2 className="text-xl font-mono font-bold text-red-500 glow-text">CRITICAL SYSTEM FAILURE</h2>
              <p className="font-mono text-xs text-red-500/70 uppercase tracking-widest">{loadError}</p>
            </div>
            <button 
              onClick={() => window.location.reload()}
              className="hud-button border-red-500/50 text-red-500 hover:bg-red-500/10 px-8"
            >
              REBOOT SYSTEM
            </button>
          </motion.div>
        ) : (
          <>
            <RefreshCw className="animate-spin text-crimson mb-4" size={48} />
            <span className="font-mono text-crimson animate-pulse tracking-[0.2em]">INITIALIZING HUD...</span>
            <span className="font-mono text-[8px] text-crimson/30 mt-4 uppercase">{systemMessage}</span>
          </>
        )}
      </div>
    );
  }

  const compareProduct = async (product: Product) => {
    const now = Date.now();
    if (now - lastSearchTime < SEARCH_COOLDOWN) {
      const remaining = Math.ceil((SEARCH_COOLDOWN - (now - lastSearchTime)) / 1000);
      addToast(`SYSTEM COOLING: Wait ${remaining}s`, "error");
      return;
    }

    setComparingProduct(product.id);
    setIsComparing(true);
    setLastSearchTime(now);
    setScanTimeout(180);
    setSystemMessage(`INITIATING MARKET SCAN: ${product.name.toUpperCase()}`);

    const controller = new AbortController();
    setScanController(controller);

    // Countdown timer
    const countdownInterval = setInterval(() => {
      setScanTimeout(prev => {
        if (prev <= 1) {
          clearInterval(countdownInterval);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    try {
      const response = await fetch("/api/compare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productName: product.name,
          profileId: activeProfileId
        }),
        signal: controller.signal
      });

      clearInterval(countdownInterval);

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || "Comparison failed");
      }

      const results = await response.json();
      console.log("MARKET SCAN RESULTS ACQUIRED:", results);

      // Only update if we are still looking at the same product
      setSelectedProductId(currentId => {
        if (currentId === product.id) {
          setComparisonResults(results);
          setSystemMessage("COMPARISON DATA RETRIEVED");
          addToast("MARKET TELEMETRY ACQUIRED", "success");
        }
        return currentId;
      });

      // Update product with comparison results and best price
      const newProducts = data.products.map(p => {
        if (p.id === product.id) {
          const now = new Date().toISOString();
          const bestPrice = results.length > 0 ? Math.min(...results.map((r: any) => r.price)) : p.currentPrice;
          const priceChanged = bestPrice !== p.currentPrice;

          return {
            ...p,
            previousPrice: priceChanged ? p.currentPrice : p.previousPrice,
            currentPrice: bestPrice,
            lastUpdated: now,
            priceHistory: priceChanged ? [...p.priceHistory, { date: now, price: bestPrice }] : p.priceHistory,
            comparisonResults: results
          };
        }
        return p;
      });

      const newData = { ...data, products: newProducts };
      setData(newData);
      saveData(newData);

      if (results.length > 0) {
        const bestPrice = Math.min(...results.map((r: any) => r.price));
        if (bestPrice < product.currentPrice) {
          addToast("BEST MARKET PRICE APPLIED TO TRACKER", "success");
        } else if (bestPrice > product.currentPrice) {
          addToast("PRICE INCREASE DETECTED: PROMOTION MAY HAVE ENDED", "info");
        }
      }
    } catch (error: any) {
      clearInterval(countdownInterval);
      
      if (error.name === 'AbortError') {
        setSystemMessage("MARKET SCAN CANCELLED BY USER");
        addToast("Market scan cancelled", "info");
      } else {
        const msg = error.message || "COMPARISON SEQUENCE FAILED";
        setSystemMessage(`ERROR: ${msg.toUpperCase()}`);
        addToast(msg, "error", error.stack);
      }
    } finally {
      clearInterval(countdownInterval);
      setIsComparing(false);
      setComparingProduct(null);
      setScanController(null);
      setScanTimeout(0);
    }
  };

  const cancelCompare = () => {
    if (scanController) {
      scanController.abort();
      setIsComparing(false);
      setComparingProduct(null);
      setScanController(null);
      setScanTimeout(0);
      setSystemMessage("MARKET SCAN CANCELLED BY USER");
      addToast("Market scan cancelled", "info");
    }
  };

  const createProfile = () => {
    if (!newProfileName) return;
    const newProfile: Profile = {
      id: Math.random().toString(36).substr(2, 9),
      name: newProfileName,
    };
    const newData = { ...data, profiles: [...data.profiles, newProfile] };
    saveData(newData);
    setActiveProfileId(newProfile.id);
    setNewProfileName("");
    setIsCreatingProfile(false);
    setSystemMessage(`PROFILE CREATED: ${newProfile.name.toUpperCase()}`);
  };

  if (!activeProfileId || !activeProfile) {
    if (data.profiles.length > 0) {
      return (
        <div className="h-screen w-screen flex flex-col bg-[#0a0a0a] relative overflow-hidden">
          <div className="scanline" />
          
          {isElectron && (
            <div className="h-6 bg-black/80 border-b border-crimson/20 flex items-center justify-between px-4 z-[100] app-drag">
              <div className="flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-crimson animate-pulse" />
                <span className="text-[8px] font-mono text-crimson/50 tracking-widest">CRIMSON_SENTINEL_HUD_ACTIVE</span>
              </div>
          <div className="flex items-center gap-2 app-no-drag">
            <button onClick={minimizeApp} className="text-crimson/30 hover:text-crimson transition-colors p-1">
              <Minus size={12} />
            </button>
            <button onClick={maximizeApp} className="text-crimson/30 hover:text-crimson transition-colors p-1">
              <Square size={10} />
            </button>
            <button onClick={closeApp} className="text-crimson/30 hover:text-crimson transition-colors p-1">
              <X size={12} />
            </button>
          </div>
            </div>
          )}

          <div className="flex-1 flex items-center justify-center">
            <motion.div 
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              className="hud-border p-12 bg-black/60 max-w-md w-full flex flex-col gap-8 z-10"
            >
              <div className="text-center">
                <Cpu className="text-crimson mx-auto mb-4 animate-pulse" size={48} />
                <h1 className="text-2xl font-mono font-bold glow-text tracking-tighter">CRIMSON SENTINEL</h1>
                <p className="text-[10px] font-mono text-crimson/50 mt-2 tracking-widest">SELECT OPERATOR PROFILE</p>
              </div>
              
              <div className="flex flex-col gap-3">
                {data.profiles.map(profile => (
                  <button 
                    key={profile.id}
                    onClick={() => setActiveProfileId(profile.id)}
                    className="hud-button w-full py-4 text-sm flex items-center justify-between group"
                  >
                    <span>{profile.name.toUpperCase()}</span>
                    <ChevronRight className="group-hover:translate-x-1 transition-transform" size={16} />
                  </button>
                ))}
                <button 
                  onClick={() => setIsCreatingProfile(true)}
                  className="hud-button w-full py-4 text-sm border-dashed border-crimson/30 bg-transparent hover:bg-crimson/5"
                >
                  + NEW OPERATOR
                </button>
              </div>
            </motion.div>
          </div>

          <AnimatePresence>
            {isCreatingProfile && (
              <Modal title="INITIALIZE NEW OPERATOR" onClose={() => setIsCreatingProfile(false)}>
                <div className="flex flex-col gap-4">
                  <input 
                    autoFocus
                    className="hud-input w-full" 
                    placeholder="OPERATOR NAME" 
                    value={newProfileName}
                    onChange={(e) => setNewProfileName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && createProfile()}
                  />
                  <button onClick={createProfile} className="hud-button w-full">CONFIRM IDENTITY</button>
                </div>
</Modal>
          )}

          {showConfirmPurge && (
            <Modal title="PURGE OPERATOR DATA" onClose={() => setShowConfirmPurge(false)}>
              <div className="flex flex-col gap-6">
                <div className="flex flex-col items-center gap-4 py-4">
                  <ShieldAlert className="text-red-500 animate-pulse" size={48} />
                  <p className="text-center font-mono text-xs text-crimson/70">
                    THIS ACTION WILL PERMANENTLY DELETE ALL DATA ASSOCIATED WITH THIS OPERATOR.
                    <br /><br />
                    <span className="text-red-500 font-bold">THIS CANNOT BE UNDONE.</span>
                  </p>
                </div>
                <div className="flex gap-4">
                  <button
                    onClick={() => setShowConfirmPurge(false)}
                    className="hud-button flex-1 border-crimson/30"
                  >
                    CANCEL
                  </button>
                  <button
                    onClick={() => {
                      const newData = {
                        ...data,
                        profiles: data.profiles.filter(p => p.id !== activeProfileId),
                        lists: data.lists.filter(l => l.profileId !== activeProfileId),
                        products: data.products.filter(p => p.profileId !== activeProfileId)
                      };
                      saveData(newData);
                      setActiveProfileId(null);
                      setShowConfirmPurge(false);
                      addToast("OPERATOR PROFILE PURGED", "success");
                    }}
                    className="hud-button flex-1 border-red-500/50 text-red-500 hover:bg-red-500/10"
                  >
                    PURGE DATA
                  </button>
                </div>
              </div>
            </Modal>
          )}
          </AnimatePresence>
        </div>
      );
    }

    // No profiles at all
    return (
      <div className="h-screen w-screen flex flex-col bg-[#0a0a0a] relative overflow-hidden">
        <div className="scanline" />
        
        {isElectron && (
          <div className="h-6 bg-black/80 border-b border-crimson/20 flex items-center justify-between px-4 z-[100] app-drag">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-crimson animate-pulse" />
              <span className="text-[8px] font-mono text-crimson/50 tracking-widest">CRIMSON_SENTINEL_HUD_ACTIVE</span>
            </div>
          <div className="flex items-center gap-2 app-no-drag">
            <button onClick={minimizeApp} className="text-crimson/30 hover:text-crimson transition-colors p-1">
              <Minus size={12} />
            </button>
            <button onClick={maximizeApp} className="text-crimson/30 hover:text-crimson transition-colors p-1">
              <Square size={10} />
            </button>
            <button onClick={closeApp} className="text-crimson/30 hover:text-crimson transition-colors p-1">
              <X size={12} />
            </button>
          </div>
          </div>
        )}

        <div className="flex-1 flex items-center justify-center">
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="hud-border p-12 bg-black/60 max-w-md w-full flex flex-col gap-8 z-10"
          >
            <div className="text-center">
              <ShieldAlert className="text-crimson mx-auto mb-4 animate-pulse" size={48} />
              <h1 className="text-2xl font-mono font-bold glow-text tracking-tighter">NO OPERATOR DETECTED</h1>
              <p className="text-[10px] font-mono text-crimson/50 mt-2 tracking-widest">SYSTEM INITIALIZATION REQUIRED</p>
            </div>
            
            <div className="flex flex-col gap-4">
              <input 
                autoFocus
                className="hud-input w-full" 
                placeholder="ENTER OPERATOR NAME" 
                value={newProfileName}
                onChange={(e) => setNewProfileName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && createProfile()}
              />
              <button onClick={createProfile} className="hud-button w-full py-4">INITIALIZE SYSTEM</button>
            </div>
          </motion.div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen flex flex-col relative overflow-hidden bg-[#0a0a0a]">
      <div className="scanline" />
      
      {/* Background HUD Elements */}
      <div className="fixed inset-0 z-0 overflow-hidden pointer-events-none">
        <div className="absolute inset-0 hud-grid opacity-20" />
        <div className="absolute inset-0 hud-vignette" />
        <div className="absolute inset-0 hud-scanline-overlay opacity-10" />
        
        {/* Floating Particles */}
        {[...Array(15)].map((_, i) => (
          <div 
            key={i} 
            className="hud-particle"
            style={{ 
              left: `${Math.random() * 100}%`, 
              animationDelay: `${Math.random() * 15}s`,
              width: `${Math.random() * 3 + 1}px`,
              height: `${Math.random() * 3 + 1}px`
            }} 
          />
        ))}
      </div>
      
      {isElectron && (
        <div className="h-6 bg-black/80 border-b border-crimson/20 flex items-center justify-between px-4 z-[100] app-drag">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-crimson animate-pulse" />
            <span className="text-[8px] font-mono text-crimson/50 tracking-widest">CRIMSON_SENTINEL_HUD_ACTIVE</span>
          </div>
          <div className="flex items-center gap-2 app-no-drag">
            <button onClick={minimizeApp} className="text-crimson/30 hover:text-crimson transition-colors p-1">
              <Minus size={12} />
            </button>
            <button onClick={maximizeApp} className="text-crimson/30 hover:text-crimson transition-colors p-1">
              <Square size={10} />
            </button>
            <button onClick={closeApp} className="text-crimson/30 hover:text-crimson transition-colors p-1">
              <X size={12} />
            </button>
          </div>
        </div>
      )}
      
      {/* Header HUD */}
      <header className="h-16 border-b border-crimson/30 flex items-center justify-between px-8 bg-black/40 backdrop-blur-md z-10">
        <div className="flex items-center gap-4">
          <Cpu className="text-crimson animate-pulse" size={24} />
          <h1 className="text-xl font-mono font-bold tracking-tighter glow-text">
            CRIMSON SENTINEL <span className="text-[10px] text-crimson/50 align-top">v1.0.4</span>
          </h1>
        </div>
        
        <div className="flex items-center gap-8 font-mono text-xs">
          <div className="flex flex-col items-end">
            <span className="text-crimson/50">OPERADOR</span>
            <span className="text-white">{activeProfile?.name.toUpperCase()}</span>
          </div>
          <div className="h-8 w-[1px] bg-crimson/30" />
          <div className="flex flex-col items-end">
            <span className="text-crimson/50">STATUS DO SISTEMA</span>
            <span className="text-crimson animate-pulse-red">{systemMessage}</span>
          </div>
          <div className="h-8 w-[1px] bg-crimson/30" />
          <div className="flex flex-col items-end">
            <span className="text-crimson/50">NODOS RASTREADOS</span>
            <span className="text-white">{profileProducts.length} ATIVOS</span>
          </div>
          <div className="h-8 w-[1px] bg-crimson/30" />
          <button 
            onClick={() => window.location.reload()} 
            className="text-crimson/30 hover:text-crimson transition-colors"
            title="RELOAD SYSTEM"
          >
            <RefreshCw size={16} />
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar HUD */}
        <nav className="w-20 border-r border-crimson/30 flex flex-col items-center py-8 gap-8 bg-black/20 z-10 relative">
          <div className="absolute inset-0 pointer-events-none opacity-5 flex items-center justify-center overflow-hidden">
            <div className="w-64 h-64 border-4 border-dashed border-crimson rounded-full hud-rotate" />
            <div className="absolute w-48 h-48 border-2 border-dotted border-crimson rounded-full hud-rotate [animation-direction:reverse]" />
          </div>
          <NavButton 
            active={activeTab === "dashboard"} 
            onClick={() => { playSound('click'); setActiveTab("dashboard"); setSelectedListId(null); }}
            icon={<LayoutDashboard size={24} />}
            label="DASHBOARD"
          />
          <NavButton 
            active={activeTab === "lists"} 
            onClick={() => { playSound('click'); setActiveTab("lists"); }}
            icon={<ListPlus size={24} />}
            label="LISTS"
          />
          <NavButton 
            active={activeTab === "settings"} 
            onClick={() => { playSound('click'); setActiveTab("settings"); }}
            icon={<Settings size={24} />}
            label="CONFIG"
          />
          <div className="mt-auto flex flex-col gap-4">
            <NavButton 
              active={false} 
              onClick={() => { playSound('click'); setActiveProfileId(null); }}
              icon={<User size={24} />}
              label="SWITCH"
            />
          </div>
        </nav>

        {/* Main Content Area */}
        <main className="flex-1 overflow-y-auto p-8 relative">
          <AnimatePresence mode="wait">
            {activeTab === "dashboard" && (
              <motion.div 
                key="dashboard"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6"
              >
                <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.1 }}>
                  <StatCard label="TOTAL DE PRODUTOS" value={profileProducts.length} />
                </motion.div>
                <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.2 }}>
                  <StatCard label="QUEDAS DE PREÇO" value={profileProducts.filter(p => p.currentPrice < p.previousPrice).length} color="text-green-500" />
                </motion.div>
                <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 }}>
                  <StatCard 
                    label="ALERTAS ENVIADOS" 
                    value={profileProducts.reduce((acc, p) => acc + (p.priceHistory?.filter((h, i) => i > 0 && h.price < p.priceHistory[i-1].price).length || 0), 0)} 
                  />
                </motion.div>
                
                <motion.div 
                  initial={{ opacity: 0, y: 20 }} 
                  animate={{ opacity: 1, y: 0 }} 
                  transition={{ delay: 0.4 }}
                  className="col-span-full mt-8"
                >
                  <h2 className="text-sm font-mono text-crimson/50 mb-4 tracking-[0.3em]">ATIVIDADE RECENTE</h2>
                  <div className="hud-border bg-black/40 p-6 flex flex-col gap-4">
                    {profileProducts.slice(0, 5).map((product, idx) => (
                      <motion.div 
                        key={product.id} 
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: 0.5 + (idx * 0.1) }}
                        onClick={() => { playSound('click'); setSelectedProductId(product.id); }}
                        className="flex items-center justify-between border-b border-crimson/10 pb-2 cursor-pointer hover:bg-crimson/5 transition-colors group"
                      >
                        <div className="flex items-center gap-4">
                          <div className="w-2 h-2 rounded-full bg-crimson animate-pulse" />
                          <span className="font-mono text-sm font-bold group-hover:text-crimson transition-colors">{product.name}</span>
                        </div>
                        <span className="text-xs text-crimson/50 font-mono">{new Date(product.lastUpdated).toLocaleTimeString()}</span>
                      </motion.div>
                    ))}
                    {profileProducts.length === 0 && <div className="text-center py-8 text-crimson/30 font-mono italic">NENHUM DADO DETECTADO</div>}
                  </div>
                </motion.div>

                <motion.div 
                  initial={{ opacity: 0, y: 20 }} 
                  animate={{ opacity: 1, y: 0 }} 
                  transition={{ delay: 0.5 }}
                  className="col-span-full mt-8"
                >
                  <h2 className="text-sm font-mono text-crimson/50 mb-4 tracking-[0.3em]">TELEMETRIA DE LISTA (VALOR TOTAL AO LONGO DO TEMPO)</h2>
                  <div className="hud-border bg-black/40 p-6 h-80">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={listHistoryData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#222" vertical={false} />
                        <XAxis 
                          dataKey="date" 
                          stroke="#444" 
                          fontSize={10} 
                          fontFamily="monospace" 
                          tickLine={false}
                          axisLine={false}
                        />
                        <YAxis 
                          stroke="#444" 
                          fontSize={10} 
                          fontFamily="monospace" 
                          tickLine={false}
                          axisLine={false}
                          tickFormatter={(val) => `BRL ${val}`}
                        />
                        <Tooltip 
                          contentStyle={{ backgroundColor: '#000', border: '1px solid #900', borderRadius: '0px', fontFamily: 'monospace' }}
                          itemStyle={{ color: '#f00' }}
                        />
                        {profileLists.map((list, idx) => (
                          <Line 
                            key={list.id}
                            type="monotone" 
                            dataKey={list.name} 
                            stroke={idx % 2 === 0 ? "#f00" : "#900"} 
                            strokeWidth={2} 
                            dot={{ r: 4, fill: idx % 2 === 0 ? "#f00" : "#900", strokeWidth: 0 }}
                            activeDot={{ 
                              r: 6, 
                              fill: '#fff', 
                              stroke: '#f00',
                              onClick: () => {
                                playSound('click');
                                setSelectedListId(list.id);
                                setActiveTab("lists");
                              }
                            }}
                            connectNulls
                          />
                        ))}
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </motion.div>
              </motion.div>
            )}

            {activeTab === "lists" && (
              <motion.div 
                key="lists"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="flex flex-col gap-8"
              >
                <div className="flex items-center justify-between">
                  <h2 className="text-sm font-mono text-crimson/50 tracking-[0.3em]">PRODUCT ARCHIVES</h2>
                  <button onClick={() => { playSound('click'); setIsAddingList(true); }} className="hud-button flex items-center gap-2">
                    <Plus size={16} /> NEW ARCHIVE
                  </button>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {profileLists.map((list, idx) => (
                    <motion.div 
                      key={list.id} 
                      initial={{ opacity: 0, y: 20 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: idx * 0.05 }}
                      onClick={() => { playSound('click'); setSelectedListId(list.id); }}
                      className={cn(
                        "hud-border p-6 cursor-pointer transition-all hover:bg-crimson/5 group",
                        selectedListId === list.id && "bg-crimson/10 border-crimson/60 shadow-[0_0_20px_rgba(255,0,0,0.2)]"
                      )}
                    >
                      <div className="flex justify-between items-start mb-4">
                        <h3 className="font-mono font-bold text-lg group-hover:glow-text transition-all">{list.name}</h3>
                        <div className="flex items-center gap-2">
                          <button 
                            onClick={(e) => { e.stopPropagation(); playSound('click'); deleteList(list.id); }}
                            className="text-crimson/30 hover:text-crimson"
                          >
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </div>
                      
                      {list.budget && (
                        <div className="mb-4">
                          <div className="flex justify-between text-[8px] font-mono text-crimson/50 mb-1 uppercase tracking-widest">
                            <span>BUDGET PROGRESS</span>
                            <span>{Math.round((profileProducts.filter(p => p.listId === list.id).reduce((sum, p) => sum + p.currentPrice, 0) / list.budget) * 100)}%</span>
                          </div>
                          <div className="h-1 w-full bg-crimson/10 overflow-hidden">
                            <motion.div 
                              initial={{ width: 0 }}
                              animate={{ width: `${Math.min(100, (profileProducts.filter(p => p.listId === list.id).reduce((sum, p) => sum + p.currentPrice, 0) / list.budget) * 100)}%` }}
                              className={cn(
                                "h-full",
                                (profileProducts.filter(p => p.listId === list.id).reduce((sum, p) => sum + p.currentPrice, 0) / list.budget) > 1 ? "bg-red-500 shadow-[0_0_10px_rgba(239,68,68,0.5)]" : "bg-green-500 shadow-[0_0_10px_rgba(34,197,94,0.5)]"
                              )}
                            />
                          </div>
                        </div>
                      )}

                      <div className="flex items-center justify-between text-xs font-mono text-crimson/50">
                        <span>{profileProducts.filter(p => p.listId === list.id).length} ITEMS</span>
                        <span>{new Date(list.createdAt).toLocaleDateString()}</span>
                      </div>
                    </motion.div>
                  ))}
                </div>

                {selectedListId && (
                  <motion.div 
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="mt-8"
                  >
                    <div className="flex items-center justify-between mb-6">
                      <div className="flex flex-col">
                        <h2 className="text-sm font-mono text-crimson/50 tracking-[0.3em]">
                          {profileLists.find(l => l.id === selectedListId)?.name.toUpperCase()} CONTENTS
                        </h2>
                        <div className="flex items-center gap-4 mt-2">
                          <div className="flex items-center gap-2">
                            <Wallet size={12} className="text-crimson/50" />
                            <span className="text-[10px] font-mono text-crimson/30 uppercase">BUDGET:</span>
                            <input 
                              type="number"
                              className="hud-input py-1 px-2 text-[10px] w-24"
                              placeholder="SET BUDGET..."
                              value={profileLists.find(l => l.id === selectedListId)?.budget || ""}
                              onChange={(e) => updateListBudget(selectedListId, e.target.value ? parseFloat(e.target.value) : undefined)}
                            />
                          </div>
                          <button 
                            onClick={() => { playSound('click'); setShowComparisonGrid(true); }}
                            className="text-[10px] font-mono text-crimson/50 hover:text-crimson flex items-center gap-2"
                          >
                            <Grid3X3 size={12} /> MATRIX VIEW
                          </button>
                        </div>
                      </div>
          <button onClick={() => { playSound('click'); setIsAddingProduct(true); }} className="hud-button flex items-center gap-2">
            <Plus size={16} /> ADD LINK
          </button>
        </div>

        {/* Market Scan Progress UI */}
        {isComparing && (
          <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            className="mb-6 p-4 hud-border bg-black/80"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <RefreshCw className="animate-spin text-crimson" size={20} />
                <div className="flex flex-col">
                  <span className="text-xs font-mono text-crimson/70 uppercase">Escaneando Mercado</span>
                  <span className="text-sm font-mono text-white truncate max-w-[300px]">
                    {comparingProduct ? profileProducts.find(p => p.id === comparingProduct)?.name : "Produto"}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-4">
                {/* Countdown */}
                <div className="flex items-center gap-2">
                  <span className={cn(
                    "text-sm font-mono font-bold",
                    scanTimeout <= 30 ? "text-red-500 animate-pulse" : "text-crimson"
                  )}>
                    {Math.floor(scanTimeout / 60)}:{(scanTimeout % 60).toString().padStart(2, '0')}
                  </span>
                </div>
                {/* Botão Cancelar */}
                <button
                  onClick={() => { playSound('click'); cancelCompare(); }}
                  className="px-3 py-1 text-xs font-mono bg-red-500/20 border border-red-500/50 hover:bg-red-500 hover:text-black transition-all"
                >
                  CANCELAR
                </button>
              </div>
            </div>
            {/* Barra de Progresso */}
            <div className="w-full h-1 bg-crimson/20 overflow-hidden mt-3">
              <motion.div
                initial={{ width: "100%" }}
                animate={{ width: "0%" }}
                transition={{ duration: 180, ease: "linear" }}
                className="h-full bg-crimson"
              />
            </div>
          </motion.div>
        )}

        <div className="grid grid-cols-1 gap-4">
                      {profileProducts.filter(p => p.listId === selectedListId).map((product, idx) => (
                        <motion.div
                          key={product.id}
                          initial={{ opacity: 0, x: -20 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ delay: idx * 0.05 }}
                        >
                          <ProductRow 
                            product={product} 
                            onDelete={() => { playSound('click'); deleteProduct(product.id); }} 
                            onCompare={() => { playSound('click'); compareProduct(product); }}
                            onClick={() => { playSound('click'); setSelectedProductId(product.id); }}
                            isComparing={comparingProduct === product.id}
                          />
                        </motion.div>
                      ))}
                      {profileProducts.filter(p => p.listId === selectedListId).length === 0 && (
                        <div className="hud-border p-12 text-center text-crimson/30 font-mono">
                          NO PRODUCTS IN THIS ARCHIVE
                        </div>
                      )}
                    </div>
                  </motion.div>
                )}
              </motion.div>
            )}

            {activeTab === "settings" && (
              <motion.div 
                key="settings"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="max-w-2xl mx-auto"
              >
                <h2 className="text-sm font-mono text-crimson/50 tracking-[0.3em] mb-8">SYSTEM CONFIGURATION</h2>
                <div className="hud-border bg-black/40 p-8 flex flex-col gap-8">
                  <ConfigSection title="AI CORE PARAMETERS">
                    <div className="grid grid-cols-1 gap-4">
<InputGroup
                  label="GEMINI API KEY"
                  placeholder="AIzaSy..."
                  type="password"
                  value={activeProfile?.geminiApiKey || ""}
                  onChange={(val) => updateProfileSetting("geminiApiKey", val)}
                />
                      <p className="text-[10px] font-mono text-crimson/50 px-4">
                        * REQUIRED FOR SCRAPING AND COMPARISON. GET ONE AT AISTUDIO.GOOGLE.COM
                      </p>
                    </div>
                  </ConfigSection>

                  <ConfigSection title="COMMUNICATION CHANNELS">
                    <div className="grid grid-cols-1 gap-4">
<InputGroup
                  label="DISCORD WEBHOOK"
                  placeholder="https://discord.com/api/webhooks/..."
                  type="password"
                  value={activeProfile?.discordWebhook || ""}
                  onTest={testDiscord}
                  onChange={(val) => updateProfileSetting("discordWebhook", val)}
                />
<InputGroup
                  label="TELEGRAM BOT TOKEN"
                  placeholder="0000000000:AA..."
                  type="password"
                  value={activeProfile?.telegramToken || ""}
                  onTest={testTelegram}
                  onChange={(val) => updateProfileSetting("telegramToken", val)}
                />
<InputGroup
                  label="TELEGRAM CHAT ID"
                  placeholder="-100..."
                  type="password"
                  value={activeProfile?.telegramChatId || ""}
                  onChange={(val) => updateProfileSetting("telegramChatId", val)}
                />
                <InputGroup
                  label="GMAIL ADDRESS"
                  placeholder="user@gmail.com"
                  type="password"
                  value={activeProfile?.gmailUser || ""}
                  onTest={testEmail}
                  onChange={(val) => updateProfileSetting("gmailUser", val)}
                />
                <InputGroup
                  label="GMAIL APP PASSWORD"
                  placeholder="xxxx xxxx xxxx xxxx"
                  type="password"
                  value={activeProfile?.gmailPass || ""}
                  onChange={(val) => updateProfileSetting("gmailPass", val)}
                />
                      <p className="text-[10px] font-mono text-crimson/50 px-4">
                        * GMAIL REQUIRES AN "APP PASSWORD" (16 CHARS). ENABLE 2FA IN GOOGLE ACCOUNT SETTINGS TO GENERATE ONE.
                      </p>
                    </div>
                  </ConfigSection>

                  <ConfigSection title="ADVANCED SCRAPING PIPELINE">
                    <div className="grid grid-cols-1 gap-4">
                      <div className="flex items-center justify-between p-4 border border-crimson/20 bg-crimson/5">
                        <div className="flex items-center gap-4">
                          <Cpu className="text-crimson" size={20} />
                          <div className="flex flex-col">
                            <span className="text-xs font-mono">ENABLE ADVANCED PIPELINE</span>
                            <span className="text-[8px] font-mono text-crimson/50 uppercase">PLAYWRIGHT + QWEN + NVIDIA FALLBACK</span>
                          </div>
                        </div>
<button
                  onClick={() => updateProfileSetting("useAdvancedScraping", !activeProfile?.useAdvancedScraping)}
                  className={cn(
                            "w-12 h-6 border transition-all relative",
                            activeProfile?.useAdvancedScraping ? "border-crimson bg-crimson/20" : "border-crimson/30 bg-black"
                          )}
                        >
                          <div className={cn(
                            "absolute top-1 w-4 h-4 transition-all",
                            activeProfile?.useAdvancedScraping ? "right-1 bg-crimson" : "left-1 bg-crimson/30"
                          )} />
                        </button>
                      </div>

                      {activeProfile?.useAdvancedScraping && (
                        <motion.div 
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          className="grid grid-cols-1 gap-4"
                        >
<InputGroup
                    label="LM STUDIO URL (LOCAL LLM)"
                    placeholder="http://localhost:1234/v1"
                    value={activeProfile?.lmStudioUrl || ""}
                    onChange={(val) => updateProfileSetting("lmStudioUrl", val)}
                  />
                  <InputGroup
                    label="NVIDIA API KEY (FALLBACK)"
                    placeholder="nvapi-..."
                    type="password"
                    value={activeProfile?.nvidiaApiKey || ""}
                    onChange={(val) => updateProfileSetting("nvidiaApiKey", val)}
                  />
                        </motion.div>
                      )}
                    </div>
                  </ConfigSection>
                  
                  <ConfigSection title="MARKET ANALYSIS (SEARCH)">
                    <div className="grid grid-cols-1 gap-4">
<InputGroup
                  label="SERPER.DEV API KEY"
                  placeholder="serper_..."
                  type="password"
                  value={activeProfile?.serperApiKey || ""}
                  onChange={(val) => updateProfileSetting("serperApiKey", val)}
                />
                <InputGroup
                  label="TAVILY API KEY"
                  placeholder="tvly-..."
                  type="password"
                  value={activeProfile?.tavilyApiKey || ""}
                  onChange={(val) => updateProfileSetting("tavilyApiKey", val)}
                />
                      <p className="text-[10px] font-mono text-crimson/50 px-4">
                        * USE THESE AS ALTERNATIVES TO GEMINI SEARCH IF YOU HIT QUOTA LIMITS.
                      </p>
                    </div>
                  </ConfigSection>

<ConfigSection title="SCRAPE PARAMETERS">
              <div className="flex items-center justify-between p-4 border border-crimson/20 bg-crimson/5">
                <div className="flex items-center gap-4">
                  <ShieldAlert className="text-crimson" size={20} />
                  <span className="text-xs font-mono">AUTO-REFRESH INTERVAL</span>
                </div>
                <select 
                  className="bg-black border border-crimson/30 text-xs font-mono p-1"
                  value={activeProfile?.refreshInterval || "12"}
                  onChange={(e) => updateProfileSetting("refreshInterval", e.target.value)}
                >
                  <option value="1">1 HOUR</option>
                  <option value="6">6 HOURS</option>
                  <option value="12">12 HOURS</option>
                  <option value="24">24 HOURS</option>
                </select>
              </div>
            </ConfigSection>

<button onClick={() => { saveData(data); addToast("CONFIGURATION SAVED", "success"); }} className="hud-button w-full py-4 text-sm">SAVE CONFIGURATION</button>

            <div className="mt-12 pt-8 border-t border-crimson/20">
              <button
                onClick={() => setShowConfirmPurge(true)}
                className="text-crimson/50 hover:text-crimson text-[10px] font-mono flex items-center gap-2 mx-auto"
              >
                <Trash2 size={12} /> PURGE OPERATOR PROFILE
              </button>
            </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </main>
      </div>

      {/* Modals */}
      <AnimatePresence>
        {selectedProductId && (
          <ProductDetailModal 
            product={data.products.find(p => p.id === selectedProductId)!} 
            onClose={() => { setSelectedProductId(null); setComparisonResults([]); setAiInsight(null); }}
            onCompare={() => compareProduct(data.products.find(p => p.id === selectedProductId)!)}
            isComparing={comparingProduct === selectedProductId || (Date.now() - lastSearchTime < SEARCH_COOLDOWN)}
            comparisonResults={comparisonResults}
            onUpdateTargetPrice={updateProductTargetPrice}
            onGenerateAiInsight={generateAiInsight}
            aiInsight={aiInsight}
            isGeneratingInsight={isGeneratingInsight}
            onDeleteComparisonResult={deleteComparisonResult}
            onUpdateComparisonResult={updateComparisonResult}
            onAddComparisonResult={addComparisonResult}
          />
        )}

        {showComparisonGrid && selectedListId && (
          <ComparisonMatrix 
            list={profileLists.find(l => l.id === selectedListId)!}
            products={profileProducts.filter(p => p.listId === selectedListId)}
            onClose={() => setShowComparisonGrid(false)}
          />
        )}

        {isAddingList && (
          <Modal title="CREATE NEW ARCHIVE" onClose={() => setIsAddingList(false)}>
            <div className="flex flex-col gap-4">
              <input 
                autoFocus
                className="hud-input w-full" 
                placeholder="ARCHIVE NAME" 
                value={newListName}
                onChange={(e) => setNewListName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addList()}
              />
              <button onClick={() => { playSound('click'); addList(); }} className="hud-button w-full">INITIALIZE</button>
            </div>
          </Modal>
        )}

        {isAddingProduct && (
          <Modal title="ADD TRACKING TARGETS" onClose={() => { if (isLoading) cancelScrape(); setIsAddingProduct(false); }}>
            <div className="flex flex-col gap-4 relative">
              {isLoading && <div className="hud-scanner" />}
              <div className="flex flex-col gap-3 max-h-[400px] overflow-y-auto overflow-x-hidden pr-2 custom-scrollbar">
                <label className="text-[8px] font-mono text-crimson/70 tracking-widest ml-1 uppercase">
                  TARGET URLS
                </label>
                {newUrls.map((url, idx) => (
                  <div key={idx} className="flex gap-2">
                    <input 
                      autoFocus={idx === newUrls.length - 1}
                      className="hud-input flex-1 text-xs font-mono" 
                      placeholder="https://amazon.com.br/dp/..." 
                      value={url}
                      onChange={(e) => {
                        const updated = [...newUrls];
                        updated[idx] = e.target.value;
                        setNewUrls(updated);
                      }}
                      disabled={isLoading}
                    />
                    {newUrls.length > 1 && (
                      <button 
                        onClick={() => setNewUrls(newUrls.filter((_, i) => i !== idx))}
                        className="p-2 text-crimson/30 hover:text-crimson transition-colors"
                        disabled={isLoading}
                      >
                        <X size={16} />
                      </button>
                    )}
                  </div>
                ))}
                {!isLoading && (
                  <button 
                    onClick={() => { playSound('click'); setNewUrls([...newUrls, ""]); }}
                    className="text-[10px] font-mono text-crimson/50 hover:text-crimson flex items-center gap-2 mt-2 ml-1"
                  >
                    <Plus size={12} /> ADD ANOTHER TARGET
                  </button>
                )}
              </div>
              
              <div className="flex gap-2 mt-4">
                {isLoading ? (
                  <button 
                    onClick={cancelScrape}
                    className="hud-button w-full border-red-500/50 text-red-500 hover:bg-red-500/10 flex items-center justify-center gap-2"
                  >
                    <X size={16} /> ABORT SEQUENCE
                  </button>
                ) : (
                  <button 
                    onClick={() => { playSound('click'); addProduct(); }} 
                    disabled={isLoading || newUrls.every(u => !u.trim())}
                    className="hud-button w-full flex items-center justify-center gap-2"
                  >
                    <Plus size={16} /> BEGIN TRACKING
                  </button>
                )}
              </div>
              
              {isLoading && (
                <div className="text-[10px] font-mono text-crimson animate-pulse text-center">
                  SCRAPING DATA FROM EXTERNAL NODES...
                </div>
              )}
            </div>
          </Modal>
        )}

        {isComparing && (
          <Modal title="MARKET COMPARISON" onClose={() => { setIsComparing(false); setComparisonResults([]); }}>
            <div className="flex flex-col gap-4 relative min-h-[200px] justify-center">
              {comparingProduct ? (
                <div className="flex flex-col items-center py-12 gap-4">
                  <div className="hud-scanner" />
                  <RefreshCw className="animate-spin text-crimson" size={32} />
                  <span className="font-mono text-xs animate-pulse tracking-[0.2em]">SCANNING GLOBAL NODES...</span>
                </div>
              ) : comparisonResults.length > 0 ? (
                <div className="flex flex-col gap-3">
                  {comparisonResults.sort((a, b) => a.price - b.price).map((res, i) => (
                    <motion.div 
                      key={i} 
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: i * 0.1 }}
                      className={cn(
                        "hud-border p-3 bg-black/40 flex items-center justify-between group hover:bg-crimson/5 transition-all",
                        i === 0 && "border-green-500/50 bg-green-500/5 shadow-[0_0_15px_rgba(34,197,94,0.1)]"
                      )}
                    >
                      <div className="flex flex-col">
                        <span className="text-[10px] font-mono text-crimson/50 uppercase tracking-tight">{res.site}</span>
                        <span className={cn("text-sm font-mono font-bold", i === 0 ? "text-green-500" : "text-white")}>
                          BRL {res.price.toFixed(2)}
                        </span>
                      </div>
                      <div className="flex items-center gap-3">
                        {i === 0 && <span className="text-[8px] font-bold text-green-500 border border-green-500 px-1 animate-pulse">BEST DEAL</span>}
                        <a href={res.url} target="_blank" rel="noopener noreferrer" className="hud-button text-[10px] py-1 px-4">VIEW</a>
                      </div>
                    </motion.div>
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center py-12 gap-4 text-center">
                  <ShieldAlert className="text-crimson/30" size={48} />
                  <div className="flex flex-col gap-1">
                    <span className="font-mono text-sm text-crimson/50">NO COMPETITIVE DATA FOUND</span>
                    <span className="font-mono text-[8px] text-crimson/30 uppercase tracking-widest">TARGET MAY BE UNIQUE OR OUT OF STOCK</span>
                  </div>
                </div>
              )}
            </div>
          </Modal>
        )}
      </AnimatePresence>

{/* Toast Notifications */}
		<div className="fixed bottom-12 right-8 z-[200] flex flex-col gap-2 pointer-events-auto">
			<AnimatePresence>
				{toasts.map(toast => (
					<ToastWithTimer
						key={toast.id}
						toast={toast}
						onClose={() => removeToast(toast.id)}
						onCopy={() => copyToastError(toast)}
					/>
				))}
			</AnimatePresence>
		</div>

      {/* Footer HUD */}
      <footer className="h-8 border-t border-crimson/30 flex items-center justify-between px-8 bg-black/60 text-[10px] font-mono text-crimson/50 z-10">
        <div className="flex gap-4">
          <span>LATENCY: 14ms</span>
          <span>UPTIME: 99.9%</span>
        </div>
        <div className="flex gap-4">
          <span>ENCRYPTION: AES-256</span>
          <span>LOC: CACHY_OS_NODE_01</span>
        </div>
      </footer>
    </div>
  );
}

function NavButton({ active, onClick, icon, label }: { active: boolean, onClick: () => void, icon: React.ReactNode, label: string }) {
  return (
    <button 
      onClick={onClick}
      className={cn(
        "flex flex-col items-center gap-1 transition-all group",
        active ? "text-crimson" : "text-crimson/40 hover:text-crimson/70"
      )}
    >
      <div className={cn(
        "p-2 rounded-lg transition-all",
        active && "bg-crimson/10 shadow-[0_0_15px_rgba(255,0,0,0.3)]"
      )}>
        {icon}
      </div>
      <span className="text-[8px] font-bold tracking-widest">{label}</span>
    </button>
  );
}

function StatCard({ label, value, color = "text-white" }: { label: string, value: string | number, color?: string }) {
  return (
    <div className="hud-border p-6 bg-black/40">
      <div className="text-[10px] font-mono text-crimson/50 tracking-widest mb-2">{label}</div>
      <div className={cn("text-3xl font-mono font-bold", color)}>{value}</div>
      <div className="mt-4 h-1 w-full bg-crimson/10 overflow-hidden">
        <motion.div 
          initial={{ width: 0 }}
          animate={{ width: "70%" }}
          className="h-full bg-crimson"
        />
      </div>
    </div>
  );
}

function ProductRow({ product, onDelete, onCompare, onClick, isComparing }: { product: Product, onDelete: () => void, onCompare: () => void, onClick: () => void, isComparing: boolean }) {
  const priceDropped = product.currentPrice < product.previousPrice;
  const priceIncreased = product.currentPrice > product.previousPrice;

  const targetMet = product.targetPrice && product.currentPrice <= product.targetPrice;

  return (
    <div 
      onClick={onClick}
      className={cn(
        "hud-border p-4 bg-black/40 flex items-center gap-6 group cursor-pointer hover:bg-crimson/5 transition-all relative overflow-hidden",
        targetMet && "border-green-500/50 bg-green-500/5 shadow-[inset_0_0_20px_rgba(34,197,94,0.05)]"
      )}
    >
      {targetMet && (
        <div className="absolute top-0 right-0 bg-green-500 text-black font-mono text-[8px] px-2 font-bold animate-pulse">
          TARGET_ACQUIRED
        </div>
      )}
      <div className="w-16 h-16 bg-crimson/5 border border-crimson/20 flex items-center justify-center shrink-0 relative">
        {product.imageUrl ? (
          <img 
            src={product.imageUrl} 
            alt={product.name} 
            className="w-full h-full object-contain mix-blend-screen" 
            referrerPolicy="no-referrer" 
            onError={(e) => {
              const keywords = product.name.split(' ').slice(0, 2).join(' ');
              (e.target as HTMLImageElement).src = `https://placehold.co/400x400/000000/ff0000?text=${encodeURIComponent(keywords)}`;
            }}
          />
        ) : (
          <Cpu size={24} className="text-crimson/20" />
        )}
        <div className="absolute -bottom-1 -left-1 w-2 h-2 border-b border-l border-crimson/40" />
        <div className="absolute -top-1 -right-1 w-2 h-2 border-t border-r border-crimson/40" />
      </div>
      
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <h3 className="font-mono text-sm font-bold truncate group-hover:text-crimson transition-colors tracking-tight">{product.name}</h3>
        </div>
        <div className="flex items-center gap-4 text-[10px] font-mono text-crimson/50">
          <div className="flex items-center gap-1">
            <Scan size={10} />
            <span>{new Date(product.lastUpdated).toLocaleDateString()}</span>
          </div>
          <div className={cn("flex items-center gap-1", product.available ? "text-green-500" : "text-red-500")}>
            <div className={cn("w-1 h-1 rounded-full", product.available ? "bg-green-500 animate-pulse" : "bg-red-500")} />
            {product.available ? "ACTIVE" : "OFFLINE"}
          </div>
          {product.lastScrapeMethod && (
            <div className="flex items-center gap-1 text-crimson/30">
              <Cpu size={10} />
              <span>{product.lastScrapeMethod}</span>
            </div>
          )}
          {product.targetPrice && (
            <div className="flex items-center gap-1 text-crimson/30">
              <Target size={10} />
              <span>{product.currency} {product.targetPrice.toFixed(2)}</span>
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-col items-end gap-1">
        {product.comparisonResults && product.comparisonResults.length > 0 && (
          <span className="text-[8px] font-mono text-green-500/50 uppercase tracking-widest">Market Best Price</span>
        )}
        <div className="flex items-center gap-2">
          {priceDropped && <TrendingDown size={14} className="text-green-500" />}
          {priceIncreased && <TrendingUp size={14} className="text-red-500" />}
          <span className={cn(
            "text-lg font-mono font-bold tracking-tighter",
            priceDropped ? "text-green-500" : priceIncreased ? "text-red-500" : "text-white"
          )}>
            {product.currency} {product.currentPrice.toFixed(2)}
          </span>
        </div>
        {product.previousPrice > 0 && (
          <span className="text-[10px] font-mono text-crimson/30 line-through">
            {product.currency} {product.previousPrice.toFixed(2)}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2 ml-4 opacity-0 group-hover:opacity-100 transition-opacity">
        <button 
          onClick={(e) => { e.stopPropagation(); onCompare(); }} 
          disabled={isComparing}
          className="p-2 text-crimson/30 hover:text-crimson transition-colors hud-border border-crimson/10 hover:border-crimson/40"
        >
          {isComparing ? <RefreshCw className="animate-spin" size={14} /> : <RefreshCw size={14} />}
        </button>
        <button 
          onClick={(e) => { e.stopPropagation(); onDelete(); }} 
          className="p-2 text-crimson/30 hover:text-red-500 transition-colors hud-border border-crimson/10 hover:border-red-500/40"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}

function ComparisonMatrix({ list, products, onClose }: { list: ProductList, products: Product[], onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center p-4 bg-black/90 backdrop-blur-md">
      <motion.div 
        initial={{ scale: 0.95, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.95, opacity: 0 }}
        className="hud-border bg-[#0a0a0a] w-full max-w-6xl max-h-[90vh] overflow-hidden flex flex-col p-8 relative"
      >
        <button onClick={onClose} className="absolute top-6 right-6 text-crimson/50 hover:text-crimson z-10">
          <X size={24} />
        </button>

        <div className="mb-8">
          <h2 className="text-sm font-mono text-crimson/50 tracking-[0.3em] uppercase">{list.name} - MARKET MATRIX</h2>
          <p className="text-[10px] font-mono text-crimson/30 mt-1 uppercase tracking-widest">CROSS-NODE PRICE COMPARISON GRID</p>
        </div>

        <div className="flex-1 overflow-y-auto overflow-x-hidden custom-scrollbar">
          <table className="w-full border-collapse font-mono text-xs">
            <thead>
              <tr className="border-b border-crimson/20">
                <th className="text-left p-4 text-crimson/50 font-bold uppercase tracking-widest sticky top-0 bg-[#0a0a0a] z-10">TARGET UNIT</th>
                <th className="text-right p-4 text-crimson/50 font-bold uppercase tracking-widest sticky top-0 bg-[#0a0a0a] z-10">CURRENT NODE</th>
                <th className="text-right p-4 text-crimson/50 font-bold uppercase tracking-widest sticky top-0 bg-[#0a0a0a] z-10">TARGET PRICE</th>
                <th className="text-right p-4 text-crimson/50 font-bold uppercase tracking-widest sticky top-0 bg-[#0a0a0a] z-10">STATUS</th>
              </tr>
            </thead>
            <tbody>
              {products.map((product) => {
                const isAtTarget = product.targetPrice && product.currentPrice <= product.targetPrice;
                return (
                  <tr key={product.id} className="border-b border-crimson/10 hover:bg-crimson/5 transition-colors group">
                    <td className="p-4">
                      <div className="flex items-center gap-3">
                        <div className="w-8 h-8 bg-crimson/5 border border-crimson/20 flex items-center justify-center">
                          {product.imageUrl ? (
                            <img src={product.imageUrl} alt="" className="w-full h-full object-contain" referrerPolicy="no-referrer" />
                          ) : <Cpu size={14} className="text-crimson/20" />}
                        </div>
                        <span className="font-bold group-hover:text-crimson transition-colors truncate max-w-[200px]">{product.name}</span>
                      </div>
                    </td>
                    <td className="p-4 text-right">
                      <span className={cn(
                        "font-bold",
                        product.currentPrice < product.previousPrice ? "text-green-500" : 
                        product.currentPrice > product.previousPrice ? "text-red-500" : "text-white"
                      )}>
                        {product.currency} {product.currentPrice.toFixed(2)}
                      </span>
                    </td>
                    <td className="p-4 text-right text-crimson/50">
                      {product.targetPrice ? `${product.currency} ${product.targetPrice.toFixed(2)}` : "---"}
                    </td>
                    <td className="p-4 text-right">
                      {isAtTarget ? (
                        <span className="text-[8px] font-bold text-green-500 border border-green-500 px-2 py-1 animate-pulse">ACQUIRED</span>
                      ) : (
                        <span className="text-[8px] font-bold text-crimson/30 border border-crimson/10 px-2 py-1">TRACKING</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="bg-crimson/5">
                <td className="p-4 font-bold text-crimson/70 uppercase tracking-widest">TOTAL ARCHIVE VALUE</td>
                <td className="p-4 text-right font-bold text-white text-lg">
                  {products[0]?.currency} {products.reduce((sum, p) => sum + p.currentPrice, 0).toFixed(2)}
                </td>
                <td className="p-4 text-right text-crimson/50">
                  {list.budget ? `${products[0]?.currency} ${list.budget.toFixed(2)}` : "---"}
                </td>
                <td className="p-4 text-right">
                  {list.budget && products.reduce((sum, p) => sum + p.currentPrice, 0) > list.budget ? (
                    <span className="text-[8px] font-bold text-red-500 border border-red-500 px-2 py-1">OVER BUDGET</span>
                  ) : list.budget ? (
                    <span className="text-[8px] font-bold text-green-500 border border-green-500 px-2 py-1">WITHIN LIMITS</span>
                  ) : null}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </motion.div>
    </div>
  );
}

function ProductDetailModal({ 
  product, 
  onClose, 
  onCompare, 
  isComparing, 
  comparisonResults,
  onUpdateTargetPrice,
  onGenerateAiInsight,
  aiInsight,
  isGeneratingInsight,
  onDeleteComparisonResult,
  onUpdateComparisonResult,
  onAddComparisonResult
}: { 
  product: Product, 
  onClose: () => void, 
  onCompare: () => void, 
  isComparing: boolean, 
  comparisonResults: any[],
  onUpdateTargetPrice: (id: string, price: number | undefined) => void,
  onGenerateAiInsight: (product: Product) => void,
  aiInsight: string | null,
  isGeneratingInsight: boolean,
  onDeleteComparisonResult: (productId: string, index: number) => void,
  onUpdateComparisonResult: (productId: string, index: number, updated: any) => void,
  onAddComparisonResult: (productId: string, newResult: any) => void
}) {
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editValue, setEditValue] = useState<{ site: string, price: string, url: string }>({ site: "", price: "", url: "" });
  const [isAddingManual, setIsAddingManual] = useState(false);

  const chartData = product.priceHistory.map(h => ({
    date: new Date(h.date).toLocaleDateString(),
    price: h.price
  }));

  const displayResults = comparisonResults.length > 0 ? comparisonResults : (product.comparisonResults || []);
  
  const bestMarketPrice = displayResults.length > 0 
    ? Math.min(...displayResults.map(r => r.price)) 
    : null;
  
  const isCheaperAvailable = bestMarketPrice !== null && bestMarketPrice < product.currentPrice;

  const startEditing = (index: number, res: any) => {
    setEditingIndex(index);
    setEditValue({ site: res.site, price: res.price.toString(), url: res.url });
  };

  const saveEdit = (index: number) => {
    onUpdateComparisonResult(product.id, index, {
      site: editValue.site,
      price: parseFloat(editValue.price) || 0,
      url: editValue.url
    });
    setEditingIndex(null);
  };

  const handleAddManual = () => {
    onAddComparisonResult(product.id, {
      site: editValue.site || "Manual",
      price: parseFloat(editValue.price) || 0,
      url: editValue.url || "#"
    });
    setIsAddingManual(false);
    setEditValue({ site: "", price: "", url: "" });
  };

  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center p-4 bg-black/95 backdrop-blur-xl">
      <motion.div 
        initial={{ scale: 1.1, opacity: 0, filter: 'blur(20px)' }}
        animate={{ scale: 1, opacity: 1, filter: 'blur(0px)' }}
        exit={{ scale: 1.1, opacity: 0, filter: 'blur(20px)' }}
        className="w-full max-w-6xl max-h-[95vh] overflow-hidden flex flex-col relative"
      >
        {/* HUD Corners */}
        <div className="absolute top-0 left-0 w-12 h-12 border-t-2 border-l-2 border-crimson/40" />
        <div className="absolute top-0 right-0 w-12 h-12 border-t-2 border-r-2 border-crimson/40" />
        <div className="absolute bottom-0 left-0 w-12 h-12 border-b-2 border-l-2 border-crimson/40" />
        <div className="absolute bottom-0 right-0 w-12 h-12 border-b-2 border-r-2 border-crimson/40" />

        <div className="bg-black/80 border border-crimson/20 p-8 flex flex-col gap-8 overflow-y-auto overflow-x-hidden custom-scrollbar">
          <div className="flex justify-between items-start">
            <div className="flex gap-8">
              <div className="w-40 h-40 bg-crimson/5 border border-crimson/20 p-2 relative group">
                <div className="absolute inset-0 bg-crimson/10 animate-pulse opacity-0 group-hover:opacity-100 transition-opacity" />
                {product.imageUrl ? (
                  <img 
                    src={product.imageUrl} 
                    alt={product.name} 
                    className="w-full h-full object-contain mix-blend-screen" 
                    referrerPolicy="no-referrer" 
                    onError={(e) => {
                      const keywords = product.name.split(' ').slice(0, 2).join(' ');
                      (e.target as HTMLImageElement).src = `https://placehold.co/400x400/000000/ff0000?text=${encodeURIComponent(keywords)}`;
                    }}
                  />
                ) : (
                  <Cpu size={64} className="text-crimson/20 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
                )}
                <div className="absolute -bottom-2 -right-2 bg-crimson text-black font-mono text-[10px] px-2 font-bold">UNIT_ID: {product.id.slice(0,8)}</div>
              </div>

                <div className="flex flex-col gap-4">
                  <div className="flex flex-col">
                    <span className="text-[10px] font-mono text-crimson/50 tracking-[0.5em] uppercase">ALVO_IDENTIFICADO</span>
                    <h2 className="text-3xl font-mono font-bold text-white tracking-tight glow-text">{product.name}</h2>
                  </div>
                  
                  <div className="flex items-center gap-6">
                    <div className="flex flex-col">
                      <span className="text-[10px] font-mono text-crimson/30 uppercase">VALOR_ATUAL</span>
                      <span className="text-2xl font-mono font-bold text-white">{product.currency} {product.currentPrice.toFixed(2)}</span>
                    </div>
                    {product.previousPrice > 0 && (
                      <div className="flex flex-col">
                        <span className="text-[10px] font-mono text-crimson/30 uppercase">VALOR_ANTERIOR</span>
                        <span className="text-lg font-mono text-crimson/40 line-through">{product.currency} {product.previousPrice.toFixed(2)}</span>
                      </div>
                    )}
                    <div className="h-10 w-px bg-crimson/20 mx-2" />
                    <div className="flex flex-col gap-1">
                      <span className="text-[10px] font-mono text-crimson/30 uppercase">ALERTA_DE_ALVO</span>
                      <div className="flex items-center gap-3">
                        <div className="relative">
                          <Target className="absolute left-2 top-1/2 -translate-y-1/2 text-crimson/50" size={12} />
                          <input 
                            type="number"
                            className="hud-input pl-8 py-1 text-xs w-32"
                            placeholder="DEFINIR ALVO"
                            value={product.targetPrice || ""}
                            onChange={(e) => onUpdateTargetPrice(product.id, e.target.value ? parseFloat(e.target.value) : undefined)}
                          />
                        </div>
                        {product.targetPrice && product.currentPrice <= product.targetPrice && (
                          <div className="flex items-center gap-2 text-green-500 font-mono text-[10px] font-bold animate-pulse">
                            <ShieldAlert size={14} /> ALVO_ATINGIDO
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
            </div>

            <button onClick={onClose} className="p-2 text-crimson/50 hover:text-crimson transition-all hover:rotate-90">
              <X size={32} />
            </button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
            {/* Telemetry Column */}
            <div className="flex flex-col gap-6">
              <div className="hud-border bg-crimson/5 p-6">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <History size={16} className="text-crimson" />
                    <span className="text-[10px] font-mono text-crimson tracking-widest uppercase">TELEMETRIA_DE_PREÇO</span>
                  </div>
                  <span className="text-[8px] font-mono text-crimson/30">FEED_EM_TEMPO_REAL</span>
                </div>
                <div className="h-64 w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#222" vertical={false} />
                      <XAxis dataKey="date" hide />
                      <YAxis hide domain={['auto', 'auto']} />
                      <Tooltip 
                        contentStyle={{ backgroundColor: '#000', border: '1px solid #900', borderRadius: '0px', fontFamily: 'monospace' }}
                        itemStyle={{ color: '#f00' }}
                      />
                      <Line 
                        type="monotone" 
                        dataKey="price" 
                        stroke="#f00" 
                        strokeWidth={3} 
                        dot={{ r: 4, fill: '#f00', strokeWidth: 0 }}
                        activeDot={{ r: 6, fill: '#fff', stroke: '#f00' }}
                      />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="hud-border p-4 bg-black/40">
                  <span className="text-[8px] font-mono text-crimson/50 uppercase">ÚLTIMA ATUALIZAÇÃO</span>
                  <div className="text-sm font-mono mt-1">{new Date(product.lastUpdated).toLocaleString()}</div>
                </div>
                <div className="hud-border p-4 bg-black/40">
                  <span className="text-[8px] font-mono text-crimson/50 uppercase">DISPONIBILIDADE</span>
                  <div className={cn("text-sm font-mono mt-1", product.available ? "text-green-500" : "text-red-500")}>
                    {product.available ? "NODO_ATIVO" : "NODO_OFFLINE"}
                  </div>
                </div>
              </div>
            </div>

            {/* Intelligence Column */}
            <div className="flex flex-col gap-6">
              <div className="hud-border bg-black/40 p-6 flex-1 flex flex-col">
                <div className="flex items-center justify-between mb-6">
                  <div className="flex items-center gap-2">
                    <BrainCircuit size={16} className="text-crimson" />
                    <span className="text-[10px] font-mono text-crimson tracking-widest uppercase">INSIGHTS_DO_NÚCLEO_IA</span>
                  </div>
                  <button 
                    onClick={() => onGenerateAiInsight(product)}
                    disabled={isGeneratingInsight}
                    className="hud-button text-[10px] py-1 px-4 flex items-center gap-2"
                  >
                    {isGeneratingInsight ? <RefreshCw className="animate-spin" size={12} /> : <BrainCircuit size={12} />}
                    EXECUTAR_ANÁLISE
                  </button>
                </div>

                <div className="flex-1 min-h-[350px] hud-border border-crimson/10 bg-crimson/5 p-6 font-mono text-xs leading-relaxed overflow-y-auto overflow-x-hidden custom-scrollbar">
                  {isGeneratingInsight ? (
                    <div className="flex flex-col items-center justify-center h-full gap-4">
                      <div className="hud-scanner" />
                      <span className="animate-pulse text-crimson/50">CONSULTANDO_NODOS_GLOBAIS...</span>
                    </div>
                  ) : aiInsight ? (
                    <div className="prose prose-invert prose-xs max-w-none">
                      <ReactMarkdown>{aiInsight}</ReactMarkdown>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center h-full text-crimson/20 italic text-center">
                      <ShieldAlert size={32} className="mb-4 opacity-20" />
                      INICIAR_SEQUÊNCIA_DE_ANÁLISE_PARA_INTELIGÊNCIA_DE_MERCADO
                    </div>
                  )}
                </div>

                {displayResults.length > 0 && (
                  <div className="mt-4 flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-mono text-crimson/50 uppercase tracking-widest">NODOS_DE_MERCADO_ENCONTRADOS</span>
                      <button 
                        onClick={() => { setIsAddingManual(true); setEditValue({ site: "", price: "", url: "" }); }}
                        className="text-[8px] font-mono text-crimson/50 hover:text-crimson flex items-center gap-1"
                      >
                        <Plus size={10} /> ADICIONAR_MANUAL
                      </button>
                    </div>
                    <div className="flex flex-col gap-2 max-h-[150px] overflow-y-auto overflow-x-hidden custom-scrollbar pr-2">
                      {isAddingManual && (
                        <div className="flex flex-col gap-2 p-2 bg-crimson/10 border border-crimson/30">
                          <input 
                            className="hud-input text-[10px] py-1" 
                            placeholder="LOJA" 
                            value={editValue.site} 
                            onChange={e => setEditValue({...editValue, site: e.target.value})}
                          />
                          <input 
                            className="hud-input text-[10px] py-1" 
                            placeholder="PREÇO" 
                            type="number"
                            value={editValue.price} 
                            onChange={e => setEditValue({...editValue, price: e.target.value})}
                          />
                          <input 
                            className="hud-input text-[10px] py-1" 
                            placeholder="URL" 
                            value={editValue.url} 
                            onChange={e => setEditValue({...editValue, url: e.target.value})}
                          />
                          <div className="flex gap-2">
                            <button onClick={handleAddManual} className="hud-button flex-1 text-[8px] py-1">SALVAR</button>
                            <button onClick={() => setIsAddingManual(false)} className="hud-button flex-1 text-[8px] py-1 border-crimson/20">CANCELAR</button>
                          </div>
                        </div>
                      )}
                      {displayResults.sort((a, b) => a.price - b.price).map((res: any, i: number) => (
                        <div key={i} className="flex items-center justify-between p-2 bg-crimson/5 border border-crimson/10 text-[10px]">
                          {editingIndex === i ? (
                            <div className="flex flex-col gap-1 w-full">
                              <input 
                                className="hud-input text-[8px] py-0.5" 
                                value={editValue.site} 
                                onChange={e => setEditValue({...editValue, site: e.target.value})}
                              />
                              <input 
                                className="hud-input text-[8px] py-0.5" 
                                type="number"
                                value={editValue.price} 
                                onChange={e => setEditValue({...editValue, price: e.target.value})}
                              />
                              <div className="flex gap-2 mt-1">
                                <button onClick={() => saveEdit(i)} className="text-green-500 hover:text-green-400">OK</button>
                                <button onClick={() => setEditingIndex(null)} className="text-crimson/50 hover:text-crimson">CANCEL</button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <div className="flex flex-col">
                                <span className="text-crimson/50 uppercase">{res.site}</span>
                                <span className={cn("font-bold", i === 0 ? "text-green-500" : "text-white")}>
                                  {product.currency} {res.price.toFixed(2)}
                                </span>
                              </div>
                              <div className="flex items-center gap-3">
                                <button onClick={() => startEditing(i, res)} className="text-crimson/30 hover:text-crimson transition-colors">
                                  <Edit2 size={12} />
                                </button>
                                <button onClick={() => onDeleteComparisonResult(product.id, i)} className="text-crimson/30 hover:text-red-500 transition-colors">
                                  <Trash2 size={12} />
                                </button>
                                <a href={res.url} target="_blank" rel="noopener noreferrer" className="text-crimson hover:text-white transition-colors">
                                  <ExternalLink size={12} />
                                </a>
                              </div>
                            </>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="flex gap-4">
                <button 
                  onClick={onCompare}
                  disabled={isComparing}
                  className="hud-button flex-1 py-3 flex items-center justify-center gap-3 group"
                >
                  {isComparing ? <RefreshCw className="animate-spin" size={16} /> : <RefreshCw size={16} className="group-hover:rotate-180 transition-transform duration-500" />}
                  ESCANEAR_MERCADO
                </button>
                <a 
                  href={product.url} 
                  target="_blank" 
                  rel="noopener noreferrer" 
                  className="hud-button py-3 px-6 flex items-center justify-center"
                >
                  <ExternalLink size={16} />
                </a>
              </div>
            </div>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

function Modal({ title, children, onClose }: { title: string, children: React.ReactNode, onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
      <motion.div 
        initial={{ scale: 0.9, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        exit={{ scale: 0.9, opacity: 0 }}
        className="hud-border bg-[#0a0a0a] w-full max-w-md p-8 relative"
      >
        <div className="flex items-center justify-between mb-8">
          <h2 className="text-sm font-mono text-crimson tracking-[0.3em] glow-text">{title}</h2>
          <button onClick={onClose} className="text-crimson/50 hover:text-crimson">
            <ChevronRight className="rotate-90" />
          </button>
        </div>
        {children}
      </motion.div>
    </div>
  );
}

function ConfigSection({ title, children }: { title: string, children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-[10px] font-mono text-crimson/50 tracking-widest border-b border-crimson/20 pb-1">{title}</h3>
      {children}
    </div>
  );
}

function InputGroup({ label, placeholder, value, onChange, type = "text", onTest }: { label: string, placeholder: string, value: string, onChange: (val: string) => void, type?: string, onTest?: () => void }) {
  const [showPassword, setShowPassword] = useState(false);
  const isPassword = type === "password";

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between ml-1">
        <label className="text-[8px] font-mono text-crimson/70 tracking-widest">{label}</label>
        <div className="flex items-center gap-2">
          {isPassword && (
            <button 
              onClick={() => setShowPassword(!showPassword)}
              className="text-crimson/50 hover:text-crimson transition-colors"
            >
              {showPassword ? <EyeOff size={10} /> : <Eye size={10} />}
            </button>
          )}
          {onTest && value && (
            <button 
              onClick={onTest}
              className="text-[6px] font-mono text-crimson border border-crimson/30 px-1 py-0.5 hover:bg-crimson hover:text-black transition-all"
            >
              TEST CONNECTION
            </button>
          )}
        </div>
      </div>
      <input 
        type={isPassword ? (showPassword ? "text" : "password") : type}
        className="hud-input text-xs" 
        placeholder={placeholder} 
        value={value}
        onChange={(e) => onChange(e.target.value)}
/>
	</div>
	);
}

function ToastWithTimer({ toast, onClose, onCopy }: { toast: { id: string, message: string, type: 'success' | 'error' | 'info', details?: string }, onClose: () => void, onCopy: () => void }) {
  const [timeLeft, setTimeLeft] = useState(5);
  const [isExpanded, setIsExpanded] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => {
      setTimeLeft(prev => {
        if (prev <= 1) {
          clearInterval(timer);
          onClose();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timer);
  }, [onClose]);

  return (
    <motion.div
      initial={{ opacity: 0, x: 100, filter: 'blur(10px)' }}
      animate={{ opacity: 1, x: 0, filter: 'blur(0px)' }}
      exit={{ opacity: 0, x: 100, filter: 'blur(10px)' }}
      className={cn(
        "hud-border bg-black/95 backdrop-blur-md min-w-[300px] max-w-[500px] pointer-events-auto",
        toast.type === 'success' ? 'border-green-500/50' : toast.type === 'error' ? 'border-red-500/50' : 'border-crimson/50'
      )}
    >
      {/* Timer bar */}
      <div className="h-1 w-full bg-crimson/10 overflow-hidden">
        <motion.div
          initial={{ width: "100%" }}
          animate={{ width: "0%" }}
          transition={{ duration: 5, ease: "linear" }}
          className={cn(
            "h-full",
            toast.type === 'success' ? 'bg-green-500' : toast.type === 'error' ? 'bg-red-500' : 'bg-crimson'
          )}
        />
      </div>

      <div className="px-4 py-3 flex items-start gap-3">
        <div className={cn(
          "w-2 h-full min-h-[40px] shrink-0",
          toast.type === 'success' ? 'bg-green-500' : toast.type === 'error' ? 'bg-red-500' : 'bg-crimson'
        )} />

        <div className="flex-1 flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <div className="flex flex-col">
              <span className="text-[8px] font-mono text-crimson/50 uppercase tracking-widest">{toast.type}</span>
              <span className="text-xs font-mono font-bold tracking-tight text-white">{toast.message}</span>
            </div>
            <div className={cn(
              "flex items-center justify-center w-8 h-8 rounded-full border-2",
              timeLeft <= 2 ? "bg-red-500/20 border-red-500 animate-pulse" : "bg-crimson/20 border-crimson/50"
            )}>
              <span className={cn(
                "text-sm font-mono font-bold",
                timeLeft <= 2 ? "text-red-500" : "text-crimson"
              )}>{timeLeft}</span>
            </div>
          </div>

          {toast.type === 'error' && toast.details && (
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className="text-[10px] font-mono text-crimson/70 hover:text-crimson transition-colors text-left"
            >
              {isExpanded ? '▲ ESCONDER DETALHES' : '▼ MOSTRAR DETALHES'}
            </button>
          )}

          {isExpanded && toast.details && (
            <div className="bg-black/50 p-2 border border-crimson/20 max-h-[100px] overflow-auto">
              <pre className="text-[9px] font-mono text-red-400 whitespace-pre-wrap break-words">{toast.details}</pre>
            </div>
          )}

          {toast.type === 'error' && (
            <div className="flex gap-2 mt-1">
              <button
                onClick={onCopy}
                className="flex-1 text-[10px] font-mono bg-crimson hover:bg-crimson/80 text-white px-3 py-2 transition-all font-bold"
              >
                📋 COPIAR ERRO
              </button>
              <button
                onClick={onClose}
                className="text-[10px] font-mono bg-red-500/20 border border-red-500/40 px-3 py-2 hover:bg-red-500 hover:text-black transition-all"
              >
                FECHAR
              </button>
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}

