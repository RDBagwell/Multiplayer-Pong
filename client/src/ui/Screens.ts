import { DIFFICULTIES, type Difficulty } from "../../../shared/protocol.ts";
import { el, replace, setText } from "./dom.ts";

export interface MenuActions {
    playBot(difficulty: Difficulty): void;
    playOffline(difficulty: Difficulty): void;
    quickMatch(): void;
    createRoom(): void;
    joinRoom(code: string): void;
    watchRoom(code: string): void;
}

/** What the landing screen shows about the server. */
export interface ServerView {
    online: boolean;
    /** Show the "play offline meanwhile" banner. */
    offerOffline: boolean;
    label: string;
}

const DIFFICULTY_LABELS: Record<Difficulty, string> = { easy: "Easy", medium: "Medium", hard: "Hard" };

/** The overlay that holds the landing screen, the waiting screens and messages. */
export class Screens {
    readonly root: HTMLElement;
    private readonly card: HTMLElement;
    /** Elements of the landing screen that follow the server's state. */
    private landing: { status: HTMLElement; dot: HTMLElement; offer: HTMLElement; online: HTMLButtonElement[] } | null = null;
    private difficulty: Difficulty = "medium";

    constructor() {
        this.card = el("div", { class: "card" });
        this.root = el("div", { class: "overlay", hidden: true }, this.card);
    }

    hide(): void {
        this.root.hidden = true;
        this.landing = null;
        this.card.classList.remove("landing");
    }

    private show(...children: (Node | string | null)[]): void {
        replace(this.card, ...children);
        this.card.classList.remove("landing");
        this.landing = null;
        this.root.hidden = false;
    }

    /** The landing screen: the four ways in, and what the network lab is. */
    menu(actions: MenuActions, server: ServerView, notice?: string): void {
        const button = (label: string, onClick: () => void, cls = "") => {
            const b = el("button", { type: "button", class: cls }, label);
            b.addEventListener("click", onClick);
            return b;
        };
        const code = el("input", {
            type: "text",
            placeholder: "CODE",
            maxlength: 9,
            autocomplete: "off",
            autocapitalize: "characters",
            spellcheck: "false",
            "aria-label": "Room code",
        });
        code.addEventListener("keydown", (e) => {
            if (e.key === "Enter") actions.joinRoom(code.value);
        });

        // Difficulty is a small segmented control shared by the online and offline buttons.
        const segments = DIFFICULTIES.map((d) => {
            const b = el("button", { type: "button", class: "segment", "aria-pressed": String(d === this.difficulty) }, DIFFICULTY_LABELS[d]);
            b.addEventListener("click", () => {
                this.difficulty = d;
                for (const [i, s] of segments.entries()) s.setAttribute("aria-pressed", String(DIFFICULTIES[i] === d));
            });
            return b;
        });

        const quick = button("Find a match", actions.quickMatch, "primary");
        const create = button("Create room", actions.createRoom);
        const join = button("Join", () => actions.joinRoom(code.value));
        const watch = button("Watch", () => actions.watchRoom(code.value), "ghost");
        const playOnline = button("Play online", () => actions.playBot(this.difficulty), "primary");
        const playOffline = button("Play offline", () => actions.playOffline(this.difficulty));

        const dot = el("span", { class: "dot", "aria-hidden": "true" });
        const status = el("span", { class: "status-text" });
        const offer = el(
            "div",
            { class: "offer", role: "status", hidden: true },
            el("p", {}, "The server is waking up: free hosting sleeps when nobody's playing. You don't have to wait."),
            button("Play the computer offline", () => actions.playOffline(this.difficulty), "primary")
        );

        this.show(
            el(
                "header",
                { class: "brand" },
                el("h1", {}, el("span", { class: "logo" }, "NETCODE"), el("span", { class: "logo accent" }, "PONG")),
                el("p", { class: "tagline" }, "A multiplayer Pong that shows its work."),
                el("p", { class: "server-status" }, dot, status)
            ),
            notice ? el("p", { class: "notice", role: "status" }, notice) : null,
            offer,
            el(
                "div",
                { class: "cards" },
                el("section", { class: "tile" }, el("h2", {}, "Quick match"), el("p", {}, "Play the next person who's waiting. Open a second tab to play yourself."), el("div", { class: "row" }, quick)),
                el(
                    "section",
                    { class: "tile" },
                    el("h2", {}, "Private room"),
                    el("p", {}, "Get a link to send a friend, or enter their code."),
                    el("div", { class: "row" }, create),
                    el("div", { class: "row join" }, code, join, watch)
                ),
                el(
                    "section",
                    { class: "tile" },
                    el("h2", {}, "Play vs. computer"),
                    el("p", {}, "Online runs on the server, so the network lab works. Offline runs entirely in your browser."),
                    el("div", { class: "segments", role: "group", "aria-label": "Difficulty" }, ...segments),
                    el("div", { class: "row" }, playOnline, playOffline)
                ),
                el(
                    "section",
                    { class: "tile lab-explainer" },
                    el("h2", {}, "The network lab"),
                    el(
                        "p",
                        {},
                        "In any online match, open ",
                        el("strong", {}, "Network lab"),
                        " (or press L). Add latency, jitter and packet loss, then switch off prediction, reconciliation and interpolation one at a time to feel what each one does."
                    )
                )
            ),
            el("p", { class: "hint" }, "W/S or ↑/↓ · mouse · drag on your half · M mutes · L opens the lab")
        );
        this.card.classList.add("landing");
        this.landing = { status, dot, offer, online: [quick, create, join, watch, playOnline] };
        this.setServer(server);
    }

