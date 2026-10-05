import { expect, test } from "@playwright/test";

test("with the server unreachable, the landing page offers offline play and a full match runs in the browser", async ({ page }) => {
    const sockets: string[] = [];
    page.on("websocket", (ws) => sockets.push(ws.url()));
    // Fake timers, so a whole match (minutes of game time) can be fast-forwarded.
    await page.clock.install();
    await page.goto("/");

    // The offer appears and online play is disabled while the server can't be reached.
    await page.clock.runFor(2_000);
    await expect(page.locator(".offer")).toBeVisible();
    await expect(page.locator(".status-text")).toContainText("Waking the server");
    await expect(page.getByRole("button", { name: "Find a match" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Play online" })).toBeDisabled();

    await page.getByRole("button", { name: "Play the computer offline" }).click();
    await expect(page.locator(".hud")).toContainText("Offline · in your browser");
    await expect(page.locator(".hud")).toContainText("Computer (medium)");

    // Play until someone reaches 7 (the player just holds still; the bot will win).
    const score = page.locator(".hud .score");
    for (let i = 0; i < 60 && !(await page.getByRole("button", { name: "Rematch" }).isVisible()); i++) {
        await page.clock.runFor(10_000);
    }
    await expect(page.getByRole("button", { name: "Rematch" })).toBeVisible();
    const [a, b] = (await score.innerText()).split(":").map((n) => Number(n.trim()));
    expect(Math.max(a, b)).toBe(7);

    // Rematch starts a fresh match, still offline.
    await page.getByRole("button", { name: "Rematch" }).click();
    await page.clock.runFor(500);
    await expect(score).toHaveText("0 : 0");

    // Only failed attempts to reach the (absent) server; the match itself never touched the network.
    for (const url of sockets) expect(url).toContain("127.0.0.1:1");
});
