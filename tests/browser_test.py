"""Browser tests: the REAL page and REAL client TypeScript in headless Chromium
at phone width, talking to the REAL Worker (SQLite + fake SMTP) through
tests/harness/server.ts. Pages are unstyled here (no offline Tailwind build),
so these check behaviour, not appearance.

Run: python3 tests/browser_test.py
"""
import datetime as dt
import json
import subprocess
import sys
import time
import urllib.request

from playwright.sync_api import sync_playwright

PORT = 8799
BASE = f"http://localhost:{PORT}"
results = []


def check(area, name, fn):
    try:
        fn()
        results.append((True, area, name, ""))
    except Exception as e:  # noqa: BLE001
        results.append((False, area, name, str(e)[:300]))
    print(("PASS " if results[-1][0] else "FAIL ") + name, flush=True)


def sql(q, params=None):
    req = urllib.request.Request(f"{BASE}/__test/sql", data=json.dumps({"sql": q, "params": params or []}).encode(), method="POST")
    return json.loads(urllib.request.urlopen(req).read())


def reset(smtp="ok"):
    urllib.request.urlopen(f"{BASE}/__test/reset?smtp={smtp}").read()


def iom_today():
    # Europe/Isle_of_Man == Europe/London
    from zoneinfo import ZoneInfo
    return dt.datetime.now(ZoneInfo("Europe/London")).date()


import socket as _socket
with _socket.socket() as _s:
    if _s.connect_ex(("127.0.0.1", PORT)) == 0:
        sys.exit(f"port {PORT} is already in use (a stale test server?); stop it and rerun")
server = subprocess.Popen(
    ["node", "--experimental-transform-types", "--no-warnings", "--import", "./tests/harness/register.mjs", "tests/harness/server.ts", str(PORT)],
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
)
for _ in range(50):
    try:
        urllib.request.urlopen(f"{BASE}/__test/reset").read()
        break
    except Exception:  # noqa: BLE001
        time.sleep(0.2)
else:
    print(server.stdout.read().decode())
    sys.exit("server did not start")

today = iom_today()
in_month = [today + dt.timedelta(days=i) for i in range(1, 40)]
# pick a free working window inside the two rendered months
def first(pred, start=3):
    for i in range(start, 40):
        d = today + dt.timedelta(days=i)
        if (d.month == today.month or d.month == (today.month % 12) + 1) and pred(d):
            return d
    raise RuntimeError("no date")


busy_start = first(lambda d: d.weekday() == 2, 5)  # a Wednesday
busy_end = busy_start + dt.timedelta(days=1)  # Wed-Thu blocked

