#!/usr/bin/env node

// Opt-in paid acceptance check. Load credentials explicitly, for example:
//   node --env-file=.env scripts/verify-openai-live.mjs
process.env.CLAUDE_LIVE_PROVIDER = "openai";
// This dedicated paid verifier must never degrade into the control-plane-only
// check merely because the caller's environment contains an opt-out value.
process.env.CLAUDE_LIVE_REQUIRE_SUCCESS = "1";
await import("./verify-claude-live.mjs");
