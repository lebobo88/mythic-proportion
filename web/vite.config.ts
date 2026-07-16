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
export default defineConfig({
  plugins: [react()],
  base: "/app/",
  build: {
    outDir: "../src/mythic_proportion/web/static_next",
    emptyOutDir: true,
  },
});
