#!/usr/bin/env node

// Docker control-plane acceptance must never inherit a provider or paid-live
// mode from the caller's shell/.env. The imported verifier then injects dummy
// credentials unconditionally and accepts any honest terminal outcome.
process.env.CLAUDE_LIVE_PROVIDER = "anthropic";
process.env.CLAUDE_LIVE_REQUIRE_SUCCESS = "0";
await import("./verify-claude-live.mjs");
