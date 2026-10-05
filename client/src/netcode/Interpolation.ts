import { BALL_RADIUS, FIELD_WIDTH, PADDLE_FACE_X, TICK_DT, TICK_MS } from "../../../shared/constants.ts";
import { stepPaddle, sweepBall } from "../../../shared/physics.ts";
import type { Snapshot } from "../../../shared/protocol.ts";
import type { BallState } from "../../../shared/state.ts";

/**
 * Technique 4 — Entity interpolation.
 *
 * Snapshots arrive 20 times a second, at irregular intervals, and some never
 * arrive. Drawing each object where the latest snapshot says makes it jump
 * 20 times a second and stutter whenever the network hiccups.
 *
 * Instead, the client draws the ball and the opponent slightly in the past:
 * at "render time" = the server's current tick minus a delay of about two
 * snapshot intervals (100 ms at 20 Hz). At that time it almost always has a
 * snapshot on each side, and draws the motion between them. The cost is
 * that you see others 100 ms late, which is why the delay is kept as small
 * as the network allows: it grows with measured jitter and shrinks back
 * when the network calms down, slowly enough that motion never stalls or
 * runs backwards.
 *
 * Paddles are interpolated linearly. The ball is traced along its real path
 * instead: from the older snapshot forward and the newer one backward, using
 * the shared physics in free flight, so it bounces off walls in exactly the
 * right place instead of cutting the corner. Across a paddle hit it switches
 * from one trace to the other at the paddle face.
 *
 * When the next snapshot is late (a gap), it extrapolates from the newest
 * one for up to 100 ms, then holds still until data arrives.
 */

/** "local": an offline match, simulated in the browser (no network at all). */
export type InterpolationMode = "waiting" | "interpolating" | "extrapolating" | "holding" | "raw" | "local";

export interface EntityView {
    /** The (fractional) server tick being drawn. */
    renderTick: number;
    ball: { x: number; y: number };
    paddleY: [number, number];
    /** The newest snapshot at or before renderTick: source of score, phase and countdown. */
    base: Snapshot;
    mode: InterpolationMode;
}

export interface InterpolationOptions {
    /** Never render closer to the present than this. */
    minDelayMs: number;
    maxDelayMs: number;
    /** Expected time between snapshots. */
    snapshotIntervalMs: number;
    /** How far past the newest snapshot it will guess. */
    maxExtrapolationMs: number;
    /** How fast the delay may change, as a fraction of real time (0.1 = 10%). */
    maxDelaySlew: number;
}

export const DEFAULT_INTERPOLATION: InterpolationOptions = {
    minDelayMs: 100,
    maxDelayMs: 400,
    snapshotIntervalMs: 50,
    maxExtrapolationMs: 100,
    maxDelaySlew: 0.1,
};

/** Snapshots ordered by tick. Duplicates and very old ones are dropped. */
export class SnapshotBuffer {
    readonly items: Snapshot[] = [];
    private readonly keepTicks: number;

    constructor(keepTicks = 180) {
        this.keepTicks = keepTicks;
    }

    insert(s: Snapshot): boolean {
        const items = this.items;
        let i = items.length;
        while (i > 0 && items[i - 1].tick > s.tick) i--;
        if (i > 0 && items[i - 1].tick === s.tick) return false;
        items.splice(i, 0, s);
        const newest = items[items.length - 1].tick;
        while (items.length > 2 && items[0].tick < newest - this.keepTicks) items.shift();
        return true;
    }

    get newest(): Snapshot | undefined {
        return this.items[this.items.length - 1];
    }

    clear(): void {
        this.items.length = 0;
    }
}

/** Ball position after `ticks` (may be fractional) of free flight. */
function flyForward(ball: BallState, ticks: number): BallState {
    if (ticks <= 0) return ball;
    return sweepBall(ball, ticks * TICK_DT, null, 0).ball;
}

/** Ball position `ticks` before the given state, assuming free flight. */
function flyBackward(ball: BallState, ticks: number): BallState {
    if (ticks <= 0) return ball;
    const back = flyForward({ ...ball, vx: -ball.vx, vy: -ball.vy }, ticks);
    return { ...back, vx: -back.vx, vy: -back.vy };
}

