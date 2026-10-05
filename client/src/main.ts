import "./styles.css";
import { io } from "socket.io-client";
import { TICK_RATE } from "../../shared/constants.ts";
import type { Ack, Difficulty, RoomInfo } from "../../shared/protocol.ts";
import { Sound } from "./audio/Sound.ts";
import { SERVER_URL } from "./config.ts";
import { Controls } from "./input/Controls.ts";
import { Connection } from "./net/Connection.ts";
import { NetworkSimulator } from "./net/NetworkSimulator.ts";
import { ServerStatus } from "./net/ServerStatus.ts";
import { Session, type TokenStore } from "./net/Session.ts";
import { GameClient, type ClientView } from "./netcode/GameClient.ts";
import { OfflineMatch } from "./offline/OfflineMatch.ts";
import { Effects } from "./render/Effects.ts";
import { Renderer, type Overlay } from "./render/Renderer.ts";
import { el } from "./ui/dom.ts";
import { DEFAULT_LAB, LabPanel, type LabSettings } from "./ui/LabPanel.ts";
import { Hud, Screens } from "./ui/Screens.ts";

// Refuse to run inside a frame (clickjacking); the server also sends frame-ancestors 'none'.
if (window.top !== window.self) throw new Error("Pong can't run inside a frame.");

const now = () => performance.now();

/** The seat token survives a reload of this tab, and nothing else. */
const tokenStore: TokenStore = {
    load() {
        try {
            const raw = sessionStorage.getItem("pong.seat");
            const v = raw ? JSON.parse(raw) : null;
            return v && typeof v.code === "string" && typeof v.token === "string" ? v : null;
        } catch {
            return null;
        }
    },
    save(value) {
        try {
            sessionStorage.setItem("pong.seat", JSON.stringify(value));
        } catch {
            // Private mode: no resume after reload, everything else works.
        }
    },
    clear() {
        try {
            sessionStorage.removeItem("pong.seat");
        } catch {
            // ignore
        }
    },
};

/** Lab settings are a per-browser convenience, remembered in localStorage when it's available. */
function loadLab(): LabSettings {
    try {
        const raw = JSON.parse(localStorage.getItem("pong.lab") ?? "null");
        const c = raw?.conditions;
        const t = raw?.toggles;
        const num = (v: unknown, max: number) => (typeof v === "number" && v >= 0 && v <= max ? v : 0);
        if (!c || !t) return structuredClone(DEFAULT_LAB);
        return {
            conditions: { latencyMs: num(c.latencyMs, 500), jitterMs: num(c.jitterMs, 150), loss: num(c.loss, 0.3) },
            toggles: { prediction: t.prediction !== false, reconciliation: t.reconciliation !== false, interpolation: t.interpolation !== false },
            showTruth: raw.showTruth === true,
        };
    } catch {
        return structuredClone(DEFAULT_LAB);
    }
}

function loadFlag(key: string): boolean {
    try {
        return localStorage.getItem(key) === "1";
    } catch {
        return false;
    }
}

function saveFlag(key: string, value: boolean): void {
    try {
        localStorage.setItem(key, value ? "1" : "0");
    } catch {
        // Storage unavailable.
    }
}

function saveLab(settings: LabSettings): void {
    try {
        localStorage.setItem("pong.lab", JSON.stringify(settings));
    } catch {
        // Storage unavailable: settings last for this page only.
    }
}

// --- Wiring -----------------------------------------------------------------

const labSettings = loadLab();
const socket = io(SERVER_URL, { transports: ["websocket"] });
const status = new ServerStatus(performance.now());
socket.on("connect", () => status.onConnect());
socket.on("disconnect", () => status.onDisconnect());
socket.on("connect_error", () => status.onError());
const netsim = new NetworkSimulator(labSettings.conditions);
const connection = new Connection(socket, netsim, now);
const session = new Session(connection, tokenStore);
const game = new GameClient(connection, labSettings.toggles);
const lab = new LabPanel(labSettings, (settings) => {
    netsim.conditions = { ...settings.conditions };
    game.toggles = { ...settings.toggles };
    saveLab(settings);
});

const canvas = el("canvas", { class: "field", "aria-label": "Pong field" });
const hud = new Hud();
const screens = new Screens();
const toast = el("div", { class: "toast", role: "status", "aria-live": "polite", hidden: true });
const stage = el("main", { class: "stage" }, el("div", { class: "field-wrap" }, canvas), lab.root);
const app = el("div", { class: "app" }, hud.root, stage, screens.root, toast);
document.body.appendChild(app);

