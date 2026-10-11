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
  addons: { code: string; label: string; price_pence: number }[];
  delivery_zones: Zone[];
  settings: Record<string, string>;
}

let pricing: PricingPayload | null = null;
let busy: { start_date: string; end_date: string }[] = [];
let dateClash = false;
let weekendNotFriday = false;
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
const estimateBox = document.getElementById("estimate") as HTMLDetailsElement | null;
if (startInput) startInput.min = todayIso();

const setText = (id: string, text: string) => {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
};

function updateEstimate() {
  if (!estimateBox || !planSelect) return;
  const rate = pricing?.rates.find((r) => r.code === planSelect.value);
  const deposit = Number(pricing?.settings["deposit_pence"] ?? NaN);
  if (!rate || Number.isNaN(deposit)) {
    estimateBox.hidden = true;
    return;
  }
  const f = (fulfilSelect?.value ?? "self") as Fulfilment;
  const journeys = journeysFor(f);
  const otherChosen = areaSelect?.value === "__other";
  const zone =
    journeys > 0 && !otherChosen ? (pricing?.delivery_zones.find((z) => z.areas === areaSelect?.value) ?? null) : null;
  const transport = journeys === 0 ? 0 : otherChosen ? null : transportPence(f, zone);
  const chosenExtras = Array.from(
    document.querySelectorAll<HTMLInputElement>('#enquiry-form input[name="extras"]:checked'),
  )
    .map((el) => pricing?.addons.find((a) => a.code === el.value))
    .filter((a): a is PricingPayload["addons"][number] => !!a);
  const extrasPence = chosenExtras.map((a) => a.price_pence);
  const est = computeEstimate({ hirePence: rate.price_pence, transportPence: transport, extrasPence, depositPence: deposit });

  setText("est-hire-label", rate.label);
  setText("est-hire", gbp(est.hirePence));
  const extrasBox = document.getElementById("est-extras");
  if (extrasBox) {
    extrasBox.replaceChildren(
      ...chosenExtras.map((a) => {
        const row = document.createElement("div");
        row.className = "flex items-baseline gap-3";
        const label = document.createElement("span");
        label.textContent = a.label;
        const leader = document.createElement("span");
        leader.className = "menu-leader";
        const value = document.createElement("span");
        value.className = "shrink-0 text-right font-semibold tabular-nums";
        value.textContent = gbp(a.price_pence);
        row.append(label, leader, value);
        return row;
      }),
    );
  }
  const transportRow = document.getElementById("est-transport-row");
  if (transportRow) transportRow.hidden = journeys === 0;
  setText(
    "est-transport-label",
    f === "deliver_only" ? "Delivery (one journey)" : f === "collect_only" ? "Collection (one journey)" : "Delivery & collection (both journeys)",
  );
  setText("est-transport", est.transportQuoted ? "To be quoted" : gbp(est.transportPence ?? 0));
  setText("est-deposit", gbp(est.depositPence));
  const due = est.dueAtHandoverPence === null ? "To be quoted" : gbp(est.dueAtHandoverPence);
  setText("est-due", due);
  setText("est-summary-total", due);
  setText("est-eff", est.effectivePence === null ? "To be quoted" : gbp(est.effectivePence));
  const start = startInput?.value ?? "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(start)) {
    const days = covered(start, planSelect.value);
    setText("est-dates", days.length === 1 ? fmtDay(days[0]!) : `${fmtDay(days[0]!)} to ${fmtDay(days[days.length - 1]!)}`);
  } else {
    setText("est-dates", "");
  }
  estimateBox.hidden = false;
}

// Desktop shows the estimate open beside the steps; smaller screens get a
// compact bar the customer can expand.
const desktop = window.matchMedia("(min-width: 1024px)");
function syncEstimateOpen() {
  if (estimateBox) estimateBox.open = desktop.matches;
}
desktop.addEventListener("change", syncEstimateOpen);
syncEstimateOpen();
estimateBox?.querySelector("summary")?.addEventListener("click", (e) => {
  if (desktop.matches) e.preventDefault();
});

function updateSpanNote() {
  if (!spanNote || !planSelect) return;
  const start = startInput?.value ?? "";
  dateClash = false;
  weekendNotFriday = false;
  const conflictEl = document.getElementById("est-conflict");
  if (conflictEl) conflictEl.hidden = true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) {
    spanNote.textContent = planSelect.value === "weekend" ? "Weekend hires run Friday to Monday morning." : "";
    return;
  }
  if (planSelect.value === "weekend" && !isFriday(start)) {
    weekendNotFriday = true;
    spanNote.textContent = "Weekend hire starts on a Friday. Please pick a Friday, or choose another hire length.";
    return;
  }
  const days = covered(start, planSelect.value);
  const clash = days.some(isBusy);
  let text =
    days.length === 1 ? `Covers ${fmtDay(days[0]!)}.` : `Covers ${fmtDay(days[0]!)} to ${fmtDay(days[days.length - 1]!)}.`;
  if (planSelect.value === "weekend") text += " Collect Friday, return Monday morning.";
  spanNote.textContent = text;
  dateClash = clash;
  if (conflictEl) conflictEl.hidden = !clash;
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
    const inRange = range.includes(iso);
    if (inRange) btn.classList.add(isBusy(iso) ? "cal-conflict" : "cal-sel");
    btn.setAttribute("aria-pressed", String(inRange && !isBusy(iso)));
  }
  updateSpanNote();
  updateEstimate();
}

