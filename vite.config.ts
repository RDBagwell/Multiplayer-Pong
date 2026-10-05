import { defineConfig } from "vite";

// The client lives in client/; in development Vite serves it on 5173 and
// forwards the Socket.io WebSocket to the game server on 3000.
export default defineConfig({
    root: "client",
    build: {
        outDir: "dist",
        emptyOutDir: true,
        target: "es2022",
    },
    server: {
        port: 5173,
        strictPort: true,
        proxy: {
            // 127.0.0.1, not localhost: localhost can resolve to IPv6 (::1) while the
            // server is only reachable on IPv4, which shows up as "ECONNREFUSED ::1:3000".
            "/socket.io": { target: `ws://127.0.0.1:${Number(process.env.PORT) || 3000}`, ws: true },
        },
    },
});
