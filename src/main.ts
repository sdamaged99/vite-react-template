import "./styles/main.css";
import {
  addDays as sharedAddDays,
  computeEstimate,
  coveredDates,
  isFriday as sharedIsFriday,
  journeysFor,
  spanDaysFor,
  todayIoM,
  transportPence,
  type Fulfilment,
} from "../shared/booking";

// Set when Turnstile is configured in the Cloudflare dashboard; the Worker
// skips verification while its secret is unset, so both sides stay in step.
const TURNSTILE_SITE_KEY = "";

/* ---------------------------------------------------------------- nav ----- */
const toggle = document.getElementById("nav-toggle");
const menu = document.getElementById("mobile-nav");
if (toggle && menu) {
  toggle.addEventListener("click", () => {
    const open = menu.hidden;
    menu.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  });
  menu.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest("a")) {
      menu.hidden = true;
      toggle.setAttribute("aria-expanded", "false");
    }
  });
}

/* ------------------------------------------------------------- shared ----- */
const gbp = (pence: number) =>
  new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    minimumFractionDigits: pence % 100 === 0 ? 0 : 2,
  }).format(pence / 100);

interface Rate {
  code: string;
  label: string;
  duration_hours: number;
  price_pence: number;
}
interface Zone {
  name: string;
  areas: string;
  one_way_pence: number;
  both_pence: number;
}
interface PricingPayload {
  rates: Rate[];
  addons: { code: string; price_pence: number }[];
  delivery_zones: Zone[];
  settings: Record<string, string>;
}

let pricing: PricingPayload | null = null;
let busy: { start_date: string; end_date: string }[] = [];
let dateClash = false;
const isBusy = (iso: string) => busy.some((r) => iso >= r.start_date && iso <= r.end_date);
const todayIso = () => todayIoM();

function spanDays(code: string): number {
  const rate = pricing?.rates.find((r) => r.code === code);
  return spanDaysFor(code, rate?.duration_hours);
}
const addDays = sharedAddDays;
const covered = (start: string, code: string) => coveredDates(start, spanDays(code));
const isFriday = sharedIsFriday;
const fmtDay = (iso: string) =>
  new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

/* --------------------------------------------------------- form wiring ---- */
const form = document.getElementById("enquiry-form") as HTMLFormElement | null;
const startInput = document.getElementById("enq-start") as HTMLInputElement | null;
const planSelect = document.getElementById("enq-plan") as HTMLSelectElement | null;
const fulfilSelect = document.getElementById("enq-fulfilment") as HTMLSelectElement | null;
const areaSelect = document.getElementById("enq-area") as HTMLSelectElement | null;
const spanNote = document.getElementById("enq-span");
if (startInput) startInput.min = todayIso();

function updateEstimate() {
  const box = document.getElementById("estimate");
  if (!box || !planSelect) return;
  const rate = pricing?.rates.find((r) => r.code === planSelect.value);
  const deposit = Number(pricing?.settings["deposit_pence"] ?? NaN);
  if (!rate || Number.isNaN(deposit)) {
    box.hidden = true;
    return;
  }
  const f = (fulfilSelect?.value ?? "self") as Fulfilment;
  const journeys = journeysFor(f);
  const otherChosen = areaSelect?.value === "__other";
  const zone =
    journeys > 0 && !otherChosen ? (pricing?.delivery_zones.find((z) => z.areas === areaSelect?.value) ?? null) : null;
  const transport = journeys === 0 ? 0 : otherChosen ? null : transportPence(f, zone);
  const extrasPence = Array.from(
    document.querySelectorAll<HTMLInputElement>('#enquiry-form input[name="extras"]:checked'),
  ).map((el) => pricing?.addons.find((a) => a.code === el.value)?.price_pence ?? 0);
  const est = computeEstimate({ hirePence: rate.price_pence, transportPence: transport, extrasPence, depositPence: deposit });

  const set = (id: string, text: string) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  set("est-hire-label", rate.label);
  set("est-hire", gbp(est.hirePence));
  const extrasRow = document.getElementById("est-extras-row");
  if (extrasRow) extrasRow.hidden = est.extrasPence === 0;
  set("est-extras", gbp(est.extrasPence));
  const transportRow = document.getElementById("est-transport-row");
  if (transportRow) transportRow.hidden = journeys === 0;
  set(
    "est-transport-label",
    f === "deliver_only" ? "Delivery (one journey)" : f === "collect_only" ? "Collection (one journey)" : "Delivery & collection (both journeys)",
  );
  set("est-transport", est.transportQuoted ? "Quoted individually" : gbp(est.transportPence ?? 0));
  set("est-deposit", gbp(est.depositPence));
  set("est-due", est.dueAtHandoverPence === null ? "Confirmed with your quote" : gbp(est.dueAtHandoverPence));
  set("est-eff", est.effectivePence === null ? "Confirmed with your quote" : gbp(est.effectivePence));
  box.hidden = false;
}

