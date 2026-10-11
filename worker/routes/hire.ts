import type { Context, Hono } from "hono";
import { todayIoM } from "../../shared/booking";
import type { AppBindings } from "../types";

/**
 * Hire lifecycle for Amanda: handover and return checklists, hire-payment
 * amounts, and an itemised deposit ledger kept separate from hire income.
 *
 * State rules (each enforced with a guarded write, so a double tap or two
 * devices at once can't record anything twice):
 *   booking ──handover──▶ out ──return──▶ back ──refund/deduct (≤ held)──▶ settled
 * - handover: bookings only; once; never after a return
 * - return: only after the handover; once
 * - hire payment: once per hire (before, at or after handover)
 * - deposit taken: once per hire (unique index), recorded at handover
 * - refunds and deductions: only after the return; never more than is held;
 *   deductions need a reason; any number of partial refunds
 */

type Ctx = Context<AppBindings>;

const MONEY_MAX = 100_000; // £1,000: sanity cap for a one-machine hire
const isPence = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MONEY_MAX;
const PAY_METHODS = ["cash", "bank"] as const;
const CHECK_KEYS = ["machine_ok", "attachment", "hose", "accessories", "detergent", "photos"] as const;

function cleanChecks(raw: unknown, note: unknown): string {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const out: Record<string, boolean | string> = {};
  for (const k of CHECK_KEYS) out[k] = o[k] === true;
  const n = typeof note === "string" ? note.trim().slice(0, 300) : "";
  if (n) out.note = n;
  return JSON.stringify(out);
}

const gbp = (p: number) => `£${(p / 100).toFixed(p % 100 === 0 ? 0 : 2)}`;

const LEDGER_SUMS = `
  COALESCE((SELECT SUM(amount_pence) FROM deposit_entries WHERE diary_id = d.id AND kind = 'taken'), 0) AS deposit_taken,
  COALESCE((SELECT SUM(amount_pence) FROM deposit_entries WHERE diary_id = d.id AND kind = 'refund'), 0) AS deposit_refunded,
  COALESCE((SELECT SUM(amount_pence) FROM deposit_entries WHERE diary_id = d.id AND kind = 'deduction'), 0) AS deposit_deducted`;

export const DIARY_COLUMNS = `d.id, d.start_date, d.end_date, d.kind, d.name, d.note, d.enquiry_id, d.returned, d.paid,
  d.deposit_status, d.handed_over_at, d.handover_check, d.returned_at, d.return_check,
  d.hire_paid_pence, d.hire_paid_method, d.hire_paid_at, ${LEDGER_SUMS},
  e.phone, e.email, e.estimate_total_pence`;

interface DiaryState {
  id: number;
  kind: string;
  handed_over_at: string | null;
  returned: number;
  paid: number;
}

async function loadState(c: Ctx, id: number): Promise<DiaryState | null> {
  return c.env.DB.prepare("SELECT id, kind, handed_over_at, returned, paid FROM diary WHERE id = ?")
    .bind(id)
    .first<DiaryState>();
}

async function held(c: Ctx, id: number): Promise<number> {
  const r = await c.env.DB.prepare(
    `SELECT COALESCE(SUM(CASE kind WHEN 'taken' THEN amount_pence ELSE -amount_pence END), 0) AS held
     FROM deposit_entries WHERE diary_id = ?`,
  ).bind(id).first<{ held: number }>();
  return r?.held ?? 0;
}

/** Keeps the older single-word deposit_status in step with the ledger. */
async function syncDepositStatus(c: Ctx, id: number) {
  await c.env.DB.prepare(
    `UPDATE diary SET deposit_status = CASE
       WHEN (SELECT COUNT(*) FROM deposit_entries WHERE diary_id = ?1 AND kind = 'taken') = 0 THEN deposit_status
       WHEN (SELECT COALESCE(SUM(CASE kind WHEN 'taken' THEN amount_pence ELSE -amount_pence END), 0)
             FROM deposit_entries WHERE diary_id = ?1) > 0 THEN 'held'
       WHEN (SELECT COUNT(*) FROM deposit_entries WHERE diary_id = ?1 AND kind = 'deduction') > 0 THEN 'deducted'
       ELSE 'refunded' END
     WHERE id = ?1`,
  ).bind(id).run();
}

