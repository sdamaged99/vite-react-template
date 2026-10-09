// Amanda's availability screen. All endpoints sit behind Cloudflare Access;
// a 401/503 here means Access isn't set up or the session expired.

interface DiaryEntry {
  id: number;
  start_date: string;
  end_date: string;
  kind: "booking" | "blocked";
  name: string | null;
  note: string | null;
}
interface Enquiry {
  id: number;
  created_at: string;
  name: string;
  email: string;
  phone: string;
  preferred_start: string;
  rate_plan_code: string;
  fulfilment_pref: string;
  area: string | null;
  address: string | null;
  message: string | null;
  status: "new" | "replied" | "closed";
  emailed: number;
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

async function loadWho() {
  const me = await api<{ email: string | null }>("/me");
  const el = document.getElementById("whoami");
  if (el && me?.email) el.textContent = me.email;
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
      row.className = "flex flex-wrap items-center gap-3 rounded-lg border border-line bg-card px-4 py-3 text-[14.5px]";
      const badge = document.createElement("span");
      badge.className =
        "rounded-full px-2.5 py-0.5 text-[11px] font-bold " +
        (d.kind === "booking" ? "bg-rec text-chambray-deep" : "bg-oat text-ink-soft");
      badge.textContent = d.kind === "booking" ? "Booking" : "Blocked";
      const when = document.createElement("strong");
      when.textContent = d.start_date === d.end_date ? fmt(d.start_date) : `${fmt(d.start_date)} to ${fmt(d.end_date)}`;
      const who = document.createElement("span");
      who.className = "text-ink-soft";
      who.textContent = [d.name, d.note].filter(Boolean).join(" · ");
      const del = document.createElement("button");
      del.className = "ml-auto text-[13px] font-bold text-[#9c4038]";
      del.textContent = "Remove";
      del.addEventListener("click", async () => {
        del.disabled = true;
        del.textContent = "Removing…";
        if ((await api(`/diary/${d.id}`, { method: "DELETE" })) !== null) loadDiary();
        else {
          del.disabled = false;
          del.textContent = "Remove";
        }
      });
      row.append(badge, when, who, del);
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
    loadDiary();
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
      const status = document.createElement("span");
      status.className = "rounded-full bg-oat px-2.5 py-0.5 text-[11px] font-bold";
      status.textContent = q.status + (q.emailed ? "" : " · not emailed");
      const when = document.createElement("span");
      when.className = "ml-auto text-[12.5px] text-ink-soft";
      when.textContent = new Date(q.created_at + "Z").toLocaleString("en-GB");
      top.append(name, status, when);
      const detail = document.createElement("p");
      detail.className = "text-ink-soft";
      detail.textContent = `${q.rate_plan_code} from ${fmt(q.preferred_start)} · ${
        q.fulfilment_pref === "deliver" ? `deliver: ${q.area ?? ""}, ${q.address ?? ""}` : "customer collects"
      } · ${q.phone}`;
      card.append(top, detail);
      if (q.message) {
        const msg = document.createElement("p");
        msg.textContent = `“${q.message}”`;
        card.append(msg);
      }
      const actions = document.createElement("div");
      actions.className = "flex flex-wrap gap-2 pt-1";
      const reply = document.createElement("a");
      reply.className = "btn px-4 py-2 text-[13.5px]";
      reply.href = `mailto:${q.email}?subject=${encodeURIComponent("Your Sparkle Carpets enquiry")}`;
      reply.textContent = "Reply by email";
      actions.append(reply);
      for (const s of ["replied", "closed"] as const) {
        if (q.status === s) continue;
        const b = document.createElement("button");
        b.className = "btn btn-ghost px-4 py-2 text-[13.5px]";
        b.textContent = s === "replied" ? "Mark replied" : "Mark closed";
        b.addEventListener("click", async () => {
          b.disabled = true;
          if ((await api(`/enquiries/${q.id}/status`, { method: "POST", body: JSON.stringify({ status: s }) })) !== null)
            loadEnquiries();
          else b.disabled = false;
        });
        actions.append(b);
      }
      card.append(actions);
      return card;
    }),
  );
}

loadWho();
loadDiary();
loadEnquiries();
