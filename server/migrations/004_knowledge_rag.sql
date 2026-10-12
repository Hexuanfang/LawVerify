ALTER TABLE knowledge_file_chunks
  ADD COLUMN IF NOT EXISTS point_id TEXT,
  ADD COLUMN IF NOT EXISTS char_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS embedding_status TEXT NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS embedding_error TEXT,
  ADD COLUMN IF NOT EXISTS embedding_updated_at TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_file_chunks_point_id
  ON knowledge_file_chunks (point_id)
  WHERE point_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_knowledge_file_chunks_file_chunk
  ON knowledge_file_chunks (knowledge_file_id, chunk_index);

CREATE INDEX IF NOT EXISTS idx_knowledge_file_chunks_embedding_status
  ON knowledge_file_chunks (embedding_status);
