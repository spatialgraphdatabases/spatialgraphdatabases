---
pageTitle: Real-Time Demographic POI Enrichment
datePublished: 2025-11-12
dateModified: 2026-06-26
---
# Enriching POI Data with Real-Time Demographics

The symptom that brings teams here is a routing graph whose pathfinding latency creeps from sub-100ms into the high hundreds the moment a live demographics feed is wired in. Foot-traffic vectors, mobility heatmaps, and census microdata arrive at sub-second intervals, and the obvious fix — a `MATCH ... SET` per payload — quietly blocks every concurrent Dijkstra or A\* traversal on the hottest nodes in the graph. The root cause is lock contention: transit hubs, commercial intersections, and logistics waypoints carry the most edges *and* attract the most demographic updates, so write locks and read traversals collide on exactly the same vertices. This page resolves that by decoupling stream ingestion from graph mutation with one runnable async enricher that buffers writes by spatial partition, flushes them as version-guarded `UNWIND` batches, validates coordinates before any write, and bounds concurrency so the transaction manager never stalls active routing queries.

## Prerequisites & Versions

| Library | Min version | Install |
| --- | --- | --- |
| Python | 3.11 | `asyncio.TaskGroup`, `tuple[str, str]` typing |
| `neo4j` async driver | 5.14 | `pip install "neo4j>=5.14"` |
| `h3` | 4.1 | `pip install "h3>=4.1"` |
| Neo4j server | 5.x | `docker run -p7687:7687 -e NEO4J_AUTH=neo4j/password neo4j:5` |

This guide assumes the `POI` nodes being enriched already exist with a `location` point and a stable `id`. Those anchors are produced upstream by the [OSM data ingestion pipelines](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/osm-data-ingestion-pipelines/) stage and loaded with the throughput patterns in [scaling async graph ingestion with Python asyncio](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/async-batch-processing-for-graphs/scaling-async-graph-ingestion-with-python-asyncio/). Demographic enrichment is a write-back layer on top of that topology — never enrich coordinates that have no matching node, or you will mint phantom POIs that corrupt routing.

## Implementation

The architecture routes every demographic payload through an async consumer that buckets writes by H3 cell, so geographically co-located POIs flush together and adjacent updates serialize instead of deadlocking. Each partition fills an in-memory buffer until it crosses `batch_size` or a `flush_interval` timer fires, then commits one `UNWIND` sweep guarded by a monotonic version so out-of-order deliveries can never overwrite fresher data. A semaphore caps concurrent flushes to keep the transaction manager off its knees.

