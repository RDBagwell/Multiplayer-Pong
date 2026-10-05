/**
 * Where the game server is. In development (and when the Node server serves
 * the client itself) it's the page's own origin. The GitHub Pages build sets
 * VITE_SERVER_URL to the Render service's https:// origin; see
 * scripts/build-pages.mjs.
 */
export const SERVER_URL: string | undefined = import.meta.env.VITE_SERVER_URL || undefined;
