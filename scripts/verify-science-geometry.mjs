#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  SCIENCE_GEOMETRY_PREVIEW_MAX_POINTS,
  parseGeometryPreview,
} from "../apps/web/src/science/geometry-preview-parser.ts";

const vtk = parseGeometryPreview(`# vtk DataFile Version 3.0
bounded triangle
ASCII
DATASET POLYDATA
POINTS 3 float
-1 0 0  2 0 0  0 3 0
POLYGONS 1 4
3 0 1 2
`, "vtk");
assert.equal(vtk.format, "VTK");
assert.deepEqual(vtk.bounds, { min: [-1, 0, 0], max: [2, 3, 0] });
assert.deepEqual(vtk.edges, [[0, 1], [1, 2], [2, 0]]);
assert.match(vtk.topology, /3 points.*1 polygon loop/);

assert.throws(
  () => parseGeometryPreview(`# vtk DataFile Version 3.0
binary
BINARY
DATASET POLYDATA
POINTS 1 float
0 0 0
`, "vtk"),
  /Binary VTK requires the remote renderer/,
);
assert.throws(
  () => parseGeometryPreview(`# vtk DataFile Version 3.0
bad topology
ASCII
DATASET POLYDATA
POINTS 2 float
0 0 0  1 0 0
LINES 1 3
2 0 9
`, "vtk"),
  /outside the POINTS section/,
);

const stl = parseGeometryPreview(`solid triangle
facet normal 0 0 1
  outer loop
    vertex 0 0 0
    vertex 1 0 0
    vertex 0 1 0
  endloop
endfacet
endsolid triangle
`, "stl");
assert.equal(stl.format, "STL");
assert.deepEqual(stl.bounds, { min: [0, 0, 0], max: [1, 1, 0] });
assert.equal(stl.points.length, 3);
assert.equal(stl.edges.length, 3);
assert.match(stl.limitations.join(" "), /does not infer watertightness/);

const step = parseGeometryPreview(`ISO-10303-21;
HEADER;
ENDSEC;
DATA;
#1=CARTESIAN_POINT('',(0.,0.,0.));
#2=CARTESIAN_POINT('',(2.,3.,4.));
#3=VERTEX_POINT('',#1);
#4=VERTEX_POINT('',#2);
#5=EDGE_CURVE('',#3,#4,#6,.T.);
ENDSEC;
END-ISO-10303-21;
`, "step");
assert.equal(step.format, "STEP");
assert.deepEqual(step.bounds, { min: [0, 0, 0], max: [2, 3, 4] });
assert.deepEqual(step.edges, [[0, 1]]);
assert.match(step.limitations[0], /not a CAD tessellation or geometry kernel/);

const tooManyPoints = Array.from(
  { length: SCIENCE_GEOMETRY_PREVIEW_MAX_POINTS + 1 },
  (_, index) => `${index} 0 0`,
).join(" ");
assert.throws(
  () => parseGeometryPreview(`# vtk DataFile Version 3.0
cap
ASCII
DATASET POLYDATA
POINTS ${SCIENCE_GEOMETRY_PREVIEW_MAX_POINTS + 1} float
${tooManyPoints}
`, "vtk"),
  /client preview cap/,
);
assert.throws(
  () => parseGeometryPreview("solid\0binary", "stl"),
  /binary data; use the remote renderer/,
);
assert.throws(
  () => parseGeometryPreview("not geometry", "unknown"),
  /supports bounded ASCII VTK, ASCII STL, and STEP\/STP/,
);

console.log(
  "SCIENCE GEOMETRY PASS: bounded ASCII VTK/STL diagnostics, STEP topology, caps, and explicit fallback",
);
