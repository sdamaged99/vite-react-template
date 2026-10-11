import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = new URL(".", import.meta.url);
const ALIASES = {
  hono: new URL("hono.ts", here).href,
  "cloudflare:sockets": new URL("sockets.ts", here).href,
};

export async function resolve(specifier, context, next) {
  if (ALIASES[specifier]) return { url: ALIASES[specifier], shortCircuit: true };
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
    const base = new URL(specifier, context.parentURL);
    const p = fileURLToPath(base);
    if (!/\.[cm]?[jt]s$/.test(p) && existsSync(p + ".ts")) {
      return { url: pathToFileURL(p + ".ts").href, shortCircuit: true };
    }
  }
  return next(specifier, context);
}
