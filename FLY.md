# Clyle on Fly.io

Fly runs the app on a small VM that **sleeps when idle and wakes in seconds** —
and the database lives on a persistent volume, so nothing is ever lost
(fixes Render's wake-up-and-forget-the-DB bug).

**Cost reality:** no true free tier (it was removed in 2024). With auto-stop
enabled, a lightly-used app lands around **$1–4/mo** (compute only bills while
awake + ~$0.45/mo for the 3 GB volume). A card is required at signup.

**Env vars needed: zero.** The image boots with the catalog baked in and seeds
its own volume. Google OAuth comes later, optional.

## One-time setup (~5 min)

1. **Sign up** — <https://fly.io/app/sign-up> (card required).
2. **Install the CLI** — <https://fly.io/docs/flyctl/install/>,
   then `fly auth login`.
3. **Create the app** (from this repo's root):
   ```sh
   fly launch --image ghcr.io/ichial09u/clyle:latest --region ord --no-deploy
   ```
   Say yes when it offers to copy `fly.toml`. Region `ord` = Chicago —
   pick the one closest to you if different.
4. **Create the database volume** (3 GB, ~$0.45/mo):
   ```sh
   fly volumes create clyle_data --region ord --size 3
   ```
5. **Deploy:**
   ```sh
   fly deploy
   ```
6. Open `https://clyle.fly.dev` — done. HTTPS is automatic, no domain needed.

## Google OAuth (optional, when you want login)

1. Google Cloud Console → Credentials → your OAuth client →
   add Authorized redirect URI:
   `https://clyle.fly.dev/api/auth/google/callback`
2. Set the secrets:
   ```sh
   fly secrets set GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=...
   ```
3. Redeploy is not needed — secrets apply on next boot; restart:
   ```sh
   fly machine list && fly machines restart <machine-id>
   ```

## Day-2

| Task | Command |
|---|---|
| Update to the latest image | `fly deploy` (re-pulls `:latest`) |
| Refresh the catalog DB | `fly secrets set DB_RESEED=1` then `fly machines restart <id>` (remove the var after) |
| Check health | `fly status` · `fly logs` · `https://clyle.fly.dev/api/health` |
| Feels slow? | `fly scale memory 1024` |
| Wake speed | `auto_stop_machines = "stop"` in fly.toml; switch to `"suspend"` for near-instant resume |

## Notes

- The app sleeps when idle (default in fly.toml). First visit after idle
  takes a few seconds — normal.
- `clyle.fly.dev` is the free public URL; a custom domain can be added later
  with `fly certs add yourdomain.com`.
- The volume (`clyle_data`) is the database of record. Deleting it deletes
  user data.
