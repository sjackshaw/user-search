"""
Seed script: populates source_change_logs and etl_job_logs with realistic
synthetic historical data so the GenAI service has meaningful context to work
with from day one.

Writes a SQL file (seed_change_logs.sql) that is then applied via docker exec.

Run once before deploying the GenAI service:
    python3 seed_change_logs.py
    docker exec -i user-search-postgres-1 psql -U postgres -d appdb < seed_change_logs.sql
"""

import json, random, re
from datetime import datetime, timedelta

random.seed(99)

# ── Load source data to sample realistic emails / values ──────────────────────
ad_data   = json.load(open("services/etl-ad-line/data/primary.json"))
nf_data   = json.load(open("services/etl-netforum-line/data/primary.json"))
eu_data   = json.load(open("services/etl-eu-line/data/primary.json"))
dg_data   = json.load(open("services/etl-dg-line/data/primary.json"))

ad_users  = [p for p in ad_data if p.get("type") == "user"]
ad_names  = [f"{u['first_name']} {u['last_name']}" for u in ad_users]

first_names = ["James","Mary","John","Patricia","Robert","Jennifer","Michael","Linda",
               "David","Elizabeth","Richard","Susan","Joseph","Jessica","Thomas","Sarah",
               "Aisha","Omar","Priya","Raj","Yuki","Kenji","Fatima","Lena","Sofia"]
last_names  = ["Smith","Johnson","Williams","Brown","Jones","Garcia","Miller","Davis",
               "Hernandez","Lopez","Gonzalez","Wilson","Anderson","Thomas","Taylor",
               "Patel","Kumar","Singh","Nakamura","Yamamoto","Hassan","Park","Okafor"]

def rand_name():
    return f"{random.choice(first_names)} {random.choice(last_names)}"

def rand_dt(start_days_ago=420, end_days_ago=1):
    """Return a random TIMESTAMPTZ string between start and end days ago."""
    start = datetime.utcnow() - timedelta(days=start_days_ago)
    end   = datetime.utcnow() - timedelta(days=end_days_ago)
    delta = (end - start).total_seconds()
    t = start + timedelta(seconds=random.random() * delta)
    return t.strftime("%Y-%m-%d %H:%M:%S+00")

def rand_dt_recent():
    """Last 60 days — makes 'what changed last week?' queries hit."""
    return rand_dt(60, 0)

def esc(v):
    """Escape single quotes for SQL."""
    if v is None:
        return "NULL"
    return "'" + str(v).replace("'", "''") + "'"

# ── ETL job ID pool (IDs 1-16 exist) ─────────────────────────────────────────
EXISTING_JOB_IDS = list(range(1, 17))

rows_change  = []   # (source_table, email, change_type, field_name, old_value, new_value, detected_at, etl_job_id)
rows_etl_job = []   # (service, phase, target_table, status, processed, created, updated, deleted, error, started, finished)

# ─────────────────────────────────────────────────────────────────────────────
# source_change_logs — active_directory
# ─────────────────────────────────────────────────────────────────────────────
ad_emails = [p["email"] for p in ad_data]

# 500 creates (spread over 14 months)
for email in random.sample(ad_emails, 500):
    rows_change.append(("active_directory", email, "created", None, None, None, rand_dt(), random.choice(EXISTING_JOB_IDS)))

# 800 field-level updates (6 fields, recent dates so they show up in week queries)
ad_update_fields = {
    "enabled":           (["true"], ["false", "true"]),
    "locked":            (["false"], ["true", "false"]),
    "type":              (["user"], ["contact", "user"]),
    "passwordlastreset": (None, None),    # handled inline
    "first_name":        (None, None),
    "last_name":         (None, None),
}
for _ in range(800):
    email = random.choice(ad_emails)
    field = random.choice(list(ad_update_fields.keys()))
    if field == "passwordlastreset":
        old_val = rand_dt(730, 90)
        new_val = rand_dt(89, 1)
    elif field in ("first_name", "last_name"):
        old_val = random.choice(first_names if field == "first_name" else last_names)
        new_val = random.choice(first_names if field == "first_name" else last_names)
        while new_val == old_val:
            new_val = random.choice(first_names if field == "first_name" else last_names)
    else:
        old_list, new_list = ad_update_fields[field]
        old_val = random.choice(old_list)
        new_val = random.choice(new_list)
        while new_val == old_val:
            new_val = random.choice(new_list)
    dt = rand_dt_recent() if random.random() < 0.35 else rand_dt()
    rows_change.append(("active_directory", email, "updated", field, old_val, new_val, dt, random.choice(EXISTING_JOB_IDS)))

# 200 deletes
for email in random.sample(ad_emails, 200):
    rows_change.append(("active_directory", email, "deleted", None, None, None, rand_dt(), random.choice(EXISTING_JOB_IDS)))

