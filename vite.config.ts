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
            "/socket.io": { target: "ws://localhost:3000", ws: true },
        },
    },
});
