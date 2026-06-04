/**
 * Tiny shared parsing helpers for the relationship agents (Phase 5).
 *
 * Model output is untrusted text; these defensively extract a JSON object out of
 * it (tolerating ```json fences or surrounding prose) and coerce string fields.
 * Kept pure + dependency-free so every agent shares one parser and the unit tests
 * pin its behavior.
 */

/** Parse a JSON object out of a model response, tolerating ```json fences /
 *  surrounding prose. Returns null when nothing parseable is present. */
export function safeJsonObject(text: string): Record<string, unknown> | null {
  if (!text) return null;
  const trimmed = text.trim();
  const candidates: string[] = [trimmed];
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const brace = trimmed.match(/\{[\s\S]*\}/);
  if (brace?.[0]) candidates.push(brace[0]);
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

/** A trimmed non-empty string, or null. */
export function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}
