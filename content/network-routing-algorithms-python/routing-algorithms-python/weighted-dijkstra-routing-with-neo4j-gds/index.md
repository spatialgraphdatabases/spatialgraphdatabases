---
pageTitle: Weighted Dijkstra with Neo4j GDS
title: Weighted Dijkstra Routing with Neo4j GDS
description: Projecting a weighted subgraph and running gds.shortestPath.dijkstra from async Python for single-source and one-to-many routing, with projection cleanup
slug: weighted-dijkstra-routing-with-neo4j-gds
type: article
breadcrumb: Dijkstra with GDS
datePublished: 2026-07-14
dateModified: 2026-07-14
---
# Weighted Dijkstra Routing with Neo4j GDS

When a route query needs weighted shortest paths at scale — a single source to one target, or a source to every reachable node as a cost surface — the hand-written traversal that round-trips per expanded node stops being the right tool. The Graph Data Science library runs a parallel, in-database Dijkstra over a projected in-memory graph, so the entire search happens on the server and only the result crosses the wire. The catch is the projection lifecycle: a projected graph is a named, heap-resident object that outlives the query, and getting its creation, reuse, and disposal wrong is how a routing service leaks memory until GDS refuses to project anything at all. This page runs `gds.shortestPath.dijkstra` and `gds.allShortestPaths.dijkstra` from async Python end to end — project a weighted subgraph, stream results, drop the projection — and contrasts it with the hand-written [A* implementation](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/routing-algorithms-python/implementing-astar-with-a-haversine-heuristic-in-python/). It is a focused companion to the [Routing Algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/routing-algorithms-python/) decision guide.

## Prerequisites & Versions

The GDS plugin must be installed on the server; the client side is the plain async driver calling `CALL gds.*` procedures, which keeps the whole flow in one async transaction model.

| Requirement | Minimum version | Note |
| --- | --- | --- |
| Python | 3.10+ | async/await, f-strings |
| Neo4j | 5.13+ | Native `point`, unique constraint on the node id |
| GDS plugin | 2.6+ | `gds.graph.project`, `gds.shortestPath.dijkstra` |
| neo4j (driver) | 5.x | `AsyncGraphDatabase` |

```bash
pip install "neo4j>=5.18"
```

The graph carries a scalar routing weight on each relationship — here `drive_s`, travel time in seconds — kept distinct from raw length, following the [node and edge spatial mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/) conventions. A unique constraint on the node id lets the anchor lookup seek the source and target before projection.

## Core Concept & Mechanism

GDS does not run over your stored graph. It runs over a **named projection**: a compressed, in-memory copy of a chosen node and relationship subset, materialised once and referenced by name across many algorithm calls. The relationship weight the algorithm minimises must be projected as a relationship *property* — Dijkstra reads it from the in-memory structure, never from the stored relationship. The lifecycle is always the same three moves: project the subgraph, run one or more algorithms against the named graph, drop the projection to reclaim the heap.

Two Dijkstra procedures cover the routing shapes:

- `gds.shortestPath.dijkstra` — one source to one target, returning the single optimal path and its `totalCost`.
- `gds.allShortestPaths.dijkstra` — one source to *every* reachable node, returning a cost surface: the optimal cost from the source to all targets in a single pass. This is the one-to-many case where a heuristic would have no single goal to bias toward, so Dijkstra, not A\*, is the correct algorithm.

