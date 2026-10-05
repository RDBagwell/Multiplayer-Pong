import type { Config } from "../config.ts";
import { generateRoomCode } from "../security/random.ts";
import { MatchQueue, type QueueEntry } from "./MatchQueue.ts";
import { Room, type RoomDeps, type RoomMode } from "./Room.ts";

export interface Clock {
    /** Monotonic milliseconds. */
    now(): number;
}

export const systemClock: Clock = { now: () => performance.now() };

export interface ManagerDeps extends Omit<RoomDeps, "config"> {
    clock?: Clock;
}

/**
 * Owns every room and the quick-match queue, and drives the rooms' loops.
 *
 * In production `start()` calls `advance()` every few milliseconds; each
 * room's accumulator turns the elapsed time into whole ticks. Tests and the
 * netcode harness skip `start()` and call `advance()` themselves with a
 * virtual clock.
 */
export class RoomManager<E extends QueueEntry = QueueEntry> {
    readonly rooms = new Map<string, Room>();
    readonly queue = new MatchQueue<E>();
    readonly clock: Clock;
    private readonly config: Config;
    private readonly deps: ManagerDeps;
    private timer: ReturnType<typeof setInterval> | null = null;
    private lastSweep = 0;

    constructor(config: Config, deps: ManagerDeps) {
        this.config = config;
        this.deps = deps;
        this.clock = deps.clock ?? systemClock;
        this.lastSweep = this.clock.now();
    }

    /** A new room with a fresh unguessable code, or null if the server is full. */
    create(mode: RoomMode): Room | null {
        if (this.rooms.size >= this.config.maxRooms) return null;
        let code = generateRoomCode();
        while (this.rooms.has(code)) code = generateRoomCode();
        const room = new Room(code, mode, this.clock.now(), { ...this.deps, config: this.config });
        this.rooms.set(code, room);
        return room;
    }

    get(code: string): Room | undefined {
        return this.rooms.get(code);
    }

    advance(now = this.clock.now()): void {
        const started = performance.now();
        let maxTicks = 0;
        for (const room of this.rooms.values()) {
            try {
                maxTicks = Math.max(maxTicks, room.advance(now));
            } catch (err) {
                this.deps.log?.("error", `room loop failed: ${(err as Error)?.stack || err}`);
                room.close("Something went wrong.");
            }
        }
        if (now - this.lastSweep >= this.config.sweepIntervalMs) this.sweep(now);
        if (this.config.loopStatsMs > 0) this.recordLoop(now, performance.now() - started, maxTicks);
    }

    // -------------------------------------------------------------------------
    // Loop timing stats (LOOP_STATS_MS): for load testing, off by default.
    // -------------------------------------------------------------------------

    private loop = { since: 0, last: null as number | null, gaps: [] as number[], durations: [] as number[], maxTicks: 0, skipped: 0 };

    /**
     * Records how regularly the loop runs. A healthy server calls advance()
     * every loopIntervalMs and steps at most one tick per room per call; when
     * it falls behind, the gaps between calls grow past a tick (16.7 ms),
     * rooms step several ticks at once (snapshots bunch up), and after 250 ms
     * rooms start skipping time.
     */
    private recordLoop(now: number, durationMs: number, maxTicks: number): void {
        const l = this.loop;
        if (l.last !== null) l.gaps.push(now - l.last);
        l.last = now;
        l.durations.push(durationMs);
        l.maxTicks = Math.max(l.maxTicks, maxTicks);
        if (now - l.since < this.config.loopStatsMs) return;
        const pct = (xs: number[], p: number) => {
            if (!xs.length) return 0;
            const sorted = [...xs].sort((a, b) => a - b);
            return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
        };
        let skipped = 0;
        let playing = 0;
        for (const room of this.rooms.values()) {
            skipped += room.skippedTicks;
            if (room.status === "playing" || room.status === "over") playing++;
        }
        const round = (x: number) => Math.round(x * 100) / 100;
        const mem = process.memoryUsage();
        this.deps.log?.(
            "stats",
            JSON.stringify({
                rooms: this.rooms.size,
                playing,
                calls: l.durations.length,
                gapP50: round(pct(l.gaps, 50)),
                gapP99: round(pct(l.gaps, 99)),
                gapMax: round(Math.max(0, ...l.gaps)),
                advanceP50: round(pct(l.durations, 50)),
                advanceP99: round(pct(l.durations, 99)),
                advanceMax: round(Math.max(0, ...l.durations)),
                maxTicksPerCall: l.maxTicks,
                skippedTicks: skipped - l.skipped,
                rssMB: round(mem.rss / 2 ** 20),
                heapMB: round(mem.heapUsed / 2 ** 20),
            })
        );
        this.loop = { since: now, last: l.last, gaps: [], durations: [], maxTicks: 0, skipped };
    }

    /** Removes closed, abandoned and never-joined rooms. */
    sweep(now = this.clock.now()): void {
        this.lastSweep = now;
        for (const [code, room] of this.rooms) {
            if (!room.isExpired(now)) continue;
            room.close("This room has closed.");
            this.rooms.delete(code);
        }
    }

    start(): void {
        if (this.timer) return;
        this.timer = setInterval(() => this.advance(), this.config.loopIntervalMs);
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        for (const room of this.rooms.values()) room.close("The server is restarting.");
        this.rooms.clear();
    }
}
