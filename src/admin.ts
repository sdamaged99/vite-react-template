// Amanda's availability screen. All endpoints sit behind Cloudflare Access;
// a 401/503 here means Access isn't set up or the session expired.

interface DiaryEntry {
  id: number;
  start_date: string;
  end_date: string;
  kind: "booking" | "blocked";
  name: string | null;
  note: string | null;
  enquiry_id: number | null;
  returned: number;
  paid: number;
  deposit_status: "held" | "refunded" | "deducted" | "na";
  handed_over_at: string | null;
  handover_check: string | null;
  returned_at: string | null;
  return_check: string | null;
  hire_paid_pence: number | null;
  hire_paid_method: string | null;
  hire_paid_at: string | null;
  deposit_taken: number;
  deposit_refunded: number;
  deposit_deducted: number;
  phone: string | null;
  email: string | null;
  estimate_total_pence: number | null;
}
interface TodayPayload {
  today: string;
  deposit_default_pence: number;
  going_out: DiaryEntry[];
  due_back: DiaryEntry[];
  enquiries: { id: number; name: string; preferred_start: string; rate_plan_code: string; status: string; created_at: string }[];
  deposits_to_settle: DiaryEntry[];
}
interface Enquiry {
  id: number;
  created_at: string;
  name: string;
  email: string;
  phone: string;
  preferred_start: string;
  rate_plan_code: string;
  fulfilment: string;
  area: string | null;
  address: string | null;
  extras: string;
  estimate_total_pence: number | null;
  message: string | null;
  status: "new" | "replied" | "confirmed" | "declined" | "closed";
  emailed: number;
  email_error: string | null;
  terms_version: string | null;
  terms_acknowledged_at: string | null;
  accepted_terms_version: string | null;
  accepted_at: string | null;
  acceptance_method: string | null;
}

const ACCEPTANCE_METHOD_LABELS: Record<string, string> = {
  email: "email",
  whatsapp: "WhatsApp",
  phone: "phone",
  in_person: "in person",
};
interface Activity {
  actor: string;
  action: string;
  entity: string | null;
  entity_id: number | null;
  detail: string | null;
  created_at: string;
}

const errBox = document.getElementById("admin-error");

function fail(msg: string) {
  if (!errBox) return;
  errBox.textContent = msg;
  errBox.hidden = false;
}

