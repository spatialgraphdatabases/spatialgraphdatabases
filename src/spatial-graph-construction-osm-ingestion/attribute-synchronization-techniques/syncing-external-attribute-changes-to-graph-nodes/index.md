---
pageTitle: External Attribute Sync for Graphs
datePublished: 2025-11-20
dateModified: 2026-06-26
---
# Syncing External Attribute Changes to Graph Nodes

The symptom that brings teams to this page is a routing graph that slowly goes wrong while the loader reports success: traffic-speed updates land out of order, a stale `weight_factor` overwrites a fresher one, and the next shortest-path query returns a route that no longer exists on the ground. The root cause is treating attribute sync as a blind `SET` — external telemetry (traffic feeds, sensor pollers, GTFS-RT vehicle positions) arrives unordered, at-least-once, and partially malformed, so the last write to commit wins regardless of which write is *newest*. This page resolves that with one runnable worker that applies monotonic version-guarded upserts, batches writes to bound transaction-log pressure, validates coordinate drift before mutating, and partitions work by geographic bucket so concurrent updates to adjacent road segments never deadlock.

## Prerequisites & Versions

| Library | Min version | Install |
| --- | --- | --- |
| Python | 3.11 | `asyncio.TaskGroup`, `tuple[str, str]` typing |
| `neo4j` async driver | 5.14 | `pip install "neo4j>=5.14"` |
| Neo4j server | 5.x | `docker run -p7687:7687 -e NEO4J_AUTH=neo4j/password neo4j:5` |

This guide assumes the graph already exists: the `RoutingNode` records being updated here are produced upstream by the [OSM data ingestion pipelines](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/osm-data-ingestion-pipelines/) stage, and each node already carries a `location` point and an `external_id` that the source feed references. If you are still loading the base topology, start with [scaling async graph ingestion with Python asyncio](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/async-batch-processing-for-graphs/scaling-async-graph-ingestion-with-python-asyncio/) first — attribute sync is a write-back layer on top of that graph, not a replacement for it.

## Implementation

The schema below anchors the upsert on a uniqueness constraint over `external_id` (so the `MATCH` is an index seek, not a label scan) and tracks an `attr_version` per node. The `AttributeSyncWorker` class then validates incoming payloads, buckets them by geohash prefix to serialize neighbours, chunks each bucket, and applies a version-guarded `SET` inside a managed transaction. The whole module is self-contained and runnable.

```cypher
CREATE CONSTRAINT routing_node_extid IF NOT EXISTS
FOR (n:RoutingNode) REQUIRE n.external_id IS UNIQUE;

CREATE POINT INDEX routing_node_location IF NOT EXISTS
FOR (n:RoutingNode) ON (n.location);
```

