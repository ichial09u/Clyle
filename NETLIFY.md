# Clyle on Netlify — free Next.js hosting (with honest fine print)

Netlify runs the full app — SSR pages, every API route, the video proxy —
via its official OpenNext adapter. Next.js 16 is supported out of the box.

**The fine print first:** Netlify's 2026 free plan is credit-based, and the
video proxy is bandwidth-hungry. Every second of playback streams through
the server, so the free tier is roughly **15 GB of streamed video per
month**. Light personal use fits; heavy binge-watching pauses the site
until the month rolls over. Render free (100 GB/mo) or Fly (~$1–4) absorb
far more traffic — treat Netlify as a great second/backup host, not the
main binge machine.

## What the free plan gives you (300 credits/month)

| Usage              | Credits        | Free budget                |
| ------------------ | -------------- | -------------------------- |
| Bandwidth          | 20 / GB        | ≈ 15 GB streamed video     |
| Production deploy  | 15 each        | ≈ 20 pushes to main        |
| Web requests       | 2 / 10,000     | plenty                     |
| SSR / compute      | 10 / GB-hour   | light use is fine          |

Emails warn you at 50 / 75 / 100 %. At 0 credits the site pauses until the
next billing cycle — no surprise bills, no credit card on file.

## Deploy (5 minutes)

1. **Sign up** — <https://app.netlify.com> → "Sign up with GitHub"
   (no credit card).
2. **Import** — "Add new site" → "Import an existing project" → GitHub →
   pick **ichial09u/Clyle**, branch `main`. Build settings auto-load from
   `netlify.toml` (the app lives in `src/`; base/command/publish are
   already pinned, and the Next.js adapter is forced explicitly via
   `[[plugins]]` — with a `src/` monorepo, relying on auto-detection can
   build "successfully" into a static-only deploy where every route 404s).
   First build ≈ 5–8 minutes.
3. **Verify** — open `https://<site>.netlify.app/api/health` →
   `"ok": true`, `animeCount` > 0.

## Database — pick one

- **No Turso (default):** the packaged 38 MB catalog ships inside the
  function bundle and is copied to /tmp at boot (the same trick the Vercel
  build already uses — db.ts detects Netlify automatically). Catalog,
  search and playback all work; writes (My List, progress sync, comments)
  last only for the life of each serverless instance.
- **With Turso (recommended):** follow [TURSO.md](TURSO.md) once (~10 min),
  then add two env vars and everything persists across redeploys, sleeps
  and months:

  Site configuration → Environment variables →

  ```
  TURSO_DATABASE_URL = libsql://clyle-xxx.turso.io
  TURSO_AUTH_TOKEN   = eyJ...
  ```

  Redeploy → `/api/health` reports the Turso-backed `animeCount`.

## Sign-in (Google OAuth)

Add the existing `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` values as env
vars, then in Google Cloud Console → Credentials → the OAuth client →
"Authorized redirect URIs" add:

```
https://<site>.netlify.app/api/auth/google/callback
```

## Daily refresh (catalog + ANN news)

Vercel crons don't exist on Netlify. The repo ships
`.github/workflows/cron.yml` instead — set the **repo variable** `CLYLE_URL`
(Settings → Secrets and variables → Actions → Variables) to the base URL
that should be pinged daily, plus the `CRON_SECRET` repo secret if that
deployment sets one. Tip: point it at a long-running host (Render / Fly) —
the refresh sweep can exceed Netlify's 10 s function limit.

## Know the limits

- **≈ 15 GB/mo streamed video** — the proxy funnels every HLS segment
  through Netlify functions; bandwidth is the credit sink.
- **10 s function timeout** on the free plan — routes are normally fast,
  but a slow upstream resolver can occasionally time out.
- **Push to `main` = auto-deploy** and costs 15 credits (~20 pushes/mo).

## Day-2

- **Update:** push to `main` → Netlify builds and deploys automatically.
- **Refresh catalog data:** re-run `scripts/turso-push.mjs --fresh` per
  [TURSO.md](TURSO.md) (only needed when using Turso).
- **Remove it:** Site configuration → General → "Delete site", or just let
  it pause — a paused site costs nothing.

Nothing here touches the other hosts: the Docker image / Render / Fly /
Dokploy setups all ignore `netlify.toml`, so every deployment path can
coexist in the same repo.
