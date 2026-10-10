-- The upholstery & stair attachment is now included with every hire rather
-- than a GBP 5 optional extra. Deactivating the addon removes it from the
-- public pricing API and stops the server pricing it from stale clients.
UPDATE addons SET active = 0 WHERE code = 'upholstery_tool';
