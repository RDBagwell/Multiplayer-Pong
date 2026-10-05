# Deploying it (free)

GitHub Pages only hosts static files, so the game is deployed in two parts, the same way as Chat Mafia:

- the **client** (the web page) on **GitHub Pages**, built by [`.github/workflows/pages.yml`](../.github/workflows/pages.yml);
- the **server** (the Socket.io game server) on **Render**'s free tier, described by [`render.yaml`](../render.yaml).

Do these steps **after this branch is merged into `master`**. They assume the repository is `RDBagwell/Multiplayer-Pong`; if you've renamed it, use the new name wherever the repo name appears (the Pages URL changes with it; nothing in the code needs to change).

## 1. Create the server on Render

1. Sign in at <https://dashboard.render.com> with your GitHub account.
2. Click **New +** (top right) → **Blueprint**.
3. Under **Connect a repository**, pick **RDBagwell/Multiplayer-Pong**. If it isn't listed, click **Configure account** / **Connect GitHub** and give Render access to the repo.
4. Give the Blueprint a name (e.g. `netcode-pong`) and keep **Branch** set to `master`.
5. Render reads `render.yaml` and asks for the value of **`ALLOWED_ORIGINS`**. Enter your GitHub Pages origin: **`https://rdbagwell.github.io`**. Exactly that: `https://`, lowercase, **no** `/Multiplayer-Pong` path and **no** trailing slash.
6. Click **Apply** and wait for the service to show **Live**.
7. Open the service **netcode-pong-server** and copy its URL from the top of the page, e.g. `https://netcode-pong-server.onrender.com`. Open `<that URL>/healthz` in a browser: it should show `{"ok":true}`.

*Prefer not to use a Blueprint?* **New +** → **Web Service** → pick the repo, then set: Language **Node**, Branch `master`, Build Command `npm ci --omit=dev`, Start Command `npm start`, Instance Type **Free**. Under **Advanced** set Health Check Path `/healthz`, and add these environment variables: `NODE_ENV=production`, `NODE_VERSION=22`, `ALLOWED_ORIGINS=https://rdbagwell.github.io`, `CLIENT_IP_HEADER=true-client-ip`, `TRUST_PROXY_HOPS=1`, `SERVE_CLIENT=false`.

What the server does in production (`NODE_ENV=production`): it refuses to start unless every `ALLOWED_ORIGINS` entry is `https://`, sends HSTS, and accepts WebSocket connections only from the allowed origins. Render terminates TLS, so browsers reach it only over HTTPS/WSS. `PORT` is set by Render and read from the environment.

## 2. Tell the client where the server is

1. On GitHub, open the repo → **Settings** → **Secrets and variables** → **Actions**.
2. Choose the **Variables** tab (not Secrets) → **New repository variable**.
3. Name: **`GAME_SERVER_URL`**. Value: the Render URL from step 1.7, e.g. `https://netcode-pong-server.onrender.com`. It must start with `https://`.
4. Click **Add variable**.

The Pages build ([`scripts/build-pages.mjs`](../scripts/build-pages.mjs)) compiles that address into the client and writes a Content-Security-Policy into the page whose `connect-src` allows exactly that server (`https://` and `wss://`) and nothing else. It refuses to build with a missing or non-`https://` URL.

## 3. Turn on GitHub Pages

1. Repo → **Settings** → **Pages** (left sidebar).
2. Under **Build and deployment** → **Source**, choose **GitHub Actions**.
3. Go to the **Actions** tab → **Deploy client to GitHub Pages** (left list) → **Run workflow** → branch `master` → **Run workflow**. (It also runs on every push to `master`.)
4. When the run is green, the site is live at **<https://rdbagwell.github.io/Multiplayer-Pong/>**.

## 4. Share the link

Open the Pages URL. **Play vs. computer → Play online** is the quickest check that the two halves talk to each other: open **Network lab** and the stats should be moving. For a game with a friend, **Private room → Create room** and send the invite link (it looks like `https://rdbagwell.github.io/Multiplayer-Pong/?join=ABC123`).

## The free tier's cold start, and the offline fallback

Render's free web services spin down after a while without traffic, and the next visitor waits while the server starts again (see Render's documentation on free instances for the current limits). The page handles this:

- The landing screen shows the server's state ("Connecting…", "Waking the server…", "Server online").
- If the server hasn't answered after 1.5 s, or refuses the connection, it offers **Play the computer offline**: a full match against the same bot, run entirely in the browser with the same simulation code. The online buttons switch on by themselves once the server answers.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Stuck on "Waking the server…" for minutes | Check the Render service is **Live** and `/healthz` works. Check `GAME_SERVER_URL` is exactly the Render URL, then re-run the Pages workflow. |
| Works locally, but online play never connects on Pages | `ALLOWED_ORIGINS` on Render must be exactly `https://rdbagwell.github.io`. After changing it, Render redeploys by itself. The browser console shows a CSP error if `GAME_SERVER_URL` doesn't match the server. |
| The Pages workflow fails with "GAME_SERVER_URL is not set" | Add the variable (step 2) under **Variables**, not **Secrets**. |
| Render deploy fails with "ALLOWED_ORIGINS is required" or "must be https://" | Set it in the service → **Environment**, with `https://` and no path. |
| Render build fails with a Node version error | Set `NODE_VERSION` to `22` (or later) in the service → **Environment**. |

## Running the production build locally

```bash
npm run build                      # client into client/dist
NODE_ENV=production ALLOWED_ORIGINS=https://example.com npm start   # checks the production config
npm start                          # development config: serves client/dist on http://localhost:3000
```
