# Install Zetaris locally

This guide covers a local Docker Compose installation. The local path was
tested on a fresh install; see the [test record](zetaris-installation-test-record.md).
For a managed compute cluster in your AWS account, use [Managed AWS cluster](managed-aws-cluster-guide.md).

## 1. Obtain the distribution and access

### What is being installed

The bundle includes:

| Service | Purpose |
|---|---|
| `postgres` | Metadata, audit and sample databases |
| `driver` | Query engine |
| `api`, `ui` | API and browser interface |
| `init`, `bootstrap` | Initialise volumes, keys, accounts and samples |
| `ai-datasteward` | AI data service |

### Download and licensing

You need the platform archive, its matching `.env`, registry credentials and a Zetaris licence or evaluation entitlement covering your installation.

1. Start at [Zetaris Cloud](https://www.zetaris.com/cloud) for a local installation. Choose **Start Free** to open the account portal, then register or sign in with your existing account. You can also use the [registration page](https://cloud.enterprise.zetaris.com/register) directly. Your Zetaris Cloud credentials are separate from the administrator account you will create inside your installation.
2. Review the [Terms and Conditions](https://cloud.enterprise.zetaris.com/terms) and [Privacy Policy](https://cloud.enterprise.zetaris.com/privacy) before completing registration. Your use of the platform is governed by your Order with Zetaris. Without one, the agreement allows internal evaluation for up to 30 days; it does not grant an ongoing licence.
3. Open the [Run locally page](https://cloud.enterprise.zetaris.com/dashboard/download), download `zetaris-platform.zip` and use the registry sign-in command supplied there. That page also has the current local startup steps and sign-in details. Move the zip out of Downloads before unpacking it. If the download is not available for your account, contact [Zetaris Support](https://www.zetaris.com/support) to have it enabled.

If your organisation has already arranged access, use the supplied archive and registry credentials. The Apache licence in the `getting-started` repository covers the data recipes only, not the platform images.

The `getting-started` repository contains recipes and guides, not the platform
images. Keep the supplied bundle files together and use its matching `.env`.
Some older bundle comments refer to `.env.example` or `env/make-env.sh`; those
files are absent from this distribution. Ask the distributor for a matching
`.env` if it is missing, and keep the supplied image references as a set.

## 2. Local Docker Compose

### 2.1 Prepare the machine

Install [Docker Desktop](https://docs.docker.com/desktop/) on macOS/Windows, or [Docker Engine with the Compose plugin](https://docs.docker.com/engine/install/) on Linux. On Windows, run the shell commands from WSL2 with Docker Desktop integration enabled.

| Requirement | Guidance for this bundle |
| --- | --- |
| Docker | Docker Engine 25 or later is recommended by the preflight script; daemon must be running |
| Compose | Use the `docker compose` plugin; this guide was tested with Compose 5.5.1 |
| Memory | 8 GB available to Docker recommended; preflight fails below 6 GB |
| CPU | 4 CPUs available to Docker recommended |
| Disk | At least 15 GB free for the installation; allow additional space for datasets and logs |
| Architecture | The supplied Zetaris images are amd64; Apple Silicon requires emulation |
| Network | Outbound access to the image registry and the data sources you will query |

On Docker Desktop, the memory allocation to Docker matters, not just the laptop's installed RAM. Leave headroom for the operating system and other applications. On Apple Silicon, enable supported amd64 acceleration where available and allow extra startup time.

### 2.2 Extract the bundle and authenticate

From the directory containing the downloaded archive:

```bash
unzip zetaris-platform.zip
cd zetaris-platform
docker version
docker compose version
docker login zetarishackathon.azurecr.io
./preflight.sh
```

Enter the registry credentials issued by Zetaris at the prompts. Run subsequent platform commands from this directory, which contains `docker-compose.yml`.

Resolve every preflight failure before proceeding. The registry check detects a stored login configuration; `docker compose pull` is the definitive check that the credentials can access the required images. Check free space in Docker Desktop's disk image as well as on the host.

### 2.3 Configure before first startup

Edit the supplied `.env` in an editor. Keep the issued image settings and other supplied values. Set or confirm:

| Variable | Local value or action |
| --- | --- |
| `ZETARIS_ADMIN_EMAIL` | Initial administrator email |
| `ZETARIS_ADMIN_PASSWORD` | Your own strong password, following the policy below |
| `ZETARIS_ADMIN_ORG` | Initial organisation name; choose before the first startup |
| `ZSPARK_DRIVER_MEM` | `2g` |
| `ZSPARK_DRIVER_CORES` | `2` |
| `ZSPARK_MASTER_URL` | `local[2]` |
| `ZETARIS_API_MAX_HEAP` | `1g` |
| `UI_PORT` | `3000` |
| `ALLOWED_ORIGINS` | `http://localhost:3000` |
| `GUI_URL` | `http://localhost:3000` |
| `COMPOSE_PROFILES` | Empty/unset for this local path |
| `ZETARIS_SEED_TPCH` | `true` to retain the supplied sample-data setup |

The administrator password must be at least eight characters and contain lowercase, uppercase, a digit and one of `$ @ ! % * ? &`. Other punctuation is rejected.

Keep `.env` private and out of version control:

```bash
chmod 600 .env
docker compose config --quiet
```

`--quiet` validates the configuration without printing resolved secrets.

### 2.4 Pull and start

```bash
docker compose pull
docker compose up -d
docker compose ps --all
```

Image downloads and first startup can take time, especially on Apple Silicon.
Use service readiness rather than elapsed time to decide when startup is complete.

```bash
docker compose logs --tail=80 driver api bootstrap
./verify.sh
```

Expected results:

- `postgres`, `driver`, `api`, `ui` and `ai-datasteward` are running; check their health in `docker compose ps --all`.
- `init` and `bootstrap` show `Exited (0)`. They are successful one-time setup jobs.
- `verify.sh` passes all nine checks, including login and a query through the UI, API and query engine.

If bootstrap is still running, wait for it to finish and rerun the verifier. If
`ui` checks fail immediately after bootstrap finishes, wait a minute and run
`./verify.sh` again before troubleshooting. Continue with section 3.

## 3. First login and initial verification

1. Open <http://localhost:3000>.
2. Sign in with the administrator email and password configured before bootstrap.
3. Open the SQL Editor and run:

```sql
SELECT 1 AS one;
```

Expect one row with value `1`. This confirms that an authenticated query reaches the engine without depending on an external dataset.

If you use a shipped default password, change it immediately.

Changing `ZETARIS_ADMIN_PASSWORD` or the organisation in `.env` after bootstrap does not recreate or reset existing accounts. After a UI password change, the verifier needs a matching credential value in `.env`; otherwise its login check can fail even though the services are healthy.

<a id="4-verify-the-data-recipes"></a>
<a id="parquetcsv"></a>
<a id="rest"></a>
## 4. Next steps

In the SQL Editor, start with [the supplied sample SQL](../connections/lightning-recipe-reference.md).
When you are ready to connect another source, choose a [Cookbook](../guides/recipe-readiness.md).

## 5. Stop and tear down

Run from the platform directory:

```bash
docker compose stop          # stop containers, retaining data
docker compose start         # resume stopped containers
docker compose down          # remove containers/network, retain named volumes
docker compose up -d         # recreate containers using retained data
```

`docker compose down -v` also deletes the named volumes, including the metastore and encryption keys. Use it only when discarding the installation.
