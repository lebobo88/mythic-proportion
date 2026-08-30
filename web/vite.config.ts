import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite config for the greenfield Mythic Proportion frontend.
//
// - `base: "/app/"` matches the FastAPI mount point added in Phase 0
//   (`src/mythic_proportion/web/app.py` mounts this build's output at
//   `/app`). The legacy vanilla-JS SPA continues to be served at `/` from
//   `src/mythic_proportion/web/static/` — this build does NOT touch that
//   directory (parity requirement, see specs/parity-checklist.md).
// - `build.outDir` points at a NEW directory, `static_next`, sibling to the
//   legacy `static/`, so the two builds never collide.
// - `server.proxy` forwards `/api` to the FastAPI backend that `scripts/dev.ps1`
//   boots over the dev vault. Every call in `src/lib/api.ts` is a *relative*
//   fetch (`/api/search`, `/api/upload`, ...), so without this proxy they 404
//   against Vite itself and the dev server is frontend-only. The browser origin
//   stays `http://localhost:5173`, which is in the backend's `ALLOWED_ORIGINS`
//   allowlist, so the CSRF origin check on mutating POSTs still passes.
// - `strictPort` deliberately fails loudly instead of drifting to 5174+: a
//   drifting port is how orphaned dev servers accumulated across sessions
//   (see HANDOFF.md, "clean single-server environment").
const apiTarget = process.env.MYTHIC_DEV_API ?? "http://127.0.0.1:8766";

export default defineConfig({
  plugins: [react()],
  base: "/app/",
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: "../src/mythic_proportion/web/static_next",
    emptyOutDir: true,
  },
});
