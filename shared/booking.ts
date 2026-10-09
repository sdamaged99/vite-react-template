/**
 * Shared booking date and money logic, used by both the Worker and the
 * browser so the two can never disagree.
 *
 * DATE SEMANTICS (authoritative):
 * - All booking dates (`diary.start_date/end_date`, `enquiries.preferred_start`)
 *   are inclusive CALENDAR DATES in Isle of Man local time (Europe/Isle_of_Man,
 *   which tracks UK GMT/BST), stored as ISO `YYYY-MM-DD` strings.
 * - A hire "covers" `spanDaysFor(plan)` consecutive calendar days starting on
 *   the preferred start date. The span includes the return day: a weekend hire
 *   (collect Friday, return Monday morning) covers Fri, Sat, Sun AND Mon.
 * - Clock times for handover and return are agreed per booking between Amanda
 *   and the customer and are NOT modelled in the database.
 * - "Today" is always computed in Isle of Man local time, never UTC, so the
 *   site behaves correctly in the hour after midnight during British Summer
 *   Time.
 */

export const IOM_TZ = "Europe/Isle_of_Man";

const isoFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: IOM_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Current calendar date on the Isle of Man as YYYY-MM-DD. */
export function todayIoM(now: Date = new Date()): string {
  return isoFmt.format(now);
}

export const isIsoDate = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s);

/** Calendar-date arithmetic, immune to DST (anchored at UTC noon). */
export function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Days of week: 0=Sun … 5=Fri. Weekend hires must start on a Friday. */
export function isFriday(iso: string): boolean {
  return new Date(iso + "T12:00:00Z").getUTCDay() === 5;
}

const FALLBACK_DAYS: Record<string, number> = { "24h": 1, "48h": 2, "3day": 3, week: 7 };

/** Calendar days a hire occupies, INCLUDING the return day for weekend hire. */
export function spanDaysFor(code: string, durationHours?: number): number {
  if (code === "weekend") return 4; // Fri, Sat, Sun + Monday-morning return
  if (durationHours && durationHours > 0) return Math.max(1, Math.ceil(durationHours / 24));
  return FALLBACK_DAYS[code] ?? 1;
}

export function coveredDates(startIso: string, span: number): string[] {
  return Array.from({ length: span }, (_, i) => addDays(startIso, i));
}

export function lastDay(startIso: string, span: number): string {
  return addDays(startIso, span - 1);
}

export interface DateRange {
  start_date: string;
  end_date: string;
}

/** Inclusive overlap of two inclusive date ranges. ISO strings compare lexically. */
export function rangesOverlap(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return aStart <= bEnd && aEnd >= bStart;
}

export function overlapsAny(startIso: string, span: number, ranges: DateRange[]): boolean {
  const end = lastDay(startIso, span);
  return ranges.some((r) => rangesOverlap(startIso, end, r.start_date, r.end_date));
}

/* ------------------------------- transport ------------------------------- */

export type Fulfilment = "self" | "deliver_only" | "collect_only" | "both";

export const FULFILMENTS: Fulfilment[] = ["self", "deliver_only", "collect_only", "both"];

/** Charged journeys for a fulfilment choice. */
export function journeysFor(f: Fulfilment): 0 | 1 | 2 {
  switch (f) {
    case "self":
      return 0;
    case "deliver_only":
    case "collect_only":
      return 1;
    case "both":
      return 2;
  }
}

export function transportPence(
  f: Fulfilment,
  zone: { one_way_pence: number; both_pence: number } | null,
): number | null {
  const j = journeysFor(f);
  if (j === 0) return 0;
  if (!zone) return null; // area outside the configured zones: quoted individually
  return j === 1 ? zone.one_way_pence : zone.both_pence;
}

/* -------------------------------- estimate ------------------------------- */

export interface EstimateInput {
  hirePence: number;
  transportPence: number | null; // null = "quoted individually"
  extrasPence: number[];
  depositPence: number;
}

export interface Estimate {
  hirePence: number;
  transportPence: number | null;
  extrasPence: number;
  depositPence: number;
  /** Hire + extras + transport (0 when transport is quoted): the non-refundable part. */
  chargesPence: number | null;
  /** Charges + deposit: what the customer hands over on collection/delivery. */
  dueAtHandoverPence: number | null;
  /** Charges only: what the hire effectively costs once the deposit is refunded. */
  effectivePence: number | null;
  transportQuoted: boolean;
}

export function computeEstimate(i: EstimateInput): Estimate {
  const extras = i.extrasPence.reduce((a, b) => a + b, 0);
  const quoted = i.transportPence === null;
  const charges = quoted ? null : i.hirePence + extras + (i.transportPence ?? 0);
  return {
    hirePence: i.hirePence,
    transportPence: i.transportPence,
    extrasPence: extras,
    depositPence: i.depositPence,
    chargesPence: charges,
    dueAtHandoverPence: charges === null ? null : charges + i.depositPence,
    effectivePence: charges,
    transportQuoted: quoted,
  };
}
