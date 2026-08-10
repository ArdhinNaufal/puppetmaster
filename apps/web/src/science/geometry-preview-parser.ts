export const SCIENCE_GEOMETRY_PREVIEW_MAX_BYTES = 8 * 1024 * 1024;
export const SCIENCE_GEOMETRY_PREVIEW_MAX_POINTS = 5_000;
export const SCIENCE_GEOMETRY_PREVIEW_MAX_EDGES = 10_000;

export type GeometryPoint3 = [number, number, number];
export type GeometryEdge = [number, number];

export interface GeometryPreviewModel {
  format: "VTK" | "STL" | "STEP";
  points: GeometryPoint3[];
  edges: GeometryEdge[];
  bounds: {
    min: GeometryPoint3;
    max: GeometryPoint3;
  };
  topology: string;
  limitations: string[];
}

function finitePoint(values: number[], label: string): GeometryPoint3 {
  if (values.length !== 3 || values.some((value) => !Number.isFinite(value))) {
    throw new Error(`${label} contains a non-finite or incomplete coordinate.`);
  }
  return [values[0]!, values[1]!, values[2]!];
}

function assertBounds(points: number, edges: number) {
  if (points > SCIENCE_GEOMETRY_PREVIEW_MAX_POINTS) {
    throw new Error(
      `Geometry has ${points.toLocaleString()} points; client preview cap is `
      + `${SCIENCE_GEOMETRY_PREVIEW_MAX_POINTS.toLocaleString()}. Use the remote renderer or structured table.`,
    );
  }
  if (edges > SCIENCE_GEOMETRY_PREVIEW_MAX_EDGES) {
    throw new Error(
      `Geometry has more than ${SCIENCE_GEOMETRY_PREVIEW_MAX_EDGES.toLocaleString()} topology edges. `
      + "Use the remote renderer or structured table.",
    );
  }
}

function geometryBounds(points: GeometryPoint3[]): GeometryPreviewModel["bounds"] {
  const min: GeometryPoint3 = [...points[0]!] as GeometryPoint3;
  const max: GeometryPoint3 = [...points[0]!] as GeometryPoint3;
  for (const point of points.slice(1)) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis]!, point[axis]!);
      max[axis] = Math.max(max[axis]!, point[axis]!);
    }
  }
  return { min, max };
}