<svg viewBox="4 -4 724 279" role="img" aria-labelledby="gds-dij-title gds-dij-desc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="gds-dij-title">From stored graph to a named GDS projection to a Dijkstra source-to-targets cost surface</title>
  <desc id="gds-dij-desc">Three stages left to right. First, the stored property graph of intersections and weighted segments. An arrow labelled gds.graph.project leads to the second stage, a named in-memory projection holding the same topology plus the drive_s weight. An arrow labelled dijkstra leads to the third stage, a cost surface: a source node radiates concentric cost rings, and three target nodes are annotated with their optimal costs from the source. Dropping the projection afterwards reclaims the heap.</desc>
  <defs>
    <marker id="gds-dij-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7.5" markerHeight="7.5" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <!-- Stage 1: stored graph -->
  <rect class="viz-backdrop" x="4" y="-4" width="724" height="279" fill="var(--viz-bg,#ffffff)"/>
  <text x="120" y="26" text-anchor="middle" font-size="12.5" font-weight="700" fill="currentColor">Stored graph</text>
  <rect x="20" y="40" width="200" height="196" rx="10" fill="var(--surface-2,#fff)" stroke="var(--line,#e5e0d2)" stroke-width="1.4"/>
  <g stroke="currentColor" stroke-width="1.5" opacity="0.5">
    <line x1="70" y1="90" x2="150" y2="80"/>
    <line x1="150" y1="80" x2="170" y2="150"/>
    <line x1="70" y1="90" x2="90" y2="170"/>
    <line x1="90" y1="170" x2="170" y2="150"/>
    <line x1="90" y1="170" x2="140" y2="205"/>
  </g>
  <g fill="var(--ink-soft,#455062)">
    <circle cx="70" cy="90" r="8"/> <circle cx="150" cy="80" r="8"/> <circle cx="170" cy="150" r="8"/> <circle cx="90" cy="170" r="8"/> <circle cx="140" cy="205" r="8"/>
  </g>
  <text x="120" y="228" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">:Intersection -[:SEGMENT {drive_s}]-></text>
  <!-- project arrow -->
  <line x1="222" y1="138" x2="286" y2="138" stroke="currentColor" stroke-width="1.8" marker-end="url(#gds-dij-arrow)"/>
  <text x="254" y="128" text-anchor="middle" font-size="9.5" fill="var(--accent,#0a656d)" font-weight="700">project</text>
  <!-- Stage 2: named projection -->
  <text x="380" y="26" text-anchor="middle" font-size="12.5" font-weight="700" fill="currentColor">Named projection</text>
  <rect x="292" y="60" width="176" height="150" rx="10" fill="var(--accent-3,#5b21b6)" opacity="0.1"/>
  <rect x="292" y="60" width="176" height="150" rx="10" fill="none" stroke="var(--accent-3,#5b21b6)" stroke-width="1.8"/>
  <text x="380" y="96" text-anchor="middle" font-size="12" font-weight="700" fill="var(--accent-3,#5b21b6)">'sf_road'</text>
  <text x="380" y="126" text-anchor="middle" font-size="10.5" fill="currentColor">in-memory copy</text>
  <text x="380" y="146" text-anchor="middle" font-size="10.5" fill="currentColor">weight: drive_s</text>
  <text x="380" y="176" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">heap-resident</text>
  <text x="380" y="192" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">until dropped</text>
  <!-- dijkstra arrow -->
  <line x1="470" y1="138" x2="522" y2="138" stroke="currentColor" stroke-width="1.8" marker-end="url(#gds-dij-arrow)"/>
  <text x="496" y="128" text-anchor="middle" font-size="9.5" fill="var(--accent,#0a656d)" font-weight="700">dijkstra</text>
  <!-- Stage 3: cost surface -->
  <text x="646" y="26" text-anchor="middle" font-size="12.5" font-weight="700" fill="currentColor">Cost surface</text>
  <circle cx="600" cy="150" r="86" fill="none" stroke="var(--accent,#0a656d)" stroke-width="1" stroke-dasharray="3 5" opacity="0.4"/>
  <circle cx="600" cy="150" r="56" fill="none" stroke="var(--accent,#0a656d)" stroke-width="1" stroke-dasharray="3 5" opacity="0.5"/>
  <circle cx="600" cy="150" r="28" fill="none" stroke="var(--accent,#0a656d)" stroke-width="1" stroke-dasharray="3 5" opacity="0.6"/>
  <circle cx="600" cy="150" r="10" fill="var(--accent-2,#a8380b)"/>
  <text x="600" y="153" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--viz-on-pill,#ffffff)">S</text>
  <g fill="var(--accent,#0a656d)">
    <circle cx="640" cy="122" r="7"/> <circle cx="558" cy="180" r="7"/> <circle cx="662" cy="196" r="7"/>
  </g>
  <g font-size="9.5" fill="currentColor" font-weight="600">
    <text x="654" y="112">210s</text>
    <text x="516" y="192">330s</text>
    <text x="676" y="210">540s</text>
  </g>
  <text x="646" y="256" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">optimal cost S → every target</text>
</svg>

## Implementation

The coroutine below projects a weighted subgraph, runs a point-to-point Dijkstra, then a one-to-many cost surface, and drops the projection in a `finally` block so a mid-query exception can never orphan the in-memory graph. The example routes across the San Francisco Bay Area.

