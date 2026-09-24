-- Crimson Sentinel — Database Schema
-- FASE 1: substitui data.json por SQLite com better-sqlite3
-- Roda automaticamente via db.ts na primeira inicialização.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA encoding = 'UTF-8';

-- ---------------------------------------------------------------------------
-- MÓDULO E-COMMERCE (espelha os tipos existentes: Profile, ProductList, Product)
-- ---------------------------------------------------------------------------

-- Perfis de usuário (substitui data.profiles[])
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar TEXT,
  email TEXT,
  discord_webhook TEXT,
  telegram_token TEXT,
  telegram_chat_id TEXT,
  gmail_user TEXT,
  gmail_pass TEXT,
  gemini_api_key TEXT,
  lm_studio_url TEXT,
  nvidia_api_key TEXT,
  serper_api_key TEXT,
  tavily_api_key TEXT,
  use_advanced_scraping INTEGER DEFAULT 0,
  refresh_interval TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Listas de produtos (substitui data.lists[])
CREATE TABLE IF NOT EXISTS product_lists (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  profile_id TEXT NOT NULL,
  budget REAL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);

-- Produtos rastreados (substitui data.products[])
CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  name TEXT,
  current_price REAL,
  previous_price REAL,
  currency TEXT DEFAULT 'BRL',
  available INTEGER DEFAULT 1,
  image_url TEXT,
  last_updated TEXT,
  list_id TEXT,
  profile_id TEXT NOT NULL,
  target_price REAL,
  last_scrape_method TEXT,
  comparison_results TEXT, -- JSON array de {site, price, url}
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (list_id) REFERENCES product_lists(id) ON DELETE SET NULL,
  FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_products_list_id ON products(list_id);
CREATE INDEX IF NOT EXISTS idx_products_profile_id ON products(profile_id);

-- Histórico de preços (normalizado — antes embutido em product.priceHistory[])
CREATE TABLE IF NOT EXISTS price_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id TEXT NOT NULL,
  price REAL NOT NULL,
  date TEXT NOT NULL,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_price_history_product_id ON price_history(product_id);

-- ---------------------------------------------------------------------------
-- MÓDULO LOCAL / GEOLocalIZADO (novo — FASE 4+)
-- ---------------------------------------------------------------------------

-- Estabelecimentos físicos (supermercados, farmácias, etc.)
CREATE TABLE IF NOT EXISTS establishments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  chain TEXT, -- nome da rede (ex: "Carrefour", "Pão de Açúcar")
  category TEXT, -- "supermercado", "farmacia", "eletronicos"
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  address TEXT,
  city TEXT,
  state TEXT,
  postal_code TEXT,
  osm_id BIGINT, -- OpenStreetMap ID via Overpass
  price_url TEXT, -- URL de busca de preço local; {term} substituído pelo nome do item (FASE 11)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_establishments_category ON establishments(category);
CREATE INDEX IF NOT EXISTS idx_establishments_coords ON establishments(lat, lng);

