# Zetaris Setup Guide

Do the steps in order. Do not run `npm run dev` until step 6.

## 1. Find the env files

Go to the main folder: `C:\Users\user\Desktop\Haze-Agent`

- `.env` is your real settings file. Never share it.
- `.env.example` is an empty copy.

No `.env`? Copy `.env.example` and name the copy `.env`.

## 2. Get the Zetaris zip file

1. Open https://cloud.enterprise.zetaris.com/dashboard/download
2. Do step 1 on that page: copy the `docker login` command and run it in a terminal.
   You only do this once per computer. The page shows your own name and password.
3. Download `zetaris-platform.zip`.
4. Move it out of Downloads, then unzip it.
5. Open the `.env` file inside the unzipped folder.

## 3. Fill in our `.env`

Open our `.env` in `C:\Users\user\Desktop\Haze-Agent`.

Copy these four lines from the zip's `.env` into ours:

```
DRIVER_IMAGE=
API_IMAGE=
UI_IMAGE=
POSTGRES_PASSWORD=
```

Pick an admin email and password. The password needs 8 or more letters,
a small letter, a big letter, a number, and one of these: `$ @ ! % * ? &`

```
ZETARIS_ADMIN_EMAIL=
ZETARIS_ADMIN_PASSWORD=
```

Use the same email and password here:

```
ZETARIS_USERNAME=
ZETARIS_PASSWORD=
```

Leave `ZETARIS_API_KEY=` empty. You get it in step 5.

## 4. Start Zetaris

Open Docker Desktop. Wait until it is running. Then in PowerShell:

```powershell
cd C:\Users\user\Desktop\Haze-Agent\app\adapters\zetaris\zetaris-platform
docker compose pull
docker compose up -d
docker compose ps --all
```

- The first start takes a few minutes.
- Cannot find the file? Run the same commands from `C:\Users\user\Desktop\Haze-Agent`.

## 5. Get the API key

1. Open http://localhost:3000
2. Sign in with your admin email and password.
3. Go to the API key page.
4. Click the **+** button (top right).
5. Copy the key right away.
6. Paste it in `.env`:

```
ZETARIS_API_KEY=
```

## 6. Run the project

```powershell
cd C:\Users\user\Desktop\Haze-Agent
npm run dev
```

## To stop Zetaris

```powershell
docker compose down
```

## Problems

| Problem | What to do |
| --- | --- |
| Cannot download images | Do the `docker login` in step 2 again |
| Zetaris is slow or stuck | Give Docker more memory (8 GB) and start again |
| Error `401` | Make a new API key and paste it in `.env` |
| Cannot sign in | Use the first admin password you set |
