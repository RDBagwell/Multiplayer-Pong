import { describe, expect, it } from "vitest";
import { BALL_RADIUS, FIELD_HEIGHT, INPUT_LEVELS, PADDLE_FACE_X, PADDLE_HALF_HEIGHT, TICK_MS } from "../../shared/constants.ts";
import { nextRandom } from "../../shared/rng.ts";
import { createInitialState, type GameState, type TickInputs } from "../../shared/state.ts";
import { step } from "../../shared/step.ts";
import { LagCompensator } from "../../server/rooms/LagCompensator.ts";
import { Room, type Member } from "../../server/rooms/Room.ts";
import { testConfig } from "../helpers.ts";

function seededRandom(seed: number): () => number {
    let s = seed;
    return () => {
        const r = nextRandom(s);
        s = r.state;
        return r.value;
    };
}

function fakeMember(id: string): Member & { received: { event: string; payload: unknown }[] } {
    const received: { event: string; payload: unknown }[] = [];
    return { id, received, send: (event, payload) => received.push({ event, payload }), join() {}, leave() {} };
}

function makeRoom(overrides: Parameters<typeof testConfig>[0] = {}, seed = 1) {
    const broadcasts: { event: string; payload: unknown }[] = [];
    const room = new Room("ABCDEF", "private", 0, {
        config: testConfig(overrides),
        broadcast: (_channel, event, payload) => broadcasts.push({ event, payload }),
        seed: () => seed,
        botRandom: seededRandom(seed),
    });
    return { room, broadcasts };
}

describe("room loop", () => {
    it("turns irregular wall-clock time into exactly one tick per 1/60 s, without drift", () => {
        const { room } = makeRoom();
        room.seatHuman(0, fakeMember("a"), 0);
        room.seatHuman(1, fakeMember("b"), 0);
        let now = 0;
        room.advance(now);
        const jitter = seededRandom(3);
        while (now < 60_000) {
            now += 1 + jitter() * 30; // between 1 and 31 ms, like a busy event loop
            room.advance(now);
        }
        expect(Math.abs(room.game!.tick - Math.floor(now / TICK_MS))).toBeLessThanOrEqual(1);
        expect(room.skippedTicks).toBe(0);
    });

    it("skips time after a long stall instead of fast-forwarding a burst", () => {
        const { room } = makeRoom();
        room.seatHuman(0, fakeMember("a"), 0);
        room.seatHuman(1, fakeMember("b"), 0);
        room.advance(0);
        room.advance(5_000);
        expect(room.game!.tick).toBeLessThanOrEqual(1);
        expect(room.skippedTicks).toBeGreaterThan(290);
    });

    it("broadcasts snapshots at the configured rate", () => {
        for (const rate of [10, 20, 30, 60]) {
            const { room, broadcasts } = makeRoom({ snapshotRate: rate });
            room.seatHuman(0, fakeMember("a"), 0);
            room.seatHuman(1, fakeMember("b"), 0);
            broadcasts.length = 0;
            for (let t = 0; t <= 6000; t += 4) room.advance(t + 0.5);
            const snapshots = broadcasts.filter((b) => b.event === "snapshot").length;
            expect(snapshots).toBeGreaterThanOrEqual(rate * 6 - 1);
            expect(snapshots).toBeLessThanOrEqual(rate * 6 + 1);
        }
    });

    it("applies each input at the tick it was stamped for, and late inputs at the next tick", () => {
        const { room } = makeRoom();
        room.seatHuman(0, fakeMember("a"), 0);
        room.seatHuman(1, fakeMember("b"), 0);
        room.advance(0);
        room.advance(TICK_MS * 10 + 0.5);
        const t = room.game!.tick;
        room.receiveInput(0, [{ seq: 0, tick: t + 5, dir: INPUT_LEVELS }], 0);
        room.advance(TICK_MS * 14 + 0.5); // ticks t+1 .. t+4
        expect(room.game!.tick).toBe(t + 4);
        expect(room.game!.paddles[0].dir).toBe(0);
        room.advance(TICK_MS * 15 + 0.5);
        expect(room.game!.paddles[0].dir).toBe(INPUT_LEVELS);
        expect(room.snapshot().a[0]).toBe(0);

        // Stamped for a tick the server has already simulated: applied at the next one.
        expect(room.receiveInput(0, [{ seq: 1, tick: t + 5, dir: -INPUT_LEVELS }], 0).accepted).toBe(1);
        // An input for an earlier tick than the previous one is impossible.
        expect(room.receiveInput(0, [{ seq: 2, tick: t + 3, dir: 0 }], 0).rejected).toBe(1);
        room.advance(TICK_MS * 16 + 0.5);
        expect(room.game!.paddles[0].dir).toBe(-INPUT_LEVELS);
        expect(room.snapshot().a[0]).toBe(1);
    });
});

