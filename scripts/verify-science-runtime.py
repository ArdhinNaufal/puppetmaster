#!/usr/bin/env python3
"""Adversarial verifier for the isolated deterministic Science runtime."""

from __future__ import annotations

import concurrent.futures
import copy
import hashlib
import http.client
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any


REPOSITORY = Path(__file__).resolve().parents[1]
SERVER = REPOSITORY / "services" / "science-runtime" / "server.py"
FIXTURE = (
    REPOSITORY
    / "services"
    / "science-runtime"
    / "fixtures"
    / "contract"
    / "submission.json"
)
EXPECTED_RESULT = (
    REPOSITORY
    / "services"
    / "science-runtime"
    / "fixtures"
    / "contract"
    / "expected-result.json"
)
TOKEN = "runtime-verifier-token-" + ("a" * 48)
CONTROL_ORIGIN = "http://control-plane.invalid"
MAX_CONTROL_RESPONSE_BYTES = 64 * 1024
RUNTIME_INSTANCES: dict[int, str] = {}


class VerificationFailure(RuntimeError):
    pass


def require(condition: bool, detail: str) -> None:
    if not condition:
        raise VerificationFailure(detail)


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


class RuntimeProcess:
    def __init__(self, state_dir: Path) -> None:
        self.state_dir = state_dir
        self.port = free_port()
        self.process: subprocess.Popen[bytes] | None = None
        self.stdout = None
        self.stderr = None

    def start(self) -> None:
        environment = os.environ.copy()
        environment.update(
            {
                "PYTHONDONTWRITEBYTECODE": "1",
                "SCIENCE_RUNTIME_HOST": "127.0.0.1",
                "SCIENCE_RUNTIME_PORT": str(self.port),
                "SCIENCE_RUNTIME_STATE_DIR": str(self.state_dir),
                "SCIENCE_RUNTIME_TOKEN": TOKEN,
                "SCIENCE_RUNTIME_ALLOWED_INPUT_ORIGINS": CONTROL_ORIGIN,
                "SCIENCE_RUNTIME_MAX_CONCURRENCY": "4",
                "SCIENCE_RUNTIME_FIXTURE_DELAY_MS": "20",
            }
        )
        environment.pop("SCIENCE_RUNTIME_ALLOW_ANONYMOUS", None)
        self.stdout = (self.state_dir / "runtime.stdout.log").open("ab")
        self.stderr = (self.state_dir / "runtime.stderr.log").open("ab")
        self.process = subprocess.Popen(
            [sys.executable, str(SERVER)],
            cwd=REPOSITORY,
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=self.stdout,
            stderr=self.stderr,
        )
        deadline = time.monotonic() + 10
        last_error: Exception | None = None
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                self._close_logs()
                detail = (self.state_dir / "runtime.stderr.log").read_text(
                    "utf-8", errors="replace"
                )
                raise VerificationFailure(
                    f"runtime exited during startup ({self.process.returncode}): {detail[-2000:]}"
                )
            try:
                status, _, body = request(self.port, "GET", "/health", auth=False)
                health = decode(body)
                instance_id = health.get("instanceId")
                if (
                    status == 200
                    and health.get("ok") is True
                    and isinstance(instance_id, str)
                ):
                    RUNTIME_INSTANCES[self.port] = instance_id
                    return
            except (OSError, http.client.HTTPException, VerificationFailure) as exc:
                last_error = exc
            time.sleep(0.03)
        self.stop()
        raise VerificationFailure(f"runtime did not become healthy: {last_error}")

    def stop(self) -> None:
        process = self.process
        if process is not None and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        self.process = None
        RUNTIME_INSTANCES.pop(self.port, None)
        self._close_logs()

    def _close_logs(self) -> None:
        for stream in (self.stdout, self.stderr):
            if stream is not None:
                stream.close()
        self.stdout = None
        self.stderr = None


