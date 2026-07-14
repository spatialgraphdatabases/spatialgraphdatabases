---
pageTitle: Isochrone & Service-Area Analysis
title: Isochrone and Service-Area Analysis
description: Compute reachability sets on a spatial road graph with cost-limited single-source traversal, turning everywhere within T minutes of an origin into a service-area boundary.
slug: isochrone-and-service-area-analysis
type: guide
breadcrumb: Isochrone & Service Areas
datePublished: 2026-07-14
dateModified: 2026-07-14
---
# Isochrone and Service-Area Analysis

An isochrone answers a question that point-to-point routing cannot: not "how do I get from A to B", but "where can I get to at all inside a budget". A delivery planner needs every address a depot can serve in thirty minutes; a retail team needs the catchment a new store draws from within a fifteen-minute drive; a dispatcher needs to know which ambulances can reach an incident under the response-time target. Each is a reachability set — the collection of graph nodes whose cheapest cumulative travel cost from an origin stays under a threshold — and the naive way to build one is catastrophic: run a shortest-path query to every node in the network and keep the ones that come back cheap. On a metro-scale graph that is millions of independent searches for a result that a single traversal produces in one pass. This guide shows how to compute reachability correctly with a cost-limited single-source traversal, drive it from async Python against Neo4j, turn the resulting node set into a service-area polygon, and avoid the weighting and topology traps that quietly return the wrong area. It is one of the core techniques in [Cypher Spatial Queries & Pathfinding Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/).

