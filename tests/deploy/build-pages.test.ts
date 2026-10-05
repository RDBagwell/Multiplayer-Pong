import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");

function build(serverUrl: string | undefined) {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "pages-"));
    const env: NodeJS.ProcessEnv = { ...process.env, PAGES_OUT: out };
    delete env.GAME_SERVER_URL;
    if (serverUrl !== undefined) env.GAME_SERVER_URL = serverUrl;
    try {
        execFileSync(process.execPath, ["scripts/build-pages.mjs"], { cwd: ROOT, env, stdio: "pipe" });
        return { ok: true as const, out };
    } catch (err) {
        return { ok: false as const, out, stderr: String((err as { stderr?: Buffer }).stderr ?? "") };
    }
}

describe("GitHub Pages build", () => {
    it("compiles in the server address and a CSP that allows only that server", { timeout: 60_000 }, () => {
        const r = build("https://netcode-pong-server.onrender.com/some/path?x=1");
        expect(r.ok).toBe(true);
        const html = fs.readFileSync(path.join(r.out, "index.html"), "utf8");
        expect(html).toContain(
            "connect-src 'self' https://netcode-pong-server.onrender.com wss://netcode-pong-server.onrender.com;"
        );
        expect(html).toMatch(/script-src 'self'/);
        expect(html).toContain('src="./assets/'); // relative paths: works under /<repo-name>/
        expect(fs.existsSync(path.join(r.out, ".nojekyll"))).toBe(true);
        const js = fs.readdirSync(path.join(r.out, "assets")).filter((f) => f.endsWith(".js"));
        const bundle = js.map((f) => fs.readFileSync(path.join(r.out, "assets", f), "utf8")).join("");
        expect(bundle).toContain("https://netcode-pong-server.onrender.com");
        expect(bundle).not.toContain("/some/path");
    });

    it("refuses a missing or non-https server URL", () => {
        const missing = build(undefined);
        expect(missing.ok).toBe(false);
        expect(missing.ok ? "" : missing.stderr).toContain("GAME_SERVER_URL is not set");
        const http = build("http://example.com");
        expect(http.ok).toBe(false);
        expect(http.ok ? "" : http.stderr).toContain("must start with https://");
    });
});
