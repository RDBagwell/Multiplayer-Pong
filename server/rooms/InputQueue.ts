import type { InputCommand } from "../../shared/protocol.ts";

export interface InputLimits {
    maxLeadTicks: number;
    maxPending: number;
    maxPerTick: number;
}

export interface ReceiveResult {
    accepted: number;
    /** Already seen (duplicates, resends, reordered packets). Normal on a lossy network. */
    stale: number;
    /** Impossible: going back in time, too far in the future, or flooding. Counts as abuse. */
    rejected: number;
}

/**
 * One player's inputs on the server.
 *
 * Clients send input *changes* ("from tick T, hold direction D"), each with a
 * sequence number, and resend the ones the server hasn't acknowledged yet.
 * This queue accepts each sequence number once, keeps them in order, and
 * applies each at its tick. Inputs that arrive after their tick are applied
 * at the next tick the server runs (the client then reconciles).
 */
export class InputQueue {
    private readonly limits: InputLimits;
    private pending: InputCommand[] = [];
    private lastReceivedSeq = -1;
    private lastReceivedTick = -1;
    /** The direction currently held. */
    dir = 0;
    /** Highest sequence number applied so far (sent back in snapshots as the ack). */
    lastProcessedSeq = -1;
    /** Inputs that arrived after their tick had already been simulated. */
    lateCount = 0;

    constructor(limits: InputLimits) {
        this.limits = limits;
    }

    receive(commands: readonly InputCommand[], currentTick: number): ReceiveResult {
        const result: ReceiveResult = { accepted: 0, stale: 0, rejected: 0 };
        for (const cmd of commands) {
            if (cmd.seq <= this.lastReceivedSeq) {
                result.stale++;
                continue;
            }
            const impossible =
                cmd.tick < this.lastReceivedTick || // a later input can't be for an earlier tick
                cmd.tick > currentTick + this.limits.maxLeadTicks ||
                this.pending.length >= this.limits.maxPending ||
                this.pending.filter((p) => p.tick === cmd.tick).length >= this.limits.maxPerTick;
            if (impossible) {
                result.rejected++;
                continue;
            }
            if (cmd.tick <= currentTick) this.lateCount++;
            this.lastReceivedSeq = cmd.seq;
            this.lastReceivedTick = cmd.tick;
            this.pending.push(cmd);
            result.accepted++;
        }
        return result;
    }

    /** Applies every input due at or before `tick` and returns the direction to hold for it. */
    takeFor(tick: number): number {
        while (this.pending.length && this.pending[0].tick <= tick) {
            const cmd = this.pending.shift()!;
            this.dir = cmd.dir;
            this.lastProcessedSeq = cmd.seq;
        }
        return this.dir;
    }

    get pendingCount(): number {
        return this.pending.length;
    }
}
