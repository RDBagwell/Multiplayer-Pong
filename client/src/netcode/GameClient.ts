import { TICK_MS } from "../../../shared/constants.ts";
import { MAX_COMMANDS_PER_PACKET, MAX_VIEW_LAG_TICKS, type RoomInfo, type Snapshot } from "../../../shared/protocol.ts";
import type { Phase, Seat } from "../../../shared/state.ts";
import type { Connection } from "../net/Connection.ts";
import { ClockSync } from "./ClockSync.ts";
import { Interpolator, type InterpolationMode } from "./Interpolation.ts";
import { Predictor } from "./Prediction.ts";
import { reconcile } from "./Reconciliation.ts";

/** The lab's switches. All on is how the game is meant to be played. */
export interface NetcodeToggles {
    prediction: boolean;
    reconciliation: boolean;
    interpolation: boolean;
}

export const ALL_ON: NetcodeToggles = { prediction: true, reconciliation: true, interpolation: true };

/** Turns the player's controls into a direction, given where the client believes its paddle is. */
export type InputSource = (paddleY: number) => number;

/** Everything the renderer needs for one frame. */
export interface ClientView {
    ball: { x: number; y: number };
    paddleY: [number, number];
    score: [number, number];
    phase: Phase;
    phaseTicks: number;
    paused: boolean;
    winner: -1 | Seat;
    server: Seat;
    you: Seat | -1;
    /** The newest raw snapshot ("the truth" as last reported by the server). */
    truth: Snapshot;
    renderTick: number;
    mode: InterpolationMode;
}

export interface NetStats {
    rttMs: number;
    rttVariationMs: number;
    snapshotJitterMs: number;
    snapshotsPerSecond: number;
    snapshotsReceived: number;
    snapshotsLost: number;
    bytesUpPerSecond: number;
    bytesDownPerSecond: number;
    correctionsPerSecond: number;
    corrections: number;
    lastCorrection: number;
    interpolationDelayMs: number;
    predictionLeadMs: number;
    unackedInputs: number;
    mode: InterpolationMode | "none";
}

/** Prediction errors below this are blended out; above it the paddle jumps (field units). */
const SMOOTH_LIMIT = 60;
/** Time constant of the blend (ms). */
const SMOOTH_TAU = 50;
/** Resend unacknowledged inputs this often, in case the last packet was lost (ms). */
const RESEND_MS = 100;

/**
 * The client side of the netcode: owns one connection to one room and
 * combines clock sync, prediction, reconciliation and interpolation. It has
 * no DOM and no timers: the browser calls `update()` every few milliseconds
 * and `view()` once per frame; the test harness does the same on a virtual
 * clock.
 */
export class GameClient {
    readonly connection: Connection;
    readonly clock = new ClockSync();
    readonly interpolator = new Interpolator();
    predictor = new Predictor();
    toggles: NetcodeToggles;
    input: InputSource = () => 0;
    room: RoomInfo | null = null;
    /** The newest snapshot received (by tick). */
    latest: Snapshot | null = null;

    private lastSyncAt = -Infinity;
    private lastInputAt = -Infinity;
    private renderOffset = 0;
    private lastViewAt: number | null = null;
    private lastMode: InterpolationMode | "none" = "none";
    private arrivals: number[] = [];
    private correctionTimes: number[] = [];
    private counters = { received: 0, lost: 0, corrections: 0, lastCorrection: 0 };
    /** Called for every reconciled snapshot (the harness uses it to check invariants). */
    onReconcile: ((snapshot: Snapshot, error: number) => void) | null = null;

    constructor(connection: Connection, toggles: NetcodeToggles = ALL_ON) {
        this.connection = connection;
        this.toggles = { ...toggles };
        connection.on("syncReply", (r, at) => this.clock.addSample(r.t, at, r.tk));
        connection.on("snapshot", (s, at) => this.onSnapshot(s, at));
        connection.on("room", (info) => this.onRoom(info));
    }

