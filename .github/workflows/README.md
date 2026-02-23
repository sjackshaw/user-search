# GitHub Actions workflows

This directory contains CI workflows used by the repository.

Workflows
- `docker-build.yaml`: builds images using `docker compose` and the compose fragments. It is intended to run on push to `main` and builds the local images defined by the compose files.
- `ci.yml`: the main CI workflow. Responsibilities:
  - Assume an AWS role via OIDC (set `AWS_ROLE_TO_ASSUME` in GitHub Secrets).
  - Retrieve DB credentials from AWS Secrets Manager (set `DB_SECRET_ARN` in GitHub Secrets).
  - Start the Postgres dev container via `docker-compose.postgres.yml`, apply SQL migrations (if present), run tests, then tear down.
  - Build and push service images to ECR in the `build-and-push` job (requires the IAM role to have ECR permissions).

Required repository secrets
- `AWS_ROLE_TO_ASSUME` — ARN of the IAM role created from `ci/aws/iam-role-oidc.yml`.
- `DB_SECRET_ARN` — ARN of the Secrets Manager secret that contains DB credentials.

Notes
- The workflows use GitHub OIDC to assume roles; ensure the IAM role trust policy limits the `sub` condition to your repo and branch.
- If you change compose file names or service names, update the workflow matrix and compose commands accordingly.
