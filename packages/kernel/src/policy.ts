import { z } from "zod";

/**
 * Approval auto-allow policies (Stage 1, G2). A gated (write/destructive) tool
 * call that matches a policy — tool pattern plus *every* argument predicate —
 * is executed without pausing for a human, and audited as `approval.auto`.
 * Everything unmatched still gates, so the default posture is unchanged;
 * policies only carve out reviewed-safe paths (e.g. "email.send when `to`
 * endsWith @acme.io") to fight approval fatigue.
 */

export const PolicyPredicate = z.object({
  /** Dot path into the tool args, e.g. "to" or "message.channel". */
  path: z.string().min(1),
  op: z.enum(["eq", "neq", "contains", "startsWith", "endsWith", "lt", "gt"]),
  value: z.union([z.string(), z.number(), z.boolean()]),
});
export type PolicyPredicate = z.infer<typeof PolicyPredicate>;

export interface ApprovalPolicyLike {
  id: string;
  agentId: string | null;
  /** `server.tool` or `server.*`. */
  tool: string;
  predicates: unknown;
  enabled: boolean;
}

function valueAt(args: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => (acc as any)?.[key], args);
}

export function predicateMatches(pred: PolicyPredicate, args: Record<string, unknown>): boolean {
  const actual = valueAt(args, pred.path);
  switch (pred.op) {
    case "eq":
      return actual === pred.value;
    case "neq":
      return actual !== pred.value;
    case "contains":
      return typeof actual === "string" && actual.includes(String(pred.value));
    case "startsWith":
      return typeof actual === "string" && actual.startsWith(String(pred.value));
    case "endsWith":
      return typeof actual === "string" && actual.endsWith(String(pred.value));
    case "lt":
      return typeof actual === "number" && actual < Number(pred.value);
    case "gt":
      return typeof actual === "number" && actual > Number(pred.value);
  }
}

function toolMatches(pattern: string, server: string, tool: string): boolean {
  return pattern === `${server}.${tool}` || pattern === `${server}.*`;
}

/**
 * First enabled policy that auto-allows this call, or null. All predicates of
 * a policy must pass (AND); a malformed predicate list disables its policy
 * (fail closed).
 */
export function findMatchingPolicy(
  policies: ApprovalPolicyLike[],
  call: { server: string; tool: string; args: Record<string, unknown> },
): ApprovalPolicyLike | null {
  for (const policy of policies) {
    if (!policy.enabled || !toolMatches(policy.tool, call.server, call.tool)) continue;
    const parsed = z.array(PolicyPredicate).safeParse(policy.predicates);
    if (!parsed.success) continue;
    if (parsed.data.every((p) => predicateMatches(p, call.args))) return policy;
  }
  return null;
}