/** True if the ball is past the face of the paddle it is heading towards. */
function pastFace(ball: BallState): boolean {
    return ball.vx < 0 ? ball.x - BALL_RADIUS < PADDLE_FACE_X[0] : ball.x + BALL_RADIUS > PADDLE_FACE_X[1];
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export class Interpolator {
    readonly buffer = new SnapshotBuffer();
    options: InterpolationOptions;
    /** Current delay behind the server, in ms. */
    delayMs: number;
    /** Snapshot arrival jitter in ms (RFC 3550 estimator). */
    jitterMs = 0;
    private lastTransit: number | null = null;
    private lastRenderTick = -Infinity;
    private lastSampleAt: number | null = null;

    constructor(options: Partial<InterpolationOptions> = {}) {
        this.options = { ...DEFAULT_INTERPOLATION, ...options };
        this.delayMs = this.targetDelayMs;
    }

    /** Stores a snapshot and updates the jitter estimate. Returns false for duplicates. */
    onSnapshot(snapshot: Snapshot, receivedAt: number): boolean {
        const newest = this.buffer.newest;
        if (!this.buffer.insert(snapshot)) return false;
        if (!newest || snapshot.tick > newest.tick) {
            // Transit time relative to the server's tick clock; its variation is the jitter.
            const transit = receivedAt - snapshot.tick * TICK_MS;
            if (this.lastTransit !== null) this.jitterMs += (Math.abs(transit - this.lastTransit) - this.jitterMs) / 16;
            this.lastTransit = transit;
        }
        return true;
    }

    /** The delay it is aiming for: two snapshot intervals plus room for jitter. */
    get targetDelayMs(): number {
        const { minDelayMs, maxDelayMs, snapshotIntervalMs } = this.options;
        return Math.min(maxDelayMs, Math.max(minDelayMs, 2 * snapshotIntervalMs + 3 * this.jitterMs));
    }

    reset(): void {
        this.buffer.clear();
        this.lastTransit = null;
        this.lastRenderTick = -Infinity;
        this.lastSampleAt = null;
        this.jitterMs = 0;
        this.delayMs = this.targetDelayMs;
    }

    /**
     * What to draw at local time `now`, given the server's current tick.
     * `enabled: false` is the lab's "interpolation off": draw the newest
     * snapshot as it is.
     */
    sample(serverTick: number, now: number, enabled = true): EntityView | null {
        const items = this.buffer.items;
        if (!items.length) return null;
        const newest = items[items.length - 1];
        if (!enabled) {
            return { renderTick: newest.tick, ball: { ...newest.ball }, paddleY: [newest.paddles[0].y, newest.paddles[1].y], base: newest, mode: "raw" };
        }

        // Move the delay towards its target, no faster than maxDelaySlew of real time.
        const dt = this.lastSampleAt === null ? 0 : Math.max(0, now - this.lastSampleAt);
        this.lastSampleAt = now;
        const maxStep = dt * this.options.maxDelaySlew;
        this.delayMs += Math.max(-maxStep, Math.min(maxStep, this.targetDelayMs - this.delayMs));

        // Render time never goes backwards, even if the clock estimate does.
        const renderTick = Math.max(this.lastRenderTick, serverTick - this.delayMs / TICK_MS);
        this.lastRenderTick = renderTick;

        if (renderTick <= items[0].tick) {
            const first = items[0];
            return { renderTick, ball: { ...first.ball }, paddleY: [first.paddles[0].y, first.paddles[1].y], base: first, mode: "waiting" };
        }
        if (renderTick >= newest.tick) return this.extrapolate(newest, renderTick);

        let i = items.length - 2;
        while (i > 0 && items[i].tick > renderTick) i--;
        const a = items[i];
        const b = items[i + 1];
        const t = (renderTick - a.tick) / (b.tick - a.tick);
        return {
            renderTick,
            ball: this.ballBetween(a, b, renderTick, t),
            paddleY: [lerp(a.paddles[0].y, b.paddles[0].y, t), lerp(a.paddles[1].y, b.paddles[1].y, t)],
            base: a,
            mode: "interpolating",
        };
    }

    private ballBetween(a: Snapshot, b: Snapshot, renderTick: number, t: number): { x: number; y: number } {
        const sinceA = renderTick - a.tick;
        const untilB = b.tick - renderTick;
        if (a.phase === "playing" && b.phase === "playing" && a.rally === b.rally) {
            const fromA = flyForward(a.ball, sinceA);
            const fromB = flyBackward(b.ball, untilB);
            if (b.hits === a.hits) return { x: lerp(fromA.x, fromB.x, t), y: lerp(fromA.y, fromB.y, t) };
            // A paddle hit in between: follow A's path up to the paddle face, then B's.
            return pastFace(fromA) ? fromB : fromA;
        }
        if (a.phase === "playing") {
            // The point ended in between: keep the ball flying out of the field.
            return flyForward(a.ball, sinceA);
        }
        if (b.phase === "playing" && b.ball.vx !== 0) {
            // Served in between: centre until the serve, then B's path.
            const ticksSinceServe = Math.abs(b.ball.x - FIELD_WIDTH / 2) / Math.abs(b.ball.vx) / TICK_DT;
            return untilB > ticksSinceServe ? { ...a.ball } : flyBackward(b.ball, untilB);
        }
        return { ...a.ball };
    }

    private extrapolate(newest: Snapshot, renderTick: number): EntityView {
        const maxTicks = this.options.maxExtrapolationMs / TICK_MS;
        const ahead = renderTick - newest.tick;
        const k = newest.paused ? 0 : Math.min(ahead, maxTicks);
        const paddleY: [number, number] = [
            stepPaddle(newest.paddles[0], newest.paddles[0].dir, k * TICK_DT).y,
            stepPaddle(newest.paddles[1], newest.paddles[1].dir, k * TICK_DT).y,
        ];
        const ball = newest.phase === "playing" && k > 0 ? sweepBall(newest.ball, k * TICK_DT, paddleY, newest.hits).ball : newest.ball;
        return {
            renderTick,
            ball: { x: ball.x, y: ball.y },
            paddleY,
            base: newest,
            mode: ahead <= 1e-9 ? "interpolating" : ahead <= maxTicks ? "extrapolating" : "holding",
        };
    }
}
