import crypto from "node:crypto";
import type { Server, Socket } from "socket.io";
import {
    SESSION_EVENTS,
    clientEventSchemas,
    normalizeRoomCode,
    validateClientEvent,
    type Ack,
    type ClientEvent,
    type ClientPayload,
} from "../../shared/protocol.ts";
import type { Seat } from "../../shared/state.ts";
import type { Config } from "../config.ts";
import type { QueueEntry } from "../rooms/MatchQueue.ts";
import type { Member, Room } from "../rooms/Room.ts";
import type { RoomManager } from "../rooms/RoomManager.ts";
import { KeyedRateLimiter, TokenBucket } from "../security/rateLimit.ts";

/** Every error a client can see. A small fixed set, so errors never reveal internals. */
export const ERRORS = {
    invalid: "Invalid request.",
    rateLimited: "Slow down a little.",
    notFound: "That room doesn't exist, is full, or has already started.",
    serverFull: "The server is full right now. Try again later.",
    expired: "That session has expired.",
    notAllowed: "That's not possible right now.",
    replaced: "This seat was opened in another tab.",
    generic: "Something went wrong.",
} as const;

const KNOWN_EVENTS = new Set(Object.keys(clientEventSchemas));

interface Membership {
    code: string;
    seat: Seat | -1;
}

interface SocketData {
    ip: string;
    counted: boolean;
    violations: number;
    bucket: TokenBucket;
    sessionBucket: TokenBucket;
    member: Member;
    membership: Membership | null;
}

type GameSocket = Socket<Record<string, (...args: any[]) => void>, Record<string, (...args: any[]) => void>, Record<string, never>, SocketData>;

export interface QuickEntry extends QueueEntry {
    socket: GameSocket;
}

type Log = (level: string, message: string) => void;
type Reply = (result: Ack) => void;

/**
 * The Socket.io boundary. Everything that arrives here is hostile until proven
 * otherwise: the event must be known, the payload must pass its zod schema,
 * the socket must be within its rate limits, and identity comes only from
 * `socket.data.membership`, which only the server sets.
 */
export class SocketController {
    private readonly io: Server;
    private readonly manager: RoomManager<QuickEntry>;
    private readonly config: Config;
    private readonly log: Log;
    private readonly joinLimiter: KeyedRateLimiter;
    private readonly createLimiter: KeyedRateLimiter;
    private readonly connectLimiter: KeyedRateLimiter;
    private readonly connectionsPerIp = new Map<string, number>();
    private readonly pruner: ReturnType<typeof setInterval>;

    constructor(io: Server, manager: RoomManager<QuickEntry>, config: Config, log: Log = () => {}) {
        this.io = io;
        this.manager = manager;
        this.config = config;
        this.log = log;
        this.joinLimiter = new KeyedRateLimiter(config.limits.joinPerIp);
        this.createLimiter = new KeyedRateLimiter(config.limits.createPerIp);
        this.connectLimiter = new KeyedRateLimiter(config.limits.connectPerIp);
        this.pruner = setInterval(() => {
            for (const limiter of [this.joinLimiter, this.createLimiter, this.connectLimiter]) limiter.prune();
        }, 60_000);
        this.pruner.unref?.();

        io.use((socket, next) => this.admit(socket as GameSocket, next));
        io.on("connection", (socket) => this.register(socket as GameSocket));
    }

    stop(): void {
        clearInterval(this.pruner);
    }

    // -------------------------------------------------------------------------
    // Connection admission
    // -------------------------------------------------------------------------

