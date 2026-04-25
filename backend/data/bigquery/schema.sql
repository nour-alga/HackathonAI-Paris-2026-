-- KOVER.IA BigQuery Schema
-- Remplace <PROJECT_ID> par ton GCP project ID

-- Dataset
CREATE SCHEMA IF NOT EXISTS `<PROJECT_ID>.kover_ia`
OPTIONS(
  description="KOVER.IA detection dataset",
  location="US"
);

-- Table des incidents
CREATE OR REPLACE TABLE `<PROJECT_ID>.kover_ia.incidents` (
  incident_id STRING NOT NULL DEFAULT GENERATE_UUID(),
  hack_tx_hash STRING NOT NULL,
  severity STRING NOT NULL,  -- LOW|MEDIUM|HIGH|CRITICAL
  summary STRING,
  narrative STRING,
  tainted_wallets_count INT64,
  lstm_prediction JSON,
  created_at TIMESTAMP NOT NULL,
  acknowledged BOOL DEFAULT FALSE,
  PRIMARY KEY (incident_id) NOT ENFORCED
)
PARTITION BY DATE(created_at)
CLUSTER BY severity, hack_tx_hash
OPTIONS(
  description="Detected security incidents",
  require_partition_filter=false
);

-- Table des wallets taintés
CREATE OR REPLACE TABLE `<PROJECT_ID>.kover_ia.tainted_wallets` (
  wallet_id STRING NOT NULL DEFAULT GENERATE_UUID(),
  address STRING NOT NULL,
  taint_score FLOAT64 NOT NULL,
  hops_from_source INT64,
  amount_usd FLOAT64,
  detected_at TIMESTAMP NOT NULL,
  hack_tx_hash STRING NOT NULL,
  PRIMARY KEY (wallet_id) NOT ENFORCED
)
PARTITION BY DATE(detected_at)
CLUSTER BY hack_tx_hash, address
OPTIONS(
  description="Tainted wallets linked to security incidents",
  require_partition_filter=false
);

-- Index pour les requêtes rapides
CREATE OR REPLACE INDEX idx_incidents_severity ON `<PROJECT_ID>.kover_ia.incidents` (severity, created_at DESC);
CREATE OR REPLACE INDEX idx_incidents_txhash ON `<PROJECT_ID>.kover_ia.incidents` (hack_tx_hash);
CREATE OR REPLACE INDEX idx_wallets_address ON `<PROJECT_ID>.kover_ia.tainted_wallets` (address);
CREATE OR REPLACE INDEX idx_wallets_txhash ON `<PROJECT_ID>.kover_ia.tainted_wallets` (hack_tx_hash);
