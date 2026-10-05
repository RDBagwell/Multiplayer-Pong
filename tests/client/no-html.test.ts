import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const CLIENT = path.resolve(import.meta.dirname, "../../client");

function sources(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) return e.name === "dist" ? [] : sources(p);
        return /\.(ts|html)$/.test(e.name) ? [p] : [];
    });
}

describe("client DOM safety", () => {
    it("never parses strings as HTML and has no inline scripts or handlers", () => {
        const files = sources(CLIENT);
        expect(files.length).toBeGreaterThan(10);
        const inCode = [/\.innerHTML\b/, /\.outerHTML\b/, /insertAdjacentHTML/, /document\.write/, /\beval\(/, /new Function\(/];
        const inHtml = [/\son[a-z]+\s*=/i, /<script(?![^>]*\bsrc=)[^>]*>/];
        for (const file of files) {
            const text = fs.readFileSync(file, "utf8");
            for (const pattern of file.endsWith(".html") ? inHtml : inCode) {
                expect(text, `${file} matches ${pattern}`).not.toMatch(pattern);
            }
        }
    });
});
