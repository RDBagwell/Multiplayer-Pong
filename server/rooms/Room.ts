import { TICK_MS, TICK_RATE } from "../../shared/constants.ts";
import { encodeSnapshot, type Difficulty, type InputCommand, type RoomInfo, type RoomStatus } from "../../shared/protocol.ts";
import { createInitialState, type GameState, type Seat, type TickInputs } from "../../shared/state.ts";
import { step } from "../../shared/step.ts";
import { BOT_LABELS, Bot } from "../../shared/bot.ts";
import type { Config } from "../config.ts";
import { generateToken, hashesEqual, hashToken, randomSeed } from "../security/random.ts";
import { InputQueue, type ReceiveResult } from "./InputQueue.ts";
import { LagCompensator } from "./LagCompensator.ts";

/** Something that can be in a room: a socket, in practice. */
export interface Member {
    readonly id: string;
    send(event: string, payload: unknown): void;
    join(channel: string): void;
    leave(channel: string): void;
}

export interface RoomDeps {
    config: Config;
    /** Sends one message to every member of a channel (encoded once). */
    broadcast(channel: string, event: string, payload: unknown): void;
    log?(level: string, message: string): void;
    /** Overridable for tests. */
    seed?: () => number;
    botRandom?: () => number;
}

export type RoomMode = RoomInfo["mode"];

interface SeatSlot {
    kind: "empty" | "human" | "bot";
    tokenHash: string | null;
    member: Member | null;
    input: InputQueue;
    bot: Bot | null;
    rematch: boolean;
    /** View lag the client reports, in ticks (see LagCompensator). */
    viewLag: number;
    disconnectedAt: number | null;
}

/**
 * One match. Runs its own fixed-step simulation, driven by `advance(now)`:
 * an accumulator turns elapsed wall-clock time into whole 60 Hz ticks, so the
 * simulation never drifts from real time however irregularly it's called.
 * Every Nth tick it broadcasts a snapshot to players and spectators.
 */
export class Room {
    readonly code: string;
    readonly mode: RoomMode;
    readonly createdAt: number;
    status: RoomStatus = "waiting";
    game: GameState | null = null;
    readonly seats: [SeatSlot, SeatSlot];
    readonly spectators = new Map<string, Member>();
    closeReason: string | undefined;

    private readonly deps: RoomDeps;
    private readonly config: Config;
    private readonly snapshotEvery: number;
    private readonly lagComp: LagCompensator;
    private accumulator = 0;
    private lastAdvance: number | null = null;
    private pause: { seat: Seat; forfeitAt: number; resumeAt: number | null } | null = null;
    private forfeited: -1 | Seat = -1;
    private lastHumanAt: number;
    /** Ticks skipped because the server fell too far behind (should stay 0). */
    skippedTicks = 0;

    constructor(code: string, mode: RoomMode, now: number, deps: RoomDeps) {
        this.code = code;
        this.mode = mode;
        this.createdAt = now;
        this.lastHumanAt = now;
        this.deps = deps;
        this.config = deps.config;
        this.snapshotEvery = Math.max(1, Math.round(TICK_RATE / this.config.snapshotRate));
        this.lagComp = new LagCompensator(this.config.lagCompensation ? Math.round(this.config.lagCompensationMaxMs / TICK_MS) : 0);
        const slot = (): SeatSlot => ({
            kind: "empty",
            tokenHash: null,
            member: null,
            input: new InputQueue(this.config.input),
            bot: null,
            rematch: false,
            viewLag: 0,
            disconnectedAt: null,
        });
        this.seats = [slot(), slot()];
    }

    get channel(): string {
        return `room:${this.code}`;
    }

    // -------------------------------------------------------------------------
    // Membership
    // -------------------------------------------------------------------------

    openSeat(): Seat | -1 {
        if (this.status !== "waiting") return -1;
        return this.seats[0].kind === "empty" ? 0 : this.seats[1].kind === "empty" ? 1 : -1;
    }

