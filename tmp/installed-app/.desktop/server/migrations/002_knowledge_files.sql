CREATE TABLE IF NOT EXISTS knowledge_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  original_file_name TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_extension TEXT NOT NULL DEFAULT '',
  file_kind TEXT NOT NULL DEFAULT 'other',
  file_size BIGINT NOT NULL DEFAULT 0,
  storage_provider TEXT NOT NULL,
  storage_bucket TEXT NOT NULL,
  storage_key TEXT NOT NULL UNIQUE,
  storage_url TEXT NOT NULL,
  extraction_status TEXT NOT NULL DEFAULT 'pending',
  extraction_error TEXT,
  extracted_text TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  vector_status TEXT NOT NULL DEFAULT 'pending',
  vector_error TEXT,
  vector_chunk_count INT NOT NULL DEFAULT 0,
  vector_keywords JSONB NOT NULL DEFAULT '[]'::jsonb,
  vector_updated_at TIMESTAMPTZ,
  linked_statute_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (organization_id, relative_path)
);

CREATE TABLE IF NOT EXISTS knowledge_file_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  knowledge_file_id UUID NOT NULL REFERENCES knowledge_files(id) ON DELETE CASCADE,
  chunk_index INT NOT NULL,
  content TEXT NOT NULL,
  keyword_payload JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (knowledge_file_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_files_org_uploaded_at
  ON knowledge_files (organization_id, uploaded_at DESC);

CREATE INDEX IF NOT EXISTS idx_knowledge_files_org_vector_status
  ON knowledge_files (organization_id, vector_status);

CREATE INDEX IF NOT EXISTS idx_knowledge_file_chunks_file_id
  ON knowledge_file_chunks (knowledge_file_id);
