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
}
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
  loadDiary();
  loadEnquiries();
  loadActivity();
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
        top.append(chip(d.paid ? "Paid" : "Payment due", d.paid ? "bg-rec text-chambray-deep" : "bg-oat text-ink-soft"));
        if (d.returned) top.append(chip("Returned", "bg-rec text-chambray-deep"));
        top.append(
          chip(
            d.deposit_status === "held" ? "Deposit held" : `Deposit ${d.deposit_status}`,
            d.deposit_status === "held" ? "bg-oat text-ink-soft" : "bg-rec text-chambray-deep",
          ),
        );
      }
      const del = document.createElement("button");
      del.className = "ml-auto text-[13px] font-bold text-[#9c4038]";
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
        const actions = document.createElement("div");
        actions.className = "flex flex-wrap gap-2";
        if (!d.paid) {
          actions.append(
            actionBtn("Payment received", async (b) => {
              b.disabled = true;
              if ((await api(`/diary/${d.id}/paid`, { method: "POST", body: JSON.stringify({ paid: true }) })) !== null)
                refreshAll();
              else b.disabled = false;
            }),
          );
        }
        if (!d.returned) {
          actions.append(
            actionBtn("Mark returned", async (b) => {
              b.disabled = true;
              if ((await api(`/diary/${d.id}/returned`, { method: "POST", body: JSON.stringify({ returned: true }) })) !== null)
                refreshAll();
              else b.disabled = false;
            }),
          );
        }
        if (d.deposit_status === "held") {
          for (const s of ["refunded", "deducted"] as const) {
            actions.append(
              actionBtn(`Deposit ${s}`, async (b) => {
                b.disabled = true;
                if ((await api(`/diary/${d.id}/deposit`, { method: "POST", body: JSON.stringify({ status: s }) })) !== null)
                  refreshAll();
                else b.disabled = false;
              }),
            );
          }
        }
        if (actions.childElementCount > 0) row.append(actions);
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
        q.estimate_total_pence != null ? ` · est. due £${(q.estimate_total_pence / 100).toFixed(0)} incl. deposit` : ""
      }`;
      card.append(detail);
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