<svg viewBox="0 0 720 440" role="img" aria-labelledby="isoTitle isoDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="isoTitle">Concentric cost bands radiating from a single origin node</title>
  <desc id="isoDesc">A single origin node sits at the centre of three concentric rings representing cumulative travel-cost bands of five, ten, and fifteen minutes. Nodes are coloured by the band they fall into: the innermost reachable set is closest, the middle and outer sets progressively further by cost, and a few nodes sit outside the fifteen-minute ring and are unreachable within budget. The bands follow travel cost along the road graph, not straight-line distance, so their true shape is irregular even though the schematic draws them as rings.</desc>
  <defs>
    <marker id="iso-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <!-- rings -->
  <circle cx="250" cy="225" r="185" fill="var(--accent-4,#b58900)" opacity="0.06"/>
  <circle cx="250" cy="225" r="125" fill="var(--accent-3,#5b21b6)" opacity="0.07"/>
  <circle cx="250" cy="225" r="65" fill="var(--accent,#0a656d)" opacity="0.10"/>
  <circle cx="250" cy="225" r="185" fill="none" stroke="var(--accent-4,#b58900)" stroke-width="1.3" stroke-dasharray="5 5" opacity="0.7"/>
  <circle cx="250" cy="225" r="125" fill="none" stroke="var(--accent-3,#5b21b6)" stroke-width="1.3" stroke-dasharray="5 5" opacity="0.7"/>
  <circle cx="250" cy="225" r="65" fill="none" stroke="var(--accent,#0a656d)" stroke-width="1.4" stroke-dasharray="5 5" opacity="0.8"/>
  <!-- ring labels -->
  <text x="250" y="52" text-anchor="middle" font-size="10.5" fill="var(--accent-4,#b58900)" font-weight="700">15 min</text>
  <text x="250" y="112" text-anchor="middle" font-size="10.5" fill="var(--accent-3,#5b21b6)" font-weight="700">10 min</text>
  <text x="250" y="172" text-anchor="middle" font-size="10.5" fill="var(--accent,#0a656d)" font-weight="700">5 min</text>
  <!-- outer (unreachable) nodes -->
  <g fill="currentColor" opacity="0.22">
    <circle cx="500" cy="90" r="4"/> <circle cx="540" cy="300" r="4"/> <circle cx="470" cy="405" r="4"/> <circle cx="70" cy="70" r="4"/>
  </g>
  <!-- 15-min band nodes -->
  <g fill="var(--accent-4,#b58900)">
    <circle cx="250" cy="55" r="4.4"/> <circle cx="100" cy="150" r="4.4"/> <circle cx="405" cy="215" r="4.4"/> <circle cx="150" cy="360" r="4.4"/> <circle cx="360" cy="350" r="4.4"/> <circle cx="390" cy="118" r="4.4"/>
  </g>
  <!-- 10-min band nodes -->
  <g fill="var(--accent-3,#5b21b6)">
    <circle cx="250" cy="118" r="4.4"/> <circle cx="150" cy="225" r="4.4"/> <circle cx="342" cy="180" r="4.4"/> <circle cx="330" cy="288" r="4.4"/> <circle cx="182" cy="300" r="4.4"/>
  </g>
  <!-- 5-min band nodes -->
  <g fill="var(--accent,#0a656d)">
    <circle cx="250" cy="182" r="4.4"/> <circle cx="212" cy="242" r="4.4"/> <circle cx="292" cy="252" r="4.4"/> <circle cx="228" cy="200" r="4.4"/>
  </g>
  <!-- a couple of illustrative edges from origin -->
  <g stroke="currentColor" stroke-width="1.4" opacity="0.35" fill="none">
    <path d="M250 225 L250 186" marker-end="url(#iso-arrow)"/>
    <path d="M250 225 L214 240" marker-end="url(#iso-arrow)"/>
    <path d="M250 225 L288 250" marker-end="url(#iso-arrow)"/>
  </g>
  <!-- origin -->
  <circle cx="250" cy="225" r="13" fill="var(--accent-2,#a8380b)"/>
  <text x="250" y="229" text-anchor="middle" font-size="11" font-weight="700" fill="#ffffff">S</text>
  <text x="250" y="428" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.7">bands follow cumulative travel cost along edges — the true shape is irregular</text>
  <!-- legend -->
  <g font-size="11" fill="currentColor">
    <circle cx="560" cy="150" r="6.5" fill="var(--accent-2,#a8380b)"/>
    <text x="574" y="154">origin</text>
    <circle cx="560" cy="178" r="4.4" fill="var(--accent,#0a656d)"/>
    <text x="574" y="182">within 5 min</text>
    <circle cx="560" cy="206" r="4.4" fill="var(--accent-3,#5b21b6)"/>
    <text x="574" y="210">within 10 min</text>
    <circle cx="560" cy="234" r="4.4" fill="var(--accent-4,#b58900)"/>
    <text x="574" y="238">within 15 min</text>
    <circle cx="560" cy="262" r="4" fill="currentColor" opacity="0.22"/>
    <text x="574" y="266" opacity="0.85">over budget</text>
  </g>
</svg>

## Prerequisites

These examples assume an async Python service, a Neo4j instance with the Graph Data Science (GDS) library installed, and a road graph whose edges already carry a travel-cost weight (seconds or minutes), not just geometric length. The single-source traversal uses GDS; the boundary step uses a client-side geometry library and is deliberately kept at overview level here.

| Requirement | Minimum version | Notes |
| --- | --- | --- |
| Python | 3.10+ | Union types and `match` used in examples |
| Neo4j | 5.13+ | Native `point`, `CREATE POINT INDEX`, id lookup indexes |
| Neo4j GDS | 2.6+ | `gds.graph.project`, `gds.allShortestPaths.dijkstra` |
| neo4j (driver) | 5.x | Async driver (`AsyncGraphDatabase`) |
| shapely | 2.0+ | `concave_hull` for the service-area boundary (optional) |
| pytest / pytest-asyncio | 0.23+ | Correctness assertions |

```bash
pip install "neo4j>=5.18" "shapely>=2.0" "pytest>=8.0" "pytest-asyncio>=0.23"
```

This pattern assumes your graph already follows sound [node and edge spatial mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/) conventions — coordinates stored as native `point` values on routable nodes, with a cost `weight` on each edge kept distinct from raw length — and that a [spatial indexing strategy](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) backs the origin lookup so anchoring the source seeks rather than scans.

## Core Concept & Mechanism

