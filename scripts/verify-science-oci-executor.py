#!/usr/bin/env python3
"""Deterministic adversarial verifier for the Science OCI executor core.

No real container is launched here.  The fake engine proves command policy,
idempotency, exact identity/generation fencing, staged-input integrity, bounded
output receipts, cancellation, timeout, and crash-response recovery.  A live
rootless engine lane is still a separate release gate.
"""

from __future__ import annotations

import hashlib
import http.client
import io
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Mapping


sys.dont_write_bytecode = True
REPOSITORY = Path(__file__).resolve().parents[1]
MODULE_PATH = REPOSITORY / "services" / "science-oci-executor" / "executor.py"
SPEC = importlib.util.spec_from_file_location("science_oci_executor", MODULE_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("could not load Science OCI executor")
oci = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = oci
sys.modules["executor"] = oci
SPEC.loader.exec_module(oci)
SERVER_PATH = REPOSITORY / "services" / "science-oci-executor" / "server.py"
SERVER_SPEC = importlib.util.spec_from_file_location("science_oci_server", SERVER_PATH)
if SERVER_SPEC is None or SERVER_SPEC.loader is None:
    raise RuntimeError("could not load Science OCI HTTP server")
oci_server = importlib.util.module_from_spec(SERVER_SPEC)
sys.modules[SERVER_SPEC.name] = oci_server
SERVER_SPEC.loader.exec_module(oci_server)

DIGEST = "sha256:" + "a" * 64
IMAGE = "registry.invalid/science/notebook@" + DIGEST
ORIGIN = "https://artifacts.invalid"
INPUT_BYTES = b"immutable notebook input\n"
INPUT_SHA = hashlib.sha256(INPUT_BYTES).hexdigest()


class VerificationFailure(RuntimeError):
    pass


def require(condition: bool, detail: str) -> None:
    if not condition:
        raise VerificationFailure(detail)


class FakeFetcher:
    def __init__(self) -> None:
        self.requests: list[str] = []

    def fetch(
        self,
        url: str,
        destination: Path,
        expected_size: int,
        should_cancel=None,  # noqa: ANN001
    ) -> None:
        if should_cancel and should_cancel():
            raise oci.CancellationError("fake staging cancelled")
        self.requests.append(url)
        require(expected_size == len(INPUT_BYTES), "fake received an unexpected input size")
        destination.write_bytes(INPUT_BYTES)


class BlockingFetcher(FakeFetcher):
    def __init__(self) -> None:
        super().__init__()
        self.entered = threading.Event()
        self.release = threading.Event()

    def fetch(
        self,
        url: str,
        destination: Path,
        expected_size: int,
        should_cancel=None,  # noqa: ANN001
    ) -> None:
        self.entered.set()
        deadline = time.monotonic() + 5
        while not self.release.wait(0.01):
            if should_cancel and should_cancel():
                raise oci.CancellationError("blocking fake staging cancelled")
            require(time.monotonic() < deadline, "blocking fetch release timed out")
        super().fetch(url, destination, expected_size, should_cancel)


class SelectiveBlockingFetcher(FakeFetcher):
    def __init__(self) -> None:
        super().__init__()
        self.entered = threading.Event()
        self.release = threading.Event()

    def fetch(
        self,
        url: str,
        destination: Path,
        expected_size: int,
        should_cancel=None,  # noqa: ANN001
    ) -> None:
        if "signature=slow" in url:
            self.entered.set()
            deadline = time.monotonic() + 5
            while not self.release.wait(0.01):
                if should_cancel and should_cancel():
                    raise oci.CancellationError("selective fake staging cancelled")
                require(time.monotonic() < deadline, "selective fetch release timed out")
        super().fetch(url, destination, expected_size, should_cancel)


class FakeEngine:
    def __init__(self, endpoint: str, *, rootless: bool = True) -> None:
        self.endpoint = endpoint
        self.rootless = rootless
        self.engine_id = "fake-rootless-engine-1"
        self.containers: dict[str, Any] = {}
        self.names: dict[str, str] = {}
        self.specs: list[Any] = []
        self.started: list[str] = []
        self.killed: list[str] = []
        self.removed: list[str] = []
        self.verified: list[str] = []
        self.inspect_calls = 0
        self.raise_after_create = False
        self.output_data: dict[str, dict[str, bytes]] = {}
        self.probe_calls = 0
        self.probe_entered: threading.Event | None = None
        self.probe_release: threading.Event | None = None
        self.start_entered: threading.Event | None = None
        self.start_release: threading.Event | None = None
        self.raise_after_start = False
        self.fail_start_before_effect = False
        self.raise_after_remove = False
        self.transient_inspect_ids: set[str] = set()
        self.transient_inspect_failures: dict[str, int] = {}
        self.create_entered: threading.Event | None = None
        self.create_release: threading.Event | None = None
        self.engine_id_after_create: str | None = None

    def probe(self):
        self.probe_calls += 1
        if self.probe_entered is not None:
            self.probe_entered.set()
        if self.probe_release is not None:
            require(self.probe_release.wait(5), "fake probe release timed out")
        return oci.EngineProbe(
            kind="docker",
            endpoint=self.endpoint,
            engine_id=self.engine_id,
            rootless=self.rootless,
        )

    def lookup(self, name: str):
        identifier = self.names.get(name)
        return self.containers.get(identifier) if identifier else None

    def create(self, spec):
        self.specs.append(spec)
        if self.create_entered is not None:
            self.create_entered.set()
        if self.create_release is not None:
            require(self.create_release.wait(5), "fake create release timed out")
        identifier = hashlib.sha256(spec.name.encode("utf-8")).hexdigest()
        container = oci.EngineContainer(
            id=identifier,
            name=spec.name,
            labels=dict(spec.labels),
            state="created",
            exit_code=None,
        )
        self.containers[identifier] = container
        self.names[spec.name] = identifier
        self.output_data[identifier] = {}
        if self.engine_id_after_create is not None:
            self.engine_id = self.engine_id_after_create
            self.engine_id_after_create = None
        if self.raise_after_create:
            self.raise_after_create = False
            raise oci.ExecutorError("simulated lost create response")
        return container

    def start(self, container_id: str, _timeout_seconds: int) -> None:
        if self.start_entered is not None:
            self.start_entered.set()
        if self.start_release is not None:
            require(self.start_release.wait(5), "fake start release timed out")
        if self.fail_start_before_effect:
            self.fail_start_before_effect = False
            raise oci.ExecutorError("simulated pre-effect start failure")
        container = self.containers[container_id]
        self.started.append(container_id)
        self.containers[container_id] = replace(container, state="running")
        if self.raise_after_start:
            self.raise_after_start = False
            raise oci.ExecutorError("simulated lost start response")

    def verify_isolation(self, container_id: str, spec) -> None:
        container = self.containers[container_id]
        require(container.name == spec.name, "fake isolation inspected the wrong container")
        require(spec.uid != 0 and spec.gid != 0, "fake admitted a root container user")
        require(spec.resources["gpuCount"] == 0, "fake admitted an unisolated GPU")
        require(set(spec.labels.items()).issubset(set(container.labels.items())), "fake labels drifted")
        self.verified.append(container_id)

    def export_outputs(self, container_id: str, destination: Path) -> None:
        destination.mkdir(parents=False, exist_ok=False)
        for relative, payload in self.output_data.get(container_id, {}).items():
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(payload)

    def write_output(self, container_id: str, relative: str, payload: bytes) -> None:
        self.output_data[container_id][relative] = payload

    def inspect(self, container_id: str):
        self.inspect_calls += 1
        remaining = self.transient_inspect_failures.get(container_id, 0)
        if remaining > 0:
            self.transient_inspect_failures[container_id] = remaining - 1
            raise oci.ExecutorError("simulated one-shot transient inspect failure")
        if container_id in self.transient_inspect_ids:
            raise oci.ExecutorError("simulated transient inspect failure")
        return self.containers.get(container_id)

    def kill(self, container_id: str) -> None:
        container = self.containers.get(container_id)
        if container is None:
            return
        self.killed.append(container_id)
        self.containers[container_id] = replace(
            container, state="exited", exit_code=137
        )

    def remove(self, container_id: str) -> None:
        container = self.containers.pop(container_id, None)
        if container is None:
            return
        self.removed.append(container_id)
        self.names.pop(container.name, None)
        if self.raise_after_remove:
            self.raise_after_remove = False
            raise oci.ExecutorError("simulated lost remove response")

    def complete(self, container_id: str, exit_code: int = 0) -> None:
        container = self.containers[container_id]
        self.containers[container_id] = replace(
            container, state="exited", exit_code=exit_code
        )

    def inject_name_collision(self, name: str) -> str:
        identifier = "b" * 64
        self.containers[identifier] = oci.EngineContainer(
            id=identifier,
            name=name,
            labels={"io.puppetmaster.science.handle": "run-" + "f" * 32},
            state="created",
            exit_code=None,
        )
        self.names[name] = identifier
        return identifier


def config(root: Path, *, admitted: bool = True):
    root.mkdir(parents=True, exist_ok=True)
    endpoint = "unix:///run/user/1000/puppetmaster-science/docker.sock"
    seccomp_profile = root / "seccomp.json"
    if not seccomp_profile.exists():
        seccomp_profile.write_text(
            json.dumps({"defaultAction": "SCMP_ACT_ERRNO", "syscalls": []}),
            encoding="utf-8",
        )
    return oci.OciExecutorConfig(
        state_dir=root,
        engine_kind="docker",
        engine_binary=(root / "bin" / "docker").resolve(),
        engine_endpoint=endpoint,
        expected_engine_id="fake-rootless-engine-1",
        image_map={DIGEST: IMAGE},
        allowed_kernels=frozenset({"python-notebook-v1"}),
        allowed_input_origins=frozenset({ORIGIN}),
        admitted=admitted,
        engine_boundary="dedicated-rootless",
        seccomp_profile=seccomp_profile.resolve(),
        seccomp_sha256=hashlib.sha256(seccomp_profile.read_bytes()).hexdigest(),
        limits=oci.ResourceLimits(
            cpu_millicores=2000,
            memory_mb=2048,
            gpu_count=0,
            wall_time_seconds=60,
            pids=64,
        ),
        max_input_bytes=1024 * 1024,
        max_output_file_bytes=1024 * 1024,
        max_output_total_bytes=2 * 1024 * 1024,
    )


def submission(key: str, *, url_suffix: str = "one", generation: int = 1):
    expires = datetime.now(timezone.utc) + timedelta(minutes=10)
    return {
        "runId": "science-run-1",
        "missionId": "science-mission-1",
        "generation": generation,
        "idempotencyKey": key,
        "submittedAt": datetime.now(timezone.utc)
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z"),
        "imageDigest": DIGEST,
        "kernel": "python-notebook-v1",
        "parameters": {"units": {"length": "mm"}, "randomSeeds": {"solver": 42}},
        "resources": {
            "cpuMillicores": 1000,
            "memoryMb": 512,
            "gpuCount": 0,
            "wallTimeSeconds": 30,
        },
        "inputs": [
            {
                "artifactVersionId": "artifact-version-1",
                "role": "notebook",
                "mediaType": "application/x-ipynb+json",
                "sha256": INPUT_SHA,
                "size": len(INPUT_BYTES),
                "reference": {
                    "url": f"{ORIGIN}/api/science/artifacts/input?signature={url_suffix}",
                    "expiresAt": expires.isoformat(timespec="milliseconds").replace(
                        "+00:00", "Z"
                    ),
                    "sha256": INPUT_SHA,
                    "size": len(INPUT_BYTES),
                    "method": "GET",
                },
            }
        ],
    }


def assert_raises(error_type, callback, detail: str) -> Exception:
    try:
        callback()
    except error_type as error:
        return error
    except Exception as error:  # pragma: no cover - diagnostic branch
        raise VerificationFailure(
            f"{detail}: expected {error_type.__name__}, got {type(error).__name__}"
        ) from error
    raise VerificationFailure(f"{detail}: expected {error_type.__name__}")


def wait_until(predicate, detail: str, timeout: float = 5.0) -> None:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(0.01)
    raise VerificationFailure(detail)


def verify_config_and_command(root: Path) -> None:
    cfg = config(root)
    parsed = oci.OciExecutorConfig.from_env(
        {
            "SCIENCE_OCI_STATE_DIR": str(root / "parsed-state"),
            "SCIENCE_OCI_ENGINE": "docker",
            "SCIENCE_OCI_ENGINE_BINARY": str(cfg.engine_binary),
            "SCIENCE_OCI_ENGINE_ENDPOINT": cfg.engine_endpoint,
            "SCIENCE_OCI_EXPECTED_ENGINE_ID": cfg.expected_engine_id,
            "SCIENCE_OCI_SECCOMP_PROFILE": str(cfg.seccomp_profile),
            "SCIENCE_OCI_IMAGE_MAP_JSON": json.dumps({DIGEST: IMAGE}),
            "SCIENCE_OCI_ALLOWED_KERNELS": "python-notebook-v1",
            "SCIENCE_OCI_ALLOWED_INPUT_ORIGINS": ORIGIN,
            "SCIENCE_OCI_ENGINE_BOUNDARY": "dedicated-rootless",
            "SCIENCE_OCI_EXECUTOR_ADMISSION": "approved",
        }
    )
    require(
        parsed.expected_engine_id == cfg.expected_engine_id
        and parsed.seccomp_sha256 == cfg.seccomp_sha256
        and parsed.admitted,
        "strict environment configuration lost endpoint/profile admission pins",
    )
    assert_raises(
        oci.AdmissionError,
        lambda: oci.OciExecutorConfig.from_env(
            {
                "SCIENCE_OCI_STATE_DIR": str(root),
                "SCIENCE_OCI_ENGINE": "docker",
                "SCIENCE_OCI_ENGINE_BINARY": str(cfg.engine_binary),
                "SCIENCE_OCI_ENGINE_ENDPOINT": "unix:///var/run/docker.sock",
                "SCIENCE_OCI_EXPECTED_ENGINE_ID": "fake-rootless-engine-1",
                "SCIENCE_OCI_SECCOMP_PROFILE": str(cfg.seccomp_profile),
                "SCIENCE_OCI_IMAGE_MAP_JSON": json.dumps({DIGEST: IMAGE}),
                "SCIENCE_OCI_ALLOWED_KERNELS": "python-notebook-v1",
                "SCIENCE_OCI_ALLOWED_INPUT_ORIGINS": ORIGIN,
            }
        ),
        "default host Docker socket was admitted",
    )
    assert_raises(
        oci.AdmissionError,
        lambda: oci._validate_dedicated_endpoint(
            "unix:///var/run/../run/docker.sock"
        ),
        "lexical alias of the default host Docker socket was admitted",
    )
    assert_raises(
        oci.AdmissionError,
        lambda: oci._validate_dedicated_endpoint(
            "npipe:////./pipe/private/../docker_engine"
        ),
        "named-pipe alias of the default host Docker endpoint was admitted",
    )
    require(
        oci._validate_dedicated_endpoint(
            "unix:///run/user/1000/../1000/puppetmaster-science/docker.sock"
        )
        == "unix:///run/user/1000/puppetmaster-science/docker.sock",
        "non-default Unix endpoint was not canonicalized",
    )
    permissive_profile = root / "permissive-seccomp.json"
    permissive_profile.write_text(
        json.dumps({"defaultAction": "SCMP_ACT_ALLOW", "syscalls": []}),
        encoding="utf-8",
    )
    permissive_cfg = replace(
        cfg,
        state_dir=root / "permissive-state",
        seccomp_profile=permissive_profile.resolve(),
        seccomp_sha256=hashlib.sha256(permissive_profile.read_bytes()).hexdigest(),
    )
    assert_raises(
        oci.AdmissionError,
        lambda: oci.OciExecutor(
            permissive_cfg,
            FakeEngine(permissive_cfg.engine_endpoint),
            fetcher=FakeFetcher(),
            auto_monitor=False,
        ),
        "initial syscall-permissive seccomp policy was admitted",
    )
    engine = oci.DockerCliEngine(cfg)
    spec = oci.ContainerSpec(
        name="pm-science-command-check-g1",
        image_reference=IMAGE,
        labels={"io.puppetmaster.science.generation": "1"},
        input_dir=root / "job" / "input",
        control_dir=root / "job" / "control",
        output_dir=root / "job" / "output",
        resources={"cpuMillicores": 1000, "memoryMb": 512},
        uid=65532,
        gid=65532,
        pids=64,
        max_output_bytes=2 * 1024 * 1024,
    )
    command = engine.build_create_command(spec)
    joined = "\n".join(command)
    pairs = list(zip(command, command[1:]))
    require(("--network", "none") in pairs, "network=none is missing")
    require("--read-only" in command, "read-only root filesystem is missing")
    require(("--cap-drop", "ALL") in pairs, "cap-drop ALL is missing")
    require(
        ("--security-opt", "no-new-privileges=true") in pairs,
        "no-new-privileges is missing",
    )
    require(
        ("--security-opt", f"seccomp={cfg.seccomp_profile}") in pairs,
        "explicit seccomp is missing",
    )
    require(("--log-driver", "none") in pairs, "engine log retention was not disabled")
    require(("--pids-limit", "64") in pairs, "PID limit is missing")
    require(("--cpus", "1") in pairs, "CPU limit is missing")
    require(("--memory", "512m") in pairs, "memory limit is missing")
    require(("--memory-swap", "512m") in pairs, "swap ceiling is missing")
    require(("--user", "65532:65532") in pairs, "non-root user is missing")
    require(command[-1] == IMAGE and "@sha256:" in command[-1], "image is not digest-pinned")
    require("--privileged" not in command, "privileged mode was enabled")
    mount_values = [right for left, right in pairs if left == "--mount"]
    require(
        all("docker.sock" not in value and "podman.sock" not in value for value in mount_values),
        "engine socket leaked into container mounts",
    )
    require("signature=" not in joined, "signed reference leaked into engine argv")
    require(
        sum(1 for item in command if item == "--mount") == 2,
        "executor must expose only read-only input and control bind mounts",
    )
    require(
        any("/science/output:" in item and "noexec" in item for item in command),
        "bounded output tmpfs is missing",
    )


def verify_engine_adapter_counterexamples(root: Path) -> None:
    cfg = config(root)

    def completed(code: int, stdout: bytes = b"", stderr: bytes = b""):
        return subprocess.CompletedProcess([], code, stdout=stdout, stderr=stderr)

    absent = oci.DockerCliEngine(cfg)
    absent_responses = iter([completed(1), completed(0, b"")])
    absent._run = lambda *_args, **_kwargs: next(absent_responses)  # type: ignore[method-assign]
    require(absent.inspect("missing-container") is None, "independent absence proof was rejected")

    transient = oci.DockerCliEngine(cfg)
    transient_calls = 0

    def transient_run(*_args, **_kwargs):
        nonlocal transient_calls
        transient_calls += 1
        if transient_calls == 1:
            return completed(1)
        raise oci.ExecutorError("simulated engine list transport failure")

    transient._run = transient_run  # type: ignore[method-assign]
    assert_raises(
        oci.ExecutorError,
        lambda: transient.inspect("ambiguous-container"),
        "transient inspect failure was collapsed into not-found",
    )

    present = oci.DockerCliEngine(cfg)
    listing = json.dumps({"ID": "c" * 64, "Names": "still-there"}).encode() + b"\n"
    present_responses = iter([completed(1), completed(0, listing)])
    present._run = lambda *_args, **_kwargs: next(present_responses)  # type: ignore[method-assign]
    assert_raises(
        oci.ExecutorError,
        lambda: present.inspect("still-there"),
        "failed inspect hid a container proved present by the second query",
    )

    spec = oci.ContainerSpec(
        name="pm-science-isolation-check-g1",
        image_reference=IMAGE,
        labels={"io.puppetmaster.science.generation": "1"},
        input_dir=(root / "isolation" / "input").resolve(),
        control_dir=(root / "isolation" / "control").resolve(),
        output_dir=(root / "isolation" / "output").resolve(),
        resources={"cpuMillicores": 1000, "memoryMb": 512},
        uid=65532,
        gid=65532,
        pids=64,
        max_output_bytes=2 * 1024 * 1024,
    )
    inspect_row = {
        "Config": {"User": "65532:65532", "Image": IMAGE},
        "HostConfig": {
            "NetworkMode": "none",
            "IpcMode": "none",
            "PidMode": "private",
            "UTSMode": "private",
            "ReadonlyRootfs": True,
            "Privileged": False,
            "CapDrop": ["ALL"],
            "SecurityOpt": [
                "no-new-privileges:true",
                f"seccomp={cfg.seccomp_profile}",
            ],
            "PidsLimit": 64,
            "Memory": 512 * 1024 * 1024,
            "MemorySwap": 512 * 1024 * 1024,
            "NanoCpus": 1_000_000_000,
            "Devices": [],
            "DeviceRequests": [],
            "DeviceCgroupRules": [],
            "LogConfig": {"Type": "none", "Config": {}},
            "Tmpfs": {
                "/tmp": "rw,noexec,nosuid,nodev,size=64m,uid=65532,gid=65532,mode=0700",
                "/run": "rw,noexec,nosuid,nodev,size=16m,uid=65532,gid=65532,mode=0700",
                "/science/output": "rw,noexec,nosuid,nodev,size=2097152,uid=65532,gid=65532,mode=0700",
            },
        },
        "Mounts": [
            {"Destination": "/science/input", "Source": str(spec.input_dir), "Type": "bind", "RW": False},
            {"Destination": "/science/control", "Source": str(spec.control_dir), "Type": "bind", "RW": False},
        ],
    }
    isolation = oci.DockerCliEngine(cfg)
    isolation._run = lambda *_args, **_kwargs: completed(0, json.dumps(inspect_row).encode())  # type: ignore[method-assign]
    isolation.verify_isolation("container", spec)
    bad_seccomp = json.loads(json.dumps(inspect_row))
    bad_seccomp["HostConfig"]["SecurityOpt"][1] = "seccomp=unconfined"
    isolation._run = lambda *_args, **_kwargs: completed(0, json.dumps(bad_seccomp).encode())  # type: ignore[method-assign]
    assert_raises(
        oci.AdmissionError,
        lambda: isolation.verify_isolation("container", spec),
        "unconfined seccomp passed post-create inspection",
    )
    bad_logs = json.loads(json.dumps(inspect_row))
    bad_logs["HostConfig"]["LogConfig"] = {"Type": "json-file", "Config": {}}
    isolation._run = lambda *_args, **_kwargs: completed(0, json.dumps(bad_logs).encode())  # type: ignore[method-assign]
    assert_raises(
        oci.AdmissionError,
        lambda: isolation.verify_isolation("container", spec),
        "persistent engine logging passed post-create inspection",
    )
    bad_cap_add = json.loads(json.dumps(inspect_row))
    bad_cap_add["HostConfig"]["CapAdd"] = ["SYS_ADMIN"]
    isolation._run = lambda *_args, **_kwargs: completed(0, json.dumps(bad_cap_add).encode())  # type: ignore[method-assign]
    assert_raises(
        oci.AdmissionError,
        lambda: isolation.verify_isolation("container", spec),
        "added capability passed post-create isolation inspection",
    )
    bad_tmpfs = json.loads(json.dumps(inspect_row))
    bad_tmpfs["HostConfig"]["Tmpfs"]["/science/output"] += ",exec"
    isolation._run = lambda *_args, **_kwargs: completed(0, json.dumps(bad_tmpfs).encode())  # type: ignore[method-assign]
    assert_raises(
        oci.AdmissionError,
        lambda: isolation.verify_isolation("container", spec),
        "tmpfs option override passed post-create inspection",
    )

    class FakeProcess:
        def __init__(self, stdout: bytes = b"", stderr: bytes = b"", *, timeout_once: bool = False):
            self.stdout = io.BytesIO(stdout)
            self.stderr = io.BytesIO(stderr)
            self.timeout_once = timeout_once
            self.wait_calls = 0
            self.returncode = 0

        def wait(self, timeout=None):  # noqa: ANN001
            self.wait_calls += 1
            if self.timeout_once and self.wait_calls == 1:
                raise subprocess.TimeoutExpired("engine", timeout)
            return self.returncode

        def kill(self) -> None:
            self.returncode = -9

    original_popen = oci.subprocess.Popen
    ambient = {
        "HTTP_PROXY": os.environ.get("HTTP_PROXY"),
        "DOCKER_CONFIG": os.environ.get("DOCKER_CONFIG"),
        "PODMAN_CONNECTIONS_CONF": os.environ.get("PODMAN_CONNECTIONS_CONF"),
    }
    try:
        os.environ["HTTP_PROXY"] = "http://proxy.invalid"
        os.environ["DOCKER_CONFIG"] = "secret-config"
        os.environ["PODMAN_CONNECTIONS_CONF"] = "secret-connections"
        captured: dict[str, Any] = {}

        def capture_popen(*_args, **kwargs):
            captured.update(kwargs)
            return FakeProcess()

        oci.subprocess.Popen = capture_popen
        oci.DockerCliEngine(cfg)._run(["version"])
        engine_env = captured["env"]
        require(
            "HTTP_PROXY" not in engine_env
            and "DOCKER_CONFIG" not in engine_env
            and "PODMAN_CONNECTIONS_CONF" not in engine_env,
            "engine subprocess inherited ambient proxy/context configuration",
        )
        oci.subprocess.Popen = lambda *_args, **_kwargs: FakeProcess(timeout_once=True)
        assert_raises(
            oci.ExecutorError,
            lambda: oci.DockerCliEngine(cfg)._run(["info"]),
            "subprocess timeout escaped provider error normalization",
        )
        oci.subprocess.Popen = lambda *_args, **_kwargs: (_ for _ in ()).throw(
            OSError("unavailable")
        )
        assert_raises(
            oci.ExecutorError,
            lambda: oci.DockerCliEngine(cfg)._run(["info"]),
            "subprocess OSError escaped provider error normalization",
        )
        oci.subprocess.Popen = lambda *_args, **_kwargs: FakeProcess(
            stdout=b"x" * (256 * 1024 + 1)
        )
        assert_raises(
            oci.ExecutorError,
            lambda: oci.DockerCliEngine(cfg)._run(["info"]),
            "engine output flood bypassed the in-flight capture bound",
        )
    finally:
        oci.subprocess.Popen = original_popen
        for key, value in ambient.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    invalid_create = oci.DockerCliEngine(cfg)
    invalid_create._run = lambda *_args, **_kwargs: completed(0, b"\xff")  # type: ignore[method-assign]
    assert_raises(
        oci.ExecutorError,
        lambda: invalid_create.create(spec),
        "non-ASCII engine identity escaped provider error normalization",
    )

    cfg.seccomp_profile.write_text('{"defaultAction":"SCMP_ACT_ALLOW"}', encoding="utf-8")
    assert_raises(
        oci.AdmissionError,
        lambda: oci.DockerCliEngine(cfg).build_create_command(spec),
        "mutable seccomp profile drift was accepted",
    )


def verify_state_ownership_quota_and_sweep(root: Path) -> None:
    owner_cfg = config(root / "owner")
    jobs_dir = owner_cfg.state_dir / "jobs"
    jobs_dir.mkdir(exist_ok=True)
    orphan_handle = "run-" + "a" * 32
    orphan_stage = jobs_dir / f".{orphan_handle}-{'b' * 16}"
    orphan_stage.mkdir()
    orphan_file = orphan_stage / "partial.bin"
    orphan_file.write_bytes(b"abandoned staging bytes")
    os.chmod(orphan_file, 0o400)
    os.chmod(orphan_stage, 0o500)
    metadata_temp = owner_cfg.state_dir / ".ledger-123-abcdef12"
    metadata_temp.write_bytes(b"partial ledger")
    sentinel = jobs_dir / ".operator-sentinel"
    sentinel.write_text("keep", encoding="utf-8")

    owner = oci.OciExecutor(
        owner_cfg, FakeEngine(owner_cfg.engine_endpoint), fetcher=FakeFetcher(), auto_monitor=False
    )
    require(
        not orphan_stage.exists() and not metadata_temp.exists() and sentinel.is_file(),
        "startup sweep did not remove only exact crash-temporary names",
    )
    assert_raises(
        oci.AdmissionError,
        lambda: oci.OciExecutor(
            owner_cfg,
            FakeEngine(owner_cfg.engine_endpoint),
            fetcher=FakeFetcher(),
            auto_monitor=False,
        ),
        "second state-directory writer acquired the executor ledger",
    )
    owner.close()
    successor = oci.OciExecutor(
        owner_cfg, FakeEngine(owner_cfg.engine_endpoint), fetcher=FakeFetcher(), auto_monitor=False
    )
    successor.close()

    base_quota_cfg = config(root / "quota")
    one_reservation = (
        len(INPUT_BYTES)
        + base_quota_cfg.max_output_total_bytes
        + oci.JOB_STATE_RESERVATION_BYTES
    )
    quota_cfg = replace(
        base_quota_cfg,
        max_state_bytes=oci.STATE_FIXED_RESERVATION_BYTES + one_reservation,
    )
    quota_engine = FakeEngine(quota_cfg.engine_endpoint)
    quota = oci.OciExecutor(
        quota_cfg, quota_engine, fetcher=FakeFetcher(), auto_monitor=False
    )
    quota_instance = quota.admit()
    quota.submit(submission("state-quota-one"), quota_instance)
    error = assert_raises(
        oci.ExecutorError,
        lambda: quota.submit(submission("state-quota-two"), quota_instance),
        "aggregate durable-state reservation admitted a second over-quota job",
    )
    require("state quota" in str(error), "state quota refusal was not explicit")
    quota.close()


def verify_lifecycle(root: Path) -> None:
    cfg = config(root)
    engine = FakeEngine(cfg.engine_endpoint)
    fetcher = FakeFetcher()
    executor = oci.OciExecutor(cfg, engine, fetcher=fetcher, auto_monitor=False)
    instance = executor.admit()
    health = executor.health()
    require(
        health["executionMode"] == "isolated_oci"
        and health["executesUserCode"] is True
        and health["instanceId"] == instance,
        "admitted health contract is incorrect",
    )
    first = submission("stable-key", url_suffix="secret-one")
    handle = executor.submit(first, instance)["handle"]
    require(
        len(engine.specs) == 1 and len(engine.started) == 1 and len(engine.verified) == 1,
        "first submit did not create and verify exactly once",
    )
    ledger_text = executor.ledger_path.read_text("utf-8")
    require("secret-one" not in ledger_text, "signed input URL persisted in the ledger")
    require("stable-key" not in ledger_text, "raw idempotency key persisted in the ledger")
    spec_text = (engine.specs[0].control_dir / "submission.json").read_text("utf-8")
    require("signature=" not in spec_text and "https://" not in spec_text, "capability leaked into execution spec")
    require(INPUT_SHA in spec_text, "execution spec omitted immutable input receipt")
    staged = next(engine.specs[0].input_dir.iterdir())
    require(staged.read_bytes() == INPUT_BYTES, "staged input bytes changed")

    replay = submission("stable-key", url_suffix="secret-refreshed")
    replay["submittedAt"] = first["submittedAt"]
    replay["inputs"][0]["reference"]["expiresAt"] = first["inputs"][0]["reference"]["expiresAt"]
    require(executor.submit(replay, instance)["handle"] == handle, "replay changed handle")
    require(len(engine.specs) == 1 and len(engine.started) == 1, "replay duplicated execution")

    executor.close()
    restarted = oci.OciExecutor(cfg, engine, fetcher=fetcher, auto_monitor=False)
    require(restarted.admit() == instance, "restart changed provider instance")
    require(restarted.submit(replay, instance)["handle"] == handle, "restart replay changed handle")
    require(len(engine.specs) == 1 and len(engine.started) == 1, "restart replay duplicated compute")

    result_bytes = b'{"temperature":293.15,"unit":"K"}\n'
    container_id = engine.started[0]
    engine.write_output(container_id, "result.json", result_bytes)
    engine.complete(container_id, 0)
    status = restarted.status(handle, 1, instance)
    require(status["state"] == "succeeded", "zero exit did not reach succeeded")
    require(engine.removed == [container_id], "success did not remove the exact container")
    outputs = restarted.collect_outputs(handle, 1, instance)
    require(len(outputs) == 1, "output receipt count is incorrect")
    require(outputs[0]["sha256"] == hashlib.sha256(result_bytes).hexdigest(), "output checksum is wrong")
    require(outputs[0]["size"] == len(result_bytes), "output size is wrong")
    require(b"".join(restarted.open_output(handle, 1, outputs[0]["reference"], instance)) == result_bytes, "output stream changed bytes")
    require(restarted.cancel(handle, 2, instance) == {"accepted": False}, "stale generation cancelled execution")

    changed = submission("stable-key", url_suffix="secret-refreshed")
    changed["submittedAt"] = first["submittedAt"]
    changed["inputs"][0]["reference"]["expiresAt"] = first["inputs"][0]["reference"]["expiresAt"]
    changed["parameters"] = {"units": {"length": "m"}, "randomSeeds": {"solver": 42}}
    assert_raises(
        oci.ConflictError,
        lambda: restarted.submit(changed, instance),
        "semantic idempotency conflict was accepted",
    )
    restarted.close()


def verify_cancel_timeout_recovery(root: Path) -> None:
    cfg = config(root)
    engine = FakeEngine(cfg.engine_endpoint)
    fetcher = FakeFetcher()
    executor = oci.OciExecutor(cfg, engine, fetcher=fetcher, auto_monitor=False)
    instance = executor.admit()

    cancel_input = submission("cancel-key")
    cancel_handle = executor.submit(cancel_input, instance)["handle"]
    cancel_id = executor.jobs[cancel_handle]["containerId"]
    require(executor.cancel(cancel_handle, 1, instance) == {"accepted": True}, "cancel was refused")
    require(cancel_id in engine.killed and cancel_id in engine.removed, "cancel did not kill/remove exact container")
    require(executor.status(cancel_handle, 1, instance)["state"] == "cancelled", "cancel did not converge")

    timeout_input = submission("timeout-key")
    timeout_handle = executor.submit(timeout_input, instance)["handle"]
    timeout_id = executor.jobs[timeout_handle]["containerId"]
    with executor.lock:
        executor.jobs[timeout_handle]["startedAt"] = "2000-01-01T00:00:00.000Z"
        executor._persist_locked()
    executor.tick(timeout_handle)
    require(timeout_id in engine.killed and timeout_id in engine.removed, "wall timeout did not clean exact container")
    require(executor.status(timeout_handle, 1, instance)["state"] == "failed", "wall timeout did not fail")

    engine.raise_after_create = True
    lost_input = submission("lost-create-key")
    lost_handle = executor.submit(lost_input, instance)["handle"]
    require(executor.status(lost_handle, 1, instance)["state"] == "running", "lost create response was not recovered")
    matching_specs = [spec for spec in engine.specs if spec.name == executor.jobs[lost_handle]["containerName"]]
    require(len(matching_specs) == 1, "lost create response created a duplicate")

    collision_input = submission("collision-key")
    collision_key_hash = hashlib.sha256(b"collision-key").hexdigest()
    collision_handle = "run-" + hashlib.sha256(
        (instance + "\0" + collision_key_hash).encode("ascii")
    ).hexdigest()[:32]
    collision_name = executor._container_name(collision_handle, 1)
    foreign_id = engine.inject_name_collision(collision_name)
    assert_raises(
        oci.FenceError,
        lambda: executor.submit(collision_input, instance),
        "foreign same-name container passed identity fencing",
    )
    require(foreign_id in engine.containers, "executor touched a foreign same-name container")

    inspect_before = engine.inspect_calls
    engine.engine_id = "replacement-rootless-engine-2"
    assert_raises(
        oci.AdmissionError,
        lambda: executor.status(lost_handle, 1, instance),
        "unpinned engine replacement passed admission",
    )
    require(engine.inspect_calls == inspect_before, "engine drift touched an old execution")
    with executor.health_condition:
        executor.health_cache = None
    replacement_health = executor.health()
    require(replacement_health["ok"] is False, "unpinned replacement engine was admitted")
    executor.close()


def verify_start_cancel_crash_convergence(root: Path) -> None:
    drift_cfg = config(root / "create-drift")
    drift_engine = FakeEngine(drift_cfg.engine_endpoint)
    drift_executor = oci.OciExecutor(
        drift_cfg, drift_engine, fetcher=FakeFetcher(), auto_monitor=False
    )
    drift_instance = drift_executor.admit()
    drift_engine.engine_id_after_create = "replacement-during-create"
    assert_raises(
        oci.AdmissionError,
        lambda: drift_executor.submit(
            submission("create-drift"), drift_instance
        ),
        "engine replacement during create passed the pinned boundary",
    )
    drift_handle = next(iter(drift_executor.jobs))
    drift_container = drift_executor.jobs[drift_handle]["containerId"]
    require(
        drift_container in drift_engine.containers
        and drift_executor.jobs[drift_handle]["state"] == "provisioning"
        and not drift_engine.killed
        and not drift_engine.removed,
        "drift cleanup touched the replacement or lost the orphan-safe allocation record",
    )
    drift_executor.close()

    lost_cfg = config(root / "lost-start")
    lost_engine = FakeEngine(lost_cfg.engine_endpoint)
    lost_engine.raise_after_start = True
    lost = oci.OciExecutor(
        lost_cfg, lost_engine, fetcher=FakeFetcher(), auto_monitor=False
    )
    lost_instance = lost.admit()
    lost_handle = lost.submit(submission("lost-start"), lost_instance)["handle"]
    lost_job = lost.jobs[lost_handle]
    require(
        lost_job["state"] == "running"
        and lost_job["startRequestedAt"]
        and lost_job["startedAt"] == lost_job["startRequestedAt"],
        "lost start response bypassed the durable wall-time boundary",
    )
    with lost.lock:
        lost.jobs[lost_handle]["startedAt"] = "2000-01-01T00:00:00.000Z"
        lost._persist_locked()
    lost.tick(lost_handle)
    require(
        lost.jobs[lost_handle]["state"] == "failed"
        and lost.jobs[lost_handle]["error"] == "wall_time_exceeded",
        "lost-start recovery did not retain wall-time enforcement",
    )
    lost.close()

    restart_cfg = config(root / "startup-reconcile")
    restart_engine = FakeEngine(restart_cfg.engine_endpoint)
    restart_engine.fail_start_before_effect = True
    before = oci.OciExecutor(
        restart_cfg, restart_engine, fetcher=FakeFetcher(), auto_monitor=False
    )
    restart_instance = before.admit()
    assert_raises(
        oci.ExecutorError,
        lambda: before.submit(submission("created-before-restart"), restart_instance),
        "pre-effect start failure did not remain recoverable",
    )
    restart_handle = next(iter(before.jobs))
    require(
        before.jobs[restart_handle]["state"] == "provisioning"
        and before.jobs[restart_handle]["containerId"],
        "created container was not durably recoverable",
    )
    restart_engine.transient_inspect_failures[
        before.jobs[restart_handle]["containerId"]
    ] = 1
    before.close()
    restarted = oci.OciExecutor(
        restart_cfg, restart_engine, fetcher=FakeFetcher(), auto_monitor=True
    )
    require(restarted.admit() == restart_instance, "restart changed pinned provider instance")
    wait_until(
        lambda: restarted.jobs[restart_handle]["state"] == "running",
        "autonomous startup reconciliation did not retry and start a verified created container",
    )
    require(
        restarted.jobs[restart_handle]["startRequestedAt"],
        "startup reconciliation omitted the durable start boundary",
    )
    wait_until(
        lambda: restart_instance in restarted.reconciled_instances,
        "startup reconciliation changed job state before publishing readiness",
    )
    restarted.cancel(restart_handle, 1, restart_instance)
    restarted.close()

    parallel_cfg = config(root / "parallel-staging")
    parallel_engine = FakeEngine(parallel_cfg.engine_endpoint)
    selective_fetcher = SelectiveBlockingFetcher()
    parallel = oci.OciExecutor(
        parallel_cfg,
        parallel_engine,
        fetcher=selective_fetcher,
        auto_monitor=False,
    )
    parallel_instance = parallel.admit()
    slow_results: list[dict[str, str]] = []
    slow_errors: list[Exception] = []
    slow_submission = submission("parallel-slow", url_suffix="slow")

    def submit_slow() -> None:
        try:
            slow_results.append(
                parallel.submit(
                    json.loads(json.dumps(slow_submission)), parallel_instance
                )
            )
        except Exception as error:  # noqa: BLE001
            slow_errors.append(error)

    slow_worker = threading.Thread(target=submit_slow)
    slow_worker.start()
    require(selective_fetcher.entered.wait(5), "slow staging did not enter its fetch")
    replay_started = time.monotonic()
    replay_result = parallel.submit(
        json.loads(json.dumps(slow_submission)), parallel_instance
    )
    require(
        time.monotonic() - replay_started < 1.0 and replay_result["handle"],
        "active same-handle idempotent replay waited behind staging",
    )
    fast_started = time.monotonic()
    fast_result = parallel.submit(
        submission("parallel-fast", url_suffix="fast"), parallel_instance
    )
    require(
        time.monotonic() - fast_started < 1.0 and fast_result["handle"],
        "one network staging operation retained the global submit lock",
    )
    selective_fetcher.release.set()
    slow_worker.join(5)
    require(
        not slow_worker.is_alive() and not slow_errors and len(slow_results) == 1,
        "parallel staging submissions did not converge",
    )
    require(
        replay_result["handle"] == slow_results[0]["handle"],
        "active idempotent replay returned a different durable handle",
    )
    parallel.close()

    queued_cfg = config(root / "queued-cancel")
    queued_engine = FakeEngine(queued_cfg.engine_endpoint)
    blocking_fetcher = BlockingFetcher()
    queued = oci.OciExecutor(
        queued_cfg, queued_engine, fetcher=blocking_fetcher, auto_monitor=False
    )
    queued_instance = queued.admit()
    submit_errors: list[Exception] = []

    def submit_queued() -> None:
        try:
            queued.submit(submission("queued-cancel"), queued_instance)
        except Exception as error:  # noqa: BLE001
            submit_errors.append(error)

    submit_thread = threading.Thread(target=submit_queued)
    submit_thread.start()
    require(blocking_fetcher.entered.wait(5), "queued submit did not enter staging")
    queued_handle = next(iter(queued.jobs))
    cancel_result: list[dict[str, bool]] = []
    cancel_thread = threading.Thread(
        target=lambda: cancel_result.append(
            queued.cancel(queued_handle, 1, queued_instance)
        )
    )
    cancel_thread.start()
    wait_until(
        lambda: queued.jobs[queued_handle]["cancelRequested"] is True,
        "queued cancellation was not durably visible during staging",
    )
    cancel_thread.join(1)
    require(
        not cancel_thread.is_alive() and cancel_result == [{"accepted": True}],
        "queued cancellation waited behind network staging",
    )
    submit_thread.join(5)
    require(not submit_thread.is_alive() and not cancel_thread.is_alive(), "queued cancel deadlocked")
    require(not submit_errors and cancel_result == [{"accepted": True}], "queued cancel failed")
    require(
        queued.jobs[queued_handle]["state"] == "cancelled" and not queued_engine.specs,
        "queued cancellation allowed an OCI allocation",
    )
    queued.close()

    provisioning_cfg = config(root / "provisioning-cancel")
    provisioning_engine = FakeEngine(provisioning_cfg.engine_endpoint)
    provisioning_engine.create_entered = threading.Event()
    provisioning_engine.create_release = threading.Event()
    provisioning = oci.OciExecutor(
        provisioning_cfg,
        provisioning_engine,
        fetcher=FakeFetcher(),
        auto_monitor=False,
    )
    provisioning_instance = provisioning.admit()
    provisioning_errors: list[Exception] = []

    def submit_provisioning() -> None:
        try:
            provisioning.submit(
                submission("provisioning-cancel"), provisioning_instance
            )
        except Exception as error:  # noqa: BLE001
            provisioning_errors.append(error)

    provisioning_submit = threading.Thread(target=submit_provisioning)
    provisioning_submit.start()
    require(
        provisioning_engine.create_entered.wait(5),
        "submit did not enter provisioning create",
    )
    provisioning_handle = next(iter(provisioning.jobs))
    provisioning_cancel_result: list[dict[str, bool]] = []
    provisioning_cancel = threading.Thread(
        target=lambda: provisioning_cancel_result.append(
            provisioning.cancel(
                provisioning_handle, 1, provisioning_instance
            )
        )
    )
    provisioning_cancel.start()
    wait_until(
        lambda: provisioning.jobs[provisioning_handle]["cancelRequested"] is True,
        "provisioning cancellation was not durably visible during create",
    )
    provisioning_cancel.join(1)
    require(
        not provisioning_cancel.is_alive()
        and provisioning_cancel_result == [{"accepted": True}],
        "provisioning cancellation waited behind an in-flight create",
    )
    provisioning_engine.create_release.set()
    provisioning_submit.join(5)
    provisioning_cancel.join(5)
    require(not provisioning_errors, "provisioning cancellation surfaced submit failure")
    require(
        provisioning_cancel_result == [{"accepted": True}]
        and provisioning.jobs[provisioning_handle]["state"] == "cancelled"
        and not provisioning_engine.started
        and len(provisioning_engine.removed) == 1,
        "provisioning cancellation did not remove the unstarted exact allocation",
    )
    provisioning.close()

    start_cfg = config(root / "inflight-start-cancel")
    start_engine = FakeEngine(start_cfg.engine_endpoint)
    start_engine.start_entered = threading.Event()
    start_engine.start_release = threading.Event()
    inflight = oci.OciExecutor(
        start_cfg, start_engine, fetcher=FakeFetcher(), auto_monitor=False
    )
    inflight_instance = inflight.admit()
    inflight_errors: list[Exception] = []

    def submit_inflight() -> None:
        try:
            inflight.submit(submission("inflight-start-cancel"), inflight_instance)
        except Exception as error:  # noqa: BLE001
            inflight_errors.append(error)

    inflight_submit = threading.Thread(target=submit_inflight)
    inflight_submit.start()
    require(start_engine.start_entered.wait(5), "submit did not reach in-flight start")
    inflight_handle = next(iter(inflight.jobs))
    require(
        inflight.jobs[inflight_handle]["startRequestedAt"],
        "start call began before its durable boundary",
    )
    inflight_cancel_result: list[dict[str, bool]] = []
    inflight_cancel = threading.Thread(
        target=lambda: inflight_cancel_result.append(
            inflight.cancel(inflight_handle, 1, inflight_instance)
        )
    )
    inflight_cancel.start()
    wait_until(
        lambda: inflight.jobs[inflight_handle]["cancelRequested"] is True,
        "in-flight cancellation was not persisted",
    )
    inflight_cancel.join(1)
    require(
        not inflight_cancel.is_alive()
        and inflight_cancel_result == [{"accepted": True}],
        "cancellation waited behind an in-flight OCI start",
    )
    start_engine.start_release.set()
    inflight_submit.join(5)
    inflight_cancel.join(5)
    require(not inflight_errors, "in-flight start cancellation surfaced a submit error")
    require(inflight_cancel_result == [{"accepted": True}], "in-flight cancel was refused")
    require(
        inflight.jobs[inflight_handle]["state"] == "cancelled"
        and len(start_engine.started) == 1
        and start_engine.removed == start_engine.started,
        "in-flight start cancellation did not converge on the exact container",
    )
    inflight.close()

    crash_cfg = config(root / "terminal-crash")
    crash_engine = FakeEngine(crash_cfg.engine_endpoint)
    crash = oci.OciExecutor(
        crash_cfg, crash_engine, fetcher=FakeFetcher(), auto_monitor=False
    )
    crash_instance = crash.admit()
    crash_handle = crash.submit(submission("terminal-crash"), crash_instance)["handle"]
    crash_id = crash.jobs[crash_handle]["containerId"]
    crash_engine.write_output(crash_id, "result.json", b'{"durable":true}\n')
    crash_engine.complete(crash_id, 0)
    crash_engine.raise_after_remove = True
    assert_raises(
        oci.ExecutorError,
        lambda: crash.tick(crash_handle),
        "lost remove response falsely committed terminal state",
    )
    require(
        crash.jobs[crash_handle]["state"] == "running"
        and crash.jobs[crash_handle]["terminalIntent"]
        and crash_id not in crash_engine.containers,
        "terminal receipt/removal crash boundary was not durable",
    )
    crash.close()
    crash_restarted = oci.OciExecutor(
        crash_cfg, crash_engine, fetcher=FakeFetcher(), auto_monitor=False
    )
    crash_restarted.admit()
    require(
        crash_restarted.status(crash_handle, 1, crash_instance)["state"] == "succeeded",
        "restart did not commit durable receipts after exact absence proof",
    )
    crash_restarted.close()

    transient_cfg = config(root / "transient-status")
    transient_engine = FakeEngine(transient_cfg.engine_endpoint)
    transient_executor = oci.OciExecutor(
        transient_cfg, transient_engine, fetcher=FakeFetcher(), auto_monitor=False
    )
    transient_instance = transient_executor.admit()
    transient_handle = transient_executor.submit(
        submission("transient-status"), transient_instance
    )["handle"]
    transient_id = transient_executor.jobs[transient_handle]["containerId"]
    transient_engine.transient_inspect_ids.add(transient_id)
    assert_raises(
        oci.ExecutorError,
        lambda: transient_executor.status(transient_handle, 1, transient_instance),
        "transient inspect failure was converted to terminal absence",
    )
    require(
        transient_executor.jobs[transient_handle]["state"] == "running",
        "transient inspect failure terminalized live compute",
    )
    transient_executor.close()


def verify_fail_closed_health(root: Path) -> None:
    cfg = config(root, admitted=False)
    engine = FakeEngine(cfg.engine_endpoint)
    executor = oci.OciExecutor(cfg, engine, fetcher=FakeFetcher(), auto_monitor=False)
    health = executor.health()
    require(health["ok"] is False and health["executesUserCode"] is False, "unapproved health admitted execution")
    assert_raises(
        oci.AdmissionError,
        lambda: executor.submit(submission("not-admitted"), "science-oci-" + "0" * 32),
        "unapproved executor accepted submit",
    )
    executor.close()
    rootless_cfg = config(root / "rootless-false")
    rootless_engine = FakeEngine(rootless_cfg.engine_endpoint, rootless=False)
    rootless_executor = oci.OciExecutor(
        rootless_cfg, rootless_engine, fetcher=FakeFetcher(), auto_monitor=False
    )
    require(rootless_executor.health()["ok"] is False, "rootful engine was admitted")
    rootless_executor.close()


def verify_health_retention_and_endpoint_policy(root: Path) -> None:
    health_cfg = config(root / "health")
    health_engine = FakeEngine(health_cfg.engine_endpoint)
    health_engine.probe_entered = threading.Event()
    health_engine.probe_release = threading.Event()
    health_executor = oci.OciExecutor(
        health_cfg, health_engine, fetcher=FakeFetcher(), auto_monitor=False
    )
    results: list[dict[str, Any]] = []
    errors: list[Exception] = []

    def probe_health() -> None:
        try:
            results.append(health_executor.health())
        except Exception as error:  # noqa: BLE001
            errors.append(error)

    workers = [threading.Thread(target=probe_health) for _ in range(8)]
    for worker in workers:
        worker.start()
    require(health_engine.probe_entered.wait(5), "health probe did not enter fake engine")
    time.sleep(0.05)
    health_engine.probe_release.set()
    for worker in workers:
        worker.join(5)
    require(not errors and len(results) == 8, "concurrent health calls did not converge")
    require(
        health_engine.probe_calls == 2 and all(result["ok"] for result in results),
        "health amplification bypassed single-flight admission",
    )
    health_executor.health()
    require(health_engine.probe_calls == 2, "health TTL cache did not bound engine probes")
    health_executor.close()

    readiness_cfg = config(root / "readiness")
    readiness_engine = FakeEngine(readiness_cfg.engine_endpoint)
    readiness = oci.OciExecutor(
        readiness_cfg,
        readiness_engine,
        fetcher=FakeFetcher(),
        auto_monitor=True,
    )
    reconcile_entered = threading.Event()
    reconcile_release = threading.Event()
    original_prune = readiness._prune_terminal_receipts
    prune_attempts = 0

    def flaky_prune() -> None:
        nonlocal prune_attempts
        prune_attempts += 1
        if prune_attempts == 1:
            reconcile_entered.set()
            require(reconcile_release.wait(5), "readiness release timed out")
            raise OSError("simulated transient state-volume failure")
        original_prune()

    readiness._prune_terminal_receipts = flaky_prune  # type: ignore[method-assign]
    pending = readiness.health()
    require(reconcile_entered.wait(5), "startup reconciliation did not begin")
    require(
        pending["ok"] is False and pending["executesUserCode"] is False,
        "health admitted execution before first successful startup reconciliation",
    )
    reconcile_release.set()
    wait_until(
        lambda: readiness.health()["ok"] is True,
        "startup reconciliation did not retry a raw operational failure",
    )
    require(prune_attempts >= 2, "raw startup failure was not retried")
    readiness.close()

    assert_raises(
        oci.AdmissionError,
        lambda: oci_server._server_config(
            {"SCIENCE_OCI_RUNTIME_TOKEN": "x" * 31 + "é"}
        ),
        "non-ASCII bearer token was admitted",
    )
    fetcher = oci.ScopedHttpInputFetcher(frozenset({ORIGIN}))
    proxy_handlers = [
        handler
        for handler in fetcher.opener.handlers
        if isinstance(handler, oci.ProxyHandler)
    ]
    require(
        not proxy_handlers,
        "input fetcher inherited ambient proxy configuration",
    )

    retention_cfg = replace(
        config(root / "retention"),
        terminal_retention_seconds=1,
        max_tombstones=64,
    )
    retention_engine = FakeEngine(retention_cfg.engine_endpoint)
    retention = oci.OciExecutor(
        retention_cfg, retention_engine, fetcher=FakeFetcher(), auto_monitor=False
    )
    retention_instance = retention.admit()
    retained_submission = submission("retention-key")
    retained_handle = retention.submit(retained_submission, retention_instance)["handle"]
    retention.cancel(retained_handle, 1, retention_instance)
    retained_root = retention._job_paths(retained_handle)[0].parent
    with retention.lock:
        retention.jobs[retained_handle]["finishedAt"] = "2000-01-01T00:00:00.000Z"
        retention._persist_locked()
    retention._prune_terminal_receipts()
    require(
        retained_handle not in retention.jobs
        and retained_handle in retention.tombstones
        and not retained_root.exists(),
        "expired terminal receipt did not converge to a bounded durable tombstone",
    )
    require(
        retention.status(retained_handle, 1, retention_instance)["state"] == "cancelled",
        "retained tombstone lost terminal status fencing",
    )
    require(
        retention.submit(retained_submission, retention_instance)["handle"] == retained_handle,
        "same semantic replay bypassed the retained tombstone",
    )
    conflicting = json.loads(json.dumps(retained_submission))
    conflicting["parameters"] = {"changed": True}
    assert_raises(
        oci.ConflictError,
        lambda: retention.submit(conflicting, retention_instance),
        "tombstoned idempotency key accepted semantic drift",
    )
    retention.close()

    rotation_cfg = replace(config(root / "rotation"), max_concurrency=1)
    rotation_engine = FakeEngine(rotation_cfg.engine_endpoint)
    old_executor = oci.OciExecutor(
        rotation_cfg, rotation_engine, fetcher=FakeFetcher(), auto_monitor=False
    )
    old_instance = old_executor.admit()
    old_handle = old_executor.submit(submission("old-instance-active"), old_instance)["handle"]
    old_id = old_executor.jobs[old_handle]["containerId"]
    rotation_engine.engine_id = "fake-rootless-engine-2"
    old_executor.close()
    replacement_cfg = replace(
        rotation_cfg, expected_engine_id="fake-rootless-engine-2"
    )
    replacement = oci.OciExecutor(
        replacement_cfg, rotation_engine, fetcher=FakeFetcher(), auto_monitor=False
    )
    replacement_instance = replacement.admit()
    require(replacement_instance != old_instance, "pinned engine replacement reused old fence")
    quote = replacement.quote(submission("rotation-quote")["resources"])
    require(quote["available"] is True, "old-instance active row exhausted replacement quota")
    replacement_handle = replacement.submit(
        submission("replacement-instance-active"), replacement_instance
    )["handle"]
    require(
        replacement_handle != old_handle
        and old_id in rotation_engine.containers
        and old_handle not in replacement.jobs
        and replacement.tombstones[old_handle]["instanceId"] == old_instance
        and replacement.tombstones[old_handle]["state"] == "orphaned"
        and replacement.tombstones[old_handle]["retainedExternalOrphan"] is True,
        "replacement touched or collided with old-instance execution",
    )
    replacement.close()
    replacement_restarted = oci.OciExecutor(
        replacement_cfg,
        rotation_engine,
        fetcher=FakeFetcher(),
        auto_monitor=False,
    )
    require(
        replacement_restarted.admit() == replacement_instance,
        "retained old-instance reservation prevented a safe executor restart",
    )
    replacement_restarted.close()


def verify_http_contract(root: Path) -> None:
    cfg = config(root)
    engine = FakeEngine(cfg.engine_endpoint)
    executor = oci.OciExecutor(cfg, engine, fetcher=FakeFetcher(), auto_monitor=False)
    token = "http-verifier-token-" + "x" * 48
    runtime = oci_server.RuntimeServer(("127.0.0.1", 0), executor, token)
    worker = threading.Thread(target=runtime.serve_forever, daemon=True)
    worker.start()
    port = int(runtime.server_address[1])

    def request(
        method: str,
        path: str,
        body: Any | None = None,
        *,
        auth: bool = True,
        fence: str | None = None,
        key: str | None = None,
    ) -> tuple[int, Mapping[str, str], bytes]:
        payload = None if body is None else json.dumps(body, separators=(",", ":")).encode()
        headers: dict[str, str] = {}
        if auth:
            headers["Authorization"] = "Bearer " + token
        if fence:
            headers["X-Science-Provider-Instance"] = fence
        if key:
            headers["Idempotency-Key"] = key
        if payload is not None:
            headers["Content-Type"] = "application/json"
            headers["Content-Length"] = str(len(payload))
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        try:
            connection.request(method, path, body=payload, headers=headers)
            response = connection.getresponse()
            data = response.read(2 * 1024 * 1024)
            return response.status, dict(response.getheaders()), data
        finally:
            connection.close()

    try:
        oversized = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        try:
            oversized.putrequest("GET", "/health")
            oversized.putheader("X-Oversized", "x" * (oci_server.MAX_HEADER_BYTES + 1))
            oversized.endheaders()
            oversized_response = oversized.getresponse()
            oversized_response.read()
            require(
                oversized_response.status == 431,
                "oversized HTTP headers were not rejected before handler work",
            )
        finally:
            oversized.close()
        require(
            0 < oci_server.HEADER_TIMEOUT_SECONDS <= 30
            and 0 < oci_server.BODY_TIMEOUT_SECONDS <= 60
            and 0 < oci_server.WRITE_TIMEOUT_SECONDS <= 60
            and oci_server.MAX_INFLIGHT_REQUESTS <= 64,
            "HTTP read/write/concurrency bounds are not release-bounded",
        )
        status, _, raw = request("GET", "/health", auth=False)
        health = json.loads(raw)
        require(status == 200 and health["executionMode"] == "isolated_oci", "HTTP health is incompatible")
        instance = health["instanceId"]
        status, _, _ = request("POST", "/v1/quote", {"resources": submission("q")["resources"]}, auth=False)
        require(status == 401, "HTTP control route accepted an anonymous request")
        status, _, raw = request(
            "POST", "/v1/quote", {"resources": submission("q")["resources"]}
        )
        require(status == 200 and json.loads(raw)["available"] is True, "HTTP quote failed")
        body = submission("http-key")
        status, _, _ = request("POST", "/v1/runs", body, key="http-key")
        require(status == 409, "HTTP submit accepted a missing instance fence")
        status, _, raw = request(
            "POST", "/v1/runs", body, fence=instance, key="http-key"
        )
        require(status == 201, "HTTP submit failed")
        handle = json.loads(raw)["handle"]
        status, _, raw = request(
            "GET", f"/v1/runs/{handle}?generation=1", fence=instance
        )
        require(status == 200 and json.loads(raw)["state"] == "running", "HTTP status failed")
        payload = b'{"http":true}\n'
        engine.write_output(engine.started[-1], "result.json", payload)
        engine.complete(engine.started[-1], 0)
        status, _, raw = request(
            "GET", f"/v1/runs/{handle}?generation=1", fence=instance
        )
        require(status == 200 and json.loads(raw)["state"] == "succeeded", "HTTP terminal status failed")
        status, _, raw = request(
            "GET", f"/v1/runs/{handle}/outputs?generation=1", fence=instance
        )
        outputs = json.loads(raw)["outputs"]
        require(status == 200 and len(outputs) == 1, "HTTP output listing failed")
        status, headers, raw = request("GET", outputs[0]["reference"], fence=instance)
        require(status == 200 and raw == payload, "HTTP output stream changed bytes")
        require(headers.get("ETag") == f'"sha256:{outputs[0]["sha256"]}"', "HTTP output ETag is wrong")
    finally:
        runtime.shutdown()
        runtime.server_close()
        executor.close()
        worker.join(timeout=5)


def main() -> int:
    with tempfile.TemporaryDirectory(prefix="science-oci-verify-") as temporary:
        root = Path(temporary)
        verify_config_and_command(root / "command")
        verify_engine_adapter_counterexamples(root / "engine-adapter")
        verify_state_ownership_quota_and_sweep(root / "state")
        verify_lifecycle(root / "lifecycle")
        verify_cancel_timeout_recovery(root / "recovery")
        verify_start_cancel_crash_convergence(root / "crash-convergence")
        verify_fail_closed_health(root / "closed")
        verify_health_retention_and_endpoint_policy(root / "policy")
        verify_http_contract(root / "http")
    print(
        "SCIENCE OCI EXECUTOR CANDIDATE PASS: canonical pinned rootless endpoint policy, "
        "exclusive state ownership, restrictive seccomp, secure argv, aggregate state quota, "
        "parallel cancellable staging, idempotency, fencing, fail-closed recovery, bounded "
        "outputs, timeout, tombstones, HTTP bounds, and exact cleanup"
    )
    print("LIVE OCI EXECUTION: NOT PROVEN (no real rootless engine or notebook corpus in this lane)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
