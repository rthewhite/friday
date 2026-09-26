/** Tiny HTTP router for core: method + `:param` paths, JSON helpers, node adapters for module routes. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { RouteTable, type HttpMethod, type RouteHandler, type RouteRequest, type RouteResponse } from "@friday/sdk";

export type NodeHandler = (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, url: URL) => void | Promise<void>;

export class Router {
  private readonly table = new RouteTable();

  add(method: HttpMethod, path: string, handler: NodeHandler): this {
    // Node handlers get the raw objects; wrap them into the shared table's handler shape via a marker.
    this.table.add({ method, path, handler: handler as unknown as RouteHandler });
    return this;
  }

  /** True when a route handled the request (including 405). */
  async dispatch(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const hit = this.table.find(req.method ?? "GET", url.pathname);
    if (hit === null) return false;
    if (hit === "method") {
      res.statusCode = 405;
      res.end("method not allowed");
      return true;
    }
    await (hit.handler as unknown as NodeHandler)(req, res, hit.params, url);
    return true;
  }
}

export function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

export async function readBody(req: IncomingMessage, limit = 1_000_000): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new Error("body too large");
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Adapt a node request/response pair to the sdk's framework-free route shape. */
export function adaptRequest(req: IncomingMessage, url: URL, path: string): RouteRequest {
  let bodyPromise: Promise<string> | undefined;
  const text = () => (bodyPromise ??= readBody(req));
  return {
    method: (req.method ?? "GET") as HttpMethod,
    path,
    query: url.searchParams,
    headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : v])),
    text,
    json: async <T,>() => {
      const t = await text();
      return (t ? JSON.parse(t) : undefined) as T;
    },
  };
}

export function adaptResponse(res: ServerResponse): RouteResponse {
  let sent = false;
  const out: RouteResponse = {
    get sent() { return sent; },
    status(code) { res.statusCode = code; return out; },
    json(body) { sent = true; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); },
    text(body, contentType = "text/plain; charset=utf-8") { sent = true; res.setHeader("content-type", contentType); res.end(body); },
  };
  return out;
}
