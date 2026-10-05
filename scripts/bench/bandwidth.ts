/**
 * Bandwidth per player at different snapshot rates.
 *
 *   node --experimental-strip-types scripts/bench/bandwidth.ts 20,30
 *
 * Uses the headless harness (tests/harness): the real server and two real
 * clients (socket.io-client + the browser's GameClient) in a private room,
 * on a virtual clock, with a perfect network. Each client is played by the
 * harness's scripted player, which moves almost constantly, so input traffic
 * is on the high side of a real match.
 *
 * Bytes are counted on every engine.io packet each client sends or receives
 * (game traffic, clock sync, room events and engine.io pings), plus the
 * WebSocket frame header each one needs (2–4 bytes from the server, 6–8 from
 * the client, which must mask). TCP/IP and TLS overhead are not included.
 */
import { PERFECT_NETWORK } from "../../client/src/net/NetworkSimulator.ts";
import { createHarness, scriptedPlayer, seededRandom, type HarnessClient } from "../../tests/harness/harness.ts";

const rates = (process.argv[2] ?? "20,30").split(",").map(Number);
const WARMUP_MS = 5_000;
const MEASURE_MS = 60_000;

interface Meter {
    up: number;
    down: number;
    upPackets: number;
    downPackets: number;
    snapshotBytes: number;
    snapshots: number;
    inputPackets: number;
    on: boolean;
}

function wsFrame(payload: number, masked: boolean): number {
    const len = payload < 126 ? 2 : payload < 65536 ? 4 : 10;
    return len + (masked ? 4 : 0);
}

function meter(client: HarnessClient): Meter {
    const m: Meter = { up: 0, down: 0, upPackets: 0, downPackets: 0, snapshotBytes: 0, snapshots: 0, inputPackets: 0, on: false };
    const engine = client.connection.socket.io.engine;
    const size = (p: { data?: unknown }) => 1 + (typeof p.data === "string" ? p.data.length : 0);
    engine.on("packetCreate", (p: { data?: unknown }) => {
        if (!m.on) return;
        const n = size(p);
        m.up += n + wsFrame(n, true);
        m.upPackets++;
        if (typeof p.data === "string" && p.data.startsWith('2["input"')) m.inputPackets++;
    });
    engine.on("packet", (p: { data?: unknown }) => {
        if (!m.on) return;
        const n = size(p);
        m.down += n + wsFrame(n, false);
        m.downPackets++;
        if (typeof p.data === "string" && p.data.startsWith('2["snapshot"')) {
            m.snapshots++;
            m.snapshotBytes += n;
        }
    });
    return m;
}

async function measure(snapshotRate: number) {
    const h = await createHarness({ seed: 5, server: { config: { snapshotRate } } });
    try {
        const a = await h.addClient("a", PERFECT_NETWORK);
        const b = await h.addClient("b", PERFECT_NETWORK);
        const created = await h.settle(a.session.createRoom());
        if (!created.ok) throw new Error(created.error);
        await h.settle(b.session.joinRoom(created.code!));
        a.game.input = scriptedPlayer(a, seededRandom(11));
        b.game.input = scriptedPlayer(b, seededRandom(13));
        const meters = [meter(a), meter(b)];
        await h.run(WARMUP_MS);
        for (const m of meters) m.on = true;
        await h.run(MEASURE_MS);
        for (const m of meters) m.on = false;
        const s = MEASURE_MS / 1000;
        const avg = (f: (m: Meter) => number) => meters.reduce((acc, m) => acc + f(m), 0) / meters.length;
        return {
            snapshotRate,
            downBytesPerSec: Math.round(avg((m) => m.down) / s),
            upBytesPerSec: Math.round(avg((m) => m.up) / s),
            downPacketsPerSec: Math.round((avg((m) => m.downPackets) / s) * 10) / 10,
            upPacketsPerSec: Math.round((avg((m) => m.upPackets) / s) * 10) / 10,
            inputPacketsPerSec: Math.round((avg((m) => m.inputPackets) / s) * 10) / 10,
            avgSnapshotBytes: Math.round(avg((m) => m.snapshotBytes) / avg((m) => m.snapshots)),
        };
    } finally {
        await h.close();
    }
}

console.log(`Node ${process.version}; ${MEASURE_MS / 1000} s of game time measured after ${WARMUP_MS / 1000} s, two players per room, perfect network.\n`);
console.log("| Snapshot rate | Download per player | Upload per player | Packets/s down / up | Input packets/s | Average snapshot |");
console.log("|---|---|---|---|---|---|");
for (const rate of rates) {
    const r = await measure(rate);
    console.log(
        `| ${r.snapshotRate} Hz | ${(r.downBytesPerSec / 1000).toFixed(2)} kB/s | ${(r.upBytesPerSec / 1000).toFixed(2)} kB/s | ${r.downPacketsPerSec} / ${r.upPacketsPerSec} | ${r.inputPacketsPerSec} | ${r.avgSnapshotBytes} B |`
    );
}
process.exit(0);
