---
pageTitle: Haversine Distance Filtering in Cypher
---
# Filtering Graph Paths by Haversine Distance in Cypher

A variable-length `MATCH` over a dense road or transit network expands combinatorially, and if you compute spherical distance *after* the paths are materialized, the JVM heap fills with millions of permutations before a single one is rejected — the symptom is a routing endpoint that passes staging and then throws `OutOfMemoryError` or times out the moment real traffic clusters in one city. The root cause is post-query evaluation: the planner buffers every candidate path, then the application filters. This page resolves it by pushing a cumulative `point.distance()` accumulator into the `WHERE` pipeline of the path match itself, so geometrically implausible branches are discarded as the expansion runs rather than after it finishes. This is the segment-level case of the broader [distance filter query patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/) — where each hop is checked, not just the endpoint.

## Prerequisites & Versions

The accumulator below relies on native `point` support and the `reduce()` list function, both stable on Neo4j 5.x. The Python side uses the official async driver; no APOC or GDS dependency is required for the filter itself.

| Requirement | Minimum version | Install / note |
| --- | --- | --- |
| Python | 3.10+ | `tuple[str, str]` and union syntax used below |
| Neo4j | 5.13+ | Native `point`, `CREATE POINT INDEX`, `point.distance()` |
| neo4j (driver) | 5.x | `AsyncGraphDatabase`, native point serialization |

```bash
pip install "neo4j>=5.18"
```

This pattern assumes your graph already follows sound [node and edge spatial mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/) conventions — coordinates stored as native `point` values on the nodes, edge lengths kept distinct from routing weights — and that a [spatial indexing strategy](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) backs the anchor property so the initial node lookup seeks rather than scans.

## Implementation

The query computes cumulative great-circle distance across every relationship in a bounded variable-length path, enforces a hard meter threshold, and returns only surviving paths sorted shortest-first. The `reduce()` accumulator walks the relationship stream, summing `point.distance()` between each edge's start and end node.

```cypher
// One-time: native point index so the anchor lookup seeks instead of scans
CREATE POINT INDEX location_spatial_idx IF NOT EXISTS
FOR (l:Location) ON (l.location);
```

```cypher
MATCH path = (start:Location {id: $start_id})-[:CONNECTS*1..8]->(end:Location {id: $end_id})
WITH path,
     reduce(cumulative_m = 0.0, r IN relationships(path) |
         cumulative_m + point.distance(startNode(r).location, endNode(r).location)) AS dist_m
WHERE dist_m <= $max_meters
RETURN path, dist_m
ORDER BY dist_m ASC
LIMIT 50
```

