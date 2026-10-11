"""Runs the exact retention SQL from OPERATIONS.md against the real migrations
with seeded data, and checks what is deleted and what survives.
Run: python3 tests/retention_test.py"""
import glob
import re
import sqlite3
import sys

db = sqlite3.connect(":memory:")
db.execute("PRAGMA foreign_keys = ON")  # D1 enforces foreign keys
for f in sorted(glob.glob("db/migrations/0*.sql")):
    db.executescript(open(f).read())

ops = open("OPERATIONS.md").read()
block = re.search(r"## Data housekeeping.*?```sql\n(.*?)```", ops, re.S).group(1)


def enq(name, status, created):
    cur = db.execute(
        "INSERT INTO enquiries (name,email,phone,preferred_start,rate_plan_code,fulfilment,extras,estimate_total_pence,status,created_at,email_error)"
        " VALUES (?,?,?,?,?,?,?,?,?,datetime('now',?),?)",
        (name, f"{name}@example.com", "07624", "2020-01-01", "48h", "self", "[]", 12000, status, created, f"550 <{name}@example.com> rejected"),
    )
    db.execute("INSERT INTO audit_log (actor, action, entity, entity_id, detail) VALUES ('a','enquiry.resend_email','enquiry',?, ?)",
               (cur.lastrowid, f"550 <{name}@example.com> rejected"))
    return cur.lastrowid


def diary(enquiry_id, name, end_offset):
    cur = db.execute("INSERT INTO diary (start_date,end_date,kind,name,enquiry_id) VALUES (date('now',?),date('now',?),'booking',?,?)",
                     (end_offset, end_offset, name, enquiry_id))
    db.execute("INSERT INTO audit_log (actor, action, entity, entity_id) VALUES ('a','diary.add','diary',?)", (cur.lastrowid,))
    return cur.lastrowid


# Unsuccessful enquiries
enq("new_9m", "new", "-9 months")            # keep (under cut-off)
enq("new_11m", "new", "-11 months")          # delete
enq("declined_13m", "declined", "-13 months")  # delete
enq("replied_2y", "replied", "-2 years")       # delete
# Confirmed hires
h1 = enq("hire_5y", "confirmed", "-5 years"); diary(h1, "hire_5y", "-5 years")               # keep
h2 = enq("hire_7y", "confirmed", "-7 years"); diary(h2, "hire_7y", "-7 years")               # delete both
h3 = enq("hire_6y_ended_5y", "confirmed", "-6 years", ) ; diary(h3, "hire_6y_ended_5y", "-5 years")  # keep: hire ended < 6y ago
h4 = enq("confirmed_no_diary_7y", "confirmed", "-7 years")    # diary removed by hand: delete
# Edge: confirmed then marked closed (API allows it) and still in the diary
h5 = enq("closed_with_diary_2y", "closed", "-2 years"); diary(h5, "closed_with_diary_2y", "-2 years")  # keep: it's a hire
db.commit()

db.executescript(block)  # raises on any FK violation, like the D1 Console would

names = {r[0] for r in db.execute("SELECT name FROM enquiries")}
dnames = {r[0] for r in db.execute("SELECT name FROM diary")}
audit_left = [r[0] for r in db.execute("SELECT detail FROM audit_log WHERE detail IS NOT NULL")]

checks = [
    ("enquiry under 10 months kept", "new_9m" in names),
    ("unsuccessful enquiries past cut-off deleted", not ({"new_11m", "declined_13m", "replied_2y"} & names)),
    ("hire within 6 years kept (enquiry + diary)", "hire_5y" in names and "hire_5y" in dnames),
    ("hire over 6 years deleted (enquiry + diary)", "hire_7y" not in names and "hire_7y" not in dnames),
    ("6 years counted from hire end, not enquiry date", "hire_6y_ended_5y" in names),
    ("confirmed enquiry whose diary entry was removed is deleted after 6 years", "confirmed_no_diary_7y" not in names),
    ("enquiry still referenced by the diary is not deleted (no FK failure)", "closed_with_diary_2y" in names),
    ("audit entries for deleted records removed (no stray customer emails)",
     not any(n in d for d in audit_left for n in ["new_11m", "declined_13m", "replied_2y", "hire_7y", "confirmed_no_diary_7y"])),
    ("audit entries for kept records retained", any("new_9m" in d for d in audit_left)),
]
fails = 0
for name, ok in checks:
    print(("PASS  " if ok else "FAIL  ") + name)
    fails += not ok
print(f"\n{len(checks) - fails}/{len(checks)} passed")
sys.exit(1 if fails else 0)
