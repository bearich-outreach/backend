-- Schema untuk Bearich Outreach (opsional — aplikasi membuat tabel otomatis saat pertama dijalankan)

CREATE DATABASE IF NOT EXISTS bearich CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE bearich;

CREATE TABLE IF NOT EXISTS settings (
  id INT PRIMARY KEY DEFAULT 1,
  business_name VARCHAR(255) NOT NULL DEFAULT 'Bearich Studio',
  services JSON NOT NULL,
  segment_focus VARCHAR(255) NOT NULL DEFAULT '',
  provider VARCHAR(50) NOT NULL DEFAULT 'none',
  api_key VARCHAR(500) NOT NULL DEFAULT '',
  base_url VARCHAR(255) NOT NULL DEFAULT 'https://api.deepseek.com/v1',
  model VARCHAR(100) NOT NULL DEFAULT 'deepseek-chat',
  weekly_target INT NOT NULL DEFAULT 25,
  sequence JSON NOT NULL,
  CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS prospects (
  id VARCHAR(40) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  company VARCHAR(255) NOT NULL DEFAULT '',
  channel VARCHAR(50) NOT NULL DEFAULT 'linkedin',
  contact VARCHAR(255) NOT NULL DEFAULT '',
  segment VARCHAR(255) NOT NULL DEFAULT '',
  notes TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'new',
  created_at DATETIME(3) NOT NULL,
  last_contact_at DATETIME(3) NULL,
  next_follow_up_at DATETIME(3) NULL,
  follow_up_step INT NOT NULL DEFAULT 0,
  closed_at DATETIME(3) NULL,
  closed_value DECIMAL(12,2) NULL DEFAULT 0,
  INDEX idx_status (status),
  INDEX idx_follow_up (next_follow_up_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS activities (
  id VARCHAR(40) PRIMARY KEY,
  prospect_id VARCHAR(40) NOT NULL,
  type VARCHAR(20) NOT NULL,
  message TEXT,
  created_at DATETIME(3) NOT NULL,
  INDEX idx_prospect (prospect_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS apps (
  id VARCHAR(40) PRIMARY KEY,
  slug VARCHAR(50) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  icon VARCHAR(50) NOT NULL DEFAULT '',
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  session_secret VARCHAR(128) NOT NULL,
  created_at DATETIME(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS app_credentials (
  id VARCHAR(40) PRIMARY KEY,
  app_id VARCHAR(40) NOT NULL,
  username VARCHAR(100) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_app_user (app_id, username),
  INDEX idx_app_id (app_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS transactions (
  id VARCHAR(40) PRIMARY KEY,
  type VARCHAR(10) NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  category VARCHAR(100) NOT NULL DEFAULT '',
  account VARCHAR(50) NOT NULL DEFAULT 'Tunai',
  description TEXT,
  txn_date DATE NOT NULL,
  created_at DATETIME(3) NOT NULL,
  INDEX idx_type (type),
  INDEX idx_date (txn_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS cashflow_accounts (
  id VARCHAR(40) PRIMARY KEY,
  name VARCHAR(50) NOT NULL UNIQUE,
  type VARCHAR(20) NOT NULL DEFAULT 'lainnya',
  created_at DATETIME(3) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS notes (
  id VARCHAR(40) PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  content TEXT,
  tags JSON NOT NULL,
  pinned TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  INDEX idx_pinned (pinned)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS cashflow_settings (
  id INT PRIMARY KEY DEFAULT 1,
  target_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  target_type VARCHAR(20) NOT NULL DEFAULT 'saving',
  CHECK (id = 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS tasks (
  id VARCHAR(40) PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  description TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'todo',
  priority VARCHAR(10) NOT NULL DEFAULT 'medium',
  due_date DATE NULL,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  completed_at DATETIME(3) NULL,
  INDEX idx_status (status),
  INDEX idx_due (due_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Autopilot: Fase 0 target generator (10.280 kombinasi)
CREATE TABLE IF NOT EXISTS search_targets (
  id VARCHAR(40) PRIMARY KEY,
  keyword VARCHAR(255) NOT NULL,
  city VARCHAR(100) NOT NULL,
  category VARCHAR(100) NOT NULL,
  status ENUM('PENDING','PROCESSING','DONE','FAILED') NOT NULL DEFAULT 'PENDING',
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_keyword (keyword),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Fase 1 raw leads (dedup place_id)
CREATE TABLE IF NOT EXISTS raw_leads (
  id VARCHAR(40) PRIMARY KEY,
  place_id VARCHAR(100) NOT NULL,
  name VARCHAR(255) NOT NULL,
  address TEXT,
  phone_raw VARCHAR(50) DEFAULT '',
  website VARCHAR(255) DEFAULT '',
  rating DECIMAL(2,1) NULL,
  review_count INT NOT NULL DEFAULT 0,
  maps_status ENUM('OPERATIONAL','CLOSED_PERMANENTLY','UNKNOWN') NOT NULL DEFAULT 'UNKNOWN',
  city VARCHAR(100) NOT NULL DEFAULT '',
  category VARCHAR(100) NOT NULL DEFAULT '',
  keyword VARCHAR(255) NOT NULL DEFAULT '',
  raw_json JSON,
  created_at DATETIME(3) NOT NULL,
  last_seen_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_place (place_id),
  INDEX idx_city_cat (city, category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Fase 3 qualified leads (buffer)
CREATE TABLE IF NOT EXISTS qualified_leads (
  id VARCHAR(40) PRIMARY KEY,
  place_id VARCHAR(100) NOT NULL,
  name VARCHAR(255) NOT NULL,
  company VARCHAR(255) NOT NULL DEFAULT '',
  address TEXT NULL,
  phone_628 VARCHAR(20) NOT NULL,
  city VARCHAR(100) NOT NULL DEFAULT '',
  category VARCHAR(100) NOT NULL DEFAULT '',
  rating DECIMAL(2,1) NULL,
  review_count INT NOT NULL DEFAULT 0,
  website VARCHAR(255) DEFAULT '',
  maps_url VARCHAR(600) NOT NULL DEFAULT '',
  score INT NOT NULL,
  wa_verified TINYINT(1) NOT NULL DEFAULT 0,
  message TEXT,
  message_variants JSON,
  status ENUM('New Lead','Contacted','Replied') NOT NULL DEFAULT 'New Lead',
  created_at DATETIME(3) NOT NULL,
  contacted_at DATETIME(3) NULL,
  replied_at DATETIME(3) NULL,
  UNIQUE KEY uq_place (place_id),
  UNIQUE KEY uq_phone (phone_628),
  INDEX idx_status (status),
  INDEX idx_score (score)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS webhook_logs (
  id VARCHAR(40) PRIMARY KEY,
  phone_628 VARCHAR(20) NOT NULL DEFAULT '',
  event VARCHAR(50) NOT NULL DEFAULT '',
  payload JSON,
  created_at DATETIME(3) NOT NULL,
  INDEX idx_phone (phone_628)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS outreach_daily_counter (
  date DATE PRIMARY KEY,
  count INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Antrian tunda verifikasi WA (gateway error/timeout): bukan qualified, dicoba lagi
CREATE TABLE IF NOT EXISTS wa_verify_pending (
  place_id VARCHAR(100) PRIMARY KEY,
  phone_628 VARCHAR(20) NOT NULL,
  name VARCHAR(255) NOT NULL DEFAULT '',
  city VARCHAR(100) NOT NULL DEFAULT '',
  category VARCHAR(100) NOT NULL DEFAULT '',
  attempts INT NOT NULL DEFAULT 0,
  next_retry_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  INDEX idx_retry (next_retry_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Jobs app (Glints + JobStreet, full remote, isolasi penuh)
CREATE TABLE IF NOT EXISTS job_targets (
  id VARCHAR(40) PRIMARY KEY,
  keyword VARCHAR(255) NOT NULL,
  source ENUM('glints','jobstreet') NOT NULL DEFAULT 'glints',
  status ENUM('PENDING','PROCESSING','DONE','FAILED') NOT NULL DEFAULT 'PENDING',
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at DATETIME(3) NOT NULL,
  updated_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_keyword_source (keyword, source),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS job_raw (
  id VARCHAR(40) PRIMARY KEY,
  source ENUM('glints','jobstreet') NOT NULL DEFAULT 'glints',
  external_id VARCHAR(255) NOT NULL,
  title VARCHAR(255) NOT NULL DEFAULT '',
  company VARCHAR(255) NOT NULL DEFAULT '',
  location VARCHAR(255) NOT NULL DEFAULT '',
  url VARCHAR(1000) NOT NULL DEFAULT '',
  posted_date DATETIME(3) NULL,
  payload JSON,
  reason_skipped VARCHAR(100) NOT NULL DEFAULT '',
  created_at DATETIME(3) NOT NULL,
  last_seen_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_source_ext (source, external_id),
  UNIQUE KEY uq_norm_url (url(255)),
  INDEX idx_seen (last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS job_listings (
  id VARCHAR(40) PRIMARY KEY,
  source ENUM('glints','jobstreet') NOT NULL DEFAULT 'glints',
  external_id VARCHAR(255) NOT NULL,
  title VARCHAR(255) NOT NULL DEFAULT '',
  company VARCHAR(255) NOT NULL DEFAULT '',
  location VARCHAR(255) NOT NULL DEFAULT 'Remote',
  url VARCHAR(1000) NOT NULL DEFAULT '',
  salary_text VARCHAR(255) NOT NULL DEFAULT '',
  remote_label ENUM('Remote','Perlu Cek') NOT NULL DEFAULT 'Perlu Cek',
  review_flag TINYINT(1) NOT NULL DEFAULT 0,
  score INT NOT NULL DEFAULT 0,
  status ENUM('New','Saved','Applied','Interview','Rejected') NOT NULL DEFAULT 'New',
  hidden TINYINT(1) NOT NULL DEFAULT 0,
  posted_date DATETIME(3) NULL,
  first_seen_at DATETIME(3) NOT NULL,
  last_seen_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_source_ext (source, external_id),
  INDEX idx_status_hidden (status, hidden),
  INDEX idx_score (score),
  INDEX idx_posted (posted_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;