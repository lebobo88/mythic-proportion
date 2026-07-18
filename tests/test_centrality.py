"""Tests for :mod:`mythic_proportion.graph.centrality` -- the pure-Python
power-iteration eigenvector centrality used by the Phase 4b `/api/graph`
enrichment (plan Section 6.4/7). No sqlite/store involvement here: every test
feeds a plain weighted edge list directly, exactly the shape
:func:`mythic_proportion.graph.communities.build_weighted_edge_list` already
produces.
"""

from __future__ import annotations

import logging
import math

import pytest

from mythic_proportion.graph.centrality import (
    _run_power_iteration,
    compute_eigenvector_centrality,
)


def test_returns_empty_dict_for_no_node_ids() -> None:
    assert compute_eigenvector_centrality([], []) == {}


def test_all_isolated_nodes_score_zero_when_there_are_no_edges_at_all() -> None:
    scores = compute_eigenvector_centrality([], [1, 2, 3])
    assert scores == {1: 0.0, 2: 0.0, 3: 0.0}


def test_every_score_is_normalized_into_the_closed_unit_interval() -> None:
    edges = [(1, 2, 3.0), (2, 3, 1.0), (3, 4, 5.0), (4, 1, 2.0)]
    scores = compute_eigenvector_centrality(edges, [1, 2, 3, 4])
    assert set(scores.keys()) == {1, 2, 3, 4}
    for value in scores.values():
        assert 0.0 <= value <= 1.0
    assert max(scores.values()) == pytest.approx(1.0)


def test_hub_and_spoke_graph_ranks_the_hub_strictly_above_every_spoke() -> None:
    # Node 0 is the hub, connected to four otherwise-disconnected spokes.
    edges = [(0, 1, 1.0), (0, 2, 1.0), (0, 3, 1.0), (0, 4, 1.0)]
    scores = compute_eigenvector_centrality(edges, [0, 1, 2, 3, 4])
    assert scores[0] == pytest.approx(1.0)
    for spoke in (1, 2, 3, 4):
        assert scores[spoke] < scores[0]
        assert scores[spoke] > 0.0


def test_symmetric_triangle_gives_every_member_the_same_score() -> None:
    edges = [(1, 2, 4.0), (2, 3, 4.0), (1, 3, 4.0)]
    scores = compute_eigenvector_centrality(edges, [1, 2, 3])
    assert scores[1] == pytest.approx(scores[2], abs=1e-6)
    assert scores[2] == pytest.approx(scores[3], abs=1e-6)
    assert scores[1] == pytest.approx(1.0)


def test_a_node_with_zero_edges_in_an_otherwise_connected_graph_scores_zero() -> None:
    edges = [(1, 2, 1.0), (2, 3, 1.0)]
    scores = compute_eigenvector_centrality(edges, [1, 2, 3, 99])
    assert scores[99] == pytest.approx(0.0)


def test_ignores_edges_referencing_a_node_id_outside_the_requested_set() -> None:
    edges = [(1, 2, 1.0), (2, 999, 5.0)]
    scores = compute_eigenvector_centrality(edges, [1, 2])
    assert set(scores.keys()) == {1, 2}


def test_is_fully_deterministic_across_repeated_calls_on_the_same_input() -> None:
    edges = [(1, 2, 3.0), (2, 3, 1.0), (3, 4, 5.0), (4, 1, 2.0), (2, 4, 0.5)]
    first = compute_eigenvector_centrality(edges, [1, 2, 3, 4])
    second = compute_eigenvector_centrality(edges, [1, 2, 3, 4])
    assert first == second


def test_a_degenerate_all_zero_weight_graph_never_produces_nan_or_out_of_range_scores() -> None:
    # Every listed edge carries zero weight (a pathological input -- real
    # extracted relationship weights are always positive confidence scores,
    # never zero) -- there is no real weighted connectivity to distinguish
    # any node from any other, so tying all three at the same score is
    # correct; the actual bar this guards is numerical safety (no NaN, no
    # divide-by-zero, no value outside [0, 1]), not a specific tie value.
    edges = [(1, 2, 0.0), (2, 3, 0.0)]
    scores = compute_eigenvector_centrality(edges, [1, 2, 3])
    assert set(scores.keys()) == {1, 2, 3}
    for value in scores.values():
        assert value == value  # not NaN
        assert 0.0 <= value <= 1.0
    assert scores[1] == pytest.approx(scores[2])
    assert scores[2] == pytest.approx(scores[3])


