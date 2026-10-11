"""Responsive layout and accessibility checks on the STYLED pages.

Needs a Tailwind build of src/styles/main.css (SITE_CSS) and, optionally, the
site's font files (FONT_DIR with Fraunces[...].ttf and Figtree[...].ttf, from
github.com/google/fonts) so text metrics match production. Screenshots are
written to SHOT_DIR for human review.

Run: SITE_CSS=/path/site.css FONT_DIR=/path/fonts SHOT_DIR=/path/shots python3 tests/visual_test.py
"""
import json
import os
import subprocess
import sys
import time
import urllib.request
import datetime as dt

from playwright.sync_api import sync_playwright

PORT = 8797
BASE = f"http://localhost:{PORT}"
SHOTS = os.environ.get("SHOT_DIR", "shots")
FONTS = os.environ.get("FONT_DIR", "")
os.makedirs(SHOTS, exist_ok=True)

server = subprocess.Popen(
    ["node", "--experimental-transform-types", "--no-warnings", "--import", "./tests/harness/register.mjs", "tests/harness/server.ts", str(PORT)],
    stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT, env=os.environ.copy(),
)
for _ in range(50):
    try:
        urllib.request.urlopen(f"{BASE}/__test/reset").read()
        break
    except Exception:  # noqa: BLE001
        time.sleep(0.2)


def sql(q, params=None):
    req = urllib.request.Request(f"{BASE}/__test/sql", data=json.dumps({"sql": q, "params": params or []}).encode(), method="POST")
    return json.loads(urllib.request.urlopen(req).read())


def post_enquiry(**kw):
    body = {"name": "X", "email": "x@example.com", "phone": "07624 000000", "preferred_start": "", "rate_plan_code": "48h",
            "fulfilment": "self", "area": "", "address": "", "extras": [], "message": "", "terms_acknowledged": True, "website": ""}
    body.update(kw)
    req = urllib.request.Request(f"{BASE}/api/enquiry", data=json.dumps(body).encode(), headers={"content-type": "application/json"}, method="POST")
    return json.loads(urllib.request.urlopen(req).read())


today = dt.date.today()
sql("INSERT INTO diary (start_date, end_date, kind, name) VALUES (?, ?, 'booking', 'Existing hire')",
    [(today + dt.timedelta(days=9)).isoformat(), (today + dt.timedelta(days=11)).isoformat()])
post_enquiry(name="Alice Example", preferred_start=(today + dt.timedelta(days=20)).isoformat(), fulfilment="deliver_only",
             area="Ballasalla, Derbyhaven", address="1 Main Road", extras=["solution"], message="Ground floor flat, lift available.")
post_enquiry(name="Bob Example", preferred_start=(today + dt.timedelta(days=30)).isoformat())

FONT_CSS = """
@font-face{font-family:'Fraunces';src:url(https://fonts.gstatic.com/local/fraunces.ttf) format('truetype');font-weight:100 900;font-style:normal}
@font-face{font-family:'Figtree';src:url(https://fonts.gstatic.com/local/figtree.ttf) format('truetype');font-weight:300 900;font-style:normal}
@font-face{font-family:'Figtree';src:url(https://fonts.gstatic.com/local/figtree-italic.ttf) format('truetype');font-weight:300 900;font-style:italic}
"""
FONT_FILES = {
    "fraunces.ttf": "Fraunces[SOFT,WONK,opsz,wght].ttf",
    "figtree.ttf": "Figtree[wght].ttf",
    "figtree-italic.ttf": "Figtree-Italic[wght].ttf",
}

