# POI Enrichment Workflows

A routing graph that knows *where* a point of interest sits but nothing about *what* it is can plan geometry, not decisions. The moment you need to dispatch to "open delivery depots within 5 km" or route around "a venue at capacity", raw OpenStreetMap coordinates are not enough — you need commercial, demographic, and operational attributes bound to the right junction. **POI enrichment workflows** attach those external attributes to already-ingested graph nodes without corrupting topology or stalling concurrent traversals. Get it wrong and the failure is quietly expensive: an attribute snapped to the wrong node, a synchronous enrichment loop that exhausts the connection pool mid-run, or a duplicate write that inflates a routing weight and silently reroutes every vehicle through it. This guide covers the matching mechanism, the schema enrichment requires, a complete runnable async loader, the query and tuning patterns that keep it fast, the failure modes that bite in production, and how to prove the result is correct.

Enrichment is the stage that turns a traversable graph into a decision-ready one, and it sits squarely on top of the ingestion work in [Spatial Graph Construction & OSM Ingestion](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/): it assumes a clean, indexed topology already exists and only ever projects attributes onto verified spatial anchors.

## Prerequisites

Enrichment runs strictly downstream of base network ingestion. Before attaching any payload, the graph must already be loaded, coordinates normalized to WGS84 (EPSG:4326), and the spatial index built — the matching step below seeks that index on every lookup. You also need an async Python toolchain and an HTTP client for the external provider.

| Component | Minimum version | Notes |
| --- | --- | --- |
| Python | 3.10+ | `asyncio.Semaphore` and `TaskGroup` patterns assume 3.10/3.11 |
| Neo4j | 5.x | Point indexes and `point.distance()` in metres require the 5-series engine |
| `neo4j` driver | 5.x | Provides `AsyncGraphDatabase` and `session.execute_write` |
| `aiohttp` | 3.9+ | Async HTTP client for non-blocking provider calls |

```bash
pip install "neo4j>=5.0" "aiohttp>=3.9"
```

Confirm connectivity before the first batch — a misconfigured `uri` or auth tuple surfaces as an enrichment queue that fills and never drains, which is far harder to diagnose than an explicit failure at startup.

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

Enrichment is, at its core, a spatial join followed by an idempotent write. Each external record arrives with a coordinate (or an `osm_id`) and a payload; the job's task is to find the one graph node that record describes and attach the payload to it. The hard part is doing that match cheaply and the write safely, concurrently, against a graph that is simultaneously serving routing queries.

Direct coordinate-to-node joins are computationally hopeless at scale — comparing a target against every node forces a great-circle distance for every candidate, which degrades to O(N) per record. The production pattern is a two-phase match: a coarse latitude/longitude bounding-box pre-filter that the point index can seek, narrowing millions of nodes to a handful, followed by an exact `point.distance()` evaluation only on that survivor set. This is the same predicate shape that the [distance filter query patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/) layer formalizes, applied here as a nearest-anchor lookup.

The write side rests on three properties:

- **Idempotency.** Re-running an enrichment job must not inflate weights, duplicate events, or rewrite immutable geometry. `coalesce()` and `ON CREATE`/`SET` separation make a second pass a no-op where it should be.
- **Decoupling.** External providers impose rate limits, return partial payloads, and drift their schemas. A synchronous loop binds the database transaction rate to the provider's latency; an async pipeline buffers provider I/O and flushes to the graph in bounded batches.
- **Atomicity.** Each batch write is one managed transaction, so a partial failure never leaves a node half-enriched while a routing query reads it.

