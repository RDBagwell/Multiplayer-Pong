import { TICK_MS } from "../../../shared/constants.ts";

/**
 * Technique 1 — Clock synchronisation.
 *
 * Every other technique needs to know which server tick "now" is: the client
 * stamps its inputs with the tick they should apply at, and renders other
 * objects a fixed time behind the server. Clocks on two machines don't
 * agree, and the network delay between them varies, so the client measures.
 *
 * NTP-style: the client sends its time t0; the server replies with its tick
 * at the moment it answered; the reply arrives at t1. The round trip is
 * t1 − t0. Assuming the two directions take about as long, the server's tick
 * at t1 was its reported tick plus half the round trip. That gives one
 * estimate of the offset between the local clock and the server's ticks.
 *
 * Single samples are noisy (a delayed reply makes the server look further
 * ahead than it is), so it keeps a window of recent samples, trusts only the
 * fastest half of them (a fast round trip leaves little room for asymmetry),
 * and takes their median. The estimate it uses moves towards that target
 * gradually, so time never jumps, unless it is far off (a first sync, or the
 * server skipped time), in which case it snaps.
 *
 * Round-trip time and its variation are smoothed the way TCP does it
 * (RFC 6298): SRTT += (RTT − SRTT)/8, RTTVAR += (|RTT − SRTT| − RTTVAR)/4.
 */

export interface ClockSyncOptions {
    windowSize: number;
    /** Snap instead of slewing if the target is further off than this (ticks). */
    snapTicks: number;
    /** Fraction of the remaining error corrected per sample when slewing. */
    slewFraction: number;
}

const DEFAULTS: ClockSyncOptions = { windowSize: 16, snapTicks: 4, slewFraction: 0.2 };

interface Sample {
    rtt: number;
    offset: number;
    /** Arrival order: among equally fast samples, newer ones win. */
    n: number;
}

export class ClockSync {
    private readonly options: ClockSyncOptions;
    private samples: Sample[] = [];
    /** Server tick = localMs / TICK_MS + offsetTicks. */
    private offsetTicks: number | null = null;
    srtt: number | null = null;
    rttvar = 0;
    /** The most recent raw round trip. */
    lastRtt = 0;
    /** Tick samples in the current window (sync replies from inside a running match). */
    sampleCount = 0;

    constructor(options: Partial<ClockSyncOptions> = {}) {
        this.options = { ...DEFAULTS, ...options };
    }

    /** Feeds one reply: our send time `t0`, its arrival `t1`, and the server's tick when it answered (-1 if no match). */
    addSample(t0: number, t1: number, serverTick: number): void {
        const rtt = Math.max(0, t1 - t0);
        this.lastRtt = rtt;
        if (this.srtt === null) {
            this.srtt = rtt;
            this.rttvar = rtt / 2;
        } else {
            this.rttvar += (Math.abs(rtt - this.srtt) - this.rttvar) / 4;
            this.srtt += (rtt - this.srtt) / 8;
        }
        if (serverTick < 0) return;
        this.sampleCount++;

        const offset = serverTick + rtt / 2 / TICK_MS - t1 / TICK_MS;
        this.samples.push({ rtt, offset, n: this.sampleCount });
        if (this.samples.length > this.options.windowSize) this.samples.shift();

        const target = this.target();
        if (this.offsetTicks === null || Math.abs(target - this.offsetTicks) > this.options.snapTicks) {
            this.offsetTicks = target;
        } else {
            this.offsetTicks += (target - this.offsetTicks) * this.options.slewFraction;
        }
    }

    /** Median offset of the fastest half of the window. */
    private target(): number {
        const fastest = [...this.samples].sort((a, b) => a.rtt - b.rtt || b.n - a.n).slice(0, Math.max(1, Math.ceil(this.samples.length / 2)));
        const offsets = fastest.map((s) => s.offset).sort((a, b) => a - b);
        const mid = offsets.length >> 1;
        return offsets.length % 2 ? offsets[mid] : (offsets[mid - 1] + offsets[mid]) / 2;
    }

    /** Forget the tick offset (new room, or the server's tick jumped). Round-trip estimates are kept. */
    reset(): void {
        this.samples = [];
        this.offsetTicks = null;
        this.sampleCount = 0;
    }

    get ready(): boolean {
        return this.offsetTicks !== null;
    }

    /** The server's (fractional) tick at local time `now`. */
    serverTick(now: number): number {
        if (this.offsetTicks === null) throw new Error("clock not synchronised yet");
        return now / TICK_MS + this.offsetTicks;
    }

    /** Smoothed round-trip time in ms (0 before the first sample). */
    get rtt(): number {
        return this.srtt ?? 0;
    }
}
