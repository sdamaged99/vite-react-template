import { addDays, todayIoM } from "../../shared/booking";
import { cfg, smtpConfigured } from "./notify";
import { sendMail } from "./smtp";
import type { Env } from "../types";

/**
 * PREPARED, NOT ACTIVE. Daily reminder emails, run by a Cloudflare Cron
 * Trigger (free). Two switches must both be on before anything is sent:
 *   1. a "triggers": { "crons": [...] } entry in wrangler.jsonc (none yet), and
 *   2. settings.reminders_enabled = '1' in D1 (seeded '0').
 * With either off, nothing runs or nothing is sent.
 *
 * What it sends, once per hire:
 * - the customer, the day before collection/delivery (confirmed bookings
 *   with an email on file that haven't been handed over);
 * - the customer, the day before the return is due (handed over, not back);
 * - Amanda, a short summary when anything goes out or comes back today.
 * Each send is claimed in D1 first, so a retried run can't send twice; a
 * failed send releases the claim and is logged to the audit trail.
 */

const fmt = (iso: string) =>
  new Date(iso + "T12:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });

interface Row {
  id: number;
  name: string | null;
  email: string | null;
  start_date: string;
  end_date: string;
}

export interface ReminderRun {
  enabled: boolean;
  sent: string[];
  failed: string[];
}

async function claimAndSend(env: Env, row: Row, column: "reminder_handover_sent_at" | "reminder_return_sent_at", subject: string, text: string, out: ReminderRun) {
  const claim = await env.DB.prepare(`UPDATE diary SET ${column} = datetime('now') WHERE id = ? AND ${column} IS NULL`).bind(row.id).run();
  if ((claim.meta?.changes ?? 0) === 0) return; // already sent by an earlier run
  try {
    await sendMail(cfg(env), {
      from: env.MAIL_FROM!,
      to: [`${row.name ?? ""} <${row.email}>`],
      replyTo: env.MAIL_TO!,
      subject,
      text,
    });
    out.sent.push(`${column}:${row.id}`);
    await env.DB.prepare("INSERT INTO audit_log (actor, action, entity, entity_id) VALUES ('scheduler', ?, 'diary', ?)")
      .bind(`reminder.${column === "reminder_handover_sent_at" ? "handover" : "return"}`, row.id)
      .run();
  } catch (err) {
    await env.DB.prepare(`UPDATE diary SET ${column} = NULL WHERE id = ?`).bind(row.id).run();
    out.failed.push(`${column}:${row.id}`);
    await env.DB.prepare("INSERT INTO audit_log (actor, action, entity, entity_id, detail) VALUES ('scheduler', 'reminder.failed', 'diary', ?, ?)")
      .bind(row.id, String(err).slice(0, 300))
      .run();
  }
}

export async function runReminders(env: Env, now: Date = new Date()): Promise<ReminderRun> {
  const out: ReminderRun = { enabled: false, sent: [], failed: [] };
  const flag = await env.DB.prepare("SELECT value FROM settings WHERE key = 'reminders_enabled'").first<{ value: string }>();
  if (flag?.value !== "1" || !smtpConfigured(env)) return out;
  out.enabled = true;
  const today = todayIoM(now);
  const tomorrow = addDays(today, 1);

  const starting = await env.DB.prepare(
    `SELECT d.id, d.name, e.email, d.start_date, d.end_date FROM diary d JOIN enquiries e ON e.id = d.enquiry_id
     WHERE d.kind = 'booking' AND d.start_date = ? AND d.handed_over_at IS NULL AND d.returned = 0
       AND d.reminder_handover_sent_at IS NULL AND e.email IS NOT NULL`,
  ).bind(tomorrow).all<Row>();
  for (const r of starting.results) {
    await claimAndSend(env, r, "reminder_handover_sent_at", `Reminder: your carpet cleaner hire starts tomorrow`,
      `Hi ${r.name ?? "there"},\n\nA quick reminder that your Sparkle Carpets hire starts tomorrow, ${fmt(r.start_date)}, ` +
      `with the return due ${fmt(r.end_date)}. Handover is at the time we agreed with you.\n\n` +
      `The machine guide is at https://sparklecarpets.im/instructions/ if you'd like a look beforehand.\n` +
      `If anything has changed, just reply to this email.\n\nSparkle Carpets, Isle of Man\nbookings@sparklecarpets.im`, out);
  }

  const ending = await env.DB.prepare(
    `SELECT d.id, d.name, e.email, d.start_date, d.end_date FROM diary d JOIN enquiries e ON e.id = d.enquiry_id
     WHERE d.kind = 'booking' AND d.end_date = ? AND d.handed_over_at IS NOT NULL AND d.returned = 0
       AND d.reminder_return_sent_at IS NULL AND e.email IS NOT NULL`,
  ).bind(tomorrow).all<Row>();
  for (const r of ending.results) {
    await claimAndSend(env, r, "reminder_return_sent_at", `Reminder: your carpet cleaner is due back tomorrow`,
      `Hi ${r.name ?? "there"},\n\nA quick reminder that the carpet cleaner is due back tomorrow, ${fmt(r.end_date)}, ` +
      `at the time we agreed with you.\n\nBefore returning it, please empty and rinse both tanks and gather everything ` +
      `that came with it, including the stair and upholstery attachment. If you need longer, reply to this email ` +
      `and we'll check availability.\n\nSparkle Carpets, Isle of Man\nbookings@sparklecarpets.im`, out);
  }

  // Amanda's summary for today (only when there is something to do).
  const todayRows = await env.DB.prepare(
    `SELECT name, start_date, end_date, handed_over_at IS NOT NULL AS out_now FROM diary
     WHERE kind = 'booking' AND returned = 0 AND (start_date = ?1 AND handed_over_at IS NULL OR end_date = ?1 AND handed_over_at IS NOT NULL)`,
  ).bind(today).all<{ name: string | null; start_date: string; end_date: string; out_now: number }>();
  if (todayRows.results.length > 0) {
    const lines = todayRows.results.map((r) => `- ${r.out_now ? "Due back" : "Going out"}: ${r.name ?? "Booking"} (${r.start_date} to ${r.end_date})`);
    try {
      await sendMail(cfg(env), {
        from: env.MAIL_FROM!,
        to: [env.MAIL_TO!],
        subject: `Today: ${todayRows.results.length} hire${todayRows.results.length === 1 ? "" : "s"} to handle`,
        text: `${lines.join("\n")}\n\nOpen the admin page to record handovers and returns.`,
      });
      out.sent.push("summary");
    } catch {
      out.failed.push("summary");
    }
  }
  return out;
}
