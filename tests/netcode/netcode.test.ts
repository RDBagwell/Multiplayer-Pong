import { afterEach, describe, expect, it } from "vitest";
import { INPUT_LEVELS, TICK_MS } from "../../shared/constants.ts";
import { PRESETS } from "../../client/src/net/presets.ts";
import type { NetworkConditions } from "../../client/src/net/NetworkSimulator.ts";
import { createHarness, scriptedPlayer, seededRandom, type Harness, type HarnessClient } from "../harness/harness.ts";

let h: Harness | null = null;
afterEach(async () => {
    await h?.close();
    h = null;
});

/** A client in a match against the server's bot, with the match running. */
async function botMatch(conditions: NetworkConditions, seed = 1) {
    h = await createHarness({ seed });
    const player = await h.addClient("player", conditions);
    const ack = await h.settle(player.session.playBot("medium"));
    if (!ack.ok) throw new Error(ack.error);
    await h.run(3_000, () => player.game.predictor.started);
    expect(player.game.predictor.started).toBe(true);
    return { h, player, room: h.server.manager.get(ack.code!)! };
}

/** Random direction changes, like a nervous player. */
function jitteryInput(random: () => number) {
    let dir = 0;
    return () => {
        if (random() < 0.06) dir = Math.round(random() * 2 * INPUT_LEVELS) - INPUT_LEVELS;
        return dir;
    };
}

const conditions: [string, NetworkConditions][] = [
    ["a perfect network", PRESETS.perfect.conditions],
    ["Same city", PRESETS.sameCity.conditions],
    ["Bad Wi-Fi", PRESETS.badWifi.conditions],
    ["Satellite", PRESETS.satellite.conditions],
];

describe("clock sync", () => {
    it.each(conditions)("estimates the round trip and the server's tick under %s", async (_name, net) => {
        const { h, player, room } = await botMatch(net);
        await h.run(5_000);
        const c = player.game.clock;
        // The simulated network adds latencyMs plus on average jitterMs (half each way, twice).
        expect(c.rtt).toBeGreaterThanOrEqual(net.latencyMs);
        expect(c.rtt).toBeLessThan(net.latencyMs + 2 * net.jitterMs + 4 * 8 + 10);
        // Within a tick or two of the truth, read straight from the server.
        expect(Math.abs(c.serverTick(h.clock.t) - room.tickAt(h.clock.t))).toBeLessThan(2 + net.jitterMs / TICK_MS);
    });
});

describe("prediction and reconciliation", () => {
    it.each(conditions)("the predicted paddle converges exactly to the server's after inputs stop, under %s", async (_name, net) => {
        const { h, player, room } = await botMatch(net);
        const seat = player.game.seat as 0 | 1;
        player.game.input = jitteryInput(seededRandom(3));
        await h.run(4_000);
        player.game.input = () => 0;
        await h.run(3_000);
        expect(player.game.predictor.unacked).toEqual([]);
        expect(player.game.predictor.paddle.y).toBe(room.game!.paddles[seat].y);
        expect(player.game.latest!.paddles[seat].y).toBe(room.game!.paddles[seat].y);
        // And what's drawn has settled on it too.
        expect(player.view!.paddleY[seat]).toBe(room.game!.paddles[seat].y);
    });

    it("never corrects anything on a steady network: prediction is exactly right", async () => {
        const steady = { latencyMs: 100, jitterMs: 0, loss: 0 };
        const { h, player, room } = await botMatch(steady);
        const seat = player.game.seat as 0 | 1;
        player.game.input = jitteryInput(seededRandom(9));
        await h.run(10_000);
        expect(player.game.predictor.lastSeq).toBeGreaterThan(20);
        expect(room.seats[seat].input.lateCount).toBe(0);
        expect(player.game.stats(h.clock.t).corrections).toBe(0);
    });

    it("never desyncs under Bad Wi-Fi: every reconcile lands on the server's state, and corrections are explained by late inputs", async () => {
        const { h, player, room } = await botMatch(PRESETS.badWifi.conditions);
        const seat = player.game.seat as 0 | 1;
        const mismatches: string[] = [];
        player.game.onReconcile = (s) => {
            // After rewinding, the history at the snapshot's tick is the server's state, bit for bit.
            const atS = player.game.predictor.history.get(s.tick);
            if (atS && atS.y !== s.paddles[seat].y) mismatches.push(`tick ${s.tick}: ${atS.y} vs ${s.paddles[seat].y}`);
        };
        player.game.input = jitteryInput(seededRandom(5));
        await h.run(20_000);
        player.game.input = () => 0;
        await h.run(3_000);
        expect(mismatches).toEqual([]);
        const stats = player.game.stats(h.clock.t);
        const late = room.seats[seat].input.lateCount;
        // A late input can be off for a couple of snapshots until its ack arrives; nothing else may cause corrections.
        expect(stats.corrections).toBeLessThanOrEqual(3 * late);
        expect(player.game.predictor.paddle.y).toBe(room.game!.paddles[seat].y);
    });

    it("with reconciliation off, the paddle rubber-bands (the lab's demonstration)", async () => {
        const { h, player } = await botMatch({ latencyMs: 150, jitterMs: 0, loss: 0 });
        player.game.toggles.reconciliation = false;
        let dir = INPUT_LEVELS;
        player.game.input = (y) => {
            if (y > 400) dir = -INPUT_LEVELS;
            if (y < 100) dir = INPUT_LEVELS;
            return dir;
        };
        await h.run(5_000);
        const stats = player.game.stats(h.clock.t);
        expect(stats.corrections).toBeGreaterThan(20);
        expect(stats.lastCorrection).toBeGreaterThan(10);
    });
});

