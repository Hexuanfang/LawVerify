ALTER TABLE point_ledger_entries
  ADD COLUMN IF NOT EXISTS operation_key TEXT,
  ADD COLUMN IF NOT EXISTS action_type TEXT,
  ADD COLUMN IF NOT EXISTS related_entry_id UUID REFERENCES point_ledger_entries(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cloud_point_ledger_operation_key
  ON point_ledger_entries (operation_key)
  WHERE operation_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_cloud_point_ledger_action_type_created_at
  ON point_ledger_entries (action_type, created_at DESC);
