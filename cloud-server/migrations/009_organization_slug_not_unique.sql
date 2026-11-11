-- 机构名称允许重复：organizations.slug 由机构名派生，不再承担唯一性约束。
ALTER TABLE organizations
  DROP CONSTRAINT IF EXISTS organizations_slug_key;

CREATE INDEX IF NOT EXISTS idx_organizations_slug ON organizations (slug);