    /** Updates the landing screen when the server comes and goes. */
    setServer(server: ServerView): void {
        if (!this.landing) return;
        setText(this.landing.status, server.label);
        this.landing.dot.className = `dot ${server.online ? "on" : "off"}`;
        this.landing.offer.hidden = !server.offerOffline;
        for (const b of this.landing.online) b.disabled = !server.online;
    }

    queue(onCancel: () => void): void {
        const cancel = el("button", { type: "button" }, "Cancel");
        cancel.addEventListener("click", onCancel);
        this.show(el("h2", {}, "Looking for an opponent…"), el("p", { class: "lede" }, "Tip: open this page in a second tab to play yourself."), el("div", { class: "row" }, cancel));
    }

    waiting(code: string, onCancel: () => void): void {
        const base = `${location.origin}${location.pathname}`;
        const invite = `${base}?join=${code}`;
        const watch = `${base}?watch=${code}`;
        const copy = (label: string, text: string) => {
            const b = el("button", { type: "button" }, label);
            b.addEventListener("click", async () => {
                try {
                    await navigator.clipboard.writeText(text);
                    b.textContent = "Copied";
                } catch {
                    b.textContent = "Copy failed: select the link";
                }
                setTimeout(() => (b.textContent = label), 1500);
            });
            return b;
        };
        const cancel = el("button", { type: "button", class: "ghost" }, "Cancel");
        cancel.addEventListener("click", onCancel);
        this.show(
            el("h2", {}, "Waiting for your opponent"),
            el("p", { class: "lede" }, "Send them this link, or the code."),
            el("p", { class: "code", "aria-label": "Room code" }, code),
            el("input", { type: "text", readonly: true, value: invite, "aria-label": "Invite link", class: "link" }),
            el("div", { class: "row" }, copy("Copy invite link", invite), copy("Copy spectator link", watch), cancel)
        );
    }

    message(title: string, body: string, onOk: () => void): void {
        const ok = el("button", { type: "button", class: "primary" }, "OK");
        ok.addEventListener("click", onOk);
        this.show(el("h2", {}, title), el("p", { class: "lede" }, body), el("div", { class: "row" }, ok));
    }
}

/** The bar above the field: players, score, and the match buttons. */
export class Hud {
    readonly root: HTMLElement;
    private readonly left: HTMLElement;
    private readonly right: HTMLElement;
    private readonly score: HTMLElement;
    private readonly info: HTMLElement;
    readonly labButton: HTMLButtonElement;
    readonly leaveButton: HTMLButtonElement;
    readonly rematchButton: HTMLButtonElement;
    readonly muteButton: HTMLButtonElement;

    constructor() {
        this.left = el("span", { class: "player" });
        this.right = el("span", { class: "player right" });
        this.score = el("span", { class: "score", "aria-live": "polite" });
        this.info = el("span", { class: "info" });
        this.labButton = el("button", { type: "button", class: "lab-toggle", "aria-expanded": "false", "aria-controls": "lab" }, "Network lab");
        this.rematchButton = el("button", { type: "button", class: "primary", hidden: true }, "Rematch");
        this.leaveButton = el("button", { type: "button", class: "ghost" }, "Leave");
        this.muteButton = el("button", { type: "button", class: "ghost", "aria-pressed": "false", title: "Sound (M)" }, "Sound on");
        this.root = el(
            "header",
            { class: "hud", hidden: true },
            el("div", { class: "match" }, this.left, this.score, this.right),
            el("div", { class: "actions" }, this.info, this.rematchButton, this.muteButton, this.labButton, this.leaveButton)
        );
    }

    setMuted(muted: boolean): void {
        this.muteButton.textContent = muted ? "Sound off" : "Sound on";
        this.muteButton.setAttribute("aria-pressed", String(muted));
    }

    set(left: string, right: string, score: string, info: string): void {
        if (this.left.textContent !== left) this.left.textContent = left;
        if (this.right.textContent !== right) this.right.textContent = right;
        if (this.score.textContent !== score) this.score.textContent = score;
        if (this.info.textContent !== info) this.info.textContent = info;
    }
}
