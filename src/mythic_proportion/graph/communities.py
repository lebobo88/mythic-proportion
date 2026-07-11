"""Hierarchical Leiden community detection over the graph layer (Phase 4).

:func:`compute_communities` is the single entry point: build a weighted,
undirected edge-list from ``relationships`` (:func:`build_weighted_edge_list`),
run hierarchical Leiden (:func:`run_hierarchical_leiden`), and atomically
persist ``level``/``cluster``/``parent_cluster`` into the (previously empty,
see Phase 3) ``communities`` table via
:meth:`mythic_proportion.graph.store.GraphStore.replace_communities`.

Backend selection (per specs/ROADMAP-BRIEF.md §6.2 + the Phase 4 build
directive): **graspologic.hierarchical_leiden** is the primary backend (pinned
``random_seed`` for stable community IDs across re-index runs). If
``graspologic`` fails to import (the documented Windows risk -- it pulls
numpy/scipy/gensim/POT), this falls back to **leidenalg + python-igraph**
(lighter, ships Windows wheels), synthesizing the same leveled hierarchy via
recursive ``find_partition`` calls. Both backends stay behind the optional
``[graphrag]`` extra and are imported lazily -- never at module import time --
so the base install (and every other test in this package) never requires
either of them.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass

from mythic_proportion.graph.store import GraphStore

#: Pinned across every real (non-test) call site -- this is what makes
#: community IDs stable across an identical re-index (the brief's "stable
#: community IDs across identical re-runs" requirement).
DEFAULT_RANDOM_SEED = 1337
DEFAULT_MAX_CLUSTER_SIZE = 50

_INSTALL_HINT = (
    "Community detection requires the '[graphrag]' extra: "
    "pip install 'mythic-proportion[graphrag]' (graspologic), or as a "
    "lighter Windows-friendly fallback: pip install leidenalg python-igraph"
)


@dataclass(frozen=True)
class CommunityAssignment:
    """One entity's membership at one level of the hierarchy."""

    entity_id: int
    cluster: int
    parent_cluster: int | None
    level: int


@dataclass
class CommunityComputeReport:
    """Counts of what :func:`compute_communities` wrote in one call."""

    rows_written: int = 0
    levels: int = 0
    entities_clustered: int = 0
    entities_isolated: int = 0
    backend: str = ""


def build_weighted_edge_list(conn: sqlite3.Connection) -> list[tuple[int, int, float]]:
    """``[(entity_id_a, entity_id_b, weight)]`` -- one undirected edge per
    entity pair, summing the weight of every (possibly multi-typed)
    directed relationship row between them. Leiden operates on undirected
    weighted graphs; ``relationships`` stores directed rows keyed on
    ``(source_id, target_id, type)`` (see ``index/schema.sql``), so pairs are
    normalized to ``(min(a,b), max(a,b))`` before summing."""
    aggregated: dict[tuple[int, int], float] = {}
    for row in conn.execute("SELECT source_id, target_id, weight FROM relationships"):
        a, b = int(row["source_id"]), int(row["target_id"])
        if a == b:
            continue  # a self-loop contributes nothing to community structure
        key = (a, b) if a < b else (b, a)
        aggregated[key] = aggregated.get(key, 0.0) + float(row["weight"])
    return [(a, b, w) for (a, b), w in aggregated.items()]


def _run_via_graspologic(
    edges: list[tuple[int, int, float]], *, random_seed: int, max_cluster_size: int
) -> list[CommunityAssignment]:
    from graspologic.partition import hierarchical_leiden  # lazy -- see module docstring

    clusters = hierarchical_leiden(
        edges, random_seed=random_seed, max_cluster_size=max_cluster_size
    )
    return [
        CommunityAssignment(
            entity_id=int(c.node), cluster=int(c.cluster), parent_cluster=c.parent_cluster, level=int(c.level)
        )
        for c in clusters
    ]


