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

    def client_overlap():
        page.select_option("#enq-plan", "48h")
        day_before = busy_start - dt.timedelta(days=1)
        page.click(f'button.cal-day[data-iso="{day_before}"]')
        assert page.input_value("#enq-start") == day_before.isoformat()
        assert page.locator("#est-conflict").is_visible(), "conflict notice should show"
        assert page.locator("#enquiry-form button[type=submit]").is_disabled()
        page.select_option("#enq-plan", "24h")  # now only the free day
        assert not page.locator("#est-conflict").is_visible()
        assert page.locator("#enquiry-form button[type=submit]").is_enabled()
    check("11 Overlap", "Client blocks a span that runs into a booked day, and clears when it no longer does", client_overlap)

    def weekend_client():
        page.select_option("#enq-plan", "weekend")
        days = page.locator("button.cal-day.cal-free")
        enabled_non_friday = page.evaluate(
            """() => [...document.querySelectorAll('button.cal-day.cal-free')]
                 .filter(b => !b.disabled && new Date(b.dataset.iso + 'T12:00:00Z').getUTCDay() !== 5).length"""
        )
        assert enabled_non_friday == 0, f"{enabled_non_friday} non-Friday days still clickable"
        sat = first(lambda d: d.weekday() == 5 and not (busy_start <= d <= busy_end))
        page.fill("#enq-start", sat.isoformat())
        page.dispatch_event("#enq-start", "change")
        assert "starts on a Friday" in page.text_content("#enq-span")
        assert page.locator("#enquiry-form button[type=submit]").is_disabled()
        fri = first(lambda d: d.weekday() == 4 and not any(busy_start <= d + dt.timedelta(days=k) <= busy_end for k in range(4)))
        page.click(f'button.cal-day[data-iso="{fri}"]')
        mon = fri + dt.timedelta(days=3)
        note = page.text_content("#enq-span")
        assert "Collect Friday, return Monday morning" in note, note
        assert page.locator(f'button.cal-day[data-iso="{mon}"]').get_attribute("class").count("cal-sel") == 1 or mon.month not in (today.month, (today.month % 12) + 1)
    check("12 Weekend/TZ", "Weekend: only Fridays selectable; a typed Saturday is blocked; span shows Fri-Mon", weekend_client)

    def estimate_matrix():
        plans = {"24h": 30, "48h": 45, "weekend": 55, "3day": 60, "week": 95}
        zones = [("Castletown", 5), ("Ballasalla, Derbyhaven", 7.5), ("Douglas, Braddan, Onchan", 20), ("Ramsey, Andreas, Jurby", 40)]
        fri = first(lambda d: d.weekday() == 4 and not any(busy_start <= d + dt.timedelta(days=k) <= busy_end for k in range(4)))
        page.click(f'button.cal-day[data-iso="{fri}"]') if page.locator(f'button.cal-day[data-iso="{fri}"]').is_enabled() else None
        def money(v):
            return f"£{v:.2f}" if v % 1 else f"£{int(v)}"
        checked = 0
        for plan, hire in plans.items():
            page.select_option("#enq-plan", plan)
            page.fill("#enq-start", fri.isoformat()); page.dispatch_event("#enq-start", "change")
            for ful, mult in [("self", 0), ("deliver_only", 1), ("collect_only", 1), ("both", 2)]:
                page.select_option("#enq-fulfilment", ful)
                for area, one in (zones if mult else [("", 0)]):
                    if area:
                        page.select_option("#enq-area", area)
                    for extra in (False, True):
                        page.set_checked('input[name="extras"][value="solution"]', extra)
                        transport = one * mult
                        due = hire + transport + (5 if extra else 0) + 75
                        assert page.text_content("#est-hire") == money(hire), (plan, page.text_content("#est-hire"))
                        assert page.text_content("#est-deposit") == "£75"
                        assert page.text_content("#est-due") == money(due), (plan, ful, area, extra, page.text_content("#est-due"))
                        assert page.text_content("#est-eff") == money(due - 75)
                        if mult:
                            assert page.text_content("#est-transport") == money(transport), (ful, area)
                        else:
                            assert not page.locator("#est-transport-row").is_visible()
                        rows = page.locator("#est-extras > div")
                        assert rows.count() == (1 if extra else 0)
                        if extra:
                            assert "Additional detergent portion" in rows.first.text_content() and "£5" in rows.first.text_content()
                        checked += 1
        page.set_checked('input[name="extras"][value="solution"]', False)
        page.select_option("#enq-fulfilment", "self")
        assert checked == 5 * (2 + 3 * 4 * 2), checked
    check("13 Pricing", "Live estimate: every package x transport option (4 zones each) x extras, itemised", estimate_matrix)

    def other_area():
        page.select_option("#enq-fulfilment", "both")
        opts = page.eval_on_selector_all("#enq-area option", "os => os.map(o => o.value)")
        assert "__other" in opts, f"'Other location' option missing after prices load: {opts}"
        page.select_option("#enq-area", "__other")
        assert page.locator("#enq-other").is_visible()
        assert page.text_content("#est-transport") == "To be quoted"
        assert page.text_content("#est-due") == "To be quoted"
        page.select_option("#enq-fulfilment", "self")
    check("13 Pricing", "'Other location' stays available after live prices load and shows 'To be quoted'", other_area)

    def estimate_fits_mobile():
        page.select_option("#enq-fulfilment", "both")
        page.select_option("#enq-area", "__other")
        box = page.eval_on_selector("#estimate", "e => ({sw: e.scrollWidth, cw: e.clientWidth})")
        page.select_option("#enq-fulfilment", "self")
        assert box["sw"] <= box["cw"], box
    # (layout depends on Tailwind classes that aren't compiled here; recorded as not testable below)

    def validation():
        reset()
        load()
        before = sql("SELECT count(*) AS n FROM enquiries")[0]["n"]
        page.click("#enquiry-form button[type=submit]")
        page.wait_for_timeout(300)
        invalid = page.evaluate("() => [...document.querySelectorAll('#enquiry-form :invalid')].map(e => e.name)")
        assert "name" in invalid and "terms_acknowledged" in invalid, invalid
        assert sql("SELECT count(*) AS n FROM enquiries")[0]["n"] == before, "nothing should be sent"
        page.fill('input[name="name"]', "Pat Example")
        page.fill('input[name="phone"]', "07624 000000")
        page.fill('input[name="email"]', "not-an-email")
        d = first(lambda d: not (busy_start <= d <= busy_end + dt.timedelta(days=2)) and d.weekday() < 4)
        page.fill("#enq-start", d.isoformat()); page.dispatch_event("#enq-start", "change")
        page.select_option("#enq-plan", "24h")
        page.check('input[name="terms_acknowledged"]')
        page.click("#enquiry-form button[type=submit]")
        page.wait_for_timeout(300)
        assert page.evaluate("() => document.querySelector('input[name=email]').matches(':invalid')")
        assert sql("SELECT count(*) AS n FROM enquiries")[0]["n"] == before
    check("10 Mobile/a11y", "Validation: empty/invalid fields and unticked terms are caught in the browser; nothing sent", validation)

    def unchecked_terms_named():
        lab = page.locator('label:has(input[name="terms_acknowledged"])').text_content()
        assert "I confirm that I have read the proposed Equipment Hire Terms & Conditions." in " ".join(lab.split()), lab
        assert page.locator('label:has(input[name="terms_acknowledged"]) a[href="/terms/"]').count() == 1
        body = page.text_content("#enquiry-form")
        assert "Submitting an enquiry does not create a confirmed booking or an obligation to pay." in " ".join(body.split())
    check("15 Terms", "Acknowledgement checkbox wording, link and no-obligation line are as specified", unchecked_terms_named)

    def submit_ok():
        page.fill('input[name="email"]', "pat@example.com")
        page.click("#enquiry-form button[type=submit]")
        page.wait_for_selector("#enquiry-result.enq-ok", timeout=10000)
        rows = sql("SELECT name, email, rate_plan_code, terms_version, emailed, estimate_total_pence FROM enquiries")
        assert len(rows) == 1 and rows[0]["name"] == "Pat Example" and rows[0]["terms_version"] == "1.1" and rows[0]["emailed"] == 1, rows
        assert rows[0]["estimate_total_pence"] == 3000 + 7500
        msgs = json.loads(urllib.request.urlopen(f"{BASE}/__test/smtp").read())
        assert len(msgs) == 2, msgs
        focused = page.evaluate("() => document.activeElement && document.activeElement.id")
        assert focused == "enquiry-result", focused
    check("14 Email", "Browser submission persists to D1, sends both emails, success message gets focus", submit_ok)

    def submit_email_fail():
        reset(smtp="auth_fail")
        load()
        page.fill('input[name="name"]', "Sam Example"); page.fill('input[name="phone"]', "07624 111111"); page.fill('input[name="email"]', "sam@example.com")
        d = first(lambda d: not (busy_start <= d <= busy_end) and d.weekday() < 4)
        page.fill("#enq-start", d.isoformat()); page.dispatch_event("#enq-start", "change")
        page.select_option("#enq-plan", "24h")
        page.check('input[name="terms_acknowledged"]')
        page.click("#enquiry-form button[type=submit]")
        page.wait_for_selector("#enquiry-result.enq-err", timeout=10000)
        assert "saved, but our email notification failed" in page.text_content("#enquiry-result")
        assert sql("SELECT emailed FROM enquiries")[0]["emailed"] == 0
    check("14 Email", "SMTP failure: customer is told the enquiry was saved but not emailed", submit_email_fail)

    def server_error_inline():
        reset()
        load()
        d = first(lambda d: d.weekday() < 3)
        page.fill('input[name="name"]', "Lee Example"); page.fill('input[name="phone"]', "07624 222222"); page.fill('input[name="email"]', "lee@example.com")
        page.select_option("#enq-plan", "24h")
        page.fill("#enq-start", d.isoformat()); page.dispatch_event("#enq-start", "change")
        page.check('input[name="terms_acknowledged"]')
        sql("INSERT INTO diary (start_date, end_date, kind) VALUES (?, ?, 'booking')", [d.isoformat(), d.isoformat()])  # taken meanwhile
        page.click("#enquiry-form button[type=submit]")
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
        pg.fill('input[name="name"]', name); pg.fill('input[name="phone"]', "07624 333333"); pg.fill('input[name="email"]', "f@example.com")
        pg.select_option("#enq-plan", plan)
        pg.fill("#enq-start", d.isoformat()); pg.dispatch_event("#enq-start", "change")
        pg.check('input[name="terms_acknowledged"]')

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
            assert "if it doesn't, just send the enquiry" in " ".join(pg.text_content("#availability-cal").split())
            assert pg.locator("#cal-legend").is_hidden()
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
        fill_basic(pg, "Outage Weekend", sat, plan="weekend")
        assert pg.locator("#enquiry-form button[type=submit]").is_disabled()
        assert sql("SELECT count(*) AS n FROM enquiries")[0]["n"] == 0
        c.close()
    check("2 API failure", "Calendar API down: weekend rule still enforced in the browser", outage_weekend)

    def outage_pricing():
        reset()
        free = first(lambda d: d.weekday() < 4, 8)
        c, pg = outage_page(fail_pricing="500")
        assert pg.locator("#estimate").is_hidden(), "no estimate without live prices"
        assert pg.text_content('[data-price-plan="24h"]') == "£30", "static published price stays"
        fill_basic(pg, "Outage Pricing", free, plan="48h")
        pg.select_option("#enq-fulfilment", "both"); pg.select_option("#enq-area", "Douglas, Braddan, Onchan"); pg.fill('input[name="address"]', "2 High St")
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
        assert page.locator('img[src*="/images/"]').count() == 1, "only the existing hero photo"
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
        row = ap.locator("#diary-list > *", has_text="Alice A")
        row.get_by_role("button", name="Payment received").click()
        ap.wait_for_function("() => [...document.querySelectorAll('#diary-list > *')].some(e => e.textContent.includes('Alice A') && e.textContent.includes('Paid'))", timeout=10000)
        ap.locator("#diary-list > *", has_text="Alice A").get_by_role("button", name="Mark returned").click()
        ap.wait_for_function("() => [...document.querySelectorAll('#diary-list > *')].some(e => e.textContent.includes('Alice A') && e.textContent.includes('Returned'))", timeout=10000)
        r = sql("SELECT paid, returned, deposit_status FROM diary WHERE name='Alice A'")[0]
        assert r == {"paid": 1, "returned": 1, "deposit_status": "held"}, r
        ap.locator("#diary-list > *", has_text="Alice A").get_by_role("button", name="Deposit refunded").click()
        ap.wait_for_timeout(800)
        assert sql("SELECT deposit_status FROM diary WHERE name='Alice A'")[0]["deposit_status"] == "refunded"
        acts = " ".join(ap.text_content("#activity-list").split())
        assert "diary.deposit" in acts or "deposit" in acts.lower(), acts[:200]
    check("16 Admin", "Admin: payment, return and deposit refund recorded as separate steps (deposit untouched by return)", diary_flow)

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