An isochrone is not a distance filter. A [distance filter query pattern](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/) asks which nodes lie within a straight-line radius of a point; an isochrone asks which nodes lie within a travel-cost budget *along the network*. A river with one bridge, a motorway with widely spaced ramps, or a one-way grid all make the reachable area wildly different from a circle. The only faithful way to compute it is to walk the graph outward from the origin, accumulating edge cost, and stop each branch when its running total exceeds the budget.

Formally, given an origin $s$, an edge-cost function, and a budget $B$, the reachable set is

$$R(s, B) = \{\, v \in V : d(s, v) \le B \,\}$$

where $d(s, v)$ is the minimum cumulative edge cost of any path from $s$ to $v$. Computing $d(s, v)$ for *every* $v$ at once is exactly what a single-source shortest-path algorithm does. Run Dijkstra once from $s$ and it produces a shortest-path tree annotating every node it reaches with its cheapest cost-to-arrive; truncate that tree at the budget and the surviving nodes are the isochrone. This is the key efficiency insight: one traversal yields the whole set, so the cost is $O((V + E)\log V)$ for the search, not one search per candidate.

Two traversal shapes matter. When every edge has unit cost — "within N hops" — a cost-limited breadth-first search suffices and expands ring by ring. When edges carry real, unequal weights — seconds of travel time — you need a cost-limited Dijkstra, which pops nodes in ascending cost order so the first time it settles a node it has already found the cheapest route there. A budget cap simply stops the frontier from expanding past $B$: any node whose settled cost exceeds the budget, and every node reachable only through it, is pruned. The [network routing algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/) track covers the traversal internals in depth; here the point is that reachability is a single truncated Dijkstra, and the practical decision is what the edge weight represents.

Once you hold the reachable node set, a service area is its footprint. The nodes are a point cloud; the boundary is a polygon wrapped around them — a concave hull or alpha-shape rather than a convex hull, because a convex hull bridges over concavities (bays, wedge-shaped gaps between arterials) and reports coverage that does not exist. Computing that polygon is a client-side geometry step over the returned coordinates, not graph work.

## Schema & Data Model

The traversal reads two things: a stable origin `id` to anchor the source, and a cost `weight` on every routable edge. Both need to be present and correctly typed before a projection is built, because GDS reads the weight straight from the stored property.

```cypher
// Anchor the source lookup so the origin match seeks, not scans
CREATE INDEX road_node_id IF NOT EXISTS
FOR (n:RoadNode) ON (n.id);

// Native point index — used later to hand coordinates to the hull step
CREATE POINT INDEX road_node_location IF NOT EXISTS
FOR (n:RoadNode) ON (n.location);
```

```cypher
// Representative shape of the routable graph
// (:RoadNode {id, location: point({srid:4326, latitude, longitude})})
//   -[:CONNECTED_TO {length_m, travel_s, weight}]->
// (:RoadNode)
// `weight` is the traversal cost. For a drive-time isochrone it MUST be travel_s
// (seconds), NOT length_m — the single most common mistake this whole page exists to prevent.
```

Keep `travel_s` and `length_m` as separate properties and point `weight` at whichever the current analysis needs. A drive-time service area weights on `travel_s`; a "within 2 km of road" catchment weights on `length_m`. Conflating them produces an area that looks plausible and is silently wrong — short in kilometres but hours off in time, or vice versa. Direction is load-bearing too: one-way streets must be modelled as directed `CONNECTED_TO` edges, and the projection must respect that orientation, or the isochrone will let vehicles drive the wrong way up ramps.

## Step-by-Step Implementation

The workflow is: anchor the origin, project a weighted graph, run one single-source Dijkstra, truncate at the budget, and return the reachable nodes with their costs. We build it as runnable async code.

### 1. Project a weighted graph

GDS operates on an in-memory projection, not the stored graph. Project once, reuse the named graph for many origins and budgets, and drop it when done. Projecting the `weight` property is what lets Dijkstra accumulate real cost.

