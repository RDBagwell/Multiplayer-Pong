import type { Seat } from "../../../shared/state.ts";
import type { FxEvent } from "../render/Effects.ts";

/**
 * Retro blips generated with Web Audio: no audio files to download.
 *
 * Browsers only allow audio after a user gesture, so the AudioContext is
 * created on the first click or key press (`unlock()`).
 */
export class Sound {
    muted: boolean;
    private ctx: AudioContext | null = null;
    private master: GainNode | null = null;

    constructor(muted = false) {
        this.muted = muted;
    }

    /** Call from a user gesture. */
    unlock(): void {
        if (this.ctx) {
            if (this.ctx.state === "suspended") void this.ctx.resume();
            return;
        }
        const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!Ctx) return;
        this.ctx = new Ctx();
        this.master = this.ctx.createGain();
        this.master.gain.value = 0.18;
        this.master.connect(this.ctx.destination);
    }

    play(event: FxEvent, you: Seat | -1): void {
        if (this.muted || !this.ctx || !this.master) return;
        switch (event.type) {
            case "hit":
                this.blip(event.seat === you ? 660 : 520, 0.06, "square");
                break;
            case "wall":
                this.blip(260, 0.04, "triangle");
                break;
            case "countdown":
                this.blip(event.n === 1 ? 880 : 440, 0.07, "square", 0.6);
                break;
            case "point": {
                const good = you === -1 || event.seat === you;
                this.sequence(good ? [523, 784] : [392, 262], 0.09, "square");
                break;
            }
            case "win": {
                const good = you === -1 || event.seat === you;
                this.sequence(good ? [523, 659, 784, 1047] : [392, 330, 262, 196], 0.11, "triangle");
                break;
            }
        }
    }

    private blip(freq: number, duration: number, type: OscillatorType, volume = 1, delay = 0): void {
        const ctx = this.ctx!;
        const t = ctx.currentTime + delay;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, t);
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(volume, t + 0.005);
        gain.gain.exponentialRampToValueAtTime(0.001, t + duration);
        osc.connect(gain);
        gain.connect(this.master!);
        osc.start(t);
        osc.stop(t + duration + 0.02);
    }

    private sequence(freqs: number[], each: number, type: OscillatorType): void {
        freqs.forEach((f, i) => this.blip(f, each, type, 0.8, i * each));
    }
}
