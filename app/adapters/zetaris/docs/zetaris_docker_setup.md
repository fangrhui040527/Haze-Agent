# Zetaris Platform — Ubuntu commands

Run these commands from inside the `zetaris-platform` folder.

## Step 0 — Unzip and Configure Environment

1. Unzip your `zetaris-platform.zip` into `app/adapters/zetaris/zetaris-platform`.
2. Ensure `.env` and `.env.server.example` are present in the current `zetaris-platform` folder (copy `.env.server.example` to `.env`).
3. In `.env`, configure the administrator credentials before proceeding to the next steps:
   ```env
   ZETARIS_ADMIN_PASSWORD=<your_secure_password>
   ZETARIS_ADMIN_EMAIL=<your_admin_email>
   ZETARIS_ADMIN_ORG=hack4hire
   ```
   > **Note:** The admin account is created during the initial setup. Configure these values before starting the platform for the first time. The password must be at least 8 characters containing lowercase, uppercase, a digit, and one of: `$ @ ! % * ? &`.

## Step 1 — Preflight

```bash
./preflight.sh
```

## Step 2 — Pull the images

```bash
docker compose pull
```

## Step 3 — Start Zetaris

```bash
docker compose up -d
```

## Step 4 — Check the containers

```bash
docker compose ps
```

## Step 5 — View driver logs

```bash
docker compose logs -f driver
```

Press `Ctrl+C` to stop viewing logs.

## Step 6 — Verify the installation

```bash
./verify.sh
```

## Step 7 — Open Zetaris

Open:

```text
http://localhost:3000
```

## Step 8 — Sign in

```text
Username: admin@zetaris.com
Password: Zetaris1@
```

## Step 9 — Stop Zetaris when needed

```bash
docker compose down
```

To stop and delete all Zetaris data:

```bash
docker compose down -v
```
