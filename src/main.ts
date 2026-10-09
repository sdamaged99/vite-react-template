import "./styles/main.css";

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

/* ------------------------------------------------------- live pricing ----- */
const gbp = (pence: number) =>
  new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    minimumFractionDigits: pence % 100 === 0 ? 0 : 2,
  }).format(pence / 100);

interface PricingPayload {
  rates: { code: string; label: string; price_pence: number }[];
  addons: { code: string; price_pence: number }[];
  delivery_zones: { name: string; areas: string; one_way_pence: number; both_pence: number }[];
  settings: Record<string, string>;
}

async function hydrate() {
  try {
    const res = await fetch("/api/pricing");
    if (!res.ok) return;
    const data = (await res.json()) as PricingPayload;

    for (const el of document.querySelectorAll<HTMLElement>("[data-price-plan]")) {
      const rate = data.rates.find((r) => r.code === el.dataset.pricePlan);
      if (rate) el.textContent = gbp(rate.price_pence);
    }
    for (const el of document.querySelectorAll<HTMLElement>("[data-price-addon]")) {
      const addon = data.addons.find((a) => a.code === el.dataset.priceAddon);
      if (addon) el.textContent = gbp(addon.price_pence);
    }
    for (const el of document.querySelectorAll<HTMLElement>("[data-price-setting]")) {
      const value = data.settings[el.dataset.priceSetting ?? ""];
      if (value !== undefined) el.textContent = gbp(Number(value));
    }

    const zoneBody = document.getElementById("zone-rows");
    if (zoneBody && data.delivery_zones.length > 0) {
      zoneBody.replaceChildren(
        ...data.delivery_zones.map((z) => {
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

    // Enquiry form selects follow the database too.
    const planSelect = document.getElementById("enq-plan") as HTMLSelectElement | null;
    if (planSelect && data.rates.length > 0) {
      planSelect.replaceChildren(
        ...data.rates.map((r) => {
          const o = document.createElement("option");
          o.value = r.code;
          o.textContent = `${r.label} — ${gbp(r.price_pence)}`;
          return o;
        }),
      );
      planSelect.value = "48h";
    }
    const areaSelect = document.getElementById("enq-area") as HTMLSelectElement | null;
    if (areaSelect && data.delivery_zones.length > 0) {
      areaSelect.replaceChildren(
        ...data.delivery_zones.map((z) => {
          const o = document.createElement("option");
          o.value = z.areas;
          o.textContent = `${z.areas} — ${gbp(z.both_pence)} both ways`;
          return o;
        }),
      );
    }

    // WhatsApp appears only once a verified number is configured.
    const wa = (data.settings["whatsapp_number"] ?? "").replace(/\D/g, "");
    if (wa) {
      for (const el of document.querySelectorAll<HTMLAnchorElement>("[data-whatsapp]")) {
        el.href = `https://wa.me/${wa}`;
        el.hidden = false;
      }
    }
  } catch {
    /* static fallbacks remain */
  }
}
hydrate();

/* ------------------------------------------------- availability shown ----- */
async function renderCalendar() {
  const mount = document.getElementById("availability-cal");
  if (!mount) return;
  let ranges: { start_date: string; end_date: string }[] = [];
  try {
    const res = await fetch("/api/unavailable");
    if (res.ok) ranges = ((await res.json()) as { unavailable: typeof ranges }).unavailable;
  } catch {
    return; // leave the explanatory text in place
  }
  const busy = (iso: string) => ranges.some((r) => iso >= r.start_date && iso <= r.end_date);
  const today = new Date();
  const todayIso = today.toISOString().slice(0, 10);
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
      const date = new Date(first.getFullYear(), first.getMonth(), d);
      const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      const cell = document.createElement("span");
      cell.textContent = String(d);
      cell.className =
        "cal-day" + (iso < todayIso ? " cal-past" : busy(iso) ? " cal-busy" : " cal-free");
      grid.append(cell);
    }
    wrap.append(title, grid);
    months.push(wrap);
  }
  mount.replaceChildren(...months);
  const legend = document.getElementById("cal-legend");
  if (legend) legend.hidden = false;
}
renderCalendar();

/* -------------------------------------------------------- enquiry form ---- */
const form = document.getElementById("enquiry-form") as HTMLFormElement | null;
if (form) {
  const startInput = document.getElementById("enq-start") as HTMLInputElement | null;
  if (startInput) startInput.min = new Date().toISOString().slice(0, 10);

  const fulfilment = document.getElementById("enq-fulfilment") as HTMLSelectElement | null;
  const deliveryFields = document.getElementById("enq-delivery-fields");
  const syncDelivery = () => {
    if (deliveryFields && fulfilment) deliveryFields.hidden = fulfilment.value !== "deliver";
  };
  fulfilment?.addEventListener("change", syncDelivery);
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
    result.hidden = true;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Sending…";
    }
    const fd = new FormData(form);
    const payload = Object.fromEntries(fd.entries());
    (payload as Record<string, string>)["turnstile_token"] = turnstileToken;
    try {
      const res = await fetch("/api/enquiry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (res.ok && data.ok) {
        form.hidden = true;
        result.textContent =
          "Thanks — your enquiry is on its way. We'll check availability and reply personally, usually the same day. Nothing is booked or paid until we've confirmed with you.";
        result.className = "enq-ok";
      } else {
        result.textContent = data.error ?? "Something went wrong sending that; please email bookings@sparklecarpets.im instead.";
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
