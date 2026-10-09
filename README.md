# Sparkle Carpets

Equipment-hire website for sparklecarpets.im: React islands on a static marketing site, Hono API on Cloudflare Workers, D1 database.

## Prerequisites

- Node.js 20+
- A Cloudflare account with Workers and D1 enabled
- `npx wrangler login` completed

## Local development

```sh
npm install
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

The Cloudflare Vite plugin runs the Worker and static assets together at the dev URL; `/api/health` confirms the API, `/api/rates` confirms D1.

## First-time Cloudflare setup

1. `npx wrangler d1 create sparkle-carpets` and paste the returned `database_id` into `wrangler.jsonc` (done for production).
2. `npm run db:migrate:remote`
3. **Email (self-hosted NethServer):** create a sending mailbox (e.g. website@sparklecarpets.im), then set secrets:
   `npx wrangler secret put SMTP_HOST` (mail server hostname), `SMTP_PORT` (`465` implicit TLS or `587` STARTTLS), `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` (e.g. `Sparkle Carpets <website@sparklecarpets.im>`), `MAIL_TO` (`bookings@sparklecarpets.im`). With any unset, enquiries are stored but no email is sent. The server must present a valid TLS certificate and allow outbound submission from Cloudflare's network.
4. **Cloudflare Access (admin page):** Zero Trust → Access → Applications → self-hosted app covering `sparkle-carpets.../admin/*` and `/api/admin/*`, policy: Allow, include Emails = Amanda's address, one-time PIN login method. Then set `ACCESS_TEAM_DOMAIN` (e.g. `yourteam.cloudflareaccess.com`) and `ACCESS_AUD` (the app's Audience tag) in `wrangler.jsonc` vars and redeploy. Admin APIs are fail-closed until then.
5. **Turnstile (anti-spam):** Turnstile → Add site → copy the site key into `TURNSTILE_SITE_KEY` in `src/main.ts`, and `npx wrangler secret put TURNSTILE_SECRET_KEY`. Until both are set, the form relies on validation plus a honeypot.
6. **WhatsApp:** once the business number is verified, set it (digits only, international format) in the `settings` table key `whatsapp_number`; the buttons appear automatically.

## Deployment

Preferred: connect the GitHub repository to Cloudflare Workers Builds (Workers & Pages → the worker → Settings → Builds). Pushes to `main` deploy automatically; pull requests get preview URLs. Manual fallback: `npm run deploy`.

DNS for sparklecarpets.im is already on Cloudflare; add the custom domain to the Worker under Settings → Domains & Routes.

## Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Local dev server (Worker + assets + HMR) |
| `npm run build` | Production build to `dist/` |
| `npm run typecheck` | TypeScript project check (app + worker) |
| `npm run deploy` | Build and deploy with wrangler |
| `npm run db:migrate:local` / `:remote` | Apply D1 migrations |

## Publishing new hire terms

1. Add the new wording as `terms/versions/vN.N.txt` (never edit an old version's file).
2. Update `terms/index.html` (body, version number, effective date) and regenerate `worker/lib/terms.ts` so it contains every version's text and SHA-256, with `CURRENT_TERMS` pointing at the new one. Keep the page's figures identical to the canonical text file: the page is the published copy of a hashed document, so a price change means publishing a new version, not editing this one.
3. Nothing else: enquiries record the version and hash current at submission, and booking confirmations embed the accepted version's full text, so existing bookings are never moved onto newer terms.

## Repository documentation

- `PROJECT_CONTEXT.md` — background, architecture and the decision log
- `DATABASE.md` — schema, migrations and the overlap-prevention pattern
- `OPERATIONS.md` — backups, email DNS, maintenance, rollback