AUDIT_JS = r"""
() => {
  const vw = document.documentElement.clientWidth;
  const desc = (el) => {
    const t = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 50);
    return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').filter(Boolean).slice(0, 2).join('.') : ''} "${t}"`;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && !el.closest('[hidden]');
  };
  const out = { overflow: document.documentElement.scrollWidth - vw, wide: [], small: [], contrast: [], tiny: [] };

  for (const el of document.body.querySelectorAll('*')) {
    if (!visible(el) || el.closest('.overflow-x-auto')) continue;
    const r = el.getBoundingClientRect();
    if (r.right > vw + 1 || r.left < -1) out.wide.push(`${desc(el)} [${Math.round(r.left)}..${Math.round(r.right)}]`);
  }

  for (const el of document.querySelectorAll('a[href], button, select, input:not([type=hidden]), summary, textarea')) {
    if (!visible(el) || el.name === 'website' || el.disabled) continue;
    const parent = el.parentElement;
    const inlineLink = el.tagName === 'A' && getComputedStyle(el).display === 'inline' && parent &&
      parent.textContent.trim().length > el.textContent.trim().length + 5;
    if (inlineLink) continue; // WCAG 2.5.8 inline-in-sentence exception
    let r = el.getBoundingClientRect();
    if ((el.type === 'checkbox' || el.type === 'radio') && el.closest('label')) r = el.closest('label').getBoundingClientRect();
    if (r.width >= 23.5 && r.height >= 23.5) continue;
    // WCAG 2.5.8 spacing exception: a 24px square centred on the target must not overlap another target
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const sq = { l: cx - 12, r: cx + 12, t: cy - 12, b: cy + 12 };
    const others = [...document.querySelectorAll('a[href], button, select, input:not([type=hidden]), summary, textarea')]
      .filter((o) => o !== el && visible(o) && !o.contains(el) && !el.contains(o)).map((o) => o.getBoundingClientRect());
    const clash = others.some((o) => o.left < sq.r && o.right > sq.l && o.top < sq.b && o.bottom > sq.t);
    if (clash) out.small.push(`${desc(el)} ${Math.round(r.width)}x${Math.round(r.height)}`);
  }

  const parse = (c) => { const m = c.match(/rgba?\(([^)]+)\)/); if (!m) return null; const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const blend = (top, bot) => ({ r: top.r * top.a + bot.r * (1 - top.a), g: top.g * top.a + bot.g * (1 - top.a), b: top.b * top.a + bot.b * (1 - top.a), a: 1 });
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const bgOf = (el) => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage && cs.backgroundImage !== 'none') return null; // photo/gradient: can't judge
      const c = parse(cs.backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) base = blend(layers[i], base);
    return base;
  };
  const seen = new Set();
  for (const el of document.body.querySelectorAll('*')) {
    if (!visible(el) || el.closest('button:disabled')) continue;
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!own) continue;
    const cs = getComputedStyle(el);
    const size = parseFloat(cs.fontSize);
    if (size < 12) out.tiny.push(`${desc(el)} ${size}px`);
    const bg = bgOf(el); if (!bg) continue;
    let fg = parse(cs.color); if (!fg) continue;
    const op = parseFloat(cs.opacity); if (op < 1) fg = { ...fg, a: fg.a * op };
    fg = blend(fg, bg);
    const L1 = lum(fg), L2 = lum(bg);
    const ratio = (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
    const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
    const need = large ? 3 : 4.5;
    if (ratio < need) {
      const key = desc(el);
      if (!seen.has(key)) { seen.add(key); out.contrast.push(`${key} ${ratio.toFixed(2)}:1 (needs ${need})`); }
    }
  }
  return out;
}
"""

FOCUS_JS = r"""
() => { const el = document.activeElement; if (!el || el === document.body) return null;
  const cs = getComputedStyle(el); const r = el.getBoundingClientRect();
  const ring = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || (cs.boxShadow && cs.boxShadow !== 'none');
  return { tag: el.tagName, text: (el.innerText || el.getAttribute('aria-label') || el.name || '').trim().slice(0, 40), ring,
           outline: cs.outlineStyle + ' ' + cs.outlineWidth + ' ' + cs.outlineColor, top: Math.round(r.top) }; }
"""

