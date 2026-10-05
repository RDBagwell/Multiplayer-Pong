/**
 * Captures the README screenshots with Playwright (Chromium).
 *
 *   npm run build && node --experimental-strip-types scripts/screenshots.ts
 *
 * Starts the real server on port 3200 serving client/dist, drives real
 * matches against the bot, and writes PNGs to docs/images/. The "server
 * waking" shot uses the built client with no server running behind it.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { chromium, devices, type Page } from "@playwright/test";

const OUT = "docs/images";
const PORT = 3200;
const URL = `http://localhost:${PORT}/`;
const NODE_FLAGS = ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function startServer(): ChildProcess {
    return spawn(process.execPath, [...NODE_FLAGS, "server/index.ts"], {
        env: { ...process.env, PORT: String(PORT), SERVE_CLIENT: "true", ALLOWED_ORIGINS: `http://localhost:${PORT}` },
        stdio: "ignore",
    });
}

async function waitFor(url: string): Promise<void> {
    for (let i = 0; i < 100; i++) {
        try {
            if ((await fetch(url)).ok) return;
        } catch {
            // not yet
        }
        await sleep(100);
    }
    throw new Error(`${url} did not come up`);
}

/** Holds a key for a while, then releases it, to keep the player's paddle moving. */
async function wiggle(page: Page, ms: number): Promise<void> {
    const end = Date.now() + ms;
    let key = "KeyW";
    while (Date.now() < end) {
        await page.keyboard.down(key);
        await sleep(350);
        await page.keyboard.up(key);
        key = key === "KeyW" ? "KeyS" : "KeyW";
    }
}

/**
 * Waits for the next point, then for the pause and the 3-2-1 countdown after it
 * (0.75 s + 1.5 s) and about half a second of the serve, so the shot shows the
 * ball crossing the field.
 */
async function midRally(page: Page): Promise<void> {
    const score = page.locator(".hud .score");
    const before = await score.innerText();
    for (let i = 0; i < 400 && (await score.innerText()) === before; i++) await sleep(50);
    await sleep(2800);
}

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();

// 1. Landing with the server down: the offline offer.
{
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });
    // Serve the built page from a server that has no game server behind it.
    const offline = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "preview", "--port", String(PORT + 1), "--strictPort"], { stdio: "ignore" });
    await waitFor(`http://localhost:${PORT + 1}/`);
    await page.goto(`http://localhost:${PORT + 1}/`);
    await page.locator(".offer").waitFor({ state: "visible" });
    await page.screenshot({ path: `${OUT}/landing-waking.png` });
    offline.kill();
    await page.close();
}

const server = startServer();
await waitFor(`${URL}healthz`);
try {
    // 2. Landing, server online.
    {
        const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 });
        await page.goto(URL);
        await page.locator(".dot.on").waitFor();
        await page.screenshot({ path: `${OUT}/landing.png` });
        await page.close();
    }

    // 3. The network lab: Bad Wi-Fi, "show the truth" on, mid-rally.
    {
        const page = await browser.newPage({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2 });
        await page.goto(URL);
        await page.getByRole("button", { name: "Hard" }).click();
        await page.getByRole("button", { name: "Play online" }).click();
        await page.getByRole("button", { name: "Network lab" }).click();
        await page.getByRole("button", { name: "Bad Wi-Fi" }).click();
        await page.getByLabel("Show the truth").check();
        await wiggle(page, 3000);
        await midRally(page);
        await page.screenshot({ path: `${OUT}/network-lab.png` });

        // 3b. Same match with interpolation off.
        await page.getByRole("switch", { name: "Interpolation" }).uncheck();
        await midRally(page);
        await page.screenshot({ path: `${OUT}/network-lab-interpolation-off.png` });
        await page.close();
    }

    // 4. A phone in portrait.
    {
        const context = await browser.newContext({ ...devices["iPhone 13"] });
        const page = await context.newPage();
        await page.goto(URL);
        await page.getByRole("button", { name: "Play online" }).click();
        await sleep(4000);
        await page.screenshot({ path: `${OUT}/phone.png` });
        await context.close();
    }
} finally {
    server.kill();
    await browser.close();
}
console.log(`Screenshots written to ${OUT}/`);
