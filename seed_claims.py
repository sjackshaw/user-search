"""
Load synthetic claims JSON into the local Postgres claims table.

Default flow:
    python3 seed_claims.py
    docker exec -i user-search-postgres-1 psql -U postgres -d appdb < seed_claims.sql

Use --apply to run the generated SQL against the local Postgres container.
"""

import argparse
import json
import subprocess
from pathlib import Path


CLAIMS_PATH = Path("data-output/claims/claims.output.json")
SQL_PATH = Path("seed_claims.sql")


def sql_string(value):
    if value is None:
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"


def sql_number(value):
    if value is None:
        return "NULL"
    return str(value)


def render_sql(claims):
    lines = [
        "BEGIN;",
        "TRUNCATE TABLE claims RESTART IDENTITY;",
    ]
    for claim in claims:
        values = [
            sql_string(claim["memberId"]),
            sql_string(claim["memberEmail"]),
            sql_string(claim["claimId"]),
            sql_string(claim["claimType"]),
            sql_string(claim["serviceDate"]),
            sql_string(claim["provider"]),
            sql_number(claim["amountBilled"]),
            sql_number(claim["amountPaid"]),
            sql_number(claim["planYear"]),
            sql_string(claim["status"]),
        ]
        lines.append(
            "INSERT INTO claims (member_id, member_email, claim_id, claim_type, service_date, provider, "
            "amount_billed, amount_paid, plan_year, status) VALUES ("
            + ", ".join(values)
            + ") ON CONFLICT (claim_id) DO NOTHING;"
        )
    lines.append("COMMIT;")
    return "\n".join(lines) + "\n"


def apply_sql(sql_path):
    with sql_path.open("rb") as sql_file:
        subprocess.run(
            ["docker", "exec", "-i", "user-search-postgres-1", "psql", "-U", "postgres", "-d", "appdb", "-v", "ON_ERROR_STOP=1"],
            stdin=sql_file,
            check=True,
        )


def main():
    parser = argparse.ArgumentParser(description="Generate SQL to seed synthetic claims into Postgres.")
    parser.add_argument("--apply", action="store_true", help="Apply seed_claims.sql to user-search-postgres-1 after writing it.")
    args = parser.parse_args()

    if not CLAIMS_PATH.exists():
        raise SystemExit(f"Missing claims file: {CLAIMS_PATH}. Run python3 generate_synthetic_claims.py first.")

    with CLAIMS_PATH.open() as source:
        claims = json.load(source)

    SQL_PATH.write_text(render_sql(claims))
    print(f"Wrote {SQL_PATH} with {len(claims)} claims.")

    if args.apply:
        apply_sql(SQL_PATH)
        print("Applied claims seed SQL to user-search-postgres-1/appdb.")


if __name__ == "__main__":
    main()
