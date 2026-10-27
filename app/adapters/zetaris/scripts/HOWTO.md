# Repository scripts

Run these commands from `app/adapters/zetaris`. Configuration lives in the Haze
repository root `.env`. Zetaris helpers have Deno/TypeScript and Python versions
with matching settings and behaviour.
The local file downloaders are Python-only.

<a id="find-your-organization-id"></a>
## Configure access

The scripts read `.env` from the Haze repository root, or from the top-level
checkout when run in a Git worktree. This file is gitignored. Do not replace an
existing file or commit credentials. Legacy `app/adapters/zetaris/.env.local`
files supply missing settings; root `.env` values take precedence. Start with
[the shared template](../../../../.env.example). The root Compose deployment uses
this same file.
See the [client setup guide](../../../../docs/zetaris/connections/client-setup.md) for how to
find your organisation ID and protect your credentials.

The quick SQL helpers use the **UI proxy**. Set its UI origin, numeric org ID,
and either `ZETARIS_API_KEY` or both `ZETARIS_USERNAME` and
`ZETARIS_PASSWORD`:

```dotenv
ZETARIS_BASE_URL=http://localhost:3000
ZETARIS_ORG_ID=
ZETARIS_API_KEY=
ZETARIS_USERNAME=
ZETARIS_PASSWORD=
ZETARIS_QUERY_LIMIT=1000
ZETARIS_ENGINE_ID=
```

`ZETARIS_BASE_URL` is a UI origin, not the raw API endpoint on port 8888. The
multi-statement REST/JDBC runner uses `ZETARIS_REST_URL` for the direct API.
These are different clients and routes.

<a id="verify-sql-execution"></a>
<a id="check-the-zetaris-connection"></a>
<a id="run-a-zetaris-query"></a>
<a id="how-a-request-works"></a>
<a id="what-the-zetaris-scripts-send"></a>
## Run one Zetaris request

Use `check_zetaris` to list Lightning databases. Use `query_zetaris` to send
one SQL request and print its JSON response. These helpers do not split a SQL
file or roll back changes. Review the query first; it runs with your Zetaris
account's permissions.

```sh
./scripts/check_zetaris.ts
python3 scripts/check_zetaris.py
```

```sh
./scripts/query_zetaris.ts "SELECT 1"
python3 scripts/query_zetaris.py "SELECT 1"
```

To send one complete SQL statement from a file:

```sh
./scripts/query_zetaris.ts --file path/to/query.sql
python3 scripts/query_zetaris.py --file path/to/query.sql
```

Each request goes through the UI's `/api/proxy/...` route. The shared helper
loads `.env`, gets a token, and sends the bearer token, `X-Org-ID`, and a
fresh UUID `X-Request-ID`. Requests time out after 30 seconds. `ZETARIS_QUERY_LIMIT`
defaults to 1000 rows; `ZETARIS_ENGINE_ID` is optional. A 404 usually means
`ZETARIS_BASE_URL` is not the UI origin or the UI does not expose proxy routes.

<a id="check-readiness-and-run-sql-scripts-rest-or-jdbc"></a>
## Preflight and run SQL scripts

`preflight.py` checks configuration and connectivity. It is read-only and
installs nothing. It checks direct REST and instance state, and can also check
JDBC when requested. Even with `--jdbc`, it still runs the REST checks, so a
REST-only failure does not by itself mean JDBC is unavailable. Read the
JDBC-specific result separately.

```sh
python3 scripts/preflight.py
python3 scripts/preflight.py --jdbc --jar /path/to/zetaris-driver.jar
```

`run_sql.py` runs one SQL statement at a time from a file or from `-e`. It
understands quotes and comments, stops at the first error, and keeps a
multi-table `COMPILE USL` whole. Its Python JDBC mode needs a JDK, the driver
JAR, and `jaydebeapi` in `.venv`; provide `--jar` or set `ZETARIS_JDBC_JAR`.
Direct Java JDBC connections do not need Python. The scripts never guess the
JAR path.

```sh
python3 scripts/run_sql.py --dry-run open_data/rest_apis/sql/rate_limited/12_company_dns_create.sql
python3 scripts/run_sql.py open_data/rest_apis/sql/rate_limited/12_company_dns_create.sql
python3 scripts/run_sql.py --channel jdbc -e "SELECT 1"
```

Create scripts change the instance. Inspect the dry-run, confirm object
ownership and permissions, and get a clear go-ahead before running without
`--dry-run`. `--skip-exists` skips "already exists" errors; inspect matching
definitions first. A script containing `YOUR_APP_NAME YOUR_CONTACT_EMAIL`
needs `ZETARIS_USER_AGENT`; SEC EDGAR needs your real contact email.

