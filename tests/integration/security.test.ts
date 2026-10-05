import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { io as ioClient } from "socket.io-client";
import { FIELD_HEIGHT, INPUT_LEVELS } from "../../shared/constants.ts";
import { ORIGIN, privateMatch, sleep, startServer, waitFor, type TestClient, type TestEnv } from "../helpers.ts";

let env: TestEnv;
afterEach(async () => {
    await env?.close();
});

/** Sends one input change, stamped a few ticks ahead of the latest snapshot. */
function sendInput(client: TestClient, seq: number, dir: number) {
    const tick = (client.snapshot?.tick ?? 0) + 3;
    client.socket.emit("input", { c: [[seq, tick, dir]], l: 0 });
}

describe("authority", () => {
    beforeEach(async () => {
        env = await startServer();
    });

    it("a player's inputs only ever move their own paddle", async () => {
        const { a, b } = await privateMatch(env);
        const seatA = a.room!.you as 0 | 1;
        const seatB = b.room!.you as 0 | 1;
        expect(seatA).not.toBe(seatB);
        await a.waitForSnapshot(() => true);
        sendInput(a, 0, INPUT_LEVELS);
        const moved = await a.waitForSnapshot((s) => s.paddles[seatA].y > FIELD_HEIGHT / 2 + 50);
        expect(moved.paddles[seatB].y).toBe(FIELD_HEIGHT / 2);
        expect(moved.acks[seatA]).toBe(0);
        expect(moved.acks[seatB]).toBe(-1);
    });

    it("positions and ball data are rejected and never relayed", async () => {
        const { a, b } = await privateMatch(env);
        await a.waitForSnapshot(() => true);
        const before = b.raw.length;
        a.socket.emit("ballMove", { ballX: 0, ballY: 0, score: [7, 0] });
        a.socket.emit("paddleMove", { xPosition: 0 });
        a.socket.emit("input", { c: [[0, 10, 1]], l: 0, y: 0 }); // extra field: a position
        a.socket.emit("input", { c: [[0, 10, 1]], l: 0, seat: 1 }); // can't choose a seat
        await waitFor(() => a.errors.length >= 4, 2000, "errors");
        await sleep(100);
        const relayed = b.raw.slice(before).filter((m) => !["snapshot", "room"].includes(m.event));
        expect(relayed).toEqual([]);
        const s = b.snapshot!;
        expect(s.score).toEqual([0, 0]);
        expect(s.paddles.map((p) => p.y)).toEqual([FIELD_HEIGHT / 2, FIELD_HEIGHT / 2]);
        expect(s.acks).toEqual([-1, -1]);
    });

    it("ignores impossible inputs: far-future ticks, going back in time, duplicates", async () => {
        const { a } = await privateMatch(env);
        const seat = a.room!.you as 0 | 1;
        const snap = await a.waitForSnapshot(() => true);
        a.socket.emit("input", { c: [[0, snap.tick + 10_000, INPUT_LEVELS]], l: 0 }); // too far ahead
        a.socket.emit("input", { c: [[1, snap.tick + 5, -INPUT_LEVELS]], l: 0 });
        a.socket.emit("input", { c: [[2, snap.tick + 1, INPUT_LEVELS]], l: 0 }); // earlier tick than seq 1
        a.socket.emit("input", { c: [[1, snap.tick + 5, -INPUT_LEVELS]], l: 0 }); // duplicate
        const s = await a.waitForSnapshot((x) => x.acks[seat] === 1 && x.tick > snap.tick + 20);
        expect(s.paddles[seat].dir).toBe(-INPUT_LEVELS);
    });

    it("spectators can't send inputs", async () => {
        const { a, code } = await privateMatch(env);
        const spectator = env.connect();
        await spectator.connected;
        expect((await spectator.request("watchRoom", { code })).seat).toBe(-1);
        const snap = await spectator.waitForSnapshot(() => true);
        spectator.socket.emit("input", { c: [[0, snap.tick + 3, INPUT_LEVELS]], l: 0 });
        await waitFor(() => spectator.errors.length > 0, 2000, "error");
        await sleep(150);
        expect(a.snapshot!.paddles.map((p) => p.dir)).toEqual([0, 0]);
    });
});

describe("message validation", () => {
    beforeEach(async () => {
        env = await startServer();
    });

    it.each([
        ["unknown event", "hack", {}],
        ["wrong type", "joinRoom", { code: 123 }],
        ["extra field", "createRoom", { admin: true }],
        ["not an object", "playBot", "hard"],
        ["bad enum", "playBot", { difficulty: "impossible" }],
    ])("rejects %s with a generic error", async (_label, event, payload) => {
        const c = env.connect();
        await c.connected;
        if (event === "hack") {
            c.socket.emit(event, payload);
            await waitFor(() => c.errors.length > 0, 2000, "error");
            expect(c.errors[0]).toBe("Invalid request.");
        } else {
            const res = await c.request(event, payload);
            expect(res).toEqual({ ok: false, error: "Invalid request." });
        }
    });

    it("disconnects a client that sends an oversized message", async () => {
        const c = env.connect();
        await c.connected;
        c.socket.emit("joinRoom", { code: "x".repeat(10_000) });
        await waitFor(() => c.disconnected, 2000, "disconnect");
    });

    it("disconnects persistent offenders", async () => {
        const c = env.connect();
        await c.connected;
        for (let i = 0; i < 30; i++) c.socket.emit("nonsense", i);
        await waitFor(() => c.disconnected, 2000, "disconnect");
    });
});

