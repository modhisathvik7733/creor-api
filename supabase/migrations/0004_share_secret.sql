-- Add secret column for engine-based share auth (no JWT needed)
ALTER TABLE shares ADD COLUMN secret TEXT;
CREATE INDEX shares_secret_idx ON shares (secret) WHERE secret IS NOT NULL;