function onDayClick(iso: string) {
  if (!startInput) return;
  startInput.value = iso;
  clearStepError(1);
  repaintCalendar();
}

let activeMonth = 0;
function showMonth(i: number) {
  const months = Array.from(document.querySelectorAll<HTMLElement>("#availability-cal .cal-month"));
  if (months.length === 0) return;
  activeMonth = Math.max(0, Math.min(months.length - 1, i));
  months.forEach((m, k) => {
    if (k === activeMonth) m.setAttribute("data-active", "");
    else m.removeAttribute("data-active");
    const prev = m.querySelector<HTMLButtonElement>("[data-cal-prev]");
    const next = m.querySelector<HTMLButtonElement>("[data-cal-next]");
    if (prev) prev.disabled = k === 0;
    if (next) next.disabled = k === months.length - 1;
  });
}

async function renderCalendar() {
  const mount = document.getElementById("availability-cal");
  if (!mount) return;
  try {
    const res = await fetch("/api/unavailable");
    if (res.ok) busy = ((await res.json()) as { unavailable: typeof busy }).unavailable;
    else return;
  } catch {
    return; // leave the explanatory text and the typed-date field in place
  }
  const [iomYear, iomMonth] = todayIso().split("-").map(Number) as [number, number];
  const months: HTMLElement[] = [];
  for (let m = 0; m < 2; m++) {
    const first = new Date(iomYear, iomMonth - 1 + m, 1);
    const monthName = first.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
    const wrap = document.createElement("div");
    wrap.className = "cal-month";
    const head = document.createElement("div");
    head.className = "cal-head";
    const prev = document.createElement("button");
    prev.type = "button";
    prev.className = "cal-nav";
    prev.dataset.calPrev = "";
    prev.setAttribute("aria-label", "Previous month");
    prev.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3L5 8l5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    prev.addEventListener("click", () => showMonth(activeMonth - 1));
    const title = document.createElement("div");
    title.className = "cal-title grow text-center lg:text-left";
    title.textContent = monthName;
    const next = document.createElement("button");
    next.type = "button";
    next.className = "cal-nav";
    next.dataset.calNext = "";
    next.setAttribute("aria-label", "Next month");
    next.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    next.addEventListener("click", () => showMonth(activeMonth + 1));
    head.append(prev, title, next);
    const grid = document.createElement("div");
    grid.className = "cal-grid";
    for (const d of ["M", "T", "W", "T", "F", "S", "S"]) {
      const h = document.createElement("span");
      h.className = "cal-dow";
      h.setAttribute("aria-hidden", "true");
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
      } else {
        cell.setAttribute("aria-label", `${fmtDay(iso)} ${past ? "is in the past" : "is unavailable"}`);
      }
      grid.append(cell);
    }
    wrap.append(head, grid);
    months.push(wrap);
  }
  mount.replaceChildren(...months);
  // The calendar works, so the typed-date field is redundant; it stays in the
  // form (hidden) as the value the calendar writes to.
  const fallback = document.getElementById("enq-date-fallback");
  if (fallback) fallback.hidden = true;
  const legend = document.getElementById("cal-legend");
  if (legend) legend.hidden = false;
  const start = startInput?.value ?? "";
  showMonth(start && start.slice(0, 7) !== todayIso().slice(0, 7) ? 1 : 0);
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
      const current = areaSelect.value;
      // Keep the static "Other location — request a quote" option: places
      // outside the zones are quoted individually, never dropped.
      const other = areaSelect.querySelector<HTMLOptionElement>('option[value="__other"]');
      areaSelect.replaceChildren(
        ...pricing.delivery_zones.map((z) => {
          const o = document.createElement("option");
          o.value = z.areas;
          o.textContent = `${z.areas} — ${gbp(z.both_pence)} both ways`;
          return o;
        }),
        ...(other ? [other] : []),
      );
      if ([...areaSelect.options].some((o) => o.value === current)) areaSelect.value = current;
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
const panels = Array.from(document.querySelectorAll<HTMLElement>("#enquiry-form [data-step]"));
const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>("#enquiry-form [data-goto]"));
let currentStep = 1;
let furthestStep = 1;

const panel = (n: number) => panels.find((p) => p.dataset.step === String(n));
function stepErrorEl(n: number): HTMLElement | null {
  return n === 3 ? document.getElementById("enquiry-error") : (panel(n)?.querySelector<HTMLElement>(".step-error") ?? null);
}
function clearStepError(n: number) {
  const el = stepErrorEl(n);
  if (el) el.hidden = true;
}
function showStepError(n: number, msg: string) {
  const el = stepErrorEl(n);
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
}

