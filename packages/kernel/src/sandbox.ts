import { Worker } from "node:worker_threads";

/**
 * Runs a workflow code node's source in an isolated worker thread with no
 * ambient network or filesystem handles passed in — only a JSON `context`
 * value is marshalled across the thread boundary (docs/ARCHITECTURE.md §6).
 * The source runs as an async function body that may `return` a value; it sees
 * `context` (upstream outputs) and `input` (the immediate upstream output).
 *
 * Two guards bound execution: a `vm` timeout for synchronous spins and a hard
 * worker-termination deadline for anything async that overruns.
 */
const WORKER_SOURCE = /* js */ `
  import { workerData, parentPort } from "node:worker_threads";
  import vm from "node:vm";

  const { source, context, input, timeoutMs } = workerData;
  (async () => {
    try {
      const sandbox = { context, input, console: { log: () => {} } };
      vm.createContext(sandbox);
      const wrapped = "(async () => {" + source + "})()";
      const result = await vm.runInContext(wrapped, sandbox, {
        timeout: Math.max(1, timeoutMs),
      });
      parentPort.postMessage({ ok: true, result: result ?? null });
    } catch (err) {
      parentPort.postMessage({ ok: false, error: String(err && err.message ? err.message : err) });
    }
  })();
`;

export async function runCodeNode(
  source: string,
  context: unknown,
  input: unknown,
  timeoutMs = 2_000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { source, context, input, timeoutMs },
    });

    const deadline = setTimeout(() => {
      void worker.terminate();
      reject(new Error(`code node timed out after ${timeoutMs}ms`));
    }, timeoutMs + 500);

    worker.once("message", (msg: { ok: boolean; result?: unknown; error?: string }) => {
      clearTimeout(deadline);
      void worker.terminate();
      if (msg.ok) resolve(msg.result ?? null);
      else reject(new Error(msg.error ?? "code node failed"));
    });
    worker.once("error", (err) => {
      clearTimeout(deadline);
      reject(err);
    });
  });
}
