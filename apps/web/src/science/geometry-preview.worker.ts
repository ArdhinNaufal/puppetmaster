import {
  parseGeometryPreview,
  SCIENCE_GEOMETRY_PREVIEW_MAX_BYTES,
  type GeometryPreviewModel,
} from "./geometry-preview-parser.js";

interface GeometryWorkerRequest {
  requestId: number;
  bytes: ArrayBuffer;
  formatHint: string;
}

type GeometryWorkerResponse =
  | { requestId: number; ok: true; model: GeometryPreviewModel }
  | { requestId: number; ok: false; error: string };

interface WorkerScope {
  addEventListener(
    type: "message",
    listener: (event: MessageEvent<GeometryWorkerRequest>) => void,
  ): void;
  postMessage(message: GeometryWorkerResponse): void;
}

const scope = globalThis as unknown as WorkerScope;

scope.addEventListener("message", (event) => {
  const request = event.data;
  try {
    if (
      !request
      || !Number.isSafeInteger(request.requestId)
      || !(request.bytes instanceof ArrayBuffer)
      || typeof request.formatHint !== "string"
    ) {
      throw new Error("Geometry worker received an invalid request.");
    }
    if (request.bytes.byteLength > SCIENCE_GEOMETRY_PREVIEW_MAX_BYTES) {
      throw new Error("Geometry payload exceeds the bounded client preview cap.");
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(request.bytes);
    const model = parseGeometryPreview(text, request.formatHint);
    scope.postMessage({ requestId: request.requestId, ok: true, model });
  } catch (error) {
    scope.postMessage({
      requestId: request?.requestId ?? -1,
      ok: false,
      error: error instanceof Error ? error.message : "Geometry preview parsing failed.",
    });
  }
});

export {};