<svg viewBox="0 0 1000 410" role="img" aria-labelledby="pe-title pe-desc" xmlns="http://www.w3.org/2000/svg">
  <title id="pe-title">POI enrichment data flow: a provider stream feeds a semaphore-capped async fetch and a bounded batch buffer, which match each record through a two-phase spatial lookup before an idempotent upsert lands verified attributes on the POI graph, with failed batches routed to a dead-letter sink.</title>
  <desc id="pe-desc">External provider records flow into an async fetch stage capped by a semaphore, then collect in a bounded batch buffer of at most five hundred records. Each batch enters a two-phase match: a bounding-box pre-filter that the point index can seek narrows millions of nodes to a handful, then an exact point.distance evaluation runs only on those survivors. Matched records pass to an idempotent UNWIND upsert that uses coalesce and a source-version guard so a re-run is a no-op, and the verified attributes land on the POI graph below it. If a batch fails — a provider rate limit, a partial payload, or a write error — it is routed to a dead-letter sink so the stream keeps draining instead of stalling.</desc>
  <style>
    .pe-lbl{font:700 12px var(--font-sans,system-ui,sans-serif);fill:var(--ink-mute,#6b7280);letter-spacing:.05em;text-transform:uppercase;}
    .pe-box{fill:var(--viz-panel,#f4f4f5);stroke:var(--line-strong,#9ca3af);stroke-width:1.5;}
    .pe-feed{fill:var(--surface-2,#f4f4f5);stroke:var(--line-strong,#9ca3af);stroke-width:1.5;}
    .pe-acc{fill:var(--viz-panel,#f4f4f5);stroke:var(--accent,#0e7c86);stroke-width:2.5;}
    .pe-t{font:600 13px var(--font-sans,system-ui,sans-serif);fill:var(--ink,#1f2937);}
    .pe-tc{font:600 13px var(--font-sans,system-ui,sans-serif);fill:var(--accent,#0e7c86);}
    .pe-s{font:10px var(--font-mono,ui-monospace,monospace);fill:var(--ink-mute,#6b7280);}
    .pe-flow{fill:none;stroke:var(--accent,#0e7c86);stroke-width:2.5;}
    .pe-bound{fill:none;stroke:var(--accent,#0e7c86);stroke-width:1.5;stroke-dasharray:5 4;opacity:.8;}
    .pe-drop{fill:none;stroke:var(--accent-coral,#ff6b6b);stroke-width:2;stroke-dasharray:5 3;}
    .pe-dropt{font:italic 11px var(--font-sans,system-ui,sans-serif);fill:var(--accent-coral,#ff6b6b);}
    .pe-cap{font:600 11px var(--font-sans,system-ui,sans-serif);fill:var(--accent,#0e7c86);}
  </style>
  <defs>
    <marker id="pe-arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="var(--accent,#0e7c86)"/>
    </marker>
    <marker id="pe-darr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="var(--accent-coral,#ff6b6b)"/>
    </marker>
  </defs>
  <!-- column labels -->
  <rect class="viz-backdrop" x="0" y="0" width="1000" height="410" fill="var(--viz-bg,#ffffff)"/>
  <text class="pe-lbl" x="99" y="30" text-anchor="middle">External provider</text>
  <text class="pe-lbl" x="480" y="30" text-anchor="middle">Async enrichment pipeline</text>
  <text class="pe-lbl" x="901" y="30" text-anchor="middle">POI graph</text>
  <!-- provider stream -->
  <rect class="pe-feed" x="24" y="140" width="150" height="56" rx="10"/>
  <text class="pe-t" x="99" y="166" text-anchor="middle">Provider stream</text>
  <text class="pe-s" x="99" y="184" text-anchor="middle">coord / osm_id + payload</text>
  <!-- stream -> async fetch -->
  <path class="pe-flow" d="M174 168 H202" marker-end="url(#pe-arr)"/>
  <!-- async fetch (semaphore-capped) -->
  <rect class="pe-acc" x="206" y="140" width="152" height="56" rx="10"/>
  <text class="pe-tc" x="282" y="166" text-anchor="middle">Async fetch</text>
  <text class="pe-s" x="282" y="184" text-anchor="middle">semaphore &#8804; N in-flight</text>
  <!-- async fetch -> batch buffer -->
  <path class="pe-flow" d="M358 168 H386" marker-end="url(#pe-arr)"/>
  <!-- batch buffer -->
  <rect class="pe-box" x="390" y="140" width="140" height="56" rx="10"/>
  <text class="pe-t" x="460" y="166" text-anchor="middle">Batch buffer</text>
  <text class="pe-s" x="460" y="184" text-anchor="middle">bounded, &#8804; 500</text>
  <!-- batch buffer -> two-phase match -->
  <path class="pe-flow" d="M530 168 H558" marker-end="url(#pe-arr)"/>
  <!-- two-phase match container -->
  <rect class="pe-bound" x="562" y="102" width="232" height="134" rx="13"/>
  <text class="pe-cap" x="678" y="120" text-anchor="middle">Two-phase match</text>
  <!-- bbox prefilter -->
  <rect class="pe-box" x="576" y="130" width="204" height="42" rx="9"/>
  <text class="pe-t" x="678" y="150" text-anchor="middle">Bbox pre-filter</text>
  <text class="pe-s" x="678" y="166" text-anchor="middle">point-index seek</text>
  <!-- prefilter -> exact distance -->
  <path class="pe-flow" d="M678 172 V182" marker-end="url(#pe-arr)"/>
  <!-- exact distance -->
  <rect class="pe-box" x="576" y="184" width="204" height="42" rx="9"/>
  <text class="pe-t" x="678" y="204" text-anchor="middle">point.distance &#8804; r</text>
  <text class="pe-s" x="678" y="220" text-anchor="middle">exact, on survivors</text>
  <!-- match -> upsert -->
  <path class="pe-flow" d="M794 168 H822" marker-end="url(#pe-arr)"/>
  <!-- idempotent upsert -->
  <rect class="pe-acc" x="826" y="140" width="150" height="56" rx="10"/>
  <text class="pe-tc" x="901" y="162" text-anchor="middle">Idempotent</text>
  <text class="pe-tc" x="901" y="178" text-anchor="middle">UNWIND upsert</text>
  <text class="pe-s" x="901" y="192" text-anchor="middle">coalesce + version guard</text>
  <!-- upsert -> POI graph -->
  <path class="pe-flow" d="M901 196 V250" marker-end="url(#pe-arr)"/>
  <!-- POI graph -->
  <rect class="pe-box" x="826" y="252" width="150" height="52" rx="10"/>
  <text class="pe-t" x="901" y="276" text-anchor="middle">POI nodes</text>
  <text class="pe-s" x="901" y="294" text-anchor="middle">verified + provenance</text>
  <!-- dead-letter branch -->
  <path class="pe-drop" d="M460 196 C460 250 470 280 488 300" marker-end="url(#pe-darr)"/>
  <text class="pe-dropt" x="300" y="262" text-anchor="middle">429 / partial / write error</text>
  <rect class="pe-box" x="388" y="302" width="204" height="52" rx="10"/>
  <text class="pe-dropt" x="490" y="326" text-anchor="middle">Dead-letter sink</text>
  <text class="pe-s" x="490" y="344" text-anchor="middle">failed batch, stream continues</text>
</svg>

The deeper streaming variant — sub-second demographic deltas, spatial partitioning by H3/S2 cell, and backpressure under high write amplification — is covered in [Enriching POI Data with Real-Time Demographics](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/poi-enrichment-workflows/enriching-poi-data-with-real-time-demographics/); the workflow here is the batch foundation that pattern extends.

## Schema & Data Model

The data model keeps immutable identity separate from mutable, externally sourced attributes. A `POI` node carries its stable spatial identity — `location` (a point), `osm_id`, and a coarse `category` — written once during ingestion. Enrichment only ever touches the mutable layer: `operational_status`, `capacity_metric`, `demographic_index`, and the provenance fields `source_version`, `last_updated_by`, and `last_enriched`. The decisions that produce the node identity in the first place — id derivation, intersection splitting, directional weighting — belong to [Node and Edge Spatial Mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/); the workflow here assumes those nodes already exist.

Two schema objects must exist before the first enrichment batch runs, or the match step collapses to a scan:

1. A **point index** on `POI.location`, which the bounding-box pre-filter seeks. Without it the planner falls back to `NodeByLabelScan`, exactly the cost the [spatial indexing strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) layer exists to eliminate.
2. A **range or uniqueness index** on `POI.osm_id`, so records that carry a stable external id can match by id directly instead of by geometry — faster and immune to coordinate drift.

```cypher
// Run once, before enrichment. IF NOT EXISTS makes this idempotent.
CREATE POINT INDEX poi_location_point IF NOT EXISTS
FOR (p:POI) ON (p.location);

CREATE CONSTRAINT poi_osm_id_unique IF NOT EXISTS
FOR (p:POI) REQUIRE p.osm_id IS UNIQUE;

// Optional: a composite range index speeds category-scoped enrichment passes.
CREATE INDEX poi_category_range IF NOT EXISTS
FOR (p:POI) ON (p.category);
```

Enrichment provenance is best modelled as its own node rather than as ever-growing properties. Linking `(:POI)-[:ENRICHED_BY]->(:EnrichmentEvent)` preserves an audit trail — what was written, from which `source_version`, when — without bloating the primary routing queries that only read the current attribute values on the `POI`.

## Step-by-Step Implementation

The pipeline below is the complete, runnable core. It owns one driver, caps provider concurrency with a semaphore, buffers records into bounded batches, and writes each batch as a single retryable transaction.

### 1. Match a single coordinate to its anchor node

The two-phase match is the heart of enrichment. The bounding box is computed in Cypher from the target point — note the longitude span is divided by `cos(latitude)` to correct for meridian convergence — and only survivors of that index-seekable filter pay the `point.distance()` cost. `point.distance()` returns metres for WGS84 points, so the radius passes through with no manual projection.

```cypher
WITH point({latitude: $lat, longitude: $lon}) AS target_point,
     $lat - 0.0045 AS min_lat, $lat + 0.0045 AS max_lat,
     $lon - (0.0045 / cos(radians($lat))) AS min_lon,
     $lon + (0.0045 / cos(radians($lat))) AS max_lon
MATCH (p:POI)
WHERE p.location.latitude  >= min_lat AND p.location.latitude  <= max_lat
  AND p.location.longitude >= min_lon AND p.location.longitude <= max_lon
  AND p.osm_id IS NOT NULL
WITH p, target_point, point.distance(p.location, target_point) AS dist
WHERE dist <= $radius_meters
ORDER BY dist ASC
LIMIT 1
SET p.last_enriched = datetime(),
    p.operational_status = coalesce($status, p.operational_status),
    p.capacity_metric = $capacity
RETURN p.node_id AS enriched_id, dist AS match_distance
```

The `coalesce($status, p.operational_status)` is deliberate: a provider that omits a field must not blank an existing high-confidence value. The whole statement is one transaction, so a routing query never observes a node mid-write.

### 2. Initialize one driver and the bounded primitives

Create the driver once and share it across the pipeline. Size the pool to the concurrency cap so a worker never blocks on connection acquisition, and bound the buffer so the producer throttles automatically when the provider runs faster than the graph can absorb.

```python
import asyncio
import aiohttp
from dataclasses import dataclass
from typing import AsyncIterator, Dict, Any, List
from neo4j import AsyncGraphDatabase
import logging

logger = logging.getLogger(__name__)

@dataclass
class EnrichmentPayload:
    node_id: str
    lat: float
    lon: float
    external_ref: str

class POIEnricher:
    def __init__(self, uri: str, auth: tuple[str, str], max_concurrency: int = 10):
        self.driver = AsyncGraphDatabase.driver(
            uri, auth=auth, max_connection_pool_size=max_concurrency
        )
        # Caps in-flight provider calls AND active write transactions
        self.semaphore = asyncio.Semaphore(max_concurrency)

    async def close(self) -> None:
        await self.driver.close()
```

### 3. Fetch external attributes without blocking the event loop

The provider call is I/O-bound; running it under `aiohttp` lets the event loop validate and flush other batches while a request is in flight. The semaphore caps parallel requests so a burst never trips the provider's rate limit (`429`) or stampedes the driver pool.

```python
    async def _fetch_attributes(
        self,
        http: aiohttp.ClientSession,
        batch: List[EnrichmentPayload],
        api_url: str,
    ) -> List[Dict[str, Any]]:
        async with self.semaphore:
            async with http.post(api_url, json=[p.__dict__ for p in batch]) as resp:
                resp.raise_for_status()
                return await resp.json()
```

### 4. Define the idempotent batch upsert

A single `UNWIND $records AS rec` turns one round-trip into thousands of row writes against a plan compiled once. Matching by the constrained `node_id` makes each `MATCH` an index seek; `coalesce()` preserves existing values, and the `source_version` guard skips records the graph has already seen.

```python
    @staticmethod
    async def _apply_enrichment_tx(tx, records: List[Dict[str, Any]]):
        cypher = """
        UNWIND $records AS rec
        MATCH (p:POI {node_id: rec.node_id})
        // Skip if this exact source version is already applied (idempotency guard)
        WHERE coalesce(p.source_version, '') <> rec.source_version
        SET p.demographic_index = rec.demographic_index,
            p.operational_status = coalesce(rec.status, p.operational_status),
            p.source_version = rec.source_version,
            p.last_updated_by = rec.provider,
            p.last_enriched = datetime(),
            p.verified = true
        MERGE (p)-[:ENRICHED_BY]->(e:EnrichmentEvent {version: rec.source_version})
          ON CREATE SET e.at = datetime(), e.provider = rec.provider
        RETURN count(p) AS updated_count
        """
        result = await tx.run(cypher, records=records)
        return (await result.single())["updated_count"]
```

### 5. Stream records, buffer into batches, and flush

The producer drains an async source, buffers to `batch_size`, fetches attributes, then writes through `execute_write` — which retries transient errors (leader switches, deadlocks) automatically. A failed batch routes to a dead-letter sink rather than halting the run, so one bad provider response cannot stall the whole pipeline.

```python
    async def run(
        self,
        poi_source: AsyncIterator[EnrichmentPayload],
        api_url: str,
        batch_size: int = 500,
    ) -> None:
        async with self.driver.session(database="neo4j") as session:
            async with aiohttp.ClientSession() as http:
                buffer: List[EnrichmentPayload] = []
                async for poi in poi_source:
                    buffer.append(poi)
                    if len(buffer) >= batch_size:
                        await self._flush(session, http, buffer, api_url)
                        buffer = []
                if buffer:  # final partial batch
                    await self._flush(session, http, buffer, api_url)

    async def _flush(self, session, http, buffer, api_url) -> None:
        try:
            records = await self._fetch_attributes(http, buffer, api_url)
            updated = await session.execute_write(self._apply_enrichment_tx, records)
            logger.info("enriched %d POIs", updated)
        except Exception as exc:
            # Dead-letter the batch; never let one failure stop the stream
            logger.error("batch failed, dead-lettering %d records: %s", len(buffer), exc)
```

The records this consumes are anchored to nodes produced by [OSM Data Ingestion Pipelines](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/osm-data-ingestion-pipelines/); the loader assumes those `node_id`s already exist and only attaches attributes to them.

## Query Patterns & Variants

Three enrichment shapes recur, each a deliberate variant of the base match-and-upsert.

**Variant 1 — match by stable external id (preferred when available).** When a record carries an `osm_id`, skip geometry entirely and seek the uniqueness index. This is immune to coordinate drift and an order of magnitude cheaper than the spatial match.

```cypher
UNWIND $records AS rec
MATCH (p:POI {osm_id: rec.osm_id})
SET p.operational_status = coalesce(rec.status, p.operational_status),
    p.last_enriched = datetime()
RETURN count(p) AS matched
// $records: maps each carrying a stable osm_id; seeks poi_osm_id_unique, no geometry math
```

**Variant 2 — category-scoped spatial enrichment.** When a feed only describes one place type (e.g. fuel stations), add the category predicate so the planner narrows the candidate set on the range index before the distance check.

```cypher
WITH point({latitude: $lat, longitude: $lon}) AS target
MATCH (p:POI)
WHERE p.category = $category
  AND point.distance(p.location, target) <= $radius_m
WITH p, target, point.distance(p.location, target) AS dist
ORDER BY dist ASC LIMIT 1
SET p.capacity_metric = $capacity, p.last_enriched = datetime()
RETURN p.node_id AS id, dist
// $category narrows on poi_category_range; combine with a bbox prefilter on dense graphs
```

**Variant 3 — precedence-aware conflict resolution.** When multiple feeds touch the same node, encode a precedence rank so an operational override is never clobbered by a stale historical baseline.

```cypher
UNWIND $records AS rec
MATCH (p:POI {node_id: rec.node_id})
// Only overwrite when the incoming feed outranks the source already stored
WHERE rec.precedence >= coalesce(p.source_precedence, 0)
SET p.operational_status = rec.status,
    p.source_precedence = rec.precedence,
    p.last_updated_by = rec.provider,
    p.last_enriched = datetime()
RETURN count(p) AS applied
// precedence: operational(3) > commercial(2) > historical(1)
```

## Performance Tuning

Async enrichment shifts the bottleneck off provider latency and onto match cost and write contention, so tune both.

**Profile the match, do not guess.** Prefix the match statement with `PROFILE` against a representative coordinate and confirm the plan emits `NodeIndexSeekByRange` or `NodeIndexSeekByPoint` — not `NodeByLabelScan` or a dominating `Filter`. A scan means the point index, the predicate syntax, or the parameter typing is misaligned. The planner-side levers — index hints, predicate ordering — are detailed in [Graph Query Planner Optimization](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/).

```cypher
PROFILE
MATCH (p:POI)
WHERE p.location.latitude  >= $min_lat AND p.location.latitude  <= $max_lat
  AND p.location.longitude >= $min_lon AND p.location.longitude <= $max_lon
WITH p, point.distance(p.location, point({latitude: $lat, longitude: $lon})) AS d
WHERE d <= $radius_m
RETURN p.node_id ORDER BY d LIMIT 1
```

**Match by id whenever the feed provides one.** Geometry matching is the fallback, not the default. A feed that carries `osm_id` should always take Variant 1; reserve the two-phase spatial match for records that only have coordinates.

**Size batches to the provider and the graph, not a round number.** 250–1,000 records per batch is the working range. The provider's payload limit caps the upper bound; below ~250 the per-transaction overhead dominates. If many records target high-degree hub nodes, smaller batches reduce lock contention on those hot anchors.

**Right-size concurrency against the slower of provider and database.** `max_connection_pool_size` should match the semaphore cap so a worker never waits on a connection. Start conservative (around 8–10), watch for provider `429`s and connection-acquisition timeouts, then raise it. Decouple the read freshness requirement from write throughput: caching enriched attributes in a low-latency key-value layer and refreshing the graph asynchronously trades a bounded staleness window for far lower write contention against live routing queries.

## Edge Cases & Gotchas

- **Attribute bound to the wrong junction.** If enrichment runs against a topology whose coordinates were never reconciled, the nearest-anchor match snaps the payload to a neighbouring node and silently corrupts routing. Geometry must already agree — enrichment never fixes topology, it inherits it.
- **Coordinate-order traps.** Raw provider feeds and GeoJSON emit `(lon, lat)` while Neo4j `point({latitude, longitude})` is the reverse. A silent swap produces plausible points in the wrong hemisphere; assert bounds tightly (`-90..90` vs `-180..180`) so a swap fails loudly rather than mismatching.
- **Longitude span without the latitude correction.** A fixed degree offset for the bounding box over-narrows near the poles and over-widens near the equator. Dividing the longitude span by `cos(latitude)` keeps the box a roughly constant ground distance — omitting it causes missed matches at high latitude.
- **Partial provider payloads overwriting good data.** A `SET p.status = rec.status` blanks the field when the provider omits it. Always wrap externally sourced writes in `coalesce()` so a missing field preserves the existing value.
- **Non-idempotent re-runs inflating weights or duplicating events.** Re-applying the same `source_version` must be a no-op. Guard the write with a version comparison and `MERGE` events on their version key, never `CREATE`.
- **`NaN`/`Inf` coordinates from a malformed feed.** These slip past naive range checks and poison the point index. Validate for finiteness before the match, not after.


<svg viewBox="0 0 780 268" role="img" aria-labelledby="pcTitle pcDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="pcTitle">A partial provider payload is not a request to blank the missing fields</title>
  <desc id="pcDesc">A stored POI carrying a status, a footfall figure and an opening-hours string receives a snapshot that omits status and opening hours. Written with a bare SET, the two absent fields are overwritten with null and the previously good values are gone, with the flush still reporting success. Written through coalesce, the incoming value is used when present and the stored value is kept when it is not, so only footfall changes.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="268" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Absent is not the same as empty</text>
  <text x="24" y="52" font-size="11" font-weight="700" fill="currentColor">stored</text>
  <text x="24" y="72" font-size="11" font-weight="700" fill="currentColor">incoming</text>
  <text x="24" y="112" font-size="11" font-weight="700" fill="var(--viz-poor,#a8320f)">bare SET</text>
  <text x="24" y="152" font-size="11" font-weight="700" fill="var(--viz-good,#0a656d)">coalesce</text>
  <g font-size="10.5" text-anchor="middle">
    <text x="250" y="34" font-weight="700" fill="currentColor">status</text>
    <text x="450" y="34" font-weight="700" fill="currentColor">footfall_7d</text>
    <text x="650" y="34" font-weight="700" fill="currentColor">opening_hours</text>
    <rect x="150" y="40" width="200" height="22" rx="5" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1"/><text x="250" y="55" fill="currentColor">"open"</text>
    <rect x="350" y="40" width="200" height="22" rx="5" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1"/><text x="450" y="55" fill="currentColor">4,120</text>
    <rect x="550" y="40" width="200" height="22" rx="5" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1"/><text x="650" y="55" fill="currentColor">"Mo-Fr 09:00-18:00"</text>
    <rect x="150" y="66" width="200" height="22" rx="5" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1" stroke-dasharray="4 3"/><text x="250" y="81" fill="var(--viz-ink-mute,#565f6d)">not in payload</text>
    <rect x="350" y="66" width="200" height="22" rx="5" fill="var(--accent-3,#5b21b6)"/><text x="450" y="81" font-weight="700" fill="var(--viz-on-pill,#ffffff)">5,308</text>
    <rect x="550" y="66" width="200" height="22" rx="5" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1" stroke-dasharray="4 3"/><text x="650" y="81" fill="var(--viz-ink-mute,#565f6d)">not in payload</text>
    <rect x="150" y="98" width="200" height="22" rx="5" fill="var(--viz-poor,#a8320f)"/><text x="250" y="113" font-weight="700" fill="var(--viz-on-pill,#ffffff)">null</text>
    <rect x="350" y="98" width="200" height="22" rx="5" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1"/><text x="450" y="113" fill="currentColor">5,308</text>
    <rect x="550" y="98" width="200" height="22" rx="5" fill="var(--viz-poor,#a8320f)"/><text x="650" y="113" font-weight="700" fill="var(--viz-on-pill,#ffffff)">null</text>
    <rect x="150" y="138" width="200" height="22" rx="5" fill="var(--viz-good,#0a656d)"/><text x="250" y="153" font-weight="700" fill="var(--viz-on-pill,#ffffff)">"open"</text>
    <rect x="350" y="138" width="200" height="22" rx="5" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1"/><text x="450" y="153" fill="currentColor">5,308</text>
    <rect x="550" y="138" width="200" height="22" rx="5" fill="var(--viz-good,#0a656d)"/><text x="650" y="153" font-weight="700" fill="var(--viz-on-pill,#ffffff)">"Mo-Fr 09:00-18:00"</text>
  </g>
  <text x="24" y="196" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">Both writes commit, both report the same row count, and the difference only surfaces the next time something reads</text>
  <text x="24" y="212" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">the blanked field. Wrapping every externally sourced write in coalesce makes the payload additive by default —</text>
  <text x="24" y="228" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">a provider then has to send an explicit sentinel to clear a field, which is what clearing a field should require.</text>
</svg>

## Verification & Testing

Correctness here is structural, not "the job exited 0". Assert three things after a run: re-running the same feed changes nothing (idempotency), every enriched node carries provenance (auditability), and no node was matched outside its tolerance (spatial correctness).

```python
import asyncio
from neo4j import AsyncGraphDatabase

async def verify_enrichment(uri: str, auth: tuple[str, str], version: str) -> None:
    driver = AsyncGraphDatabase.driver(uri, auth=auth)
    async with driver.session(database="neo4j") as session:
        # 1. Provenance: every enriched node must carry source + timestamp
        rec = await (await session.run(
            """
            MATCH (p:POI) WHERE p.source_version = $version
              AND (p.last_enriched IS NULL OR p.last_updated_by IS NULL)
            RETURN count(p) AS missing_provenance
            """, version=version)).single()
        assert rec["missing_provenance"] == 0, "enriched nodes missing provenance"

        # 2. Auditability: an EnrichmentEvent exists for this version
        rec = await (await session.run(
            "MATCH (e:EnrichmentEvent {version: $version}) RETURN count(e) AS events",
            version=version)).single()
        assert rec["events"] >= 1, "no audit event recorded for this run"

        # 3. Idempotency signal: count nodes at this version before a dry re-run
        rec = await (await session.run(
            "MATCH (p:POI {source_version: $version}) RETURN count(p) AS n",
            version=version)).single()
        print(f"nodes at version {version}: {rec['n']}")
    await driver.close()

asyncio.run(verify_enrichment("bolt://localhost:7687", ("neo4j", "password"), "2026-06-01"))
```

Run the enrichment against the same fixture twice and assert that `updated_count` from `_apply_enrichment_tx` is zero on the second pass — the version guard should make every record a no-op. A non-zero second pass means the idempotency guard is broken. Keeping attributes current after this initial pass is the remit of [Attribute Synchronization Techniques](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/attribute-synchronization-techniques/), which the same provenance fields feed into.

## FAQ

<details>
<summary>Should I match POIs by coordinate or by OSM id?</summary>

Always prefer the `osm_id` (or any stable external id) when the feed provides one. An id match is a single index seek, immune to coordinate drift, and an order of magnitude cheaper than the two-phase spatial match. Reserve the bounding-box-plus-distance match for records that arrive with coordinates only. In practice most pipelines run both: id-matching for feeds that carry one, geometry-matching as the fallback.
</details>

<details>
<summary>Why divide the longitude bounding box by cos(latitude)?</summary>

One degree of longitude shrinks toward the poles as meridians converge, while one degree of latitude is roughly constant. A fixed degree offset therefore makes the box too wide near the equator and too narrow near the poles. Dividing the longitude span by cos(latitude) keeps the box a roughly constant ground distance, so the same radius parameter behaves consistently everywhere and high-latitude matches are not silently missed.
</details>

<details>
<summary>How do I keep re-running an enrichment job from corrupting data?</summary>

Make every write idempotent. Match on a constrained key, guard the SET with a source_version comparison so an already-applied version is a no-op, use coalesce() so a missing field never blanks an existing value, and MERGE audit events on their version key rather than CREATE-ing them. Verify by importing the same feed twice and asserting the second pass updates zero nodes.
</details>

<details>
<summary>What happens when two feeds disagree about the same POI?</summary>

Encode a precedence rank and only overwrite when the incoming feed outranks the source already stored (for example operational > commercial > historical). Store the winning rank in a source_precedence property so the next write can compare against it. This makes conflict resolution deterministic and removes the need for manual reconciliation.
</details>

<details>
<summary>How do I enrich without slowing down live routing queries?</summary>

Decouple read freshness from write throughput. Run enrichment as bounded async batches under a semaphore so writes never stampede the transaction layer, and wrap each batch in a single transaction so routing never reads a half-enriched node. When near-real-time reads are required, cache the enriched attributes in a low-latency key-value layer and refresh the graph asynchronously, accepting a bounded staleness window in exchange for much lower write contention.
</details>

## Related

- [OSM Data Ingestion Pipelines](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/osm-data-ingestion-pipelines/) — the parsing stage that produces the anchored nodes enrichment attaches to.
- [Async Batch Processing for Graphs](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/async-batch-processing-for-graphs/) — the bounded-queue and semaphore patterns the enrichment loader builds on.
- [Attribute Synchronization Techniques](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/attribute-synchronization-techniques/) — keeping node and edge properties current after the initial enrichment pass.
- [Enriching POI Data with Real-Time Demographics](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/poi-enrichment-workflows/enriching-poi-data-with-real-time-demographics/) — the streaming, spatially partitioned extension of this workflow.
- [Reverse-Geocoding POI Nodes to Administrative Boundaries](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/poi-enrichment-workflows/reverse-geocoding-poi-nodes-to-admin-boundaries/) — stamping each POI with its containing admin area via point-in-polygon and a `:WITHIN` hierarchy.
- [Spatial Indexing Strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) — the point index the two-phase match seeks against.

This guide is part of [Spatial Graph Construction & OSM Ingestion](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/).

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "Should I match POIs by coordinate or by OSM id?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Always prefer the osm_id or any stable external id when the feed provides one. An id match is a single index seek, immune to coordinate drift, and an order of magnitude cheaper than the two-phase spatial match. Reserve the bounding-box-plus-distance match for records that arrive with coordinates only. In practice most pipelines run both: id-matching for feeds that carry one, geometry-matching as the fallback."
      }
    },
    {
      "@type": "Question",
      "name": "Why divide the longitude bounding box by cos(latitude)?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "One degree of longitude shrinks toward the poles as meridians converge, while one degree of latitude is roughly constant. A fixed degree offset makes the box too wide near the equator and too narrow near the poles. Dividing the longitude span by cos(latitude) keeps the box a roughly constant ground distance, so the same radius parameter behaves consistently everywhere and high-latitude matches are not silently missed."
      }
    },
    {
      "@type": "Question",
      "name": "How do I keep re-running an enrichment job from corrupting data?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Make every write idempotent. Match on a constrained key, guard the SET with a source_version comparison so an already-applied version is a no-op, use coalesce() so a missing field never blanks an existing value, and MERGE audit events on their version key rather than CREATE-ing them. Verify by importing the same feed twice and asserting the second pass updates zero nodes."
      }
    },
    {
      "@type": "Question",
      "name": "What happens when two feeds disagree about the same POI?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Encode a precedence rank and only overwrite when the incoming feed outranks the source already stored, for example operational over commercial over historical. Store the winning rank in a source_precedence property so the next write can compare against it. This makes conflict resolution deterministic and removes the need for manual reconciliation."
      }
    },
    {
      "@type": "Question",
      "name": "How do I enrich without slowing down live routing queries?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Decouple read freshness from write throughput. Run enrichment as bounded async batches under a semaphore so writes never stampede the transaction layer, and wrap each batch in a single transaction so routing never reads a half-enriched node. When near-real-time reads are required, cache the enriched attributes in a low-latency key-value layer and refresh the graph asynchronously, accepting a bounded staleness window in exchange for much lower write contention."
      }
    }
  ]
}
</script>
