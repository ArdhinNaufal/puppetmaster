export type ProviderEnvironment = Readonly<Record<string, string | undefined>>;

export interface ProviderEndpoint {
  value: string;
  host: string;
  protocol: "http:" | "https:";
}

export type AnthropicTransport = "direct" | "bedrock" | "foundry" | "vertex" | "invalid";

export interface AnthropicProviderReadiness {
  transport: AnthropicTransport;
  authenticationConfigured: boolean;
  authenticationError: string | null;
  endpoint: ProviderEndpoint | null;
  endpointError: string | null;
}

export interface OpenAiEndpointReadiness {
  endpoint: ProviderEndpoint | null;
  transportAllowed: boolean;
  error: string | null;
}

const CLOUD_TRANSPORTS = [
  { transport: "bedrock", flag: "CLAUDE_CODE_USE_BEDROCK", label: "Bedrock" },
  { transport: "vertex", flag: "CLAUDE_CODE_USE_VERTEX", label: "Vertex" },
  { transport: "foundry", flag: "CLAUDE_CODE_USE_FOUNDRY", label: "Foundry" },
] as const;

const valueFrom = (env: ProviderEnvironment, name: string): string | null => {
  const value = env[name]?.trim();
  return value ? value : null;
};

export function providerEnvEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized !== undefined && normalized !== "" && !["0", "false", "no", "off"].includes(normalized);
}

export function parseProviderEndpoint(value: string): ProviderEndpoint | null {
  try {
    const parsed = new URL(value);
    const protocol = parsed.protocol.toLowerCase();
    if (!parsed.hostname || (protocol !== "http:" && protocol !== "https:")) return null;
    return {
      value,
      host: parsed.hostname.toLowerCase(),
      protocol,
    };
  } catch {
    return null;
  }
}

const endpointResult = (
  value: string,
  invalidMessage: string,
): Pick<AnthropicProviderReadiness, "endpoint" | "endpointError"> => {
  const endpoint = parseProviderEndpoint(value);
  return endpoint
    ? { endpoint, endpointError: null }
    : { endpoint: null, endpointError: invalidMessage };
};

/**
 * Resolve the one Anthropic transport Claude Code will actually use. Cloud
 * selectors are authoritative: direct credentials never make a selected cloud
 * transport look authenticated, and conflicting selectors are rejected.
 */
