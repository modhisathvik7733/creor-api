-- Add source column to keys table to distinguish IDE-generated keys from user-created ones.
-- IDE keys (source='ide') are hidden from the web dashboard and cannot be deleted by users.

ALTER TABLE keys ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'user';
