import { afterEach, describe, expect, it } from "vitest";
import { INPUT_LEVELS } from "../../shared/constants.ts";
import { MatchQueue } from "../../server/rooms/MatchQueue.ts";
import { privateMatch, sleep, startServer, waitFor, type TestClient, type TestEnv } from "../helpers.ts";

let env: TestEnv;
afterEach(async () => {
    await env?.close();
});

async function connected(n: number): Promise<TestClient[]> {
    const clients = Array.from({ length: n }, () => env.connect());
    await Promise.all(clients.map((c) => c.connected));
    return clients;
}

describe("quick match queue", () => {
    it("pairs two waiting players into a fresh room on opposite sides", async () => {
        env = await startServer();
        const [a, b] = await connected(2);
        expect(await a.request("quickMatch")).toEqual({ ok: true, queued: true });
        await sleep(50);
        expect(a.seated).toEqual([]);
        await b.request("quickMatch");
        await waitFor(() => a.seated.length && b.seated.length, 2000, "seated");
        expect(a.seated[0].code).toBe(b.seated[0].code);
        expect(new Set([a.seated[0].seat, b.seated[0].seat])).toEqual(new Set([0, 1]));
        expect(a.seated[0].token).not.toBe(b.seated[0].token);
        const info = await a.waitForRoom((r) => r.status === "playing");
        expect(info.mode).toBe("quick");
    });

    it("survives disconnects: a player who left the queue is never matched", async () => {
        env = await startServer();
        const [a, b, c] = await connected(3);
        await a.request("quickMatch");
        a.socket.disconnect();
        await sleep(50);
        await b.request("quickMatch");
        await sleep(50);
        expect(b.seated).toEqual([]); // not paired with the departed player
        await c.request("quickMatch");
        await waitFor(() => b.seated.length && c.seated.length, 2000, "seated");
        expect(b.seated[0].code).toBe(c.seated[0].code);
        expect(env.server.manager.rooms.size).toBe(1);
    });

    it("never pairs a player with themselves, however often they ask", async () => {
        env = await startServer();
        const [a, b] = await connected(2);
        for (let i = 0; i < 5; i++) await a.request("quickMatch");
        await sleep(50);
        expect(a.seated).toEqual([]);
        expect(env.server.manager.queue.size).toBe(1);
        await b.request("quickMatch");
        await waitFor(() => a.seated.length && b.seated.length, 2000, "seated");
        expect(a.seated).toHaveLength(1);
    });

    it("cancelling leaves the queue", async () => {
        env = await startServer();
        const [a, b] = await connected(2);
        await a.request("quickMatch");
        await a.request("cancelQueue");
        await b.request("quickMatch");
        await sleep(50);
        expect(a.seated).toEqual([]);
        expect(b.seated).toEqual([]);
    });

    it("drops dead entries even if the disconnect was missed", () => {
        const q = new MatchQueue();
        let aliveA = true;
        const member = (id: string) => ({ id, send() {}, join() {}, leave() {} });
        q.enqueue({ member: member("a"), isAlive: () => aliveA });
        q.enqueue({ member: member("b"), isAlive: () => true });
        aliveA = false;
        expect(q.takePair()).toBeNull();
        q.enqueue({ member: member("c"), isAlive: () => true });
        expect(q.takePair()!.map((e) => e.member.id)).toEqual(["b", "c"]);
    });
});

describe("private rooms, bots and spectators", () => {
    it("a friend joins by code; a third player can't take a seat but can watch", async () => {
        env = await startServer();
        const { code } = await privateMatch(env);
        const [late] = await connected(1);
        expect(await late.request("joinRoom", { code })).toEqual({ ok: false, error: "That room doesn't exist, is full, or has already started." });
        expect(await late.request("joinRoom", { code: "ZZZZZZ" })).toEqual({ ok: false, error: "That room doesn't exist, is full, or has already started." });
        expect((await late.request("watchRoom", { code: code.toLowerCase() })).ok).toBe(true);
        const s1 = await late.waitForSnapshot(() => true);
        await late.waitForSnapshot((s) => s.tick > s1.tick);
        expect(late.room!.you).toBe(-1);
    });

    it("plays against the computer at every difficulty", async () => {
        // Seed 100: seat 0 (the human) serves first, so the first shot goes to the bot.
        env = await startServer({ seed: () => 100 });
        for (const difficulty of ["easy", "medium", "hard"]) {
            const [c] = await connected(1);
            const res = await c.request("playBot", { difficulty });
            expect(res.ok).toBe(true);
            const info = await c.waitForRoom((r) => r.status === "playing");
            expect(info.seats[1]).toMatchObject({ kind: "bot", connected: true });
            // The bot moves its paddle once the ball is served towards it.
            await c.waitForSnapshot((s) => s.paddles[1].dir !== 0, 5000);
        }
    });
});