```python
import asyncio
from neo4j import AsyncGraphDatabase

PROJECT = """
CALL gds.graph.project(
    $graph_name,
    'RoadNode',
    { CONNECTED_TO: { properties: 'weight', orientation: 'NATURAL' } }
)
YIELD graphName, nodeCount, relationshipCount
RETURN graphName, nodeCount, relationshipCount
"""
```

`orientation: 'NATURAL'` preserves edge direction so one-way segments stay one-way. Use `'UNDIRECTED'` only for genuinely bidirectional networks such as pedestrian paths.

### 2. Run the cost-limited single-source traversal

A single call to `gds.allShortestPaths.dijkstra.stream` from the source node yields every reachable target with its cheapest `totalCost`. Applying `WHERE totalCost <= $budget` truncates the shortest-path tree to the isochrone. The budget is expressed in the same unit as `weight` — seconds here.

```python
REACHABLE = """
MATCH (src:RoadNode {id: $source_id})
CALL gds.allShortestPaths.dijkstra.stream($graph_name, {
    sourceNode: src,
    relationshipWeightProperty: 'weight'
})
YIELD targetNode, totalCost
WITH gds.util.asNode(targetNode) AS n, totalCost
WHERE totalCost <= $budget
RETURN n.id AS node_id,
       n.location.latitude  AS lat,
       n.location.longitude AS lon,
       totalCost AS cost_s
ORDER BY totalCost ASC
"""
```

### 3. Drive it from a pooled async service

One driver per process, one session per unit of work, and a `finally` block that drops the projection so it does not leak GDS heap between requests.

```python
async def compute_isochrone(driver, source_id: str, budget_s: float,
                            graph_name: str = "iso_graph") -> list[dict]:
    async with driver.session(database="neo4j") as session:
        # Rebuild the projection idempotently.
        await session.run("CALL gds.graph.drop($g, false) YIELD graphName",
                          g=graph_name)
        await session.run(PROJECT, graph_name=graph_name)
        try:
            result = await session.run(
                REACHABLE, graph_name=graph_name,
                source_id=source_id, budget=budget_s,
            )
            return [record.data() async for record in result]
        finally:
            await session.run("CALL gds.graph.drop($g, false) YIELD graphName",
                              g=graph_name)


async def main():
    driver = AsyncGraphDatabase.driver(
        "neo4j+s://your-cluster.databases.neo4j.io",
        auth=("neo4j", "secure-password"),
        max_connection_pool_size=40,
        connection_acquisition_timeout=5.0,
    )
    try:
        # Origin: a depot in central Chicago. Budget: 15 minutes = 900 s.
        reachable = await compute_isochrone(driver, source_id="depot-001", budget_s=900)
        print(f"{len(reachable)} nodes reachable within 15 min")
    finally:
        await driver.close()


if __name__ == "__main__":
    asyncio.run(main())
```

### 4. Wrap the reachable set in a boundary

The list of `(lat, lon)` pairs is the service area as a point cloud. To publish it as a polygon, wrap the points in a concave hull — Shapely 2.x exposes `concave_hull` directly. This is a client-side step; the graph work is already done.

```python
from shapely import MultiPoint, concave_hull

def service_area_polygon(reachable: list[dict], ratio: float = 0.4):
    """Concave-hull boundary around the reachable node cloud.
    ratio→0 hugs the points tightly (alpha-shape-like); ratio→1 approaches the convex hull."""
    pts = MultiPoint([(r["lon"], r["lat"]) for r in reachable])
    return concave_hull(pts, ratio=ratio)
```

Prefer a concave hull over a convex one so the polygon does not bridge across water, parks, or the wedge between two diverging arterials. The `ratio` is the accuracy dial: tighter hugs the true footprint at the cost of a jagged edge.

## Query Patterns & Variants

The same "everywhere within budget" intent takes several shapes. Pick by graph size and whether GDS is available.

**Variant A — GDS single-source Dijkstra (the default).** The pattern above. One projection, one traversal, weighted cost, scales to metro networks. Reach for it first.

