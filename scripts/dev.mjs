// Starts the game server (with --watch) and the Vite dev server together.
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
const procs = [
    ["server", "npm", ["run", "dev:server"]],
    ["client", "npm", ["run", "dev:client"]],
].map(([name, cmd, args]) => {
    const child = spawn(cmd, args, { stdio: "inherit", shell: isWindows });
    child.on("exit", (code) => {
        console.log(`[dev] ${name} exited (${code ?? "signal"}); stopping.`);
        shutdown(code ?? 0);
    });
    return child;
});

let stopping = false;
function shutdown(code) {
    if (stopping) return;
    stopping = true;
    for (const child of procs) if (child.exitCode === null) child.kill("SIGTERM");
    setTimeout(() => process.exit(code), 500).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
