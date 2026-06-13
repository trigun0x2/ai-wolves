import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { isOperator, tokensMatch, requireOperator, rateLimit } from "../src/server/middleware";

describe("operator auth", () => {
  it("tokensMatch is exact and length-safe", () => {
    expect(tokensMatch("abc", "abc")).toBe(true);
    expect(tokensMatch("abc", "abd")).toBe(false);
    expect(tokensMatch("abc", "abcd")).toBe(false);
    expect(tokensMatch("", "")).toBe(true);
  });

  it("isOperator: open when unconfigured, exact when configured", () => {
    expect(isOperator(undefined, undefined)).toBe(true); // auth disabled
    expect(isOperator(undefined, "anything")).toBe(true);
    expect(isOperator("secret", "secret")).toBe(true);
    expect(isOperator("secret", "wrong")).toBe(false);
    expect(isOperator("secret", undefined)).toBe(false);
  });

  it("requireOperator passes/blocks based on the header", () => {
    const next = vi.fn();
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
    const mk = (hdr?: string) =>
      ({ get: (h: string) => (h === "x-operator-token" ? hdr : undefined), query: {} }) as unknown as Request;

    // configured + correct → next()
    requireOperator(() => "secret")(mk("secret"), res, next);
    expect(next).toHaveBeenCalledTimes(1);

    // configured + wrong → 401
    requireOperator(() => "secret")(mk("nope"), res, next);
    expect(res.status).toHaveBeenCalledWith(401);

    // unconfigured → next() regardless
    const next2 = vi.fn();
    requireOperator(() => undefined)(mk(undefined), res, next2);
    expect(next2).toHaveBeenCalledTimes(1);
  });
});

describe("rateLimit", () => {
  it("allows up to max then 429s, per IP", () => {
    const limiter = rateLimit({ windowMs: 60_000, max: 3 });
    const calls: number[] = [];
    const run = (ip: string) => {
      const next = vi.fn();
      const res = {
        set: vi.fn(),
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      } as unknown as Response;
      limiter({ ip } as Request, res, next);
      calls.push((res.status as ReturnType<typeof vi.fn>).mock.calls.length ? 429 : 200);
    };

    run("1.1.1.1");
    run("1.1.1.1");
    run("1.1.1.1");
    run("1.1.1.1"); // 4th → blocked
    expect(calls).toEqual([200, 200, 200, 429]);

    // A different IP has its own bucket.
    const next = vi.fn();
    const res = { set: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
    limiter({ ip: "2.2.2.2" } as Request, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});