pages = [("home", "/"), ("terms", "/terms/"), ("privacy", "/privacy/"), ("instructions", "/instructions/"), ("admin", "/admin/")]
widths = [(320, "phone-320"), (375, "phone-375"), (414, "phone-414"), (768, "tablet-768"), (1024, "laptop-1024"), (1280, "desktop-1280"), (1440, "desktop-1440")]
report = {}

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path="/opt/pw-browsers/chromium-1194/chrome-linux/chrome")
    token = urllib.request.urlopen(f"{BASE}/__test/jwt").read().decode()

    def ctx_for(width, admin=False):
        c = browser.new_context(viewport={"width": width, "height": 900}, device_scale_factor=1,
                                extra_http_headers={"Cf-Access-Jwt-Assertion": token} if admin else {})
        if FONTS:
            c.route("**/fonts.googleapis.com/**", lambda r: r.fulfill(status=200, content_type="text/css", body=FONT_CSS))
            def serve(real):
                return lambda route: route.fulfill(status=200, content_type="font/ttf", path=os.path.join(FONTS, real))
            for short, real in FONT_FILES.items():
                c.route(f"**/fonts.gstatic.com/local/{short}", serve(real))
        else:
            c.route("**/fonts.*/**", lambda r: r.abort())
        return c

    for name, path in pages:
        for width, label in widths:
            c = ctx_for(width, admin=(name == "admin"))
            pg = c.new_page()
            pg.goto(BASE + path, wait_until="networkidle")
            pg.wait_for_timeout(400)
            if name == "home":
                pg.wait_for_selector("button.cal-day")
            if name == "admin":
                pg.wait_for_selector("#enquiry-list > *")
            pg.evaluate("document.fonts.ready")
            res = pg.evaluate(AUDIT_JS)
            # keyboard focus walk (first 30 stops)
            focus_missing = []
            for _ in range(30):
                pg.keyboard.press("Tab")
                f = pg.evaluate(FOCUS_JS)
                if f and not f["ring"]:
                    focus_missing.append(f"{f['tag']} '{f['text']}' ({f['outline']})")
            res["focus_missing"] = sorted(set(focus_missing))
            pg.evaluate("document.documentElement.style.scrollBehavior='auto'; window.scrollTo(0,0)")
            pg.screenshot(path=os.path.join(SHOTS, f"{name}-{label}.png"), full_page=True)
            report[f"{name}@{width}"] = res
            c.close()

    # Interaction states on the smallest phone: open menu, filled form with estimate, FAQ open
    c = ctx_for(320)
    pg = c.new_page()
    pg.goto(BASE + "/", wait_until="networkidle")
    pg.wait_for_selector("button.cal-day")
    pg.click("#nav-toggle")
    pg.screenshot(path=os.path.join(SHOTS, "home-320-menu-open.png"))
    pg.click("#nav-toggle")
    free = None
    for i in range(14, 40):
        d = today + dt.timedelta(days=i)
        if d.weekday() == 4:
            free = d
            break
    pg.select_option("#enq-plan", "weekend")
    pg.fill("#enq-start", free.isoformat())
    pg.dispatch_event("#enq-start", "change")
    pg.select_option("#enq-fulfilment", "both")
    pg.select_option("#enq-area", "Ballasalla, Derbyhaven")
    pg.check('input[name="extras"][value="solution"]')
    est = pg.locator("#estimate")
    est.scroll_into_view_if_needed()
    est.screenshot(path=os.path.join(SHOTS, "estimate-320-itemised.png"))
    pg.select_option("#enq-area", "__other")
    est.screenshot(path=os.path.join(SHOTS, "estimate-320-quoted.png"))
    report["estimate@320"] = pg.evaluate(AUDIT_JS)
    pg.locator("#book").screenshot(path=os.path.join(SHOTS, "booking-320.png"))
    pg.locator("details.faq-item").first.click()
    pg.locator("#faq").screenshot(path=os.path.join(SHOTS, "faq-320-open.png"))
    c.close()
    browser.close()

server.terminate()
json.dump(report, open(os.path.join(SHOTS, "report.json"), "w"), indent=1)
for k, v in report.items():
    issues = {kk: vv for kk, vv in v.items() if (vv if kk != "overflow" else vv > 0)}
    print(f"{k:22} " + ("clean" if not issues else json.dumps(issues)[:900]))
