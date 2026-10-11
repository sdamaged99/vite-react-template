-- Migration 0011: storage for prepared-but-inactive features. Additive only.
-- Reminders: when each reminder email went out (claimed before sending, so
-- a retried run never sends twice).
ALTER TABLE diary ADD COLUMN reminder_handover_sent_at TEXT;
ALTER TABLE diary ADD COLUMN reminder_return_sent_at TEXT;
-- Feature switches, both OFF. Turning one on is a deliberate settings change.
INSERT OR IGNORE INTO settings (key, value) VALUES ('reminders_enabled', '0');
INSERT OR IGNORE INTO settings (key, value) VALUES ('whatsapp_followup', '0');