function updateSpanNote() {
  if (!spanNote || !planSelect) return;
  const start = startInput?.value ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) {
    spanNote.textContent = planSelect.value === "weekend" ? "Weekend hires run Friday to Monday morning." : "";
    return;
  }
  const days = covered(start, planSelect.value);
  const clash = days.some(isBusy);
  let text =
    days.length === 1 ? `Covers ${fmtDay(days[0]!)}.` : `Covers ${fmtDay(days[0]!)} to ${fmtDay(days[days.length - 1]!)}.`;
  if (planSelect.value === "weekend") text += " Collect Friday, return Monday morning.";
  spanNote.textContent = text;
  dateClash = clash;
  const conflictEl = document.getElementById("est-conflict");
  if (conflictEl) conflictEl.hidden = !clash;
  const submit = document.querySelector<HTMLButtonElement>("#enquiry-form button[type=submit]");
  if (submit) submit.disabled = clash;
}

function repaintCalendar() {
  const plan = planSelect?.value ?? "48h";
  const start = startInput?.value ?? "";
  const range = /^\d{4}-\d{2}-\d{2}$/.test(start) ? covered(start, plan) : [];
  for (const btn of document.querySelectorAll<HTMLButtonElement>("button.cal-day")) {
    const iso = btn.dataset.iso ?? "";
    btn.classList.remove("cal-sel", "cal-conflict", "cal-nostart");
    const free = !isBusy(iso) && iso >= todayIso();
    if (free && plan === "weekend" && !isFriday(iso)) {
      btn.classList.add("cal-nostart");
      btn.disabled = true;
    } else if (free) {
      btn.disabled = false;
    }
    if (range.includes(iso)) btn.classList.add(isBusy(iso) ? "cal-conflict" : "cal-sel");
  }
  updateSpanNote();
  updateEstimate();
}

function onDayClick(iso: string) {
  if (!startInput) return;
  startInput.value = iso;
  repaintCalendar();
}

async function renderCalendar() {
  const mount = document.getElementById("availability-cal");
  if (!mount) return;
  try {
    const res = await fetch("/api/unavailable");
    if (res.ok) busy = ((await res.json()) as { unavailable: typeof busy }).unavailable;
    else return;
  } catch {
    return; // leave the explanatory text in place
  }
  const today = new Date();
  const months: HTMLElement[] = [];
  for (let m = 0; m < 2; m++) {
    const first = new Date(today.getFullYear(), today.getMonth() + m, 1);
    const wrap = document.createElement("div");
    wrap.className = "cal-month";
    const title = document.createElement("div");
    title.className = "cal-title";
    title.textContent = first.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
    const grid = document.createElement("div");
    grid.className = "cal-grid";
    for (const d of ["M", "T", "W", "T", "F", "S", "S"]) {
      const h = document.createElement("span");
      h.className = "cal-dow";
      h.textContent = d;
      grid.append(h);
    }
    const lead = (first.getDay() + 6) % 7; // Monday first
    for (let i = 0; i < lead; i++) grid.append(document.createElement("span"));
    const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    for (let d = 1; d <= days; d++) {
      const iso = `${first.getFullYear()}-${String(first.getMonth() + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const past = iso < todayIso();
      const taken = isBusy(iso);
      const cell = document.createElement("button");
      cell.type = "button";
      cell.textContent = String(d);
      cell.dataset.iso = iso;
      cell.className = "cal-day " + (past ? "cal-past" : taken ? "cal-busy" : "cal-free");
      cell.disabled = past || taken;
      if (!past && !taken) {
        cell.setAttribute("aria-label", `Start enquiry on ${fmtDay(iso)}`);
        cell.addEventListener("click", () => onDayClick(iso));
      }
      grid.append(cell);
    }
    wrap.append(title, grid);
    months.push(wrap);
  }
  mount.replaceChildren(...months);
  const legend = document.getElementById("cal-legend");
  if (legend) legend.hidden = false;
  repaintCalendar();
}

/* ------------------------------------------------------- live pricing ----- */
async function hydrate() {
  try {
    const res = await fetch("/api/pricing");
    if (!res.ok) return;
    pricing = (await res.json()) as PricingPayload;

    for (const el of document.querySelectorAll<HTMLElement>("[data-price-plan]")) {
      const rate = pricing.rates.find((r) => r.code === el.dataset.pricePlan);
      if (rate) el.textContent = gbp(rate.price_pence);
    }
    for (const el of document.querySelectorAll<HTMLElement>("[data-price-addon]")) {
      const addon = pricing.addons.find((a) => a.code === el.dataset.priceAddon);
      if (addon) el.textContent = gbp(addon.price_pence);
    }
    for (const el of document.querySelectorAll<HTMLElement>("[data-price-setting]")) {
      const value = pricing.settings[el.dataset.priceSetting ?? ""];
      if (value !== undefined) el.textContent = gbp(Number(value));
    }

    const zoneBody = document.getElementById("zone-rows");
    if (zoneBody && pricing.delivery_zones.length > 0) {
      zoneBody.replaceChildren(
        ...pricing.delivery_zones.map((z) => {
          const tr = document.createElement("tr");
          const name = document.createElement("td");
          name.textContent = z.areas;
          const one = document.createElement("td");
          one.textContent = gbp(z.one_way_pence);
          const both = document.createElement("td");
          both.textContent = gbp(z.both_pence);
          tr.append(name, one, both);
          return tr;
        }),
      );
    }

    if (planSelect && pricing.rates.length > 0) {
      const current = planSelect.value;
      planSelect.replaceChildren(
        ...pricing.rates.map((r) => {
          const o = document.createElement("option");
          o.value = r.code;
          o.textContent = `${r.label} — ${gbp(r.price_pence)}`;
          return o;
        }),
      );
      planSelect.value = pricing.rates.some((r) => r.code === current) ? current : "48h";
    }
    if (areaSelect && pricing.delivery_zones.length > 0) {
      areaSelect.replaceChildren(
        ...pricing.delivery_zones.map((z) => {
          const o = document.createElement("option");
          o.value = z.areas;
          o.textContent = `${z.areas} — ${gbp(z.both_pence)} both ways`;
          return o;
        }),
      );
    }

    const wa = (pricing.settings["whatsapp_number"] ?? "").replace(/\D/g, "");
    if (wa) {
      for (const el of document.querySelectorAll<HTMLAnchorElement>("[data-whatsapp]")) {
        el.href = `https://wa.me/${wa}`;
        el.hidden = false;
      }
    }
    repaintCalendar();
  } catch {
    /* static fallbacks remain */
  }
}