describe("bot", () => {
    function botMatch(a: "easy" | "medium" | "hard", b: "easy" | "medium" | "hard", seed: number) {
        const { room } = makeRoom({}, seed);
        room.seatBot(0, a);
        room.seatBot(1, b);
        let now = 0;
        let hits = 0;
        while (room.status === "playing" && now < 30 * 60_000) {
            now += 50;
            room.advance(now);
            hits += room.game!.events.filter((e) => e.type === "hit").length;
        }
        return { game: room.game!, hits };
    }

    it("plays complete matches with real rallies", () => {
        const { game, hits } = botMatch("medium", "medium", 5);
        expect(game.phase).toBe("over");
        expect(Math.max(...game.score)).toBe(7);
        expect(hits).toBeGreaterThan(5);
    });

    it("is beatable: even the hard bot misses, and harder bots win more often", () => {
        let hardWins = 0;
        let hardConceded = 0;
        for (let seed = 1; seed <= 6; seed++) {
            const { game } = botMatch("hard", "easy", seed);
            if (game.winner === 0) hardWins++;
            hardConceded += game.score[1];
        }
        expect(hardWins).toBeGreaterThanOrEqual(5);
        expect(hardConceded).toBeGreaterThan(0);
    });
});

describe("lag compensation", () => {
    /**
     * A ball about to cross the left paddle face, with the paddle 20 units
     * out of reach but racing towards it at full speed.
     */
    function scenario(): GameState {
        const s = createInitialState(1);
        return {
            ...s,
            phase: "playing",
            phaseTicks: 0,
            ball: { x: PADDLE_FACE_X[0] + BALL_RADIUS + 15, y: 200, vx: -600, vy: 0 },
            paddles: [
                { y: 200 + PADDLE_HALF_HEIGHT + BALL_RADIUS + 20, dir: 0 },
                { y: FIELD_HEIGHT / 2, dir: 0 },
            ],
        };
    }

    function play(lagComp: LagCompensator, viewLag: number, ticks = 30) {
        let s = scenario();
        const inputs: TickInputs = [-INPUT_LEVELS, 0];
        for (let i = 0; i < ticks; i++) {
            const before = s;
            s = lagComp.afterStep(before, inputs, step(before, inputs), [viewLag, 0]);
        }
        return s;
    }

    it("without it, the server scores the miss the player didn't see", () => {
        const s = play(new LagCompensator(0), 6);
        expect(s.score).toEqual([0, 1]);
    });

    it("with it, a paddle that reached the ball within the player's view lag gets the hit", () => {
        const lc = new LagCompensator(9);
        const s = play(lc, 6);
        expect(lc.rewinds).toBe(1);
        expect(s.score).toEqual([0, 0]);
        expect(s.ball.vx).toBeGreaterThan(0);
        expect(s.hits).toBe(1);
    });

    it("is bounded: claiming a huge lag gives no more than the cap", () => {
        // Paddle 60 units out of reach: it needs about 7 ticks to cover the ball.
        const far = (lc: LagCompensator, lag: number) => {
            let s = scenario();
            s = { ...s, paddles: [{ y: 200 + PADDLE_HALF_HEIGHT + BALL_RADIUS + 60, dir: 0 }, s.paddles[1]] };
            for (let i = 0; i < 30; i++) {
                const before = s;
                s = lc.afterStep(before, [-INPUT_LEVELS, 0], step(before, [-INPUT_LEVELS, 0]), [lag, 0]);
            }
            return s;
        };
        expect(far(new LagCompensator(3), 60).score).toEqual([0, 1]);
        expect(far(new LagCompensator(9), 60).score).toEqual([0, 0]);
    });
});
