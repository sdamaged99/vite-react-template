-- Migration 0006: record hire payment received, separate from returned and
-- deposit status. Non-destructive single column addition.
ALTER TABLE diary ADD COLUMN paid INTEGER NOT NULL DEFAULT 0;
