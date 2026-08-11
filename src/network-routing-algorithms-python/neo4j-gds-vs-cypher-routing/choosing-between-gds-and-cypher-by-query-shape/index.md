---
pageTitle: Choosing GDS or Cypher
title: Choosing Between GDS and Cypher by Query Shape
description: A decision procedure that answers from the query's shape and the graph's update rate, rather than from a benchmark of the wrong thing.
slug: choosing-between-gds-and-cypher-by-query-shape
type: article
breadcrumb: Choosing by Shape
datePublished: 2026-08-11
dateModified: 2026-08-11
---
# Choosing Between GDS and Cypher by Query Shape

"Which is faster, GDS or Cypher?" has no answer, and chasing one produces benchmarks that are individually correct and collectively useless — GDS wins the test that keeps a projection resident, Cypher wins the one that does not, and both results are quoted at each other indefinitely. The question that does have an answer is narrower: *for this query shape, at this update rate, at this request volume, which one is cheaper?* Three properties settle it, none of them requires a measurement to decide, and the measurement is then worth running to confirm rather than to discover. This page gives the procedure and the cases where it points somewhere unexpected.

## Prerequisites & Versions

The decision needs no code; the confirmation reuses the existing benchmark harness.

| Requirement | Minimum version | Install |
| --- | --- | --- |
| Python | 3.11 | — |
| neo4j (async driver) | 5.20 | `pip install "neo4j>=5.20"` |
| Neo4j Server | 5.15 | — |
| Graph Data Science | 2.6 | server plugin |

## Implementation

```python
from dataclasses import dataclass
from enum import Enum


class Shape(Enum):
    POINT_TO_POINT = "one source, one target"
    ONE_TO_MANY = "one source, many targets"
    MANY_TO_MANY = "many sources, many targets"
    WHOLE_GRAPH = "every node — centrality, components, communities"


@dataclass(frozen=True)
class Workload:
    shape: Shape
    requests_per_hour: float
    graph_changes_per_hour: float
    custom_cost_per_request: bool   # does the weight depend on the caller?

    @property
    def projection_reuses(self) -> float:
        """How many requests one projection can serve before it goes stale.

        This is the number the whole decision turns on. A projection is a
        snapshot, so its useful life ends at the next topology or weight change;
        everything it can serve in that window shares its build cost.
        """
        if self.graph_changes_per_hour <= 0:
            return float("inf")
        return self.requests_per_hour / self.graph_changes_per_hour


def recommend(w: Workload) -> tuple[str, str]:
    # A per-request cost function cannot be projected: the weight is not a
    # property of the graph, it is a property of the request. This overrides
    # everything else, including volume.
    if w.custom_cost_per_request:
        return ("Cypher", "the weight depends on the caller, so no projection "
                          "can be shared between requests")

    # Whole-graph algorithms have no Cypher equivalent worth writing. The
    # projection is not an optimisation here, it is the only implementation.
    if w.shape is Shape.WHOLE_GRAPH:
        return ("GDS", "no practical Cypher formulation; the projection is the "
                       "implementation rather than an accelerator")

    # Many-to-many is where the asymmetry is largest: one projection serves the
    # entire matrix, and Cypher would pay a traversal per cell.
    if w.shape is Shape.MANY_TO_MANY:
        return ("GDS", "one projection amortises across every cell of the matrix")

    # One-to-many settles every reachable node in a single pass either way, but
    # GDS does it against a packed array rather than the store.
    if w.shape is Shape.ONE_TO_MANY and w.projection_reuses >= 10:
        return ("GDS", f"~{w.projection_reuses:.0f} requests per projection build")

    if w.projection_reuses < 5:
        return ("Cypher", f"only ~{w.projection_reuses:.1f} requests per build — "
                          "the projection never pays for itself")

    return ("either — measure", f"~{w.projection_reuses:.0f} reuses puts this in "
                                "the band where the constants decide")


if __name__ == "__main__":
    cases = [
        Workload(Shape.POINT_TO_POINT, 40_000, 1, False),      # busy, stable
        Workload(Shape.POINT_TO_POINT, 200, 60, False),        # live traffic feed
        Workload(Shape.MANY_TO_MANY, 24, 1, False),            # nightly fleet plan
        Workload(Shape.POINT_TO_POINT, 5_000, 1, True),        # per-user preferences
        Workload(Shape.WHOLE_GRAPH, 1, 1, False),              # centrality report
    ]
    for w in cases:
        choice, why = recommend(w)
        print(f"{w.shape.value:<34}{choice:<16}{why}")
```