async function api<T>(path: string, init?: RequestInit): Promise<T | null> {
  const res = await fetch(`/api/admin${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (res.status === 401) {
    fail("Not signed in. Open this page through the Cloudflare Access sign-in (one-time PIN to your email) and try again.");
    return null;
  }
  if (res.status === 503) {
    fail("Admin access isn't configured yet. Barry needs to set up the Cloudflare Access application first.");
    return null;
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    fail(body.error ?? `Something went wrong (${res.status}).`);
    return null;
  }
  return (await res.json()) as T;
}

const fmt = (iso: string) =>
  new Date(iso + "T00:00:00").toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });

function chip(text: string, cls: string): HTMLSpanElement {
  const s = document.createElement("span");
  s.className = `rounded-full px-2.5 py-0.5 text-[11px] font-bold ${cls}`;
  s.textContent = text;
  return s;
}

function actionBtn(label: string, onClick: (btn: HTMLButtonElement) => void, ghost = true): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = (ghost ? "btn btn-ghost" : "btn") + " px-4 py-2 text-[13.5px]";
  b.textContent = label;
  b.addEventListener("click", () => onClick(b));
  return b;
}

async function loadWho() {
  const me = await api<{ email: string | null }>("/me");
  const el = document.getElementById("whoami");
  if (el && me?.email) el.textContent = me.email;
}

function refreshAll() {
  loadToday();
  loadDiary();
  loadEnquiries();
  loadActivity();
}

/* ------------------------------------------------- hire lifecycle UI ----- */
let depositDefault = 7500;
const money = (p: number) => `£${(p / 100).toFixed(p % 100 === 0 ? 0 : 2)}`;
const stamp = (dt: string | null) =>
  dt ? new Date(dt.replace(" ", "T") + "Z").toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
const heldOf = (d: DiaryEntry) => d.deposit_taken - d.deposit_refunded - d.deposit_deducted;
/** "45" or "7.50" (pounds) to pence; NaN when not a sensible amount. */
function toPence(v: string): number {
  const t = v.trim().replace(/^£/, "");
  if (t === "") return 0;
  if (!/^\d{1,4}(\.\d{1,2})?$/.test(t)) return NaN;
  return Math.round(Number(t) * 100);
}
const expectedHire = (d: DiaryEntry) =>
  d.estimate_total_pence != null ? Math.max(0, d.estimate_total_pence - depositDefault) : null;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

const CHECKS: [string, string, boolean][] = [
  ["machine_ok", "Machine clean and working", true],
  ["attachment", "Stair & upholstery attachment", true],
  ["hose", "Hose", true],
  ["accessories", "Other accessories", true],
  ["detergent", "Detergent", true],
  ["photos", "Photos taken (kept on phone)", false],
];

function checklist(prefix: string, detergentLabel: string): { node: HTMLElement; read: () => Record<string, boolean> } {
  const box = el("fieldset", "m-0 grid gap-1.5 border-0 p-0 sm:grid-cols-2");
  const inputs: Record<string, HTMLInputElement> = {};
  for (const [key, label, def] of CHECKS) {
    const lab = el("label", "flex min-h-9 items-center gap-2.5 text-[14.5px]");
    const cb = el("input", "h-5 w-5 shrink-0 accent-[var(--color-chambray-deep)]");
    cb.type = "checkbox";
    cb.checked = def;
    cb.name = `${prefix}-${key}`;
    inputs[key] = cb;
    lab.append(cb, document.createTextNode(key === "detergent" ? detergentLabel : label));
    box.append(lab);
  }
  return { node: box, read: () => Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, v.checked])) };
}

function moneyInput(label: string, pence: number | null): { node: HTMLLabelElement; input: HTMLInputElement } {
  const lab = el("label", "field");
  lab.append(document.createTextNode(label));
  const inp = el("input");
  inp.inputMode = "decimal";
  inp.placeholder = "0.00";
  inp.value = pence != null && pence > 0 ? (pence / 100).toFixed(pence % 100 ? 2 : 0) : "";
  lab.append(inp);
  return { node: lab, input: inp };
}

function panel(summaryText: string, open = false): { details: HTMLDetailsElement; body: HTMLElement } {
  const det = el("details", "rounded-lg border border-line bg-linen");
  det.open = open;
  const sum = el("summary", "flex min-h-11 cursor-pointer items-center px-3 text-[14.5px] font-semibold", summaryText);
  const body = el("div", "grid gap-3 px-3 pb-3");
  det.append(sum, body);
  return { details: det, body };
}

async function post(path: string, body: unknown, btn: HTMLButtonElement, busyText: string) {
  if (errBox) errBox.hidden = true;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = busyText;
  const ok = (await api(path, { method: "POST", body: JSON.stringify(body) })) !== null;
  if (ok) refreshAll();
  else {
    btn.disabled = false;
    btn.textContent = label;
  }
}

function handoverPanel(d: DiaryEntry, open: boolean): HTMLElement {
  const { details, body } = panel("Hand over", open);
  const checks = checklist("h", "Detergent supplied");
  const note = el("input");
  note.placeholder = "Condition notes (optional)";
  note.maxLength = 300;
  const noteLab = el("label", "field", "Condition at handover");
  noteLab.append(note);
  body.append(checks.node, noteLab);
  let payTick: HTMLInputElement | null = null;
  let pay: ReturnType<typeof moneyInput> | null = null;
  let method: HTMLSelectElement | null = null;
  if (!d.paid) {
    const row = el("div", "grid gap-3 sm:grid-cols-[auto_1fr_1fr] sm:items-end");
    const lab = el("label", "flex min-h-11 items-center gap-2.5 text-[14.5px] font-semibold");
    payTick = el("input", "h-5 w-5 accent-[var(--color-chambray-deep)]");
    payTick.type = "checkbox";
    // Ticked when the expected hire amount is known from the enquiry; otherwise
    // Amanda ticks it and types the amount, so nothing is recorded by accident.
    payTick.checked = expectedHire(d) != null;
    lab.append(payTick, document.createTextNode("Hire payment received"));
    pay = moneyInput("Amount (£)", expectedHire(d));
    const mLab = el("label", "field", "Paid by");
    method = el("select");
    for (const [v, t] of [["cash", "Cash"], ["bank", "Bank transfer"]]) {
      const o = el("option", "", t);
      o.value = v!;
      method.append(o);
    }
    mLab.append(method);
    row.append(lab, pay.node, mLab);
    body.append(row);
  } else {
    body.append(el("p", "text-[13.5px] text-ink-soft", `Hire payment already recorded: ${d.hire_paid_pence != null ? money(d.hire_paid_pence) : "yes"}.`));
  }
  const dep = moneyInput("Deposit received (£)", depositDefault);
  body.append(dep.node);
  const btn = el("button", "btn justify-self-start", "Record handover");
  btn.type = "button";
  btn.addEventListener("click", () => {
    const depP = toPence(dep.input.value);
    const payP = pay && payTick?.checked ? toPence(pay.input.value) : 0;
    if (Number.isNaN(depP) || Number.isNaN(payP)) return fail("Amounts must be in pounds, like 45 or 7.50.");
    if (payTick?.checked && payP === 0) return fail("Enter the hire payment amount, or untick 'Hire payment received'.");
    post(`/diary/${d.id}/handover`, {
      checks: checks.read(),
      note: note.value,
      hire_paid_pence: payP || null,
      hire_paid_method: method?.value,
      deposit_pence: depP || null,
    }, btn, "Saving…");
  });
  body.append(btn);
  return details;
}

function returnPanel(d: DiaryEntry, open: boolean): HTMLElement {
  const { details, body } = panel("Record return", open);
  const checks = checklist("r", "Detergent and bottle returned");
  const note = el("input");
  note.placeholder = "Condition notes (optional)";
  note.maxLength = 300;
  const noteLab = el("label", "field", "Condition on return");
  noteLab.append(note);
  const held = heldOf(d);
  const refund = moneyInput(`Refund now (£) — ${money(held)} held`, held);
  const ded = moneyInput("Deduction (£)", 0);
  const reason = el("input");
  reason.placeholder = "Reason, e.g. excess cleaning (terms 7.5)";
  reason.maxLength = 200;
  const rLab = el("label", "field", "Deduction reason");
  rLab.append(reason);
  const money2 = el("div", "grid gap-3 sm:grid-cols-2");
  money2.append(refund.node, ded.node);
  body.append(checks.node, noteLab, money2, rLab);
  const btn = el("button", "btn justify-self-start", "Record return");
  btn.type = "button";
  btn.addEventListener("click", () => {
    const r = toPence(refund.input.value);
    const x = toPence(ded.input.value);
    if (Number.isNaN(r) || Number.isNaN(x)) return fail("Amounts must be in pounds, like 75 or 7.50.");
    if (r + x > held) return fail(`Refund plus deduction can't be more than the ${money(held)} held.`);
    post(`/diary/${d.id}/return`, { checks: checks.read(), note: note.value, refund_pence: r, deduction_pence: x, deduction_reason: reason.value }, btn, "Saving…");
  });
  body.append(btn);
  return details;
}

