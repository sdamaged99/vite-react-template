# Database

Cloudflare D1 (SQLite). Migrations live in `db/migrations/` and are applied with `npm run db:migrate:local` / `:remote`. Never edit an applied migration; add a new numbered file.

Conventions: timestamps are ISO 8601 UTC text; money is integer pence; booleans are 0/1 integers.

## Tables

| Table | Purpose |
| --- | --- |
| `settings` | Key/value configuration: `turnaround_buffer_hours`, `request_hold_hours`, `deposit_pence`, `extra_day_pence`, `cleaning_charge_pence`, `detergent_included`, `operating_base`, `handover_times`. |
| `delivery_zones` | Configurable geographical delivery pricing from Castletown: `one_way_pence` (delivery-only or collection-only) and `both_pence`. Amanda can add, remove, reprice or deactivate zones. Remote addresses are quoted manually per booking. |
| `equipment` | Hireable machines. One row today; the schema supports more. |
| `rate_plans` | Configurable durations and prices per machine (24h, 48h, weekend, week). |
| `addons` | Optional extras (cleaning solution). |
| `customers` | Contact details captured with a booking request. |
| `bookings` | Dormant since the Oct 2026 descope (kept as the upgrade path to a full reservation engine). One row per request. `buffer_until` = `end_at` + turnaround buffer and is what availability checks against. `hold_expires_at` drives auto-expiry of unanswered requests. `fulfilment` is one of `self`, `delivery_only`, `collection_only`, `both`; `transport_pence` (zone price, Amanda's manual `delivery_quote_pence`, or 0 when waived) is itemised separately from hire and deposit; `delivery_status` (`requested` → `confirmed`/`declined`) records Amanda's decision, and no delivery time is promised until she confirms. Rebuilt in migration 0003, pre-launch, while empty. |
| `payments` | Handover payments and deposits: kinds `hire`, `deposit`, `deposit_refund`, `deduction`. Method `online` is reserved for a future provider. |
| `enquiries` | Every enquiry from the website form: contact details, preferred dates, fulfilment preference, status (`new`/`replied`/`closed`) and whether the notification email was accepted. The system of record if mail fails. |
| `diary` | What actually drives availability: date ranges marked `booking` or `blocked`, added by Amanda at `/admin/`. The public calendar reads only the dates, never names. |
| `blocked_dates` | Dormant (superseded by `diary`). |
| `audit_log` | Significant admin and system events. |

## Booking status lifecycle

```
requested ──confirm──▶ confirmed ──handover──▶ collected ──return──▶ returned ──deposit settled──▶ closed
    │                      │
    ├─ declined            └─ cancelled
    └─ expired (hold_expires_at passed; set by the scheduled Worker)
```

Statuses `requested`, `confirmed` and `collected` occupy the calendar; everything else releases it.

## Overlap prevention (Phase 2 implementation note)

One machine means low contention, but simultaneous requests must still be safe. Insert a booking request with a single conditional statement so the check and the write are atomic:

```sql
INSERT INTO bookings (reference, equipment_id, customer_id, rate_plan_code, addon_codes,
                      start_at, end_at, buffer_until, fulfilment, status, hold_expires_at,
                      total_pence, terms_accepted_at)
SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'requested', ?10, ?11, ?12
WHERE NOT EXISTS (
  SELECT 1 FROM bookings
  WHERE equipment_id = ?2
    AND status IN ('requested', 'confirmed', 'collected')
    AND start_at < ?8          -- existing.start < new.buffer_until
    AND buffer_until > ?6      -- existing.buffer_until > new.start
)
AND NOT EXISTS (
  SELECT 1 FROM blocked_dates
  WHERE equipment_id = ?2 AND start_at < ?8 AND end_at > ?6
);
```

`meta.changes = 0` means the dates were taken; return a conflict to the client. D1 serialises writes per database, so this statement cannot interleave with another insert. The partial index `idx_bookings_window` keeps the check cheap.

## Backups

See OPERATIONS.md: D1 Time Travel for 30-day point-in-time restore, plus a scheduled export to R2 for longer retention.
