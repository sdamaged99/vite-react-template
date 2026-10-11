-- Migration 0010: handover/return checklists, hire-payment amounts and an
-- itemised deposit ledger. Additive only: existing diary rows keep every
-- value; new columns are NULL for them, and their old paid/returned/
-- deposit_status flags remain valid.
ALTER TABLE diary ADD COLUMN handed_over_at TEXT;
ALTER TABLE diary ADD COLUMN handover_check TEXT;
ALTER TABLE diary ADD COLUMN returned_at TEXT;
ALTER TABLE diary ADD COLUMN return_check TEXT;
ALTER TABLE diary ADD COLUMN hire_paid_pence INTEGER;
ALTER TABLE diary ADD COLUMN hire_paid_method TEXT;
ALTER TABLE diary ADD COLUMN hire_paid_at TEXT;

-- Money held as deposit, kept apart from hire income. One 'taken' row per
-- hire; any number of partial refunds and deductions, each never more than
-- what is still held (enforced by the Worker's guarded inserts).
CREATE TABLE deposit_entries (
  id INTEGER PRIMARY KEY,
  diary_id INTEGER NOT NULL REFERENCES diary(id),
  kind TEXT NOT NULL CHECK (kind IN ('taken', 'refund', 'deduction')),
  amount_pence INTEGER NOT NULL CHECK (amount_pence > 0),
  reason TEXT,
  actor TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_deposit_entries_diary ON deposit_entries (diary_id);
CREATE UNIQUE INDEX idx_deposit_taken_once ON deposit_entries (diary_id) WHERE kind = 'taken';