describe("disconnects and reconnection", () => {
    const fast = { reconnectGraceMs: 600, resumeDelayMs: 100 };

    it("pauses the match and gives the seat back to a reconnecting player", async () => {
        env = await startServer({ config: fast });
        const { a, b, code } = await privateMatch(env);
        const seatA = a.room!.you as 0 | 1;
        const token = a.token;
        a.socket.disconnect();
        const paused = await b.waitForRoom((r) => r.status === "paused");
        expect(paused.pause).toMatchObject({ seat: seatA, resumeInMs: null });
        expect(paused.pause!.forfeitInMs).toBeGreaterThan(0);
        expect(paused.seats[seatA].connected).toBe(false);
        const frozen = await b.waitForSnapshot((s) => s.paused);

        const [back] = await connected(1);
        expect(await back.request("resume", { code, token })).toEqual({ ok: true, code, seat: seatA });
        await back.waitForRoom((r) => r.status === "paused" && r.pause?.resumeInMs !== null);
        await back.waitForRoom((r) => r.status === "playing");
        // The paddle is theirs again.
        const snap = await back.waitForSnapshot((s) => !s.paused && s.tick > frozen.tick);
        back.socket.emit("input", { c: [[0, snap.tick + 3, INPUT_LEVELS]], l: 0 });
        await back.waitForSnapshot((s) => s.paddles[seatA].dir === INPUT_LEVELS && s.acks[seatA] === 0);
    });

    it("forfeits the match after the grace period", async () => {
        env = await startServer({ config: fast });
        const { a, b } = await privateMatch(env);
        const seatA = a.room!.you as 0 | 1;
        a.socket.disconnect();
        await b.waitForRoom((r) => r.status === "paused");
        const over = await b.waitForRoom((r) => r.status === "over", 3000);
        expect(over.forfeited).toBe(seatA);
        expect(b.snapshot!.winner).toBe(b.room!.you);
    });

    it("a player who leaves on purpose forfeits at once and can't come back", async () => {
        env = await startServer({ config: fast });
        const { a, b, code } = await privateMatch(env);
        const token = a.token;
        await a.request("leaveRoom");
        await b.waitForRoom((r) => r.status === "over" && r.forfeited === a.room!.you);
        const [back] = await connected(1);
        expect((await back.request("resume", { code, token })).ok).toBe(false);
    });

    it("opening the seat in a second tab moves it there", async () => {
        env = await startServer();
        const { a, code } = await privateMatch(env);
        const [tab2] = await connected(1);
        expect((await tab2.request("resume", { code, token: a.token })).ok).toBe(true);
        await waitFor(() => a.errors.includes("This seat was opened in another tab."), 2000, "replaced");
        const snap = await tab2.waitForSnapshot(() => true);
        // The old tab can no longer steer.
        a.socket.emit("input", { c: [[0, snap.tick + 3, INPUT_LEVELS]], l: 0 });
        await sleep(150);
        expect(tab2.snapshot!.acks[tab2.room!.you as 0 | 1]).toBe(-1);
    });
});

describe("rematch", () => {
    it("needs both players to agree", async () => {
        env = await startServer();
        const { a, b } = await privateMatch(env);
        // Playing to 7 takes a while; end the match directly on the server.
        const room = env.server.manager.get(a.code)!;
        room.game = { ...room.game!, phase: "over", winner: 0 };
        await b.waitForRoom((r) => r.status === "over");
        const startTick = room.game.tick;

        expect((await a.request("rematch")).ok).toBe(true);
        const waiting = await b.waitForRoom((r) => r.seats[a.room!.you as 0 | 1].rematch);
        expect(waiting.status).toBe("over");
        expect((await b.request("rematch")).ok).toBe(true);
        await a.waitForRoom((r) => r.status === "playing");
        const fresh = await a.waitForSnapshot((s) => s.phase === "countdown");
        expect(fresh.score).toEqual([0, 0]);
        expect(fresh.tick).toBeGreaterThanOrEqual(startTick); // the tick keeps counting
    });

    it("isn't possible while the match is still on", async () => {
        env = await startServer();
        const { a } = await privateMatch(env);
        expect(await a.request("rematch")).toEqual({ ok: false, error: "That's not possible right now." });
    });
});
