// Self-hosted build, step 1: the static site into dist/client (same pages as
// the Cloudflare build, without the Cloudflare plugin).
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";

const page = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [tailwindcss()],
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: page("index.html"),
        terms: page("terms/index.html"),
        instructions: page("instructions/index.html"),
        privacy: page("privacy/index.html"),
        admin: page("admin/index.html"),
      },
    },
  },
});
