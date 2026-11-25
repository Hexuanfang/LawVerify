ALTER TABLE users ADD COLUMN IF NOT EXISTS verified_phone TEXT
  CHECK (verified_phone IS NULL OR verified_phone ~ '^1[3-9][0-9]{9}$');

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_verified_phone
  ON users (verified_phone) WHERE verified_phone IS NOT NULL;

CREATE TABLE IF NOT EXISTS account_sms_challenges (
  id UUID PRIMARY KEY,
  phone_key TEXT NOT NULL,
  ip_key TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('register', 'login')),
  code_digest TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  consumed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_account_sms_phone_created
  ON account_sms_challenges (phone_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_account_sms_ip_created
  ON account_sms_challenges (ip_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_account_sms_created ON account_sms_challenges (created_at);
