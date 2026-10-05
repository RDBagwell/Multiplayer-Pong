/**
 * The wire protocol: every message either side can send, its zod schema, and
 * the compact encoding of snapshots.
 *
 * Both directions are validated: the server treats every client message as
 * hostile, and the client validates what it receives too (defence in depth,
 * and it catches protocol drift between versions).
 *
 * Game traffic (`input`, `snapshot`, `sync`, `syncReply`) is the traffic that
 * real games send over UDP. It is designed to survive loss, duplication and
 * reordering, which the client's network simulator introduces on purpose.
 * Session traffic (rooms, matchmaking) is reliable and acknowledged.
 */
import { z } from "zod";
import { INPUT_LEVELS, TICK_RATE } from "./constants.ts";
import { PHASES, type GameState, type Phase, type Seat } from "./state.ts";

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/** No 0/O, 1/I/L: codes are read aloud and typed on phones. */
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const ROOM_CODE_LENGTH = 6;
const ROOM_CODE_PATTERN = new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);

/** Accepts "abc-def", " ABCDEF " etc. Returns null for anything that can't be a code. */
export function normalizeRoomCode(raw: unknown): string | null {
    if (typeof raw !== "string" || raw.length > 16) return null;
    const code = raw.replace(/[\s-]/g, "").toUpperCase();
    return ROOM_CODE_PATTERN.test(code) ? code : null;
}

