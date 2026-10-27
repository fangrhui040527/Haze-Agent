# Zetaris platform

The platform runs on one machine through the Haze repository-root `compose.yaml`.
Run Docker Compose commands from the Haze repository root. Settings live in the
shared root `.env`; this folder holds deployment assets and diagnostic scripts.

```
postgres --(healthy)--> driver --(healthy)--> api --(healthy)--> ui
     +-- init --(completed)--+                            +----> bootstrap
```

| Service | Ports | What it is |
|---|---|---|
| `postgres` | internal | metastore and audit databases |
| `init` | -- | one-shot: volume ownership and the shared keypair |
| `driver` | 10000, 4040 (local only) | the query engine; creates the organisation and its administrator on first start |
| `api` | 8888, 8889 (local only) | REST API |
| `ui` | 3000 | the web interface |
| `bootstrap` | -- | one-shot: the sample data |

`init` and `bootstrap` finish as `Exited (0)`. That is success; they are setup jobs, not services.

## Install

See the [local installation guide](../../../../docs/Zetaris/install/local-installation.md) for the full
configuration steps. For a new checkout, copy root `.env.example` to root `.env`
without overwriting an existing file, then fill in the image references and
credentials issued with your Zetaris download. Keep the issued driver, API and
UI image references together. For an existing install, retain its deployment
credentials and settings in root `.env`.

Start Docker Desktop with 8 GB of memory and 4 CPUs available, sign in to the
issued image registry, then run these commands from the Haze repository root:

```sh
docker login zetarishackathon.azurecr.io
bash app/adapters/zetaris/zetaris-platform/preflight.sh
docker compose config --quiet
docker compose pull
docker compose up -d
docker compose ps --all
```

The shell scripts run in WSL, Linux or macOS. PowerShell can run the Docker
commands directly. The first startup may take several minutes; `init` and
`bootstrap` ending as `Exited (0)` is expected.

```sh
bash app/adapters/zetaris/zetaris-platform/verify.sh
```

Open <http://localhost:3000> and sign in with the configured administrator email
and password. The administrator is created on first startup; changing the
bootstrap variables later does not reset an existing account.

### On a server

Configure HTTPS in root `.env` by setting `COMPOSE_PROFILES=tls`,
`ZETARIS_PUBLIC_HOST` to the public hostname, and `ALLOWED_ORIGINS` and `GUI_URL`
to its HTTPS origin. Then run `docker compose up -d` from the repository root.
The optional Caddy service serves ports 80 and 443. For a private address that
cannot receive a public certificate, set `CADDY_GLOBAL_OPTIONS=local_certs` and
trust the generated certificate on your client.

### If something fails

Run the verifier above. Check logs with `docker compose logs --tail=50 driver api`.
A registry access error requires the issued registry login; a driver that never
becomes healthy often needs more Docker memory. The browser interface requires
HTTPS when accessed through a hostname or address other than localhost.

## Sample data

The first start registers the same sample datasets a Zetaris Cloud cluster gets, so instructions written for one work on the other. Both are read in place from the public bucket `s3a://zetaris-public-dataset`, so the machine needs outbound internet.

| Database | Tables | Format |
|---|---|---|
| `NY_TAXI` | 15, e.g. `customers`, `trips`, `yellow_taxi`, `taxi_zones` | CSV |
| `TPCDS_DB` | 24, the TPC-DS schema, e.g. `store_sales`, `item`, `date_dim` | Parquet |

Try `SELECT * FROM NY_TAXI.customers LIMIT 10`.

## Sizing

| | Query engine | For |
|---|---|---|
| root `.env` example | 2 GB, 2 cores | a laptop |
| server tuning in root `.env` | 4 GB, 4 cores | an instance with room |

The query engine uses exactly the heap it is given, so this is the one choice that decides how fast queries run. Leave room for both the driver and API heaps when increasing these settings.

## Tuning the query engine

Heap and cores come from root `.env`:

| | |
|---|---|
| `ZSPARK_DRIVER_MEM` | how much heap the query engine gets -- the setting that decides query speed |
| `ZSPARK_DRIVER_CORES` | cores it may use |
| `ZSPARK_MASTER_URL` | `local[2]` runs Spark in-process with two threads |

Other Spark settings are in `app/adapters/zetaris/zetaris-platform/conf/spark-defaults.conf`, which the driver reads at startup. It ships with the useful settings commented out beside their defaults, so you can see what is available without reading Spark's documentation:

```bash
vi app/adapters/zetaris/zetaris-platform/conf/spark-defaults.conf
docker compose restart driver
```

The one worth knowing about is `spark.sql.shuffle.partitions`. Spark defaults to 200, which is sized for a cluster; on two cores that is 200 small tasks queueing, and lowering it near your core count is usually the largest single improvement.

Heap and cores cannot be set in that file. The driver is launched with them on the command line, and a command line wins -- so `spark.driver.memory` there is ignored silently.

## Connecting over JDBC

The query engine listens on port 10000 on this machine. Tools that speak JDBC -- DBeaver, DataGrip, Tableau, your own Java or Python code -- connect to it through the driver in this folder's `jdbc/` directory.

| | |
|---|---|
| Driver file | `app/adapters/zetaris/zetaris-platform/jdbc/ndp-jdbc-driver-2.4.3.1-7eff043-driver.jar` |
| Driver class | `com.zetaris.lightning.jdbc.LightningDriver` |
| URL | `jdbc:zetaris:lightning@localhost:10000` |
| User / password | the account you sign in to the web interface with |

- **Use this jar, not a generic Hive or Spark driver.** It is the only driver that understands the `jdbc:zetaris:lightning@` URL, and it bundles everything it needs, so add the one file to your tool and nothing else.
- **In DBeaver:** Database -> Driver Manager -> New, add the jar under Libraries, set the class and URL above, then create a connection with that driver.
- **Only from this machine.** Port 10000 is bound to `127.0.0.1` because the connection is unencrypted. To reach it from elsewhere, tunnel it: `ssh -L 10000:localhost:10000 <server>`, then connect to `localhost:10000` as above.
- **Port 10000 already taken?** Set `DRIVER_PORT` in `.env`, run `docker compose up -d`, and use that port in the URL.
- **Nothing answers until the driver is healthy.** `bash app/adapters/zetaris/zetaris-platform/verify.sh` tells you when it is.

## Day to day

```bash
docker compose ps
docker compose logs -f driver
docker compose down          # stop, keep the data
docker compose down -v       # stop and delete everything, including the metastore
```

**Back up root `.env` and the Zetaris data volumes.** The volumes contain the metastore and the encryption keypair used for stored datasource credentials.

## Two things worth knowing

**The keypair is generated once.** `init` writes it into a shared volume on first start, and both the driver and the API read the same copy. `docker compose down -v` destroys it along with everything encrypted with it.

**`init` runs as root and `api` has `group_add`.** A new Docker volume belongs to root until something claims it, so one container takes ownership. The driver and the API then run as different users sharing that tree through a common group.
