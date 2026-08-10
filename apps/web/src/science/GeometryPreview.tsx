import { useMemo, useState } from "react";
import type {
  GeometryPoint3,
  GeometryPreviewModel,
} from "./geometry-preview-parser.js";

export type { GeometryPreviewModel } from "./geometry-preview-parser.js";
export {
  SCIENCE_GEOMETRY_PREVIEW_MAX_BYTES,
} from "./geometry-preview-parser.js";

type Projection = "iso" | "xy" | "xz" | "yz";

function project(point: GeometryPoint3, view: Projection): [number, number] {
  if (view === "xy") return [point[0], -point[1]];
  if (view === "xz") return [point[0], -point[2]];
  if (view === "yz") return [point[1], -point[2]];
  return [point[0] - point[2] * 0.58, -point[1] + point[2] * 0.34];
}

function coordinate(value: number): string {
  return Math.abs(value) >= 10_000 || (Math.abs(value) > 0 && Math.abs(value) < 0.001)
    ? value.toExponential(3)
    : Number(value.toPrecision(6)).toString();
}

export function GeometryPreview(props: { model: GeometryPreviewModel }) {
  const [projection, setProjection] = useState<Projection>("iso");
  const drawing = useMemo(() => {
    const projected = props.model.points.map((point) => project(point, projection));
    const xs = projected.map((point) => point[0]);
    const ys = projected.map((point) => point[1]);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const width = Math.max(maxX - minX, Number.EPSILON);
    const height = Math.max(maxY - minY, Number.EPSILON);
    const scale = Math.min(740 / width, 410 / height);
    return projected.map(([x, y]) => [
      400 + (x - (minX + maxX) / 2) * scale,
      230 + (y - (minY + maxY) / 2) * scale,
    ] as [number, number]);
  }, [props.model.points, projection]);

  return (
    <div className="sci-geometry-preview">
      <div className="sci-geometry-toolbar">
        <span>{props.model.format} CLIENT DIAGNOSTIC</span>
        <label>
          PROJECTION
          <select value={projection} onChange={(event) => setProjection(event.target.value as Projection)}>
            <option value="iso">ISOMETRIC</option>
            <option value="xy">XY</option>
            <option value="xz">XZ</option>
            <option value="yz">YZ</option>
          </select>
        </label>
      </div>
      <svg viewBox="0 0 800 460" role="img" aria-label={`${props.model.format} bounded geometry preview. ${props.model.topology}`}>
        <rect width="800" height="460" className="sci-geometry-bg" />
        <g className="sci-geometry-edges">
          {props.model.edges.map(([from, to], index) => (
            <line
              key={`${from}:${to}:${index}`}
              x1={drawing[from]?.[0]}
              y1={drawing[from]?.[1]}
              x2={drawing[to]?.[0]}
              y2={drawing[to]?.[1]}
            />
          ))}
        </g>
        <g className="sci-geometry-points">
          {drawing.map(([x, y], index) => <circle key={index} cx={x} cy={y} r={props.model.edges.length ? 1.25 : 2} />)}
        </g>
      </svg>
      <div className="sci-geometry-readout">
        <b>{props.model.topology}</b>
        <span>
          RAW BOUNDS · X [{coordinate(props.model.bounds.min[0])}, {coordinate(props.model.bounds.max[0])}]
          {" "}Y [{coordinate(props.model.bounds.min[1])}, {coordinate(props.model.bounds.max[1])}]
          {" "}Z [{coordinate(props.model.bounds.min[2])}, {coordinate(props.model.bounds.max[2])}]
        </span>
        <ul>{props.model.limitations.map((limitation) => <li key={limitation}>{limitation}</li>)}</ul>
      </div>
    </div>
  );
}