```python
import asyncio
from neo4j import AsyncDriver, AsyncGraphDatabase

GRAPH_NAME = "sf_road"

PROJECT = """
CALL gds.graph.project(
  $graph,
  'Intersection',
  { SEGMENT: { properties: 'drive_s' } }
)
YIELD graphName, nodeCount, relationshipCount
RETURN graphName, nodeCount, relationshipCount
"""

POINT_TO_POINT = """
MATCH (src:Intersection {id: $src}), (dst:Intersection {id: $dst})
CALL gds.shortestPath.dijkstra.stream($graph, {
  sourceNode: src,
  targetNode: dst,
  relationshipWeightProperty: 'drive_s'
})
YIELD totalCost, nodeIds
RETURN totalCost AS cost_s,
       [nid IN nodeIds | gds.util.asNode(nid).id] AS route
"""

ONE_TO_MANY = """
MATCH (src:Intersection {id: $src})
CALL gds.allShortestPaths.dijkstra.stream($graph, {
  sourceNode: src,
  relationshipWeightProperty: 'drive_s'
})
YIELD targetNode, totalCost
RETURN gds.util.asNode(targetNode).id AS target_id, totalCost AS cost_s
ORDER BY cost_s ASC
LIMIT 25
"""

DROP = "CALL gds.graph.drop($graph, false) YIELD graphName RETURN graphName"


async def project_if_absent(session, graph: str) -> None:
    exists = await session.run("RETURN gds.graph.exists($graph) AS ok", graph=graph)
    if (await exists.single())["ok"]:
        return
    await (await session.run(PROJECT, graph=graph)).consume()


async def route_with_gds(driver: AsyncDriver, src: str, dst: str) -> dict:
    async with driver.session(database="neo4j") as session:
        await project_if_absent(session, GRAPH_NAME)
        try:
            p2p = await (await session.run(
                POINT_TO_POINT, graph=GRAPH_NAME, src=src, dst=dst)).single()
            surface = [rec.data() async for rec in await session.run(
                ONE_TO_MANY, graph=GRAPH_NAME, src=src)]
            return {
                "cost_s": p2p["cost_s"] if p2p else None,
                "route": p2p["route"] if p2p else [],
                "nearest_targets": surface,
            }
        finally:
            await (await session.run(DROP, graph=GRAPH_NAME)).consume()


async def main():
    driver = AsyncGraphDatabase.driver(
        "neo4j://localhost:7687", auth=("neo4j", "secure-password"),
        max_connection_pool_size=20, connection_acquisition_timeout=15.0,
    )
    try:
        # Ferry Building -> Oracle Park, San Francisco
        result = await route_with_gds(driver, "I-sf-embarcadero", "I-sf-mission-bay")
        if result["cost_s"] is not None:
            print(f"Fastest path: {result['cost_s'] / 60:.1f} min, "
                  f"{len(result['route'])} intersections")
        print(f"Reachable-target sample: {len(result['nearest_targets'])} rows")
    finally:
        await driver.close()


if __name__ == "__main__":
    asyncio.run(main())
```

## How It Works

- **Projection is idempotent by guard, not by default.** `gds.graph.project` errors if a graph of that name already exists, so `project_if_absent` checks `gds.graph.exists` first. In a long-lived service you typically project once at startup for a stable graph and skip the per-request project/drop cycle entirely — reproject only when the topology or weights change.
- **The weight is a projected property.** `{ SEGMENT: { properties: 'drive_s' } }` copies `drive_s` into the in-memory relationships, and `relationshipWeightProperty: 'drive_s'` tells Dijkstra to minimise it. Omit either half and the algorithm silently treats every edge as weight `1.0`, returning a hop-optimal path dressed up as a cost-optimal one.
- **Streaming keeps results off the server heap.** The `.stream` mode yields rows straight to the driver rather than writing back to the graph, and the async `async for` consumes them incrementally. `gds.util.asNode(nid).id` translates the internal node id GDS returns back into your application id.
- **The projection is dropped in `finally`.** `gds.graph.drop($graph, false)` — the `false` means "do not fail if absent" — runs whether or not the query succeeded, so an exception cannot leave a multi-gigabyte projection stranded on the heap.

