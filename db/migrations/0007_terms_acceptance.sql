-- Migration 0007: record terms acceptance per enquiry. Non-destructive;
-- pre-existing rows keep NULLs ("no terms record"). Confirmed bookings keep
-- the version their enquiry accepted via diary.enquiry_id.
ALTER TABLE enquiries ADD COLUMN terms_version TEXT;
ALTER TABLE enquiries ADD COLUMN terms_accepted_at TEXT;
ALTER TABLE enquiries ADD COLUMN terms_hash TEXT;
