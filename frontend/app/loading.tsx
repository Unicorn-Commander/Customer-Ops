/**
 * Global route-transition fallback. Next renders this while a route segment's
 * data/code resolves (Suspense boundary). Kept calm + on-brand: the cockpit's
 * radar mark over the ambient field, with the spinner ring the AppShell already
 * uses so navigations feel continuous rather than blank. Reduced-motion safe via
 * the global `.co-app *` guard in theme.css.
 */
export default function Loading() {
  return (
    <div className="co-ambient co-ambient-grid grid min-h-screen place-items-center px-6">
      <div className="relative flex flex-col items-center gap-5 text-center">
        <span aria-hidden className="co-glow absolute -inset-6 h-[120px] w-[120px]" />
        <span className="relative grid h-14 w-14 place-items-center">
          <img src="/brand-mark.png" alt="Customer-Ops" className="h-14 w-14 rounded-[16px] shadow-glow" />
          <span
            aria-hidden
            className="absolute -inset-1.5 rounded-[18px] border-2 border-accent/30 border-t-accent motion-safe:animate-spin"
          />
        </span>
        <p className="text-sm text-tertiary" role="status">
          Loading your cockpit…
        </p>
      </div>
    </div>
  );
}
