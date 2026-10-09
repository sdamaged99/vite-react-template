-- Migration 0004: simplified enquiry model.
-- Customers send enquiries; Amanda confirms by email/WhatsApp and records
-- bookings or blocked periods in the diary, which drives the public calendar.
-- The richer bookings/payments tables from 0001/0003 remain but are dormant.

CREATE TABLE enquiries (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  preferred_start TEXT NOT NULL,      -- ISO date the customer would like to start
  rate_plan_code TEXT NOT NULL,
  fulfilment_pref TEXT NOT NULL CHECK (fulfilment_pref IN ('collect', 'deliver')),
  area TEXT,                          -- delivery zone name when delivering
  address TEXT,                       -- delivery address when delivering
  message TEXT,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'replied', 'closed')),
  emailed INTEGER NOT NULL DEFAULT 0  -- 1 once the notification email was accepted by the mail server
);

CREATE INDEX idx_enquiries_status ON enquiries (status, created_at);

CREATE TABLE diary (
  id INTEGER PRIMARY KEY,
  start_date TEXT NOT NULL,           -- ISO date, inclusive
  end_date TEXT NOT NULL,             -- ISO date, inclusive (covers turnaround too)
  kind TEXT NOT NULL CHECK (kind IN ('booking', 'blocked')),
  name TEXT,                          -- customer name for bookings; label for blocks
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_diary_dates ON diary (end_date, start_date);

INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES
  ('whatsapp_number', '', datetime('now'));  -- E.164 digits once verified; empty hides the button
