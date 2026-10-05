declare module "*.css";

interface ImportMetaEnv {
    /** The game server's https:// origin, set by the GitHub Pages build. Empty: same origin (development). */
    readonly VITE_SERVER_URL?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