-- Itens da lista de compras local
CREATE TABLE IF NOT EXISTS shopping_list_items (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  quantity REAL DEFAULT 1,  -- aceita fracionário (ex.: 0.5 kg)
  unit TEXT CHECK (unit IN ('kg','mg','g','L','ml','un') OR unit IS NULL), -- #23
  category TEXT, -- "mercearia", "hortifruti", "limpeza", etc.
  checked INTEGER DEFAULT 0,
  target_price REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Observações de preço em estabelecimentos (preço coletado in-loco ou via scraping local)
CREATE TABLE IF NOT EXISTS price_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shopping_list_item_id TEXT,
  product_id TEXT, -- FK opcional para products (se for produto de e-commerce)
  establishment_id TEXT NOT NULL,
  price REAL NOT NULL,
  currency TEXT DEFAULT 'BRL',
  observed_at TEXT NOT NULL,
  source TEXT, -- "manual", "scraping", "flyer", "social"
  notes TEXT,
  FOREIGN KEY (shopping_list_item_id) REFERENCES shopping_list_items(id) ON DELETE CASCADE,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL,
  FOREIGN KEY (establishment_id) REFERENCES establishments(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_price_obs_item ON price_observations(shopping_list_item_id);
CREATE INDEX IF NOT EXISTS idx_price_obs_establishment ON price_observations(establishment_id);
CREATE INDEX IF NOT EXISTS idx_price_obs_product ON price_observations(product_id);

-- Promoções detectadas (flyers, encartes, redes sociais)
CREATE TABLE IF NOT EXISTS promotions (
  id TEXT PRIMARY KEY,
  establishment_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  regular_price REAL,
  promo_price REAL NOT NULL,
  currency TEXT DEFAULT 'BRL',
  start_date TEXT,
  end_date TEXT,
  source TEXT, -- "flyer", "instagram", "whatsapp", "manual"
  source_url TEXT,
  raw_text TEXT, -- texto bruto do flyer/post
  detected_at TEXT NOT NULL DEFAULT (datetime('now')),
  is_active INTEGER DEFAULT 1,
  FOREIGN KEY (establishment_id) REFERENCES establishments(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_promotions_establishment ON promotions(establishment_id);
CREATE INDEX IF NOT EXISTS idx_promotions_active ON promotions(is_active);

-- Rotas de compra otimizadas (TSP entre estabelecimentos)
CREATE TABLE IF NOT EXISTS routes (
  id TEXT PRIMARY KEY,
  name TEXT,
  start_lat REAL NOT NULL,
  start_lng REAL NOT NULL,
  total_distance_km REAL,
  total_estimated_cost REAL,
  route_data TEXT, -- JSON com a sequência de waypoints
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Paradas de uma rota (cada estabelecimento visitado)
CREATE TABLE IF NOT EXISTS route_stops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  route_id TEXT NOT NULL,
  establishment_id TEXT NOT NULL,
  stop_order INTEGER NOT NULL,
  estimated_cost REAL,
  items TEXT, -- JSON array de nomes de itens comprados aqui
  FOREIGN KEY (route_id) REFERENCES routes(id) ON DELETE CASCADE,
  FOREIGN KEY (establishment_id) REFERENCES establishments(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_route_stops_route ON route_stops(route_id);

-- Log de notificações enviadas (FASE 6) — dedup anti-spam + histórico de alertas
CREATE TABLE IF NOT EXISTS notification_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL, -- "product" | "shopping_item" | "promotion"
  entity_id TEXT NOT NULL,
  channel TEXT NOT NULL,     -- "discord" | "telegram" | "email"
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  details TEXT,              -- JSON extra (URLs, snippets, etc.)
  sent_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_notification_log_entity ON notification_log(entity_type, entity_id);

-- Fontes de monitoramento social (FASE 8) — WhatsApp (texto colado) e Instagram (perfil)
CREATE TABLE IF NOT EXISTS social_sources (
  id TEXT PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp', 'instagram')),
  name TEXT NOT NULL,
  url TEXT, -- perfil/post do Instagram (opcional para WhatsApp)
  establishment_hint TEXT, -- nome do estabelecimento para associar as promoções
  enabled INTEGER DEFAULT 1,
  last_checked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_social_sources_channel ON social_sources(channel);

-- Configurações do usuário (substitui hardcoded consts do server.ts)
CREATE TABLE IF NOT EXISTS user_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Valores padrão
INSERT OR IGNORE INTO user_settings (key, value) VALUES
  ('scan_interval_ms', '43200000'),        -- 12h (igual ao hardcoded atual)
  ('scan_daily_hour', '15'),                 -- 15h (igual ao scheduleDailyScan atual)
  ('scan_timeout_ms', '590000'),            -- 9.83min (igual ao SCAN_TIMEOUT_MS atual)
  ('social_monitoring_enabled', 'true'),
  ('scrape_cache_ttl_ms', '3600000'),       -- 1h (igual ao CACHE_TTL do scraper)
  ('geolocation_search_radius_m', '5000'),  -- 5km
  ('route_max_stops', '15'),
  ('notifications_enabled', 'true'),        -- FASE 6: master switch de alertas
  ('notification_cooldown_hours', '24'),     -- FASE 6: não re-alerta mesmo alvo neste intervalo
  ('social_scan_interval_ms', '21600000'),   -- FASE 9: scan social recorrente (6h)
  ('local_price_scan_interval_ms', '21600000'), -- FASE 12: scan de preços locais recorrente (6h)
  ('user_lat', NULL),                       -- FASE 4: latitude do usuário (geocoded)
  ('user_lng', NULL),                       -- FASE 4: longitude do usuário
  ('user_address', NULL),                   -- FASE 4: endereço formatado
  ('scan_concurrency', '5'),                -- A3: concorrência por worker (5 x 4 processos pm2 = 20)
  ('flash_threshold_pct', '30'),            -- C1: % abaixo da média para ser flash
  ('flash_history_days', '30'),              -- C1: janela temporal da média histórica
  ('flash_telegram_priority', 'true'),       -- C1: flash só Telegram (ignora Discord/email)
  ('whatsapp_scan_per_contact_min', '20'),   -- C2: throttle entre checks de Status (15-30 min)
  ('instagram_scan_per_handle_min', '45'),   -- C3: throttle entre checks de Stories (30-60 min)
  ('whatsapp_operator_chat_id', NULL);       -- #35: chatId serializado do operador (…@c.us)

-- ---------------------------------------------------------------------------
-- FRENTE 4 — Monitoramento de Grupos + Sistema de Triggers
-- ---------------------------------------------------------------------------

-- Mensagens recebidas de grupos WhatsApp/Telegram
CREATE TABLE IF NOT EXISTS group_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL CHECK (source IN ('whatsapp', 'telegram')),
  group_name TEXT NOT NULL,
  group_id TEXT,
  sender TEXT,
  text TEXT NOT NULL,
  media_url TEXT,
  received_at TEXT NOT NULL DEFAULT (datetime('now')),
  processed INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_group_messages_source ON group_messages(source);
CREATE INDEX IF NOT EXISTS idx_group_messages_received ON group_messages(received_at);

-- Regras de trigger configuráveis pelo usuário
CREATE TABLE IF NOT EXISTS triggers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('product', 'keyword', 'promo')),
  condition TEXT NOT NULL CHECK (condition IN ('price_lte', 'price_drop_pct', 'price_trend', 'contains', 'new_promo')),
  value TEXT NOT NULL,
  channels TEXT NOT NULL DEFAULT 'discord',
  enabled INTEGER DEFAULT 1,
  last_fired_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_triggers_enabled ON triggers(enabled);

-- Histórico de disparos de triggers
CREATE TABLE IF NOT EXISTS trigger_fire_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger_id TEXT NOT NULL,
  entity_id TEXT,
  matched_value TEXT,
  fired_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (trigger_id) REFERENCES triggers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_trigger_fire_log_trigger ON trigger_fire_log(trigger_id);