-- Toutes les transactions liées au hack Euler Finance
-- 13 mars 2023 — $197M volés
-- Usage : exporter en CSV puis convertir pour l'entraînement LSTM

SELECT
  block_timestamp,
  `hash`                                    AS tx_hash,
  from_address,
  to_address,
  CAST(value AS FLOAT64) / 1e18            AS eth_value,
  gas_price / 1e9                           AS gas_price_gwei,
  receipt_gas_used                          AS gas_used,
  block_number
FROM `bigquery-public-data.crypto_ethereum.transactions`
WHERE DATE(block_timestamp) BETWEEN '2023-03-13' AND '2023-03-15'
  AND (
    from_address IN (
      '0xb2698c2d99ad2c302a95a8db26b08d17a77cedd4',  -- attaquant principal
      '0x27182842e098f60e3d576794a5bffb0777e025d3'   -- contrat Euler Finance
    )
    OR to_address IN (
      '0xb2698c2d99ad2c302a95a8db26b08d17a77cedd4',
      '0x27182842e098f60e3d576794a5bffb0777e025d3'
    )
  )
ORDER BY block_timestamp ASC