**Variant B — cost-bounded expansion in pure Cypher (small graphs only).** With no GDS on the instance, a bounded variable-length match can approximate the reachable set. It is exponential in the hop cap, so it is only safe on small or sparse graphs and as a teaching aid.

```cypher
MATCH (src:RoadNode {id: $source_id})
MATCH path = (src)-[:CONNECTED_TO*1..12]->(v:RoadNode)
WITH v, min(reduce(c = 0.0, r IN relationships(path) | c + r.weight)) AS cost
WHERE cost <= $budget
RETURN v.id AS node_id, cost
ORDER BY cost ASC
// Cap the hop count (*1..12). An unbounded star materializes the whole component
// before the budget filter runs.
```

**Variant C — bucket the reachable set into bands.** Real deliverables show 10/20/30-minute rings in one response. A `CASE` over the streamed `totalCost` labels each node with its band so a single query returns the layered isochrone.

```cypher
MATCH (src:RoadNode {id: $source_id})
CALL gds.allShortestPaths.dijkstra.stream($graph_name, {
    sourceNode: src, relationshipWeightProperty: 'weight'
})
YIELD targetNode, totalCost
WITH gds.util.asNode(targetNode) AS n, totalCost
WHERE totalCost <= 1800
RETURN n.id AS node_id,
       CASE WHEN totalCost <= 600  THEN '0-10'
            WHEN totalCost <= 1200 THEN '10-20'
            ELSE '20-30' END AS band_min
ORDER BY totalCost
```

The full drive-time band pipeline — travel-time projection, band bucketing, and the three failure modes that corrupt it — is the subject of [Computing Drive-Time Isochrones with Neo4j GDS](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/isochrone-and-service-area-analysis/computing-drive-time-isochrones-with-neo4j-gds/). When the question is "the closest k facilities to a point" rather than "everything within a budget", that is [k-nearest-neighbor routing](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/k-nearest-neighbor-routing/), which anchors on proximity instead of reachability.

## Performance Tuning

GDS traversal cost splits into two phases — building the projection and running the search — and they profile differently.

- **Profile the anchor, not the traversal.** The `MATCH (src:RoadNode {id: $source_id})` must resolve through the id index. Run `EXPLAIN` on that lead-in and confirm a `NodeIndexSeek`, never a `NodeByLabelScan`; a scan there adds a full-label read to every isochrone request. The [Cypher performance tuning](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/) loop applies directly to this anchor query.
- **Reuse the projection.** `gds.graph.project` is the expensive step — it copies the topology and weights into off-heap memory. Project once and run many origins and budgets against the named graph; re-projecting per request throws that cost away. Use `gds.graph.project.estimate` to size GDS heap before projecting a large network.
- **Tune traversal concurrency.** `gds.allShortestPaths.dijkstra` accepts a `concurrency` parameter; match it to available cores, not to request count, so parallel isochrone requests do not oversubscribe the CPU.
- **Cap the budget you actually need.** A 15-minute isochrone settles far fewer nodes than a 60-minute one. Do not compute a large tree and slice it small if you only ever serve short budgets — pass the real `$budget` so Dijkstra can stop the frontier early.
- **Keep the projection fresh, not stale.** A projection is a snapshot. On a graph under live edits, a long-lived projection drifts from the stored topology; schedule re-projection against the write cadence.

## Edge Cases & Gotchas

- **Distance weight instead of travel-time weight.** Projecting `length_m` when you meant `travel_s` yields a distance isochrone dressed up as a drive-time one. It is the number-one defect: motorways look slow and side streets look fast. Assert the weight semantics before trusting any area.
- **No budget cap.** Streaming every shortest path and filtering in the client still makes GDS settle the entire reachable component. Push the `<= $budget` predicate into the query so the tree is truncated server-side.
- **Disconnected components.** If the origin sits in a component that a data gap severed from the rest of the network, the isochrone collapses to a handful of nodes. A suspiciously tiny reachable set is almost always a connectivity break at the origin, not a real coverage limit — audit degree and component membership around the source.
- **Convex hull masquerading as a service area.** A convex hull spans concavities and over-reports coverage across water and parkland. Use a concave hull or alpha-shape and validate the polygon area against the node spread.
- **Ignoring edge direction.** Projecting one-way streets as `UNDIRECTED` lets the traversal drive against traffic, inflating the area. Match the projection orientation to the network's real directionality.
- **Mixed CRS coordinates.** Latitude/longitude points (SRID 4326) and Cartesian points (SRID 7203) are not interchangeable when the hull step consumes them; normalize CRS at ingestion so the boundary geometry is metric-consistent.

