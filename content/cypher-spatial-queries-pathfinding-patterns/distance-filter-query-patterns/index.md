---
pageTitle: Distance Filter Query Patterns
---
# Distance Filter Query Patterns for Spatial Graph Routing

A pathfinding query that does not bound its search radius will read the entire graph before it returns a single route. On a continental road network that means tens of millions of nodes scanned to answer a question that, geometrically, only touches a few hundred. The cost is not abstract: p99 latency climbs into seconds, the page cache thrashes, the connection pool drains under concurrency, and a routing endpoint that worked in staging falls over the first time real traffic clusters in a city. Distance filter query patterns fix this at the source — they apply a coordinate-anchored predicate that the spatial index can seek, so the engine enters the graph through a bounded window and the expensive distance math only ever runs on survivors. This guide shows how to build those predicates correctly for a Python-driven Neo4j workload, drive them from the async driver, profile them, and harden them against the precision and topology traps that silently corrupt results. It is one of the core techniques in [Cypher Spatial Queries & Pathfinding Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/).

<svg viewBox="0 0 770 432" role="img" aria-labelledby="radTitle radDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="radTitle">Unbounded label scan versus index-bounded box-then-circle radius search</title>
  <desc id="radDesc">Left: an unbounded radius query reads every node in the label (all dots highlighted) even though only a handful fall inside the target radius — an O(n) scan. Right: the two-stage filter first seeks an index-aligned bounding box so nodes outside it are never read (faded), then the point.distance guard clips the four box corners back to the inscribed circle, leaving only the nodes truly within radius returned.</desc>
  <defs>
    <marker id="radArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <rect class="viz-backdrop" x="0" y="0" width="770" height="432" fill="var(--viz-bg,#ffffff)"/>
  <line x1="385" y1="50" x2="385" y2="392" stroke="currentColor" stroke-width="1" stroke-dasharray="3 6" opacity="0.3"/>
  <!-- LEFT: unbounded scan -->
  <text x="175" y="26" text-anchor="middle" font-size="14.5" font-weight="700" fill="currentColor">Unbounded — every node read</text>
  <text x="175" y="44" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7">point.distance alone → O(n) label scan</text>
  <g fill="var(--accent-coral,#ff6b6b)" opacity="0.85">
    <circle cx="110" cy="148" r="3.4"/> <circle cx="170" cy="148" r="3.4"/> <circle cx="225" cy="148" r="3.4"/> <circle cx="95" cy="188" r="3.4"/> <circle cx="160" cy="188" r="3.4"/> <circle cx="215" cy="188" r="3.4"/> <circle cx="105" cy="228" r="3.4"/> <circle cx="165" cy="228" r="3.4"/> <circle cx="230" cy="228" r="3.4"/> <circle cx="145" cy="268" r="3.4"/> <circle cx="205" cy="268" r="3.4"/> <circle cx="238" cy="150" r="3.4"/> <circle cx="102" cy="150" r="3.4"/>
    <circle cx="85" cy="268" r="3.4"/> <circle cx="96" cy="128" r="3.4"/> <circle cx="244" cy="128" r="3.4"/> <circle cx="96" cy="282" r="3.4"/> <circle cx="246" cy="282" r="3.4"/>
    <circle cx="40" cy="70" r="3.4"/> <circle cx="90" cy="70" r="3.4"/> <circle cx="150" cy="70" r="3.4"/> <circle cx="210" cy="70" r="3.4"/> <circle cx="270" cy="70" r="3.4"/> <circle cx="310" cy="70" r="3.4"/> <circle cx="30" cy="108" r="3.4"/> <circle cx="80" cy="108" r="3.4"/> <circle cx="130" cy="108" r="3.4"/> <circle cx="190" cy="108" r="3.4"/> <circle cx="250" cy="108" r="3.4"/> <circle cx="300" cy="108" r="3.4"/> <circle cx="55" cy="148" r="3.4"/> <circle cx="285" cy="148" r="3.4"/> <circle cx="35" cy="188" r="3.4"/> <circle cx="280" cy="188" r="3.4"/> <circle cx="320" cy="188" r="3.4"/> <circle cx="50" cy="228" r="3.4"/> <circle cx="290" cy="228" r="3.4"/> <circle cx="30" cy="268" r="3.4"/> <circle cx="265" cy="268" r="3.4"/> <circle cx="310" cy="268" r="3.4"/> <circle cx="60" cy="308" r="3.4"/> <circle cx="120" cy="308" r="3.4"/> <circle cx="180" cy="308" r="3.4"/> <circle cx="245" cy="308" r="3.4"/> <circle cx="300" cy="308" r="3.4"/> <circle cx="45" cy="346" r="3.4"/> <circle cx="100" cy="346" r="3.4"/> <circle cx="160" cy="346" r="3.4"/> <circle cx="220" cy="346" r="3.4"/> <circle cx="285" cy="346" r="3.4"/>
  </g>
  <circle cx="170" cy="205" r="92" fill="none" stroke="currentColor" stroke-width="1.4" stroke-dasharray="5 5" opacity="0.5"/>
  <path d="M170 197 v16 M162 205 h16" stroke="currentColor" stroke-width="2"/>
  <text x="175" y="386" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.7">all 51 nodes scanned · 11 within radius</text>
  <!-- RIGHT: index-bounded box then circle -->
  <text x="575" y="26" text-anchor="middle" font-size="14.5" font-weight="700" fill="currentColor">Bounded — box seek, then clip</text>
  <text x="575" y="44" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7">indexed range scan → distance guard</text>
  <g transform="translate(400,0)">
    <!-- never read: outside the box -->
    <g fill="currentColor" opacity="0.2">
      <circle cx="40" cy="70" r="3.4"/> <circle cx="90" cy="70" r="3.4"/> <circle cx="150" cy="70" r="3.4"/> <circle cx="210" cy="70" r="3.4"/> <circle cx="270" cy="70" r="3.4"/> <circle cx="310" cy="70" r="3.4"/> <circle cx="30" cy="108" r="3.4"/> <circle cx="80" cy="108" r="3.4"/> <circle cx="130" cy="108" r="3.4"/> <circle cx="190" cy="108" r="3.4"/> <circle cx="250" cy="108" r="3.4"/> <circle cx="300" cy="108" r="3.4"/> <circle cx="55" cy="148" r="3.4"/> <circle cx="285" cy="148" r="3.4"/> <circle cx="35" cy="188" r="3.4"/> <circle cx="280" cy="188" r="3.4"/> <circle cx="320" cy="188" r="3.4"/> <circle cx="50" cy="228" r="3.4"/> <circle cx="290" cy="228" r="3.4"/> <circle cx="30" cy="268" r="3.4"/> <circle cx="265" cy="268" r="3.4"/> <circle cx="310" cy="268" r="3.4"/> <circle cx="60" cy="308" r="3.4"/> <circle cx="120" cy="308" r="3.4"/> <circle cx="180" cy="308" r="3.4"/> <circle cx="245" cy="308" r="3.4"/> <circle cx="300" cy="308" r="3.4"/> <circle cx="45" cy="346" r="3.4"/> <circle cx="100" cy="346" r="3.4"/> <circle cx="160" cy="346" r="3.4"/> <circle cx="220" cy="346" r="3.4"/> <circle cx="285" cy="346" r="3.4"/>
    </g>
    <!-- bounding box (index-seekable) -->
    <rect x="78" y="113" width="184" height="184" rx="4" fill="var(--accent,#0e7c86)" opacity="0.06"/>
    <rect x="78" y="113" width="184" height="184" rx="4" fill="none" stroke="var(--accent,#0e7c86)" stroke-width="1.6" stroke-dasharray="6 4"/>
    <!-- inscribed radius -->
    <circle cx="170" cy="205" r="92" fill="none" stroke="var(--accent,#0e7c86)" stroke-width="1.6"/>
    <!-- read but clipped (box corners, outside circle) -->
    <g fill="none" stroke="var(--accent-coral,#ff6b6b)" stroke-width="1.5">
      <circle cx="85" cy="268" r="3.4"/> <circle cx="96" cy="128" r="3.4"/> <circle cx="244" cy="128" r="3.4"/> <circle cx="96" cy="282" r="3.4"/> <circle cx="246" cy="282" r="3.4"/>
    </g>
    <!-- returned: within radius -->
    <g fill="var(--accent,#0e7c86)">
      <circle cx="110" cy="148" r="3.6"/> <circle cx="170" cy="148" r="3.6"/> <circle cx="225" cy="148" r="3.6"/> <circle cx="95" cy="188" r="3.6"/> <circle cx="160" cy="188" r="3.6"/> <circle cx="215" cy="188" r="3.6"/> <circle cx="105" cy="228" r="3.6"/> <circle cx="165" cy="228" r="3.6"/> <circle cx="230" cy="228" r="3.6"/> <circle cx="145" cy="268" r="3.6"/> <circle cx="205" cy="268" r="3.6"/> <circle cx="238" cy="150" r="3.6"/> <circle cx="102" cy="150" r="3.6"/>
    </g>
    <path d="M170 197 v16 M162 205 h16" stroke="currentColor" stroke-width="2"/>
    <text x="175" y="386" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.7">18 read · 5 corners clipped · 11 returned</text>
  </g>
  <!-- legend -->
  <g font-size="10.5" fill="currentColor">
    <circle cx="216" cy="414" r="3.6" fill="var(--accent,#0e7c86)"/>
    <text x="226" y="418">within radius (returned)</text>
    <circle cx="400" cy="414" r="3.4" fill="none" stroke="var(--accent-coral,#ff6b6b)" stroke-width="1.5"/>
    <text x="410" y="418">box corner — read, then clipped</text>
    <circle cx="606" cy="414" r="3.4" fill="currentColor" opacity="0.2"/>
    <text x="616" y="418" opacity="0.85">outside box — never read</text>
  </g>
</svg>

## Prerequisites

These examples assume an async Python service talking to a Neo4j instance with native `point` support. The `point.distance()` semantics and index-backed range predicates used below are stable on Neo4j 5.x; the bounding-box math is pure client-side Python and version-independent.

| Requirement | Minimum version | Notes |
| --- | --- | --- |
| Python | 3.10+ | Union types and structural `match` used in examples |
| Neo4j | 5.13+ | Native `point` type, `CREATE POINT INDEX`, index-backed range predicates |
| neo4j (driver) | 5.x | Async driver (`AsyncGraphDatabase`), native point serialization |
| pytest / pytest-asyncio | 0.23+ | For the correctness assertions in the testing section |

```bash
pip install "neo4j>=5.18" "pytest>=8.0" "pytest-asyncio>=0.23"
```

This pattern assumes your graph already follows sound [node and edge spatial mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/) conventions — coordinates stored as native `point` values on the primitives you actually filter, not as detached `lat`/`lon` strings that no index can seek — and that the right [spatial indexing strategy](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) backs the `location` property. Without an index, every pattern below degrades to a full label scan no matter how tight the predicate reads.

## Core Concept & Mechanism

Neo4j represents geography with the native `point()` type, which defaults to the WGS 84 ellipsoid (SRID 4326) for latitude/longitude coordinates. The `point.distance()` function returns the great-circle distance in meters between two such points. The trap is that `point.distance()` is a computed function, not an indexable property: when it appears alone in a `WHERE` clause, the planner has no seekable range to descend into, so it falls back to a label scan and evaluates the function once per node. Complexity becomes O(n) in the label size, independent of how small the search radius is.

The fix is a two-stage predicate. Stage one constrains candidates with a coordinate-aligned bounding box — four simple range comparisons on `location.latitude` and `location.longitude` that the native point index (an R-tree variant) can seek directly. Stage two applies exact `point.distance()` only to the bounded survivors, clipping the box corners back to a true circle. In dense urban graphs this collapses the candidate set by 90–99% before a single distance call runs, which is the difference between an index seek and a full scan.

The mechanism that makes stage one work is **predicate push-down**: the planner recognizes the range comparison as index-seekable and enters the graph through a `PointIndexSeekByRange`. The deeper cost-model and plan-selection details belong to [graph query planner optimization](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/); here it is enough to know that the bounding box is the predicate shape the planner can actually push down.

<svg viewBox="0 0 772 214" role="img" aria-labelledby="pipeTitle pipeDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="pipeTitle">Two-stage distance-filter pipeline from full label to bounded result</title>
  <desc id="pipeDesc">A left-to-right pipeline. Stage one: an indexed bounding-box range scan reduces all nodes (millions) to a candidate set (hundreds). Stage two: an exact point.distance great-circle check over only those candidates clips the box to a true radius, yielding the sorted, limited result. The candidate count collapses by roughly 90 to 99 percent before any distance math runs.</desc>
  <defs>
    <marker id="pipeArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7.5" markerHeight="7.5" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <!-- stage band labels -->
  <rect class="viz-backdrop" x="0" y="0" width="772" height="214" fill="var(--viz-bg,#ffffff)"/>
  <rect x="155" y="14" width="285" height="20" rx="10" fill="var(--accent,#0e7c86)" opacity="0.1"/>
  <text x="297" y="28" text-anchor="middle" font-size="11" font-weight="700" fill="var(--accent,#0e7c86)">Stage 1 — index seek (cheap, bounded)</text>
  <rect x="455" y="14" width="305" height="20" rx="10" fill="var(--accent-coral,#ff6b6b)" opacity="0.1"/>
  <text x="607" y="28" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">Stage 2 — exact distance (only survivors)</text>
  <!-- boxes -->
  <g font-size="12.5" font-weight="700" fill="currentColor">
    <g>
      <rect x="12" y="64" width="130" height="78" rx="9" fill="currentColor" opacity="0.05"/>
      <rect x="12" y="64" width="130" height="78" rx="9" fill="none" stroke="currentColor" stroke-width="1.4" opacity="0.5"/>
      <text x="77" y="98" text-anchor="middle">All nodes</text>
    </g>
    <g>
      <rect x="172" y="64" width="130" height="78" rx="9" fill="var(--accent,#0e7c86)" opacity="0.08"/>
      <rect x="172" y="64" width="130" height="78" rx="9" fill="none" stroke="var(--accent,#0e7c86)" stroke-width="1.8"/>
      <text x="237" y="92" text-anchor="middle">Bounding box</text>
    </g>
    <g>
      <rect x="332" y="64" width="130" height="78" rx="9" fill="var(--accent,#0e7c86)" opacity="0.08"/>
      <rect x="332" y="64" width="130" height="78" rx="9" fill="none" stroke="var(--accent,#0e7c86)" stroke-width="1.4"/>
      <text x="397" y="98" text-anchor="middle">Candidate set</text>
    </g>
    <g>
      <rect x="492" y="64" width="130" height="78" rx="9" fill="none" stroke="currentColor" stroke-width="1.4"/>
      <text x="557" y="92" text-anchor="middle">point.distance</text>
    </g>
    <g>
      <rect x="652" y="64" width="108" height="78" rx="9" fill="var(--accent-coral,#ff6b6b)" opacity="0.12"/>
      <rect x="652" y="64" width="108" height="78" rx="9" fill="none" stroke="var(--accent-coral,#ff6b6b)" stroke-width="1.8"/>
      <text x="706" y="92" text-anchor="middle">Within radius</text>
    </g>
  </g>
  <!-- sublabels -->
  <g font-size="10.5" fill="currentColor" opacity="0.72" text-anchor="middle">
    <text x="77" y="116">millions</text>
    <text x="237" y="110">indexed</text>
    <text x="237" y="124">range scan</text>
    <text x="397" y="116">hundreds</text>
    <text x="557" y="110">exact</text>
    <text x="557" y="124">great-circle</text>
    <text x="706" y="110">sorted,</text>
    <text x="706" y="124">limited</text>
  </g>
  <!-- arrows -->
  <g stroke="currentColor" stroke-width="1.8">
    <line x1="142" y1="103" x2="170" y2="103" marker-end="url(#pipeArrow)"/>
    <line x1="302" y1="103" x2="330" y2="103" marker-end="url(#pipeArrow)"/>
    <line x1="462" y1="103" x2="490" y2="103" marker-end="url(#pipeArrow)"/>
    <line x1="622" y1="103" x2="650" y2="103" marker-end="url(#pipeArrow)"/>
  </g>
  <text x="386" y="178" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.78">candidate set collapses 90–99% before a single distance call runs</text>
  <!-- reduction bar -->
  <rect x="172" y="190" width="450" height="9" rx="4.5" fill="currentColor" opacity="0.12"/>
  <rect x="172" y="190" width="40" height="9" rx="4.5" fill="var(--accent,#0e7c86)"/>
  <text x="638" y="198" font-size="9.5" fill="currentColor" opacity="0.6">survivors</text>
</svg>

The bounding box itself is derived from the search radius. For a radius $r$ meters at latitude $\phi$ on a sphere of radius $R$, the half-extents in degrees are:

$$\Delta\phi = \frac{r}{R} \cdot \frac{180}{\pi}, \qquad \Delta\lambda = \frac{r}{R \cos\phi} \cdot \frac{180}{\pi}$$

The $\cos\phi$ term widens the longitude band toward the poles, where meridians converge. Computing this client-side keeps the box as plain query parameters the planner can seek, rather than forcing the engine to derive it per row.

## Schema & Data Model

The planner can only seek an index that exists, and only when the predicate shape matches it. Store coordinates as a native `point` on the node so the range comparison is index-backed, and keep edge weights separate so distance filtering and cost-weighted traversal stay independent.

```cypher
// Native point index — backs the bounding-box range predicate and point.distance()
CREATE POINT INDEX road_node_location IF NOT EXISTS
FOR (n:RoadNode) ON (n.location);

// Lookup index on the stable id used to anchor route queries
CREATE INDEX road_node_id IF NOT EXISTS
FOR (n:RoadNode) ON (n.id);
```

```cypher
// Representative shape of the indexed spatial graph
// (:RoadNode {id, location: point({srid:4326, latitude, longitude})})
//   -[:CONNECTED_TO {length_m, travel_s, weight}]->
// (:RoadNode)
```

Anchor the index on the property the predicate actually filters. A point index on a `:RoadNode` does nothing for a distance predicate evaluated over edge geometry, so for segment-level filtering keep a precomputed bounding box on the relationship instead. Edge `weight` stays distinct from raw `length_m` so that a distance filter (a spatial constraint) and a shortest-path cost (a traversal constraint) never get conflated — a mistake that produces routes that are short in kilometers but wrong in travel time.

## Step-by-Step Implementation

The workflow is: compute the bounding box client-side, pass it as parameters, let the index seek the box, then clip to the exact radius. We build it as runnable async code.

### 1. Compute the bounding box client-side

Deriving the box in Python keeps the corners as stable parameters the planner can seek. Never compute the box inside Cypher — a per-row trig expression cannot be pushed down to the index.

```python
import asyncio
import math
from neo4j import AsyncGraphDatabase

EARTH_RADIUS_M = 6_371_000.0  # mean spherical radius


def compute_bounding_box(lat: float, lon: float, radius_m: float) -> dict:
    """WGS84 degree-space bounding box for spatial-index pre-filtering.

    Spherical approximation; the longitude band widens with latitude via cos(phi).
    """
    d_lat = math.degrees(radius_m / EARTH_RADIUS_M)
    d_lon = math.degrees(radius_m / (EARTH_RADIUS_M * math.cos(math.radians(lat))))
    return {
        "min_lat": lat - d_lat, "max_lat": lat + d_lat,
        "min_lon": lon - d_lon, "max_lon": lon + d_lon,
    }
```

### 2. Run the two-stage radius query through the async driver

Parameterized execution lets the driver serialize coordinates into the binary protocol, keeps the plan cacheable, and closes the door on injection. The bounding-box comparison seeks the index; the `point.distance()` guard clips the box corners back to a circle.

```python
async def query_spatial_radius(driver, lat: float, lon: float, radius_m: float):
    bbox = compute_bounding_box(lat, lon, radius_m)
    query = """
    WITH point({srid: 4326, latitude: $lat, longitude: $lon}) AS target
    MATCH (n:RoadNode)
    WHERE n.location.latitude  >= $min_lat AND n.location.latitude  <= $max_lat
      AND n.location.longitude >= $min_lon AND n.location.longitude <= $max_lon
    WITH n, target, point.distance(n.location, target) AS dist_m
    WHERE dist_m <= $radius
    RETURN n.id AS node_id, dist_m
    ORDER BY dist_m ASC
    LIMIT 200
    """
    async with driver.session() as session:
        result = await session.run(
            query, lat=lat, lon=lon, radius=radius_m, **bbox
        )
        return [record.data() async for record in result]
```

### 3. Wire it into a pooled async service

Tune `max_connection_pool_size` to the concurrency of your request handlers, and set an acquisition timeout so a query that accidentally falls back to a scan fails fast instead of starving the pool.

```python
async def main():
    pool_config = {
        "max_connection_pool_size": 40,
        "connection_acquisition_timeout": 5.0,
        "max_transaction_retry_time": 10.0,
    }
    driver = AsyncGraphDatabase.driver(
        "neo4j+s://your-cluster.databases.neo4j.io",
        auth=("neo4j", "secure-password"),
        **pool_config,
    )
    try:
        nodes = await query_spatial_radius(driver, 40.7128, -74.0060, 5000)
        print(f"Resolved {len(nodes)} nodes within 5 km radius.")
    finally:
        await driver.close()


if __name__ == "__main__":
    asyncio.run(main())
```

## Query Patterns & Variants

The same "within distance" intent takes several shapes. Pick the one whose anchor matches how the index is structured and how the result is consumed.

**Variant A — bounded radius (the default).** Box-then-distance, returning everything inside a fixed radius, sorted nearest-first. This is the shape from the implementation above and the one to reach for first.

```cypher
WITH point({srid: 4326, latitude: $lat, longitude: $lon}) AS target
MATCH (n:RoadNode)
WHERE n.location.latitude  >= $min_lat AND n.location.latitude  <= $max_lat
  AND n.location.longitude >= $min_lon AND n.location.longitude <= $max_lon
WITH n, point.distance(n.location, target) AS dist_m
WHERE dist_m <= $radius
RETURN n.id, dist_m ORDER BY dist_m LIMIT 200
// $min_*/$max_* always come from compute_bounding_box(); never derive the box in Cypher.
```

**Variant B — nearest-K without a fixed radius.** When the question is "the closest k nodes" rather than "everything within r", drop the distance guard but keep the bounding box so the index still bounds the scan. Widen the box and re-run if fewer than `k` rows return at the edge of coverage. This is the entry point shared with [k-nearest-neighbor routing](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/k-nearest-neighbor-routing/), where the bounded candidate set feeds a graph projection.

```cypher
WITH point({srid: 4326, latitude: $lat, longitude: $lon}) AS target
MATCH (n:RoadNode)
WHERE n.location.latitude  >= $min_lat AND n.location.latitude  <= $max_lat
  AND n.location.longitude >= $min_lon AND n.location.longitude <= $max_lon
RETURN n.id, point.distance(n.location, target) AS dist_m
ORDER BY dist_m ASC LIMIT $k
```

**Variant C — distance-pruned path expansion.** Routing queries often need the distance filter applied *during* traversal so the engine never materializes geometrically implausible detours. Bounding both endpoints of a variable-length path keeps the expansion inside a corridor instead of exploding combinatorially. Pair this with weighted edges to prefer realistic transit, and cross-reference [k-nearest-neighbor routing](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/k-nearest-neighbor-routing/) for ranking the resulting candidates.

```cypher
WITH point({srid: 4326, latitude: $lat, longitude: $lon}) AS origin
MATCH (start:RoadNode {id: $start_id})
MATCH path = (start)-[:CONNECTED_TO*1..8]->(dest:RoadNode)
WHERE dest.location.latitude  >= $min_lat AND dest.location.latitude  <= $max_lat
  AND dest.location.longitude >= $min_lon AND dest.location.longitude <= $max_lon
  AND point.distance(dest.location, origin) <= $radius
RETURN dest.id, reduce(c = 0.0, r IN relationships(path) | c + r.weight) AS cost
ORDER BY cost ASC LIMIT 25
// Cap the variable-length bound (*1..8); an unbounded star will materialize the whole component.
```

For segment-by-segment cumulative-distance accumulation along a path — the harder case where each hop is checked, not just the endpoint — see [Filtering Graph Paths by Haversine Distance in Cypher](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/filtering-graph-paths-by-haversine-distance-in-cypher/).

## Performance Tuning

Profiling is the whole game. `EXPLAIN` returns the plan without running it — use it in CI to assert plan shape; `PROFILE` runs the query and annotates each operator with real `db hits` and `rows`. Read the plan bottom-up and find the first operator whose `rows` count dwarfs the final result; that is where the predicate is failing to bound the scan.

- **Confirm the seek, not the scan.** A healthy radius query shows a `PointIndexSeekByRange` (or `NodeIndexSeekByRange`) at the base of the plan. If you see a `NodeByLabelScan` feeding a `Filter` on `point.distance`, push-down failed — the box predicate is missing, malformed, or sitting after an expansion.
- **Keep the box on the anchor.** The four range comparisons must reference the node whose index you want to seek. Moving them downstream of a `MATCH` expansion defeats the index.
- **Parameterize everything.** Literal coordinates baked into the query string force recompilation and thrash the plan cache. Pass `$min_lat`, `$radius`, etc. as parameters with stable numeric types.
- **Size the page cache for the hot region.** Seeks only stay fast if the working set's nodes and the point index live in memory. Mirror that client-side with a bounded `max_connection_pool_size` so you do not over-subscribe the server.
- **Trade accuracy for speed deliberately.** Exact great-circle math via `point.distance()` carries measurable CPU cost. For micro-mobility or indoor routing, an approximate Euclidean distance over a projected CRS (such as EPSG:3857) can be acceptable, but the distortion grows with latitude and span — benchmark against your latency SLO before adopting it, and keep WGS 84 for anything continental.

This profiling loop — capture `PROFILE`, find the widest operator, tighten the predicate or add the index, re-profile — is the same one detailed in [Cypher performance tuning](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/). When distance filters need to correlate against external datasets (telemetry, POI catalogs), the join itself becomes the bottleneck; [spatial join techniques](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/spatial-join-techniques/) cover index-probe joins that avoid the cross-product blowup.

<svg viewBox="0 0 760 348" role="img" aria-labelledby="profTitle profDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="profTitle">PROFILE operator trees: label scan versus point-index seek for a radius filter</title>
  <desc id="profDesc">Left, the unindexed plan: a NodeByLabelScan reads every RoadNode and feeds a trailing Filter that evaluates point.distance once per row, so the widest operator carries millions of rows and DbHits. Right, the indexed plan: a PointIndexSeekByRange on road_node_location enters only the bounding box, then a Filter clips the corners with point.distance, so the widest operator carries only hundreds of rows. Same result set, two plan shapes.</desc>
  <defs>
    <marker id="profArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <rect class="viz-backdrop" x="0" y="0" width="760" height="348" fill="var(--viz-bg,#ffffff)"/>
  <line x1="380" y1="44" x2="380" y2="320" stroke="currentColor" stroke-width="1" stroke-dasharray="3 6" opacity="0.3"/>
  <!-- LEFT: unindexed -->
  <text x="190" y="26" text-anchor="middle" font-size="14.5" font-weight="700" fill="currentColor">Unindexed — push-down failed</text>
  <text x="190" y="44" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7">box predicate missing or after expansion</text>
  <g fill="none" stroke="var(--accent-coral,#ff6b6b)" stroke-width="1.6">
    <rect x="60" y="56" width="260" height="58" rx="8" stroke-width="2.4"/>
    <rect x="60" y="160" width="260" height="58" rx="8"/>
  </g>
  <line x1="190" y1="114" x2="190" y2="158" stroke="currentColor" stroke-width="1.6" marker-end="url(#profArrow)"/>
  <text x="190" y="82" text-anchor="middle" font-size="13.5" font-weight="700" fill="currentColor">NodeByLabelScan</text>
  <text x="190" y="100" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.72">(:RoadNode) — every labeled node</text>
  <text x="190" y="186" text-anchor="middle" font-size="13.5" font-weight="700" fill="currentColor">Filter</text>
  <text x="190" y="204" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.72">point.distance(…) ≤ r, once per row</text>
  <rect x="60" y="262" width="260" height="50" rx="8" fill="var(--accent-coral,#ff6b6b)" opacity="0.14"/>
  <rect x="60" y="262" width="260" height="50" rx="8" fill="none" stroke="var(--accent-coral,#ff6b6b)" stroke-width="1.4"/>
  <text x="190" y="284" text-anchor="middle" font-size="12.5" font-weight="700" fill="currentColor">rows ≈ millions · DbHits ≈ 10⁷</text>
  <text x="190" y="301" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.78">scales with label size N</text>
  <!-- RIGHT: indexed -->
  <text x="570" y="26" text-anchor="middle" font-size="14.5" font-weight="700" fill="currentColor">Indexed — box seek pushed down</text>
  <text x="570" y="44" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7">range predicate on the anchor node</text>
  <g fill="none" stroke="var(--accent,#0e7c86)" stroke-width="1.6">
    <rect x="440" y="56" width="260" height="58" rx="8" stroke-width="2.4"/>
    <rect x="440" y="160" width="260" height="58" rx="8"/>
  </g>
  <line x1="570" y1="114" x2="570" y2="158" stroke="currentColor" stroke-width="1.6" marker-end="url(#profArrow)"/>
  <text x="570" y="82" text-anchor="middle" font-size="13.5" font-weight="700" fill="currentColor">PointIndexSeekByRange</text>
  <text x="570" y="100" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.72">road_node_location — box range only</text>
  <text x="570" y="186" text-anchor="middle" font-size="13.5" font-weight="700" fill="currentColor">Filter</text>
  <text x="570" y="204" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.72">point.distance(…) clips box corners</text>
  <rect x="440" y="262" width="260" height="50" rx="8" fill="var(--accent,#0e7c86)" opacity="0.14"/>
  <rect x="440" y="262" width="260" height="50" rx="8" fill="none" stroke="var(--accent,#0e7c86)" stroke-width="1.4"/>
  <text x="570" y="284" text-anchor="middle" font-size="12.5" font-weight="700" fill="currentColor">rows ≈ hundreds · DbHits ≈ log N</text>
  <text x="570" y="301" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.78">scales with local node density</text>
  <text x="380" y="338" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.62">PROFILE — read bottom-up · the bold base operator is where the scan is bounded</text>
</svg>

## Edge Cases & Gotchas

- **Mixed CRS coordinates.** A geographic `point({latitude, longitude})` (SRID 4326) and a Cartesian `point({x, y})` (SRID 7203) are not comparable; `point.distance()` across SRIDs returns `null`, and a `null` predicate silently drops the row instead of erroring. Normalize CRS at ingestion and assert the SRID before querying.
- **Antimeridian and polar wrap.** A bounding box straddling ±180° longitude produces `min_lon > max_lon`, so a naive range comparison returns nothing. Split the box into two queries across the seam, or special-case high-latitude searches where the longitude band balloons past 180°.
- **Coordinate precision traps.** Float rounding on dense grids can make two endpoints "almost equal", creating phantom dead-ends or duplicate nodes that distort distance results. Snap to a fixed tolerance during ingestion, not at query time.
- **The box is a square, the radius is a circle.** Skipping the `point.distance()` guard returns the box corners — up to ~27% more area than the inscribed circle. Always keep the second stage if you need true radius semantics.
- **Unbounded variable-length paths.** A `[:CONNECTED_TO*]` with no upper bound will materialize the entire connected component before any distance filter applies. Always cap the hop count and bound the endpoints.
- **Driver timeout masquerading as pool exhaustion.** A query that falls back to a full scan blows past `connection_acquisition_timeout` under load and drains the pool. A timeout storm at peak traffic is usually a missing-seek symptom, not a pool-size problem.

## Verification & Testing

A distance filter is only safe if the bounded query returns the *same* rows as a brute-force scan, just faster. Assert both correctness (the right nodes, in the right order) and plan shape (a seek, not a scan) — a regression that turns the seek back into a scan changes only latency, so a correctness test alone will not catch it.

```python
import pytest
from neo4j import AsyncGraphDatabase

SEED = """
CREATE (a:RoadNode {id: 1, location: point({srid:4326, latitude: 40.7128, longitude: -74.0060})})
CREATE (b:RoadNode {id: 2, location: point({srid:4326, latitude: 40.7300, longitude: -74.0100})})
CREATE (c:RoadNode {id: 3, location: point({srid:4326, latitude: 41.5000, longitude: -74.9000})})
"""


@pytest.mark.asyncio
async def test_bounded_radius_matches_bruteforce():
    driver = AsyncGraphDatabase.driver("bolt://localhost:7687", auth=("neo4j", "test"))
    async with driver.session(database="neo4j") as s:
        await s.run("MATCH (n) DETACH DELETE n")
        await s.run(SEED)
        await s.run(
            "CREATE POINT INDEX road_node_location IF NOT EXISTS "
            "FOR (n:RoadNode) ON (n.location)"
        )

        # Ground truth: brute-force distance over every node, no bounding box.
        truth = await (await s.run(
            """
            WITH point({srid:4326, latitude: 40.7128, longitude: -74.0060}) AS t
            MATCH (n:RoadNode)
            WITH n, point.distance(n.location, t) AS d WHERE d <= 5000
            RETURN n.id AS id ORDER BY d
            """
        )).values()

        # Bounded two-stage query under test (box from compute_bounding_box).
        got = await (await s.run(
            """
            WITH point({srid:4326, latitude: 40.7128, longitude: -74.0060}) AS t
            MATCH (n:RoadNode)
            WHERE n.location.latitude  >= 40.6679 AND n.location.latitude  <= 40.7577
              AND n.location.longitude >= -74.0653 AND n.location.longitude <= -73.9467
            WITH n, point.distance(n.location, t) AS d WHERE d <= 5000
            RETURN n.id AS id ORDER BY d
            """
        )).values()

    assert got == truth, "bounded query must match brute-force result set"
    await driver.close()
```

Pair this with a plan-shape check: run `EXPLAIN` on the bounded query, read the plan from `result.consume()`, and assert it contains a point index seek rather than a label scan. Run both assertions in CI so a refactor that drops the box predicate is caught before it ships.

## FAQ

<details>
<summary>Why does my point.distance query still scan the whole label?</summary>

Because `point.distance()` is a computed function, not an indexable property, so it cannot push down on its own. Add a bounding-box range predicate on `location.latitude`/`location.longitude` ahead of it, confirm a `POINT INDEX` exists on `location`, and keep the box predicate on the anchor node before any expansion. Run `PROFILE` and look for a `PointIndexSeekByRange` at the base of the plan; a `NodeByLabelScan` feeding a `Filter` means push-down failed.
</details>

<details>
<summary>Do I really need both the bounding box and the distance check?</summary>

Yes, for true radius semantics. The bounding box is what the index seeks, but it is a square — its corners extend roughly 27% beyond the inscribed circle. The `point.distance()` guard clips those corners back to an exact radius. Drop it only when you genuinely want box semantics or are doing nearest-K, where `ORDER BY ... LIMIT k` replaces the radius.
</details>

<details>
<summary>Should I compute the bounding box in Python or in Cypher?</summary>

In Python. A box derived inside Cypher with per-row trig cannot be pushed down to the index, so the planner reverts to a scan. Compute the four corners client-side, pass them as parameters, and the range comparison becomes index-seekable while the plan stays cacheable.
</details>

<details>
<summary>Is approximate (Euclidean) distance ever safe to use?</summary>

For small, low-latitude extents — micro-mobility, indoor, single-campus routing — projecting to a Cartesian CRS such as EPSG:3857 and using straight-line distance can shave CPU at acceptable error. The distortion grows with latitude and span, so it is wrong for continental logistics. Keep WGS 84 and `point.distance()` as the default and benchmark any approximation against your accuracy and latency budget before adopting it.
</details>

<details>
<summary>How do I filter distance along a multi-hop path, not just to an endpoint?</summary>

Endpoint filtering bounds where a route may finish; cumulative filtering bounds the route's total length as it expands. For the latter, accumulate per-segment Haversine distance across `relationships(path)` and prune when the running sum exceeds tolerance. That segment-level technique is covered in detail in Filtering Graph Paths by Haversine Distance in Cypher.
</details>

## Related

- [Filtering Graph Paths by Haversine Distance in Cypher](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/filtering-graph-paths-by-haversine-distance-in-cypher/) — segment-level cumulative distance pruning along variable-length paths.
- [Bounding-Box Search Across the Antimeridian](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/bounding-box-search-across-the-antimeridian/) — splitting a radius box that straddles the ±180° meridian so the index still seeks it.
- [K-Nearest-Neighbor Routing](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/k-nearest-neighbor-routing/) — feeding a bounded candidate set into a graph projection and shortest-path pass.
- [Spatial Join Techniques](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/spatial-join-techniques/) — index-probe joins for correlating spatial nodes with external datasets.
- [Cypher Performance Tuning](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/) — the PROFILE-driven loop for keeping these predicates index-backed.
- [Spatial Indexing Strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) — choosing the index that makes the bounding box seekable.

This guide is part of [Cypher Spatial Queries & Pathfinding Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/).

For authoritative reference on native spatial functions and geometry standards, consult the [Neo4j Cypher Spatial Functions Documentation](https://neo4j.com/docs/cypher-manual/current/functions/spatial/), the [OGC Simple Features Specification](https://www.ogc.org/standards/sfa), and [ISO 19111](https://www.iso.org/standard/66155.html).

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "Why does my point.distance query still scan the whole label?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Because point.distance() is a computed function, not an indexable property, so it cannot push down on its own. Add a bounding-box range predicate on location.latitude and location.longitude ahead of it, confirm a POINT INDEX exists on location, and keep the box predicate on the anchor node before any expansion. Run PROFILE and look for a PointIndexSeekByRange at the base of the plan; a NodeByLabelScan feeding a Filter means push-down failed."
      }
    },
    {
      "@type": "Question",
      "name": "Do I really need both the bounding box and the distance check?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Yes, for true radius semantics. The bounding box is what the index seeks, but it is a square whose corners extend roughly 27 percent beyond the inscribed circle. The point.distance() guard clips those corners back to an exact radius. Drop it only when you genuinely want box semantics or are doing nearest-K, where ORDER BY plus LIMIT k replaces the radius."
      }
    },
    {
      "@type": "Question",
      "name": "Should I compute the bounding box in Python or in Cypher?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "In Python. A box derived inside Cypher with per-row trigonometry cannot be pushed down to the index, so the planner reverts to a scan. Compute the four corners client-side, pass them as parameters, and the range comparison becomes index-seekable while the plan stays cacheable."
      }
    },
    {
      "@type": "Question",
      "name": "Is approximate Euclidean distance ever safe to use?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "For small, low-latitude extents such as micro-mobility, indoor, or single-campus routing, projecting to a Cartesian CRS like EPSG:3857 and using straight-line distance can reduce CPU at acceptable error. The distortion grows with latitude and span, so it is wrong for continental logistics. Keep WGS 84 and point.distance() as the default and benchmark any approximation against your accuracy and latency budget first."
      }
    },
    {
      "@type": "Question",
      "name": "How do I filter distance along a multi-hop path, not just to an endpoint?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Endpoint filtering bounds where a route may finish; cumulative filtering bounds the route's total length as it expands. For the latter, accumulate per-segment Haversine distance across the relationships in the path and prune when the running sum exceeds tolerance. That segment-level technique is covered in Filtering Graph Paths by Haversine Distance in Cypher."
      }
    }
  ]
}
</script>