    /** Seats a human and returns their session token (only its hash is kept). */
    seatHuman(seat: Seat, member: Member, now: number): string {
        const token = generateToken();
        const slot = this.seats[seat];
        slot.kind = "human";
        slot.tokenHash = hashToken(token);
        slot.member = member;
        slot.disconnectedAt = null;
        member.join(this.channel);
        this.lastHumanAt = now;
        this.maybeStart();
        this.sendInfo();
        return token;
    }

    seatBot(seat: Seat, difficulty: Difficulty): void {
        const slot = this.seats[seat];
        slot.kind = "bot";
        slot.bot = new Bot(seat, difficulty, this.deps.botRandom);
        this.maybeStart();
        this.sendInfo();
    }

    addSpectator(member: Member): boolean {
        if (this.status === "closed" || this.spectators.size >= this.config.maxSpectatorsPerRoom) return false;
        this.spectators.set(member.id, member);
        member.join(this.channel);
        this.sendInfo();
        if (this.game) member.send("snapshot", this.snapshot());
        return true;
    }

    /** The seat `token` belongs to, or -1. */
    seatForToken(token: string): Seat | -1 {
        const hash = hashToken(token);
        for (const seat of [0, 1] as const) {
            const h = this.seats[seat].tokenHash;
            if (h && hashesEqual(h, hash)) return seat;
        }
        return -1;
    }

    /**
     * Gives a seat back to a returning player. Returns the member that held it
     * before (another tab), which the caller should detach, or null.
     */
    reattach(seat: Seat, member: Member, now: number): Member | null {
        const slot = this.seats[seat];
        const previous = slot.member && slot.member.id !== member.id ? slot.member : null;
        previous?.leave(this.channel);
        slot.member = member;
        slot.disconnectedAt = null;
        member.join(this.channel);
        this.lastHumanAt = now;
        if (this.status === "paused" && this.pause) {
            const missing = this.missingSeat();
            if (missing === -1) this.pause.resumeAt = now + this.config.resumeDelayMs;
            else this.pause = { seat: missing, forfeitAt: this.seats[missing].disconnectedAt! + this.config.reconnectGraceMs, resumeAt: null };
        }
        this.sendInfo();
        if (this.game) member.send("snapshot", this.snapshot());
        return previous;
    }

    /** A member's connection dropped. Players keep their seat for the grace period. */
    disconnected(memberId: string, now: number): void {
        if (this.spectators.delete(memberId)) return this.sendInfo();
        const seat = this.seatOf(memberId);
        if (seat === -1) return;
        const slot = this.seats[seat];
        slot.member = null;
        slot.disconnectedAt = now;
        slot.rematch = false;
        if (this.status === "playing" || (this.status === "paused" && this.pause?.resumeAt)) {
            this.setPaused(true);
            this.status = "paused";
            this.pause = { seat, forfeitAt: now + this.config.reconnectGraceMs, resumeAt: null };
        }
        this.sendInfo(now);
    }

    /** A member chose to leave. A player who leaves a match forfeits it and can't come back. */
    left(memberId: string, member: Member): void {
        member.leave(this.channel);
        if (this.spectators.delete(memberId)) return this.sendInfo();
        const seat = this.seatOf(memberId);
        if (seat === -1) return;
        const slot = this.seats[seat];
        slot.member = null;
        slot.tokenHash = null;
        slot.rematch = false;
        slot.disconnectedAt = null;
        if (this.status === "waiting") return this.close("The host left.");
        if (this.status === "playing" || this.status === "paused") this.forfeit(seat);
        this.sendInfo();
    }

    seatOf(memberId: string): Seat | -1 {
        if (this.seats[0].member?.id === memberId) return 0;
        if (this.seats[1].member?.id === memberId) return 1;
        return -1;
    }

    // -------------------------------------------------------------------------
    // Inputs
    // -------------------------------------------------------------------------