# ─────────────────────────────────────────────────────────────────────────────
# source_change_logs — netforum_members
# ─────────────────────────────────────────────────────────────────────────────
nf_emails = [p["email"] for p in nf_data]

for email in random.sample(nf_emails, 150):
    rows_change.append(("netforum_members", email, "created", None, None, None, rand_dt(), random.choice(EXISTING_JOB_IDS)))

nf_update_fields = ["enabled", "last_login", "type", "first_name", "last_name"]
for _ in range(300):
    email = random.choice(nf_emails)
    field = random.choice(nf_update_fields)
    if field == "enabled":
        old_val, new_val = "true", "false"
        if random.random() > 0.5:
            old_val, new_val = new_val, old_val
    elif field == "last_login":
        old_val = rand_dt(730, 91)
        new_val = rand_dt(90, 1)
    elif field == "type":
        old_val, new_val = "member", "fellow"
        if random.random() > 0.5:
            old_val, new_val = new_val, old_val
    elif field == "first_name":
        old_val = random.choice(first_names)
        new_val = random.choice([n for n in first_names if n != old_val])
    else:
        old_val = random.choice(last_names)
        new_val = random.choice([n for n in last_names if n != old_val])
    dt = rand_dt_recent() if random.random() < 0.35 else rand_dt()
    rows_change.append(("netforum_members", email, "updated", field, old_val, new_val, dt, random.choice(EXISTING_JOB_IDS)))

for email in random.sample(nf_emails, 75):
    rows_change.append(("netforum_members", email, "deleted", None, None, None, rand_dt(), random.choice(EXISTING_JOB_IDS)))

# ─────────────────────────────────────────────────────────────────────────────
# source_change_logs — external_users
# ─────────────────────────────────────────────────────────────────────────────
eu_emails = [p["email"] for p in eu_data]
eu_sponsors = list({p["sponsor"] for p in eu_data})

for email in random.sample(eu_emails, 150):
    rows_change.append(("external_users", email, "created", None, None, None, rand_dt(), random.choice(EXISTING_JOB_IDS)))

eu_update_fields = ["enabled", "sponsor", "type", "first_name", "last_name"]
for _ in range(300):
    email = random.choice(eu_emails)
    field = random.choice(eu_update_fields)
    if field == "enabled":
        old_val, new_val = "true", "false"
        if random.random() > 0.5:
            old_val, new_val = new_val, old_val
    elif field == "sponsor":
        old_val = random.choice(eu_sponsors)
        new_val = random.choice([s for s in eu_sponsors if s != old_val])
    elif field == "type":
        old_val, new_val = "external-user", "contractor"
        if random.random() > 0.5:
            old_val, new_val = new_val, old_val
    elif field == "first_name":
        old_val = random.choice(first_names)
        new_val = random.choice([n for n in first_names if n != old_val])
    else:
        old_val = random.choice(last_names)
        new_val = random.choice([n for n in last_names if n != old_val])
    dt = rand_dt_recent() if random.random() < 0.35 else rand_dt()
    rows_change.append(("external_users", email, "updated", field, old_val, new_val, dt, random.choice(EXISTING_JOB_IDS)))

for email in random.sample(eu_emails, 75):
    rows_change.append(("external_users", email, "deleted", None, None, None, rand_dt(), random.choice(EXISTING_JOB_IDS)))

# ─────────────────────────────────────────────────────────────────────────────
# source_change_logs — distribution_groups (supplement existing 1000)
# ─────────────────────────────────────────────────────────────────────────────
dg_emails = [g["email"] for g in dg_data]
dg_names  = [g["name"] for g in dg_data]

for email in random.sample(dg_emails, 75):
    rows_change.append(("distribution_groups", email, "created", None, None, None, rand_dt(), random.choice(EXISTING_JOB_IDS)))

for _ in range(150):
    email = random.choice(dg_emails)
    field = random.choice(["name", "alias", "contacts"])
    if field == "name":
        old_val = random.choice(dg_names)
        new_val = old_val + " (Renamed)"
    elif field == "alias":
        old_val = re.sub(r"[^a-z0-9]+", "-", random.choice(dg_names).lower()).strip("-")
        new_val = old_val + "-v2"
    else:
        n = random.randint(1, 4)
        old_val = json.dumps([{"email": random.choice(ad_emails)}])
        new_val = json.dumps([{"email": random.choice(ad_emails)} for _ in range(n)])
    dt = rand_dt_recent() if random.random() < 0.35 else rand_dt()
    rows_change.append(("distribution_groups", email, "updated", field, old_val, new_val, dt, random.choice(EXISTING_JOB_IDS)))

for email in random.sample(dg_emails, 50):
    rows_change.append(("distribution_groups", email, "deleted", None, None, None, rand_dt(), random.choice(EXISTING_JOB_IDS)))

