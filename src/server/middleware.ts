import crypto from "node:crypto";
import type { Request, RequestHandler, Response } from "express";

/** Constant-time string compare (avoids leaking the token via timing). */
export function tokensMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Is this request authorized as the operator?
 * If no token is configured, auth is OFF (open) — frictionless local dev.
 */
export function isOperator(configured: string | undefined, provided: string | undefined): boolean {
  if (!configured) return true;
  return !!provided && tokensMatch(configured, provided);
}

/** Express guard for operator-only endpoints (start, replay, queue removal). */
export function requireOperator(getConfigured: () => string | undefined): RequestHandler {
  return (req: Request, res: Response, next) => {
    const provided =
      req.get("x-operator-token") ?? (typeof req.query.token === "string" ? req.query.token : "");
    if (isOperator(getConfigured(), provided || undefined)) {
      next();
      return;
    }
    res.status(401).json({ error: "operator token required" });
  };
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window per-IP rate limiter (in-memory; fine for a single instance).
 * Keyed by req.ip — set `app.set("trust proxy", true)` so this is the real
 * client IP behind Fly's proxy, not the proxy's.
 */
export function rateLimit({ windowMs, max }: { windowMs: number; max: number }): RequestHandler {
  const hits = new Map<string, Bucket>();
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, b] of hits) if (b.resetAt <= now) hits.delete(k);
  }, windowMs);
  sweep.unref();

  return (req: Request, res: Response, next) => {
    const key = req.ip ?? "unknown";
    const now = Date.now();
    let b = hits.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      hits.set(key, b);
    }
    b.count += 1;
    if (b.count > max) {
      res.set("Retry-After", String(Math.ceil((b.resetAt - now) / 1000)));
      res.status(429).json({ error: "too many requests — slow down" });
      return;
    }
    next();
  };
}