/* -------------------------------------------------------- enquiry form ---- */
if (form) {
  const deliveryFields = document.getElementById("enq-delivery-fields");
  const otherWrap = document.getElementById("enq-other-wrap");
  const syncDelivery = () => {
    const f = (fulfilSelect?.value ?? "self") as Fulfilment;
    if (deliveryFields) deliveryFields.hidden = journeysFor(f) === 0;
    if (otherWrap) otherWrap.hidden = areaSelect?.value !== "__other";
    updateEstimate();
  };
  fulfilSelect?.addEventListener("change", syncDelivery);
  areaSelect?.addEventListener("change", syncDelivery);
  for (const cb of document.querySelectorAll('#enquiry-form input[name="extras"]')) {
    cb.addEventListener("change", updateEstimate);
  }
  planSelect?.addEventListener("change", repaintCalendar);
  startInput?.addEventListener("change", repaintCalendar);
  syncDelivery();

  let turnstileToken = "";
  if (TURNSTILE_SITE_KEY) {
    const slot = document.getElementById("turnstile-slot");
    if (slot) {
      (window as unknown as Record<string, unknown>)["onTurnstile"] = () => {
        (window as unknown as { turnstile: { render: (el: Element, o: object) => void } }).turnstile.render(slot, {
          sitekey: TURNSTILE_SITE_KEY,
          callback: (t: string) => (turnstileToken = t),
        });
      };
      const s = document.createElement("script");
      s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstile&render=explicit";
      s.async = true;
      document.head.append(s);
    }
  }

  const result = document.getElementById("enquiry-result");
  const submitBtn = form.querySelector("button[type=submit]") as HTMLButtonElement | null;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!result) return;
    if (dateClash) {
      result.textContent = "Those dates are unavailable; please pick different dates on the calendar.";
      result.className = "enq-err";
      result.hidden = false;
      return;
    }
    result.hidden = true;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Sending…";
    }
    const fd = new FormData(form);
    const otherInput = document.getElementById("enq-other") as HTMLInputElement | null;
    const rawArea = String(fd.get("area") ?? "");
    const payload = {
      name: fd.get("name"),
      email: fd.get("email"),
      phone: fd.get("phone"),
      preferred_start: fd.get("preferred_start"),
      rate_plan_code: fd.get("rate_plan_code"),
      fulfilment: fd.get("fulfilment"),
      area: rawArea === "__other" ? (otherInput?.value ?? "").trim() : rawArea,
      address: fd.get("address"),
      extras: fd.getAll("extras"),
      message: fd.get("message"),
      website: fd.get("website"),
      turnstile_token: turnstileToken,
    };
    try {
      const res = await fetch("/api/enquiry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as { ok?: boolean; emailed?: boolean; error?: string };
      if (res.ok && data.ok) {
        form.hidden = true;
        result.textContent =
          data.emailed === false
            ? "Your enquiry has been saved, but our email notification failed, so we may not see it straight away. If you haven't heard from us within two days, please email bookings@sparklecarpets.im directly, quoting your name and dates."
            : "Thanks — your enquiry is on its way. We'll check availability and reply personally, as soon as we can. Nothing is booked or paid until we've confirmed with you.";
        result.className = data.emailed === false ? "enq-err" : "enq-ok";
      } else {
        result.textContent =
          data.error ?? "Something went wrong sending that; please email bookings@sparklecarpets.im instead.";
        result.className = "enq-err";
      }
    } catch {
      result.textContent = "We couldn't send that just now; please email bookings@sparklecarpets.im instead.";
      result.className = "enq-err";
    }
    result.hidden = false;
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Send enquiry";
    }
  });
}

hydrate();
renderCalendar();