def _run_via_leidenalg(
    edges: list[tuple[int, int, float]], *, random_seed: int, max_cluster_size: int
) -> list[CommunityAssignment]:
    """Fallback backend: recursive ``leidenalg.find_partition`` synthesizing
    the same leveled ``(cluster, parent_cluster, level)`` hierarchy
    ``graspologic.hierarchical_leiden`` would produce -- split any
    cluster larger than ``max_cluster_size`` one more level down, until
    every leaf cluster is small enough or can no longer be split."""
    import igraph as ig  # lazy -- see module docstring
    import leidenalg  # lazy -- see module docstring

    node_ids = sorted({a for a, _b, _w in edges} | {b for _a, b, _w in edges})
    index_of = {node_id: i for i, node_id in enumerate(node_ids)}
    graph = ig.Graph()
    graph.add_vertices(len(node_ids))
    graph.add_edges([(index_of[a], index_of[b]) for a, b, _w in edges])
    graph.es["weight"] = [w for _a, _b, w in edges]

    assignments: list[CommunityAssignment] = []
    next_cluster_id = 0

    def _partition(vertex_indices: list[int], parent_cluster: int | None, level: int) -> None:
        nonlocal next_cluster_id
        subgraph = graph.subgraph(vertex_indices)
        partition = leidenalg.find_partition(
            subgraph,
            leidenalg.RBConfigurationVertexPartition,
            weights="weight" if "weight" in subgraph.es.attributes() else None,
            seed=random_seed,
        )
        # Map each local (subgraph) partition-cluster back to this level's
        # own cluster ids, then record every member's assignment.
        local_to_cluster: dict[int, int] = {}
        oversized: dict[int, list[int]] = {}
        for local_idx, membership in enumerate(partition.membership):
            if membership not in local_to_cluster:
                local_to_cluster[membership] = next_cluster_id
                next_cluster_id += 1
            cluster_id = local_to_cluster[membership]
            global_vertex_idx = vertex_indices[local_idx]
            node_id = node_ids[global_vertex_idx]
            assignments.append(
                CommunityAssignment(
                    entity_id=node_id, cluster=cluster_id, parent_cluster=parent_cluster, level=level
                )
            )
            oversized.setdefault(cluster_id, []).append(global_vertex_idx)

        for cluster_id, members in oversized.items():
            if len(members) > max_cluster_size and len(members) < len(vertex_indices):
                _partition(members, cluster_id, level + 1)

    if vertex_indices := list(range(len(node_ids))):
        _partition(vertex_indices, None, 0)

    return assignments


def run_hierarchical_leiden(
    edges: list[tuple[int, int, float]],
    *,
    random_seed: int = DEFAULT_RANDOM_SEED,
    max_cluster_size: int = DEFAULT_MAX_CLUSTER_SIZE,
) -> tuple[list[CommunityAssignment], str]:
    """Run hierarchical Leiden over ``edges``, returning
    ``(assignments, backend_name)``. Tries ``graspologic`` first, then
    ``leidenalg``+``igraph``; raises :class:`ImportError` with an actionable
    install hint if neither is available. ``[]`` (no LLM/no import at all)
    for an empty edge list."""
    if not edges:
        return [], "none"
    try:
        return _run_via_graspologic(
            edges, random_seed=random_seed, max_cluster_size=max_cluster_size
        ), "graspologic"
    except ImportError:
        pass
    try:
        return _run_via_leidenalg(
            edges, random_seed=random_seed, max_cluster_size=max_cluster_size
        ), "leidenalg"
    except ImportError as exc:
        raise ImportError(_INSTALL_HINT) from exc


def compute_communities(
    conn: sqlite3.Connection,
    *,
    random_seed: int = DEFAULT_RANDOM_SEED,
    max_cluster_size: int = DEFAULT_MAX_CLUSTER_SIZE,
) -> CommunityComputeReport:
    """Recompute the whole-graph Leiden clustering and atomically replace the
    ``communities`` table (cheap at personal-vault scale, per the brief --
    "recompute whole-graph each index run" rather than incrementally
    diffing). Entities with zero relationships (isolated -- Leiden never
    sees them, since they contribute no edge) each get their own singleton
    level-0 community so every entity is always assigned to *some*
    community, even a brand-new, never-linked one."""
    store = GraphStore(conn)
    edges = build_weighted_edge_list(conn)
    assignments, backend = run_hierarchical_leiden(
        edges, random_seed=random_seed, max_cluster_size=max_cluster_size
    )

    clustered_ids = {a.entity_id for a in assignments}
    all_entity_ids = store.all_entity_ids()
    isolated_ids = sorted(set(all_entity_ids) - clustered_ids)

    next_cluster_id = (max((a.cluster for a in assignments), default=-1)) + 1
    rows: list[tuple[int, int, int | None, int]] = [
        (a.level, a.cluster, a.parent_cluster, a.entity_id) for a in assignments
    ]
    for entity_id in isolated_ids:
        rows.append((0, next_cluster_id, None, entity_id))
        next_cluster_id += 1

    store.replace_communities(rows)

    levels = len({a.level for a in assignments}) or (1 if isolated_ids else 0)
    return CommunityComputeReport(
        rows_written=len(rows),
        levels=levels,
        entities_clustered=len(clustered_ids),
        entities_isolated=len(isolated_ids),
        backend=backend,
    )
