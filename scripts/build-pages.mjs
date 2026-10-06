// Builds the client for GitHub Pages into _site/ (or $PAGES_OUT).
//
// Same approach as Chat Mafia's build-pages: the only deploy-time input is the
// GAME_SERVER_URL repository variable, and two things are generated from it:
//   1. the server address compiled into the client (VITE_SERVER_URL), and
//   2. a Content-Security-Policy <meta> tag whose connect-src allows exactly
//      that server (https:// and wss://) and nothing else.
// GitHub Pages can't send headers, so the CSP has to live in the page.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const raw = (process.env.GAME_SERVER_URL || "").trim();
if (!raw) {
    console.error("GAME_SERVER_URL is not set. Add it under Settings → Secrets and variables → Actions → Variables.");
    process.exit(1);
}
let url;
try {
    url = new URL(raw);
} catch {
    console.error(`GAME_SERVER_URL is not a valid URL: ${raw}`);
    process.exit(1);
}
if (url.protocol !== "https:") {
    console.error("GAME_SERVER_URL must start with https:// (production must use HTTPS/WSS).");
    process.exit(1);
}
// The game server is the Render service, never the Pages site itself: GitHub
// Pages serves static files only, so a page pointed at it would wait forever.
if (url.hostname === "github.io" || url.hostname.endsWith(".github.io")) {
    console.error(
        `GAME_SERVER_URL points at GitHub Pages (${url.hostname}), which can't run the game server. ` +
            "Set it to the Render service URL, e.g. https://netcode-pong-server.onrender.com."
    );
    process.exit(1);
}
const origin = url.origin; // drops any path, query or trailing slash
const wsOrigin = origin.replace(/^https:/, "wss:");
const out = path.resolve(process.env.PAGES_OUT || "_site");

// Relative asset paths (--base ./) so the site works at /<repo-name>/ whatever the repo is called.
execFileSync(process.execPath, ["node_modules/vite/bin/vite.js", "build", "--base", "./", "--outDir", out, "--emptyOutDir"], {
    stdio: "inherit",
    env: { ...process.env, VITE_SERVER_URL: origin },
});

const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' ${origin} ${wsOrigin}`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
].join("; ");

const indexPath = path.join(out, "index.html");
const html = fs.readFileSync(indexPath, "utf8");
if (/<script(?![^>]*\bsrc=)[^>]*>/.test(html)) {
    console.error("The built index.html contains an inline script, which the CSP (script-src 'self') would block.");
    process.exit(1);
}
const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}" />\n        <meta name="referrer" content="no-referrer" />`;
const updated = html.replace(/<head>/, `<head>\n        ${meta}`);
if (updated === html) {
    console.error("Could not find <head> in the built index.html.");
    process.exit(1);
}
fs.writeFileSync(indexPath, updated);
fs.writeFileSync(path.join(out, ".nojekyll"), "");
console.log(`Built ${path.relative(process.cwd(), out) || out}/ for server ${origin}`);
