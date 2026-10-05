import { TICK_MS, TICK_RATE } from "../../../shared/constants.ts";
import { Bot, BOT_LABELS } from "../../../shared/bot.ts";
import { decodeSnapshot, encodeSnapshot, type Difficulty, type RoomInfo } from "../../../shared/protocol.ts";
import { createInitialState, type GameState } from "../../../shared/state.ts";
import { step } from "../../../shared/step.ts";
import type { ClientView, InputSource } from "../netcode/GameClient.ts";

/** Longest stretch of time simulated in one update (a background tab coming back skips the rest). */
const MAX_CATCH_UP_MS = 250;

/**
 * Play vs. computer with no server at all.
 *
 * Because the simulation is a pure function in `shared/`, the browser can run
 * the whole match itself: the same 60 Hz `step()` the server runs, the same
 * `Bot` the server uses for online bot matches, and the same fixed-step
 * accumulator. Nothing is sent anywhere. It exists so that a visitor is
 * never stuck while the free-tier server wakes up.
 *
 * It produces the same `ClientView` and `RoomInfo` shapes as an online match,
 * so the renderer, the HUD and the effects don't know the difference.
 */
export class OfflineMatch {
    readonly difficulty: Difficulty;
    state: GameState;
    input: InputSource = () => 0;
    private previous: GameState;
    private bot: Bot;
    private accumulator = 0;
    private lastUpdate: number | null = null;
    private readonly random: () => number;
    private readonly seed: () => number;

    constructor(difficulty: Difficulty, options: { random?: () => number; seed?: () => number } = {}) {
        this.difficulty = difficulty;
        this.random = options.random ?? Math.random;
        this.seed = options.seed ?? (() => Math.floor(this.random() * 2 ** 32));
        this.state = createInitialState(this.seed());
        this.previous = this.state;
        this.bot = new Bot(1, difficulty, this.random);
    }

    get over(): boolean {
        return this.state.phase === "over";
    }

    /** Advances the simulation to local time `now` in whole ticks. */
    update(now: number): void {
        const elapsed = this.lastUpdate === null ? 0 : Math.min(MAX_CATCH_UP_MS, Math.max(0, now - this.lastUpdate));
        this.lastUpdate = now;
        this.accumulator += elapsed;
        while (this.accumulator >= TICK_MS) {
            this.accumulator -= TICK_MS;
            this.tick();
        }
    }

    /** One fixed step: the player's input and the bot's, exactly as the server would apply them. */
    tick(): void {
        this.previous = this.state;
        this.state = step(this.state, [this.input(this.state.paddles[0].y), this.bot.decide(this.state)]);
    }

    rematch(): void {
        const tick = this.state.tick;
        this.state = { ...createInitialState(this.seed()), tick };
        this.previous = this.state;
        this.bot = new Bot(1, this.difficulty, this.random);
    }

    /** What to draw: blended between the last two ticks so motion is smooth at any refresh rate. */
    view(): ClientView {
        const s = this.state;
        const p = this.previous;
        const t = Math.min(1, this.accumulator / TICK_MS);
        const sameRally = p.rally === s.rally && p.phase === s.phase;
        const mix = (a: number, b: number) => (sameRally ? a + (b - a) * t : b);
        return {
            ball: { x: mix(p.ball.x, s.ball.x), y: mix(p.ball.y, s.ball.y) },
            paddleY: [mix(p.paddles[0].y, s.paddles[0].y), mix(p.paddles[1].y, s.paddles[1].y)],
            score: s.score,
            phase: s.phase,
            phaseTicks: s.phaseTicks,
            paused: false,
            winner: s.winner,
            server: s.server,
            you: 0,
            truth: decodeSnapshot(encodeSnapshot(s, [-1, -1])),
            renderTick: s.tick + t,
            mode: "local",
        };
    }

    /** Room info in the same shape an online match sends, for the HUD. */
    info(): RoomInfo {
        return {
            code: "OFFLINE",
            mode: "bot",
            status: this.over ? "over" : "playing",
            you: 0,
            seats: [
                { kind: "human", connected: true, rematch: false, label: "Player 1" },
                { kind: "bot", connected: true, rematch: true, label: BOT_LABELS[this.difficulty] },
            ],
            spectators: 0,
            pause: null,
            forfeited: -1,
            settings: { tickRate: TICK_RATE, snapshotRate: TICK_RATE, lagCompensation: false, lagCompensationMaxMs: 0 },
        };
    }
}
