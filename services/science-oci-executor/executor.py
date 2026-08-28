"""Fail-closed, production-intent OCI execution core for Science Operations.

This module is deliberately separate from ``services/science-runtime``.  The
runtime there is a deterministic wire-contract fixture and must never grow an
execution path.  This core supplies the missing per-run OCI boundary to a
future thin HTTP ``/v1`` service, while remaining testable with a fake engine.

The only process-launching implementation in this file invokes Docker or
Podman with an argument vector and ``shell=False``.  Signed input URLs are
consumed by the staging layer and are never passed to the engine or persisted.
"""

from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import posixpath
import re
import secrets
import shutil
import stat
import subprocess
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterator, Mapping, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener


LEDGER_VERSION = 1
EXECUTOR_VERSION = "0.1.0"
EXECUTION_CONTRACT = "science-oci-execution.v1"
STATE_FIXED_RESERVATION_BYTES = 64 * 1024 * 1024
JOB_STATE_RESERVATION_BYTES = 256 * 1024
IMAGE_DIGEST = re.compile(r"^sha256:[0-9a-f]{64}$")
INSTANCE_ID = re.compile(r"^science-oci-[0-9a-f]{32}$")
SAFE_KERNEL = re.compile(r"^[A-Za-z0-9._+-]{1,200}$")
SAFE_HANDLE = re.compile(r"^run-[0-9a-f]{32}$")
SECRET_FIELD = re.compile(
    r"(^|_)(secret|token|password|passwd|api_key|credential|private_key|"
    r"authorization|bearer|access_key|access_key_id|session_key|key)(_|$)",
    re.IGNORECASE,
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


class ExecutorError(RuntimeError):
    """A bounded failure safe to map to a provider error."""


class AdmissionError(ExecutorError):
    """The configured engine boundary has not passed admission."""


class FenceError(ExecutorError):
    """An operation targeted another provider instance or generation."""


class ConflictError(ExecutorError):
    """An idempotency identity was reused with different semantics."""


class CancellationError(ExecutorError):
    """Input staging observed a durable cancellation request."""


def _fsync_file(path: Path) -> None:
    """Flush an existing regular file without following an unexpected symlink."""
    if path.is_symlink() or not path.is_file():
        raise ExecutorError("durable state path is not a regular file")
    original_mode = stat.S_IMODE(path.stat().st_mode)
    changed_mode = False
    try:
        if os.name == "nt" and not original_mode & stat.S_IWUSR:
            os.chmod(path, original_mode | stat.S_IWUSR)
            changed_mode = True
        with path.open("r+b" if os.name == "nt" else "rb") as stream:
            os.fsync(stream.fileno())
    except OSError as exc:
        raise ExecutorError("durable state file could not be flushed") from exc
    finally:
        if changed_mode:
            try:
                os.chmod(path, original_mode)
            except OSError as exc:
                raise ExecutorError("durable state file mode could not be restored") from exc


def _fsync_directory(path: Path) -> None:
    """Flush directory entries where the host supports directory fsync."""
    if os.name == "nt":
        # Python cannot open Windows directories for fsync. os.replace remains
        # atomic, but retained live evidence must cover host crash durability.
        return
    try:
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    except OSError as exc:
        raise ExecutorError("durable state directory could not be flushed") from exc


def _fsync_tree(root: Path) -> None:
    if root.is_symlink() or not root.is_dir():
        raise ExecutorError("durable state tree is not a directory")
    directories = [root]
    for path in root.rglob("*"):
        if path.is_symlink():
            raise ExecutorError("durable state tree contains a symbolic link")
        if path.is_file():
            _fsync_file(path)
        elif path.is_dir():
            directories.append(path)
        else:
            raise ExecutorError("durable state tree contains a special file")
    for directory in reversed(directories):
        _fsync_directory(directory)


def canonical_json(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def _bounded_text(value: Any, field: str, minimum: int, maximum: int) -> str:
    if not isinstance(value, str):
        raise ExecutorError(f"{field} must be a string")
    if not minimum <= len(value) <= maximum:
        raise ExecutorError(f"{field} must contain {minimum}-{maximum} characters")
    if any(ord(character) < 0x20 or ord(character) == 0x7F for character in value):
        raise ExecutorError(f"{field} contains a control character")
    return value


def _exact_object(value: Any, field: str, keys: set[str]) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        raise ExecutorError(f"{field} must contain exactly {', '.join(sorted(keys))}")
    return value


def _integer(
    value: Any, field: str, minimum: int, maximum: int
) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ExecutorError(f"{field} must be an integer")
    if value < minimum or value > maximum:
        raise ExecutorError(f"{field} must be between {minimum} and {maximum}")
    return value


def _parse_time(value: Any, field: str) -> datetime:
    text = _bounded_text(value, field, 1, 100)
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ExecutorError(f"{field} must be an ISO-8601 timestamp") from exc
    if parsed.tzinfo is None:
        raise ExecutorError(f"{field} must include a timezone")
    return parsed.astimezone(timezone.utc)


def _reject_secret_fields(value: Any, field: str) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            if not isinstance(key, str) or SECRET_FIELD.search(key):
                raise ExecutorError(f"{field} contains a secret-like field")
            _reject_secret_fields(child, f"{field}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _reject_secret_fields(child, f"{field}[{index}]")


def _origin(url: str) -> str:
    parsed = urlsplit(url)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise ExecutorError("input reference URL must use HTTP or HTTPS")
    if parsed.username or parsed.password or parsed.fragment:
        raise ExecutorError("input reference URL contains forbidden components")
    host = parsed.hostname.lower()
    if ":" in host:
        host = f"[{host}]"
    default_port = 80 if parsed.scheme == "http" else 443
    port = parsed.port
    return f"{parsed.scheme}://{host}" + (
        f":{port}" if port is not None and port != default_port else ""
    )


def _digest_file(
    path: Path, should_cancel: Callable[[], bool] | None = None
) -> tuple[int, str]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            if should_cancel and should_cancel():
                raise CancellationError("file verification was cancelled")
            size += len(chunk)
            digest.update(chunk)
    return size, digest.hexdigest()


@dataclass(frozen=True)
class ResourceLimits:
    cpu_millicores: int = 4000
    memory_mb: int = 8192
    gpu_count: int = 0
    wall_time_seconds: int = 3600
    pids: int = 256


@dataclass(frozen=True)
class OciExecutorConfig:
    state_dir: Path
    engine_kind: str
    engine_binary: Path
    engine_endpoint: str
    expected_engine_id: str
    image_map: Mapping[str, str]
    allowed_kernels: frozenset[str]
    allowed_input_origins: frozenset[str]
    admitted: bool
    engine_boundary: str
    seccomp_profile: Path
    seccomp_sha256: str
    limits: ResourceLimits = ResourceLimits()
    container_uid: int = 65532
    container_gid: int = 65532
    max_inputs: int = 200
    max_input_bytes: int = 2 * 1024 * 1024 * 1024
    max_outputs: int = 200
    max_concurrency: int = 4
    max_output_file_bytes: int = 1024 * 1024 * 1024
    max_output_total_bytes: int = 2 * 1024 * 1024 * 1024
    max_state_bytes: int = 16 * 1024 * 1024 * 1024
    engine_timeout_seconds: int = 30
    poll_interval_seconds: float = 0.25
    health_cache_seconds: float = 2.0
    terminal_retention_seconds: int = 7 * 24 * 60 * 60
    max_tombstones: int = 4096

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "OciExecutorConfig":
        source = os.environ if env is None else env
        required = (
            "SCIENCE_OCI_STATE_DIR",
            "SCIENCE_OCI_ENGINE",
            "SCIENCE_OCI_ENGINE_BINARY",
            "SCIENCE_OCI_ENGINE_ENDPOINT",
            "SCIENCE_OCI_EXPECTED_ENGINE_ID",
            "SCIENCE_OCI_SECCOMP_PROFILE",
            "SCIENCE_OCI_IMAGE_MAP_JSON",
            "SCIENCE_OCI_ALLOWED_KERNELS",
            "SCIENCE_OCI_ALLOWED_INPUT_ORIGINS",
        )
        missing = [name for name in required if not str(source.get(name, "")).strip()]
        if missing:
            raise AdmissionError(
                "OCI executor configuration is incomplete: " + ", ".join(missing)
            )
        engine_kind = source["SCIENCE_OCI_ENGINE"].strip().lower()
        if engine_kind not in {"docker", "podman"}:
            raise AdmissionError("SCIENCE_OCI_ENGINE must be docker or podman")
        binary = Path(source["SCIENCE_OCI_ENGINE_BINARY"]).expanduser()
        if not binary.is_absolute():
            raise AdmissionError("SCIENCE_OCI_ENGINE_BINARY must be an absolute path")
        endpoint = _validate_dedicated_endpoint(
            source["SCIENCE_OCI_ENGINE_ENDPOINT"].strip()
        )
        expected_engine_id = str(source["SCIENCE_OCI_EXPECTED_ENGINE_ID"]).strip()
        if (
            not 1 <= len(expected_engine_id) <= 200
            or any(ord(character) < 0x21 or ord(character) > 0x7E for character in expected_engine_id)
        ):
            raise AdmissionError("SCIENCE_OCI_EXPECTED_ENGINE_ID must be 1-200 printable ASCII characters")
        seccomp_profile = Path(source["SCIENCE_OCI_SECCOMP_PROFILE"]).expanduser()
        if not seccomp_profile.is_absolute():
            raise AdmissionError("SCIENCE_OCI_SECCOMP_PROFILE must be an absolute path")
        seccomp_profile = seccomp_profile.resolve()
        if not seccomp_profile.is_file() or seccomp_profile.is_symlink():
            raise AdmissionError("SCIENCE_OCI_SECCOMP_PROFILE must be a regular non-symbolic file")
        try:
            seccomp_bytes = seccomp_profile.read_bytes()
            if len(seccomp_bytes) > 1024 * 1024:
                raise AdmissionError("SCIENCE_OCI_SECCOMP_PROFILE exceeds 1 MiB")
            seccomp_row = json.loads(seccomp_bytes.decode("utf-8", errors="strict"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise AdmissionError("SCIENCE_OCI_SECCOMP_PROFILE must be readable JSON") from exc
        if not isinstance(seccomp_row, dict) or not seccomp_row:
            raise AdmissionError("SCIENCE_OCI_SECCOMP_PROFILE must contain a JSON object")
        _validate_seccomp_policy(seccomp_row)
        seccomp_sha256 = hashlib.sha256(seccomp_bytes).hexdigest()
        state_dir = Path(source["SCIENCE_OCI_STATE_DIR"]).expanduser().resolve()
        if "," in str(state_dir) or any(ch in str(state_dir) for ch in "\r\n"):
            raise AdmissionError("SCIENCE_OCI_STATE_DIR cannot contain comma or newline")
        try:
            image_map_raw = json.loads(source["SCIENCE_OCI_IMAGE_MAP_JSON"])
        except (TypeError, json.JSONDecodeError) as exc:
            raise AdmissionError("SCIENCE_OCI_IMAGE_MAP_JSON must be JSON") from exc
        if not isinstance(image_map_raw, dict) or not image_map_raw:
            raise AdmissionError("SCIENCE_OCI_IMAGE_MAP_JSON must be a non-empty object")
        image_map: dict[str, str] = {}
        for digest, reference in image_map_raw.items():
            if not isinstance(digest, str) or not IMAGE_DIGEST.fullmatch(digest):
                raise AdmissionError("OCI image map contains an invalid digest")
            if not isinstance(reference, str) or not reference.endswith("@" + digest):
                raise AdmissionError("every OCI image reference must end in its mapped digest")
            if reference.count("@") != 1 or any(character.isspace() for character in reference):
                raise AdmissionError("OCI image references must be immutable and whitespace-free")
            image_map[digest] = reference
        kernels = frozenset(
            item.strip()
            for item in source["SCIENCE_OCI_ALLOWED_KERNELS"].split(",")
            if item.strip()
        )
        if not kernels or any(not SAFE_KERNEL.fullmatch(item) for item in kernels):
            raise AdmissionError("SCIENCE_OCI_ALLOWED_KERNELS is invalid")
        configured_origins: set[str] = set()
        for item in source["SCIENCE_OCI_ALLOWED_INPUT_ORIGINS"].split(","):
            candidate = item.strip()
            if not candidate:
                continue
            parsed_origin = urlsplit(candidate)
            if parsed_origin.path not in {"", "/"} or parsed_origin.query or parsed_origin.fragment:
                raise AdmissionError(
                    "SCIENCE_OCI_ALLOWED_INPUT_ORIGINS entries must be exact origins"
                )
            configured_origins.add(_origin(candidate))
        origins = frozenset(configured_origins)
        if not origins:
            raise AdmissionError("SCIENCE_OCI_ALLOWED_INPUT_ORIGINS is empty")

        def bounded_int(name: str, default: int, minimum: int, maximum: int) -> int:
            raw = str(source.get(name, default)).strip()
            try:
                value = int(raw)
            except ValueError as exc:
                raise AdmissionError(f"{name} must be an integer") from exc
            if value < minimum or value > maximum:
                raise AdmissionError(f"{name} must be between {minimum} and {maximum}")
            return value

        limits = ResourceLimits(
            cpu_millicores=bounded_int(
                "SCIENCE_OCI_MAX_CPU_MILLICORES", 4000, 1, 1_000_000
            ),
            memory_mb=bounded_int(
                "SCIENCE_OCI_MAX_MEMORY_MB", 8192, 16, 16_777_216
            ),
            # GPU device isolation is deliberately not admitted in this slice.
            gpu_count=0,
            wall_time_seconds=bounded_int(
                "SCIENCE_OCI_MAX_WALL_SECONDS", 3600, 1, 31_536_000
            ),
            pids=bounded_int("SCIENCE_OCI_MAX_PIDS", 256, 16, 4096),
        )
        parsed_config = cls(
            state_dir=state_dir,
            engine_kind=engine_kind,
            engine_binary=binary,
            engine_endpoint=endpoint,
            expected_engine_id=expected_engine_id,
            image_map=image_map,
            allowed_kernels=kernels,
            allowed_input_origins=origins,
            admitted=str(source.get("SCIENCE_OCI_EXECUTOR_ADMISSION", "")).lower()
            == "approved",
            engine_boundary=str(source.get("SCIENCE_OCI_ENGINE_BOUNDARY", "")).lower(),
            seccomp_profile=seccomp_profile,
            seccomp_sha256=seccomp_sha256,
            limits=limits,
            container_uid=bounded_int("SCIENCE_OCI_CONTAINER_UID", 65532, 10000, 2**31 - 1),
            container_gid=bounded_int("SCIENCE_OCI_CONTAINER_GID", 65532, 10000, 2**31 - 1),
            max_input_bytes=bounded_int(
                "SCIENCE_OCI_MAX_INPUT_BYTES", 2 * 1024**3, 1, 16 * 1024**3
            ),
            max_output_file_bytes=bounded_int(
                "SCIENCE_OCI_MAX_OUTPUT_FILE_BYTES", 1024**3, 1, 16 * 1024**3
            ),
            max_output_total_bytes=bounded_int(
                "SCIENCE_OCI_MAX_OUTPUT_TOTAL_BYTES", 2 * 1024**3, 1, 32 * 1024**3
            ),
            max_state_bytes=bounded_int(
                "SCIENCE_OCI_MAX_STATE_BYTES",
                16 * 1024**3,
                STATE_FIXED_RESERVATION_BYTES + JOB_STATE_RESERVATION_BYTES + 1,
                1024 * 1024**4,
            ),
            max_concurrency=bounded_int("SCIENCE_OCI_MAX_CONCURRENCY", 4, 1, 64),
            terminal_retention_seconds=bounded_int(
                "SCIENCE_OCI_TERMINAL_RETENTION_SECONDS", 7 * 24 * 60 * 60, 3600, 31_536_000
            ),
            max_tombstones=bounded_int(
                "SCIENCE_OCI_MAX_TOMBSTONES", 4096, 64, 65536
            ),
        )
        minimum_state_reservation = (
            STATE_FIXED_RESERVATION_BYTES
            + JOB_STATE_RESERVATION_BYTES
            + parsed_config.max_output_total_bytes
        )
        if parsed_config.max_state_bytes < minimum_state_reservation:
            raise AdmissionError(
                "SCIENCE_OCI_MAX_STATE_BYTES cannot reserve one maximum output set"
            )
        return parsed_config


def _validate_seccomp_policy(row: Mapping[str, Any]) -> None:
    """Reject profiles whose default action does not actually filter syscalls."""
    deny_actions = {
        "SCMP_ACT_ERRNO",
        "SCMP_ACT_KILL",
        "SCMP_ACT_KILL_PROCESS",
        "SCMP_ACT_KILL_THREAD",
        "SCMP_ACT_TRAP",
    }
    if row.get("defaultAction") not in deny_actions:
        raise AdmissionError("OCI seccomp defaultAction must deny unlisted syscalls")
    syscalls = row.get("syscalls")
    if not isinstance(syscalls, list):
        raise AdmissionError("OCI seccomp profile must contain a syscall rule list")
    for rule in syscalls:
        if (
            not isinstance(rule, dict)
            or not isinstance(rule.get("names"), list)
            or not rule["names"]
            or not all(isinstance(name, str) and name for name in rule["names"])
            or not isinstance(rule.get("action"), str)
        ):
            raise AdmissionError("OCI seccomp profile contains an invalid syscall rule")


def _validate_dedicated_endpoint(endpoint: str) -> str:
    """Return one canonical local endpoint and reject aliases of host defaults."""
    if (
        not endpoint
        or any(character in endpoint for character in "\r\n\0")
        or any(character.isspace() for character in endpoint)
    ):
        raise AdmissionError("the OCI engine endpoint contains a forbidden character")
    parsed = urlsplit(endpoint)
    if parsed.query or parsed.fragment or parsed.username or parsed.password:
        raise AdmissionError("the OCI engine endpoint contains forbidden URI components")
    scheme = parsed.scheme.lower()
    if scheme == "unix":
        if parsed.netloc or not parsed.path.startswith("/") or "\\" in parsed.path:
            raise AdmissionError("the OCI Unix endpoint must contain an absolute socket path")
        canonical_path = "/" + posixpath.normpath(
            "/" + parsed.path.lstrip("/")
        ).lstrip("/")
        if os.name != "nt":
            # Resolve existing symlink aliases as well as lexical dot segments.
            try:
                canonical_path = Path(canonical_path).resolve(strict=False).as_posix()
            except (OSError, RuntimeError) as exc:
                raise AdmissionError(
                    "the OCI Unix endpoint could not be canonicalized"
                ) from exc
        if canonical_path.rstrip("/").lower() in {
            "/var/run/docker.sock",
            "/run/docker.sock",
        }:
            raise AdmissionError("the default host Docker endpoint is forbidden")
        return "unix://" + canonical_path
    if scheme == "npipe":
        normalized = endpoint.replace("\\", "/")
        raw_path = normalized.split("://", 1)[1].lstrip("/")
        if not raw_path.lower().startswith("./pipe/"):
            raise AdmissionError("the OCI named-pipe endpoint is invalid")
        pipe_name = posixpath.normpath(raw_path[7:]).strip("/")
        if (
            not pipe_name
            or pipe_name.startswith("../")
            or pipe_name == ".."
            or any(part in {"", ".", ".."} for part in pipe_name.split("/"))
        ):
            raise AdmissionError("the OCI named-pipe endpoint is invalid")
        if pipe_name.lower() == "docker_engine":
            raise AdmissionError("the default host Docker endpoint is forbidden")
        return "npipe:////./pipe/" + pipe_name
    raise AdmissionError("the OCI engine endpoint must be a local unix or named pipe")


@dataclass(frozen=True)
class EngineProbe:
    kind: str
    endpoint: str
    engine_id: str
    rootless: bool


@dataclass(frozen=True)
class EngineContainer:
    id: str
    name: str
    labels: Mapping[str, str]
    state: str
    exit_code: int | None


@dataclass(frozen=True)
class ContainerSpec:
    name: str
    image_reference: str
    labels: Mapping[str, str]
    input_dir: Path
    control_dir: Path
    output_dir: Path
    resources: Mapping[str, int]
    uid: int
    gid: int
    pids: int
    max_output_bytes: int


class OciEngine(Protocol):
    def probe(self) -> EngineProbe: ...

    def lookup(self, name: str) -> EngineContainer | None: ...

    def create(self, spec: ContainerSpec) -> EngineContainer: ...

    def verify_isolation(self, container_id: str, spec: ContainerSpec) -> None: ...

    def export_outputs(self, container_id: str, destination: Path) -> None: ...

    def start(self, container_id: str, timeout_seconds: int) -> None: ...

    def inspect(self, container_id: str) -> EngineContainer | None: ...

    def kill(self, container_id: str) -> None: ...

    def remove(self, container_id: str) -> None: ...


class DockerCliEngine:
    """Docker/Podman CLI adapter.  It never invokes a shell."""

    def __init__(self, config: OciExecutorConfig) -> None:
        self.config = config

    def _prefix(self) -> list[str]:
        switch = "--host" if self.config.engine_kind == "docker" else "--url"
        return [str(self.config.engine_binary), switch, self.config.engine_endpoint]

    def _run(
        self, arguments: list[str], *, check: bool = True, timeout: int | None = None
    ) -> subprocess.CompletedProcess[bytes]:
        command = [*self._prefix(), *arguments]
        try:
            process = subprocess.Popen(
                command,
                shell=False,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env={
                    key: value
                    for key, value in os.environ.items()
                    if key.upper()
                    not in {"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"}
                    and not key.upper().startswith(
                        ("DOCKER_", "CONTAINER_", "PODMAN_")
                    )
                },
                creationflags=(subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0),
            )
        except OSError as exc:
            raise ExecutorError("OCI engine command could not be executed") from exc
        if process.stdout is None or process.stderr is None:
            process.kill()
            raise ExecutorError("OCI engine command pipes were unavailable")

        limit = 256 * 1024
        stdout = bytearray()
        stderr = bytearray()
        overflow = threading.Event()
        read_errors: list[OSError] = []

        def consume(stream, target: bytearray) -> None:  # noqa: ANN001
            try:
                while chunk := stream.read(64 * 1024):
                    room = limit + 1 - len(target)
                    if room > 0:
                        target.extend(chunk[:room])
                    if len(chunk) > room or len(target) > limit:
                        overflow.set()
                        try:
                            process.kill()
                        except OSError:
                            pass
                        return
            except OSError as exc:
                read_errors.append(exc)

        readers = [
            threading.Thread(target=consume, args=(process.stdout, stdout), daemon=True),
            threading.Thread(target=consume, args=(process.stderr, stderr), daemon=True),
        ]
        for reader in readers:
            reader.start()
        deadline = timeout or self.config.engine_timeout_seconds
        timed_out = False
        try:
            return_code = process.wait(timeout=deadline)
        except subprocess.TimeoutExpired:
            timed_out = True
            try:
                process.kill()
            except OSError:
                pass
            try:
                return_code = process.wait(timeout=5)
            except (subprocess.TimeoutExpired, OSError) as exc:
                raise ExecutorError("OCI engine command could not be reaped") from exc
        except OSError as exc:
            try:
                process.kill()
            except OSError:
                pass
            raise ExecutorError("OCI engine command wait failed") from exc
        for reader in readers:
            reader.join(timeout=5)
        if any(reader.is_alive() for reader in readers):
            try:
                process.stdout.close()
                process.stderr.close()
            except OSError:
                pass
            raise ExecutorError("OCI engine response pipes did not close")
        if timed_out:
            raise ExecutorError("OCI engine command exceeded its deadline")
        if read_errors:
            raise ExecutorError("OCI engine response could not be read") from read_errors[0]
        if overflow.is_set():
            raise ExecutorError("OCI engine response exceeded 256 KiB")
        result = subprocess.CompletedProcess(
            command, return_code, bytes(stdout), bytes(stderr)
        )
        if check and return_code != 0:
            # Engine text can contain paths or registry details; do not surface it.
            raise ExecutorError(f"OCI engine command failed with code {return_code}")
        return result

    def probe(self) -> EngineProbe:
        if self.config.engine_kind == "docker":
            result = self._run(["info", "--format", "{{json .}}"])
            try:
                row = json.loads(result.stdout)
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise AdmissionError("Docker info response was not JSON") from exc
            options = row.get("SecurityOptions", [])
            rootless = any("rootless" in str(option).lower() for option in options)
            engine_id = str(row.get("ID", "")).strip()
        else:
            result = self._run(["info", "--format", "json"])
            try:
                row = json.loads(result.stdout)
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise AdmissionError("Podman info response was not JSON") from exc
            host = row.get("host", {}) if isinstance(row, dict) else {}
            security = host.get("security", {}) if isinstance(host, dict) else {}
            rootless = bool(security.get("rootless"))
            # Hostname is not an engine/storage identity and must not satisfy a
            # replacement fence. Podman targets without host.id remain NO-GO.
            engine_id = str(host.get("id") or "").strip()
        if not engine_id or len(engine_id) > 200:
            raise AdmissionError("OCI engine did not return a bounded identity")
        return EngineProbe(
            kind=self.config.engine_kind,
            endpoint=self.config.engine_endpoint,
            engine_id=engine_id,
            rootless=rootless,
        )

    def build_create_command(self, spec: ContainerSpec) -> list[str]:
        try:
            if self.config.seccomp_profile.is_symlink():
                raise AdmissionError("OCI seccomp profile became symbolic")
            seccomp_bytes = self.config.seccomp_profile.read_bytes()
            seccomp_size = len(seccomp_bytes)
            seccomp_sha256 = hashlib.sha256(seccomp_bytes).hexdigest()
            seccomp_row = json.loads(seccomp_bytes.decode("utf-8", errors="strict"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise AdmissionError("OCI seccomp profile is no longer readable") from exc
        if (
            seccomp_size > 1024 * 1024
            or seccomp_sha256 != self.config.seccomp_sha256
        ):
            raise AdmissionError("OCI seccomp profile changed after admission")
        if not isinstance(seccomp_row, dict):
            raise AdmissionError("OCI seccomp profile is no longer a JSON object")
        _validate_seccomp_policy(seccomp_row)
        for path in (spec.input_dir, spec.control_dir, spec.output_dir):
            if "," in str(path) or any(character in str(path) for character in "\r\n"):
                raise ExecutorError("OCI bind path contains a forbidden delimiter")
        cpu = f"{spec.resources['cpuMillicores'] / 1000:.3f}".rstrip("0").rstrip(".")
        memory = f"{spec.resources['memoryMb']}m"
        arguments = [
            "create",
            "--name",
            spec.name,
            "--user",
            f"{spec.uid}:{spec.gid}",
            "--network",
            "none",
            "--ipc",
            "none",
            "--pid",
            "private",
            "--uts",
            "private",
            "--read-only",
            "--init",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges=true",
            "--security-opt",
            f"seccomp={self.config.seccomp_profile}",
            "--log-driver",
            "none",
            "--pids-limit",
            str(spec.pids),
            "--cpus",
            cpu,
            "--memory",
            memory,
            "--memory-swap",
            memory,
            "--stop-timeout",
            "10",
            "--tmpfs",
            f"/tmp:rw,noexec,nosuid,nodev,size=64m,uid={spec.uid},gid={spec.gid},mode=0700",
            "--tmpfs",
            f"/run:rw,noexec,nosuid,nodev,size=16m,uid={spec.uid},gid={spec.gid},mode=0700",
            "--tmpfs",
            f"/science/output:rw,noexec,nosuid,nodev,size={spec.max_output_bytes},uid={spec.uid},gid={spec.gid},mode=0700",
            "--mount",
            f"type=bind,src={spec.input_dir},dst=/science/input,readonly",
            "--mount",
            f"type=bind,src={spec.control_dir},dst=/science/control,readonly",
            "--env",
            "SCIENCE_EXECUTION_SPEC=/science/control/submission.json",
            "--env",
            "SCIENCE_OUTPUT_DIR=/science/output",
        ]
        for key, value in sorted(spec.labels.items()):
            arguments.extend(["--label", f"{key}={value}"])
        arguments.append(spec.image_reference)
        return [*self._prefix(), *arguments]

    @staticmethod
    def _listed_reference_matches(row: Mapping[str, Any], reference: str) -> bool:
        identifier = str(row.get("ID") or row.get("Id") or "")
        raw_names = row.get("Names") or row.get("Name") or ""
        name_values = raw_names if isinstance(raw_names, list) else str(raw_names).split(",")
        names = {
            str(item).strip().lstrip("/")
            for item in name_values
            if str(item).strip()
        }
        return (
            reference == identifier
            or (len(reference) >= 12 and identifier.startswith(reference))
            or reference.lstrip("/") in names
        )

    def _prove_reference_absent(self, reference: str) -> bool:
        """Use a second successful engine query before treating inspect failure as 404.

        Docker and Podman both use exit status 1 for not-found *and* several
        daemon/transport failures. A successful bounded all-container listing is
        therefore the independent absence proof; ambiguity remains an error.
        """
        result = self._run(
            ["container", "ls", "--all", "--no-trunc", "--format", "{{json .}}"]
        )
        try:
            rows = [
                json.loads(line)
                for line in result.stdout.decode("utf-8", errors="strict").splitlines()
                if line.strip()
            ]
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ExecutorError("OCI engine absence proof was malformed") from exc
        if not all(isinstance(row, dict) for row in rows):
            raise ExecutorError("OCI engine absence proof was malformed")
        if any(self._listed_reference_matches(row, reference) for row in rows):
            raise ExecutorError("OCI inspect failed while the container still exists")
        return True

    def _inspect_reference(self, reference: str) -> EngineContainer | None:
        result = self._run(
            ["container", "inspect", "--format", "{{json .}}", reference],
            check=False,
        )
        if result.returncode != 0:
            self._prove_reference_absent(reference)
            return None
        try:
            row = json.loads(result.stdout)
            labels = row["Config"].get("Labels") or {}
            state = row["State"]
            identifier = str(row["Id"])
            name = str(row["Name"]).lstrip("/")
            status = str(state["Status"])
            exit_code = int(state["ExitCode"]) if status not in {"created", "running"} else None
        except (KeyError, TypeError, ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ExecutorError("OCI engine returned malformed inspect data") from exc
        if not re.fullmatch(r"[a-zA-Z0-9_.-]{1,128}", identifier):
            raise ExecutorError("OCI engine returned an invalid container identity")
        if not isinstance(labels, dict) or not all(
            isinstance(key, str) and isinstance(value, str) for key, value in labels.items()
        ):
            raise ExecutorError("OCI engine returned invalid labels")
        return EngineContainer(identifier, name, labels, status, exit_code)

    def lookup(self, name: str) -> EngineContainer | None:
        return self._inspect_reference(name)

    def create(self, spec: ContainerSpec) -> EngineContainer:
        command = self.build_create_command(spec)
        # Strip the already-constructed prefix; _run adds the same trusted prefix.
        result = self._run(command[len(self._prefix()) :])
        try:
            identifier = result.stdout.decode("ascii", errors="strict").strip()
        except UnicodeDecodeError as exc:
            raise ExecutorError("OCI engine create response was not ASCII") from exc
        if not re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", identifier):
            raise ExecutorError("OCI engine create response had an invalid identity")
        container = self.inspect(identifier)
        if container is None:
            raise ExecutorError("OCI engine created a container that cannot be inspected")
        return container

    def verify_isolation(self, container_id: str, spec: ContainerSpec) -> None:
        result = self._run(
            ["container", "inspect", "--format", "{{json .}}", container_id]
        )
        try:
            row = json.loads(result.stdout)
            host = row["HostConfig"]
            configured = row["Config"]
            mounts = row.get("Mounts") or []
        except (KeyError, TypeError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ExecutorError("OCI engine isolation inspection was malformed") from exc
        security_options = {str(option) for option in (host.get("SecurityOpt") or [])}
        normalized_security: dict[str, str] = {}
        for option in security_options:
            separator = "=" if "=" in option else ":" if ":" in option else None
            if separator is None:
                normalized_security[option.lower()] = ""
            else:
                key, value = option.split(separator, 1)
                normalized_security[key.lower()] = value
        cap_drop = {str(capability).upper() for capability in (host.get("CapDrop") or [])}
        expected_memory = int(spec.resources["memoryMb"]) * 1024 * 1024
        expected_nano_cpus = int(spec.resources["cpuMillicores"]) * 1_000_000
        effective = {
            "user": configured.get("User") == f"{spec.uid}:{spec.gid}",
            "image_reference": configured.get("Image") == spec.image_reference,
            "network": str(host.get("NetworkMode", "")).lower() == "none",
            "ipc": str(host.get("IpcMode", "")).lower() == "none",
            "pid": str(host.get("PidMode", "")).lower() in {"", "private"},
            "uts": str(host.get("UTSMode", "")).lower() in {"", "private"},
            "readonly": host.get("ReadonlyRootfs") is True,
            "unprivileged": host.get("Privileged") is False,
            "capabilities": "ALL" in cap_drop,
            "cap_add": not (host.get("CapAdd") or []),
            "no_new_privileges": "no-new-privileges" in normalized_security
            and normalized_security["no-new-privileges"].lower()
            in {"true", "1", ""},
            "seccomp": normalized_security.get("seccomp")
            == str(self.config.seccomp_profile),
            "pids": isinstance(host.get("PidsLimit"), int)
            and 0 < host["PidsLimit"] <= spec.pids,
            "memory": isinstance(host.get("Memory"), int)
            and 0 < host["Memory"] <= expected_memory,
            "swap": host.get("MemorySwap") == host.get("Memory"),
            "cpu": isinstance(host.get("NanoCpus"), int)
            and 0 < host["NanoCpus"] <= expected_nano_cpus,
            "devices": not (
                host.get("Devices")
                or host.get("DeviceRequests")
                or host.get("DeviceCgroupRules")
            ),
            "logging": isinstance(host.get("LogConfig"), dict)
            and str(host["LogConfig"].get("Type", "")).lower() == "none"
            and not (host["LogConfig"].get("Config") or {}),
        }
        if not all(effective.values()):
            failed = ", ".join(sorted(key for key, passed in effective.items() if not passed))
            raise AdmissionError(f"OCI engine did not enforce isolation: {failed}")
        expected_mounts = {
            "/science/input": (spec.input_dir.resolve(), False),
            "/science/control": (spec.control_dir.resolve(), False),
        }
        if len(mounts) != len(expected_mounts):
            raise AdmissionError("OCI engine exposed an unexpected mount")
        observed: set[str] = set()
        for mount in mounts:
            if not isinstance(mount, dict):
                raise AdmissionError("OCI engine returned malformed mount isolation")
            destination = str(mount.get("Destination", ""))
            expected = expected_mounts.get(destination)
            if expected is None or mount.get("Type") != "bind":
                raise AdmissionError("OCI engine exposed an unadmitted mount")
            source = Path(str(mount.get("Source", ""))).resolve()
            if source != expected[0] or bool(mount.get("RW")) is not expected[1]:
                raise AdmissionError("OCI engine bind mount differs from the admitted path/mode")
            observed.add(destination)
        if observed != set(expected_mounts):
            raise AdmissionError("OCI engine omitted an admitted bind mount")
        tmpfs = host.get("Tmpfs") or {}

        def tmpfs_matches(options: Any, expected_size: int) -> bool:
            tokens = {
                token.strip().lower()
                for token in str(options).split(",")
                if token.strip()
            }
            if not {"rw", "noexec", "nosuid", "nodev"}.issubset(tokens):
                return False
            if {"exec", "suid", "dev"} & tokens:
                return False
            if f"uid={spec.uid}" not in tokens or f"gid={spec.gid}" not in tokens:
                return False
            if not ({"mode=0700", "mode=700"} & tokens):
                return False
            sizes = [token.removeprefix("size=") for token in tokens if token.startswith("size=")]
            if len(sizes) != 1:
                return False
            raw_size = sizes[0]
            multiplier = 1
            if raw_size.endswith("k"):
                multiplier = 1024
                raw_size = raw_size[:-1]
            elif raw_size.endswith("m"):
                multiplier = 1024 * 1024
                raw_size = raw_size[:-1]
            elif raw_size.endswith("g"):
                multiplier = 1024 * 1024 * 1024
                raw_size = raw_size[:-1]
            try:
                return int(raw_size) * multiplier == expected_size
            except ValueError:
                return False

        expected_tmpfs_sizes = {
            "/tmp": 64 * 1024 * 1024,
            "/run": 16 * 1024 * 1024,
            "/science/output": spec.max_output_bytes,
        }
        if set(tmpfs) != set(expected_tmpfs_sizes) or any(
            not tmpfs_matches(tmpfs[path], size)
            for path, size in expected_tmpfs_sizes.items()
        ):
            raise AdmissionError("OCI engine tmpfs isolation differs from admission")

    def export_outputs(self, container_id: str, destination: Path) -> None:
        destination.mkdir(parents=False, exist_ok=False)
        try:
            self._run(
                [
                    "container",
                    "cp",
                    f"{container_id}:/science/output/.",
                    str(destination),
                ],
                timeout=max(self.config.engine_timeout_seconds, 300),
            )
        except Exception:
            shutil.rmtree(destination, ignore_errors=True)
            raise

    def start(self, container_id: str, timeout_seconds: int) -> None:
        self._run(
            ["container", "start", container_id],
            timeout=max(1, min(self.config.engine_timeout_seconds, timeout_seconds)),
        )

    def inspect(self, container_id: str) -> EngineContainer | None:
        return self._inspect_reference(container_id)

    def kill(self, container_id: str) -> None:
        if self.inspect(container_id) is None:
            return
        result = self._run(
            ["container", "kill", "--signal", "KILL", container_id], check=False
        )
        if result.returncode != 0 and self.inspect(container_id) is not None:
            raise ExecutorError("OCI engine could not kill the exact container")

    def remove(self, container_id: str) -> None:
        if self.inspect(container_id) is None:
            return
        result = self._run(
            ["container", "rm", "--force", "--volumes", container_id], check=False
        )
        remaining = self.inspect(container_id)
        if remaining is not None:
            raise ExecutorError("OCI engine could not prove exact-container removal")


class InputFetcher(Protocol):
    def fetch(
        self,
        url: str,
        destination: Path,
        expected_size: int,
        should_cancel: Callable[[], bool] | None = None,
    ) -> None: ...


class ScopedHttpInputFetcher:
    """Bounded, no-redirect fetcher for short-lived artifact capabilities."""

    class _NoRedirect(HTTPRedirectHandler):
        def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
            return None

    def __init__(self, allowed_origins: frozenset[str], timeout_seconds: int = 30) -> None:
        self.allowed_origins = allowed_origins
        self.timeout_seconds = timeout_seconds
        # Explicitly ignore ambient HTTP(S)_PROXY/ALL_PROXY variables. A signed
        # capability must not be disclosed to an operator-unapproved proxy.
        self.opener = build_opener(ProxyHandler({}), self._NoRedirect())

    def fetch(
        self,
        url: str,
        destination: Path,
        expected_size: int,
        should_cancel: Callable[[], bool] | None = None,
    ) -> None:
        if should_cancel and should_cancel():
            raise CancellationError("input staging was cancelled")
        if _origin(url) not in self.allowed_origins:
            raise ExecutorError("input reference origin is not allowlisted")
        deadline = time.monotonic() + self.timeout_seconds
        request = Request(
            url,
            method="GET",
            headers={"Accept": "application/octet-stream", "Accept-Encoding": "identity"},
        )
        try:
            response = self.opener.open(request, timeout=self.timeout_seconds)
        except HTTPError as exc:
            # Redirects and remote errors are intentionally not exposed verbatim.
            raise ExecutorError(f"input fetch returned HTTP {exc.code}") from exc
        except (TimeoutError, OSError, URLError) as exc:
            raise ExecutorError("input fetch transport failed within its bounded request") from exc
        try:
            target_stream = destination.open("xb")
        except OSError as exc:
            response.close()
            raise ExecutorError("input staging file could not be created") from exc
        with response, target_stream as target:
            if should_cancel and should_cancel():
                raise CancellationError("input staging was cancelled")
            if time.monotonic() >= deadline:
                raise ExecutorError("input fetch exceeded its total deadline")
            if response.status != 200:
                raise ExecutorError(f"input fetch returned HTTP {response.status}")
            if response.geturl() != url:
                raise ExecutorError("input fetch changed URL")
            encoding = response.headers.get("Content-Encoding", "identity").lower()
            if encoding not in {"", "identity"}:
                raise ExecutorError("input fetch used a non-identity content encoding")
            content_length = response.headers.get("Content-Length")
            if content_length is not None:
                try:
                    if int(content_length) != expected_size:
                        raise ExecutorError("input Content-Length differs from its receipt")
                except ValueError as exc:
                    raise ExecutorError("input Content-Length is invalid") from exc
            remaining = expected_size
            while remaining:
                if should_cancel and should_cancel():
                    raise CancellationError("input staging was cancelled")
                if time.monotonic() >= deadline:
                    raise ExecutorError("input fetch exceeded its total deadline")
                chunk = response.read(min(1024 * 1024, remaining + 1))
                if time.monotonic() >= deadline:
                    raise ExecutorError("input fetch exceeded its total deadline")
                if not chunk:
                    break
                if len(chunk) > remaining:
                    raise ExecutorError("input exceeded its declared size")
                target.write(chunk)
                remaining -= len(chunk)
            if should_cancel and should_cancel():
                raise CancellationError("input staging was cancelled")
            if remaining or response.read(1):
                raise ExecutorError("input size differs from its receipt")
            target.flush()
            try:
                os.fsync(target.fileno())
            except OSError as exc:
                raise ExecutorError("staged input could not be flushed") from exc


def _normalize_submission(
    value: Any,
    config: OciExecutorConfig,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    row = _exact_object(value, "submission", SUBMISSION_KEYS)
    image_digest = _bounded_text(row["imageDigest"], "imageDigest", 71, 71)
    if not IMAGE_DIGEST.fullmatch(image_digest) or image_digest not in config.image_map:
        raise ExecutorError("imageDigest is not admitted by the immutable image map")
    kernel = _bounded_text(row["kernel"], "kernel", 1, 200)
    if kernel not in config.allowed_kernels:
        raise ExecutorError("kernel is not admitted")
    parameters = row["parameters"]
    if not isinstance(parameters, dict):
        raise ExecutorError("parameters must be an object")
    _reject_secret_fields(parameters, "parameters")
    try:
        parameter_bytes = canonical_json(parameters)
    except (TypeError, ValueError) as exc:
        raise ExecutorError("parameters must be finite JSON") from exc
    if len(parameter_bytes) > 32 * 1024:
        raise ExecutorError("parameters exceed 32 KiB")
    resource_row = _exact_object(row["resources"], "resources", RESOURCE_KEYS)
    resources = {
        "cpuMillicores": _integer(
            resource_row["cpuMillicores"],
            "resources.cpuMillicores",
            1,
            config.limits.cpu_millicores,
        ),
        "memoryMb": _integer(
            resource_row["memoryMb"],
            "resources.memoryMb",
            16,
            config.limits.memory_mb,
        ),
        "gpuCount": _integer(
            resource_row["gpuCount"], "resources.gpuCount", 0, 64
        ),
        "wallTimeSeconds": _integer(
            resource_row["wallTimeSeconds"],
            "resources.wallTimeSeconds",
            1,
            config.limits.wall_time_seconds,
        ),
    }
    if resources["gpuCount"] != 0:
        raise ExecutorError("GPU execution is not admitted by this executor")
    raw_inputs = row["inputs"]
    if not isinstance(raw_inputs, list) or len(raw_inputs) > config.max_inputs:
        raise ExecutorError(f"inputs must contain at most {config.max_inputs} items")
    persisted_inputs: list[dict[str, Any]] = []
    ephemeral_inputs: list[dict[str, Any]] = []
    total_size = 0
    for index, raw_input in enumerate(raw_inputs):
        item = _exact_object(raw_input, f"inputs[{index}]", INPUT_KEYS)
        reference = _exact_object(
            item["reference"], f"inputs[{index}].reference", REFERENCE_KEYS
        )
        checksum = _bounded_text(item["sha256"], f"inputs[{index}].sha256", 64, 64)
        if not re.fullmatch(r"[0-9a-f]{64}", checksum):
            raise ExecutorError(f"inputs[{index}].sha256 is invalid")
        size = _integer(item["size"], f"inputs[{index}].size", 0, config.max_input_bytes)
        total_size += size
        if total_size > config.max_input_bytes:
            raise ExecutorError("total input size exceeds executor admission")
        url = _bounded_text(reference["url"], f"inputs[{index}].reference.url", 1, 4096)
        if _origin(url) not in config.allowed_input_origins:
            raise ExecutorError(f"inputs[{index}] origin is not allowlisted")
        if reference["method"] != "GET":
            raise ExecutorError(f"inputs[{index}] reference method must be GET")
        if reference["sha256"] != checksum or reference["size"] != size:
            raise ExecutorError(f"inputs[{index}] receipt differs from its reference")
        expires_at = _parse_time(
            reference["expiresAt"], f"inputs[{index}].reference.expiresAt"
        )
        if expires_at <= datetime.now(timezone.utc):
            raise ExecutorError(f"inputs[{index}] reference has expired")
        persisted = {
            "artifactVersionId": _bounded_text(
                item["artifactVersionId"], f"inputs[{index}].artifactVersionId", 1, 200
            ),
            "role": _bounded_text(item["role"], f"inputs[{index}].role", 1, 200),
            "mediaType": _bounded_text(
                item["mediaType"], f"inputs[{index}].mediaType", 1, 255
            ),
            "sha256": checksum,
            "size": size,
        }
        persisted_inputs.append(persisted)
        ephemeral_inputs.append(
            {
                **persisted,
                "url": url,
                "expiresAt": expires_at.isoformat(timespec="milliseconds").replace(
                    "+00:00", "Z"
                ),
            }
        )
    normalized = {
        "runId": _bounded_text(row["runId"], "runId", 1, 200),
        "missionId": _bounded_text(row["missionId"], "missionId", 1, 200),
        "generation": _integer(row["generation"], "generation", 1, 2**31 - 1),
        "idempotencyKey": _bounded_text(
            row["idempotencyKey"], "idempotencyKey", 1, 200
        ),
        "submittedAt": _parse_time(row["submittedAt"], "submittedAt")
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z"),
        "imageDigest": image_digest,
        "kernel": kernel,
        "parameters": parameters,
        "resources": resources,
        "inputs": persisted_inputs,
    }
    return normalized, ephemeral_inputs


class OciExecutor:
    """Durable idempotent per-run executor with exact instance/generation fences."""

    def __init__(
        self,
        config: OciExecutorConfig,
        engine: OciEngine,
        *,
        fetcher: InputFetcher | None = None,
        auto_monitor: bool = True,
    ) -> None:
        self.config = config
        canonical_endpoint = _validate_dedicated_endpoint(config.engine_endpoint)
        if canonical_endpoint != config.engine_endpoint:
            raise AdmissionError("OCI engine endpoint must use its canonical form")
        if config.max_state_bytes < (
            STATE_FIXED_RESERVATION_BYTES
            + JOB_STATE_RESERVATION_BYTES
            + config.max_output_total_bytes
        ):
            raise AdmissionError("OCI state quota cannot reserve one maximum output set")
        try:
            seccomp_bytes = config.seccomp_profile.read_bytes()
            seccomp_row = json.loads(seccomp_bytes.decode("utf-8", errors="strict"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise AdmissionError("OCI seccomp profile is unavailable at executor startup") from exc
        if (
            config.seccomp_profile.is_symlink()
            or not isinstance(seccomp_row, dict)
            or hashlib.sha256(seccomp_bytes).hexdigest() != config.seccomp_sha256
        ):
            raise AdmissionError("OCI seccomp profile differs from its startup admission")
        _validate_seccomp_policy(seccomp_row)
        self.engine = engine
        self.fetcher = fetcher or ScopedHttpInputFetcher(config.allowed_input_origins)
        self.auto_monitor = auto_monitor
        self.lock = threading.RLock()
        self.submit_lock = threading.Lock()
        self.prune_lock = threading.Lock()
        self.stop_event = threading.Event()
        self.health_condition = threading.Condition()
        self.health_inflight = False
        self.health_cache: tuple[float, dict[str, Any]] | None = None
        self.startup_reconcile_instances: set[str] = set()
        self.reconciled_instances: set[str] = set()
        self.reconciliation_local = threading.local()
        self.startup_reconcile_thread: threading.Thread | None = None
        self.monitors: dict[str, threading.Thread] = {}
        self.operation_locks: dict[str, threading.RLock] = {}
        self.state_dir = config.state_dir.resolve()
        self.jobs_dir = self.state_dir / "jobs"
        self.ledger_path = self.state_dir / "ledger.json"
        self.identity_path = self.state_dir / "identity.json"
        self.owner_lock_path = self.state_dir / ".executor-owner.lock"
        self.owner_lock_stream: Any | None = None
        self.owner_lock_kind: str | None = None
        for path in (self.state_dir, self.jobs_dir):
            path.mkdir(parents=True, exist_ok=True)
        try:
            os.chmod(self.state_dir, stat.S_IRWXU)
            os.chmod(self.jobs_dir, stat.S_IRWXU)
        except OSError:
            pass
        self._acquire_state_owner_lock()
        self.tombstones: dict[str, dict[str, Any]] = {}
        self.ledger_needs_reservation_upgrade = False
        try:
            self._sweep_orphan_temporaries()
            self.jobs = self._load_ledger()
            if self.ledger_needs_reservation_upgrade:
                with self.lock:
                    self._persist_locked()
        except Exception:
            self._release_state_owner_lock()
            raise
        self.instance_id: str | None = None
        self.engine_id: str | None = None

    def _acquire_state_owner_lock(self) -> None:
        """Hold one cross-process, nonblocking writer lease for this state root."""
        if self.owner_lock_path.exists() and (
            self.owner_lock_path.is_symlink() or not self.owner_lock_path.is_file()
        ):
            raise AdmissionError("OCI executor owner lock path is not a regular file")
        flags = os.O_RDWR | os.O_CREAT | getattr(os, "O_CLOEXEC", 0)
        if hasattr(os, "O_NOFOLLOW"):
            flags |= os.O_NOFOLLOW
        if os.name == "nt":
            flags |= getattr(os, "O_BINARY", 0)
        try:
            descriptor = os.open(self.owner_lock_path, flags, 0o600)
            if not stat.S_ISREG(os.fstat(descriptor).st_mode):
                os.close(descriptor)
                raise AdmissionError("OCI executor owner lock is not a regular file")
            stream = os.fdopen(descriptor, "r+b", buffering=0)
            if os.name == "nt":
                import msvcrt

                if os.fstat(stream.fileno()).st_size < 1:
                    stream.write(b"\0")
                    stream.flush()
                    os.fsync(stream.fileno())
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                lock_kind = "windows"
            elif os.name == "posix":
                import fcntl

                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                lock_kind = "posix"
            else:
                stream.close()
                raise AdmissionError("this host has no admitted OCI state-lock implementation")
        except AdmissionError:
            raise
        except (OSError, ImportError) as exc:
            try:
                if "stream" in locals():
                    stream.close()
            except OSError:
                pass
            raise AdmissionError(
                "OCI executor state directory already has a writer or cannot be locked"
            ) from exc
        self.owner_lock_stream = stream
        self.owner_lock_kind = lock_kind

    def _release_state_owner_lock(self) -> None:
        stream = self.owner_lock_stream
        kind = self.owner_lock_kind
        self.owner_lock_stream = None
        self.owner_lock_kind = None
        if stream is None:
            return
        try:
            if kind == "windows":
                import msvcrt

                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            elif kind == "posix":
                import fcntl

                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
        except (OSError, ImportError):
            pass
        finally:
            try:
                stream.close()
            except OSError:
                pass

    @staticmethod
    def _remove_orphan_path(path: Path) -> None:
        try:
            is_junction = bool(getattr(path, "is_junction", lambda: False)())
            if path.is_symlink() or is_junction or path.is_file():
                path.unlink()
            elif path.is_dir():
                def restore_write_and_retry(function, name, _error):  # noqa: ANN001
                    os.chmod(name, stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR)
                    function(name)

                shutil.rmtree(path, onerror=restore_write_and_retry)
            else:
                raise ExecutorError("OCI orphan temporary is a special file")
        except OSError as exc:
            raise ExecutorError("OCI orphan temporary could not be removed") from exc

    def _sweep_orphan_temporaries(self) -> None:
        """Delete only exact crash-temporary names while the writer lease is held."""
        staging = re.compile(r"^\.run-[0-9a-f]{32}-[0-9a-f]{16}$")
        metadata = re.compile(r"^\.(?:ledger|identity)-[0-9]+-[0-9a-f]{8}$")
        jobs_changed = False
        state_changed = False
        try:
            for path in self.jobs_dir.iterdir():
                if staging.fullmatch(path.name):
                    self._remove_orphan_path(path)
                    jobs_changed = True
            for path in self.state_dir.iterdir():
                if metadata.fullmatch(path.name):
                    self._remove_orphan_path(path)
                    state_changed = True
        except OSError as exc:
            raise ExecutorError("OCI orphan temporary sweep failed") from exc
        if jobs_changed:
            _fsync_directory(self.jobs_dir)
        if state_changed:
            _fsync_directory(self.state_dir)

    def _submission_reservation(self, submission: Mapping[str, Any]) -> int:
        try:
            input_bytes = sum(int(item["size"]) for item in submission["inputs"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ExecutorError("OCI submission cannot derive its state reservation") from exc
        return input_bytes + self.config.max_output_total_bytes + JOB_STATE_RESERVATION_BYTES

    def _state_reserved_bytes_locked(self) -> int:
        return STATE_FIXED_RESERVATION_BYTES + sum(
            int(row.get("reservedBytes", 0))
            for row in (*self.jobs.values(), *self.tombstones.values())
        )

    def _load_ledger(self) -> dict[str, dict[str, Any]]:
        try:
            if not self.ledger_path.exists():
                return {}
            if self.ledger_path.stat().st_size > 64 * 1024 * 1024:
                raise ExecutorError("OCI executor ledger exceeds 64 MiB")
            row = json.loads(self.ledger_path.read_text("utf-8"))
        except ExecutorError:
            raise
        except (OSError, json.JSONDecodeError) as exc:
            raise ExecutorError("OCI executor ledger is unreadable") from exc
        if not isinstance(row, dict) or row.get("version") != LEDGER_VERSION:
            raise ExecutorError("OCI executor ledger version is invalid")
        jobs = row.get("jobs")
        if not isinstance(jobs, dict) or len(jobs) > 4096:
            raise ExecutorError("OCI executor ledger jobs are invalid")
        for handle, job in jobs.items():
            if not SAFE_HANDLE.fullmatch(str(handle)) or not isinstance(job, dict):
                raise ExecutorError("OCI executor ledger contains an invalid job")
            if job.get("state") not in ACTIVE_STATES | TERMINAL_STATES:
                raise ExecutorError("OCI executor ledger contains an invalid state")
            if not INSTANCE_ID.fullmatch(str(job.get("instanceId", ""))):
                raise ExecutorError("OCI executor ledger contains an invalid instance fence")
            expected_reservation = self._submission_reservation(job.get("submission", {}))
            reserved = job.get("reservedBytes")
            if reserved is None:
                job["reservedBytes"] = expected_reservation
                self.ledger_needs_reservation_upgrade = True
            elif (
                isinstance(reserved, bool)
                or not isinstance(reserved, int)
                or reserved < expected_reservation
                or reserved > self.config.max_state_bytes
            ):
                raise ExecutorError("OCI executor ledger contains an invalid state reservation")
        tombstones = row.get("tombstones", {})
        if not isinstance(tombstones, dict) or len(tombstones) > self.config.max_tombstones:
            raise ExecutorError("OCI executor ledger tombstones are invalid")
        for handle, tombstone in tombstones.items():
            if (
                not SAFE_HANDLE.fullmatch(str(handle))
                or not isinstance(tombstone, dict)
                or tombstone.get("state") not in TERMINAL_STATES | {"orphaned"}
                or not INSTANCE_ID.fullmatch(str(tombstone.get("instanceId", "")))
            ):
                raise ExecutorError("OCI executor ledger contains an invalid tombstone")
            reserved = tombstone.get("reservedBytes")
            minimum_reservation = 1 if tombstone.get("retainedExternalOrphan") else 0
            if reserved is None:
                tombstone["reservedBytes"] = (
                    self.config.max_input_bytes
                    + self.config.max_output_total_bytes
                    + JOB_STATE_RESERVATION_BYTES
                    if tombstone.get("retainedExternalOrphan")
                    else 0
                )
                self.ledger_needs_reservation_upgrade = True
            elif (
                isinstance(reserved, bool)
                or not isinstance(reserved, int)
                or reserved < minimum_reservation
                or reserved > self.config.max_state_bytes
            ):
                raise ExecutorError("OCI executor tombstone has an invalid state reservation")
        self.tombstones = tombstones
        aggregate = STATE_FIXED_RESERVATION_BYTES + sum(
            int(row["reservedBytes"])
            for row in (*jobs.values(), *tombstones.values())
        )
        if aggregate > self.config.max_state_bytes:
            raise AdmissionError("OCI executor durable state reservation exceeds its quota")
        return jobs

    def _persist_locked(self) -> None:
        payload = canonical_json(
            {
                "version": LEDGER_VERSION,
                "jobs": self.jobs,
                "tombstones": self.tombstones,
            }
        )
        if len(payload) > 64 * 1024 * 1024:
            raise ExecutorError("OCI executor ledger exceeds 64 MiB")
        temporary = self.ledger_path.with_name(f".ledger-{os.getpid()}-{secrets.token_hex(4)}")
        try:
            with temporary.open("xb") as stream:
                stream.write(payload)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.ledger_path)
            _fsync_directory(self.ledger_path.parent)
            os.chmod(self.ledger_path, stat.S_IRUSR | stat.S_IWUSR)
        except ExecutorError:
            raise
        except OSError as exc:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
            raise ExecutorError("OCI executor ledger could not be persisted") from exc

    def _read_identity(self) -> dict[str, str] | None:
        if not self.identity_path.exists():
            return None
        try:
            row = json.loads(self.identity_path.read_text("utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise AdmissionError("OCI executor identity file is unreadable") from exc
        if (
            not isinstance(row, dict)
            or set(row) != {"instanceId", "engineId"}
            or not INSTANCE_ID.fullmatch(str(row.get("instanceId", "")))
            or not isinstance(row.get("engineId"), str)
        ):
            raise AdmissionError("OCI executor identity file is invalid")
        return row

    def _write_identity(self, instance_id: str, engine_id: str) -> None:
        temporary = self.identity_path.with_name(f".identity-{os.getpid()}-{secrets.token_hex(4)}")
        try:
            with temporary.open("xb") as stream:
                stream.write(canonical_json({"instanceId": instance_id, "engineId": engine_id}))
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.identity_path)
            _fsync_directory(self.identity_path.parent)
            os.chmod(self.identity_path, stat.S_IRUSR | stat.S_IWUSR)
        except ExecutorError:
            raise
        except OSError as exc:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
            raise AdmissionError("OCI executor identity could not be persisted") from exc

    def admit(self, *, rotate_on_engine_change: bool = True) -> str:
        if not self.config.admitted:
            raise AdmissionError("SCIENCE_OCI_EXECUTOR_ADMISSION=approved is required")
        if self.config.engine_boundary != "dedicated-rootless":
            raise AdmissionError(
                "SCIENCE_OCI_ENGINE_BOUNDARY=dedicated-rootless is required"
            )
        probe = self.engine.probe()
        if (
            probe.kind != self.config.engine_kind
            or probe.endpoint != self.config.engine_endpoint
            or probe.engine_id != self.config.expected_engine_id
            or not probe.rootless
        ):
            raise AdmissionError("OCI engine did not prove the pinned rootless endpoint identity")
        schedule_reconcile = False
        with self.lock:
            identity = self._read_identity()
            if identity is None:
                instance_id = "science-oci-" + secrets.token_hex(16)
                self._write_identity(instance_id, probe.engine_id)
            elif identity["engineId"] == probe.engine_id:
                instance_id = identity["instanceId"]
            elif rotate_on_engine_change:
                # Old jobs remain fenced to the old instance and are never touched
                # through the replacement engine.
                instance_id = "science-oci-" + secrets.token_hex(16)
                self._write_identity(instance_id, probe.engine_id)
            else:
                raise FenceError("OCI engine identity changed; health re-admission is required")
            self.instance_id = instance_id
            self.engine_id = probe.engine_id
            self._compact_old_instance_jobs_locked(instance_id)
            if (
                instance_id not in self.reconciled_instances
                and instance_id not in self.startup_reconcile_instances
            ):
                self.startup_reconcile_instances.add(instance_id)
                schedule_reconcile = True
        if schedule_reconcile:
            if self.auto_monitor:
                worker = threading.Thread(
                    target=self._startup_reconcile,
                    args=(instance_id,),
                    daemon=True,
                    name="science-oci-startup-reconcile",
                )
                self.startup_reconcile_thread = worker
                worker.start()
            else:
                self._startup_reconcile(instance_id, retry=False)
        return instance_id

    def _compact_old_instance_jobs_locked(self, current_instance_id: str) -> None:
        """Move unreachable active rows to bounded non-terminal orphan inventory.

        No engine operation is attempted. These records never expire
        automatically because the old allocation cannot be proved absent through
        the replacement endpoint. Compaction prevents old rows consuming the
        current instance's concurrency/lifetime job slots while preserving an
        explicit admin-action barrier.
        """
        handles = [
            handle
            for handle, job in self.jobs.items()
            if job.get("instanceId") != current_instance_id
            and job.get("state") in ACTIVE_STATES
        ]
        if not handles:
            return
        if len(self.tombstones) + len(handles) > self.config.max_tombstones:
            raise AdmissionError(
                "old-instance orphan inventory exceeds SCIENCE_OCI_MAX_TOMBSTONES"
            )
        moved: dict[str, dict[str, Any]] = {}
        try:
            for handle in handles:
                if handle in self.tombstones:
                    raise AdmissionError("old-instance orphan handle conflicts with a tombstone")
                job = self.jobs.pop(handle)
                moved[handle] = job
                self.tombstones[handle] = {
                    "handle": handle,
                    "keyHash": job["keyHash"],
                    "payloadDigest": job["payloadDigest"],
                    "instanceId": job["instanceId"],
                    "generation": job["generation"],
                    "state": "orphaned",
                    "originalState": job["state"],
                    "containerId": job.get("containerId"),
                    "progress": job.get("progress"),
                    "message": "engine identity changed; old allocation requires operator reconciliation",
                    "error": "old_engine_instance_unreachable",
                    "outputs": [],
                    "receiptExpired": True,
                    "createdAt": job.get("createdAt"),
                    "finishedAt": None,
                    "prunedAt": utc_now(),
                    "expiresAt": None,
                    "cleanupPending": False,
                    "retainedExternalOrphan": True,
                    "trashName": None,
                    "reservedBytes": int(job["reservedBytes"]),
                }
            self._persist_locked()
        except Exception:
            for handle, job in moved.items():
                self.tombstones.pop(handle, None)
                self.jobs[handle] = job
            raise

    def _startup_reconcile(self, instance_id: str, *, retry: bool = True) -> None:
        while not self.stop_event.is_set():
            try:
                self.reconciliation_local.instance_id = instance_id
                self._prune_terminal_receipts()
                self.reconcile(instance_id)
                with self.lock:
                    self.reconciled_instances.add(instance_id)
                with self.health_condition:
                    self.health_cache = None
                    self.health_condition.notify_all()
                return
            except Exception as exc:
                # Normalize every operational failure at the daemon boundary;
                # raw filesystem/runtime errors must not silently kill recovery.
                normalized = (
                    exc
                    if isinstance(exc, ExecutorError)
                    else ExecutorError("OCI startup reconciliation failed")
                )
                if not retry:
                    with self.lock:
                        self.startup_reconcile_instances.discard(instance_id)
                    raise normalized from exc
                if self.stop_event.wait(max(0.25, self.config.poll_interval_seconds)):
                    return
            finally:
                self.reconciliation_local.instance_id = None

    def health(self) -> dict[str, Any]:
        now = time.monotonic()
        with self.health_condition:
            if self.health_cache and now - self.health_cache[0] < self.config.health_cache_seconds:
                return json.loads(json.dumps(self.health_cache[1]))
            if self.health_inflight:
                self.health_condition.wait(
                    timeout=self.config.engine_timeout_seconds + 1
                )
                now = time.monotonic()
                if self.health_cache and now - self.health_cache[0] < self.config.health_cache_seconds:
                    return json.loads(json.dumps(self.health_cache[1]))
                return {
                    "ok": False,
                    "provider": "science-oci-executor",
                    "version": EXECUTOR_VERSION,
                    "executionMode": "isolated_oci_candidate",
                    "executesUserCode": False,
                    "detail": "OCI admission probe exceeded the shared health deadline",
                }
            self.health_inflight = True
        try:
            instance_id = self.admit()
            with self.lock:
                if instance_id not in self.reconciled_instances:
                    raise AdmissionError("OCI startup reconciliation has not completed")
        except Exception:
            result = {
                "ok": False,
                "provider": "science-oci-executor",
                "version": EXECUTOR_VERSION,
                "executionMode": "isolated_oci_candidate",
                "executesUserCode": False,
                "detail": "OCI execution admission has not passed",
            }
        else:
            result = {
                "ok": True,
                "provider": "science-oci-executor",
                "version": EXECUTOR_VERSION,
                "instanceId": instance_id,
                "executionMode": "isolated_oci",
                "executesUserCode": True,
            }
        finally:
            with self.health_condition:
                if "result" in locals():
                    self.health_cache = (time.monotonic(), result)
                self.health_inflight = False
                self.health_condition.notify_all()
        return json.loads(json.dumps(result))

    def _require_fence(self, expected_instance_id: str) -> str:
        if not INSTANCE_ID.fullmatch(str(expected_instance_id)):
            raise FenceError("expected provider instance ID is invalid")
        current = self._require_engine_fence(expected_instance_id)
        with self.lock:
            if current not in self.reconciled_instances:
                raise AdmissionError("OCI startup reconciliation has not completed")
        return current

    def _require_engine_fence(self, expected_instance_id: str) -> str:
        if not INSTANCE_ID.fullmatch(str(expected_instance_id)):
            raise FenceError("expected provider instance ID is invalid")
        current = self.admit(rotate_on_engine_change=False)
        if current != expected_instance_id:
            raise FenceError("provider instance fence rejected the operation")
        return current

    def _require_internal_job_instance(self, job_instance_id: str) -> None:
        """Fence background/recovery work before any execution-scoped engine call."""
        current = self._require_engine_fence(job_instance_id)
        if current != job_instance_id:
            raise FenceError("background execution belongs to another provider instance")
        with self.lock:
            ready = current in self.reconciled_instances
        if not ready and getattr(self.reconciliation_local, "instance_id", None) != current:
            raise AdmissionError("OCI startup reconciliation has not completed")

    def quote(self, resources: Mapping[str, Any]) -> dict[str, Any]:
        available = False
        reason: str | None = None
        try:
            instance_id = self.admit(rotate_on_engine_change=False)
            with self.lock:
                if instance_id not in self.reconciled_instances:
                    raise AdmissionError("OCI startup reconciliation has not completed")
            row = _exact_object(dict(resources), "resources", RESOURCE_KEYS)
            available = (
                _integer(row["cpuMillicores"], "cpuMillicores", 1, 1_000_000)
                <= self.config.limits.cpu_millicores
                and _integer(row["memoryMb"], "memoryMb", 1, 16_777_216)
                <= self.config.limits.memory_mb
                and _integer(row["gpuCount"], "gpuCount", 0, 64) == 0
                and _integer(row["wallTimeSeconds"], "wallTimeSeconds", 1, 31_536_000)
                <= self.config.limits.wall_time_seconds
            )
            if not available:
                reason = "requested resources exceed admitted executor limits"
            with self.lock:
                if sum(
                    job["state"] in ACTIVE_STATES
                    and job.get("instanceId") == self.instance_id
                    for job in self.jobs.values()
                ) >= self.config.max_concurrency:
                    available = False
                    reason = "executor concurrency is exhausted"
                elif (
                    self._state_reserved_bytes_locked()
                    + self.config.max_output_total_bytes
                    + JOB_STATE_RESERVATION_BYTES
                    > self.config.max_state_bytes
                ):
                    available = False
                    reason = "executor durable state quota is exhausted"
        except ExecutorError:
            reason = "OCI executor admission is unavailable"
        return {
            "available": available,
            "provider": "science-oci-executor",
            "source": "declared",
            "queueSeconds": 0 if available else None,
            "estimatedWallSeconds": None,
            "cost": None,
            "limits": {
                "cpuMillicores": self.config.limits.cpu_millicores,
                "memoryMb": self.config.limits.memory_mb,
                "gpuCount": 0,
                "wallTimeSeconds": self.config.limits.wall_time_seconds,
            },
            **({"reason": reason} if reason else {}),
        }

    def submit(self, value: Any, expected_instance_id: str) -> dict[str, str]:
        instance_id = self._require_fence(expected_instance_id)
        self._prune_terminal_receipts()
        normalized, ephemeral_inputs = _normalize_submission(value, self.config)
        state_reservation = self._submission_reservation(normalized)
        key_hash = hashlib.sha256(normalized["idempotencyKey"].encode("utf-8")).hexdigest()
        semantic = dict(normalized)
        del semantic["idempotencyKey"]
        payload_digest = hashlib.sha256(canonical_json(semantic)).hexdigest()
        # Provider instance is part of the handle namespace. An engine identity
        # rotation cannot let an old tombstone block the replacement forever.
        handle = "run-" + hashlib.sha256(
            (instance_id + "\0" + key_hash).encode("ascii")
        ).hexdigest()[:32]
        with self.submit_lock:
            with self.lock:
                existing = self.jobs.get(handle) or self.tombstones.get(handle)
                if existing:
                    if (
                        existing.get("keyHash") != key_hash
                        or existing.get("payloadDigest") != payload_digest
                    ):
                        raise ConflictError(
                            "Idempotency-Key was already used with a different submission"
                        )
                    if existing.get("instanceId") != instance_id:
                        raise FenceError("idempotent execution belongs to another provider instance")
                    if existing["state"] in TERMINAL_STATES:
                        return {"handle": handle}
                else:
                    if len(self.jobs) >= 4096:
                        raise ExecutorError("OCI executor ledger capacity is exhausted")
                    if (
                        self._state_reserved_bytes_locked() + state_reservation
                        > self.config.max_state_bytes
                    ):
                        raise ExecutorError("OCI executor durable state quota is exhausted")
                    if sum(
                        job["state"] in ACTIVE_STATES
                        and job.get("instanceId") == instance_id
                        for job in self.jobs.values()
                    ) >= self.config.max_concurrency:
                        raise ExecutorError("OCI executor concurrency is exhausted")
                    now = utc_now()
                    self.jobs[handle] = {
                        "handle": handle,
                        "keyHash": key_hash,
                        "payloadDigest": payload_digest,
                        "instanceId": instance_id,
                        "generation": normalized["generation"],
                        "submission": {**normalized, "idempotencyKeyHash": key_hash},
                        "state": "queued",
                        "progress": 0.0,
                        "message": "input staging reserved",
                        "error": None,
                        "cancelRequested": False,
                        "containerName": self._container_name(handle, normalized["generation"]),
                        "containerId": None,
                        "allocationAttempted": False,
                        "outputs": [],
                        "createdAt": now,
                        "startedAt": None,
                        "startRequestedAt": None,
                        "terminalIntent": None,
                        "reservedBytes": state_reservation,
                        "updatedAt": now,
                    }
                    del self.jobs[handle]["submission"]["idempotencyKey"]
                    self._persist_locked()
        try:
            operation_lock = self._operation_lock(handle)
            if not operation_lock.acquire(blocking=False):
                # Another same-handle submit/recovery owns convergence. The
                # durable row is already the idempotent acknowledgement.
                return {"handle": handle}
            try:
                with self.lock:
                    current = self.jobs.get(handle)
                    if not current or current["state"] in TERMINAL_STATES:
                        return {"handle": handle}
                    already_running = (
                        current["state"] == "running" and bool(current.get("containerId"))
                    )
                if already_running:
                    self._ensure_monitor(handle)
                    return {"handle": handle}
                self._provision(handle, normalized, ephemeral_inputs)
            finally:
                operation_lock.release()
        except Exception as exc:
            ensure_monitor = False
            with self.lock:
                job = self.jobs[handle]
                if job["state"] not in TERMINAL_STATES:
                    if job.get("containerId") or job.get("allocationAttempted"):
                        # Do not claim a safe terminal state while removal of
                        # an exact external allocation remains unproved.
                        job.update(
                            state="provisioning",
                            progress=0.1,
                            message="OCI provisioning failed; exact cleanup is unproved",
                            error=type(exc).__name__[:200],
                            updatedAt=utc_now(),
                        )
                        ensure_monitor = True
                    else:
                        job.update(
                            state="failed",
                            progress=None,
                            message="OCI execution provisioning failed",
                            error=type(exc).__name__[:200],
                            updatedAt=utc_now(),
                        )
                    self._persist_locked()
            if ensure_monitor:
                self._ensure_monitor(handle)
            if isinstance(exc, ExecutorError):
                raise
            raise ExecutorError("OCI execution provisioning failed") from exc
        return {"handle": handle}

    def _prune_terminal_receipts(self) -> None:
        """Bound local receipt/idempotency retention without touching live jobs.

        A terminal row is eligible only after exact-container removal was
        durably committed and the configured retention window elapsed. The
        cleanup intent is persisted before bytes are renamed/deleted. A compact
        tombstone continues to reject same-key semantic drift for a second
        retention window. This is a provider-local cache policy, not a legal
        hold or control-plane artifact-retention implementation.
        """
        if not self.prune_lock.acquire(blocking=False):
            return
        try:
            now = datetime.now(timezone.utc)
            cutoff = now.timestamp() - self.config.terminal_retention_seconds
            with self.lock:
                expired_tombstones = [
                    handle
                    for handle, tombstone in self.tombstones.items()
                    if not tombstone.get("cleanupPending")
                    and not tombstone.get("retainedExternalOrphan")
                    and _parse_time(tombstone["expiresAt"], "expiresAt").timestamp()
                    <= now.timestamp()
                ]
                for handle in expired_tombstones:
                    self.tombstones.pop(handle, None)
                if expired_tombstones:
                    self._persist_locked()
                pending = [
                    (handle, tombstone)
                    for handle, tombstone in self.tombstones.items()
                    if tombstone.get("cleanupPending")
                ]
                eligible = [
                    handle
                    for handle, job in self.jobs.items()
                    if job.get("state") in TERMINAL_STATES
                    and not job.get("containerId")
                    and job.get("finishedAt")
                    and _parse_time(job["finishedAt"], "finishedAt").timestamp() <= cutoff
                    and handle not in self.tombstones
                ]
            for handle, tombstone in pending:
                try:
                    self._finish_prune(handle, str(tombstone["trashName"]))
                except ExecutorError:
                    # Do not release metadata/idempotency protection. A failed
                    # cleanup also must not reject unrelated work immediately.
                    continue
            for handle in eligible:
                with self.lock:
                    if len(self.tombstones) >= self.config.max_tombstones:
                        break
                    job = self.jobs.get(handle)
                    if not job or job.get("state") not in TERMINAL_STATES:
                        continue
                    trash_name = f".pruned-{handle}-{secrets.token_hex(8)}"
                    expires = now + timedelta(
                        seconds=self.config.terminal_retention_seconds
                    )
                    self.tombstones[handle] = {
                        "handle": handle,
                        "keyHash": job["keyHash"],
                        "payloadDigest": job["payloadDigest"],
                        "instanceId": job["instanceId"],
                        "generation": job["generation"],
                        "state": job["state"],
                        "progress": job.get("progress"),
                        "message": "provider-local terminal receipt retention expired",
                        "error": job.get("error"),
                        "outputs": [],
                        "receiptExpired": True,
                        "createdAt": job.get("createdAt"),
                        "finishedAt": job.get("finishedAt"),
                        "prunedAt": utc_now(),
                        "expiresAt": expires.isoformat(timespec="milliseconds").replace(
                            "+00:00", "Z"
                        ),
                        "cleanupPending": True,
                        "trashName": trash_name,
                        "reservedBytes": int(job["reservedBytes"]),
                    }
                    self._persist_locked()
                try:
                    self._finish_prune(handle, trash_name)
                except ExecutorError:
                    continue
        finally:
            self.prune_lock.release()

    def _finish_prune(self, handle: str, trash_name: str) -> None:
        root = (self.jobs_dir / handle).resolve()
        trash = (self.jobs_dir / trash_name).resolve()
        if root.parent != self.jobs_dir.resolve() or trash.parent != self.jobs_dir.resolve():
            raise ExecutorError("terminal pruning path escaped the executor state root")
        try:
            if root.exists():
                os.replace(root, trash)
                _fsync_directory(self.jobs_dir)
            if trash.exists():
                if trash.is_symlink() or not trash.is_dir():
                    raise ExecutorError("terminal pruning target is not a directory")
                def restore_write_and_retry(function, name, _error):  # noqa: ANN001
                    os.chmod(name, stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR)
                    function(name)

                shutil.rmtree(trash, onerror=restore_write_and_retry)
                _fsync_directory(self.jobs_dir)
        except OSError as exc:
            # Keep both authoritative job and cleanup-pending tombstone. A later
            # startup/submit retries; quota is not released prematurely.
            raise ExecutorError("terminal receipt pruning did not complete") from exc
        with self.lock:
            tombstone = self.tombstones.get(handle)
            if not tombstone or tombstone.get("trashName") != trash_name:
                raise ExecutorError("terminal pruning tombstone changed unexpectedly")
            self.jobs.pop(handle, None)
            tombstone["cleanupPending"] = False
            tombstone["reservedBytes"] = 0
            self._persist_locked()

    @staticmethod
    def _container_name(handle: str, generation: int) -> str:
        return f"pm-science-{handle[4:20]}-g{generation}"

    def _job_paths(self, handle: str) -> tuple[Path, Path, Path]:
        root = (self.jobs_dir / handle).resolve()
        if root.parent != self.jobs_dir.resolve():
            raise ExecutorError("job path escaped the executor state root")
        return root / "input", root / "control", root / "output"

    def _cancel_requested(self, handle: str) -> bool:
        with self.lock:
            job = self.jobs.get(handle)
            return not job or bool(job.get("cancelRequested"))

    def _stage_inputs(
        self,
        handle: str,
        normalized: Mapping[str, Any],
        ephemeral_inputs: list[dict[str, Any]],
    ) -> tuple[Path, Path, Path]:
        should_cancel = lambda: self._cancel_requested(handle)
        if should_cancel():
            raise CancellationError("input staging was cancelled")
        input_dir, control_dir, output_dir = self._job_paths(handle)
        if input_dir.exists() and control_dir.exists():
            for index, item in enumerate(normalized["inputs"]):
                if should_cancel():
                    raise CancellationError("input staging was cancelled")
                path = input_dir / f"{index:04d}-{item['sha256'][:16]}.bin"
                if not path.is_file() or _digest_file(path, should_cancel) != (
                    item["size"],
                    item["sha256"],
                ):
                    raise ExecutorError("persisted staged input differs from its receipt")
            return input_dir, control_dir, output_dir
        root = input_dir.parent
        if root.exists():
            raise ExecutorError("partial input staging requires operator cleanup")
        temporary = self.jobs_dir / f".{handle}-{secrets.token_hex(8)}"
        temporary_input = temporary / "input"
        temporary_control = temporary / "control"
        temporary_input.mkdir(parents=True)
        temporary_control.mkdir()
        control_inputs: list[dict[str, Any]] = []
        try:
            for index, item in enumerate(ephemeral_inputs):
                if should_cancel():
                    raise CancellationError("input staging was cancelled")
                filename = f"{index:04d}-{item['sha256'][:16]}.bin"
                target = temporary_input / filename
                expires_at = _parse_time(item["expiresAt"], "input reference expiry")
                if expires_at <= datetime.now(timezone.utc):
                    raise ExecutorError("input reference expired before staging")
                self.fetcher.fetch(
                    item["url"], target, item["size"], should_cancel
                )
                if should_cancel():
                    raise CancellationError("input staging was cancelled")
                if expires_at <= datetime.now(timezone.utc):
                    raise ExecutorError("input reference expired during staging")
                if _digest_file(target, should_cancel) != (
                    item["size"],
                    item["sha256"],
                ):
                    raise ExecutorError("staged input differs from its immutable receipt")
                os.chmod(target, stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)
                _fsync_file(target)
                control_inputs.append(
                    {
                        **{key: item[key] for key in ("artifactVersionId", "role", "mediaType", "sha256", "size")},
                        "path": f"/science/input/{filename}",
                    }
                )
            execution_spec = {
                "contractVersion": EXECUTION_CONTRACT,
                "runId": normalized["runId"],
                "missionId": normalized["missionId"],
                "generation": normalized["generation"],
                "submittedAt": normalized["submittedAt"],
                "imageDigest": normalized["imageDigest"],
                "kernel": normalized["kernel"],
                "parameters": normalized["parameters"],
                "resources": normalized["resources"],
                "inputs": control_inputs,
            }
            spec_path = temporary_control / "submission.json"
            with spec_path.open("xb") as stream:
                stream.write(canonical_json(execution_spec))
                stream.flush()
                os.fsync(stream.fileno())
            os.chmod(spec_path, stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)
            os.chmod(temporary_input, stat.S_IRUSR | stat.S_IXUSR | stat.S_IRGRP | stat.S_IXGRP | stat.S_IROTH | stat.S_IXOTH)
            os.chmod(temporary_control, stat.S_IRUSR | stat.S_IXUSR | stat.S_IRGRP | stat.S_IXGRP | stat.S_IROTH | stat.S_IXOTH)
            _fsync_tree(temporary)
            if should_cancel():
                raise CancellationError("input staging was cancelled")
            os.replace(temporary, root)
            _fsync_directory(self.jobs_dir)
        except Exception:
            shutil.rmtree(temporary, ignore_errors=True)
            raise
        return input_dir, control_dir, output_dir

    def _expected_labels(self, job: Mapping[str, Any]) -> dict[str, str]:
        return {
            "io.puppetmaster.science.executor-instance": str(job["instanceId"]),
            "io.puppetmaster.science.handle": str(job["handle"]),
            "io.puppetmaster.science.generation": str(job["generation"]),
            "io.puppetmaster.science.payload-digest": str(job["payloadDigest"]),
        }

    def _effective_spec(self, job: Mapping[str, Any]) -> ContainerSpec:
        input_dir, control_dir, output_dir = self._job_paths(str(job["handle"]))
        submission = job["submission"]
        return ContainerSpec(
            name=str(job["containerName"]),
            image_reference=self.config.image_map[str(submission["imageDigest"])],
            labels=self._expected_labels(job),
            input_dir=input_dir,
            control_dir=control_dir,
            output_dir=output_dir,
            resources=submission["resources"],
            uid=self.config.container_uid,
            gid=self.config.container_gid,
            pids=self.config.limits.pids,
            max_output_bytes=self.config.max_output_total_bytes,
        )

    @staticmethod
    def _assert_container_identity(
        container: EngineContainer, expected_name: str, labels: Mapping[str, str]
    ) -> None:
        if container.name != expected_name or any(
            container.labels.get(key) != value for key, value in labels.items()
        ):
            raise FenceError("OCI container identity or generation label differs")

    def _provision(
        self,
        handle: str,
        normalized: Mapping[str, Any],
        ephemeral_inputs: list[dict[str, Any]],
    ) -> None:
        try:
            input_dir, control_dir, output_dir = self._stage_inputs(
                handle, normalized, ephemeral_inputs
            )
        except CancellationError:
            if not self._cancel_requested(handle):
                raise
            self._transition(
                handle, "cancelled", None, "cancelled during immutable input staging", None
            )
            return
        with self.lock:
            job = self.jobs[handle]
            job.update(
                state="provisioning",
                progress=0.1,
                message="immutable inputs staged and verified",
                updatedAt=utc_now(),
            )
            self._persist_locked()
            labels = self._expected_labels(job)
            name = job["containerName"]
            job_instance_id = str(job["instanceId"])
            cancel_requested = bool(job.get("cancelRequested"))
        if cancel_requested:
            self._transition(
                handle, "cancelled", None, "cancelled before OCI allocation", None
            )
            return
        # Input staging may be long. Re-probe the engine identity before the
        # first operation capable of observing or allocating a container.
        self._require_internal_job_instance(job_instance_id)
        existing = self.engine.lookup(name)
        if existing is not None:
            self._assert_container_identity(existing, name, labels)
            container = existing
        else:
            with self.lock:
                spec = self._effective_spec(self.jobs[handle])
                if self.jobs[handle].get("cancelRequested"):
                    self._transition(
                        handle, "cancelled", None, "cancelled before OCI allocation", None
                    )
                    return
            try:
                with self.lock:
                    self.jobs[handle]["allocationAttempted"] = True
                    self.jobs[handle]["updatedAt"] = utc_now()
                    self._persist_locked()
                container = self.engine.create(spec)
            except ExecutorError:
                # A lost create response is recovered only by the deterministic
                # name plus all immutable labels; never create a second instance.
                recovered = self.engine.lookup(name)
                if recovered is None:
                    with self.lock:
                        self.jobs[handle]["allocationAttempted"] = False
                        self.jobs[handle]["updatedAt"] = utc_now()
                        self._persist_locked()
                    raise
                self._assert_container_identity(recovered, name, labels)
                container = recovered
            self._assert_container_identity(container, name, labels)
        # Persist the discovered allocation before another admission probe. If
        # the endpoint identity changes now, recovery retains an explicit orphan
        # record and never inspects/removes through the replacement engine.
        with self.lock:
            job = self.jobs[handle]
            job["containerId"] = container.id
            job["updatedAt"] = utc_now()
            self._persist_locked()
        # Close the create/lookup-to-start window as far as the CLI protocol
        # permits. Exact labels remain the second fence on every inspect.
        self._require_internal_job_instance(job_instance_id)
        with self.lock:
            effective_spec = self._effective_spec(self.jobs[handle])
        try:
            self.engine.verify_isolation(container.id, effective_spec)
        except Exception:
            # Labels were verified before this point, so cleanup may target only
            # this exact, still-unstarted allocation. If cleanup cannot be
            # proven, retain the handle in provisioning for replay/admin action.
            self._require_internal_job_instance(job_instance_id)
            current_for_cleanup = self.engine.inspect(container.id)
            if current_for_cleanup is not None:
                self._assert_container_identity(current_for_cleanup, name, labels)
                if current_for_cleanup.state == "running":
                    self.engine.kill(container.id)
                self.engine.remove(container.id)
            with self.lock:
                self.jobs[handle]["containerId"] = None
                self.jobs[handle]["allocationAttempted"] = False
                self.jobs[handle]["updatedAt"] = utc_now()
                self._persist_locked()
            raise
        self._require_internal_job_instance(job_instance_id)
        current = self.engine.inspect(container.id)
        if current is None:
            raise ExecutorError("created OCI container disappeared before start")
        self._assert_container_identity(current, name, labels)
        with self.lock:
            cancel_requested = bool(self.jobs[handle].get("cancelRequested"))
        if cancel_requested:
            self._remove_then_commit(
                handle,
                container.id,
                "cancelled",
                None,
                "exact OCI container cancelled before start",
                None,
            )
            return
        if current.state == "created":
            current = self._start_existing(
                handle, current, effective_spec, isolation_verified=True
            )
        if current.state not in {"running", "created"}:
            # Never restart an exited container: doing so would duplicate compute.
            self.tick(handle)
            return
        with self.lock:
            job = self.jobs[handle]
            if job["state"] not in TERMINAL_STATES:
                job.update(
                    state="running",
                    progress=0.25,
                    message="isolated OCI container started",
                    startedAt=job.get("startedAt") or utc_now(),
                    updatedAt=utc_now(),
                )
                self._persist_locked()
        self._ensure_monitor(handle)

    def _start_existing(
        self,
        handle: str,
        container: EngineContainer,
        spec: ContainerSpec,
        *,
        isolation_verified: bool = False,
    ) -> EngineContainer:
        with self.lock:
            job_instance_id = str(self.jobs[handle]["instanceId"])
        self._require_internal_job_instance(job_instance_id)
        if not isolation_verified:
            self.engine.verify_isolation(container.id, spec)
        with self.lock:
            job = self.jobs[handle]
            if job.get("cancelRequested"):
                cancel_before_start = True
            else:
                cancel_before_start = False
        if cancel_before_start:
            self._remove_then_commit(
                handle,
                container.id,
                "cancelled",
                None,
                "exact OCI container cancelled before start",
                None,
            )
            return container
        with self.lock:
            job = self.jobs[handle]
            boundary = job.get("startRequestedAt") or utc_now()
            job.update(
                startRequestedAt=boundary,
                startedAt=job.get("startedAt") or boundary,
                message="durable OCI start boundary recorded",
                updatedAt=utc_now(),
            )
            self._persist_locked()
        try:
            with self.lock:
                wall_seconds = int(
                    self.jobs[handle]["submission"]["resources"]["wallTimeSeconds"]
                )
            self._require_internal_job_instance(job_instance_id)
            self.engine.start(container.id, wall_seconds)
        except ExecutorError:
            current = self.engine.inspect(container.id)
            if current is None:
                self._transition(
                    handle,
                    "failed",
                    None,
                    "OCI start failed and exact container is absent",
                    "container_start_failed",
                )
                return container
            self._assert_container_identity(current, spec.name, spec.labels)
            if current.state == "created":
                # The durable boundary makes a later retry safe; elapsed wall
                # time continues from the first attempted start.
                raise
            container = current
        else:
            current = self.engine.inspect(container.id)
            if current is None:
                raise ExecutorError("started OCI container disappeared before convergence")
            self._assert_container_identity(current, spec.name, spec.labels)
            container = current
        with self.lock:
            cancel_requested = bool(self.jobs[handle].get("cancelRequested"))
        if cancel_requested and container.state == "running":
            self._remove_then_commit(
                handle,
                container.id,
                "cancelled",
                None,
                "cancellation synchronized after in-flight OCI start",
                None,
            )
        elif container.state == "running":
            with self.lock:
                job = self.jobs[handle]
                if job["state"] not in TERMINAL_STATES:
                    job.update(
                        state="running",
                        progress=0.25,
                        message="isolated OCI container started",
                        updatedAt=utc_now(),
                    )
                    self._persist_locked()
        return container

    def _ensure_monitor(self, handle: str) -> None:
        if not self.auto_monitor:
            return
        with self.lock:
            if self.jobs[handle]["state"] in TERMINAL_STATES:
                return
            current = self.monitors.get(handle)
            if current and current.is_alive():
                return
            worker = threading.Thread(
                target=self._monitor,
                args=(handle,),
                daemon=True,
                name=f"science-oci-{handle[4:12]}",
            )
            self.monitors[handle] = worker
            worker.start()

    def _monitor(self, handle: str) -> None:
        while not self.stop_event.wait(self.config.poll_interval_seconds):
            try:
                self.tick(handle)
            except Exception:
                try:
                    with self.lock:
                        job = self.jobs.get(handle)
                        if not job or job["state"] in TERMINAL_STATES:
                            return
                        job.update(
                            message="OCI engine or durable state is temporarily unavailable",
                            updatedAt=utc_now(),
                        )
                        self._persist_locked()
                except Exception:
                    # Keep the watchdog alive even when the state volume is the
                    # transient failure. The next bounded tick retries cleanup.
                    pass
                continue
            with self.lock:
                if self.jobs[handle]["state"] in TERMINAL_STATES:
                    return

    def _operation_lock(self, handle: str) -> threading.RLock:
        with self.lock:
            return self.operation_locks.setdefault(handle, threading.RLock())

    def tick(self, handle: str) -> None:
        with self._operation_lock(handle):
            self._tick_once(handle)

    def _tick_once(self, handle: str) -> None:
        with self.lock:
            job = self.jobs.get(handle) or self.tombstones.get(handle)
            if not job or job["state"] in TERMINAL_STATES:
                return
            container_id = job.get("containerId")
            labels = self._expected_labels(job)
            name = job["containerName"]
            cancel_requested = bool(job["cancelRequested"])
            allocation_attempted = bool(job.get("allocationAttempted"))
            submission = json.loads(json.dumps(job["submission"]))
            started_at = job.get("startedAt")
            wall_seconds = int(job["submission"]["resources"]["wallTimeSeconds"])
            job_instance_id = str(job["instanceId"])
        self._require_internal_job_instance(job_instance_id)
        if not container_id:
            recovered = self.engine.lookup(name)
            if recovered is not None:
                self._assert_container_identity(recovered, name, labels)
                with self.lock:
                    self.jobs[handle]["containerId"] = recovered.id
                    self.jobs[handle]["updatedAt"] = utc_now()
                    self._persist_locked()
                container_id = recovered.id
            elif cancel_requested:
                self._transition(
                    handle,
                    "cancelled",
                    None,
                    "cancelled before an OCI allocation existed",
                    None,
                )
                return
            elif allocation_attempted:
                # A prior create response was ambiguous, but lookup has now
                # independently proved absence. Re-enter provision from the
                # durable staged inputs; the deterministic name/labels prevent
                # duplicate allocation.
                self._provision(handle, submission, [])
                return
            else:
                return
        container = self.engine.inspect(container_id)
        if container is None:
            with self.lock:
                terminal_intent = self.jobs[handle].get("terminalIntent")
            if terminal_intent:
                self._commit_terminal_intent(handle)
                return
            self._transition(
                handle,
                "cancelled" if cancel_requested else "failed",
                None,
                "exact OCI container is absent",
                None if cancel_requested else "container_absent",
            )
            return
        self._assert_container_identity(container, name, labels)
        timed_out = False
        if started_at:
            elapsed = datetime.now(timezone.utc) - _parse_time(started_at, "startedAt")
            timed_out = elapsed.total_seconds() > wall_seconds
        if container.state == "running" and not cancel_requested and not timed_out:
            return
        if container.state == "running":
            self.engine.kill(container_id)
            container = self.engine.inspect(container_id)
            if container is not None and container.state == "running":
                raise ExecutorError("OCI engine did not prove container termination")
        if cancel_requested or timed_out:
            self._remove_then_commit(
                handle,
                container_id,
                "cancelled" if cancel_requested else "failed",
                None,
                "exact OCI container cancelled" if cancel_requested else "OCI wall-time limit exceeded",
                None if cancel_requested else "wall_time_exceeded",
            )
            return
        if container.state == "created":
            with self.lock:
                spec = self._effective_spec(self.jobs[handle])
            current = self._start_existing(handle, container, spec)
            with self.lock:
                terminal = self.jobs[handle]["state"] in TERMINAL_STATES
            if terminal or current.state in {"created", "running"}:
                return
            container = current
        if container.state in {"paused", "restarting"}:
            return
        if container.exit_code != 0:
            self._remove_then_commit(
                handle,
                container_id,
                "failed",
                None,
                "OCI execution returned a non-zero status",
                "container_exit_nonzero",
            )
            return
        try:
            self._export_outputs_exact(handle, container_id)
            outputs = self._collect_output_files(handle)
        except ExecutorError:
            self._remove_then_commit(
                handle,
                container_id,
                "failed",
                None,
                "OCI outputs failed bounded receipt validation",
                "invalid_outputs",
            )
            return
        self._remove_then_commit(
            handle,
            container_id,
            "succeeded",
            1.0,
            "OCI outputs checksummed and exact container removed",
            None,
            outputs,
        )

    def _export_outputs_exact(self, handle: str, container_id: str) -> None:
        _, _, output_dir = self._job_paths(handle)
        if output_dir.exists():
            # A completed export is atomically renamed into place. Re-validate
            # it rather than copying a stopped container twice after restart.
            self._collect_output_files(handle)
            return
        root = output_dir.parent
        for stale in root.glob(".output-export-*"):
            resolved = stale.resolve()
            if resolved.parent != root.resolve():
                raise ExecutorError("stale output export escaped its job root")
            if stale.is_symlink() or stale.is_file():
                stale.unlink()
            else:
                shutil.rmtree(stale)
        temporary = root / f".output-export-{secrets.token_hex(8)}"
        try:
            self.engine.export_outputs(container_id, temporary)
            self._collect_output_files(handle, directory=temporary)
            _fsync_tree(temporary)
            os.replace(temporary, output_dir)
            _fsync_directory(root)
        except Exception:
            if temporary.exists():
                shutil.rmtree(temporary, ignore_errors=True)
            raise

    def _remove_then_commit(
        self,
        handle: str,
        container_id: str,
        state: str,
        progress: float | None,
        message: str,
        error: str | None,
        outputs: list[dict[str, Any]] | None = None,
    ) -> None:
        """Persist terminal evidence, prove removal, then expose terminal state."""
        with self.lock:
            job = self.jobs[handle]
            if job["state"] in TERMINAL_STATES:
                return
            if state == "succeeded" and job.get("cancelRequested"):
                state = "cancelled"
                progress = None
                message = "cancellation won the terminal output commit"
                error = None
                outputs = []
            job["terminalIntent"] = {
                "state": state,
                "progress": progress,
                "message": message[:2000],
                "error": error[:4000] if error else None,
                "outputs": outputs or [],
                "preparedAt": utc_now(),
            }
            job["updatedAt"] = utc_now()
            self._persist_locked()
        # Never publish a terminal receipt while this exact external allocation
        # may still exist. remove() includes an independent absence proof.
        self._require_internal_job_instance(str(job["instanceId"]))
        self.engine.remove(container_id)
        self._commit_terminal_intent(handle)

    def _commit_terminal_intent(self, handle: str) -> None:
        with self.lock:
            job = self.jobs[handle]
            intent = job.get("terminalIntent")
            if not isinstance(intent, dict):
                raise ExecutorError("terminal convergence lacks a durable intent")
            state = str(intent.get("state"))
            progress = intent.get("progress")
            message = str(intent.get("message", ""))
            error = intent.get("error")
            outputs = intent.get("outputs")
            if state not in TERMINAL_STATES or not isinstance(outputs, list):
                raise ExecutorError("durable terminal intent is invalid")
            if state == "succeeded" and job.get("cancelRequested"):
                state = "cancelled"
                progress = None
                message = "cancellation won the terminal output commit"
                error = None
                outputs = []
            job.update(
                state=state,
                progress=progress,
                message=message[:2000],
                error=str(error)[:4000] if error else None,
                outputs=outputs,
                containerId=None,
                terminalIntent=None,
                finishedAt=utc_now(),
                updatedAt=utc_now(),
            )
            self._persist_locked()

    def _transition(
        self,
        handle: str,
        state: str,
        progress: float | None,
        message: str,
        error: str | None,
        outputs: list[dict[str, Any]] | None = None,
    ) -> None:
        with self.lock:
            job = self.jobs[handle]
            if job["state"] in TERMINAL_STATES:
                return
            if state == "succeeded" and job["cancelRequested"]:
                state = "cancelled"
                progress = None
                message = "cancellation won the terminal output commit"
                error = None
                outputs = []
            job.update(
                state=state,
                progress=progress,
                message=message[:2000],
                error=error[:4000] if error else None,
                outputs=outputs or [],
                containerId=None,
                terminalIntent=None,
                finishedAt=utc_now(),
                updatedAt=utc_now(),
            )
            self._persist_locked()

    def _collect_output_files(
        self, handle: str, *, directory: Path | None = None
    ) -> list[dict[str, Any]]:
        _, _, final_output_dir = self._job_paths(handle)
        output_dir = final_output_dir if directory is None else directory.resolve()
        if directory is not None and output_dir.parent != final_output_dir.parent.resolve():
            raise ExecutorError("OCI output export escaped its job root")
        if output_dir.is_symlink() or not output_dir.is_dir():
            raise ExecutorError("OCI output root is missing or symbolic")
        files: list[Path] = []
        entries = 0
        for path in output_dir.rglob("*"):
            entries += 1
            if entries > max(4096, self.config.max_outputs * 8):
                raise ExecutorError("OCI output tree contains too many entries")
            if path.is_symlink():
                raise ExecutorError("OCI outputs may not contain symbolic links")
            if path.is_dir():
                continue
            if not path.is_file():
                raise ExecutorError("OCI output contains a non-regular file")
            files.append(path)
            if len(files) > self.config.max_outputs:
                raise ExecutorError("OCI output count exceeds the admitted bound")
        files.sort(key=lambda path: path.relative_to(output_dir).as_posix())
        if not 1 <= len(files) <= self.config.max_outputs:
            raise ExecutorError("OCI output count is outside the admitted bound")
        receipts: list[dict[str, Any]] = []
        total = 0
        for path in files:
            relative = path.relative_to(output_dir).as_posix()
            if len(relative) > 300 or any(part in {"", ".", ".."} for part in relative.split("/")):
                raise ExecutorError("OCI output logical name is invalid")
            size, checksum = _digest_file(path)
            if size > self.config.max_output_file_bytes:
                raise ExecutorError("OCI output file exceeds the admitted bound")
            total += size
            if total > self.config.max_output_total_bytes:
                raise ExecutorError("OCI output set exceeds the admitted bound")
            os.chmod(path, stat.S_IRUSR | stat.S_IRGRP | stat.S_IROTH)
            _fsync_file(path)
            suffix = path.suffix.lower()
            kind = (
                "geometry" if suffix in {".vtk", ".vtp", ".stl", ".step", ".stp"}
                else "image" if suffix in {".png", ".jpg", ".jpeg", ".webp"}
                else "notebook" if suffix == ".ipynb"
                else "dataset" if suffix in {".csv", ".parquet", ".arrow"}
                else "log" if suffix in {".log", ".txt"}
                else "result"
            )
            media_type = mimetypes.guess_type(relative)[0] or "application/octet-stream"
            reference = "/v1/outputs/" + handle + "/" + "/".join(
                quote(part, safe="") for part in relative.split("/")
            )
            receipts.append(
                {
                    "reference": reference,
                    "logicalName": relative,
                    "kind": kind,
                    "format": suffix.lstrip(".") or "binary",
                    "mediaType": media_type,
                    "sha256": checksum,
                    "size": size,
                    "metadata": {"executorContract": EXECUTION_CONTRACT},
                    "_path": str(path),
                }
            )
        return receipts

    def _get_job(
        self, handle: str, generation: int, expected_instance_id: str
    ) -> dict[str, Any]:
        self._require_fence(expected_instance_id)
        if not SAFE_HANDLE.fullmatch(handle):
            raise FenceError("provider handle is invalid")
        with self.lock:
            job = self.jobs.get(handle) or self.tombstones.get(handle)
            if not job:
                raise FenceError("provider handle was not found")
            if job["instanceId"] != expected_instance_id:
                raise FenceError("execution belongs to another provider instance")
            if job["generation"] != generation:
                raise FenceError("provider generation mismatch")
            return json.loads(json.dumps(job))

    def status(
        self, handle: str, generation: int, expected_instance_id: str
    ) -> dict[str, Any]:
        job = self._get_job(handle, generation, expected_instance_id)
        if job["state"] in ACTIVE_STATES and job.get("containerId"):
            self.tick(handle)
            job = self._get_job(handle, generation, expected_instance_id)
        return {
            "state": job["state"],
            "progress": job["progress"],
            "message": job["message"],
            **({"error": job["error"]} if job.get("error") else {}),
        }

    def cancel(
        self, handle: str, generation: int, expected_instance_id: str
    ) -> dict[str, bool]:
        try:
            job = self._get_job(handle, generation, expected_instance_id)
        except FenceError as exc:
            if "generation mismatch" in str(exc):
                return {"accepted": False}
            raise
        if job["state"] in {"succeeded", "failed"}:
            return {"accepted": False}
        if job["state"] == "cancelled":
            return {"accepted": True}
        with self.lock:
            current = self.jobs.get(handle)
            if not current or current["state"] in {"succeeded", "failed"}:
                return {"accepted": False}
            if current["state"] == "cancelled":
                return {"accepted": True}
            current.update(
                cancelRequested=True,
                message="cancellation requested for exact OCI generation",
                updatedAt=utc_now(),
            )
            self._persist_locked()
        # Persist first so staging/create/start observes cancellation. Converge
        # synchronously only when no operation is in flight; otherwise return
        # accepted promptly and let that operation/monitor honor the durable flag.
        operation_lock = self._operation_lock(handle)
        if operation_lock.acquire(blocking=False):
            try:
                self._tick_once(handle)
            finally:
                operation_lock.release()
        else:
            self._ensure_monitor(handle)
        return {"accepted": True}

    def collect_outputs(
        self, handle: str, generation: int, expected_instance_id: str
    ) -> list[dict[str, Any]]:
        job = self._get_job(handle, generation, expected_instance_id)
        if job.get("receiptExpired"):
            raise ExecutorError("provider-local output receipt retention has expired")
        if job["state"] != "succeeded":
            raise ExecutorError(f"outputs are unavailable while state is {job['state']}")
        return [
            {key: value for key, value in output.items() if key != "_path"}
            for output in job["outputs"]
        ]

    def open_output(
        self,
        handle: str,
        generation: int,
        reference: str,
        expected_instance_id: str,
    ) -> Iterator[bytes]:
        job = self._get_job(handle, generation, expected_instance_id)
        if job["state"] != "succeeded":
            raise ExecutorError("output is not available")
        matches = [output for output in job["outputs"] if output["reference"] == reference]
        if len(matches) != 1:
            raise ExecutorError("output reference was not found")
        receipt = matches[0]
        path = Path(receipt["_path"])
        size, checksum = _digest_file(path)
        if size != receipt["size"] or checksum != receipt["sha256"]:
            raise ExecutorError("output bytes differ from their immutable receipt")

        def stream() -> Iterator[bytes]:
            with path.open("rb") as source:
                while chunk := source.read(1024 * 1024):
                    yield chunk

        return stream()

    def open_http_output(
        self,
        handle: str,
        reference: str,
        expected_instance_id: str,
    ) -> tuple[dict[str, Any], Iterator[bytes]]:
        """Resolve one same-origin HTTP output without trusting URL generation data."""
        self._require_fence(expected_instance_id)
        if not SAFE_HANDLE.fullmatch(handle):
            raise FenceError("provider handle is invalid")
        with self.lock:
            job = self.jobs.get(handle)
            if not job or job["instanceId"] != expected_instance_id:
                raise FenceError("output belongs to another provider instance")
            generation = int(job["generation"])
        receipts = self.collect_outputs(handle, generation, expected_instance_id)
        matching = [receipt for receipt in receipts if receipt["reference"] == reference]
        if len(matching) != 1:
            raise ExecutorError("output reference was not found")
        return matching[0], self.open_output(
            handle, generation, reference, expected_instance_id
        )

    def reconcile(self, expected_instance_id: str) -> None:
        self._require_engine_fence(expected_instance_id)
        with self.lock:
            handles = [
                handle
                for handle, job in self.jobs.items()
                if job["instanceId"] == expected_instance_id and job["state"] in ACTIVE_STATES
            ]
        failures = 0
        for handle in handles:
            try:
                self._reconcile_handle(handle)
            except ExecutorError:
                failures += 1
        if failures:
            raise ExecutorError(
                f"startup reconciliation retained {failures} unconverged execution(s)"
            )

    def _reconcile_handle(self, handle: str) -> None:
        with self._operation_lock(handle):
            with self.lock:
                job = self.jobs[handle]
                container_id = job.get("containerId")
                name = job["containerName"]
                labels = self._expected_labels(job)
                job_instance_id = str(job["instanceId"])
                cancel_requested = bool(job.get("cancelRequested"))
                submission = json.loads(json.dumps(job["submission"]))
            self._require_internal_job_instance(job_instance_id)
            if not container_id:
                recovered = self.engine.lookup(name)
                if recovered is not None:
                    self._assert_container_identity(recovered, name, labels)
                    with self.lock:
                        self.jobs[handle]["containerId"] = recovered.id
                        self.jobs[handle]["updatedAt"] = utc_now()
                        self._persist_locked()
                elif cancel_requested:
                    self._transition(
                        handle,
                        "cancelled",
                        None,
                        "startup reconciliation proved no OCI allocation",
                        None,
                    )
                    return
                else:
                    input_dir, control_dir, _ = self._job_paths(handle)
                    if input_dir.is_dir() and control_dir.is_dir():
                        # Signed references are intentionally gone, but the
                        # fully flushed immutable staging set is sufficient.
                        self._provision(handle, submission, [])
                    else:
                        self._transition(
                            handle,
                            "failed",
                            None,
                            "startup occurred before immutable input staging completed",
                            "staging_interrupted_before_durable_boundary",
                        )
                        return
            self._tick_once(handle)
            self._ensure_monitor(handle)

    def close(self) -> None:
        self.stop_event.set()
        current = threading.current_thread()
        workers = list(self.monitors.values())
        if self.startup_reconcile_thread is not None:
            workers.append(self.startup_reconcile_thread)
        for worker in workers:
            if worker is not current and worker.is_alive():
                worker.join(timeout=max(1.0, self.config.poll_interval_seconds * 4))
        if any(worker is not current and worker.is_alive() for worker in workers):
            # A still-running worker may touch durable state. Retain the owner
            # lease until process teardown rather than permit a second writer.
            return
        self._release_state_owner_lock()