function depositActions(d: DiaryEntry): HTMLElement {
  const wrap = el("div", "grid gap-2");
  const held = heldOf(d);
  if (held <= 0) {
    wrap.append(el("p", "text-[13.5px] text-ink-soft", "Deposit amount wasn't recorded (entered before itemised tracking); settle it outside the dashboard."));
    return wrap;
  }
  const full = el("button", "btn justify-self-start", `Refund remaining ${money(held)}`);
  full.type = "button";
  full.addEventListener("click", () => post(`/diary/${d.id}/deposit/refund`, { amount_pence: held }, full, "Saving…"));
  const { details, body } = panel("Partial refund or deduction");
  const amt = moneyInput("Amount (£)", null);
  const reason = el("input");
  reason.placeholder = "Reason (needed for a deduction)";
  reason.maxLength = 200;
  const rLab = el("label", "field", "Reason");
  rLab.append(reason);
  const row = el("div", "flex flex-wrap gap-2");
  const refundBtn = el("button", "btn btn-ghost px-4 py-2 text-[13.5px]", "Refund this amount");
  const dedBtn = el("button", "btn btn-ghost px-4 py-2 text-[13.5px]", "Deduct this amount");
  for (const [b, kind] of [[refundBtn, "refund"], [dedBtn, "deduction"]] as const) {
    b.type = "button";
    b.addEventListener("click", () => {
      const p = toPence(amt.input.value);
      if (!p || Number.isNaN(p)) return fail("Enter an amount in pounds.");
      post(`/diary/${d.id}/deposit/${kind}`, { amount_pence: p, reason: reason.value }, b, "Saving…");
    });
  }
  row.append(refundBtn, dedBtn);
  body.append(amt.node, rLab, row);
  wrap.append(full, details);
  return wrap;
}

