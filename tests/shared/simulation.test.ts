import { describe, expect, it } from "vitest";
import {
    BALL_MAX_SPEED,
    BALL_RADIUS,
    BALL_SERVE_SPEED,
    BALL_SPEED_INCREMENT,
    COUNTDOWN_TICKS,
    FIELD_HEIGHT,
    FIELD_WIDTH,
    INPUT_LEVELS,
    MAX_BOUNCE_SLOPE,
    PADDLE_FACE_X,
    PADDLE_HALF_HEIGHT,
    PADDLE_SPEED,
    PADDLE_WIDTH,
    POINT_PAUSE_TICKS,
    POINTS_TO_WIN,
    TICK_DT,
} from "../../shared/constants.ts";
import { ballSpeedAfterHits, clampDir, stepPaddle, sweepBall, velocityFromSlope } from "../../shared/physics.ts";
import { nextRandom } from "../../shared/rng.ts";
import { createInitialState, type GameState, type Seat, type TickInputs } from "../../shared/state.ts";
import { step } from "../../shared/step.ts";

/** A reproducible input log: each seat changes direction at random ticks. */
function randomInputLog(seed: number, ticks: number): TickInputs[] {
    let rng = seed;
    const log: TickInputs[] = [];
    const dirs: [number, number] = [0, 0];
    for (let t = 0; t < ticks; t++) {
        for (const seat of [0, 1] as const) {
            const a = nextRandom(rng);
            rng = a.state;
            if (a.value < 0.08) {
                const b = nextRandom(rng);
                rng = b.state;
                dirs[seat] = Math.round(b.value * 2 * INPUT_LEVELS) - INPUT_LEVELS;
            }
        }
        log.push([dirs[0], dirs[1]]);
    }
    return log;
}

function run(state: GameState, log: readonly TickInputs[]): GameState[] {
    const states = [state];
    for (const inputs of log) states.push(step(states.at(-1)!, inputs));
    return states;
}

/** Inputs that make a seat chase the ball as well as its top speed allows. */
function chase(s: GameState, seat: Seat): number {
    const delta = s.ball.y - s.paddles[seat].y;
    return clampDir((delta / (PADDLE_SPEED * TICK_DT)) * INPUT_LEVELS);
}

function deepFreeze<T>(o: T): T {
    if (o && typeof o === "object") {
        Object.freeze(o);
        for (const v of Object.values(o)) deepFreeze(v);
    }
    return o;
}

describe("determinism", () => {
    it("replaying the same input log from the same state gives bit-identical states", () => {
        const log = randomInputLog(12345, 20_000);
        const a = run(createInitialState(42), log);
        const b = run(createInitialState(42), log);
        expect(a.length).toBe(b.length);
        for (let i = 0; i < a.length; i++) {
            // JSON of a double is its shortest round-trip form, so equal strings mean equal bits.
            expect(JSON.stringify(b[i])).toBe(JSON.stringify(a[i]));
        }
        // The log actually exercised the game.
        const final = a.at(-1)!;
        expect(final.score[0] + final.score[1]).toBeGreaterThan(0);
        expect(a.some((s) => s.events.some((e) => e.type === "hit"))).toBe(true);
    });

    it("replaying from any intermediate state reproduces the rest of the run (what reconciliation relies on)", () => {
        const log = randomInputLog(7, 3000);
        const full = run(createInitialState(9), log);
        for (const from of [1, 500, 1234, 2999]) {
            const replay = run(structuredClone(full[from]), log.slice(from));
            expect(JSON.stringify(replay.at(-1))).toBe(JSON.stringify(full.at(-1)));
        }
    });

    it("never mutates the state it is given", () => {
        let s = deepFreeze(createInitialState(1));
        for (const inputs of randomInputLog(3, 2000)) s = deepFreeze(step(s, inputs));
        expect(s.tick).toBe(2000);
    });

    it("different seeds give different serves", () => {
        const serveOf = (seed: number) => {
            let s = createInitialState(seed);
            while (s.phase !== "playing") s = step(s, [0, 0]);
            return s.ball;
        };
        expect(serveOf(1)).not.toEqual(serveOf(2));
        expect(serveOf(5)).toEqual(serveOf(5));
    });

    it("matches the golden run (if this fails, the simulation changed: server and clients must be updated together)", () => {
        // FNV-1a over the JSON of every state in the run: any change in any bit of any tick shows up.
        let hash = 0x811c9dc5;
        const states = run(createInitialState(2024), randomInputLog(99, 3000));
        for (const s of states) {
            const json = JSON.stringify(s);
            for (let i = 0; i < json.length; i++) hash = Math.imul(hash ^ json.charCodeAt(i), 0x01000193) >>> 0;
        }
        const final = states.at(-1)!;
        expect({ hash: hash.toString(16), tick: final.tick, score: final.score, ball: final.ball }).toMatchInlineSnapshot(`
          {
            "ball": {
              "vx": 0,
              "vy": 0,
              "x": 400,
              "y": 250,
            },
            "hash": "593117df",
            "score": [
              4,
              7,
            ],
            "tick": 3000,
          }
        `);
    });
});

