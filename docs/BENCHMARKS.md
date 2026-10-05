# Benchmarks

Every number on this page comes from a run made for this document, with the command shown. Nothing is extrapolated unless it says so.

## Machine

All runs: a cloud container (Claude Code on the web) with **4 vCPUs, Intel Xeon Processor @ 2.10 GHz**, 16 GB RAM, Ubuntu 24.04.4 LTS, Linux 6.18.44, **Node v22.22.0**. Measured on 5 October 2026, on commit `a67f58c` of `showcase/polish-and-deploy` (the benchmark scripts are unchanged since).

This is not the production host. Render's free tier gives a web service a fraction of one CPU (see Render's pricing page for the current figure), so expect the capacity there to be several times lower than below. The *shape* (cost per room, where timing slips) carries over; the absolute room counts do not. To measure on another machine, run the same commands there.

## Bandwidth per player

```bash
node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/bench/bandwidth.ts 20,30
```

**Setup.** The headless harness ([`tests/harness`](../tests/harness/harness.ts)): the real server and two real clients (`socket.io-client` plus the browser's `GameClient`) in one private room, on a virtual clock, with a perfect network. Both players are the harness's scripted player, which steers towards the ball almost all the time, so input traffic is on the busy side of real play. 5 s of warm-up, then 60 s of game time measured. `SNAPSHOT_RATE` is the only setting changed between rows.

**What is counted.** Every engine.io packet each client sends or receives (inputs, snapshots, clock sync, room info and engine.io keep-alives), plus each packet's WebSocket frame header (2–4 bytes from the server, 6–8 bytes from the client, which must mask). TCP/IP and TLS overhead are **not** included. Engine.io's keep-alive ping runs on real time (every 25 s), not the virtual clock, so it is almost absent from these 60 virtual seconds; it adds a few bytes each way every 25 s.

| Snapshot rate | Download per player | Upload per player | Packets/s down / up | Input packets/s | Average snapshot |
|---|---|---|---|---|---|
| 20 Hz (default) | 3.25 kB/s | 0.96 kB/s | 21 / 15.8 | 14.8 | 155 B |
| 30 Hz | 4.83 kB/s | 0.79 kB/s | 31 / 14.1 | 13.1 | 155 B |

**Reading it.**

- Download is almost all snapshots: 20 (or 30) per second of about 155 bytes, plus one clock-sync reply per second. It scales with the snapshot rate: 30 Hz costs about 1.5 times as much as 20 Hz.
- Upload doesn't depend on the snapshot rate. It depends on how often the player changes direction: an input packet is sent only when the direction changes (and resent every 100 ms until acknowledged), so the two rows differ only because the two rallies played out differently. A player holding still sends almost nothing but one clock sync per second.
- So a server sends about 6.5 kB/s per room at 20 Hz (two players), or about 52 kbit/s, before TCP/IP.

**Why 20 Hz is the default.** With interpolation, motion looks the same at 20 and 30 Hz, and 30 Hz costs about 1.5 times the download. Its one advantage would be a shorter interpolation delay (two snapshot intervals: 67 ms instead of 100 ms), but this client keeps a 100 ms floor on that delay anyway ([`Interpolation.ts`](../client/src/netcode/Interpolation.ts)), so on a calm network 30 Hz buys nothing visible here.

## Server CPU and memory per room, and where timing slips

```bash
node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/bench/load.ts 10,50,100,200,400,600,800
# repeated for the interesting range:
node --experimental-strip-types --disable-warning=ExperimentalWarning scripts/bench/load.ts 600,700,800
```

**Setup** ([`scripts/bench/load.ts`](../scripts/bench/load.ts)). For each room count:

- the real server runs in **its own process** (`server/index.ts`, development config, `LOOP_STATS_MS=5000` so it logs its own loop timing);
- worker processes ([`load-worker.ts`](../scripts/bench/load-worker.ts), up to 100 rooms each) play that many two-player matches, **two real Socket.io connections per room**. Each room connects from its own loopback address (127.1.x.y), so the server's normal per-IP limits stay on. The players send real input packets with sequence numbers and resends, a clock sync every second, and ask for a rematch when a match ends, so every room is playing for the whole run;
- 10 s of warm-up, then 30 s measured. **CPU** is the server process's user + system time from `/proc/<pid>/stat` over those 30 s (100% = one core fully busy; the server's game loop runs on one thread). **RSS** is read at the end of the window.

**Loop timing columns.** The server calls its loop every 4 ms; each call steps every room by as many 60 Hz ticks as time allows (one tick = 16.7 ms).

- *Loop gap*: time between loop calls. Healthy is about 4–5 ms. Above 16.7 ms, rooms fall a whole tick behind between calls.
- *advance() p99*: how long one loop call takes, for all rooms.
- *Ticks per call (max)*: 1 means every room stepped at most one tick per call; more means rooms had to catch up in a burst, so snapshots bunch up.
- *Skipped ticks*: ticks dropped because the server stalled for over 250 ms.
- *Client gap*: time between snapshots as the players received them (ideal: 50 ms at 20 Hz).