    get seat(): Seat | -1 {
        return this.room?.you ?? -1;
    }

    // -------------------------------------------------------------------------
    // Inbound
    // -------------------------------------------------------------------------

    private onRoom(info: RoomInfo): void {
        if (this.room?.code !== info.code || this.room.you !== info.you) this.resetMatchState();
        this.room = info;
        this.interpolator.options = { ...this.interpolator.options, snapshotIntervalMs: 1000 / info.settings.snapshotRate };
    }

    /** Forget the current room (after leaving it). */
    detach(): void {
        this.room = null;
        this.resetMatchState();
    }

    private resetMatchState(): void {
        this.clock.reset();
        this.interpolator.reset();
        this.predictor = new Predictor();
        this.latest = null;
        this.renderOffset = 0;
        this.arrivals = [];
    }

    private onSnapshot(s: Snapshot, receivedAt: number): void {
        if (!this.interpolator.onSnapshot(s, receivedAt)) return;
        this.counters.received++;
        this.arrivals.push(receivedAt);
        const every = this.room ? Math.round(1000 / this.room.settings.snapshotRate / TICK_MS) : 3;
        if (this.latest && s.tick <= this.latest.tick) {
            // Arrived out of order: it wasn't lost after all, but it's too old to reconcile with.
            this.counters.lost = Math.max(0, this.counters.lost - 1);
            return;
        }
        if (this.latest) this.counters.lost += Math.max(0, Math.round((s.tick - this.latest.tick) / every) - 1);
        this.latest = s;

        const seat = this.seat;
        if (seat === -1 || !this.predictor.started) return;
        if (s.tick > this.predictor.tick) {
            // We fell behind the server (a stall, or a clock correction): start again from its state.
            this.predictor.acknowledge(s.acks[seat]);
            this.predictor.start(s.tick, s.paddles[seat]);
            return;
        }
        const before = this.predictor.paddle.y;
        const result = reconcile(this.predictor, s.tick, s.paddles[seat], s.acks[seat], {
            enabled: this.toggles.reconciliation,
            frozen: s.paused,
        });
        if (result.error > 1e-6) {
            this.counters.corrections++;
            this.counters.lastCorrection = result.error;
            this.correctionTimes.push(receivedAt);
            const smooth = this.toggles.reconciliation && result.error < SMOOTH_LIMIT;
            this.renderOffset = smooth ? this.renderOffset + (before - this.predictor.paddle.y) : 0;
        }
        this.onReconcile?.(s, result.error);
    }

    // -------------------------------------------------------------------------
    // Outbound: the fixed-step prediction loop
    // -------------------------------------------------------------------------

    /** How far ahead of the server the client predicts, in ticks: half a round trip plus margin for variation. */
    leadTicks(): number {
        return (this.clock.rtt / 2 + 2 * this.clock.rttvar) / TICK_MS + 1;
    }

    /** Call every few milliseconds. */
    update(now: number): void {
        this.connection.pump(now);

        // Sync quickly at the start of a match, then once a second.
        const inMatch = this.room !== null && this.room.status !== "waiting" && this.room.status !== "closed";
        const syncEvery = inMatch && this.clock.sampleCount < 5 ? 100 : 1000;
        if (now - this.lastSyncAt >= syncEvery && this.connection.connected) {
            this.lastSyncAt = now;
            this.connection.send("sync", { t: now });
        }

        const seat = this.seat;
        const latest = this.latest;
        if (seat === -1 || !latest || !this.clock.ready || !this.room) return;

        const serverTick = this.clock.serverTick(now);
        const targetTick = Math.floor(serverTick + this.leadTicks());
        if (!this.predictor.started || Math.abs(this.predictor.tick - targetTick) > 60) {
            this.predictor.start(latest.tick, latest.paddles[seat]);
        }
        const frozen = this.room.status === "paused" || latest.paused;
        let sent = false;
        for (let steps = 0; this.predictor.tick < targetTick && steps < 60; steps++) {
            if (this.predictor.advance(this.input(this.predictor.paddle.y), frozen)) sent = true;
        }

        const unacked = this.predictor.unacked;
        if (unacked.length && (sent || now - this.lastInputAt >= RESEND_MS)) {
            this.lastInputAt = now;
            const viewLag = Math.round(this.predictor.tick - (serverTick - this.interpolator.delayMs / TICK_MS));
            this.connection.send("input", {
                c: unacked.slice(-MAX_COMMANDS_PER_PACKET).map((c) => [c.seq, c.tick, c.dir] as [number, number, number]),
                l: Math.max(0, Math.min(MAX_VIEW_LAG_TICKS, viewLag)),
            });
        }
    }

