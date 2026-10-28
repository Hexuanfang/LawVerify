CREATE TABLE IF NOT EXISTS account_sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_account_sessions_user ON account_sessions(user_id);

-- Preserve currently active tokens during the transition from single-session login.
INSERT INTO account_sessions (id, user_id, expires_at)
SELECT current_session_id, id, NOW() + INTERVAL '30 days'
FROM users WHERE current_session_id IS NOT NULL
ON CONFLICT (id) DO NOTHING;
