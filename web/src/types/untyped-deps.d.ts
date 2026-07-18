// Ambient module declarations for Phase 5 3D-graph dependencies that ship no
// TypeScript types and have no `@types/*` package (verified against the npm
// registry at install time -- 404 for both `@types/d3-force-3d` and
// `@types/three-forcegraph`). Deliberately minimal: only the exports this
// codebase actually calls (see forceLayout.worker.ts and InstancedNodes.tsx)
// -- not a full re-typing of either library.

declare module "d3-force-3d" {
  export interface SimulationNodeDatum3D {
    id?: string;
    index?: number;
    x?: number;
    y?: number;
    z?: number;
    vx?: number;
    vy?: number;
    vz?: number;
    fx?: number | null;
    fy?: number | null;
    fz?: number | null;
  }

  export interface SimulationLinkDatum3D<N = SimulationNodeDatum3D> {
    source: string | N;
    target: string | N;
    index?: number;
  }

  export interface Simulation3D<N extends SimulationNodeDatum3D = SimulationNodeDatum3D> {
    nodes(): N[];
    nodes(nodes: N[]): this;
    alpha(): number;
    alpha(value: number): this;
    alphaMin(): number;
    alphaMin(value: number): this;
    alphaDecay(): number;
    alphaDecay(value: number): this;
    alphaTarget(): number;
    alphaTarget(value: number): this;
    velocityDecay(): number;
    velocityDecay(value: number): this;
    force(name: string): unknown;
    force(name: string, force: unknown | null): this;
    tick(iterations?: number): this;
    restart(): this;
    stop(): this;
    numDimensions(): number;
    numDimensions(n: number): this;
    on(typenames: string, listener: ((...args: unknown[]) => void) | null): this;
  }

  export function forceSimulation<N extends SimulationNodeDatum3D = SimulationNodeDatum3D>(
    nodes?: N[],
    numDimensions?: number,
  ): Simulation3D<N>;

  export interface ForceManyBody3D {
    (alpha: number): void;
    strength(value: number | ((node: unknown, i: number, nodes: unknown[]) => number)): ForceManyBody3D;
    distanceMax(value: number): ForceManyBody3D;
  }
  export function forceManyBody(): ForceManyBody3D;

  export interface ForceLink3D<N, L> {
    (alpha: number): void;
    id(accessor: (node: N, i: number, nodes: N[]) => string): ForceLink3D<N, L>;
    distance(value: number | ((link: L) => number)): ForceLink3D<N, L>;
    strength(value: number | ((link: L) => number)): ForceLink3D<N, L>;
    links(links: L[]): ForceLink3D<N, L>;
  }
  export function forceLink<
    N extends SimulationNodeDatum3D = SimulationNodeDatum3D,
    L extends SimulationLinkDatum3D<N> = SimulationLinkDatum3D<N>,
  >(links?: L[]): ForceLink3D<N, L>;

  export interface ForceCenter3D {
    (alpha: number): void;
    x(value: number): ForceCenter3D;
    y(value: number): ForceCenter3D;
    z(value: number): ForceCenter3D;
  }
  export function forceCenter(x?: number, y?: number, z?: number): ForceCenter3D;

  export interface ForceCollide3D {
    (alpha: number): void;
    radius(value: number | ((node: unknown) => number)): ForceCollide3D;
  }
  export function forceCollide(radius?: number | ((node: unknown) => number)): ForceCollide3D;

  // Browser-audit item 1 (BLOCKING, live-Chrome finding): forceLayout.worker.ts
  // added a weak per-axis containment force toward the origin to bound
  // isolated-node drift on sparse/disconnected graphs -- see that file for
  // the full rationale. `d3-force-3d` ships no `.d.ts` of its own (see this
  // file's header comment); this mirrors its real `x.js`/`y.js`/`z.js` API
  // shape, minimally (only the `.strength(...)` method this codebase calls).
  export interface ForceAxis3D {
    (alpha: number): void;
    strength(value: number | ((node: unknown, i: number, nodes: unknown[]) => number)): ForceAxis3D;
  }
  export function forceX(x?: number | ((node: unknown, i: number, nodes: unknown[]) => number)): ForceAxis3D;
  export function forceY(y?: number | ((node: unknown, i: number, nodes: unknown[]) => number)): ForceAxis3D;
  export function forceZ(z?: number | ((node: unknown, i: number, nodes: unknown[]) => number)): ForceAxis3D;

  // Phase 4a de-risking spike addition (plan Section 6.3): Orbital mode's
  // concentric-shell force. Mirrors `d3-force-3d`'s real `radial.js` API
  // shape, minimally (only the `.strength(...)` accessor this codebase
  // calls beyond the constructor's `radius`/`x`/`y`/`z` args).
  export interface ForceRadial3D {
    (alpha: number): void;
    strength(value: number | ((node: unknown, i: number, nodes: unknown[]) => number)): ForceRadial3D;
    radius(value: number | ((node: unknown, i: number, nodes: unknown[]) => number)): ForceRadial3D;
  }
  export function forceRadial(
    radius: number | ((node: unknown, i: number, nodes: unknown[]) => number),
    x?: number,
    y?: number,
    z?: number,
  ): ForceRadial3D;
}

declare module "troika-three-text" {
  import type { Mesh } from "three";
  export class Text extends Mesh {
    text: string;
    fontSize: number;
    color: number | string;
    anchorX: string | number;
    anchorY: string | number;
    outlineWidth: number | string;
    outlineColor: number | string;
    sync(callback?: () => void): void;
    dispose(): void;
  }
}