    private clientIp(socket: GameSocket): string {
        const direct = socket.handshake.address;
        const header = this.config.clientIpHeader;
        if (header) {
            const value = String(socket.handshake.headers[header] || "").trim();
            if (/^[0-9a-fA-F:.]{2,45}$/.test(value)) return value;
        }
        const hops = this.config.trustProxyHops;
        if (!hops) return direct;
        const forwarded = String(socket.handshake.headers["x-forwarded-for"] || "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        // Each trusted proxy appends the address it saw; entries before those are client-controlled.
        return forwarded[Math.max(0, forwarded.length - hops)] || direct;
    }

    private admit(socket: GameSocket, next: (err?: Error) => void): void {
        const ip = this.clientIp(socket);
        socket.data.ip = ip;
        const open = this.connectionsPerIp.get(ip) || 0;
        if (open >= this.config.limits.maxConcurrentPerIp || !this.connectLimiter.take(ip)) {
            return next(new Error("Too many connections"));
        }
        this.connectionsPerIp.set(ip, open + 1);
        socket.data.counted = true;
        next();
    }

    private register(socket: GameSocket): void {
        socket.data.violations = 0;
        socket.data.bucket = new TokenBucket(this.config.limits.socketEvents);
        socket.data.sessionBucket = new TokenBucket(this.config.limits.sessionEvents);
        socket.data.membership = null;
        socket.data.member = {
            id: socket.id,
            send: (event, payload) => socket.emit(event, payload),
            join: (channel) => void socket.join(channel),
            leave: (channel) => void socket.leave(channel),
        };

        socket.onAny((event: string) => {
            if (!KNOWN_EVENTS.has(event)) this.violation(socket, ERRORS.invalid);
        });
        for (const event of KNOWN_EVENTS) {
            socket.on(event, (payload: unknown, ack: unknown) => this.dispatch(socket, event as ClientEvent, payload, ack));
        }
        socket.on("disconnect", () =>
            this.safe("disconnect", () => {
                if (socket.data.counted) {
                    const ip = socket.data.ip;
                    const left = (this.connectionsPerIp.get(ip) || 1) - 1;
                    if (left > 0) this.connectionsPerIp.set(ip, left);
                    else this.connectionsPerIp.delete(ip);
                }
                this.manager.queue.remove(socket.id);
                const membership = socket.data.membership;
                if (membership) this.manager.get(membership.code)?.disconnected(socket.id, this.now());
                socket.data.membership = null;
            })
        );
    }

    // -------------------------------------------------------------------------
    // Dispatch
    // -------------------------------------------------------------------------

    private dispatch(socket: GameSocket, event: ClientEvent, payload: unknown, ack: unknown): void {
        // Allow emit(event, ack) with no payload.
        if (typeof payload === "function" && ack === undefined) {
            ack = payload;
            payload = undefined;
        }
        const reply: Reply = (result) => {
            if (typeof ack === "function") ack(result);
            else if (!result.ok) socket.emit("serverError", { message: result.error });
        };

        this.safe(
            event,
            () => {
                if (!socket.data.bucket.take()) return reply(this.violation(socket, ERRORS.rateLimited, false));
                const valid = validateClientEvent(event, payload);
                if (!valid.ok) return reply(this.violation(socket, ERRORS.invalid, false));

                if (event === "input") return this.input(socket, valid.data as ClientPayload<"input">);
                if (event === "sync") return this.sync(socket, valid.data as ClientPayload<"sync">);
                if (SESSION_EVENTS.has(event)) {
                    if (!socket.data.sessionBucket.take()) return reply(this.violation(socket, ERRORS.rateLimited, false));
                    return reply(this.session(socket, event, valid.data));
                }
                reply({ ok: false, error: ERRORS.invalid });
            },
            reply
        );
    }

    /** Counts abuse; persistent offenders are disconnected. */
    private violation(socket: GameSocket, error: string, emit = true): Ack {
        socket.data.violations++;
        if (socket.data.violations > this.config.limits.maxViolations) {
            this.log("warn", "disconnecting socket after repeated invalid or excessive events");
            socket.disconnect(true);
        } else if (emit) {
            socket.emit("serverError", { message: error });
        }
        return { ok: false, error };
    }

    private session(socket: GameSocket, event: ClientEvent, data: unknown): Ack {
        switch (event) {
            case "createRoom":
                return this.createRoom(socket);
            case "joinRoom":
                return this.joinRoom(socket, data as ClientPayload<"joinRoom">);
            case "watchRoom":
                return this.watchRoom(socket, data as ClientPayload<"watchRoom">);
            case "quickMatch":
                return this.quickMatch(socket);
            case "cancelQueue":
                this.manager.queue.remove(socket.id);
                return { ok: true };
            case "playBot":
                return this.playBot(socket, data as ClientPayload<"playBot">);
            case "resume":
                return this.resume(socket, data as ClientPayload<"resume">);
            case "leaveRoom":
                this.release(socket);
                return { ok: true };
            case "rematch":
                return this.rematch(socket);
            default:
                return { ok: false, error: ERRORS.invalid };
        }
    }

    // -------------------------------------------------------------------------
    // Session events
    // -------------------------------------------------------------------------

    private createRoom(socket: GameSocket): Ack {
        if (!this.createLimiter.take(socket.data.ip)) return { ok: false, error: ERRORS.rateLimited };
        this.release(socket);
        const room = this.manager.create("private");
        if (!room) return { ok: false, error: ERRORS.serverFull };
        const token = this.seat(socket, room, 0);
        this.log("info", "private room created");
        return { ok: true, code: room.code, seat: 0, token };
    }

    private joinRoom(socket: GameSocket, { code }: ClientPayload<"joinRoom">): Ack {
        if (!this.joinLimiter.take(socket.data.ip)) return { ok: false, error: ERRORS.rateLimited };
        const room = this.findRoom(code);
        const seat = room ? room.openSeat() : -1;
        if (!room || seat === -1) return { ok: false, error: ERRORS.notFound };
        this.release(socket);
        const token = this.seat(socket, room, seat);
        return { ok: true, code: room.code, seat, token };
    }

    private watchRoom(socket: GameSocket, { code }: ClientPayload<"watchRoom">): Ack {
        if (!this.joinLimiter.take(socket.data.ip)) return { ok: false, error: ERRORS.rateLimited };
        const room = this.findRoom(code);
        if (!room) return { ok: false, error: ERRORS.notFound };
        this.release(socket);
        if (!room.addSpectator(socket.data.member)) return { ok: false, error: ERRORS.notFound };
        socket.data.membership = { code: room.code, seat: -1 };
        return { ok: true, code: room.code, seat: -1 };
    }

    private quickMatch(socket: GameSocket): Ack {
        this.release(socket);
        this.manager.queue.enqueue({ member: socket.data.member, socket, isAlive: () => socket.connected });
        this.pairQueue();
        return { ok: true, queued: true };
    }

    /** Pairs everyone who can be paired. Each pair gets a fresh room with randomly assigned sides. */
    private pairQueue(): void {
        for (let pair = this.manager.queue.takePair(); pair; pair = this.manager.queue.takePair()) {
            const room = this.manager.create("quick");
            if (!room) {
                this.manager.queue.requeueFront(pair);
                for (const entry of pair) entry.socket.emit("serverError", { message: ERRORS.serverFull });
                return;
            }
            const first = crypto.randomInt(2) as Seat;
            pair.forEach((entry, i) => {
                const seat = (i === 0 ? first : 1 - first) as Seat;
                const token = this.seat(entry.socket, room, seat);
                entry.socket.emit("seated", { code: room.code, seat, token });
            });
        }
    }

    private playBot(socket: GameSocket, { difficulty }: ClientPayload<"playBot">): Ack {
        if (!this.createLimiter.take(socket.data.ip)) return { ok: false, error: ERRORS.rateLimited };
        this.release(socket);
        const room = this.manager.create("bot");
        if (!room) return { ok: false, error: ERRORS.serverFull };
        room.seatBot(1, difficulty);
        const token = this.seat(socket, room, 0);
        return { ok: true, code: room.code, seat: 0, token };
    }

    private resume(socket: GameSocket, { code, token }: ClientPayload<"resume">): Ack {
        if (!this.joinLimiter.take(socket.data.ip)) return { ok: false, error: ERRORS.rateLimited };
        const room = this.findRoom(code);
        const seat = room ? room.seatForToken(token) : -1;
        if (!room || seat === -1) return { ok: false, error: ERRORS.expired };

        const current = socket.data.membership;
        if (!(current?.code === room.code && current.seat === seat)) this.release(socket);
        const previous = room.reattach(seat, socket.data.member, this.now());
        if (previous) {
            const old = this.io.sockets.sockets.get(previous.id) as GameSocket | undefined;
            if (old) {
                old.data.membership = null;
                old.emit("serverError", { message: ERRORS.replaced });
            }
        }
        socket.data.membership = { code: room.code, seat };
        return { ok: true, code: room.code, seat };
    }

    private rematch(socket: GameSocket): Ack {
        const { room, seat } = this.current(socket);
        if (!room || seat === -1 || !room.rematch(seat)) return { ok: false, error: ERRORS.notAllowed };
        return { ok: true };
    }

    // -------------------------------------------------------------------------
    // Game traffic (no acks: like UDP, it is fire-and-forget)
    // -------------------------------------------------------------------------

    private input(socket: GameSocket, { c, l }: ClientPayload<"input">): void {
        const { room, seat } = this.current(socket);
        if (!room || seat === -1) return void this.violation(socket, ERRORS.notAllowed);
        const commands = c.map(([seq, tick, dir]) => ({ seq, tick, dir }));
        const result = room.receiveInput(seat, commands, l);
        if (result.rejected > 0) this.violation(socket, ERRORS.invalid, false);
    }

    private sync(socket: GameSocket, { t }: ClientPayload<"sync">): void {
        const { room } = this.current(socket);
        socket.emit("syncReply", { t, st: this.now(), tk: room ? room.tickAt() : -1 });
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    private seat(socket: GameSocket, room: Room, seat: Seat): string {
        const token = room.seatHuman(seat, socket.data.member, this.now());
        socket.data.membership = { code: room.code, seat };
        return token;
    }

    /** A socket holds at most one seat (or spectator place); taking a new one releases the old. */
    private release(socket: GameSocket): void {
        this.manager.queue.remove(socket.id);
        const membership = socket.data.membership;
        socket.data.membership = null;
        if (membership) this.manager.get(membership.code)?.left(socket.id, socket.data.member);
    }

    private current(socket: GameSocket): { room: Room | null; seat: Seat | -1 } {
        const m = socket.data.membership;
        const room = m ? this.manager.get(m.code) : undefined;
        if (!m || !room || room.status === "closed") return { room: null, seat: -1 };
        return { room, seat: m.seat };
    }

    private findRoom(raw: string): Room | null {
        const code = normalizeRoomCode(raw);
        const room = code ? this.manager.get(code) : undefined;
        return room && room.status !== "closed" ? room : null;
    }

    private now(): number {
        return this.manager.clock.now();
    }

    /** Errors never crash the process and never reach the client verbatim. */
    private safe(event: string, fn: () => void, reply?: Reply): void {
        try {
            fn();
        } catch (err) {
            this.log("error", `handler "${event}" failed: ${(err as Error)?.stack || err}`);
            reply?.({ ok: false, error: ERRORS.generic });
        }
    }
}