export function resolveAnthropicProviderReadiness(
  env: ProviderEnvironment,
): AnthropicProviderReadiness {
  const selected = CLOUD_TRANSPORTS.filter(({ flag }) => providerEnvEnabled(env[flag]));
  if (selected.length > 1) {
    const labels = selected.map(({ label }) => label).join(" and ");
    return {
      transport: "invalid",
      authenticationConfigured: false,
      authenticationError:
        `Conflicting Claude Code transports are enabled (${labels}). Set only one of ` +
        "CLAUDE_CODE_USE_BEDROCK, CLAUDE_CODE_USE_VERTEX, or CLAUDE_CODE_USE_FOUNDRY.",
      endpoint: null,
      endpointError: "Claude Code cannot choose an endpoint while multiple cloud transports are enabled.",
    };
  }

  const transport = selected[0]?.transport ?? "direct";
  if (transport === "bedrock") {
    const bearer = valueFrom(env, "AWS_BEARER_TOKEN_BEDROCK");
    const accessKey = valueFrom(env, "AWS_ACCESS_KEY_ID");
    const secretKey = valueFrom(env, "AWS_SECRET_ACCESS_KEY");
    const authenticationConfigured = Boolean(bearer || (accessKey && secretKey));
    const region = valueFrom(env, "AWS_REGION") ?? valueFrom(env, "AWS_DEFAULT_REGION") ?? "us-east-1";
    const endpoint = /^[a-z0-9-]+$/i.test(region)
      ? endpointResult(
          `https://bedrock-runtime.${region}.amazonaws.com`,
          "Claude Code could not derive a valid Bedrock endpoint from AWS_REGION or AWS_DEFAULT_REGION.",
        )
      : {
          endpoint: null,
          endpointError: "AWS_REGION or AWS_DEFAULT_REGION must identify a valid Bedrock region.",
        };
    return {
      transport,
      authenticationConfigured,
      authenticationError: authenticationConfigured
        ? null
        : "Claude Code Bedrock authentication is not configured; set AWS_BEARER_TOKEN_BEDROCK or both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.",
      ...endpoint,
    };
  }

  if (transport === "foundry") {
    const authenticationConfigured = Boolean(valueFrom(env, "ANTHROPIC_FOUNDRY_API_KEY"));
    const baseUrl = valueFrom(env, "ANTHROPIC_FOUNDRY_BASE_URL");
    const endpoint = baseUrl
      ? endpointResult(
          baseUrl,
          "ANTHROPIC_FOUNDRY_BASE_URL must be a valid HTTP(S) URL with a hostname.",
        )
      : {
          endpoint: null,
          endpointError: "Claude Code Foundry requires ANTHROPIC_FOUNDRY_BASE_URL in the server environment.",
        };
    return {
      transport,
      authenticationConfigured,
      authenticationError: authenticationConfigured
        ? null
        : "Claude Code Foundry authentication is not configured; set ANTHROPIC_FOUNDRY_API_KEY in the server environment.",
      ...endpoint,
    };
  }

  if (transport === "vertex") {
    const region = valueFrom(env, "CLOUD_ML_REGION") ?? "us-east5";
    const endpoint = /^[a-z0-9-]+$/i.test(region)
      ? endpointResult(
          `https://${region}-aiplatform.googleapis.com`,
          "Claude Code could not derive a valid Vertex endpoint from CLOUD_ML_REGION.",
        )
      : {
          endpoint: null,
          endpointError: "CLOUD_ML_REGION must identify a valid Vertex region.",
        };
    return {
      transport,
      authenticationConfigured: false,
      authenticationError:
        "Claude Code Vertex is unavailable in disposable workbenches because Application Default Credentials are not forwarded or verified; unset CLAUDE_CODE_USE_VERTEX and choose direct Anthropic, Bedrock, or Foundry.",
      ...endpoint,
    };
  }

  const authenticationConfigured = Boolean(
    valueFrom(env, "ANTHROPIC_API_KEY") || valueFrom(env, "ANTHROPIC_AUTH_TOKEN"),
  );
  const baseUrl = valueFrom(env, "ANTHROPIC_BASE_URL") ?? "https://api.anthropic.com";
  return {
    transport,
    authenticationConfigured,
    authenticationError: authenticationConfigured
      ? null
      : "Claude Code direct Anthropic authentication is not configured; set ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN in the server environment.",
    ...endpointResult(
      baseUrl,
      "ANTHROPIC_BASE_URL must be a valid HTTP(S) URL with a hostname.",
    ),
  };
}

const normalizedHost = (host: string): string => {
  const withoutTrailingDot = host.endsWith(".") ? host.slice(0, -1) : host;
  return withoutTrailingDot.startsWith("[") && withoutTrailingDot.endsWith("]")
    ? withoutTrailingDot.slice(1, -1)
    : withoutTrailingDot;
};

export function isContainerLoopbackHost(host: string): boolean {
  const normalized = normalizedHost(host.toLowerCase());
  if (normalized === "localhost" || normalized.endsWith(".localhost")) return true;
  if (normalized === "0.0.0.0" || normalized === "::" || normalized === "::1") return true;
  if (/^127(?:\.|$)/.test(normalized)) return true;
  return normalized === "::ffff:7f00:1" || normalized.startsWith("::ffff:127.");
}

/** Validate whether Aider can reach the configured endpoint from its container. */
export function resolveOpenAiEndpointReadiness(
  endpointValue: string,
  allowInsecure: boolean,
): OpenAiEndpointReadiness {
  const endpoint = parseProviderEndpoint(endpointValue.trim());
  if (!endpoint) {
    return {
      endpoint: null,
      transportAllowed: false,
      error: "OpenAI provider endpoint must be a valid HTTP(S) URL with a hostname.",
    };
  }
  if (isContainerLoopbackHost(endpoint.host)) {
    return {
      endpoint,
      transportAllowed: false,
      error:
        "OpenAI provider endpoint resolves inside the disposable workbench container; use host.docker.internal for a host service on Docker Desktop, or use a reachable HTTPS hostname, then add that host to WORKBENCH_EGRESS_ALLOW.",
    };
  }
  const trustedDockerHost = normalizedHost(endpoint.host) === "host.docker.internal";
  if (endpoint.protocol !== "https:" && !trustedDockerHost && !allowInsecure) {
    return {
      endpoint,
      transportAllowed: false,
      error:
        "OpenAI provider endpoint must use HTTPS; set CLAUDE_CODE_ALLOW_INSECURE_OPENAI_BASE_URL=1 only for a trusted plaintext endpoint.",
    };
  }
  return { endpoint, transportAllowed: true, error: null };
}
