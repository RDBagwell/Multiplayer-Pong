import { BALL_RADIUS, FIELD_HEIGHT, INPUT_LEVELS, PADDLE_FACE_X, PADDLE_HALF_HEIGHT, PADDLE_SPEED, TICK_DT } from "./constants.ts";
import { clampDir, sweepBall } from "./physics.ts";
import type { Difficulty } from "./protocol.ts";
import type { BallState, GameState, Seat } from "./state.ts";

export interface BotProfile {
    /** How old the ball position the bot reacts to is (human reaction time). */
    reactionTicks: number;
    /** Standard deviation of its aim, in field units, drawn once per incoming shot. */
    aimError: number;
    /** Chance per incoming shot of misjudging badly (a "brain fade"). */
    mistakeChance: number;
    /** Fastest input it uses (out of INPUT_LEVELS). */
    maxLevel: number;
    /** It doesn't bother moving for errors smaller than this. */
    deadZone: number;
}

export const BOT_PROFILES: Record<Difficulty, BotProfile> = {
    easy: { reactionTicks: 20, aimError: 34, mistakeChance: 0.22, maxLevel: 5, deadZone: 10 },
    medium: { reactionTicks: 13, aimError: 20, mistakeChance: 0.1, maxLevel: 7, deadZone: 6 },
    hard: { reactionTicks: 8, aimError: 10, mistakeChance: 0.04, maxLevel: 8, deadZone: 3 },
};

export const BOT_LABELS: Record<Difficulty, string> = { easy: "Computer (easy)", medium: "Computer (medium)", hard: "Computer (hard)" };

/**
 * The computer opponent. It runs on the server in online bot matches, and in
 * the browser in offline mode. It produces the same thing a human client does, an
 * input direction per tick, so the simulation can't tell it apart from a
 * player. It plays like a person: it reacts to where the ball was a moment
 * ago, works out where it will arrive, aims with some error, sometimes
 * misjudges completely, and drifts back to the middle between shots.
 *
 * Its randomness is its own (Math.random by default); it doesn't touch the
 * match RNG, so it can't affect determinism.
 */
export class Bot {
    readonly seat: Seat;
    readonly difficulty: Difficulty;
    private readonly profile: BotProfile;
    private readonly random: () => number;
    private readonly seen: BallState[] = [];
    private shotKey = "";
    private error = 0;

    constructor(seat: Seat, difficulty: Difficulty, random: () => number = Math.random) {
        this.seat = seat;
        this.difficulty = difficulty;
        this.profile = BOT_PROFILES[difficulty];
        this.random = random;
    }

    /** Called once per tick with the latest state; returns the direction to hold. */
    decide(state: GameState): number {
        this.seen.push({ ...state.ball });
        if (this.seen.length > this.profile.reactionTicks + 1) this.seen.shift();
        const ball = this.seen[0];
        const paddleY = state.paddles[this.seat].y;

        let target = FIELD_HEIGHT / 2;
        const incoming = state.phase === "playing" && (this.seat === 0 ? ball.vx < 0 : ball.vx > 0);
        if (incoming) {
            // A new shot (direction changed): decide how well to read it.
            const key = `${state.rally}:${Math.sign(ball.vx)}:${state.hits}`;
            if (key !== this.shotKey) {
                this.shotKey = key;
                const blunder = this.random() < this.profile.mistakeChance;
                this.error = this.gaussian() * this.profile.aimError + (blunder ? (this.random() < 0.5 ? -1 : 1) * (PADDLE_HALF_HEIGHT + 30) : 0);
            }
            target = this.predictArrival(ball) + this.error;
        }

        const delta = target - paddleY;
        if (Math.abs(delta) < this.profile.deadZone) return 0;
        const level = (delta / (PADDLE_SPEED * TICK_DT)) * INPUT_LEVELS;
        return clampDir(Math.max(-this.profile.maxLevel, Math.min(this.profile.maxLevel, level)));
    }

    /** Where the ball will cross this bot's paddle face, following wall bounces. */
    private predictArrival(start: BallState): number {
        const faceX = this.seat === 0 ? PADDLE_FACE_X[0] + BALL_RADIUS : PADDLE_FACE_X[1] - BALL_RADIUS;
        let ball = start;
        for (let i = 0; i < 300; i++) {
            const reached = this.seat === 0 ? ball.x <= faceX : ball.x >= faceX;
            if (reached) return ball.y;
            ball = sweepBall(ball, TICK_DT, null, 0).ball;
        }
        return ball.y;
    }

    private gaussian(): number {
        // Box–Muller. Fine here: the bot is outside the deterministic simulation.
        const u = Math.max(this.random(), 1e-9);
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.random());
    }
}