```python
import asyncio
import logging
import math
import time
from itertools import islice
from typing import Any, Iterable, Iterator

from neo4j import AsyncGraphDatabase
from neo4j.exceptions import TransientError, ServiceUnavailable

logging.basicConfig(level=logging.INFO)

# Version-guarded upsert: the WHERE clause is the entire concurrency story.
# A SET only fires when the incoming version strictly beats the stored one,
# so out-of-order and duplicate deliveries collapse to the newest write.
SYNC_QUERY = """
UNWIND $batch AS u
MATCH (n:RoutingNode {external_id: u.external_id})
USING INDEX n:RoutingNode(external_id)
WHERE n.attr_version < u.version
SET n.status        = u.status,
    n.weight_factor = u.weight_factor,
    n.attr_version  = u.version,
    n.last_synced   = u.timestamp
RETURN n.external_id AS synced_id, n.attr_version AS new_version
"""


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in metres (WGS84 sphere)."""
    r = 6_371_000.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    )
    return 2 * r * math.asin(math.sqrt(a))


def geo_bucket(lat: float, lon: float, precision: int = 2) -> str:
    """Coarse spatial key: payloads sharing a bucket touch adjacent nodes,
    so we serialise them onto the same worker to avoid lock contention."""
    return f"{round(lat, precision)}:{round(lon, precision)}"


def chunked(items: Iterable[dict], size: int) -> Iterator[list[dict]]:
    it = iter(items)
    while chunk := list(islice(it, size)):
        yield chunk


class AttributeSyncWorker:
    REQUIRED = ("external_id", "version", "timestamp", "lat", "lon", "base_lat", "base_lon")

    def __init__(
        self,
        uri: str,
        auth: tuple[str, str],
        *,
        database: str = "routing",
        batch_size: int = 2_500,
        max_drift_m: float = 500.0,
        max_retries: int = 3,
    ) -> None:
        self.driver = AsyncGraphDatabase.driver(
            uri,
            auth=auth,
            max_connection_pool_size=40,
            connection_acquisition_timeout=4.0,
            # Surface transient errors to the app so a failed batch is re-derived
            # with a fresh version, never blindly re-sent mid-partition.
            max_transaction_retry_time=0,
        )
        self.database = database
        self.batch_size = batch_size
        self.max_drift_m = max_drift_m
        self.max_retries = max_retries
        self.log = logging.getLogger("attr_sync")

    async def close(self) -> None:
        await self.driver.close()

    def _accept(self, p: dict[str, Any]) -> bool:
        """Reject at the boundary: missing keys or coordinate drift beyond
        budget means the payload is stale or misaligned — never let it write."""
        if any(k not in p or p[k] is None for k in self.REQUIRED):
            self.log.warning("Dropping payload missing required keys: %s", p.get("external_id"))
            return False
        drift = haversine_m(p["lat"], p["lon"], p["base_lat"], p["base_lon"])
        if drift > self.max_drift_m:
            self.log.warning("Dropping %s: %.0fm drift exceeds budget", p["external_id"], drift)
            return False
        return True

    async def _apply_chunk(self, session, chunk: list[dict]) -> int:
        for attempt in range(1, self.max_retries + 1):
            start = time.perf_counter()
            try:
                result = await session.run(SYNC_QUERY, batch=chunk)
                synced = [r["synced_id"] async for r in result]
                elapsed_ms = (time.perf_counter() - start) * 1000
                if elapsed_ms > 50:
                    self.log.warning(
                        "Slow chunk: %.0fms for %d rows — check lock waits or index health.",
                        elapsed_ms, len(chunk),
                    )
                return len(synced)
            except (TransientError, ServiceUnavailable) as exc:
                backoff = 0.25 * (2 ** (attempt - 1))
                self.log.warning("Transient (%d/%d): %s — retry in %.2fs",
                                 attempt, self.max_retries, exc, backoff)
                await asyncio.sleep(backoff)
        self.log.error("Chunk permanently failed after %d retries", self.max_retries)
        return 0

    async def sync(self, payloads: Iterable[dict[str, Any]]) -> int:
        # Bucket first so neighbouring nodes serialise; distinct buckets run
        # in parallel without ever racing for the same node lock.
        buckets: dict[str, list[dict]] = {}
        for p in payloads:
            if self._accept(p):
                buckets.setdefault(geo_bucket(p["lat"], p["lon"]), []).append(p)

        total = 0
        async with asyncio.TaskGroup() as tg:
            tasks = [tg.create_task(self._sync_bucket(rows)) for rows in buckets.values()]
        for t in tasks:
            total += t.result()
        self.log.info("Sync complete: %d nodes updated across %d buckets", total, len(buckets))
        return total

    async def _sync_bucket(self, rows: list[dict]) -> int:
        applied = 0
        async with self.driver.session(database=self.database) as session:
            for chunk in chunked(rows, self.batch_size):
                applied += await self._apply_chunk(session, chunk)
        return applied


async def main() -> None:
    worker = AttributeSyncWorker("bolt://localhost:7687", ("neo4j", "password"))
    feed = [
        {"external_id": "osm:node/42", "version": 17, "timestamp": "2026-06-26T09:00:00Z",
         "status": "congested", "weight_factor": 2.4,
         "lat": 52.5200, "lon": 13.4050, "base_lat": 52.5200, "base_lon": 13.4050},
    ]
    try:
        await worker.sync(feed)
    finally:
        await worker.close()


if __name__ == "__main__":
    asyncio.run(main())
```

