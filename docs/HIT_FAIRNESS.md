# Hit fairness: "but it hit my paddle!"

A short note on why a player can see the ball hit their paddle while the server says it missed, and what the server can do about it. The full netcode write-up comes later; this covers the one technique that is a judgement call rather than a straightforward improvement.

## Why it happens

Each client draws two kinds of objects from two different moments in time:

- **Your own paddle is drawn in the future.** Prediction applies your inputs immediately, and the client runs about half a round trip ahead of the server, so your input reaches the server just before the tick it is stamped for.
- **The ball and your opponent are drawn in the past.** Interpolation draws them about 100 ms (more on a jittery network) behind the server, between two snapshots that have already arrived, and those snapshots are themselves half a round trip old when they arrive.

So the frame in which you see the ball touch your paddle combines the ball from tick *T* with your paddle from tick *T + d*, where *d* is your **view lag**: the interpolation delay plus how far ahead the client predicts (about half a round trip, plus a small safety margin), in ticks. The server judges the hit at tick *T*, using your paddle at tick *T*.

If you were still moving the paddle into place during those *d* ticks (which is exactly what you do when you reach for a ball), the server's paddle at *T* was short of where yours was when you saw the ball arrive. You saw a hit, and the server scored a miss. With a 100 ms round trip and a 100 ms interpolation delay, *d* is at least 150 ms, 9 ticks, and a paddle at full speed covers 9 units per tick (540 units/s), so the gap can be 81 units: almost a paddle's length (90).

Nobody is cheating and nothing is broken. The two views are each correct for their own moment.

## What the server can do: bounded lag compensation

With `LAG_COMPENSATION=true`, the server favours the defender, within a limit:

1. Every input packet carries the client's view lag *d*, in ticks.
2. When the ball crosses a paddle face without hitting it at tick *T*, the server doesn't decide yet. It keeps simulating, and the ball keeps flying.
3. At tick *T + d*, the tick at which that player actually saw the ball arrive, it checks the player's paddle. If the paddle covers the point where the ball crossed, the server **rewinds**: it goes back to the state before tick *T*, replays that tick with the hit forced, and re-simulates every tick since with the recorded inputs of both players. The simulation is deterministic, so the replay is exact.
4. *d* is capped by `LAG_COMPENSATION_MAX_MS` (150 ms, 9 ticks, by default).

The implementation is `server/rooms/LagCompensator.ts`; `tests/server/room.test.ts` checks that a miss the player didn't see is overturned, and that the cap holds.

## The trade-off, honestly

Lag compensation doesn't remove the disagreement; it moves it to the other player.

- **The attacker sees the ball go past the paddle and then come back.** For up to *d* ticks the server (and so the opponent) has the ball behind the paddle, sometimes already out of the field with the point on the scoreboard. The rewind undoes both. The bigger *d*, the bigger the jump.
- **It gives reach.** A paddle gets *d* extra ticks to reach the ball. A client can lie about *d* to always get the maximum. The cap bounds this: in 150 ms a paddle travels at most 81 units, less than one paddle length (90). Without a cap, a player on a slow connection, or claiming one, would be nearly unbeatable.
- **It rewards latency.** Two honest players with different connections get different amounts of help.
- **It costs memory and CPU.** The server keeps the last *d* ticks of states and inputs, and a rewind re-simulates up to *d* ticks.

That is why it is **off by default**. In Pong, both players' perception of the ball is equally delayed, and the rubber-banding it causes is very visible on a small, empty field. In a shooter, the shooter's experience is what matters most and the target rarely notices, so the trade usually goes the other way.

## What the client does regardless

- The lab's **"Show the truth"** ghost draws exactly what the server last reported, so a player can see the gap for themselves.
- Interpolation keeps its delay as low as the measured jitter allows, which keeps *d*, and the disagreement, as small as possible.