Where the hand-written [A* search](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/routing-algorithms-python/implementing-astar-with-a-haversine-heuristic-in-python/) pays one network round trip per expanded node and lets you shape the cost function in Python per request, GDS pays a one-time projection cost and then runs the entire search server-side in parallel. A\* wins on a single point-to-point query with a custom or dynamic cost function; GDS wins decisively on one-to-many cost surfaces and on high query volume against a stable graph, where the projection amortises. The measured crossover is laid out in [Neo4j GDS vs Custom Cypher Routing](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/neo4j-gds-vs-cypher-routing/).

<svg viewBox="0 0 780 306" role="img" aria-labelledby="gwTitle gwDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="gwTitle">Both halves of the weight wiring have to be present, or every edge costs 1.0</title>
  <desc id="gwDesc">A truth table over the two independent settings. Projecting the drive_s property without naming relationshipWeightProperty, naming it without projecting the property, or omitting both, all produce the same outcome: Dijkstra treats every relationship as weight 1.0 and returns the path with the fewest hops, presented as though it were cost-optimal. Only when the property is projected and named does the search minimise drive_s. Nothing in the result distinguishes the three failing cases from the working one.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="306" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Two independent settings, one silent failure mode</text>
  <text x="196" y="52" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">properties: 'drive_s'</text>
  <text x="196" y="66" text-anchor="middle" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">in the projection</text>
  <text x="392" y="52" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">relationshipWeightProperty</text>
  <text x="392" y="66" text-anchor="middle" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">in the algorithm call</text>
  <text x="620" y="52" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">what Dijkstra minimises</text>
  <g font-size="12" font-weight="700" text-anchor="middle">
    <rect x="24" y="80" width="732" height="46" rx="8" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-poor,#a8320f)" stroke-width="1.5"/>
    <rect x="150" y="92" width="92" height="24" rx="12" fill="var(--viz-poor,#a8320f)"/><text x="196" y="109" font-size="10.5" fill="var(--viz-on-pill,#ffffff)">absent</text>
    <rect x="346" y="92" width="92" height="24" rx="12" fill="var(--viz-poor,#a8320f)"/><text x="392" y="109" font-size="10.5" fill="var(--viz-on-pill,#ffffff)">absent</text>
    <text x="620" y="103" font-size="11" fill="var(--viz-poor,#a8320f)">hop count — weight 1.0 per edge</text>
    <text x="620" y="118" font-size="9.5" font-weight="400" fill="var(--viz-ink-mute,#565f6d)">returns a path, no warning</text>
    <rect x="24" y="134" width="732" height="46" rx="8" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-poor,#a8320f)" stroke-width="1.5"/>
    <rect x="150" y="146" width="92" height="24" rx="12" fill="var(--viz-good,#0a656d)"/><text x="196" y="163" font-size="10.5" fill="var(--viz-on-pill,#ffffff)">present</text>
    <rect x="346" y="146" width="92" height="24" rx="12" fill="var(--viz-poor,#a8320f)"/><text x="392" y="163" font-size="10.5" fill="var(--viz-on-pill,#ffffff)">absent</text>
    <text x="620" y="157" font-size="11" fill="var(--viz-poor,#a8320f)">hop count — the property is loaded but unused</text>
    <text x="620" y="172" font-size="9.5" font-weight="400" fill="var(--viz-ink-mute,#565f6d)">costs memory and changes nothing</text>
    <rect x="24" y="188" width="732" height="46" rx="8" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-poor,#a8320f)" stroke-width="1.5"/>
    <rect x="150" y="200" width="92" height="24" rx="12" fill="var(--viz-poor,#a8320f)"/><text x="196" y="217" font-size="10.5" fill="var(--viz-on-pill,#ffffff)">absent</text>
    <rect x="346" y="200" width="92" height="24" rx="12" fill="var(--viz-good,#0a656d)"/><text x="392" y="217" font-size="10.5" fill="var(--viz-on-pill,#ffffff)">present</text>
    <text x="620" y="211" font-size="11" fill="var(--viz-poor,#a8320f)">hop count — the named property is not there</text>
    <text x="620" y="226" font-size="9.5" font-weight="400" fill="var(--viz-ink-mute,#565f6d)">the likeliest of the three to be written</text>
    <rect x="24" y="242" width="732" height="46" rx="8" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="2"/>
    <rect x="150" y="254" width="92" height="24" rx="12" fill="var(--viz-good,#0a656d)"/><text x="196" y="271" font-size="10.5" fill="var(--viz-on-pill,#ffffff)">present</text>
    <rect x="346" y="254" width="92" height="24" rx="12" fill="var(--viz-good,#0a656d)"/><text x="392" y="271" font-size="10.5" fill="var(--viz-on-pill,#ffffff)">present</text>
    <text x="620" y="265" font-size="11" fill="var(--viz-good,#0a656d)">drive_s — the cost-optimal path</text>
    <text x="620" y="280" font-size="9.5" font-weight="400" fill="var(--viz-ink-mute,#565f6d)">the only wiring that means what it says</text>
  </g>
