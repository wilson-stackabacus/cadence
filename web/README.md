# Cadence Web

The online twin of the Cadence Mac app: same checklist, week/month calendars, recurring tasks,
to-do list, 20-word reflections, booking, reminders and check-ins — and it **syncs with the Mac app**.

- **Hosting:** Vercel (static site + one serverless function, free Hobby plan). No server of your own.
- **Database:** Turso (hosted SQLite/libSQL, free tier).
- **Login:** username + password (scrypt-hashed). "Keep me signed in" = a 1-year rolling session
  (HttpOnly cookie in the browser; Keychain token in the Mac app).

## Deploy (one time, ~10 minutes)

### 1. Create the Turso database
1. Sign up at <https://turso.tech> (free) and install the CLI: `brew install tursodatabase/tap/turso`, then `turso auth login`.
2. Create the database and a token:
   ```
   turso db create cadence
   turso db show cadence --url          # -> libsql://cadence-<you>.turso.io
   turso db tokens create cadence       # -> a long token
   ```
   Tables are created automatically on first request.

### 2. Deploy to Vercel
1. Sign up at <https://vercel.com> (free Hobby plan).
2. From this `web/` folder:
   ```
   npx vercel login
   npx vercel link                      # create a new project, root = this folder
   npx vercel env add TURSO_DATABASE_URL production
   npx vercel env add TURSO_AUTH_TOKEN production
   npx vercel deploy --prod
   ```
   (Or push the repo to GitHub and import it in the Vercel dashboard with **Root Directory = `web`**,
   then add the two environment variables under Settings › Environment Variables.)
3. Open the URL Vercel prints (e.g. `https://cadence-xyz.vercel.app`) and create your account.

### 3. Connect the Mac app
Cadence for Mac › Settings › **Sync with Cadence Web** → paste the Vercel URL, enter the same username
and password, **Sign in**. Existing Mac data is uploaded and merged; it stays signed in.

### 4. (Optional) Google Calendar on the web
In Google Cloud Console (Calendar API enabled), create an OAuth client of type **Web application** with redirect URI
`https://<your-app>.vercel.app/api/google/callback`, then add to Vercel:
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PUBLIC_URL=https://<your-app>.vercel.app` and redeploy.
(The Mac app keeps using its own Desktop client.)

### 5. (Optional) Calendly
Nothing to configure on the server. Each user pastes a Calendly **Personal Access Token**
(Calendly › Integrations › API & Webhooks) in Settings › Calendly.

## Calendar imports
Google Calendar events and Calendly meetings become **silent** checklist items (no notifications;
switch any single one on in its editor). IDs are derived from the event (`stableUUID("google:<id>")`,
`stableUUID("calendly:<uri>")`) identically on Mac, web and server, so nothing is ever imported twice.
Deleting an imported item hides it permanently; cancelled/moved events update or disappear.

- **Polling:** Mac and web re-check Google every 2 minutes (plus on wake/focus), Calendly every 30.
- **Push (instant):** with Google configured on the server (step 4) and `PUBLIC_URL` set, the server
  subscribes to Google change notifications; `/api/google/webhook` imports changes into Turso right
  away, and devices pick them up on their next sync. A daily Vercel cron (`/api/cron/google`, protected
  by `CRON_SECRET`) renews the subscriptions, which Google expires after ~7 days.

## How sync works
Every task, reflection and the shared settings are one row in Turso with the client's edit time.
Clients push changes and pull everything newer than their cursor; on conflict the most recent edit wins.
Deletions sync as tombstones. Device-only things (Google sign-in on the Mac, chosen calendars,
"show reminders in this browser") never leave the device.

If both the Mac app and a browser tab are open on the same computer you'd get reminders twice —
turn off **Settings › Reminders on this device** in the browser.

## Local development
```
npm install
npm run dev            # http://localhost:8132, uses web/data/cadence.db instead of Turso
npm test               # recurrence parity with the Mac app
node test/api.js       # API smoke test against the dev server (creates a local dev account)
node test/vercel-shim.js
```
Set `TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` locally to develop against the real database.

## Layout
```
api/index.js        Vercel function — every /api/* request (rewritten by vercel.json)
server/app.js       API routes: auth, sync, Google
server/auth.js      scrypt passwords, sessions, login rate limiting
server/db.js        Turso/libSQL client, schema, sync merge
server/google.js    Google Calendar OAuth + proxy for the web
server/dev.js       local dev server
public/             the web app (no build step): index.html, css/, js/{app,store,model,reminders}.js
```
