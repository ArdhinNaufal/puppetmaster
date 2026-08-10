#!/usr/bin/env python3
"""Generate the deterministic, non-regulated Science Operations pilot corpus.

The files are deliberately small enough for repository and browser tests. They
exercise format detection and protocol plumbing; they are not solver-validation
or CAD-fidelity reference assets.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import struct
import sys
from pathlib import Path
from typing import Any


IMAGE_DIGEST = (
    "sha256:1445edcf2ab7a2400b0851810d78bf572ad104afc8518f5cd207d88c528b72d6"
)
CONTROL_ORIGIN = "http://control-plane.invalid"


def canonical_json(value: Any) -> bytes:
    return json.dumps(
        value,
        allow_nan=False,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def npy_float64_2x4(values: list[float]) -> bytes:
    """Encode one fixed-shape little-endian NPY v1 array without NumPy."""

    if len(values) != 8:
        raise ValueError("the fixture array must contain exactly eight values")
    header = "{'descr': '<f8', 'fortran_order': False, 'shape': (2, 4), }"
    padding = 16 - ((10 + len(header) + 1) % 16)
    encoded_header = (header + (" " * padding) + "\n").encode("latin-1")
    return (
        b"\x93NUMPY"
        + bytes((1, 0))
        + struct.pack("<H", len(encoded_header))
        + encoded_header
        + struct.pack("<8d", *values)
    )


def corpus_files() -> dict[str, tuple[bytes, str, str]]:
    csv_bytes = (
        "time_s,temperature_k,pressure_pa\n"
        "0.0,293.15,101325\n"
        "0.5,294.10,101410\n"
        "1.0,295.02,101522\n"
        "1.5,295.80,101601\n"
    ).encode("utf-8")
    csv_sha = hashlib.sha256(csv_bytes).hexdigest()
    csv_size = len(csv_bytes)
    submission = {
        "runId": "00000000-0000-4000-8000-000000000001",
        "missionId": "00000000-0000-4000-8000-000000000002",
        "generation": 1,
        "idempotencyKey": "science-runtime-fixture:1",
        "submittedAt": "2026-01-01T00:00:00.000Z",
        "imageDigest": IMAGE_DIGEST,
        "kernel": "python-fixture-v1",
        "parameters": {
            "fixtureDelayMs": 20,
            "fixtureOutcome": "succeeded",
            "randomSeeds": {"python": 7},
            "units": {"temperature": "K", "pressure": "Pa"},
        },
        "resources": {
            "cpuMillicores": 500,
            "memoryMb": 512,
            "gpuCount": 0,
            "wallTimeSeconds": 30,
        },
        "inputs": [
            {
                "artifactVersionId": "00000000-0000-4000-8000-000000000003",
                "role": "boundary_conditions",
                "mediaType": "text/csv",
                "sha256": csv_sha,
                "size": csv_size,
                "reference": {
                    "url": (
                        f"{CONTROL_ORIGIN}/api/science/artifact-versions/"
                        "00000000-0000-4000-8000-000000000003/content"
                        "?audience=fixture&expires=4070908800&sig="
                        + ("a" * 64)
                    ),
                    "expiresAt": "2099-01-01T00:00:00.000Z",
                    "sha256": csv_sha,
                    "size": csv_size,
                    "method": "GET",
                },
            }
        ],
    }
    expected_result = {
        "contractVersion": "http-contract.v1",
        "runId": submission["runId"],
        "missionId": submission["missionId"],
        "generation": submission["generation"],
        "submittedAt": submission["submittedAt"],
        "imageDigest": IMAGE_DIGEST,
        "inputs": [
            {
                "artifactVersionId": submission["inputs"][0]["artifactVersionId"],
                "mediaType": "text/csv",
                "role": "boundary_conditions",
                "sha256": csv_sha,
                "size": csv_size,
            }
        ],
        "kernel": "python-fixture-v1",
        "parameters": submission["parameters"],
        "resources": submission["resources"],
    }
    notebook = {
        "cells": [
            {
                "cell_type": "markdown",
                "metadata": {},
                "source": [
                    "# Puppetmaster deterministic fixture\n",
                    "Contract corpus only; the bundled runtime does not execute this notebook.",
                ],
            },
            {
                "cell_type": "code",
                "execution_count": None,
                "metadata": {},
                "outputs": [],
                "source": [
                    "SEED = 7\n",
                    "assert SEED == 7\n",
                ],
            },
        ],
        "metadata": {
            "kernelspec": {
                "display_name": "Python 3",
                "language": "python",
                "name": "python3",
            }
        },
        "nbformat": 4,
        "nbformat_minor": 5,
    }
    step = """ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('PUPPETMASTER PREVIEW TETRAHEDRON; NOT A SOLVER MESH'),'2;1');
