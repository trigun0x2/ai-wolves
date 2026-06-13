import type { RequestHandler } from "express";

/**
 * Gateway → primary reverse proxy for /api/* (control plane). Gateways serve the
 * static UI and spectator WebSockets locally (fanned via the bus) but forward all
 * API calls to the single primary, which owns the game loop, the queue (and its
 * keys, in memory), auth, the rate limiter, and the host-game cap. The real
 * client IP is forwarded so the primary's rate limiter keys on it.
 */
export function createApiProxy(primaryBase: string): RequestHandler {
  const base = primaryBase.replace(/\/$/, "");
  return async (req, res) => {
    const target = base + req.originalUrl;
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      const opToken = req.get("x-operator-token");
      if (opToken) headers["x-operator-token"] = opToken;
      const ct = req.get("content-type");
      if (ct) headers["content-type"] = ct;
      headers["x-forwarded-for"] = req.ip ?? "";

      const method = req.method.toUpperCase();
      const init: RequestInit = { method, headers };
      if (method !== "GET" && method !== "HEAD" && req.body != null) {
        init.body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
      }

      const upstream = await fetch(target, init);
      res.status(upstream.status);
      const respType = upstream.headers.get("content-type");
      if (respType) res.set("content-type", respType);
      res.send(Buffer.from(await upstream.arrayBuffer()));
    } catch (err) {
      console.error("[proxy] upstream failed:", err);
      res.status(502).json({ error: "primary unreachable" });
    }
  };
}
