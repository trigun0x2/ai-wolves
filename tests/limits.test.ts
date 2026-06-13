import { describe, expect, it } from "vitest";
import { withinWindowCount } from "../src/server/middleware";
import { looksLikeBillingError } from "../src/llm/errors";

describe("withinWindowCount (host-game cap)", () => {
  it("prunes timestamps outside the window and counts the rest", () => {
    const now = 1_000_000;
    const hour = 3_600_000;
    const ts = [now - hour - 1, now - hour - 100, now - 1000, now - 500];
    expect(withinWindowCount(ts, now, hour)).toBe(2); // two stale entries dropped
    expect(ts).toEqual([now - 1000, now - 500]); // mutated in place
  });

  it("enforces a cap of 5 across a rolling window", () => {
    const hour = 3_600_000;
    const ts: number[] = [];
    let now = 0;
    const tryStart = (cap: number) => {
      if (withinWindowCount(ts, now, hour) >= cap) return false;
      ts.push(now);
      return true;
    };
    // 5 within the hour succeed, the 6th is blocked
    for (let i = 0; i < 5; i++) {
      now += 60_000;
      expect(tryStart(5)).toBe(true);
    }
    now += 60_000;
    expect(tryStart(5)).toBe(false);

    // After the first start ages out of the window, one more is allowed
    now = ts[0] + hour + 1;
    expect(tryStart(5)).toBe(true);
  });
});

describe("looksLikeBillingError", () => {
  it("matches common out-of-credit / quota phrasings", () => {
    expect(looksLikeBillingError("Your credit balance is too low to access the Anthropic API")).toBe(true);
    expect(looksLikeBillingError("You exceeded your current quota, please check your plan")).toBe(true);
    expect(looksLikeBillingError("Error code: 429 - insufficient_quota")).toBe(true);
    expect(looksLikeBillingError("402 Payment Required")).toBe(true);
    expect(looksLikeBillingError("out of credits")).toBe(true);
  });

  it("does not match unrelated failures", () => {
    expect(looksLikeBillingError("model refused")).toBe(false);
    expect(looksLikeBillingError("empty completion")).toBe(false);
    expect(looksLikeBillingError("ECONNRESET")).toBe(false);
  });
});
