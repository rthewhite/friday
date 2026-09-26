/**
 * Module-scoped HTTP routes. A module registers handlers with `ctx.http.route`;
 * core serves them at `/api/modules/<id>/<path>`. The request and response
 * types are deliberately small and framework-free so the test host can
 * implement them in memory.
 */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface RouteRequest {
  method: HttpMethod;
  /** Path relative to the module mount, without query string. */
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  /** Parse the body as JSON; rejects on invalid JSON. Resolves `undefined` for an empty body. */
  json<T = unknown>(): Promise<T>;
  text(): Promise<string>;
}

export interface RouteResponse {
  status(code: number): RouteResponse;
  json(body: unknown): void;
  text(body: string, contentType?: string): void;
  /** True once `json` or `text` was called. */
  readonly sent: boolean;
}

export type RouteParams = Record<string, string>;
export type RouteHandler = (req: RouteRequest, res: RouteResponse, params: RouteParams) => void | Promise<void>;

export interface ModuleHttp {
  /** `path` may contain `:param` segments, e.g. `items/:id`. Leading slash optional. */
  route(method: HttpMethod, path: string, handler: RouteHandler): void;
}

export interface RouteDef {
  method: HttpMethod;
  path: string;
  handler: RouteHandler;
}

/** Compile `items/:id` into a matcher. Returns params or null. */
export function compilePath(path: string): (p: string) => RouteParams | null {
  const segs = normalizePath(path).split("/").filter(Boolean);
  return (p: string) => {
    const parts = normalizePath(p).split("/").filter(Boolean);
    if (parts.length !== segs.length) return null;
    const params: RouteParams = {};
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i], v = parts[i];
      if (s.startsWith(":")) params[s.slice(1)] = decodeURIComponent(v);
      else if (s !== v) return null;
    }
    return params;
  };
}

export function normalizePath(p: string): string {
  return "/" + p.replace(/^\/+|\/+$/g, "");
}

/** Ordered route table with matching; shared by core and the test host. */
export class RouteTable {
  private readonly routes: { def: RouteDef; match: (p: string) => RouteParams | null }[] = [];

  add(def: RouteDef): void {
    this.routes.push({ def, match: compilePath(def.path) });
  }

  /** `{ handler, params }`, `"method"` when the path matched another method only, or `null`. */
  find(method: string, path: string): { handler: RouteHandler; params: RouteParams } | "method" | null {
    let pathMatched = false;
    for (const r of this.routes) {
      const params = r.match(path);
      if (!params) continue;
      if (r.def.method === method) return { handler: r.def.handler, params };
      pathMatched = true;
    }
    return pathMatched ? "method" : null;
  }

  list(): RouteDef[] {
    return this.routes.map((r) => r.def);
  }

  clear(): void {
    this.routes.length = 0;
  }
}