function paymentPanel(d: DiaryEntry): HTMLElement {
  const { details, body } = panel(d.handed_over_at || d.returned ? "Record hire payment" : "Paid in advance? Record hire payment");
  const amt = moneyInput("Amount (£)", expectedHire(d));
  const mLab = el("label", "field", "Paid by");
  const method = el("select");
  for (const [v, t] of [["bank", "Bank transfer"], ["cash", "Cash"]]) {
    const o = el("option", "", t);
    o.value = v!;
    method.append(o);
  }
  mLab.append(method);
  const btn = el("button", "btn justify-self-start", "Record payment");
  btn.type = "button";
  btn.addEventListener("click", () => {
    const p = toPence(amt.input.value);
    if (!p || Number.isNaN(p)) return fail("Enter the amount received in pounds.");
    post(`/diary/${d.id}/payment`, { amount_pence: p, method: method.value }, btn, "Saving…");
  });
  body.append(amt.node, mLab, btn);
  return details;
}

function statusLine(d: DiaryEntry): string {
  const parts: string[] = [];
  if (d.handed_over_at) parts.push(`Out ${stamp(d.handed_over_at)}`);
  if (d.hire_paid_pence != null) parts.push(`Hire ${money(d.hire_paid_pence)} (${d.hire_paid_method === "bank" ? "bank" : "cash"})`);
  else if (d.paid) parts.push("Hire paid");
  if (d.deposit_taken > 0) {
    let dep = `Deposit ${money(d.deposit_taken)}`;
    if (d.deposit_refunded) dep += `, ${money(d.deposit_refunded)} refunded`;
    if (d.deposit_deducted) dep += `, ${money(d.deposit_deducted)} deducted`;
    const h = heldOf(d);
    dep += h > 0 ? `, ${money(h)} held` : ", settled";
    parts.push(dep);
  } else if (d.returned) {
    parts.push(`Deposit ${d.deposit_status}`);
  }
  if (d.returned_at) parts.push(`Back ${stamp(d.returned_at)}`);
  else if (d.returned) parts.push("Returned");
  return parts.join(" · ");
}

/** The single next step for a booking, so routine work is one panel and one tap. */
function nextAction(d: DiaryEntry, open: boolean): HTMLElement | null {
  if (d.kind !== "booking") return null;
  if (!d.handed_over_at && !d.returned) return handoverPanel(d, open);
  if (d.handed_over_at && !d.returned) return returnPanel(d, open);
  if (d.returned && (heldOf(d) > 0 || (d.deposit_taken === 0 && d.deposit_status === "held" && !d.handed_over_at))) return depositActions(d);
  return null;
}

function hireCard(d: DiaryEntry, today: string, openAction: boolean): HTMLElement {
  const card = el("div", "grid gap-2.5 rounded-xl border border-line bg-card px-4 py-3 text-[14.5px]");
  const top = el("div", "flex flex-wrap items-baseline gap-x-3 gap-y-1");
  top.append(el("strong", "", d.name ?? "Booking"));
  top.append(el("span", "text-ink-soft", d.start_date === d.end_date ? fmt(d.start_date) : `${fmt(d.start_date)} to ${fmt(d.end_date)}`));
  if (!d.handed_over_at && !d.returned && d.start_date < today) top.append(chip("Late collection", "bg-[#f7e9e7] text-[#8a2f28]"));
  if (d.handed_over_at && !d.returned && d.end_date < today) top.append(chip("Overdue", "bg-[#f7e9e7] text-[#8a2f28]"));
  if (d.phone) {
    const tel = el("a", "ml-auto font-semibold text-chambray-deep no-underline", d.phone);
    tel.href = `tel:${d.phone.replace(/[^\d+]/g, "")}`;
    top.append(tel);
  }
  card.append(top);
  const st = statusLine(d);
  if (st) card.append(el("p", "text-[13px] text-ink-soft", st));
  if (d.note) card.append(el("p", "text-[13px] text-ink-soft", d.note));
  if (d.kind === "booking" && !d.paid && (d.handed_over_at || d.returned)) card.append(paymentPanel(d));
  const act = nextAction(d, openAction);
  if (act) card.append(act);
  return card;
}

