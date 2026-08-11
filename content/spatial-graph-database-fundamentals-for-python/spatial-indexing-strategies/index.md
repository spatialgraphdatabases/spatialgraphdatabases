# Spatial Indexing Strategies

Production routing systems collapse the moment a spatial predicate degrades into a full graph scan. The difference between millisecond nearest-neighbor resolution and minute-long stalls comes down to one decision: how coordinate data is mapped onto a searchable index structure that the query planner can actually seek. Pick the wrong structure — or attach it to the wrong primitive — and every distance query reads the whole label, memory grows with the node count instead of the search radius, and p99 latency spikes the instant traffic clusters. This guide shows how to choose a spatial index for a Python-driven graph workload, create it correctly, drive it from the async Neo4j driver, and keep it from fragmenting under sustained mutation. It builds on the broader concepts in [Spatial Graph Database Fundamentals for Python](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/).

<svg viewBox="0 0 760 392" role="img" aria-labelledby="fit-title fit-desc" xmlns="http://www.w3.org/2000/svg">
  <title id="fit-title">Spatial index fit by dominant access pattern</title>
  <desc id="fit-desc">A matrix with three rows (R-tree native point index, Geohash or H3 string-prefix grid, and Quadtree hierarchical bounds) against four access-pattern columns (k-nearest, range or radius, polygon containment, and sharding or cache locality). Each cell is rated Good, OK, or Poor. The R-tree is Good for k-nearest and range, OK for polygon, Poor for sharding. Geohash or H3 is OK for k-nearest and range, Poor for polygon, Good for sharding. Quadtree is OK for k-nearest and range, Good for polygon, OK for sharding.</desc>
  <style>
    .fm-row{fill:var(--surface-2,#f4f4f5);stroke:var(--line-strong,#9ca3af);stroke-width:1;}
    .fm-hd{fill:var(--ink,#1f2937);font:700 14px var(--font-sans,system-ui,sans-serif);}
    .fm-hsub{fill:var(--ink-mute,#6b7280);font:12px var(--font-mono,ui-monospace,monospace);}
    .fm-rl{fill:var(--ink,#1f2937);font:700 15px var(--font-sans,system-ui,sans-serif);}
    .fm-rs{fill:var(--ink-mute,#6b7280);font:12px var(--font-mono,ui-monospace,monospace);}
    .fm-pt{fill:var(--viz-on-pill,#ffffff);font:700 13px var(--font-sans,system-ui,sans-serif);}
    .fm-lg{fill:var(--ink-mute,#6b7280);font:12px var(--font-sans,system-ui,sans-serif);}
  </style>
  <!-- column headers -->
  <rect class="viz-backdrop" x="0" y="0" width="760" height="392" fill="var(--viz-bg,#ffffff)"/>
  <text class="fm-hd"   x="278" y="30" text-anchor="middle">k-nearest</text>
  <text class="fm-hsub" x="278" y="48" text-anchor="middle">KNN</text>
  <text class="fm-hd"   x="414" y="30" text-anchor="middle">range</text>
  <text class="fm-hsub" x="414" y="48" text-anchor="middle">radius / bbox</text>
  <text class="fm-hd"   x="550" y="30" text-anchor="middle">polygon</text>
  <text class="fm-hsub" x="550" y="48" text-anchor="middle">containment</text>
  <text class="fm-hd"   x="677" y="30" text-anchor="middle">sharding</text>
  <text class="fm-hsub" x="677" y="48" text-anchor="middle">cache locality</text>
  <!-- row backgrounds -->
  <rect class="fm-row" x="24"  y="64"  width="186" height="78" rx="8"/>
  <rect class="fm-row" x="24"  y="150" width="186" height="78" rx="8"/>
  <rect class="fm-row" x="24"  y="236" width="186" height="78" rx="8"/>
  <!-- row labels -->
  <text class="fm-rl" x="40" y="98">R-tree</text>
  <text class="fm-rs" x="40" y="118">native point index</text>
  <text class="fm-rl" x="40" y="184">Geohash / H3</text>
  <text class="fm-rs" x="40" y="204">string-prefix grid</text>
  <text class="fm-rl" x="40" y="270">Quadtree</text>
  <text class="fm-rs" x="40" y="290">hierarchical bounds</text>
  <!-- fit pills: rows x cols -->
  <!-- Row 1: R-tree -->
  <g><rect x="230" y="88"  width="96" height="30" rx="15" fill="var(--accent,#0e7c86)"/><text class="fm-pt" x="278" y="108" text-anchor="middle">Good</text></g>
  <g><rect x="366" y="88"  width="96" height="30" rx="15" fill="var(--accent,#0e7c86)"/><text class="fm-pt" x="414" y="108" text-anchor="middle">Good</text></g>
  <g><rect x="502" y="88"  width="96" height="30" rx="15" fill="var(--viz-ok,#8a6d00)"/><text class="fm-pt" x="550" y="108" text-anchor="middle">OK</text></g>
  <g><rect x="629" y="88"  width="96" height="30" rx="15" fill="var(--accent-coral,#ff6b6b)"/><text class="fm-pt" x="677" y="108" text-anchor="middle">Poor</text></g>
  <!-- Row 2: Geohash / H3 -->
  <g><rect x="230" y="174" width="96" height="30" rx="15" fill="var(--viz-ok,#8a6d00)"/><text class="fm-pt" x="278" y="194" text-anchor="middle">OK</text></g>
  <g><rect x="366" y="174" width="96" height="30" rx="15" fill="var(--viz-ok,#8a6d00)"/><text class="fm-pt" x="414" y="194" text-anchor="middle">OK</text></g>
  <g><rect x="502" y="174" width="96" height="30" rx="15" fill="var(--accent-coral,#ff6b6b)"/><text class="fm-pt" x="550" y="194" text-anchor="middle">Poor</text></g>
  <g><rect x="629" y="174" width="96" height="30" rx="15" fill="var(--accent,#0e7c86)"/><text class="fm-pt" x="677" y="194" text-anchor="middle">Good</text></g>
  <!-- Row 3: Quadtree -->
  <g><rect x="230" y="260" width="96" height="30" rx="15" fill="var(--viz-ok,#8a6d00)"/><text class="fm-pt" x="278" y="280" text-anchor="middle">OK</text></g>
  <g><rect x="366" y="260" width="96" height="30" rx="15" fill="var(--viz-ok,#8a6d00)"/><text class="fm-pt" x="414" y="280" text-anchor="middle">OK</text></g>
  <g><rect x="502" y="260" width="96" height="30" rx="15" fill="var(--accent,#0e7c86)"/><text class="fm-pt" x="550" y="280" text-anchor="middle">Good</text></g>
  <g><rect x="629" y="260" width="96" height="30" rx="15" fill="var(--viz-ok,#8a6d00)"/><text class="fm-pt" x="677" y="280" text-anchor="middle">OK</text></g>
  <!-- legend -->
  <g><rect x="230" y="352" width="16" height="16" rx="4" fill="var(--accent,#0e7c86)"/><text class="fm-lg" x="252" y="365">Good fit</text></g>
  <g><rect x="338" y="352" width="16" height="16" rx="4" fill="var(--viz-ok,#8a6d00)"/><text class="fm-lg" x="360" y="365">Acceptable</text></g>
  <g><rect x="462" y="352" width="16" height="16" rx="4" fill="var(--accent-coral,#ff6b6b)"/><text class="fm-lg" x="484" y="365">Poor fit</text></g>
</svg>

## Prerequisites

These examples assume an async Python stack talking to a Neo4j instance with native `point` support. The `CREATE POINT INDEX` syntax and `point.distance` semantics used below are stable on Neo4j 5.x; geohash/H3 work is library-side and version-independent.

| Requirement | Minimum version | Notes |
| --- | --- | --- |
| Python | 3.10+ | Union types (`dict \| None`) and `match` used in examples |
| Neo4j | 5.13+ | Native `point` type, `CREATE POINT INDEX`, index-backed range predicates |
| neo4j (driver) | 5.x | Async driver (`AsyncGraphDatabase`) |
| shapely | 2.0+ | Client-side geometry validation before ingestion |
| python-geohash | 0.8+ | Prefix encoding for sharded grids (or `h3` 3.7+ for hex grids) |

```bash
pip install "neo4j>=5.18" "shapely>=2.0" "python-geohash>=0.8" "h3>=3.7"
```

Before tuning indexes, confirm your graph already follows sound [node and edge spatial mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/) conventions — coordinates stored as native `point` values on traversable primitives, not as detached string properties that no index can seek.

## Core Concept & Mechanism

A spatial index exists to convert "find things near here" from an O(n) scan into a bounded lookup. The three structures you will actually choose between trade off along the same axis: lookup precision versus write cost versus shardability.

- **R-tree / native point index.** Neo4j's `POINT INDEX` is an R-tree variant: a balanced tree of nested bounding boxes. It excels at range and nearest-neighbor queries over points because the planner can descend only the boxes that overlap the search window. The cost is write amplification — every insert may trigger node splits that ripple up the tree, and concurrent bulk upserts contend on those splits.
- **Quadtree.** Recursively partitions space into four quadrants until each leaf holds at most *k* points. Lookups are predictable for uniform distributions and it answers polygon and multi-scale analytic queries naturally. Under dense urban clustering, though, leaves overflow and the tree fragments — depth grows where points concentrate, so latency becomes data-dependent.
- **Geohash / H3 grids.** Encode a coordinate as a string (geohash) or hex cell id (H3). Proximity becomes shared-prefix matching, which makes these structures trivial to shard, cache, and replicate across regions — a string prefix maps cleanly to a partition key. The trade-off is geometric: cell boundaries are arbitrary, so two points either side of a boundary look "far" by prefix even when they are meters apart, and you must query neighbor cells to be correct.

The mechanism that ties all three to query speed is **predicate push-down**. When the planner recognizes that a `WHERE` clause is an index-seekable range or point predicate, it enters the graph through the index and expands only the matching subset. When it cannot — because the predicate sits after an expansion, or the property is not a native point — it falls back to a label scan plus a post-filter, and you pay for every node regardless of radius. The deep trade-off between prefix grids and recursive partitioning is dissected in [Implementing Geohash vs Quadtree Indexing in Neo4j](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/implementing-geohash-vs-quadtree-indexing-in-neo4j/).

Use this rough decision tree to pick a primary index — it is not exhaustive, but captures the trade-offs that matter at production scale:

<svg viewBox="0 0 820 412" role="img" aria-labelledby="dt-title dt-desc" xmlns="http://www.w3.org/2000/svg">
  <title id="dt-title">Decision tree for choosing a primary spatial index</title>
  <desc id="dt-desc">Starting from the primary access pattern: a range or k-nearest workload over points leads to a second question — is write amplification tolerable? If yes and read-heavy, choose the R-tree native point index, the Neo4j default; if no and write-heavy, choose Geohash or H3. A sharding or cache-locality workload goes straight to Geohash or H3, a string-prefix index. A polygon or multi-scale analytics workload goes to a Quadtree with hierarchical bounds.</desc>
  <style>
    .dt-q{fill:var(--surface-2,#f4f4f5);stroke:var(--viz-ok,#8a6d00);stroke-width:2;}
    .dt-o{fill:var(--surface-2,#f4f4f5);stroke:var(--accent,#0e7c86);stroke-width:2;}
    .dt-t{fill:var(--ink,#1f2937);font:700 15px var(--font-sans,system-ui,sans-serif);}
    .dt-s{fill:var(--ink-mute,#6b7280);font:13px var(--font-mono,ui-monospace,monospace);}
    .dt-edge{stroke:currentColor;stroke-width:1.5;fill:none;opacity:.55;}
    .dt-lb{fill:var(--ink-mute,#6b7280);font:600 12px var(--font-sans,system-ui,sans-serif);}
    .dt-lbg{fill:var(--viz-bg,#ffffff);}
  </style>
  <defs>
    <marker id="dt-arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor" opacity=".55"/>
    </marker>
  </defs>
  <!-- edges -->
  <rect class="viz-backdrop" x="0" y="0" width="820" height="412" fill="var(--viz-bg,#ffffff)"/>
  <path class="dt-edge" d="M345 84 C 270 110, 200 130, 175 159" marker-end="url(#dt-arr)"/>
  <path class="dt-edge" d="M430 84 L430 306" marker-end="url(#dt-arr)"/>
  <path class="dt-edge" d="M475 84 C 560 110, 620 134, 645 162" marker-end="url(#dt-arr)"/>
  <path class="dt-edge" d="M150 233 L140 306" marker-end="url(#dt-arr)"/>
  <path class="dt-edge" d="M250 233 C 300 270, 345 280, 380 306" marker-end="url(#dt-arr)"/>
  <!-- edge labels -->
  <g><rect class="dt-lbg" x="222" y="112" width="92" height="18" rx="4"/><text class="dt-lb" x="268" y="125" text-anchor="middle">Range / KNN</text></g>
  <g><rect class="dt-lbg" x="370" y="178" width="120" height="18" rx="4"/><text class="dt-lb" x="430" y="191" text-anchor="middle">Sharding / locality</text></g>
  <g><rect class="dt-lbg" x="528" y="112" width="120" height="18" rx="4"/><text class="dt-lb" x="588" y="125" text-anchor="middle">Polygon analytics</text></g>
  <g><rect class="dt-lbg" x="92" y="262" width="106" height="18" rx="4"/><text class="dt-lb" x="145" y="275" text-anchor="middle">Yes · read-heavy</text></g>
  <g><rect class="dt-lbg" x="262" y="262" width="106" height="18" rx="4"/><text class="dt-lb" x="315" y="275" text-anchor="middle">No · write-heavy</text></g>
  <!-- Start question -->
  <rect class="dt-q" x="305" y="28" width="210" height="56" rx="10"/>
  <text class="dt-t" x="410" y="61" text-anchor="middle">Primary access pattern?</text>
  <!-- RangeQ question -->
  <rect class="dt-q" x="65" y="161" width="220" height="72" rx="10"/>
  <text class="dt-t" x="175" y="192" text-anchor="middle">Write amplification</text>
  <text class="dt-t" x="175" y="212" text-anchor="middle">tolerable?</text>
  <!-- Quad outcome -->
  <rect class="dt-o" x="535" y="164" width="220" height="66" rx="10"/>
  <text class="dt-t" x="645" y="194" text-anchor="middle">Quadtree</text>
  <text class="dt-s" x="645" y="214" text-anchor="middle">hierarchical bounds</text>
  <!-- RTree outcome -->
  <rect class="dt-o" x="25" y="308" width="230" height="68" rx="10"/>
  <text class="dt-t" x="140" y="338" text-anchor="middle">R-tree / native point</text>
  <text class="dt-s" x="140" y="358" text-anchor="middle">default in Neo4j</text>
  <!-- Hash outcome -->
  <rect class="dt-o" x="325" y="308" width="220" height="68" rx="10"/>
  <text class="dt-t" x="435" y="338" text-anchor="middle">Geohash or H3</text>
  <text class="dt-s" x="435" y="358" text-anchor="middle">string-prefix index</text>
</svg>

## Schema & Data Model

The planner can only seek an index that exists, and only when the predicate shape matches the index type. The model below stores point geometry as a native `point` so distance filters are index-backed, carries a `geohash` string for shard routing, and keeps a precomputed `bbox` on linear features so range comparisons run before any expensive distance math.

```cypher
// Native point index — backs point.distance() range/KNN predicates
CREATE POINT INDEX hub_location IF NOT EXISTS
FOR (h:Hub) ON (h.location);

// Prefix index on the geohash string — backs STARTS WITH shard routing
CREATE TEXT INDEX hub_geohash IF NOT EXISTS
FOR (h:Hub) ON (h.geohash);

// Range index on the edge bounding box corners — cheap pre-filter for segments
CREATE INDEX segment_bbox IF NOT EXISTS
FOR ()-[r:ROAD_SEGMENT]-() ON (r.bbox_min_lat, r.bbox_max_lat);
```

```cypher
// Representative shape of the indexed spatial graph
// (:Hub {id, location: point({srid:4326, latitude, longitude}), geohash})
//   -[:ROAD_SEGMENT {bbox_min_lat, bbox_max_lat, bbox_min_lon, bbox_max_lon, length_m}]->
// (:Hub)
```

Point entities (delivery hubs, charging stations, IoT beacons) want a dense point index; linear features (road segments, transit corridors, pipelines) want bounding-box range indexes on their edges. Attaching a point index to a polyline forces the engine to compute `point.distance` after the scan, bypassing the index entirely. Which physical structure ultimately backs `location` — R-tree point index, geohash bucket, or H3 cell — is exactly the selectivity that your [graph query planner optimization](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/) layer consumes when it costs a plan.

## Step-by-Step Implementation

The workflow is: validate geometry client-side, enforce a single CRS, write the node with both a native point and a shard key, then query through a two-stage bounded predicate. We build it as runnable async code.

### 1. Validate and enforce a single CRS at ingestion

Malformed or mixed-CRS coordinates are the most common source of silently wrong results. Reject them before they cost a network round trip, and always pin WGS 84 (EPSG:4326) so distance math is comparable.

```python
import asyncio
import geohash
from shapely.geometry import Point
from shapely.validation import explain_validity
from neo4j import AsyncGraphDatabase

URI = "neo4j+s://your-cluster-host:7687"
AUTH = ("neo4j", "secure-password")
POOL_CONFIG = {
    "max_connection_pool_size": 50,
    "connection_acquisition_timeout": 5.0,
    "max_transaction_retry_time": 10.0,
}


def validate_coordinate(lat: float, lon: float) -> Point:
    """Reject out-of-CRS or invalid geometry before any graph write."""
    if not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
        raise ValueError(f"Coordinate outside EPSG:4326 bounds: {lat}, {lon}")
    pt = Point(lon, lat)  # shapely is (x=lon, y=lat)
    if not pt.is_valid:
        raise ValueError(f"Invalid geometry: {explain_validity(pt)}")
    return pt
```

### 2. Write the node with a native point and a shard key

The `MERGE` writes one canonical node; the `SET` populates the native `point` (which the point index seeks) and the `geohash` prefix (which the text index uses for shard routing). Precision 7 geohashes resolve to roughly 150 m cells — tune precision to your locality target.

```python
async def ingest_spatial_node(driver, node_id: int, lat: float, lon: float):
    validate_coordinate(lat, lon)
    gh = geohash.encode(lat, lon, precision=7)

    query = """
    MERGE (n:Hub {id: $id})
    SET n.location = point({srid: 4326, latitude: $lat, longitude: $lon}),
        n.geohash = $gh,
        n.updated_at = timestamp()
    """
    async with driver.session() as session:
        await session.run(query, id=node_id, lat=lat, lon=lon, gh=gh)


async def main():
    driver = AsyncGraphDatabase.driver(URI, auth=AUTH, **POOL_CONFIG)
    try:
        await ingest_spatial_node(driver, 8842, 40.7128, -74.0060)
    finally:
        await driver.close()


if __name__ == "__main__":
    asyncio.run(main())
```

### 3. Query through a two-stage bounded predicate

The single most effective spatial query pattern is: pre-filter with a cheap bounding box the index can seek, then apply exact distance only to the survivors. In dense urban graphs this collapses the candidate set by 90–99% before any `point.distance` call runs.

```python
import math


def compute_bounding_box(lat: float, lon: float, radius_km: float) -> dict:
    """Approximate degree-space bounding box on a spherical earth model."""
    R = 6371.0  # Earth radius, km
    d_lat = math.degrees(radius_km / R)
    d_lon = math.degrees(radius_km / (R * math.cos(math.radians(lat))))
    return {
        "min_lat": lat - d_lat, "max_lat": lat + d_lat,
        "min_lon": lon - d_lon, "max_lon": lon + d_lon,
    }


async def find_nearest_hubs(driver, lat: float, lon: float, radius_km: float = 5.0):
    bbox = compute_bounding_box(lat, lon, radius_km)
    query = """
    WITH point({srid: 4326, latitude: $lat, longitude: $lon}) AS target
    MATCH (hub:Hub)
    WHERE hub.location.latitude  >= $min_lat AND hub.location.latitude  <= $max_lat
      AND hub.location.longitude >= $min_lon AND hub.location.longitude <= $max_lon
    WITH hub, point.distance(hub.location, target) AS dist_m
    WHERE dist_m <= ($radius_km * 1000)
    RETURN hub.id AS id, dist_m AS distance_m
    ORDER BY dist_m ASC
    LIMIT 25
    """
    async with driver.session() as session:
        result = await session.run(query, lat=lat, lon=lon, radius_km=radius_km, **bbox)
        return [record.data() async for record in result]
```

## Query Patterns & Variants

The same "near here" intent has several index-able shapes. Pick the one whose anchor matches how the index is structured.

**Variant A — bounding box then exact distance (R-tree friendly).** The default for native point indexes. The range comparison on `latitude`/`longitude` is index-seekable; the distance call only runs on the bounded survivors.

```cypher
WITH point({srid: 4326, latitude: $lat, longitude: $lon}) AS target
MATCH (hub:Hub)
WHERE hub.location.latitude  >= $min_lat AND hub.location.latitude  <= $max_lat
  AND hub.location.longitude >= $min_lon AND hub.location.longitude <= $max_lon
WITH hub, point.distance(hub.location, target) AS dist_m
WHERE dist_m <= $radius_m
RETURN hub.id, dist_m ORDER BY dist_m LIMIT 50
// $min_*/$max_* come from compute_bounding_box(); never compute the box in Cypher.
```

**Variant B — geohash prefix shard routing.** When data is partitioned by region, route to the shard with a prefix seek before any geometry runs. Truncate the geohash to the precision whose cell comfortably contains your radius.

```cypher
MATCH (hub:Hub)
WHERE hub.geohash STARTS WITH $cell_prefix
WITH hub, point.distance(hub.location, point($target)) AS dist_m
WHERE dist_m <= $radius_m
RETURN hub.id, dist_m ORDER BY dist_m LIMIT 50
// Query the 8 neighbor prefixes too, or points across a cell border are missed.
```

**Variant C — KNN without a fixed radius.** When the question is "the k closest" rather than "everything within r", drop the radius guard and let `ORDER BY ... LIMIT k` do the work — but keep the bounding box so the index still bounds the scan. This overlaps directly with [k-nearest-neighbor routing](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/k-nearest-neighbor-routing/), and the predicate shapes mirror those in [distance filter query patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/).

```cypher
WITH point({srid: 4326, latitude: $lat, longitude: $lon}) AS target
MATCH (hub:Hub)
WHERE hub.location.latitude  >= $min_lat AND hub.location.latitude  <= $max_lat
  AND hub.location.longitude >= $min_lon AND hub.location.longitude <= $max_lon
RETURN hub.id, point.distance(hub.location, target) AS dist_m
ORDER BY dist_m ASC LIMIT $k
// Widen the box and re-run if fewer than $k rows return at the edge of coverage.
```

## Performance Tuning

Profiling is the whole game. `EXPLAIN` returns the plan without running it (validate plan shape in CI); `PROFILE` runs the query and annotates each operator with real `db hits` and `rows`. Read the plan bottom-up and find the first operator whose `rows` is far larger than the final result — that is where an index or a tighter predicate belongs.

- **Confirm the seek, not the scan.** A healthy spatial query shows a `PointIndexSeek` (or `NodeIndexSeekByRange`) at the bottom. If you see a `NodeByLabelScan` feeding a `Filter` on `point.distance`, the predicate is not pushing down — move it onto the anchor and verify the index covers the property.
- **Refresh statistics after bulk loads.** Stale histograms make the planner misjudge selectivity and skip the index. Recompute after large ingestion or coordinate rewrites.
- **Keep plans cacheable.** Always parameterize. Literal coordinates baked into the query string force recompilation and thrash the plan cache; pass `$min_lat` etc. as parameters with stable types.
- **Budget memory for the hot region.** Size the page cache to hold the working set's nodes and the point index, so seeks stay in memory. Mirror this client-side with a bounded `max_connection_pool_size`.
- **Batch writes away from reads.** Run index rebuilds and bulk upserts in maintenance windows; node-split churn during heavy writes directly degrades read selectivity.

These planner-side concerns connect to the broader profiling and memory workflow in [Cypher performance tuning](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/). A practical loop: capture `PROFILE`, find the widest operator, add the index or tighten the predicate that narrows it, re-profile, and confirm `db hits` dropped.

<svg viewBox="0 0 820 312" role="img" aria-labelledby="prof-title prof-desc" xmlns="http://www.w3.org/2000/svg">
  <title id="prof-title">PROFILE operator trees for an unindexed versus an index-backed distance query</title>
  <desc id="prof-desc">Two stacked operator pipelines read bottom-up. The unindexed plan starts with a NodeByLabelScan over every Hub returning 1.2 million rows — the widest operator, highlighted — then a Filter on point.distance narrows it to 42 rows. The indexed plan starts with a PointIndexSeekByRange that returns only 3.1 thousand rows from the bounding box, then the same point.distance Filter narrows to 42. Both return an identical result set, but the indexed plan touches roughly 380 times fewer rows.</desc>
  <style>
    .pt-box{fill:var(--surface-2,#f4f4f5);stroke:var(--line-strong,#9ca3af);stroke-width:1.5;}
    .pt-hot{stroke:var(--accent-coral,#ff6b6b);stroke-width:2.5;}
    .pt-good{stroke:var(--accent,#0e7c86);stroke-width:2.5;}
    .pt-op{fill:var(--ink,#1f2937);font:600 16px var(--font-sans,system-ui,sans-serif);}
    .pt-sub{fill:var(--ink-mute,#6b7280);font:13px var(--font-mono,ui-monospace,monospace);}
    .pt-hd{font:700 17px var(--font-sans,system-ui,sans-serif);}
    .pt-pill{font:700 13px var(--font-mono,ui-monospace,monospace);fill:var(--viz-on-pill,#ffffff);}
    .pt-flow{stroke:currentColor;stroke-width:1.5;fill:none;opacity:.55;}
    .pt-note{fill:var(--accent-coral,#ff6b6b);font:italic 12px var(--font-sans,system-ui,sans-serif);}
    .pt-cap{fill:var(--ink-mute,#6b7280);font:600 13px var(--font-sans,system-ui,sans-serif);}
  </style>
  <defs>
    <marker id="pt-arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor" opacity=".55"/>
    </marker>
  </defs>
  <rect class="viz-backdrop" x="0" y="0" width="820" height="312" fill="var(--viz-bg,#ffffff)"/>
  <text class="pt-hd" x="210" y="28" text-anchor="middle" fill="var(--accent-coral,#ff6b6b)">Without point index</text>
  <text class="pt-hd" x="610" y="28" text-anchor="middle" fill="var(--accent,#0e7c86)">With point index</text>
  <!-- flow connectors (rows flow upward from scan to filter) -->
  <line class="pt-flow" x1="210" y1="148" x2="210" y2="112" marker-end="url(#pt-arr)"/>
  <line class="pt-flow" x1="610" y1="148" x2="610" y2="112" marker-end="url(#pt-arr)"/>
  <!-- LEFT: unindexed -->
  <g>
    <rect class="pt-box" x="60" y="116" width="300" height="56" rx="8"/>
    <text class="pt-op"  x="78" y="141">Filter</text>
    <text class="pt-sub" x="78" y="160">point.distance &lt;= r</text>
    <rect x="272" y="130" width="80" height="28" rx="14" fill="var(--ink-mute,#6b7280)"/>
    <text class="pt-pill" x="312" y="148" text-anchor="middle">42</text>
  </g>
  <g>
    <rect class="pt-box pt-hot" x="60" y="210" width="300" height="56" rx="8"/>
    <text class="pt-op"  x="78" y="235">NodeByLabelScan</text>
    <text class="pt-sub" x="78" y="254">:Hub</text>
    <rect x="272" y="224" width="80" height="28" rx="14" fill="var(--accent-coral,#ff6b6b)"/>
    <text class="pt-pill" x="312" y="242" text-anchor="middle">1.2 M</text>
    <text class="pt-note" x="210" y="286" text-anchor="middle">every Hub read before the filter runs</text>
  </g>
  <!-- RIGHT: indexed -->
  <g>
    <rect class="pt-box" x="460" y="116" width="300" height="56" rx="8"/>
    <text class="pt-op"  x="478" y="141">Filter</text>
    <text class="pt-sub" x="478" y="160">point.distance &lt;= r</text>
    <rect x="672" y="130" width="80" height="28" rx="14" fill="var(--ink-mute,#6b7280)"/>
    <text class="pt-pill" x="712" y="148" text-anchor="middle">42</text>
  </g>
  <g>
    <rect class="pt-box pt-good" x="460" y="210" width="300" height="56" rx="8"/>
    <text class="pt-op"  x="478" y="235">PointIndexSeekByRange</text>
    <text class="pt-sub" x="478" y="254">:Hub(location) in bbox</text>
    <rect x="672" y="224" width="80" height="28" rx="14" fill="var(--accent,#0e7c86)"/>
    <text class="pt-pill" x="712" y="242" text-anchor="middle">3.1 K</text>
  </g>
  <text class="pt-cap" x="410" y="306" text-anchor="middle">Identical 42-row result — the indexed plan touches ~380x fewer rows.</text>
</svg>

## Edge Cases & Gotchas

- **Mixed CRS coordinates.** A geographic `point({latitude, longitude})` (SRID 4326) and a Cartesian `point({x, y})` (SRID 7203) are not comparable; `point.distance` across SRIDs returns `null`, and a `null` predicate silently drops the row rather than erroring. Normalize CRS at ingestion and assert the SRID before querying.
- **Geohash boundary misses.** Two points meters apart can land in different cells with different prefixes. A prefix-only query will miss the neighbor — always expand to the surrounding cells (8 for a square grid, 6 for H3) before computing distance.
- **Coordinate precision traps.** Float rounding on dense grids can make two segment endpoints "almost equal", creating phantom dead-ends or duplicate nodes. Snap to a fixed tolerance during [node and edge spatial mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/), not at query time.
- **Point index attached to the wrong primitive.** A point index on a node does nothing for a distance predicate evaluated over edge geometry. Index the property the planner actually filters on.
- **Index fragmentation under churn.** Uneven leaf splits after sustained writes inflate I/O and cache misses. Schedule periodic rebuilds in low-traffic windows and monitor index hit ratios via engine telemetry.
- **Driver timeout vs. unbounded scan.** A query that falls back to a full scan will blow past `connection_acquisition_timeout` under load and exhaust the pool. A timeout storm during peak traffic is usually a missing-seek symptom, not a pool-size problem.

## Verification & Testing

An index change is only safe if the indexed query returns the *same* rows as the naive one, just faster. Assert both correctness (the right hubs, in the right order) and plan shape (a seek, not a scan) — a regression that turns a seek back into a scan changes only latency, so a correctness test alone will not catch it.

```python
import pytest
from neo4j import AsyncGraphDatabase

SEED = """
CREATE (a:Hub {id: 1, location: point({srid:4326, latitude: 47.60, longitude: -122.33})})
CREATE (b:Hub {id: 2, location: point({srid:4326, latitude: 47.62, longitude: -122.35})})
CREATE (c:Hub {id: 3, location: point({srid:4326, latitude: 47.95, longitude: -122.90})})
"""


@pytest.mark.asyncio
async def test_bounded_query_matches_bruteforce():
    driver = AsyncGraphDatabase.driver("bolt://localhost:7687", auth=("neo4j", "test"))
    async with driver.session(database="neo4j") as s:
        await s.run("MATCH (n) DETACH DELETE n")
        await s.run(SEED)
        await s.run(
            "CREATE POINT INDEX hub_location IF NOT EXISTS FOR (h:Hub) ON (h.location)"
        )

        # Ground truth: brute-force distance over all hubs, no bounding box.
        truth = await (await s.run(
            """
            WITH point({srid:4326, latitude: 47.60, longitude: -122.33}) AS t
            MATCH (h:Hub)
            WITH h, point.distance(h.location, t) AS d WHERE d <= 5000
            RETURN h.id AS id ORDER BY d
            """
        )).values()

        # Indexed two-stage query under test.
        got = await (await s.run(
            """
            WITH point({srid:4326, latitude: 47.60, longitude: -122.33}) AS t
            MATCH (h:Hub)
            WHERE h.location.latitude >= 47.55 AND h.location.latitude <= 47.65
              AND h.location.longitude >= -122.40 AND h.location.longitude <= -122.28
            WITH h, point.distance(h.location, t) AS d WHERE d <= 5000
            RETURN h.id AS id ORDER BY d
            """
        )).values()

    assert got == truth, "bounded query must match brute-force result set"
    await driver.close()
```

Pair this with a plan-shape assertion: run `EXPLAIN` on the bounded query and inspect the plan from `result.consume()` to assert it contains a point index seek rather than a label scan.

## FAQ

<details>
<summary>R-tree, geohash, or quadtree — which should I default to?</summary>

Default to Neo4j's native point index (an R-tree) for point range and nearest-neighbor queries on a single instance — it gives index-backed `point.distance` with no extra moving parts. Reach for geohash or H3 when your dominant concern is sharding, cache locality, or cross-region replication, since string prefixes map cleanly to partitions. Choose a quadtree when you need polygon containment or multi-scale analytics rather than point proximity.
</details>

<details>
<summary>Why does my point.distance query still do a full label scan?</summary>

Almost always the predicate is not index-seekable as written, or the property is not a native point. Confirm `location` is stored as `point({srid:4326, ...})`, that a `POINT INDEX` exists on it, and that your range comparison sits before any expansion. Run `PROFILE` and check for a `PointIndexSeekByRange` at the base of the plan; a `NodeByLabelScan` feeding a `Filter` means push-down failed.
</details>

<details>
<summary>What geohash precision should I use for a given radius?</summary>

Match the cell size to your query radius so a small set of cells covers the search window. Precision 6 is roughly 1.2 km, precision 7 roughly 150 m, precision 8 roughly 38 m. Pick the precision whose cell comfortably contains your typical radius, then query that cell plus its neighbors so points near a boundary are not missed.
</details>

<details>
<summary>How do I stop a spatial index from fragmenting under heavy writes?</summary>

Separate write and read pressure: batch bulk upserts into maintenance windows so node-split churn does not collide with live queries, and schedule periodic index rebuilds during low-traffic periods. Monitor index hit ratios and leaf depth via engine telemetry, and consider a write-tolerant geohash grid if your workload is genuinely write-heavy rather than read-heavy.
</details>

<details>
<summary>Should I shard spatial data, and by what key?</summary>

Shard once a single instance can no longer hold the hot region's nodes and index in the page cache. Geohash prefix or H3 resolution level is the natural shard key because it aligns physical storage with query locality, which minimizes cross-node hops during nearest-neighbor resolution. Avoid sharding by an unrelated key (such as ingestion time), since it scatters spatially adjacent points across partitions.
</details>

## Related

- [Implementing Geohash vs Quadtree Indexing in Neo4j](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/implementing-geohash-vs-quadtree-indexing-in-neo4j/) — a hands-on comparison of prefix grids versus recursive partitioning.
- [R-tree vs Geohash vs Quadtree for Road Graphs](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/r-tree-vs-geohash-vs-quadtree-for-road-graphs/) — a workload-driven decision guide for picking an index on a road network.
- [Node and Edge Spatial Mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/) — storing geometry as native points so it can be indexed.
- [Graph Query Planner Optimization](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/) — making the planner consume the selectivity your index exposes.
- [Distance Filter Query Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/) — predicate shapes that resolve against spatial indexes.
- [K-Nearest-Neighbor Routing](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/k-nearest-neighbor-routing/) — KNN resolution built on a bounded spatial scan.

This guide is part of [Spatial Graph Database Fundamentals for Python](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/).

For authoritative reference on native spatial functions and geometry standards, consult the [Neo4j Cypher Spatial Functions Documentation](https://neo4j.com/docs/cypher-manual/current/functions/spatial/) and the [Shapely Geometry Validation Manual](https://shapely.readthedocs.io/en/stable/manual.html).

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "R-tree, geohash, or quadtree — which should I default to?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Default to Neo4j's native point index (an R-tree) for point range and nearest-neighbor queries on a single instance, since it gives index-backed point.distance with no extra moving parts. Reach for geohash or H3 when your dominant concern is sharding, cache locality, or cross-region replication, because string prefixes map cleanly to partitions. Choose a quadtree when you need polygon containment or multi-scale analytics rather than point proximity."
      }
    },
    {
      "@type": "Question",
      "name": "Why does my point.distance query still do a full label scan?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Almost always the predicate is not index-seekable as written, or the property is not a native point. Confirm location is stored as point with SRID 4326, that a POINT INDEX exists on it, and that your range comparison sits before any expansion. Run PROFILE and check for a PointIndexSeekByRange at the base of the plan; a NodeByLabelScan feeding a Filter means push-down failed."
      }
    },
    {
      "@type": "Question",
      "name": "What geohash precision should I use for a given radius?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Match the cell size to your query radius so a small set of cells covers the search window. Precision 6 is roughly 1.2 km, precision 7 roughly 150 m, and precision 8 roughly 38 m. Pick the precision whose cell comfortably contains your typical radius, then query that cell plus its neighbors so points near a boundary are not missed."
      }
    },
    {
      "@type": "Question",
      "name": "How do I stop a spatial index from fragmenting under heavy writes?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Separate write and read pressure: batch bulk upserts into maintenance windows so node-split churn does not collide with live queries, and schedule periodic index rebuilds during low-traffic periods. Monitor index hit ratios and leaf depth via engine telemetry, and consider a write-tolerant geohash grid if your workload is genuinely write-heavy rather than read-heavy."
      }
    },
    {
      "@type": "Question",
      "name": "Should I shard spatial data, and by what key?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Shard once a single instance can no longer hold the hot region's nodes and index in the page cache. Geohash prefix or H3 resolution level is the natural shard key because it aligns physical storage with query locality, which minimizes cross-node hops during nearest-neighbor resolution. Avoid sharding by an unrelated key such as ingestion time, since it scatters spatially adjacent points across partitions."
      }
    }
  ]
}
</script>
