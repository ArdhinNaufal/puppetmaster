import assert from "node:assert/strict";

import {
  providerEnvEnabled,
  resolveAnthropicProviderReadiness,
  resolveOpenAiEndpointReadiness,
} from "../apps/server/dist/claude-code-readiness.js";

const directSecret = "direct-secret-sentinel";
const cloudSecret = "cloud-secret-sentinel";

const assertSecretFree = (result, values = [directSecret, cloudSecret]) => {
  const errors = [result.authenticationError, result.endpointError, result.error]
    .filter(Boolean)
    .join(" ");
  for (const value of values) assert.equal(errors.includes(value), false, "readiness error leaked a credential value");
};

console.log("== provider flag parsing ==");
for (const value of ["1", "true", "yes", "on", "enabled"]) assert.equal(providerEnvEnabled(value), true);
for (const value of [undefined, "", "0", "false", "no", "off", " OFF "]) {
  assert.equal(providerEnvEnabled(value), false);
}

console.log("== direct Anthropic readiness ==");
{
  const missing = resolveAnthropicProviderReadiness({});
  assert.equal(missing.transport, "direct");
  assert.equal(missing.authenticationConfigured, false);
  assert.equal(missing.endpoint?.host, "api.anthropic.com");
  assert.match(missing.authenticationError ?? "", /ANTHROPIC_API_KEY.*ANTHROPIC_AUTH_TOKEN/);

  const apiKey = resolveAnthropicProviderReadiness({ ANTHROPIC_API_KEY: directSecret });
  assert.equal(apiKey.authenticationConfigured, true);
  assert.equal(apiKey.authenticationError, null);

  const authToken = resolveAnthropicProviderReadiness({
    ANTHROPIC_AUTH_TOKEN: directSecret,
    ANTHROPIC_BASE_URL: "https://anthropic-gateway.example.test/v1",
  });
  assert.equal(authToken.authenticationConfigured, true);
  assert.equal(authToken.endpoint?.host, "anthropic-gateway.example.test");

  const invalidEndpoint = resolveAnthropicProviderReadiness({
    ANTHROPIC_API_KEY: directSecret,
    ANTHROPIC_BASE_URL: `not-a-url-${cloudSecret}`,
  });
  assert.equal(invalidEndpoint.endpoint, null);
  assert.match(invalidEndpoint.endpointError ?? "", /valid HTTP\(S\) URL/);
  assertSecretFree(invalidEndpoint);
}

console.log("== Bedrock readiness is transport-specific ==");
{
  const unrelatedDirectKey = resolveAnthropicProviderReadiness({
    CLAUDE_CODE_USE_BEDROCK: "1",
    ANTHROPIC_API_KEY: directSecret,
  });
  assert.equal(unrelatedDirectKey.transport, "bedrock");
  assert.equal(unrelatedDirectKey.authenticationConfigured, false);
  assert.equal(unrelatedDirectKey.endpoint?.host, "bedrock-runtime.us-east-1.amazonaws.com");
  assertSecretFree(unrelatedDirectKey);

  const bearer = resolveAnthropicProviderReadiness({
    CLAUDE_CODE_USE_BEDROCK: "true",
    AWS_BEARER_TOKEN_BEDROCK: cloudSecret,
    ANTHROPIC_BASE_URL: "https://direct-only.example.test",
  });
  assert.equal(bearer.authenticationConfigured, true);
  assert.equal(bearer.endpoint?.host, "bedrock-runtime.us-east-1.amazonaws.com");

  const incompletePair = resolveAnthropicProviderReadiness({
    CLAUDE_CODE_USE_BEDROCK: "1",
    AWS_ACCESS_KEY_ID: "access-id",
  });
  assert.equal(incompletePair.authenticationConfigured, false);

  const accessPair = resolveAnthropicProviderReadiness({
    CLAUDE_CODE_USE_BEDROCK: "1",
    AWS_ACCESS_KEY_ID: "access-id",
    AWS_SECRET_ACCESS_KEY: cloudSecret,
    AWS_REGION: "ap-southeast-2",
  });
  assert.equal(accessPair.authenticationConfigured, true);
  assert.equal(accessPair.endpoint?.host, "bedrock-runtime.ap-southeast-2.amazonaws.com");

  const invalidRegion = resolveAnthropicProviderReadiness({
    CLAUDE_CODE_USE_BEDROCK: "1",
    AWS_BEARER_TOKEN_BEDROCK: cloudSecret,
    AWS_REGION: "not a region",
  });
  assert.equal(invalidRegion.endpoint, null);
  assert.match(invalidRegion.endpointError ?? "", /valid Bedrock region/);
  assertSecretFree(invalidRegion);
}

