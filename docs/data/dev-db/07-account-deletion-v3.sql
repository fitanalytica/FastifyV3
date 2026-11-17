-- Deleting an account (docs/data/api.md section 8b): the e-mailed confirmation code. One row per user, replaced by each new code, gone with the user.
-- Run on the local database after 06-posts-v3.sql; the same statement is meant for production later.
--   psql -d fitanalytica_dev -f 07-account-deletion-v3.sql

CREATE TABLE account_deletion_codes (
  userid UUID PRIMARY KEY REFERENCES userlogin(userid) ON DELETE CASCADE,
  code_hash CHAR(64) NOT NULL,          -- HMAC-SHA256 of the user id and the code, keyed with the server's secret: the code itself is never stored
  expires_at INTEGER NOT NULL,          -- epoch seconds
  attempts SMALLINT NOT NULL DEFAULT 0, -- wrong tries; the code is dead after 5
  sent_at INTEGER NOT NULL,             -- epoch seconds of the last send, for the resend wait
  sends SMALLINT NOT NULL DEFAULT 1,    -- sent in the current hour, for the limit
  sends_from INTEGER NOT NULL           -- when that hour began
);