describe("collision", () => {
    const speeds = Array.from({ length: Math.ceil((BALL_MAX_SPEED - BALL_SERVE_SPEED) / BALL_SPEED_INCREMENT) + 1 }, (_, i) =>
        Math.min(BALL_SERVE_SPEED + i * BALL_SPEED_INCREMENT, BALL_MAX_SPEED)
    );
    const slopes = Array.from({ length: 33 }, (_, i) => -MAX_BOUNCE_SLOPE + (i * 2 * MAX_BOUNCE_SLOPE) / 32);
    // Different starting distances so the face is met at every point within a tick.
    const phases = [0, 0.13, 0.37, 0.5, 0.71, 0.99];

    it("includes the maximum speed, which moves the ball further per tick than a paddle is thick", () => {
        expect(speeds.at(-1)).toBe(BALL_MAX_SPEED);
        expect(BALL_MAX_SPEED * TICK_DT).toBeGreaterThan(PADDLE_WIDTH);
    });

    /**
     * Flies a ball at `seat`'s paddle, which is placed exactly where the ball
     * will arrive, and returns what happened.
     */
    function fly(seat: Seat, speed: number, slope: number, phase: number, paddleOffset: number) {
        const v = velocityFromSlope(seat === 0 ? -1 : 1, slope, speed);
        const perTick = Math.abs(v.vx) * TICK_DT;
        const faceDistance = perTick * (3 + phase);
        const x = seat === 0 ? PADDLE_FACE_X[0] + BALL_RADIUS + faceDistance : PADDLE_FACE_X[1] - BALL_RADIUS - faceDistance;
        // Start so that (ignoring walls) the ball reaches the face at mid-height.
        const ticksToFace = faceDistance / perTick;
        const y = FIELD_HEIGHT / 2 - v.vy * TICK_DT * ticksToFace;
        let ball = { x, y, vx: v.vx, vy: v.vy };
        const paddleY = FIELD_HEIGHT / 2 + paddleOffset;
        const paddles: [number, number] = seat === 0 ? [paddleY, FIELD_HEIGHT / 2] : [FIELD_HEIGHT / 2, paddleY];
        const events = [];
        let behind = false;
        for (let t = 0; t < 12; t++) {
            const r = sweepBall(ball, TICK_DT, paddles, 0);
            ball = r.ball;
            events.push(...r.events);
            if (seat === 0 ? ball.x - BALL_RADIUS < PADDLE_FACE_X[0] - 1e-6 : ball.x + BALL_RADIUS > PADDLE_FACE_X[1] + 1e-6) behind = true;
            if (ball.y < BALL_RADIUS || ball.y > FIELD_HEIGHT - BALL_RADIUS) throw new Error(`ball left the field: ${ball.y}`);
        }
        return { ball, events, behind };
    }

    it("never lets a ball through a paddle that covers it, at every speed, angle and sub-tick phase", () => {
        let cases = 0;
        const failures: string[] = [];
        for (const seat of [0, 1] as const) {
            for (const speed of speeds) {
                for (const slope of slopes) {
                    for (const phase of phases) {
                        for (const offset of [0, PADDLE_HALF_HEIGHT * 0.5, -PADDLE_HALF_HEIGHT, PADDLE_HALF_HEIGHT + BALL_RADIUS - 0.5]) {
                            const { ball, events, behind } = fly(seat, speed, slope, phase, offset);
                            const hits = events.filter((e) => e.type === "hit").length;
                            const misses = events.filter((e) => e.type === "miss").length;
                            // It hit exactly once, never got behind the face, and now travels away from the paddle.
                            const ok = hits === 1 && misses === 0 && !behind && Math.sign(ball.vx) === (seat === 0 ? 1 : -1);
                            if (!ok) failures.push(`seat ${seat} speed ${speed} slope ${slope} phase ${phase} offset ${offset}`);
                            cases++;
                        }
                    }
                }
            }
        }
        expect(failures).toEqual([]);
        expect(cases).toBeGreaterThan(10_000);
    });

    it("lets a ball pass a paddle that is out of the way, and reports exactly one miss", () => {
        for (const seat of [0, 1] as const) {
            for (const speed of [BALL_SERVE_SPEED, BALL_MAX_SPEED]) {
                for (const slope of [-1, 0, 0.4]) {
                    const { events, behind } = fly(seat, speed, slope, 0.5, PADDLE_HALF_HEIGHT + BALL_RADIUS + 1);
                    expect(events.filter((e) => e.type === "hit")).toHaveLength(0);
                    expect(events.filter((e) => e.type === "miss")).toHaveLength(1);
                    expect(behind).toBe(true);
                }
            }
        }
    });

    it("bounces flat off the centre of the paddle and at the maximum angle off the edges", () => {
        const at = (offset: number) => {
            const ball = { x: PADDLE_FACE_X[0] + BALL_RADIUS + 3, y: FIELD_HEIGHT / 2 + offset, vx: -600, vy: 0 };
            return sweepBall(ball, TICK_DT, [FIELD_HEIGHT / 2, FIELD_HEIGHT / 2], 0).ball;
        };
        expect(at(0).vy).toBe(0);
        expect(at(0).vx).toBeGreaterThan(0);
        const edge = at(PADDLE_HALF_HEIGHT + BALL_RADIUS);
        expect(edge.vy / edge.vx).toBeCloseTo(MAX_BOUNCE_SLOPE, 2);
        const top = at(-(PADDLE_HALF_HEIGHT + BALL_RADIUS));
        expect(top.vy / top.vx).toBeCloseTo(-MAX_BOUNCE_SLOPE, 2);
        // Steeper the further from the centre.
        expect(Math.abs(at(20).vy)).toBeLessThan(Math.abs(at(40).vy));
    });

    it("keeps the ball inside the walls, including at maximum speed and the steepest angle", () => {
        const v = velocityFromSlope(1, MAX_BOUNCE_SLOPE * 3, BALL_MAX_SPEED);
        let ball = { x: FIELD_WIDTH / 2, y: FIELD_HEIGHT / 2, vx: v.vx, vy: v.vy };
        let walls = 0;
        for (let t = 0; t < 600; t++) {
            const r = sweepBall(ball, TICK_DT, null, 0);
            ball = r.ball;
            walls += r.events.filter((e) => e.type === "wall").length;
            expect(ball.y).toBeGreaterThanOrEqual(BALL_RADIUS);
            expect(ball.y).toBeLessThanOrEqual(FIELD_HEIGHT - BALL_RADIUS);
            if (ball.x > FIELD_WIDTH * 3) break;
        }
        expect(walls).toBeGreaterThan(2);
    });

    it("handles several contacts in one step (wall then paddle, near a corner)", () => {
        // Ball heading up-left, about to hit the top wall and then the left paddle in the same long step.
        const ball = { x: PADDLE_FACE_X[0] + BALL_RADIUS + 10, y: BALL_RADIUS + 5, vx: -600, vy: -600 };
        const r = sweepBall(ball, 0.05, [PADDLE_HALF_HEIGHT, FIELD_HEIGHT / 2], 0);
        // It hits high on the paddle, so it goes back up and may meet the wall again.
        expect(r.events.map((e) => e.type).slice(0, 2)).toEqual(["wall", "hit"]);
        expect(r.ball.vx).toBeGreaterThan(0);
    });
});