# ─────────────────────────────────────────────────────────────────────────────
# etl_job_logs — additional historical runs including failures
# ─────────────────────────────────────────────────────────────────────────────
services = [
    ("etl-ad-line",       "primary", "active_directory",             6000),
    ("etl-ad-line",       "logs",    "active_directory_activity_logs", 3000),
    ("etl-netforum-line", "primary", "netforum_members",              1000),
    ("etl-netforum-line", "logs",    "netforum_activity_logs",        2000),
    ("etl-eu-line",       "primary", "external_users",                1000),
    ("etl-eu-line",       "logs",    "external_user_activity_logs",   2000),
    ("etl-dg-line",       "primary", "distribution_groups",            500),
    ("etl-dg-line",       "logs",    "distribution_group_sync_logs",  1500),
]

error_messages = [
    "Connection timeout after 30000ms while fetching source data.",
    "ECONNREFUSED: Unable to reach source API endpoint.",
    "JSON parse error: unexpected token at position 0 in response body.",
    "pgvector embedding model failed to load: CUDA out of memory.",
    "Postgres pool exhausted: all 10 connections in use after 5000ms.",
    "Source data file not found: /data/primary.json (stale mount?).",
    "SSL certificate verification failed for source endpoint.",
    "Rate limit exceeded: 429 Too Many Requests from upstream AD API.",
]

# Generate 40 historical completed runs spread over the last 14 months
for _ in range(40):
    svc, phase, tbl, base_count = random.choice(services)
    started = datetime.utcnow() - timedelta(days=random.randint(3, 400),
                                            hours=random.randint(0, 23),
                                            minutes=random.randint(0, 59))
    duration = timedelta(seconds=random.randint(10, 90))
    finished = started + duration
    processed = base_count + random.randint(-50, 50)
    created   = random.randint(0, 30)
    updated   = random.randint(0, 80)
    deleted   = random.randint(0, 15)
    rows_etl_job.append((svc, phase, tbl, "completed", processed, created, updated, deleted,
                         None, started.strftime("%Y-%m-%d %H:%M:%S+00"),
                         finished.strftime("%Y-%m-%d %H:%M:%S+00")))

# Generate 12 historical failed runs
for _ in range(12):
    svc, phase, tbl, _ = random.choice(services)
    started = datetime.utcnow() - timedelta(days=random.randint(2, 350),
                                            hours=random.randint(0, 23))
    duration = timedelta(seconds=random.randint(1, 15))
    finished = started + duration
    error = random.choice(error_messages)
    rows_etl_job.append((svc, phase, tbl, "failed", 0, 0, 0, 0,
                         error, started.strftime("%Y-%m-%d %H:%M:%S+00"),
                         finished.strftime("%Y-%m-%d %H:%M:%S+00")))

# ─────────────────────────────────────────────────────────────────────────────
# Write SQL
# ─────────────────────────────────────────────────────────────────────────────
lines = [
    "-- Auto-generated seed data for GenAI service context.",
    "-- Produced by seed_change_logs.py",
    "BEGIN;",
    "",
]

# etl_job_logs
lines.append("-- ── Additional historical etl_job_logs ─────────────────────────────────────")
for (svc, phase, tbl, status, processed, created, updated, deleted, error, started, finished) in rows_etl_job:
    lines.append(
        f"INSERT INTO etl_job_logs "
        f"(service, phase, target_table, status, records_processed, records_created, records_updated, records_deleted, error_message, started_at, finished_at) VALUES "
        f"({esc(svc)}, {esc(phase)}, {esc(tbl)}, {esc(status)}, {processed}, {created}, {updated}, {deleted}, {esc(error)}, {esc(started)}, {esc(finished)});"
    )

lines.append("")
lines.append("-- ── source_change_logs ──────────────────────────────────────────────────────")

for (source_table, email, change_type, field_name, old_value, new_value, detected_at, etl_job_id) in rows_change:
    fn = esc(field_name)
    ov = esc(old_value)
    nv = esc(new_value)
    lines.append(
        f"INSERT INTO source_change_logs "
        f"(source_table, email, change_type, field_name, old_value, new_value, detected_at, etl_job_id) VALUES "
        f"({esc(source_table)}, {esc(email)}, {esc(change_type)}, {fn}, {ov}, {nv}, {esc(detected_at)}, {etl_job_id});"
    )

lines.append("")
lines.append("COMMIT;")

with open("seed_change_logs.sql", "w") as f:
    f.write("\n".join(lines))

total_change = len(rows_change)
total_etl    = len(rows_etl_job)
print(f"SQL written to seed_change_logs.sql")
print(f"  source_change_logs rows : {total_change:,}")
print(f"  etl_job_logs rows       : {total_etl}")

# Breakdown
from collections import Counter
ct = Counter((r[0], r[2]) for r in rows_change)
print("\nsource_change_logs breakdown:")
for (tbl, ctype), n in sorted(ct.items()):
    print(f"  {tbl:30s}  {ctype:10s}  {n:4d}")
