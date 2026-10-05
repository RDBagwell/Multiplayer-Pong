import type { Ack, Difficulty } from "../../../shared/protocol.ts";
import type { Connection } from "./Connection.ts";

/** Where a seat's session token is kept between reloads (sessionStorage in the browser). */
export interface TokenStore {
    load(): { code: string; token: string } | null;
    save(value: { code: string; token: string }): void;
    clear(): void;
}

export const memoryTokenStore = (): TokenStore => {
    let value: { code: string; token: string } | null = null;
    return { load: () => value, save: (v) => (value = v), clear: () => (value = null) };
};

/**
 * Room and matchmaking requests. Keeps the seat token of the current seat in
 * `store`, so that after a reload or a dropped connection `resumeIfSeated()`
 * can ask for the seat back.
 */
export class Session {
    readonly connection: Connection;
    readonly store: TokenStore;
    /** Called when an automatic resume fails (the seat expired or the room closed). */
    onResumeFailed: ((error: string) => void) | null = null;

    constructor(connection: Connection, store: TokenStore) {
        this.connection = connection;
        this.store = store;
        connection.on("seated", ({ code, token }) => store.save({ code, token }));
    }

    async resumeIfSeated(): Promise<Ack | null> {
        const saved = this.store.load();
        if (!saved) return null;
        const ack = await this.connection.request("resume", saved);
        if (!ack.ok) {
            this.store.clear();
            this.onResumeFailed?.(ack.error);
        }
        return ack;
    }

    private async seat(request: Promise<Ack>): Promise<Ack> {
        const ack = await request;
        if (ack.ok && ack.code && ack.token) this.store.save({ code: ack.code, token: ack.token });
        return ack;
    }

    createRoom(): Promise<Ack> {
        return this.seat(this.connection.request("createRoom", {}));
    }

    joinRoom(code: string): Promise<Ack> {
        return this.seat(this.connection.request("joinRoom", { code }));
    }

    watchRoom(code: string): Promise<Ack> {
        this.store.clear();
        return this.connection.request("watchRoom", { code });
    }

    quickMatch(): Promise<Ack> {
        this.store.clear();
        return this.connection.request("quickMatch", {});
    }

    cancelQueue(): Promise<Ack> {
        return this.connection.request("cancelQueue", {});
    }

    playBot(difficulty: Difficulty): Promise<Ack> {
        return this.seat(this.connection.request("playBot", { difficulty }));
    }

    rematch(): Promise<Ack> {
        return this.connection.request("rematch", {});
    }

    leave(): Promise<Ack> {
        this.store.clear();
        return this.connection.request("leaveRoom", {});
    }
}
