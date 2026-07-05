import { randomBytes } from "node:crypto";
import { getMission, getMissionSteps, type Db } from "@puppetmaster/db";
import type { EventBus } from "./bridge.js";

/**
 * OpenTelemetry GenAI export (Stage 5, G8 — §1.5). Dependency-free OTLP/HTTP
 * JSON exporter: when a mission finishes, its recorded step log is turned into
 * one trace — a root mission span with child spans per step — following the
 * `gen_ai.*` semantic conventions (operation name, request model, token
 * usage), and POSTed to `${OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces`. Because
 * spans are built from the persisted step IO, durations are real and the
 * exporter adds zero overhead to the hot path.
 */

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: { key: string; value: { stringValue?: string; intValue?: string } }[];
  status: { code: number };
}

const attr = (key: string, value: string | number) => ({
  key,
  value: typeof value === "number" ? { intValue: String(Math.round(value)) } : { stringValue: value },
});

const nanos = (d: Date | string | null | undefined, fallback: Date): string =>
  String(BigInt(new Date(d ?? fallback).getTime()) * 1_000_000n);

const spanId = () => randomBytes(8).toString("hex");

/** Mission uuid → 32-hex trace id (stable: steps of one mission share a trace). */
const traceIdOf = (missionId: string) => missionId.replaceAll("-", "").padEnd(32, "0").slice(0, 32);

export function startOtelExporter(
  bus: EventBus,
  db: Db,
  endpoint: string,
  opts?: { serviceName?: string; log?: (msg: string, err?: unknown) => void },
): () => void {
  const url = `${endpoint.replace(/\/$/, "")}/v1/traces`;
  const serviceName = opts?.serviceName ?? "puppetmaster";

  return bus.subscribe((event) => {
    if (event.type !== "mission.finished") return;
    void (async () => {
      try {
        const mission = await getMission(db, event.missionId);
        if (!mission) return;
        const steps = await getMissionSteps(db, event.missionId);
        const traceId = traceIdOf(mission.id);
        const rootSpanId = spanId();
        const started = mission.startedAt ?? mission.createdAt;
        const finished = mission.finishedAt ?? new Date();

        const spans: OtlpSpan[] = [
          {
            traceId,
            spanId: rootSpanId,
            name: `mission ${mission.kind}`,
            kind: 1,
            startTimeUnixNano: nanos(started, new Date()),
            endTimeUnixNano: nanos(finished, new Date()),
            attributes: [
              attr("puppetmaster.mission.id", mission.id),
              attr("puppetmaster.mission.kind", mission.kind),
              attr("puppetmaster.mission.status", mission.status),
              attr("puppetmaster.workspace.id", mission.workspaceId),
            ],
            status: { code: mission.status === "succeeded" ? 1 : 2 },
          },
        ];

        for (const step of steps) {
          const isLlm = step.kind === "agent" && step.nodeId.startsWith("llm-");
          const usage = ((step.output ?? {}) as { usage?: { inputTokens?: number; outputTokens?: number } })
            .usage;
          const attrs = [
            attr("puppetmaster.step.node_id", step.nodeId),
            attr("puppetmaster.step.status", step.status),
          ];
          let name: string;
          if (isLlm) {
            const model = ((step.input ?? {}) as { model?: string }).model ?? "unknown";
            name = `chat ${model}`;
            attrs.push(attr("gen_ai.operation.name", "chat"), attr("gen_ai.request.model", model));
            if (usage) {
              attrs.push(
                attr("gen_ai.usage.input_tokens", usage.inputTokens ?? 0),
                attr("gen_ai.usage.output_tokens", usage.outputTokens ?? 0),
              );
            }
          } else if (step.kind === "action") {
            const tool = step.nodeId.replace("__", ".");
            name = `execute_tool ${tool}`;
            attrs.push(attr("gen_ai.operation.name", "execute_tool"), attr("gen_ai.tool.name", tool));
          } else {
            name = `${step.kind} ${step.nodeId}`;
          }
          spans.push({
            traceId,
            spanId: spanId(),
            parentSpanId: rootSpanId,
            name,
            kind: 1,
            startTimeUnixNano: nanos(step.startedAt, new Date(started)),
            endTimeUnixNano: nanos(step.finishedAt ?? step.startedAt, new Date(finished)),
            attributes: attrs,
            status: { code: step.status === "failed" ? 2 : 1 },
          });
        }

        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            resourceSpans: [
              {
                resource: { attributes: [attr("service.name", serviceName)] },
                scopeSpans: [{ scope: { name: "puppetmaster.kernel" }, spans }],
              },
            ],
          }),
        });
        if (!res.ok) opts?.log?.(`otel export failed: ${res.status}`);
      } catch (err) {
        opts?.log?.("otel export error", err);
      }
    })();
  });
}