## Verification & Testing

A reachability query is only trustworthy if its output matches a hand-computed ground truth on a graph small enough to reason about. Seed a tiny weighted network, run the traversal at a known budget, and assert the exact node set — a regression that swaps the weight property or drops the budget cap changes the set, and the assertion catches it.

```python
import pytest
from neo4j import AsyncGraphDatabase

SEED = """
CREATE (s:RoadNode {id: 'S', location: point({srid:4326, latitude: 41.8781, longitude: -87.6298})})
CREATE (a:RoadNode {id: 'A', location: point({srid:4326, latitude: 41.8850, longitude: -87.6300})})
CREATE (b:RoadNode {id: 'B', location: point({srid:4326, latitude: 41.8900, longitude: -87.6200})})
CREATE (c:RoadNode {id: 'C', location: point({srid:4326, latitude: 41.9100, longitude: -87.6000})})
CREATE (s)-[:CONNECTED_TO {weight: 300.0}]->(a)
CREATE (a)-[:CONNECTED_TO {weight: 300.0}]->(b)
CREATE (b)-[:CONNECTED_TO {weight: 600.0}]->(c)
"""


@pytest.mark.asyncio
async def test_reachable_set_within_budget():
    driver = AsyncGraphDatabase.driver("bolt://localhost:7687", auth=("neo4j", "test"))
    async with driver.session(database="neo4j") as s:
        await s.run("MATCH (n) DETACH DELETE n")
        await s.run(SEED)
        await s.run("CALL gds.graph.drop('t', false) YIELD graphName")
        await s.run(
            "CALL gds.graph.project('t', 'RoadNode', "
            "{CONNECTED_TO: {properties: 'weight', orientation: 'NATURAL'}})"
        )
        # Budget 700 s: S(0) + A(300) + B(600) reachable; C(1200) is not.
        got = await (await s.run(
            """
            MATCH (src:RoadNode {id: 'S'})
            CALL gds.allShortestPaths.dijkstra.stream('t',
                {sourceNode: src, relationshipWeightProperty: 'weight'})
            YIELD targetNode, totalCost
            WITH gds.util.asNode(targetNode) AS n, totalCost
            WHERE totalCost <= 700
            RETURN n.id AS id ORDER BY totalCost
            """
        )).value()
        await s.run("CALL gds.graph.drop('t', false) YIELD graphName")

    assert got == ["S", "A", "B"], "reachable set must stop at the budget"
    await driver.close()
```

Pair this with a plan-shape check on the origin anchor — `EXPLAIN` the lead-in `MATCH` and assert a `NodeIndexSeek` — so a refactor that drops the id index is caught before it slows every request in production.

