/**
 * A simulated bad network, applied to the client's game traffic in both
 * directions. It is what the network lab's sliders control.
 *
 * Every message is delayed by half the added round-trip latency plus a
 * random 0..jitter, and dropped with the given probability. Because each
 * message gets its own random delay, messages can overtake each other, just
 * as UDP datagrams do. (Socket.io itself runs over TCP, which never loses or
 * reorders, so without this layer the game would never see those problems.)
 *
 * Only game traffic (inputs, snapshots, clock sync) goes through here.
 * Session traffic (joining rooms, rematches) stays reliable, like the
 * reliable channel real games keep for the same purpose.
 *
 * There are no timers: `pump(now)` releases whatever is due. The browser
 * pumps every few milliseconds; the test harness pumps on a virtual clock.
 */

export interface NetworkConditions {
    /** Added round-trip latency in ms (half each way). */
    latencyMs: number;
    /** Extra random delay per message, 0..jitterMs, in each direction. */
    jitterMs: number;
    /** Probability (0..1) that a message is lost, in each direction. */
    loss: number;
}

export const PERFECT_NETWORK: NetworkConditions = { latencyMs: 0, jitterMs: 0, loss: 0 };

interface Queued {
    at: number;
    order: number;
    deliver: () => void;
}

export interface DirectionCounters {
    messages: number;
    dropped: number;
}

export class NetworkSimulator {
    conditions: NetworkConditions;
    private readonly random: () => number;
    private queue: Queued[] = [];
    private order = 0;
    readonly up: DirectionCounters = { messages: 0, dropped: 0 };
    readonly down: DirectionCounters = { messages: 0, dropped: 0 };

    constructor(conditions: NetworkConditions = PERFECT_NETWORK, random: () => number = Math.random) {
        this.conditions = { ...conditions };
        this.random = random;
    }

    /** True when the simulator changes nothing (messages go straight through). */
    get isPerfect(): boolean {
        const c = this.conditions;
        return c.latencyMs <= 0 && c.jitterMs <= 0 && c.loss <= 0;
    }

    /** Schedules a message; `deliver` runs when it arrives (never, if it's lost). */
    transmit(direction: "up" | "down", now: number, deliver: () => void): void {
        const counters = direction === "up" ? this.up : this.down;
        counters.messages++;
        const { latencyMs, jitterMs, loss } = this.conditions;
        if (loss > 0 && this.random() < loss) {
            counters.dropped++;
            return;
        }
        const delay = Math.max(0, latencyMs / 2) + Math.max(0, jitterMs) * this.random();
        if (delay <= 0 && this.queue.length === 0) return deliver();
        this.queue.push({ at: now + delay, order: this.order++, deliver });
    }

    /** Delivers every message that is due, in arrival order. */
    pump(now: number): void {
        if (!this.queue.length) return;
        const due: Queued[] = [];
        const later: Queued[] = [];
        for (const q of this.queue) (q.at <= now ? due : later).push(q);
        if (!due.length) return;
        this.queue = later;
        due.sort((a, b) => a.at - b.at || a.order - b.order);
        for (const q of due) q.deliver();
    }

    get inFlight(): number {
        return this.queue.length;
    }
}
