import type { Socket } from "socket.io-client";
import {
    ackSchema,
    parseSnapshot,
    roomInfoSchema,
    seatedSchema,
    serverErrorSchema,
    syncReplySchema,
    type Ack,
    type ClientEvent,
    type ClientPayload,
    type RoomInfo,
    type Seated,
    type Snapshot,
    type SyncReply,
} from "../../../shared/protocol.ts";
import { NetworkSimulator } from "./NetworkSimulator.ts";
import { TrafficMeter } from "./TrafficMeter.ts";

export interface ConnectionEvents {
    connect: () => void;
    disconnect: (reason: string) => void;
    snapshot: (snapshot: Snapshot, receivedAt: number) => void;
    syncReply: (reply: SyncReply, receivedAt: number) => void;
    room: (info: RoomInfo) => void;
    seated: (seated: Seated) => void;
    serverError: (message: string) => void;
}

type GameEvent = "input" | "sync";

/**
 * The client's only door to the server. Game traffic goes through the
 * network simulator; session requests are sent directly and acknowledged.
 * Everything received is validated before anyone sees it, and every byte is
 * counted for the lab's stats.
 */
export class Connection {
    readonly socket: Socket;
    readonly netsim: NetworkSimulator;
    readonly traffic = new TrafficMeter();
    private readonly now: () => number;
    private readonly handlers: { [K in keyof ConnectionEvents]?: ConnectionEvents[K][] } = {};

    constructor(socket: Socket, netsim: NetworkSimulator, now: () => number) {
        this.socket = socket;
        this.netsim = netsim;
        this.now = now;

        socket.on("connect", () => this.emit("connect"));
        socket.on("disconnect", (reason: string) => this.emit("disconnect", reason));
        // Game traffic in: through the simulated network, then validated.
        socket.on("snapshot", (payload: unknown) =>
            this.receive("snapshot", payload, () => {
                const snapshot = parseSnapshot(payload);
                if (snapshot) this.emit("snapshot", snapshot, this.now());
            })
        );
        socket.on("syncReply", (payload: unknown) =>
            this.receive("syncReply", payload, () => {
                const reply = syncReplySchema.safeParse(payload);
                if (reply.success) this.emit("syncReply", reply.data, this.now());
            })
        );
        // Session traffic in: reliable.
        socket.on("room", (payload: unknown) => {
            this.traffic.countDown("room", payload, this.now());
            const info = roomInfoSchema.safeParse(payload);
            if (info.success) this.emit("room", info.data);
        });
        socket.on("seated", (payload: unknown) => {
            this.traffic.countDown("seated", payload, this.now());
            const seated = seatedSchema.safeParse(payload);
            if (seated.success) this.emit("seated", seated.data);
        });
        socket.on("serverError", (payload: unknown) => {
            const error = serverErrorSchema.safeParse(payload);
            if (error.success) this.emit("serverError", error.data.message);
        });
    }

    on<K extends keyof ConnectionEvents>(event: K, handler: ConnectionEvents[K]): () => void {
        const list = (this.handlers[event] ??= []) as ConnectionEvents[K][];
        list.push(handler);
        return () => {
            const i = list.indexOf(handler);
            if (i >= 0) list.splice(i, 1);
        };
    }

    /** Game traffic out: fire-and-forget through the simulated network. */
    send<E extends GameEvent>(event: E, payload: ClientPayload<E>): void {
        const now = this.now();
        this.traffic.countUp(event, payload, now);
        this.netsim.transmit("up", now, () => {
            if (this.socket.connected) this.socket.emit(event, payload);
        });
    }

    /** Session request: reliable, acknowledged, with a timeout. */
    request<E extends ClientEvent>(event: E, payload: ClientPayload<E>, timeoutMs = 5000): Promise<Ack> {
        this.traffic.countUp(event, payload, this.now());
        return new Promise((resolve) => {
            this.socket.timeout(timeoutMs).emit(event, payload, (err: Error | null, res: unknown) => {
                if (err) return resolve({ ok: false, error: "The server didn't answer. Check your connection." });
                const ack = ackSchema.safeParse(res);
                resolve(ack.success ? ack.data : { ok: false, error: "Unexpected reply from the server." });
            });
        });
    }

    /** Releases simulated-network messages that are due. Call often. */
    pump(now = this.now()): void {
        this.netsim.pump(now);
    }

    get connected(): boolean {
        return this.socket.connected;
    }

    private receive(event: string, payload: unknown, deliver: () => void): void {
        this.netsim.transmit("down", this.now(), () => {
            this.traffic.countDown(event, payload, this.now());
            deliver();
        });
    }

    private emit<K extends keyof ConnectionEvents>(event: K, ...args: Parameters<ConnectionEvents[K]>): void {
        for (const handler of this.handlers[event] ?? []) (handler as (...a: Parameters<ConnectionEvents[K]>) => void)(...args);
    }
}