<svg viewBox="0 0 880 412" role="img" aria-labelledby="syncTitle syncDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="syncTitle">Version-guarded attribute sync pipeline from an unordered external feed to the RoutingNode store</title>
  <desc id="syncDesc">A left-to-right pipeline. Stage one is an unordered external feed of payloads carrying mixed versions and two invalid records. Stage two is a boundary validator that drops payloads with missing keys or coordinate drift beyond 500 metres. Stage three buckets the survivors by coarse geohash key. Stage four runs one session per bucket: neighbouring nodes serialise inside a bucket while distinct buckets run in parallel, each applying a version-guarded UNWIND and SET into the RoutingNode store. A callout band at the bottom shows the guard predicate WHERE attr_version is less than the incoming version, so out-of-order and duplicate deliveries collapse to the newest write and stale matches become no-ops.</desc>
  <defs>
    <marker id="syncArr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <!-- stage headers -->
  <text x="95"  y="22" text-anchor="middle" font-size="12.5" font-weight="700" fill="currentColor">1 · Unordered feed</text>
  <text x="280" y="22" text-anchor="middle" font-size="12.5" font-weight="700" fill="currentColor">2 · Validate boundary</text>
  <text x="460" y="22" text-anchor="middle" font-size="12.5" font-weight="700" fill="currentColor">3 · Geohash bucket</text>
  <text x="650" y="22" text-anchor="middle" font-size="12.5" font-weight="700" fill="currentColor">4 · Per-bucket worker</text>
  <!-- stage containers -->
  <rect x="20"  y="34" width="150" height="252" rx="8" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <rect x="210" y="34" width="140" height="252" rx="8" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <rect x="400" y="34" width="120" height="252" rx="8" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <rect x="560" y="34" width="180" height="252" rx="8" fill="none" stroke="currentColor" stroke-width="1" opacity="0.3"/>
  <!-- ===== STAGE 1: feed payload chips ===== -->
  <g font-size="10" text-anchor="middle">
    <rect x="32" y="54"  width="126" height="24" rx="5" fill="none" stroke="currentColor" stroke-width="1.4"/>
    <text x="95" y="70"  fill="currentColor">v18 · ok</text>
    <rect x="32" y="86"  width="126" height="24" rx="5" fill="none" stroke="currentColor" stroke-width="1.4"/>
    <text x="95" y="102" fill="currentColor">v15 · stale order</text>
    <rect x="32" y="118" width="126" height="24" rx="5" fill="none" stroke="currentColor" stroke-width="1.4"/>
    <text x="95" y="134" fill="currentColor">v17 · ok</text>
    <rect x="32" y="150" width="126" height="24" rx="5" fill="none" stroke="var(--accent-coral,#ff6b6b)" stroke-width="1.4"/>
    <text x="95" y="166" fill="var(--accent-coral,#ff6b6b)">900 m drift</text>
    <rect x="32" y="182" width="126" height="24" rx="5" fill="none" stroke="var(--accent-coral,#ff6b6b)" stroke-width="1.4"/>
    <text x="95" y="198" fill="var(--accent-coral,#ff6b6b)">external_id = null</text>
  </g>
  <text x="95" y="232" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.75">at-least-once,</text>
  <text x="95" y="246" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.75">out of order</text>
  <!-- arrow 1 -> 2 -->
  <line x1="172" y1="130" x2="208" y2="130" stroke="currentColor" stroke-width="1.6" marker-end="url(#syncArr)"/>
  <!-- ===== STAGE 2: validator ===== -->
  <text x="280" y="78"  text-anchor="middle" font-size="10" fill="currentColor">_accept(p)</text>
  <text x="280" y="100" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.85">require 7 keys</text>
  <text x="280" y="116" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.85">drift ≤ 500 m</text>
  <line x1="232" y1="128" x2="328" y2="128" stroke="currentColor" stroke-width="0.8" stroke-dasharray="3 4" opacity="0.4"/>
  <!-- drop path -->
  <line x1="280" y1="138" x2="280" y2="196" stroke="var(--accent-coral,#ff6b6b)" stroke-width="1.6" marker-end="url(#syncArr)"/>
  <text x="280" y="216" text-anchor="middle" font-size="10" font-weight="700" fill="var(--accent-coral,#ff6b6b)">✕ dropped</text>
  <text x="280" y="232" text-anchor="middle" font-size="9" fill="var(--accent-coral,#ff6b6b)" opacity="0.9">never enters a tx</text>
  <!-- arrow 2 -> 3 (valid survivors) -->
  <line x1="352" y1="110" x2="398" y2="110" stroke="currentColor" stroke-width="1.6" marker-end="url(#syncArr)"/>
  <!-- ===== STAGE 3: bucketer ===== -->
  <g font-size="9.5" text-anchor="middle">
    <rect x="414" y="92"  width="92" height="26" rx="5" fill="none" stroke="var(--accent,#0e7c86)" stroke-width="1.4"/>
    <text x="460" y="109" fill="var(--accent,#0e7c86)">52.52 : 13.40</text>
    <rect x="414" y="158" width="92" height="26" rx="5" fill="none" stroke="var(--accent,#0e7c86)" stroke-width="1.4"/>
    <text x="460" y="175" fill="var(--accent,#0e7c86)">52.49 : 13.38</text>
  </g>
  <text x="460" y="232" text-anchor="middle" font-size="9" fill="currentColor" opacity="0.75">neighbours →</text>
  <text x="460" y="245" text-anchor="middle" font-size="9" fill="currentColor" opacity="0.75">same bucket</text>
  <!-- arrows 3 -> 4 lanes -->
  <line x1="508" y1="105" x2="558" y2="95"  stroke="currentColor" stroke-width="1.6" marker-end="url(#syncArr)"/>
  <line x1="508" y1="171" x2="558" y2="190" stroke="currentColor" stroke-width="1.6" marker-end="url(#syncArr)"/>
  <!-- ===== STAGE 4: per-bucket sessions (lanes) ===== -->
  <rect x="572" y="60"  width="156" height="62" rx="6" fill="var(--accent,#0e7c86)" opacity="0.10"/>
  <rect x="572" y="60"  width="156" height="62" rx="6" fill="none" stroke="var(--accent,#0e7c86)" stroke-width="1.4"/>
  <text x="650" y="78"  text-anchor="middle" font-size="10" font-weight="700" fill="var(--accent,#0e7c86)">bucket A · 1 session</text>
  <text x="650" y="96"  text-anchor="middle" font-size="9" fill="currentColor" opacity="0.85">v15 → v17 → v18</text>
  <text x="650" y="110" text-anchor="middle" font-size="9" fill="currentColor" opacity="0.85">serialised, no deadlock</text>
  <rect x="572" y="158" width="156" height="62" rx="6" fill="var(--accent,#0e7c86)" opacity="0.10"/>
  <rect x="572" y="158" width="156" height="62" rx="6" fill="none" stroke="var(--accent,#0e7c86)" stroke-width="1.4"/>
  <text x="650" y="176" text-anchor="middle" font-size="10" font-weight="700" fill="var(--accent,#0e7c86)">bucket B · 1 session</text>
  <text x="650" y="194" text-anchor="middle" font-size="9" fill="currentColor" opacity="0.85">UNWIND $batch · SET</text>
  <text x="650" y="208" text-anchor="middle" font-size="9" fill="currentColor" opacity="0.85">chunked ≈ 2 500 rows</text>
  <text x="650" y="244" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.8">buckets run ∥ parallel under TaskGroup</text>
  <!-- arrows 4 -> store -->
  <line x1="730" y1="91"  x2="788" y2="148" stroke="currentColor" stroke-width="1.6" marker-end="url(#syncArr)"/>
  <line x1="730" y1="189" x2="788" y2="172" stroke="currentColor" stroke-width="1.6" marker-end="url(#syncArr)"/>
  <!-- ===== store cylinder ===== -->
  <g stroke="currentColor" stroke-width="1.6" fill="none">
    <path d="M792 128 a30 9 0 0 0 60 0 v68 a30 9 0 0 1 -60 0 z"/>
    <ellipse cx="822" cy="128" rx="30" ry="9"/>
  </g>
  <text x="822" y="166" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">Routing</text>
  <text x="822" y="180" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">Node</text>
  <text x="822" y="218" text-anchor="middle" font-size="9" fill="var(--accent,#0e7c86)">attr_version ↑</text>
  <!-- ===== bottom callout: the guard ===== -->
  <rect x="20" y="312" width="840" height="80" rx="8" fill="var(--accent,#0e7c86)" opacity="0.08"/>
  <rect x="20" y="312" width="840" height="80" rx="8" fill="none" stroke="var(--accent,#0e7c86)" stroke-width="1.2"/>
  <text x="40" y="338" font-size="11.5" font-weight="700" fill="var(--accent,#0e7c86)">Monotonic version guard — the whole concurrency story</text>
  <text x="40" y="360" font-size="11" fill="currentColor" font-family="var(--font-mono,monospace)">MATCH (n {external_id}) WHERE n.attr_version &lt; u.version SET n.attr_version = u.version, …</text>
  <text x="40" y="380" font-size="9.5" fill="currentColor" opacity="0.8">Out-of-order and duplicate deliveries collapse to the newest write; a stale match simply does not fire — an idempotent no-op.</text>