<svg viewBox="0 0 720 410" role="img" aria-labelledby="havTitle havDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="havTitle">Inline cumulative-distance pruning during a variable-length path expansion</title>
  <desc id="havDesc">A path expands hop by hop from a start node. Each relationship is labelled with its point.distance() segment length, and a running cumulative sum is shown beneath every node. At the third node the expansion forks: one branch reaches the end at 11.3 km, under the 12 km max_meters budget, and is kept; the other branch reaches 13.8 km, exceeds the budget, and is pruned by the WHERE clause before it can expand further. Two budget bars below compare each branch against the 12 km threshold.</desc>
  <defs>
    <marker id="havArr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
    <marker id="havArrCut" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="var(--accent-coral,#ff6b6b)"/>
    </marker>
  </defs>
  <text x="20" y="26" font-size="14.5" font-weight="700" fill="currentColor">Cumulative pruning as the path expands</text>
  <text x="700" y="26" text-anchor="end" font-size="11.5" fill="var(--accent,#0e7c86)" font-weight="700">$max_meters = 12.0 km</text>
  <!-- ===== edges ===== -->
  <!-- kept trunk -->
  <line x1="78" y1="150" x2="197" y2="150" stroke="currentColor" stroke-width="2" marker-end="url(#havArr)"/>
  <line x1="233" y1="150" x2="352" y2="150" stroke="currentColor" stroke-width="2" marker-end="url(#havArr)"/>
  <!-- B -> END (kept) -->
  <line x1="386" y1="166" x2="548" y2="232" stroke="var(--accent,#0e7c86)" stroke-width="2.4" marker-end="url(#havArr)"/>
  <!-- B -> X (pruned) -->
  <line x1="386" y1="134" x2="533" y2="84" stroke="var(--accent-coral,#ff6b6b)" stroke-width="2" stroke-dasharray="6 4" marker-end="url(#havArrCut)" opacity="0.85"/>
  <!-- segment-distance labels -->
  <text x="137" y="140" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.85">+3.1 km</text>
  <text x="292" y="140" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.85">+4.2 km</text>
  <text x="476" y="196" text-anchor="middle" font-size="10.5" fill="var(--accent,#0e7c86)" font-weight="600">+4.0 km</text>
  <text x="452" y="106" text-anchor="middle" font-size="10.5" fill="var(--accent-coral,#ff6b6b)" font-weight="600">+6.5 km</text>
  <!-- scissors / cut glyph on pruned edge -->
  <text x="468" y="124" text-anchor="middle" font-size="14" fill="var(--accent-coral,#ff6b6b)">&#9986;</text>
  <!-- ===== nodes ===== -->
  <!-- S -->
  <circle cx="60" cy="150" r="13" fill="var(--accent,#0e7c86)"/>
  <text x="60" y="154" text-anchor="middle" font-size="11" font-weight="700" fill="#fff">S</text>
  <text x="60" y="182" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.85">&#931; 0.0 km</text>
  <!-- A -->
  <circle cx="215" cy="150" r="13" fill="currentColor"/>
  <text x="215" y="154" text-anchor="middle" font-size="11" font-weight="700" fill="var(--bg,#fff)">n1</text>
  <text x="215" y="182" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.85">&#931; 3.1 km</text>
  <!-- B (fork) -->
  <circle cx="370" cy="150" r="13" fill="currentColor"/>
  <text x="370" y="154" text-anchor="middle" font-size="11" font-weight="700" fill="var(--bg,#fff)">n2</text>
  <text x="370" y="182" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.85">&#931; 7.3 km</text>
  <!-- END (kept) -->
  <circle cx="560" cy="240" r="13" fill="var(--accent,#0e7c86)"/>
  <text x="560" y="244" text-anchor="middle" font-size="10" font-weight="700" fill="#fff">end</text>
  <text x="560" y="270" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--accent,#0e7c86)">&#931; 11.3 km &#10003; kept</text>
  <!-- X (pruned) -->
  <circle cx="545" cy="76" r="13" fill="none" stroke="var(--accent-coral,#ff6b6b)" stroke-width="2" stroke-dasharray="4 3"/>
  <text x="545" y="80" text-anchor="middle" font-size="11" font-weight="700" fill="var(--accent-coral,#ff6b6b)">&#10005;</text>
  <text x="545" y="52" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--accent-coral,#ff6b6b)">&#931; 13.8 km &gt; budget</text>
  <text x="660" y="80" text-anchor="middle" font-size="9.5" fill="var(--accent-coral,#ff6b6b)" opacity="0.9">pruned before</text>
  <text x="660" y="92" text-anchor="middle" font-size="9.5" fill="var(--accent-coral,#ff6b6b)" opacity="0.9">further expansion</text>
  <!-- ===== budget bars ===== -->
  <!-- scale: x0=150, 24 px per km, threshold 12 km -> x=438 -->
  <line x1="438" y1="312" x2="438" y2="392" stroke="var(--accent,#0e7c86)" stroke-width="1.4" stroke-dasharray="3 4" opacity="0.8"/>
  <text x="438" y="306" text-anchor="middle" font-size="9.5" fill="var(--accent,#0e7c86)" opacity="0.9">12 km</text>
  <text x="20" y="338" font-size="10.5" fill="currentColor" opacity="0.85">kept path</text>
  <rect x="150" y="328" width="200" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <rect x="150" y="328" width="271.2" height="14" rx="3" fill="var(--accent,#0e7c86)" opacity="0.85"/>
  <text x="20" y="378" font-size="10.5" fill="currentColor" opacity="0.85">pruned path</text>
  <rect x="150" y="368" width="200" height="14" rx="3" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <rect x="150" y="368" width="288" height="14" rx="3" fill="var(--accent-coral,#ff6b6b)" opacity="0.45"/>
  <rect x="438" y="368" width="43.2" height="14" rx="3" fill="var(--accent-coral,#ff6b6b)"/>
  <text x="488" y="378" font-size="9.5" fill="var(--accent-coral,#ff6b6b)" font-weight="700">over budget</text>