<svg viewBox="0 0 760 372" role="img" aria-labelledby="hullTitle hullDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="hullTitle">Turning a reachable node set into a concave-hull service-area polygon</title>
  <desc id="hullDesc">Left panel: the reachable node set returned by the traversal, drawn as a scattered point cloud with the origin marked. Right panel: the same points wrapped in a concave-hull polygon that hugs the outer nodes to form the service-area boundary, following concavities rather than bridging over them the way a convex hull would.</desc>
  <defs>
    <marker id="hull-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <text x="185" y="28" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">Reachable node set</text>
  <text x="185" y="46" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.7">traversal output — a point cloud</text>
  <text x="575" y="28" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">Service-area polygon</text>
  <text x="575" y="46" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.7">concave hull around the cloud</text>
  <!-- LEFT panel -->
  <g>
    <g fill="var(--accent,#0a656d)">
      <circle cx="90" cy="110" r="4"/> <circle cx="150" cy="90" r="4"/> <circle cx="220" cy="100" r="4"/> <circle cx="280" cy="140" r="4"/> <circle cx="300" cy="200" r="4"/> <circle cx="280" cy="260" r="4"/> <circle cx="210" cy="290" r="4"/> <circle cx="140" cy="280" r="4"/> <circle cx="80" cy="220" r="4"/> <circle cx="60" cy="160" r="4"/>
      <circle cx="150" cy="160" r="4"/> <circle cx="210" cy="180" r="4"/> <circle cx="170" cy="230" r="4"/> <circle cx="240" cy="230" r="4"/>
    </g>
    <circle cx="150" cy="160" r="8.5" fill="var(--accent-2,#a8380b)"/>
    <text x="150" y="163" text-anchor="middle" font-size="8.5" font-weight="700" fill="#ffffff">S</text>
  </g>
  <!-- arrow -->
  <line x1="345" y1="190" x2="400" y2="190" stroke="currentColor" stroke-width="1.8" marker-end="url(#hull-arrow)"/>
  <text x="372" y="180" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">hull</text>
  <!-- RIGHT panel (nodes offset +370 in x) -->
  <g>
    <polygon points="430,160 460,110 520,90 590,100 650,140 670,200 650,260 580,290 510,280 450,220"
             fill="var(--accent,#0a656d)" opacity="0.10"
             stroke="var(--accent,#0a656d)" stroke-width="1.8" stroke-dasharray="6 4"/>
    <g fill="var(--accent,#0a656d)">
      <circle cx="460" cy="110" r="4"/> <circle cx="520" cy="90" r="4"/> <circle cx="590" cy="100" r="4"/> <circle cx="650" cy="140" r="4"/> <circle cx="670" cy="200" r="4"/> <circle cx="650" cy="260" r="4"/> <circle cx="580" cy="290" r="4"/> <circle cx="510" cy="280" r="4"/> <circle cx="450" cy="220" r="4"/> <circle cx="430" cy="160" r="4"/>
      <circle cx="520" cy="160" r="4"/> <circle cx="580" cy="180" r="4"/> <circle cx="540" cy="230" r="4"/> <circle cx="610" cy="230" r="4"/>
    </g>
    <circle cx="520" cy="160" r="8.5" fill="var(--accent-2,#a8380b)"/>
    <text x="520" y="163" text-anchor="middle" font-size="8.5" font-weight="700" fill="#ffffff">S</text>
  </g>
  <text x="380" y="340" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.72">a concave hull follows the true footprint; a convex hull would bridge the concavities and over-report coverage</text>
</svg>

## FAQ

<details>
<summary>Isochrone versus a distance-radius filter — what is the difference?</summary>

A distance-radius filter returns nodes within a straight-line distance of a point; an isochrone returns nodes within a travel-cost budget along the road network. They diverge sharply wherever geography constrains movement — rivers, limited-access highways, one-way grids. A point 500 metres away across an uncrossable river is inside the radius but far outside a five-minute isochrone. Use a radius when you want geometric proximity and an isochrone when you want real reachability.
</details>

<details>
<summary>Why run one single-source traversal instead of many point-to-point queries?</summary>

Because a single-source Dijkstra computes the cheapest cost to every reachable node in one pass and produces a shortest-path tree you can truncate at the budget. Running a separate shortest-path query to each candidate node repeats most of the same work thousands of times over and turns an order of V-plus-E-log-V computation into V independent searches. One traversal, then a budget filter, is the correct shape.
</details>

<details>
<summary>Should the edge weight be distance or travel time?</summary>

Whatever the budget represents. A drive-time isochrone must weight on travel seconds, not metres, or a motorway will look as slow as a side street and the area will be wrong. A distance catchment weights on length. Keep both properties on the edge and point the traversal weight at the one the current analysis needs; never conflate them.
</details>

<details>
<summary>Why a concave hull instead of a convex hull for the boundary?</summary>

