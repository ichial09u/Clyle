# Clyle

Personal streaming app (anime + shows) — Next.js 16 PWA with a seeded
SQLite catalog, packaged as an Android APK, deployable to any Node/Docker host.

| Piece | Where |
|---|---|
| App source (live) | [`src/`](./src) |
| Android wrapper (Capacitor) | [`mobile/`](./mobile) |
| Backend Docker image | [`Dockerfile`](./Dockerfile) → `ghcr.io/ichial09u/clyle:latest` |
| One-click host deploy | [`render.yaml`](./render.yaml) |

## Android APK

Latest release: **https://github.com/ichial09u/Clyle/releases/latest**
(`Clyle-v1.0.0.apk`)

1. Download the APK on your phone and open it (allow "install unknown apps"
   when prompted — it is self-signed, not from the Play Store).
2. First launch shows a **Connect screen**: paste your backend URL
   (e.g. `https://clyle-xxxx.onrender.com`). It is stored on-device, so the
   APK works with any host and never needs rebuilding when the host changes.

## Backend — pick one

**A. Render (recommended, ~2 min, free, no card):**

1. Sign up at [render.com](https://render.com).
2. **New + → Blueprint** → select this repo (`ichial09u/Clyle`) → **Apply**.
   Render reads `render.yaml`, pulls the prebuilt image from GHCR, done.
3. Your permanent URL appears (`https://clyle-xxxx.onrender.com`) — paste it
   into the APK Connect screen.

Free tier: sleeps after ~15 min idle; the first request then takes ~1 min
to wake. Watch-progress writes reset on redeploy (catalog always ships
inside the image).

**B. Any Docker host:**

```bash
docker run -d -p 3000:3000 ghcr.io/ichial09u/clyle:latest
```

The image is rebuilt automatically on every push to `main` by
[.github/workflows/docker.yml](./.github/workflows/docker.yml).

## iPhone / iPad

No signed IPA is possible without a paid Apple developer account. Instead,
open the backend URL in Safari → **Share → Add to Home Screen** — the app
is a full PWA (standalone display, icons, splash verified).

## Local development

```bash
cd src
bun install
bun run dev          # http://localhost:3000
```
