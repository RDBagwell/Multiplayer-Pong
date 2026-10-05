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
        for (const room of this.rooms.values()) {
            try {
                room.advance(now);
            } catch (err) {
                this.deps.log?.("error", `room loop failed: ${(err as Error)?.stack || err}`);
                room.close("Something went wrong.");
            }
        }
        if (now - this.lastSweep >= this.config.sweepIntervalMs) this.sweep(now);
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