describe("rate limits", () => {
    it("throttles event floods and disconnects the flooder", async () => {
        env = await startServer({ config: { limits: { socketEvents: { capacity: 20, windowMs: 1000 } } } });
        const { a } = await privateMatch(env);
        const snap = await a.waitForSnapshot(() => true);
        for (let i = 0; i < 100; i++) a.socket.emit("input", { c: [[i, snap.tick + 2, 0]], l: 0 });
        await waitFor(() => a.disconnected, 3000, "disconnect");
    });

    it("limits room creation per IP", async () => {
        env = await startServer({ config: { limits: { createPerIp: { capacity: 3, windowMs: 60_000 } } } });
        const c = env.connect();
        await c.connected;
        const results = [];
        for (let i = 0; i < 5; i++) results.push((await c.request("createRoom")).ok);
        expect(results).toEqual([true, true, true, false, false]);
    });

    it("limits concurrent connections per IP", async () => {
        env = await startServer({ config: { limits: { maxConcurrentPerIp: 3 } } });
        const ok = [env.connect(), env.connect(), env.connect()];
        await Promise.all(ok.map((c) => c.connected));
        await expect(env.connect().connected).rejects.toThrow();
    });

    it("caps the number of rooms", async () => {
        env = await startServer({ config: { maxRooms: 2 } });
        const c = env.connect();
        await c.connected;
        expect((await c.request("playBot", { difficulty: "easy" })).ok).toBe(true);
        const d = env.connect();
        await d.connected;
        expect((await d.request("createRoom")).ok).toBe(true);
        const e = env.connect();
        await e.connected;
        expect(await e.request("createRoom")).toEqual({ ok: false, error: "The server is full right now. Try again later." });
    });
});

describe("origins", () => {
    beforeEach(async () => {
        env = await startServer();
    });

    it.each([["https://evil.example"], ["null"], [null]])("refuses origin %s", async (origin) => {
        await expect(env.connect({ origin }).connected).rejects.toThrow();
    });

    it("accepts an allow-listed origin", async () => {
        await expect(env.connect({ origin: ORIGIN }).connected).resolves.toBeUndefined();
    });

    it("refuses long-polling (WebSocket only, so every connection carries an Origin to check)", async () => {
        const socket = ioClient(env.url, { transports: ["polling"], forceNew: true, reconnection: false, extraHeaders: { origin: ORIGIN } });
        const result = await new Promise((resolve) => {
            socket.once("connect", () => resolve("connected"));
            socket.once("connect_error", () => resolve("refused"));
        });
        socket.disconnect();
        expect(result).toBe("refused");
    });
});

describe("session tokens", () => {
    beforeEach(async () => {
        env = await startServer();
    });

    it("a forged token can't take a seat", async () => {
        const { a, code } = await privateMatch(env);
        const thief = env.connect();
        await thief.connected;
        const forged = "A".repeat(43);
        expect(await thief.request("resume", { code, token: forged })).toEqual({ ok: false, error: "That session has expired." });
        // A real token from a different room doesn't work here either.
        const other = env.connect();
        await other.connected;
        const otherRoom = await other.request("createRoom");
        expect((await thief.request("resume", { code, token: otherRoom.token })).ok).toBe(false);
        expect((await thief.request("resume", { code: otherRoom.code, token: a.token })).ok).toBe(false);
        // And the seat is untouched.
        expect(a.room!.seats[a.room!.you as 0 | 1].connected).toBe(true);
        expect(thief.rooms).toEqual([]);
    });

    it("tokens are never sent to anyone but their owner", async () => {
        const { a, b, code } = await privateMatch(env);
        const spectator = env.connect();
        await spectator.connected;
        await spectator.request("watchRoom", { code });
        await sleep(200);
        for (const [client, foreign] of [
            [a, b.token],
            [b, a.token],
            [spectator, a.token],
            [spectator, b.token],
        ] as const) {
            expect(JSON.stringify(client.raw)).not.toContain(foreign);
        }
    });

    it("room codes are 6 characters from the unambiguous alphabet", async () => {
        const c = env.connect();
        await c.connected;
        const codes = new Set<string>();
        for (let i = 0; i < 20; i++) codes.add((await c.request("createRoom")).code!);
        expect(codes.size).toBe(20);
        for (const code of codes) expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    });
});