# ---------------------------------------------------------------------------
# J-001 remediation (Codex CODE_REVIEW checkpoint, plan Section 12): the
# original 100-iteration cap left a large-star graph's leaf scores with
# ~30% error, silently returned as if it were the final, converged answer.
# ---------------------------------------------------------------------------


def test_large_star_graph_converges_within_a_tight_error_bound_at_the_default_iteration_cap() -> None:
    """Regression for J-001: checks an ACTUAL numeric error bound against
    the star graph's known closed-form eigenvector-centrality solution, not
    merely hub-above-spoke ordering (which the old, genuinely-broken
    100-iteration default already passed at ~30% error -- ordering alone
    cannot catch this class of bug). For an n-spoke star, the true
    (max-normalized) leaf score is exactly ``1/sqrt(n)`` -- see the
    ENGINEERING_JOB report's derivation. 5,000 spokes is comfortably inside
    the plan's ~10,000-node stress target (Section 6.3) and keeps this
    test's own runtime bounded (~1s), while still exercising the same small-
    spectral-gap shape as the reviewer's reported 10,000-spoke case.
    """
    n_spokes = 5000
    edges = [(0, i, 1.0) for i in range(1, n_spokes + 1)]
    node_ids = list(range(n_spokes + 1))

    scores = compute_eigenvector_centrality(edges, node_ids)

    true_leaf_score = 1.0 / math.sqrt(n_spokes)
    assert scores[0] == pytest.approx(1.0, abs=1e-6)
    for spoke in range(1, n_spokes + 1):
        assert scores[spoke] == pytest.approx(true_leaf_score, abs=1e-4)


def test_run_power_iteration_reports_converged_true_for_a_well_conditioned_small_graph() -> None:
    edges = [(1, 2, 3.0), (2, 3, 1.0), (3, 4, 5.0), (4, 1, 2.0)]
    _scores, converged, achieved_delta = _run_power_iteration(
        edges, [1, 2, 3, 4], max_iterations=1000, tolerance=1e-10
    )
    assert converged is True
    assert achieved_delta is not None
    assert achieved_delta < 1e-10


def test_run_power_iteration_reports_converged_false_when_the_iteration_cap_is_hit_first() -> None:
    """Forces the non-convergence path deterministically and cheaply: a
    large-ish star (small spectral gap, per the J-001 analysis above) capped
    at a deliberately tiny iteration budget it cannot possibly settle
    within. This is the fast, targeted counterpart to the slow full-scale
    convergence test above -- it exercises the OUTCOME-detection machinery
    itself, not iteration-count tuning."""
    n_spokes = 200
    edges = [(0, i, 1.0) for i in range(1, n_spokes + 1)]
    node_ids = list(range(n_spokes + 1))

    _scores, converged, achieved_delta = _run_power_iteration(
        edges, node_ids, max_iterations=3, tolerance=1e-10
    )
    assert converged is False
    assert achieved_delta is not None
    assert achieved_delta >= 1e-10


def test_compute_eigenvector_centrality_logs_a_warning_on_non_convergence_but_still_returns_a_result(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """J-001's "detect/handle non-convergence rather than silently returning
    a partial result as if it were final" requirement: the public function
    must surface a non-convergent run (here, forced via an artificially tiny
    `max_iterations`) via a logged warning, while still returning a usable
    best-effort result rather than raising or hanging."""
    n_spokes = 200
    edges = [(0, i, 1.0) for i in range(1, n_spokes + 1)]
    node_ids = list(range(n_spokes + 1))

    with caplog.at_level(logging.WARNING, logger="mythic_proportion.graph.centrality"):
        scores = compute_eigenvector_centrality(edges, node_ids, max_iterations=3)

    assert set(scores.keys()) == set(node_ids)
    assert any("did not converge" in record.message for record in caplog.records)


def test_compute_eigenvector_centrality_does_not_log_when_it_genuinely_converges(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level(logging.WARNING, logger="mythic_proportion.graph.centrality"):
        compute_eigenvector_centrality([(1, 2, 3.0), (2, 3, 1.0)], [1, 2, 3])
    assert not any("did not converge" in record.message for record in caplog.records)
