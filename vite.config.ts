import { resolve } from "node:path";
import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [cloudflare(), tailwindcss()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        terms: resolve(__dirname, "terms/index.html"),
        instructions: resolve(__dirname, "instructions/index.html"),
        privacy: resolve(__dirname, "privacy/index.html"),
        admin: resolve(__dirname, "admin/index.html"),
      },
    },
  },
});
