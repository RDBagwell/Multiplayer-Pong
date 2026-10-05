// Starts the game server (with --watch) and, once it is listening, the Vite dev server.
// Zero dependencies: two child processes sharing this terminal; Ctrl+C stops both.
import { spawn } from "node:child_process";

// The server's .ts files run on Node's built-in type stripping (22.6+, flag-free from 22.18);
// Vite 8 needs 22.12+. Fail clearly here rather than leave Vite proxying to a server that never started.
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
    console.error(`[dev] Node ${process.versions.node} is too old: this project needs Node 22.12 or later.`);
    process.exit(1);
}

const isWindows = process.platform === "win32";
const port = Number(process.env.PORT) || 3000;
const procs = [];
let stopping = false;

function start(name, script) {
    const child = spawn("npm", ["run", script], { stdio: "inherit", shell: isWindows });
    child.on("exit", (code) => {
        console.log(`[dev] ${name} exited (${code ?? "signal"}); stopping.`);
        shutdown(code ?? 0);
    });
    procs.push(child);
}

function shutdown(code) {
    if (stopping) return;
    stopping = true;
    for (const child of procs) if (child.exitCode === null) child.kill("SIGTERM");
    setTimeout(() => process.exit(code), 500).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

/** Resolves once the game server answers /healthz, so Vite never proxies to a port nobody listens on yet. */
async function waitForServer(timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (!stopping && Date.now() < deadline) {
        try {
            const res = await fetch(`http://127.0.0.1:${port}/healthz`);
            if (res.ok) return true;
        } catch {
            // Not listening yet.
        }
        await new Promise((r) => setTimeout(r, 200));
    }
    return false;
}

start("server", "dev:server");
if (await waitForServer()) {
    start("client", "dev:client");
} else if (!stopping) {
    console.error(`[dev] The game server didn't start on port ${port} within 30 s; see the errors above.`);
    shutdown(1);
}
