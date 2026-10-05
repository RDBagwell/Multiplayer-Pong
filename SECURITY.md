# Security

Multiplayer Pong is played by strangers on the internet, against a server that runs the game. This document describes what we defend against and how. It follows the same patterns as [Chat Mafia](https://github.com/RDBagwell/Chat_Mafia_Game/blob/main/SECURITY.md).

**Reporting a vulnerability:** please open a private security advisory on GitHub (**Security** tab → **Report a vulnerability**) rather than a public issue.

## Threat model

**Assets**

- The integrity of a match: the ball, the paddles and the score.
- Seats: a player's session token is their paddle.
- Server availability: a small instance whose CPU runs every match's 60 Hz simulation.

**Attackers**

- **A cheating player** with a modified client or raw Socket.io access. They send arbitrary events and payloads, forge fields, replay or guess tokens, and flood.
- **An outsider** who guesses room codes, floods connections or rooms, or embeds the page in a frame.
- **A malicious web page** that opens a WebSocket to the server from a visitor's browser (cross-site WebSocket hijacking).

**Out of scope**

- Input automation (a bot playing through a real client). The server can only check that inputs are possible, not who produced them.
- Volumetric DDoS, which only the hosting provider can absorb.
- Persistence: all state is in memory, and a restart ends every match.

## Principles

1. **The server is the authority.** It runs the only simulation that counts (`shared/step.ts`, stepped by `server/rooms/Room.ts`). Clients run the same code only to *predict* their own paddle and to draw; the server's snapshots always win.
2. **Clients send intentions, never results.** The only gameplay message is `input`: "from tick T, hold direction D". There is no message that carries a position, a velocity, a score or a seat. Fields like that are rejected by the strict schemas.
3. **Nothing a client says about itself is trusted.** A socket's seat comes only from `socket.data.membership`, which only the server sets after a successful create, join, quick match or resume.
4. **One path in.** Every event goes through `SocketController.dispatch()`: known event, rate limit, zod validation, then the handler.

## Mitigations

### Game integrity

| Rule | Where |
|---|---|
| Inputs are bound to the sender's own seat; a spectator or a player in no room can't send any. | `SocketController.input`, `Room.receiveInput` |
| Each input is applied once, in sequence-number order. Duplicates and reordered resends are ignored. | `InputQueue.receive` |
| Impossible inputs are rejected and count as abuse: a tick earlier than the previous input's, a tick more than 30 ticks (0.5 s) ahead of the server, more than 4 changes for one tick, or more than 32 waiting. | `InputQueue.receive`, `config.input` |
| Directions are integers in ±8 (8 = full speed); the paddle speed and the field bounds are the simulation's, not the client's. | `protocol.ts`, `physics.ts` |
| Randomness (serve angles) comes from a seed the server draws with `crypto.randomInt`; clients never see the RNG state. | `Room.startMatch`, `security/random.ts` |
| Errors come from a small fixed set (`ERRORS` in `SocketController.ts`). Zod messages, stack traces and internals never reach a client. | `SocketController.ts` |

### Lag compensation (off by default)

With `LAG_COMPENSATION=true`, the server checks a player's paddle at the tick they *saw* the ball arrive, not the tick it arrived on the server (see `server/rooms/LagCompensator.ts`). Clients report their own view lag, so a cheater can claim the maximum to gain reach. The claim is capped at `LAG_COMPENSATION_MAX_MS` (150 ms by default, 9 ticks), which bounds the extra reach to what a paddle travels in 150 ms. The cost to the opponent, a ball that passes a paddle and jumps back, is bounded the same way.

### Identity, sessions and rooms

- Every seat gets a **256-bit random token** (`crypto.randomBytes(32)`). The server stores only its SHA-256 hash and compares hashes in constant time. The client keeps the token in `sessionStorage` to resume after a reload or a dropped connection. `socket.id` is never used as identity, and tokens are never sent to anyone but their owner (tested).
- **Reconnect:** a valid token gives the seat back, on a new socket. If the seat is open in another tab, the old tab is detached. While a player is away the match is paused with a visible countdown; after 30 s it is forfeited.
- **Leaving** on purpose forfeits a running match and invalidates the token.
- **Room codes:** 6 characters from a 31-character unambiguous alphabet, generated with `crypto.randomInt` (about 887 million codes). Join, watch and resume attempts are limited to 20 per minute per IP. "Not found", "full" and "already started" all return the same message.
- **Quick match** pairs sockets, not IPs (two tabs on one machine can play each other), but never a socket with itself, and never a socket that has disconnected.

### Cross-origin access

- `ALLOWED_ORIGINS` is an explicit allowlist. `*` is refused at startup, and production requires `https://` origins.
- Socket.io runs **WebSocket-only**. The upgrade request always carries an `Origin` header, which `allowRequest` checks against the allowlist (CORS alone doesn't cover WebSockets). Requests with no origin or `null` are refused. This blocks cross-site WebSocket hijacking.
- Express adds CORS headers only for allow-listed origins.

### Browser hardening

- **CSP** (helmet, for the built client served by the Node server): `default-src 'self'`, `script-src 'self'` (no inline scripts), `style-src 'self'`, `connect-src 'self'` plus the same host's WebSocket, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`, `frame-ancestors 'none'`. helmet also sets `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and HSTS in production.
- The client builds its DOM with `textContent` only; no server- or user-provided string is ever parsed as HTML. The Socket.io client is bundled, not loaded from a CDN.
- The client validates what it receives with the same zod schemas, so a malformed message is dropped rather than drawn.

### Abuse and denial of service

| Limit | Value |
|---|---|
| Socket.io `maxHttpBufferSize` | 2 KB (larger frames disconnect the socket; the largest legal message is a 16-command input packet) |
| Any event per socket | 200 / 2 s (inputs at up to 60/s plus resends and clock syncs fit easily) |
| Session events per socket (create, join, rematch...) | 20 / 10 s |
| Invalid or rate-limited events before disconnect | 20 |
| Join/watch/resume attempts per IP | 20 / min |
| Room creation per IP (private rooms and bot matches) | 10 / 10 min |
| New connections per IP | 30 / min, max 20 concurrent |
| Rooms per server | 200 (`MAX_ROOMS`) |
| Spectators per room | 32 |
| Cleanup | rooms with no connected human for 2 min, and private rooms nobody joined for 30 min, are closed |
| Server loop | if the host stalls for more than 250 ms, rooms skip time instead of fast-forwarding a burst of ticks |

Rate limiters are token buckets that are pruned when full, so memory stays bounded. Per-IP limits use the real client IP behind a proxy (`CLIENT_IP_HEADER`, `TRUST_PROXY_HOPS`).

### Operations

- Every socket handler and every room loop is wrapped: an exception is logged and answered with a generic error (or closes that one room) instead of crashing the process. `uncaughtException` and `unhandledRejection` are logged.
- Logs never contain tokens.
- Configuration lives in environment variables. `.env` is gitignored, and `.env.example` is committed with no secrets (there are none today).
- CI runs `npm audit --omit=dev`.

## Tests

`tests/integration/security.test.ts` and `tests/integration/matchmaking.test.ts` run a real server and real `socket.io-client` connections. They check that a client can't move the other paddle or the ball, that positions and unknown events are rejected and never relayed, that impossible inputs are ignored, that malformed and oversized messages are rejected, that rate limits disconnect flooders, that foreign origins and long-polling are refused, that forged or foreign tokens can't take a seat, and that tokens never leak to other clients.