<svg viewBox="0 0 980 452" role="img" aria-labelledby="pe-title pe-desc" xmlns="http://www.w3.org/2000/svg">
  <title id="pe-title">Stream-to-graph enrichment pipeline: telemetry buffered by H3 cell, then version-guarded UNWIND upsert</title>
  <desc id="pe-desc">A left-to-right data flow in five stages. Stage one is the inbound demographic telemetry stream carrying latitude, longitude, a payload and a version, delivered unordered and at-least-once. Stage two validates the coordinates with validate_wgs84 — rejecting out-of-range values so no phantom cell is created — then resolves them to an H3 resolution-7 cell of about five square kilometres. Stage three fans co-located updates into per-cell ring buffers, one partition per hexagon. Stage four is flush control: a partition flushes when it reaches batch_size or its flush_interval timer fires, and a semaphore bounds how many flushes run at once. Stage five issues one version-guarded UNWIND upsert, where a stale version becomes a no-op under optimistic concurrency control, writing p.demographics, p.last_enriched and p.enrichment_version into the POI graph.</desc>
  <style>
    .pe-hd{font:700 14px var(--font-sans,system-ui,sans-serif);fill:var(--ink,#1f2937);}
    .pe-box{fill:var(--surface-1,#ffffff);stroke:var(--accent,#0e7c86);stroke-width:2;}
    .pe-box2{fill:var(--surface-2,#f4f4f5);stroke:var(--line-strong,#9ca3af);stroke-width:1.5;}
    .pe-buf{fill:var(--surface-2,#f4f4f5);stroke:var(--accent,#0e7c86);stroke-width:2;}
    .pe-t{font:700 13px var(--font-sans,system-ui,sans-serif);fill:var(--ink,#1f2937);}
    .pe-ta{font:700 13px var(--font-sans,system-ui,sans-serif);fill:var(--accent,#0e7c86);}
    .pe-s{font:11px var(--font-mono,ui-monospace,monospace);fill:var(--ink-mute,#6b7280);}
    .pe-edge{fill:none;stroke:var(--accent,#0e7c86);stroke-width:2.5;}
    .pe-flow{fill:none;stroke:currentColor;stroke-width:2;opacity:.5;}
    .pe-div{stroke:var(--line-strong,#9ca3af);stroke-width:1;opacity:.7;}
    .pe-note{font:italic 12px var(--font-sans,system-ui,sans-serif);fill:var(--accent-coral,#ff6b6b);}
    .pe-db{fill:var(--surface-1,#ffffff);stroke:var(--accent,#0e7c86);stroke-width:2.5;}
  </style>
  <defs>
    <marker id="pe-arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="var(--accent,#0e7c86)"/>
    </marker>
    <marker id="pe-farr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor" opacity=".55"/>
    </marker>
  </defs>
  <!-- column headers -->
  <text class="pe-hd" x="94"  y="40" text-anchor="middle">Stream in</text>
  <text class="pe-hd" x="271" y="40" text-anchor="middle">Resolve</text>
  <text class="pe-hd" x="449" y="40" text-anchor="middle">Partition buffers</text>
  <text class="pe-hd" x="635" y="40" text-anchor="middle">Flush control</text>
  <text class="pe-hd" x="870" y="40" text-anchor="middle">Upsert &#8594; graph</text>
  <!-- A: telemetry -->
  <rect class="pe-box" x="24" y="178" width="140" height="120" rx="10"/>
  <text class="pe-t" x="94" y="210" text-anchor="middle">Telemetry</text>
  <text class="pe-s" x="94" y="230" text-anchor="middle">(lat, lon, payload)</text>
  <text class="pe-s" x="94" y="248" text-anchor="middle">+ version</text>
  <text class="pe-note" x="94" y="270" text-anchor="middle">unordered</text>
  <text class="pe-note" x="94" y="286" text-anchor="middle">at-least-once</text>
  <!-- B: resolve -->
  <rect class="pe-box2" x="196" y="150" width="150" height="58" rx="9"/>
  <text class="pe-s" x="271" y="184" text-anchor="middle">validate_wgs84</text>
  <rect class="pe-box" x="196" y="222" width="150" height="72" rx="9"/>
  <text class="pe-t" x="271" y="252" text-anchor="middle">H3 cell</text>
  <text class="pe-s" x="271" y="272" text-anchor="middle">res 7 &#8776; 5 km&#178;</text>
  <text class="pe-note" x="271" y="322" text-anchor="middle">reject out-of-range</text>
  <text class="pe-note" x="271" y="338" text-anchor="middle">&#8594; no phantom cell</text>
  <!-- C: buffers -->
  <rect class="pe-buf" x="378" y="92"  width="142" height="66" rx="9"/>
  <text class="pe-t" x="449" y="120" text-anchor="middle">Partition A</text>
  <text class="pe-s" x="449" y="140" text-anchor="middle">ring buffer</text>
  <rect class="pe-buf" x="378" y="190" width="142" height="66" rx="9"/>
  <text class="pe-t" x="449" y="218" text-anchor="middle">Partition B</text>
  <text class="pe-s" x="449" y="238" text-anchor="middle">ring buffer</text>
  <rect class="pe-buf" x="378" y="288" width="142" height="66" rx="9"/>
  <text class="pe-t" x="449" y="316" text-anchor="middle">Partition C</text>
  <text class="pe-s" x="449" y="336" text-anchor="middle">ring buffer</text>
  <!-- D: flush control -->
  <rect class="pe-box2" x="552" y="190" width="166" height="112" rx="10"/>
  <text class="pe-t" x="635" y="216" text-anchor="middle">Flush trigger</text>
  <text class="pe-s" x="635" y="234" text-anchor="middle">size &#8805; batch_size</text>
  <text class="pe-s" x="635" y="250" text-anchor="middle">or flush_interval</text>
  <line class="pe-div" x1="566" y1="262" x2="704" y2="262"/>
  <text class="pe-t" x="635" y="282" text-anchor="middle">Semaphore</text>
  <text class="pe-s" x="635" y="298" text-anchor="middle">bounded concurrency</text>
  <!-- E: upsert + graph -->
  <rect class="pe-box" x="786" y="150" width="168" height="70" rx="10"/>
  <text class="pe-t" x="870" y="180" text-anchor="middle">UNWIND upsert</text>
  <text class="pe-s" x="870" y="200" text-anchor="middle">version-guarded &#183; OCC</text>
  <text class="pe-note" x="862" y="246" text-anchor="end">stale version &#8594; no-op</text>
  <!-- POI graph cylinder -->
  <path class="pe-db" d="M820 270 a50 12 0 0 0 100 0 v98 a50 12 0 0 1 -100 0 z"/>
  <ellipse class="pe-db" cx="870" cy="270" rx="50" ry="12"/>
  <text class="pe-ta" x="870" y="330" text-anchor="middle">POI graph</text>
  <text class="pe-s" x="870" y="400" text-anchor="middle">p.demographics</text>
  <text class="pe-s" x="870" y="416" text-anchor="middle">p.last_enriched</text>
  <text class="pe-s" x="870" y="432" text-anchor="middle">p.enrichment_version</text>
  <!-- flow arrows -->
  <path class="pe-edge" d="M164 212 C 180 198 184 186 196 180" marker-end="url(#pe-arr)"/>
  <line class="pe-edge" x1="271" y1="208" x2="271" y2="222" marker-end="url(#pe-arr)"/>
  <path class="pe-flow" d="M346 248 C 362 200 364 150 378 128" marker-end="url(#pe-farr)"/>
  <path class="pe-flow" d="M346 256 C 364 240 360 232 378 224" marker-end="url(#pe-farr)"/>
  <path class="pe-flow" d="M346 266 C 362 300 364 340 378 318" marker-end="url(#pe-farr)"/>
  <path class="pe-flow" d="M520 125 C 536 160 540 200 552 226" marker-end="url(#pe-farr)"/>
  <path class="pe-flow" d="M520 223 C 536 232 540 236 552 240" marker-end="url(#pe-farr)"/>
  <path class="pe-flow" d="M520 321 C 536 290 540 254 552 254" marker-end="url(#pe-farr)"/>
  <path class="pe-edge" d="M718 232 C 744 210 762 195 786 187" marker-end="url(#pe-arr)"/>
  <line class="pe-edge" x1="870" y1="220" x2="870" y2="256" marker-end="url(#pe-arr)"/>
</svg>

The upsert anchors on a uniqueness constraint over `id` so the `MATCH` is an index seek, not a label scan, and a `POINT INDEX` keeps the spatial property usable by downstream routing. Create both before running the worker:

```cypher
CREATE CONSTRAINT poi_id_unique IF NOT EXISTS
FOR (p:POI) REQUIRE p.id IS UNIQUE;

CREATE POINT INDEX poi_location IF NOT EXISTS
FOR (p:POI) ON (p.location);
```

```python
import asyncio
import logging
from collections import defaultdict
from datetime import datetime, timezone

import h3
from neo4j import AsyncGraphDatabase
from neo4j.exceptions import TransientError, ServiceUnavailable

logging.basicConfig(level=logging.INFO)

# The WHERE clause is the whole concurrency story: a SET only fires when the
# incoming snapshot strictly beats the stored one, so out-of-order and
# at-least-once deliveries collapse to the newest demographic snapshot.
UPSERT_QUERY = """
UNWIND $batch AS rec
MATCH (p:POI {id: rec.poi_id})
WHERE coalesce(p.enrichment_version, 0) < rec.version
SET p.demographics      = rec.demographics,
    p.last_enriched     = rec.ts,
    p.enrichment_version = rec.version
RETURN count(p) AS applied
"""


def validate_wgs84(lat: float, lon: float) -> bool:
    """Reject malformed coordinates before H3 resolution: out-of-range inputs
    yield silent cell collisions or raise h3.H3FailedError."""
    return -90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0


class DemographicEnricher:
    def __init__(
        self,
        uri: str,
        auth: tuple[str, str],
        *,
        database: str = "routing",
        h3_resolution: int = 7,
        batch_size: int = 1_000,
        flush_interval: float = 5.0,
        max_concurrency: int = 10,
        max_retries: int = 3,
    ) -> None:
        self.driver = AsyncGraphDatabase.driver(
            uri,
            auth=auth,
            max_connection_pool_size=50,
            connection_acquisition_timeout=3.0,
            # Re-derive failed batches with a fresh version rather than blindly
            # letting the driver replay a half-applied transaction.
            max_transaction_retry_time=0,
        )
        self.database = database
        self.h3_resolution = h3_resolution
        self.batch_size = batch_size
        self.flush_interval = flush_interval
        self.max_retries = max_retries
        self.buffer: dict[str, list[dict]] = defaultdict(list)
        self._semaphore = asyncio.Semaphore(max_concurrency)
        self._flush_tasks: dict[str, asyncio.Task] = {}
        self.log = logging.getLogger("enricher")

    async def close(self) -> None:
        await self.driver.close()

    def _partition(self, lat: float, lon: float) -> str:
        """WGS84 -> H3 hexagon id used as a deterministic sharding key."""
        return h3.latlng_to_cell(lat, lon, self.h3_resolution)

    async def ingest(self, poi_id: str, lat: float, lon: float,
                     demographics: dict, version: int) -> None:
        if not validate_wgs84(lat, lon):
            self.log.warning("Dropping %s: invalid coordinates (%s, %s)", poi_id, lat, lon)
            return
        cell = self._partition(lat, lon)
        self.buffer[cell].append({
            "poi_id": poi_id,
            "demographics": demographics,
            "version": version,
            "ts": datetime.now(timezone.utc).isoformat(),
        })
        if len(self.buffer[cell]) >= self.batch_size:
            await self._flush(cell)
        elif cell not in self._flush_tasks:
            self._flush_tasks[cell] = asyncio.create_task(self._delayed_flush(cell))

    async def _delayed_flush(self, cell: str) -> None:
        await asyncio.sleep(self.flush_interval)
        await self._flush(cell)

    async def _flush(self, cell: str) -> None:
        async with self._semaphore:
            batch = self.buffer.pop(cell, [])
            self._flush_tasks.pop(cell, None)
            if not batch:
                return
            for attempt in range(1, self.max_retries + 1):
                try:
                    async with self.driver.session(database=self.database) as session:
                        result = await session.run(UPSERT_QUERY, batch=batch)
                        summary = await result.single()
                    self.log.info("Cell %s: %d/%d rows applied",
                                  cell, summary["applied"], len(batch))
                    return
                except (TransientError, ServiceUnavailable) as exc:
                    backoff = 0.25 * (2 ** (attempt - 1))
                    self.log.warning("Cell %s transient (%d/%d): %s — retry in %.2fs",
                                     cell, attempt, self.max_retries, exc, backoff)
                    await asyncio.sleep(backoff)
            # Requeue once exhausted so the next flush cycle re-attempts.
            self.log.error("Cell %s failed after %d retries — requeueing", cell, self.max_retries)
            self.buffer[cell].extend(batch)


async def main() -> None:
    enricher = DemographicEnricher("bolt://localhost:7687", ("neo4j", "password"))
    feed = [
        ("osm:node/42", 52.5200, 13.4050, {"foot_traffic": 0.82, "median_age": 34}, 7),
        ("osm:node/91", 52.5210, 13.4061, {"foot_traffic": 0.41, "median_age": 51}, 3),
    ]
    try:
        for poi_id, lat, lon, demo, ver in feed:
            await enricher.ingest(poi_id, lat, lon, demo, ver)
        # Drain any buffers that never reached batch_size.
        await asyncio.gather(*(enricher._flush(c) for c in list(enricher.buffer)))
    finally:
        await enricher.close()


if __name__ == "__main__":
    asyncio.run(main())
```

## How It Works

Three mechanisms carry the guarantees, and each maps to a specific line:

- **`UNWIND` batch upsert.** The Cypher turns a Python list into a relational row stream, so the planner runs one transactional sweep instead of N discrete writes. That collapses N lock-acquire/release cycles into one, which is what keeps demographic writes from monopolising the high-degree nodes that pathfinding also needs.
- **Monotonic version guard (`WHERE coalesce(p.enrichment_version, 0) < rec.version`).** This is optimistic concurrency control without explicit locks. Mobility streams are unordered and at-least-once; the guard means a stale snapshot simply does not match and becomes a no-op, while the `RETURN count(p)` tells you how many rows actually mutated. Routing services can read `enrichment_version` to detect a stale snapshot without taking a read lock.
- **H3 partitioning (`_partition` + per-cell buffers).** Bucketing by hexagon serialises co-located updates onto the same flush while distinct cells run concurrently under the semaphore. This is the cheapest defence against the deadlocks that plague unpartitioned concurrent `SET` workloads — the same index-and-locality discipline the [spatial indexing strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) layer applies to point lookups, here applied to write fan-out.

Coordinate validation runs *before* the partition is computed: `validate_wgs84` rejects out-of-range latitude/longitude so a malformed payload can never produce a colliding cell or raise inside `h3.latlng_to_cell`. The `location` point itself is owned upstream — see [building automated OSM-to-graph ETL pipelines](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/osm-data-ingestion-pipelines/building-automated-osm-to-graph-etl-pipelines/) for how `id` and `location` are first established.

## Common Failure Patterns

**1. Last-write-wins clobbering with a bare `SET`.** Dropping the version guard lets an older mobility snapshot overwrite a newer one whenever it commits second — silent, because the flush still reports success. Keep the guard in the query, never in application code:

```cypher
// WRONG — newest snapshot is not guaranteed to survive:
MATCH (p:POI {id: rec.poi_id}) SET p.demographics = rec.demographics
// RIGHT — only a strictly newer version mutates the node:
MATCH (p:POI {id: rec.poi_id})
WHERE coalesce(p.enrichment_version, 0) < rec.version
SET p.demographics = rec.demographics, p.enrichment_version = rec.version
```

**2. `NodeByLabelScan` during flush windows.** Without the uniqueness constraint the planner resolves `MATCH (p:POI {id: ...})` with a full label scan that scales linearly with graph cardinality and spikes CPU exactly when a batch lands. Confirm the plan before trusting throughput — you want a `NodeUniqueIndexSeek`, not a scan:

```cypher
EXPLAIN
UNWIND [{poi_id: "osm:node/42", demographics: {foot_traffic: 0.82}, version: 7, ts: "2026-06-26T10:00:00Z"}] AS rec
MATCH (p:POI {id: rec.poi_id})
WHERE coalesce(p.enrichment_version, 0) < rec.version
SET p.demographics = rec.demographics, p.enrichment_version = rec.version
```

**3. Partition skew at high H3 resolution.** Resolution 8–9 cells are tiny, so rural feeds scatter into many near-empty buffers that flush on the timer instead of by size — multiplying transaction count and WAL pressure. Resolution 7 (~5 km²) keeps buffers dense enough to amortise commit overhead; only raise it where the feed is genuinely dense:

```python
enricher = DemographicEnricher(uri, auth, h3_resolution=7, batch_size=1_000)
```

## Performance Notes

Flush cost is dominated by how many rows actually mutate the store, not by how many payloads arrive. With at-least-once delivery the redundancy factor — duplicate or stale deliveries per logical update — sets the write-amplification budget. If $N$ logical updates arrive as $D$ deliveries, the version guard collapses committed writes toward $N$ while the planner still pays an index seek per delivery:

$$W_{\text{commit}} = N, \qquad C_{\text{seek}} = D \cdot c_{\text{idx}}, \qquad A = \frac{D}{N}$$

For a mobility feed with $A \approx 3$ (each POI re-reported three times per tick), two-thirds of seeks short-circuit at the `WHERE` filter without touching the property store or WAL. In-memory cost is bounded by `batch_size × bytes_per_row` per active cell, so the 1,000-row default holds in-flight payload to a few megabytes regardless of total feed volume. Watch three signals to hold routing SLAs: `dbms.lock.wait.time` (sustained waits >50ms mean flushes are colliding with active traversals), checkpoint latency (rising WAL volume forces ingestion throttling), and pool saturation (`ConnectionAcquisitionTimeout` silently drops payloads).

Switch strategies when $A$ climbs past ~10: debounce upstream by keeping only the highest-version payload per `id` before calling `ingest`, pushing $D$ back toward $N$. When committed writes — not seeks — are the bottleneck, profile the plan with the techniques in [optimizing Cypher query plans for spatial data](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/optimizing-cypher-query-plans-for-spatial-data/) before adding workers; more concurrency only deepens lock queues if the write plan is already index-bound.

## Related

- [Syncing external attribute changes to graph nodes](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/attribute-synchronization-techniques/syncing-external-attribute-changes-to-graph-nodes/)
- [Scaling async graph ingestion with Python asyncio](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/async-batch-processing-for-graphs/scaling-async-graph-ingestion-with-python-asyncio/)
- [Building automated OSM-to-graph ETL pipelines](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/osm-data-ingestion-pipelines/building-automated-osm-to-graph-etl-pipelines/)
- [Spatial indexing strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/)

This guide is part of [POI Enrichment Workflows](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/poi-enrichment-workflows/), within the broader [Spatial Graph Construction & OSM Ingestion](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/) guide.
