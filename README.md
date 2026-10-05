# Pong netcode lab

Multiplayer Pong built the way real online games are: the server runs the only simulation that counts, and each client hides the network with **clock sync**, **client-side prediction**, **server reconciliation** and **entity interpolation**. A built-in **network lab** lets you add latency, jitter and packet loss and switch each technique off, to feel why it exists.

The game is deliberately simple so the networking is the story. This is a rebuild of a 2022 course project; [`docs/ORIGINAL.md`](docs/ORIGINAL.md) records what was wrong with the original (tagged `v1-original`).

## Run it

Requires Node 22.18 or later (the server runs its TypeScript directly with Node's built-in type stripping).

```bash
npm install
npm run dev        # game server on :3000 + Vite on :5173 -> open http://localhost:5173
```

Other scripts:

| Command | What it does |
|---|---|
| `npm test` | All tests (simulation, server, security, matchmaking, headless netcode harness) |
| `npm run typecheck` | `tsc --noEmit` for the server/shared code and the browser client |
| `npm run build` | Builds the client into `client/dist` |
| `npm start` | Runs the server, which also serves `client/dist` → http://localhost:3000 |

Configuration is by environment variable; see [`.env.example`](.env.example). Notable: `SNAPSHOT_RATE` (default 20), `LAG_COMPENSATION=true` to turn on [bounded lag compensation](docs/HIT_FAIRNESS.md).

## Play

- **Against the computer:** easy, medium or hard. The bot reacts with a delay and makes human mistakes.
- **Quick match:** pairs you with the next person waiting (open a second tab to play yourself).
- **Private room:** share the invite link or the 6-letter code. A spectator link lets anyone watch.
- First to 7. If a player drops, the match pauses for up to 30 s and a reload gets their paddle back.

**Controls:** `W`/`S` or `↑`/`↓`; or the mouse over the field; or on a touch screen, drag anywhere on your half. On a phone in portrait the field turns so your paddle is at the bottom. `L` opens the network lab.

## The network lab

Open **Network lab** during any match:

- **Network:** added round-trip latency (0–500 ms), jitter (0–150 ms) and packet loss (0–30%), applied to the game traffic in both directions; presets for *Same city*, *Across the country*, *Bad Wi-Fi* and *Satellite*.
- **Netcode:** switch prediction, reconciliation and interpolation on and off, each with a one-line explanation.
- **Show the truth:** a dashed outline of the latest raw server snapshot behind what you see.
- **Live:** round trip, jitter, updates received and lost, bytes per second each way, prediction corrections per second, and the interpolation delay.

Things to try: *Satellite* with prediction off (your paddle wades through syrup); 150 ms of latency with reconciliation off (your paddle snaps back on every update); interpolation off at any setting (the ball and opponent jump 20 times a second).

## Project layout

```
shared/            Imported by both sides
  step.ts          The deterministic fixed-step simulation (60 Hz)
  physics.ts       Swept collision, paddles, bounce rules
  protocol.ts      Every message, its zod schema, and the snapshot encoding
server/
  rooms/Room.ts    One match: accumulator loop, input queues, snapshots, pause/forfeit, rematch
  rooms/InputQueue.ts, LagCompensator.ts, MatchQueue.ts, RoomManager.ts
  bots/Bot.ts      The computer opponent
  sockets/SocketController.ts   The Socket.io boundary: validation, rate limits, sessions
  security/        Tokens, room codes, token buckets
client/src/
  netcode/         One file per technique: ClockSync, Prediction, Reconciliation,
                   Interpolation, and GameClient which combines them (no DOM)
  net/             Connection, NetworkSimulator, Session, presets
  render/, input/, ui/   Canvas renderer, controls, menus and the lab panel
tests/
  shared/          Determinism, collision at every angle and speed, rules
  server/          Room loop, bot, lag compensation
  integration/     Security and matchmaking with real socket.io-client connections
  harness/         Headless harness: real server + clients on a virtual clock
  netcode/         Convergence, reconciliation, interpolation, full matches under bad networks
docs/              ORIGINAL.md, HIT_FAIRNESS.md
```

Security design and limits: [`SECURITY.md`](SECURITY.md).
