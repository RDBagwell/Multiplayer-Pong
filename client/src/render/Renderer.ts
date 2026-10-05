import { BALL_RADIUS, FIELD_HEIGHT, FIELD_WIDTH, PADDLE_FACE_X, PADDLE_HALF_HEIGHT, PADDLE_WIDTH } from "../../../shared/constants.ts";
import type { Snapshot } from "../../../shared/protocol.ts";
import type { Seat } from "../../../shared/state.ts";
import type { ClientView } from "../netcode/GameClient.ts";
import type { FxFrame } from "./Effects.ts";

const COLORS = {
    background: "#0b0e14",
    field: "#10141d",
    border: "#232a38",
    centre: "#2b3344",
    paddle: "#e6e9ef",
    own: "#5eead4",
    ball: "#ffffff",
    truth: "rgba(251, 113, 133, 0.85)",
    text: "#e6e9ef",
    muted: "#8b93a7",
};

export interface Overlay {
    /** Large centred text (countdown digit, "You win"...). */
    title?: string;
    subtitle?: string;
}

/**
 * Draws the match on a canvas at the display's refresh rate, independently
 * of the 60 Hz simulation and the 20 Hz snapshots.
 *
 * - Crisp on high-DPI screens: the backing store is sized in device pixels.
 * - Responsive: the 800×500 field is scaled to fit. On a portrait screen it
 *   is turned 90° so that your paddle is at the bottom, like phone Pong.
 * - Field-to-screen mapping is one matrix, also used (inverted) to turn
 *   pointer positions back into field coordinates.
 */
