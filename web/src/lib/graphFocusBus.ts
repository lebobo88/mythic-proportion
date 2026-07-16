// Tiny pub/sub so the Cmd+K command palette (mounted at the App level,
// outside the Graph tab) can ask GraphView to refocus a node even though
// GraphView is only mounted while the Graph tab is active. `onSelectTab`
// switches tabs and `requestGraphFocus` fires in the same synchronous
// event-handler tick, before React has re-rendered/mounted GraphView -- so
// the request is also retained as `pending` and drained once by whichever
// GraphView mount effect asks for it next (see GraphView.tsx).
let pending: string | null = null;
const subscribers = new Set<(nodeId: string) => void>();

export function requestGraphFocus(nodeId: string): void {
  pending = nodeId;
  subscribers.forEach((cb) => cb(nodeId));
}

/** Reads-and-clears the last pending focus request, or null if none. */
export function consumePendingGraphFocus(): string | null {
  const value = pending;
  pending = null;
  return value;
}

export function subscribeGraphFocus(callback: (nodeId: string) => void): () => void {
  subscribers.add(callback);
  return () => subscribers.delete(callback);
}
