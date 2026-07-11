// Main-thread wrapper around forceLayout.worker.ts. Owns nothing but a
// `postMessage` channel + a subscriber list -- no physics, no React state
// (positions flow into refs, per the "never setState in useFrame" perf
// requirement -- see Graph3DScene.tsx).
import type { ForceLayoutInMessage, ForceLayoutOutMessage, WorkerLink, WorkerNode } from "./forceLayout.worker";

/** Minimal surface this client needs from a Worker -- real `Worker` satisfies it,
 *  and tests can supply a fake to assert worker-based layout structurally
 *  without jsdom's lack of real Worker support. */
export interface WorkerLike {
  postMessage(message: ForceLayoutInMessage, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent<ForceLayoutOutMessage>) => void): void;
  terminate(): void;
}

export type TickListener = (positions: Float32Array, ids: string[], alpha: number) => void;

export class ForceLayoutClient {
  private worker: WorkerLike;
  private tickListeners = new Set<TickListener>();
  private endListeners = new Set<() => void>();

  constructor(worker: WorkerLike) {
    this.worker = worker;
    this.worker.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg.type === "tick") {
        for (const cb of this.tickListeners) cb(msg.positions, msg.ids, msg.alpha);
      } else if (msg.type === "end") {
        for (const cb of this.endListeners) cb();
      }
    });
  }

  onTick(cb: TickListener): () => void {
    this.tickListeners.add(cb);
    return () => this.tickListeners.delete(cb);
  }

  onEnd(cb: () => void): () => void {
    this.endListeners.add(cb);
    return () => this.endListeners.delete(cb);
  }

  init(nodes: WorkerNode[], links: WorkerLink[], warmupTicks = 60): void {
    this.worker.postMessage({ type: "init", nodes, links, warmupTicks });
  }

  update(nodes: WorkerNode[], links: WorkerLink[], warmupTicks = 30): void {
    this.worker.postMessage({ type: "update", nodes, links, warmupTicks });
  }

  reheat(): void {
    this.worker.postMessage({ type: "reheat" });
  }

  drag(id: string, x: number, y: number, z: number): void {
    this.worker.postMessage({ type: "drag", id, x, y, z });
  }

  dragEnd(id: string): void {
    this.worker.postMessage({ type: "dragend", id });
  }

  stop(): void {
    this.worker.postMessage({ type: "stop" });
  }

  dispose(): void {
    this.worker.terminate();
  }
}

/** Real-Worker factory -- kept separate from the class so tests never need `new Worker(...)` in jsdom. */
export function createForceLayoutWorker(): WorkerLike {
  return new Worker(new URL("./forceLayout.worker.ts", import.meta.url), { type: "module" }) as WorkerLike;
}