    receiveInput(seat: Seat, commands: readonly InputCommand[], viewLag: number): ReceiveResult {
        const slot = this.seats[seat];
        if (slot.kind !== "human" || !this.game) return { accepted: 0, stale: 0, rejected: 0 };
        slot.viewLag = viewLag;
        return slot.input.receive(commands, this.game.tick);
    }

    rematch(seat: Seat): boolean {
        if (this.status !== "over" || !this.game) return false;
        const other = this.seats[seat === 0 ? 1 : 0];
        if (other.kind === "human" && !other.tokenHash) return false; // they left for good
        this.seats[seat].rematch = true;
        for (const slot of this.seats) if (slot.kind === "bot") slot.rematch = true;
        if (this.seats[0].rematch && this.seats[1].rematch) this.startMatch();
        else this.sendInfo();
        return true;
    }

    // -------------------------------------------------------------------------
    // Simulation
    // -------------------------------------------------------------------------

    /** Steps as many ticks as the time since the last call allows, and runs timers. */
    advance(now: number): void {
        const elapsed = this.lastAdvance === null ? 0 : now - this.lastAdvance;
        this.lastAdvance = now;
        if (this.hasConnectedHuman()) this.lastHumanAt = now;
        this.runTimers(now);
        if (!this.game || this.status === "waiting" || this.status === "closed") return;

        this.accumulator += Math.max(0, elapsed);
        if (this.accumulator > this.config.maxCatchUpMs) {
            // A long stall (debugger, overloaded host): skip time rather than fast-forward a burst of ticks.
            const skip = Math.floor((this.accumulator - TICK_MS) / TICK_MS);
            this.skippedTicks += skip;
            this.accumulator -= skip * TICK_MS;
        }
        while (this.accumulator >= TICK_MS) {
            this.accumulator -= TICK_MS;
            this.tick();
        }
    }

    /**
     * The room's tick at time `now`, including the fraction elapsed towards
     * the next one (for clock sync), or -1 when no match is running.
     */
    tickAt(now: number): number {
        if (!this.game || this.status === "waiting" || this.status === "closed") return -1;
        const sinceAdvance = this.lastAdvance === null ? 0 : Math.max(0, now - this.lastAdvance);
        return this.game.tick + (this.accumulator + sinceAdvance) / TICK_MS;
    }

    private tick(): void {
        const before = this.game!;
        const inputs: TickInputs = [this.inputFor(0, before), this.inputFor(1, before)];
        let next = step(before, inputs);
        next = this.lagComp.afterStep(before, inputs, next, [this.seats[0].viewLag, this.seats[1].viewLag]);
        this.game = next;

        if (next.tick % this.snapshotEvery === 0) this.deps.broadcast(this.channel, "snapshot", this.snapshot());
        if (next.phase === "over" && this.status === "playing" && !this.lagComp.hasPending) {
            this.status = "over";
            this.sendInfo();
        }
    }

    private inputFor(seat: Seat, state: GameState): number {
        const slot = this.seats[seat];
        if (slot.kind === "bot") return slot.bot!.decide(state);
        return slot.input.takeFor(state.tick + 1);
    }

    snapshot() {
        const acks: [number, number] = [this.seats[0].input.lastProcessedSeq, this.seats[1].input.lastProcessedSeq];
        return encodeSnapshot(this.game!, acks);
    }

    private maybeStart(): void {
        if (this.status === "waiting" && this.seats[0].kind !== "empty" && this.seats[1].kind !== "empty") this.startMatch();
    }

    private startMatch(): void {
        const tick = this.game?.tick ?? 0;
        // The tick keeps counting across rematches, so clients' clocks stay valid.
        this.game = { ...createInitialState((this.deps.seed ?? randomSeed)()), tick };
        for (const slot of this.seats) slot.rematch = false;
        this.forfeited = -1;
        this.pause = null;
        this.lagComp.reset();
        this.status = "playing";
        this.sendInfo();
        this.deps.broadcast(this.channel, "snapshot", this.snapshot());
    }

