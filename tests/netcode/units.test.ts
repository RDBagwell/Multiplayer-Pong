import { describe, expect, it } from "vitest";
import { TICK_MS } from "../../shared/constants.ts";
import { encodeSnapshot, decodeSnapshot } from "../../shared/protocol.ts";
import { createInitialState } from "../../shared/state.ts";
import { ClockSync } from "../../client/src/netcode/ClockSync.ts";
import { SnapshotBuffer } from "../../client/src/netcode/Interpolation.ts";
import { NetworkSimulator } from "../../client/src/net/NetworkSimulator.ts";
import { Predictor } from "../../client/src/netcode/Prediction.ts";
import { reconcile } from "../../client/src/netcode/Reconciliation.ts";
import { seededRandom } from "../harness/harness.ts";

describe("ClockSync", () => {
    /** Server tick = (serverMs) / TICK_MS; the server clock runs `skew` ms ahead of ours. */
    function feed(sync: ClockSync, skew: number, delays: [number, number][]) {
        let t = 10_000;
        for (const [up, down] of delays) {
            const t0 = t;
            const serverTick = (t0 + up + skew) / TICK_MS;
            const t1 = t0 + up + down;
            sync.addSample(t0, t1, serverTick);
            t += 1000;
        }
        return t;
    }

    it("finds the server tick from symmetric round trips", () => {
        const sync = new ClockSync();
        const t = feed(sync, 5000, Array.from({ length: 10 }, () => [40, 40] as [number, number]));
        expect(sync.serverTick(t)).toBeCloseTo((t + 5000) / TICK_MS, 6);
        expect(sync.rtt).toBeCloseTo(80, 6);
    });

    it("ignores outliers: a few very slow, lopsided replies barely move the estimate", () => {
        const sync = new ClockSync();
        const delays: [number, number][] = Array.from({ length: 16 }, (_, i) => (i % 5 === 4 ? [400, 20] : [40, 40]));
        const t = feed(sync, -3000, delays);
        const errorTicks = sync.serverTick(t) - (t - 3000) / TICK_MS;
        // A naive average of all samples would be off by about 3 ticks.
        expect(Math.abs(errorTicks)).toBeLessThan(0.2);
    });

    it("moves gradually for small changes and snaps for large ones", () => {
        const sync = new ClockSync();
        let t = feed(sync, 0, Array.from({ length: 16 }, () => [30, 30] as [number, number]));
        const before = sync.serverTick(t) - t / TICK_MS;
        // The server is suddenly 2 ticks further ahead. A single sample is outvoted by the window...
        t = feed(sync, 2 * TICK_MS, [[30, 30]]);
        expect(sync.serverTick(t) - t / TICK_MS - before).toBeCloseTo(0, 6);
        // ...once most of the window agrees, the estimate glides towards it instead of jumping.
        t = feed(sync, 2 * TICK_MS, Array.from({ length: 11 }, () => [30, 30] as [number, number]));
        const moved = sync.serverTick(t) - t / TICK_MS - before;
        expect(moved).toBeGreaterThan(0.5);
        expect(moved).toBeLessThan(1.9);
        t = feed(sync, 2 * TICK_MS, Array.from({ length: 30 }, () => [30, 30] as [number, number]));
        expect(sync.serverTick(t) - t / TICK_MS - before).toBeCloseTo(2, 2);
        // 10 ticks: snap.
        const sync2 = new ClockSync();
        feed(sync2, 0, Array.from({ length: 16 }, () => [30, 30] as [number, number]));
        const t2 = feed(sync2, 10 * TICK_MS, Array.from({ length: 16 }, () => [30, 30] as [number, number]));
        expect(sync2.serverTick(t2)).toBeCloseTo((t2 + 10 * TICK_MS) / TICK_MS, 3);
    });
});

describe("SnapshotBuffer", () => {
    const snap = (tick: number) => decodeSnapshot(encodeSnapshot({ ...createInitialState(1), tick }, [0, 0]));

    it("keeps snapshots in tick order whatever order they arrive in, without duplicates", () => {
        const b = new SnapshotBuffer();
        for (const t of [3, 9, 6, 15, 12, 9, 3]) b.insert(snap(t));
        expect(b.items.map((s) => s.tick)).toEqual([3, 6, 9, 12, 15]);
    });
});

describe("NetworkSimulator", () => {
    it("delays, reorders and drops at the configured rates", () => {
        const sim = new NetworkSimulator({ latencyMs: 100, jitterMs: 50, loss: 0.1 }, seededRandom(1));
        const delivered: { id: number; at: number }[] = [];
        let now = 0;
        for (let id = 0; id < 2000; id++) {
            const sentAt = now;
            sim.transmit("down", sentAt, () => delivered.push({ id, at: now - sentAt }));
            now += 5;
            sim.pump(now);
        }
        for (let i = 0; i < 100; i++) sim.pump((now += 5));
        const lossRate = 1 - delivered.length / 2000;
        expect(lossRate).toBeGreaterThan(0.08);
        expect(lossRate).toBeLessThan(0.12);
        for (const d of delivered) {
            expect(d.at).toBeGreaterThanOrEqual(50);
            expect(d.at).toBeLessThanOrEqual(100 + 5);
        }
        const reordered = delivered.some((d, i) => i > 0 && d.id < delivered[i - 1].id);
        expect(reordered).toBe(true);
    });
});

describe("reconcile", () => {
    it("replays unacknowledged inputs from the server's state", () => {
        const p = new Predictor();
        p.start(100, { y: 250, dir: 0 });
        for (let i = 0; i < 10; i++) p.advance(8); // seq 0 at tick 101
        for (let i = 0; i < 10; i++) p.advance(-8); // seq 1 at tick 111
        const predicted = p.paddle.y;
        // The server applied seq 0 exactly as predicted, and hasn't seen seq 1 yet.
        const atTick105 = p.history.get(105)!;
        const r = reconcile(p, 105, atTick105, 0);
        expect(r.error).toBe(0);
        expect(r.replayed).toBe(15);
        expect(p.paddle.y).toBe(predicted);
        expect(p.unacked.map((c) => c.seq)).toEqual([1]);
    });

    it("corrects when the server disagrees, and naive mode snaps back", () => {
        const p = new Predictor();
        p.start(0, { y: 250, dir: 0 });
        for (let i = 0; i < 20; i++) p.advance(8);
        const r = reconcile(p, 10, { y: 250, dir: 0 }, -1); // server hasn't applied anything yet at tick 10
        expect(r.error).toBeGreaterThan(0);
        const q = new Predictor();
        q.start(0, { y: 250, dir: 0 });
        for (let i = 0; i < 20; i++) q.advance(8);
        const naive = reconcile(q, 10, { y: 300, dir: 8 }, 0, { enabled: false });
        expect(q.paddle.y).toBe(300);
        expect(naive.error).toBeGreaterThan(50);
    });
});
