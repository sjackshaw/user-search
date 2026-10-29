# GitHub Actions workflows

> **Note:** This project is a proof of concept. There is no deployment pipeline — containers are built and run locally via Docker Compose (see [startup/setup.sh](../../startup/setup.sh)).

- `ci.yml`: runs on every push/PR to `main`. Installs dependencies, runs ESLint (`npm run lint`) and the Jest unit test suite (`npm test`) across all services. No external services (database, Docker) are required — all 10 test suites are pure unit tests.