export class Renderer {
    readonly canvas: HTMLCanvasElement;
    private readonly ctx: CanvasRenderingContext2D;
    private dpr = 1;
    private cssWidth = 0;
    private cssHeight = 0;
    /** Field units -> CSS pixels. */
    matrix = new DOMMatrix();
    portrait = false;
    private seat: Seat | -1 = -1;

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        const ctx = canvas.getContext("2d", { alpha: false });
        if (!ctx) throw new Error("Canvas 2D is not available");
        this.ctx = ctx;
        new ResizeObserver(() => this.resize()).observe(canvas);
        this.resize();
    }

    private resize(): void {
        const rect = this.canvas.getBoundingClientRect();
        this.dpr = Math.min(window.devicePixelRatio || 1, 3);
        this.cssWidth = Math.max(1, rect.width);
        this.cssHeight = Math.max(1, rect.height);
        const w = Math.round(this.cssWidth * this.dpr);
        const h = Math.round(this.cssHeight * this.dpr);
        if (this.canvas.width !== w || this.canvas.height !== h) {
            this.canvas.width = w;
            this.canvas.height = h;
        }
        this.layout(this.seat);
    }

    /** Recomputes the field transform for the current size and the viewer's seat. */
    layout(seat: Seat | -1): void {
        this.seat = seat;
        const W = this.cssWidth;
        const H = this.cssHeight;
        this.portrait = H > W * 1.1;
        const margin = 12;
        if (!this.portrait) {
            const s = Math.min((W - 2 * margin) / FIELD_WIDTH, (H - 2 * margin) / FIELD_HEIGHT);
            const ox = (W - FIELD_WIDTH * s) / 2;
            const oy = (H - FIELD_HEIGHT * s) / 2;
            this.matrix = new DOMMatrix([s, 0, 0, s, ox, oy]);
        } else {
            const s = Math.min((W - 2 * margin) / FIELD_HEIGHT, (H - 2 * margin) / FIELD_WIDTH);
            const ox = (W - FIELD_HEIGHT * s) / 2;
            const oy = (H - FIELD_WIDTH * s) / 2;
            // Your end of the field at the bottom of the screen.
            this.matrix =
                seat === 1
                    ? new DOMMatrix([0, s, -s, 0, ox + FIELD_HEIGHT * s, oy])
                    : new DOMMatrix([0, -s, s, 0, ox, oy + FIELD_WIDTH * s]);
        }
    }

    /** CSS-pixel position (relative to the canvas) -> field coordinates. */
    screenToField(px: number, py: number): { x: number; y: number } {
        const p = this.matrix.inverse().transformPoint(new DOMPoint(px, py));
        return { x: p.x, y: p.y };
    }

    /** Which way "down the field" (+y) points on screen, as a unit-ish vector. */
    fieldDownOnScreen(): { x: number; y: number } {
        return { x: this.matrix.c, y: this.matrix.d };
    }

    draw(view: ClientView | null, showTruth: boolean, overlay: Overlay = {}, fx?: FxFrame): void {
        const ctx = this.ctx;
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        ctx.fillStyle = COLORS.background;
        ctx.fillRect(0, 0, this.cssWidth, this.cssHeight);

        this.toField(fx?.shake);
        ctx.fillStyle = COLORS.field;
        ctx.fillRect(0, 0, FIELD_WIDTH, FIELD_HEIGHT);
        ctx.strokeStyle = COLORS.border;
        ctx.lineWidth = 2;
        ctx.strokeRect(1, 1, FIELD_WIDTH - 2, FIELD_HEIGHT - 2);
        ctx.strokeStyle = COLORS.centre;
        ctx.setLineDash([10, 12]);
        ctx.beginPath();
        ctx.moveTo(FIELD_WIDTH / 2, 8);
        ctx.lineTo(FIELD_WIDTH / 2, FIELD_HEIGHT - 8);
        ctx.stroke();
        ctx.setLineDash([]);

        if (view) {
            if (showTruth) this.drawTruth(view.truth);
            for (const seat of [0, 1] as const) {
                this.paddle(seat, view.paddleY[seat], seat === view.you ? COLORS.own : COLORS.paddle, fx?.flash[seat] ?? 0);
            }
            const showBall = view.phase === "playing" || view.phase === "countdown";
            if (showBall && fx?.trail.length) {
                // A fading trail of recent positions.
                const n = fx.trail.length;
                fx.trail.forEach((p, i) => {
                    ctx.fillStyle = `rgba(255, 255, 255, ${(0.22 * (i + 1)) / n})`;
                    ctx.beginPath();
                    ctx.arc(p.x, p.y, BALL_RADIUS * (0.45 + (0.45 * (i + 1)) / n), 0, Math.PI * 2);
                    ctx.fill();
                });
            }
            if (showBall) {
                ctx.fillStyle = COLORS.ball;
                ctx.beginPath();
                ctx.arc(view.ball.x, view.ball.y, BALL_RADIUS, 0, Math.PI * 2);
                ctx.fill();
            }
        }

        this.toScreen();
        if (overlay.title) this.centredText(overlay.title, overlay.subtitle);
    }

    private drawTruth(truth: Snapshot): void {
        const ctx = this.ctx;
        ctx.save();
        ctx.strokeStyle = COLORS.truth;
        ctx.lineWidth = 2;
        ctx.setLineDash([5, 4]);
        for (const seat of [0, 1] as const) {
            const x = seat === 0 ? PADDLE_FACE_X[0] - PADDLE_WIDTH : PADDLE_FACE_X[1];
            ctx.strokeRect(x - 1, truth.paddles[seat].y - PADDLE_HALF_HEIGHT - 1, PADDLE_WIDTH + 2, PADDLE_HALF_HEIGHT * 2 + 2);
        }
        if (truth.phase === "playing" || truth.phase === "countdown") {
            ctx.beginPath();
            ctx.arc(truth.ball.x, truth.ball.y, BALL_RADIUS + 2, 0, Math.PI * 2);
            ctx.stroke();
        }
        ctx.restore();
    }

    private paddle(seat: Seat, y: number, color: string, flash: number): void {
        const ctx = this.ctx;
        const x = seat === 0 ? PADDLE_FACE_X[0] - PADDLE_WIDTH : PADDLE_FACE_X[1];
        ctx.save();
        if (flash > 0) {
            // A brief glow when the ball hits it.
            ctx.shadowColor = color;
            ctx.shadowBlur = 24 * flash * this.dpr;
        }
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.roundRect(x, y - PADDLE_HALF_HEIGHT, PADDLE_WIDTH, PADDLE_HALF_HEIGHT * 2, 4);
        ctx.fill();
        if (flash > 0) {
            ctx.fillStyle = `rgba(255, 255, 255, ${0.7 * flash})`;
            ctx.fill();
        }
        ctx.restore();
    }

    private centredText(title: string, subtitle?: string): void {
        const ctx = this.ctx;
        const size = Math.max(28, Math.min(this.cssWidth, this.cssHeight) * 0.12);
        const cx = this.cssWidth / 2;
        const cy = this.cssHeight / 2;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.lineJoin = "round";
        ctx.font = `700 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
        ctx.lineWidth = 6;
        ctx.strokeStyle = COLORS.background;
        ctx.strokeText(title, cx, cy);
        ctx.fillStyle = COLORS.text;
        ctx.fillText(title, cx, cy);
        if (subtitle) {
            const small = Math.max(14, size * 0.32);
            ctx.font = `500 ${small}px system-ui, -apple-system, "Segoe UI", sans-serif`;
            ctx.lineWidth = 4;
            ctx.strokeText(subtitle, cx, cy + size * 0.75);
            ctx.fillStyle = COLORS.muted;
            ctx.fillText(subtitle, cx, cy + size * 0.75);
        }
    }

    private toField(offset: { x: number; y: number } = { x: 0, y: 0 }): void {
        const m = this.matrix;
        const d = this.dpr;
        this.ctx.setTransform(m.a * d, m.b * d, m.c * d, m.d * d, (m.e + offset.x) * d, (m.f + offset.y) * d);
    }

    private toScreen(): void {
        this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }
}
