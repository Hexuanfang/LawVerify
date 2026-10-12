CREATE TABLE IF NOT EXISTS payment_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  commercial_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  workspace_user_id TEXT NOT NULL,
  workspace_user_email TEXT,
  workspace_user_name TEXT,
  package_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  amount_fen INT NOT NULL,
  points INT NOT NULL,
  out_trade_no TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  qr_code_content TEXT,
  payment_url TEXT,
  provider_order_id TEXT,
  provider_message TEXT,
  point_log_id TEXT,
  provider_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  paid_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS point_ledger_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  commercial_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  workspace_user_id TEXT NOT NULL,
  workspace_user_email TEXT,
  workspace_user_name TEXT,
  order_id UUID REFERENCES payment_orders(id) ON DELETE SET NULL,
  entry_type TEXT NOT NULL,
  change_points INT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (order_id, entry_type)
);

CREATE INDEX IF NOT EXISTS idx_payment_orders_workspace_user_created_at
  ON payment_orders (workspace_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_orders_status_created_at
  ON payment_orders (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_orders_org_created_at
  ON payment_orders (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_point_ledger_workspace_user_created_at
  ON point_ledger_entries (workspace_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_point_ledger_org_created_at
  ON point_ledger_entries (organization_id, created_at DESC);
