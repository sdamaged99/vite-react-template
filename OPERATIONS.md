# Operations

## Backups and recovery

- **D1 Time Travel** provides point-in-time restore for the last 30 days: `npx wrangler d1 time-travel restore sparkle-carpets --timestamp=<unix>`. Verify the current bookmark before risky changes: `npx wrangler d1 time-travel info sparkle-carpets`.
- **Long retention (Phase 2):** a scheduled Worker run exports bookings, customers and payments to R2 (or emails a CSV) weekly. Until then, `npx wrangler d1 export sparkle-carpets --remote --output=backup.sql` taken manually before each schema migration.
- **Restore drill:** part of Phase 4 sign-off; do not launch untested.

## Deployment and rollback

- Deploys run from GitHub via Cloudflare Workers Builds on push to `main`; PRs get preview URLs with a separate preview D1 database.
- Rollback: `npx wrangler deployments list` then `npx wrangler rollback` to the previous version. Static assets and Worker roll back together.
- Database migrations do not roll back automatically; write a compensating migration.

## Email

All mail goes through the business's own NethServer: the Worker submits enquiry notifications and customer acknowledgements over authenticated SMTP (465/587) using a dedicated mailbox, so SPF/DKIM/DMARC are whatever the NethServer already publishes and no third-party sender exists. Credentials are Worker secrets (`SMTP_*`, `MAIL_*`; see README). If a send fails, the enquiry is still stored and flagged "not emailed" on the admin page, so check there whenever the mail server has been down.

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
| Enquiry emails missing | Admin page "not emailed" flags, NethServer mail log, SMTP secrets set, spam folder |
| Calendar not showing busy dates | `/api/unavailable` response; diary entries' date ranges |
