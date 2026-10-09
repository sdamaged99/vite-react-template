-- Migration 0003: provisional launch pricing (GBP, pence) and zoned delivery.
-- Every figure here is editable via settings/rate_plans/addons/delivery_zones,
-- which the Phase 2 admin dashboard writes to.

-- Hire packages ---------------------------------------------------------------
UPDATE rate_plans SET price_pence = 3000, label = '24-hour hire'  WHERE equipment_id = 1 AND code = '24h';
UPDATE rate_plans SET price_pence = 4500, label = '48-hour hire'  WHERE equipment_id = 1 AND code = '48h';
UPDATE rate_plans SET price_pence = 5500, label = 'Weekend hire'  WHERE equipment_id = 1 AND code = 'weekend';
UPDATE rate_plans SET price_pence = 9500, label = 'Weekly hire'   WHERE equipment_id = 1 AND code = 'week';

INSERT INTO rate_plans (equipment_id, code, label, duration_hours, price_pence)
SELECT 1, '3day', '3-day hire', 72, 6000
WHERE NOT EXISTS (SELECT 1 FROM rate_plans WHERE equipment_id = 1 AND code = '3day');

-- Add-ons. One measured starter portion of detergent is included with every
-- hire (settings flag below); this row is the additional portion.
UPDATE addons SET label = 'Additional detergent portion', price_pence = 500 WHERE code = 'solution';

INSERT INTO addons (code, label, price_pence)
SELECT 'upholstery_tool', 'Upholstery & stair attachment (subject to availability)', 500
WHERE NOT EXISTS (SELECT 1 FROM addons WHERE code = 'upholstery_tool');

-- Delivery & collection: configurable geographical zones from Castletown ------
-- one_way_pence covers delivery-only OR collection-only; both_pence covers both
-- journeys. Remote/unusual addresses are quoted manually (bookings.delivery_quote_pence).
CREATE TABLE delivery_zones (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,          -- display name, e.g. 'Castletown'
  areas TEXT NOT NULL,         -- comma-separated places the zone covers
  one_way_pence INTEGER NOT NULL,
  both_pence INTEGER NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

INSERT INTO delivery_zones (name, areas, one_way_pence, both_pence, sort) VALUES
  ('Castletown',            'Castletown',                       500,  1000, 1),
  ('Ballasalla area',       'Ballasalla, Derbyhaven',           750,  1500, 2),
  ('South west',            'Port Erin, Port St Mary, Colby',  1000,  2000, 3),
  ('Ballabeg & Santon',     'Ballabeg, Santon',                1500,  3000, 4),
  ('Douglas area',          'Douglas, Braddan, Onchan',        2000,  4000, 5),
  ('Peel & central',        'Peel, St John''s, Laxey',         2500,  5000, 6),
  ('North west',            'Kirk Michael, Sulby, Ballaugh',   3500,  7000, 7),
  ('North',                 'Ramsey, Andreas, Jurby',          4000,  8000, 8);

-- Bookings: four fulfilment choices and delivery workflow ---------------------
-- Rebuilt because SQLite cannot alter a CHECK constraint. Safe at this point in
-- the migration sequence: the system is pre-launch and the table holds no rows.
DROP TABLE bookings;
CREATE TABLE bookings (
  id INTEGER PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  equipment_id INTEGER NOT NULL REFERENCES equipment(id),
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  rate_plan_code TEXT NOT NULL,
  addon_codes TEXT NOT NULL DEFAULT '[]',
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  buffer_until TEXT NOT NULL,
  -- 'self': customer collects and returns, free. 'delivery_only' / 'collection_only':
  -- one journey. 'both': Sparkle handles both journeys.
  fulfilment TEXT NOT NULL CHECK (fulfilment IN ('self', 'delivery_only', 'collection_only', 'both')),
  delivery_zone_id INTEGER REFERENCES delivery_zones(id),
  delivery_address TEXT,            -- full validated address when fulfilment <> 'self'
  delivery_quote_pence INTEGER,     -- manual quotation for remote/unusual addresses; overrides zone price
  -- Delivery is always subject to Amanda's availability: never auto-promise a
  -- date or time. Journey times are agreed separately from the rental dates.
  delivery_status TEXT NOT NULL DEFAULT 'none'
    CHECK (delivery_status IN ('none', 'requested', 'confirmed', 'declined')),
  transport_pence INTEGER NOT NULL DEFAULT 0,  -- shown separately from hire and deposit; 0 = waived/self
  status TEXT NOT NULL CHECK (status IN
    ('requested', 'confirmed', 'declined', 'expired', 'cancelled', 'collected', 'returned', 'closed')),
  hold_expires_at TEXT,
  total_pence INTEGER NOT NULL,     -- hire + addons + transport; deposit tracked in payments
  terms_accepted_at TEXT NOT NULL,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_bookings_window
  ON bookings (equipment_id, start_at, buffer_until)
  WHERE status IN ('requested', 'confirmed', 'collected');
CREATE INDEX idx_bookings_status ON bookings (status);

-- Charges and settings --------------------------------------------------------
UPDATE settings SET value = '7500', updated_at = datetime('now') WHERE key = 'deposit_pence';
DELETE FROM settings WHERE key = 'delivery_charge_pence';

INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES
  ('extra_day_pence',       '1500', datetime('now')),  -- additional hire day, subject to availability
  ('cleaning_charge_pence', '1000', datetime('now')),  -- excessive equipment-cleaning charge, where justified
  ('detergent_included',    '1',    datetime('now')),  -- one measured starter portion included per hire
  ('operating_base',        'Castletown', datetime('now')),  -- public area only; the private address is never published
  -- Provisional handover times; confirm with Amanda before showing on the site.
  ('handover_times', '{"weekend":{"collect":"Fri 17:30","return":"Mon 08:30"},"provisional":true}', datetime('now'));
