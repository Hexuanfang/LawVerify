ALTER TABLE users
ADD COLUMN IF NOT EXISTS current_session_id UUID;
