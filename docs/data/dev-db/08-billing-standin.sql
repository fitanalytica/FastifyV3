-- LOCAL DATABASES ONLY. Stand-ins for the old app's billing tables (production has the real ones): `paymentstore`, so the account deletion can be tested (a user with
-- a row here has bought a subscription, and their profile row is kept for billing, docs/data/api.md section 8b), and `membership`, `protection_logs`, `payments` and `receiptdump`,
-- which the Pro state and the purchases read and write (api.md section 15). Only the columns the code reads are here, with the real types and keys; the `_sandbox` copy of membership is made too.
--   psql -d fitanalytica_dev -f 08-billing-standin.sql
CREATE TABLE IF NOT EXISTS paymentstore (
  userid UUID,
  ddate INTEGER DEFAULT EXTRACT(EPOCH FROM now()),
  product_id TEXT,
  expires_date INTEGER
);

CREATE TABLE IF NOT EXISTS membership (
  membership_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_userid UUID NOT NULL,
  created_date BIGINT DEFAULT EXTRACT(EPOCH FROM now()),
  invite_code VARCHAR(10),
  redeemed_by_userid UUID,
  redeemed_date BIGINT,
  expires_date BIGINT,
  reference_id VARCHAR(50),
  product_id VARCHAR(50),
  shared_date BIGINT
);
CREATE INDEX IF NOT EXISTS membership_buyer_idx ON membership (buyer_userid);
CREATE INDEX IF NOT EXISTS membership_redeemer_idx ON membership (redeemed_by_userid);
CREATE UNIQUE INDEX IF NOT EXISTS membership_invite_code_key ON membership (invite_code);
CREATE UNIQUE INDEX IF NOT EXISTS membership_ref_solo_idx ON membership (reference_id) WHERE invite_code IS NULL;
CREATE TABLE IF NOT EXISTS membership_sandbox (LIKE membership INCLUDING ALL);

-- The values of the enum are a guess ('iap' is the one the code writes); production has the real list.
DO $$ BEGIN
  CREATE TYPE protection_logs_transaction_type_enum AS ENUM ('iap', 'used');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE TABLE IF NOT EXISTS protection_logs (
  protection_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  streak_id UUID,
  level_id UUID,
  userid UUID NOT NULL REFERENCES userlogin(userid) ON DELETE CASCADE,
  dtgraph BIGINT,
  protection_days SMALLINT NOT NULL,
  transaction_type protection_logs_transaction_type_enum NOT NULL,
  ddate BIGINT DEFAULT EXTRACT(EPOCH FROM now()),
  transaction_id BIGINT,
  CONSTRAINT unique_protection_tx_id UNIQUE (transaction_id)
);

DO $$ BEGIN
  CREATE TYPE server_type_enum AS ENUM ('apple', 'google');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE TABLE IF NOT EXISTS payments (
  paymentsid UUID PRIMARY KEY,
  store_id UUID,
  userid UUID,
  amount REAL,
  convert_rate REAL,
  expires_date BIGINT,
  original_purchase_date BIGINT,
  original_transaction_id BIGINT,
  purchase_date BIGINT,
  transaction_id BIGINT,
  recent_subscription_start_date BIGINT,
  ddate INTEGER DEFAULT EXTRACT(EPOCH FROM now()),
  subscription_group_identifier INTEGER,
  auto_renew_status SMALLINT DEFAULT 0,
  currency CHAR(3),
  storefront CHAR(3),
  product_id VARCHAR(50),
  in_app_ownership_type VARCHAR(25),
  transaction_reason VARCHAR(40),
  transaction_type VARCHAR(100),
  CONSTRAINT unique_transaction_id UNIQUE (transaction_id)
);
CREATE INDEX IF NOT EXISTS idx_payments_userid_ddate ON payments (userid, ddate DESC);
CREATE TABLE IF NOT EXISTS payments_sandbox (LIKE payments INCLUDING ALL);
CREATE TABLE IF NOT EXISTS receiptdump (
  receiptid UUID PRIMARY KEY,
  store_id UUID,
  transaction_id BIGINT,
  original_transaction_id BIGINT,
  ddate INTEGER DEFAULT EXTRACT(EPOCH FROM now()),
  receipt JSON,
  server server_type_enum
);
CREATE TABLE IF NOT EXISTS receiptdump_sandbox (LIKE receiptdump INCLUDING ALL);