    private runTimers(now: number): void {
        if (this.status !== "paused" || !this.pause) return;
        if (this.pause.resumeAt !== null) {
            if (now >= this.pause.resumeAt) {
                this.pause = null;
                this.setPaused(false);
                this.status = this.game?.phase === "over" ? "over" : "playing";
                this.sendInfo();
            }
        } else if (now >= this.pause.forfeitAt) {
            this.forfeit(this.pause.seat);
            this.sendInfo();
        }
    }

    private forfeit(seat: Seat): void {
        if (!this.game) return;
        const winner: Seat = seat === 0 ? 1 : 0;
        this.game = { ...this.game, phase: "over", phaseTicks: 0, winner, paused: false, events: [] };
        this.lagComp.reset();
        this.forfeited = seat;
        this.pause = null;
        this.status = "over";
        this.deps.broadcast(this.channel, "snapshot", this.snapshot());
    }

    private setPaused(paused: boolean): void {
        if (!this.game) return;
        this.game = { ...this.game, paused };
        this.lagComp.reset();
    }

    private missingSeat(): Seat | -1 {
        for (const seat of [0, 1] as const) {
            const slot = this.seats[seat];
            if (slot.kind === "human" && !slot.member) return seat;
        }
        return -1;
    }

    hasConnectedHuman(): boolean {
        return this.spectators.size > 0 || this.seats.some((s) => s.kind === "human" && s.member);
    }

    /** Closed, abandoned, or a private room nobody joined. */
    isExpired(now: number): boolean {
        if (this.status === "closed") return true;
        if (!this.hasConnectedHuman() && now - this.lastHumanAt > this.config.emptyRoomMs) return true;
        return this.status === "waiting" && now - this.createdAt > this.config.waitingRoomMs;
    }

    close(reason: string): void {
        if (this.status === "closed") return;
        this.status = "closed";
        this.closeReason = reason;
        this.sendInfo();
        for (const [member] of this.members()) member.leave(this.channel);
        for (const slot of this.seats) slot.member = null;
        this.spectators.clear();
    }

    // -------------------------------------------------------------------------
    // Room info
    // -------------------------------------------------------------------------

    private *members(): Generator<[Member, Seat | -1]> {
        for (const seat of [0, 1] as const) {
            const m = this.seats[seat].member;
            if (m) yield [m, seat];
        }
        for (const m of this.spectators.values()) yield [m, -1];
    }

    /** Sends each member the room info, personalised with their own seat. */
    sendInfo(now = this.lastAdvance ?? 0): void {
        for (const [member, seat] of this.members()) member.send("room", this.info(seat, now));
    }

    info(you: Seat | -1, now = this.lastAdvance ?? 0): RoomInfo {
        const seatInfo = (seat: Seat) => {
            const s = this.seats[seat];
            return {
                kind: s.kind,
                connected: s.kind === "bot" || (s.kind === "human" && s.member !== null),
                rematch: s.rematch,
                label: s.kind === "bot" ? BOT_LABELS[s.bot!.difficulty] : `Player ${seat + 1}`,
            };
        };
        return {
            code: this.code,
            mode: this.mode,
            status: this.status,
            you,
            seats: [seatInfo(0), seatInfo(1)],
            spectators: this.spectators.size,
            pause: this.pause
                ? {
                      seat: this.pause.seat,
                      forfeitInMs: Math.max(0, this.pause.forfeitAt - now),
                      resumeInMs: this.pause.resumeAt === null ? null : Math.max(0, this.pause.resumeAt - now),
                  }
                : null,
            forfeited: this.forfeited,
            ...(this.closeReason ? { reason: this.closeReason } : {}),
            settings: {
                tickRate: TICK_RATE,
                snapshotRate: this.config.snapshotRate,
                lagCompensation: this.config.lagCompensation,
                lagCompensationMaxMs: this.config.lagCompensationMaxMs,
            },
        };
    }

    /** Rewinds granted by lag compensation (for tests and logs). */
    get lagCompensationRewinds(): number {
        return this.lagComp.rewinds;
    }
}