A convex hull is the smallest convex polygon containing the points, so it bridges straight across any concavity — a bay, a park, the wedge between two diverging arterials — and reports coverage that the network does not actually provide. A concave hull or alpha-shape follows the indentations of the point cloud and yields a service-area boundary that matches where vehicles can really reach. Tune the concavity ratio to trade edge smoothness for fidelity.
</details>

<details>
<summary>My reachable set is tiny and obviously wrong. What happened?</summary>

The origin is almost certainly in a disconnected component — a data gap severed its part of the network from the rest, so the traversal runs out of edges quickly. Check the degree of the source node and its component membership before blaming the budget. A second common cause is projecting the graph as directed when it should be undirected, or vice versa, so the frontier cannot expand past the first one-way segment.
</details>

## Related

- [Computing Drive-Time Isochrones with Neo4j GDS](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/isochrone-and-service-area-analysis/computing-drive-time-isochrones-with-neo4j-gds/) — the complete travel-time projection and 10/20/30-minute band pipeline.
- [Distance Filter Query Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/) — straight-line radius predicates, and why they are not reachability.
- [K-Nearest-Neighbor Routing](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/k-nearest-neighbor-routing/) — proximity ranking when the question is "closest k", not "within budget".
- [Network Routing Algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/) — the Dijkstra and A\* internals the single-source traversal is built on.
- [Cypher Performance Tuning](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/) — the PROFILE loop for keeping the origin anchor index-backed.

This guide is part of [Cypher Spatial Queries & Pathfinding Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/).

For authoritative reference on the algorithms and functions used here, consult the [Neo4j GDS single-source shortest-path documentation](https://neo4j.com/docs/graph-data-science/current/algorithms/dijkstra-single-source/) and the [Neo4j Cypher Spatial Functions Documentation](https://neo4j.com/docs/cypher-manual/current/functions/spatial/).

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "Isochrone versus a distance-radius filter — what is the difference?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "A distance-radius filter returns nodes within a straight-line distance of a point; an isochrone returns nodes within a travel-cost budget along the road network. They diverge sharply wherever geography constrains movement such as rivers, limited-access highways, and one-way grids. A point 500 metres away across an uncrossable river is inside the radius but far outside a five-minute isochrone. Use a radius when you want geometric proximity and an isochrone when you want real reachability."
      }
    },
    {
      "@type": "Question",
      "name": "Why run one single-source traversal instead of many point-to-point queries?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Because a single-source Dijkstra computes the cheapest cost to every reachable node in one pass and produces a shortest-path tree you can truncate at the budget. Running a separate shortest-path query to each candidate node repeats most of the same work thousands of times over and turns an order of V plus E log V computation into V independent searches. One traversal, then a budget filter, is the correct shape."
      }
    },
    {
      "@type": "Question",
      "name": "Should the edge weight be distance or travel time?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Whatever the budget represents. A drive-time isochrone must weight on travel seconds, not metres, or a motorway will look as slow as a side street and the area will be wrong. A distance catchment weights on length. Keep both properties on the edge and point the traversal weight at the one the current analysis needs; never conflate them."
      }
    },
    {
      "@type": "Question",
      "name": "Why a concave hull instead of a convex hull for the boundary?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "A convex hull is the smallest convex polygon containing the points, so it bridges straight across any concavity such as a bay, a park, or the wedge between two diverging arterials, and reports coverage that the network does not actually provide. A concave hull or alpha-shape follows the indentations of the point cloud and yields a service-area boundary that matches where vehicles can really reach. Tune the concavity ratio to trade edge smoothness for fidelity."
      }
    },
    {
      "@type": "Question",
      "name": "My reachable set is tiny and obviously wrong. What happened?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "The origin is almost certainly in a disconnected component where a data gap severed its part of the network from the rest, so the traversal runs out of edges quickly. Check the degree of the source node and its component membership before blaming the budget. A second common cause is projecting the graph as directed when it should be undirected, or vice versa, so the frontier cannot expand past the first one-way segment."
      }
    }
  ]
}
</script>