def request(
    port: int,
    method: str,
    path: str,
    body: Any | bytes | None = None,
    *,
    auth: bool = True,
    token: str = TOKEN,
    idempotency_key: str | None = None,
    content_type: str = "application/json",
    instance_id: str | None = "__auto__",
) -> tuple[int, dict[str, str], bytes]:
    if body is None:
        payload = None
    elif isinstance(body, bytes):
        payload = body
    else:
        payload = json.dumps(
            body,
            ensure_ascii=False,
            allow_nan=True,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
    headers: dict[str, str] = {}
    if auth:
        headers["Authorization"] = f"Bearer {token}"
    if payload is not None:
        headers["Content-Type"] = content_type
    if idempotency_key is not None:
        headers["Idempotency-Key"] = idempotency_key
    if instance_id == "__auto__":
        instance_id = (
            RUNTIME_INSTANCES.get(port)
            if path.startswith("/v1/runs/") or path == "/v1/runs"
            or path.startswith("/v1/outputs/")
            else None
        )
    if instance_id is not None:
        headers["X-Science-Provider-Instance"] = instance_id
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        connection.request(method, path, body=payload, headers=headers)
        response = connection.getresponse()
        response_body = response.read(2 * 1024 * 1024)
        require(
            len(response_body) <= 2 * 1024 * 1024,
            "runtime response exceeded verifier hard bound",
        )
        response_headers = {key.lower(): value for key, value in response.getheaders()}
        return response.status, response_headers, response_body
    finally:
        connection.close()


def duplicate_key_request(port: int) -> tuple[int, bytes]:
    payload = b'{"resources":{"cpuMillicores":500,"cpuMillicores":600,"memoryMb":512,"gpuCount":0,"wallTimeSeconds":30}}'
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        connection.putrequest("POST", "/v1/quote")
        connection.putheader("Authorization", f"Bearer {TOKEN}")
        connection.putheader("Content-Type", "application/json")
        connection.putheader("Content-Length", str(len(payload)))
        connection.endheaders(payload)
        response = connection.getresponse()
        return response.status, response.read()
    finally:
        connection.close()


def oversized_length_request(port: int) -> tuple[int, dict[str, str], bytes]:
    """Advertise an oversized body without streaming it.

    The runtime must reject Content-Length before reading. Avoiding unread
    request bytes also prevents platform-specific TCP resets from hiding the
    deterministic 413 response on Windows.
    """

    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        connection.putrequest("POST", "/v1/quote")
        connection.putheader("Authorization", f"Bearer {TOKEN}")
        connection.putheader("Content-Type", "application/json")
        connection.putheader("Content-Length", str((1024 * 1024) + 1))
        connection.endheaders()
        response = connection.getresponse()
        response_body = response.read(2 * 1024 * 1024)
        response_headers = {key.lower(): value for key, value in response.getheaders()}
        return response.status, response_headers, response_body
    finally:
        connection.close()


def duplicate_instance_fence_request(
    port: int,
    value: dict[str, Any],
    instance_id: str,
) -> tuple[int, dict[str, str], bytes]:
    payload = json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    try:
        connection.putrequest("POST", "/v1/runs")
        connection.putheader("Authorization", f"Bearer {TOKEN}")
        connection.putheader("Content-Type", "application/json")
        connection.putheader("Content-Length", str(len(payload)))
        connection.putheader("Idempotency-Key", value["idempotencyKey"])
        connection.putheader("X-Science-Provider-Instance", instance_id)
        connection.putheader("X-Science-Provider-Instance", instance_id)
        connection.endheaders(payload)
        response = connection.getresponse()
        body = response.read()
        headers = {key.lower(): item for key, item in response.getheaders()}
        return response.status, headers, body
    finally:
        connection.close()


def decode(body: bytes) -> dict[str, Any]:
    try:
        value = json.loads(body)
    except json.JSONDecodeError as exc:
        raise VerificationFailure(f"response was not JSON: {body[:200]!r}") from exc
    require(isinstance(value, dict), "response JSON must be an object")
    return value


def error_code(body: bytes) -> str:
    value = decode(body)
    error = value.get("error")
    require(isinstance(error, dict), "error response has no error object")
    code = error.get("code")
    require(isinstance(code, str), "error response has no code")
    return code


def expect_status(
    actual: tuple[int, dict[str, str], bytes],
    expected: int,
    label: str,
    code: str | None = None,
) -> tuple[dict[str, str], bytes]:
    status, headers, body = actual
    require(status == expected, f"{label}: expected HTTP {expected}, received {status}: {body[:500]!r}")
    require(
        headers.get("x-content-type-options") == "nosniff",
        f"{label}: missing nosniff",
    )
    if headers.get("content-type", "").startswith("application/json"):
        require(
            len(body) <= MAX_CONTROL_RESPONSE_BYTES,
            f"{label}: control response exceeds 64 KiB",
        )
    if code is not None:
        require(error_code(body) == code, f"{label}: expected error code {code}")
    return headers, body


def submission(unique: str, *, generation: int = 1, delay_ms: int = 20) -> dict[str, Any]:
    value = json.loads(FIXTURE.read_text("utf-8"))
    value["runId"] = f"run-{unique}"
    value["missionId"] = f"mission-{unique}"
    value["generation"] = generation
    value["idempotencyKey"] = f"science-runtime:{unique}:{generation}"
    value["parameters"]["fixtureDelayMs"] = delay_ms
    return value


def submit(port: int, value: dict[str, Any]) -> tuple[int, str]:
    status, _, body = request(
        port,
        "POST",
        "/v1/runs",
        value,
        idempotency_key=value["idempotencyKey"],
    )
    require(status in {200, 201}, f"submit failed with HTTP {status}: {body[:500]!r}")
    handle = decode(body).get("handle")
    require(isinstance(handle, str) and handle.startswith("run-"), "submit returned invalid handle")
    return status, handle


def status(port: int, handle: str, generation: int) -> dict[str, Any]:
    response = request(
        port, "GET", f"/v1/runs/{handle}?generation={generation}"
    )
    _, body = expect_status(response, 200, "status")
    return decode(body)


def wait_state(
    port: int,
    handle: str,
    generation: int,
    expected: set[str],
    *,
    timeout: float = 8,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    latest: dict[str, Any] = {}
    while time.monotonic() < deadline:
        latest = status(port, handle, generation)
        if latest.get("state") in expected:
            return latest
        time.sleep(0.02)
    raise VerificationFailure(
        f"run {handle} did not reach {sorted(expected)}; last status={latest}"
    )


def verify_startup_auth_default(state_parent: Path) -> None:
    environment = os.environ.copy()
    environment.update(
        {
            "PYTHONDONTWRITEBYTECODE": "1",
            "SCIENCE_RUNTIME_STATE_DIR": str(state_parent / "no-auth"),
            "SCIENCE_RUNTIME_PORT": "0",
        }
    )
    environment.pop("SCIENCE_RUNTIME_TOKEN", None)
    environment.pop("SCIENCE_RUNTIME_ALLOW_ANONYMOUS", None)
    process = subprocess.run(
        [sys.executable, str(SERVER)],
        cwd=REPOSITORY,
        env=environment,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=5,
        check=False,
    )
    require(process.returncode != 0, "runtime started without an auth policy")
    require(
        b"SCIENCE_RUNTIME_TOKEN is required" in process.stderr,
        "missing-token startup did not explain its fail-closed policy",
    )


def verify_node_adapter(port: int) -> None:
    provider = REPOSITORY / "packages" / "kernel" / "dist" / "science" / "providers.js"
    require(
        provider.is_file(),
        "kernel dist/science/providers.js is missing; build @puppetmaster/kernel before this verifier",
    )
    script = r"""
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { HttpComputeProvider } from "./packages/kernel/dist/science/providers.js";
const input = JSON.parse(await readFile(process.env.SCIENCE_SUBMISSION, "utf8"));
input.runId = "run-node-adapter";
input.missionId = "mission-node-adapter";
input.idempotencyKey = "science-runtime:node-adapter:1";
input.parameters.fixtureDelayMs = 20;
const provider = new HttpComputeProvider({
  kind: "local_container",
  baseUrl: process.env.SCIENCE_BASE_URL,
  bearerToken: process.env.SCIENCE_TOKEN,
  timeoutMs: 5000,
});
const productionAdmissionProbe = new HttpComputeProvider({
  kind: "local_container",
  baseUrl: process.env.SCIENCE_BASE_URL,
  bearerToken: process.env.SCIENCE_TOKEN,
  timeoutMs: 5000,
  requiredExecutionMode: "isolated_oci",
});
const initialHealth = await provider.health();
if (!initialHealth.ok || !initialHealth.instanceId) {
  throw new Error("runtime did not expose an admitted operation instance");
}
const operationFence = { expectedInstanceId: initialHealth.instanceId };
const productionHealth = await productionAdmissionProbe.health();
if (productionHealth.ok) {
  throw new Error("production health admitted the non-executing contract fixture");
}
let admissionRefusal = "";
try {
  await productionAdmissionProbe.submit(input, operationFence);
} catch (error) {
  admissionRefusal = error instanceof Error ? error.message : String(error);
}
if (!/contract fixture|not admitted/i.test(admissionRefusal)) {
  throw new Error("production adapter admitted the non-executing contract fixture");
}
const quote = await provider.quote(input.resources);
if (!quote.available || quote.provider !== "science-runtime-fixture") throw new Error("quote contract mismatch");
const { handle } = await provider.submit(input, operationFence);
let observed;
for (let attempt = 0; attempt < 200; attempt += 1) {
  observed = await provider.status(handle, input.generation, operationFence);
  if (["succeeded", "failed", "cancelled"].includes(observed.state)) break;
  await new Promise((resolve) => setTimeout(resolve, 10));
}
if (observed?.state !== "succeeded") throw new Error(`adapter run ended ${observed?.state}`);
const outputs = await provider.collectOutputs(handle, input.generation, operationFence);
if (outputs.length !== 1) throw new Error("adapter output count mismatch");
const hash = createHash("sha256");
let size = 0;
for await (const chunk of await provider.openOutput(outputs[0], operationFence)) {
  size += chunk.byteLength;
  hash.update(chunk);
}
if (size !== outputs[0].size || hash.digest("hex") !== outputs[0].sha256) {
  throw new Error("adapter streamed output differs from receipt");
}
const health = await provider.health();
if (
  !health.ok ||
  health.version !== "0.2.0" ||
  health.executionMode !== "contract_fixture" ||
  health.executesUserCode !== false
) throw new Error("adapter health mismatch");
process.stdout.write(JSON.stringify({ handle, state: observed.state, size }));
"""
    environment = os.environ.copy()
    environment.update(
        {
            "SCIENCE_BASE_URL": f"http://127.0.0.1:{port}",
            "SCIENCE_TOKEN": TOKEN,
            "SCIENCE_SUBMISSION": str(FIXTURE),
        }
    )
    result = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        cwd=REPOSITORY,
        env=environment,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=15,
        check=False,
    )
    require(
        result.returncode == 0,
        f"live HttpComputeProvider adapter probe failed: {result.stderr.decode('utf-8', 'replace')}",
    )
    evidence = decode(result.stdout)
    require(evidence.get("state") == "succeeded", "adapter probe did not succeed")


def main() -> int:
    require(SERVER.is_file(), f"missing runtime server {SERVER}")
    require(FIXTURE.is_file(), "science fixtures are missing; run generate-science-fixtures.py")
    require(
        EXPECTED_RESULT.is_file(),
        "science expected-result fixture is missing",
    )
    checks: list[str] = []
    with tempfile.TemporaryDirectory(prefix="puppetmaster-science-runtime-") as raw:
        temporary = Path(raw)
        verify_startup_auth_default(temporary)
        checks.append("auth-default")

        state_dir = temporary / "state"
        state_dir.mkdir()
        runtime = RuntimeProcess(state_dir)
        runtime.start()
        try:
            headers, health_body = expect_status(
                request(runtime.port, "GET", "/health", auth=False),
                200,
                "health",
            )
            health = decode(health_body)
            require(health.get("version") == "0.2.0", "health version mismatch")
            initial_instance_id = health.get("instanceId")
            require(
                isinstance(initial_instance_id, str)
                and initial_instance_id.startswith("science-runtime-")
                and len(initial_instance_id) == len("science-runtime-") + 32,
                "health instance identity is missing or malformed",
            )
            require(
                health.get("executionMode") == "contract_fixture"
                and health.get("executesUserCode") is False,
                "health must identify the non-executing contract fixture",
            )
            require(
                health.get("integrations")
                == {
                    "jupyterEnterpriseGateway": "no-go",
                    "trame": "no-go",
                    "occt": "no-go",
                },
                "health must expose explicit JEG/trame/OCCT no-go state",
            )
            require("no-store" in headers.get("cache-control", ""), "health must not cache")
            expect_status(
                request(runtime.port, "GET", "/health?verbose=1", auth=False),
                422,
                "health query",
                "invalid_request",
            )
            checks.append("health-no-go")

            expect_status(
                request(runtime.port, "POST", "/v1/quote", {"resources": {}}, auth=False),
                401,
                "missing auth",
                "unauthorized",
            )
            expect_status(
                request(
                    runtime.port,
                    "POST",
                    "/v1/quote",
                    {"resources": {}},
                    token="wrong-" + ("x" * 40),
                ),
                401,
                "bad auth",
                "unauthorized",
            )
            checks.append("bearer-auth")

            base = submission("direct")
            _, quote_body = expect_status(
                request(
                    runtime.port,
                    "POST",
                    "/v1/quote",
                    {"resources": base["resources"]},
                ),
                200,
                "quote",
            )
            quote = decode(quote_body)
            require(quote.get("available") is True, "valid resources were unavailable")
            require(quote.get("provider") == "science-runtime-fixture", "quote provider mismatch")
            over = copy.deepcopy(base["resources"])
            over["gpuCount"] = 1
            _, unavailable_body = expect_status(
                request(runtime.port, "POST", "/v1/quote", {"resources": over}),
                200,
                "unavailable quote",
            )
            require(decode(unavailable_body).get("available") is False, "GPU quote must be unavailable")
            extra_quote = {"resources": base["resources"], "unexpected": True}
            expect_status(
                request(runtime.port, "POST", "/v1/quote", extra_quote),
                422,
                "strict quote",
                "invalid_request",
            )
            checks.append("quote-limits")

            duplicate_status, duplicate_body = duplicate_key_request(runtime.port)
            require(duplicate_status == 400, "duplicate JSON key was not rejected")
            require(error_code(duplicate_body) == "invalid_json", "duplicate key error code mismatch")
            expect_status(
                oversized_length_request(runtime.port),
                413,
                "oversized request",
                "payload_too_large",
            )
            wrong_media = request(
                runtime.port,
                "POST",
                "/v1/quote",
                b"{}",
                content_type="text/plain",
            )
            expect_status(wrong_media, 415, "content type", "unsupported_media_type")
            checks.append("strict-bounds")

            disallowed = copy.deepcopy(base)
            disallowed["inputs"][0]["reference"]["url"] = "http://metadata.invalid/latest"
            expect_status(
                request(
                    runtime.port,
                    "POST",
                    "/v1/runs",
                    disallowed,
                    idempotency_key=disallowed["idempotencyKey"],
                ),
                422,
                "input origin",
                "input_origin_not_allowed",
            )
            wrong_image = copy.deepcopy(base)
            wrong_image["imageDigest"] = "sha256:" + ("f" * 64)
            expect_status(
                request(
                    runtime.port,
                    "POST",
                    "/v1/runs",
                    wrong_image,
                    idempotency_key=wrong_image["idempotencyKey"],
                ),
                422,
                "image allowlist",
                "image_not_allowed",
            )
            wrong_kernel = copy.deepcopy(base)
            wrong_kernel["kernel"] = "arbitrary-python"
            expect_status(
                request(
                    runtime.port,
                    "POST",
                    "/v1/runs",
                    wrong_kernel,
                    idempotency_key=wrong_kernel["idempotencyKey"],
                ),
                422,
                "kernel allowlist",
                "kernel_not_allowed",
            )
            secret = copy.deepcopy(base)
            secret["parameters"]["apiToken"] = "must-not-enter-runtime"
            expect_status(
                request(
                    runtime.port,
                    "POST",
                    "/v1/runs",
                    secret,
                    idempotency_key=secret["idempotencyKey"],
                ),
                422,
                "secret parameter",
                "secret_field_forbidden",
            )
            too_many = copy.deepcopy(base)
            too_many["inputs"] = [copy.deepcopy(base["inputs"][0]) for _ in range(201)]
            expect_status(
                request(
                    runtime.port,
                    "POST",
                    "/v1/runs",
                    too_many,
                    idempotency_key=too_many["idempotencyKey"],
                ),
                422,
                "input count",
                "invalid_request",
            )
            maximum = submission("maximum-inputs", delay_ms=0)
            maximum["inputs"] = []
            for index in range(200):
                item = copy.deepcopy(base["inputs"][0])
                item["artifactVersionId"] = f"artifact-version-{index:03d}"
                item["role"] = f"input_{index:03d}"
                maximum["inputs"].append(item)
            _, maximum_handle = submit(runtime.port, maximum)
            wait_state(runtime.port, maximum_handle, 1, {"succeeded"})
            expect_status(
                request(
                    runtime.port,
                    "GET",
                    f"/v1/runs/{maximum_handle}/outputs?generation=1",
                ),
                200,
                "maximum input output",
            )
            checks.append("allowlists-secret-boundary")

            fenced = submission("instance-fence", delay_ms=0)
            stale_instance_id = "science-runtime-" + ("e" * 32)
            if stale_instance_id == initial_instance_id:
                stale_instance_id = "science-runtime-" + ("f" * 32)
            expect_status(
                request(
                    runtime.port,
                    "POST",
                    "/v1/runs",
                    fenced,
                    idempotency_key=fenced["idempotencyKey"],
                    instance_id=None,
                ),
                409,
                "missing provider instance fence",
                "provider_instance_mismatch",
            )
            expect_status(
                duplicate_instance_fence_request(
                    runtime.port,
                    fenced,
                    initial_instance_id,
                ),
                409,
                "duplicate provider instance fence",
                "provider_instance_mismatch",
            )
            expect_status(
                request(
                    runtime.port,
                    "POST",
                    "/v1/runs",
                    fenced,
                    idempotency_key=fenced["idempotencyKey"],
                    instance_id=stale_instance_id,
                ),
                409,
                "stale provider instance fence",
                "provider_instance_mismatch",
            )
            fenced_status, fenced_handle = submit(runtime.port, fenced)
            require(
                fenced_status == 201,
                "rejected instance-fence requests must not create an execution",
            )
            wait_state(runtime.port, fenced_handle, 1, {"succeeded"})
            expect_status(
                request(
                    runtime.port,
                    "GET",
                    f"/v1/runs/{fenced_handle}?generation=1",
                    instance_id=stale_instance_id,
                ),
                409,
                "stale status provider instance fence",
                "provider_instance_mismatch",
            )
            expect_status(
                request(
                    runtime.port,
                    "GET",
                    f"/v1/runs/{fenced_handle}/outputs?generation=1",
                    instance_id=None,
                ),
                409,
                "missing output-list provider instance fence",
                "provider_instance_mismatch",
            )
            _, fenced_outputs_body = expect_status(
                request(
                    runtime.port,
                    "GET",
                    f"/v1/runs/{fenced_handle}/outputs?generation=1",
                ),
                200,
                "fenced output list",
            )
            fenced_outputs = decode(fenced_outputs_body).get("outputs")
            require(
                isinstance(fenced_outputs, list)
                and len(fenced_outputs) == 1
                and isinstance(fenced_outputs[0], dict)
                and isinstance(fenced_outputs[0].get("reference"), str),
                "fenced output list did not return a receipt",
            )
            expect_status(
                request(
                    runtime.port,
                    "GET",
                    fenced_outputs[0]["reference"],
                    instance_id=stale_instance_id,
                ),
                409,
                "stale output-stream provider instance fence",
                "provider_instance_mismatch",
            )
            expect_status(
                request(
                    runtime.port,
                    "POST",
                    f"/v1/runs/{fenced_handle}/cancel",
                    {"generation": 1},
                    instance_id=None,
                ),
                409,
                "missing cancel provider instance fence",
                "provider_instance_mismatch",
            )
            checks.append("operation-instance-fence")

            with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
                deliveries = list(
                    pool.map(
                        lambda _: submit(runtime.port, copy.deepcopy(base)),
                        range(8),
                    )
                )
            handles = {handle for _, handle in deliveries}
            require(len(handles) == 1, "concurrent duplicate delivery created multiple handles")
            require(
                sum(1 for response_status, _ in deliveries if response_status == 201) == 1,
                "concurrent duplicate delivery created more than one external job",
            )
            direct_handle = next(iter(handles))
            terminal = wait_state(runtime.port, direct_handle, 1, {"succeeded"})
            require(terminal.get("progress") == 1.0, "successful run has wrong progress")
            checks.append("idempotent-concurrency")

            refreshed = copy.deepcopy(base)
            refreshed["inputs"][0]["reference"]["url"] = (
                f"{CONTROL_ORIGIN}/api/science/artifact-versions/refreshed/content"
                "?audience=fixture&expires=4070908800&sig=" + ("b" * 64)
            )
            refreshed["inputs"][0]["reference"]["expiresAt"] = "2099-02-01T00:00:00.000Z"
            replay_status, replay_handle = submit(runtime.port, refreshed)
            require(
                replay_status == 200 and replay_handle == direct_handle,
                "refreshed signed reference did not replay idempotently",
            )
            conflict = copy.deepcopy(base)
            conflict["parameters"]["fixtureDelayMs"] = 21
            expect_status(
                request(
                    runtime.port,
                    "POST",
                    "/v1/runs",
                    conflict,
                    idempotency_key=conflict["idempotencyKey"],
                ),
                409,
                "idempotency conflict",
                "idempotency_conflict",
            )
            state_bytes = (state_dir / "state.json").read_bytes()
            require(
                b"sig=" not in state_bytes
                and b"expiresAt" not in state_bytes
                and CONTROL_ORIGIN.encode("utf-8") not in state_bytes,
                "durable ledger retained an ephemeral signed input reference",
            )
            checks.append("durable-redacted-idempotency")

            expect_status(
                request(runtime.port, "GET", f"/v1/runs/{direct_handle}?generation=2"),
                409,
                "status generation fence",
                "generation_mismatch",
            )
            expect_status(
                request(
                    runtime.port,
                    "POST",
                    f"/v1/runs/{direct_handle}/cancel",
                    {"generation": 2},
                ),
                409,
                "cancel generation fence",
                "generation_mismatch",
            )
            checks.append("generation-fencing")

            _, outputs_body = expect_status(
                request(
                    runtime.port,
                    "GET",
                    f"/v1/runs/{direct_handle}/outputs?generation=1",
                ),
                200,
                "output receipt",
            )
            outputs = decode(outputs_body).get("outputs")
            require(isinstance(outputs, list) and len(outputs) == 1, "output list mismatch")
            receipt = outputs[0]
            require(
                isinstance(receipt, dict)
                and isinstance(receipt.get("reference"), str)
                and receipt["reference"].startswith("/v1/outputs/")
                and not receipt["reference"].startswith("http")
                and "data:" not in json.dumps(receipt).lower(),
                "output reference is not a same-origin bounded path",
            )
            expect_status(
                request(runtime.port, "GET", receipt["reference"], auth=False),
                401,
                "output auth",
                "unauthorized",
            )
            output_headers, output_bytes = expect_status(
                request(runtime.port, "GET", receipt["reference"]),
                200,
                "output bytes",
            )
            require(
                int(output_headers["content-length"]) == receipt["size"] == len(output_bytes),
                "output length differs from receipt",
            )
            require(
                hashlib.sha256(output_bytes).hexdigest() == receipt["sha256"],
                "output checksum differs from receipt",
            )
            expected = json.loads(EXPECTED_RESULT.read_text("utf-8"))
            expected["runId"] = base["runId"]
            expected["missionId"] = base["missionId"]
            expected["parameters"]["fixtureDelayMs"] = 20
            require(json.loads(output_bytes) == expected, "deterministic output content mismatch")
            checks.append("same-origin-checksummed-output")

            cancel_body = submission("cancel", delay_ms=30_000)
            _, cancel_handle = submit(runtime.port, cancel_body)
            wait_state(runtime.port, cancel_handle, 1, {"queued", "provisioning", "running"})
            _, cancelled_body = expect_status(
                request(
                    runtime.port,
                    "POST",
                    f"/v1/runs/{cancel_handle}/cancel",
                    {"generation": 1},
                ),
                202,
                "cancel",
            )
            require(decode(cancelled_body).get("accepted") is True, "cancel was not accepted")
            wait_state(runtime.port, cancel_handle, 1, {"cancelled"})
            _, repeat_cancel = expect_status(
                request(
                    runtime.port,
                    "POST",
                    f"/v1/runs/{cancel_handle}/cancel",
                    {"generation": 1},
                ),
                200,
                "terminal cancel",
            )
            require(decode(repeat_cancel).get("accepted") is False, "terminal cancel must be false")
            checks.append("cancellation")

            newer = submission("fence", generation=2, delay_ms=20)
            _, newer_handle = submit(runtime.port, newer)
            expect_status(
                request(
                    runtime.port,
                    "POST",
                    f"/v1/runs/{newer_handle}/cancel",
                    {"generation": 1},
                ),
                409,
                "stale cancellation",
                "generation_mismatch",
            )
            wait_state(runtime.port, newer_handle, 2, {"succeeded"})
            checks.append("stale-cancel-safety")

            failed = submission("failed")
            failed["parameters"]["fixtureOutcome"] = "failed"
            _, failed_handle = submit(runtime.port, failed)
            failed_status = wait_state(runtime.port, failed_handle, 1, {"failed"})
            require(
                isinstance(failed_status.get("error"), str),
                "failed run omitted bounded error",
            )
            checks.append("failure-terminal")

            verify_node_adapter(runtime.port)
            checks.append("live-http-adapter")

            interrupted = submission("interrupted", delay_ms=30_000)
            _, interrupted_handle = submit(runtime.port, interrupted)
            wait_state(runtime.port, interrupted_handle, 1, {"running"})
            cancel_restart = submission("cancel-restart", delay_ms=30_000)
            _, cancel_restart_handle = submit(runtime.port, cancel_restart)
            wait_state(
                runtime.port,
                cancel_restart_handle,
                1,
                {"queued", "provisioning", "running"},
            )
            expect_status(
                request(
                    runtime.port,
                    "POST",
                    f"/v1/runs/{cancel_restart_handle}/cancel",
                    {"generation": 1},
                ),
                202,
                "cancel before restart",
            )
        finally:
            runtime.stop()

        runtime = RuntimeProcess(state_dir)
        runtime.start()
        try:
            require(
                RUNTIME_INSTANCES.get(runtime.port) == initial_instance_id,
                "durable runtime ledger changed provider identity across restart",
            )
            require(
                status(runtime.port, direct_handle, 1).get("state") == "succeeded",
                "terminal success did not survive restart",
            )
            replay_status, replay_handle = submit(runtime.port, refreshed)
            require(
                replay_status == 200 and replay_handle == direct_handle,
                "idempotent handle did not survive restart",
            )
            require(
                status(runtime.port, interrupted_handle, 1).get("state") == "failed",
                "interrupted active job did not converge to explicit failure",
            )
            require(
                status(runtime.port, cancel_restart_handle, 1).get("state") == "cancelled",
                "persisted cancellation did not converge after restart",
            )
            checks.append("restart-reconciliation")

            receipt_path = state_dir / "outputs" / direct_handle / "result.json"
            original = receipt_path.read_bytes()
            require(original, "output selected for tamper test is empty")
            receipt_path.write_bytes(bytes((original[0] ^ 1,)) + original[1:])
            expect_status(
                request(
                    runtime.port,
                    "GET",
                    f"/v1/outputs/{direct_handle}/result.json",
                ),
                500,
                "tampered output",
                "receipt_mismatch",
            )
            checks.append("tamper-detection")
        finally:
            runtime.stop()

    print(
        "SCIENCE RUNTIME PASS: "
        + f"{len(checks)} checks ["
        + ", ".join(checks)
        + "]"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except VerificationFailure as error:
        print(f"SCIENCE RUNTIME FAIL: {error}", file=sys.stderr)
        raise SystemExit(1)
