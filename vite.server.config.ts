// Self-hosted build, step 2: the Node server bundled into one file,
// dist/server/server.js, with Hono and all app code inlined (only Node
// built-ins stay external), so the container needs Node and nothing else.
import { defineConfig } from "vite";

export default defineConfig({
  ssr: { noExternal: true, target: "node" },
  build: {
    ssr: "server/node.ts",
    outDir: "dist/server",
    emptyOutDir: true,
    target: "node22",
    minify: false,
    sourcemap: true,
    rollupOptions: { output: { format: "es", entryFileNames: "server.js" } },
  },
});
