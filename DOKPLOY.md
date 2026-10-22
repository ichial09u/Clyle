# Deploy Clyle on Dokploy

Dokploy pulls the same public image Render uses (`ghcr.io/ichial09u/clyle:latest`),
so deploys are a pull-and-start — nothing compiles on your server.

## 0. What you need

- **Dokploy Cloud** account (the 7-day trial dashboard). Apps still run on a
  server *you* connect — the dashboard alone doesn't host anything.
- **One free server.** Recommended: Oracle Cloud "Always Free" ARM VM
  (2 OCPU / 12 GB RAM / 200 GB disk / 10 TB egress, never expires):

  1. oracle.com → Start for free (credit card required at signup, never charged
     on Always Free resources).
  2. Compute → Instances → Create: image **Ubuntu 24.04**, shape
     **Ampere A1** (set 2 OCPU / 12 GB), pick any region with capacity
     (retry another region if "out of capacity").
  3. Download the SSH private key when offered.
  4. Networking → Virtual cloud network → subnet → **Security list**: add
     ingress rules for TCP **22, 80, 443** from 0.0.0.0/0 (Traefik + SSH).

## 1. Connect the server to Dokploy

Dokploy dashboard → **Servers → Add server**, paste the SSH credentials it
asks for (IP + key or the provided one-liner). Dokploy installs Docker +
Traefik on the box and shows it green.

## 2. Deploy the app

1. **Projects → Create Project**, open it → **+ → Docker Compose**.
2. Choose **Paste Compose** and paste the contents of
   `dokploy-compose.yml` (repo root) → **Deploy**.
3. First boot takes ~1 min: the entrypoint seeds `clyle-data:/app/db`
   with the packaged catalog, then `node server.js` serves UI + API on port 3000.
4. Health endpoint if you want a check: `/api/health`.

## 3. Domain + SSL

Service → **Domains → Add domain**: use the free `*.dokploy.xyz` domain or
point your own A record at the server IP. Let's Encrypt SSL is automatic.

## 4. Google sign-in (optional)

Once the domain is live, add the callback in Google Cloud console →
Credentials → your OAuth client → **Authorized redirect URIs**:

```
https://YOUR-DOMAIN/api/auth/google/callback
```

Then set these env vars on the service (Environment tab) and redeploy:
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `AUTH_SECRET`.

Everything else (VAPID push keys, bot tokens) already has baked-in fallbacks.

## 5. Day-2 operations

| Task | How |
|------|-----|
| Ship an update | Push to `main` → Actions rebuilds `:latest` → Dokploy service → **Redeploy** |
| Refresh the catalog DB | Set `DB_RESEED=1` env → redeploy → remove the var |
| Keep progress forever | Nothing to do — the `clyle-data` volume persists across deploys |
| Keep Oracle from idling the VM | Any uptime monitor pinging `/api/health` every 5 min is enough |