describe("paddles", () => {
    it("move at a speed proportional to the input level and stop at the walls", () => {
        const p = { y: FIELD_HEIGHT / 2, dir: 0 };
        expect(stepPaddle(p, INPUT_LEVELS, TICK_DT).y).toBeCloseTo(FIELD_HEIGHT / 2 + PADDLE_SPEED * TICK_DT, 2);
        expect(stepPaddle(p, INPUT_LEVELS / 2, TICK_DT).y).toBeCloseTo(FIELD_HEIGHT / 2 + (PADDLE_SPEED * TICK_DT) / 2, 2);
        let q = p;
        for (let i = 0; i < 200; i++) q = stepPaddle(q, -INPUT_LEVELS, TICK_DT);
        expect(q.y).toBe(PADDLE_HALF_HEIGHT);
        for (let i = 0; i < 200; i++) q = stepPaddle(q, INPUT_LEVELS, TICK_DT);
        expect(q.y).toBe(FIELD_HEIGHT - PADDLE_HALF_HEIGHT);
    });

    it("clamp impossible inputs to the legal range", () => {
        expect(clampDir(1e9)).toBe(INPUT_LEVELS);
        expect(clampDir(-1e9)).toBe(-INPUT_LEVELS);
        expect(clampDir(Number.NaN)).toBe(0);
        expect(clampDir(2.6)).toBe(3);
    });
});

