ALTER TABLE cocreate_applications
  ADD COLUMN IF NOT EXISTS email TEXT,
  ADD COLUMN IF NOT EXISTS phone TEXT,
  ALTER COLUMN contact DROP NOT NULL;

-- 保留历史联系方式，格式明确的邮箱和手机号纳入唯一性检查。
-- 历史记录重复时由最早一条占用新字段，其他记录仍保留原值供审核。
WITH normalized AS (
  SELECT id, submitted_at, lower(btrim(contact)) AS email,
    regexp_replace(regexp_replace(contact, '[[:space:]()-]', '', 'g'), '^([+]?86|0086)', '') AS phone
  FROM cocreate_applications WHERE contact IS NOT NULL
), candidates AS (
  SELECT id,
    CASE WHEN email ~ '^[^[:space:]@]+@[^[:space:]@]+[.][a-z]{2,}$' AND length(email) <= 254
      AND row_number() OVER (PARTITION BY email ORDER BY submitted_at, id) = 1 THEN email END AS email,
    CASE WHEN phone ~ '^1[3-9][0-9]{9}$'
      AND row_number() OVER (PARTITION BY phone ORDER BY submitted_at, id) = 1 THEN phone END AS phone
  FROM normalized
), available AS (
  SELECT id,
    CASE WHEN NOT EXISTS (SELECT 1 FROM cocreate_applications app WHERE app.email = candidates.email) THEN email END AS email,
    CASE WHEN NOT EXISTS (SELECT 1 FROM cocreate_applications app WHERE app.phone = candidates.phone) THEN phone END AS phone
  FROM candidates
)
UPDATE cocreate_applications app
SET email = COALESCE(app.email, available.email), phone = COALESCE(app.phone, available.phone)
FROM available WHERE app.id = available.id AND (available.email IS NOT NULL OR available.phone IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cocreate_applications_email ON cocreate_applications (email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_cocreate_applications_phone ON cocreate_applications (phone);

ALTER TABLE cocreate_applications DROP CONSTRAINT IF EXISTS cocreate_application_contacts_check;
ALTER TABLE cocreate_applications ADD CONSTRAINT cocreate_application_contacts_check CHECK (
  (contact IS NOT NULL OR (email IS NOT NULL AND phone IS NOT NULL))
  AND (email IS NULL OR (email <> '' AND email = lower(btrim(email))))
  AND (phone IS NULL OR phone ~ '^1[3-9][0-9]{9}$')
);
