import { TICK_DT } from "../../../shared/constants.ts";
import { stepPaddle } from "../../../shared/physics.ts";
import type { InputCommand } from "../../../shared/protocol.ts";
import type { PaddleState } from "../../../shared/state.ts";

/**
 * Technique 2 — Client-side prediction.
 *
 * Without it, pressing a key does nothing visible until the input has gone to
 * the server, been simulated, and come back in a snapshot: a full round trip
 * plus up to one snapshot interval. At 100 ms of latency that feels like
 * steering through syrup.
 *
 * Instead, the client applies its own inputs immediately, with the same
 * `stepPaddle` the server uses, so in the normal case it computes exactly the
 * position the server will compute. It runs slightly *ahead* of the server
 * (by about half a round trip) and stamps each input with the tick it applied
 * it at, so the input reaches the server just before the server simulates
 * that tick.
 *
 * Inputs are sent as changes ("from tick T, hold direction D"), numbered.
 * The predictor keeps every change the server hasn't acknowledged yet (for
 * resending, and for reconciliation to replay) and its own predicted paddle
 * for each recent tick.
 */
export class Predictor {
    /** Last tick predicted. */
    tick = -1;
    /** Predicted paddle after `tick`. */
    paddle: PaddleState = { y: 0, dir: 0 };
    /** The direction currently held. */
    dir = 0;
    /** Sent but not yet acknowledged, oldest first. */
    unacked: InputCommand[] = [];
    /** Predicted paddle after each recent tick (for reconciliation and the harness). */
    readonly history = new Map<number, PaddleState>();
    private nextSeq = 0;
    private readonly historyTicks: number;

    constructor(historyTicks = 240) {
        this.historyTicks = historyTicks;
    }

    get started(): boolean {
        return this.tick >= 0;
    }

    /** Starts (or restarts) predicting from a known server state. Sequence numbers keep counting. */
    start(tick: number, paddle: PaddleState): void {
        this.tick = tick;
        this.paddle = { ...paddle };
        this.dir = paddle.dir;
        this.history.clear();
        this.history.set(tick, this.paddle);
    }

    /**
     * Predicts one more tick holding `dir`. Returns the new input command if
     * the direction changed (the caller sends it), else null. `frozen` (the
     * match is paused) records the input but doesn't move the paddle, as on
     * the server.
     */
    advance(dir: number, frozen = false): InputCommand | null {
        const tick = this.tick + 1;
        let command: InputCommand | null = null;
        if (dir !== this.dir) {
            command = { seq: this.nextSeq++, tick, dir };
            this.unacked.push(command);
            this.dir = dir;
        }
        this.paddle = frozen ? { ...this.paddle, dir } : stepPaddle(this.paddle, dir, TICK_DT);
        this.tick = tick;
        this.history.set(tick, this.paddle);
        this.history.delete(tick - this.historyTicks);
        return command;
    }

    /** Drops commands the server has applied (sequence numbers up to `seq`). */
    acknowledge(seq: number): void {
        while (this.unacked.length && this.unacked[0].seq <= seq) this.unacked.shift();
    }

    get lastSeq(): number {
        return this.nextSeq - 1;
    }
}
