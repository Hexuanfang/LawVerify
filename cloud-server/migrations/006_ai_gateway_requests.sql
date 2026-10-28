CREATE TABLE IF NOT EXISTS ai_gateway_requests (
  id TEXT PRIMARY KEY,
  organization_id UUID NOT NULL,
  user_id UUID NOT NULL,
  actor JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'refund_pending', 'refunded')),
  consumption_key TEXT NOT NULL UNIQUE,
  entry_id TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ai_gateway_requests_recovery_idx
  ON ai_gateway_requests(status, updated_at);
