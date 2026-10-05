/**
 * Tracks whether the game server can be reached, and decides when to offer
 * the offline mode instead.
 *
 * The server runs on a free tier that sleeps when idle; the first visitor
 * after a quiet spell waits while it boots. Rather than leave them staring at
 * "Connecting…", the landing screen offers a match against the computer that
 * runs entirely in the browser as soon as a connection is late.
 *
 * Pure state + timestamps (no timers, no DOM), so it can be unit-tested.
 */

export type ServerState =
    /** First connection attempt, still within the grace period. */
    | "connecting"
    /** No connection yet after the grace period: probably a cold start. */
    | "waking"
    | "online"
    /** Was online, lost the connection, trying again. */
    | "reconnecting";

export interface ServerStatusOptions {
    /** How long a first connection may take before it counts as "waking" (ms). */
    graceMs: number;
}

export const DEFAULT_SERVER_STATUS: ServerStatusOptions = { graceMs: 1500 };

export class ServerStatus {
    private readonly options: ServerStatusOptions;
    private readonly startedAt: number;
    private connected = false;
    private everConnected = false;
    /** Connection attempts that failed (connect_error). */
    failures = 0;

    constructor(now: number, options: Partial<ServerStatusOptions> = {}) {
        this.options = { ...DEFAULT_SERVER_STATUS, ...options };
        this.startedAt = now;
    }

    onConnect(): void {
        this.connected = true;
        this.everConnected = true;
    }

    onDisconnect(): void {
        this.connected = false;
    }

    onError(): void {
        this.connected = false;
        this.failures++;
    }

    state(now: number): ServerState {
        if (this.connected) return "online";
        if (this.everConnected) return "reconnecting";
        // A refused connection is a definite answer; don't wait out the grace period.
        if (this.failures > 0 || now - this.startedAt >= this.options.graceMs) return "waking";
        return "connecting";
    }

    /** Online play is possible right now. */
    isOnline(now: number): boolean {
        return this.state(now) === "online";
    }

    /** Offer "Play offline" prominently: the server isn't there (yet). */
    offerOffline(now: number): boolean {
        const s = this.state(now);
        return s === "waking" || s === "reconnecting";
    }

    /** A short human-readable status line. */
    label(now: number): string {
        switch (this.state(now)) {
            case "online":
                return "Server online";
            case "connecting":
                return "Connecting…";
            case "waking":
                return "Waking the server: free hosting sleeps when idle…";
            case "reconnecting":
                return "Connection lost. Reconnecting…";
        }
    }
}
