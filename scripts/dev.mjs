// Starts the game server (with --watch) and the Vite dev server together.
// Zero dependencies: two child processes sharing this terminal; Ctrl+C stops both.
import { spawn } from "node:child_process";

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
