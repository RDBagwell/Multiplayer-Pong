import { createServer, defaultLog } from "./app.ts";
import { loadConfig } from "./config.ts";

// Node 22 can read a .env file without a dependency.
try {
    process.loadEnvFile();
} catch {
    // No .env file: use the real environment.
}

const config = loadConfig();
const server = createServer({ config });
const port = await server.listen(config.port);
defaultLog("info", `Pong server listening on port ${port}`);
defaultLog("info", `Allowed origins: ${config.allowedOrigins.join(", ")}`);
defaultLog("info", `Snapshots: ${config.snapshotRate} Hz. Lag compensation: ${config.lagCompensation ? `on (max ${config.lagCompensationMaxMs} ms)` : "off"}`);

process.on("uncaughtException", (err) => defaultLog("error", `uncaught: ${err?.stack || err}`));
process.on("unhandledRejection", (err) => defaultLog("error", `unhandled rejection: ${(err as Error)?.stack || err}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, async () => {
        await server.close();
        process.exit(0);
    });
}
