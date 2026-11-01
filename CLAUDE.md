# Sparkle Carpets — handover for Claude Code

Read this first, then `PROJECT_CONTEXT.md` (decision log), `DATABASE.md`, `OPERATIONS.md` and `README.md`.

## What this is

Website and enquiry/admin system for **Sparkle Carpets** (sparklecarpets.im): Amanda Lawler's sole-trader carpet-cleaner **hire** business in Castletown, Isle of Man. One machine (BISSELL Big Green, UK model 48F3E). Customers send an **enquiry** (not a booking); Amanda confirms by email/WhatsApp, takes payment and a £75 deposit at handover (cash or bank transfer), and runs everything from email, WhatsApp and the admin page. A handful of hires a month: keep everything simple and on free tiers.

Barry (repo owner) builds and maintains it and also does some handovers.

## Where things are

| Thing | Value |
|---|---|
| Repo | `github.com/sdamaged99/vite-react-template` (private; name is a leftover from Cloudflare's template) |
| Production | Cloudflare Worker `sparkle-carpets`, served at `sparkle-carpets.barry-60c.workers.dev`. Custom domain `sparklecarpets.im` **not yet confirmed attached** |
| Deploy | Cloudflare Workers Builds: **every push to `main` deploys to production**. Other branches build previews |
| Database | D1 `sparkle-carpets`, id `bd084e6b-7008-4f3d-b434-d38136f0d316`, binding `DB` |
| Email | Self-hosted NethServer 8 over SMTP (dependency-free client in `worker/lib/smtp.ts`) |
| Admin | `/admin/`, protected by Cloudflare Access (verified again inside the Worker; fail-closed) |

**Warning:** preview builds use the **production D1**. Never point tests or experiments at a preview with real data unless you mean to.

Git hosting: Barry is moving personal projects from GitHub to his Gitea (`gitea.demanufactured.co.uk`, user `barry`), one project at a time, GitHub staying authoritative until he approves each cutover. This one hasn't been migrated. Workers Builds only connects to GitHub/GitLab, so a move to Gitea also needs a new deploy path (e.g. Gitea Actions running `wrangler deploy` with an API token). Don't move it without his go-ahead.

## Stack and layout

Vite 6 multi-page static site + vanilla TypeScript (no React components in use despite the template name) + Tailwind v4, served as Workers Static Assets; Hono API in the same Worker under `/api/*` (`run_worker_first`); D1 (SQLite).

```
index.html, terms/, privacy/, instructions/, admin/   pages (Vite inputs in vite.config.ts → environments.client)
src/main.ts          public site: pricing hydration, calendar, 3-step enquiry, estimate, prepared gallery/reviews/WhatsApp
src/admin.ts         admin: Today dashboard, diary, handover/return/deposit panels, enquiries, activity
src/styles/main.css  Tailwind @theme tokens + components
shared/booking.ts    date/money rules shared by browser and Worker (IoM time, spans, overlap, estimate)
worker/index.ts      Hono app + scheduled() (reminders; inactive)
worker/routes/public.ts   /api/pricing, /api/unavailable, POST /api/enquiry
worker/routes/admin.ts    /api/admin/* enquiries, confirm, acceptance, diary
worker/routes/hire.ts     /api/admin handover, return, payment, deposit ledger, /today
worker/lib/  smtp.ts, notify.ts (emails), terms.ts (GENERATED), access.ts (JWT), reminders.ts
db/migrations/0001–0011   applied in production (see below)
terms/versions/*.txt      canonical hire terms, hashed; scripts/gen-terms.mjs builds worker/lib/terms.ts
public/   images, qr/ (machine-guide QR + print sheet), gallery/ and reviews/ manifests (empty), robots, sitemap
tests/    booking.test.ts, api.test.ts, browser_test.py, retention_test.py, visual_test.py, harness/
```

## Commands

```sh
npm install
npm run dev            # Vite + Worker locally (Cloudflare Vite plugin)
npm run build          # what Workers Builds runs
npm run typecheck      # tsc -b — NEVER RUN YET (see "First jobs")
npm run db:migrate:local
```

Tests (no node_modules needed; the harness stands in for Hono, D1 and the mail server):

```sh
node --experimental-strip-types tests/booking.test.ts
node --experimental-transform-types --import ./tests/harness/register.mjs tests/api.test.ts      # 42 tests
python3 tests/browser_test.py        # 47 tests, needs Python Playwright + Chromium
python3 tests/retention_test.py      # 10 tests: the housekeeping SQL in OPERATIONS.md
SITE_CSS=… FONT_DIR=… SHOT_DIR=… python3 tests/visual_test.py   # styled layout/contrast/tap targets
```

`visual_test.py` needs a Tailwind build of `src/styles/main.css` (`npx @tailwindcss/cli -i src/styles/main.css -o site.css` locally) and the Fraunces/Figtree variable fonts from `github.com/google/fonts`. The browser/visual tests start a server on ports 8799/8797 and refuse to run if a stale one is still listening. Browser tests at 375px use `is_mobile=False` on purpose (mobile emulation hung clicks on unstyled pages).

All of the above were last run green on commit `4e2f541`, but only against the harness: **nothing has been tested against live Cloudflare, real D1, the NethServer or Cloudflare Access.**

## Database and migrations

Production has 0001–0011 applied (confirmed by `SELECT name FROM d1_migrations`). Migrations have been applied by pasting into the **D1 Console**, which rejects SQL comments, so paste a comment-free copy and finish with `INSERT INTO d1_migrations (name) VALUES ('00NN_name.sql');`. Wrangler (`npm run db:migrate:remote`) also works now that you have a local toolchain; don't do both for the same file.

Rules: migrations are additive; existing rows must survive; a migration that the new code depends on is applied **before** merging that code (0007/0008 caused short outages when merged first).

Key tables: `rate_plans`, `addons`, `delivery_zones`, `settings` (prices and switches live here, never hard-coded beyond static fallbacks), `enquiries` (incl. terms acknowledgement vs formal acceptance, separate columns), `diary` (bookings/blocks, handover/return, hire payment), `deposit_entries` (ledger: one `taken`, then partial `refund`/`deduction`, guarded so they never exceed what's held), `audit_log`.

## Rules that matter (from the decision log)

- **Never deploy or merge to `main` without Barry's explicit approval.** Work on a branch, run the tests, report, wait. Never claim something is committed or deployed unless the tool output shows it.
- Enquiry ≠ booking. Initial checkbox = acknowledgement of the proposed terms; formal acceptance is recorded separately by Amanda; Confirm never records acceptance.
- **Terms are versioned and hashed.** Never edit an existing `terms/versions/vX.txt`. To change terms: add a new version file, update `terms/index.html`, run `node scripts/gen-terms.mjs` (add the version to its list). Current: **v1.1** (effective 11 Oct 2026). Old enquiries keep their version.
- Sole trader, operated by Amanda Lawler. Never call it a company, registered, insured or certified. Payment: cash or bank transfer at handover; **no Stripe or online payments** (Stripe doesn't support IoM). No customer accounts, no paid services.
- Stair & upholstery attachment is **included free**; only extra detergent (£5) is a paid extra.
- Never fabricate photos, reviews, testimonials or machine figures. The machine photo is a deliberate placeholder until Amanda supplies real ones. Dimensions shown are the verified 107 × 28 × 52 cm only.
- Dates are Isle of Man calendar dates (`todayIoM()`, DST-safe). Weekend hire is Fri–Mon and blocks the Monday. Pending enquiries never block availability.
- Privacy notice v1.1 promises no fixed retention periods; OPERATIONS.md has the monthly housekeeping SQL (internal defaults: 10 months / 6 years).
- English (GB), plain wording, no marketing fluff. Preserve the design (tokens in `main.css`); `ink-soft` is `#5b6572` for AA contrast.

## Gotchas already hit

- Vite multi-page inputs must sit under `environments.client.build.rollupOptions.input`, or the Worker build fails ("Entry module 'index.html' cannot be external").
- `cloudflare:sockets` is imported dynamically with `/* @vite-ignore */`.
- `worker/lib/terms.ts` is generated; edit the `.txt` files and regenerate.
- An admin page left open across a deploy calls removed endpoints until refreshed.
- D1 Console shows only the last statement's result in a multi-statement paste.

## Still to do (owner: Barry/Amanda unless noted)

1. **Configuration before launch:** SMTP secrets (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, `MAIL_TO`; `bookings@` is an alias of Amanda's account with no password of its own, so the recommended sender is a dedicated real `website@` mailbox, with `MAIL_TO` = `bookings@`; Barry hasn't confirmed which he set up); Cloudflare Access app for `/admin/*` and `/api/admin/*` plus `ACCESS_TEAM_DOMAIN`/`ACCESS_AUD` vars; attach the custom domain; SPF/DKIM/DMARC; optional Turnstile.
2. **Live smoke test** once configured: enquiry → both emails → record acceptance → confirm → handover → return → refund; then delete the test rows.
3. Print the QR sticker from `/qr/` only once `sparklecarpets.im` is live, and test-scan it.
4. Confirm Information Commissioner registration and where the NethServer is hosted (privacy notice may need it).
5. Real machine photos → swap the placeholder (instructions in `index.html` comments), then optionally the gallery manifest.
6. Prepared features (all OFF, see README "Prepared features"): reminders (needs a cron trigger in `wrangler.jsonc` **and** `reminders_enabled='1'`), WhatsApp follow-up (verified number **and** `whatsapp_followup='1'`), gallery, testimonials.
7. Known limitations: equipment photos aren't uploaded (just a "photos taken" tick; would need R2); structured-data prices in `index.html` must be updated by hand if D1 prices change; preview builds share production D1.

## First jobs in Claude Code

1. `npm install && npm run typecheck && npm run build`. Typecheck has never been run on this code (the previous sandbox had no npm access); fix any type errors on a branch.
2. Run the four test suites above to confirm the local setup matches.
3. Then pick up "Still to do" with Barry.
