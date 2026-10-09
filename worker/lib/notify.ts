import { sendMail, type SmtpConfig } from "./smtp";
import type { Env } from "../types";

/** Everything the enquiry emails need; built once at submission and rebuilt
 *  from the stored row for the admin "retry email" action. */
export interface EnquiryEmailData {
  id: number;
  name: string;
  email: string;
  phone: string;
  preferred_start: string;
  span_end: string;
  plan_label: string;
  fulfilment: string; // self | deliver_only | collect_only | both
  area: string | null;
  address: string | null;
  extras: { label: string; price_pence: number }[];
  transport_pence: number | null; // null = quoted individually
  deposit_pence: number;
  due_pence: number | null; // total due at handover incl deposit; null when quoted
  message: string | null;
}

const gbp = (p: number) => `£${(p / 100).toFixed(p % 100 === 0 ? 0 : 2)}`;

export const FULFILMENT_LABELS: Record<string, string> = {
  self: "Customer collects and returns (free)",
  deliver_only: "Delivery only — customer returns it (one journey)",
  collect_only: "Collection only — customer picks it up (one journey)",
  both: "Delivery and collection (both journeys)",
};

export function smtpConfigured(env: Env): boolean {
  return Boolean(env.SMTP_HOST && env.SMTP_PORT && env.SMTP_USER && env.SMTP_PASS && env.MAIL_FROM && env.MAIL_TO);
}

function cfg(env: Env): SmtpConfig {
  return { host: env.SMTP_HOST!, port: Number(env.SMTP_PORT), user: env.SMTP_USER!, pass: env.SMTP_PASS! };
}

export function notificationText(d: EnquiryEmailData): string {
  const lines = [
    `New hire enquiry (ref ${d.id})`,
    "",
    `Name:    ${d.name}`,
    `Phone:   ${d.phone}`,
    `Email:   ${d.email}`,
    `Dates:   ${d.preferred_start} to ${d.span_end} (inclusive)`,
    `Hire:    ${d.plan_label}`,
    `Fulfil:  ${FULFILMENT_LABELS[d.fulfilment] ?? d.fulfilment}`,
    d.area ? `Area:    ${d.area}` : "",
    d.address ? `Address: ${d.address}` : "",
    "",
    "Estimate shown to the customer:",
    ...d.extras.map((x) => `  Extra: ${x.label} — ${gbp(x.price_pence)}`),
    `  Transport: ${d.transport_pence === null ? "to be quoted" : gbp(d.transport_pence)}`,
    `  Refundable deposit: ${gbp(d.deposit_pence)}`,
    `  Total due at handover: ${d.due_pence === null ? "to be quoted" : gbp(d.due_pence)}`,
    "",
    d.message ? `Message: ${d.message}` : "",
    "",
    "This is a PENDING enquiry. Confirm or decline it from the admin page;",
    "reply to this email to respond to the customer.",
  ].filter((l) => l !== "");
  return lines.join("\n");
}

/** Send Amanda's notification, then a best-effort customer acknowledgement.
 *  Returns {emailed:true} only when the notification was accepted. */
export async function sendEnquiryEmails(env: Env, d: EnquiryEmailData): Promise<{ emailed: boolean; error?: string }> {
  if (!smtpConfigured(env)) return { emailed: false, error: "SMTP not configured" };
  const conf = cfg(env);
  try {
    await sendMail(conf, {
      from: env.MAIL_FROM!,
      to: [env.MAIL_TO!],
      replyTo: `${d.name} <${d.email}>`,
      subject: `Hire enquiry: ${d.plan_label} from ${d.preferred_start} (${d.name})`,
      text: notificationText(d),
    });
  } catch (err) {
    return { emailed: false, error: String(err).slice(0, 500) };
  }
  await sendMail(conf, {
    from: env.MAIL_FROM!,
    to: [`${d.name} <${d.email}>`],
    replyTo: env.MAIL_TO!,
    subject: "We've received your enquiry — Sparkle Carpets",
    text:
      `Hi ${d.name},\n\nThanks for your enquiry about hiring our BISSELL Big Green ` +
      `(${d.plan_label}, preferred dates ${d.preferred_start} to ${d.span_end}).\n\n` +
      `This is NOT a confirmed booking yet. We'll check availability and reply personally ` +
      `as soon as we can to agree the details; payment is arranged directly with Amanda, normally at handover, and nothing is paid online.\n\n` +
      `Sparkle Carpets, Isle of Man\nbookings@sparklecarpets.im`,
  }).catch(() => {
    /* acknowledgement is best-effort */
  });
  return { emailed: true };
}

/** Booking-confirmed email, sent only AFTER the diary entry is saved. */
export async function sendConfirmationEmail(
  env: Env,
  d: { name: string; email: string; plan_label: string; start: string; end: string },
): Promise<{ emailed: boolean; error?: string }> {
  if (!smtpConfigured(env)) return { emailed: false, error: "SMTP not configured" };
  try {
    await sendMail(cfg(env), {
      from: env.MAIL_FROM!,
      to: [`${d.name} <${d.email}>`],
      replyTo: env.MAIL_TO!,
      subject: `Your Sparkle Carpets booking is confirmed — ${d.start}`,
      text:
        `Hi ${d.name},\n\nGood news: your ${d.plan_label} is confirmed for ${d.start} to ${d.end} (inclusive).\n\n` +
        `We'll be in touch to agree exact handover times. Payment is arranged directly with Amanda, normally at handover, along with the refundable deposit.\n` +
        `If anything changes, just reply to this email.\n\nSparkle Carpets, Isle of Man\nbookings@sparklecarpets.im`,
    });
    return { emailed: true };
  } catch (err) {
    return { emailed: false, error: String(err).slice(0, 500) };
  }
}