| Rooms | Server CPU (1 core = 100%) | CPU per room | RSS | Loop gap p99 / max | advance() p99 | Ticks per call (max) | Skipped ticks | Snapshots/s per client | Client gap p99 / max |
|---|---|---|---|---|---|---|---|---|---|
| 10 | 5.8% | 0.58% | 110 MB | 4.92 / 6.78 ms | 0.26 ms | 1 | 0 | 20 | 53.7 / 59.3 ms |
| 50 | 12% | 0.24% | 134 MB | 4.99 / 5.46 ms | 0.39 ms | 1 | 0 | 20 | 53.9 / 54.9 ms |
| 100 | 18.9% | 0.19% | 136 MB | 5.05 / 6.53 ms | 0.66 ms | 1 | 0 | 20 | 54 / 56.3 ms |
| 200 | 29.6% | 0.15% | 148 MB | 5.08 / 27.54 ms | 1.18 ms | 2 | 0 | 20 | 53.9 / 92.9 ms |
| 400 | 56.5% | 0.14% | 189 MB | 5.11 / 21.78 ms | 2.16 ms | 2 | 0 | 20 | 54.1 / 72.7 ms |
| 600 | 82.9% | 0.14% | 186 MB | 12.26 / 28.02 ms | 6.84 ms | 2 | 0 | 20 | 57.6 / 86.5 ms |
| 800 | 103.5% | 0.13% | 237 MB | 54.5 / 110.41 ms | 26.78 ms | 7 | 0 | 19.95 | 75.5 / 136.9 ms |

Repeat run of the top of the range:

| Rooms | Server CPU (1 core = 100%) | CPU per room | RSS | Loop gap p99 / max | advance() p99 | Ticks per call (max) | Skipped ticks | Snapshots/s per client | Client gap p99 / max |
|---|---|---|---|---|---|---|---|---|---|
| 600 | 81.6% | 0.14% | 187 MB | 11.22 / 84.76 ms | 6.51 ms | 6 | 0 | 20 | 57.4 / 151.6 ms |
| 700 | 95.4% | 0.14% | 196 MB | 25.46 / 40.12 ms | 12.57 ms | 3 | 0 | 19.99 | 62.6 / 84.5 ms |
| 800 | 104% | 0.13% | 319 MB | 51.86 / 132.18 ms | 27 ms | 8 | 0 | 19.99 | 78.6 / 144.9 ms |

In every run: 0 rooms failed to start, 0 unexpected disconnects, 0 server errors.

**Reading it.**

- **Cost per room is small and nearly flat**: about 0.13–0.19% of one core per room from 100 rooms up. The higher per-room figure at 10 rooms is the fixed cost of an idle Node process and Socket.io spread over few rooms.
- **Memory** grows from 110 MB (10 rooms) to about 190 MB (600–700 rooms). Derived from the table, not measured separately: roughly 0.1–0.15 MB per room; the 800-room runs are higher and noisier because the process is saturated and garbage collection falls behind.
- **Where timing starts slipping: between 600 and 700 rooms on this machine**, as the server approaches one full core. At 600 rooms the loop gap's p99 (11–12 ms) is still inside a tick, though rare spikes appear (one 85 ms gap in the repeat run). At 700 the p99 gap (25 ms) exceeds a tick, so rooms routinely step two or three ticks at once. At 800 the process needs more than one core: gaps of 50+ ms at p99, catch-up bursts of 7–8 ticks, and players receive snapshots up to about 145 ms apart instead of 50. The game still runs at the right speed (the accumulator never loses time, and no ticks were skipped), but snapshot timing gets uneven, which interpolation then has to absorb with a longer delay.
- **Before the slip point the timing is solid**: up to 400 rooms the p99 loop gap stays at about 5 ms and every room steps one tick per call. The occasional larger max gap (e.g. 27 ms at 200 rooms) is a single pause, most likely garbage collection.

**Caveats.**

- The load generators ran on the same 4-vCPU machine as the server (up to 8 worker processes at 800 rooms), so at the top of the range the server competes with them for CPU. On a dedicated host the slip point would be somewhat higher.
- The players in the load test steer with a simple rule instead of the full browser netcode, so their input pattern is plausible but not identical to people's.
- The server's game loop and its Socket.io I/O share one Node thread; this is the limit these runs find. Scaling past it means more processes (rooms are independent, so they shard naturally by room code), which this project doesn't do.

## Reproducing

Both scripts are in [`scripts/bench`](../scripts/bench). The load test needs Linux (it reads `/proc`) and takes about 45 s per room count. The bandwidth test runs anywhere and takes a few seconds.
