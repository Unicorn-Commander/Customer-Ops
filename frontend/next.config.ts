import type { NextConfig } from 'next';
import path from 'path';

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  // Pin the file-tracing root to THIS app so Next doesn't infer a parent
  // directory's lockfile as the workspace root (the repo sits under a shared
  // Development/ tree that carries its own package-lock.json).
  outputFileTracingRoot: path.join(__dirname),
  // ESLint is a CI concern, not a production-build gate. A transitive
  // @typescript-eslint bump promoted no-explicit-any to build-fatal across a
  // codebase that type-checks clean (tsc still runs and STILL fails the build
  // on real type errors). Lint runs in CI (Project-Ops CI task), not here.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
