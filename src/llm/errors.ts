/**
 * Heuristic: does this LLM error message mean the key is out of credits/quota
 * (vs. a transient rate limit or a normal failure)? Covers the common provider
 * phrasings — Anthropic "credit balance is too low", OpenAI "insufficient_quota"
 * / "exceeded your current quota", OpenRouter 402 "payment required".
 */
const BILLING_PATTERNS = [
  /credit balance is too low/i,
  /insufficient[_\s]?quota/i,
  /exceeded your current quota/i,
  /payment required/i,
  /402/,
  /out of (credits|tokens)/i,
  /billing/i,
  /quota/i,
];

export function looksLikeBillingError(message: string): boolean {
  return BILLING_PATTERNS.some((re) => re.test(message));
}
