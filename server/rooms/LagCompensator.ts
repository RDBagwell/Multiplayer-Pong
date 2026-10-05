import { paddleCovers } from "../../shared/physics.ts";
import type { GameState, Seat, TickInputs } from "../../shared/state.ts";
import { step } from "../../shared/step.ts";

interface PendingMiss {
    seat: Seat;
    /** Tick during which the ball crossed the paddle face. */
    tick: number;
    /** Where it crossed. */
    y: number;
}

/**
 * Bounded lag compensation for paddle hits ("hit fairness").
 *
 * The problem: a client renders the ball in the past (interpolation delay
 * plus network latency) but its own paddle in the present (prediction). So
 * the moment a player sees the ball reach their paddle is several ticks
 * after the server simulated it. A player can see a clean hit locally while
 * the server, using the paddle where it was at the earlier tick, scores a
 * miss.
 *
 * The fix: each client reports its view lag `d` (how many ticks behind its
 * own predicted tick it draws the ball). When the ball misses seat S at
 * tick T, the server waits until tick T + d, the tick at which that player
 * actually saw the ball arrive, and checks S's paddle at that tick. If it
 * covers the crossing point, the server rewinds to tick T, replays it with
 * the hit forced, and re-simulates up to now with the recorded inputs.
 *
 * The cost, which is why it is bounded and off by default: the opponent sees
 * the ball pass the paddle and then jump back, and a player can claim the
 * maximum lag to get extra reach. `d` is capped (150 ms by default), which
 * caps both effects.
 */
export class LagCompensator {
    readonly maxTicks: number;
    /** `before` is the state a tick started from; `inputs` are what it was stepped with. */
    private history: { before: GameState; inputs: TickInputs }[] = [];
    private pending: PendingMiss[] = [];
    /** Hits granted by rewinding (for logs and tests). */
    rewinds = 0;

    constructor(maxTicks: number) {
        this.maxTicks = Math.max(0, Math.floor(maxTicks));
    }

    reset(): void {
        this.history = [];
        this.pending = [];
    }

    /**
     * Call after every step with the state it started from, its inputs and
     * its result, plus each seat's reported view lag in ticks. Returns the
     * state to continue from: `after`, or a re-simulated state if a miss was
     * overturned.
     */
    afterStep(before: GameState, inputs: TickInputs, after: GameState, viewLag: readonly [number, number]): GameState {
        if (this.maxTicks === 0) return after;
        this.history.push({ before, inputs });
        if (this.history.length > this.maxTicks + 2) this.history.shift();

        for (const e of after.events) {
            if (e.type === "miss") this.pending.push({ seat: e.seat, tick: after.tick, y: e.y });
        }

        let current = after;
        const stillPending: PendingMiss[] = [];
        for (const miss of this.pending) {
            const lag = Math.min(Math.max(0, Math.floor(viewLag[miss.seat])), this.maxTicks);
            if (current.tick < miss.tick + lag) {
                stillPending.push(miss);
                continue;
            }
            // The ball has often already left the field (and a point was awarded) by
            // now; the replay from the miss undoes that too.
            if (lag > 0 && paddleCovers(current.paddles[miss.seat].y, miss.y)) {
                const rewound = this.rewind(miss, current.paddles[miss.seat].y, current.tick);
                if (rewound) {
                    current = rewound;
                    this.rewinds++;
                }
            }
        }
        this.pending = stillPending;
        return current;
    }

    /** True while a miss may still be overturned (the room waits before declaring a winner). */
    get hasPending(): boolean {
        return this.pending.length > 0;
    }

    private rewind(miss: PendingMiss, paddleY: number, now: number): GameState | null {
        const start = this.history.findIndex((h) => h.before.tick === miss.tick - 1);
        if (start < 0) return null;
        let state = step(this.history[start].before, this.history[start].inputs, undefined, { forceHit: { seat: miss.seat, paddleY } });
        for (let i = start + 1; i < this.history.length; i++) {
            this.history[i] = { before: state, inputs: this.history[i].inputs };
            state = step(state, this.history[i].inputs);
        }
        return state.tick === now ? state : null;
    }
}
