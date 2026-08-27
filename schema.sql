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