---
pageTitle: Cypher Performance Tuning for Routing
---
# Cypher Performance Tuning for Spatial Routing Workflows

Spatial routing in a graph database collapses the instant a query stops seeking an index and starts scanning a label. Logistics and mobility engineers see it as latency that is fine in staging and catastrophic at peak dispatch: a `point.distance()` predicate buried inside a variable-length expansion, a bounding-box check evaluated *after* the path is materialized, a connection pool starved while sessions block on heap-heavy traversals. The cost of ignoring this is not a slow page — it is a dispatch loop that misses its window and a graph engine that OOMs under concurrency. This guide shows how to make Cypher routing queries deterministic: anchor every spatial query on an index-seekable predicate, push filters ahead of traversal, cap path expansion, and align the async Python driver with the engine's execution model. It is one of the workflows in [Cypher Spatial Queries & Pathfinding Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/).

<svg viewBox="0 0 820 440" role="img" aria-labelledby="pp-title pp-desc" xmlns="http://www.w3.org/2000/svg">
  <title id="pp-title">Index-first routing pipeline versus the scan-then-filter anti-pattern</title>
  <desc id="pp-desc">Two execution lanes. The tuned lane: a PointIndexSeekByRange on a bounding box yields a small candidate set of hundreds, then shortestPath expands a small frontier with bounded heap, returning a route. The anti-pattern lane: a NodeByLabelScan reads every Node, shortestPath materializes all routes which allocates heap proportional to branching factor to the power of depth, then point.distance filters after the fact, returning the same route far more expensively. Heap stays bounded in the tuned lane and blows up at the materialization step in the anti-pattern lane.</desc>
  <style>
    .pp-box{fill:var(--surface-2,#f4f4f5);stroke-width:2;}
    .pp-good{stroke:var(--accent,#0e7c86);}
    .pp-bad{stroke:var(--accent-coral,#ff6b6b);}
    .pp-m{fill:var(--ink,#1f2937);font:700 13px var(--font-sans,system-ui,sans-serif);}
    .pp-s{fill:var(--ink-mute,#6b7280);font:11px var(--font-mono,ui-monospace,monospace);}
    .pp-lane{fill:var(--ink,#1f2937);font:700 14px var(--font-sans,system-ui,sans-serif);}
    .pp-edge{stroke:currentColor;stroke-width:1.6;fill:none;opacity:.55;}
    .pp-pill{font:700 11px var(--font-sans,system-ui,sans-serif);fill:#fff;}
    .pp-cap{fill:var(--ink-mute,#6b7280);font:11px var(--font-sans,system-ui,sans-serif);}
  </style>
  <defs>
    <marker id="pp-arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor" opacity=".55"/>
    </marker>
  </defs>
  <!-- TUNED LANE -->
  <text class="pp-lane pp-good" x="12" y="40" fill="var(--accent,#0e7c86)">Index-first (tuned)</text>
  <path class="pp-edge" d="M280 100 L317 100" marker-end="url(#pp-arr)"/>
  <path class="pp-edge" d="M457 100 L494 100" marker-end="url(#pp-arr)"/>
  <path class="pp-edge" d="M634 100 L671 100" marker-end="url(#pp-arr)"/>
  <g><rect class="pp-box pp-good" x="140" y="70" width="140" height="60" rx="8"/>
    <text class="pp-m" x="210" y="96" text-anchor="middle">Index seek</text>
    <text class="pp-s" x="210" y="116" text-anchor="middle">bounding box</text></g>
  <g><rect class="pp-box pp-good" x="317" y="70" width="140" height="60" rx="8"/>
    <text class="pp-m" x="387" y="96" text-anchor="middle">Candidates</text>
    <text class="pp-s" x="387" y="116" text-anchor="middle">~ hundreds</text></g>
  <g><rect class="pp-box pp-good" x="494" y="70" width="140" height="60" rx="8"/>
    <text class="pp-m" x="564" y="96" text-anchor="middle">shortestPath</text>
    <text class="pp-s" x="564" y="116" text-anchor="middle">small frontier</text></g>
  <g><rect class="pp-box pp-good" x="671" y="70" width="140" height="60" rx="8"/>
    <text class="pp-m" x="741" y="96" text-anchor="middle">Route</text>
    <text class="pp-s" x="741" y="116" text-anchor="middle">returned</text></g>
  <g><rect x="494" y="142" width="140" height="22" rx="11" fill="var(--accent,#0e7c86)"/>
    <text class="pp-pill" x="564" y="157" text-anchor="middle">heap: bounded</text></g>
  <!-- ANTI-PATTERN LANE -->
  <text class="pp-lane pp-bad" x="12" y="290" fill="var(--accent-coral,#ff6b6b)">Scan-then-filter (anti-pattern)</text>
  <path class="pp-edge" d="M280 320 L317 320" marker-end="url(#pp-arr)"/>
  <path class="pp-edge" d="M457 320 L494 320" marker-end="url(#pp-arr)"/>
  <path class="pp-edge" d="M634 320 L671 320" marker-end="url(#pp-arr)"/>
  <g><rect class="pp-box pp-bad" x="140" y="290" width="140" height="60" rx="8"/>
    <text class="pp-m" x="210" y="316" text-anchor="middle">Label scan</text>
    <text class="pp-s" x="210" y="336" text-anchor="middle">every :Node</text></g>
  <g><rect class="pp-box pp-bad" x="317" y="290" width="140" height="60" rx="8"/>
    <text class="pp-m" x="387" y="316" text-anchor="middle">shortestPath</text>
    <text class="pp-s" x="387" y="336" text-anchor="middle">all routes built</text></g>
  <g><rect class="pp-box pp-bad" x="494" y="290" width="140" height="60" rx="8"/>
    <text class="pp-m" x="564" y="316" text-anchor="middle">Distance filter</text>
    <text class="pp-s" x="564" y="336" text-anchor="middle">after the fact</text></g>
  <g><rect class="pp-box pp-bad" x="671" y="290" width="140" height="60" rx="8"/>
    <text class="pp-m" x="741" y="316" text-anchor="middle">Route</text>
    <text class="pp-s" x="741" y="336" text-anchor="middle">returned</text></g>
  <g><rect x="317" y="362" width="140" height="22" rx="11" fill="var(--accent-coral,#ff6b6b)"/>
    <text class="pp-pill" x="387" y="377" text-anchor="middle">heap &#8733; b&#7496;</text></g>
  <text class="pp-cap" x="12" y="416">Same route, same result &#8212; the tuned lane prunes millions of nodes before any path is expanded.</text>
</svg>

## Prerequisites

You need a working async toolchain before tuning anything. The patterns below target Neo4j 5.x (native point indexes and the `PointIndexSeekByRange` operator) driven from Python 3.9+ with the official async driver. The optional Graph Data Science (GDS) library is only required for the projection-based variant in the query section.

```bash
pip install "neo4j>=5.14" "shapely>=2.0" "numpy>=1.26"
# optional, only for the GDS projection variant
pip install "graphdatascience>=1.10"
```

| Component | Minimum version | Why it matters |
| --- | --- | --- |
| Neo4j | 5.14 | Range/point indexes, `PROFILE` operator detail, `db.index.*` procedures |
| Python | 3.9 | `AsyncGraphDatabase`, `tuple[...]` typing, `asyncio.gather` ergonomics |
| neo4j driver | 5.14 | Native `point` serialization over Bolt, async session pooling |
| GDS (optional) | 1.10 | In-memory graph projections for repeated multi-source routing |

A read replica or a dedicated `routing` database is assumed for the heavier analytical queries so that path materialization never contends with the write path.

## Core Concept & Mechanism

A spatial routing query has two distinct cost centers, and tuning is the art of keeping them separate. The first is **candidate resolution**: finding the handful of nodes that anchor the route. The second is **traversal**: expanding relationships between those anchors. The query planner can resolve candidates in `O(log N)` *if and only if* the spatial predicate is index-seekable; otherwise it falls back to `NodeByLabelScan`, reading every node of the label, and the whole query degrades linearly with vertex count.

Index seekability is the entire game. Neo4j has no native `WITHIN` predicate, so a circular search must be expressed as a rectangular range check that maps onto the underlying R-tree. A predicate like `n.location.latitude >= $min_lat AND n.location.latitude <= $max_lat` (on a `POINT INDEX`) produces a `PointIndexSeekByRange` at the base of the plan. By contrast, `point.distance(n.location, $p) <= $r` evaluated alone is *not* seekable — the planner cannot bound it — so it forces a scan. The production shape is therefore a two-stage filter: an index-backed bounding box prunes millions of nodes to hundreds, then exact `point.distance()` math refines that small set. This is the same index-first discipline formalized in [Distance Filter Query Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/), and it is where the [Spatial Indexing Strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) layer earns its keep.

The second mechanism is **predicate push-down**. The planner is free to reorder operators, but only when the predicate is attached to a node it can resolve early. If you place a spatial constraint *inside* a `shortestPath(...)` pattern, the engine must materialize partial routes before it can test the geometry — buffering intermediate path state and allocating heap proportional to branching factor times depth. Pushing the spatial filter onto the anchor `MATCH` lets the planner shrink the search frontier before the path algorithm runs at all. Choosing the operator order the index exposes is the core of [Graph Query Planner Optimization](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/).

## Schema & Data Model

Tuning is impossible if the data model is not seekable. Store geography as a native `point` (not stringified JSON, not decoupled `lat`/`lon` floats), use `:ROUTE`/`:CONNECTED_TO` relationships with a numeric `weight` for cost accumulation, and create the indexes the planner will actually consume.

```cypher
// Native point on the searchable node label
CREATE POINT INDEX node_location_idx IF NOT EXISTS
FOR (n:Node) ON (n.location);

// Anchor lookups by business key resolve via a fast equality seek
CREATE RANGE INDEX node_id_idx IF NOT EXISTS
FOR (n:Node) ON (n.id);

// Relationship weight backs cost-bounded traversal predicates
CREATE RANGE INDEX route_weight_idx IF NOT EXISTS
FOR ()-[r:CONNECTED_TO]-() ON (r.weight);
```

Each `:Node` carries `id` (string business key), `location` (`point({srid: 4326, latitude, longitude})`), and a `status` flag; each `:CONNECTED_TO` carries `weight` (traversal cost, e.g. seconds or meters). Confirm readiness with `SHOW INDEXES` — every index must read `ONLINE` before it can be seeked. Truncating coordinates to ~5 decimal places (about 1.1 m at the equator) keeps index node depth shallow without harming routing accuracy, which directly improves page-cache hit ratios under load.

## Step-by-Step Implementation

The following builds an index-anchored, depth-bounded router end to end. Each step explains the tuning decision baked into it.

**1. Precompute the bounding envelope in Python.** Never let the engine derive a search rectangle at runtime; compute it client-side so the query receives plain scalar parameters the index can seek on. The longitude offset widens with latitude because meridians converge toward the poles.

```python
import math
from typing import Mapping

def bounding_box(lat: float, lon: float, radius_m: float) -> Mapping[str, float]:
    """WGS84 bounding box for index pre-filtering (spherical approximation)."""
    earth_radius_m = 6_378_137.0
    d_lat = math.degrees(radius_m / earth_radius_m)
    d_lon = math.degrees(radius_m / (earth_radius_m * math.cos(math.radians(lat))))
    return {
        "min_lat": lat - d_lat, "max_lat": lat + d_lat,
        "min_lon": lon - d_lon, "max_lon": lon + d_lon,
    }
```

**2. Parameterize everything except the depth bound.** Parameters keep the plan cache warm across concurrent requests; inline literals fragment it and force recompilation. The one exception is the variable-length upper bound (`*..N`), which Cypher requires as a literal — so validate it as an integer and interpolate it into the template, never from user input directly.

**3. Anchor the route, then expand.** The query resolves `src` and `dst` through their bounding boxes (index seek) before `shortestPath` runs, and a cost predicate prunes edges that exceed the load ceiling during expansion.

```python
import asyncio
from neo4j import AsyncGraphDatabase
from neo4j.exceptions import Neo4jError
from typing import Mapping, Optional

class SpatialRouter:
    def __init__(self, uri: str, user: str, password: str, pool_size: int = 20) -> None:
        self.driver = AsyncGraphDatabase.driver(
            uri,
            auth=(user, password),
            max_connection_pool_size=pool_size,
            max_connection_lifetime=300,          # align with LB idle timeout
            connection_acquisition_timeout=5.0,    # fail fast on pool starvation
        )

    async def resolve_route(
        self,
        origin_id: str,
        destination_id: str,
        src_box: Mapping[str, float],
        dst_box: Mapping[str, float],
        max_load: float,
        max_hops: int = 20,
    ) -> Optional[Mapping]:
        if not (1 <= max_hops <= 100):
            raise ValueError("max_hops must be an integer between 1 and 100")

        query = f"""
        MATCH (src:Node {{id: $origin_id}})
        MATCH (dst:Node {{id: $dest_id}})
        WHERE src.location.latitude  >= $s_min_lat AND src.location.latitude  <= $s_max_lat
          AND src.location.longitude >= $s_min_lon AND src.location.longitude <= $s_max_lon
          AND dst.location.latitude  >= $d_min_lat AND dst.location.latitude  <= $d_max_lat
          AND dst.location.longitude >= $d_min_lon AND dst.location.longitude <= $d_max_lon
        MATCH path = shortestPath((src)-[:CONNECTED_TO*..{max_hops}]->(dst))
        WHERE all(r IN relationships(path) WHERE r.weight <= $max_load)
        RETURN path,
               reduce(c = 0.0, r IN relationships(path) | c + r.weight) AS cost
        """
        params = {
            "origin_id": origin_id, "dest_id": destination_id, "max_load": max_load,
            "s_min_lat": src_box["min_lat"], "s_max_lat": src_box["max_lat"],
            "s_min_lon": src_box["min_lon"], "s_max_lon": src_box["max_lon"],
            "d_min_lat": dst_box["min_lat"], "d_max_lat": dst_box["max_lat"],
            "d_min_lon": dst_box["min_lon"], "d_max_lon": dst_box["max_lon"],
        }
        async with self.driver.session(database="routing") as session:
            try:
                result = await session.run(query, **params)
                record = await result.single()
                return record.data() if record else None
            except Neo4jError as exc:
                raise RuntimeError(f"route resolution failed: {exc}") from exc

    async def close(self) -> None:
        await self.driver.close()
```

**4. Batch independent requests without sharing a session.** Use `asyncio.gather` to fan out concurrent routes; each task takes its own session from the pool so one slow traversal never blocks the others.

```python
async def main() -> None:
    router = SpatialRouter("neo4j+s://your-cluster.databases.neo4j.io", "neo4j", "secret")
    jobs = [
        ("HUB_A", "HUB_D", (40.71, -74.01), (40.78, -73.95)),
        ("HUB_B", "HUB_E", (40.65, -74.02), (40.73, -73.99)),
    ]
    async def run(origin, dest, o, d):
        return await router.resolve_route(
            origin, dest, bounding_box(*o, 8_000), bounding_box(*d, 8_000), max_load=5.0
        )
    results = await asyncio.gather(*(run(*j) for j in jobs))
    print(f"resolved {sum(r is not None for r in results)}/{len(results)} routes")
    await router.close()

if __name__ == "__main__":
    asyncio.run(main())
```

## Query Patterns & Variants

Three concrete shapes cover most routing workloads. Each annotates the parameter that governs its cost.

**Variant A — radius-anchored single source.** When the destination is "nearest viable node" rather than a fixed id, resolve candidates with the index, then expand. The `$radius` parameter is the dominant cost lever: every meter widens the candidate set quadratically.

```cypher
WITH point({latitude: $lat, longitude: $lon}) AS origin
MATCH (n:Node)
WHERE n.location.latitude  >= $min_lat AND n.location.latitude  <= $max_lat
  AND n.location.longitude >= $min_lon AND n.location.longitude <= $max_lon
  AND point.distance(n.location, origin) <= $radius   // exact refine on small set
RETURN n.id, point.distance(n.location, origin) AS dist_m
ORDER BY dist_m ASC
LIMIT $k                                              // hard cap caps the sort
```

**Variant B — cost-bounded shortest path.** Accumulate edge `weight` and reject paths over budget during traversal. The `*..N` literal is the safety valve; keep it at a realistic operational bound (`*..20`), never `*..100`.

```cypher
MATCH (src:Node {id: $src_id}), (dst:Node {id: $dst_id})
MATCH path = shortestPath((src)-[:CONNECTED_TO*..20]->(dst))
WHERE reduce(c = 0.0, r IN relationships(path) | c + r.weight) <= $budget
RETURN path,
       reduce(c = 0.0, r IN relationships(path) | c + r.weight) AS cost
```

**Variant C — GDS projection for repeated multi-source routing.** When you route from many sources over the same topology, project once into an in-memory graph and run Dijkstra natively instead of re-expanding Cypher patterns per request. The projection name is reused across calls; `relationshipWeightProperty` is what makes it cost-aware.

```cypher
CALL gds.shortestPath.dijkstra.stream('routing-graph', {
  sourceNode: $src_internal_id,
  targetNode: $dst_internal_id,
  relationshipWeightProperty: 'weight'
})
YIELD totalCost, nodeIds
RETURN totalCost, [id IN nodeIds | gds.util.asNode(id).id] AS route
```

This variant trades projection memory and a refresh discipline for far lower per-query latency on hot topologies; it is the bridge into [Spatial Join Techniques](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/spatial-join-techniques/) when routes must be correlated against external datasets.

## Performance Tuning

Profile before you tune. `EXPLAIN` shows the planner's intended operator tree and cost estimates without running the query; `PROFILE` runs it and reports actual db-hits, rows, and memory per operator.

```cypher
PROFILE
MATCH (src:Node {id: $src_id})
MATCH (dst:Node)
WHERE dst.location.latitude  >= $min_lat AND dst.location.latitude  <= $max_lat
  AND dst.location.longitude >= $min_lon AND dst.location.longitude <= $max_lon
MATCH path = shortestPath((src)-[:CONNECTED_TO*..15]->(dst))
RETURN path
```

Read the plan bottom-up. The base operator on the spatial side must be `PointIndexSeekByRange` — if you see `NodeByLabelScan` feeding a `Filter`, push-down failed and the predicate is not seekable as written. Watch the db-hits column for the operator that dominates; in spatial routing it is almost always an `Expand(All)` that ran before the geometry was constrained. The fix is structural: move the spatial predicate onto the anchor `MATCH` so the frontier is small before expansion begins.

Traversal memory is the other budget. The engine buffers intermediate path state, so worst-case memory scales with branching factor `b` and depth `d`:

$$M \approx b^{d}$$

This is why capping `*..N` and using `shortestPath`/`allShortestPaths` instead of unbounded pattern matching is non-negotiable — each unit of depth multiplies the buffer. Concrete levers, in order of impact:

- **Push spatial predicates to the anchor MATCH** so the index prunes before expansion.
- **Cap variable-length depth** to an operational maximum; reject impossible routes with a bound rather than a timeout.
- **Parameterize** to keep the plan cache warm and avoid recompilation under burst.
- **Set `dbms.memory.transaction.total.max`** to bound a single runaway query instead of letting it exhaust the heap for everyone.
- **Batch bulk coordinate updates** into maintenance windows; native point indexes compact in the background, but write bursts collide with read latency and fragment leaf depth.
- **Route analytical traversals to a read replica** so path materialization never contends with the write path.
- **Compute distances client-side** (`shapely`/`numpy`) when the result does not need to drive a database decision, eliminating a round-trip.

## Edge Cases & Gotchas

- **Coordinate precision drift.** GPS jitter can push a real node just outside a tight bounding box, producing a false-negative empty result. Implement *adaptive bounding*: expand the envelope incrementally only when the first query returns nothing, rather than over-widening every query.
- **The antimeridian and poles.** A bounding box that crosses ±180° longitude silently returns nothing because `min_lon > max_lon`. Detect the wrap and split into two range predicates; near the poles the longitude offset explodes, so clamp it.
- **Variable-length bound as a parameter.** `[:CONNECTED_TO*..$n]` is a syntax error — the upper bound must be a literal. Validate `n` as an integer and interpolate it into the template; everything else stays parameterized.
- **Driver timeout vs. server timeout.** `connection_acquisition_timeout` only governs *getting* a connection; a long traversal can still exceed it downstream. Pair it with a server-side transaction timeout so a stuck query is killed rather than holding a pooled connection.
- **Mixed geometry storage.** A single node stored with `location` as a string or as separate `lat`/`lon` floats bypasses the spatial planner entirely and triggers a scan. Enforce native `point` at ingestion; storing geometry correctly is the job of [Node and Edge Spatial Mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/).
- **GDS projection staleness.** An in-memory projection does not see writes made after it was created. Routes will follow a topology that no longer exists until you refresh it; schedule projection rebuilds on a cadence matched to your write rate.

## Verification & Testing

Correctness assertions belong in CI, not in a dashboard you check after an incident. Seed a tiny deterministic graph, then assert that the tuned query returns the path you expect and that the bounding box actually constrains the result set.

```python
import asyncio
import pytest
from neo4j import AsyncGraphDatabase

SEED = """
MERGE (a:Node {id:'A'}) SET a.location = point({latitude:40.70, longitude:-74.01})
MERGE (b:Node {id:'B'}) SET b.location = point({latitude:40.72, longitude:-73.99})
MERGE (c:Node {id:'C'}) SET c.location = point({latitude:40.74, longitude:-73.97})
MERGE (a)-[:CONNECTED_TO {weight:1.0}]->(b)
MERGE (b)-[:CONNECTED_TO {weight:1.0}]->(c)
"""

@pytest.mark.asyncio
async def test_route_exists_and_is_cost_bounded():
    driver = AsyncGraphDatabase.driver("neo4j://localhost:7687", auth=("neo4j", "test"))
    async with driver.session(database="routing") as s:
        await s.run("MATCH (n) DETACH DELETE n")
        await s.run(SEED)
        rec = await (await s.run(
            """
            MATCH (src:Node {id:'A'}), (dst:Node {id:'C'})
            MATCH path = shortestPath((src)-[:CONNECTED_TO*..10]->(dst))
            RETURN length(path) AS hops,
                   reduce(c=0.0, r IN relationships(path) | c + r.weight) AS cost
            """
        )).single()
        assert rec["hops"] == 2          # A -> B -> C
        assert rec["cost"] == 2.0        # cost accumulation is correct
    await driver.close()
```

Beyond path existence, assert the operational invariants that tuning depends on: query that the spatial index reads `ONLINE` via `SHOW INDEXES`, run a `PROFILE` in a smoke test and fail the build if the plan contains `NodeByLabelScan` on the spatial label, and degree-check anchor nodes so a topology gap surfaces as a failed assertion rather than a silently empty route.

## FAQ

<details>
<summary>Why does my routing query still do a full label scan after I added a point index?</summary>

The predicate is almost certainly not index-seekable as written. A bare `point.distance(n.location, $p) <= $r` cannot be bounded by the planner, so it scans. Wrap it with a bounding-box range check on `n.location.latitude`/`longitude` so the planner emits a `PointIndexSeekByRange`, then keep `point.distance()` only as the exact refine on the small candidate set. Confirm with `PROFILE` that the seek sits at the base of the plan.
</details>

<details>
<summary>Should I put the spatial filter inside shortestPath or before it?</summary>

Before it, always, when topology allows. A predicate inside `shortestPath(...)` forces the engine to materialize partial routes before it can test geometry, allocating heap proportional to branching factor times depth. Anchoring the spatial constraint on the source/destination `MATCH` lets the index shrink the frontier before the path algorithm runs at all.
</details>

<details>
<summary>How do I bound variable-length path memory under concurrency?</summary>

Cap the `*..N` upper bound to a realistic operational maximum, prefer `shortestPath`/`allShortestPaths` over unbounded pattern matching, and set a per-transaction memory ceiling so one runaway query cannot exhaust the shared heap. Worst-case buffer growth is roughly branching-factor to the power of depth, so every unit of depth you remove multiplies down the memory you save.
</details>

<details>
<summary>When is GDS Dijkstra worth it over plain Cypher shortestPath?</summary>

When you route many times over the same topology. A one-off route is cheaper as Cypher `shortestPath`; high-frequency multi-source routing amortizes the cost of an in-memory GDS projection and runs native Dijkstra far faster per call. The trade-off is projection memory plus a refresh discipline — the projection does not see writes made after it was built.
</details>

<details>
<summary>My tight bounding box sometimes returns no route — is that a bug?</summary>

Usually it is coordinate drift, not a bug. GPS jitter can push a valid node just outside a narrow envelope. Use adaptive bounding: issue the tight query first, and only widen the envelope incrementally when it returns empty. Also check for an antimeridian wrap, where `min_lon > max_lon` makes the range predicate match nothing.
</details>

## Related

- [Eliminating Cartesian Products in Spatial Cypher](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/eliminating-cartesian-products-in-spatial-cypher/) — spotting and rewriting the disconnected patterns that blow up to N×M rows.
- [Keeping Spatial Queries in the Plan Cache](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/keeping-spatial-queries-in-the-plan-cache/) — parameterizing coordinates so plans are reused instead of recompiled.
- [Distance Filter Query Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/) — the two-stage index-then-refine filter this guide tunes around.
- [K-Nearest Neighbor Routing](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/k-nearest-neighbor-routing/) — bounded candidate generation before traversal.
- [Spatial Join Techniques](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/spatial-join-techniques/) — correlating routes with external datasets without a full topology scan.
- [Graph Query Planner Optimization](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/) — making the planner consume the selectivity your spatial index exposes.
- [Spatial Indexing Strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) — choosing and attaching the index a seekable predicate depends on.

This guide is part of [Cypher Spatial Queries & Pathfinding Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/). For authoritative reference, consult the [Neo4j Cypher Manual](https://neo4j.com/docs/cypher-manual/current/), the [Neo4j Spatial Functions Documentation](https://neo4j.com/docs/cypher-manual/current/functions/spatial/), and the [Python asyncio Documentation](https://docs.python.org/3/library/asyncio.html).

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "Why does my routing query still do a full label scan after I added a point index?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "The predicate is almost certainly not index-seekable as written. A bare point.distance(n.location, p) <= r cannot be bounded by the planner, so it scans. Wrap it with a bounding-box range check on n.location.latitude and longitude so the planner emits a PointIndexSeekByRange, then keep point.distance() only as the exact refine on the small candidate set. Confirm with PROFILE that the seek sits at the base of the plan."
      }
    },
    {
      "@type": "Question",
      "name": "Should I put the spatial filter inside shortestPath or before it?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Before it, always, when topology allows. A predicate inside shortestPath forces the engine to materialize partial routes before it can test geometry, allocating heap proportional to branching factor times depth. Anchoring the spatial constraint on the source and destination MATCH lets the index shrink the frontier before the path algorithm runs at all."
      }
    },
    {
      "@type": "Question",
      "name": "How do I bound variable-length path memory under concurrency?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Cap the variable-length upper bound to a realistic operational maximum, prefer shortestPath or allShortestPaths over unbounded pattern matching, and set a per-transaction memory ceiling so one runaway query cannot exhaust the shared heap. Worst-case buffer growth is roughly branching factor to the power of depth, so every unit of depth you remove multiplies down the memory you save."
      }
    },
    {
      "@type": "Question",
      "name": "When is GDS Dijkstra worth it over plain Cypher shortestPath?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "When you route many times over the same topology. A one-off route is cheaper as Cypher shortestPath; high-frequency multi-source routing amortizes the cost of an in-memory GDS projection and runs native Dijkstra far faster per call. The trade-off is projection memory plus a refresh discipline, because the projection does not see writes made after it was built."
      }
    },
    {
      "@type": "Question",
      "name": "My tight bounding box sometimes returns no route - is that a bug?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Usually it is coordinate drift, not a bug. GPS jitter can push a valid node just outside a narrow envelope. Use adaptive bounding: issue the tight query first, and only widen the envelope incrementally when it returns empty. Also check for an antimeridian wrap, where min_lon greater than max_lon makes the range predicate match nothing."
      }
    }
  ]
}
</script>
