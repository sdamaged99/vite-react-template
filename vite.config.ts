import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";

const page = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [cloudflare(), tailwindcss()],
  // The page list must apply only to the browser build; the Worker build has
  // its own entry from wrangler.jsonc and chokes on HTML inputs.
  environments: {
    client: {
      build: {
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
    },
  },
});
