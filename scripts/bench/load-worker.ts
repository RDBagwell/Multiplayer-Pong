/**
 * Load-test worker: plays ROOMS private-room matches against a running server,
 * two simulated players per room, each a real socket.io-client connection.
 *
 * Each room connects from its own loopback address (127.1.x.y), so the
 * server's per-IP limits stay on and are respected. Players behave like a
 * real client on the wire: input changes with sequence numbers and resends
 * of unacknowledged ones, a clock-sync ping every second, and a rematch when
 * a match ends. They steer with a simple chase rule rather than the full
 * browser netcode, so the worker itself stays cheap.
 *
 * Prints one JSON line with what the players observed during the measured
 * window (after WARMUP_MS).
 *
 * Env: URL, ROOMS, OFFSET (room index of the first room), WARMUP_MS, MEASURE_MS.
 */
import { io, type Socket } from "socket.io-client";

const URL = process.env.URL ?? "http://127.0.0.1:3100";
const ROOMS = Number(process.env.ROOMS ?? 10);
const OFFSET = Number(process.env.OFFSET ?? 0);
const WARMUP_MS = Number(process.env.WARMUP_MS ?? 10_000);
const MEASURE_MS = Number(process.env.MEASURE_MS ?? 30_000);
const ORIGIN = "http://localhost:5173";

type Ack = { ok: boolean; code?: string; seat?: number; error?: string };

const start = performance.now();
const measuring = () => {
    const t = performance.now() - start;
    return t >= WARMUP_MS && t < WARMUP_MS + MEASURE_MS;
};
const gaps: number[] = [];
let snapshots = 0;
let disconnects = 0;
let closing = false;
let errors = 0;

function addressFor(room: number): string {
    return `127.1.${Math.floor(room / 250)}.${(room % 250) + 1}`;
}

function connect(localAddress: string): Promise<Socket> {
    return new Promise((resolve, reject) => {
        const socket = io(URL, {
            transports: ["websocket"],
            forceNew: true,
            reconnection: false,
            extraHeaders: { origin: ORIGIN },
            localAddress,
        } as Parameters<typeof io>[1]);
        socket.once("connect", () => resolve(socket));
        socket.once("connect_error", reject);
    });
}

function request(socket: Socket, event: string, payload: unknown): Promise<Ack> {
    return new Promise((resolve) => socket.timeout(10_000).emit(event, payload, (err: Error | null, res: Ack) => resolve(err ? { ok: false, error: "timeout" } : res)));
}

/** One simulated player. */
function play(socket: Socket, seat: number): void {
    let seq = -1;
    let dir = 0;
    let lastTick = 0;
    let unacked: [number, number, number][] = [];
    let lastSnapshotAt: number | null = null;
    let lastSendAt = 0;
    const aimError = (Math.random() * 2 - 1) * 40;

    const send = () => {
        if (!unacked.length) return;
        lastSendAt = performance.now();
        socket.emit("input", { c: unacked.slice(-16), l: 6 });
    };

    socket.on("snapshot", (s: { t: number; b: number[]; p: [number, number][]; a: [number, number] }) => {
        const now = performance.now();
        if (lastSnapshotAt !== null && measuring()) gaps.push(now - lastSnapshotAt);
        lastSnapshotAt = now;
        if (measuring()) snapshots++;
        lastTick = Math.max(lastTick, s.t);
        unacked = unacked.filter(([q]) => q > s.a[seat]);

        const [, by, bvx] = s.b;
        const incoming = seat === 0 ? bvx < 0 : bvx > 0;
        const target = incoming ? by + aimError : 250;
        const next = Math.max(-8, Math.min(8, Math.round(((target - s.p[seat][0]) / 9) * 8)));
        if (next !== dir) {
            dir = next;
            unacked.push([++seq, lastTick + 3, dir]);
            send();
        } else if (unacked.length && now - lastSendAt > 100) {
            send();
        }
    });
    socket.on("room", (info: { status: string; seats: { rematch: boolean }[] }) => {
        if (info.status === "over" && !info.seats[seat].rematch) void request(socket, "rematch", {});
    });
    socket.on("serverError", () => errors++);
    socket.on("disconnect", () => {
        if (!closing) disconnects++;
    });
    const sync = setInterval(() => socket.emit("sync", { t: performance.now() }), 1000);
    sync.unref();
}

async function main(): Promise<void> {
    const sockets: Socket[] = [];
    let failedRooms = 0;
    const setups = Array.from({ length: ROOMS }, async (_, i) => {
        const address = addressFor(OFFSET + i);
        try {
            // Stagger room creation a little so connection bursts look like real arrivals.
            await new Promise((r) => setTimeout(r, i * 5));
            const a = await connect(address);
            const b = await connect(address);
            sockets.push(a, b);
            const created = await request(a, "createRoom", {});
            if (!created.ok || !created.code) throw new Error(created.error ?? "createRoom failed");
            const joined = await request(b, "joinRoom", { code: created.code });
            if (!joined.ok) throw new Error(joined.error ?? "joinRoom failed");
            play(a, created.seat ?? 0);
            play(b, joined.seat ?? 1);
        } catch (err) {
            failedRooms++;
            console.error(`room ${OFFSET + i}: ${(err as Error).message}`);
        }
    });
    await Promise.all(setups);
    const setupMs = performance.now() - start;

    await new Promise((r) => setTimeout(r, Math.max(0, WARMUP_MS + MEASURE_MS - (performance.now() - start))));
    closing = true;
    for (const s of sockets) s.disconnect();

    gaps.sort((a, b) => a - b);
    const pct = (p: number) => (gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor((p / 100) * gaps.length))] : 0);
    console.log(
        JSON.stringify({
            rooms: ROOMS - failedRooms,
            failedRooms,
            setupMs: Math.round(setupMs),
            snapshotsPerClientPerSec: Math.round((snapshots / (2 * Math.max(1, ROOMS - failedRooms)) / (MEASURE_MS / 1000)) * 100) / 100,
            gapP50: Math.round(pct(50) * 10) / 10,
            gapP99: Math.round(pct(99) * 10) / 10,
            gapMax: Math.round((gaps.at(-1) ?? 0) * 10) / 10,
            disconnects,
            errors,
        })
    );
    process.exit(0);
}

void main();
