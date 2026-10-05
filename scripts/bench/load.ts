/**
 * Server load test.
 *
 *   node --experimental-strip-types scripts/bench/load.ts 10,50,200
 *
 * For each room count: starts the real server in its own process (port 3100,
 * LOOP_STATS_MS=5000), starts worker processes (scripts/bench/load-worker.ts,
 * up to 100 rooms each) that play that many two-player matches over real
 * sockets, waits WARMUP_MS, then measures for MEASURE_MS:
 *
 * - server CPU, from /proc/<pid>/stat (utime + stime): 100% = one core;
 * - server memory (VmRSS from /proc/<pid>/status);
 * - the server loop's timing, from its own LOOP_STATS_MS log lines;
 * - snapshot arrival gaps as the clients saw them.
 *
 * Linux only (/proc). Prints a Markdown table row per run, and raw JSON.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

const counts = (process.argv[2] ?? "10,50,200").split(",").map(Number);
const PORT = 3100;
const WARMUP_MS = Number(process.env.WARMUP_MS ?? 10_000);
const MEASURE_MS = Number(process.env.MEASURE_MS ?? 30_000);
const ROOMS_PER_WORKER = 100;
const CLK_TCK = 100; // getconf CLK_TCK on Linux
const NODE_FLAGS = ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"];

function cpuTicks(pid: number): number {
    const fields = fs.readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].split(" ");
    return Number(fields[11]) + Number(fields[12]); // utime + stime (fields 14 and 15)
}

function rssMB(pid: number): number {
    const line = fs.readFileSync(`/proc/${pid}/status`, "utf8").split("\n").find((l) => l.startsWith("VmRSS:"))!;
    return Math.round(Number(line.split(/\s+/)[1]) / 1024);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForHealth(): Promise<void> {
    for (let i = 0; i < 100; i++) {
        try {
            if ((await fetch(`http://127.0.0.1:${PORT}/healthz`)).ok) return;
        } catch {
            // not yet
        }
        await sleep(100);
    }
    throw new Error("server did not start");
}

function collect(child: ChildProcess): string[] {
    const lines: string[] = [];
    let buf = "";
    child.stdout!.on("data", (d: Buffer) => {
        buf += d.toString();
        const parts = buf.split("\n");
        buf = parts.pop()!;
        lines.push(...parts);
    });
    child.stderr!.on("data", (d: Buffer) => process.stderr.write(d));
    return lines;
}

async function run(rooms: number) {
    const server = spawn(process.execPath, [...NODE_FLAGS, "server/index.ts"], {
        env: {
            ...process.env,
            PORT: String(PORT),
            SERVE_CLIENT: "false",
            MAX_ROOMS: String(Math.max(200, rooms + 10)),
            LOOP_STATS_MS: "5000",
            NODE_ENV: "development",
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    const serverLines = collect(server);
    await waitForHealth();
    const workerCount = Math.ceil(rooms / ROOMS_PER_WORKER);
    const workers = Array.from({ length: workerCount }, (_, w) => {
        const n = Math.min(ROOMS_PER_WORKER, rooms - w * ROOMS_PER_WORKER);
        const child = spawn(process.execPath, [...NODE_FLAGS, "scripts/bench/load-worker.ts"], {
            env: { ...process.env, URL: `http://127.0.0.1:${PORT}`, ROOMS: String(n), OFFSET: String(w * ROOMS_PER_WORKER), WARMUP_MS: String(WARMUP_MS), MEASURE_MS: String(MEASURE_MS) },
            stdio: ["ignore", "pipe", "pipe"],
        });
        return { child, lines: collect(child), done: new Promise((r) => child.on("exit", r)) };
    });

    await sleep(WARMUP_MS);
    const statsFrom = serverLines.length;
    const cpu0 = cpuTicks(server.pid!);
    const t0 = performance.now();
    await sleep(MEASURE_MS);
    const cpu1 = cpuTicks(server.pid!);
    const seconds = (performance.now() - t0) / 1000;
    const rss = rssMB(server.pid!);
    const stats = serverLines
        .slice(statsFrom)
        .filter((l) => l.includes("[STATS]"))
        .map((l) => JSON.parse(l.slice(l.indexOf("{"))));
    await Promise.all(workers.map((w) => w.done));
    server.kill("SIGTERM");
    await new Promise((r) => server.on("exit", r));

    const clients = workers.flatMap((w) => w.lines.filter((l) => l.startsWith("{")).map((l) => JSON.parse(l)));
    const max = (xs: number[]) => Math.max(0, ...xs);
    const cpuPercent = ((cpu1 - cpu0) / CLK_TCK / seconds) * 100;
    return {
        rooms,
        roomsPlaying: max(stats.map((s) => s.playing)),
        failedRooms: clients.reduce((a, c) => a + c.failedRooms, 0),
        cpuPercent: Math.round(cpuPercent * 10) / 10,
        cpuPerRoom: Math.round((cpuPercent / rooms) * 100) / 100,
        rssMB: rss,
        loopGapP99: max(stats.map((s) => s.gapP99)),
        loopGapMax: max(stats.map((s) => s.gapMax)),
        advanceP99: max(stats.map((s) => s.advanceP99)),
        maxTicksPerCall: max(stats.map((s) => s.maxTicksPerCall)),
        skippedTicks: stats.reduce((a, s) => a + s.skippedTicks, 0),
        snapshotsPerClientPerSec: Math.min(...clients.map((c) => c.snapshotsPerClientPerSec)),
        clientGapP99: max(clients.map((c) => c.gapP99)),
        clientGapMax: max(clients.map((c) => c.gapMax)),
        disconnects: clients.reduce((a, c) => a + c.disconnects, 0),
        errors: clients.reduce((a, c) => a + c.errors, 0),
    };
}

console.log(`Machine: ${os.cpus().length} × ${os.cpus()[0].model}, ${Math.round(os.totalmem() / 2 ** 30)} GB RAM, ${os.type()} ${os.release()}, Node ${process.version}`);
console.log(`Warm-up ${WARMUP_MS / 1000} s, measured ${MEASURE_MS / 1000} s per run.\n`);
console.log("| Rooms | Server CPU (1 core = 100%) | CPU per room | RSS | Loop gap p99 / max | advance() p99 | Ticks per call (max) | Skipped ticks | Snapshots/s per client | Client gap p99 / max |");
console.log("|---|---|---|---|---|---|---|---|---|---|");
const results = [];
for (const n of counts) {
    const r = await run(n);
    results.push(r);
    console.log(
        `| ${r.rooms}${r.failedRooms ? ` (${r.failedRooms} failed)` : ""} | ${r.cpuPercent}% | ${r.cpuPerRoom}% | ${r.rssMB} MB | ${r.loopGapP99} / ${r.loopGapMax} ms | ${r.advanceP99} ms | ${r.maxTicksPerCall} | ${r.skippedTicks} | ${r.snapshotsPerClientPerSec} | ${r.clientGapP99} / ${r.clientGapMax} ms |`
    );
    await sleep(2000);
}
console.log("\n" + JSON.stringify(results, null, 2));
