# Project context

## Background

Sparkle Carpets is Amanda's Isle of Man side business hiring out one BISSELL Big Green carpet-cleaning machine to domestic customers. It is equipment hire, not a cleaning service. Barry builds and maintains the site; Amanda runs bookings from her phone and is not expected to touch the infrastructure. The guiding principle is the smallest reliable system that delivers an excellent customer experience.

## Architecture

- **Public site:** static HTML authored in `index.html`, styled with Tailwind v4 design tokens (`src/styles/main.css`). No framework on the marketing page; a small vanilla script handles the mobile menu. Fully crawlable, fast first paint.
- **Islands:** React mounts only into explicit mount points (`src/islands/`), loaded on demand. Phase 2 adds the availability calendar island; the admin dashboard will be a separate React entry behind Access.
- **API:** Hono on Cloudflare Workers (`worker/`), routes split into `public`, `booking` and `admin`. Static assets are served by Workers Static Assets with `run_worker_first` on `/api/*`.
- **Database:** Cloudflare D1, migrations in `db/migrations/`. Config (prices, buffer, hold window, deposit) lives in tables, not code.
- **Admin auth:** Cloudflare Access (one-time PIN to Amanda's email) in front of the admin area, with the Access JWT independently verified in the Worker (`worker/lib/access.ts`). No app-level password storage.

## Decision log

| # | Decision | Rationale |
| --- | --- | --- |
| 1 | No Stripe | Stripe does not support businesses in British Crown Dependencies, Isle of Man included (verified Oct 2026). |
| 2 | Launch payment model: booking request online, payment at handover (card reader / bank transfer) | Halves the backend (no webhooks, holds, refunds); volume does not yet justify online payment. Schema keeps a `payments` table with an `online` method so a provider (PayPal / SumUp, both IoM-compatible) can be added later without migration. |
| 3 | Deposit taken at handover, refunded after return inspection | Avoids processor fees both ways and card pre-auth windows; tracked as payment rows. |
| 4 | Cleaning solution as a paid add-on at booking | Margin line; customers get everything in one go. |
| 5 | Booking requests auto-hold dates; Amanda confirms or declines; unanswered requests auto-expire (default 24 h, `request_hold_hours`) | Prevents double requests without instant-confirm risk. |
| 6 | Turnaround buffer after each return, fixed hours, configurable (default 4 h, `turnaround_buffer_hours`) | Business requirement: inspection and cleaning time between hires; allows same-day rehire on early returns. |
| 7 | Cloudflare Access for admin auth | Removes the riskiest code (hand-rolled auth) entirely; free at this scale; works on a phone. |
| 8 | Static prerendered marketing page + React islands | Local SEO goals; smallest JS payload; React reserved for the calendar and admin. |
| 9 | Public site is light-theme only | Deliberate simplification for a marketing site specced as white/off-white; halves visual QA. |
| 10 | Transactional email: Resend (Phase 3) | MailChannels' free Workers integration ended; Resend free tier covers this volume. Swappable. |
| 11 | No invented content | Prices, photos, specs, policies and reviews that are not yet real carry a visible dashed "placeholder" marker so nothing fabricated ships unnoticed. |
| 13 | Typography: Fraunces (display, optical sizing) + Figtree (body), Oct 2026 | Chosen from seven specimens as the soft-editorial direction; replaced the launch pairing Young Serif + Karla, which was limited to one display weight. |
| 12 | Visual identity: "fresh linen boutique" (design Concept B, Oct 2026) | Chambray blue + oat + ink-navy palette (no green, no terracotta), arched "doorway" photo frames and circular IoM stamp as the graphic language, Young Serif display with Karla body, café-menu price presentation. Chosen over an editorial concept (too photography-dependent) and a conversion-panel concept (least distinctive); the booking-panel hero idea from the latter is earmarked for Phase 2. Real lifestyle and product photography still required; all image slots carry shot direction. |

## Phases

1. **Website and branding** — this scaffold: public site, identity, pricing presentation, docs. ← current
2. **Booking engine** — availability API, booking request flow with Turnstile, hold expiry via scheduled Worker, admin dashboard behind Access.
3. **Payments and notifications** — transactional email (confirmation, collection instructions, return reminder, cancellation, new-booking alert to Amanda); online payment only if demand justifies it.
4. **Security and production readiness** — concurrency tests on the booking window, cancellation paths, expiry runs, auth checks, restore drill, rollback drill.

## Open items before launch

- Real prices, deposit amount, delivery charge, handover times and location (Amanda).
- Verified Big Green model designation and specs.
- Photography.
- Rental terms and privacy policy text (damage liability, late return, cancellation cut-offs).
- Check whether registration with the IoM Information Commissioner is required.
- Confirm liability insurance for hired-out equipment.
