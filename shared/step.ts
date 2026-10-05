import {
    BALL_RADIUS,
    BALL_SERVE_SPEED,
    COUNTDOWN_TICKS,
    FIELD_WIDTH,
    POINT_PAUSE_TICKS,
    POINTS_TO_WIN,
    SERVE_SLOPE,
    TICK_DT,
} from "./constants.ts";
import { quantize, stepPaddle, sweepBall, velocityFromSlope, type SweepOptions } from "./physics.ts";
import { nextRandom } from "./rng.ts";
import { centredBall, cloneState, type GameState, type Seat, type TickInputs } from "./state.ts";

export type StepOptions = SweepOptions;

/**
 * Advances the match by one fixed step. Pure and deterministic: it never
 * mutates `state`, reads no clock and no Math.random, so the same state and
 * inputs always give a bit-identical result, on the server and in any browser.
 *
 * `dt` is always TICK_DT in the game (the server and clients run the same
 * fixed tick); it's a parameter so tests can exercise other step sizes.
 *
 * Order within a step: paddles move first, then the ball is swept against the
 * paddles' new positions.
 */
export function step(state: GameState, inputs: TickInputs, dt: number = TICK_DT, options: StepOptions = {}): GameState {
    const s = cloneState(state);
    s.tick = state.tick + 1;
    s.events = [];
    if (s.paused) return s;

    s.paddles = [stepPaddle(s.paddles[0], inputs[0], dt), stepPaddle(s.paddles[1], inputs[1], dt)];

    switch (s.phase) {
        case "over":
            break;
        case "point":
            if (--s.phaseTicks <= 0) {
                s.phase = "countdown";
                s.phaseTicks = COUNTDOWN_TICKS;
            }
            break;
        case "countdown":
            if (--s.phaseTicks <= 0) serve(s);
            break;
        case "playing": {
            const result = sweepBall(s.ball, dt, [s.paddles[0].y, s.paddles[1].y], s.hits, options);
            s.ball = result.ball;
            s.hits = result.hits;
            s.events.push(...result.events);
            if (s.ball.x + BALL_RADIUS < 0) awardPoint(s, 1);
            else if (s.ball.x - BALL_RADIUS > FIELD_WIDTH) awardPoint(s, 0);
            break;
        }
    }
    return s;
}

/** Launches the ball from the centre towards the receiver at a seeded random angle. */
function serve(s: GameState): void {
    const r = nextRandom(s.rng);
    s.rng = r.state;
    const slope = (r.value * 2 - 1) * SERVE_SLOPE;
    const v = velocityFromSlope(s.server === 0 ? 1 : -1, slope, BALL_SERVE_SPEED);
    s.ball = { ...centredBall(), vx: quantize(v.vx), vy: quantize(v.vy) };
    s.phase = "playing";
    s.phaseTicks = 0;
    s.hits = 0;
    s.events.push({ type: "serve", seat: s.server });
}

function awardPoint(s: GameState, scorer: Seat): void {
    s.score[scorer]++;
    s.events.push({ type: "point", seat: scorer });
    s.ball = centredBall();
    s.rally++;
    s.hits = 0;
    if (s.score[scorer] >= POINTS_TO_WIN) {
        s.phase = "over";
        s.phaseTicks = 0;
        s.winner = scorer;
        s.events.push({ type: "win", seat: scorer });
        return;
    }
    s.phase = "point";
    s.phaseTicks = POINT_PAUSE_TICKS;
    s.server = s.server === 0 ? 1 : 0;
}
