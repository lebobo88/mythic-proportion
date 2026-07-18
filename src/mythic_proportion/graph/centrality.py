"""Pure-Python centrality measures for the Phase 4b `/api/graph` enrichment
(plan Section 6.4/7).

:func:`compute_eigenvector_centrality` is a plain weighted power iteration
over the same undirected edge list :func:`mythic_proportion.graph.communities
.build_weighted_edge_list` already builds for Leiden -- deliberately NOT
delegated to ``networkx`` (only a *transitive* dependency of the optional
``graspologic`` backend, never declared as a first-class project dependency
in ``pyproject.toml``) or to ``graspologic``/``igraph`` (neither ships a
centrality API this project already depends on). This keeps the Phase 4b
enrichment free of any new dependency, per the T2 "do not add a dependency
without explicit job authority" contract.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

# J-001 remediation (Codex CODE_REVIEW checkpoint, plan Section 12): the
# original 100-iteration cap was nowhere near enough to converge on a
# plausible worst-case spectral gap. A star/hub-and-spoke shape (one entity
# with an unusually large number of direct relationships -- a realistic
# knowledge-graph pattern, not a contrived edge case) is the textbook
# near-worst case for power iteration: after the `(I + A)` identity shift
# (see the loop below), the leading/subleading eigenvalue ratio for an
# n-spoke star is `(sqrt(n)-1)/(sqrt(n)+1)`, which for n=10,000 is
# approximately 0.9802 -- meaning the per-iteration error only shrinks by
# ~2% per step, not the near-instant convergence a well-conditioned graph
# gets. Measured directly (see the ENGINEERING_JOB report's benchmark):
# at the old 100-iteration cap, a 10,000-spoke star's leaf scores carried
# ~30% relative error. 500 was chosen as the new default over a fully-
# convergent ~1,000+: at 500 iterations the exact reviewer-reported
# 10,000-spoke case is already down to 0.0089% relative error (three orders
# of magnitude tighter than the original bug, comfortable margin), while
# roughly halving worst-case latency versus 1,000 on a realistic (not
# single-hub) ~10k-node cluster-shaped graph (see the ENGINEERING_JOB
# report's J-003 benchmark: ~4.8s at 500 iterations versus ~8.5-9.8s at
# 1,000, on a 10k-node/20k-edge synthetic graph shaped like the plan's own
# stress-test fixture). 500 is deliberately still a bounded, non-infinite
# cap ("a sane upper cap so it doesn't hang") -- a graph large/pathological
# enough to still miss `tolerance` at that cap gets a logged warning (see
# `_run_power_iteration` below) rather than an unbounded hang or a
# silently-treated-as-final partial result. The residual latency risk this
# still leaves at the plan's full 10k-node stress scale is a REAL, reported,
# NOT-yet-resolved limitation -- see the ENGINEERING_JOB report's J-003
# section; caching/moving this off the synchronous request path is the
# recommended follow-up, deliberately out of scope for this bounded fix.
DEFAULT_EIGENVECTOR_ITERATIONS = 500
DEFAULT_EIGENVECTOR_TOLERANCE = 1e-10


def compute_eigenvector_centrality(
    edges: list[tuple[int, int, float]],
    node_ids: list[int],
    *,
    max_iterations: int = DEFAULT_EIGENVECTOR_ITERATIONS,
    tolerance: float = DEFAULT_EIGENVECTOR_TOLERANCE,
) -> dict[int, float]:
    """Weighted eigenvector centrality via power iteration, returning
    ``{entity_id: score}`` with every score normalized so the single
    highest-scoring node is exactly ``1.0`` and every other node falls in
    ``[0, 1]`` -- the plan Section 7 wire contract ("each normalized to
    0..1"), which is NOT the same convention ``networkx.eigenvector_
    centrality`` uses by default (unit L2 norm).

    Chosen over betweenness centrality for the Phase 4b enrichment (plan
    Section 5.3's open "which centrality measure" decision -- see the
    ENGINEERING_JOB report for the full rationale, summarized here): (1)
    cost -- betweenness (Brandes' algorithm) is O(V*E), while this power
    iteration is O(iterations * E), materially cheaper as the graph grows
    toward the plan's 10k-node stress target, and this projection runs
    on-demand on every `/api/graph` request rather than being cached; (2)
    fit -- eigenvector centrality ("important because connected to
    important nodes") matches the Orbital mode's gravity-well metaphor
    (large hubs pull in other hubs) better than betweenness ("bridges
    between communities"), which is a brokerage measure, not a prominence
    one.

    Isolated nodes (degree 0) and nodes in a component the dominant
    eigenvector doesn't reach settle at ``0.0``, never ``NaN`` -- no
    divide-by-zero: a graph with no edges at all short-circuits to
    all-``0.0`` before any iteration runs, and a degenerate all-zero
    iteration result (every edge weight summed to zero) is caught the same
    way.

    J-001 remediation: if the power iteration still has not settled below
    ``tolerance`` by ``max_iterations`` (an even more extreme spectral gap
    than the 10,000-spoke worst case this default is tuned for), this logs
    a warning identifying the node count and the achieved delta -- the
    caller still gets a best-effort result (never `None`/an exception), but
    it is no longer SILENTLY treated as fully converged; see
    `_run_power_iteration` for the convergence tracking this relies on.
    """
    scores, converged, achieved_delta = _run_power_iteration(
        edges, node_ids, max_iterations=max_iterations, tolerance=tolerance
    )
    if not converged:
        logger.warning(
            "compute_eigenvector_centrality: power iteration did not converge within "
            "%d iterations (tolerance=%s, achieved delta=%s) for a %d-node graph; "
            "returning the best-effort partial result. This can happen for a node "
            "with an extremely large, near-star-shaped neighborhood (a very small "
            "spectral gap) -- see the Phase 4b engineering report's J-001 remediation.",
            max_iterations,
            tolerance,
            achieved_delta,
            len(node_ids),
        )
    return scores


def _run_power_iteration(
    edges: list[tuple[int, int, float]],
    node_ids: list[int],
    *,
    max_iterations: int,
    tolerance: float,
) -> tuple[dict[int, float], bool, float | None]:
    """The actual power-iteration loop, returning ``(scores, converged,
    achieved_delta)`` -- split out from :func:`compute_eigenvector_
    centrality` purely so the convergence OUTCOME is directly testable
    (see ``test_returns_converged_false_when_the_iteration_cap_is_hit_before_
    tolerance_is_reached`` in test_centrality.py) without needing a
    multi-second, thousands-of-nodes graph just to exercise the
    non-convergence path."""
    if not node_ids:
        return {}, True, None
    if not edges:
        return {node_id: 0.0 for node_id in node_ids}, True, None

    valid_ids = set(node_ids)
    adjacency: dict[int, list[tuple[int, float]]] = {node_id: [] for node_id in node_ids}
    for a, b, weight in edges:
        if a not in valid_ids or b not in valid_ids:
            continue
        adjacency[a].append((b, weight))
        adjacency[b].append((a, weight))

    n = len(node_ids)
    x: dict[int, float] = {node_id: 1.0 / n for node_id in node_ids}
    converged = False
    achieved_delta: float | None = None

    for _ in range(max_iterations):
        nxt: dict[int, float] = {node_id: 0.0 for node_id in node_ids}
        for node_id, neighbors in adjacency.items():
            # Power iteration on `(I + A)`, not bare `A`: a plain adjacency
            # power iteration oscillates forever (never converges) on any
            # bipartite subgraph -- a plain star/hub-and-spoke shape is the
            # simplest example, and knowledge graphs routinely contain
            # hub-like entities whose immediate neighborhood is exactly that
            # shape. `A`'s eigenvalues are symmetric about 0 for a bipartite
            # graph, so +lambda_max and -lambda_max tie for dominance and the
            # naive iterate alternates between two vectors instead of
            # settling. Adding the identity (each node's own PREVIOUS score,
            # once, alongside its neighbors' contributions) shifts every
            # eigenvalue by exactly +1 without changing any eigenvector, which
            # breaks that tie (`1 + lambda_max` uniquely exceeds
            # `1 - lambda_max` in magnitude for any lambda_max > 0) and
            # restores normal convergence to the standard eigenvector-
            # centrality result. See `test_hub_and_spoke_graph_ranks_the_hub_
            # strictly_above_every_spoke` in test_centrality.py for the
            # regression this fixes (confirmed RED without this shift).
            if not neighbors:
                # A genuinely isolated node (zero edges) never gets the
                # identity-shift self-term below -- it must converge to
                # exactly 0.0, never an arbitrary shared constant, and never
                # pollute the norm shared with every connected node.
                continue
            total = x[node_id]
            for other, weight in neighbors:
                total += weight * x[other]
            nxt[node_id] = total
        norm = sum(v * v for v in nxt.values()) ** 0.5
        if norm == 0.0:
            # The dominant eigenvector has fully decayed (e.g. every edge
            # touching this node set carries zero weight) -- nothing left to
            # normalize; every node is equally uninformative. This is a
            # genuine fixed point, not a cap-out -- counts as converged.
            return {node_id: 0.0 for node_id in node_ids}, True, 0.0
        nxt = {node_id: v / norm for node_id, v in nxt.items()}
        delta = sum(abs(nxt[node_id] - x[node_id]) for node_id in node_ids)
        x = nxt
        achieved_delta = delta
        if delta < tolerance:
            converged = True
            break

    max_value = max(x.values(), default=0.0)
    if max_value <= 0.0:
        return {node_id: 0.0 for node_id in node_ids}, converged, achieved_delta
    scores = {node_id: max(0.0, value / max_value) for node_id, value in x.items()}
    return scores, converged, achieved_delta
