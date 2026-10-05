import { COUNTDOWN_TICKS, FIELD_HEIGHT, FIELD_WIDTH } from "./constants.ts";
import { nextRandom, seedFrom } from "./rng.ts";

export type Seat = 0 | 1;
export type Phase = "countdown" | "playing" | "point" | "over";
export const PHASES: readonly Phase[] = ["countdown", "playing", "point", "over"];

export interface BallState {
    x: number;
    y: number;
    /** Units per second. */
    vx: number;
    vy: number;
}

export interface PaddleState {
    /** Centre of the paddle. */
    y: number;
    /** The input direction currently held, -INPUT_LEVELS..INPUT_LEVELS. */
    dir: number;
}

/** Something that happened during the last step (for sounds, effects and lag compensation). */
export type GameEvent =
    | { type: "wall" }
    | { type: "hit"; seat: Seat }
    /** The ball crossed `seat`'s paddle face without touching the paddle. `y` is where it crossed. */
    | { type: "miss"; seat: Seat; y: number }
    | { type: "point"; seat: Seat }
    | { type: "serve"; seat: Seat }
    | { type: "win"; seat: Seat };

export interface GameState {
    tick: number;
    phase: Phase;
    /** Ticks left in the current countdown or point pause. */
    phaseTicks: number;
    /** Set by the server while a player is disconnected: time stands still except for `tick`. */
    paused: boolean;
    ball: BallState;
    paddles: [PaddleState, PaddleState];
    score: [number, number];
    /** Who serves the current (or next) rally. Serves alternate. */
    server: Seat;
    /** Ball-reset counter. Changes whenever the ball jumps back to the centre, so clients never interpolate across a reset. */
    rally: number;
    /** Paddle hits in the current rally (drives the ball speed). */
    hits: number;
    /** -1 until someone wins. */
    winner: -1 | Seat;
    /** RNG state (uint32). */
    rng: number;
    /** Events from the last step only. */
    events: GameEvent[];
}

/** The held input direction of each seat for one tick. */
export type TickInputs = readonly [number, number];

export function centredBall(): BallState {
    return { x: FIELD_WIDTH / 2, y: FIELD_HEIGHT / 2, vx: 0, vy: 0 };
}

/** A new match: paddles centred, ball waiting, countdown to the first serve. */
export function createInitialState(seed: number): GameState {
    const first = nextRandom(seedFrom(seed));
    return {
        tick: 0,
        phase: "countdown",
        phaseTicks: COUNTDOWN_TICKS,
        paused: false,
        ball: centredBall(),
        paddles: [
            { y: FIELD_HEIGHT / 2, dir: 0 },
            { y: FIELD_HEIGHT / 2, dir: 0 },
        ],
        score: [0, 0],
        server: first.value < 0.5 ? 0 : 1,
        rally: 0,
        hits: 0,
        winner: -1,
        rng: first.state,
        events: [],
    };
}

export function cloneState(s: GameState): GameState {
    return {
        ...s,
        ball: { ...s.ball },
        paddles: [{ ...s.paddles[0] }, { ...s.paddles[1] }],
        score: [s.score[0], s.score[1]],
        events: s.events.slice(),
    };
}
