# Zetaris quick start for Windows

Follow these steps to run Zetaris locally with Docker Desktop. This starts the
Zetaris platform only; you do not need to start the Haze app.

For detailed requirements, licensing information, other operating systems and
troubleshooting, see the [full local installation guide](local-installation.md).

## Before you start

- Have the Haze-Agent repository on your computer.
- Install and start [Docker Desktop](https://docs.docker.com/desktop/).
- Allow Docker about 8 GB of memory and 4 CPUs.
- Have access to the Zetaris download page and its registry credentials:
  <https://cloud.enterprise.zetaris.com/dashboard/download>.

## Step 1: Open the project folder

Open PowerShell and go to the Haze-Agent folder:

```powershell
cd C:\Users\user\Desktop\Haze-Agent
```

If you put the repository somewhere else, use that folder instead. Run all
commands in this guide from the repository root, the folder containing
`compose.yaml`.

## Step 2: Create your settings file

Create `.env` from the example only if you do not already have one:

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

`.env` contains private settings. Never share it or commit it to Git. If it
already exists, keep it; do not overwrite it.

## Step 3: Sign in and get the Zetaris image settings

1. Open the Zetaris download page:
   <https://cloud.enterprise.zetaris.com/dashboard/download>.
2. Copy the `docker login` command shown for your account and run that exact
   command in PowerShell. Do not share the command or its credentials.
3. Download `zetaris-platform.zip` and open its `.env` file.

## Step 4: Fill in `.env`

Open your project `.env` in Notepad:

```powershell
notepad .env
```

Find the existing entries and replace their values; **do not paste additional
copies of the lines**. Use the matching bundle's values for the three image
settings:

```text
DRIVER_IMAGE=<value from the downloaded bundle .env>
API_IMAGE=<value from the downloaded bundle .env>
UI_IMAGE=<value from the downloaded bundle .env>
```

Then set:

- `POSTGRES_PASSWORD`: choose a strong password for the local database.
- `ZETARIS_ADMIN_EMAIL`: choose the email you will use to sign in to the local UI.
- `ZETARIS_ADMIN_PASSWORD`: choose a password with at least 8 characters,
  including a lowercase letter, uppercase letter, number and one of
  `$ @ ! % * ? &`. Using `@` avoids `$` interpretation in `.env`.

Save the file. Each setting should appear only once. In particular, edit the
existing image and password entries; duplicate entries can make Docker use a
different value than you expect. Leave `ZETARIS_API_KEY` blank for now; it is
not needed to open the Zetaris UI.

## Step 5: Start Zetaris

Make sure Docker Desktop is running, then run:

```powershell
docker compose pull
docker compose up -d
docker compose ps --all
```

The first start can take several minutes while Docker downloads the images and
the platform initializes. `init` and `bootstrap` showing `Exited (0)` is
expected; they are one-time setup jobs. The `postgres`, `driver`, `api` and
`ui` services should be running.

## Step 6: Open Zetaris

Open <http://localhost:3000> in your browser and sign in with the email and
password you set in `.env`. The administrator account is created on first
startup; changing those settings later does not reset an existing account.

You are done. You do not need `npm run dev` just to use Zetaris. That command
starts the separate Haze development application.

### Optional: connect Haze to Zetaris

If you want Haze integrations to authenticate, create an API key in the Zetaris
UI and put it in the existing `ZETARIS_API_KEY` entry in `.env`. Keep the key
private. This is optional for using Zetaris in the browser.

## Stop Zetaris

From the Haze-Agent repository root, run:

```powershell
docker compose down
```

This stops Zetaris and keeps its data. **Do not add `-v`** unless you intend to
delete the database and stored keys.

## If it does not start

Check Docker Desktop is running, confirm the `docker login` succeeded, then
review the service status and recent logs:

```powershell
docker compose ps --all
docker compose logs --tail=50 driver api
```

For more detailed checks, follow the
[full local installation guide](local-installation.md).

## Optional final step: start the Haze app

Zetaris is ready to use at <http://localhost:3000>. If you also want to run the
Haze development app, open a second PowerShell window at the Haze-Agent
repository root. On a fresh checkout, install its dependencies once:

```powershell
npm ci
npm --prefix frontend ci
```

Then start Haze:

```powershell
npm run dev
```

Keep that terminal open while using Haze. The app usually opens at
<http://localhost:5173>. The dev command also starts Zetaris if it is not
already running. Press `Ctrl+C` to stop the Haze app; Zetaris will keep
running. To stop Zetaris too, use the `docker compose down` command above.