FILE_NAME('preview-tetrahedron.step','2026-01-01T00:00:00',('Puppetmaster'),('Puppetmaster'),'fixture-generator','fixture-generator','');
FILE_SCHEMA(('CONFIG_CONTROL_DESIGN'));
ENDSEC;
DATA;
#10=CARTESIAN_POINT('',(0.,0.,0.));
#11=CARTESIAN_POINT('',(1.,0.,0.));
#12=CARTESIAN_POINT('',(0.,1.,0.));
#13=CARTESIAN_POINT('',(0.,0.,1.));
#20=POLY_LOOP('',(#10,#12,#11));
#21=POLY_LOOP('',(#10,#11,#13));
#22=POLY_LOOP('',(#11,#12,#13));
#23=POLY_LOOP('',(#12,#10,#13));
#30=FACE_OUTER_BOUND('',#20,.T.);
#31=FACE_OUTER_BOUND('',#21,.T.);
#32=FACE_OUTER_BOUND('',#22,.T.);
#33=FACE_OUTER_BOUND('',#23,.T.);
#40=FACE('',(#30));
#41=FACE('',(#31));
#42=FACE('',(#32));
#43=FACE('',(#33));
#50=CLOSED_SHELL('',(#40,#41,#42,#43));
#60=FACETED_BREP('preview tetrahedron',#50);
ENDSEC;
END-ISO-10303-21;
""".encode("ascii")
    vtk = """# vtk DataFile Version 3.0
Puppetmaster deterministic scalar fixture
ASCII
DATASET STRUCTURED_POINTS
DIMENSIONS 2 2 2
ORIGIN 0 0 0
SPACING 1 1 1
POINT_DATA 8
SCALARS temperature float 1
LOOKUP_TABLE default
293.15
293.80
294.10
294.45
294.80
295.02
295.40
295.80
""".encode("ascii")
    files: dict[str, tuple[bytes, str, str]] = {
        "contract/submission.json": (
            canonical_json(submission),
            "application/json",
            "Valid HttpComputeProvider submission fixture",
        ),
        "contract/expected-result.json": (
            canonical_json(expected_result),
            "application/json",
            "Expected deterministic runtime output bytes",
        ),
        "data/thermal-boundary.csv": (
            csv_bytes,
            "text/csv",
            "Small tabular boundary-condition input",
        ),
        "data/thermal-field.npy": (
            npy_float64_2x4(
                [293.15, 293.80, 294.10, 294.45, 294.80, 295.02, 295.40, 295.80]
            ),
            "application/x-npy",
            "Small dense array input",
        ),
        "geometry/preview-tetrahedron.step": (
            step,
            "model/step",
            "Small STEP syntax/preview fixture; not solver-quality validation geometry",
        ),
        "notebooks/deterministic-pilot.ipynb": (
            canonical_json(notebook),
            "application/x-ipynb+json",
            "Notebook structure fixture; never executed by this runtime",
        ),
        "results/thermal-field.vtk": (
            vtk,
            "model/vnd.vtk",
            "Small legacy ASCII VTK visualization fixture",
        ),
        "malformed/broken.step": (
            b"ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('BROKEN'));\n",
            "model/step",
            "Deliberately truncated STEP upload",
        ),
        "malformed/interrupted-upload.part": (
            b"\x93NUMPY\x01\x00\x76\x00{'descr': '<f8'",
            "application/octet-stream",
            "Deliberately interrupted array upload",
        ),
    }
    return files


def expected_files() -> dict[str, bytes]:
    described = corpus_files()
    payloads = {name: value[0] for name, value in described.items()}
    manifest = {
        "schemaVersion": "puppetmaster-science-corpus.v1",
        "classification": "synthetic-non-regulated",
        "limitations": [
            "No file is evidence of solver accuracy or convergence.",
            "The STEP fixture exercises bounded preview parsing, not CAD fidelity.",
            "The notebook is structure-only; the fixture runtime executes no user code.",
        ],
        "files": [
            {
                "path": name,
                "mediaType": described[name][1],
                "purpose": described[name][2],
                "sha256": hashlib.sha256(payloads[name]).hexdigest(),
                "size": len(payloads[name]),
            }
            for name in sorted(payloads)
        ],
    }
    payloads["manifest.json"] = canonical_json(manifest)
    return payloads


def write_atomic(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with temporary.open("wb") as stream:
        stream.write(payload)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def check(output: Path, files: dict[str, bytes]) -> list[str]:
    failures: list[str] = []
    expected_names = set(files)
    actual_names = {
        path.relative_to(output).as_posix()
        for path in output.rglob("*")
        if path.is_file()
    } if output.exists() else set()
    for missing in sorted(expected_names - actual_names):
        failures.append(f"missing {missing}")
    for unexpected in sorted(actual_names - expected_names):
        failures.append(f"unexpected {unexpected}")
    for name in sorted(expected_names & actual_names):
        if (output / name).read_bytes() != files[name]:
            failures.append(f"content mismatch {name}")
    return failures


def main() -> int:
    repository = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--output",
        type=Path,
        default=repository / "services" / "science-runtime" / "fixtures",
    )
    parser.add_argument("--check", action="store_true")
    arguments = parser.parse_args()
    output = arguments.output.resolve()
    files = expected_files()
    if arguments.check:
        failures = check(output, files)
        if failures:
            for failure in failures:
                print(f"SCIENCE FIXTURE FAIL: {failure}", file=sys.stderr)
            return 1
        print(f"SCIENCE FIXTURES PASS: {len(files)} deterministic files")
        return 0
    for name, payload in files.items():
        write_atomic(output / name, payload)
    print(f"SCIENCE FIXTURES GENERATED: {len(files)} files at {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
