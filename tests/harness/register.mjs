// Test-only module wiring: lets Node run the real Worker source without
// node_modules. "hono" and "cloudflare:sockets" resolve to small local
// stand-ins; extensionless relative imports resolve to their .ts files.
import { register } from "node:module";
register("./loader.mjs", import.meta.url);
