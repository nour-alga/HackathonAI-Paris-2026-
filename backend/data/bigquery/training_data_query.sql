-- Dataset d'entraînement : transactions normales vs suspectes
-- Source : BigQuery public dataset Ethereum
-- Usage : entraînement du GAT

-- Transactions normales (licit) — protocoles DeFi stables
SELECT
  `hash`             AS tx_hash,
  from_address,
  to_address,
  CAST(value AS FLOAT64) / 1e18  AS eth_value,
  gas_price / 1e9                 AS gas_price_gwei,
  block_timestamp,
  0                               AS label  -- 0 = normal
FROM `bigquery-public-data.crypto_ethereum.transactions`
WHERE DATE(block_timestamp) BETWEEN '2023-01-01' AND '2023-03-01'
  AND to_address IN (
    '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9',  -- Aave
    '0xc3d688b66703497daa19211eedff47f25384cdc3'   -- Compound V3
  )
  AND CAST(value AS FLOAT64) > 0
LIMIT 50000

UNION ALL

-- Transactions suspectes (illicit) — wallets hacks connus
SELECT
  `hash`             AS tx_hash,
  from_address,
  to_address,
  CAST(value AS FLOAT64) / 1e18  AS eth_value,
  gas_price / 1e9                 AS gas_price_gwei,
  block_timestamp,
  1                               AS label  -- 1 = suspect
FROM `bigquery-public-data.crypto_ethereum.transactions`
WHERE DATE(block_timestamp) BETWEEN '2022-01-01' AND '2023-06-01'
  AND from_address IN (
    '0xb2698c2d99ad2c302a95a8db26b08d17a77cedd4',  -- Euler hacker
    '0x098b716b8aaf21512996dc57eb0615e2383e2f96',  -- Ronin hacker
    '0x629e7da20197a5429d30da36e77d06cdf796b71a'   -- Wormhole hacker
  )
LIMIT 10000
