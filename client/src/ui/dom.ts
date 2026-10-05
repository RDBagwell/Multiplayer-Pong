/**
 * The only way the client creates DOM. Text is always set with textContent,
 * never parsed as HTML, and only a short list of attributes is allowed (no
 * href, src or on* handlers). tests/client/no-html.test.ts checks that
 * nothing in the client uses innerHTML or friends.
 */

const ALLOWED_ATTRIBUTES = new Set([
    "class",
    "id",
    "type",
    "role",
    "title",
    "for",
    "name",
    "value",
    "min",
    "max",
    "step",
    "placeholder",
    "maxlength",
    "autocomplete",
    "autocapitalize",
    "spellcheck",
    "inputmode",
    "tabindex",
    "disabled",
    "readonly",
    "checked",
    "hidden",
    "aria-label",
    "aria-describedby",
    "aria-expanded",
    "aria-controls",
    "aria-pressed",
    "aria-live",
    "aria-hidden",
    "data-preset",
]);

export type Child = Node | string | number | null | undefined | false;
export type Attrs = Record<string, string | number | boolean | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs)) {
        if (value === undefined || value === false) continue;
        if (!ALLOWED_ATTRIBUTES.has(name)) throw new Error(`attribute not allowed: ${name}`);
        node.setAttribute(name, value === true ? "" : String(value));
    }
    append(node, ...children);
    return node;
}

export function append(parent: Node, ...children: Child[]): void {
    for (const child of children) {
        if (child === null || child === undefined || child === false) continue;
        parent.appendChild(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
    }
}

/** Replaces all children. */
export function replace(parent: Node, ...children: Child[]): void {
    while (parent.firstChild) parent.removeChild(parent.firstChild);
    append(parent, ...children);
}

export function setText(node: Node, text: string): void {
    if (node.textContent !== text) node.textContent = text;
}
