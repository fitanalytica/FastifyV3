-- LOCAL DATABASES ONLY. A stand-in for the old app's `paymentstore` (production has the real one), so the account deletion can be tested: a user with a row here
-- has bought a subscription, and their profile row is kept for billing (docs/data/api.md section 8b). Only the columns the code reads are here.
--   psql -d fitanalytica_dev -f 08-billing-standin.sql
CREATE TABLE IF NOT EXISTS paymentstore (
  userid UUID,
  ddate INTEGER DEFAULT EXTRACT(EPOCH FROM now()),
  product_id TEXT,
  expires_date INTEGER
);
