import { io as ioClient, type Socket } from "socket.io-client";
import { createServer, type ServerOptions } from "../server/app.ts";
import { loadConfig, type Config } from "../server/config.ts";
import { parseSnapshot, roomInfoSchema, type RoomInfo, type Snapshot } from "../shared/protocol.ts";

/** An ack with every optional field visible, for convenient assertions. */
export interface LooseAck {
    ok: boolean;
    error?: string;
    code?: string;
    seat?: -1 | 0 | 1;
    token?: string;
    queued?: boolean;
}

export const ORIGIN = "http://localhost:5173";

type ConfigOverrides = Partial<Omit<Config, "limits" | "input">> & { limits?: Partial<Config["limits"]>; input?: Partial<Config["input"]> };

export function testConfig(overrides: ConfigOverrides = {}): Config {
    const base = loadConfig({});
    return {
        ...base,
        ...overrides,
        limits: {
            ...base.limits,
            // Generous by default so tests aren't throttled; limit tests override.
            joinPerIp: { capacity: 1000, windowMs: 1000 },
            createPerIp: { capacity: 1000, windowMs: 1000 },
            connectPerIp: { capacity: 1000, windowMs: 1000 },
            sessionEvents: { capacity: 1000, windowMs: 1000 },
            maxConcurrentPerIp: 1000,
            ...overrides.limits,
        },
        input: { ...base.input, ...overrides.input },
    };
}

export interface TestServerOptions extends Omit<ServerOptions, "config"> {
    config?: ConfigOverrides;
}

export async function startServer(options: TestServerOptions = {}) {
    const server = createServer({ log: () => {}, ...options, config: testConfig(options.config) });
    const port = await server.listen(0);
    const url = `http://127.0.0.1:${port}`;
    const clients: TestClient[] = [];

    function connect({ origin = ORIGIN }: { origin?: string | null } = {}): TestClient {
        const socket = ioClient(url, {
            transports: ["websocket"],
            forceNew: true,
            reconnection: false,
            extraHeaders: origin ? { origin } : {},
        });
        const client = new TestClient(socket);
        clients.push(client);
        return client;
    }

    async function close(): Promise<void> {
        for (const c of clients) c.socket.disconnect();
        await server.close();
    }

    return { server, url, connect, close };
}

export type TestEnv = Awaited<ReturnType<typeof startServer>>;

/** Wraps a socket.io-client socket and records everything it receives. */
export class TestClient {
    readonly socket: Socket;
    readonly snapshots: Snapshot[] = [];
    readonly rooms: RoomInfo[] = [];
    readonly errors: string[] = [];
    readonly seated: { code: string; seat: 0 | 1; token: string }[] = [];
    /** Every event received, for leak checks. */
    readonly raw: { event: string; payload: unknown }[] = [];
    readonly connected: Promise<void>;
    disconnected = false;
    token = "";
    code = "";

    constructor(socket: Socket) {
        this.socket = socket;
        socket.onAny((event: string, payload: unknown) => this.raw.push({ event, payload }));
        socket.on("snapshot", (w: unknown) => {
            const s = parseSnapshot(w);
            if (!s) throw new Error("server sent a malformed snapshot");
            this.snapshots.push(s);
        });
        socket.on("room", (r: unknown) => this.rooms.push(roomInfoSchema.parse(r)));
        socket.on("serverError", (e: { message: string }) => this.errors.push(e.message));
        socket.on("seated", (s: { code: string; seat: 0 | 1; token: string }) => {
            this.seated.push(s);
            this.code = s.code;
            this.token = s.token;
        });
        socket.on("disconnect", () => (this.disconnected = true));
        this.connected = new Promise((resolve, reject) => {
            socket.once("connect", () => resolve());
            socket.once("connect_error", reject);
        });
    }

    get room(): RoomInfo | undefined {
        return this.rooms.at(-1);
    }

    get snapshot(): Snapshot | undefined {
        return this.snapshots.at(-1);
    }

    request(event: string, payload?: unknown): Promise<LooseAck> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`no ack for ${event}`)), 2000);
            this.socket.emit(event, payload ?? {}, (res: LooseAck) => {
                clearTimeout(timer);
                if (res.ok && res.token) this.token = res.token;
                if (res.ok && res.code) this.code = res.code;
                resolve(res);
            });
        });
    }

    waitForRoom(predicate: (r: RoomInfo) => boolean, timeout = 3000): Promise<RoomInfo> {
        return waitFor(() => (this.room && predicate(this.room) ? this.room : null), timeout, "room info");
    }

    waitForSnapshot(predicate: (s: Snapshot) => boolean, timeout = 3000): Promise<Snapshot> {
        return waitFor(() => (this.snapshot && predicate(this.snapshot) ? this.snapshot : null), timeout, "snapshot");
    }
}

export async function waitFor<T>(fn: () => T | null | undefined | false, timeout = 3000, what = "condition"): Promise<T> {
    const start = Date.now();
    for (;;) {
        const value = fn();
        if (value) return value;
        if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${what}`);
        await sleep(5);
    }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Two connected players in a private room, match started. */
export async function privateMatch(env: TestEnv) {
    const a = env.connect();
    const b = env.connect();
    await Promise.all([a.connected, b.connected]);
    const created = await a.request("createRoom");
    if (!created.ok) throw new Error(created.error);
    const joined = await b.request("joinRoom", { code: created.code });
    if (!joined.ok) throw new Error(joined.error);
    await Promise.all([a.waitForRoom((r) => r.status === "playing"), b.waitForRoom((r) => r.status === "playing")]);
    return { a, b, code: created.code! };
}
