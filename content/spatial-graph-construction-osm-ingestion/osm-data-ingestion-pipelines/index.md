---
pageTitle: OSM Data Ingestion Pipelines
title: OSM Data Ingestion Pipelines
description: Turn raw OpenStreetMap PBF extracts into a routing-ready Neo4j graph — streaming PBF parsing, geodesic edge weighting, and idempotent async UNWIND ingestion in Python.
slug: osm-data-ingestion-pipelines
type: guide
breadcrumb: OSM Data Ingestion Pipelines
datePublished: 2025-09-24
dateModified: 2026-06-26
---
# Production-Grade OSM Data Ingestion Pipelines

An OSM ingestion pipeline must produce a deterministic, query-ready spatial graph before any routing algorithm is allowed to read it — and the failure cost of getting this wrong is invisible until production. Raw OpenStreetMap exports contain overlapping geometries, duplicate junction nodes, dangling ways, and free-text tags that mean different things in different countries. Pour that directly into a graph and `shortestPath` silently returns a detour around a junction that should exist, a one-way street routes traffic the wrong direction, or a continental import dies with an out-of-memory kill three hours in. This guide solves the engineering problem of converting a `.osm.pbf` extract into a normalized, weighted, index-backed graph: how to stream the file without materializing it in heap, how to derive edge weights that respect the geoid, and how to write the result idempotently so re-imports never corrupt topology.

This is the entry stage of [Spatial Graph Construction & OSM Ingestion](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/): the edge rows this pipeline emits are exactly the input that the high-throughput loader in [Async Batch Processing for Graphs](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/async-batch-processing-for-graphs/) consumes. Get parsing and normalization right here and every downstream traversal inherits a clean graph; get it wrong and you propagate broken connectivity into every route.

## Prerequisites

You need an async Python toolchain, a parser that can stream PBF block-by-block, and a Neo4j instance reachable over Bolt. The geodesic weighting step depends on `pyproj`; the parsing step uses `pyrosm` (which wraps the `osmium` reader) so continental extracts never need to fit in memory at once.

| Component | Minimum version | Notes |
| --- | --- | --- |
| Python | 3.10+ | `match`/`case` tag classification assumes 3.10 |
| Neo4j | 5.x | `MERGE`-time index seeks and point indexes require the 5-series planner |
| `neo4j` driver | 5.x | Provides `AsyncGraphDatabase` and `session.execute_write` |
| `pyrosm` | 0.6+ | Block-level PBF reader; avoids full-dataset materialization |
| `pyproj` | 3.6+ | Geodesic (`Geod.inv`) edge lengths on the WGS84 ellipsoid |

```bash
pip install "neo4j>=5.0" "pyrosm>=0.6" "pyproj>=3.6"
```

Confirm the driver can reach the database before parsing a single byte — a misconfigured `uri` or auth tuple surfaces much later as an ingestion queue that fills and never drains, which is far harder to diagnose than an explicit connectivity failure at startup.

```python
import asyncio
from neo4j import AsyncGraphDatabase

async def healthcheck(uri: str, auth: tuple[str, str]) -> None:
    driver = AsyncGraphDatabase.driver(uri, auth=auth)
    await driver.verify_connectivity()
    await driver.close()

asyncio.run(healthcheck("bolt://localhost:7687", ("neo4j", "password")))
```

## Core Concept & Mechanism

The pipeline is a three-stage transform: **extract** (stream features out of the PBF), **transform** (classify tags, snap coordinates, compute geodesic weights), and **load** (batch idempotent writes into the graph). The reason it must be staged — rather than a single read-everything-then-write loop — is that the three stages have incompatible cost profiles. Extraction is disk-I/O bound, transformation is CPU bound, and loading is network bound. A naive loader serializes them and idles two of the three resources at every step.

