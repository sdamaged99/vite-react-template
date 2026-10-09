-- Migration 0001: initial schema.
-- Times are stored as ISO 8601 UTC text; money as integer pence.

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE equipment (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  model TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  notes TEXT
);

CREATE TABLE rate_plans (
  id INTEGER PRIMARY KEY,
  equipment_id INTEGER NOT NULL REFERENCES equipment(id),
  code TEXT NOT NULL,                 -- '24h' | '48h' | 'weekend' | 'week'
  label TEXT NOT NULL,
  duration_hours INTEGER NOT NULL,
  price_pence INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (equipment_id, code)
);

CREATE TABLE addons (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,          -- 'solution'
  label TEXT NOT NULL,
  price_pence INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  address TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE bookings (
  id INTEGER PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,     -- short human-friendly code, e.g. 'SC-4F7K'
  equipment_id INTEGER NOT NULL REFERENCES equipment(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  rate_plan_code TEXT NOT NULL,
  addon_codes TEXT NOT NULL DEFAULT '[]',   -- JSON array of addon codes
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  buffer_until TEXT NOT NULL,         -- end_at + turnaround buffer; blocks the next hire
  fulfilment TEXT NOT NULL CHECK (fulfilment IN ('collection', 'delivery')),
  delivery_address TEXT,
  status TEXT NOT NULL CHECK (status IN
    ('requested', 'confirmed', 'declined', 'expired', 'cancelled', 'collected', 'returned', 'closed')),
  hold_expires_at TEXT,               -- set while status = 'requested'; auto-release deadline
  total_pence INTEGER NOT NULL,
  terms_accepted_at TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Payments are recorded at handover (card reader / bank transfer / cash).
-- The 'online' method exists so a payment provider can be added later
-- without a schema migration.
CREATE TABLE payments (
  id INTEGER PRIMARY KEY,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  kind TEXT NOT NULL CHECK (kind IN ('hire', 'deposit', 'deposit_refund', 'deduction')),
  method TEXT NOT NULL CHECK (method IN ('card_reader', 'bank_transfer', 'cash', 'online')),
  amount_pence INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'received', 'refunded', 'waived')),
  recorded_by TEXT,
  recorded_at TEXT NOT NULL DEFAULT (datetime('now')),
  note TEXT
);

CREATE TABLE blocked_dates (
  id INTEGER PRIMARY KEY,
  equipment_id INTEGER NOT NULL REFERENCES equipment(id),
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  reason TEXT
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  actor TEXT NOT NULL,                -- admin email or 'system'
  action TEXT NOT NULL,
  entity TEXT,
  entity_id INTEGER,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_bookings_window
  ON bookings (equipment_id, start_at, buffer_until)
  WHERE status IN ('requested', 'confirmed', 'collected');

CREATE INDEX idx_bookings_status ON bookings (status);
CREATE INDEX idx_payments_booking ON payments (booking_id);
CREATE INDEX idx_blocked_window ON blocked_dates (equipment_id, start_at, end_at);
