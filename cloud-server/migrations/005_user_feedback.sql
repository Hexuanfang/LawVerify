CREATE TABLE IF NOT EXISTS user_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  membership_id UUID REFERENCES organization_memberships(id) ON DELETE SET NULL,
  user_email TEXT NOT NULL,
  user_name TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'desktop_app',
  feedback_type TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  contact TEXT,
  app_version TEXT,
  client_platform TEXT,
  page_context TEXT,
  case_name TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  admin_note TEXT,
  handled_at TIMESTAMPTZ,
  handled_by_email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_feedback_created_at
  ON user_feedback (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_feedback_type_created_at
  ON user_feedback (feedback_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_feedback_status_created_at
  ON user_feedback (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_feedback_user_id_created_at
  ON user_feedback (user_id, created_at DESC);
