#!/usr/bin/env python3
"""Thin bounded HTTP v1 wrapper around the fail-closed OCI executor core."""

from __future__ import annotations

import hmac
import json
import os
import re
import signal
import socket
import sys
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Mapping
from urllib.parse import parse_qs, urlsplit

from executor import (
    AdmissionError,
    ConflictError,
    DockerCliEngine,
    ExecutorError,
    FenceError,
    OciExecutor,
    OciExecutorConfig,
    canonical_json,
    utc_now,
)


MAX_REQUEST_BYTES = 1024 * 1024
MAX_CONTROL_RESPONSE_BYTES = 64 * 1024
MAX_HEADER_BYTES = 16 * 1024
MAX_HEADER_COUNT = 64
HEADER_TIMEOUT_SECONDS = 10
BODY_TIMEOUT_SECONDS = 30
WRITE_TIMEOUT_SECONDS = 30
MAX_INFLIGHT_REQUESTS = 32
class HttpError(Exception):
    def __init__(self, status: int, code: str, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.code = code
        self.detail = detail


def decode_json(raw: bytes) -> Any:
    def exact_pairs(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
        result: dict[str, Any] = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("duplicate JSON key")
            result[key] = value
        return result

    return json.loads(raw, object_pairs_hook=exact_pairs)


class RuntimeServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 64

    def __init__(
        self,
        address: tuple[str, int],
        executor: OciExecutor,
        bearer_token: str,
    ) -> None:
        super().__init__(address, RuntimeHandler)
        self.executor = executor
        self.bearer_token = bearer_token
        self.request_slots = threading.BoundedSemaphore(MAX_INFLIGHT_REQUESTS)

    def process_request(self, request, client_address):  # noqa: ANN001
        if not self.request_slots.acquire(blocking=False):
            try:
                request.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            request.close()
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.request_slots.release()
            raise

    def process_request_thread(self, request, client_address):  # noqa: ANN001
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.request_slots.release()


class RuntimeHandler(BaseHTTPRequestHandler):
    server: RuntimeServer
    protocol_version = "HTTP/1.1"
    server_version = "PuppetmasterScienceOciExecutor"
    sys_version = ""

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(HEADER_TIMEOUT_SECONDS)
        self.deadline_lock = threading.Lock()
        self.deadline_timers: dict[str, threading.Timer] = {}
        self._begin_deadline("headers", HEADER_TIMEOUT_SECONDS)

    def _expire_connection(self) -> None:
        try:
            self.connection.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass

    def _begin_deadline(self, name: str, seconds: int) -> None:
        timer = threading.Timer(seconds, self._expire_connection)
        timer.daemon = True
        with self.deadline_lock:
            previous = self.deadline_timers.pop(name, None)
            if previous is not None:
                previous.cancel()
            self.deadline_timers[name] = timer
        timer.start()

    def _cancel_deadline(self, name: str) -> None:
        with self.deadline_lock:
            timer = self.deadline_timers.pop(name, None)
        if timer is not None:
            timer.cancel()

    def finish(self) -> None:
        with self.deadline_lock:
            timers = list(self.deadline_timers.values())
            self.deadline_timers.clear()
        for timer in timers:
            timer.cancel()
        super().finish()

    def parse_request(self) -> bool:
        try:
            if not super().parse_request():
                return False
            header_items = list(self.headers.raw_items())
            header_bytes = sum(
                len(name.encode("latin-1", errors="replace"))
                + len(value.encode("latin-1", errors="replace"))
                + 4
                for name, value in header_items
            )
            if len(header_items) > MAX_HEADER_COUNT or header_bytes > MAX_HEADER_BYTES:
                self.send_error(HTTPStatus.REQUEST_HEADER_FIELDS_TOO_LARGE)
                self.close_connection = True
                return False
            return True
        finally:
            self._cancel_deadline("headers")

    def log_message(self, _message: str, *_args: Any) -> None:
        # Never log the request target or body. Signed artifact capabilities are
        # body-only but this also protects future query-bearing endpoints.
        sys.stderr.write(
            json.dumps(
                {
                    "time": utc_now(),
                    "event": "science_oci.http_request",
                    "remote": self.client_address[0],
                    "method": self.command,
                },
                separators=(",", ":"),
            )
            + "\n"
        )

    def _headers(self, status: int, content_type: str, length: int) -> None:
        self.close_connection = True
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
            status = HTTPStatus.INTERNAL_SERVER_ERROR
            payload = canonical_json(
                {
                    "error": {
                        "code": "response_too_large",
                        "detail": "control response exceeds 64 KiB",
                    }
                }
            )
        self.connection.settimeout(WRITE_TIMEOUT_SECONDS)
        self._begin_deadline("write", WRITE_TIMEOUT_SECONDS)
        try:
            self._headers(status, "application/json; charset=utf-8", len(payload))
            self.wfile.write(payload)
        finally:
            self._cancel_deadline("write")

    def _error(self, error: HttpError) -> None:
        self._json(
            error.status,
            {"error": {"code": error.code, "detail": error.detail[:4000]}},
        )

    def _authorized(self, path: str) -> bool:
        if path == "/health":
            return True
        values = self.headers.get_all("Authorization", [])
        expected = "Bearer " + self.server.bearer_token
        if (
            len(values) == 1
            and all(ord(character) <= 0x7E for character in values[0])
            and hmac.compare_digest(values[0], expected)
        ):
            return True
        self._json(
            HTTPStatus.UNAUTHORIZED,
            {"error": {"code": "unauthorized", "detail": "valid bearer token required"}},
        )
        return False

    def _instance_fence(self) -> str:
        values = self.headers.get_all("X-Science-Provider-Instance", [])
        if len(values) != 1 or not re.fullmatch(r"science-oci-[0-9a-f]{32}", values[0]):
            raise HttpError(
                HTTPStatus.CONFLICT,
                "provider_instance_mismatch",
                "exactly one valid expected provider instance header is required",
            )
        return values[0]

    def _body(self) -> Any:
        content_type = self.headers.get("Content-Type", "")
        if content_type.split(";", 1)[0].strip().lower() != "application/json":
            raise HttpError(
                HTTPStatus.UNSUPPORTED_MEDIA_TYPE,
                "unsupported_media_type",
                "application/json is required",
            )
        if self.headers.get("Transfer-Encoding") is not None:
            raise HttpError(400, "invalid_framing", "Transfer-Encoding is not accepted")
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) != 1:
            raise HttpError(411, "length_required", "exactly one Content-Length is required")
        try:
            length = int(lengths[0])
        except ValueError as exc:
            raise HttpError(411, "length_required", "valid Content-Length is required") from exc
        if length < 0 or length > MAX_REQUEST_BYTES:
            raise HttpError(413, "payload_too_large", "request body exceeds 1 MiB")
        self.connection.settimeout(BODY_TIMEOUT_SECONDS)
        self._begin_deadline("body", BODY_TIMEOUT_SECONDS)
        try:
            raw = self.rfile.read(length)
        except (TimeoutError, OSError) as exc:
            raise HttpError(408, "request_timeout", "request body exceeded its read deadline") from exc
        finally:
            self._cancel_deadline("body")
        if len(raw) != length:
            raise HttpError(400, "invalid_json", "request body was truncated")
        try:
            return decode_json(raw)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as exc:
            raise HttpError(
                400,
                "invalid_json",
                "request body must be valid JSON without duplicate keys",
            ) from exc

    @staticmethod
    def _generation(query: str) -> int:
        try:
            values = parse_qs(query, strict_parsing=True)
            if set(values) != {"generation"} or len(values["generation"]) != 1:
                raise ValueError
            generation = int(values["generation"][0])
        except (KeyError, TypeError, ValueError) as exc:
            raise HttpError(
                422,
                "invalid_request",
                "exactly one positive generation query parameter is required",
            ) from exc
        if generation < 1 or generation > 2**31 - 1:
            raise HttpError(422, "invalid_request", "generation is outside its bound")
        return generation

    @staticmethod
    def _map_executor_error(error: ExecutorError) -> HttpError:
        if isinstance(error, ConflictError):
            return HttpError(409, "idempotency_conflict", str(error))
        if isinstance(error, FenceError):
            return HttpError(409, "provider_instance_mismatch", str(error))
        if isinstance(error, AdmissionError):
            return HttpError(503, "executor_not_admitted", str(error))
        return HttpError(422, "executor_rejected", str(error))

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlsplit(self.path)
        try:
            if not self._authorized(parsed.path):
                return
            if parsed.path == "/health":
                if parsed.query:
                    raise HttpError(422, "invalid_request", "health does not accept a query")
                health = self.server.executor.health()
                self._json(200 if health["ok"] else 503, health)
                return
            fence = self._instance_fence()
            status_match = re.fullmatch(r"/v1/runs/(run-[0-9a-f]{32})", parsed.path)
            if status_match:
                generation = self._generation(parsed.query)
                self._json(
                    200,
                    self.server.executor.status(status_match.group(1), generation, fence),
                )
                return
            outputs_match = re.fullmatch(
                r"/v1/runs/(run-[0-9a-f]{32})/outputs", parsed.path
            )
            if outputs_match:
                generation = self._generation(parsed.query)
                outputs = self.server.executor.collect_outputs(
                    outputs_match.group(1), generation, fence
                )
                self._json(200, {"outputs": outputs})
                return
            output_match = re.fullmatch(
                r"/v1/outputs/(run-[0-9a-f]{32})/(.{1,3500})", parsed.path
            )
            if output_match:
                if parsed.query:
                    raise HttpError(422, "invalid_request", "output does not accept a query")
                receipt, stream = self.server.executor.open_http_output(
                    output_match.group(1), parsed.path, fence
                )
                self.connection.settimeout(WRITE_TIMEOUT_SECONDS)
                self._begin_deadline("write", WRITE_TIMEOUT_SECONDS)
                try:
                    self.send_response(200)
                    self.send_header("Content-Type", receipt["mediaType"])
                    self.send_header("Content-Length", str(receipt["size"]))
                    self.send_header("ETag", f'"sha256:{receipt["sha256"]}"')
                    self.send_header("Cache-Control", "private, immutable, max-age=31536000")
                    self.send_header("X-Content-Type-Options", "nosniff")
                    self.send_header("Content-Security-Policy", "default-src 'none'")
                    self.send_header("Cross-Origin-Resource-Policy", "same-origin")
                    self.send_header("Connection", "close")
                    self.end_headers()
                    for chunk in stream:
                        self.wfile.write(chunk)
                finally:
                    self._cancel_deadline("write")
                return
            raise HttpError(404, "not_found", "route was not found")
        except HttpError as error:
            self._error(error)
        except ExecutorError as error:
            self._error(self._map_executor_error(error))
        except Exception as error:  # noqa: BLE001
            self.log_message("unhandled GET failure: %s", type(error).__name__)
            self._error(HttpError(500, "internal_error", "internal provider error"))

    def do_POST(self) -> None:  # noqa: N802
        parsed = urlsplit(self.path)
        try:
            if not self._authorized(parsed.path):
                return
            if parsed.query:
                raise HttpError(422, "invalid_request", "query parameters are not allowed")
            if parsed.path == "/v1/quote":
                body = self._body()
                if not isinstance(body, dict) or set(body) != {"resources"}:
                    raise HttpError(422, "invalid_request", "quote requires only resources")
                self._json(200, self.server.executor.quote(body["resources"]))
                return
            fence = self._instance_fence()
            if parsed.path == "/v1/runs":
                body = self._body()
                keys = self.headers.get_all("Idempotency-Key", [])
                if (
                    len(keys) != 1
                    or not isinstance(body, dict)
                    or not isinstance(body.get("idempotencyKey"), str)
                    or any(
                        ord(character) < 0x21 or ord(character) > 0x7E
                        for character in keys[0]
                    )
                    or any(
                        ord(character) < 0x21 or ord(character) > 0x7E
                        for character in body.get("idempotencyKey", "")
                    )
                    or not hmac.compare_digest(keys[0], body["idempotencyKey"])
                ):
                    raise HttpError(
                        422,
                        "idempotency_mismatch",
                        "Idempotency-Key must exactly match submission.idempotencyKey",
                    )
                result = self.server.executor.submit(body, fence)
                self._json(201, result)
                return
            cancel_match = re.fullmatch(
                r"/v1/runs/(run-[0-9a-f]{32})/cancel", parsed.path
            )
            if cancel_match:
                body = self._body()
                if not isinstance(body, dict) or set(body) != {"generation"}:
                    raise HttpError(422, "invalid_request", "cancel requires only generation")
                generation = body["generation"]
                if isinstance(generation, bool) or not isinstance(generation, int):
                    raise HttpError(422, "invalid_request", "generation must be an integer")
                self._json(
                    202,
                    self.server.executor.cancel(cancel_match.group(1), generation, fence),
                )
                return
            raise HttpError(404, "not_found", "route was not found")
        except HttpError as error:
            self._error(error)
        except ExecutorError as error:
            self._error(self._map_executor_error(error))
        except Exception as error:  # noqa: BLE001
            self.log_message("unhandled POST failure: %s", type(error).__name__)
            self._error(HttpError(500, "internal_error", "internal provider error"))


def _server_config(env: Mapping[str, str]) -> tuple[str, int, str]:
    host = str(env.get("SCIENCE_OCI_HOST", "127.0.0.1")).strip()
    try:
        port = int(str(env.get("SCIENCE_OCI_PORT", "8091")))
    except ValueError as exc:
        raise AdmissionError("SCIENCE_OCI_PORT must be an integer") from exc
    if not host or port < 1 or port > 65535:
        raise AdmissionError("SCIENCE_OCI_HOST/PORT is invalid")
    if host not in {"127.0.0.1", "::1", "localhost"} and str(
        env.get("SCIENCE_OCI_TRUSTED_TLS_PROXY", "")
    ).lower() != "approved":
        raise AdmissionError(
            "non-loopback bind requires SCIENCE_OCI_TRUSTED_TLS_PROXY=approved"
        )
    token = str(env.get("SCIENCE_OCI_RUNTIME_TOKEN", ""))
    if len(token) < 32 or len(token) > 4096 or any(
        ord(ch) < 0x21 or ord(ch) > 0x7E for ch in token
    ):
        raise AdmissionError(
            "SCIENCE_OCI_RUNTIME_TOKEN must be 32-4096 printable ASCII characters"
        )
    return host, port, token


def main() -> int:
    os.umask(0o077)
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        raise AdmissionError("the OCI executor daemon must not run as root")
    config = OciExecutorConfig.from_env()
    host, port, token = _server_config(os.environ)
    executor = OciExecutor(config, DockerCliEngine(config))
    server = RuntimeServer((host, port), executor, token)

    def stop(_signum: int, _frame: Any) -> None:
        executor.close()
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    actual_host, actual_port = server.server_address[:2]
    print(
        json.dumps(
            {
                "event": "science_oci.started",
                "host": actual_host,
                "port": actual_port,
                "admitted": executor.health()["ok"],
            },
            separators=(",", ":"),
        ),
        flush=True,
    )
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        executor.close()
        server.server_close()
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AdmissionError as error:
        sys.stderr.write(
            json.dumps(
                {
                    "time": utc_now(),
                    "event": "science_oci.startup_refused",
                    "errorType": type(error).__name__,
                },
                separators=(",", ":"),
            )
            + "\n"
        )
        raise SystemExit(78)
