# Clyle on Turso — the $0 always-on database

Turso (<https://turso.tech>) is SQLite-as-a-service with a free tier. Point
Clyle at it and the database stops living on the host machine entirely —
which permanently fixes the one thing free hosting could never do:

- Render free sleeps → wakes → **keeps every user, list and progress row** (no more wiped DB)
- Redeploys, restarts, instance recycling — data survives all of it
- Costs **$0**; free tier storage is sized in GBs, the whole catalog is ~40 MB

The app code already supports it (merged in `db.ts`): with the two env vars
set, everything goes to Turso; without them, the packaged SQLite takes over
like before. **Zero-risk opt-in, instant rollback.**

## Setup (~10 minutes)

1. **Sign up** — <https://turso.tech> → "Get started" → log in with GitHub
   (no credit card).
2. **Create a database** — name it `clyle`, location closest to your users
   (e.g. `iad` for US East).
3. **Grab the two credentials** — in the dashboard (or CLI):
   - Database URL → looks like `libsql://clyle-<something>.turso.io`
   - Auth token → create one in the dashboard ("Tokens" / `turso db tokens create clyle`)
4. **Push the catalog** (one-time, ~2–10 min depending on connection):
   ```sh
   cd src
   TURSO_DATABASE_URL=libsql://clyle-xxx.turso.io \
   TURSO_AUTH_TOKEN=eyJ... \
   node scripts/turso-push.mjs --fresh
   ```
   (On Windows PowerShell, use `$env:TURSO_DATABASE_URL="..."` lines instead.)
   The script copies all tables FK-safely, prunes junk orphans, and verifies
   every row count. It refuses to touch a target that already has data
   unless you pass `--fresh`.
5. **Verify through the app's own driver**:
   ```sh
   TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... node scripts/turso-smoke.mjs
   ```
   Should print `DB IS READY`.

## Switch the app over

Render dashboard → your `clyle` web service → **Environment** → add:

```
TURSO_DATABASE_URL = libsql://clyle-xxx.turso.io
TURSO_AUTH_TOKEN   = eyJ...
```

Save → the service redeploys → open `/api/health`:

```json
{ "ok": true, "dbExists": ..., "animeCount": 2284, ... }
```

`animeCount` > 0 means the app is serving from Turso. Done — this is now a
database that can never be wiped by a sleep.

## Rollback

Remove the two env vars → the next boot uses the packaged SQLite again.
Turso keeps your data either way; nothing is destroyed by rolling back.

## Notes

- **Google OAuth, push notifications, comments, sync** — all keep working;
  they were already server features.
- Catalog refreshes: re-run `turso-push.mjs --fresh` after a new seed build.
- The mobile app / clients don't change at all — same API, same domain.
- Free-tier limits are generous (GBs of storage, millions of writes/day);
  a streaming catalog + personal usage sits far below them.
