// Minimal stand-in for the subset of Hono the Worker uses. Test-only.
type Handler = (c: Ctx, next: () => Promise<void>) => Promise<Response | void> | Response | void;
interface Route { method: string; pattern: string; handler: Handler }

class Ctx {
  env: any;
  private vars = new Map<string, unknown>();
  private extraHeaders = new Headers();
  params: Record<string, string> = {};
  res: Response | undefined;
  constructor(public request: Request, env: any) { this.env = env; }
  get req() {
    const r = this.request;
    const self = this;
    return {
      url: r.url,
      raw: r,
      method: r.method,
      json: () => r.clone().json(),
      param: (k: string) => self.params[k],
      header: (k: string) => r.headers.get(k) ?? undefined,
    };
  }
  get(k: string) { return this.vars.get(k); }
  set(k: string, v: unknown) { this.vars.set(k, v); }
  header(k: string, v: string) { this.extraHeaders.set(k, v); }
  json(obj: unknown, status = 200) {
    const h = new Headers(this.extraHeaders);
    h.set("content-type", "application/json");
    return new Response(JSON.stringify(obj), { status, headers: h });
  }
}

function match(pattern: string, path: string): Record<string, string> | null {
  if (pattern === "*" || pattern === "/*") return {};
  const a = pattern.split("/").filter(Boolean);
  const b = path.split("/").filter(Boolean);
  if (a.length !== b.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.startsWith(":")) out[a[i]!.slice(1)] = decodeURIComponent(b[i]!);
    else if (a[i] !== b[i]) return null;
  }
  return out;
}

export class Hono<_T = unknown> {
  routes: Route[] = [];
  private nf: Handler = (c) => c.json({ error: "Not found" }, 404);
  private err: (e: unknown, c: Ctx) => Response = (_e, c) => c.json({ error: "Internal error" }, 500);
  private add(method: string, pattern: string, handler: Handler) { this.routes.push({ method, pattern, handler }); return this; }
  get(p: string, h: Handler) { return this.add("GET", p, h); }
  post(p: string, h: Handler) { return this.add("POST", p, h); }
  delete(p: string, h: Handler) { return this.add("DELETE", p, h); }
  use(p: string, h: Handler) { return this.add("USE", p, h); }
  route(prefix: string, sub: Hono) {
    for (const r of sub.routes) {
      const pat = r.pattern === "*" ? `${prefix}/*` : prefix + r.pattern;
      this.routes.push({ ...r, pattern: pat, prefix } as Route & { prefix: string });
    }
    return this;
  }
  notFound(h: Handler) { this.nf = h; }
  onError(h: (e: unknown, c: Ctx) => Response) { this.err = h; }
  fetch = async (request: Request, env: any): Promise<Response> => {
    const c = new Ctx(request, env);
    const path = new URL(request.url).pathname;
    const chain: { h: Handler; params: Record<string, string> }[] = [];
    for (const r of this.routes) {
      if (r.method === "USE") {
        const pre = (r as any).prefix ?? "";
        if (r.pattern.endsWith("/*") ? path.startsWith(r.pattern.slice(0, -1)) || path === pre : !!match(r.pattern, path))
          chain.push({ h: r.handler, params: {} });
      } else if (r.method === request.method) {
        const p = match(r.pattern, path);
        if (p) { chain.push({ h: r.handler, params: p }); break; }
      }
    }
    if (!chain.some((x) => !this.routes.find((r) => r.handler === x.h && r.method === "USE"))) chain.push({ h: this.nf, params: {} });
    try {
      let i = -1;
      let out: Response | undefined;
      const run = async (idx: number): Promise<void> => {
        if (idx <= i) throw new Error("next() called twice");
        i = idx;
        const step = chain[idx];
        if (!step) return;
        c.params = step.params;
        const r = await step.h(c, () => run(idx + 1));
        if (r instanceof Response && !out) out = r;
      };
      await run(0);
      return out ?? c.json({ error: "No response" }, 500);
    } catch (e) {
      return this.err(e, c);
    }
  };
}
export type MiddlewareHandler<_T = unknown> = Handler;

export type Context<_T = unknown> = any;
