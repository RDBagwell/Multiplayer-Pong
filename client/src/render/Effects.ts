import { BALL_RADIUS, FIELD_HEIGHT, PADDLE_FACE_X } from "../../../shared/constants.ts";
import type { Seat } from "../../../shared/state.ts";
import type { ClientView } from "../netcode/GameClient.ts";

export type FxEvent =
    | { type: "hit"; seat: Seat }
    | { type: "wall" }
    | { type: "point"; seat: Seat }
    | { type: "win"; seat: Seat }
    | { type: "countdown"; n: number };

/** What the renderer needs to draw the effects for one frame. */
export interface FxFrame {
    /** Recent ball positions, oldest first. */
    trail: { x: number; y: number }[];
    /** 0..1 brightness of each paddle's hit flash. */
    flash: [number, number];
    /** Screen offset in CSS pixels (0 when reduced motion is on). */
    shake: { x: number; y: number };
}

const TRAIL_LENGTH = 10;
const FLASH_MS = 160;
const SHAKE_MS = 280;
const SHAKE_PX = 7;
/** How close to a paddle face / wall a direction change must be to count as a bounce (field units). */
const NEAR = 24;

/**
 * Turns the stream of rendered views into game-feel events: paddle hits,
 * wall bounces, points, the countdown, the win.
 *
 * Events are detected on the *rendered* timeline (where the ball visibly
 * changes direction), not the server's, so a sound plays when you see the
 * hit rather than ~100 ms earlier when the server simulated it. The same code
 * works for online matches and offline ones.
 */
export class Effects {
    reducedMotion: boolean;
    private prev: { x: number; y: number; dx: number; dy: number } | null = null;
    private score: [number, number] | null = null;
    private phase: string | null = null;
    private countdown = 0;
    private trail: { x: number; y: number }[] = [];
    private flashAt: [number, number] = [-Infinity, -Infinity];
    private shakeAt = -Infinity;
    private seed = 1;

    constructor(reducedMotion = false) {
        this.reducedMotion = reducedMotion;
    }

    reset(): void {
        this.prev = null;
        this.score = null;
        this.phase = null;
        this.countdown = 0;
        this.trail = [];
    }

    /** Feeds one rendered view; returns the events that happened since the last one. */
    update(view: ClientView, now: number): FxEvent[] {
        const events: FxEvent[] = [];
        const ball = view.ball;
        const playing = view.phase === "playing";

        if (playing && this.prev) {
            const dx = ball.x - this.prev.x;
            const dy = ball.y - this.prev.y;
            if (dx !== 0 && this.prev.dx !== 0 && Math.sign(dx) !== Math.sign(this.prev.dx)) {
                // Reversed horizontally: a paddle hit, if it happened at a paddle face.
                const seat: Seat = dx > 0 ? 0 : 1;
                const face = seat === 0 ? PADDLE_FACE_X[0] + BALL_RADIUS : PADDLE_FACE_X[1] - BALL_RADIUS;
                if (Math.abs(this.prev.x - face) < NEAR) {
                    events.push({ type: "hit", seat });
                    this.flashAt[seat] = now;
                }
            }
            if (dy !== 0 && this.prev.dy !== 0 && Math.sign(dy) !== Math.sign(this.prev.dy)) {
                const nearWall = this.prev.y < BALL_RADIUS + NEAR || this.prev.y > FIELD_HEIGHT - BALL_RADIUS - NEAR;
                if (nearWall) events.push({ type: "wall" });
            }
            this.prev = { x: ball.x, y: ball.y, dx: dx || this.prev.dx, dy: dy || this.prev.dy };
        } else {
            this.prev = playing ? { x: ball.x, y: ball.y, dx: 0, dy: 0 } : null;
        }

        if (playing) {
            this.trail.push({ x: ball.x, y: ball.y });
            if (this.trail.length > TRAIL_LENGTH) this.trail.shift();
        } else {
            this.trail = [];
        }

        if (this.score && (view.score[0] !== this.score[0] || view.score[1] !== this.score[1])) {
            const seat: Seat = view.score[0] > this.score[0] ? 0 : 1;
            events.push({ type: "point", seat });
            this.shakeAt = now;
        }
        this.score = [view.score[0], view.score[1]];

        if (view.phase === "over" && this.phase !== null && this.phase !== "over" && view.winner !== -1) {
            events.push({ type: "win", seat: view.winner });
        }
        if (view.phase === "countdown") {
            const n = Math.max(1, Math.ceil(view.phaseTicks / 30));
            if (n !== this.countdown) events.push({ type: "countdown", n });
            this.countdown = n;
        } else {
            this.countdown = 0;
        }
        this.phase = view.phase;
        return events;
    }

    frame(now: number): FxFrame {
        const flash = (at: number) => Math.max(0, 1 - (now - at) / FLASH_MS);
        let shake = { x: 0, y: 0 };
        const age = now - this.shakeAt;
        if (!this.reducedMotion && age < SHAKE_MS) {
            const strength = SHAKE_PX * (1 - age / SHAKE_MS);
            shake = { x: (this.noise() * 2 - 1) * strength, y: (this.noise() * 2 - 1) * strength };
        }
        return { trail: this.trail.slice(), flash: [flash(this.flashAt[0]), flash(this.flashAt[1])], shake };
    }

    /** Cheap deterministic noise for the shake (no need for crypto-quality randomness). */
    private noise(): number {
        this.seed = (Math.imul(this.seed, 1103515245) + 12345) >>> 0;
        return this.seed / 4294967296;
    }
}