function showStep(n: number, focus = true) {
  currentStep = n;
  furthestStep = Math.max(furthestStep, n);
  for (const p of panels) p.hidden = p.dataset.step !== String(n);
  for (const t of tabs) {
    const k = Number(t.dataset.goto);
    t.disabled = k > furthestStep;
    if (k === n) t.setAttribute("aria-current", "step");
    else t.removeAttribute("aria-current");
  }
  if (focus) {
    const title = panel(n)?.querySelector<HTMLElement>(".step-title");
    title?.focus({ preventScroll: true });
    document.getElementById("book")?.scrollIntoView({ block: "start", behavior: "smooth" });
  }
}

const isShown = (el: HTMLElement) => !el.closest("[hidden]");

/** Returns true when step n is complete; otherwise shows why and returns false. */
function validateStep(n: number, report = true): boolean {
  const p = panel(n);
  if (!p) return true;
  if (n === 1) {
    const start = startInput?.value ?? "";
    let msg = "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) msg = "Please choose a start date.";
    else if (start < todayIso()) msg = "Please pick a start date from today onwards.";
    else if (weekendNotFriday) msg = "Weekend hire starts on a Friday. Please pick a Friday, or choose another hire length.";
    else if (dateClash) msg = "Those dates are unavailable; please pick different dates on the calendar.";
    if (msg) {
      if (report) showStepError(1, msg);
      return false;
    }
  }
  const controls = Array.from(p.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("input, select, textarea"))
    .filter((el) => isShown(el) && el.name !== "website");
  const bad = controls.find((el) => !el.checkValidity());
  if (bad) {
    if (report) {
      clearStepError(n);
      bad.reportValidity();
    }
    return false;
  }
  clearStepError(n);
  return true;
}

if (form) {
  const deliveryFields = document.getElementById("enq-delivery-fields");
  const otherWrap = document.getElementById("enq-other-wrap");
  const otherInput = document.getElementById("enq-other") as HTMLInputElement | null;
  const syncDelivery = () => {
    const f = (fulfilSelect?.value ?? "self") as Fulfilment;
    const needsTransport = journeysFor(f) > 0;
    if (deliveryFields) deliveryFields.hidden = !needsTransport;
    const otherShown = needsTransport && areaSelect?.value === "__other";
    if (otherWrap) otherWrap.hidden = !otherShown;
    if (otherInput) otherInput.required = otherShown;
    const addressInput = form?.querySelector<HTMLInputElement>('input[name="address"]');
    if (addressInput) addressInput.required = needsTransport;
    if (areaSelect) areaSelect.required = needsTransport;
    updateEstimate();
  };
  fulfilSelect?.addEventListener("change", syncDelivery);
  areaSelect?.addEventListener("change", syncDelivery);
  for (const cb of document.querySelectorAll('#enquiry-form input[name="extras"]')) {
    cb.addEventListener("change", updateEstimate);
  }
  planSelect?.addEventListener("change", () => {
    clearStepError(1);
    repaintCalendar();
  });
  startInput?.addEventListener("change", () => {
    clearStepError(1);
    repaintCalendar();
  });
  syncDelivery();

  for (const btn of form.querySelectorAll<HTMLButtonElement>("[data-next]")) {
    btn.addEventListener("click", () => {
      if (validateStep(currentStep)) showStep(currentStep + 1);
    });
  }
  for (const btn of form.querySelectorAll<HTMLButtonElement>("[data-back]")) {
    btn.addEventListener("click", () => showStep(currentStep - 1));
  }
  for (const t of tabs) {
    t.addEventListener("click", () => {
      const target = Number(t.dataset.goto);
      // Going back is always free; going forward re-checks the steps in between.
      for (let k = currentStep; k < target; k++) {
        if (!validateStep(k)) {
          if (k !== currentStep) showStep(k);
          return;
        }
      }
      showStep(target);
    });
  }
  showStep(1, false);

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
    clearStepError(3);
    // Every step is re-checked: a customer may have gone back and changed something.
    for (const n of [1, 2, 3]) {
      if (!validateStep(n, false)) {
        if (n !== currentStep) showStep(n);
        validateStep(n);
        return;
      }
    }
    result.hidden = true;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Sending…";
    }
    const fd = new FormData(form);
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
      terms_acknowledged: fd.get("terms_acknowledged") === "on",
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
        result.className = (data.emailed === false ? "enq-err" : "enq-ok") + " mt-6";
        result.hidden = false;
        result.focus();
      } else {
        showStepError(3, data.error ?? "Something went wrong sending that; please email bookings@sparklecarpets.im instead.");
      }
    } catch {
      showStepError(3, "We couldn't send that just now; please email bookings@sparklecarpets.im instead.");
    }
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = "Send enquiry";
    }
  });
}

hydrate();
renderCalendar();
