/**
 * Game rules and dimensions, shared by the server and the client.
 *
 * Units are abstract "field units"; the renderer scales them to the screen.
 * Speeds are per second and are integrated with the fixed tick length, so the
 * game runs at the same speed on every machine whatever its frame rate.
 */

// --- Time -------------------------------------------------------------------

/** Simulation steps per second, on the server and in every client. */
export const TICK_RATE = 60;
/** Length of one simulation step, in seconds. */
export const TICK_DT = 1 / TICK_RATE;
/** Length of one simulation step, in milliseconds. */
export const TICK_MS = 1000 / TICK_RATE;

// --- Field ------------------------------------------------------------------

export const FIELD_WIDTH = 800;
export const FIELD_HEIGHT = 500;

// --- Paddles ----------------------------------------------------------------

export const PADDLE_HALF_HEIGHT = 45;
export const PADDLE_WIDTH = 12;
/** Distance from the field edge to the back of a paddle. */
export const PADDLE_INSET = 20;
/** x of the face the ball bounces off, for the left (0) and right (1) paddle. */
export const PADDLE_FACE_X = [PADDLE_INSET + PADDLE_WIDTH, FIELD_WIDTH - PADDLE_INSET - PADDLE_WIDTH] as const;
/** Top speed of a paddle, in units per second. */
export const PADDLE_SPEED = 540;
/**
 * Inputs are intentions, not positions: an integer "direction" from
 * -INPUT_LEVELS (full speed up) to +INPUT_LEVELS (full speed down). Keyboards
 * send the extremes; mouse and touch send intermediate levels so the paddle
 * can stop exactly under the pointer.
 */
export const INPUT_LEVELS = 8;

// --- Ball -------------------------------------------------------------------

export const BALL_RADIUS = 7;
/** Speed of a fresh serve, in units per second. */
export const BALL_SERVE_SPEED = 380;
/** Added to the speed on every paddle hit... */
export const BALL_SPEED_INCREMENT = 24;
/** ...up to this cap: 18 units per tick, more than a paddle is thick (12). */
export const BALL_MAX_SPEED = 1080;
/**
 * Bounce direction is (±1, offset × MAX_BOUNCE_SLOPE), normalised, where
 * offset ∈ [-1, 1] is where the ball met the paddle (0 = centre). 1.6 is a
 * maximum angle of about 58° from horizontal.
 */
export const MAX_BOUNCE_SLOPE = 1.6;
/** Serve slope is drawn uniformly from ±SERVE_SLOPE (about ±31°). */
export const SERVE_SLOPE = 0.6;

// --- Match flow ---------------------------------------------------------------

export const POINTS_TO_WIN = 7;
/** Pause after a point, before the countdown (0.75 s). */
export const POINT_PAUSE_TICKS = 45;
/** Countdown before every serve (1.5 s, shown as 3-2-1). */
export const COUNTDOWN_TICKS = 90;

/**
 * Positions and velocities are rounded to this many steps per unit at the end
 * of every tick. Rounding is deterministic, keeps snapshots short on the wire,
 * and means the values a client receives are exactly the server's values.
 */
export const QUANTUM = 100;