describe("interpolation", () => {
    function expectMonotonic(client: HarnessClient) {
        const ticks = client.renderTicks;
        expect(ticks.length).toBeGreaterThan(100);
        for (let i = 1; i < ticks.length; i++) {
            if (ticks[i] < ticks[i - 1]) throw new Error(`${client.name}: render tick went back from ${ticks[i - 1]} to ${ticks[i]} at frame ${i}`);
        }
    }

    it.each(conditions)("render time never goes backwards under %s", async (_name, net) => {
        const { h, player } = await botMatch(net);
        player.game.input = jitteryInput(seededRandom(2));
        await h.run(15_000);
        expectMonotonic(player);
    });

    it("draws others in the past by about the interpolation delay, and the delay grows with jitter", async () => {
        const calm = await botMatch(PRESETS.sameCity.conditions);
        await calm.h.run(5_000);
        const calmDelay = calm.player.game.interpolator.delayMs;
        const behind = calm.room.tickAt(calm.h.clock.t) - calm.player.view!.renderTick;
        expect(calmDelay).toBeGreaterThanOrEqual(100);
        expect(behind * TICK_MS).toBeGreaterThan(calmDelay - 2 * TICK_MS);
        expect(behind * TICK_MS).toBeLessThan(calmDelay + 2 * TICK_MS);
        await calm.h.close();

        const shaky = await botMatch(PRESETS.badWifi.conditions);
        await shaky.h.run(8_000);
        expect(shaky.player.game.interpolator.delayMs).toBeGreaterThan(calmDelay + 20);
    });

    it("keeps the ball inside the field and moving smoothly at 20 Hz snapshots", async () => {
        const { h, player } = await botMatch(PRESETS.sameCity.conditions);
        const positions: { x: number; y: number; phase: string }[] = [];
        for (let i = 0; i < 1500; i++) {
            await h.step();
            if (player.view) positions.push({ ...player.view.ball, phase: player.view.phase });
        }
        let maxJump = 0;
        for (let i = 1; i < positions.length; i++) {
            const a = positions[i - 1];
            const b = positions[i];
            if (a.phase !== "playing" || b.phase !== "playing") continue;
            maxJump = Math.max(maxJump, Math.hypot(b.x - a.x, b.y - a.y));
            expect(b.y).toBeGreaterThanOrEqual(0);
            expect(b.y).toBeLessThanOrEqual(500);
        }
        // An 8 ms frame at the top ball speed (1080 u/s) moves under 9 units; a 20 Hz jump would be 50+.
        expect(maxJump).toBeLessThan(12);
    });
});

describe("full matches", () => {
    async function twoPlayerMatch(net: NetworkConditions, seed: number) {
        h = await createHarness({ seed });
        const a = await h.addClient("a", net);
        const b = await h.addClient("b", net);
        const created = await h.settle(a.session.createRoom());
        if (!created.ok) throw new Error(created.error);
        expect((await h.settle(b.session.joinRoom(created.code!))).ok).toBe(true);
        a.game.input = scriptedPlayer(a, seededRandom(seed * 11));
        b.game.input = scriptedPlayer(b, seededRandom(seed * 13));
        const room = h.server.manager.get(created.code!)!;
        const finished = await h.run(10 * 60_000, () => room.status === "over");
        await h.run(1_000);
        return { a, b, room, finished };
    }

    it("a whole match between two clients completes under Bad Wi-Fi", async () => {
        const { a, b, room, finished } = await twoPlayerMatch(PRESETS.badWifi.conditions, 4);
        expect(finished).toBe(true);
        const final = room.game!;
        expect(Math.max(...final.score)).toBe(7);
        expect(final.winner).not.toBe(-1);
        for (const c of [a, b]) {
            expect(c.game.latest!.phase).toBe("over");
            expect(c.game.latest!.score).toEqual(final.score);
            expect(c.game.latest!.winner).toBe(final.winner);
            expectMonotonicTicks(c);
        }
        // The network really was bad.
        expect(a.netsim.down.dropped + b.netsim.down.dropped).toBeGreaterThan(0);
        expect(a.game.stats(h!.clock.t).snapshotsLost).toBeGreaterThan(0);
    });
});

function expectMonotonicTicks(client: HarnessClient) {
    for (let i = 1; i < client.renderTicks.length; i++) {
        if (client.renderTicks[i] < client.renderTicks[i - 1]) throw new Error(`${client.name}: render tick went backwards at frame ${i}`);
    }
}