async function loadToday() {
  const data = await api<TodayPayload>("/today");
  const mount = document.getElementById("today");
  if (!data || !mount) return;
  depositDefault = data.deposit_default_pence || depositDefault;
  const group = (title: string, items: HTMLElement[], empty: string) => {
    const sec = el("section", "grid gap-2");
    const h = el("h3", "flex items-baseline gap-2 text-[17px] font-semibold");
    h.append(document.createTextNode(title), el("span", "rounded-full bg-oat px-2 py-0.5 text-[12.5px] font-bold", String(items.length)));
    sec.append(h);
    if (items.length === 0) sec.append(el("p", "text-[13.5px] text-ink-soft", empty));
    else sec.append(...items);
    return sec;
  };
  const enquiryItems = data.enquiries.map((q) => {
    const a = el("a", "flex min-h-11 items-center gap-3 rounded-lg border border-line bg-card px-4 text-[14.5px] text-ink no-underline");
    a.href = `#enq-${q.id}`;
    a.append(el("strong", "", q.name), el("span", "text-ink-soft", `${q.rate_plan_code} from ${fmt(q.preferred_start)}`), chip(q.status, "ml-auto bg-oat text-ink"));
    return a;
  });
  mount.replaceChildren(
    group("Going out", data.going_out.map((d) => hireCard(d, data.today, true)), "Nothing to hand over today."),
    group("Due back", data.due_back.map((d) => hireCard(d, data.today, true)), "Nothing due back today."),
    group("Deposits to settle", data.deposits_to_settle.map((d) => hireCard(d, data.today, true)), "No deposits waiting."),
    group("Open enquiries", enquiryItems, "No enquiries waiting for a reply."),
  );
}

async function loadDiary() {
  const data = await api<{ diary: DiaryEntry[] }>("/diary");
  const list = document.getElementById("diary-list");
  if (!data || !list) return;
  if (data.diary.length === 0) {
    list.innerHTML = `<p class="text-[14px] text-ink-soft">Nothing in the diary yet.</p>`;
    return;
  }
  list.replaceChildren(
    ...data.diary.map((d) => {
      const row = document.createElement("div");
      row.className = "grid gap-2 rounded-lg border border-line bg-card px-4 py-3 text-[14.5px]";
      const top = document.createElement("div");
      top.className = "flex flex-wrap items-center gap-3";
      top.append(
        chip(d.kind === "booking" ? "Booking" : "Blocked", d.kind === "booking" ? "bg-rec text-chambray-deep" : "bg-oat text-ink-soft"),
      );
      const when = document.createElement("strong");
      when.textContent = d.start_date === d.end_date ? fmt(d.start_date) : `${fmt(d.start_date)} to ${fmt(d.end_date)}`;
      const who = document.createElement("span");
      who.className = "text-ink-soft";
      who.textContent = [d.name, d.note].filter(Boolean).join(" · ");
      top.append(when, who);
      if (d.kind === "booking") {
        top.append(chip(d.paid ? "Paid" : "Payment due", d.paid ? "bg-rec text-chambray-deep" : "bg-oat text-ink"));
        if (d.handed_over_at && !d.returned) top.append(chip("Out", "bg-rec text-chambray-deep"));
        if (d.returned) top.append(chip("Returned", "bg-rec text-chambray-deep"));
      }
      const del = document.createElement("button");
      del.className = "ml-auto min-h-6 px-1 text-[13px] font-bold text-[#9c4038]";
      del.textContent = "Remove";
      del.addEventListener("click", async () => {
        del.disabled = true;
        del.textContent = "Removing…";
        if ((await api(`/diary/${d.id}`, { method: "DELETE" })) !== null) refreshAll();
        else {
          del.disabled = false;
          del.textContent = "Remove";
        }
      });
      top.append(del);
      row.append(top);

      if (d.kind === "booking") {
        const st = statusLine(d);
        if (st) row.append(el("p", "text-[13px] text-ink-soft", st));
        if (!d.paid) row.append(paymentPanel(d));
        const act = nextAction(d, false);
        if (act) row.append(act);
      }
      return row;
    }),
  );
}

