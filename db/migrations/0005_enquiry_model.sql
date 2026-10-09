-- Migration 0005: four fulfilment choices, extras, estimates, email-failure
-- tracking, and return/deposit tracking on the diary.
-- NON-DESTRUCTIVE: existing enquiry rows are carried over with their
-- fulfilment mapped ('collect' -> 'self', 'deliver' -> 'both').

ALTER TABLE enquiries RENAME TO enquiries_v1;

CREATE TABLE enquiries (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  preferred_start TEXT NOT NULL,       -- inclusive IoM-local ISO date (see shared/booking.ts)
  rate_plan_code TEXT NOT NULL,
  -- self: customer collects & returns (free). deliver_only / collect_only:
  -- one charged journey. both: both journeys charged.
  fulfilment TEXT NOT NULL CHECK (fulfilment IN ('self', 'deliver_only', 'collect_only', 'both')),
  area TEXT,                           -- configured zone areas, or free text => quoted individually
  address TEXT,
  extras TEXT NOT NULL DEFAULT '[]',   -- JSON array of addon codes
  estimate_total_pence INTEGER,        -- due at handover incl deposit; NULL when transport is quoted
  message TEXT,
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'replied', 'confirmed', 'declined', 'closed')),
  emailed INTEGER NOT NULL DEFAULT 0,
  email_error TEXT                     -- last SMTP failure, shown on the admin page with a retry
);

INSERT INTO enquiries (id, created_at, name, email, phone, preferred_start, rate_plan_code,
                       fulfilment, area, address, message, status, emailed)
SELECT id, created_at, name, email, phone, preferred_start, rate_plan_code,
       CASE fulfilment_pref WHEN 'deliver' THEN 'both' ELSE 'self' END,
       area, address, message, status, emailed
FROM enquiries_v1;

DROP TABLE enquiries_v1;
CREATE INDEX idx_enquiries_status ON enquiries (status, created_at);

-- Diary: link to the confirming enquiry, and track return and deposit as
-- SEPARATE actions (marking returned never touches the deposit).
ALTER TABLE diary ADD COLUMN enquiry_id INTEGER REFERENCES enquiries(id);
ALTER TABLE diary ADD COLUMN returned INTEGER NOT NULL DEFAULT 0;
ALTER TABLE diary ADD COLUMN deposit_status TEXT NOT NULL DEFAULT 'held'
  CHECK (deposit_status IN ('held', 'refunded', 'deducted', 'na'));
