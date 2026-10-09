# Operations

## Backups and recovery

- **D1 Time Travel** provides point-in-time restore for the last 30 days: `npx wrangler d1 time-travel restore sparkle-carpets --timestamp=<unix>`. Verify the current bookmark before risky changes: `npx wrangler d1 time-travel info sparkle-carpets`.
- **Long retention (Phase 2):** a scheduled Worker run exports bookings, customers and payments to R2 (or emails a CSV) weekly. Until then, `npx wrangler d1 export sparkle-carpets --remote --output=backup.sql` taken manually before each schema migration.
- **Restore drill:** part of Phase 4 sign-off; do not launch untested.

## Deployment and rollback

- Deploys run from GitHub via Cloudflare Workers Builds on push to `main`; PRs get preview URLs with a separate preview D1 database.
- Rollback: `npx wrangler deployments list` then `npx wrangler rollback` to the previous version. Static assets and Worker roll back together.
- Database migrations do not roll back automatically; write a compensating migration.

## Email and DNS

Two senders will share sparklecarpets.im:

1. **NethServer 8** hosts the `bookings@` mailbox for ordinary correspondence.
2. **Resend** (Phase 3) sends automated transactional mail via API from the Worker.

DNS requirements when Phase 3 lands:

- SPF: one merged record including both senders, e.g. `v=spf1 include:<nethserver-sender> include:resend's-spf -all` (exactly one SPF TXT record on the domain).
- DKIM: separate selectors per sender (NethServer's own, plus the records Resend issues at verification).
- DMARC: start at `p=none` with a monitoring address, tighten once reports are clean.
- Keep API keys out of the frontend; `EMAIL_API_KEY` is a Worker secret.

## Routine maintenance

- Dependency updates monthly (`npm outdated`), Cloudflare compatibility date reviewed quarterly.
- Review `audit_log` and Worker observability for anomalies when touching the app.
- Amanda-facing issues (booking stuck, wrong price): fix data via the admin dashboard, never direct SQL in production unless the dashboard cannot, and record what changed.

## Troubleshooting

| Symptom | First checks |
| --- | --- |
| /api/* returning 500 | Worker logs (observability is enabled), recent deploy, D1 binding present |
| Admin 401 for Amanda | Access policy includes her email; `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` match the Access app; JWT header reaching the Worker |
| Admin 503 | Access vars unset; admin is fail-closed by design |
| Emails missing (Phase 3) | Resend dashboard delivery log, SPF/DKIM alignment, spam folder |
| Double-booking reported | Should be impossible via the conditional insert; check for manual SQL writes and `blocked_dates` gaps |
