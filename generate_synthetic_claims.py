"""
Generate synthetic member benefits claims from netForum users.

The source of truth for member identities is data-output/netForum/netForum.output.json.
Each generated member gets 5-15 claims across the current and previous plan year.
Output is written to both data-output/claims and the etl-claims-line service data
directory so the isolated claims ETL container can ingest the same data shape.
"""

import json
import os
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path


RANDOM_SEED = 7213
SOURCE_PATH = Path("data-output/netForum/netForum.output.json")
OUTPUT_DIR = Path("data-output/claims")
SERVICE_DATA_DIR = Path("services/etl-claims-line/data")

CLAIM_TYPES = [
    ("medical", ["North Ridge Medical", "Cedar Valley Clinic", "Summit Health Partners"]),
    ("dental", ["BrightPath Dental", "Harbor Dental Group", "Oak Street Dental"]),
    ("vision", ["ClearView Optometry", "Lumen Vision Center", "Northstar Eye Care"]),
    ("rx", ["WellSpring Pharmacy", "CivicCare Rx", "Greenline Pharmacy"]),
    ("mental_health", ["Balance Behavioral Health", "Renew Counseling", "Harbor Mind Clinic"]),
]
STATUSES = ["processed", "pending", "denied", "appealed"]
EVENTS_BY_STATUS = {
    "processed": ["submitted", "adjudicated", "paid"],
    "pending": ["submitted", "in_review"],
    "denied": ["submitted", "adjudicated", "denied"],
    "appealed": ["submitted", "denied", "appealed"],
}


def load_members():
    with SOURCE_PATH.open() as source:
        raw_records = json.load(source)

    members = []
    for index, record in enumerate(raw_records, start=1):
        payload = record.get("payload", record)
        email = payload.get("email")
        if not email:
            continue
        members.append({
            "memberId": f"NF-{index:06d}",
            "email": email,
            "firstName": payload.get("first_name", "Member"),
            "lastName": payload.get("last_name", str(index)),
            "type": payload.get("type", "member"),
        })
    return members


def iso_date(dt):
    return dt.date().isoformat()


def iso_timestamp(dt):
    return dt.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def currency(amount):
    return round(amount, 2)


def generate_claims(members):
    rng = random.Random(RANDOM_SEED)
    now = datetime.now(timezone.utc)
    current_year = now.year
    claims = []
    logs = []

    for member in members:
        claim_count = rng.randint(5, 15)
        for sequence in range(1, claim_count + 1):
            claim_type, providers = rng.choice(CLAIM_TYPES)
            service_date = now - timedelta(days=rng.randint(5, 700))
            plan_year = service_date.year if service_date.year in (current_year, current_year - 1) else current_year - 1
            provider = rng.choice(providers)
            status = rng.choices(STATUSES, weights=[64, 18, 12, 6], k=1)[0]
            amount_billed = currency(rng.uniform(45, 4200))
            paid_factor = {
                "processed": rng.uniform(0.55, 0.92),
                "pending": 0,
                "denied": 0,
                "appealed": rng.uniform(0, 0.35),
            }[status]
            amount_paid = currency(amount_billed * paid_factor)
            claim_id = f"CLM-{member['memberId']}-{sequence:03d}"

            claims.append({
                "memberId": member["memberId"],
                "memberEmail": member["email"],
                "claimId": claim_id,
                "claimType": claim_type,
                "serviceDate": iso_date(service_date),
                "provider": provider,
                "amountBilled": amount_billed,
                "amountPaid": amount_paid,
                "planYear": plan_year,
                "status": status,
            })

            event_time = service_date + timedelta(days=1)
            for event in EVENTS_BY_STATUS[status]:
                notes = f"{claim_type.replace('_', ' ').title()} claim {event.replace('_', ' ')} by {provider}."
                logs.append({
                    "logTimestamp": iso_timestamp(event_time),
                    "memberId": member["memberId"],
                    "memberEmail": member["email"],
                    "claimId": claim_id,
                    "eventType": event,
                    "notes": notes,
                })
                event_time += timedelta(days=rng.randint(1, 12))

    return claims, logs


def write_json(path, records):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w") as target:
        json.dump(records, target, indent=2)
        target.write("\n")


def main():
    if not SOURCE_PATH.exists():
        raise SystemExit(f"Missing source file: {SOURCE_PATH}")

    members = load_members()
    limit = os.environ.get("CLAIMS_MEMBER_LIMIT")
    if limit:
        members = members[: int(limit)]

    claims, logs = generate_claims(members)
    write_json(OUTPUT_DIR / "claims.output.json", claims)
    write_json(OUTPUT_DIR / "claims-logs.output.json", logs)
    write_json(SERVICE_DATA_DIR / "primary.json", claims)
    write_json(SERVICE_DATA_DIR / "logs.json", logs)
    print(f"Generated {len(claims)} claims and {len(logs)} log events from {len(members)} netForum members.")


if __name__ == "__main__":
    main()
