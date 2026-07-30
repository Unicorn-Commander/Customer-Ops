import { AsyncLocalStorage } from 'async_hooks';

/**
 * REQUEST-SCOPED memo store for the server-side entitlement resolver.
 *
 * WHY THIS EXISTS — `WorkspaceContextService.effectiveEntitlements` has a dozen
 * production call sites (customers.service x5, the five relationship agents, the
 * relations officer, plus the PAT chokepoint), and the JWT/session lane
 * deliberately passes `maxAgeMs: 0` so an operator pin edit lands on the very
 * next request. Those two facts together turned ONE inbound API request into a
 * dozen outbound entitlement fetches (each with a 5s timeout) and a dozen
 * `workspace_entitlements` UPSERTs.
 *
 * The fix is NOT a time-based TTL on that lane — that would re-open the
 * staleness window the `maxAgeMs: 0` default exists to close. It is a memo whose
 * lifetime is exactly ONE REQUEST: the first call for a workspace does the source
 * read, every later call in the same request reuses that in-flight promise, and
 * the NEXT request starts with an empty store and reads the source again.
 *
 *   one resolve per workspace per request  —  zero cross-request staleness
 *
 * Established by RequestContextMiddleware (already applied to `*`, and it runs
 * before guards/interceptors, so the PAT chokepoint is inside the scope too).
 * Outside an HTTP request (cron jobs, boot-time work, unit tests that don't opt
 * in) there is NO store and the resolver behaves exactly as it did before —
 * per-call, bounded only by its own process cache.
 *
 * Values are stored as `unknown` promises so this file stays dependency-free and
 * cannot form an import cycle with the resolver that owns the value type.
 */
const storage = new AsyncLocalStorage<Map<string, Promise<unknown>>>();

/**
 * Run `fn` inside a fresh entitlement memo scope. Anything awaited (transitively)
 * inside `fn` sees the same store; anything outside sees none.
 */
export function runInEntitlementRequestScope<T>(fn: () => T): T {
  return storage.run(new Map<string, Promise<unknown>>(), fn);
}

/** The active request's memo store, or undefined when not inside a request. */
export function entitlementRequestScope(): Map<string, Promise<unknown>> | undefined {
  return storage.getStore();
}
