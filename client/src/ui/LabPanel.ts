import type { RoomInfo } from "../../../shared/protocol.ts";
import type { NetworkConditions } from "../net/NetworkSimulator.ts";
import { PRESETS, type PresetName } from "../net/presets.ts";
import type { NetStats, NetcodeToggles } from "../netcode/GameClient.ts";
import { el, setText } from "./dom.ts";

export interface LabSettings {
    conditions: NetworkConditions;
    toggles: NetcodeToggles;
    showTruth: boolean;
}

export const DEFAULT_LAB: LabSettings = {
    conditions: { ...PRESETS.perfect.conditions },
    toggles: { prediction: true, reconciliation: true, interpolation: true },
    showTruth: false,
};

/** One-sentence explanations, written for someone who has never heard the terms. */
const EXPLAIN = {
    latency: "Extra time for every message to reach the server and come back, like playing from further away.",
    jitter: "A random extra delay on each message, so they arrive unevenly and sometimes out of order.",
    loss: "The share of messages that never arrive at all.",
    prediction: "Moves your paddle the instant you press a key, instead of waiting for the server to confirm the move.",
    reconciliation: "When the server's answer arrives, quietly corrects your paddle without undoing the moves you made since.",
    interpolation: "Shows the ball and your opponent a split second in the past, gliding smoothly between server updates instead of jumping.",
    truth: "Draws a faint outline of exactly what the server last reported, so you can see the gap between what it knows and what you see.",
} as const;

const STATS: { key: string; label: string; explain: string }[] = [
    { key: "rtt", label: "Round trip", explain: "Time for a message to reach the server and come back." },
    { key: "jitter", label: "Jitter", explain: "How unevenly server updates arrive." },
    { key: "rate", label: "Server updates", explain: "Snapshots received in the last second." },
    { key: "lost", label: "Updates lost", explain: "Snapshots that never arrived (since joining)." },
    { key: "up", label: "Upload", explain: "Data sent to the server per second." },
    { key: "down", label: "Download", explain: "Data received from the server per second." },
    { key: "corrections", label: "Corrections", explain: "Times per second the server disagreed with your predicted paddle." },
    { key: "delay", label: "Interpolation delay", explain: "How far in the past the ball and opponent are drawn." },
];

let ids = 0;
const uid = (name: string) => `lab-${name}-${++ids}`;

/**
 * The network lab: sliders for the simulated network, switches for each
 * netcode technique, the "show the truth" ghost, presets and live stats.
 * It only produces settings; main.ts applies them.
 */
export class LabPanel {
    readonly root: HTMLElement;
    settings: LabSettings;
    private readonly onChange: (settings: LabSettings) => void;
    private readonly sliders: Record<"latency" | "jitter" | "loss", { input: HTMLInputElement; value: HTMLElement }>;
    private readonly switches: Record<keyof NetcodeToggles | "truth", HTMLInputElement>;
    private readonly statValues = new Map<string, HTMLElement>();
    private readonly presetButtons: HTMLButtonElement[] = [];
    private readonly server: HTMLElement;

    constructor(settings: LabSettings, onChange: (settings: LabSettings) => void) {
        this.settings = structuredClone(settings);
        this.onChange = onChange;

        const slider = (key: "latency" | "jitter" | "loss", label: string, max: number, step: number) => {
            const id = uid(key);
            const tip = uid(`${key}-tip`);
            const input = el("input", { type: "range", id, min: 0, max, step, "aria-describedby": tip });
            const value = el("output", { for: id, class: "value" });
            input.addEventListener("input", () => this.readSliders());
            const row = el(
                "div",
                { class: "slider" },
                el("div", { class: "label-row" }, el("label", { for: id }, label), this.tip(tip, EXPLAIN[key]), value),
                input
            );
            return { row, input, value };
        };
        const latency = slider("latency", "Added latency", 500, 5);
        const jitter = slider("jitter", "Jitter", 150, 5);
        const loss = slider("loss", "Packet loss", 30, 1);
        this.sliders = { latency, jitter, loss };

        const toggle = (key: keyof NetcodeToggles | "truth", label: string) => {
            const id = uid(key);
            const tip = uid(`${key}-tip`);
            const input = el("input", { type: "checkbox", id, role: "switch", "aria-describedby": tip });
            input.addEventListener("change", () => this.readSwitches());
            const row = el("div", { class: "switch" }, input, el("label", { for: id }, label), this.tip(tip, EXPLAIN[key === "truth" ? "truth" : key]));
            return { row, input };
        };
        const prediction = toggle("prediction", "Prediction");
        const reconciliation = toggle("reconciliation", "Reconciliation");
        const interpolation = toggle("interpolation", "Interpolation");
        const truth = toggle("truth", "Show the truth");
        this.switches = { prediction: prediction.input, reconciliation: reconciliation.input, interpolation: interpolation.input, truth: truth.input };

        const presets = el("div", { class: "presets" });
        for (const [name, preset] of Object.entries(PRESETS) as [PresetName, (typeof PRESETS)[PresetName]][]) {
            const b = el("button", { type: "button", "data-preset": name, "aria-pressed": "false" }, preset.label);
            b.addEventListener("click", () => this.applyPreset(name));
            presets.appendChild(b);
            this.presetButtons.push(b);
        }

        const stats = el("dl", { class: "stats" });
        for (const s of STATS) {
            const value = el("dd", {}, "–");
            this.statValues.set(s.key, value);
            stats.append(el("div", { title: s.explain }, el("dt", {}, s.label), value));
        }
        this.server = el("p", { class: "server-info" });

        this.root = el(
            "aside",
            { class: "lab", id: "lab", hidden: true, "aria-label": "Network lab" },
            el("h2", {}, "Network lab"),
            el("p", { class: "lab-intro" }, "Make the network worse, then switch the techniques off one by one to feel what each is for."),
            el("section", {}, el("h3", {}, "Network"), presets, latency.row, jitter.row, loss.row),
            el("section", {}, el("h3", {}, "Netcode"), prediction.row, reconciliation.row, interpolation.row, truth.row),
            el("section", {}, el("h3", {}, "Live"), stats, this.server)
        );
        this.render();
    }

