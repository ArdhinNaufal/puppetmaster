#!/usr/bin/env python3
"""Bounded HTTP compute-provider fixture for Puppetmaster Science Operations.

This process deliberately does not execute notebooks, images, Jupyter kernels, trame,
or OCCT.  It proves the provider wire contract with deterministic output receipts.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import signal
import sys
import threading
import time
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse


VERSION = "0.2.0"
PROVIDER = "science-runtime-fixture"
CONTRACT_VERSION = "http-contract.v1"
STATE_SCHEMA_VERSION = 2
DEFAULT_IMAGE_DIGEST = (
    "sha256:1445edcf2ab7a2400b0851810d78bf572ad104afc8518f5cd207d88c528b72d6"
)
DEFAULT_KERNEL = "python-fixture-v1"
# A valid control-plane run can contain 200 signed input references of up to
# 4096 characters each. Keep the request bounded without contradicting that
# upstream contract.
MAX_REQUEST_BYTES = 1024 * 1024
MAX_CONTROL_RESPONSE_BYTES = 64 * 1024
MAX_PARAMETERS_BYTES = 32 * 1024
MAX_INPUTS = 200
MAX_JOBS = 256
MAX_STATE_BYTES = 64 * 1024 * 1024
HANDLE_PATTERN = re.compile(r"^run-[0-9a-f]{32}$")
INSTANCE_PATTERN = re.compile(r"^science-runtime-[0-9a-f]{32}$")
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
IMAGE_DIGEST_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")
SECRET_FIELD_PATTERN = re.compile(
    r"(^|_)(secret|token|password|passwd|api_key|credential|private_key|"
    r"authorization|bearer|access_key|access_key_id|session_key|key)(_|$)"
)
ACTIVE_STATES = {"queued", "provisioning", "running"}
TERMINAL_STATES = {"succeeded", "failed", "cancelled"}
RESOURCE_KEYS = {"cpuMillicores", "memoryMb", "gpuCount", "wallTimeSeconds"}
SUBMISSION_KEYS = {
    "runId",
    "missionId",
    "generation",
    "idempotencyKey",
    "submittedAt",
    "imageDigest",
    "kernel",
    "parameters",
    "resources",
    "inputs",
}
INPUT_KEYS = {
    "artifactVersionId",
    "role",
    "mediaType",
    "sha256",
    "size",
    "reference",
}
REFERENCE_KEYS = {"url", "expiresAt", "sha256", "size", "method"}
PERSISTED_INPUT_KEYS = {
    "artifactVersionId",
    "role",
    "mediaType",
    "sha256",
    "size",
}
JOB_KEYS = {
    "handle",
    "idempotencyKey",
    "payloadDigest",
    "generation",
    "submission",
    "state",
    "progress",
    "message",
    "error",
    "output",
    "cancelRequested",
    "createdAt",
    "updatedAt",
}
OUTPUT_KEYS = {
    "reference",
    "logicalName",
    "kind",
    "format",
    "mediaType",
    "sha256",
    "size",
    "metadata",
}


class ContractError(Exception):
    def __init__(self, status: int, code: str, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.code = code
        self.detail = detail


def canonical_json(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def decode_json(raw: bytes) -> Any:
    def exact_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError(f"duplicate JSON key {key!r}")
            result[key] = value
        return result

    return json.loads(raw, object_pairs_hook=exact_pairs)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def bounded_string(value: Any, field: str, minimum: int, maximum: int) -> str:
    if not isinstance(value, str):
        raise ContractError(422, "invalid_request", f"{field} must be a string")
    if (
        len(value) < minimum
        or len(value) > maximum
        or any(ord(character) < 0x20 or ord(character) == 0x7F for character in value)
    ):
        raise ContractError(
            422,
            "invalid_request",
            f"{field} must contain {minimum}-{maximum} non-control characters",
        )
    return value


def exact_object(value: Any, field: str, keys: set[str]) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ContractError(422, "invalid_request", f"{field} must be an object")
    unknown = sorted(set(value) - keys)
    missing = sorted(keys - set(value))
    if unknown:
        raise ContractError(
            422, "invalid_request", f"{field} contains unknown keys: {', '.join(unknown)}"
        )
    if missing:
        raise ContractError(
            422, "invalid_request", f"{field} is missing keys: {', '.join(missing)}"
        )
    return value


def positive_int(value: Any, field: str, maximum: int, *, allow_zero: bool = False) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ContractError(422, "invalid_request", f"{field} must be an integer")
    minimum = 0 if allow_zero else 1
    if value < minimum or value > maximum:
        raise ContractError(
            422, "invalid_request", f"{field} must be between {minimum} and {maximum}"
        )
    return value


def parse_datetime(value: Any, field: str) -> str:
    text = bounded_string(value, field, 1, 100)
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ContractError(422, "invalid_request", f"{field} must be ISO-8601") from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ContractError(
            422, "invalid_request", f"{field} must include an explicit timezone"
        )
    return text


def normalized_origin(value: str, field: str, *, allow_path: bool) -> str:
    try:
        parsed = urlparse(value)
        port = parsed.port
    except ValueError as exc:
        raise ContractError(422, "invalid_request", f"{field} is not a valid URL") from exc
    if (
        parsed.scheme.lower() not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.fragment
        or (not allow_path and (parsed.path not in {"", "/"} or parsed.query))
    ):
        raise ContractError(
            422,
            "invalid_request",
            f"{field} must be an HTTP(S) URL without userinfo or fragment",
        )
    scheme = parsed.scheme.lower()
    hostname = parsed.hostname.lower()
    if ":" in hostname:
        hostname = f"[{hostname}]"
    default_port = 80 if scheme == "http" else 443
    authority = hostname if port in {None, default_port} else f"{hostname}:{port}"
    return f"{scheme}://{authority}"


def reject_secret_fields(value: Any, field: str) -> None:
    """Reject credential-shaped parameter fields and pathological JSON depth."""

    nodes = 0

    def visit(node: Any, depth: int) -> None:
        nonlocal nodes
        nodes += 1
        if nodes > 10_000 or depth > 32:
            raise ContractError(
                422, "invalid_request", f"{field} exceeds JSON complexity limits"
            )
        if isinstance(node, dict):
            for key, child in node.items():
                if not isinstance(key, str) or len(key) > 200:
                    raise ContractError(
                        422,
                        "invalid_request",
                        f"{field} keys must be strings no longer than 200 characters",
                    )
                normalized = re.sub(
                    r"[^a-z0-9]+",
                    "_",
                    re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", key).lower(),
                )
                if SECRET_FIELD_PATTERN.search(normalized):
                    raise ContractError(
                        422,
                        "secret_field_forbidden",
                        f"{field} cannot contain credential-shaped field {key!r}",
                    )
                visit(child, depth + 1)
        elif isinstance(node, list):
            for child in node:
                visit(child, depth + 1)
        elif isinstance(node, str) and len(node) > 16 * 1024:
            raise ContractError(
                422, "invalid_request", f"{field} contains an oversized string"
            )

    visit(value, 0)


class RuntimeState:
    def __init__(self) -> None:
        self.host = os.getenv("SCIENCE_RUNTIME_HOST", "127.0.0.1")
        try:
            self.port = int(os.getenv("SCIENCE_RUNTIME_PORT", "8090"))
        except ValueError as exc:
            raise RuntimeError("SCIENCE_RUNTIME_PORT must be an integer") from exc
        if self.port < 0 or self.port > 65_535:
            raise RuntimeError("SCIENCE_RUNTIME_PORT must be between 0 and 65535")
        self.token = os.getenv("SCIENCE_RUNTIME_TOKEN", "").strip()
        self.allow_anonymous = os.getenv("SCIENCE_RUNTIME_ALLOW_ANONYMOUS", "") == "1"
        if not self.token and not self.allow_anonymous:
            raise RuntimeError(
                "SCIENCE_RUNTIME_TOKEN is required; set "
                "SCIENCE_RUNTIME_ALLOW_ANONYMOUS=1 only for an isolated local verifier"
            )
        if self.allow_anonymous and self.host not in {"127.0.0.1", "::1", "localhost"}:
            raise RuntimeError(
                "anonymous science runtime mode may bind only to a loopback host"
            )
        if self.token and (
            len(self.token) < 32
            or len(self.token) > 4096
            or any(character in self.token for character in "\x00\r\n")
        ):
            raise RuntimeError(
                "SCIENCE_RUNTIME_TOKEN must contain 32-4096 characters and no controls"
            )

        self.state_dir = Path(
            os.getenv("SCIENCE_RUNTIME_STATE_DIR", "/var/lib/science-runtime")
        ).resolve()
        self.output_dir = self.state_dir / "outputs"
        self.state_file = self.state_dir / "state.json"
        self.instance_file = self.state_dir / "instance-id"
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self.output_dir.mkdir(parents=True, exist_ok=True)
        self.instance_id = self._load_or_create_instance_id()

        self.max_concurrency = positive_int(
            int(os.getenv("SCIENCE_RUNTIME_MAX_CONCURRENCY", "2")),
            "SCIENCE_RUNTIME_MAX_CONCURRENCY",
            64,
        )
        self.default_delay_ms = positive_int(
            int(os.getenv("SCIENCE_RUNTIME_FIXTURE_DELAY_MS", "100")),
            "SCIENCE_RUNTIME_FIXTURE_DELAY_MS",
            30_000,
            allow_zero=True,
        )
        self.limits = {
            "cpuMillicores": positive_int(
                int(os.getenv("SCIENCE_RUNTIME_MAX_CPU_MILLICORES", "1000")),
                "SCIENCE_RUNTIME_MAX_CPU_MILLICORES",
                1_000_000,
            ),
            "memoryMb": positive_int(
                int(os.getenv("SCIENCE_RUNTIME_MAX_MEMORY_MB", "512")),
                "SCIENCE_RUNTIME_MAX_MEMORY_MB",
                16_777_216,
            ),
            "gpuCount": positive_int(
                int(os.getenv("SCIENCE_RUNTIME_MAX_GPU_COUNT", "0")),
                "SCIENCE_RUNTIME_MAX_GPU_COUNT",
                64,
                allow_zero=True,
            ),
            "wallTimeSeconds": positive_int(
                int(os.getenv("SCIENCE_RUNTIME_MAX_WALL_SECONDS", "300")),
                "SCIENCE_RUNTIME_MAX_WALL_SECONDS",
                31_536_000,
            ),
        }
        digest_config = os.getenv(
            "SCIENCE_RUNTIME_ALLOWED_IMAGE_DIGESTS", DEFAULT_IMAGE_DIGEST
        )
        self.allowed_image_digests = {
            item.strip() for item in digest_config.split(",") if item.strip()
        }
        if not self.allowed_image_digests or any(
            not IMAGE_DIGEST_PATTERN.fullmatch(item)
            for item in self.allowed_image_digests
        ):
            raise RuntimeError(
                "SCIENCE_RUNTIME_ALLOWED_IMAGE_DIGESTS must be a non-empty, "
                "comma-separated list of sha256 OCI digests"
            )
        kernel_config = os.getenv("SCIENCE_RUNTIME_ALLOWED_KERNELS", DEFAULT_KERNEL)
        self.allowed_kernels = {
            item.strip() for item in kernel_config.split(",") if item.strip()
        }
        if (
            not self.allowed_kernels
            or any(
                len(item) > 200 or "\x00" in item or "\r" in item or "\n" in item
                for item in self.allowed_kernels
            )
        ):
            raise RuntimeError(
                "SCIENCE_RUNTIME_ALLOWED_KERNELS must contain bounded non-empty values"
            )
        origin_config = os.getenv("SCIENCE_RUNTIME_ALLOWED_INPUT_ORIGINS", "")
        try:
            self.allowed_input_origins = {
                normalized_origin(item.strip(), "SCIENCE_RUNTIME_ALLOWED_INPUT_ORIGINS", allow_path=False)
                for item in origin_config.split(",")
                if item.strip()
            }
        except ContractError as exc:
            raise RuntimeError(exc.detail) from exc

        self.lock = threading.RLock()
        self.slots = threading.BoundedSemaphore(self.max_concurrency)
        self.jobs: dict[str, dict[str, Any]] = {}
        self.cancel_events: dict[str, threading.Event] = {}
        self._load()

    def _load_or_create_instance_id(self) -> str:
        """Persist one immutable identity for this durable runtime ledger."""

        try:
            value = self.instance_file.read_text("utf-8").strip()
        except FileNotFoundError:
            value = "science-runtime-" + os.urandom(16).hex()
            try:
                with self.instance_file.open("x", encoding="utf-8") as stream:
                    stream.write(value + "\n")
                    stream.flush()
                    os.fsync(stream.fileno())
            except FileExistsError:
                value = self.instance_file.read_text("utf-8").strip()
        except OSError as exc:
            raise RuntimeError(
                f"cannot read runtime instance identity {self.instance_file}: {exc}"
            ) from exc
        if not INSTANCE_PATTERN.fullmatch(value):
            raise RuntimeError(
                f"runtime instance identity {self.instance_file} is malformed"
            )
        return value

    def authenticate(self, header: str | None) -> bool:
        if not self.token:
            return self.allow_anonymous
        prefix = "Bearer "
        if not header or not header.startswith(prefix):
            return False
        return hmac.compare_digest(header[len(prefix) :], self.token)

    def _load(self) -> None:
        if not self.state_file.exists():
            return
        try:
            raw = self.state_file.read_bytes()
            if len(raw) > MAX_STATE_BYTES:
                raise ValueError("state file exceeds 64 MiB")
            state = decode_json(raw)
            if (
                not isinstance(state, dict)
                or set(state) != {"schemaVersion", "jobs"}
                or state.get("schemaVersion") != STATE_SCHEMA_VERSION
                or not isinstance(state.get("jobs"), list)
            ):
                raise ValueError("state document has an unsupported shape")
            if len(state["jobs"]) > MAX_JOBS:
                raise ValueError("state document contains too many jobs")
            for job in state["jobs"]:
                self._validate_loaded_job(job)
                handle = job["handle"]
                if handle in self.jobs:
                    raise ValueError("state document contains a duplicate handle")
                self.jobs[handle] = job
                self.cancel_events[handle] = threading.Event()
            recovered = False
            for job in self.jobs.values():
                if job["state"] in ACTIVE_STATES:
                    job["state"] = (
                        "cancelled" if job["cancelRequested"] else "failed"
                    )
                    job["progress"] = None
                    if job["cancelRequested"]:
                        job["message"] = (
                            "runtime restart finalized the persisted cancellation request"
                        )
                        job["error"] = None
                    else:
                        job["message"] = (
                            "runtime restart interrupted a non-resumable fixture run"
                        )
                        job["error"] = (
                            "fixture runtime restarted before terminal receipt"
                        )
                    job["updatedAt"] = utc_now()
                    recovered = True
            if recovered:
                self._persist_locked()
        except Exception as exc:
            raise RuntimeError(
                f"refusing to start with corrupt state {self.state_file}: {exc}"
            ) from exc

    def _validate_loaded_job(self, job: Any) -> None:
        if not isinstance(job, dict) or set(job) != JOB_KEYS:
            raise ValueError("state document contains an invalid job shape")
        handle = job.get("handle")
        idempotency_key = job.get("idempotencyKey")
        submission = job.get("submission")
        if (
            not isinstance(handle, str)
            or not HANDLE_PATTERN.fullmatch(handle)
            or not isinstance(idempotency_key, str)
            or not 1 <= len(idempotency_key) <= 200
            or handle
            != "run-" + hashlib.sha256(idempotency_key.encode("utf-8")).hexdigest()[:32]
            or not isinstance(submission, dict)
            or set(submission) != SUBMISSION_KEYS
            or submission.get("idempotencyKey") != idempotency_key
            or not IMAGE_DIGEST_PATTERN.fullmatch(
                str(submission.get("imageDigest", ""))
            )
            or job.get("generation") != submission.get("generation")
            or not isinstance(job.get("generation"), int)
            or isinstance(job.get("generation"), bool)
            or job["generation"] < 1
            or job["generation"] > 2_147_483_647
        ):
            raise ValueError("state document contains an invalid job identity")
        inputs = submission.get("inputs")
        if (
            not isinstance(inputs, list)
            or len(inputs) > MAX_INPUTS
            or any(not isinstance(item, dict) or set(item) != PERSISTED_INPUT_KEYS for item in inputs)
        ):
            raise ValueError("state document contains invalid persisted inputs")
        try:
            bounded_string(submission.get("runId"), "runId", 1, 200)
            bounded_string(submission.get("missionId"), "missionId", 1, 200)
            bounded_string(submission.get("imageDigest"), "imageDigest", 71, 71)
            bounded_string(submission.get("kernel"), "kernel", 1, 200)
            parse_datetime(submission.get("submittedAt"), "submittedAt")
            self.validate_resources(submission.get("resources"))
            parameters = submission.get("parameters")
            if not isinstance(parameters, dict):
                raise ContractError(422, "invalid_request", "parameters must be an object")
            reject_secret_fields(parameters, "parameters")
            if len(canonical_json(parameters)) > MAX_PARAMETERS_BYTES:
                raise ContractError(422, "invalid_request", "parameters exceed 32 KiB")
            for index, item in enumerate(inputs):
                bounded_string(
                    item.get("artifactVersionId"),
                    f"inputs[{index}].artifactVersionId",
                    1,
                    200,
                )
                bounded_string(item.get("role"), f"inputs[{index}].role", 1, 200)
                bounded_string(
                    item.get("mediaType"),
                    f"inputs[{index}].mediaType",
                    1,
                    255,
                )
                if not SHA256_PATTERN.fullmatch(str(item.get("sha256", ""))):
                    raise ContractError(
                        422, "invalid_request", "persisted input checksum is invalid"
                    )
                positive_int(
                    item.get("size"),
                    f"inputs[{index}].size",
                    9_007_199_254_740_991,
                    allow_zero=True,
                )
        except ContractError as exc:
            raise ValueError(exc.detail) from exc
        expected_digest = hashlib.sha256(canonical_json(submission)).hexdigest()
        if (
            job.get("payloadDigest") != expected_digest
            or not SHA256_PATTERN.fullmatch(str(job.get("payloadDigest", "")))
            or job.get("state") not in ACTIVE_STATES | TERMINAL_STATES
            or not isinstance(job.get("cancelRequested"), bool)
            or not isinstance(job.get("message"), str)
            or len(job["message"]) > 2000
            or (
                job.get("error") is not None
                and (not isinstance(job["error"], str) or len(job["error"]) > 4000)
            )
        ):
            raise ValueError("state document contains inconsistent job state")
        progress = job.get("progress")
        if progress is not None and (
            isinstance(progress, bool)
            or not isinstance(progress, (int, float))
            or not 0 <= progress <= 1
        ):
            raise ValueError("state document contains invalid progress")
        for field in ("createdAt", "updatedAt"):
            try:
                parse_datetime(job.get(field), field)
            except ContractError as exc:
                raise ValueError(exc.detail) from exc
        output = job.get("output")
        if job["state"] == "succeeded":
            self._validate_stored_output(handle, output, verify_bytes=True)
        elif output is not None:
            raise ValueError("non-succeeded job contains an output receipt")

    def _validate_stored_output(
        self, handle: str, output: Any, *, verify_bytes: bool
    ) -> dict[str, Any]:
        if (
            not isinstance(output, dict)
            or set(output) != OUTPUT_KEYS
            or output.get("reference") != f"/v1/outputs/{handle}/result.json"
            or output.get("logicalName") != "result.json"
            or output.get("kind") != "result"
            or output.get("format") != "json"
            or output.get("mediaType") != "application/json"
            or not SHA256_PATTERN.fullmatch(str(output.get("sha256", "")))
            or isinstance(output.get("size"), bool)
            or not isinstance(output.get("size"), int)
            or output["size"] < 0
            or not isinstance(output.get("metadata"), dict)
            or len(canonical_json(output["metadata"])) > 32 * 1024
        ):
            raise ValueError("stored output receipt is invalid")
        if verify_bytes:
            target = (self.output_dir / handle / "result.json").resolve()
            expected_parent = (self.output_dir / handle).resolve()
            if target.parent != expected_parent or not target.is_file():
                raise ValueError("succeeded output bytes are missing")
            digest = hashlib.sha256()
            size = 0
            with target.open("rb") as stream:
                while chunk := stream.read(64 * 1024):
                    size += len(chunk)
                    digest.update(chunk)
            if size != output["size"] or digest.hexdigest() != output["sha256"]:
                raise ValueError("succeeded output bytes differ from their receipt")
        return output

    def _persist_locked(self) -> None:
        document = {
            "schemaVersion": STATE_SCHEMA_VERSION,
            "jobs": sorted(self.jobs.values(), key=lambda job: job["handle"]),
        }
        target = self.state_file
        temporary = self.state_dir / f".state-{os.getpid()}-{threading.get_ident()}.tmp"
        payload = canonical_json(document)
        if len(payload) > MAX_STATE_BYTES:
            raise RuntimeError("runtime state exceeds its 64 MiB durability bound")
        with temporary.open("wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, target)
        try:
            descriptor = os.open(self.state_dir, os.O_RDONLY)
            try:
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        except OSError:
            # Windows does not permit fsync on a directory. The file itself was
            # flushed and os.replace remains atomic there.
            pass

    def validate_resources(self, value: Any) -> dict[str, int]:
        row = exact_object(value, "resources", RESOURCE_KEYS)
        return {
            "cpuMillicores": positive_int(
                row["cpuMillicores"], "resources.cpuMillicores", 1_000_000
            ),
            "memoryMb": positive_int(
                row["memoryMb"], "resources.memoryMb", 16_777_216
            ),
            "gpuCount": positive_int(
                row["gpuCount"], "resources.gpuCount", 64, allow_zero=True
            ),
            "wallTimeSeconds": positive_int(
                row["wallTimeSeconds"], "resources.wallTimeSeconds", 31_536_000
            ),
        }

    def quote(self, body: Any) -> dict[str, Any]:
        row = exact_object(body, "quote", {"resources"})
        resources = self.validate_resources(row["resources"])
        exceeded = [
            key for key in sorted(RESOURCE_KEYS) if resources[key] > self.limits[key]
        ]
        available = not exceeded
        return {
            "available": available,
            "provider": PROVIDER,
            "source": "declared",
            "queueSeconds": 0 if available else None,
            "estimatedWallSeconds": (
                min(resources["wallTimeSeconds"], max(1, self.default_delay_ms / 1000))
                if available
                else None
            ),
            "cost": None,
            "limits": self.limits,
            **(
                {"reason": f"requested resources exceed declared limits: {', '.join(exceeded)}"}
                if exceeded
                else {}
            ),
        }

    def validate_submission(self, value: Any, header_key: str) -> dict[str, Any]:
        row = exact_object(value, "submission", SUBMISSION_KEYS)
        idempotency_key = bounded_string(
            row["idempotencyKey"], "idempotencyKey", 1, 200
        )
        if header_key != idempotency_key:
            raise ContractError(
                422,
                "idempotency_mismatch",
                "Idempotency-Key must exactly match submission.idempotencyKey",
            )
        image_digest = bounded_string(row["imageDigest"], "imageDigest", 71, 71)
        if not IMAGE_DIGEST_PATTERN.fullmatch(image_digest):
            raise ContractError(
                422, "invalid_request", "imageDigest must be a sha256 OCI digest"
            )
        if image_digest not in self.allowed_image_digests:
            raise ContractError(
                422,
                "image_not_allowed",
                "imageDigest is not in SCIENCE_RUNTIME_ALLOWED_IMAGE_DIGESTS",
            )
        kernel = bounded_string(row["kernel"], "kernel", 1, 200)
        if kernel not in self.allowed_kernels:
            raise ContractError(
                422,
                "kernel_not_allowed",
                "kernel is not in SCIENCE_RUNTIME_ALLOWED_KERNELS",
            )
        parameters = row["parameters"]
        if not isinstance(parameters, dict):
            raise ContractError(422, "invalid_request", "parameters must be an object")
        reject_secret_fields(parameters, "parameters")
        try:
            parameter_bytes = canonical_json(parameters)
        except (TypeError, ValueError) as exc:
            raise ContractError(
                422, "invalid_request", "parameters must be finite JSON"
            ) from exc
        if len(parameter_bytes) > MAX_PARAMETERS_BYTES:
            raise ContractError(422, "invalid_request", "parameters exceed 32 KiB")
        delay_ms = parameters.get("fixtureDelayMs", self.default_delay_ms)
        positive_int(delay_ms, "parameters.fixtureDelayMs", 30_000, allow_zero=True)
        outcome = parameters.get("fixtureOutcome", "succeeded")
        if outcome not in {"succeeded", "failed"}:
            raise ContractError(
                422,
                "invalid_request",
                "parameters.fixtureOutcome must be succeeded or failed",
            )
        resources = self.validate_resources(row["resources"])
        exceeded = [
            key for key in RESOURCE_KEYS if resources[key] > self.limits[key]
        ]
        if exceeded:
            raise ContractError(
                422,
                "resources_unavailable",
                f"requested resources exceed declared limits: {', '.join(sorted(exceeded))}",
            )
        inputs = row["inputs"]
        if not isinstance(inputs, list) or len(inputs) > MAX_INPUTS:
            raise ContractError(
                422, "invalid_request", f"inputs must contain at most {MAX_INPUTS} items"
            )
        normalized_inputs: list[dict[str, Any]] = []
        for index, item in enumerate(inputs):
            source = exact_object(item, f"inputs[{index}]", INPUT_KEYS)
            reference = exact_object(
                source["reference"], f"inputs[{index}].reference", REFERENCE_KEYS
            )
            checksum = bounded_string(
                source["sha256"], f"inputs[{index}].sha256", 64, 64
            )
            if not SHA256_PATTERN.fullmatch(checksum):
                raise ContractError(
                    422,
                    "invalid_request",
                    f"inputs[{index}].sha256 must be lowercase hexadecimal",
                )
            size = positive_int(
                source["size"],
                f"inputs[{index}].size",
                9_007_199_254_740_991,
                allow_zero=True,
            )
            reference_url = bounded_string(
                reference["url"], f"inputs[{index}].reference.url", 1, 4096
            )
            origin = normalized_origin(
                reference_url,
                f"inputs[{index}].reference.url",
                allow_path=True,
            )
            if origin not in self.allowed_input_origins:
                raise ContractError(
                    422,
                    "input_origin_not_allowed",
                    f"inputs[{index}].reference.url origin is not allowlisted",
                )
            if reference["method"] != "GET":
                raise ContractError(
                    422,
                    "invalid_request",
                    f"inputs[{index}].reference.method must be GET",
                )
            if reference["sha256"] != checksum or reference["size"] != size:
                raise ContractError(
                    422,
                    "invalid_request",
                    f"inputs[{index}] receipt differs from its reference",
                )
            normalized_inputs.append(
                {
                    "artifactVersionId": bounded_string(
                        source["artifactVersionId"],
                        f"inputs[{index}].artifactVersionId",
                        1,
                        200,
                    ),
                    "role": bounded_string(
                        source["role"], f"inputs[{index}].role", 1, 200
                    ),
                    "mediaType": bounded_string(
                        source["mediaType"], f"inputs[{index}].mediaType", 1, 255
                    ),
                    "sha256": checksum,
                    "size": size,
                }
            )
            # Validate the ephemeral reference, then deliberately discard it.
            # This deterministic fixture does not fetch inputs, and persisting
            # signed query strings would retain temporary credentials. A real
            # executor must fetch/copy the input before acknowledging submit.
            expiry_text = parse_datetime(
                reference["expiresAt"],
                f"inputs[{index}].reference.expiresAt",
            )
            expiry = datetime.fromisoformat(expiry_text.replace("Z", "+00:00"))
            if expiry <= datetime.now(timezone.utc):
                raise ContractError(
                    422,
                    "input_reference_expired",
                    f"inputs[{index}].reference has expired",
                )
        return {
            "runId": bounded_string(row["runId"], "runId", 1, 200),
            "missionId": bounded_string(row["missionId"], "missionId", 1, 200),
            "generation": positive_int(row["generation"], "generation", 2_147_483_647),
            "idempotencyKey": idempotency_key,
            "submittedAt": parse_datetime(row["submittedAt"], "submittedAt"),
            "imageDigest": image_digest,
            "kernel": kernel,
            "parameters": parameters,
            "resources": resources,
            "inputs": normalized_inputs,
        }

    def submit(self, body: Any, header_key: str) -> tuple[int, dict[str, str]]:
        submission = self.validate_submission(body, header_key)
        payload_digest = hashlib.sha256(canonical_json(submission)).hexdigest()
        handle = "run-" + hashlib.sha256(
            submission["idempotencyKey"].encode("utf-8")
        ).hexdigest()[:32]
        with self.lock:
            existing = self.jobs.get(handle)
            if existing:
                if (
                    existing["idempotencyKey"] != submission["idempotencyKey"]
                    or existing["payloadDigest"] != payload_digest
                ):
                    raise ContractError(
                        409,
                        "idempotency_conflict",
                        "Idempotency-Key was already used with a different submission",
                    )
                return 200, {"handle": handle}
            if len(self.jobs) >= MAX_JOBS:
                raise ContractError(503, "capacity_exhausted", "runtime job ledger is full")
            now = utc_now()
            job = {
                "handle": handle,
                "idempotencyKey": submission["idempotencyKey"],
                "payloadDigest": payload_digest,
                "generation": submission["generation"],
                "submission": submission,
                "state": "queued",
                "progress": 0.0,
                "message": "queued for deterministic fixture execution",
                "error": None,
                "output": None,
                "cancelRequested": False,
                "createdAt": now,
                "updatedAt": now,
            }
            self.jobs[handle] = job
            self.cancel_events[handle] = threading.Event()
            self._persist_locked()
        worker = threading.Thread(
            target=self._execute_safe,
            args=(handle,),
            daemon=True,
            name=f"science-{handle}",
        )
        try:
            worker.start()
        except Exception:
            self._transition(
                handle,
                "failed",
                None,
                "fixture worker could not start",
                error="deterministic fixture worker startup failed",
            )
            raise
        return 201, {"handle": handle}

    def _transition(
        self,
        handle: str,
        state: str,
        progress: float | None,
        message: str,
        *,
        error: str | None = None,
        output: dict[str, Any] | None = None,
    ) -> None:
        with self.lock:
            job = self.jobs[handle]
            if job["state"] in TERMINAL_STATES:
                return
            if state == "succeeded" and (
                job["cancelRequested"] or self.cancel_events[handle].is_set()
            ):
                state = "cancelled"
                progress = None
                message = "cancellation won the terminal output commit"
                error = None
                output = None
            job["state"] = state
            job["progress"] = progress
            job["message"] = message[:2000]
            job["error"] = error[:4000] if error else None
            job["output"] = output
            job["updatedAt"] = utc_now()
            self._persist_locked()

    def _wait_or_cancel(self, handle: str, milliseconds: int) -> bool:
        return self.cancel_events[handle].wait(milliseconds / 1000)

    def _execute_safe(self, handle: str) -> None:
        try:
            self._execute(handle)
        except Exception as exc:
            self.log_worker_failure(handle, exc)
            try:
                self._transition(
                    handle,
                    "failed",
                    None,
                    "deterministic fixture worker failed",
                    error="fixture worker failed before a terminal receipt",
                )
            except Exception as transition_error:
                self.log_worker_failure(handle, transition_error)

    @staticmethod
    def log_worker_failure(handle: str, error: Exception) -> None:
        # Emit only the exception class, not its text: signed references and
        # operator-supplied parameters must never be copied into logs.
        sys.stderr.write(
            json.dumps(
                {
                    "time": utc_now(),
                    "event": "science_runtime.worker_failed",
                    "handle": handle,
                    "errorType": type(error).__name__,
                },
                separators=(",", ":"),
            )
            + "\n"
        )

    def _execute(self, handle: str) -> None:
        with self.slots:
            if self.cancel_events[handle].is_set():
                self._transition(handle, "cancelled", None, "cancelled before provisioning")
                return
            self._transition(handle, "provisioning", 0.1, "fixture environment selected")
            if self._wait_or_cancel(handle, 10):
                self._transition(handle, "cancelled", None, "cancelled during provisioning")
                return
            self._transition(handle, "running", 0.25, "building deterministic receipt")
            with self.lock:
                submission = self.jobs[handle]["submission"]
            delay_ms = submission["parameters"].get(
                "fixtureDelayMs", self.default_delay_ms
            )
            elapsed = 0
            while elapsed < delay_ms:
                step = min(50, delay_ms - elapsed)
                if self._wait_or_cancel(handle, step):
                    self._transition(handle, "cancelled", None, "cancelled during execution")
                    return
                elapsed += step
            if submission["parameters"].get("fixtureOutcome", "succeeded") == "failed":
                self._transition(
                    handle,
                    "failed",
                    None,
                    "fixture failure requested",
                    error="deterministic fixtureOutcome=failed",
                )
                return
            result = {
                "contractVersion": CONTRACT_VERSION,
                "runId": submission["runId"],
                "missionId": submission["missionId"],
                "generation": submission["generation"],
                "submittedAt": submission["submittedAt"],
                "imageDigest": submission["imageDigest"],
                "inputs": [
                    {
                        "artifactVersionId": item["artifactVersionId"],
                        "mediaType": item["mediaType"],
                        "role": item["role"],
                        "sha256": item["sha256"],
                        "size": item["size"],
                    }
                    for item in submission["inputs"]
                ],
                "kernel": submission["kernel"],
                "parameters": submission["parameters"],
                "resources": submission["resources"],
            }
            payload = canonical_json(result)
            digest = hashlib.sha256(payload).hexdigest()
            run_output_dir = self.output_dir / handle
            run_output_dir.mkdir(parents=True, exist_ok=True)
            target = run_output_dir / "result.json"
            temporary = run_output_dir / f".result-{os.getpid()}.tmp"
            with temporary.open("wb") as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, target)
            try:
                descriptor = os.open(run_output_dir, os.O_RDONLY)
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
            except OSError:
                pass
            output = {
                "reference": f"/v1/outputs/{handle}/result.json",
                "logicalName": "result.json",
                "kind": "result",
                "format": "json",
                "mediaType": "application/json",
                "sha256": digest,
                "size": len(payload),
                "metadata": {
                    "contractVersion": CONTRACT_VERSION,
                    "deterministicFixture": True,
                    "executesUserCode": False,
                },
            }
            self._transition(
                handle,
                "succeeded",
                1.0,
                "deterministic output receipt finalized",
                output=output,
            )
            with self.lock:
                committed = self.jobs[handle]["state"] == "succeeded"
            if not committed:
                target.unlink(missing_ok=True)

    def _job_for_generation(self, handle: str, generation: int) -> dict[str, Any]:
        with self.lock:
            job = self.jobs.get(handle)
            if not job:
                raise ContractError(404, "not_found", "run handle was not found")
            if job["generation"] != generation:
                raise ContractError(
                    409,
                    "generation_mismatch",
                    "request generation does not own this provider handle",
                )
            return json.loads(json.dumps(job))

    def status(self, handle: str, generation: int) -> dict[str, Any]:
        job = self._job_for_generation(handle, generation)
        response: dict[str, Any] = {
            "state": job["state"],
            "progress": job["progress"],
            "message": job["message"],
            "logs": [
                f"provider={PROVIDER}",
                f"handle={handle} generation={generation} state={job['state']}",
            ],
        }
        if job.get("error"):
            response["error"] = job["error"]
        return response

    def cancel(self, handle: str, generation: int) -> tuple[int, dict[str, bool]]:
        job = self._job_for_generation(handle, generation)
        if job["state"] in TERMINAL_STATES:
            return 200, {"accepted": False}
        with self.lock:
            current = self.jobs[handle]
            if current["state"] in TERMINAL_STATES:
                return 200, {"accepted": False}
            current["cancelRequested"] = True
            current["message"] = "cancellation requested"
            current["updatedAt"] = utc_now()
            self.cancel_events[handle].set()
            self._persist_locked()
        return 202, {"accepted": True}

    def outputs(self, handle: str, generation: int) -> dict[str, Any]:
        job = self._job_for_generation(handle, generation)
        if job["state"] != "succeeded" or not job.get("output"):
            raise ContractError(
                409,
                "outputs_not_ready",
                f"outputs are unavailable while run state is {job['state']}",
            )
        encoded = canonical_json([job["output"]])
        if len(encoded) > MAX_CONTROL_RESPONSE_BYTES or b"data:" in encoded.lower():
            raise ContractError(500, "invalid_receipt", "stored output receipt is not bounded")
        return {"outputs": [job["output"]]}

    def output_path(self, handle: str, logical_name: str) -> tuple[Path, dict[str, Any]]:
        if not HANDLE_PATTERN.fullmatch(handle) or logical_name != "result.json":
            raise ContractError(404, "not_found", "output reference was not found")
        with self.lock:
            job = self.jobs.get(handle)
            if not job or job["state"] != "succeeded" or not job.get("output"):
                raise ContractError(404, "not_found", "output reference was not found")
            output = json.loads(json.dumps(job["output"]))
        try:
            self._validate_stored_output(handle, output, verify_bytes=True)
        except ValueError as exc:
            raise ContractError(
                500, "receipt_mismatch", "output bytes differ from their receipt"
            ) from exc
        target = (self.output_dir / handle / logical_name).resolve()
        return target, output


class ScienceRuntimeServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], state: RuntimeState) -> None:
        super().__init__(address, ScienceRuntimeHandler)
        self.state = state


class ScienceRuntimeHandler(BaseHTTPRequestHandler):
    server: ScienceRuntimeServer
    protocol_version = "HTTP/1.1"
    server_version = "PuppetmasterScienceRuntime"
    sys_version = ""

    def log_message(self, message: str, *args: Any) -> None:
        sys.stderr.write(
            json.dumps(
                {
                    "time": utc_now(),
                    "remote": self.client_address[0],
                    "message": message % args,
                },
                separators=(",", ":"),
            )
            + "\n"
        )

    def _headers(self, status: int, content_type: str, length: int) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'none'")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Connection", "close")
        self.end_headers()

    def _json(self, status: int, value: Any) -> None:
        payload = canonical_json(value)
        if len(payload) > MAX_CONTROL_RESPONSE_BYTES:
            status = 500
            payload = canonical_json(
                {
                    "error": {
                        "code": "response_too_large",
                        "detail": "control response exceeds 64 KiB",
                    }
                }
            )
        self._headers(status, "application/json; charset=utf-8", len(payload))
        self.wfile.write(payload)

    def _error(self, error: ContractError) -> None:
        self._json(
            error.status,
            {"error": {"code": error.code, "detail": error.detail[:4000]}},
        )

    def _authorized(self) -> bool:
        if self.path.split("?", 1)[0] == "/health":
            return True
        if self.server.state.authenticate(self.headers.get("Authorization")):
            return True
        self._json(
            HTTPStatus.UNAUTHORIZED,
            {"error": {"code": "unauthorized", "detail": "valid bearer token required"}},
        )
        return False

    def _body(self) -> Any:
        content_type = self.headers.get("Content-Type", "")
        if content_type.split(";", 1)[0].strip().lower() != "application/json":
            raise ContractError(415, "unsupported_media_type", "application/json is required")
        if self.headers.get("Transfer-Encoding") is not None:
            raise ContractError(
                400, "invalid_framing", "Transfer-Encoding is not accepted"
            )
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) != 1:
            raise ContractError(
                411, "length_required", "exactly one Content-Length is required"
            )
        try:
            length = int(lengths[0])
        except ValueError as exc:
            raise ContractError(411, "length_required", "valid Content-Length required") from exc
        if length < 0 or length > MAX_REQUEST_BYTES:
            raise ContractError(413, "payload_too_large", "request body exceeds 1 MiB")
        raw = self.rfile.read(length)
        if len(raw) != length:
            raise ContractError(400, "invalid_json", "request body was truncated")
        try:
            return decode_json(raw)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            raise ContractError(
                400,
                "invalid_json",
                "request body must be valid JSON without duplicate keys",
            ) from exc

    def _generation_query(self, parsed: Any) -> int:
        values = parse_qs(parsed.query, strict_parsing=True)
        if set(values) != {"generation"} or len(values["generation"]) != 1:
            raise ContractError(
                422, "invalid_request", "exactly one generation query parameter is required"
            )
        try:
            generation = int(values["generation"][0])
        except ValueError as exc:
            raise ContractError(
                422, "invalid_request", "generation must be an integer"
            ) from exc
        return positive_int(generation, "generation", 2_147_483_647)

    def _require_instance_fence(self) -> None:
        values = self.headers.get_all("X-Science-Provider-Instance", [])
        if len(values) != 1:
            raise ContractError(
                409,
                "provider_instance_mismatch",
                "exactly one expected provider instance header is required",
            )
        expected = bounded_string(
            values[0],
            "X-Science-Provider-Instance",
            1,
            100,
        )
        if not hmac.compare_digest(expected, self.server.state.instance_id):
            raise ContractError(
                409,
                "provider_instance_mismatch",
                "the expected provider instance is no longer active",
            )

    def do_GET(self) -> None:  # noqa: N802
        try:
            if not self._authorized():
                return
            parsed = urlparse(self.path)
            if parsed.path == "/health":
                if parsed.query or parsed.fragment:
                    raise ContractError(
                        422, "invalid_request", "query parameters are not allowed"
                    )
                self._json(
                    200,
                    {
                        "ok": True,
                        "provider": PROVIDER,
                        "version": VERSION,
                        "contractVersion": CONTRACT_VERSION,
                        "instanceId": self.server.state.instance_id,
                        "executionMode": "contract_fixture",
                        "executesUserCode": False,
                        "detail": (
                            "deterministic fixture provider only; "
                            "JEG, trame, and OCCT are disabled and unproved"
                        ),
                        "integrations": {
                            "jupyterEnterpriseGateway": "no-go",
                            "trame": "no-go",
                            "occt": "no-go",
                        },
                    },
                )
                return
            output_match = re.fullmatch(
                r"/v1/outputs/(run-[0-9a-f]{32})/(result\.json)", parsed.path
            )
            if output_match:
                self._require_instance_fence()
                if parsed.query or parsed.fragment:
                    raise ContractError(
                        422, "invalid_request", "query parameters are not allowed"
                    )
                target, receipt = self.server.state.output_path(*output_match.groups())
                size = target.stat().st_size
                self.send_response(200)
                self.send_header("Content-Type", receipt["mediaType"])
                self.send_header("Content-Length", str(size))
                self.send_header("ETag", f'"sha256:{receipt["sha256"]}"')
                self.send_header("Cache-Control", "private, immutable, max-age=31536000")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("Content-Security-Policy", "default-src 'none'")
                self.send_header("Cross-Origin-Resource-Policy", "same-origin")
                self.send_header("Connection", "close")
                self.end_headers()
                with target.open("rb") as stream:
                    while chunk := stream.read(64 * 1024):
                        self.wfile.write(chunk)
                return
            status_match = re.fullmatch(r"/v1/runs/(run-[0-9a-f]{32})", parsed.path)
            if status_match:
                self._require_instance_fence()
                generation = self._generation_query(parsed)
                self._json(
                    200,
                    self.server.state.status(status_match.group(1), generation),
                )
                return
            output_list_match = re.fullmatch(
                r"/v1/runs/(run-[0-9a-f]{32})/outputs", parsed.path
            )
            if output_list_match:
                self._require_instance_fence()
                generation = self._generation_query(parsed)
                self._json(
                    200,
                    self.server.state.outputs(output_list_match.group(1), generation),
                )
                return
            raise ContractError(404, "not_found", "route was not found")
        except ContractError as error:
            self._error(error)
        except ValueError:
            self._error(
                ContractError(422, "invalid_request", "query parameters are malformed")
            )
        except Exception as error:
            self.log_message("unhandled GET failure: %s", type(error).__name__)
            self._error(ContractError(500, "internal_error", "internal provider error"))

    def do_POST(self) -> None:  # noqa: N802
        try:
            if not self._authorized():
                return
            parsed = urlparse(self.path)
            if parsed.query:
                raise ContractError(422, "invalid_request", "query parameters are not allowed")
            if parsed.path == "/v1/quote":
                self._json(200, self.server.state.quote(self._body()))
                return
            if parsed.path == "/v1/runs":
                self._require_instance_fence()
                header_key = self.headers.get("Idempotency-Key", "")
                bounded_string(header_key, "Idempotency-Key", 1, 200)
                status, response = self.server.state.submit(self._body(), header_key)
                self._json(status, response)
                return
            cancel_match = re.fullmatch(
                r"/v1/runs/(run-[0-9a-f]{32})/cancel", parsed.path
            )
            if cancel_match:
                self._require_instance_fence()
                body = exact_object(self._body(), "cancel", {"generation"})
                generation = positive_int(
                    body["generation"], "generation", 2_147_483_647
                )
                status, response = self.server.state.cancel(
                    cancel_match.group(1), generation
                )
                self._json(status, response)
                return
            raise ContractError(404, "not_found", "route was not found")
        except ContractError as error:
            self._error(error)
        except Exception as error:
            self.log_message("unhandled POST failure: %s", type(error).__name__)
            self._error(ContractError(500, "internal_error", "internal provider error"))


def main() -> int:
    # New ledger/output files are private to the unprivileged runtime identity.
    os.umask(0o077)
    state = RuntimeState()
    server = ScienceRuntimeServer((state.host, state.port), state)

    def stop(_signum: int, _frame: Any) -> None:
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    actual_host, actual_port = server.server_address[:2]
    print(
        json.dumps(
            {
                "event": "science_runtime.started",
                "host": actual_host,
                "port": actual_port,
                "provider": PROVIDER,
                "version": VERSION,
            },
            separators=(",", ":"),
        ),
        flush=True,
    )
    try:
        server.serve_forever(poll_interval=0.2)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
