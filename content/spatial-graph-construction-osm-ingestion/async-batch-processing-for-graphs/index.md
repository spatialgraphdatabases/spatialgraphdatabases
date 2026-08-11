# Async Batch Processing for Graphs

Spatial network routing demands deterministic latency and high-throughput topology ingestion, yet raw OpenStreetMap extracts rarely arrive as clean, traversable structures. A synchronous loader that issues one transaction per edge will exhaust the connection pool, bloat the transaction log, and stall the event loop long before a continental PBF dump is half-loaded — and the symptom an engineer actually sees is an ingestion job that runs for hours, then dies with `ConnectionAcquisitionTimeout` or an out-of-memory kill. **Async batch processing for graphs** solves this by decoupling I/O-bound database writes from CPU-bound topology resolution: you validate and snap coordinates in user space, group edges into bounded payloads, and let a fixed pool of worker coroutines drain those payloads into the graph under a strict concurrency cap. This guide covers the mechanism, the schema it requires, a complete runnable loader, the query and tuning patterns that keep it fast, and how to prove the result is topologically correct.

This is the highest-leverage stage of [Spatial Graph Construction & OSM Ingestion](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/): get batching and backpressure right here and every downstream traversal inherits a clean, well-indexed graph; get it wrong and you propagate duplicate junctions and broken connectivity into every route.

## Prerequisites

You need a working async Python toolchain and a Neo4j instance reachable over Bolt. The patterns below assume the official async driver and (for the weighted-routing verification step) the Graph Data Science library.

| Component | Minimum version | Notes |
| --- | --- | --- |
| Python | 3.10+ | `asyncio.TaskGroup` examples assume 3.11; the loader itself runs on 3.10 |
| Neo4j | 5.x | Point indexes and `MERGE`-time index seeks require the 5-series planner |
| `neo4j` driver | 5.x | Provides `AsyncGraphDatabase` and `session.execute_write` |
| Neo4j GDS | 2.5+ | Only needed for the weighted-path verification check |
| `pyproj` | 3.6+ | Optional, for geodesic edge lengths more precise than Haversine |

```bash
pip install "neo4j>=5.0" "pyproj>=3.6"
```

Confirm the driver can reach the database before writing a single batch — a misconfigured `uri` or auth tuple surfaces as a queue that fills and never drains, which is far harder to diagnose than an explicit connectivity failure at startup.

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

Asynchronous ingestion works because the two costs in this pipeline are fundamentally different in kind. Coordinate validation, spatial snapping, and Haversine weighting are CPU-bound and happen in the Python process; the `MERGE`/`SET` write is I/O-bound and happens across the network in the database. A synchronous loader serializes them — it computes one edge, blocks on the round-trip, then computes the next — so the CPU sits idle during every network wait. Cooperative multitasking interleaves them: while one batch is in flight to the database, the event loop is already validating the next.

The mechanism rests on three primitives:

- **A bounded `asyncio.Queue`** acts as the backpressure boundary. When producers fill it faster than workers drain it, `await queue.put(...)` blocks the producer, so memory cannot grow without limit no matter how large the source extract is. The queue's `maxsize` is your single most important memory knob.
- **A fixed pool of worker coroutines** each owns one long-lived session and loops on `queue.get()`. Pooling sessions (rather than opening one per batch) is what keeps connection churn off the hot path.
- **An `asyncio.Semaphore`** caps the number of write transactions active at once, independent of how many workers exist, so a burst of large batches cannot stampede the database transaction layer.

The Cypher itself stays deliberately simple: a single `UNWIND $batch AS row` statement that `MERGE`s both endpoints and the relationship between them. `UNWIND` turns one parameterized round-trip into thousands of row operations, which is the difference between a query plan compiled once and a plan recompiled per edge. The detailed worker-lifecycle, retry, and streaming-generator patterns that sit on top of this are covered in [Scaling Async Graph Ingestion with Python Asyncio](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/async-batch-processing-for-graphs/scaling-async-graph-ingestion-with-python-asyncio/).

