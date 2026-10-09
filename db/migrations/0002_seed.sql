-- Migration 0002: seed configuration. Placeholder prices are 0 and must be
-- set via the admin dashboard (or directly) before launch.

INSERT INTO equipment (id, name, model, active, notes) VALUES
  (1, 'BISSELL Big Green', 'Big Green deep cleaning machine', 1, 'Verify exact model designation before publishing specs.');

INSERT INTO rate_plans (equipment_id, code, label, duration_hours, price_pence) VALUES
  (1, '24h',     '24-hour hire', 24,  0),
  (1, '48h',     '48-hour hire', 48,  0),
  (1, 'weekend', 'Weekend hire', 63,  0),  -- Fri evening → Mon morning; adjust to confirmed handover times
  (1, 'week',    'Weekly hire',  168, 0);

INSERT INTO addons (code, label, price_pence) VALUES
  ('solution', 'Carpet cleaning solution', 0);

INSERT INTO settings (key, value) VALUES
  ('turnaround_buffer_hours', '4'),
  ('request_hold_hours', '24'),
  ('deposit_pence', '0'),            -- set before launch
  ('delivery_charge_pence', '0'),    -- set before launch
  ('handover_times', '{}');          -- JSON: configurable collection/return slots, Phase 2
