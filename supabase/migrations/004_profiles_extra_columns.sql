-- Add optional columns to profiles used by Team Members UI
ALTER TABLE profiles
  ADD COLUMN IF NOT EXISTS department    text         NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS invited_by    text,
  ADD COLUMN IF NOT EXISTS last_seen_at  timestamptz;