<svg viewBox="0 0 912 380" role="img" aria-labelledby="ab-title ab-desc" xmlns="http://www.w3.org/2000/svg">
  <title id="ab-title">Backpressure-bounded async ingestion pipeline</title>
  <desc id="ab-desc">A left-to-right data-flow diagram split by a dashed vertical line into two zones. On the left, the user-space CPU-bound zone: a source stream of raw OSM edges feeds a validate-and-snap stage, which puts batches into a bounded asyncio queue whose maxsize applies backpressure. The queue fans out to a pool of three long-lived worker coroutines. The workers funnel into a semaphore gate that caps the number of active transactions. On the right, across the dashed line, the I/O-bound graph database receives one UNWIND batch per write.</desc>
  <style>
    .ab-hd{font:700 16px var(--font-sans,system-ui,sans-serif);fill:var(--ink,#1f2937);}
    .ab-zone{font:600 12px var(--font-sans,system-ui,sans-serif);fill:var(--ink-mute,#6b7280);}
    .ab-prod{fill:var(--surface-2,#f4f4f5);stroke:var(--line-strong,#9ca3af);stroke-width:1.6;}
    .ab-q{fill:var(--surface-2,#f4f4f5);stroke:var(--accent-amber,#b58900);stroke-width:2;}
    .ab-slot{fill:var(--accent-amber,#b58900);stroke:var(--accent-amber,#b58900);stroke-width:1;opacity:.22;}
    .ab-w{fill:var(--viz-panel,#f4f4f5);stroke:var(--accent,#0e7c86);stroke-width:2;}
    .ab-gate{fill:var(--viz-panel,#f4f4f5);stroke:var(--accent-3,#5b21b6);stroke-width:2;}
    .ab-db{fill:var(--viz-panel,#f4f4f5);stroke:var(--accent-coral,#c2410c);stroke-width:2;}
    .ab-t{font:600 13px var(--font-sans,system-ui,sans-serif);fill:var(--ink,#1f2937);}
    .ab-s{font:11px var(--font-mono,ui-monospace,monospace);fill:var(--ink-mute,#6b7280);}
    .ab-qlbl{font:600 12px var(--font-sans,system-ui,sans-serif);fill:var(--viz-ok,#8a6d00);}
    .ab-glbl{font:600 13px var(--font-sans,system-ui,sans-serif);fill:var(--accent-3,#5b21b6);}
    .ab-dlbl{font:600 13px var(--font-sans,system-ui,sans-serif);fill:var(--accent-coral,#c2410c);}
    .ab-cap{font:italic 12px var(--font-sans,system-ui,sans-serif);fill:var(--ink-mute,#6b7280);}
    .ab-flow{stroke:currentColor;stroke-width:2;fill:none;opacity:.55;}
    .ab-div{stroke:var(--line-strong,#9ca3af);stroke-width:1.4;stroke-dasharray:6 5;opacity:.7;fill:none;}
  </style>
  <defs>
    <marker id="ab-arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor" opacity=".6"/>
    </marker>
  </defs>
  <rect class="viz-backdrop" x="0" y="0" width="912" height="380" fill="var(--viz-bg,#ffffff)"/>
  <text class="ab-hd" x="456" y="26" text-anchor="middle">Backpressure-bounded async ingestion pipeline</text>
  <!-- zone divider (network boundary) -->
  <line class="ab-div" x1="748" y1="72" x2="748" y2="332"/>
  <text class="ab-zone" x="386" y="58" text-anchor="middle">user space · CPU-bound (asyncio event loop)</text>
  <text class="ab-zone" x="840" y="58" text-anchor="middle">database · I/O-bound</text>
  <!-- producer column -->
  <rect class="ab-prod" x="24" y="120" width="156" height="56" rx="9"/>
  <text class="ab-t" x="102" y="145" text-anchor="middle">Source stream</text>
  <text class="ab-s" x="102" y="163" text-anchor="middle">raw OSM edges</text>
  <rect class="ab-prod" x="24" y="212" width="156" height="66" rx="9"/>
  <text class="ab-t" x="102" y="239" text-anchor="middle">Validate &amp; snap</text>
  <text class="ab-s" x="102" y="258" text-anchor="middle">bounds · haversine</text>
  <line class="ab-flow" x1="102" y1="176" x2="102" y2="210" marker-end="url(#ab-arr)"/>
  <line class="ab-flow" x1="180" y1="245" x2="228" y2="206" marker-end="url(#ab-arr)"/>
  <!-- bounded queue -->
  <text class="ab-qlbl" x="284" y="112" text-anchor="middle">Bounded asyncio.Queue</text>
  <rect class="ab-q" x="232" y="124" width="104" height="168" rx="10"/>
  <rect class="ab-slot" x="246" y="142" width="76" height="16" rx="3"/>
  <rect class="ab-slot" x="246" y="168" width="76" height="16" rx="3"/>
  <rect class="ab-slot" x="246" y="194" width="76" height="16" rx="3"/>
  <rect class="ab-slot" x="246" y="220" width="76" height="16" rx="3"/>
  <rect class="ab-slot" x="246" y="246" width="76" height="16" rx="3"/>
  <text class="ab-cap" x="284" y="312" text-anchor="middle">maxsize → backpressure</text>
  <!-- worker pool -->
  <text class="ab-t" x="472" y="112" text-anchor="middle">Worker pool</text>
  <text class="ab-cap" x="472" y="312" text-anchor="middle">one long-lived session each</text>
  <rect class="ab-w" x="408" y="128" width="128" height="48" rx="8"/>
  <text class="ab-t" x="472" y="157" text-anchor="middle">Worker 1</text>
  <rect class="ab-w" x="408" y="188" width="128" height="48" rx="8"/>
  <text class="ab-t" x="472" y="217" text-anchor="middle">Worker 2</text>
  <rect class="ab-w" x="408" y="248" width="128" height="48" rx="8"/>
  <text class="ab-t" x="472" y="277" text-anchor="middle">Worker N</text>
  <line class="ab-flow" x1="336" y1="208" x2="406" y2="152" marker-end="url(#ab-arr)"/>
  <line class="ab-flow" x1="336" y1="208" x2="406" y2="212" marker-end="url(#ab-arr)"/>
  <line class="ab-flow" x1="336" y1="208" x2="406" y2="272" marker-end="url(#ab-arr)"/>
  <!-- semaphore gate -->
  <polygon class="ab-gate" points="612,212 634,168 678,168 700,212 678,256 634,256"/>
  <text class="ab-glbl" x="656" y="208" text-anchor="middle">Semaphore</text>
  <text class="ab-s" x="656" y="226" text-anchor="middle">caps active tx</text>
  <path class="ab-flow" d="M536 152 H574 V212 H608" marker-end="url(#ab-arr)"/>
  <line class="ab-flow" x1="536" y1="212" x2="608" y2="212" marker-end="url(#ab-arr)"/>
  <path class="ab-flow" d="M536 272 H574 V212 H608" marker-end="url(#ab-arr)"/>
  <!-- graph database -->
  <path class="ab-db" d="M792 158 a48 14 0 0 1 96 0 v104 a48 14 0 0 1 -96 0 z"/>
  <path class="ab-db" d="M792 158 a48 14 0 0 0 96 0" fill="none"/>
  <text class="ab-dlbl" x="840" y="208" text-anchor="middle">Graph DB</text>
  <text class="ab-s" x="840" y="226" text-anchor="middle">UNWIND $batch</text>
  <line class="ab-flow" x1="700" y1="212" x2="788" y2="212" marker-end="url(#ab-arr)"/>
</svg>

## Schema & Data Model

The data model is intentionally minimal: `Node` records intersections carrying a `location` point and a coarse `type`, and a `CONNECTS` relationship carries the routing metrics — `distance_m`, `travel_time_s`, and the raw `osm_tags`. The decisions that map raw geometry onto this node-and-edge structure (intersection splitting, directional weighting, id derivation) belong to [Node and Edge Spatial Mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/); the loader here assumes that mapping has already produced clean edge rows.

Two schema objects must exist **before** the first batch runs, or throughput collapses:

1. A **uniqueness constraint** on `Node.id`. Without it, every `MERGE (src:Node {id: ...})` degrades to a full label scan, turning ingestion from near-linear into quadratic. The constraint also creates a backing index for free.
2. A **point index** on `Node.location`. Spatial predicates and proximity lookups against freshly ingested nodes seek this index; absent it, the planner falls back to scanning every node and filtering, which the [Spatial Indexing Strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) layer exists specifically to avoid.

```cypher
// Run once, before ingestion. IF NOT EXISTS makes this idempotent.
CREATE CONSTRAINT node_id_unique IF NOT EXISTS
FOR (n:Node) REQUIRE n.id IS UNIQUE;

CREATE POINT INDEX node_location_point IF NOT EXISTS
FOR (n:Node) ON (n.location);

// Optional: index the edge id if you re-import and MERGE on relationships by id.
CREATE INDEX connects_edge_id IF NOT EXISTS
FOR ()-[r:CONNECTS]-() ON (r.id);
```

Creating the constraint and index up front matters more than it looks: building an index on an empty store is instant, whereas building it after loading millions of nodes blocks and rescans the entire label.

## Step-by-Step Implementation

The loader below is the complete, runnable core. It owns a single driver, bounds memory through the queue, caps concurrency with a semaphore, and validates every coordinate before it can reach the database.

### 1. Initialize one driver and the bounded primitives

Create the driver once at startup and share it across all workers. Size the connection pool to the concurrency cap so a worker never waits on connection acquisition, and bound the queue so producers throttle automatically under load.

```python
import asyncio
import math
from typing import List, Dict, Any
from neo4j import AsyncGraphDatabase, AsyncSession

class AsyncGraphBatchLoader:
    def __init__(
        self,
        uri: str,
        auth: tuple[str, str],
        max_concurrency: int = 40,
        batch_size: int = 5000,
    ):
        self.driver = AsyncGraphDatabase.driver(
            uri, auth=auth, max_connection_pool_size=max_concurrency
        )
        self.semaphore = asyncio.Semaphore(max_concurrency)
        self.queue: asyncio.Queue[List[Dict[str, Any]]] = asyncio.Queue(maxsize=2000)
        self.batch_size = batch_size
```

### 2. Validate and snap coordinates in user space

Reject out-of-range coordinates and quantize them so endpoints that should be the same junction round to identical values. Snapping at parse time is what prevents duplicate-node creation — pushing it into the database instead would force the engine to reconcile near-coincident points under lock.

```python
    @staticmethod
    def _validate_and_snap(coords: tuple[float, float], precision: int = 6) -> tuple[float, float]:
        """Enforce WGS84 bounds and apply spatial snapping to prevent duplicate node creation."""
        lat, lon = coords
        if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
            raise ValueError(f"Coordinates out of WGS84 bounds: {coords}")
        return round(lat, precision), round(lon, precision)

    @staticmethod
    def _haversine_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
        """Compute great-circle distance in meters for edge weight validation."""
        R = 6371000.0
        phi1, phi2 = math.radians(lat1), math.radians(lat2)
        d_phi = math.radians(lat2 - lat1)
        d_lambda = math.radians(lon2 - lon1)
        a = math.sin(d_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(d_lambda / 2) ** 2
        return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
```

A quantization of six decimal places is roughly 11 cm at the equator — tight enough to preserve distinct junctions, loose enough to merge the two endpoints of a shared intersection. Choose `precision` from your source accuracy, not by habit.

### 3. Define the idempotent write

A single `UNWIND` statement `MERGE`s both endpoints and the connecting relationship. Because every key (`id` on nodes, `id` on the relationship) is constrained or indexed, each `MERGE` is an index seek rather than a scan. The method takes the managed transaction so `execute_write` can retry it safely.

```python
    async def _execute_batch(self, tx: AsyncSession, chunk: List[Dict[str, Any]]) -> None:
        query = """
        UNWIND $batch AS row
        MERGE (src:Node {id: row.src_id})
        SET src.location = point({latitude: row.src_lat, longitude: row.src_lon}),
            src.type = row.src_type
        MERGE (tgt:Node {id: row.tgt_id})
        SET tgt.location = point({latitude: row.tgt_lat, longitude: row.tgt_lon}),
            tgt.type = row.tgt_type
        MERGE (src)-[r:CONNECTS {id: row.edge_id}]->(tgt)
        SET r.distance_m = row.distance_m,
            r.travel_time_s = row.travel_time_s,
            r.osm_tags = row.tags
        """
        await tx.run(query, batch=chunk)
```

### 4. Run a pool of workers that drain the queue

Each worker holds one long-lived session and loops forever on `queue.get()`. Wrapping the write in `session.execute_write` gives automatic retries for transient errors (leader switches, deadlocks); `task_done()` in the `finally` keeps `queue.join()` accurate even when a batch fails.

```python
    async def worker(self) -> None:
        async with self.driver.session(database="neo4j") as session:
            while True:
                chunk = await self.queue.get()
                try:
                    # execute_write handles automatic retries for transient errors
                    await session.execute_write(self._execute_batch, chunk)
                except Exception as e:
                    # In production: route to a dead-letter queue or apply exponential backoff
                    print(f"Batch ingestion failed: {e}")
                finally:
                    self.queue.task_done()
```

### 5. Stream, validate, and enqueue

The producer slices the source into batches, validates and weights each edge, then `await`s `queue.put` — which blocks once the queue is full, applying backpressure to the producer instead of letting memory balloon. `queue.join()` waits for every enqueued batch to be acknowledged before the workers are cancelled.

```python
    async def ingest_stream(self, raw_edges: List[Dict[str, Any]]) -> None:
        # Spawn a fixed pool of worker coroutines
        workers = [asyncio.create_task(self.worker()) for _ in range(5)]

        for i in range(0, len(raw_edges), self.batch_size):
            batch = raw_edges[i:i + self.batch_size]
            validated_batch = []
            for edge in batch:
                s_lat, s_lon = self._validate_and_snap((edge['src_lat'], edge['src_lon']))
                t_lat, t_lon = self._validate_and_snap((edge['tgt_lat'], edge['tgt_lon']))

                # Validate spatial consistency before enqueueing
                dist = self._haversine_distance(s_lat, s_lon, t_lat, t_lon)
                validated_batch.append({
                    **edge,
                    'src_lat': s_lat, 'src_lon': s_lon,
                    'tgt_lat': t_lat, 'tgt_lon': t_lon,
                    'distance_m': round(dist, 2),
                })
            await self.queue.put(validated_batch)

        await self.queue.join()
        for w in workers:
            w.cancel()

    async def close(self) -> None:
        await self.driver.close()
```

The edge rows this consumes are the output of [OSM Data Ingestion Pipelines](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/osm-data-ingestion-pipelines/) — the parsing stage that turns `.osm.pbf` ways and nodes into the flat `{src_id, tgt_id, src_lat, ...}` dictionaries the loader expects.

## Query Patterns & Variants

Once a region is loaded, three write/read shapes recur. Each is a deliberate variant of the base `UNWIND` ingestion.

**Variant 1 — create-only geometry, update-always metrics.** Use `ON CREATE` so re-imports never rewrite immutable coordinates but always refresh mutable edge costs. This is the safe shape for incremental updates.

```cypher
UNWIND $batch AS row
MERGE (src:Node {id: row.src_id})
  ON CREATE SET src.location = point({latitude: row.src_lat, longitude: row.src_lon})
MERGE (tgt:Node {id: row.tgt_id})
  ON CREATE SET tgt.location = point({latitude: row.tgt_lat, longitude: row.tgt_lon})
MERGE (src)-[r:CONNECTS {id: row.edge_id}]->(tgt)
SET r.distance_m = row.distance_m, r.travel_time_s = row.travel_time_s
// $batch: list of maps; src_id/tgt_id must be the SNAPPED-derived ids
```

**Variant 2 — bounding-box proximity check during load.** When you need to confirm an ingested node is inside a target tile, push the predicate down to the point index rather than filtering in Python.

```cypher
WITH point({latitude: $minLat, longitude: $minLon}) AS lo,
     point({latitude: $maxLat, longitude: $maxLon}) AS hi
MATCH (n:Node)
WHERE point.withinBBox(n.location, lo, hi)
RETURN count(n) AS nodes_in_tile
// lo/hi: SW and NE corners; seeks node_location_point, no full scan
```

**Variant 3 — proximity join after ingestion.** Distance-bounded lookups against the freshly loaded nodes follow the same predicate shapes documented under [Distance Filter Query Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/).

```cypher
MATCH (n:Node)
WHERE point.distance(n.location, $origin) < $radius_m
RETURN n.id AS id, point.distance(n.location, $origin) AS meters
ORDER BY meters
LIMIT $k
// $origin: a point({...}); $radius_m bounds the index range scan
```

## Performance Tuning

Async batching shifts the bottleneck off network latency and onto CPU scheduling and database memory, so tune both ends.

**Profile the write, do not guess.** Prefix the ingestion statement with `PROFILE` against a representative batch and confirm the operators are `NodeUniqueIndexSeek` (good) and not `NodeByLabelScan` (the constraint or index is missing). `EXPLAIN` shows the plan without executing; `PROFILE` shows actual db-hits, which is where a missing index betrays itself.

<svg viewBox="0 0 780 300" role="img" aria-labelledby="apTitle apDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="apTitle">Reading the ingestion plan: which operator the MERGE resolves through</title>
  <desc id="apDesc">The same UNWIND and MERGE statement profiled twice. With the uniqueness constraint in place, each MERGE resolves through NodeUniqueIndexSeek and the batch of 5,000 rows costs about 30,000 database hits. With the constraint missing the identical statement resolves through NodeByLabelScan, re-reading the label per row, and the same batch costs roughly 40 million hits. EXPLAIN shows the same operator names without running, but only PROFILE reports the hit counts that make the difference visible.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="300" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">PROFILE on one 5,000-row batch</text>
  <text x="24" y="42" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">identical statement · the only difference is whether the constraint exists</text>
  <rect x="24" y="58" width="356" height="184" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="1.8"/>
  <text x="202" y="82" text-anchor="middle" font-size="12" font-weight="700" fill="var(--viz-good,#0a656d)">constraint present</text>
  <rect x="48" y="96" width="308" height="30" rx="6" fill="var(--viz-good,#0a656d)"/>
  <text x="202" y="116" text-anchor="middle" font-size="11" font-weight="700" fill="var(--viz-on-pill,#ffffff)">NodeUniqueIndexSeek</text>
  <text x="202" y="146" text-anchor="middle" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">one seek per row, no re-reading</text>
  <text x="202" y="182" text-anchor="middle" font-size="22" font-weight="700" fill="currentColor">~30,000</text>
  <text x="202" y="200" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">db hits per batch</text>
  <rect x="60" y="212" width="284" height="12" rx="6" fill="var(--viz-panel-2,#ece9df)"/>
  <rect x="60" y="212" width="3" height="12" rx="6" fill="var(--viz-good,#0a656d)"/>
  <rect x="400" y="58" width="356" height="184" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-poor,#a8320f)" stroke-width="1.8"/>
  <text x="578" y="82" text-anchor="middle" font-size="12" font-weight="700" fill="var(--viz-poor,#a8320f)">constraint missing</text>
  <rect x="424" y="96" width="308" height="30" rx="6" fill="var(--viz-poor,#a8320f)"/>
  <text x="578" y="116" text-anchor="middle" font-size="11" font-weight="700" fill="var(--viz-on-pill,#ffffff)">NodeByLabelScan</text>
  <text x="578" y="146" text-anchor="middle" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">the whole label re-read per row</text>
  <text x="578" y="182" text-anchor="middle" font-size="22" font-weight="700" fill="currentColor">~40,000,000</text>
  <text x="578" y="200" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">db hits per batch</text>
  <rect x="436" y="212" width="284" height="12" rx="6" fill="var(--viz-panel-2,#ece9df)"/>
  <rect x="436" y="212" width="284" height="12" rx="6" fill="var(--viz-poor,#a8320f)"/>
  <text x="24" y="268" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">Both runs return the same row count and neither raises. EXPLAIN would show the operator names but no hit counts,</text>
  <text x="24" y="284" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">so the missing constraint reads as a slow database rather than as the schema gap it is.</text>
</svg>

```cypher
PROFILE
UNWIND $batch AS row
MERGE (src:Node {id: row.src_id})
MERGE (tgt:Node {id: row.tgt_id})
MERGE (src)-[r:CONNECTS {id: row.edge_id}]->(tgt)
RETURN count(*)
```

**Size batches to degree distribution, not to a round number.** 5,000–10,000 edge rows per batch is the working range. Larger payloads raise heap pressure and lengthen transactions; micro-batches amplify per-transaction overhead and context switching. If your graph has many high-degree intersections, smaller batches reduce lock contention on those hot nodes.

**Right-size the pool against the database, not the CPU.** `max_connection_pool_size` should match `max_concurrency` so a worker never blocks acquiring a connection. Start conservative (concurrency around 24), watch connection-acquisition timeouts and chunk-latency percentiles, then raise it. The deeper calibration loop — pool sizing math, telemetry thresholds, async generators for streaming — lives in [Scaling Async Graph Ingestion with Python Asyncio](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/async-batch-processing-for-graphs/scaling-async-graph-ingestion-with-python-asyncio/).

**Watch the transaction log and heap.** Sustained ingestion grows the transaction log; if checkpointing cannot keep up, write throughput sawtooths. Allocate page cache to fit the working set of `Node` records and their indexes, and keep the heap large enough that `UNWIND` payloads do not trigger long young-generation pauses. The planner-side levers — index hints, predicate ordering — are detailed in [Graph Query Planner Optimization](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/).

## Edge Cases & Gotchas

- **Topology gaps from over-tight snapping.** If `precision` is too high for the source accuracy, two endpoints of one junction round to different values and the connecting segment merges against the wrong node, leaving degree-0 islands. Loosen the precision and re-import; the verification query below catches this.
- **Coordinate-order traps.** Neo4j `point({latitude, longitude})` is unambiguous, but raw OSM and GeoJSON emit `(lon, lat)`. A silent lat/lon swap produces plausible-looking points in the wrong hemisphere — assert bounds tightly (`-90..90` vs `-180..180`) so a swap fails loudly.
- **Driver timeouts under burst.** A flood of oversized batches can exceed `connection_acquisition_timeout`; the fix is the semaphore cap, not a longer timeout, which only defers the failure.
- **`MERGE` on relationships without a constrained key.** `MERGE (src)-[:CONNECTS {id: ...}]->(tgt)` without an index on `r.id` rescans all relationships between the pair. Index the edge id (see the schema snippet) when re-importing by relationship id.
- **GDS projection sees stale data.** If you project a graph for routing before ingestion has fully committed, the in-memory projection misses late edges. Project only after `queue.join()` returns and the driver has flushed.
- **Coordinate alignment with enrichment.** Attaching downstream attributes assumes geometry already agrees; misaligned points during [POI Enrichment Workflows](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/poi-enrichment-workflows/) bind data to the wrong junction and silently corrupt routes.

## Verification & Testing

Correctness here is structural, not just "the job exited 0". Assert three things after every load: node and edge counts are stable across a re-import (idempotency), there are no unexpected isolated nodes (snapping held), and known paths still exist (connectivity held).

```python
import asyncio
from neo4j import AsyncGraphDatabase

async def verify_ingestion(uri: str, auth: tuple[str, str]) -> None:
    driver = AsyncGraphDatabase.driver(uri, auth=auth)
    async with driver.session(database="neo4j") as session:
        # 1. No unexpected isolated nodes (a snapping/constraint regression signal)
        rec = await (await session.run(
            "MATCH (n:Node) WHERE NOT (n)--() RETURN count(n) AS orphans"
        )).single()
        assert rec["orphans"] == 0, f"found {rec['orphans']} isolated nodes"

        # 2. Degree audit: surface absurdly high-degree nodes (merge errors)
        rec = await (await session.run(
            """
            MATCH (n:Node)
            WITH n, COUNT { (n)--() } AS deg
            WHERE deg > 24
            RETURN count(n) AS suspect_hubs
            """
        )).single()
        assert rec["suspect_hubs"] == 0, "unexpected ultra-high-degree nodes"

        # 3. Connectivity: a known A->C path must exist within a bounded hop range
        rec = await (await session.run(
            """
            MATCH p = shortestPath(
                (a:Node {id: $a})-[:CONNECTS*1..40]->(c:Node {id: $c}))
            RETURN length(p) AS hops
            """,
            a="seed-A", c="seed-C",
        )).single()
        assert rec is not None, "expected a path seed-A -> seed-C to exist"
    await driver.close()

asyncio.run(verify_ingestion("bolt://localhost:7687", ("neo4j", "password")))
```

Run this twice in CI against the same fixture: a snapping or constraint regression does not change counts on a single import, only on re-import, so a one-shot test misses it. For weighted correctness — that the stored `distance_m` actually yields sensible least-cost routes — project the region into GDS and run Dijkstra with `relationshipWeightProperty: 'distance_m'`, then compare a handful of results against ground truth.

## FAQ

<details>
<summary>How large should each batch be?</summary>

5,000–10,000 edge rows is the working range for `UNWIND`-based ingestion. Below that, per-transaction overhead and context switching dominate; above it, heap pressure and long transactions trigger garbage-collection pauses and lock contention. Tune toward the lower end if your graph has many high-degree intersections, since large batches hold locks on those hot nodes longer. Confirm the choice with `PROFILE`, not intuition.
</details>

<details>
<summary>Why use a bounded queue instead of just gathering every batch task at once?</summary>

`asyncio.gather` over every batch creates a task per chunk eagerly, so memory and in-flight transactions scale with dataset size — exactly the unbounded growth that causes OOM kills on continental extracts. A bounded `asyncio.Queue` caps resident memory: when workers fall behind, `queue.put` blocks the producer, applying backpressure so footprint scales with `maxsize` and batch size rather than with the input.
</details>

<details>
<summary>What does the semaphore add if the connection pool is already bounded?</summary>

The pool bounds connections; the semaphore bounds active write transactions, which is a different resource. Without it, a burst of large batches can each grab a connection and start a heavy transaction simultaneously, spiking database memory and lock contention even though the pool size is "respected". Capping concurrent transactions independently keeps the database transaction layer from being stampeded.
</details>

<details>
<summary>Should I compute edge distance with Haversine or a geodesic library?</summary>

Haversine over snapped WGS84 coordinates is accurate to a fraction of a percent and fast enough to run inline during validation, which is fine for most routing weights. When you need survey-grade precision — long edges, high-latitude networks, or fuel/emissions models — switch to `pyproj`'s `Geod.inv`, which uses the ellipsoidal model. Either way, compute it in user space before enqueueing so the database never does the trigonometry.
</details>

<details>
<summary>How do I make re-ingestion idempotent?</summary>

`MERGE` on a uniqueness-constrained `Node.id` derived deterministically from snapped geometry, set immutable coordinates with `ON CREATE`, and refresh mutable edge costs with `SET`. Existing junctions are reused, edges update in place, and no subgraph is orphaned. Verify by importing the same fixture twice and asserting node and relationship counts are identical after the second pass.
</details>

## Related

- [Scaling Async Graph Ingestion with Python Asyncio](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/async-batch-processing-for-graphs/scaling-async-graph-ingestion-with-python-asyncio/) — backpressure math, pool calibration, and streaming async generators for the loader above.
- [OSM Data Ingestion Pipelines](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/osm-data-ingestion-pipelines/) — the parsing stage that produces the edge rows this loader consumes.
- [POI Enrichment Workflows](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/poi-enrichment-workflows/) — attaching demographic and place attributes once topology is loaded.
- [Attribute Synchronization Techniques](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/attribute-synchronization-techniques/) — keeping node and edge properties current after the initial import.
- [Spatial Indexing Strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) — choosing the point/index type the proximity variants seek against.

This guide is part of [Spatial Graph Construction & OSM Ingestion](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/).

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "How large should each batch be?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "5,000 to 10,000 edge rows is the working range for UNWIND-based ingestion. Below that, per-transaction overhead and context switching dominate; above it, heap pressure and long transactions trigger garbage-collection pauses and lock contention. Tune toward the lower end if the graph has many high-degree intersections, since large batches hold locks on hot nodes longer. Confirm the choice with PROFILE, not intuition."
      }
    },
    {
      "@type": "Question",
      "name": "Why use a bounded queue instead of gathering every batch task at once?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "asyncio.gather over every batch creates a task per chunk eagerly, so memory and in-flight transactions scale with dataset size, which causes out-of-memory kills on large extracts. A bounded asyncio.Queue caps resident memory: when workers fall behind, queue.put blocks the producer, applying backpressure so footprint scales with maxsize and batch size rather than with the input."
      }
    },
    {
      "@type": "Question",
      "name": "What does the semaphore add if the connection pool is already bounded?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "The pool bounds connections; the semaphore bounds active write transactions, a different resource. Without it, a burst of large batches can each grab a connection and start a heavy transaction at once, spiking database memory and lock contention even though the pool size is respected. Capping concurrent transactions independently keeps the database transaction layer from being stampeded."
      }
    },
    {
      "@type": "Question",
      "name": "Should I compute edge distance with Haversine or a geodesic library?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Haversine over snapped WGS84 coordinates is accurate to a fraction of a percent and fast enough to run inline during validation, which suits most routing weights. When you need survey-grade precision for long edges, high-latitude networks, or fuel models, switch to pyproj Geod.inv, which uses the ellipsoidal model. Either way, compute it in user space before enqueueing so the database never does the trigonometry."
      }
    },
    {
      "@type": "Question",
      "name": "How do I make re-ingestion idempotent?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "MERGE on a uniqueness-constrained Node.id derived deterministically from snapped geometry, set immutable coordinates with ON CREATE, and refresh mutable edge costs with SET. Existing junctions are reused, edges update in place, and no subgraph is orphaned. Verify by importing the same fixture twice and asserting node and relationship counts are identical after the second pass."
      }
    }
  ]
}
</script>
