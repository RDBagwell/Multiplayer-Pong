# Netcode Pong

**A multiplayer Pong that shows its work.** The game is simple on purpose: it is a showcase for the netcode real online games use (a server-authoritative simulation, clock sync, client-side prediction, server reconciliation and entity interpolation), with a built-in **network lab** where you add lag, jitter and packet loss and switch each technique off to feel why it exists.

<!-- SCREENSHOTS -->

**Play it:** <https://rdbagwell.github.io/Multiplayer-Pong/> once deployed (see [Deploying](docs/DEPLOY.md)). The server sleeps when idle on its free tier; while it wakes up, the page offers a match against the computer that runs entirely in your browser.

**Before and after:** this is a rebuild of a 2022 course project, kept at [`v1-original`](https://github.com/RDBagwell/Multiplayer-Pong/tree/a3802b7) (commit `a3802b7`). [`docs/ORIGINAL.md`](docs/ORIGINAL.md) lists what was wrong with it: the players' browsers decided where the ball was, matchmaking broke after one disconnect, and the ball ran faster on faster screens.

## What to look at

If you have five minutes:

1. **[`docs/NETCODE.md`](docs/NETCODE.md)**: each technique in plain language with a timeline diagram, how it's implemented here, and what it costs.
2. **The network lab**: start *Play vs. computer → Play online*, open **Network lab**, pick *Satellite* and turn **Prediction** off, then on.
3. **[`client/src/netcode/`](client/src/netcode)**: one small, documented file per technique ([`ClockSync`](client/src/netcode/ClockSync.ts), [`Prediction`](client/src/netcode/Prediction.ts), [`Reconciliation`](client/src/netcode/Reconciliation.ts), [`Interpolation`](client/src/netcode/Interpolation.ts)), combined in [`GameClient`](client/src/netcode/GameClient.ts).
4. **[`shared/step.ts`](shared/step.ts)**: the deterministic 60 Hz simulation that the server, the browser and the offline mode all run, with swept collision so a fast ball never tunnels.
5. **[`tests/harness/`](tests/harness/harness.ts)**: a real server and real clients in one process on a virtual clock, used to prove the netcode converges under bad networks, and reused for the load test.
6. **[`docs/BENCHMARKS.md`](docs/BENCHMARKS.md)**: measured bandwidth per player and server cost per room, with the commands to reproduce them.
7. **[`SECURITY.md`](SECURITY.md)**: the server trusts nothing a client says about itself; clients send intentions, never positions.

## How to play

- **Quick match**: plays the next person who's waiting. Open a second tab to play yourself.
- **Private room**: creates a room and an invite link; a spectator link lets anyone watch.
- **Play vs. computer**: easy, medium or hard. *Online* runs on the server, so the network lab works; *offline* runs entirely in your browser.
- First to 7. Serves alternate, the ball speeds up with every hit, and where it meets the paddle sets the angle.
- If a player's connection drops, the match pauses for up to 30 s; a reload gets their paddle back.

**Controls:** `W`/`S` or `↑`/`↓`; the mouse over the field; or, on a touch screen, drag anywhere on your half. On a phone in portrait the field turns so your paddle is at the bottom. `L` opens the network lab, `M` mutes.

## Run it locally

Requires Node 22.12 or later. The server runs its TypeScript directly with Node's built-in type stripping: no build step, no ts-node.

```bash
npm install
npm run dev        # game server on :3000, then Vite on :5173 → open http://localhost:5173
```

| Command | What it does |
|---|---|
| `npm test` | Unit, integration and headless-netcode tests (vitest) |
| `npm run test:e2e` | Browser test (Playwright): the offline fallback with the server unreachable |
| `npm run typecheck` | `tsc --noEmit` for the server/shared code and the browser client |
| `npm run build` | Builds the client into `client/dist` |
| `npm start` | Runs the server, which also serves `client/dist` → http://localhost:3000 |
| `node --experimental-strip-types scripts/bench/bandwidth.ts` | Bandwidth per player ([BENCHMARKS.md](docs/BENCHMARKS.md)) |
| `node --experimental-strip-types scripts/bench/load.ts 10,50,200` | Server load test ([BENCHMARKS.md](docs/BENCHMARKS.md)) |

Configuration is by environment variable; see [`.env.example`](.env.example). Notable: `SNAPSHOT_RATE` (default 20), and `LAG_COMPENSATION=true` for [bounded lag compensation](docs/HIT_FAIRNESS.md).

## Deployment

The client is a static site on **GitHub Pages** and the server a free **Render** web service, the same split as Chat Mafia. [`docs/DEPLOY.md`](docs/DEPLOY.md) has every click. In short: create the Render Blueprint from `render.yaml` with `ALLOWED_ORIGINS=https://rdbagwell.github.io`, put the Render URL in the `GAME_SERVER_URL` repository variable, and set Pages to deploy from GitHub Actions.

**Cold starts.** Render's free tier puts the server to sleep after a while without traffic, and the first visitor afterwards waits while it starts again. The landing screen shows "Waking the server…" and, after 1.5 s (or at once if the connection is refused), offers **Play the computer offline**, which needs no server at all. The online buttons switch on by themselves when the server answers.

## Project layout

```
shared/            Imported by both sides (and the offline mode)
  step.ts          The deterministic fixed-step simulation (60 Hz)
  physics.ts       Swept collision, paddles, bounce rules
  bot.ts           The computer opponent
  protocol.ts      Every message, its zod schema, and the snapshot encoding
server/
  rooms/           Room (loop, inputs, snapshots, pause/forfeit, rematch), InputQueue,
                   LagCompensator, MatchQueue, RoomManager
  sockets/         The Socket.io boundary: validation, rate limits, sessions
  security/        Tokens, room codes, token buckets
client/src/
  netcode/         ClockSync, Prediction, Reconciliation, Interpolation, GameClient (no DOM)
  net/             Connection, NetworkSimulator, Session, ServerStatus, presets
  offline/         OfflineMatch: the whole game in the browser
  render/          Canvas renderer and effects (trail, flash, shake)
  audio/, input/, ui/   Web Audio blips, controls, landing screen and the lab panel
tests/
  shared/          Determinism, collision at every angle and speed, rules
  server/          Room loop, bot, lag compensation
  integration/     Security and matchmaking with real socket.io-client connections
  harness/         Headless harness: real server + clients on a virtual clock
  netcode/         Convergence, reconciliation, interpolation, full matches under bad networks
  client/          Offline mode, fallback offer, effects, DOM safety
  deploy/          The GitHub Pages build
  e2e/             Playwright: offline fallback in a real browser
scripts/           dev launcher, Pages build, benchmarks
docs/              NETCODE, BENCHMARKS, DEPLOY, HIT_FAIRNESS, ORIGINAL
```
