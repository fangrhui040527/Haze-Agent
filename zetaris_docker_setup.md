# Run Zetaris from Haze Agent

Run all Docker Compose commands from the Haze repository root. The root
`compose.yaml` starts Zetaris's PostgreSQL metastore, init job, driver, API,
UI and sample-data bootstrap. Platform assets remain in
`app/adapters/zetaris/zetaris-platform/`.

## Configure

Start Docker Desktop. For a new checkout, copy `.env.example` to root `.env`
without replacing an existing file. Set the matching `DRIVER_IMAGE`,
`API_IMAGE` and `UI_IMAGE` references issued with your Zetaris download, plus
`POSTGRES_PASSWORD`, `ZETARIS_ADMIN_EMAIL`, `ZETARIS_ADMIN_PASSWORD` and
`ZETARIS_ADMIN_ORG`. Retain the supplied settings for any existing install.
Haze model credentials, Zetaris client credentials and deployment settings all
use this root `.env`.

The administrator password must be at least eight characters and contain a
lowercase letter, an uppercase letter, a digit and one of `$ @ ! % * ? &`.
Existing accounts are not reset by changing bootstrap settings.

Sign in to `zetarishackathon.azurecr.io` using the registry credentials issued
by Zetaris, then validate the deployment without printing resolved secrets:

```sh
docker login zetarishackathon.azurecr.io
docker compose config --quiet
docker compose config --services
```

On WSL, Linux or macOS, check Docker resources and registry access with:

```sh
bash app/adapters/zetaris/zetaris-platform/preflight.sh
```

## Start and inspect

```sh
docker compose pull
docker compose up -d
docker compose ps --all
docker compose logs -f driver
```

The first startup can take several minutes. `init` and `bootstrap` finishing
with `Exited (0)` is expected. Open <http://localhost:3000> after the services
are ready, and sign in with the configured administrator account.

On WSL, Linux or macOS, run the read-only platform verifier:

```sh
bash app/adapters/zetaris/zetaris-platform/verify.sh
```

## Stop

```sh
docker compose down
```

The Compose project remains named `zetaris`, so it reuses existing Zetaris
containers and named volumes after this move. The legacy SmokeLedger service,
fetchers and USL bootstrap have been removed. Existing SmokeLedger volumes and
registered objects are not deleted or migrated by this repository change.

See the [platform guide](app/adapters/zetaris/zetaris-platform/README.md) for
HTTPS, sizing, JDBC and troubleshooting.
