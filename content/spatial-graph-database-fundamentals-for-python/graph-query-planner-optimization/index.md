# Graph Query Planner Optimization

Spatial routing workloads degrade the moment the query planner defaults to full graph scans instead of leveraging geographic predicates. Backend and logistics teams routinely watch p99 latency spike during peak dispatch windows because the optimizer misestimates the cardinality of bounding-box filters and expands adjacency lists it should have pruned. The failure cost is concrete: a single mis-planned `shortestPath` over a metropolitan road network can materialize millions of intermediate rows, exhaust the JVM heap, and stall every concurrent request sharing the connection pool. This guide shows how to align the planner's cost model with spatial topology so distance filters resolve early, traversals stay bounded, and plans remain stable under shifting parameters.

<figure class="svg-figure">
<svg viewBox="0 0 840 360" role="img" aria-labelledby="planc-title planc-desc" xmlns="http://www.w3.org/2000/svg">
  <title id="planc-title">Naive versus optimized Cypher execution plan for a spatial route</title>
  <desc id="planc-desc">Two stacked operator pipelines. The naive plan scans all depots by label, expands every road segment into millions of intermediate rows, then applies the distance filter last. The optimized plan seeks a service-zone index first, expands only inside the bounded zone, and runs shortestPath, so the row counts stay small at every step.</desc>
  <style>
    .pc-box{fill:var(--surface-2,#f4f4f5);stroke:var(--line-strong,#9ca3af);stroke-width:1.5;}
    .pc-hot{stroke:var(--accent-coral,#ff6b6b);stroke-width:2.5;}
    .pc-good{stroke:var(--accent,#0e7c86);stroke-width:2.5;}
    .pc-op{fill:var(--ink,#1f2937);font:600 16px var(--font-sans,system-ui,sans-serif);}
    .pc-sub{fill:var(--ink-mute,#6b7280);font:13px var(--font-mono,ui-monospace,monospace);}
    .pc-hd{font:700 17px var(--font-sans,system-ui,sans-serif);}
    .pc-pill-t{font:600 13px var(--font-mono,ui-monospace,monospace);fill:var(--viz-on-pill,#ffffff);}
    .pc-flow{stroke:currentColor;stroke-width:1.5;fill:none;opacity:.55;}
    .pc-note{fill:var(--accent-coral,#ff6b6b);font:italic 12px var(--font-sans,system-ui,sans-serif);}
  </style>
  <defs>
    <marker id="pc-arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor" opacity=".55"/>
    </marker>
  </defs>
  <!-- headers -->
  <rect class="viz-backdrop" x="0" y="0" width="840" height="360" fill="var(--viz-bg,#ffffff)"/>
  <text class="pc-hd" x="215" y="30" text-anchor="middle" fill="var(--accent-coral,#ff6b6b)">Naive plan</text>
  <text class="pc-hd" x="625" y="30" text-anchor="middle" fill="var(--accent,#0e7c86)">Optimized plan</text>
  <!-- flow connectors -->
  <line class="pc-flow" x1="215" y1="106" x2="215" y2="142" marker-end="url(#pc-arr)"/>
  <line class="pc-flow" x1="215" y1="200" x2="215" y2="236" marker-end="url(#pc-arr)"/>
  <line class="pc-flow" x1="625" y1="106" x2="625" y2="142" marker-end="url(#pc-arr)"/>
  <line class="pc-flow" x1="625" y1="200" x2="625" y2="236" marker-end="url(#pc-arr)"/>
  <!-- LEFT: naive -->
  <g>
    <rect class="pc-box" x="65" y="48" width="300" height="56" rx="8"/>
    <text class="pc-op" x="83" y="73">NodeByLabelScan</text>
    <text class="pc-sub" x="83" y="92">:Depot</text>
    <rect x="277" y="62" width="76" height="28" rx="14" fill="var(--ink-mute,#6b7280)"/>
    <text class="pc-pill-t" x="315" y="80" text-anchor="middle">120 K</text>
  </g>
  <g>
    <rect class="pc-box pc-hot" x="65" y="142" width="300" height="56" rx="8"/>
    <text class="pc-op" x="83" y="167">Expand(All)</text>
    <text class="pc-sub" x="83" y="186">every road segment</text>
    <rect x="277" y="156" width="76" height="28" rx="14" fill="var(--accent-coral,#ff6b6b)"/>
    <text class="pc-pill-t" x="315" y="174" text-anchor="middle">2.4 M</text>
    <text class="pc-note" x="215" y="216" text-anchor="middle">rows balloon before the filter runs</text>
  </g>
  <g>
    <rect class="pc-box" x="65" y="236" width="300" height="56" rx="8"/>
    <text class="pc-op" x="83" y="261">Filter</text>
    <text class="pc-sub" x="83" y="280">point.distance &lt; 3000</text>
    <rect x="277" y="250" width="76" height="28" rx="14" fill="var(--ink-mute,#6b7280)"/>
    <text class="pc-pill-t" x="315" y="268" text-anchor="middle">90</text>
  </g>
  <!-- RIGHT: optimized -->
  <g>
    <rect class="pc-box pc-good" x="475" y="48" width="300" height="56" rx="8"/>
    <text class="pc-op" x="493" y="73">NodeIndexSeek</text>
    <text class="pc-sub" x="493" y="92">:ServiceZone(region_code)</text>
    <rect x="687" y="62" width="76" height="28" rx="14" fill="var(--accent,#0e7c86)"/>
    <text class="pc-pill-t" x="725" y="80" text-anchor="middle">1</text>
  </g>
  <g>
    <rect class="pc-box pc-good" x="475" y="142" width="300" height="56" rx="8"/>
    <text class="pc-op" x="493" y="167">Expand (in zone)</text>
    <text class="pc-sub" x="493" y="186">bounded subset</text>
    <rect x="687" y="156" width="76" height="28" rx="14" fill="var(--accent,#0e7c86)"/>
    <text class="pc-pill-t" x="725" y="174" text-anchor="middle">380</text>
  </g>
  <g>
    <rect class="pc-box pc-good" x="475" y="236" width="300" height="56" rx="8"/>
    <text class="pc-op" x="493" y="261">shortestPath</text>
    <text class="pc-sub" x="493" y="280">*1..40 bounded</text>
    <rect x="687" y="250" width="76" height="28" rx="14" fill="var(--accent,#0e7c86)"/>
    <text class="pc-pill-t" x="725" y="268" text-anchor="middle">1</text>
  </g>
  <!-- badge legend baseline -->
  <text class="pc-sub" x="65" y="332">badges = estimated rows emitted by each operator</text>
</svg>

<figcaption>An index-anchored entry point keeps row counts small at every operator, instead of materializing millions of rows and discarding them in a late distance filter.</figcaption>
</figure>

## Prerequisites

This guide assumes a production-grade async Python stack talking to a Neo4j instance with spatial point support. The planner directives and `point.distance` semantics used below are stable on Neo4j 5.x; the optional Graph Data Science (GDS) routing calls require the GDS plugin.

| Requirement | Minimum version | Notes |
| --- | --- | --- |
| Python | 3.10+ | `match`/union types (`dict \| None`) used in examples |
| Neo4j | 5.13+ | Native `point` type, `USING INDEX`, point indexes |
| neo4j (driver) | 5.x | Async driver (`AsyncGraphDatabase`) |
| graphdatascience / GDS plugin | 2.5+ | Only for the GDS `shortestPath` variant |
| shapely | 2.0+ | Client-side geometry validation |
| pyproj | 3.6+ | CRS checks before ingestion-time filtering |

```bash
pip install "neo4j>=5.18" "shapely>=2.0" "pyproj>=3.6" "geopy>=2.4"
```

Before tuning the planner, confirm your graph already follows sound [node and edge spatial mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/) conventions — coordinates stored as native `point` values on traversal primitives, not as detached string properties the planner cannot index.

## Core Concept & Mechanism

The Cypher planner is cost-based: for every candidate plan it estimates the number of rows each operator will emit, multiplies by a per-operator cost, and picks the cheapest total. Those estimates come from stored statistics — label counts, relationship-type counts, and property index selectivity. The problem is that none of those histograms capture *spatial* skew. The planner has no idea that 90% of your `Depot` nodes cluster in three metro regions, so it treats `point.distance(...) < 3000` as an opaque post-filter applied after the rows already exist.

That ordering is the root cause of the blow-up. When a geographic predicate runs *after* expansion, the engine must first materialize every reachable node, then discard most of them. The fix is to give the planner a cheap, index-backed entry point that is *already* spatially bounded, so expansion starts from a small set. Three mechanisms make that happen:

1. **Index anchoring.** A `NodeIndexSeek` on a selective property (a region code, a zone id) replaces an `AllNodesScan` or broad `NodeByLabelScan`. The starting set shrinks from "all depots" to "depots in this metro".
2. **Predicate ordering.** Distance and weight predicates are placed where they prune the most rows the earliest — on the anchor or on the path's terminal node, never recomputed inside the pathfinding loop.
3. **Bounded traversal.** Variable-length patterns get an explicit upper bound (`*1..40`) so the expansion cannot run away on a cyclic road graph.

A useful way to reason about whether your distance filter is doing real work is the admissibility bound that A\*-style routing relies on. The straight-line (great-circle) distance must never overestimate the true road distance, or the search prunes valid paths:

$$h(n) \le d(n, goal) \le g(n) + h(n)$$

where $h(n)$ is the heuristic (Haversine to the goal), $d(n, goal)$ is the real remaining cost, and $g(n)$ is the cost already accumulated. Keeping the distance predicate *outside* the path expansion preserves this monotonicity — recomputing it per hop breaks it and silently corrupts results.

## Schema & Data Model

The planner can only seek an index that exists. The model below stores depot geometry as a native `point`, ties each depot to a `ServiceZone` through a `SERVES` relationship, and carries routable cost on the `ROAD_SEGMENT` edge. The `region_code` index is the anchor that lets the planner enter the graph in a spatially bounded way; the point index lets distance filters resolve without scanning.

```cypher
// Selective anchor index — the entry point for bounded expansion
CREATE INDEX zone_region IF NOT EXISTS
FOR (z:ServiceZone) ON (z.region_code);

// Lookup index for resolving depots by business key
CREATE INDEX depot_code IF NOT EXISTS
FOR (d:Depot) ON (d.code);

// Point index so point.distance() predicates are index-backed, not post-filters
CREATE POINT INDEX depot_coords IF NOT EXISTS
FOR (d:Depot) ON (d.coords);

// Edge property the pathfinder filters on; keep it numeric and present on every segment
CREATE INDEX segment_weight IF NOT EXISTS
FOR ()-[r:ROAD_SEGMENT]-() ON (r.weight_limit);
```

```cypher
// Representative shape of the routable graph
// (:Depot {code, coords: point({latitude, longitude}), region})
//   -[:SERVES]-> (:ServiceZone {region_code, bbox_min, bbox_max})
// (:Depot)-[:ROAD_SEGMENT {weight_limit, length_m, travel_s}]-> (:Depot)
```

Decisions about which physical index type backs `coords` — point index, R-tree, or a precomputed bucket — belong to your [spatial indexing strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) layer; the planner simply consumes whatever selectivity that layer exposes.

## Step-by-Step Implementation

The optimization is a transformation: take the query the planner gets wrong, and rewrite it so the only plan that survives is the bounded one. We build it in four steps, then wrap it in an async executor.

### 1. Diagnose the naive plan

Start from the obvious query and read its plan with `PROFILE`. This version expands first and filters coordinates afterward — exactly the anti-pattern.

```cypher
PROFILE
MATCH (o:Depot {code: $origin_code})-[:ROAD_SEGMENT]->(n)
WHERE point.distance(n.coords, point({latitude: $lat, longitude: $lon})) < 3000
MATCH p = shortestPath((o)-[:ROAD_SEGMENT*1..40]->(d:Depot {code: $dest_code}))
WHERE ALL(r IN relationships(p) WHERE r.weight_limit >= $cargo_tons)
RETURN p
```

In the profile you will typically see a `NodeByLabelScan` on `Depot` and a `Filter` carrying the distance predicate downstream of a large `Expand(All)` — the row count climbs before it falls.

### 2. Anchor on a selective index

Resolve the origin through its `ServiceZone` so expansion starts from a geographically bounded subset, and pin the entry point with `USING INDEX`.

```cypher
PROFILE
MATCH (zone:ServiceZone {region_code: $metro_id})
USING INDEX zone:ServiceZone(region_code)
MATCH (o:Depot)-[:SERVES]->(zone)
WHERE o.code = $origin_code
MATCH p = shortestPath((o)-[:ROAD_SEGMENT*1..40]->(d:Depot))
WHERE d.code = $dest_code
  AND point.distance(d.coords, point({latitude: $lat, longitude: $lon})) < 3000
  AND ALL(r IN relationships(p) WHERE r.weight_limit >= $cargo_tons)
RETURN p
```

The `USING INDEX` directive eliminates the label scan. By resolving the origin through a zone relationship, the planner restricts the starting expansion set to a bounded region. The distance predicate now sits on the *terminal* node `d` and stays outside the `shortestPath` expansion, which preserves the monotonicity the algorithm depends on.

### 3. Push the predicate to the anchor when possible

If your access pattern is "everything near a point" rather than "between two fixed depots", filter the anchor itself so the point index does the pruning before any expansion. This is the same predicate shape used by [distance filter query patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/).

```cypher
PROFILE
MATCH (o:Depot)
WHERE point.distance(o.coords, point($target)) < $radius
MATCH p = shortestPath((o)-[:ROAD_SEGMENT*1..40]->(d:Depot {code: $dest_code}))
WHERE ALL(r IN relationships(p) WHERE r.weight_limit >= $cargo_tons)
RETURN p ORDER BY length(p) LIMIT 1
```

### 4. Wrap it in a bounded async executor

In production these queries must run asynchronously over a bounded connection pool, with client-side geometry validation rejecting malformed coordinates before they ever reach the planner.

```python
import asyncio
from neo4j import AsyncGraphDatabase
from shapely.geometry import Point


class SpatialRouteExecutor:
    def __init__(self, uri: str, user: str, password: str, pool_size: int = 12):
        self.driver = AsyncGraphDatabase.driver(
            uri,
            auth=(user, password),
            max_connection_pool_size=pool_size,
            connection_acquisition_timeout=5.0,
            encrypted=True,
        )

    @staticmethod
    def validate_spatial_bounds(lat: float, lon: float) -> bool:
        # Reject out-of-CRS coordinates before they cost a network round trip
        if not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
            return False
        return Point(lon, lat).is_valid

    async def resolve_optimized_route(
        self, region: str, origin: str, dest: str,
        lat: float, lon: float, cargo: float,
    ) -> dict | None:
        if not self.validate_spatial_bounds(lat, lon):
            raise ValueError("Invalid coordinate geometry or out-of-bounds CRS")

        query = """
        MATCH (zone:ServiceZone {region_code: $region})
        USING INDEX zone:ServiceZone(region_code)
        MATCH (o:Depot)-[:SERVES]->(zone)
        WHERE o.code = $origin
        MATCH p = shortestPath((o)-[:ROAD_SEGMENT*1..40]->(d:Depot))
        WHERE d.code = $dest
          AND point.distance(d.coords, point($target)) < $radius
          AND ALL(r IN relationships(p) WHERE r.weight_limit >= $cargo)
        RETURN p
        """
        params = {
            "region": region,
            "origin": origin,
            "dest": dest,
            "target": {"latitude": lat, "longitude": lon},
            "radius": 3000.0,
            "cargo": cargo,
        }

        async with self.driver.session(database="routing_prod") as session:
            result = await session.run(query, params)
            record = await result.single()
            if record:
                path = record["p"]
                return {
                    "path_id": path.element_id,
                    "hops": len(path.nodes) - 1,
                    "status": "resolved",
                }
            return None

    async def close(self) -> None:
        await self.driver.close()
```

Bounded pooling keeps concurrent dispatch requests reusing established TCP sessions instead of exhausting the pool. Note that `PROFILE`/`EXPLAIN` are removed from the production query string — you profile in development to *choose* the plan, then ship the bare query so you do not pay execution-time profiling overhead. See the official [Python asyncio documentation](https://docs.python.org/3/library/asyncio.html) for event-loop and backpressure tuning under high request fan-out.

## Query Patterns & Variants

The same routing intent has several plan-able shapes. Pick the one whose anchor matches the way your callers actually parameterize requests.

**Variant A — fixed endpoints, zone-anchored.** Best when origin and destination are both known business keys. The zone seek bounds the start; the distance check on `d` is a cheap guard rail.

```cypher
MATCH (zone:ServiceZone {region_code: $metro_id})
USING INDEX zone:ServiceZone(region_code)
MATCH (o:Depot)-[:SERVES]->(zone) WHERE o.code = $origin_code
MATCH p = shortestPath((o)-[:ROAD_SEGMENT*1..40]->(d:Depot {code: $dest_code}))
RETURN p
// $metro_id must be the HIGH-selectivity key; if region holds millions of zones,
// add a composite index instead of relying on a single low-cardinality column.
```

**Variant B — nearest reachable, point-anchored.** Best when the destination is "closest hub satisfying a constraint" rather than a fixed node. This overlaps with [k-nearest-neighbor routing](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/k-nearest-neighbor-routing/); cap the candidate set with `LIMIT` *before* pathfinding.

```cypher
MATCH (o:Depot {code: $origin_code})
CALL {
  WITH o
  MATCH (d:Depot)
  WHERE point.distance(d.coords, o.coords) < $radius AND d.capacity >= $cargo
  RETURN d ORDER BY point.distance(d.coords, o.coords) LIMIT 5
}
MATCH p = shortestPath((o)-[:ROAD_SEGMENT*1..40]->(d))
RETURN p ORDER BY length(p) LIMIT 1
// The subquery LIMITs candidates so shortestPath runs at most 5 times, not N times.
```

**Variant C — GDS weighted shortest path.** When you need true edge-weighted cost (travel time, not hop count), project a bounded subgraph and run GDS Dijkstra. Project only the zone, never the whole graph.

```cypher
MATCH (src:Depot {code: $origin_code}), (dst:Depot {code: $dest_code})
CALL gds.shortestPath.dijkstra.stream('zone_subgraph', {
  sourceNode: src, targetNode: dst, relationshipWeightProperty: 'travel_s'
})
YIELD totalCost, path
RETURN totalCost, path
// 'zone_subgraph' is a named projection scoped to one region — projecting the
// full graph here is the single most common GDS memory blow-up.
```

## Performance Tuning

Profiling is the whole game. `EXPLAIN` returns the plan without running it (use it to validate plan shape in CI); `PROFILE` runs the query and annotates each operator with real `db hits` and `rows`. Read the plan bottom-up and look for the first operator whose `rows` is far larger than the final result — that is where a predicate or index belongs.

- **Refresh statistics after bulk loads.** Stale histograms produce wrong cardinality estimates. After large ingestion or weight rewrites, recompute so the cost model sees reality. These ingestion-side concerns connect directly to your async batch loading and the broader patterns in [Cypher performance tuning](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/).
- **Keep plans cacheable.** Always parameterize. Literal-in-query values force recompilation and thrash the plan cache; stable parameter type signatures maximize cache hit rate.
- **Budget memory explicitly.** Size the page cache to hold the hot region's nodes and relationships, and bound `dbms.memory.transaction.total.max` so one runaway route cannot OOM the instance. The Python side mirrors this with `max_connection_pool_size`.
- **Hint sparingly.** `USING INDEX` is the right tool when the planner picks a scan over a known-selective seek. Do not scatter hints everywhere — an over-constrained query can force a *worse* plan when data shifts.
- **Batch writes away from reads.** Run index rebuilds and weight updates in maintenance windows; index fragmentation after bulk edge updates directly degrades planner selectivity.

A practical loop: capture `PROFILE` for the slow query, find the widest operator, add the index or reorder the predicate that narrows it, then re-profile and confirm `db hits` dropped. Repeat until the largest intermediate row count is within a small multiple of the result size.

<figure class="svg-figure">
<svg viewBox="0 0 880 500" role="img" aria-labelledby="prof-title prof-desc" xmlns="http://www.w3.org/2000/svg">
  <title id="prof-title">Annotated PROFILE operator tree with rows and db hits</title>
  <desc id="prof-desc">A vertical PROFILE plan read bottom-up: NodeIndexSeek on ServiceZone emits one row, Expand(All) inflates to forty-eight thousand rows and ninety-six thousand database hits, then a Filter, shortestPath, and ProduceResults collapse back to one row. The Expand operator is highlighted as the widest operator and the tuning target, the place to add a bound or push a predicate.</desc>
  <style>
    .pf-box{fill:var(--surface-2,#f4f4f5);stroke:var(--line-strong,#9ca3af);stroke-width:1.5;}
    .pf-hot{fill:var(--surface-2,#f4f4f5);stroke:var(--accent-coral,#ff6b6b);stroke-width:2.5;}
    .pf-op{fill:var(--ink,#1f2937);font:600 15px var(--font-sans,system-ui,sans-serif);}
    .pf-sub{fill:var(--ink-mute,#6b7280);font:12px var(--font-mono,ui-monospace,monospace);}
    .pf-hd{fill:var(--ink-mute,#6b7280);font:700 12px var(--font-sans,system-ui,sans-serif);letter-spacing:.04em;}
    .pf-num{fill:var(--ink,#1f2937);font:600 14px var(--font-mono,ui-monospace,monospace);}
    .pf-hotnum{fill:var(--accent-coral,#ff6b6b);font:700 14px var(--font-mono,ui-monospace,monospace);}
    .pf-flow{stroke:currentColor;stroke-width:1.5;fill:none;opacity:.55;}
    .pf-read{stroke:var(--accent,#0e7c86);stroke-width:1.5;fill:none;stroke-dasharray:5 4;}
    .pf-readtxt{fill:var(--accent,#0e7c86);font:600 12px var(--font-sans,system-ui,sans-serif);}
    .pf-call{fill:var(--accent-coral,#ff6b6b);font:600 13px var(--font-sans,system-ui,sans-serif);}
  </style>
  <defs>
    <marker id="pf-arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor" opacity=".55"/>
    </marker>
    <marker id="pf-rarr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="var(--accent,#0e7c86)"/>
    </marker>
  </defs>
  <!-- column headers -->
  <rect class="viz-backdrop" x="0" y="0" width="880" height="500" fill="var(--viz-bg,#ffffff)"/>
  <text class="pf-hd" x="60" y="28">OPERATOR</text>
  <text class="pf-hd" x="470" y="28" text-anchor="middle">ROWS</text>
  <text class="pf-hd" x="585" y="28" text-anchor="middle">DB HITS</text>
  <!-- data-flow connectors (data flows upward, bottom-up) -->
  <line class="pf-flow" x1="210" y1="378" x2="210" y2="346" marker-end="url(#pf-arr)"/>
  <line class="pf-flow" x1="210" y1="294" x2="210" y2="262" marker-end="url(#pf-arr)"/>
  <line class="pf-flow" x1="210" y1="210" x2="210" y2="178" marker-end="url(#pf-arr)"/>
  <line class="pf-flow" x1="210" y1="126" x2="210" y2="94" marker-end="url(#pf-arr)"/>
  <!-- b1 ProduceResults -->
  <rect class="pf-box" x="60" y="42" width="300" height="52" rx="8"/>
  <text class="pf-op" x="78" y="65">ProduceResults</text>
  <text class="pf-sub" x="78" y="83">p</text>
  <text class="pf-num" x="470" y="74" text-anchor="middle">1</text>
  <text class="pf-num" x="585" y="74" text-anchor="middle">1</text>
  <!-- b2 ShortestPath -->
  <rect class="pf-box" x="60" y="126" width="300" height="52" rx="8"/>
  <text class="pf-op" x="78" y="149">ShortestPath</text>
  <text class="pf-sub" x="78" y="167">*1..40</text>
  <text class="pf-num" x="470" y="158" text-anchor="middle">1</text>
  <text class="pf-num" x="585" y="158" text-anchor="middle">412</text>
  <!-- b3 Filter -->
  <rect class="pf-box" x="60" y="210" width="300" height="52" rx="8"/>
  <text class="pf-op" x="78" y="233">Filter</text>
  <text class="pf-sub" x="78" y="251">weight_limit &gt;= $cargo</text>
  <text class="pf-num" x="470" y="242" text-anchor="middle">6</text>
  <text class="pf-num" x="585" y="242" text-anchor="middle">96</text>
  <!-- b4 Expand(All) — widest / hot -->
  <rect class="pf-hot" x="60" y="294" width="300" height="52" rx="8"/>
  <text class="pf-op" x="78" y="317">Expand(All)</text>
  <text class="pf-sub" x="78" y="335">:ROAD_SEGMENT</text>
  <text class="pf-hotnum" x="470" y="326" text-anchor="middle">48 200</text>
  <text class="pf-hotnum" x="585" y="326" text-anchor="middle">96 400</text>
  <!-- b5 NodeIndexSeek -->
  <rect class="pf-box" x="60" y="378" width="300" height="52" rx="8"/>
  <text class="pf-op" x="78" y="401">NodeIndexSeek</text>
  <text class="pf-sub" x="78" y="419">:ServiceZone(region_code)</text>
  <text class="pf-num" x="470" y="410" text-anchor="middle">1</text>
  <text class="pf-num" x="585" y="410" text-anchor="middle">2</text>
  <!-- tuning-target callout on the hot operator -->
  <line x1="360" y1="320" x2="656" y2="320" class="pf-flow" stroke="var(--accent-coral,#ff6b6b)" opacity="1" marker-end="url(#pf-arr)" style="color:var(--accent-coral,#ff6b6b)"/>
  <text class="pf-call" x="668" y="312">widest operator —</text>
  <text class="pf-call" x="668" y="330">tune here: bound the</text>
  <text class="pf-call" x="668" y="348">traversal / push a predicate</text>
  <!-- read bottom-up indicator -->
  <line class="pf-read" x1="30" y1="424" x2="30" y2="48" marker-end="url(#pf-rarr)"/>
  <text class="pf-readtxt" x="22" y="240" text-anchor="middle" transform="rotate(-90 22 240)">read bottom-up</text>
</svg>

<figcaption>Read the PROFILE plan bottom-up and find the first operator whose row count dwarfs the final result — here Expand(All). That is where an index, a tighter bound, or a reordered predicate pays off.</figcaption>
</figure>

## Edge Cases & Gotchas

- **Distance inside the pathfinder.** Putting `point.distance(...)` inside the `shortestPath` relationship predicate makes the engine recompute it per hop and breaks the monotonicity A\*/Dijkstra assume. Keep it on the anchor or terminal node.
- **Mixed CRS coordinates.** A `point({latitude, longitude})` (geographic, SRID 4326) and a `point({x, y})` (Cartesian, SRID 7203) are not comparable; `point.distance` across SRIDs returns `null`, and a `null` predicate silently drops rows. Normalize CRS at ingestion.
- **Coordinate precision traps.** Float rounding on dense urban grids can make two segment endpoints "almost equal", creating phantom dead-ends or duplicate nodes. Snap to a fixed tolerance during mapping, not at query time.
- **Unbounded variable-length paths.** `*` or a high upper bound on a cyclic road graph lets expansion explode. Always cap (`*1..40`) and prefer GDS for genuinely long routes.
- **Low-selectivity anchors.** `USING INDEX` on a column with few distinct values (e.g. a `country` field) "succeeds" but seeks a huge bucket. Verify the anchor is actually selective before hinting it.
- **GDS projection scope.** Projecting the entire graph for a single intra-region route is the most common GDS OOM. Scope every projection to the bounded subgraph you actually traverse.

## Verification & Testing

Optimizing a plan is only safe if you can prove the optimized query returns the *same* answer as the naive one, just faster. Assert correctness with deterministic fixtures: path existence, hop count, and the invariant that every edge on the returned path satisfies the weight constraint.

```python
import pytest
from neo4j import AsyncGraphDatabase

SEED = """
CREATE (z:ServiceZone {region_code: 'TEST-01'})
CREATE (a:Depot {code: 'A', coords: point({latitude: 47.60, longitude: -122.33}), capacity: 30})
CREATE (b:Depot {code: 'B', coords: point({latitude: 47.62, longitude: -122.35}), capacity: 30})
CREATE (c:Depot {code: 'C', coords: point({latitude: 47.64, longitude: -122.30}), capacity: 30})
CREATE (a)-[:SERVES]->(z), (b)-[:SERVES]->(z), (c)-[:SERVES]->(z)
CREATE (a)-[:ROAD_SEGMENT {weight_limit: 40}]->(b)
CREATE (b)-[:ROAD_SEGMENT {weight_limit: 40}]->(c)
"""


@pytest.mark.asyncio
async def test_optimized_route_matches_constraints():
    driver = AsyncGraphDatabase.driver("bolt://localhost:7687", auth=("neo4j", "test"))
    async with driver.session(database="neo4j") as s:
        await s.run("MATCH (n) DETACH DELETE n")
        await s.run(SEED)

        rec = await (await s.run(
            """
            MATCH (zone:ServiceZone {region_code: 'TEST-01'})
            MATCH (o:Depot)-[:SERVES]->(zone) WHERE o.code = 'A'
            MATCH p = shortestPath((o)-[:ROAD_SEGMENT*1..40]->(d:Depot {code: 'C'}))
            WHERE ALL(r IN relationships(p) WHERE r.weight_limit >= 25)
            RETURN p, length(p) AS hops
            """
        )).single()

    assert rec is not None, "expected a path A->C to exist"
    assert rec["hops"] == 2, "shortest A->C should traverse exactly two segments"
    assert all(r["weight_limit"] >= 25 for r in rec["p"].relationships)
    await driver.close()
```

Pair this with a plan-shape check in CI: run `EXPLAIN` and assert the plan contains a `NodeIndexSeek` (not a label scan) by inspecting the summary returned from `result.consume()`. A regression that turns a seek back into a scan will not change results — only latency — so a correctness test alone will not catch it.

## FAQ

<details>
<summary>Why does the planner ignore my point index even though it exists?</summary>

Most often the distance predicate is positioned after an expansion, so by the time it runs the rows already exist and there is nothing left to seek. Move the predicate onto an anchor node that the planner can enter through the point index, and confirm with `PROFILE` that you see a `PointIndexSeek` rather than a `Filter` on `point.distance`. Stale statistics after a bulk load can also make the planner undervalue the index — refresh them.
</details>

<details>
<summary>When should I use USING INDEX versus letting the planner decide?</summary>

Trust the planner by default. Reach for `USING INDEX` only when a `PROFILE` shows it choosing a scan over a known-selective seek, usually because spatial skew is invisible to the histograms. Treat the hint as a targeted correction, re-profile after data changes, and remove it if it ever forces a worse plan.
</details>

<details>
<summary>Should weighted routing use shortestPath or GDS Dijkstra?</summary>

`shortestPath` minimizes hop count and is ideal for unweighted reachability inside a bounded region. When the real objective is weighted cost — travel time, fuel, capacity-adjusted distance — project a region-scoped subgraph and run GDS Dijkstra with `relationshipWeightProperty`. The decisive constraint is projection scope: never project the full graph for an intra-region route.
</details>

<details>
<summary>How do I keep plans stable when parameters change constantly?</summary>

Parameterize every query so the plan cache can reuse compiled plans, and keep parameter type signatures stable (do not send an int one call and a float the next). Avoid literal values baked into the query string, and refresh statistics after large ingestion so cached cost estimates stay accurate.
</details>

<details>
<summary>My distance filter silently returns no rows — what happened?</summary>

Almost always a CRS mismatch. `point.distance` between a geographic point (SRID 4326) and a Cartesian point (SRID 7203) returns `null`, and the `null` predicate drops the row instead of erroring. Normalize all coordinates to one CRS at ingestion and assert the SRID before querying.
</details>

## Related

- [Spatial Indexing Strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) — choosing the index type whose selectivity the planner consumes.
- [Node and Edge Spatial Mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/) — storing geometry as native points so it can be indexed.
- [Optimizing Cypher Query Plans for Spatial Data](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/optimizing-cypher-query-plans-for-spatial-data/) — a deeper walkthrough of plan rewrites and cost-model overrides.
- [Reading EXPLAIN and PROFILE Plans for Spatial Queries](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/reading-explain-and-profile-plans-for-spatial-queries/) — a field guide to operator trees and finding the row-explosion operator.
- [Forcing Index Seeks with Cypher Planner Hints](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/forcing-index-seeks-with-cypher-planner-hints/) — when and how to pin the planner onto a point-index seek.
- [Cypher Performance Tuning](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/) — profiling, memory configuration, and batching across query workloads.
- [Distance Filter Query Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/) — predicate shapes that resolve against spatial indexes.

This guide is part of [Spatial Graph Database Fundamentals for Python](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/).

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "Why does the planner ignore my point index even though it exists?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Most often the distance predicate is positioned after an expansion, so the rows already exist and there is nothing left to seek. Move the predicate onto an anchor node the planner can enter through the point index, and confirm with PROFILE that you see a PointIndexSeek rather than a Filter on point.distance. Stale statistics after a bulk load can also make the planner undervalue the index, so refresh them."
      }
    },
    {
      "@type": "Question",
      "name": "When should I use USING INDEX versus letting the planner decide?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Trust the planner by default. Reach for USING INDEX only when a PROFILE shows it choosing a scan over a known-selective seek, usually because spatial skew is invisible to the histograms. Treat the hint as a targeted correction, re-profile after data changes, and remove it if it ever forces a worse plan."
      }
    },
    {
      "@type": "Question",
      "name": "Should weighted routing use shortestPath or GDS Dijkstra?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "shortestPath minimizes hop count and suits unweighted reachability inside a bounded region. When the objective is weighted cost such as travel time or fuel, project a region-scoped subgraph and run GDS Dijkstra with relationshipWeightProperty. Never project the full graph for an intra-region route."
      }
    },
    {
      "@type": "Question",
      "name": "How do I keep plans stable when parameters change constantly?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Parameterize every query so the plan cache can reuse compiled plans, and keep parameter type signatures stable. Avoid literal values baked into the query string, and refresh statistics after large ingestion so cached cost estimates stay accurate."
      }
    },
    {
      "@type": "Question",
      "name": "My distance filter silently returns no rows — what happened?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Almost always a CRS mismatch. point.distance between a geographic point (SRID 4326) and a Cartesian point (SRID 7203) returns null, and the null predicate drops the row instead of erroring. Normalize all coordinates to one CRS at ingestion and assert the SRID before querying."
      }
    }
  ]
}
</script>