    /** A "?" that shows its sentence on hover, focus or tap. */
    private tip(id: string, text: string): HTMLElement {
        const bubble = el("span", { class: "tip-text", role: "tooltip", id }, text);
        const button = el("button", { type: "button", class: "tip", "aria-label": "What this does", "aria-describedby": id }, "?");
        button.addEventListener("click", () => wrap.classList.toggle("open"));
        button.addEventListener("blur", () => wrap.classList.remove("open"));
        const wrap = el("span", { class: "tip-wrap" }, button, bubble);
        return wrap;
    }

    get open(): boolean {
        return !this.root.hidden;
    }

    set open(open: boolean) {
        this.root.hidden = !open;
    }

    private readSliders(): void {
        this.settings.conditions = {
            latencyMs: Number(this.sliders.latency.input.value),
            jitterMs: Number(this.sliders.jitter.input.value),
            loss: Number(this.sliders.loss.input.value) / 100,
        };
        this.changed();
    }

    private readSwitches(): void {
        this.settings.toggles = {
            prediction: this.switches.prediction.checked,
            reconciliation: this.switches.reconciliation.checked,
            interpolation: this.switches.interpolation.checked,
        };
        this.settings.showTruth = this.switches.truth.checked;
        this.changed();
    }

    applyPreset(name: PresetName): void {
        this.settings.conditions = { ...PRESETS[name].conditions };
        this.changed();
    }

    private changed(): void {
        this.render();
        this.onChange(structuredClone(this.settings));
    }

    private render(): void {
        const { conditions, toggles, showTruth } = this.settings;
        this.sliders.latency.input.value = String(conditions.latencyMs);
        this.sliders.jitter.input.value = String(conditions.jitterMs);
        this.sliders.loss.input.value = String(Math.round(conditions.loss * 100));
        setText(this.sliders.latency.value, `${conditions.latencyMs} ms`);
        setText(this.sliders.jitter.value, `${conditions.jitterMs} ms`);
        setText(this.sliders.loss.value, `${Math.round(conditions.loss * 1000) / 10}%`);
        this.switches.prediction.checked = toggles.prediction;
        this.switches.reconciliation.checked = toggles.reconciliation;
        this.switches.interpolation.checked = toggles.interpolation;
        this.switches.truth.checked = showTruth;
        // Reconciliation only exists on top of prediction.
        this.switches.reconciliation.disabled = !toggles.prediction;
        for (const b of this.presetButtons) {
            const p = PRESETS[b.getAttribute("data-preset") as PresetName].conditions;
            const active = p.latencyMs === conditions.latencyMs && p.jitterMs === conditions.jitterMs && Math.abs(p.loss - conditions.loss) < 1e-9;
            b.setAttribute("aria-pressed", String(active));
        }
    }

    /** Refreshes the live numbers (call a few times a second). */
    updateStats(stats: NetStats, room: RoomInfo | null): void {
        const ms = (v: number) => `${Math.round(v)} ms`;
        const bytes = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)} kB/s` : `${Math.round(v)} B/s`);
        const total = stats.snapshotsReceived + stats.snapshotsLost;
        const values: Record<string, string> = {
            rtt: ms(stats.rttMs),
            jitter: ms(stats.snapshotJitterMs),
            rate: `${stats.snapshotsPerSecond}/s`,
            lost: total ? `${stats.snapshotsLost} (${((stats.snapshotsLost / total) * 100).toFixed(1)}%)` : "0",
            up: bytes(stats.bytesUpPerSecond),
            down: bytes(stats.bytesDownPerSecond),
            corrections: `${stats.correctionsPerSecond}/s`,
            delay: this.settings.toggles.interpolation ? ms(stats.interpolationDelayMs) : "off",
        };
        for (const [key, text] of Object.entries(values)) setText(this.statValues.get(key)!, text);
        if (room) {
            const s = room.settings;
            const lag = s.lagCompensation ? `on (up to ${s.lagCompensationMaxMs} ms)` : "off";
            setText(this.server, `Server: ${s.tickRate} Hz simulation, ${s.snapshotRate} Hz snapshots, lag compensation ${lag}.`);
        }
    }
}
