/**
 * Headless netcode harness.
 *
 * Runs the real server (Express + Socket.io + rooms) and any number of real
 * clients (socket.io-client + the browser's GameClient, minus the DOM) in
 * one process, with each client behind its own simulated network.
 *
 * Time is virtual: the harness owns a clock that the server's rooms, the
 * clients' netcode and their network simulators all read, and advances it in
 * fixed steps. Between steps it yields to the event loop so real socket
 * traffic flows. That makes a two-minute match run in a few seconds, and
 * keeps simulated latency independent of how busy the test machine is.
 * Real transport time over loopback is not zero, so a message can slip by
 * one step; at the default 8 ms step that adds at most a few ms of virtual
 * latency.
 *
 * Reusable for load tests: `addClient` as many clients as needed, in as many
 * rooms as needed, and read `server.manager` for server-side state.
 */
import { io as ioClient } from "socket.io-client";
import { Connection } from "../../client/src/net/Connection.ts";
import { NetworkSimulator, PERFECT_NETWORK, type NetworkConditions } from "../../client/src/net/NetworkSimulator.ts";
import { Session, memoryTokenStore } from "../../client/src/net/Session.ts";
import { ALL_ON, GameClient, type ClientView, type NetcodeToggles } from "../../client/src/netcode/GameClient.ts";
import { nextRandom } from "../../shared/rng.ts";
import { ORIGIN, startServer, type TestServerOptions } from "../helpers.ts";

export function seededRandom(seed: number): () => number {
    let s = seed >>> 0 || 1;
    return () => {
        const r = nextRandom(s);
        s = r.state;
        return r.value;
    };
}

export class VirtualClock {
    t = 1_000;
    readonly now = (): number => this.t;
}

export interface HarnessClient {
    name: string;
    netsim: NetworkSimulator;
    connection: Connection;
    session: Session;
    game: GameClient;
    /** The view from the last step (what a browser would have drawn). */
    view: ClientView | null;
    /** Every render tick it drew, in order. */
    renderTicks: number[];
    close(): void;
}

export interface HarnessOptions {
    seed?: number;
    /** Virtual milliseconds per step. Browsers run the client loop about every 4 ms and render every 7–17 ms. */
    stepMs?: number;
    server?: Omit<TestServerOptions, "clock" | "autoStart">;
}

export async function createHarness(options: HarnessOptions = {}) {
    const clock = new VirtualClock();
    const stepMs = options.stepMs ?? 8;
    const seed = options.seed ?? 1;
    const env = await startServer({ seed: () => seed, botRandom: seededRandom(seed + 1), ...options.server, clock, autoStart: false });
    const clients: HarnessClient[] = [];

    async function addClient(name: string, conditions: NetworkConditions = PERFECT_NETWORK, toggles: NetcodeToggles = ALL_ON): Promise<HarnessClient> {
        const socket = ioClient(env.url, { transports: ["websocket"], forceNew: true, reconnection: false, extraHeaders: { origin: ORIGIN } });
        const netsim = new NetworkSimulator(conditions, seededRandom(seed * 1000 + clients.length + 7));
        const connection = new Connection(socket, netsim, clock.now);
        const session = new Session(connection, memoryTokenStore());
        const game = new GameClient(connection, toggles);
        const client: HarnessClient = { name, netsim, connection, session, game, view: null, renderTicks: [], close: () => socket.disconnect() };
        clients.push(client);
        await new Promise<void>((resolve, reject) => {
            socket.once("connect", () => resolve());
            socket.once("connect_error", reject);
        });
        return client;
    }

    const flush = async () => {
        for (let i = 0; i < 4; i++) await new Promise<void>((r) => setImmediate(r));
    };

    /** Advances virtual time by one step: server loop, then every client's update and render. */
    async function step(): Promise<void> {
        clock.t += stepMs;
        env.server.manager.advance(clock.t);
        for (const c of clients) {
            c.game.update(clock.t);
            c.view = c.game.view(clock.t);
            if (c.view) c.renderTicks.push(c.view.renderTick);
        }
        await flush();
    }

    /** Runs for `ms` of virtual time, or until `until()` is true. Returns true if `until` was met. */
    async function run(ms: number, until?: () => boolean): Promise<boolean> {
        const end = clock.t + ms;
        while (clock.t < end) {
            if (until?.()) return true;
            await step();
        }
        return until ? until() : true;
    }

    /** Waits (in virtual time) for a promise that depends on server replies, e.g. a session request. */
    async function settle<T>(promise: Promise<T>, maxMs = 2_000): Promise<T> {
        let done = false;
        let value: T;
        promise.then((v) => {
            done = true;
            value = v;
        });
        const end = clock.t + maxMs;
        while (!done && clock.t < end) await step();
        if (!done) throw new Error("request did not settle");
        return value!;
    }

    async function close(): Promise<void> {
        for (const c of clients) c.close();
        await env.close();
    }

    return { clock, env, server: env.server, clients, addClient, step, run, settle, close };
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;

/**
 * A simple scripted player for harness clients: it watches the ball in its
 * own (interpolated) view, as a person would, and steers towards where it
 * is, with an aiming error drawn per shot so that it misses sometimes.
 */
export function scriptedPlayer(client: HarnessClient, random: () => number, aimError = 40): (paddleY: number) => number {
    let shot = "";
    let error = 0;
    return (paddleY) => {
        const view = client.view;
        const seat = client.game.seat;
        if (!view || seat === -1) return 0;
        const incoming = view.phase === "playing" && (seat === 0 ? view.truth.ball.vx < 0 : view.truth.ball.vx > 0);
        const key = `${view.truth.rally}:${view.truth.hits}`;
        if (key !== shot) {
            shot = key;
            error = (random() * 2 - 1) * aimError;
        }
        const target = incoming ? view.ball.y + error : 250;
        const delta = target - paddleY;
        if (Math.abs(delta) < 4) return 0;
        return Math.max(-8, Math.min(8, Math.round((delta / 9) * 8)));
    };
}
