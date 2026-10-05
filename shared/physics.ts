import {
    BALL_MAX_SPEED,
    BALL_RADIUS,
    BALL_SERVE_SPEED,
    BALL_SPEED_INCREMENT,
    FIELD_HEIGHT,
    INPUT_LEVELS,
    MAX_BOUNCE_SLOPE,
    PADDLE_FACE_X,
    PADDLE_HALF_HEIGHT,
    PADDLE_SPEED,
    QUANTUM,
} from "./constants.ts";
import type { BallState, GameEvent, PaddleState, Seat } from "./state.ts";

/*
 * Determinism notes
 * -----------------
 * The simulation uses only +, -, *, /, Math.sqrt, Math.round, Math.min/max
 * and comparisons on doubles. IEEE 754 requires these to be correctly
 * rounded, so V8, SpiderMonkey and JavaScriptCore produce bit-identical
 * results. Trigonometry (Math.sin, Math.atan2...) is NOT required to be
 * correctly rounded and differs between engines, so it is never used: bounce
 * and serve directions are built from a slope and normalised with sqrt.
 */

/** Rounds to the simulation's resolution (1/QUANTUM units). Also turns -0 into 0. */
export function quantize(v: number): number {
    return Math.round(v * QUANTUM) / QUANTUM + 0;
}

export function clamp(v: number, lo: number, hi: number): number {
    return v < lo ? lo : v > hi ? hi : v;
}

/** Coerces any input to a legal direction (an integer in ±INPUT_LEVELS). */
export function clampDir(dir: number): number {
    if (!Number.isFinite(dir)) return 0;
    return clamp(Math.round(dir), -INPUT_LEVELS, INPUT_LEVELS);
}

const PADDLE_MIN_Y = PADDLE_HALF_HEIGHT;
const PADDLE_MAX_Y = FIELD_HEIGHT - PADDLE_HALF_HEIGHT;

/** Moves one paddle for one step. Used by the full simulation and by client-side prediction. */
export function stepPaddle(paddle: PaddleState, dir: number, dt: number): PaddleState {
    const d = clampDir(dir);
    const y = paddle.y + (d / INPUT_LEVELS) * PADDLE_SPEED * dt;
    return { y: quantize(clamp(y, PADDLE_MIN_Y, PADDLE_MAX_Y)), dir: d };
}

/** Speed of the ball after `hits` paddle hits in a rally. */
export function ballSpeedAfterHits(hits: number): number {
    return Math.min(BALL_SERVE_SPEED + hits * BALL_SPEED_INCREMENT, BALL_MAX_SPEED);
}

/** Velocity with horizontal sign `dirX` and the given slope (vy/|vx|), scaled to `speed`. */
export function velocityFromSlope(dirX: 1 | -1, slope: number, speed: number): { vx: number; vy: number } {
    const len = Math.sqrt(1 + slope * slope);
    return { vx: (dirX * speed) / len, vy: (slope * speed) / len };
}

/** Where on the paddle the ball hit: -1 (top edge) .. 0 (centre) .. 1 (bottom edge). */
export function hitOffset(ballY: number, paddleY: number): number {
    return clamp((ballY - paddleY) / (PADDLE_HALF_HEIGHT + BALL_RADIUS), -1, 1);
}

export function paddleCovers(paddleY: number, ballY: number): boolean {
    return Math.abs(ballY - paddleY) <= PADDLE_HALF_HEIGHT + BALL_RADIUS;
}

export interface SweepOptions {
    /**
     * Lag compensation (server only): treat a crossing of this seat's paddle
     * face as a hit, with the paddle at `paddleY`. See server/rooms/LagCompensator.ts.
     */
    forceHit?: { seat: Seat; paddleY: number };
}

export interface SweepResult {
    ball: BallState;
    hits: number;
    events: GameEvent[];
}

const MAX_CONTACTS_PER_STEP = 8;
const EPS = 1e-9;

