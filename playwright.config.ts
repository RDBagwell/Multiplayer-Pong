import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests in a real browser. The client is built pointing at a server
 * address where nothing listens (127.0.0.1:1), so these run exactly what a
 * visitor sees while the game server is down or asleep.
 */
export default defineConfig({
    testDir: "tests/e2e",
    testMatch: "*.spec.ts",
    timeout: 120_000,
    reporter: [["list"]],
    use: { baseURL: "http://127.0.0.1:4173", trace: "retain-on-failure" },
    projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
    webServer: {
        command: "npx vite build --outDir dist-e2e --emptyOutDir && npx vite preview --outDir dist-e2e --host 127.0.0.1 --port 4173 --strictPort",
        url: "http://127.0.0.1:4173",
        env: { VITE_SERVER_URL: "http://127.0.0.1:1" },
        reuseExistingServer: false,
        timeout: 120_000,
    },
});
