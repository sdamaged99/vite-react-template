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

1. `npx wrangler d1 create sparkle-carpets` and paste the returned `database_id` into `wrangler.jsonc`.
2. `npm run db:migrate:remote`
3. Set production secrets as they become needed: `npx wrangler secret put EMAIL_API_KEY` etc.
4. Cloudflare Access (admin area, Phase 2): create a self-hosted Access application covering `/admin` and `/api/admin/*` with a one-time-PIN policy for Amanda's email, then set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` in `wrangler.jsonc` vars.

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

## Repository documentation

- `PROJECT_CONTEXT.md` — background, architecture and the decision log
- `DATABASE.md` — schema, migrations and the overlap-prevention pattern
- `OPERATIONS.md` — backups, email DNS, maintenance, rollback