## How It Works

Three properties decide it, and they are checked in order of how decisively they settle the question.

**A per-request cost function rules out projection entirely.** If the weight depends on the caller — a vehicle profile, a set of avoided roads, a time-of-day preference — then no two requests can share a projection, and building one per request is the worst of both approaches. This overrides request volume completely: a million requests an hour with a million distinct cost functions still cannot amortise anything.

**Shape decides how much one projection is worth.** A point-to-point query uses a tiny fraction of the graph it projected; a many-to-many matrix uses all of it, repeatedly. That is why the same projection cost is extravagant in one case and negligible in the other, and it is why "is GDS faster" is unanswerable without naming the shape.

**Reuse count is the arithmetic that settles the remaining cases.** Requests divided by graph changes gives how many queries one projection can serve before it goes stale. Below about five the build dominates and Cypher wins; above about ten the build is noise and GDS wins; between them the constants matter and a measurement is genuinely required — which is the only band where the [benchmark harness](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/neo4j-gds-vs-cypher-routing/benchmarking-gds-shortestpath-against-hand-written-cypher/) is answering a question rather than confirming one.

<svg viewBox="0 0 780 320" role="img" aria-labelledby="gdsChoiceTitle gdsChoiceDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="gdsChoiceTitle">Query shape against projection reuse, and where each engine wins</title>
  <desc id="gdsChoiceDesc">A decision grid with query shape on one axis and projection reuse — requests divided by graph changes — on the other. Point-to-point queries against a rapidly changing graph fall clearly to Cypher, because the projection would be rebuilt more often than it is used. The same shape against a stable graph at high volume falls to GDS. Many-to-many and whole-graph shapes fall to GDS at every reuse level, because one projection serves the entire result. A band across the middle marks the region where the reuse count is between five and ten and the constants genuinely decide, which is the only place a benchmark answers a question rather than confirming one.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="320" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Shape × reuse — the answer is usually already decided</text>
  <text x="150" y="52" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-ink-mute,#565f6d)">query shape</text>
  <text x="330" y="52" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-ink-mute,#565f6d)">&lt; 5 reuses</text>
  <text x="480" y="52" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-ink-mute,#565f6d)">5–10</text>
  <text x="640" y="52" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-ink-mute,#565f6d)">&gt; 10 reuses</text>
  <rect x="24" y="60" width="732" height="52" rx="8" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1.2"/>
  <text x="44" y="82" font-size="11" font-weight="700" fill="currentColor">point-to-point</text>
  <text x="44" y="100" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">one source, one target</text>
  <g font-size="10" font-weight="700" text-anchor="middle">
    <rect x="270" y="74" width="120" height="24" rx="12" fill="var(--accent-3,#5b21b6)"/><text x="330" y="91" fill="var(--viz-on-pill,#ffffff)">Cypher</text>
    <rect x="420" y="74" width="120" height="24" rx="12" fill="var(--viz-ok,#7d6200)"/><text x="480" y="91" fill="var(--viz-on-pill,#ffffff)">measure</text>
    <rect x="580" y="74" width="120" height="24" rx="12" fill="var(--viz-good,#0a656d)"/><text x="640" y="91" fill="var(--viz-on-pill,#ffffff)">GDS</text>
  </g>
  <rect x="24" y="120" width="732" height="52" rx="8" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1.2"/>
  <text x="44" y="142" font-size="11" font-weight="700" fill="currentColor">one-to-many</text>
  <text x="44" y="160" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">isochrones, service areas</text>
  <g font-size="10" font-weight="700" text-anchor="middle">
    <rect x="270" y="134" width="120" height="24" rx="12" fill="var(--viz-ok,#7d6200)"/><text x="330" y="151" fill="var(--viz-on-pill,#ffffff)">measure</text>
    <rect x="420" y="134" width="120" height="24" rx="12" fill="var(--viz-good,#0a656d)"/><text x="480" y="151" fill="var(--viz-on-pill,#ffffff)">GDS</text>
    <rect x="580" y="134" width="120" height="24" rx="12" fill="var(--viz-good,#0a656d)"/><text x="640" y="151" fill="var(--viz-on-pill,#ffffff)">GDS</text>
  </g>
  <rect x="24" y="180" width="732" height="52" rx="8" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="1.6"/>
  <text x="44" y="202" font-size="11" font-weight="700" fill="currentColor">many-to-many</text>
  <text x="44" y="220" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">fleet cost matrices</text>
  <g font-size="10" font-weight="700" text-anchor="middle">
    <rect x="270" y="194" width="120" height="24" rx="12" fill="var(--viz-good,#0a656d)"/><text x="330" y="211" fill="var(--viz-on-pill,#ffffff)">GDS</text>
    <rect x="420" y="194" width="120" height="24" rx="12" fill="var(--viz-good,#0a656d)"/><text x="480" y="211" fill="var(--viz-on-pill,#ffffff)">GDS</text>
    <rect x="580" y="194" width="120" height="24" rx="12" fill="var(--viz-good,#0a656d)"/><text x="640" y="211" fill="var(--viz-on-pill,#ffffff)">GDS</text>
  </g>
  <rect x="24" y="240" width="732" height="52" rx="8" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="1.6"/>
  <text x="44" y="262" font-size="11" font-weight="700" fill="currentColor">whole graph</text>
  <text x="44" y="280" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">centrality, components, communities</text>
  <g font-size="10" font-weight="700" text-anchor="middle">
    <rect x="270" y="254" width="120" height="24" rx="12" fill="var(--viz-good,#0a656d)"/><text x="330" y="271" fill="var(--viz-on-pill,#ffffff)">GDS</text>
    <rect x="420" y="254" width="120" height="24" rx="12" fill="var(--viz-good,#0a656d)"/><text x="480" y="271" fill="var(--viz-on-pill,#ffffff)">GDS</text>
    <rect x="580" y="254" width="120" height="24" rx="12" fill="var(--viz-good,#0a656d)"/><text x="640" y="271" fill="var(--viz-on-pill,#ffffff)">GDS</text>
  </g>
  <text x="24" y="312" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">A per-request cost function overrides the whole grid and sends everything to Cypher — no projection can be shared.</text>