const diaryForm = document.getElementById("diary-form") as HTMLFormElement | null;
diaryForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (errBox) errBox.hidden = true;
  const fd = new FormData(diaryForm);
  const ok = await api("/diary", { method: "POST", body: JSON.stringify(Object.fromEntries(fd.entries())) });
  if (ok !== null) {
    diaryForm.reset();
    refreshAll();
  }
});

async function loadEnquiries() {
  const data = await api<{ enquiries: Enquiry[] }>("/enquiries");
  const list = document.getElementById("enquiry-list");
  if (!data || !list) return;
  if (data.enquiries.length === 0) {
    list.innerHTML = `<p class="text-[14px] text-ink-soft">No enquiries yet.</p>`;
    return;
  }
  list.replaceChildren(
    ...data.enquiries.map((q) => {
      const card = document.createElement("div");
      card.id = `enq-${q.id}`;
      card.style.scrollMarginTop = "16px";
      card.className = "grid gap-1.5 rounded-xl border border-line bg-card p-4 text-[14.5px]";
      const top = document.createElement("div");
      top.className = "flex flex-wrap items-baseline gap-x-3 gap-y-1";
      const name = document.createElement("strong");
      name.textContent = q.name;
      const statusCls =
        q.status === "confirmed"
          ? "bg-rec text-chambray-deep"
          : q.status === "declined" || q.status === "closed"
            ? "bg-oat text-ink-soft"
            : "bg-oat text-ink";
      top.append(name, chip(q.status, statusCls));
      const when = document.createElement("span");
      when.className = "ml-auto text-[12.5px] text-ink-soft";
      when.textContent = new Date(q.created_at + "Z").toLocaleString("en-GB");
      top.append(when);
      card.append(top);

      if (!q.emailed) {
        const warn = document.createElement("p");
        warn.className = "enq-err";
        warn.textContent = `Email notification failed — this enquiry exists only here.${q.email_error ? ` (${q.email_error})` : ""}`;
        card.append(warn);
      }

      const detail = document.createElement("p");
      detail.className = "text-ink-soft";
      const extras = (JSON.parse(q.extras || "[]") as string[]).join(", ");
      detail.textContent = `${q.rate_plan_code} from ${fmt(q.preferred_start)} · ${q.fulfilment}${
        q.area ? `: ${q.area}` : ""
      }${q.address ? `, ${q.address}` : ""} · ${q.phone}${extras ? ` · extras: ${extras}` : ""}${
        q.estimate_total_pence != null
          ? ` · est. due £${(q.estimate_total_pence / 100).toFixed(q.estimate_total_pence % 100 ? 2 : 0)} incl. deposit`
          : " · transport to be quoted"
      }`;
      card.append(detail);
      const termsLine = document.createElement("p");
      termsLine.className = "text-[12.5px] text-ink-soft";
      termsLine.textContent = q.terms_version
        ? `Terms v${q.terms_version} acknowledged as read ${new Date((q.terms_acknowledged_at ?? "") + "Z").toLocaleString("en-GB")}`
        : "No terms record (enquiry predates terms acknowledgement)";
      card.append(termsLine);
      const acceptLine = document.createElement("p");
      acceptLine.className = q.accepted_at ? "text-[12.5px] text-ink-soft" : "text-[12.5px] font-semibold text-[#9c4038]";
      acceptLine.textContent = q.accepted_at
        ? `Terms v${q.accepted_terms_version} formally accepted ${
            ACCEPTANCE_METHOD_LABELS[q.acceptance_method ?? ""] ? `via ${ACCEPTANCE_METHOD_LABELS[q.acceptance_method ?? ""]} ` : ""
          }${new Date(q.accepted_at + "Z").toLocaleString("en-GB")}`
        : "Formal acceptance not yet recorded — record it once the customer agrees the arrangements and terms.";
      card.append(acceptLine);
      if (q.message) {
        const msg = document.createElement("p");
        msg.textContent = `“${q.message}”`;
        card.append(msg);
      }

      const actions = document.createElement("div");
      actions.className = "flex flex-wrap gap-2 pt-1";
      const reply = document.createElement("a");
      reply.className = "btn btn-ghost px-4 py-2 text-[13.5px]";
      reply.href = `mailto:${q.email}?subject=${encodeURIComponent("Your Sparkle Carpets enquiry")}`;
      reply.textContent = "Reply by email";

      if (q.status === "new" || q.status === "replied") {
        actions.append(
          actionBtn(
            "Confirm booking",
            async (b) => {
              if (
                !q.accepted_at &&
                !window.confirm(
                  "No formal acceptance is recorded for this enquiry yet. The customer should explicitly accept the price, dates and terms first. Confirm the booking anyway?",
                )
              )
                return;
              b.disabled = true;
              b.textContent = "Confirming…";
              const res = await api<{ confirmation_emailed?: boolean }>(`/enquiries/${q.id}/confirm`, { method: "POST" });
              if (res !== null) {
                if (res.confirmation_emailed === false)
                  fail("Booking confirmed and dated, but the confirmation email failed; contact the customer directly.");
                refreshAll();
              } else {
                b.disabled = false;
                b.textContent = "Confirm booking";
              }
            },
            false,
          ),
        );
        actions.append(
          actionBtn("Decline", async (b) => {
            b.disabled = true;
            if ((await api(`/enquiries/${q.id}/status`, { method: "POST", body: JSON.stringify({ status: "declined" }) })) !== null)
              refreshAll();
            else b.disabled = false;
          }),
        );
        if (q.status === "new") {
          actions.append(
            actionBtn("Mark replied", async (b) => {
              b.disabled = true;
              if ((await api(`/enquiries/${q.id}/status`, { method: "POST", body: JSON.stringify({ status: "replied" }) })) !== null)
                refreshAll();
              else b.disabled = false;
            }),
          );
        }
      }
      if (!q.emailed) {
        actions.append(
          actionBtn("Retry email", async (b) => {
            b.disabled = true;
            b.textContent = "Sending…";
            if ((await api(`/enquiries/${q.id}/resend`, { method: "POST" })) !== null) refreshAll();
            else {
              b.disabled = false;
              b.textContent = "Retry email";
            }
          }),
        );
      }
      actions.append(reply);
      // Formal acceptance is a deliberate, separate record — never implied by
      // Confirm. Available until recorded, including on already-confirmed hires.
      if (!q.accepted_at && q.status !== "declined" && q.status !== "closed") {
        const sel = document.createElement("select");
        sel.className = "field w-auto px-3 py-2 text-[13.5px]";
        sel.setAttribute("aria-label", "How the customer accepted the terms");
        for (const [value, label] of [
          ["email", "by email"],
          ["whatsapp", "by WhatsApp"],
          ["phone", "by phone"],
          ["in_person", "in person"],
        ]) {
          const opt = document.createElement("option");
          opt.value = value;
          opt.textContent = label;
          sel.append(opt);
        }
        actions.append(
          sel,
          actionBtn("Record acceptance", async (b) => {
            b.disabled = true;
            if ((await api(`/enquiries/${q.id}/acceptance`, { method: "POST", body: JSON.stringify({ method: sel.value }) })) !== null)
              refreshAll();
            else b.disabled = false;
          }),
        );
      }
      card.append(actions);
      return card;
    }),
  );
}

async function loadActivity() {
  const data = await api<{ activity: Activity[] }>("/activity");
  const list = document.getElementById("activity-list");
  if (!data || !list) return;
  if (data.activity.length === 0) {
    list.innerHTML = `<p class="text-[14px] text-ink-soft">No activity yet.</p>`;
    return;
  }
  list.replaceChildren(
    ...data.activity.map((a) => {
      const row = document.createElement("p");
      row.className = "text-[13px] text-ink-soft";
      const when = new Date(a.created_at + "Z").toLocaleString("en-GB");
      row.textContent = `${when} · ${a.actor} · ${a.action}${a.entity ? ` ${a.entity} #${a.entity_id}` : ""}${
        a.detail ? ` · ${a.detail}` : ""
      }`;
      return row;
    }),
  );
}

loadWho();
refreshAll();
