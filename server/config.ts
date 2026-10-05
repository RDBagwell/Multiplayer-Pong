import { TICK_RATE } from "../shared/constants.ts";
import type { BucketOptions } from "./security/rateLimit.ts";

/** The Vite dev server (5173) and the Node server itself (3000), on both spellings of localhost. */
const DEV_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173", "http://localhost:3000", "http://127.0.0.1:3000"];

function int(value: string | undefined, fallback: number): number {
    const n = Number.parseInt(value ?? "", 10);
    return Number.isFinite(n) ? n : fallback;
}

function list(value: string | undefined): string[] {
    return String(value || "")
        .split(",")
        .map((s) => s.trim().replace(/\/+$/, ""))
        .filter(Boolean);
}

export interface Config {
    port: number;
    isProduction: boolean;
    allowedOrigins: string[];
    /** Number of reverse proxies in front of the app, for reading the client IP from X-Forwarded-For. */
    trustProxyHops: number;
    /** A header set (and overwritten) by the edge in front of the app, e.g. "true-client-ip". */
    clientIpHeader: string | null;
    /** Serve the built client (client/dist) from this server. */
    serveClient: boolean;

    maxRooms: number;
    maxSpectatorsPerRoom: number;
    /** Socket.io frame limit. The largest legal message (a full input packet) is well under this. */
    maxHttpBufferSize: number;

    /** Snapshots per second (the simulation always runs at TICK_RATE). */
    snapshotRate: number;
    /** Run the server loop this often; each run steps as many ticks as wall-clock time allows. */
    loopIntervalMs: number;
    /** If the server falls further behind than this, it skips time instead of fast-forwarding. */
    maxCatchUpMs: number;

    /** How long a disconnected player's seat is held before the match is forfeited. */
    reconnectGraceMs: number;
    /** Pause between a player coming back and play resuming. */
    resumeDelayMs: number;
    /** A private room that never got a second player is closed after this. */
    waitingRoomMs: number;
    /** A room with no connected human (players or spectators) is closed after this. */
    emptyRoomMs: number;
    sweepIntervalMs: number;

    /** Bounded lag compensation for paddle hits (see server/rooms/LagCompensator.ts). */
    lagCompensation: boolean;
    lagCompensationMaxMs: number;

    input: {
        /** How far ahead of the server's tick an input may be stamped. */
        maxLeadTicks: number;
        /** Inputs waiting to be applied, per player. */
        maxPending: number;
        /** Distinct input changes per player for a single tick. */
        maxPerTick: number;
    };

    limits: {
        socketEvents: BucketOptions;
        sessionEvents: BucketOptions;
        joinPerIp: BucketOptions;
        createPerIp: BucketOptions;
        connectPerIp: BucketOptions;
        maxConcurrentPerIp: number;
        /** Invalid or excessive events tolerated before a socket is disconnected. */
        maxViolations: number;
    };
}

/** All tunables in one place. Tests override fields as needed. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    const isProduction = env.NODE_ENV === "production";
    const allowedOrigins = list(env.ALLOWED_ORIGINS);

    if (allowedOrigins.includes("*")) {
        throw new Error("ALLOWED_ORIGINS must list explicit origins; '*' is not allowed");
    }
    if (isProduction && allowedOrigins.length === 0) {
        throw new Error("ALLOWED_ORIGINS is required in production");
    }
    if (isProduction && allowedOrigins.some((o) => !o.startsWith("https://"))) {
        throw new Error("In production every ALLOWED_ORIGINS entry must be https://");
    }
    const snapshotRate = int(env.SNAPSHOT_RATE, 20);
    if (snapshotRate < 1 || snapshotRate > TICK_RATE || TICK_RATE % snapshotRate !== 0) {
        throw new Error(`SNAPSHOT_RATE must divide the tick rate (${TICK_RATE}): 1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30 or 60`);
    }

    return {
        port: int(env.PORT, 3000),
        isProduction,
        allowedOrigins: allowedOrigins.length ? allowedOrigins : DEV_ORIGINS,
        trustProxyHops: int(env.TRUST_PROXY_HOPS, 0),
        clientIpHeader: (env.CLIENT_IP_HEADER || "").toLowerCase().trim() || null,
        serveClient: env.SERVE_CLIENT !== "false",

        maxRooms: int(env.MAX_ROOMS, 200),
        maxSpectatorsPerRoom: 32,
        maxHttpBufferSize: 2 * 1024,

        snapshotRate,
        loopIntervalMs: 4,
        maxCatchUpMs: 250,

        reconnectGraceMs: 30_000,
        resumeDelayMs: 1_500,
        waitingRoomMs: 30 * 60_000,
        emptyRoomMs: 2 * 60_000,
        sweepIntervalMs: 10_000,

        lagCompensation: env.LAG_COMPENSATION === "true",
        lagCompensationMaxMs: int(env.LAG_COMPENSATION_MAX_MS, 150),

        input: {
            maxLeadTicks: 30,
            maxPending: 32,
            maxPerTick: 4,
        },

        limits: {
            // Inputs (up to one per tick plus resends) and clock syncs share this.
            socketEvents: { capacity: 200, windowMs: 2_000 },
            sessionEvents: { capacity: 20, windowMs: 10_000 },
            joinPerIp: { capacity: 20, windowMs: 60_000 },
            createPerIp: { capacity: 10, windowMs: 10 * 60_000 },
            connectPerIp: { capacity: 30, windowMs: 60_000 },
            maxConcurrentPerIp: int(env.MAX_CONNECTIONS_PER_IP, 20),
            maxViolations: 20,
        },
    };
}