/**
 * Moves the ball through one step with continuous (swept) collision.
 *
 * Instead of moving the ball and then checking for overlap (which lets a fast
 * ball jump straight over a paddle), it computes the exact time within the
 * step at which the ball would touch each wall or paddle face, handles the
 * earliest contact, and continues with the time that is left. A ball at any
 * speed therefore meets every surface in its path.
 *
 * `paddleYs` null means free flight (walls only), which clients use to trace
 * the ball between two snapshots.
 */
export function sweepBall(
    start: BallState,
    dt: number,
    paddleYs: readonly [number, number] | null,
    hitsSoFar: number,
    options: SweepOptions = {}
): SweepResult {
    const ball = { ...start };
    const events: GameEvent[] = [];
    let hits = hitsSoFar;
    let remaining = dt;
    let missed: Seat | null = null;
    const r = BALL_RADIUS;

    for (let contact = 0; contact < MAX_CONTACTS_PER_STEP && remaining > 0; contact++) {
        let tMin = Infinity;
        let what: "top" | "bottom" | Seat | null = null;

        if (ball.vy < 0) {
            const t = Math.max(0, (r - ball.y) / ball.vy);
            if (t < tMin) [tMin, what] = [t, "top"];
        } else if (ball.vy > 0) {
            const t = Math.max(0, (FIELD_HEIGHT - r - ball.y) / ball.vy);
            if (t < tMin) [tMin, what] = [t, "bottom"];
        }
        if (paddleYs) {
            // Only a ball still in front of a face can hit it.
            if (ball.vx < 0 && ball.x - r >= PADDLE_FACE_X[0] - EPS) {
                const t = Math.max(0, (PADDLE_FACE_X[0] + r - ball.x) / ball.vx);
                if (t < tMin) [tMin, what] = [t, 0];
            } else if (ball.vx > 0 && ball.x + r <= PADDLE_FACE_X[1] + EPS) {
                const t = Math.max(0, (PADDLE_FACE_X[1] - r - ball.x) / ball.vx);
                if (t < tMin) [tMin, what] = [t, 1];
            }
        }

        if (what === null || tMin > remaining) break;

        ball.x += ball.vx * tMin;
        ball.y += ball.vy * tMin;
        remaining -= tMin;

        if (what === "top") {
            ball.y = r;
            ball.vy = -ball.vy;
            events.push({ type: "wall" });
        } else if (what === "bottom") {
            ball.y = FIELD_HEIGHT - r;
            ball.vy = -ball.vy;
            events.push({ type: "wall" });
        } else {
            const seat = what;
            const forced = options.forceHit?.seat === seat ? options.forceHit : null;
            const paddleY = forced ? forced.paddleY : paddleYs![seat];
            ball.x = seat === 0 ? PADDLE_FACE_X[0] + r : PADDLE_FACE_X[1] - r;
            if (forced || paddleCovers(paddleY, ball.y)) {
                hits++;
                const v = velocityFromSlope(seat === 0 ? 1 : -1, hitOffset(ball.y, paddleY) * MAX_BOUNCE_SLOPE, ballSpeedAfterHits(hits));
                ball.vx = v.vx;
                ball.vy = v.vy;
                events.push({ type: "hit", seat });
            } else {
                events.push({ type: "miss", seat, y: ball.y });
                missed = seat;
                // Nudge past the face so the next iteration sees the ball behind it.
                ball.x += seat === 0 ? -EPS * 10 : EPS * 10;
            }
        }
    }

    if (remaining > 0) {
        ball.x += ball.vx * remaining;
        ball.y += ball.vy * remaining;
    }
    ball.x = quantize(ball.x);
    // Rounding must never put a ball that just missed back in front of the face.
    if (missed === 0) ball.x = Math.min(ball.x, quantize(PADDLE_FACE_X[0] + r - 1 / QUANTUM));
    if (missed === 1) ball.x = Math.max(ball.x, quantize(PADDLE_FACE_X[1] - r + 1 / QUANTUM));
    ball.y = quantize(clamp(ball.y, r, FIELD_HEIGHT - r));
    ball.vx = quantize(ball.vx);
    ball.vy = quantize(ball.vy);
    return { ball, hits, events };
}
