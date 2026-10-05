import { DIFFICULTIES, type Difficulty } from "../../../shared/protocol.ts";
import { el, replace } from "./dom.ts";

export interface MenuActions {
    playBot(difficulty: Difficulty): void;
    quickMatch(): void;
    createRoom(): void;
    joinRoom(code: string): void;
    watchRoom(code: string): void;
}

/** The overlay that holds the menu, the waiting screens and the end-of-match panel. */
export class Screens {
    readonly root: HTMLElement;
    private readonly card: HTMLElement;

    constructor() {
        this.card = el("div", { class: "card" });
        this.root = el("div", { class: "overlay", hidden: true }, this.card);
    }

    hide(): void {
        this.root.hidden = true;
    }

    private show(...children: (Node | string | null)[]): void {
        replace(this.card, ...children);
        this.root.hidden = false;
    }

    menu(actions: MenuActions, notice?: string): void {
        const code = el("input", {
            type: "text",
            placeholder: "Room code",
            maxlength: 9,
            autocomplete: "off",
            autocapitalize: "characters",
            spellcheck: "false",
            "aria-label": "Room code",
        });
        const button = (label: string, onClick: () => void, cls = "") => {
            const b = el("button", { type: "button", class: cls }, label);
            b.addEventListener("click", onClick);
            return b;
        };
        const labels: Record<Difficulty, string> = { easy: "Easy", medium: "Medium", hard: "Hard" };
        this.show(
            el("h1", {}, "Pong", el("span", { class: "accent" }, " netcode lab")),
            el(
                "p",
                { class: "lede" },
                "Real multiplayer netcode, the way real games do it. Start a match, then open the ",
                el("strong", {}, "Network lab"),
                " to add lag and packet loss and switch each technique off to see why it exists."
            ),
            notice ? el("p", { class: "notice", role: "status" }, notice) : null,
            el("h2", {}, "Play against the computer"),
            el("div", { class: "row" }, ...DIFFICULTIES.map((d) => button(labels[d], () => actions.playBot(d), d === "medium" ? "primary" : ""))),
            el("h2", {}, "Play against a person"),
            el("div", { class: "row" }, button("Quick match", actions.quickMatch, "primary"), button("Create private room", actions.createRoom)),
            el(
                "div",
                { class: "row join" },
                code,
                button("Join", () => actions.joinRoom(code.value)),
                button("Watch", () => actions.watchRoom(code.value), "ghost")
            ),
            el("p", { class: "hint" }, "Controls: W/S or ↑/↓, the mouse, or drag on your half of the screen.")
        );
        code.addEventListener("keydown", (e) => {
            if (e.key === "Enter") actions.joinRoom(code.value);
        });
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

    constructor() {
        this.left = el("span", { class: "player" });
        this.right = el("span", { class: "player right" });
        this.score = el("span", { class: "score", "aria-live": "polite" });
        this.info = el("span", { class: "info" });
        this.labButton = el("button", { type: "button", class: "lab-toggle", "aria-expanded": "false", "aria-controls": "lab" }, "Network lab");
        this.rematchButton = el("button", { type: "button", class: "primary", hidden: true }, "Rematch");
        this.leaveButton = el("button", { type: "button", class: "ghost" }, "Leave");
        this.root = el(
            "header",
            { class: "hud", hidden: true },
            el("div", { class: "match" }, this.left, this.score, this.right),
            el("div", { class: "actions" }, this.info, this.rematchButton, this.labButton, this.leaveButton)
        );
    }

    set(left: string, right: string, score: string, info: string): void {
        if (this.left.textContent !== left) this.left.textContent = left;
        if (this.right.textContent !== right) this.right.textContent = right;
        if (this.score.textContent !== score) this.score.textContent = score;
        if (this.info.textContent !== info) this.info.textContent = info;
    }
}