</svg>

## Common Failure Patterns

**1. Projection memory blowup.** A projection is a heap object sized to its node and relationship count plus every projected property. Projecting the *entire* graph when a query only needs one metro area can exhaust GDS's heap and make the next `project` call fail outright. Project a subgraph, not the world — filter with a node label or a Cypher projection scoped to a region — and monitor `gds.graph.list` for projections that should have been dropped.

```cypher
// Scope the projection to a region instead of the whole graph
MATCH (n:Intersection)-[r:SEGMENT]->(m:Intersection)
WHERE n.metro = $metro AND m.metro = $metro
RETURN gds.graph.project($graph, n, m, { relationshipProperties: r { .drive_s } })
```

**2. Stale projection after a write.** The projection is a snapshot. Update `drive_s` on the stored graph — a traffic re-weighting, a closed road — and every subsequent Dijkstra over the old projection returns costs for the *previous* state, with no error to signal it. Treat the projection as a cache keyed on a topology/weight version and drop-and-reproject on any write that touches routing weights.

```python
async def refresh_projection(session, graph: str) -> None:
    await session.run(DROP, graph=graph)          # drop stale snapshot
    await session.run(PROJECT, graph=graph)       # reproject current weights
```

**3. Missing relationship weight property.** If `relationshipWeightProperty` names a property that was not projected (or is misspelled), GDS does not error — it falls back to treating all relationships as unit-weight, so Dijkstra returns the hop-optimal path and the total cost is a count of edges, not seconds. The tell is a `totalCost` that is a small integer. Always assert the property is in the projection and that returned costs are in the expected unit and magnitude.

## Performance Notes

The cost model has two distinct terms: a one-time projection cost proportional to the projected node and relationship count, and a per-query Dijkstra cost. Amortised over $q$ queries against one projection, the effective per-query cost is

$$C_{\text{eff}} = \frac{C_{\text{project}}}{q} + C_{\text{query}},$$

so the project/drop-per-request pattern shown above — chosen here for a self-contained example — is the *worst* case: it pays $C_{\text{project}}$ on every single query ($q = 1$). In production, project once and reuse across thousands of queries so $C_{\text{project}}/q$ vanishes and only the parallel Dijkstra cost remains. The one-to-many `allShortestPaths` call is where GDS earns its keep: computing a full cost surface from one source is a single Dijkstra sweep, whereas the hand-written approach would need one search per target.

Size the projection against available heap before serving traffic — a projection that spills is worse than no projection. When a query only ever touches a bounded corridor, a [distance-filtered](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/) subgraph projection keeps the in-memory footprint proportional to the region you actually route within, not the whole network.

## Related

- [Routing Algorithms in Python: Dijkstra, A*, and Contraction Hierarchies](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/routing-algorithms-python/) — where GDS Dijkstra sits among the alternatives.
- [Implementing A* with a Haversine Heuristic in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/routing-algorithms-python/implementing-astar-with-a-haversine-heuristic-in-python/) — the client-side counterpart with a custom cost function.
- [Neo4j GDS vs Custom Cypher Routing](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/neo4j-gds-vs-cypher-routing/) — the benchmark deciding when the projection cost is worth paying.
- [Distance Filter Query Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/) — scoping the projected subgraph to a bounded region.

This guide is part of [Routing Algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/routing-algorithms-python/), within the [Network Routing Algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/) section.

For authoritative procedure signatures and configuration, consult the [Neo4j GDS Dijkstra source-target documentation](https://neo4j.com/docs/graph-data-science/current/algorithms/dijkstra-source-target/) and the [GDS graph projection reference](https://neo4j.com/docs/graph-data-science/current/management-ops/graph-creation/).