</svg>

Driven from a pooled async service, the whole thing is a single self-contained coroutine. Thresholds and node ids are passed as parameters so the driver serializes them into the binary protocol and the plan stays cacheable:

```python
import asyncio
from neo4j import AsyncGraphDatabase

QUERY = """
MATCH path = (start:Location {id: $start_id})-[:CONNECTS*1..8]->(end:Location {id: $end_id})
WITH path,
     reduce(cumulative_m = 0.0, r IN relationships(path) |
         cumulative_m + point.distance(startNode(r).location, endNode(r).location)) AS dist_m
WHERE dist_m <= $max_meters
RETURN path, dist_m
ORDER BY dist_m ASC
LIMIT 50
"""


async def filter_paths_by_haversine(
    uri: str,
    auth: tuple[str, str],
    start_id: str,
    end_id: str,
    max_km: float,
) -> list:
    driver = AsyncGraphDatabase.driver(
        uri,
        auth=auth,
        max_connection_pool_size=50,
        connection_acquisition_timeout=5.0,
        max_connection_lifetime=3600,
    )
    try:
        async with driver.session(database="neo4j") as session:
            result = await session.run(
                QUERY,
                start_id=start_id,
                end_id=end_id,
                max_meters=max_km * 1000,  # point.distance() returns meters
            )
            return [record["path"] async for record in result]
    finally:
        await driver.close()


if __name__ == "__main__":
    paths = asyncio.run(
        filter_paths_by_haversine(
            "neo4j+s://your-cluster.databases.neo4j.io",
            ("neo4j", "secure-password"),
            start_id="N-1001",
            end_id="N-2087",
            max_km=12.0,
        )
    )
    print(f"Resolved {len(paths)} paths within the distance envelope.")
```

## How It Works

The performance comes from *where* the predicate runs, not from any exotic function. Three mechanics carry it:

- **Inline pruning.** The `WHERE dist_m <= $max_meters` clause sits immediately after the `reduce()` projection, so the planner evaluates the accumulator and rejects over-budget paths before buffering them for `RETURN`. Paths that blow the envelope never reach the heap as result rows.
- **Native spherical arithmetic.** `point.distance()` operates directly on WGS 84 (SRID 4326) coordinates and applies the great-circle (Haversine) formula server-side. No custom trigonometric UDFs, no client round-trips, no external geospatial library.
- **Bounded recursion.** `*1..8` caps the expansion horizon. An unbounded `[:CONNECTS*]` will materialize the entire connected component regardless of the distance threshold — the cap is what keeps the combinatorics finite so the filter has anything to prune against.

A coordinate-ordering caveat threads through all of it: WGS 84 points constructed with positional arguments follow the `(longitude, latitude)` convention, so the unambiguous named form — `point({latitude: $lat, longitude: $lon})` — is preferred at ingestion. Misordered positional coordinates introduce silent spatial drift that compounds across every hop of a multi-segment path. Validate coordinate ingestion before indexing, not at query time.

Why the cumulative accumulator rather than a single endpoint check: bounding only the destination tells you *where* a route may finish, but a path can wander far outside the envelope and still land near the target. Summing per-segment distance bounds the route's *total length as it expands*, which is the semantics routing actually needs. Bounding the endpoint as well (a cheap index-seekable range predicate) is a useful first-stage complement covered in the parent [distance filter query patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/).

## Common Failure Patterns

**1. Full label scan instead of an index seek.** Variable-length matches with `reduce()` still scan the whole label if no spatial index backs the anchor lookup. Run `PROFILE` and read the plan bottom-up: a healthy query shows a `NodeIndexSeekByRange` (point index) feeding the expansion. If you see `NodeByLabelScan`, the seek failed — usually because the index is missing, the `location` property holds mixed types (strings alongside points), or the index is in a `FAILED` state.

```cypher
SHOW INDEXES YIELD name, type, state, properties
WHERE 'location' IN properties;  -- state must read ONLINE
```