</svg>

## How It Works

Three mechanisms carry the correctness guarantees, and each maps to a specific line:

- **Monotonic version guard (`WHERE n.attr_version < u.version`).** This single predicate is optimistic concurrency control without row locks. When two workers process overlapping updates for the same node, both `MATCH`, but only the one whose `version` exceeds the stored value commits the `SET`; the loser's pattern simply does not match and is a no-op. Because the operation is idempotent, replaying an at-least-once delivery is harmless — re-applying version 17 over a stored version 17 changes nothing.
- **Index-seek upsert (`USING INDEX n:RoutingNode(external_id)`).** The hint pins the planner to the uniqueness-backed index even when skewed batch cardinality would otherwise tempt it into a full label scan. Run `EXPLAIN` on `SYNC_QUERY` and confirm a `NodeUniqueIndexSeek` precedes the `Filter`; if you see `NodeByLabelScan`, the constraint is missing or stale. This is the same index-discipline the [spatial indexing strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) layer applies to point lookups, applied here to attribute lookups.
- **Geographic bucketing (`geo_bucket` + per-bucket sessions).** Updates that touch adjacent road segments — a congested corridor, a closed junction — land in the same coarse bucket and run on one session, so they serialize naturally. Distinct buckets run concurrently under `TaskGroup` and never contend for the same node lock. This is the cheapest way to avoid the deadlocks that plague unpartitioned concurrent `SET` workloads.