const renderer = new Renderer(canvas);
const controls = new Controls(renderer, canvas);
game.input = (paddleY) => controls.direction(paddleY);

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const effects = new Effects(reducedMotion.matches);
reducedMotion.addEventListener("change", () => (effects.reducedMotion = reducedMotion.matches));
const sound = new Sound(loadFlag("pong.muted"));
hud.setMuted(sound.muted);
// Browsers allow audio only after a user gesture.
for (const type of ["pointerdown", "keydown"]) window.addEventListener(type, () => sound.unlock(), { capture: true });
function toggleMute(): void {
    sound.muted = !sound.muted;
    hud.setMuted(sound.muted);
    saveFlag("pong.muted", sound.muted);
}
hud.muteButton.addEventListener("click", toggleMute);

// --- App state ----------------------------------------------------------------

type Screen = "menu" | "queue" | "room" | "offline";
let screen: Screen = "menu";
/** The match running in this browser when playing offline. */
let offline: OfflineMatch | null = null;

function serverView() {
    const t = now();
    return { online: status.isOnline(t), offerOffline: status.offerOffline(t), label: status.label(t) };
}
let pauseDeadline: number | null = null;
let resumeDeadline: number | null = null;

function showToast(message: string): void {
    toast.textContent = message;
    toast.hidden = false;
    setTimeout(() => (toast.hidden = true), 3500);
}

function toMenu(notice?: string): void {
    screen = "menu";
    offline = null;
    game.detach();
    effects.reset();
    hud.root.hidden = true;
    hud.labButton.hidden = false;
    screens.menu(menuActions, serverView(), notice);
}

/** Starts a match against the computer that runs entirely in this browser. */
function startOffline(difficulty: Difficulty): void {
    void session.cancelQueue().catch(() => {});
    tokenStore.clear();
    offline = new OfflineMatch(difficulty);
    offline.input = (paddleY) => controls.direction(paddleY);
    screen = "offline";
    effects.reset();
    screens.hide();
    setLabOpen(false);
    hud.root.hidden = false;
    hud.labButton.hidden = true; // the lab needs a network to play with
    hud.rematchButton.hidden = true;
    renderer.layout(0);
    controls.enabled = true;
    controls.seat = 0;
}

async function enterRoom(request: Promise<Ack>): Promise<void> {
    const ack = await request;
    if (!ack.ok) return showToast(ack.error);
    showRoom();
}

/** Switches to the match screen. The server sends room info before the ack, so apply what we already have. */
function showRoom(): void {
    screen = "room";
    screens.hide();
    if (game.room) onRoom(game.room);
}

const menuActions = {
    playBot: (difficulty: Difficulty) => void enterRoom(session.playBot(difficulty)),
    playOffline: (difficulty: Difficulty) => startOffline(difficulty),
    quickMatch: async () => {
        const ack = await session.quickMatch();
        if (!ack.ok) return showToast(ack.error);
        if (screen === "menu") {
            screen = "queue";
            screens.queue(async () => {
                await session.cancelQueue();
                toMenu();
            });
        }
    },
    createRoom: () => void enterRoom(session.createRoom()),
    joinRoom: (code: string) => void enterRoom(session.joinRoom(code)),
    watchRoom: (code: string) => void enterRoom(session.watchRoom(code)),
};

connection.on("seated", () => showRoom());

connection.on("room", (info) => onRoom(info));

function onRoom(info: RoomInfo): void {
    if (screen !== "room") return;
    if (info.status === "closed") {
        tokenStore.clear();
        return toMenu(info.reason ?? "The room has closed.");
    }
    hud.root.hidden = false;
    if (info.status === "waiting") screens.waiting(info.code, () => void leave());
    else screens.hide();
    pauseDeadline = info.pause && info.pause.resumeInMs === null ? now() + info.pause.forfeitInMs : null;
    resumeDeadline = info.pause && info.pause.resumeInMs !== null ? now() + info.pause.resumeInMs : null;
    renderer.layout(info.you);
    controls.enabled = info.you !== -1;
    if (info.you !== -1) controls.seat = info.you;
    hud.rematchButton.hidden = !(info.status === "over" && info.you !== -1);
    hud.rematchButton.disabled = info.you !== -1 && info.seats[info.you].rematch;
    hud.rematchButton.textContent = hud.rematchButton.disabled ? "Waiting for opponent…" : "Rematch";
}

async function leave(): Promise<void> {
    if (screen === "offline") return toMenu();
    await session.leave();
    toMenu();
}

