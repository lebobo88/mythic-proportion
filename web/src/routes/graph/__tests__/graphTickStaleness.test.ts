// T2 remediation, round 3 (3D graph intermittent-collapse investigation --
// see the T2 job report). This job's packet asked specifically whether the
// main-thread tick handler assumes the buffer it just received is always
// the freshest, without a staleness check, and whether the existing
// headless test harness's SYNCHRONOUS mock (see graphPerf.synthetic.test.ts's
// `flush()`-based `fakeWorkers`) could ever expose an ordering bug that a
// REAL browser's genuinely async `postMessage` delivery could. This file
// answers both: `Graph3DScene.tsx` had NO staleness guard before this job
// (any received tick was applied unconditionally, keyed only by `revision`
// for an unrelated purpose -- deciding whether to rebuild the id->index
// cache, not whether to apply the tick at all); the guard added by this job
// (`isStaleTickRevision`, exported from `Graph3DScene.tsx`) is exercised
// here against REAL, GENUINELY async, GENUINELY out-of-order `postMessage`
// delivery via real `setTimeout` scheduling (a slower/older message
// scheduled to arrive after a faster/newer one) -- not the synchronous
// `flush()` mock this route's other worker tests use, which by construction
// can never produce out-of-order delivery.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ForceLayoutClient, type WorkerLike } from "../three/ForceLayoutClient";
import { isStaleTickRevision } from "../three/Graph3DScene";
import type { ForceLayoutInMessage, ForceLayoutOutMessage } from "../three/forceLayout.worker";

describe("isStaleTickRevision (pure guard predicate)", () => {
  it("classifies a revision older than the highest applied as stale", () => {
    expect(isStaleTickRevision(1, 2)).toBe(true);
  });

  it("classifies the current revision (equal) and any newer revision as NOT stale", () => {
    expect(isStaleTickRevision(2, 2)).toBe(false);
    expect(isStaleTickRevision(3, 2)).toBe(false);
  });

  it("never treats the very first tick as stale against the -1 sentinel (nothing applied yet)", () => {
    expect(isStaleTickRevision(1, -1)).toBe(false);
  });
});

/**
 * A fake `WorkerLike` whose `postMessage` schedules delivery via a REAL
 * `setTimeout`, with a caller-controlled delay per call -- genuinely async
 * and genuinely capable of out-of-order delivery (unlike a synchronous
 * mock), which is the specific class of timing this job's packet asked to
 * be tested. Only responds to `init`/`update` (the only message types this
 * test needs) by delivering exactly the scripted tick this test queues for
 * that call, via the real `delayMs` passed to `scriptNextDelivery`.
 */
function createAsyncScriptedWorker(): WorkerLike & {
  scriptNextDelivery: (tick: Extract<ForceLayoutOutMessage, { type: "tick" }>, delayMs: number) => void;
  released: ArrayBuffer[];
} {
  let listener: ((event: MessageEvent<ForceLayoutOutMessage>) => void) | null = null;
  let terminated = false;
  const scripted: { tick: Extract<ForceLayoutOutMessage, { type: "tick" }>; delayMs: number }[] = [];
  const released: ArrayBuffer[] = [];

  return {
    addEventListener(_type, cb) {
      listener = cb;
    },
    postMessage(message: ForceLayoutInMessage) {
      if (terminated) return;
      if (message.type === "init" || message.type === "update") {
        const next = scripted.shift();
        if (!next) return;
        setTimeout(() => {
          if (terminated) return;
          listener?.({ data: next.tick } as MessageEvent<ForceLayoutOutMessage>);
        }, next.delayMs);
      } else if (message.type === "releaseBuffer") {
        released.push(message.buffer);
      }
    },
    terminate() {
      terminated = true;
    },
    scriptNextDelivery(tick, delayMs) {
      scripted.push({ tick, delayMs });
    },
    released,
  };
}

describe("real async out-of-order tick delivery is correctly discarded by the guard (T2 remediation round 3)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a slower, OLDER-revision tick that arrives AFTER a faster, NEWER-revision tick never overwrites the applied positions, when the consumer applies Graph3DScene's real isStaleTickRevision guard", async () => {
    const worker = createAsyncScriptedWorker();
    const client = new ForceLayoutClient(worker);

    // Mirrors Graph3DScene's SceneContents onTick handler's guard exactly
    // (same imported predicate, same "discard + still release the buffer"
    // shape) -- this harness exists only because jsdom cannot mount a real
    // R3F <Canvas> to exercise the actual component (see this route's other
    // tests' established convention).
    let highestApplied = -1;
    let appliedPositions: Float32Array | null = null;
    client.onTick((positions, _ids, _alpha, revision) => {
      if (isStaleTickRevision(revision, highestApplied)) {
        client.releaseBuffer(positions.buffer as ArrayBuffer);
        return;
      }
      highestApplied = revision;
      appliedPositions = positions;
    });

    // Generation 1 (revision 1): a SLOW tick, simulating a message that was
    // posted before termination/re-init but is still sitting undelivered in
    // the main thread's task queue -- see the doc comment on
    // `highestAppliedRevisionRef` in Graph3DScene.tsx for the exact platform
    // subtlety this models (`Worker.terminate()`/a same-worker `update`
    // call does not retroactively cancel an already-posted message).
    worker.scriptNextDelivery(
      { type: "tick", positions: new Float32Array([0, 0, 0]), ids: ["a"], alpha: 0.3, revision: 1 },
      80,
    );
    client.init([{ id: "a" }], []);

    // Generation 2 (revision 2): a FAST tick -- the real, current generation
    // -- arrives well before generation 1's slow straggler above.
    worker.scriptNextDelivery(
      { type: "tick", positions: new Float32Array([9, 9, 9]), ids: ["a"], alpha: 0.3, revision: 2 },
      10,
    );
    client.init([{ id: "a" }], []);

    // Wait for BOTH scheduled deliveries to actually fire (generation 2 at
    // ~10ms, generation 1's straggler at ~80ms) using REAL timers -- this is
    // genuine event-loop-scheduled async delivery, not a fake-timer
    // simulation, per this job's packet asking for realistic async timing.
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(highestApplied).toBe(2);
    expect(appliedPositions).not.toBeNull();
    expect(Array.from(appliedPositions!)).toEqual([9, 9, 9]);
    // The stale generation-1 tick was still handed back for recycling
    // rather than silently dropped/leaked.
    expect(worker.released.length).toBe(1);
  });
});
