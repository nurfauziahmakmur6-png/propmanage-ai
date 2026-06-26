// Categories that must never get an auto-drafted reply — they touch money, contracts, or
// legal exposure, where a wrong AI answer is costly. These escalate to a human instead.
const SENSITIVE_CATEGORIES = new Set([
  "rent",
  "payment",
  "payments",
  "money",
  "billing",
  "deposit",
  "lease",
  "contract",
  "legal",
  "eviction",
  "notice",
  "arrears",
  "insurance",
]);

const SENSITIVE_PATTERNS: RegExp[] = [
  /\bevict(ion|ed|ing)?\b/i,
  /\b(lawsuit|legal action|sue\b|suing|court|attorney|lawyer|solicitor)\b/i,
  /\b(withhold(ing)?|unpaid|overdue|late)\s+rent\b/i,
  /\brent\s+(arrears|owed|owing)\b/i,
  /\bdeposit\s+(dispute|back|refund|return)\b/i,
  /\bterminate\s+(the\s+)?(lease|contract|tenancy|agreement)\b/i,
  /\bbreach\s+of\s+(contract|lease|tenancy)\b/i,
  /\bnotice\s+to\s+(quit|vacate|leave)\b/i,
  /\b(compensation|refund|reimburse|chargeback)\b/i,
];

/**
 * A ticket is sensitive if its category is one of the restricted set, or the tenant's
 * message text matches a money/contract/legal pattern. Enforced in code (not just the
 * prompt) so the guardrail holds regardless of what the model decides to call.
 */
export function isSensitive(category: string | null | undefined, text: string): boolean {
  if (category && SENSITIVE_CATEGORIES.has(category.trim().toLowerCase())) return true;
  return SENSITIVE_PATTERNS.some((re) => re.test(text));
}