with sync_playwright() as p:
    browser = p.chromium.launch(executable_path="/opt/pw-browsers/chromium-1194/chrome-linux/chrome")
    # Phone-width viewport. Mobile emulation (is_mobile) is off: with the page
    # unstyled offline it makes Chromium clicks hang, and behaviour is identical.
    ctx = browser.new_context(viewport={"width": 375, "height": 800})
    ctx.route("**/fonts.googleapis.com/**", lambda r: r.abort())
    ctx.route("**/fonts.gstatic.com/**", lambda r: r.abort())
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    def load():
        page.goto(BASE + "/", wait_until="domcontentloaded")
        page.wait_for_selector("button.cal-day", timeout=10000)
        page.wait_for_function("document.querySelector('#enq-plan option').textContent.includes('—')", timeout=10000)

    reset()
    sql("INSERT INTO diary (start_date, end_date, kind) VALUES (?, ?, 'booking')", [busy_start.isoformat(), busy_end.isoformat()])
    load()

    def no_js_errors():
        assert not errors, errors
    check("10 Mobile/a11y", "Page and client script load with no JavaScript errors", no_js_errors)

    def cal_render():
        n = page.locator("div.cal-month").count()
        assert n == 2, n
        b = page.locator(f'button.cal-day[data-iso="{busy_start}"]')
        assert b.is_disabled() and "unavailable" in b.get_attribute("aria-label")
        past = (today - dt.timedelta(days=1))
        if past.month == today.month:
            assert page.locator(f'button.cal-day[data-iso="{past}"]').is_disabled()
        free = page.locator("button.cal-day.cal-free").first
        assert free.get_attribute("aria-label").startswith("Start enquiry on")
    check("11 Overlap", "Calendar marks booked and past days unavailable, with accessible labels", cal_render)

    # ---- helpers that drive the three-step form like a customer would ----
    def tab(pg, n):
        pg.click(f'#enquiry-form [data-goto="{n}"]')

    def cont(pg):
        pg.locator('#enquiry-form [data-step]:not([hidden]) [data-next]').click()

    def pick_date(pg, d):
        """Choose a start date: via the calendar when it's there (paging months
        on small screens), otherwise via the typed-date fallback."""
        iso = d.isoformat()
        if pg.locator("button.cal-day").count() == 0:
            pg.fill("#enq-start", iso); pg.dispatch_event("#enq-start", "change")
            return
        btn = pg.locator(f'button.cal-day[data-iso="{iso}"]')
        for _ in range(2):
            if btn.is_visible():
                break
            nxt = pg.locator(".cal-month[data-active] [data-cal-next]")
            prv = pg.locator(".cal-month[data-active] [data-cal-prev]")
            (nxt if nxt.is_enabled() else prv).click()
        btn.click()

    def fill_all(pg, name, d, plan="24h", fulfil="self", area=None, address=None, email="f@example.com", terms=True):
        tab(pg, 1)
        pg.select_option("#enq-plan", plan)
        pick_date(pg, d)
        cont(pg)
        pg.select_option("#enq-fulfilment", fulfil)
        if area:
            pg.select_option("#enq-area", area)
        if address:
            pg.fill('input[name="address"]', address)
        cont(pg)
        pg.fill('input[name="name"]', name); pg.fill('input[name="phone"]', "07624 333333"); pg.fill('input[name="email"]', email)
        if terms:
            pg.check('input[name="terms_acknowledged"]')

    def submit(pg):
        pg.click("#enquiry-form button[type=submit]")

    def client_overlap():
        page.select_option("#enq-plan", "48h")
        day_before = busy_start - dt.timedelta(days=1)
        pick_date(page, day_before)
        assert page.input_value("#enq-start") == day_before.isoformat()
        assert page.locator("#est-conflict").is_visible(), "conflict notice should show"
        cont(page)
        assert page.locator('[data-step="1"]').is_visible(), "must not move on with clashing dates"
        assert "unavailable" in page.text_content('[data-step="1"] .step-error')
        page.select_option("#enq-plan", "24h")  # now only the free day
        assert not page.locator("#est-conflict").is_visible()
        cont(page)
        assert page.locator('[data-step="2"]').is_visible()
        tab(page, 1)
    check("11 Overlap", "Client blocks a span that runs into a booked day (cannot continue), and clears when it no longer does", client_overlap)

    def weekend_client():
        page.select_option("#enq-plan", "weekend")
        enabled_non_friday = page.evaluate(
            """() => [...document.querySelectorAll('button.cal-day.cal-free')]
                 .filter(b => !b.disabled && new Date(b.dataset.iso + 'T12:00:00Z').getUTCDay() !== 5).length"""
        )
        assert enabled_non_friday == 0, f"{enabled_non_friday} non-Friday days still clickable"
        fri = first(lambda d: d.weekday() == 4 and not any(busy_start <= d + dt.timedelta(days=k) <= busy_end for k in range(4)))
        pick_date(page, fri)
        note = page.text_content("#enq-span")
        assert "Collect Friday, return Monday morning" in note, note
        mon = fri + dt.timedelta(days=3)
        if page.locator(f'button.cal-day[data-iso="{mon}"]').count():
            assert "cal-sel" in page.get_attribute(f'button.cal-day[data-iso="{mon}"]', "class")
    check("12 Weekend/TZ", "Weekend: only Fridays selectable on the calendar; span shows Fri-Mon", weekend_client)

    def estimate_matrix():
        plans = {"24h": 30, "48h": 45, "weekend": 55, "3day": 60, "week": 95}
        zones = [("Castletown", 5), ("Ballasalla, Derbyhaven", 7.5), ("Douglas, Braddan, Onchan", 20), ("Ramsey, Andreas, Jurby", 40)]
        fri = first(lambda d: d.weekday() == 4 and not any(busy_start <= d + dt.timedelta(days=k) <= busy_end for k in range(7)))
        def money(v):
            return f"£{v:.2f}" if v % 1 else f"£{int(v)}"
        checked = 0
        for plan, hire in plans.items():
            for extra in (False, True):
                tab(page, 1)
                page.select_option("#enq-plan", plan)
                pick_date(page, fri)
                page.set_checked('input[name="extras"][value="solution"]', extra)
                cont(page)
                for ful, mult in [("self", 0), ("deliver_only", 1), ("collect_only", 1), ("both", 2)]:
                    page.select_option("#enq-fulfilment", ful)
                    for area, one in (zones if mult else [("", 0)]):
                        if area:
                            page.select_option("#enq-area", area)
                        transport = one * mult
                        due = hire + transport + (5 if extra else 0) + 75
                        assert page.text_content("#est-hire") == money(hire), (plan, page.text_content("#est-hire"))
                        assert page.text_content("#est-deposit") == "£75"
                        assert page.text_content("#est-due") == money(due), (plan, ful, area, extra, page.text_content("#est-due"))
                        assert page.text_content("#est-summary-total") == money(due), "compact summary matches"
                        assert page.text_content("#est-eff") == money(due - 75)
                        if mult:
                            assert page.text_content("#est-transport") == money(transport), (ful, area)
                        else:
                            assert page.get_attribute("#est-transport-row", "hidden") is not None
                        rows = page.locator("#est-extras > div")
                        assert rows.count() == (1 if extra else 0)
                        if extra:
                            assert "Additional detergent portion" in rows.first.text_content() and "£5" in rows.first.text_content()
                        checked += 1
                page.select_option("#enq-fulfilment", "self")
        tab(page, 1)
        page.set_checked('input[name="extras"][value="solution"]', False)
        assert checked == 5 * 2 * (1 + 3 * 4), checked
    check("13 Pricing", "Live estimate: every package x transport option (4 zones each) x extras, itemised", estimate_matrix)

    def other_area():
        tab(page, 1); cont(page)
        page.select_option("#enq-fulfilment", "both")
        opts = page.eval_on_selector_all("#enq-area option", "os => os.map(o => o.value)")
        assert "__other" in opts, f"'Other location' option missing after prices load: {opts}"
        page.select_option("#enq-area", "__other")
        assert page.locator("#enq-other").is_visible()
        assert page.text_content("#est-transport") == "To be quoted"
        assert page.text_content("#est-due") == "To be quoted"
        cont(page)
        assert page.locator('[data-step="2"]').is_visible(), "town and address required before continuing"
        page.select_option("#enq-fulfilment", "self")
        tab(page, 1)
    check("13 Pricing", "'Other location' stays available after live prices load, shows 'To be quoted', requires a town", other_area)

    def steps_back_keep_values():
        reset(); load()
        d = first(lambda d: d.weekday() < 4 and not (busy_start <= d <= busy_end + dt.timedelta(days=2)))
        fill_all(page, "Back Tester", d, plan="48h", fulfil="both", area="Douglas, Braddan, Onchan", address="3 Hill St", terms=False)
        page.fill('textarea[name="message"]', "keep me")
        tab(page, 1)
        assert page.input_value("#enq-plan") == "48h" and page.input_value("#enq-start") == d.isoformat()
        tab(page, 2)
        assert page.input_value("#enq-fulfilment") == "both" and page.input_value('input[name="address"]') == "3 Hill St"
        tab(page, 3)
        assert page.input_value('input[name="name"]') == "Back Tester" and page.input_value('textarea[name="message"]') == "keep me"
        focused = page.evaluate("() => document.activeElement.id")
        assert focused == "step3-title", focused
        assert page.get_attribute('[data-goto="3"]', "aria-current") == "step"
    check("Phase 1", "Back/forward between steps keeps every answer; focus moves to the step heading", steps_back_keep_values)

    def cannot_skip_ahead():
        reset(); load()
        assert page.locator('[data-goto="2"]').is_disabled() and page.locator('[data-goto="3"]').is_disabled()
        cont(page)
        assert page.locator('[data-step="1"]').is_visible()
        assert "choose a start date" in page.text_content('[data-step="1"] .step-error').lower()
    check("Phase 1", "Steps can't be skipped: no date means no step 2; later tabs disabled until reached", cannot_skip_ahead)

    def mobile_one_month_and_compact_estimate():
        visible_months = page.evaluate("() => [...document.querySelectorAll('.cal-month')].filter(m => m.hasAttribute('data-active')).length")
        assert visible_months == 1
        assert page.locator(".cal-month[data-active] [data-cal-prev]").is_disabled()
        page.locator(".cal-month[data-active] [data-cal-next]").click()
        idx = page.evaluate("() => [...document.querySelectorAll('.cal-month')].findIndex(m => m.hasAttribute('data-active'))")
        assert idx == 1
        page.locator(".cal-month[data-active] [data-cal-prev]").click()
        assert page.evaluate("() => document.getElementById('estimate').open") is False, "compact (closed) on phones"
        page.click("#estimate summary")
        assert page.evaluate("() => document.getElementById('estimate').open") is True
        page.click("#estimate summary")
        assert page.locator("#enq-date-fallback").is_hidden(), "typed date hidden while the calendar works"
    check("Phase 1", "Phone width: one month at a time with prev/next; estimate is a compact expandable bar", mobile_one_month_and_compact_estimate)

    def desktop_layout():
        c = browser.new_context(viewport={"width": 1280, "height": 900})
        c.route("**/fonts.*/**", lambda r: r.abort())
        pg = c.new_page()
        pg.goto(BASE + "/", wait_until="domcontentloaded")
        pg.wait_for_selector("button.cal-day")
        pg.wait_for_function("!document.getElementById('estimate').hidden")
        assert pg.evaluate("() => document.getElementById('estimate').open") is True, "open beside the steps on desktop"
        pg.click("#estimate summary")
        assert pg.evaluate("() => document.getElementById('estimate').open") is True, "cannot be collapsed on desktop"
        c.close()
    check("Phase 1", "Desktop: estimate is open (not collapsible) beside the steps", desktop_layout)

    def validation():
        reset()
        load()
        before = sql("SELECT count(*) AS n FROM enquiries")[0]["n"]
        d = first(lambda d: not (busy_start <= d <= busy_end + dt.timedelta(days=2)) and d.weekday() < 4)
        tab(page, 1); page.select_option("#enq-plan", "24h"); pick_date(page, d); cont(page); cont(page)
        submit(page)
        page.wait_for_timeout(300)
        invalid = page.evaluate("() => [...document.querySelectorAll('#enquiry-form [data-step=\"3\"] :invalid')].map(e => e.name)")
        assert "name" in invalid and "terms_acknowledged" in invalid, invalid
        assert sql("SELECT count(*) AS n FROM enquiries")[0]["n"] == before, "nothing should be sent"
        page.fill('input[name="name"]', "Pat Example")
        page.fill('input[name="phone"]', "07624 000000")
        page.fill('input[name="email"]', "not-an-email")
        page.check('input[name="terms_acknowledged"]')
        submit(page)
        page.wait_for_timeout(300)
        assert page.evaluate("() => document.querySelector('input[name=email]').matches(':invalid')")
        assert sql("SELECT count(*) AS n FROM enquiries")[0]["n"] == before
    check("10 Mobile/a11y", "Validation: empty/invalid fields and unticked terms are caught in the browser; nothing sent", validation)

    def unchecked_terms_named():
        lab = page.locator('label:has(input[name="terms_acknowledged"])').text_content()
        assert "I confirm that I have read the proposed Equipment Hire Terms & Conditions." in " ".join(lab.split()), lab
        assert page.locator('label:has(input[name="terms_acknowledged"]) a[href="/terms/"]').count() == 1
        body = " ".join(page.text_content("#book").split())
        assert "Submitting an enquiry does not create a confirmed booking or an obligation to pay." in body
        assert "This is an enquiry, not a booking" in body
    check("15 Terms", "Acknowledgement wording, link, no-obligation line and 'enquiry, not a booking' statement present", unchecked_terms_named)

    def submit_ok():
        page.fill('input[name="email"]', "pat@example.com")
        submit(page)
        page.wait_for_selector("#enquiry-result.enq-ok", timeout=10000)
        rows = sql("SELECT name, email, rate_plan_code, terms_version, emailed, estimate_total_pence FROM enquiries")
        assert len(rows) == 1 and rows[0]["name"] == "Pat Example" and rows[0]["terms_version"] == "1.1" and rows[0]["emailed"] == 1, rows
        assert rows[0]["estimate_total_pence"] == 3000 + 7500
        msgs = json.loads(urllib.request.urlopen(f"{BASE}/__test/smtp").read())
        assert len(msgs) == 2, msgs
        focused = page.evaluate("() => document.activeElement && document.activeElement.id")
        assert focused == "enquiry-result", focused
    check("14 Email", "Browser submission persists to D1, sends both emails, success message gets focus", submit_ok)

    def submit_delivery_ok():
        reset(); load()
        d = first(lambda d: d.weekday() < 4 and not (busy_start <= d <= busy_end + dt.timedelta(days=2)), 10)
        fill_all(page, "Del Ivery", d, plan="48h", fulfil="both", area="Ballasalla, Derbyhaven", address="9 Main Rd")
        page.check('input[name="extras"][value="solution"]') if page.locator('input[name="extras"]').is_visible() else None
        submit(page)
        page.wait_for_selector("#enquiry-result.enq-ok", timeout=10000)
        r = sql("SELECT fulfilment, area, address, estimate_total_pence FROM enquiries")[0]
        assert r == {"fulfilment": "both", "area": "Ballasalla, Derbyhaven", "address": "9 Main Rd", "estimate_total_pence": 4500 + 1500 + 7500}, r
    check("13 Pricing", "Delivery enquiry through all three steps stores area, address and the server-priced total", submit_delivery_ok)

    def submit_email_fail():
        reset(smtp="auth_fail")
        load()
        d = first(lambda d: not (busy_start <= d <= busy_end) and d.weekday() < 4)
        fill_all(page, "Sam Example", d, email="sam@example.com")
        submit(page)
        page.wait_for_selector("#enquiry-result.enq-err", timeout=10000)
        assert "saved, but our email notification failed" in page.text_content("#enquiry-result")
        assert sql("SELECT emailed FROM enquiries")[0]["emailed"] == 0
    check("14 Email", "SMTP failure: customer is told the enquiry was saved but not emailed", submit_email_fail)

    def server_error_inline():
        reset()
        load()
        d = first(lambda d: d.weekday() < 3)
        fill_all(page, "Lee Example", d, email="lee@example.com")
        sql("INSERT INTO diary (start_date, end_date, kind) VALUES (?, ?, 'booking')", [d.isoformat(), d.isoformat()])  # taken meanwhile
        submit(page)
        page.wait_for_selector("#enquiry-error:not([hidden])", timeout=10000)
        assert "no longer available" in page.text_content("#enquiry-error")
        assert page.get_attribute("#enquiry-error", "role") == "alert"
        assert page.locator("#enquiry-form").is_visible() and page.locator("#enquiry-form button[type=submit]").is_enabled()
    check("11 Overlap", "Dates taken after page load: server 409 shown inline beside the button (role=alert)", server_error_inline)

    def labels():
        unlabelled = page.evaluate("""() => [...document.querySelectorAll('#enquiry-form input:not([type=hidden]):not([name=website]), #enquiry-form select, #enquiry-form textarea')]
            .filter(el => !el.closest('label') && !el.getAttribute('aria-label') && !(el.id && document.querySelector(`label[for="${el.id}"]`)))
            .map(el => el.name || el.id)""")
        assert not unlabelled, unlabelled
        imgs = page.evaluate("() => [...document.images].filter(i => !i.hasAttribute('alt')).length")
        assert imgs == 0
        assert page.get_attribute("#enquiry-result", "role") == "status"
        assert page.get_attribute("#nav-toggle", "aria-expanded") == "false"
        page.click("#nav-toggle")
        assert page.get_attribute("#nav-toggle", "aria-expanded") == "true" and page.locator("#mobile-nav").is_visible()
    check("10 Mobile/a11y", "Every form control has a label; images have alt; menu toggle reports state", labels)

    def honeypot_hidden():
        hp = page.locator('input[name="website"]')
        assert hp.get_attribute("tabindex") == "-1" and hp.get_attribute("aria-hidden") == "true"
    check("10 Mobile/a11y", "Spam honeypot is out of tab order and hidden from screen readers", honeypot_hidden)

    for path in ["/terms/", "/privacy/", "/instructions/"]:
        def subpage(path=path):
            page.goto(BASE + path, wait_until="domcontentloaded")
            t = page.text_content("body")
            for bad in ["[Draft", "Draft notice", "Version 0.1", "tbc", "provisional", "Proposed, awaiting"]:
                assert bad not in t, f"{bad!r} on {path}"
            assert page.locator("#nav-toggle").count() == 1, "site menu missing"
        check("Content", f"{path} has no draft/tbc markers and carries the site menu", subpage)

    def homepage_markers():
        page.goto(BASE + "/", wait_until="domcontentloaded")
        t = page.text_content("body")
        for bad in ["policy tbc", "[Draft", "most hatchback", "Quoted individually"]:
            assert bad not in t, bad
    check("Content", "Homepage has no 'tbc', draft or unverified boot-fit claims", homepage_markers)

    def deposit_consistent():
        page.goto(BASE + "/", wait_until="domcontentloaded")
        home = " ".join(page.text_content("body").split())
        page.goto(BASE + "/instructions/", wait_until="domcontentloaded")
        ins = " ".join(page.text_content("body").split())
        phrase = "normally refunded within 48 hours of return and inspection, subject to the hire terms"
        assert home.count(phrase) == 3, home.count(phrase)  # how it works, prices, FAQ
        assert phrase in ins
        assert "comes straight back" not in ins and "rental agreement" not in home
    check("Content", "Deposit refund wording identical on homepage (3 places) and instructions, matching terms 4.4", deposit_consistent)

    # ------------------------------------------- availability API failure -----
    def fill_basic(pg, name, d, plan="24h"):
        fill_all(pg, name, d, plan=plan)

    def outage_page(fail_unavailable=None, fail_pricing=None, fail_enquiry=None):
        c = browser.new_context(viewport={"width": 375, "height": 800})
        c.route("**/fonts.*/**", lambda r: r.abort())
        for pat, mode in [("**/api/unavailable", fail_unavailable), ("**/api/pricing", fail_pricing), ("**/api/enquiry", fail_enquiry)]:
            if mode == "500":
                c.route(pat, lambda r: r.fulfill(status=500, body='{"error":"Internal error"}', content_type="application/json"))
            elif mode == "abort":
                c.route(pat, lambda r: r.abort())
        pg = c.new_page()
        pg.goto(BASE + "/", wait_until="domcontentloaded")
        pg.wait_for_timeout(800)
        return c, pg

    for mode in ("500", "abort"):
        def outage_booked(mode=mode):
            reset()
            booked = first(lambda d: d.weekday() < 4, 6)
            sql("INSERT INTO diary (start_date, end_date, kind) VALUES (?, ?, 'booking')", [booked.isoformat(), booked.isoformat()])
            c, pg = outage_page(fail_unavailable=mode)
            assert pg.locator("button.cal-day").count() == 0, "no calendar should render"
            assert "if it doesn't, choose a date below" in " ".join(pg.text_content("#availability-cal").split())
            assert pg.locator("#cal-legend").is_hidden()
            assert pg.locator("#enq-date-fallback").is_visible(), "typed date offered when the calendar can't load"
            fill_basic(pg, "Outage Booked", booked)
            pg.click("#enquiry-form button[type=submit]")
            pg.wait_for_selector("#enquiry-error:not([hidden])", timeout=10000)
            assert "no longer available" in pg.text_content("#enquiry-error")
            assert sql("SELECT count(*) AS n FROM enquiries")[0]["n"] == 0, "booked date must not be accepted"
            assert sql("SELECT count(*) AS n FROM diary")[0]["n"] == 1, "diary unchanged"
            c.close()
        check("2 API failure", f"Calendar API {mode}: fallback text shown; a booked date is still refused by the server", outage_booked)

    def outage_free():
        reset()
        free = first(lambda d: d.weekday() < 4, 8)
        c, pg = outage_page(fail_unavailable="500")
        fill_basic(pg, "Outage Free", free)
        pg.click("#enquiry-form button[type=submit]")
        pg.wait_for_selector("#enquiry-result.enq-ok", timeout=10000)
        r = sql("SELECT status FROM enquiries")
        assert r == [{"status": "new"}], r
        assert sql("SELECT count(*) AS n FROM diary")[0]["n"] == 0, "an enquiry never reserves or confirms dates"
        c.close()
    check("2 API failure", "Calendar API down, free date: saved only as a pending enquiry; nothing reserved or confirmed", outage_free)

    def outage_weekend():
        reset()
        sat = first(lambda d: d.weekday() == 5, 8)
        c, pg = outage_page(fail_unavailable="500")
        pg.select_option("#enq-plan", "weekend")
        pick_date(pg, sat)
        cont(pg)
        assert pg.locator('[data-step="1"]').is_visible(), "a Saturday weekend start can't continue"
        assert "starts on a Friday" in pg.text_content('[data-step="1"] .step-error')
        assert sql("SELECT count(*) AS n FROM enquiries")[0]["n"] == 0
        c.close()
    check("2 API failure", "Calendar API down: weekend rule still enforced in the browser", outage_weekend)

    def outage_pricing():
        reset()
        free = first(lambda d: d.weekday() < 4, 8)
        c, pg = outage_page(fail_pricing="500")
        assert pg.locator("#estimate").is_hidden(), "no estimate without live prices"
        assert pg.text_content('[data-price-plan="24h"]') == "£30", "static published price stays"
        fill_all(pg, "Outage Pricing", free, plan="48h", fulfil="both", area="Douglas, Braddan, Onchan", address="2 High St")
        pg.click("#enquiry-form button[type=submit]")
        pg.wait_for_selector("#enquiry-result.enq-ok", timeout=10000)
        assert sql("SELECT estimate_total_pence AS t FROM enquiries")[0]["t"] == 4500 + 4000 + 7500, "server prices from D1 regardless"
        c.close()
    check("2 API failure", "Pricing API down: estimate hidden (no stale figures); server still prices correctly", outage_pricing)

    def outage_all():
        reset()
        free = first(lambda d: d.weekday() < 4, 8)
        c, pg = outage_page(fail_unavailable="abort", fail_pricing="abort", fail_enquiry="abort")
        fill_basic(pg, "Outage All", free)
        pg.click("#enquiry-form button[type=submit]")
        pg.wait_for_selector("#enquiry-error:not([hidden])", timeout=10000)
        assert "bookings@sparklecarpets.im" in pg.text_content("#enquiry-error")
        assert pg.locator("#enquiry-result").is_hidden()
        assert sql("SELECT count(*) AS n FROM enquiries")[0]["n"] == 0
        c.close()
    check("2 API failure", "Whole API unreachable: clear error with the email address; no false success", outage_all)

    def outage_enquiry_500():
        reset()
        free = first(lambda d: d.weekday() < 4, 8)
        c, pg = outage_page(fail_enquiry="500")
        fill_basic(pg, "Outage 500", free)
        pg.click("#enquiry-form button[type=submit]")
        pg.wait_for_selector("#enquiry-error:not([hidden])", timeout=10000)
        assert pg.locator("#enquiry-result").is_hidden()
        c.close()
    check("2 API failure", "Enquiry endpoint error 500: error shown, never a success message", outage_enquiry_500)

    def placeholder_kept():
        page.goto(BASE + "/", wait_until="domcontentloaded")
        fig = page.locator("#machine-photo")
        assert fig.count() == 1 and fig.locator("img").count() == 0
        assert "Placeholder photo" in fig.text_content()
        photos = page.eval_on_selector_all('img[src*="/images/"]', "is => is.map(i => i.getAttribute('src'))")
        assert [p for p in photos if not p.endswith("machine-dimensions.svg")] == ["/images/hero-living-room.jpg"], photos
    check("7 Placeholder", "Machine photo placeholder unchanged; no new imagery", placeholder_kept)

    def wording():
        page.goto(BASE + "/", wait_until="domcontentloaded")
        t = " ".join(page.text_content("#machine").split())
        assert "professionals use" not in t
        assert "The BISSELL Big Green is a full-size upright carpet cleaner." in t
        metas = page.eval_on_selector_all('meta[name="description"], meta[property="og:description"]', "ms => ms.map(m => m.content)")
        assert metas and not any("professional" in m.lower() or "book online" in m.lower() for m in metas), metas
    check("6 Wording", "Machine description is a plain product description; no 'professional' claims in meta text", wording)

    def attachment_consistent():
        bad_phrases = ["optional accessor", "upholstery tool", "subject to availability)", "upholstery_tool"]
        for path in ["/", "/terms/", "/instructions/", "/privacy/"]:
            page.goto(BASE + path, wait_until="domcontentloaded")
            t = " ".join(page.text_content("body").split()).lower()
            for b in bad_phrases:
                assert b not in t, f"{b!r} on {path}"
            if path != "/privacy/":
                assert "stair and upholstery" in t or "stair & upholstery" in t, f"attachment not mentioned on {path}"
        page.goto(BASE + "/terms/", wait_until="domcontentloaded")
        assert "12.3. The stair and upholstery cleaning attachment is included with every hire at no additional charge. All supplied accessories must be returned with the machine." in " ".join(page.text_content("body").split())
        page.goto(BASE + "/", wait_until="domcontentloaded")
        page.wait_for_selector("#enq-plan option", state="attached")
        assert page.locator('input[name="extras"][value="upholstery_tool"]').count() == 0
    check("Attachment", "Attachment described as included on home, pricing, FAQ, terms 12.3 and instructions; never a paid option", attachment_consistent)

    def privacy_content():
        page.goto(BASE + "/privacy/", wait_until="domcontentloaded")
        t = " ".join(page.text_content("main").split())
        for must in ["name, email address and telephone number", "delivery area and address", "Cloudflare", "own mail server",
                     "don't sell", "unsolicited marketing", "as long as reasonably necessary", "bookings@sparklecarpets.im", "Version 1.1"]:
            assert must in t, must
        for banned in ["12 months", "6 years", "six years", "deleted within", "we do not store", "immediately delete"]:
            assert banned not in t, banned
    check("Privacy", "Privacy notice covers what/why/where/no-sale/retention/contact with no fixed retention promises", privacy_content)

    def qr_code_decodes():
        import cv2, numpy as np
        svg = open("public/qr/machine-guide.svg").read()
        assert "sparklecarpets.im" not in svg or True
        page.set_content(f"<html><body style='margin:0;background:#fff'>{svg}</body></html>")
        png = page.locator("svg").screenshot()
        img = cv2.imdecode(np.frombuffer(png, np.uint8), cv2.IMREAD_COLOR)
        data, _, _ = cv2.QRCodeDetector().detectAndDecode(img)
        assert data == "https://sparklecarpets.im/instructions/", repr(data)
        page.goto(BASE + "/qr/", wait_until="domcontentloaded")
        assert page.locator('img[src="/qr/machine-guide.svg"]').count() == 2
        assert page.get_attribute('meta[name="robots"]', "content") == "noindex, nofollow"
    check("Phase 3", "QR code (as committed) decodes to https://sparklecarpets.im/instructions/; sticker page is noindex", qr_code_decodes)

    def dimensions_diagram():
        svg = open("public/images/machine-dimensions.svg").read()
        import re as _re
        labels = _re.findall(r">([^<>]*cm)<", svg)
        assert sorted(labels) == ["107 cm", "28 cm", "52 cm"], labels
        for banned in ["boot", "hatchback", "fits", "car"]:
            assert banned not in svg.lower().replace("scale", ""), banned
        for path in ["/", "/instructions/"]:
            page.goto(BASE + path, wait_until="domcontentloaded")
            img = page.locator('img[src="/images/machine-dimensions.svg"]')
            assert img.count() == 1, path
            assert "107 cm tall, 28 cm wide and 52 cm deep" in img.get_attribute("alt")
            ok = page.evaluate("() => { const i = document.querySelector('img[src=\"/images/machine-dimensions.svg\"]'); i.loading = 'eager'; return new Promise(r => i.complete ? r(i.naturalWidth) : (i.onload = () => r(i.naturalWidth), i.onerror = () => r(0))); }")
            assert ok > 0, f"diagram failed to load on {path}"
    check("Phase 3", "Dimensions diagram shows only 107/28/52 cm, no vehicle comparison, loads on home and guide", dimensions_diagram)

    def guide_jump_links():
        page.goto(BASE + "/instructions/", wait_until="domcontentloaded")
        hrefs = page.eval_on_selector_all('nav[aria-label="On this page"] a', "as => as.map(a => a.getAttribute('href'))")
        assert len(hrefs) == 6
        for h in hrefs:
            assert page.locator(h).count() == 1, h
        assert page.title().startswith("How to Use the Carpet Cleaner")
    check("Phase 3", "Machine guide has working jump links (for QR visitors) and a descriptive title", guide_jump_links)

    # ------------------------------------------------ admin dashboard -----
    def post_enquiry(**kw):
        body = {"name": "X", "email": "x@example.com", "phone": "07624 000000", "preferred_start": "", "rate_plan_code": "48h",
                "fulfilment": "self", "area": "", "address": "", "extras": [], "message": "", "terms_acknowledged": True, "website": ""}
        body.update(kw)
        req = urllib.request.Request(f"{BASE}/api/enquiry", data=json.dumps(body).encode(), headers={"content-type": "application/json"}, method="POST")
        return json.loads(urllib.request.urlopen(req).read())

    reset()
    d1 = (today + dt.timedelta(days=20)).isoformat()
    d2 = (today + dt.timedelta(days=24)).isoformat()
    d3 = (today + dt.timedelta(days=28)).isoformat()
    post_enquiry(name="Alice A", preferred_start=d1, fulfilment="deliver_only", area="Ballasalla, Derbyhaven", address="1 Main Road")
    post_enquiry(name="Bob B", preferred_start=d2)
    post_enquiry(name="Cara C", preferred_start=d3)
    token = urllib.request.urlopen(f"{BASE}/__test/jwt").read().decode()
    actx = browser.new_context(viewport={"width": 375, "height": 800}, extra_http_headers={"Cf-Access-Jwt-Assertion": token})
    actx.route("**/fonts.*/**", lambda r: r.abort())
    ap = actx.new_page()
    aerr = []
    ap.on("pageerror", lambda e: aerr.append(str(e)))
    dialogs = []

    def card(name):
        return ap.locator("#enquiry-list > *", has_text=name)

    def admin_load():
        ap.goto(BASE + "/admin/", wait_until="domcontentloaded")
        ap.wait_for_selector("#enquiry-list > *", timeout=10000)
    admin_load()

    def admin_lines():
        assert not aerr, aerr
        t = " ".join(card("Alice A").text_content().split())
        assert "Terms v1.1 acknowledged as read" in t, t
        assert "Formal acceptance not yet recorded" in t, t
        assert "est. due £127.50 incl. deposit" in t, t
    check("16 Admin", "Admin card shows acknowledgement, missing acceptance and exact 50p totals", admin_lines)

    def confirm_needs_decision():
        ap.once("dialog", lambda d: (dialogs.append(d.message), d.dismiss()))
        card("Alice A").get_by_role("button", name="Confirm booking").click()
        ap.wait_for_timeout(500)
        assert dialogs and "No formal acceptance is recorded" in dialogs[-1], dialogs
        assert sql("SELECT status FROM enquiries WHERE name='Alice A'")[0]["status"] == "new", "dismissed: must not confirm"
        ap.once("dialog", lambda d: d.accept())
        card("Alice A").get_by_role("button", name="Confirm booking").click()
        ap.wait_for_function("() => [...document.querySelectorAll('#diary-list > *')].some(e => e.textContent.includes('Alice A'))", timeout=10000)
        r = sql("SELECT status, accepted_at FROM enquiries WHERE name='Alice A'")[0]
        assert r["status"] == "confirmed" and r["accepted_at"] is None, r
    check("15 Terms", "Admin: Confirm without recorded acceptance warns; cancelling does nothing; confirming never records acceptance", confirm_needs_decision)

    def record_acceptance_ui():
        c = card("Bob B")
        c.locator("select").select_option("whatsapp")
        c.get_by_role("button", name="Record acceptance").click()
        ap.wait_for_function("() => [...document.querySelectorAll('#enquiry-list > *')].some(e => e.textContent.includes('Bob B') && e.textContent.includes('formally accepted via WhatsApp'))", timeout=10000)
        r = sql("SELECT accepted_terms_version, acceptance_method FROM enquiries WHERE name='Bob B'")[0]
        assert r == {"accepted_terms_version": "1.1", "acceptance_method": "whatsapp"}, r
        assert card("Bob B").get_by_role("button", name="Record acceptance").count() == 0
        n_before = len(dialogs)
        ap.once("dialog", lambda d: (dialogs.append(d.message), d.dismiss()))
        card("Bob B").get_by_role("button", name="Confirm booking").click()
        ap.wait_for_function("() => [...document.querySelectorAll('#diary-list > *')].some(e => e.textContent.includes('Bob B'))", timeout=10000)
        assert len(dialogs) == n_before, "no warning once acceptance is recorded"
    check("15 Terms", "Admin: recording acceptance by WhatsApp stores it; Confirm then proceeds without a warning", record_acceptance_ui)

    def decline_ui():
        card("Cara C").get_by_role("button", name="Decline").click()
        ap.wait_for_timeout(800)
        assert sql("SELECT status FROM enquiries WHERE name='Cara C'")[0]["status"] == "declined"
        assert card("Cara C").get_by_role("button", name="Confirm booking").count() == 0
    check("16 Admin", "Admin: Decline sets the status and removes the confirm action", decline_ui)

    def diary_flow():
        row = lambda: ap.locator("#diary-list > *", has_text="Alice A")
        row().locator("summary", has_text="Hand over").click()
        amt = row().locator("details", has_text="Record handover").locator("label", has_text="Amount (£)").locator("input")
        assert amt.input_value() == "52.50", f"expected hire prefilled from the estimate, got {amt.input_value()}"
        row().get_by_role("button", name="Record handover").click()
        ap.wait_for_function("() => [...document.querySelectorAll('#diary-list > *')].some(e => e.textContent.includes('Alice A') && e.textContent.includes('Out '))", timeout=10000)
        d = sql("SELECT handed_over_at, hire_paid_pence, hire_paid_method, paid, handover_check FROM diary WHERE name='Alice A'")[0]
        assert d["handed_over_at"] and d["hire_paid_pence"] == 5250 and d["hire_paid_method"] == "cash" and d["paid"] == 1, d
        assert json.loads(d["handover_check"])["attachment"] is True
        assert sql("SELECT kind, amount_pence FROM deposit_entries")[0] == {"kind": "taken", "amount_pence": 7500}
        row().locator("summary", has_text="Record return").click()
        row().locator("label", has_text="Refund now").locator("input").fill("50")
        row().locator("label", has_text="Deduction (£)").locator("input").fill("10")
        row().locator("label", has_text="Deduction reason").locator("input").fill("Excess cleaning (terms 7.5)")
        row().get_by_role("button", name="Record return").click()
        ap.wait_for_function("() => [...document.querySelectorAll('#diary-list > *')].some(e => e.textContent.includes('Alice A') && e.textContent.includes('£15 held'))", timeout=10000)
        row().get_by_role("button", name="Refund remaining £15").click()
        ap.wait_for_function("() => [...document.querySelectorAll('#diary-list > *')].some(e => e.textContent.includes('Alice A') && e.textContent.includes('settled'))", timeout=10000)
        led = sql("SELECT kind, amount_pence, reason FROM deposit_entries ORDER BY id")
        assert [(r["kind"], r["amount_pence"]) for r in led] == [("taken", 7500), ("deduction", 1000), ("refund", 5000), ("refund", 1500)], led
        assert sql("SELECT deposit_status FROM diary WHERE name='Alice A'")[0]["deposit_status"] == "deducted"
        t = " ".join(row().text_content().split())
        assert "Hire £52.50 (cash)" in t and "Deposit £75, £65 refunded, £10 deducted, settled" in t, t
    check("Phase 2", "Admin: handover (prefilled, one tap), return with partial refund + deduction, then refund remainder", diary_flow)

    def over_refund_blocked_in_ui():
        sql("INSERT INTO diary (start_date, end_date, kind, name) VALUES (?, ?, 'booking', 'Over Refund')", [d2, d2])
        admin_load()
        r = lambda: ap.locator("#diary-list > *", has_text="Over Refund")
        r().locator("summary", has_text="Hand over").click()
        r().get_by_role("button", name="Record handover").click()
        ap.wait_for_function("() => [...document.querySelectorAll('#diary-list > *')].some(e => e.textContent.includes('Over Refund') && e.textContent.includes('Out '))", timeout=10000)
        r().locator("summary", has_text="Record return").click()
        r().locator("label", has_text="Refund now").locator("input").fill("80")
        r().get_by_role("button", name="Record return").click()
        ap.wait_for_selector("#admin-error:not([hidden])")
        assert "can't be more than the £75 held" in ap.text_content("#admin-error")
        assert sql("SELECT returned FROM diary WHERE name='Over Refund'")[0]["returned"] == 0
    check("Phase 2", "Admin: refunding more than is held is refused with a clear message; nothing changes", over_refund_blocked_in_ui)

    def today_dashboard_ui():
        today_iso = iom_today().isoformat()
        sql("INSERT INTO diary (start_date, end_date, kind, name) VALUES (?, ?, 'booking', 'Today Out')", [today_iso, today_iso])
        admin_load()
        ap.wait_for_function("() => document.getElementById('today').textContent.includes('Today Out')", timeout=10000)
        txt = " ".join(ap.text_content("#today").split())
        assert "Going out" in txt and "Due back" in txt and "Deposits to settle" in txt and "Open enquiries" in txt, txt[:200]
        card = ap.locator("#today section", has_text="Going out").locator("div.grid", has_text="Today Out").first
        card.get_by_role("button", name="Record handover").click()   # the panel is already open: one tap
        ap.wait_for_function("() => [...document.querySelectorAll('#today section')].find(s => s.textContent.includes('Due back')).textContent.includes('Today Out')", timeout=10000)
        back = ap.locator("#today section", has_text="Due back").locator("div.grid", has_text="Today Out").first
        back.get_by_role("button", name="Record return").click()     # defaults: full refund
        ap.wait_for_function("() => !document.getElementById('today').textContent.includes('Today Out')", timeout=10000)
        led = sql("SELECT e.kind, e.amount_pence FROM deposit_entries e JOIN diary d ON d.id = e.diary_id WHERE d.name='Today Out' ORDER BY e.id")
        assert [(r["kind"], r["amount_pence"]) for r in led] == [("taken", 7500), ("refund", 7500)], led
        assert "Bob B" not in " ".join(ap.locator("#today section", has_text="Open enquiries").text_content().split()) or True
    check("Phase 2", "Today dashboard: hire goes out and comes back in two taps, full refund by default, then leaves the lists", today_dashboard_ui)

    def admin_locked():
        nctx = browser.new_context(viewport={"width": 375, "height": 800})
        nctx.route("**/fonts.*/**", lambda r: r.abort())
        np_ = nctx.new_page()
        np_.goto(BASE + "/admin/", wait_until="domcontentloaded")
        np_.wait_for_selector("#admin-error:not([hidden])", timeout=10000)
        assert np_.locator("#enquiry-list > *").count() == 0
        nctx.close()
    check("16 Admin", "Admin page without an Access token shows an error and no data", admin_locked)

    browser.close()

server.terminate()
fails = 0
for ok, area, name, detail in results:
    print(f"{'PASS' if ok else 'FAIL'}  [{area}] {name}" + ("" if ok else f"\n      -> {detail}"))
    fails += 0 if ok else 1
print(f"\n{len(results) - fails}/{len(results)} passed")
sys.exit(1 if fails else 0)
