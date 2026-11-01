/**
 * Serves the built site (dist/client) the way Workers Static Assets did:
 * /path/ → path/index.html, /path → 301 to /path/ when that is a page folder,
 * hashed /assets/* cached for a year, HTML revalidated, unknown paths → 404.html
 * (or a plain 404). Paths can't escape the root.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { ServerResponse } from "node:http";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "SAMEORIGIN",
};

function isFile(p: string) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
function isDir(p: string) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function serveStatic(rootDir: string, pathname: string, method: string, res: ServerResponse): void {
  const root = resolve(rootDir);
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    decoded = "/";
  }
  const rel = normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  let file = join(root, rel);
  if (file !== root && !file.startsWith(root + sep)) {
    res.writeHead(400, SECURITY_HEADERS).end("Bad request");
    return;
  }
  let status = 200;
  if (decoded.endsWith("/")) {
    file = join(file, "index.html");
  } else if (!isFile(file) && isDir(file) && isFile(join(file, "index.html"))) {
    res.writeHead(301, { Location: `${pathname}/`, ...SECURITY_HEADERS }).end();
    return;
  }
  if (!isFile(file)) {
    status = 404;
    file = join(root, "404.html");
    if (!existsSync(file)) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8", ...SECURITY_HEADERS }).end("Not found");
      return;
    }
  }
  const type = TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
  const cache =
    status === 200 && rel.replace(/\\/g, "/").startsWith("/assets/")
      ? "public, max-age=31536000, immutable"
      : type.startsWith("text/html")
        ? "no-cache"
        : "public, max-age=3600";
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": statSync(file).size,
    "Cache-Control": cache,
    ...SECURITY_HEADERS,
  });
  if (method === "HEAD") {
    res.end();
    return;
  }
  createReadStream(file).pipe(res);
}
