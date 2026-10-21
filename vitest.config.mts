import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    // Mirrors tsconfig `paths`: "@/*" -> "./*". A regex so scoped packages
    // like `@anthropic-ai/sdk` are left alone.
    alias: [{ find: /^@\//, replacement: root }],
  },
  test: {
    // Server code and API behaviour, not React components — no jsdom.
    environment: "node",
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**", "data/**", "vendor/**", "verify/**"],
  },
});