export const DIFFICULTIES = ["easy", "medium", "hard"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

const int = z.number().int();
const finite = z.number().finite();
const seq = int.min(0).max(2 ** 31);
const tick = int.min(0).max(2 ** 31);
const roomCode = z.string().max(16);
const token = z.string().min(32).max(128).regex(/^[A-Za-z0-9_-]+$/);

/** Most input commands one packet may carry (the client resends unacknowledged ones). */
export const MAX_COMMANDS_PER_PACKET = 16;
/** Most ticks of view lag a client may claim (one second); the server caps it further. */
export const MAX_VIEW_LAG_TICKS = TICK_RATE;

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

/** One input change: from tick `tick` on, hold direction `dir`. `[seq, tick, dir]` on the wire. */
export const inputCommandSchema = z.tuple([seq, tick, int.min(-INPUT_LEVELS).max(INPUT_LEVELS)]);
export type InputCommandWire = z.infer<typeof inputCommandSchema>;
export interface InputCommand {
    seq: number;
    tick: number;
    dir: number;
}

const empty = z.strictObject({});

/** Every event a client may send, and exactly the fields it may carry. */
export const clientEventSchemas = {
    // Session (reliable, acknowledged)
    createRoom: empty,
    joinRoom: z.strictObject({ code: roomCode }),
    watchRoom: z.strictObject({ code: roomCode }),
    quickMatch: empty,
    cancelQueue: empty,
    playBot: z.strictObject({ difficulty: z.enum(DIFFICULTIES) }),
    resume: z.strictObject({ code: roomCode, token }),
    leaveRoom: empty,
    rematch: empty,
    // Game traffic (unreliable by design)
    /** `c`: the unacknowledged input commands, oldest first. `l`: how many ticks behind its own prediction the client renders the ball. */
    input: z.strictObject({
        c: z.array(inputCommandSchema).min(1).max(MAX_COMMANDS_PER_PACKET),
        l: int.min(0).max(MAX_VIEW_LAG_TICKS),
    }),
    /** Clock sync request; `t` is the client's clock, echoed back. */
    sync: z.strictObject({ t: finite }),
} as const;

export type ClientEvent = keyof typeof clientEventSchemas;
export type ClientPayload<E extends ClientEvent> = z.infer<(typeof clientEventSchemas)[E]>;

export const SESSION_EVENTS = new Set<ClientEvent>([
    "createRoom",
    "joinRoom",
    "watchRoom",
    "quickMatch",
    "cancelQueue",
    "playBot",
    "resume",
    "leaveRoom",
    "rematch",
]);

/** Returns `{ ok: true, data }` or `{ ok: false }`. Never exposes zod internals. */
export function validateClientEvent(event: string, payload: unknown): { ok: true; event: ClientEvent; data: unknown } | { ok: false } {
    if (!Object.hasOwn(clientEventSchemas, event)) return { ok: false };
    const schema = clientEventSchemas[event as ClientEvent];
    const result = schema.safeParse(payload === undefined ? {} : payload);
    return result.success ? { ok: true, event: event as ClientEvent, data: result.data } : { ok: false };
}

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

/** Every acknowledged session request answers with this. */
export const ackSchema = z.union([
    z.strictObject({
        ok: z.literal(true),
        code: z.string().optional(),
        seat: z.union([z.literal(-1), z.literal(0), z.literal(1)]).optional(),
        token: z.string().optional(),
        queued: z.boolean().optional(),
    }),
    z.strictObject({ ok: z.literal(false), error: z.string() }),
]);
export type Ack = z.infer<typeof ackSchema>;

/** Reply to `sync`: the client's `t`, the server clock `st` (ms) and the room's tick at `st` (fractional, -1 outside a match). */
export const syncReplySchema = z.strictObject({ t: finite, st: finite, tk: finite });
export type SyncReply = z.infer<typeof syncReplySchema>;

/** Sent when a quick match is found (the request was acknowledged earlier with `queued`). */
export const seatedSchema = z.strictObject({
    code: z.string(),
    seat: z.union([z.literal(0), z.literal(1)]),
    token: z.string(),
});
export type Seated = z.infer<typeof seatedSchema>;

const seatInfoSchema = z.strictObject({
    kind: z.enum(["empty", "human", "bot"]),
    connected: z.boolean(),
    rematch: z.boolean(),
    label: z.string(),
});

export const ROOM_STATUSES = ["waiting", "playing", "paused", "over", "closed"] as const;
export type RoomStatus = (typeof ROOM_STATUSES)[number];

/** Room metadata. Sent reliably whenever it changes, personalised with `you`. */
export const roomInfoSchema = z.strictObject({
    code: z.string(),
    mode: z.enum(["private", "quick", "bot"]),
    status: z.enum(ROOM_STATUSES),
    /** Your seat, or -1 for a spectator. */
    you: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
    seats: z.tuple([seatInfoSchema, seatInfoSchema]),
    spectators: int.min(0),
    /** While paused: who is missing, and in how many ms the match is forfeited. */
    pause: z.strictObject({ seat: z.union([z.literal(0), z.literal(1)]), forfeitInMs: finite }).nullable(),
    /** Set when the match ended by forfeit: the seat that forfeited. */
    forfeited: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
    /** Why the room closed, when status is "closed". */
    reason: z.string().optional(),
    settings: z.strictObject({
        tickRate: int,
        snapshotRate: int,
        lagCompensation: z.boolean(),
        lagCompensationMaxMs: int,
    }),
});
export type RoomInfo = z.infer<typeof roomInfoSchema>;

export const serverErrorSchema = z.strictObject({ message: z.string() });

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

/**
 * Compact snapshot encoding: short keys and arrays instead of nested
 * objects, and values already rounded by the simulation (see QUANTUM).
 */
export const snapshotWireSchema = z.strictObject({
    /** Server tick this snapshot describes (the state after that tick's step). */
    t: tick,
    /** Phase index into PHASES, and ticks left in it. */
    ph: int.min(0).max(PHASES.length - 1),
    pt: int.min(0),
    /** 1 while paused. */
    pa: z.union([z.literal(0), z.literal(1)]),
    /** Ball: x, y, vx, vy. */
    b: z.tuple([finite, finite, finite, finite]),
    /** Paddles: [y, dir] for seat 0 and 1. */
    p: z.tuple([z.tuple([finite, int]), z.tuple([finite, int])]),
    s: z.tuple([int.min(0), int.min(0)]),
    /** Serving seat, ball-reset counter, hits this rally, winner (-1 = none). */
    sv: z.union([z.literal(0), z.literal(1)]),
    r: int.min(0),
    h: int.min(0),
    w: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
    /** Last input sequence number the server has applied, per seat (-1 = none yet). */
    a: z.tuple([int.min(-1), int.min(-1)]),
});
export type SnapshotWire = z.infer<typeof snapshotWireSchema>;

/** A decoded snapshot: the authoritative state at `tick`, minus the RNG, plus input acks. */
export interface Snapshot {
    tick: number;
    phase: Phase;
    phaseTicks: number;
    paused: boolean;
    ball: { x: number; y: number; vx: number; vy: number };
    paddles: [{ y: number; dir: number }, { y: number; dir: number }];
    score: [number, number];
    server: Seat;
    rally: number;
    hits: number;
    winner: -1 | Seat;
    acks: [number, number];
}

export function encodeSnapshot(state: GameState, acks: readonly [number, number]): SnapshotWire {
    return {
        t: state.tick,
        ph: PHASES.indexOf(state.phase),
        pt: state.phaseTicks,
        pa: state.paused ? 1 : 0,
        b: [state.ball.x, state.ball.y, state.ball.vx, state.ball.vy],
        p: [
            [state.paddles[0].y, state.paddles[0].dir],
            [state.paddles[1].y, state.paddles[1].dir],
        ],
        s: [state.score[0], state.score[1]],
        sv: state.server,
        r: state.rally,
        h: state.hits,
        w: state.winner,
        a: [acks[0], acks[1]],
    };
}

export function decodeSnapshot(w: SnapshotWire): Snapshot {
    return {
        tick: w.t,
        phase: PHASES[w.ph],
        phaseTicks: w.pt,
        paused: w.pa === 1,
        ball: { x: w.b[0], y: w.b[1], vx: w.b[2], vy: w.b[3] },
        paddles: [
            { y: w.p[0][0], dir: w.p[0][1] },
            { y: w.p[1][0], dir: w.p[1][1] },
        ],
        score: [w.s[0], w.s[1]],
        server: w.sv,
        rally: w.r,
        hits: w.h,
        winner: w.w,
        acks: [w.a[0], w.a[1]],
    };
}

/** Parses an incoming snapshot; null if it's malformed. */
export function parseSnapshot(payload: unknown): Snapshot | null {
    const result = snapshotWireSchema.safeParse(payload);
    return result.success ? decodeSnapshot(result.data) : null;
}