function parseVtk(text: string): GeometryPreviewModel {
  if (!/^\s*#\s*vtk\s+datafile/i.test(text)) {
    throw new Error("Only legacy ASCII VTK is supported by the bounded client preview.");
  }
  if (/\bBINARY\b/i.test(text.slice(0, 512))) {
    throw new Error("Binary VTK requires the remote renderer.");
  }
  if (!/\bASCII\b/i.test(text.slice(0, 512))) {
    throw new Error("The VTK header does not declare ASCII encoding.");
  }

  const tokens = text.trim().split(/\s+/);
  const pointToken = tokens.findIndex((token) => token.toUpperCase() === "POINTS");
  if (pointToken < 0) throw new Error("VTK preview requires a POINTS section.");
  const pointCount = Number(tokens[pointToken + 1]);
  if (!Number.isSafeInteger(pointCount) || pointCount < 1) {
    throw new Error("VTK POINTS count is invalid.");
  }
  assertBounds(pointCount, 0);

  const pointStart = pointToken + 3;
  const points: GeometryPoint3[] = [];
  for (let index = 0; index < pointCount; index += 1) {
    const offset = pointStart + index * 3;
    points.push(finitePoint(
      [tokens[offset], tokens[offset + 1], tokens[offset + 2]]
        .map((value) => Number(value?.replace(/[dD]/g, "e"))),
      `VTK point ${index}`,
    ));
  }

  const edges: GeometryEdge[] = [];
  const edgeKeys = new Set<string>();
  const addEdge = (from: number, to: number) => {
    if (
      !Number.isSafeInteger(from)
      || !Number.isSafeInteger(to)
      || from < 0
      || to < 0
      || from >= points.length
      || to >= points.length
    ) {
      throw new Error("VTK topology references a point outside the POINTS section.");
    }
    if (from === to) return;
    const key = from < to ? `${from}:${to}` : `${to}:${from}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push([from, to]);
    assertBounds(points.length, edges.length);
  };

  const parseCells = (
    keyword: "LINES" | "POLYGONS" | "TRIANGLE_STRIPS" | "CELLS",
    close: boolean,
  ) => {
    const section = tokens.findIndex((token, index) =>
      index >= pointStart + pointCount * 3 && token.toUpperCase() === keyword);
    if (section < 0) return 0;
    const count = Number(tokens[section + 1]);
    const declaredSize = Number(tokens[section + 2]);
    if (
      !Number.isSafeInteger(count)
      || count < 0
      || count > SCIENCE_GEOMETRY_PREVIEW_MAX_EDGES
      || !Number.isSafeInteger(declaredSize)
      || declaredSize < 0
    ) {
      throw new Error(`VTK ${keyword} declaration is invalid or exceeds the preview cap.`);
    }
    let cursor = section + 3;
    const payloadStart = cursor;
    for (let cell = 0; cell < count; cell += 1) {
      const size = Number(tokens[cursor++]);
      if (!Number.isSafeInteger(size) || size < 1) {
        throw new Error(`VTK ${keyword} cell length is invalid.`);
      }
      const indices = tokens.slice(cursor, cursor + size).map(Number);
      if (indices.length !== size) {
        throw new Error(`VTK ${keyword} section ended before its declared cell data.`);
      }
      cursor += size;
      for (let index = 1; index < indices.length; index += 1) {
        addEdge(indices[index - 1]!, indices[index]!);
      }
      if (close && indices.length > 2) addEdge(indices.at(-1)!, indices[0]!);
    }
    if (cursor - payloadStart !== declaredSize) {
      throw new Error(`VTK ${keyword} payload length does not match its declaration.`);
    }
    return count;
  };

  const lineCount = parseCells("LINES", false);
  const polygonCount = parseCells("POLYGONS", true);
  const stripCount = parseCells("TRIANGLE_STRIPS", false);
  const cellCount = parseCells("CELLS", true);
  return {
    format: "VTK",
    points,
    edges,
    bounds: geometryBounds(points),
    topology:
      `${pointCount} points · ${lineCount} lines · ${polygonCount} polygon loops · `
      + `${stripCount} strips · ${cellCount} generic cells`,
    limitations: [
      "Legacy ASCII VTK only; scalar fields, cell types, normals, transforms, and volume rendering are not evaluated.",
      "Declared topology is shown as wire edges, not as solver-quality or tessellated surfaces.",
      "Generic CELLS are closed as diagnostic loops without interpreting their CELL_TYPES.",
    ],
  };
}

function parseStl(text: string): GeometryPreviewModel {
  if (!/^\s*solid\b/i.test(text) || !/\bfacet\s+normal\b/i.test(text)) {
    throw new Error("Only ASCII STL is supported by the bounded client preview.");
  }
  const vertexPattern =
    /\bvertex\s+([-+0-9.eEdD]+)\s+([-+0-9.eEdD]+)\s+([-+0-9.eEdD]+)/gi;
  const raw: GeometryPoint3[] = [];
  for (const match of text.matchAll(vertexPattern)) {
    raw.push(finitePoint(
      [match[1]!, match[2]!, match[3]!]
        .map((value) => Number(value.replace(/[dD]/g, "e"))),
      `STL vertex ${raw.length}`,
    ));
    assertBounds(raw.length, raw.length);
  }
  if (raw.length < 3) {
    throw new Error("ASCII STL contains no complete facet vertices.");
  }
  const facetCount = Math.floor(raw.length / 3);
  const points = raw.slice(0, facetCount * 3);
  const edges: GeometryEdge[] = [];
  for (let facet = 0; facet < facetCount; facet += 1) {
    const base = facet * 3;
    edges.push([base, base + 1], [base + 1, base + 2], [base + 2, base]);
  }
  assertBounds(points.length, edges.length);
  return {
    format: "STL",
    points,
    edges,
    bounds: geometryBounds(points),
    topology: `${facetCount} declared triangular facets · ${points.length} vertex records`,
    limitations: [
      "ASCII STL only; duplicate vertices are retained and facet normals are not validated.",
      "The preview draws declared triangle wire edges and does not infer watertightness, units, orientation, or solver-quality mesh validity.",
      ...(raw.length % 3 === 0 ? [] : ["Trailing incomplete vertex records were ignored."]),
    ],
  };
}

function parseStep(text: string): GeometryPreviewModel {
  if (!/ISO-10303-21/i.test(text)) {
    throw new Error("STEP preview requires an ISO-10303-21 text exchange file.");
  }
  const cartesian = new Map<string, GeometryPoint3>();
  const pointPattern =
    /#(\d+)\s*=\s*CARTESIAN_POINT\s*\(\s*[^,]*,\s*\(\s*([-+0-9.eEdD]+)\s*,\s*([-+0-9.eEdD]+)\s*,\s*([-+0-9.eEdD]+)\s*\)\s*\)/gi;
  for (const match of text.matchAll(pointPattern)) {
    cartesian.set(match[1]!, finitePoint(
      [match[2]!, match[3]!, match[4]!]
        .map((value) => Number(value.replace(/[dD]/g, "e"))),
      `STEP CARTESIAN_POINT #${match[1]}`,
    ));
    assertBounds(cartesian.size, 0);
  }
  if (cartesian.size === 0) {
    throw new Error("No three-dimensional CARTESIAN_POINT entities were found.");
  }

  const vertexToPoint = new Map<string, string>();
  const vertexPattern =
    /#(\d+)\s*=\s*VERTEX_POINT\s*\(\s*[^,]*,\s*#(\d+)\s*\)/gi;
  for (const match of text.matchAll(vertexPattern)) {
    vertexToPoint.set(match[1]!, match[2]!);
    if (vertexToPoint.size > SCIENCE_GEOMETRY_PREVIEW_MAX_POINTS) {
      throw new Error("STEP vertex references exceed the bounded client preview cap.");
    }
  }

  const ids = [...cartesian.keys()];
  const pointIndex = new Map(ids.map((id, index) => [id, index]));
  const points = ids.map((id) => cartesian.get(id)!);
  const edges: GeometryEdge[] = [];
  const edgePattern =
    /#\d+\s*=\s*EDGE_CURVE\s*\(\s*[^,]*,\s*#(\d+)\s*,\s*#(\d+)/gi;
  for (const match of text.matchAll(edgePattern)) {
    const from = pointIndex.get(vertexToPoint.get(match[1]!) ?? "");
    const to = pointIndex.get(vertexToPoint.get(match[2]!) ?? "");
    if (from !== undefined && to !== undefined && from !== to) edges.push([from, to]);
    assertBounds(points.length, edges.length);
  }
  return {
    format: "STEP",
    points,
    edges,
    bounds: geometryBounds(points),
    topology:
      `${points.length} raw Cartesian points · ${vertexToPoint.size} vertex references · `
      + `${edges.length} resolved edge endpoints`,
    limitations: [
      "This is an entity-level point/topology diagnostic, not a CAD tessellation or geometry kernel.",
      "Curves are straight endpoint links only; surfaces, trims, assemblies, placements, units, tolerances, and transforms are not resolved.",
      "Unreferenced Cartesian points may be construction, axis, or control data. No missing surface is fabricated.",
    ],
  };
}

export function parseGeometryPreview(
  text: string,
  formatHint: string,
): GeometryPreviewModel {
  if (text.includes("\0")) {
    throw new Error("Geometry payload contains binary data; use the remote renderer.");
  }
  const hint = formatHint.trim().toUpperCase();
  if (hint === "VTK" || /^\s*#\s*vtk\s+datafile/i.test(text)) {
    return parseVtk(text);
  }
  if (hint === "STL" || /^\s*solid\b/i.test(text)) {
    return parseStl(text);
  }
  if (
    ["STEP", "STP"].includes(hint)
    || /ISO-10303-21/i.test(text.slice(0, 2048))
  ) {
    return parseStep(text);
  }
  throw new Error(
    "Client preview supports bounded ASCII VTK, ASCII STL, and STEP/STP topology diagnostics.",
  );
}