/** Guarded ledger insert: refused (0 rows) if it would exceed what's held. */
async function ledgerOut(c: Ctx, id: number, kind: "refund" | "deduction", amount: number, reason: string | null) {
  const r = await c.env.DB.prepare(
    `INSERT INTO deposit_entries (diary_id, kind, amount_pence, reason, actor)
     SELECT ?1, ?2, ?3, ?4, ?5
     WHERE (SELECT COALESCE(SUM(CASE kind WHEN 'taken' THEN amount_pence ELSE -amount_pence END), 0)
            FROM deposit_entries WHERE diary_id = ?1) >= ?3`,
  ).bind(id, kind, amount, reason, c.get("adminEmail") ?? "admin").run();
  return (r.meta?.changes ?? 0) > 0;
}

async function audit(c: Ctx, action: string, id: number, detail?: string) {
  await c.env.DB.prepare("INSERT INTO audit_log (actor, action, entity, entity_id, detail) VALUES (?, ?, 'diary', ?, ?)")
    .bind(c.get("adminEmail") ?? "admin", action, id, detail ?? null)
    .run();
}

const idOf = (c: Ctx) => {
  const id = Number(c.req.param("id"));
  return Number.isInteger(id) && id > 0 ? id : null;
};

export function registerHireRoutes(r: Hono<AppBindings>) {
  /** Handover: checklist, optional hire payment and deposit taken, in one action. */
  r.post("/diary/:id/handover", async (c) => {
    const id = idOf(c);
    if (!id) return c.json({ error: "Bad id" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as {
      checks?: unknown;
      note?: unknown;
      hire_paid_pence?: unknown;
      hire_paid_method?: unknown;
      deposit_pence?: unknown;
    };
    const s = await loadState(c, id);
    if (!s) return c.json({ error: "Diary entry not found" }, 404);
    if (s.kind !== "booking") return c.json({ error: "Only bookings can be handed over." }, 409);
    if (s.handed_over_at) return c.json({ error: "Handover is already recorded for this hire." }, 409);
    if (s.returned) return c.json({ error: "This hire is already marked as returned." }, 409);

    const pay = b.hire_paid_pence ?? null;
    const dep = b.deposit_pence ?? null;
    if (pay !== null && !isPence(pay)) return c.json({ error: "Hire payment must be an amount in pence." }, 400);
    if (dep !== null && !isPence(dep)) return c.json({ error: "Deposit must be an amount in pence." }, 400);
    const method = typeof b.hire_paid_method === "string" ? b.hire_paid_method : "";
    if (pay && !(PAY_METHODS as readonly string[]).includes(method)) {
      return c.json({ error: "Say how the hire was paid: cash or bank transfer." }, 400);
    }
    if (pay && s.paid) return c.json({ error: "Hire payment is already recorded; untick it and try again." }, 409);
    if (dep && (await held(c, id)) > 0) return c.json({ error: "A deposit is already recorded for this hire." }, 409);

    const upd = await c.env.DB.prepare(
      "UPDATE diary SET handed_over_at = datetime('now'), handover_check = ? WHERE id = ? AND handed_over_at IS NULL AND returned = 0",
    ).bind(cleanChecks(b.checks, b.note), id).run();
    if ((upd.meta?.changes ?? 0) === 0) return c.json({ error: "Handover is already recorded for this hire." }, 409);

    if (pay) {
      await c.env.DB.prepare(
        "UPDATE diary SET paid = 1, hire_paid_pence = ?, hire_paid_method = ?, hire_paid_at = datetime('now') WHERE id = ? AND paid = 0",
      ).bind(pay, method, id).run();
    }
    if (dep) {
      await c.env.DB.prepare("INSERT OR IGNORE INTO deposit_entries (diary_id, kind, amount_pence, actor) VALUES (?, 'taken', ?, ?)")
        .bind(id, dep, c.get("adminEmail") ?? "admin")
        .run();
      await syncDepositStatus(c, id);
    }
    await audit(c, "hire.handover", id, [pay ? `hire ${gbp(pay)} ${method}` : "", dep ? `deposit ${gbp(dep)} taken` : ""].filter(Boolean).join("; ") || undefined);
    return c.json({ ok: true });
  });

  /** Return: checklist, optional deduction (with reason) and refund, in one action. */
  r.post("/diary/:id/return", async (c) => {
    const id = idOf(c);
    if (!id) return c.json({ error: "Bad id" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as {
      checks?: unknown;
      note?: unknown;
      deduction_pence?: unknown;
      deduction_reason?: unknown;
      refund_pence?: unknown;
    };
    const s = await loadState(c, id);
    if (!s) return c.json({ error: "Diary entry not found" }, 404);
    if (s.kind !== "booking") return c.json({ error: "Only bookings can be returned." }, 409);
    if (!s.handed_over_at) return c.json({ error: "Record the handover before the return." }, 409);
    if (s.returned) return c.json({ error: "The return is already recorded for this hire." }, 409);

    const ded = b.deduction_pence ?? 0;
    const ref = b.refund_pence ?? 0;
    if (!isPence(ded) || !isPence(ref)) return c.json({ error: "Amounts must be in pence." }, 400);
    const reason = typeof b.deduction_reason === "string" ? b.deduction_reason.trim().slice(0, 200) : "";
    if (ded > 0 && reason.length < 3) return c.json({ error: "Give a reason for the deduction." }, 400);
    const h = await held(c, id);
    if (ded + ref > h) return c.json({ error: `That's more than the ${gbp(h)} deposit held.` }, 409);

    const upd = await c.env.DB.prepare(
      "UPDATE diary SET returned = 1, returned_at = datetime('now'), return_check = ? WHERE id = ? AND returned = 0 AND handed_over_at IS NOT NULL",
    ).bind(cleanChecks(b.checks, b.note), id).run();
    if ((upd.meta?.changes ?? 0) === 0) return c.json({ error: "The return is already recorded for this hire." }, 409);

    const notes: string[] = [];
    if (ded > 0) {
      if (await ledgerOut(c, id, "deduction", ded, reason)) notes.push(`deducted ${gbp(ded)} (${reason})`);
    }
    if (ref > 0) {
      if (await ledgerOut(c, id, "refund", ref, null)) notes.push(`refunded ${gbp(ref)}`);
    }
    await syncDepositStatus(c, id);
    await audit(c, "hire.return", id, notes.join("; ") || undefined);
    return c.json({ ok: true, held_pence: await held(c, id) });
  });

  /** Hire payment taken outside the handover (e.g. bank transfer beforehand). */
  r.post("/diary/:id/payment", async (c) => {
    const id = idOf(c);
    if (!id) return c.json({ error: "Bad id" }, 400);
    const b = (await c.req.json().catch(() => ({}))) as { amount_pence?: unknown; method?: unknown };
    const s = await loadState(c, id);
    if (!s) return c.json({ error: "Diary entry not found" }, 404);
    if (s.kind !== "booking") return c.json({ error: "Only bookings take payment." }, 409);
    if (!isPence(b.amount_pence) || b.amount_pence === 0) return c.json({ error: "Enter the amount received." }, 400);
    const method = typeof b.method === "string" ? b.method : "";
    if (!(PAY_METHODS as readonly string[]).includes(method)) return c.json({ error: "Say how it was paid: cash or bank transfer." }, 400);
    const upd = await c.env.DB.prepare(
      "UPDATE diary SET paid = 1, hire_paid_pence = ?, hire_paid_method = ?, hire_paid_at = datetime('now') WHERE id = ? AND paid = 0",
    ).bind(b.amount_pence, method, id).run();
    if ((upd.meta?.changes ?? 0) === 0) return c.json({ error: "Hire payment is already recorded for this hire." }, 409);
    await audit(c, "hire.payment", id, `${gbp(b.amount_pence)} ${method}`);
    return c.json({ ok: true });
  });

  /** Later refunds or deductions (partial or remaining), after the return. */
  for (const kind of ["refund", "deduction"] as const) {
    r.post(`/diary/:id/deposit/${kind}`, async (c) => {
      const id = idOf(c);
      if (!id) return c.json({ error: "Bad id" }, 400);
      const b = (await c.req.json().catch(() => ({}))) as { amount_pence?: unknown; reason?: unknown };
      const s = await loadState(c, id);
      if (!s) return c.json({ error: "Diary entry not found" }, 404);
      if (!s.returned) return c.json({ error: "Record the return before refunding or deducting the deposit." }, 409);
      if (!isPence(b.amount_pence) || b.amount_pence === 0) return c.json({ error: "Enter an amount." }, 400);
      const reason = typeof b.reason === "string" ? b.reason.trim().slice(0, 200) : "";
      if (kind === "deduction" && reason.length < 3) return c.json({ error: "Give a reason for the deduction." }, 400);
      if (!(await ledgerOut(c, id, kind, b.amount_pence, kind === "deduction" ? reason : null))) {
        return c.json({ error: `That's more than the ${gbp(await held(c, id))} deposit held.` }, 409);
      }
      await syncDepositStatus(c, id);
      await audit(c, `deposit.${kind}`, id, `${gbp(b.amount_pence)}${reason ? ` (${reason})` : ""}`);
      return c.json({ ok: true, held_pence: await held(c, id) });
    });
  }

  /** Deposit ledger for one hire, oldest first. */
  r.get("/diary/:id/deposit", async (c) => {
    const id = idOf(c);
    if (!id) return c.json({ error: "Bad id" }, 400);
    const { results } = await c.env.DB.prepare(
      "SELECT kind, amount_pence, reason, actor, created_at FROM deposit_entries WHERE diary_id = ? ORDER BY id",
    ).bind(id).all();
    return c.json({ entries: results });
  });

  /** Today: what goes out, what comes back, open enquiries, deposits to settle. */
  r.get("/today", async (c) => {
    const today = todayIoM();
    const dep = await c.env.DB.prepare("SELECT value FROM settings WHERE key = 'deposit_pence'").first<{ value: string }>();
    const deposit = Number(dep?.value ?? 0);
    const [out, back, enq, deposits] = await c.env.DB.batch([
      c.env.DB.prepare(
        `SELECT ${DIARY_COLUMNS} FROM diary d LEFT JOIN enquiries e ON e.id = d.enquiry_id
         WHERE d.kind = 'booking' AND d.handed_over_at IS NULL AND d.returned = 0 AND d.start_date <= ?
         ORDER BY d.start_date`,
      ).bind(today),
      c.env.DB.prepare(
        `SELECT ${DIARY_COLUMNS} FROM diary d LEFT JOIN enquiries e ON e.id = d.enquiry_id
         WHERE d.kind = 'booking' AND d.handed_over_at IS NOT NULL AND d.returned = 0 AND d.end_date <= ?
         ORDER BY d.end_date`,
      ).bind(today),
      c.env.DB.prepare(
        `SELECT id, name, preferred_start, rate_plan_code, status, created_at FROM enquiries
         WHERE status IN ('new', 'replied') ORDER BY created_at`,
      ),
      c.env.DB.prepare(
        `SELECT * FROM (SELECT ${DIARY_COLUMNS} FROM diary d LEFT JOIN enquiries e ON e.id = d.enquiry_id
           WHERE d.kind = 'booking' AND d.returned = 1)
         WHERE deposit_taken - deposit_refunded - deposit_deducted > 0
            OR (deposit_taken = 0 AND deposit_status = 'held' AND handed_over_at IS NULL)
         ORDER BY end_date`,
      ),
    ]);
    return c.json({
      today,
      deposit_default_pence: deposit,
      going_out: out!.results,
      due_back: back!.results,
      enquiries: enq!.results,
      deposits_to_settle: deposits!.results,
    });
  });
}
