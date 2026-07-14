---
pageTitle: Neo4j GDS vs Cypher Routing
title: "Neo4j GDS vs Custom Cypher Routing: When to Use Each"
description: A production decision guide for choosing Neo4j GDS in-memory path algorithms over live Cypher traversal, weighing projection cost, freshness, memory, and ops surface
slug: neo4j-gds-vs-cypher-routing
type: guide
breadcrumb: GDS vs Cypher Routing
datePublished: 2026-07-14
dateModified: 2026-07-14
---
# Neo4j GDS vs Custom Cypher Routing: When to Use Each

Two teams ship the same feature — "shortest route between two depots" — and both are technically correct, yet one endpoint answers in four milliseconds and the other spends eight hundred milliseconds rebuilding an in-memory graph on every request. The gap is not skill; it is a choice made without a cost model. The Graph Data Science library gives you a projected in-memory copy of the graph and industrial-strength algorithms (`gds.shortestPath.dijkstra`, `gds.allShortestPaths.*`, Yen's k-shortest, Steiner tree) that run on that copy at raw-CPU speed. Hand-written Cypher — `shortestPath()`, a bounded variable-length `MATCH`, or `apoc.path` expansion — walks the live committed graph directly, transactionally, always current. Neither is "faster" in the abstract. GDS is faster *per query once the projection exists*; Cypher is faster *per request when the projection would have to be rebuilt or would go stale*. This guide gives you the projection cost model, the memory and freshness trade-offs, and a runnable async harness that runs both against the same graph so you can see the crossover on your own data. It is one of the core decisions in [Network Routing Algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/).

<svg viewBox="0 0 760 384" role="img" aria-labelledby="dmTitle dmDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="dmTitle">Decision matrix comparing GDS projected routing against live Cypher traversal across four axes</title>
  <desc id="dmDesc">A four-row matrix. Rows are graph size and reuse, freshness, query shape, and operational cost; columns are GDS projected in-memory routing and live Cypher traversal. GDS wins on graph size and reuse, and on global query shapes such as all-pairs and Yen k-shortest. Cypher wins on freshness because it reads the live committed graph, and on operational cost because it needs no in-memory copy or projection lifecycle.</desc>
  <!-- winner tints -->
  <rect x="280" y="100" width="215" height="60" fill="var(--accent,#0a656d)" opacity="0.08"/>
  <rect x="505" y="162" width="215" height="60" fill="var(--accent-3,#5b21b6)" opacity="0.08"/>
  <rect x="280" y="224" width="215" height="60" fill="var(--accent,#0a656d)" opacity="0.08"/>
  <rect x="505" y="286" width="215" height="60" fill="var(--accent-3,#5b21b6)" opacity="0.08"/>
  <!-- header -->
  <rect x="280" y="52" width="215" height="44" rx="6" fill="var(--accent,#0a656d)" opacity="0.12"/>
  <rect x="505" y="52" width="215" height="44" rx="6" fill="var(--accent-3,#5b21b6)" opacity="0.12"/>
  <text x="388" y="72" text-anchor="middle" font-size="14" font-weight="700" fill="var(--accent,#0a656d)">GDS</text>
  <text x="388" y="88" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.8">projected in-memory</text>
  <text x="612" y="72" text-anchor="middle" font-size="14" font-weight="700" fill="var(--accent-3,#5b21b6)">Cypher</text>
  <text x="612" y="88" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.8">live committed graph</text>
  <text x="52" y="80" font-size="10" font-weight="700" fill="currentColor" opacity="0.6">DECISION AXIS</text>
  <!-- grid -->
  <g stroke="currentColor" stroke-width="1" opacity="0.18">
    <line x1="40" y1="100" x2="720" y2="100"/>
    <line x1="40" y1="162" x2="720" y2="162"/>
    <line x1="40" y1="224" x2="720" y2="224"/>
    <line x1="40" y1="286" x2="720" y2="286"/>
    <line x1="40" y1="346" x2="720" y2="346"/>
    <line x1="280" y1="100" x2="280" y2="346"/>
    <line x1="505" y1="100" x2="505" y2="346"/>
  </g>
  <!-- row labels -->
  <g font-size="12.5" font-weight="700" fill="currentColor">
    <text x="52" y="126">Graph size &amp; reuse</text>
    <text x="52" y="188">Freshness</text>
    <text x="52" y="250">Query shape</text>
    <text x="52" y="312">Operational cost</text>
  </g>
  <g font-size="10" fill="currentColor" opacity="0.62">
    <text x="52" y="143">big graph, queried often?</text>
    <text x="52" y="205">staleness tolerance</text>
    <text x="52" y="267">single-pair vs global</text>
    <text x="52" y="329">memory · license · ops</text>
  </g>
  <!-- R1 -->
  <g font-size="10.5" fill="var(--accent,#0a656d)">
    <text x="292" y="122">&#10003; Large graph, many</text>
    <text x="292" y="137">repeated queries —</text>
    <text x="292" y="152">projection amortizes</text>
  </g>
  <g font-size="10.5" fill="currentColor" opacity="0.72">
    <text x="517" y="126">Only when small,</text>
    <text x="517" y="141">local, one-off</text>
  </g>
  <!-- R2 -->
  <g font-size="10.5" fill="currentColor" opacity="0.72">
    <text x="292" y="186">Snapshot — stale</text>
    <text x="292" y="201">until re-projected</text>
  </g>
  <g font-size="10.5" fill="var(--accent-3,#5b21b6)">
    <text x="517" y="182">&#10003; Always fresh,</text>
    <text x="517" y="197">reads the live</text>
    <text x="517" y="212">committed graph</text>
  </g>
  <!-- R3 -->
  <g font-size="10.5" fill="var(--accent,#0a656d)">
    <text x="292" y="246">&#10003; Global: all-pairs,</text>
    <text x="292" y="261">Yen k-shortest,</text>
    <text x="292" y="276">Steiner tree</text>
  </g>
  <g font-size="10.5" fill="currentColor" opacity="0.72">
    <text x="517" y="250">Bounded single-pair,</text>
    <text x="517" y="265">small hop count</text>
  </g>
  <!-- R4 -->
  <g font-size="10.5" fill="currentColor" opacity="0.72">
    <text x="292" y="308">In-RAM copy +</text>
    <text x="292" y="323">license + project/</text>
    <text x="292" y="338">drop lifecycle</text>
  </g>
  <g font-size="10.5" fill="var(--accent-3,#5b21b6)">
    <text x="517" y="306">&#10003; No extra memory,</text>
    <text x="517" y="321">no projection</text>
    <text x="517" y="336">to manage</text>
  </g>
  <!-- legend -->
  <g font-size="10.5" fill="currentColor">
    <rect x="280" y="360" width="12" height="12" rx="2" fill="var(--accent,#0a656d)" opacity="0.55"/>
    <text x="298" y="370">GDS favored</text>
    <rect x="420" y="360" width="12" height="12" rx="2" fill="var(--accent-3,#5b21b6)" opacity="0.55"/>
    <text x="438" y="370">Cypher favored</text>
  </g>
</svg>

## Prerequisites

These examples target a Neo4j 5.x instance with the GDS plugin installed and native `point` support, driven from an async Python service. GDS ships as a server plugin; confirm it is loaded with `RETURN gds.version()` before projecting anything. The Cypher side needs no plugin at all.

| Requirement | Minimum version | Notes |
| --- | --- | --- |
| Python | 3.10+ | Structural typing and `match` used below |
| Neo4j | 5.13+ | Native `point`, `CALL {}` subqueries, index-backed range predicates |
| neo4j (driver) | 5.x | Async driver (`AsyncGraphDatabase`), native point serialization |
| Graph Data Science | 2.6+ | `gds.graph.project`, `gds.shortestPath.dijkstra.stream`, `gds.util.asNode` |
| pytest / pytest-asyncio | 0.23+ | For the equivalence assertion in testing |

```bash
pip install "neo4j>=5.18" "pytest>=8.0" "pytest-asyncio>=0.23"
```

This decision assumes your graph already follows sound [node and edge spatial mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/) conventions — a stable `id`, coordinates as native `point`, and a numeric traversal `weight` (here `travel_s`) kept distinct from raw geometric length. Both engines route on that weight; the modeling underneath is identical, which is exactly why the choice is about execution strategy rather than schema.

## Core Concept & Mechanism

GDS and Cypher solve the shortest-path problem in two different places. Cypher runs the search *inside the transactional store*: it seeks the source node through an index, then expands relationships straight off the page cache, reading the same committed records every other query sees. There is no build step and no copy — the cost you pay is the traversal itself, every single time, walking pointer-chased records that may or may not be resident in memory.

GDS runs the search *inside a separate columnar in-memory structure* called a graph projection. `gds.graph.project` reads the nodes and relationships you name once, compacts them into contiguous integer-id arrays optimized for iteration, and parks that structure in the heap. Algorithms then run over the projection at cache-friendly speed — no index seeks, no record deserialization, no transaction bookkeeping per hop. The catch is that the projection is a *point-in-time snapshot*. Anything committed to the live graph after `project` returns is invisible to the algorithm until you rebuild it. You have traded freshness and memory for per-query throughput.

That trade is the entire decision. GDS front-loads a fixed cost — the projection build — and then serves cheap queries against a frozen copy. Cypher pays nothing up front and a moderate cost per query against the live graph. The amortized cost per query for GDS is the projection cost spread across the number of queries served before the snapshot is discarded, plus the per-query algorithm time:

$$C_\text{GDS} = \frac{T_\text{project} + T_\text{drop}}{N} + t_\text{algo}, \qquad C_\text{Cypher} = t_\text{cypher}$$

where $N$ is the number of routing queries served from one projection. When $N$ is large, the first term vanishes and GDS wins decisively. When $N$ is one — a single ad-hoc route on a graph that changes constantly — the projection cost lands entirely on that one request and Cypher wins. The crossover point $N^{*}$ is where the two are equal; measuring it on your graph is the subject of [benchmarking GDS shortestPath against hand-written Cypher](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/neo4j-gds-vs-cypher-routing/benchmarking-gds-shortestpath-against-hand-written-cypher/).

<svg viewBox="0 0 780 320" role="img" aria-labelledby="flowTitle flowDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="flowTitle">Projected-snapshot data flow versus live-graph traversal</title>
  <desc id="flowDesc">Top lane, GDS: the committed graph is copied by gds.graph.project into an in-memory projection on the heap, then dijkstra.stream produces a weight-optimal path and cost; a note warns that writes committed after project stay invisible until re-projection. Bottom lane, Cypher: the same committed graph is traversed live by shortestPath or a bounded variable-length match, ordered by cost, producing a path and cost with no copy and always current results.</desc>
  <defs>
    <marker id="gcArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <text x="20" y="22" font-size="14" font-weight="700" fill="currentColor">Projected snapshot vs live-graph traversal</text>
  <!-- GDS lane -->
  <text x="20" y="46" font-size="11.5" font-weight="700" fill="var(--accent,#0a656d)">GDS — project once, then stream many queries</text>
  <g font-size="9.5" fill="currentColor" opacity="0.7" text-anchor="middle">
    <text x="173" y="64">gds.graph.project</text>
    <text x="402" y="64">dijkstra.stream</text>
  </g>
  <g>
    <rect x="20" y="72" width="112" height="56" rx="8" fill="none" stroke="var(--ink-soft,#455062)" stroke-width="1.6"/>
    <rect x="214" y="72" width="150" height="56" rx="8" fill="var(--accent,#0a656d)" opacity="0.06"/>
    <rect x="214" y="72" width="150" height="56" rx="8" fill="none" stroke="var(--accent,#0a656d)" stroke-width="1.8"/>
    <rect x="440" y="72" width="150" height="56" rx="8" fill="none" stroke="var(--accent,#0a656d)" stroke-width="1.6"/>
    <rect x="648" y="72" width="112" height="56" rx="8" fill="none" stroke="var(--accent-2,#a8380b)" stroke-width="1.6"/>
  </g>
  <g font-size="11.5" text-anchor="middle" fill="currentColor">
    <text x="76" y="96">Committed</text><text x="76" y="112">graph</text>
    <text x="289" y="94">In-memory</text><text x="289" y="109">projection</text><text x="289" y="123" font-size="9.5" opacity="0.7">(heap copy)</text>
    <text x="515" y="96">Weight-optimal</text><text x="515" y="112">path</text>
    <text x="704" y="104">Path + cost</text>
  </g>
  <g stroke="currentColor" stroke-width="1.7" marker-end="url(#gcArrow)">
    <line x1="132" y1="100" x2="212" y2="100"/>
    <line x1="364" y1="100" x2="438" y2="100"/>
    <line x1="590" y1="100" x2="646" y2="100"/>
  </g>
  <text x="390" y="150" text-anchor="middle" font-size="10" fill="var(--accent-2,#a8380b)">Writes committed after project() stay invisible until you re-project</text>
  <!-- Cypher lane -->
  <text x="20" y="188" font-size="11.5" font-weight="700" fill="var(--accent-3,#5b21b6)">Cypher — read the live committed graph</text>
  <g font-size="9.5" fill="currentColor" opacity="0.7" text-anchor="middle">
    <text x="192" y="206">shortestPath() / *1..k</text>
    <text x="457" y="206">order by cost</text>
  </g>
  <g>
    <rect x="20" y="214" width="112" height="56" rx="8" fill="none" stroke="var(--ink-soft,#455062)" stroke-width="1.6"/>
    <rect x="252" y="214" width="176" height="56" rx="8" fill="var(--accent-3,#5b21b6)" opacity="0.06"/>
    <rect x="252" y="214" width="176" height="56" rx="8" fill="none" stroke="var(--accent-3,#5b21b6)" stroke-width="1.8"/>
    <rect x="486" y="214" width="112" height="56" rx="8" fill="none" stroke="var(--accent-2,#a8380b)" stroke-width="1.6"/>
  </g>
  <g font-size="11.5" text-anchor="middle" fill="currentColor">
    <text x="76" y="238">Committed</text><text x="76" y="254">graph</text>
    <text x="340" y="238">Live bounded</text><text x="340" y="254">traversal</text>
    <text x="542" y="246">Path + cost</text>
  </g>
  <g stroke="currentColor" stroke-width="1.7" marker-end="url(#gcArrow)">
    <line x1="132" y1="242" x2="250" y2="242"/>
    <line x1="428" y1="242" x2="484" y2="242"/>
  </g>
  <text x="662" y="238" font-size="10" fill="currentColor" opacity="0.75">no copy,</text>
  <text x="662" y="252" font-size="10" fill="var(--accent-3,#5b21b6)" font-weight="600">always current</text>
</svg>

## Schema & Data Model

Both engines route over the same physical graph, so there is exactly one schema to maintain. Store coordinates as a native `point` for the anchor lookup, keep the traversal weight numeric and separate, and index the property Cypher seeks on.

```cypher
// Anchor lookup — lets Cypher (and the GDS project MATCH) seek the endpoints
CREATE INDEX road_node_id IF NOT EXISTS
FOR (n:RoadNode) ON (n.id);

// Native point index — bounds any distance pre-filter on either engine
CREATE POINT INDEX road_node_location IF NOT EXISTS
FOR (n:RoadNode) ON (n.location);
```

```cypher
// Representative shape both engines route over
// (:RoadNode {id, location: point({srid:4326, latitude, longitude})})
//   -[:CONNECTED_TO {length_m, travel_s}]->
// (:RoadNode)
// travel_s is the routing weight; length_m stays distinct so a
// distance filter and a cost-weighted path never get conflated.
```

The one schema rule that matters for the GDS side: the property you pass as `relationshipWeightProperty` must be a stored numeric on the relationship, because the projection reads it once at build time. A weight computed on the fly in Cypher (`reduce()` over segment distances, a time-of-day multiplier) has no equivalent in a plain projection — you would have to bake it into a stored property first, or use a Cypher projection to derive it. That constraint is a frequent tie-breaker: dynamic, request-time weights lean toward Cypher.

## Step-by-Step Implementation

We build a single async module that answers the same routing question **both ways** against the same driver, so the two results — and their costs — sit side by side. The GDS path projects, streams Dijkstra, and drops; the Cypher path runs a bounded live traversal.

### 1. Project the graph and stream Dijkstra through GDS

The projection names one node label and one relationship type, carrying `travel_s` as the weight. `dijkstra.stream` returns the ordered internal node ids, which `gds.util.asNode` maps back to your stable `id`.

```python
import asyncio
from neo4j import AsyncGraphDatabase

GDS_PROJECT = """
CALL gds.graph.project(
  $graph_name,
  'RoadNode',
  { CONNECTED_TO: { properties: 'travel_s' } }
)
YIELD graphName, nodeCount, relationshipCount
RETURN graphName, nodeCount, relationshipCount
"""

GDS_DIJKSTRA = """
MATCH (src:RoadNode {id: $src_id}), (dst:RoadNode {id: $dst_id})
CALL gds.shortestPath.dijkstra.stream($graph_name, {
    sourceNode: src,
    targetNode: dst,
    relationshipWeightProperty: 'travel_s'
})
YIELD totalCost, nodeIds
RETURN totalCost AS cost,
       [nid IN nodeIds | gds.util.asNode(nid).id] AS node_path
"""

GDS_DROP = "CALL gds.graph.drop($graph_name, false) YIELD graphName RETURN graphName"


async def route_with_gds(driver, graph_name, src_id, dst_id):
    async with driver.session(database="neo4j") as session:
        await session.run(GDS_PROJECT, graph_name=graph_name)
        try:
            result = await session.run(
                GDS_DIJKSTRA, graph_name=graph_name, src_id=src_id, dst_id=dst_id
            )
            record = await result.single()
            return None if record is None else {
                "cost": record["cost"], "path": record["node_path"]
            }
        finally:
            # Always drop the projection — a leaked projection holds heap forever.
            await session.run(GDS_DROP, graph_name=graph_name)
```

### 2. Run the equivalent bounded traversal in live Cypher

The built-in `shortestPath()` returns the *fewest-hop* path, not the least-weight one, so for a true Dijkstra equivalent we expand a bounded variable-length path, sum `travel_s`, and take the cheapest. The `*1..15` cap is load-bearing: an unbounded star materializes the whole connected component.

```python
CYPHER_ROUTE = """
MATCH (src:RoadNode {id: $src_id}), (dst:RoadNode {id: $dst_id})
MATCH path = (src)-[:CONNECTED_TO*1..15]->(dst)
WITH path, reduce(c = 0.0, r IN relationships(path) | c + r.travel_s) AS total_s
RETURN total_s AS cost, [n IN nodes(path) | n.id] AS node_path
ORDER BY cost ASC
LIMIT 1
"""


async def route_with_cypher(driver, src_id, dst_id):
    async with driver.session(database="neo4j") as session:
        result = await session.run(CYPHER_ROUTE, src_id=src_id, dst_id=dst_id)
        record = await result.single()
        return None if record is None else {
            "cost": record["cost"], "path": record["node_path"]
        }
```

### 3. Run both against one pooled driver and compare

A single pooled async driver serves both. Printing the two answers together is the fastest way to catch a semantic mismatch (see the hop-count caveat below) before it reaches production.

```python
async def main():
    driver = AsyncGraphDatabase.driver(
        "neo4j+s://your-cluster.databases.neo4j.io",
        auth=("neo4j", "secure-password"),
        max_connection_pool_size=40,
        connection_acquisition_timeout=5.0,
    )
    try:
        gds_route = await route_with_gds(driver, "route_g", "N-1001", "N-2087")
        cypher_route = await route_with_cypher(driver, "N-1001", "N-2087")
        print(f"GDS    cost={gds_route['cost']:.1f}s  hops={len(gds_route['path']) - 1}")
        print(f"Cypher cost={cypher_route['cost']:.1f}s  hops={len(cypher_route['path']) - 1}")
    finally:
        await driver.close()


if __name__ == "__main__":
    asyncio.run(main())
```

Run this once and the trade is concrete: on a cold graph the GDS call spends most of its wall time in `GDS_PROJECT`, while the Cypher call returns immediately. Run it in a loop reusing one projection and the GDS per-query time collapses far below Cypher's. That is the amortization curve, made visible.

## Query Patterns & Variants

The choice is rarely "GDS everywhere" or "Cypher everywhere." Match the pattern to the query shape.

**Variant A — persistent projection, many queries.** When routing is a hot path served thousands of times between graph updates, project *once* out of band (on deploy, or on a schedule) and let every request stream against the resident projection. This is where GDS is unbeatable, because the projection cost is amortized to nearly zero.

```cypher
// Streamed against an already-resident named projection — no rebuild per request
MATCH (src:RoadNode {id: $src_id}), (dst:RoadNode {id: $dst_id})
CALL gds.shortestPath.dijkstra.stream('road_network', {
    sourceNode: src, targetNode: dst, relationshipWeightProperty: 'travel_s'
})
YIELD totalCost, nodeIds
RETURN totalCost, [nid IN nodeIds | gds.util.asNode(nid).id] AS path
// Rebuild 'road_network' only when the underlying graph changes materially.
```

**Variant B — bounded live traversal, always fresh.** When the answer must reflect the latest committed edge (a road just closed, a depot just opened) and the search radius is small, live Cypher is both simpler and correct-by-construction. There is nothing to invalidate.

```cypher
MATCH (src:RoadNode {id: $src_id}), (dst:RoadNode {id: $dst_id})
MATCH path = (src)-[:CONNECTED_TO*1..10]->(dst)
WITH path, reduce(c = 0.0, r IN relationships(path) | c + r.travel_s) AS cost
RETURN [n IN nodes(path) | n.id] AS path, cost
ORDER BY cost LIMIT 1
// Bound the hop count; pair with a bounding-box endpoint filter for wide graphs.
```

**Variant C — fewest-hops, not least-weight.** When "shortest" genuinely means fewest edges (fewest transfers, minimum-hop reachability), the built-in `shortestPath()` is the right primitive and far cheaper than a weighted expansion — but do not confuse it with Dijkstra.

```cypher
MATCH (src:RoadNode {id: $src_id}), (dst:RoadNode {id: $dst_id})
MATCH path = shortestPath((src)-[:CONNECTED_TO*..15]->(dst))
RETURN [n IN nodes(path) | n.id] AS path, length(path) AS hops
// Fewest hops, NOT least travel_s. Use GDS or Variant B for weighted optimality.
```

For the algorithm internals behind either engine — how Dijkstra relaxes edges, how A\* prunes with a heuristic — see [Routing Algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/routing-algorithms-python/). When even a warm projection is too slow because the graph is continental, neither raw engine is the answer: precompute shortcuts with [contraction hierarchies for road networks](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/contraction-hierarchies-for-road-networks/) and route over the reduced graph.

## Performance Tuning

Profiling settles the argument that intuition cannot. Use `EXPLAIN` in CI to assert plan shape and `PROFILE` to read real `db hits`.

- **Confirm the Cypher endpoint seeks, not scans.** A healthy live traversal shows a `NodeIndexSeek` on `road_node_id` at the base feeding the expansion. A `NodeByLabelScan` means the anchor index is missing and the whole comparison is unfair — you are timing a scan, not a route.
- **Watch the projection's memory estimate.** Run `CALL gds.graph.project.estimate('RoadNode', {...})` before projecting. A projection that does not fit in the configured heap either fails or evicts the page cache your Cypher queries depend on, degrading *both* engines at once.
- **Never leak a projection.** A projection built and not dropped holds heap until the database restarts. The `finally: GDS_DROP` in the implementation is not optional; in a persistent-projection design, own the lifecycle explicitly and monitor `gds.graph.list`.
- **Keep the Cypher query text stable.** Literal coordinates or hop bounds baked into the string force recompilation and thrash the plan cache. Parameterize everything so the plan stays warm — the same discipline covered in [cypher performance tuning](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/).
- **Measure amortized, not single-shot.** A one-off benchmark that projects, runs one query, and drops will always make GDS look terrible, because $N = 1$. Measure at the $N$ your workload actually serves per projection.

The full seek-versus-scan tightening loop — capture `PROFILE`, find the widest operator, add the index or bound the predicate, re-profile — carries over directly from [cypher performance tuning](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/).

## Edge Cases & Gotchas

- **`shortestPath()` is hop-optimal, GDS Dijkstra is weight-optimal.** These return different paths whenever edge weights vary. If your comparison shows GDS and `shortestPath()` disagreeing, that is expected, not a bug — compare GDS against the weighted variable-length variant instead.
- **Stale projection serving wrong routes.** A persistent projection silently answers against a snapshot. If an edge is deleted (road closure) and the projection is not rebuilt, GDS will route straight through the closure. Version the projection and invalidate it on the writes that matter.
- **Disconnected pairs.** GDS `dijkstra.stream` yields zero rows when no path exists; the bounded Cypher expansion also returns nothing. Handle the empty result explicitly — a `None` route is a valid answer, not an error to swallow.
- **Unbounded variable-length blowup.** A Cypher `[:CONNECTED_TO*]` with no upper bound materializes the entire component before any ordering applies. Always cap the hop count, and for wide graphs pre-filter endpoints with a bounding box.
- **GDS licensing and ops surface.** The projected algorithms live in a plugin that must be installed, version-matched to the server, and — for some enterprise features — licensed. Cypher traversal carries none of that. On a locked-down managed instance, the plugin may simply not be available.
- **Weight units drift.** Both engines are only as correct as `travel_s`. If some edges store seconds and others minutes, both produce confidently wrong routes. Normalize units at ingestion.

## Verification & Testing

The one property worth asserting in CI is that, on a graph where they *should* agree, GDS Dijkstra and the weighted Cypher expansion return the **same optimal cost**. A regression in either query — a dropped weight property, a broken hop bound — shows up as a cost divergence.

```python
import pytest
from neo4j import AsyncGraphDatabase

SEED = """
CREATE (a:RoadNode {id: 'A', location: point({srid:4326, latitude: 48.8566, longitude: 2.3522})})
CREATE (b:RoadNode {id: 'B', location: point({srid:4326, latitude: 48.8600, longitude: 2.3700})})
CREATE (c:RoadNode {id: 'C', location: point({srid:4326, latitude: 48.8700, longitude: 2.3900})})
CREATE (a)-[:CONNECTED_TO {travel_s: 60.0}]->(b)
CREATE (b)-[:CONNECTED_TO {travel_s: 90.0}]->(c)
CREATE (a)-[:CONNECTED_TO {travel_s: 200.0}]->(c)
"""


@pytest.mark.asyncio
async def test_gds_and_cypher_agree_on_optimal_cost():
    driver = AsyncGraphDatabase.driver("bolt://localhost:7687", auth=("neo4j", "test"))
    async with driver.session(database="neo4j") as s:
        await s.run("MATCH (n) DETACH DELETE n")
        await s.run(SEED)

        await s.run(
            "CALL gds.graph.project('t', 'RoadNode', "
            "{CONNECTED_TO: {properties: 'travel_s'}})"
        )
        gds = await (await s.run(
            "MATCH (x:RoadNode {id:'A'}), (y:RoadNode {id:'C'}) "
            "CALL gds.shortestPath.dijkstra.stream('t', "
            "{sourceNode: x, targetNode: y, relationshipWeightProperty: 'travel_s'}) "
            "YIELD totalCost RETURN totalCost AS cost"
        )).single()
        await s.run("CALL gds.graph.drop('t')")

        cy = await (await s.run(
            "MATCH (x:RoadNode {id:'A'}), (y:RoadNode {id:'C'}) "
            "MATCH p = (x)-[:CONNECTED_TO*1..15]->(y) "
            "WITH reduce(c=0.0, r IN relationships(p) | c + r.travel_s) AS cost "
            "RETURN min(cost) AS cost"
        )).single()

    # A->B->C = 150s beats the direct A->C = 200s; both engines must find 150.
    assert gds["cost"] == pytest.approx(cy["cost"])
    await driver.close()
```

Run this against a disposable database in CI. Pair it with an `EXPLAIN` assertion that the Cypher route seeks `road_node_id` rather than scanning, so a plan regression that only changes latency still gets caught.

## FAQ

<details>
<summary>Is GDS always faster than Cypher for shortest paths?</summary>

No. GDS is faster per query only after the projection exists, because the algorithm runs over a compact in-memory copy. If the projection has to be built for a single query, or rebuilt because the graph changed, that build cost lands on the request and Cypher on the live graph is usually faster. GDS wins when one projection serves many queries; Cypher wins for small, fresh, one-off routes.
</details>

<details>
<summary>Does gds.shortestPath.dijkstra return the same path as Cypher shortestPath?</summary>

Not in general. The built-in shortestPath function finds the path with the fewest relationships, ignoring weights. GDS Dijkstra finds the path with the lowest total weight. They agree only when every edge has equal weight. To compare GDS against Cypher fairly, use a bounded variable-length match that sums the weight property and orders by it, not the fewest-hop shortestPath primitive.
</details>

<details>
<summary>How stale can a GDS projection get?</summary>

A projection is a snapshot taken when gds.graph.project returns. It never updates on its own. Every node or relationship written to the live graph afterward is invisible to algorithms running on that projection until you drop and rebuild it. For data that changes often, either rebuild on the writes that matter or route with live Cypher so freshness is automatic.
</details>

<details>
<summary>What memory does a projection cost, and how do I size it?</summary>

A projection holds a compacted copy of the projected nodes and relationships plus any carried properties in the heap. Call gds.graph.project.estimate with the same arguments before projecting to get a byte estimate. Size the heap so the projection fits without evicting the page cache that live Cypher queries rely on, otherwise projecting slows every query, not just the GDS ones.
</details>

<details>
<summary>Can I use GDS if my routing weight is computed at request time?</summary>

Not directly. A plain projection reads a stored numeric property once at build time, so a weight that depends on time of day or a per-request parameter has no place to live. You either bake the weight into a stored property beforehand, use a Cypher projection to derive it at build time, or route with live Cypher where the weight can be computed in the query. Dynamic weights are a common reason to stay on Cypher.
</details>

## Related

- [Benchmarking GDS shortestPath Against Hand-Written Cypher](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/neo4j-gds-vs-cypher-routing/benchmarking-gds-shortestpath-against-hand-written-cypher/) — the async harness that measures the crossover on your own graph.
- [Routing Algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/routing-algorithms-python/) — the Dijkstra and A\* internals both engines implement.
- [Contraction Hierarchies for Road Networks](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/contraction-hierarchies-for-road-networks/) — precomputed shortcuts for when even a warm projection is too slow.
- [Cypher Performance Tuning](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/) — the PROFILE-driven loop for keeping the live traversal index-backed.
- [Graph Query Planner Optimization](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/) — why predicate placement decides whether the Cypher endpoint seeks or scans.

This guide is part of [Network Routing Algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/).

For authoritative reference, consult the [Neo4j Graph Data Science documentation](https://neo4j.com/docs/graph-data-science/current/) and the [Neo4j Cypher path-finding functions](https://neo4j.com/docs/cypher-manual/current/patterns/shortest-paths/).

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "Is GDS always faster than Cypher for shortest paths?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "No. GDS is faster per query only after the projection exists, because the algorithm runs over a compact in-memory copy. If the projection has to be built for a single query, or rebuilt because the graph changed, that build cost lands on the request and Cypher on the live graph is usually faster. GDS wins when one projection serves many queries; Cypher wins for small, fresh, one-off routes."
      }
    },
    {
      "@type": "Question",
      "name": "Does gds.shortestPath.dijkstra return the same path as Cypher shortestPath?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Not in general. The built-in shortestPath function finds the path with the fewest relationships, ignoring weights. GDS Dijkstra finds the path with the lowest total weight. They agree only when every edge has equal weight. To compare GDS against Cypher fairly, use a bounded variable-length match that sums the weight property and orders by it, not the fewest-hop shortestPath primitive."
      }
    },
    {
      "@type": "Question",
      "name": "How stale can a GDS projection get?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "A projection is a snapshot taken when gds.graph.project returns. It never updates on its own. Every node or relationship written to the live graph afterward is invisible to algorithms running on that projection until you drop and rebuild it. For data that changes often, either rebuild on the writes that matter or route with live Cypher so freshness is automatic."
      }
    },
    {
      "@type": "Question",
      "name": "What memory does a projection cost, and how do I size it?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "A projection holds a compacted copy of the projected nodes and relationships plus any carried properties in the heap. Call gds.graph.project.estimate with the same arguments before projecting to get a byte estimate. Size the heap so the projection fits without evicting the page cache that live Cypher queries rely on, otherwise projecting slows every query, not just the GDS ones."
      }
    },
    {
      "@type": "Question",
      "name": "Can I use GDS if my routing weight is computed at request time?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Not directly. A plain projection reads a stored numeric property once at build time, so a weight that depends on time of day or a per-request parameter has no place to live. You either bake the weight into a stored property beforehand, use a Cypher projection to derive it at build time, or route with live Cypher where the weight can be computed in the query. Dynamic weights are a common reason to stay on Cypher."
      }
    }
  ]
}
</script>