</svg>

## Common Failure Patterns

**1. Benchmarking a warm projection against cold Cypher.** The commonest way to produce a misleading number. Timing `gds.shortestPath.stream` against a resident projection and comparing it with a Cypher traversal that includes its own first-execution compile measures two different things. The honest comparison brackets the [full projection lifecycle](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/neo4j-gds-vs-cypher-routing/benchmarking-gds-shortestpath-against-hand-written-cypher/) on one side and a warmed plan on the other.

**2. Treating "the graph changes" as binary.** What matters is whether the change affects the *projected* properties. A graph whose POI attributes update constantly but whose topology and travel times are weekly has a projection reuse count based on the weekly figure, not the constant one. Projecting only the properties the algorithm reads is what makes that distinction real rather than notional.

**3. Choosing once and never revisiting.** The reuse count is a ratio of two numbers that both move — request volume grows, and update frequency changes when a live traffic feed is added. A choice that was clearly right at launch can be clearly wrong two quarters later, with no code change to prompt a review. It is worth recording the ratio as a metric so the crossing is visible.

## Performance Notes

The break-even is a straightforward comparison of totals over the projection's lifetime:

$$n \cdot t_{\text{cypher}} \quad\text{vs}\quad t_{\text{project}} + n \cdot t_{\text{gds}}, \qquad n^{*} = \frac{t_{\text{project}}}{t_{\text{cypher}} - t_{\text{gds}}}$$

The useful thing about this form is that it makes the sensitivity obvious. $t_{\text{project}}$ scales with graph size, so a larger graph raises the break-even and pushes marginal cases toward Cypher. The denominator is the per-query saving, which is largest exactly where the search touches a lot of the graph — so one-to-many shapes reach break-even in a handful of requests while point-to-point shapes need hundreds.

Two architectural options change the arithmetic rather than sitting inside it. **A subgraph projection** — projecting one region rather than the country — cuts $t_{\text{project}}$ by an order of magnitude and can move a marginal case decisively, at the cost of a request that leaves the region failing to find a path. And **a scheduled rebuild with an atomic swap** decouples the projection's life from the update rate: rebuild nightly into a new named graph and swap, and the reuse count becomes requests-per-night regardless of how often the underlying data moves, at the cost of serving costs that are up to a day stale.

Where neither helps and the shape is point-to-point at high volume against a static graph, the answer is usually neither engine but a [contraction hierarchy](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/contraction-hierarchies-for-road-networks/), which pays a much larger preprocessing cost once and makes every subsequent query cheaper than either option here.