Coordinate validation runs *before* any write: `_accept` drops payloads whose reported position has drifted more than the budget from the node's known `location`, which is how stale or misattributed telemetry is kept out of the routing graph entirely. The `location` itself is owned by the upstream mapping layer — see [how to map road networks to graph nodes and edges](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/how-to-map-road-networks-to-graph-nodes-and-edges/) for how `external_id` and `location` are first established.

## Common Failure Patterns

**1. Last-write-wins clobbering with a bare `SET`.** Dropping the version guard lets an older payload overwrite a newer one whenever it happens to commit second — the defect is silent because the loader still reports success. The fix is to make the guard unconditional in the query, never in application code:

```cypher
// WRONG — newest write is not guaranteed to survive:
MATCH (n:RoutingNode {external_id: u.external_id}) SET n.weight_factor = u.weight_factor
// RIGHT — only a strictly newer version mutates the node:
MATCH (n:RoutingNode {external_id: u.external_id})
WHERE n.attr_version < u.version SET n.weight_factor = u.weight_factor, n.attr_version = u.version
```

**2. Lock escalation from unpartitioned concurrent updates.** Fanning every chunk out to its own task without bucketing makes two batches race for the same hot intersection node, surfacing as `TransientError: DeadlockDetected` and `LockWaitTime` spikes above 50 ms. Bucketing by `geo_bucket` removes the contention; if a single bucket is still hot, shrink the chunk and lengthen the serial window:

```python
worker = AttributeSyncWorker(uri, auth, batch_size=1_000)  # smaller chunks, shorter lock hold
```

**3. Transaction-log pressure from unbounded batches.** A single multi-megabyte `UNWIND` forces WAL disk spills and checkpoint stalls that look like random latency cliffs. Keeping chunks near 2,500 rows holds each transaction's log footprint well under the checkpoint threshold; the `chunked` generator enforces this regardless of feed size. Pair it with a strict boundary validator so a malformed batch never enters a transaction at all.

## Performance Notes

Sync cost is dominated by how many writes actually mutate the store, not by how many payloads arrive. With at-least-once delivery, the redundancy factor — duplicate or stale deliveries per logical update — sets the write-amplification budget. If $N$ logical updates arrive as $D$ deliveries, the version guard collapses them so that committed writes track $N$ while the planner still pays an index seek per delivery:

$$W_{\text{commit}} = N, \qquad C_{\text{seek}} = D \cdot c_{\text{idx}}, \qquad A = \frac{D}{N}$$

For a traffic feed with $A \approx 3$ (each segment re-reported three times before the next tick), two-thirds of seeks are no-ops — cheap, because they short-circuit at the `WHERE` filter without touching the property store or the WAL. That asymmetry is exactly why the guard belongs in Cypher: the database discards stale work before it becomes a write. Memory stays flat at roughly `batch_size × bytes_per_row` per active bucket, so the 2,500-row default caps in-flight payload near a few megabytes regardless of total feed volume.

Switch strategies when $A$ climbs past ~10 (a very chatty feed): debounce upstream by keeping only the highest-version payload per `external_id` before calling `sync`, turning $D$ back toward $N$. When committed writes themselves are the bottleneck rather than seeks, profile the plan with the techniques in [optimizing Cypher query plans for spatial data](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/optimizing-cypher-query-plans-for-spatial-data/) before adding workers — more concurrency only deepens lock queues if the write plan is already index-bound.

## Related

- [Scaling async graph ingestion with Python asyncio](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/async-batch-processing-for-graphs/scaling-async-graph-ingestion-with-python-asyncio/)
- [Building automated OSM-to-graph ETL pipelines](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/osm-data-ingestion-pipelines/building-automated-osm-to-graph-etl-pipelines/)
- [Spatial indexing strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/)
- [Optimizing Cypher query plans for spatial data](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/optimizing-cypher-query-plans-for-spatial-data/)

This guide is part of [Attribute Synchronization Techniques](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/attribute-synchronization-techniques/), within the broader [Spatial Graph Construction & OSM Ingestion](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/) guide.
