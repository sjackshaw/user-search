# Postgres service (managed via compose)

This directory documents how Postgres is managed for local development. Postgres runs using the official image and is controlled via the compose fragment `docker-compose.postgres.yml`.

Key locations

- Init scripts: `infra/db/init/` — mounted into the container at `/docker-entrypoint-initdb.d` for first-run initialization.
- Data directory (host): `data-output/postgres/` — bound to the container's `/var/lib/postgresql/data` for visible persistence during development.

How to run (dev)

Bring up only Postgres:

```
docker compose -f docker-compose.postgres.yml up --build -d
```

Bring Postgres and the app together:

```
docker compose -f docker-compose.postgres.yml -f docker-compose.app.yml up --build
```

Logs and debugging

```
docker compose -f docker-compose.postgres.yml logs -f postgres
docker compose -f docker-compose.postgres.yml exec postgres psql -U postgres -d appdb
```

Backups and restore

Backup (host):

```
docker compose -f docker-compose.postgres.yml exec postgres pg_dump -U postgres appdb > appdb_dump.sql
```

Restore (host):

```
cat appdb_dump.sql | docker compose -f docker-compose.postgres.yml exec -T postgres psql -U postgres -d appdb
```

Notes

- For development we use a host bind-mount (`data-output/postgres`) for visibility; in CI and production prefer a named volume or managed database service.
- Do not commit credentials. Use `.env.dev` (ignored) for local development or a secret manager in CI/production.
