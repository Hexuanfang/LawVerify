ALTER TABLE cocreate_applications
  ADD COLUMN IF NOT EXISTS points_granted BIGINT NOT NULL DEFAULT 0 CHECK (points_granted >= 0);