describe("match flow", () => {
    function untilPhase(s: GameState, phase: GameState["phase"], inputs: TickInputs = [0, 0], max = 10_000): GameState {
        for (let i = 0; i < max && s.phase !== phase; i++) s = step(s, inputs);
        expect(s.phase).toBe(phase);
        return s;
    }

    it("serves after the countdown, towards the receiver", () => {
        let s = createInitialState(3);
        expect(s.phase).toBe("countdown");
        for (let i = 0; i < COUNTDOWN_TICKS - 1; i++) s = step(s, [0, 0]);
        expect(s.phase).toBe("countdown");
        s = step(s, [0, 0]);
        expect(s.phase).toBe("playing");
        expect(s.events).toContainEqual({ type: "serve", seat: s.server });
        expect(Math.sign(s.ball.vx)).toBe(s.server === 0 ? 1 : -1);
        expect(Math.hypot(s.ball.vx, s.ball.vy)).toBeCloseTo(BALL_SERVE_SPEED, 0);
    });

    it("awards the point to the other player when the ball leaves the field, then pauses and counts down", () => {
        let s = untilPhase(createInitialState(4), "playing");
        const scorer = s.server;
        const receiver: Seat = scorer === 0 ? 1 : 0;
        // A flat shot along the top while the receiver runs to the bottom.
        s = { ...s, ball: { x: FIELD_WIDTH / 2, y: 60, vx: receiver === 0 ? -500 : 500, vy: 0 } };
        const away: TickInputs = receiver === 0 ? [INPUT_LEVELS, 0] : [0, INPUT_LEVELS];
        const rally = s.rally;
        s = untilPhase(s, "point", away);
        expect(s.score[scorer]).toBe(1);
        expect(s.score[receiver]).toBe(0);
        expect(s.events).toContainEqual({ type: "point", seat: scorer });
        expect(s.server).toBe(receiver);
        expect(s.rally).toBe(rally + 1);
        expect(s.ball).toEqual({ x: FIELD_WIDTH / 2, y: FIELD_HEIGHT / 2, vx: 0, vy: 0 });
        for (let i = 0; i < POINT_PAUSE_TICKS; i++) s = step(s, [0, 0]);
        expect(s.phase).toBe("countdown");
        for (let i = 0; i < COUNTDOWN_TICKS; i++) s = step(s, [0, 0]);
        expect(s.phase).toBe("playing");
        expect(Math.sign(s.ball.vx)).toBe(receiver === 0 ? 1 : -1);
    });

    it("alternates serves and ends at the winning score", () => {
        let s = createInitialState(11);
        const serves: Seat[] = [];
        const log = randomInputLog(5, 1_000_000);
        for (let i = 0; i < log.length && s.phase !== "over"; i++) {
            s = step(s, log[i]);
            for (const e of s.events) if (e.type === "serve") serves.push(e.seat);
        }
        expect(s.phase).toBe("over");
        expect(Math.max(...s.score)).toBe(POINTS_TO_WIN);
        expect(s.winner).toBe(s.score[0] === POINTS_TO_WIN ? 0 : 1);
        expect(serves.length).toBe(s.score[0] + s.score[1]);
        for (let i = 1; i < serves.length; i++) expect(serves[i]).not.toBe(serves[i - 1]);

        // Nothing changes after the match is over, except paddles and the tick.
        const after = step(s, [INPUT_LEVELS, INPUT_LEVELS]);
        expect(after.score).toEqual(s.score);
        expect(after.ball).toEqual(s.ball);
        expect(after.phase).toBe("over");
    });

    it("speeds the ball up with every hit, up to the cap", () => {
        expect(ballSpeedAfterHits(0)).toBe(BALL_SERVE_SPEED);
        expect(ballSpeedAfterHits(1)).toBe(BALL_SERVE_SPEED + BALL_SPEED_INCREMENT);
        expect(ballSpeedAfterHits(1000)).toBe(BALL_MAX_SPEED);

        // A real rally between two players who track the ball perfectly.
        let s = untilPhase(createInitialState(8), "playing");
        let maxSpeed = 0;
        let hits = 0;
        for (let i = 0; i < 20_000 && s.phase === "playing"; i++) {
            s = step(s, [chase(s, 0), chase(s, 1)]);
            const speed = Math.hypot(s.ball.vx, s.ball.vy);
            for (const e of s.events) {
                if (e.type !== "hit") continue;
                hits++;
                expect(speed).toBeCloseTo(ballSpeedAfterHits(hits), 0);
            }
            maxSpeed = Math.max(maxSpeed, speed);
        }
        expect(hits).toBeGreaterThan((BALL_MAX_SPEED - BALL_SERVE_SPEED) / BALL_SPEED_INCREMENT);
        expect(maxSpeed).toBeLessThanOrEqual(BALL_MAX_SPEED + 0.01);
        expect(maxSpeed).toBeGreaterThan(BALL_MAX_SPEED - 0.01);
    });

    it("freezes everything but the tick while paused", () => {
        let s = untilPhase(createInitialState(2), "playing");
        s = { ...s, paused: true };
        const next = step(s, [INPUT_LEVELS, -INPUT_LEVELS]);
        expect(next.tick).toBe(s.tick + 1);
        expect({ ...next, tick: s.tick, events: s.events }).toEqual(s);
    });
});
