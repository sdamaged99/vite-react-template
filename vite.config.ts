import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";

const page = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [cloudflare(), tailwindcss()],
  build: {
    rollupOptions: {
      external: [/^cloudflare:/],
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
