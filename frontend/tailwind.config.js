/** @type {import('tailwindcss').Config} */
// Customer-Ops design system. Structural base ported from the Listing-Ops token
// system (RGB channel triplets wired as `rgb(var(--token) / <alpha-value>)`, so
// Tailwind opacity modifiers — `bg-accent/12`, `ring-accent/60` — compile to real
// rgba at every call site). All tokens are namespaced `--co-*` so they never
// collide with the legacy globals.css vars the not-yet-migrated leaf pages use.
// Richer than Listing-Ops on purpose: a stage palette + a colorful per-feature
// icon palette (the cockpit reads as color, not one calm violet).
const triplet = (v) => `rgb(var(${v}) / <alpha-value>)`;

module.exports = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "ui-sans-serif", "system-ui", "-apple-system", "BlinkMacSystemFont",
          "Segoe UI", "Roboto", "Helvetica", "Arial", "sans-serif",
        ],
        mono: ["ui-monospace", "SFMono-Regular", "SF Mono", "Menlo", "Consolas", "monospace"],
      },
      colors: {
        surface: {
          base: triplet("--co-surface-base"),
          raised: triplet("--co-surface-raised"),
          overlay: triplet("--co-surface-overlay"),
          elevated: triplet("--co-surface-elevated"),
        },
        primary: triplet("--co-text-primary"),
        secondary: triplet("--co-text-secondary"),
        tertiary: triplet("--co-text-tertiary"),
        muted: triplet("--co-text-muted"),
        accent: {
          DEFAULT: triplet("--co-accent"),
          hover: triplet("--co-accent-hover"),
          contrast: triplet("--co-accent-contrast"),
        },
        fuchsia: triplet("--co-fuchsia"),
        cyan: triplet("--co-cyan"),
        success: { DEFAULT: triplet("--co-success"), subtle: "rgb(var(--co-success) / 0.13)" },
        warning: { DEFAULT: triplet("--co-warning"), subtle: "rgb(var(--co-warning) / 0.13)" },
        danger: { DEFAULT: triplet("--co-danger"), subtle: "rgb(var(--co-danger) / 0.13)" },
        info: { DEFAULT: triplet("--co-info"), subtle: "rgb(var(--co-info) / 0.13)" },
        pos: triplet("--co-pos"),
        neg: triplet("--co-neg"),
        // The funnel stage palette (cool lead → brand prospect → won-green customer)
        stage: {
          lead: triplet("--co-stage-lead"),
          prospect: triplet("--co-stage-prospect"),
          customer: triplet("--co-stage-customer"),
        },
        // Per-feature icon hues — the colorful cockpit iconography
        feat: {
          relationships: triplet("--co-feat-relationships"),
          pipeline: triplet("--co-feat-pipeline"),
          invoices: triplet("--co-feat-invoices"),
          outreach: triplet("--co-feat-outreach"),
          email: triplet("--co-feat-email"),
          meetings: triplet("--co-feat-meetings"),
          agents: triplet("--co-feat-agents"),
        },
      },
      borderColor: {
        DEFAULT: triplet("--co-edge"),
        subtle: triplet("--co-edge-subtle"),
      },
      borderRadius: {
        token: "var(--co-radius)",
        "token-lg": "var(--co-radius-lg)",
        "token-xl": "var(--co-radius-xl)",
      },
      boxShadow: {
        token: "var(--co-shadow)",
        "token-lg": "var(--co-shadow-lg)",
        glow: "0 0 0 1px rgb(var(--co-accent) / 0.25), 0 8px 30px -6px rgb(var(--co-accent) / 0.45)",
        "glow-cyan": "0 0 0 1px rgb(var(--co-cyan) / 0.25), 0 8px 30px -6px rgb(var(--co-cyan) / 0.4)",
      },
      transitionDuration: { fast: "var(--co-dur-fast)", token: "var(--co-dur)" },
      transitionTimingFunction: { token: "var(--co-ease)" },
      keyframes: {
        "co-fade-up": { from: { opacity: "0", transform: "translateY(6px)" }, to: { opacity: "1", transform: "translateY(0)" } },
        "co-bloom": { "0%,100%": { opacity: "0.8", transform: "scale(1)" }, "50%": { opacity: "1", transform: "scale(1.06)" } },
        "co-shimmer": { "0%": { backgroundPosition: "0% 50%" }, "100%": { backgroundPosition: "200% 50%" } },
      },
      animation: {
        "fade-up": "co-fade-up var(--co-dur) var(--co-ease) both",
        bloom: "co-bloom 6s ease-in-out infinite",
      },
      // Full 0–100 opacity scale so every `/NN` modifier emits real rgba.
      opacity: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [String(i), `${i / 100}`])),
    },
  },
  plugins: [],
};