    // -------------------------------------------------------------------------
    // Rendering
    // -------------------------------------------------------------------------

    /** What to draw at local time `now`. Null until the first snapshot. */
    view(now: number): ClientView | null {
        const latest = this.latest;
        if (!latest) return null;
        const serverTick = this.clock.ready ? this.clock.serverTick(now) : latest.tick;
        const entities = this.interpolator.sample(serverTick, now, this.toggles.interpolation)!;
        const paddleY: [number, number] = [entities.paddleY[0], entities.paddleY[1]];

        const dt = this.lastViewAt === null ? 0 : Math.max(0, now - this.lastViewAt);
        this.lastViewAt = now;
        this.renderOffset *= Math.exp(-dt / SMOOTH_TAU);
        if (Math.abs(this.renderOffset) < 0.01) this.renderOffset = 0;

        const seat = this.seat;
        if (seat !== -1 && this.toggles.prediction && this.predictor.started) {
            // Predicted ticks are 1/60 s apart; blend the last two so the paddle glides on 120/144 Hz screens.
            const current = this.predictor.paddle;
            const previous = this.predictor.history.get(this.predictor.tick - 1) ?? current;
            const target = this.clock.ready ? serverTick + this.leadTicks() : this.predictor.tick;
            const t = Math.max(0, Math.min(1, target - this.predictor.tick));
            paddleY[seat] = previous.y + (current.y - previous.y) * t + this.renderOffset;
        }

        const base = entities.base;
        this.lastMode = entities.mode;
        return {
            ball: entities.ball,
            paddleY,
            score: base.score,
            phase: base.phase,
            phaseTicks: base.phaseTicks,
            paused: base.paused,
            winner: base.winner,
            server: base.server,
            you: seat,
            truth: latest,
            renderTick: entities.renderTick,
            mode: entities.mode,
        };
    }

    stats(now: number): NetStats {
        while (this.arrivals.length && this.arrivals[0] < now - 1000) this.arrivals.shift();
        while (this.correctionTimes.length && this.correctionTimes[0] < now - 1000) this.correctionTimes.shift();
        const serverTick = this.clock.ready ? this.clock.serverTick(now) : null;
        return {
            rttMs: this.clock.rtt,
            rttVariationMs: this.clock.rttvar,
            snapshotJitterMs: this.interpolator.jitterMs,
            snapshotsPerSecond: this.arrivals.length,
            snapshotsReceived: this.counters.received,
            snapshotsLost: this.counters.lost,
            bytesUpPerSecond: this.connection.traffic.upPerSecond(now),
            bytesDownPerSecond: this.connection.traffic.downPerSecond(now),
            correctionsPerSecond: this.correctionTimes.length,
            corrections: this.counters.corrections,
            lastCorrection: this.counters.lastCorrection,
            interpolationDelayMs: this.toggles.interpolation ? this.interpolator.delayMs : 0,
            predictionLeadMs: serverTick !== null && this.predictor.started ? (this.predictor.tick - serverTick) * TICK_MS : 0,
            unackedInputs: this.predictor.unacked.length,
            mode: this.lastMode,
        };
    }
}
