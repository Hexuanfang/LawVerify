CREATE TABLE IF NOT EXISTS cocreate_applications (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  contact TEXT NOT NULL,
  work_years TEXT NOT NULL CHECK (work_years IN ('under_3', '3_to_4', '5_to_9', '10_plus')),
  region TEXT NOT NULL,
  law_firm TEXT NOT NULL,
  practice_areas TEXT NOT NULL,
  resume TEXT NOT NULL,
  expectations TEXT NOT NULL,
  applicant_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved')),
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reviewed_at TIMESTAMPTZ,
  reviewed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  CHECK ((status = 'pending' AND reviewed_at IS NULL AND reviewed_by_user_id IS NULL)
         OR (status = 'approved' AND reviewed_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS idx_cocreate_applications_submitted_at
  ON cocreate_applications (submitted_at DESC, id DESC);
