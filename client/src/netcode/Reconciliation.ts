import { TICK_DT } from "../../../shared/constants.ts";
import { stepPaddle } from "../../../shared/physics.ts";
import type { PaddleState } from "../../../shared/state.ts";
import type { Predictor } from "./Prediction.ts";

/**
 * Technique 3 — Server reconciliation.
 *
 * Prediction guesses; the server decides. A snapshot says where the server
 * had our paddle at tick S, and which of our inputs it had applied by then.
 * By the time it arrives, the client has predicted several ticks past S with
 * inputs the server hadn't seen yet. Simply jumping to the server's position
 * would throw those ticks away, and the paddle would snap backwards by a
 * round trip's worth of movement on every snapshot ("rubber-banding").
 *
 * Instead: rewind to the server's state at S, then replay every input the
 * server hasn't acknowledged, tick by tick, up to the present. If the server
 * did exactly what we predicted, the replay lands on exactly the same
 * position (the simulation is deterministic) and nothing visible happens. If
 * it didn't (an input arrived late, a packet was lost, the match paused),
 * the replay lands on the corrected position, and the difference is the
 * prediction error.
 *
 * The caller decides how to show a correction: small errors are blended out
 * over a few frames, large ones applied at once (see GameClient).
 */

export interface ReconcileResult {
    /** How far the present predicted position moved (field units). 0 = the prediction was right. */
    error: number;
    /** Ticks replayed. */
    replayed: number;
}

/**
 * Reconciles `predictor` with the server's paddle at `serverTick`.
 *
 * `enabled: false` is the lab's "reconciliation off" mode: it accepts the
 * server's position as the present one without replaying, which is what a
 * naive client does, and shows the rubber-banding that replay avoids.
 */
export function reconcile(
    predictor: Predictor,
    serverTick: number,
    serverPaddle: PaddleState,
    ackSeq: number,
    { enabled = true, frozen = false }: { enabled?: boolean; frozen?: boolean } = {}
): ReconcileResult {
    predictor.acknowledge(ackSeq);
    const before = predictor.paddle;

    if (!enabled) {
        predictor.paddle = { y: serverPaddle.y, dir: predictor.dir };
        predictor.history.set(predictor.tick, predictor.paddle);
        return { error: Math.abs(before.y - predictor.paddle.y), replayed: 0 };
    }

    let paddle: PaddleState = { ...serverPaddle };
    let dir = serverPaddle.dir;
    predictor.history.set(serverTick, paddle);
    const pending = predictor.unacked;
    let next = 0;
    let replayed = 0;
    for (let tick = serverTick + 1; tick <= predictor.tick; tick++) {
        // Unacknowledged inputs stamped for this tick, or for an earlier one (late: the server will apply them as soon as they arrive).
        while (next < pending.length && pending[next].tick <= tick) dir = pending[next++].dir;
        paddle = frozen ? { ...paddle, dir } : stepPaddle(paddle, dir, TICK_DT);
        predictor.history.set(tick, paddle);
        replayed++;
    }
    predictor.paddle = paddle;
    return { error: Math.abs(before.y - paddle.y), replayed };
}