console.log("== Foundry and Vertex readiness match forwarded credentials ==");
{
  const unrelatedDirectKey = resolveAnthropicProviderReadiness({
    CLAUDE_CODE_USE_FOUNDRY: "1",
    ANTHROPIC_API_KEY: directSecret,
    ANTHROPIC_FOUNDRY_BASE_URL: "https://foundry.example.test",
  });
  assert.equal(unrelatedDirectKey.transport, "foundry");
  assert.equal(unrelatedDirectKey.authenticationConfigured, false);

  const tokenIsNotForwarded = resolveAnthropicProviderReadiness({
    CLAUDE_CODE_USE_FOUNDRY: "1",
    ANTHROPIC_FOUNDRY_AUTH_TOKEN: cloudSecret,
    ANTHROPIC_FOUNDRY_BASE_URL: "https://foundry.example.test",
  });
  assert.equal(tokenIsNotForwarded.authenticationConfigured, false);

  const missingEndpoint = resolveAnthropicProviderReadiness({
    CLAUDE_CODE_USE_FOUNDRY: "1",
    ANTHROPIC_FOUNDRY_API_KEY: cloudSecret,
  });
  assert.equal(missingEndpoint.authenticationConfigured, true);
  assert.equal(missingEndpoint.endpoint, null);
  assert.match(missingEndpoint.endpointError ?? "", /ANTHROPIC_FOUNDRY_BASE_URL/);

  const invalidEndpoint = resolveAnthropicProviderReadiness({
    CLAUDE_CODE_USE_FOUNDRY: "1",
    ANTHROPIC_FOUNDRY_API_KEY: cloudSecret,
    ANTHROPIC_FOUNDRY_BASE_URL: `invalid-${directSecret}`,
  });
  assert.equal(invalidEndpoint.endpoint, null);
  assertSecretFree(invalidEndpoint);

  const ready = resolveAnthropicProviderReadiness({
    CLAUDE_CODE_USE_FOUNDRY: "1",
    ANTHROPIC_FOUNDRY_API_KEY: cloudSecret,
    ANTHROPIC_FOUNDRY_BASE_URL: "https://foundry.example.test/anthropic",
  });
  assert.equal(ready.authenticationConfigured, true);
  assert.equal(ready.endpoint?.host, "foundry.example.test");

  const vertex = resolveAnthropicProviderReadiness({
    CLAUDE_CODE_USE_VERTEX: "1",
    ANTHROPIC_API_KEY: directSecret,
    GOOGLE_APPLICATION_CREDENTIALS: "C:\\credential-that-is-not-forwarded.json",
  });
  assert.equal(vertex.transport, "vertex");
  assert.equal(vertex.authenticationConfigured, false);
  assert.match(vertex.authenticationError ?? "", /Application Default Credentials are not forwarded or verified/);
  assert.equal(vertex.endpoint?.host, "us-east5-aiplatform.googleapis.com");
  assertSecretFree(vertex);
}

console.log("== conflicting cloud transports are rejected ==");
{
  const conflict = resolveAnthropicProviderReadiness({
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CODE_USE_FOUNDRY: "1",
    ANTHROPIC_API_KEY: directSecret,
    AWS_BEARER_TOKEN_BEDROCK: cloudSecret,
    ANTHROPIC_FOUNDRY_API_KEY: cloudSecret,
    ANTHROPIC_FOUNDRY_BASE_URL: "https://foundry.example.test",
  });
  assert.equal(conflict.transport, "invalid");
  assert.equal(conflict.authenticationConfigured, false);
  assert.equal(conflict.endpoint, null);
  assert.match(conflict.authenticationError ?? "", /Set only one/);
  assert.match(conflict.authenticationError ?? "", /Bedrock and Foundry/);
  assertSecretFree(conflict);

  const disabledFlagIsNotAConflict = resolveAnthropicProviderReadiness({
    CLAUDE_CODE_USE_BEDROCK: "off",
    CLAUDE_CODE_USE_FOUNDRY: "1",
    ANTHROPIC_FOUNDRY_API_KEY: cloudSecret,
    ANTHROPIC_FOUNDRY_BASE_URL: "https://foundry.example.test",
  });
  assert.equal(disabledFlagIsNotAConflict.transport, "foundry");
  assert.equal(disabledFlagIsNotAConflict.authenticationConfigured, true);
}

console.log("== OpenAI endpoint must be reachable from a disposable container ==");
{
  const https = resolveOpenAiEndpointReadiness("https://api.openai.com/v1", false);
  assert.equal(https.transportAllowed, true);
  assert.equal(https.endpoint?.host, "api.openai.com");

  const invalid = resolveOpenAiEndpointReadiness(`invalid-${directSecret}`, false);
  assert.equal(invalid.transportAllowed, false);
  assert.equal(invalid.endpoint, null);
  assert.match(invalid.error ?? "", /valid HTTP\(S\) URL/);
  assertSecretFree(invalid);

  const plaintext = resolveOpenAiEndpointReadiness("http://gateway.example.test/v1", false);
  assert.equal(plaintext.transportAllowed, false);
  assert.match(plaintext.error ?? "", /must use HTTPS/);
  assert.equal(resolveOpenAiEndpointReadiness("http://gateway.example.test/v1", true).transportAllowed, true);

  const dockerDesktopHost = resolveOpenAiEndpointReadiness("http://host.docker.internal:11434/v1", false);
  assert.equal(dockerDesktopHost.transportAllowed, true);

  const loopbacks = [
    "http://localhost:11434/v1",
    "https://localhost./v1",
    "http://api.localhost/v1",
    "http://127.0.0.1:11434/v1",
    "https://127.99.1.4/v1",
    "http://[::1]:11434/v1",
    "http://0.0.0.0:11434/v1",
    "http://[::]:11434/v1",
  ];
  for (const endpoint of loopbacks) {
    for (const allowInsecure of [false, true]) {
      const readiness = resolveOpenAiEndpointReadiness(endpoint, allowInsecure);
      assert.equal(readiness.transportAllowed, false, `${endpoint} must not be reachable from the provider container`);
      assert.match(readiness.error ?? "", /resolves inside the disposable workbench container/);
      assert.match(readiness.error ?? "", /host\.docker\.internal/);
    }
  }
}

console.log("PROVIDER READINESS PASS: transport-specific auth/endpoints/conflicts/container reachability");