hud.leaveButton.addEventListener("click", () => void leave());
function setLabOpen(open: boolean): void {
    if (open && screen === "offline") return;
    lab.open = open;
    hud.labButton.setAttribute("aria-expanded", String(open));
}
hud.labButton.addEventListener("click", () => setLabOpen(!lab.open));
window.addEventListener("keydown", (e) => {
    if (e.target instanceof HTMLInputElement && e.target.type === "text") return;
    if (e.code === "KeyL" && screen === "room") setLabOpen(!lab.open);
    if (e.code === "KeyM") toggleMute();
});
hud.rematchButton.addEventListener("click", async () => {
    if (screen === "offline" && offline) {
        offline.rematch();
        effects.reset();
        return;
    }
    const ack = await session.rematch();
    if (!ack.ok) showToast(ack.error);
});

session.onResumeFailed = () => {
    if (screen === "room") toMenu("Your seat has expired.");
};

connection.on("serverError", (message) => showToast(message));
connection.on("disconnect", () => {
    if (screen === "room") showToast("Connection lost. Reconnecting…");
});
connection.on("connect", async () => {
    if (screen === "menu") screens.setServer(serverView());
    // After a reload or a dropped connection, ask for our seat back with the saved token.
    const watching = screen === "room" && game.room?.you === -1 ? game.room.code : null;
    if (tokenStore.load()) {
        const ack = await session.resumeIfSeated();
        if (ack?.ok) return showRoom();
    } else if (watching) {
        return void enterRoom(session.watchRoom(watching));
    }
    handleLink();
});

/** ?join=CODE and ?watch=CODE links. */
function handleLink(): void {
    const params = new URLSearchParams(location.search);
    const join = params.get("join");
    const watch = params.get("watch");
    if (!join && !watch) return;
    history.replaceState(null, "", location.pathname);
    if (join) menuActions.joinRoom(join);
    else if (watch) menuActions.watchRoom(watch);
}

// --- Loops ----------------------------------------------------------------------

// Netcode: every 4 ms, independent of the display (the simulation itself is fixed at 60 Hz inside).
setInterval(() => {
    const t = now();
    game.update(t);
    offline?.update(t);
}, 4);

function overlayFor(view: ClientView | null, info: RoomInfo | null): Overlay {
    if (!view || !info) return {};
    const label = (seat: 0 | 1) => (seat === info.you ? "You" : info.seats[seat].label);
    if (info.status === "paused" && info.pause) {
        if (resumeDeadline !== null) return { title: "Get ready", subtitle: "Resuming…" };
        const secs = pauseDeadline === null ? 0 : Math.max(0, Math.ceil((pauseDeadline - now()) / 1000));
        const who = info.pause.seat === info.you ? "You" : info.seats[info.pause.seat].label;
        return { title: "Paused", subtitle: `${who} disconnected. Forfeit in ${secs} s` };
    }
    if (view.phase === "over" && view.winner !== -1) {
        const title = info.you === -1 ? `${label(view.winner)} wins` : view.winner === info.you ? "You win!" : "You lose";
        const subtitle = info.forfeited !== -1 ? `${label(info.forfeited as 0 | 1)} forfeited` : "First to 7";
        return { title, subtitle };
    }
    if (view.phase === "countdown") {
        const n = Math.ceil(view.phaseTicks / (TICK_RATE / 2));
        return { title: String(Math.max(1, n)), subtitle: `${label(view.server)} ${view.server === info.you ? "serve" : "serves"}` };
    }
    return {};
}

let lastStatsAt = 0;
let lastStatusAt = 0;

function frame(): void {
    const t = now();
    if (screen === "menu" && t - lastStatusAt > 250) {
        lastStatusAt = t;
        screens.setServer(serverView());
    }
    const view = offline ? offline.view() : game.view(t);
    const info = offline ? offline.info() : game.room;
    const playing = (screen === "room" || screen === "offline") && info && view;
    if (playing && offline) {
        hud.rematchButton.hidden = !offline.over;
        hud.rematchButton.disabled = false;
        hud.rematchButton.textContent = "Rematch";
    }
    if (playing) {
        controls.paddleY = offline ? offline.state.paddles[0].y : game.predictor.paddle.y;
        for (const event of effects.update(view, t)) sound.play(event, info.you);
        const name = (seat: 0 | 1) => (seat === info.you ? `${info.seats[seat].label} (you)` : info.seats[seat].label);
        const watchers = info.spectators ? ` · ${info.spectators} watching` : "";
        const where = offline ? "Offline · in your browser" : info.mode === "private" ? `Room ${info.code}` : "";
        hud.set(name(0), name(1), `${view.score[0]} : ${view.score[1]}`, `${where}${watchers}`);
        renderer.draw(view, !offline && lab.settings.showTruth, overlayFor(view, info), effects.frame(t));
        if (lab.open && t - lastStatsAt > 250) {
            lastStatsAt = t;
            lab.updateStats(game.stats(t), info);
        }
    } else {
        renderer.draw(null, false);
    }
    requestAnimationFrame(frame);
}

toMenu();
requestAnimationFrame(frame);