<svg viewBox="0 0 780 292" role="img" aria-labelledby="gdsBreakTitle gdsBreakDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="gdsBreakTitle">Cumulative cost against request count, and where the lines cross</title>
  <desc id="gdsBreakDesc">Cumulative time against the number of requests served by one projection. Cypher starts at zero and rises linearly at its per-query cost. GDS starts at the projection build cost and rises more slowly. The lines cross at the break-even request count — around 40 for a one-to-many shape where the per-query saving is large, and around 600 for a point-to-point shape where it is small. Below the crossing Cypher is cheaper in total; above it GDS is, and the gap then widens without limit.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="292" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Cumulative cost per projection lifetime</text>
  <line x1="96" y1="48" x2="96" y2="204" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <line x1="96" y1="204" x2="720" y2="204" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <g font-size="9.5" fill="var(--viz-ink-mute,#565f6d)" text-anchor="middle">
    <text x="96" y="224">0</text><text x="252" y="224">200</text><text x="408" y="224">400</text><text x="564" y="224">600</text><text x="720" y="224">800</text>
  </g>
  <text x="408" y="244" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">requests served by one projection</text>
  <text x="44" y="130" font-size="10" font-weight="700" fill="currentColor" transform="rotate(-90 44 130)">total time</text>
  <line x1="96" y1="204" x2="720" y2="56" stroke="var(--accent-3,#5b21b6)" stroke-width="2.8"/>
  <text x="640" y="74" text-anchor="end" font-size="10" font-weight="700" fill="var(--accent-3,#5b21b6)">Cypher</text>
  <line x1="96" y1="150" x2="720" y2="118" stroke="var(--viz-good,#0a656d)" stroke-width="2.8"/>
  <text x="640" y="136" text-anchor="end" font-size="10" font-weight="700" fill="var(--viz-good,#0a656d)">GDS, point-to-point</text>
  <line x1="96" y1="150" x2="720" y2="176" stroke="var(--viz-good,#0a656d)" stroke-width="2.2" stroke-dasharray="7 5"/>
  <text x="640" y="192" text-anchor="end" font-size="10" font-weight="700" fill="var(--viz-good,#0a656d)">GDS, one-to-many</text>
  <circle cx="127" cy="197" r="5" fill="var(--viz-ok,#7d6200)"/>
  <text x="140" y="192" font-size="9.5" font-weight="700" fill="var(--viz-ok,#7d6200)">~40</text>
  <circle cx="524" cy="130" r="5" fill="var(--viz-ok,#7d6200)"/>
  <text x="480" y="120" font-size="9.5" font-weight="700" fill="var(--viz-ok,#7d6200)">~600</text>
  <text x="24" y="272" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">Same projection cost, same graph — the break-even moves by a factor of fifteen purely because the shape changed.</text>
</svg>

A final note on how this decision tends to be made in practice, which is worth naming because it is the most common failure of all. Teams pick an engine early, build around it, and the choice then defends itself: the code is written for that engine, the operational knowledge is about that engine, and revisiting means a rewrite. That is a reasonable reason to be slow to change, and a poor reason to never look — particularly since the ratio that decides it moves on its own.

The cheap hedge is to keep the routing call behind a narrow interface from the start. Both engines answer the same question and return the same shape of answer, so a single method taking a source, a target and a cost property covers the overwhelming majority of usage. With that boundary in place, switching is a configuration change and a benchmark rather than a project, which means the decision can be revisited when the numbers say so rather than when someone has budget for a migration. It also makes the comparison honest, because the same caller exercises both paths against the same graph — which is exactly the measurement the benchmark harness struggles to construct after the fact.

## Related

- [Neo4j GDS vs Cypher Routing](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/neo4j-gds-vs-cypher-routing/) — the comparison this procedure formalises.
- [Benchmarking GDS shortestPath Against Hand-Written Cypher](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/neo4j-gds-vs-cypher-routing/benchmarking-gds-shortestpath-against-hand-written-cypher/) — how to measure the band where the decision is genuinely open.
- [Many-to-Many Cost Matrices with Neo4j GDS](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/multi-modal-and-fleet-routing/many-to-many-cost-matrices-with-gds/) — the shape where the answer is never in doubt.
- [Tuning JVM Heap for GDS Projections](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-memory-and-storage-tuning/tuning-jvm-heap-for-gds-projections/) — the cost the reuse count is amortising.

This guide is part of [Neo4j GDS vs Cypher Routing](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/neo4j-gds-vs-cypher-routing/), within [Network Routing Algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/).
