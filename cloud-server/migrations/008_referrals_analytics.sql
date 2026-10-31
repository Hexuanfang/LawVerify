BEGIN;
CREATE TABLE IF NOT EXISTS referral_codes (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS account_referrals (
  invitee_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  invitee_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  inviter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  inviter_organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  reward_order_id UUID UNIQUE REFERENCES payment_orders(id),
  inviter_points INT NOT NULL DEFAULT 0 CHECK (inviter_points >= 0),
  invitee_points INT NOT NULL DEFAULT 0 CHECK (invitee_points >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rewarded_at TIMESTAMPTZ,
  CHECK (inviter_id <> invitee_id)
);
CREATE INDEX IF NOT EXISTS idx_referral_inviter ON account_referrals(inviter_id);
CREATE TABLE IF NOT EXISTS analytics_preferences (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS product_events (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id UUID NOT NULL,
  name TEXT NOT NULL,
  surface TEXT NOT NULL CHECK (surface IN ('desktop', 'web')),
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
  duration_ms INT NOT NULL CHECK (duration_ms BETWEEN 0 AND 3600000),
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_product_events_time ON product_events(received_at);
COMMIT;
