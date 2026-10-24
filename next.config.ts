import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs/config";

const nextConfig: NextConfig = {
  // A stray lockfile in the home directory otherwise makes Next infer the
  // wrong workspace root.
  turbopack: { root: __dirname },
  env: {
    // Railway sets this for the build too; the browser tags its events with it.
    NEXT_PUBLIC_SENTRY_ENVIRONMENT: process.env.RAILWAY_ENVIRONMENT_NAME ?? "",
  },
};

// Source maps are generated and uploaded only when a token is present, so CI
// and local builds need no Sentry secrets; after upload they are deleted so
// the server never serves them.
const uploadSourceMaps = Boolean(process.env.SENTRY_AUTH_TOKEN);

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  release: {
    name: process.env.RAILWAY_GIT_COMMIT_SHA,
    create: uploadSourceMaps,
  },
  sourcemaps: {
    disable: !uploadSourceMaps,
    deleteSourcemapsAfterUpload: true,
  },
  silent: !process.env.CI,
  telemetry: false,
});