Consume compressed Protocol Buffer Format (PBF) rather than legacy XML. The [OSM PBF format](https://wiki.openstreetmap.org/wiki/PBF_Format) stores features in independently compressed fileblocks, which lets a reader seek and decode one block at a time instead of building a full DOM. Streaming readers like `osmium` and `pyrosm` yield ways and nodes incrementally, so peak resident memory is bounded by your chunk size, not by the extract size. Processing a continental file with an eager parser will exhaust RAM before the first transaction commits.

The mechanism rests on three decisions that determine whether the resulting graph is usable:

- **Coordinate snapping at parse time.** Two endpoints of the same junction that differ by a millionth of a degree must round to identical values *before* they reach the database, or `MERGE` creates two nodes and the connecting segment links the wrong one. Snapping in Python is cheap; reconciling near-coincident points inside the database under lock is not. The geometry-to-topology rules behind this belong to [Node and Edge Spatial Mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/).
- **Geodesic edge weights.** Euclidean distance on raw lat/lon coordinates distorts cost increasingly toward the poles. Computing length on the WGS84 ellipsoid keeps routing costs correct at any latitude.
- **Idempotent batched writes.** A single `UNWIND $batch AS row` statement that `MERGE`s both endpoints and the relationship between them turns thousands of operations into one compiled plan and one round-trip, and re-running it never duplicates topology.

<svg viewBox="0 0 900 230" role="img" aria-labelledby="pl-title pl-desc" xmlns="http://www.w3.org/2000/svg">
  <title id="pl-title">Three-stage OSM ingestion pipeline grouped by resource profile</title>
  <desc id="pl-desc">A left-to-right pipeline of six stages. The Extract phase reads .osm.pbf fileblocks and streams them with pyrosm or osmium; it is disk-I/O bound. The Transform phase classifies tags, snaps coordinates, and computes geodesic weights, then buffers bounded batches of five to ten thousand edges; it is CPU bound. The Load phase issues idempotent UNWIND MERGE writes into a routing graph of Intersection nodes and RoadSegment relationships; it is network bound. Staging the three keeps each resource busy instead of idling two while the third works.</desc>
  <style>
    .pl-box{fill:var(--surface-2,#f4f4f5);stroke-width:1.8;}
    .pl-ex{stroke:var(--line-strong,#9ca3af);}
    .pl-cpu{stroke:var(--accent,#0e7c86);}
    .pl-db{stroke:var(--accent-2,#a8380b);}
    .pl-hd{fill:var(--ink,#1f2937);font:700 14px var(--font-sans,system-ui,sans-serif);}
    .pl-sub{fill:var(--ink-mute,#6b7280);font:11.5px var(--font-mono,ui-monospace,monospace);}
    .pl-flow{stroke:currentColor;stroke-width:1.6;fill:none;opacity:.55;}
    .pl-res{font:italic 11.5px var(--font-sans,system-ui,sans-serif);}
    .pl-phase{font:700 11px var(--font-sans,system-ui,sans-serif);letter-spacing:1.5px;}
    .pl-bracket{fill:none;stroke-width:1.4;opacity:.6;}
  </style>
  <defs>
    <marker id="pl-arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor" opacity=".55"/>
    </marker>
  </defs>
  <!-- phase labels + brackets -->
  <rect class="viz-backdrop" x="0" y="0" width="900" height="230" fill="var(--viz-bg,#ffffff)"/>
  <text class="pl-phase" x="147" y="24" text-anchor="middle" fill="var(--viz-ink-mute,#565f6d)">EXTRACT</text>
  <text class="pl-phase" x="443" y="24" text-anchor="middle" fill="var(--accent,#0e7c86)">TRANSFORM</text>
  <text class="pl-phase" x="739" y="24" text-anchor="middle" fill="var(--accent-2,#a8380b)">LOAD</text>
  <path class="pl-bracket" stroke="var(--line-strong,#9ca3af)" d="M16 40 v-6 h262 v6"/>
  <path class="pl-bracket" stroke="var(--accent,#0e7c86)" d="M312 40 v-6 h262 v6"/>
  <path class="pl-bracket" stroke="var(--accent-2,#a8380b)" d="M608 40 v-6 h262 v6"/>
  <!-- stage boxes -->
  <g>
    <rect class="pl-box pl-ex" x="16" y="62" width="124" height="92" rx="8"/>
    <text class="pl-hd" x="78" y="100" text-anchor="middle">.osm.pbf</text>
    <text class="pl-sub" x="78" y="122" text-anchor="middle">fileblocks</text>
  </g>
  <line class="pl-flow" x1="140" y1="108" x2="152" y2="108" marker-end="url(#pl-arr)"/>
  <g>
    <rect class="pl-box pl-ex" x="154" y="62" width="124" height="92" rx="8"/>
    <text class="pl-hd" x="216" y="96" text-anchor="middle">Extract</text>
    <text class="pl-sub" x="216" y="118" text-anchor="middle">pyrosm · osmium</text>
    <text class="pl-sub" x="216" y="134" text-anchor="middle">stream blocks</text>
  </g>
  <line class="pl-flow" x1="278" y1="108" x2="310" y2="108" marker-end="url(#pl-arr)"/>
  <g>
    <rect class="pl-box pl-cpu" x="312" y="62" width="124" height="92" rx="8"/>
    <text class="pl-hd" x="374" y="96" text-anchor="middle">Transform</text>
    <text class="pl-sub" x="374" y="118" text-anchor="middle">classify · snap</text>
    <text class="pl-sub" x="374" y="134" text-anchor="middle">geodesic weight</text>
  </g>
  <line class="pl-flow" x1="436" y1="108" x2="448" y2="108" marker-end="url(#pl-arr)"/>
  <g>
    <rect class="pl-box pl-cpu" x="450" y="62" width="124" height="92" rx="8"/>
    <text class="pl-hd" x="512" y="96" text-anchor="middle">Batch</text>
    <text class="pl-sub" x="512" y="118" text-anchor="middle">5k–10k edges</text>
    <text class="pl-sub" x="512" y="134" text-anchor="middle">bounded</text>
  </g>
  <line class="pl-flow" x1="574" y1="108" x2="606" y2="108" marker-end="url(#pl-arr)"/>
  <g>
    <rect class="pl-box pl-db" x="608" y="62" width="124" height="92" rx="8"/>
    <text class="pl-hd" x="670" y="96" text-anchor="middle">Load</text>
    <text class="pl-sub" x="670" y="118" text-anchor="middle">UNWIND MERGE</text>
    <text class="pl-sub" x="670" y="134" text-anchor="middle">idempotent</text>
  </g>
  <line class="pl-flow" x1="732" y1="108" x2="744" y2="108" marker-end="url(#pl-arr)"/>
  <g>
    <rect class="pl-box pl-db" x="746" y="62" width="124" height="92" rx="8"/>
    <text class="pl-hd" x="808" y="96" text-anchor="middle">Routing graph</text>
    <text class="pl-sub" x="808" y="118" text-anchor="middle">Intersection</text>
    <text class="pl-sub" x="808" y="134" text-anchor="middle">RoadSegment</text>
  </g>
  <!-- resource-profile annotations -->
  <text class="pl-res" x="147" y="186" text-anchor="middle" fill="var(--viz-ink-mute,#565f6d)">disk-I/O bound</text>
  <text class="pl-res" x="443" y="186" text-anchor="middle" fill="var(--accent,#0e7c86)">CPU bound</text>
  <text class="pl-res" x="739" y="186" text-anchor="middle" fill="var(--accent-2,#a8380b)">network bound</text>
</svg>

## Schema & Data Model

The schema deliberately decouples physical infrastructure from routing metadata so traversals read weighted relationships, not raw geometry. Intersections materialize as `Intersection` nodes carrying a native `location` point and a stable `osm_id`; traversable road segments become directed `RoadSegment` relationships carrying `weight` (travel-time cost), `length_m`, `oneway`, and `highway_type`. Routing engines walk the relationships; analytics that need geometry read the node points.

Two schema objects must exist **before** the first batch, or throughput collapses:

1. A **uniqueness constraint** on `Intersection.osm_id`. Without it, every `MERGE (n:Intersection {osm_id: ...})` degrades to a full label scan and ingestion turns from near-linear into quadratic. The constraint also creates a backing index for free.
2. A **point index** on `Intersection.location`. Proximity predicates against freshly ingested nodes seek this index; absent it, the planner scans every node and filters — exactly the fallback that [Spatial Indexing Strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) exists to avoid.

```cypher
// Run once, before ingestion. IF NOT EXISTS keeps this idempotent.
CREATE CONSTRAINT intersection_osm_id IF NOT EXISTS
FOR (n:Intersection) REQUIRE n.osm_id IS UNIQUE;

CREATE POINT INDEX intersection_location IF NOT EXISTS
FOR (n:Intersection) ON (n.location);

// Optional: index the segment id if you re-import and MERGE relationships by id.
CREATE INDEX road_segment_id IF NOT EXISTS
FOR ()-[r:RoadSegment]-() ON (r.edge_id);
```

Creating the constraint and index up front matters more than it looks: building an index on an empty store is instant, whereas building it after loading millions of nodes blocks and rescans the entire label.

## Step-by-Step Implementation

The stages below compose into a complete, runnable pipeline: stream the PBF, transform features into normalized edge rows, then batch them into the graph.

### 1. Stream features out of the PBF

Read the extract block-by-block and yield one feature at a time. The reader never holds more than the active fileblock plus your buffer, so peak memory is independent of the extract size. Align the chunk boundary with the worker's memory budget (typically 2–4 GB per container).

```python
import asyncio
from typing import Any, AsyncIterator, Dict

def stream_pbf_ways(pbf_path: str):
    """Yield drivable way features with resolved endpoint coordinates.
    pyrosm reads fileblocks lazily, so resident memory stays bounded."""
    from pyrosm import OSM

    osm = OSM(pbf_path)
    # network_type filters to drivable ways; nodes resolve to lon/lat geometry.
    edges = osm.get_network(network_type="driving", nodes=False)
    for row in edges.itertuples():
        coords = list(row.geometry.coords)  # [(lon, lat), ...] along the way
        yield {
            "tags": {"highway": row.highway, "maxspeed": getattr(row, "maxspeed", None),
                     "oneway": getattr(row, "oneway", None)},
            "start_node": {"osm_id": f"{row.u}", "lon": coords[0][0], "lat": coords[0][1]},
            "end_node":   {"osm_id": f"{row.v}", "lon": coords[-1][0], "lat": coords[-1][1]},
        }

async def as_async_stream(pbf_path: str) -> AsyncIterator[Dict[str, Any]]:
    """Adapt the blocking reader to an async iterator without blocking the loop."""
    loop = asyncio.get_running_loop()
    it = stream_pbf_ways(pbf_path)
    while True:
        feature = await loop.run_in_executor(None, lambda: next(it, None))
        if feature is None:
            break
        yield feature
```

Running the blocking reader in an executor keeps the event loop responsive so transform and load coroutines make progress while the next block decompresses.

### 2. Transform: classify tags, snap, and weight on the geoid

This async generator classifies each way by `highway` class, parses the messy `maxspeed` tag, and computes geodesic edge length with `pyproj`. It buffers normalized dictionaries and yields bounded batches — no intermediate dataframe, so garbage-collection spikes stay flat.

```python
import re
from collections import deque
from pyproj import Geod

geod = Geod(ellps="WGS84")  # geodesic calculator for WGS84

def _parse_maxspeed(raw: Any, default_kph: float) -> float:
    """OSM `maxspeed` may be 'walk', '30', '50 km/h', '30 mph', or absent.
    Return km/h, falling back to a class-specific default."""
    if raw is None:
        return default_kph
    match = re.match(r"\s*(\d+(?:\.\d+)?)\s*(mph)?", str(raw), flags=re.IGNORECASE)
    if not match:
        return default_kph
    value = float(match.group(1))
    return value * 1.609344 if match.group(2) else value

def _snap(lat: float, lon: float, precision: int = 6) -> tuple[float, float]:
    """Enforce WGS84 bounds and quantize so shared junctions round to one value."""
    if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
        raise ValueError(f"coords out of WGS84 bounds: {(lat, lon)}")
    return round(lat, precision), round(lon, precision)

async def transform_osm_to_routing(
    feature_stream: AsyncIterator[Dict[str, Any]],
    batch_size: int = 5000,
) -> AsyncIterator[list[Dict[str, Any]]]:
    buffer: deque = deque()
    async for feature in feature_stream:
        tags = feature.get("tags", {})
        match tags.get("highway"):
            case "motorway" | "trunk" | "primary":
                # congestion-adjusted free-flow speed
                speed_kph = _parse_maxspeed(tags.get("maxspeed"), 100.0) * 0.85
            case "secondary" | "tertiary" | "residential" | "service":
                speed_kph = _parse_maxspeed(tags.get("maxspeed"), 30.0)
            case _:
                continue  # skip non-drivable classes

        src, tgt = feature["start_node"], feature["end_node"]
        s_lat, s_lon = _snap(src["lat"], src["lon"])
        t_lat, t_lon = _snap(tgt["lat"], tgt["lon"])
        distance_m = geod.inv(s_lon, s_lat, t_lon, t_lat)[2]  # ellipsoidal length
        weight_hours = (distance_m / 1000.0) / speed_kph if speed_kph > 0 else 0.0

        buffer.append({
            "edge_id": f"{src['osm_id']}-{tgt['osm_id']}",
            "source_id": src["osm_id"], "src_lat": s_lat, "src_lon": s_lon,
            "target_id": tgt["osm_id"], "tgt_lat": t_lat, "tgt_lon": t_lon,
            "type": tags["highway"],
            "weight": round(weight_hours, 6),
            "oneway": tags.get("oneway") == "yes",
            "length_m": round(distance_m, 2),
        })
        if len(buffer) >= batch_size:
            yield list(buffer)
            buffer.clear()
    if buffer:
        yield list(buffer)
```

Geodesic distance via `Geod.inv` prevents the routing-cost distortion that Euclidean approximations introduce at higher latitudes, and snapping at this stage is what stops duplicate junctions from ever reaching the database.

### 3. Load: idempotent batched write with connection pooling

Drain the batches into the graph through one shared async driver. A single `UNWIND` `MERGE`s both endpoints and the segment; because `osm_id` is constrained, each `MERGE` is an index seek, not a scan. `execute_write` retries transient failures (leader switches, deadlocks) automatically.

```python
from neo4j import AsyncGraphDatabase, AsyncManagedTransaction

UPSERT = """
UNWIND $batch AS row
MERGE (src:Intersection {osm_id: row.source_id})
  ON CREATE SET src.location = point({latitude: row.src_lat, longitude: row.src_lon}),
                src.created_at = timestamp()
MERGE (tgt:Intersection {osm_id: row.target_id})
  ON CREATE SET tgt.location = point({latitude: row.tgt_lat, longitude: row.tgt_lon}),
                tgt.created_at = timestamp()
MERGE (src)-[r:RoadSegment {edge_id: row.edge_id}]->(tgt)
SET r.weight = row.weight, r.length_m = row.length_m,
    r.oneway = row.oneway, r.highway_type = row.type
"""

async def _write_batch(tx: AsyncManagedTransaction, batch: list[Dict[str, Any]]) -> None:
    await tx.run(UPSERT, batch=batch)

async def run_pipeline(pbf_path: str, uri: str, auth: tuple[str, str],
                       max_concurrency: int = 24) -> int:
    driver = AsyncGraphDatabase.driver(
        uri, auth=auth, max_connection_pool_size=max_concurrency
    )
    sem = asyncio.Semaphore(max_concurrency)  # caps active write transactions
    total = 0

    async def commit(batch: list[Dict[str, Any]]) -> None:
        async with sem, driver.session(database="neo4j") as session:
            await session.execute_write(_write_batch, batch)

    try:
        tasks: list[asyncio.Task] = []
        async for batch in transform_osm_to_routing(as_async_stream(pbf_path)):
            total += len(batch)
            tasks.append(asyncio.create_task(commit(batch)))
            # keep in-flight work bounded so memory tracks the semaphore, not the file
            if len(tasks) >= max_concurrency:
                await asyncio.gather(*tasks)
                tasks.clear()
        if tasks:
            await asyncio.gather(*tasks)
    finally:
        await driver.close()
    return total

# asyncio.run(run_pipeline("region.osm.pbf", "bolt://localhost:7687", ("neo4j", "password")))
```

Sizing `max_connection_pool_size` to the concurrency cap means a worker never blocks acquiring a connection, and the [Neo4j Python driver connection guide](https://neo4j.com/docs/python-manual/current/connect/) documents the lifecycle knobs for sustained write load. For the full worker-pool, bounded-queue, and backpressure treatment of this loader, see [Async Batch Processing for Graphs](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/async-batch-processing-for-graphs/).

## Query Patterns & Variants

Once a region is loaded, three write/read shapes recur. Each is a deliberate variant of the base `UNWIND` ingestion.

**Variant 1 — create-only geometry, update-always metrics.** Use `ON CREATE` so incremental re-imports never rewrite immutable coordinates but always refresh mutable routing costs. This is the safe shape for scheduled updates.

```cypher
UNWIND $batch AS row
MERGE (src:Intersection {osm_id: row.source_id})
  ON CREATE SET src.location = point({latitude: row.src_lat, longitude: row.src_lon})
MERGE (tgt:Intersection {osm_id: row.target_id})
  ON CREATE SET tgt.location = point({latitude: row.tgt_lat, longitude: row.tgt_lon})
MERGE (src)-[r:RoadSegment {edge_id: row.edge_id}]->(tgt)
SET r.weight = row.weight, r.length_m = row.length_m
// $batch: list of maps; source_id/target_id must be SNAPPED-derived ids
```

**Variant 2 — bounding-box check during load.** To confirm an ingested node falls inside a target tile, push the predicate down to the point index rather than filtering in Python.

```cypher
WITH point({latitude: $minLat, longitude: $minLon}) AS lo,
     point({latitude: $maxLat, longitude: $maxLon}) AS hi
MATCH (n:Intersection)
WHERE point.withinBBox(n.location, lo, hi)
RETURN count(n) AS nodes_in_tile
// lo/hi: SW and NE corners; seeks intersection_location, no full scan
```

**Variant 3 — proximity lookup after ingestion.** Distance-bounded nearest-node queries against the freshly loaded graph follow the same predicate shapes documented in [Distance Filter Query Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/).

```cypher
MATCH (n:Intersection)
WHERE point.distance(n.location, $origin) < $radius_m
RETURN n.osm_id AS id, point.distance(n.location, $origin) AS meters
ORDER BY meters
LIMIT $k
// $origin: a point({...}); $radius_m bounds the index range scan
```

## Performance Tuning

Batched async ingestion moves the bottleneck off network round-trips and onto CPU scheduling and database memory, so tune both ends.

**Profile the write, do not guess.** Prefix the upsert with `PROFILE` against a representative batch and confirm the endpoint lookups are `NodeUniqueIndexSeek`, not `NodeByLabelScan` — a label scan means the constraint is missing. `EXPLAIN` shows the plan without running it; `PROFILE` reports actual db-hits, which is where a missing index betrays itself.

```cypher
PROFILE
UNWIND $batch AS row
MERGE (src:Intersection {osm_id: row.source_id})
MERGE (tgt:Intersection {osm_id: row.target_id})
MERGE (src)-[r:RoadSegment {edge_id: row.edge_id}]->(tgt)
RETURN count(*)
```

**Size batches to the transaction log, not to a round number.** 5,000–10,000 edge rows per batch is the working range. Larger payloads raise heap pressure and lengthen lock durations; if the storage engine uses write-ahead logging, keeping batches under 10,000 avoids log-truncation and checkpoint stalls. Micro-batches amplify per-transaction overhead.

**Right-size the pool against the database.** Set `max_connection_pool_size` equal to the semaphore cap so workers never wait on connection acquisition. Start conservative (concurrency around 24), watch connection-acquisition timeouts and per-batch latency percentiles, then raise it.

**Watch heap and checkpointing.** Sustained ingestion grows the transaction log; if checkpointing falls behind, throughput sawtooths. Allocate page cache to fit the working set of `Intersection` records and their indexes, and keep the heap large enough that `UNWIND` payloads do not trigger long young-generation pauses. The planner-side levers — index hints, predicate ordering — are detailed in [Graph Query Planner Optimization](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/).

## Edge Cases & Gotchas

- **Coordinate-order traps.** Neo4j `point({latitude, longitude})` is unambiguous, but raw OSM and GeoJSON emit `(lon, lat)`. A silent swap produces plausible points in the wrong hemisphere — assert bounds tightly (`-90..90` vs `-180..180`) so a swap fails loudly rather than corrupting routes.
- **Over-tight snapping creates islands.** If `precision` exceeds the source accuracy, two endpoints of one junction round to different values and the segment merges against the wrong node, leaving degree-0 islands. Six decimals is ~11 cm at the equator; loosen it for noisier sources and re-import.
- **Eager parsers OOM on continental extracts.** Loading a full country with a DOM-based XML reader materializes the dataset in heap and triggers an OOM kill before the first commit. Stream PBF fileblocks instead.
- **`MERGE` on relationships without a constrained key.** `MERGE (src)-[:RoadSegment {edge_id: ...}]->(tgt)` without an index on `edge_id` rescans every relationship between the pair. Index the segment id when re-importing by relationship id.
- **One-way direction loss.** Dropping the `oneway` tag turns a directed street into a bidirectional edge and routes traffic against the flow. Preserve `oneway` on the relationship and, where required, emit a second reversed `RoadSegment` only for two-way streets.
- **Stale GDS projections.** Projecting a graph for routing before ingestion has fully committed misses late edges. Project only after the pipeline returns and the driver has flushed. Keeping tags current after the first load is the job of [Attribute Synchronization Techniques](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/attribute-synchronization-techniques/), and attaching place data afterward is covered by [POI Enrichment Workflows](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/poi-enrichment-workflows/).


<svg viewBox="0 0 780 300" role="img" aria-labelledby="opTitle opDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="opTitle">Snapping precision against source accuracy, and what falls out on each side</title>
  <desc id="opDesc">A scale of snapping precision from four decimal places to eight, marked with the ground distance each represents: about eleven metres, one point one metres, eleven centimetres, one point one centimetres and one millimetre. Below it, the two failure regions. Too coarse and separate junctions within the grid cell merge into one node, welding streets that never met. Too fine — finer than the source's own accuracy — and the two endpoints of a single junction round to different cells, so the segment merges against the wrong node and leaves degree-zero islands behind. The safe band sits at or just below the accuracy of the source.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="300" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Choose precision from the source's accuracy, not from a habit</text>
  <line x1="80" y1="86" x2="736" y2="86" stroke="var(--viz-stroke,#9ca3af)" stroke-width="2"/>
  <g font-size="10.5" font-weight="700" text-anchor="middle">
    <circle cx="80" cy="86" r="5" fill="var(--viz-stroke,#9ca3af)"/><text x="80" y="70" fill="currentColor">4 dp</text><text x="80" y="108" font-size="9.5" font-weight="400" fill="var(--viz-ink-mute,#565f6d)">~11 m</text>
    <circle cx="244" cy="86" r="5" fill="var(--viz-stroke,#9ca3af)"/><text x="244" y="70" fill="currentColor">5 dp</text><text x="244" y="108" font-size="9.5" font-weight="400" fill="var(--viz-ink-mute,#565f6d)">~1.1 m</text>
    <circle cx="408" cy="86" r="7" fill="var(--viz-good,#0a656d)"/><text x="408" y="70" fill="var(--viz-good,#0a656d)">6 dp</text><text x="408" y="108" font-size="9.5" font-weight="400" fill="var(--viz-ink-mute,#565f6d)">~11 cm</text>
    <circle cx="572" cy="86" r="5" fill="var(--viz-stroke,#9ca3af)"/><text x="572" y="70" fill="currentColor">7 dp</text><text x="572" y="108" font-size="9.5" font-weight="400" fill="var(--viz-ink-mute,#565f6d)">~1.1 cm</text>
    <circle cx="736" cy="86" r="5" fill="var(--viz-stroke,#9ca3af)"/><text x="736" y="70" fill="currentColor">8 dp</text><text x="736" y="108" font-size="9.5" font-weight="400" fill="var(--viz-ink-mute,#565f6d)">~1 mm</text>
  </g>
  <rect x="24" y="132" width="356" height="122" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-ok,#7d6200)" stroke-width="1.6"/>
  <text x="202" y="156" text-anchor="middle" font-size="11.5" font-weight="700" fill="var(--viz-ok,#7d6200)">too coarse — junctions weld together</text>
  <rect x="150" y="170" width="52" height="52" rx="4" fill="none" stroke="var(--viz-ok,#7d6200)" stroke-width="1.4" stroke-dasharray="4 3"/>
  <circle cx="166" cy="186" r="6" fill="var(--viz-ok,#7d6200)"/>
  <circle cx="188" cy="208" r="6" fill="var(--viz-ok,#7d6200)"/>
  <text x="222" y="192" font-size="10" font-weight="700" fill="currentColor">one grid cell</text>
  <text x="222" y="208" font-size="10" fill="var(--viz-ink-mute,#565f6d)">two real junctions</text>
  <text x="202" y="242" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">streets that never met become connected</text>
  <rect x="400" y="132" width="356" height="122" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-poor,#a8320f)" stroke-width="1.6"/>
  <text x="578" y="156" text-anchor="middle" font-size="11.5" font-weight="700" fill="var(--viz-poor,#a8320f)">finer than the source — islands appear</text>
  <rect x="500" y="170" width="30" height="30" rx="3" fill="none" stroke="var(--viz-poor,#a8320f)" stroke-width="1.4" stroke-dasharray="4 3"/>
  <rect x="534" y="192" width="30" height="30" rx="3" fill="none" stroke="var(--viz-poor,#a8320f)" stroke-width="1.4" stroke-dasharray="4 3"/>
  <circle cx="515" cy="185" r="6" fill="var(--viz-poor,#a8320f)"/>
  <circle cx="549" cy="207" r="6" fill="var(--viz-poor,#a8320f)"/>
  <text x="584" y="192" font-size="10" font-weight="700" fill="currentColor">one junction</text>
  <text x="584" y="208" font-size="10" fill="var(--viz-ink-mute,#565f6d)">two canonical nodes</text>
  <text x="578" y="242" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">the segment merges against the wrong one</text>
  <text x="24" y="286" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">Both faults import cleanly. Count degree-zero nodes after every load — the island side of this trade shows up there first.</text>
</svg>

## Verification & Testing

Correctness here is structural, not "the job exited 0". After every load, assert three things: counts are stable across a re-import (idempotency held), there are no unexpected isolated nodes (snapping held), and known paths still exist (connectivity held).

```python
import asyncio
from neo4j import AsyncGraphDatabase

async def verify_ingestion(uri: str, auth: tuple[str, str]) -> None:
    driver = AsyncGraphDatabase.driver(uri, auth=auth)
    async with driver.session(database="neo4j") as session:
        # 1. No unexpected isolated nodes (snapping / constraint regression signal)
        rec = await (await session.run(
            "MATCH (n:Intersection) WHERE NOT (n)--() RETURN count(n) AS orphans"
        )).single()
        assert rec["orphans"] == 0, f"found {rec['orphans']} isolated intersections"

        # 2. Degree audit: absurdly high-degree nodes signal merge errors
        rec = await (await session.run(
            """
            MATCH (n:Intersection)
            WITH n, COUNT { (n)--() } AS deg
            WHERE deg > 12
            RETURN count(n) AS suspect_hubs
            """
        )).single()
        assert rec["suspect_hubs"] == 0, "unexpected ultra-high-degree intersections"

        # 3. Connectivity: a known A->C route must exist within a bounded hop range
        rec = await (await session.run(
            """
            MATCH p = shortestPath(
                (a:Intersection {osm_id: $a})-[:RoadSegment*1..60]->(c:Intersection {osm_id: $c}))
            RETURN length(p) AS hops
            """,
            a="seed-A", c="seed-C",
        )).single()
        assert rec is not None, "expected a route seed-A -> seed-C to exist"
    await driver.close()

asyncio.run(verify_ingestion("bolt://localhost:7687", ("neo4j", "password")))
```

Run this twice in CI against the same fixture: a snapping or constraint regression does not change counts on a single import, only on re-import, so a one-shot test misses it. For weighted correctness — that the stored `weight` yields sensible least-cost routes — project the region into GDS and run Dijkstra with `relationshipWeightProperty: 'weight'`, then compare a handful of results against ground truth.

## FAQ

<details>
<summary>Why parse PBF instead of the OSM XML export?</summary>

PBF stores features in independently compressed fileblocks, so a reader can decode one block at a time and seek without building a full DOM. That keeps peak memory bounded by your chunk size rather than the extract size, and it reads substantially faster off disk than XML. The XML format only makes sense for tiny extracts you intend to load whole; for anything regional or larger, a streaming PBF reader is the only safe choice.
</details>

<details>
<summary>How should I pick the coordinate snapping precision?</summary>

Choose `precision` from the accuracy of the source, not by habit. Six decimal places is roughly 11 cm at the equator — tight enough to keep distinct junctions separate, loose enough to merge the two endpoints of a shared intersection. If a source is noisier, too many decimals will round one junction's endpoints to different values and leave isolated nodes; the orphan check in the verification step catches this so you can loosen the precision and re-import.
</details>

<details>
<summary>Should edge length use Haversine or a geodesic library?</summary>

Geodesic length via `pyproj`'s `Geod.inv` uses the ellipsoidal WGS84 model and is the safe default for routing weights, especially for long edges or high-latitude networks where the spherical Haversine approximation drifts. Haversine is faster and accurate to a fraction of a percent for short urban segments, so it is a reasonable optimization when profiling shows the geodesic call is hot. Either way, compute the length in user space before writing so the database never does the trigonometry.
</details>

<details>
<summary>How do I make re-ingestion idempotent?</summary>

`MERGE` on the uniqueness-constrained `Intersection.osm_id`, set immutable coordinates with `ON CREATE`, and refresh mutable routing costs with `SET`. Existing junctions are reused, segments update in place, and no subgraph is orphaned. Verify by importing the same fixture twice and asserting that intersection and relationship counts are identical after the second pass.
</details>

<details>
<summary>How do I handle incremental updates without rebuilding the whole graph?</summary>

Run the same `UNWIND`/`MERGE` pipeline over a smaller diff extract (or an `osmChange` file) so only changed ways are reprocessed; the create-only geometry variant refreshes weights without touching coordinates. Scheduling those diffs, managing schema migrations, and keeping an audit trail is the orchestration concern covered in [Building Automated OSM to Graph ETL Pipelines](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/osm-data-ingestion-pipelines/building-automated-osm-to-graph-etl-pipelines/).
</details>

## Related

- [Building Automated OSM to Graph ETL Pipelines](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/osm-data-ingestion-pipelines/building-automated-osm-to-graph-etl-pipelines/) — scheduling, schema migrations, and audit trails for incremental imports.
- [Parsing OSM PBF Extracts with PyOsmium](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/osm-data-ingestion-pipelines/parsing-osm-pbf-extracts-with-pyosmium/) — streaming a `.osm.pbf` extract to routing nodes and ways without loading it into memory.
- [Async Batch Processing for Graphs](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/async-batch-processing-for-graphs/) — the bounded-queue, worker-pool loader that drains the batches this pipeline emits.
- [Node and Edge Spatial Mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/) — the geometry-to-topology rules behind intersection snapping and edge direction.
- [Attribute Synchronization Techniques](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/attribute-synchronization-techniques/) — keeping routing weights and tags current after the initial import.
- [Spatial Indexing Strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) — choosing the point/index type the proximity variants seek against.

This guide is part of [Spatial Graph Construction & OSM Ingestion](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/).

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "Why parse PBF instead of the OSM XML export?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "PBF stores features in independently compressed fileblocks, so a reader can decode one block at a time and seek without building a full DOM. That keeps peak memory bounded by chunk size rather than extract size, and it reads substantially faster off disk than XML. XML only makes sense for tiny extracts you load whole; for anything regional or larger, a streaming PBF reader is the only safe choice."
      }
    },
    {
      "@type": "Question",
      "name": "How should I pick the coordinate snapping precision?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Choose precision from the accuracy of the source, not by habit. Six decimal places is roughly 11 cm at the equator, tight enough to keep distinct junctions separate and loose enough to merge the two endpoints of a shared intersection. If a source is noisier, too many decimals round one junction's endpoints to different values and leave isolated nodes; the orphan check catches this so you can loosen precision and re-import."
      }
    },
    {
      "@type": "Question",
      "name": "Should edge length use Haversine or a geodesic library?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Geodesic length via pyproj Geod.inv uses the ellipsoidal WGS84 model and is the safe default for routing weights, especially for long edges or high-latitude networks where the spherical Haversine approximation drifts. Haversine is faster and accurate to a fraction of a percent for short urban segments, a reasonable optimization when profiling shows the geodesic call is hot. Either way, compute length in user space before writing so the database never does the trigonometry."
      }
    },
    {
      "@type": "Question",
      "name": "How do I make re-ingestion idempotent?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "MERGE on the uniqueness-constrained Intersection.osm_id, set immutable coordinates with ON CREATE, and refresh mutable routing costs with SET. Existing junctions are reused, segments update in place, and no subgraph is orphaned. Verify by importing the same fixture twice and asserting intersection and relationship counts are identical after the second pass."
      }
    },
    {
      "@type": "Question",
      "name": "How do I handle incremental updates without rebuilding the whole graph?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Run the same UNWIND/MERGE pipeline over a smaller diff extract or an osmChange file so only changed ways are reprocessed; the create-only geometry variant refreshes weights without touching coordinates. Scheduling those diffs, managing schema migrations, and keeping an audit trail is the orchestration concern handled by an automated OSM-to-graph ETL layer."
      }
    }
  ]
}
</script>