<a id="onboard-sources-with-their-dependencies"></a>
## Plan recipe dependencies

`onboard.py` reads `open_data/manifest.json` and orders each source's declared
dependencies. Use it instead of working out the order by hand.

```sh
python3 scripts/onboard.py --list
python3 scripts/onboard.py --check
python3 scripts/onboard.py plan sic_edgar_usl
python3 scripts/onboard.py run sic_edgar_usl --dry-run
python3 scripts/onboard.py run company_dns pokeapi --dry-run
```

After reviewing the plan and receiving approval, rerun the selected `run`
command without `--dry-run`. Shared dependencies run once. A dependency that
already exists satisfies the plan; for named sources, `--skip-exists` skips
duplicate errors. Sources marked `known_to_fail` need
`--allow-known-to-fail`. Rebuilding a USL may require `REMOVE USL` first;
`ACTIVATE USL TABLE` is not verified as a repeatable operation.

<a id="tear-down-and-start-over"></a>
### Rate limits and deprecated recipes

A manifest source marked `deprecated` needs `--allow-deprecated`; use its replacement instead. The former company DNS recipe 10 is replaced by recipe 12, which keeps V3 and adds V4 plus compatibility views. Recipes 13 and 14 add EU NACE and Japan.

`onboard.py` sends statements back to back. For rate-limited recipes, use SQL Editor to run one statement at a time, waiting at least 15 seconds before each endpoint call identified in the recipe header. Cache the raw table immediately; after HTTP 429, wait 60 seconds and retry that statement rather than the whole script. Do not run deprecated recipe 10 alongside replacement 12 on the same instance.

## Tear down recipe objects

`teardown` derives SQL drops from create scripts and includes sources that
depend on the target. It shows a plan and sends nothing unless you pass
`--yes`. Get clear approval before using `--yes`.

```sh
python3 scripts/onboard.py teardown sic_edgar_usl
python3 scripts/onboard.py teardown sic_edgar_usl --verbose
python3 scripts/onboard.py teardown sic_edgar_usl --yes --channel jdbc --jar /path/to/zetaris-driver.jar
python3 scripts/onboard.py teardown company_dns --no-dependents
python3 scripts/onboard.py teardown sic_edgar_usl --drop-namespace --yes
```

`--drop-namespace` removes every USL in that namespace. This runner leaves
REST/file registrations, Lightning databases and SchemaStore containers for
manual cleanup; its output lists them. That is a runner limitation, not proof
that the platform has no removal command. See [tested cleanup](../../../../docs/zetaris/guides/troubleshooting.md#cleanup).
If objects remain, inspect their definitions and use `--skip-exists` on the
next run. Check the verbose plan when adding statement types.

<a id="running-the-denotypescript-scripts"></a>
<a id="running-the-python-scripts"></a>
<a id="use-the-deno-and-python-helpers"></a>
## Use the Deno and Python helpers

Deno 2.9 or later is required for TypeScript helpers. Python 3.9 or later is
required for the Zetaris helpers. Use Python 3.8 or later for the local file
downloaders. Use a virtual environment if system Python blocks package installation.

```sh
deno --version
deno task check
python3 --version
python3 -m venv .venv
.venv/bin/pip install -r scripts/requirements.txt
```

Deno entrypoints include their network, environment, and file permissions in
their first line and load `.env` themselves. If direct execution is not
available, run a script with its needed flags, for example:

```sh
deno run --no-config --allow-net --allow-env='ZETARIS*' --allow-read scripts/check_zetaris.ts
```

<a id="fetch-local-data-files-for-the-parquetcsv-package"></a>
## Fetch local Parquet/CSV source files

These Python-only downloaders save files under the gitignored
`tmp/cache/<source>/` directory. The sources do not have Zetaris SQL table
registrations yet. Copy any required licence attribution into published work.
See the [Parquet/CSV HOWTO](../open_data/parquet_csv/HOWTO.md) for limits and
setup steps.

```sh
python3 scripts/fetch_datagovsg.py
python3 scripts/fetch_openfoodfacts.py --sample-rows 5000
```

## Render a saved result

The PUDL chart example is conditional on an already verified PUDL table.
PUDL registration is currently known to fail; start with another source. See
[troubleshooting](../../../../docs/zetaris/guides/troubleshooting.md) for connection and
partial-setup recovery.