**2. Unit and threshold mismatch.** `point.distance()` returns **meters**, always. Passing a kilometer value straight into `$max_meters` silently filters at 1/1000th the intended radius and returns an empty set — or, inverted, returns everything. Normalize at the boundary (the Python helper multiplies `max_km * 1000`) and never mix units inside the accumulator.

**3. Null distances from mixed CRS.** A geographic `point({latitude, longitude})` (SRID 4326) and a Cartesian `point({x, y})` (SRID 7203) are not comparable; `point.distance()` across SRIDs returns `null`, and a `null` term poisons the `reduce()` sum so the whole path silently drops. Assert SRID consistency at ingestion, and guard defensively if your graph mixes frames:

```cypher
WITH path,
     reduce(c = 0.0, r IN relationships(path) |
         c + coalesce(point.distance(startNode(r).location, endNode(r).location), 0.0)) AS dist_m
```

Use `coalesce` only as a diagnostic crutch — a path that needs it has a data-quality problem upstream, not a query problem.

## Performance Notes

`point.distance()` computes the great-circle distance between two coordinates on a sphere of radius $R$:

$$d = 2R \arcsin\!\left(\sqrt{\sin^{2}\!\left(\tfrac{\Delta\phi}{2}\right) + \cos\phi_1\,\cos\phi_2\,\sin^{2}\!\left(\tfrac{\Delta\lambda}{2}\right)}\,\right)$$

where $\phi_1,\phi_2$ are the endpoint latitudes and $\Delta\phi,\Delta\lambda$ the latitude and longitude deltas. The cost is a handful of trig calls **per relationship per candidate path** — cheap individually, but the accumulator pays it on every edge of every surviving branch, so total CPU scales with (paths × average depth), not with node count.

That product is where the strategy boundaries live:

1. **Heap pressure on dense grids.** Even a tight threshold can leave thousands of valid permutations within 4–5 hops in a highly connected urban graph. The `reduce()` accumulator carries state per path, so heap grows roughly linearly with the surviving-path count. Tighten `$max_meters`, lower the `*1..8` cap, or pre-filter both endpoints with a bounding box before expanding.
2. **Not a shortest-path guarantee.** This filters by *cumulative* distance and returns every path under the threshold sorted post-filter — it does not find the optimal route. For true shortest paths, delegate to the Neo4j GDS library's `gds.shortestPath.dijkstra` or `gds.shortestPath.astar`; the trade-offs are laid out under [k-nearest-neighbor routing](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/k-nearest-neighbor-routing/).
3. **Plan-cache thrashing.** Wildly varying `$max_meters` values can still recompile if combined with literal structural changes; keep the query text fixed and pin thresholds to discrete tiers (5 km, 10 km, 25 km) so the plan cache stays warm. The full `PROFILE`-driven tightening loop is documented in [Cypher performance tuning](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/).

When traversals routinely exceed 8 hops, or you need multi-modal edge weighting (road distance combined with transit schedules), the inline `reduce()` stops being the right tool: switch to a bounding-box pre-filter feeding a GDS shortest-path pass. Reserve `connection_acquisition_timeout` low (5 s above) so a query that accidentally falls back to a scan fails fast instead of draining the pool — a timeout storm at peak is almost always a missing-seek symptom, not a pool-size one.

## Related

- [Distance Filter Query Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/) — the endpoint-and-bounding-box predicates this segment-level filter complements.
- [K-Nearest-Neighbor Routing](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/k-nearest-neighbor-routing/) — ranking bounded candidates and handing them to GDS shortest-path.
- [Spatial Join Techniques](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/spatial-join-techniques/) — index-probe joins when the distance filter must correlate against external datasets.
- [Cypher Performance Tuning](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/) — the PROFILE loop for keeping the anchor lookup index-backed.
- [Graph Query Planner Optimization](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/) — why predicate placement decides seek versus scan.

This guide is part of [Distance Filter Query Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/), within the [Cypher Spatial Queries & Pathfinding Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/) pillar.

For authoritative reference on native spatial functions, consult the [Neo4j Cypher Spatial Functions Documentation](https://neo4j.com/docs/cypher-manual/current/functions/spatial/).
