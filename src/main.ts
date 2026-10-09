import "./styles/main.css";

// Mobile navigation toggle. No framework on the marketing page: React loads
// only when an island mount point is enabled (see below).
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

// Live pricing: the static HTML carries the current figures as a crawlable
// fallback; this overwrites them from the database so Amanda's dashboard
// edits show without a redeploy. Elements opt in with data attributes:
//   data-price-plan="48h"            -> rate_plans.price_pence
//   data-price-addon="solution"      -> addons.price_pence
//   data-price-setting="deposit_pence" -> settings value (pence)
const gbp = (pence: number) =>
  new Intl.NumberFormat("en-GB", {
    style: "currency",
    currency: "GBP",
    minimumFractionDigits: pence % 100 === 0 ? 0 : 2,
  }).format(pence / 100);

interface PricingPayload {
  rates: { code: string; price_pence: number }[];
  addons: { code: string; price_pence: number }[];
  delivery_zones: { name: string; areas: string; one_way_pence: number; both_pence: number }[];
  settings: Record<string, string>;
}

async function hydratePricing() {
  if (!document.querySelector("[data-price-plan],[data-price-addon],[data-price-setting]")) return;
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
    // Delivery zone table: rebuilt from the database so Amanda can add,
    // remove or reprice zones without a deploy. Static rows are the fallback.
    const zoneBody = document.getElementById("zone-rows");
    if (zoneBody && Array.isArray(data.delivery_zones) && data.delivery_zones.length > 0) {
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
  } catch {
    // Static fallback figures remain; nothing to do.
  }
}
hydratePricing();

// Island loader: Phase 2 mounts the availability calendar here. The dynamic
// import means React is only fetched on pages that actually use it.
const availabilityMount = document.getElementById("island-availability");
if (availabilityMount && availabilityMount.dataset.enabled === "true") {
  import("./islands/availability").then((m) => m.mount(availabilityMount));
}
