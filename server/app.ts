import fs from "node:fs";
import http from "node:http";
import { fileURLToPath } from "node:url";
import express, { type Request } from "express";
import helmet from "helmet";
import { Server } from "socket.io";
import { loadConfig, type Config } from "./config.ts";
import { RoomManager, type Clock } from "./rooms/RoomManager.ts";
import { SocketController, type QuickEntry } from "./sockets/SocketController.ts";

export const CLIENT_DIST = fileURLToPath(new URL("../client/dist", import.meta.url));

export type Log = (level: string, message: string) => void;

export function defaultLog(level: string, message: string): void {
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`;
    if (level === "error") console.error(line);
    else console.log(line);
}

export interface ServerOptions {
    config?: Config;
    log?: Log;
    /** Inject a virtual clock (tests, the netcode harness). */
    clock?: Clock;
    /** false: don't run the loop timer; the caller drives `manager.advance()` itself. */
    autoStart?: boolean;
    /** Deterministic match seeds and bot randomness for tests. */
    seed?: () => number;
    botRandom?: () => number;
}

/**
 * Builds the HTTP + Socket.io server without listening, so tests can start
 * isolated instances.
 */
export function createServer({ config = loadConfig(), log = defaultLog, clock, autoStart = true, seed, botRandom }: ServerOptions = {}) {
    const allowed = new Set(config.allowedOrigins);
    const app = express();
    app.disable("x-powered-by");
    if (config.trustProxyHops) app.set("trust proxy", config.trustProxyHops);

    app.use(
        helmet({
            contentSecurityPolicy: {
                useDefaults: false,
                directives: {
                    defaultSrc: ["'self'"],
                    scriptSrc: ["'self'"],
                    styleSrc: ["'self'"],
                    imgSrc: ["'self'", "data:"],
                    connectSrc: ["'self'", sameHostWebSocket],
                    fontSrc: ["'self'"],
                    objectSrc: ["'none'"],
                    baseUri: ["'none'"],
                    formAction: ["'none'"],
                    frameAncestors: ["'none'"],
                    ...(config.isProduction ? { upgradeInsecureRequests: [] } : {}),
                },
            },
            referrerPolicy: { policy: "no-referrer" },
            strictTransportSecurity: config.isProduction ? { maxAge: 31536000 } : false,
            xFrameOptions: { action: "deny" },
        })
    );

    // CORS: only allow-listed origins, never "*".
    app.use((req, res, next) => {
        const origin = req.headers.origin;
        if (origin && allowed.has(origin)) {
            res.setHeader("Access-Control-Allow-Origin", origin);
            res.setHeader("Vary", "Origin");
            res.setHeader("Access-Control-Allow-Methods", "GET");
        }
        if (req.method === "OPTIONS") return void res.sendStatus(204);
        next();
    });

    app.get("/healthz", (_req, res) => void res.json({ ok: true }));
    if (config.serveClient && fs.existsSync(CLIENT_DIST)) {
        app.use(express.static(CLIENT_DIST, { index: "index.html", dotfiles: "ignore" }));
    }
    app.use((_req, res) => void res.status(404).type("text/plain").send("Not found"));
    app.use((err: Error, _req: Request, res: express.Response, _next: express.NextFunction) => {
        log("error", `http error: ${err?.message}`);
        res.status(500).type("text/plain").send("Server error");
    });

    const httpServer = http.createServer(app);
    const io = new Server(httpServer, {
        serveClient: false,
        transports: ["websocket"],
        maxHttpBufferSize: config.maxHttpBufferSize,
        cors: { origin: [...allowed], methods: ["GET", "POST"] },
        // WebSocket upgrades are not covered by CORS, so check Origin here too.
        allowRequest: (req, callback) => callback(null, allowed.has(String(req.headers.origin))),
    });

    const manager = new RoomManager<QuickEntry>(config, {
        broadcast: (channel, event, payload) => io.to(channel).emit(event, payload),
        log,
        clock,
        seed,
        botRandom,
    });
    const sockets = new SocketController(io, manager, config, log);
    if (autoStart) manager.start();

    return {
        app,
        httpServer,
        io,
        manager,
        config,
        listen(port = config.port): Promise<number> {
            return new Promise((resolve) =>
                httpServer.listen(port, () => {
                    const address = httpServer.address();
                    resolve(typeof address === "object" && address ? address.port : port);
                })
            );
        },
        async close(): Promise<void> {
            manager.stop();
            sockets.stop();
            await new Promise<void>((resolve) => io.close(() => resolve()));
        },
    };
}

export type GameServer = ReturnType<typeof createServer>;

/** Lets the page served by this server open a WebSocket back to the same host. */
function sameHostWebSocket(req: http.IncomingMessage): string {
    const host = String(req.headers.host || "");
    if (!/^[A-Za-z0-9.:[\]-]{1,255}$/.test(host)) return "'self'";
    const secure = (req as Request).secure ?? false;
    return `${secure ? "wss" : "ws"}://${host}`;
}
