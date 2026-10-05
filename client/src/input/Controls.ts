import { FIELD_WIDTH, INPUT_LEVELS, PADDLE_SPEED, TICK_DT } from "../../../shared/constants.ts";
import type { Seat } from "../../../shared/state.ts";
import type { Renderer } from "../render/Renderer.ts";

const UP_KEYS = new Set(["KeyW", "ArrowUp"]);
const DOWN_KEYS = new Set(["KeyS", "ArrowDown"]);
const LEFT_KEYS = new Set(["KeyA", "ArrowLeft"]);
const RIGHT_KEYS = new Set(["KeyD", "ArrowRight"]);

/**
 * Keyboard, mouse and touch, turned into the one thing the server accepts:
 * an input direction per tick.
 *
 * - Keyboard: W/S or the arrow keys (A/D and left/right too when the field
 *   is turned sideways on a portrait screen). Full speed while held.
 * - Mouse: the paddle follows the pointer while it is over the field.
 * - Touch: drag anywhere on your half; the paddle moves by as much as your
 *   finger does, so your finger never hides it.
 *
 * Mouse and touch produce a *target*; each tick it is turned into a
 * direction towards it from where the client predicts the paddle is, using
 * intermediate input levels so the paddle stops exactly on target.
 */
export class Controls {
    private readonly renderer: Renderer;
    private readonly keys: string[] = [];
    private target: number | null = null;
    private touch: { id: number; startFingerY: number; startPaddleY: number } | null = null;
    /** Set by the app: where the client believes the paddle is right now. */
    paddleY = 250;
    /** Set by the app: whether input is accepted, and for which seat (whose half of the field takes touches). */
    enabled = false;
    seat: Seat = 0;

    constructor(renderer: Renderer, target: HTMLElement) {
        this.renderer = renderer;
        window.addEventListener("keydown", (e) => this.onKey(e, true));
        window.addEventListener("keyup", (e) => this.onKey(e, false));
        window.addEventListener("blur", () => (this.keys.length = 0));

        target.addEventListener("mousemove", (e) => {
            if (!this.enabled) return;
            this.target = this.fieldY(e.clientX, e.clientY);
        });
        target.addEventListener("mouseleave", () => (this.target = null));
        target.addEventListener("touchstart", (e) => this.onTouch(e, "start"), { passive: false });
        target.addEventListener("touchmove", (e) => this.onTouch(e, "move"), { passive: false });
        target.addEventListener("touchend", (e) => this.onTouch(e, "end"));
        target.addEventListener("touchcancel", (e) => this.onTouch(e, "end"));
    }

    /** The direction to hold for the next tick, given the predicted paddle position. */
    direction(paddleY: number): number {
        if (!this.enabled) return 0;
        const key = this.keys.at(-1);
        if (key) return this.keyDirection(key);
        if (this.target === null) return 0;
        const perTick = PADDLE_SPEED * TICK_DT;
        const level = Math.round(((this.target - paddleY) / perTick) * INPUT_LEVELS);
        return Math.max(-INPUT_LEVELS, Math.min(INPUT_LEVELS, level));
    }

    private keyDirection(code: string): number {
        if (UP_KEYS.has(code)) return -INPUT_LEVELS;
        if (DOWN_KEYS.has(code)) return INPUT_LEVELS;
        // Left/right only mean something when the field is sideways: map them to whichever
        // way moves the paddle left/right on screen.
        const down = this.renderer.fieldDownOnScreen();
        if (Math.abs(down.x) < Math.abs(down.y)) return 0;
        const towardsRight = down.x > 0 ? INPUT_LEVELS : -INPUT_LEVELS;
        return RIGHT_KEYS.has(code) ? towardsRight : -towardsRight;
    }

    private onKey(e: KeyboardEvent, down: boolean): void {
        const known = UP_KEYS.has(e.code) || DOWN_KEYS.has(e.code) || LEFT_KEYS.has(e.code) || RIGHT_KEYS.has(e.code);
        if (!known) return;
        const typing = e.target instanceof HTMLInputElement && e.target.type !== "range" && e.target.type !== "checkbox";
        if (typing || !this.enabled) return;
        e.preventDefault();
        const i = this.keys.indexOf(e.code);
        if (i >= 0) this.keys.splice(i, 1);
        if (down) {
            this.keys.push(e.code);
            this.target = null;
        }
    }

    private onTouch(e: TouchEvent, phase: "start" | "move" | "end"): void {
        if (!this.enabled) return;
        if (phase === "end") {
            if (this.touch && [...e.changedTouches].some((t) => t.identifier === this.touch!.id)) {
                this.touch = null;
                this.target = null;
            }
            return;
        }
        e.preventDefault();
        if (phase === "start" && !this.touch) {
            const t = e.changedTouches[0];
            const field = this.field(t.clientX, t.clientY);
            const onYourSide = this.seat === 0 ? field.x <= FIELD_WIDTH / 2 : field.x >= FIELD_WIDTH / 2;
            if (!onYourSide) return;
            this.touch = { id: t.identifier, startFingerY: field.y, startPaddleY: this.paddleY };
            return;
        }
        const t = [...e.touches].find((x) => x.identifier === this.touch?.id);
        if (!t || !this.touch) return;
        this.target = this.touch.startPaddleY + (this.fieldY(t.clientX, t.clientY) - this.touch.startFingerY);
    }

    private field(clientX: number, clientY: number): { x: number; y: number } {
        const rect = this.renderer.canvas.getBoundingClientRect();
        return this.renderer.screenToField(clientX - rect.left, clientY - rect.top);
    }

    private fieldY(clientX: number, clientY: number): number {
        return this.field(clientX, clientY).y;
    }
}
