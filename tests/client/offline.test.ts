import { describe, expect, it } from "vitest";
import { POINTS_TO_WIN, TICK_MS } from "../../shared/constants.ts";
import { OfflineMatch } from "../../client/src/offline/OfflineMatch.ts";
import { ServerStatus } from "../../client/src/net/ServerStatus.ts";
import { Effects } from "../../client/src/render/Effects.ts";
import type { ClientView } from "../../client/src/netcode/GameClient.ts";
import { seededRandom } from "../harness/harness.ts";

describe("offline mode", () => {
    it("plays a whole match against the bot with no server and no network", () => {
        // Any attempt to open a connection would throw.
        const realWebSocket = globalThis.WebSocket;
        const realFetch = globalThis.fetch;
        globalThis.WebSocket = class {
            constructor() {
                throw new Error("offline mode tried to open a WebSocket");
            }
        } as unknown as typeof WebSocket;
        globalThis.fetch = () => {
            throw new Error("offline mode tried to fetch");
        };
        try {
            const match = new OfflineMatch("hard", { random: seededRandom(3), seed: () => 42 });
            // A player who chases the ball but is slow to react: points go both ways.
            match.input = (paddleY) => {
                const target = match.state.ball.y + 30;
                return Math.max(-6, Math.min(6, Math.round((target - paddleY) / 9)));
            };
            let now = 0;
            let frames = 0;
            while (!match.over && now < 30 * 60_000) {
                now += 16.7; // a 60 Hz display
                match.update(now);
                const view = match.view();
                expect(view.mode).toBe("local");
                frames++;
            }
            expect(match.over).toBe(true);
            expect(Math.max(...match.state.score)).toBe(POINTS_TO_WIN);
            expect(match.info().status).toBe("over");
            // It really ran at 60 Hz of simulated time, not as fast as possible.
            expect(match.state.tick).toBeGreaterThan(frames * 0.9);
            expect(match.state.tick).toBeLessThan(frames * 1.1);

            match.rematch();
            expect(match.over).toBe(false);
            expect(match.state.score).toEqual([0, 0]);
        } finally {
            globalThis.WebSocket = realWebSocket;
            globalThis.fetch = realFetch;
        }
    });

    it("uses fixed steps whatever the frame rate, and skips time after a long pause", () => {
        const a = new OfflineMatch("medium", { random: seededRandom(1), seed: () => 7 });
        const b = new OfflineMatch("medium", { random: seededRandom(1), seed: () => 7 });
        for (let t = 0; t <= 6000; t += 1000 / 144) a.update(t); // 144 Hz screen
        for (let t = 0; t <= 6000; t += 1000 / 30) b.update(t); // 30 Hz screen
        expect(Math.abs(a.state.tick - b.state.tick)).toBeLessThanOrEqual(1);
        expect(a.state.tick).toBeCloseTo(6000 / TICK_MS, -1);

        const c = new OfflineMatch("easy");
        c.update(0);
        c.update(60_000); // a background tab coming back after a minute
        expect(c.state.tick).toBeLessThanOrEqual(Math.ceil(250 / TICK_MS));
    });
});

describe("server status and the offline offer", () => {
    it("waits a moment, then offers offline play while the server is unreachable", () => {
        const s = new ServerStatus(0, { graceMs: 1500 });
        expect(s.state(100)).toBe("connecting");
        expect(s.offerOffline(100)).toBe(false);
        expect(s.state(1600)).toBe("waking");
        expect(s.offerOffline(1600)).toBe(true);
        expect(s.isOnline(1600)).toBe(false);
    });

    it("offers it immediately when the connection is refused", () => {
        const s = new ServerStatus(0);
        s.onError();
        expect(s.state(10)).toBe("waking");
        expect(s.offerOffline(10)).toBe(true);
    });

    it("withdraws the offer once the server answers, and brings it back if the connection drops", () => {
        const s = new ServerStatus(0);
        s.onError();
        s.onConnect();
        expect(s.state(5000)).toBe("online");
        expect(s.offerOffline(5000)).toBe(false);
        s.onDisconnect();
        expect(s.state(6000)).toBe("reconnecting");
        expect(s.offerOffline(6000)).toBe(true);
    });
});

describe("effects", () => {
    const view = (x: number, y: number, extra: Partial<ClientView> = {}): ClientView =>
        ({ ball: { x, y }, paddleY: [250, 250], score: [0, 0], phase: "playing", phaseTicks: 0, paused: false, winner: -1, server: 0, you: 0, renderTick: 0, mode: "local", ...extra }) as ClientView;

    it("detects paddle hits and wall bounces where the drawn ball turns", () => {
        const fx = new Effects();
        const events = [
            ...fx.update(view(60, 250), 0),
            ...fx.update(view(45, 250), 16), // moving left, near the left paddle face (x = 39)
            ...fx.update(view(55, 252), 32), // now moving right: a hit
            ...fx.update(view(70, 495), 48),
            ...fx.update(view(85, 490), 64), // moving up again near the bottom wall
        ];
        expect(events).toContainEqual({ type: "hit", seat: 0 });
        expect(events).toContainEqual({ type: "wall" });
        expect(fx.frame(70).flash[0]).toBeGreaterThan(0);
    });

    it("ignores direction changes away from paddles and walls (e.g. a network correction mid-field)", () => {
        const fx = new Effects();
        const events = [...fx.update(view(400, 250), 0), ...fx.update(view(390, 250), 16), ...fx.update(view(395, 250), 32)];
        expect(events).toEqual([]);
    });

    it("reports points, and shakes only without reduced motion", () => {
        const calm = new Effects(true);
        const lively = new Effects(false);
        for (const fx of [calm, lively]) {
            fx.update(view(400, 250), 0);
            expect(fx.update(view(400, 250, { score: [1, 0], phase: "point" }), 16)).toContainEqual({ type: "point", seat: 0 });
        }
        expect(calm.frame(20).shake).toEqual({ x: 0, y: 0 });
        const s = lively.frame(20).shake;
        expect(Math.hypot(s.x, s.y)).toBeGreaterThan(0);
    });
});
