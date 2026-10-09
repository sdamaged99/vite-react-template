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
| 15 | Launch pricing (provisional, Oct 2026): 24h £30, 48h £45 (recommended), weekend £55, 3 days £60, 7 days £95; £75 refundable deposit; starter detergent included, extra portion £5; upholstery attachment £5 subject to availability; extra day £15 subject to availability; equipment-cleaning charge £10 where justified | All figures live in D1 (`rate_plans`/`addons`/`settings`), served by `GET /api/pricing`, and the homepage hydrates from it, so Amanda can change prices without a deploy. Static HTML carries fallback figures that refresh on deploy. |
| 14 | Delivery: configurable zones from Castletown with four fulfilment choices (self free, delivery only, collection only, both); every delivery subject to Amanda's confirmation, journey times agreed separately from hire dates, remote addresses quoted manually, transport always itemised separately; her home address never published | `delivery_zones` table seeded with eight zones (£5–£40 one journey, doubled for both); `bookings` rebuilt with fulfilment/zone/quote/status columns in migration 0003. |
| 13 | Typography: Fraunces (display, optical sizing) + Figtree (body), Oct 2026 | Chosen from seven specimens as the soft-editorial direction; replaced the launch pairing Young Serif + Karla, which was limited to one display weight. |
| 12 | Visual identity: "fresh linen boutique" (design Concept B, Oct 2026) | Chambray blue + oat + ink-navy palette (no green, no terracotta), arched "doorway" photo frames and circular IoM stamp as the graphic language, Young Serif display with Karla body, café-menu price presentation. Chosen over an editorial concept (too photography-dependent) and a conversion-panel concept (least distinctive); the booking-panel hero idea from the latter is earmarked for Phase 2. Real lifestyle and product photography still required; all image slots carry shot direction. |

| 16 | Descope to an enquiry-based service (Oct 2026) | A handful of bookings a month doesn't justify a reservation engine. Customers send an enquiry (form → email via the business's own NethServer over SMTP from the Worker, copy kept in `enquiries`); Amanda confirms by email/WhatsApp, takes payment at handover, and records dates in a simple `diary` that drives the public availability calendar and her one admin page behind Cloudflare Access. Dropped: online payments, deposits automation, holds/expiry, R2 evidence, damage reports, reporting, the large dashboard, and the React dependency (vanilla JS only). The richer bookings/payments tables stay dormant as an upgrade path. WhatsApp button hidden until a verified number is set in settings. |

| 17 | Improvement pass A–G (Oct 2026, `improvements` branch) | Conversion-focused copy; IoM-local (DST-safe) booking dates with weekend spans covering the Monday return day, shared between Worker and browser (shared/booking.ts, tested); server-side overlap blocking for enquiries and atomic guarded confirmation; four fulfilment choices with zone pricing and individual quotes; extras; full due-at-handover estimate; honest email-failure handling with admin retry; one-tap confirm/decline/returned/deposit with audit trail; sourced BG10 facts; proposed policy terms marked awaiting approval. |

## Current shape (post-descope)

Public site (home + terms + instructions + privacy) → enquiry form → email to bookings@ via self-hosted SMTP, stored in `enquiries` → Amanda replies by email/WhatsApp, agrees payment at handover → she records dates at `/admin/` (Cloudflare Access) in `diary` → the homepage calendar shows those dates as taken.

## Open items before launch

- Approve the draft hire terms and privacy notice (cancellation window and retention periods are bracketed; legal/proprietor identity to confirm) and remove the draft banners.
- Configure: Cloudflare Access app for `/admin/`; SMTP secrets for the NethServer; Turnstile keys; WhatsApp number in `settings` when verified.
- Apply migration 0004.
- Photograph the actual Big Green for the machine section; verify its specs.
- Confirm liability insurance and whether IoM Information Commissioner registration is required.
