/**
 * Architecture fitness config — the allowed-imports matrix
 * (WP0.4, docs/AI-SDLC-INTEGRATION-PLAN.md; corpus: ai-sdlc-architecture.md §4).
 *
 * Declared dependency direction for the monorepo:
 *   apps/server → shared, db, kernel, mcp-connectors
 *   apps/web    → shared, ui
 *   kernel      → shared, db
 *   db          → shared
 *   shared, ui, mcp-connectors → no internal imports
 *   packages/*  never import apps/*
 *   no cycles
 *
 * Everything not allowed above is forbidden. A package "earning" a new
 * dependency is a reviewed config change here, never a silent import
 * (review class: compliance-without-gaming).
 *
 * Legacy ratchet: scripts/verify-arch.sh compares the violation count
 * against arch-baseline and fails only on increases.
 */
module.exports = {
  forbidden: [
    { name: "no-circular", severity: "error", from: {}, to: { circular: true } },
    {
      name: "packages-never-import-apps",
      severity: "error",
      from: { path: "^packages" },
      to: { path: "^apps" },
    },
    {
      name: "shared-imports-nothing-internal",
      severity: "error",
      from: { path: "^packages/shared" },
      to: { path: "^packages/(db|kernel|ui|mcp-connectors)" },
    },
    {
      name: "db-only-imports-shared",
      severity: "error",
      from: { path: "^packages/db" },
      to: { path: "^packages/(kernel|ui|mcp-connectors)" },
    },
    {
      name: "kernel-only-imports-shared-db",
      severity: "error",
      from: { path: "^packages/kernel" },
      to: { path: "^packages/(ui|mcp-connectors)" },
    },
    {
      name: "ui-imports-nothing-internal",
      severity: "error",
      from: { path: "^packages/ui" },
      to: { path: "^packages/(db|kernel|shared|mcp-connectors)" },
    },
    {
      name: "connectors-import-nothing-internal",
      severity: "error",
      from: { path: "^packages/mcp-connectors" },
      to: { path: "^packages/(db|kernel|shared|ui)" },
    },
    {
      name: "web-only-imports-shared-ui",
      severity: "error",
      from: { path: "^apps/web" },
      to: { path: "^(packages/(db|kernel|mcp-connectors)|apps/server)" },
    },
    {
      name: "server-never-imports-web-or-ui",
      severity: "error",
      from: { path: "^apps/server" },
      to: { path: "^(apps/web|packages/ui)" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "node_modules|\\.d\\.ts$" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.base.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
      mainFields: ["module", "main", "types", "typings"],
    },
  },
};
