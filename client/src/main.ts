import "./styles.css";
import { io } from "socket.io-client";
import { TICK_RATE } from "../../shared/constants.ts";
import type { Ack, RoomInfo } from "../../shared/protocol.ts";
import { Controls } from "./input/Controls.ts";
import { Connection } from "./net/Connection.ts";
import { NetworkSimulator, PERFECT_NETWORK } from "./net/NetworkSimulator.ts";
import { Session, type TokenStore } from "./net/Session.ts";
import { ALL_ON, GameClient, type ClientView } from "./netcode/GameClient.ts";
import { Renderer, type Overlay } from "./render/Renderer.ts";
import { el } from "./ui/dom.ts";
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

// --- Wiring -----------------------------------------------------------------

const socket = io({ transports: ["websocket"] });
const netsim = new NetworkSimulator(PERFECT_NETWORK);
const connection = new Connection(socket, netsim, now);
const session = new Session(connection, tokenStore);
const game = new GameClient(connection, ALL_ON);

const canvas = el("canvas", { class: "field", "aria-label": "Pong field" });
const hud = new Hud();
const screens = new Screens();
const toast = el("div", { class: "toast", role: "status", "aria-live": "polite", hidden: true });
const stage = el("main", { class: "stage" }, el("div", { class: "field-wrap" }, canvas));
const app = el("div", { class: "app" }, hud.root, stage, screens.root, toast);
document.body.appendChild(app);

const renderer = new Renderer(canvas);
const controls = new Controls(renderer, canvas);
game.input = (paddleY) => controls.direction(paddleY);

// --- App state ----------------------------------------------------------------

type Screen = "menu" | "queue" | "room";
let screen: Screen = "menu";
let pauseDeadline: number | null = null;
let resumeDeadline: number | null = null;

function showToast(message: string): void {
    toast.textContent = message;
    toast.hidden = false;
    setTimeout(() => (toast.hidden = true), 3500);
}

function toMenu(notice?: string): void {
    screen = "menu";
    game.detach();
    hud.root.hidden = true;
    screens.menu(menuActions, notice);
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
    playBot: (difficulty: "easy" | "medium" | "hard") => void enterRoom(session.playBot(difficulty)),
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
    await session.leave();
    toMenu();
}

hud.leaveButton.addEventListener("click", () => void leave());
hud.rematchButton.addEventListener("click", async () => {
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
setInterval(() => game.update(now()), 4);

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

function frame(): void {
    const t = now();
    const view = game.view(t);
    const info = game.room;
    if (screen === "room" && info && view) {
        controls.paddleY = game.predictor.paddle.y;
        const name = (seat: 0 | 1) => (seat === info.you ? `${info.seats[seat].label} (you)` : info.seats[seat].label);
        const watchers = info.spectators ? ` · ${info.spectators} watching` : "";
        hud.set(name(0), name(1), `${view.score[0]} : ${view.score[1]}`, `${info.mode === "private" ? `Room ${info.code}` : ""}${watchers}`);
        renderer.draw(view, false, overlayFor(view, info));
    } else {
        renderer.draw(null, false);
    }
    requestAnimationFrame(frame);
}

toMenu();
requestAnimationFrame(frame);
