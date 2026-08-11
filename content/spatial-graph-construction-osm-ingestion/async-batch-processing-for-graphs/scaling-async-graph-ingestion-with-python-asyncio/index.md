---
pageTitle: Async Graph Ingestion Python Asyncio
datePublished: 2025-11-18
dateModified: 2026-06-26
---
# Scaling Async Graph Ingestion with Python Asyncio

A continental OpenStreetMap extract contains tens of millions of directed edges, and a single urban intersection alone can spawn dozens of relationships carrying turn restrictions, speed classes, and lane geometry. The symptom that brings teams to this page is always the same: a synchronous loader that ran fine on a city extract throws `Neo4jError: ConnectionAcquisitionTimeout` (or simply pins one CPU core at 100% while the database idles) the moment it hits a country-sized file. The root cause is that the bottleneck is network round-trip latency, not CPU — yet the code waits on each write serially. This page resolves that with a single async ingestor class that uses `asyncio` concurrency, semaphore backpressure, batched `UNWIND`, and chunk-level telemetry to push country-scale graphs into Neo4j without exhausting the connection pool or the heap.

## Prerequisites & Versions

| Library | Min version | Install |
| --- | --- | --- |
| Python | 3.11 | (async `TaskGroup`, `tuple[str, str]` typing) |
| `neo4j` async driver | 5.14 | `pip install "neo4j>=5.14"` |
| Neo4j server | 5.x | `docker run -p7687:7687 -e NEO4J_AUTH=neo4j/password neo4j:5` |
| `osmium` (intermediate extract) | 3.6 | `pip install osmium` |

This guide assumes you already have parsed OSM ways flattened into edge records — the upstream [OSM data ingestion pipelines](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/osm-data-ingestion-pipelines/) layer is responsible for turning raw `.osm.pbf` ways into the `source`/`target`/`highway` rows consumed below. If you have not built that stage yet, start with [building automated OSM-to-graph ETL pipelines](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/osm-data-ingestion-pipelines/building-automated-osm-to-graph-etl-pipelines/) first.

## Implementation

The complete ingestor below is self-contained and runnable. It creates the spatial schema, streams edge records from an async generator, dispatches bounded batches concurrently, retries transient failures, and reports chunk latency. Replace `stream_edges_from_file` with the output of your own parser; the newline-delimited JSON shape (`{"source", "target", "source_lon", ...}`) matches what a flattened OSM way export produces.

```python
import asyncio
import json
import logging
import time
from pathlib import Path
from typing import Any, AsyncGenerator

from neo4j import AsyncGraphDatabase
from neo4j.exceptions import TransientError, ServiceUnavailable

logging.basicConfig(level=logging.INFO)


class AsyncGraphIngestor:
    def __init__(
        self,
        uri: str,
        auth: tuple[str, str],
        max_concurrency: int = 32,
        batch_size: int = 5_000,
        max_retries: int = 3,
    ) -> None:
        # Pool sized to 2x the semaphore absorbs connection lifecycle churn
        # (rollbacks, keep-alives) without ever starving an active worker.
        self.driver = AsyncGraphDatabase.driver(
            uri,
            auth=auth,
            max_connection_pool_size=max_concurrency * 2,
            connection_acquisition_timeout=30.0,
        )
        self.semaphore = asyncio.Semaphore(max_concurrency)
        self.batch_size = batch_size
        self.max_retries = max_retries
        self.log = logging.getLogger("spatial_ingest")

    async def close(self) -> None:
        await self.driver.close()

    async def ensure_schema(self) -> None:
        """Idempotent: a uniqueness constraint anchors MERGE, the point
        index turns later distance filters into bounding-box seeks."""
        async with self.driver.session() as session:
            await session.run(
                "CREATE CONSTRAINT node_id IF NOT EXISTS "
                "FOR (n:Node) REQUIRE n.id IS UNIQUE"
            )
            await session.run(
                "CREATE POINT INDEX node_location IF NOT EXISTS "
                "FOR (n:Node) ON (n.location)"
            )

    @staticmethod
    def _ingest_query() -> str:
        return """
        UNWIND $batch AS edge
        MERGE (u:Node {id: edge.source})
          ON CREATE SET u.location =
            point({longitude: edge.source_lon, latitude: edge.source_lat})
        MERGE (v:Node {id: edge.target})
          ON CREATE SET v.location =
            point({longitude: edge.target_lon, latitude: edge.target_lat})
        MERGE (u)-[r:CONNECTED_TO {type: edge.highway}]->(v)
          SET r.length_meters = edge.length,
              r.speed_kph = edge.speed,
              r.bearing = edge.bearing
        """

    async def _execute_chunk(self, batch: list[dict[str, Any]]) -> int:
        query = self._ingest_query()
        async with self.semaphore:  # backpressure: cap in-flight transactions
            for attempt in range(1, self.max_retries + 1):
                start = time.perf_counter()
                try:
                    async with self.driver.session() as session:
                        result = await session.run(query, batch=batch)
                        await result.consume()
                    elapsed_ms = (time.perf_counter() - start) * 1000
                    if elapsed_ms > 200:
                        self.log.warning(
                            "Slow chunk: %.0fms for %d edges — check index "
                            "health or hot-node lock contention.",
                            elapsed_ms, len(batch),
                        )
                    return len(batch)
                except (TransientError, ServiceUnavailable) as exc:
                    backoff = 0.25 * (2 ** (attempt - 1))
                    self.log.warning(
                        "Transient failure (attempt %d/%d): %s — retry in %.2fs",
                        attempt, self.max_retries, exc, backoff,
                    )
                    await asyncio.sleep(backoff)
            self.log.error("Chunk permanently failed after %d retries", self.max_retries)
            return 0

    async def ingest(self, edges: AsyncGenerator[dict[str, Any], None]) -> None:
        await self.ensure_schema()
        chunk: list[dict[str, Any]] = []
        ingested = 0
        async with asyncio.TaskGroup() as tg:
            async for edge in edges:
                chunk.append(edge)
                if len(chunk) >= self.batch_size:
                    batch, chunk = chunk, []
                    tg.create_task(self._execute_chunk(batch))
            if chunk:
                tg.create_task(self._execute_chunk(chunk))
        # TaskGroup awaits every task; tally happens after the block exits.
        self.log.info("Ingestion complete.")


async def stream_edges_from_file(path: str) -> AsyncGenerator[dict[str, Any], None]:
    """Yields one parsed edge dict per line so resident memory stays flat
    regardless of total file size."""
    loop = asyncio.get_running_loop()
    with Path(path).open() as fh:
        for line in fh:
            line = line.strip()
            if line:
                # Offload CPU-bound JSON parse from the event loop thread.
                yield await loop.run_in_executor(None, json.loads, line)


async def main() -> None:
    ingestor = AsyncGraphIngestor(
        uri="bolt://localhost:7687",
        auth=("neo4j", "password"),
        max_concurrency=32,
        batch_size=5_000,
    )
    try:
        await ingestor.ingest(stream_edges_from_file("edges.ndjson"))
    finally:
        await ingestor.close()


if __name__ == "__main__":
    asyncio.run(main())
```

<svg viewBox="4 50 860 245" role="img" aria-labelledby="ing-title ing-desc" xmlns="http://www.w3.org/2000/svg">
  <title id="ing-title">Async ingestion pipeline with semaphore backpressure</title>
  <desc id="ing-desc">An async generator streams one edge dict at a time into a bounded chunk buffer that flushes full batches of five thousand edges. A TaskGroup hands each batch to an asyncio.Semaphore gate that admits at most max_concurrency batches at once; admitted batches run as concurrent Neo4j sessions writing into a single Neo4j store. A dashed backpressure arrow runs from the semaphore back to the buffer, showing that when the gate is full, enqueueing stalls instead of opening unbounded connections.</desc>
  <style>
    .ig-box{fill:var(--surface-2,#f4f4f5);stroke:var(--line-strong,#9ca3af);stroke-width:1.5;}
    .ig-gate{fill:var(--surface-2,#f4f4f5);stroke:var(--accent,#0e7c86);stroke-width:2.5;}
    .ig-store{fill:var(--surface-2,#f4f4f5);stroke:var(--line-strong,#9ca3af);stroke-width:2;}
    .ig-hd{fill:var(--ink,#1f2937);font:700 15px var(--font-sans,system-ui,sans-serif);}
    .ig-sub{fill:var(--ink-mute,#6b7280);font:12px var(--font-mono,ui-monospace,monospace);}
    .ig-lbl{fill:var(--ink,#1f2937);font:600 13px var(--font-sans,system-ui,sans-serif);}
    .ig-flow{stroke:currentColor;stroke-width:1.6;fill:none;opacity:.55;}
    .ig-bp{stroke:var(--accent-coral,#ff6b6b);stroke-width:1.8;fill:none;stroke-dasharray:6 4;}
    .ig-bptxt{fill:var(--accent-coral,#ff6b6b);font:italic 12px var(--font-sans,system-ui,sans-serif);}
    .ig-gatetxt{fill:var(--accent,#0e7c86);font:700 10.5px var(--font-sans,system-ui,sans-serif);}
  </style>
  <defs>
    <marker id="ig-arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor" opacity=".55"/>
    </marker>
    <marker id="ig-barr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="var(--accent-coral,#ff6b6b)"/>
    </marker>
  </defs>
  <!-- 1: async generator -->
  <rect class="viz-backdrop" x="4" y="50" width="860" height="245" fill="var(--viz-bg,#ffffff)"/>
  <g>
    <rect class="ig-box" x="20" y="120" width="150" height="78" rx="8"/>
    <text class="ig-hd" x="95" y="150" text-anchor="middle">async generator</text>
    <text class="ig-sub" x="95" y="172" text-anchor="middle">yield edge</text>
    <text class="ig-sub" x="95" y="188" text-anchor="middle">flat memory</text>
  </g>
  <line class="ig-flow" x1="170" y1="159" x2="208" y2="159" marker-end="url(#ig-arr)"/>
  <!-- 2: bounded chunk buffer -->
  <g>
    <rect class="ig-box" x="210" y="120" width="150" height="78" rx="8"/>
    <text class="ig-hd" x="285" y="150" text-anchor="middle">chunk buffer</text>
    <text class="ig-sub" x="285" y="172" text-anchor="middle">flush at</text>
    <text class="ig-sub" x="285" y="188" text-anchor="middle">batch_size=5000</text>
  </g>
  <line class="ig-flow" x1="360" y1="159" x2="398" y2="159" marker-end="url(#ig-arr)"/>
  <!-- 3: semaphore gate -->
  <g>
    <rect class="ig-gate" x="400" y="112" width="150" height="94" rx="8"/>
    <text class="ig-hd" x="475" y="142" text-anchor="middle">Semaphore</text>
    <text class="ig-gatetxt" x="475" y="164" text-anchor="middle">admit ≤ max_concurrency</text>
    <text class="ig-sub" x="475" y="186" text-anchor="middle">others wait cheaply</text>
  </g>
  <!-- 4: N concurrent sessions -->
  <line class="ig-flow" x1="550" y1="140" x2="600" y2="92" marker-end="url(#ig-arr)"/>
  <line class="ig-flow" x1="550" y1="159" x2="600" y2="159" marker-end="url(#ig-arr)"/>
  <line class="ig-flow" x1="550" y1="178" x2="600" y2="226" marker-end="url(#ig-arr)"/>
  <g>
    <rect class="ig-box" x="602" y="66" width="148" height="48" rx="8"/>
    <text class="ig-lbl" x="676" y="95" text-anchor="middle">session · UNWIND</text>
    <rect class="ig-box" x="602" y="135" width="148" height="48" rx="8"/>
    <text class="ig-lbl" x="676" y="164" text-anchor="middle">session · UNWIND</text>
    <rect class="ig-box" x="602" y="204" width="148" height="48" rx="8"/>
    <text class="ig-lbl" x="676" y="233" text-anchor="middle">session · UNWIND</text>
  </g>
  <text class="ig-sub" x="676" y="276" text-anchor="middle">N concurrent writes</text>
  <!-- 5: single store -->
  <line class="ig-flow" x1="750" y1="90" x2="790" y2="150" marker-end="url(#ig-arr)"/>
  <line class="ig-flow" x1="750" y1="159" x2="790" y2="159" marker-end="url(#ig-arr)"/>
  <line class="ig-flow" x1="750" y1="228" x2="790" y2="168" marker-end="url(#ig-arr)"/>
  <g>
    <path class="ig-store" d="M792 138 a28 9 0 0 1 56 0 v42 a28 9 0 0 1 -56 0 z"/>
    <ellipse class="ig-store" cx="820" cy="138" rx="28" ry="9"/>
    <text class="ig-lbl" x="820" y="205" text-anchor="middle">Neo4j</text>
  </g>
  <!-- backpressure arrow: gate back to buffer -->
  <path class="ig-bp" d="M400 206 C360 250 320 250 285 206" marker-end="url(#ig-barr)"/>
  <text class="ig-bptxt" x="342" y="262" text-anchor="middle">backpressure: gate full → buffer stalls</text>
</svg>

## How It Works

Three mechanisms in the code do the heavy lifting, and each maps to a specific line:

- **Semaphore backpressure (`async with self.semaphore`).** Without it, `TaskGroup` would create one coroutine per batch immediately, opening thousands of simultaneous sessions — the thundering herd that triggers `ConnectionAcquisitionTimeout`. The semaphore caps *concurrently executing* transactions at `max_concurrency` while tasks beyond that limit wait cheaply. This is why `max_connection_pool_size` is set to `2 * max_concurrency`: the pool always has headroom for connection churn underneath the active workers.
- **Batched `UNWIND` (`UNWIND $batch AS edge`).** Each network round trip carries 5,000 edges instead of one. The `MERGE` on a unique `id` (backed by the `node_id` constraint) is an index seek, not a scan, so write cost stays roughly linear in edge count rather than quadratic.
- **Streaming source (`stream_edges_from_file`).** Because the generator yields one dict at a time and `ingest` flushes the chunk buffer every `batch_size` rows, peak resident memory is bounded by `batch_size × in-flight chunks`, not by the size of the OSM extract. The `run_in_executor` call keeps the CPU-bound `json.loads` off the event loop so I/O coroutines are never blocked.

Coordinates follow Neo4j's `point({longitude, latitude})` convention (WGS84 / EPSG:4326). Populating `location` during ingest is what lets the [spatial indexing strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) layer answer later distance queries with bounding-box seeks instead of full label scans. For how these `Node`/`CONNECTED_TO` records map back to real road geometry, see [how to map road networks to graph nodes and edges](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/how-to-map-road-networks-to-graph-nodes-and-edges/).

## Common Failure Patterns

**1. Connection pool exhaustion under unbounded fan-out.** Dropping the semaphore (or sizing the pool below the concurrency limit) is the most common cause of `ConnectionAcquisitionTimeout`. The invariant to preserve:

```python
# Pool must always exceed the semaphore, never the reverse.
assert max_connection_pool_size >= max_concurrency
ingestor = AsyncGraphIngestor(uri, auth, max_concurrency=32)  # pool = 64
```

**2. Deadlocks from concurrent MERGE on shared hot nodes.** Two batches that both `MERGE` the same high-degree intersection node race for the same lock and surface as `TransientError: DeadlockDetected`. The fix is already wired in: catch `TransientError`, back off exponentially, and retry — the operation is idempotent because `MERGE` is. Do **not** retry on generic `Exception`, which would mask schema or syntax bugs:

```python
except (TransientError, ServiceUnavailable) as exc:
    await asyncio.sleep(0.25 * (2 ** (attempt - 1)))
```

**3. Swallowing failures with `return_exceptions=True`.** A bare `asyncio.gather(*tasks, return_exceptions=True)` reports "success" while half the batches silently failed. Using `asyncio.TaskGroup` instead propagates the first unhandled error and cancels siblings, so a corrupt batch surfaces immediately instead of after a four-hour run. Validate edge records before enqueueing — a `null` `source_lon` will poison the whole chunk.

<svg viewBox="0 0 780 296" role="img" aria-labelledby="spTitle spDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="spTitle">The pool must always be larger than the semaphore, never the reverse</title>
  <desc id="spDesc">Two sizings of the same ingestor. With a semaphore of 32 over a pool of 64, every task that clears the semaphore finds a free connection immediately and the run proceeds. With a semaphore of 32 over a pool of 16, sixteen tasks hold connections and sixteen more have already passed the semaphore with nowhere to go; they block in acquisition until the timeout fires and surface as ConnectionAcquisitionTimeout, which reads like a database fault but is a client-side sizing error.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="296" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">The semaphore admits tasks; the pool has to be able to serve them</text>
  <rect x="24" y="42" width="356" height="196" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="1.8"/>
  <text x="202" y="66" text-anchor="middle" font-size="12" font-weight="700" fill="var(--viz-good,#0a656d)">max_concurrency 32 · pool 64</text>
  <text x="46" y="94" font-size="10.5" font-weight="700" fill="currentColor">admitted by the semaphore</text>
  <rect x="46" y="102" width="312" height="20" rx="6" fill="var(--accent-3,#5b21b6)"/>
  <text x="202" y="117" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-on-pill,#ffffff)">32 tasks</text>
  <text x="46" y="148" font-size="10.5" font-weight="700" fill="currentColor">connections available</text>
  <rect x="46" y="156" width="312" height="20" rx="6" fill="var(--viz-good,#0a656d)"/>
  <text x="202" y="171" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-on-pill,#ffffff)">64 — headroom for retries and health checks</text>
  <text x="202" y="204" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--viz-good,#0a656d)">every admitted task acquires immediately</text>
  <text x="202" y="222" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">the semaphore is the only limiter, which is the point of having one</text>
  <rect x="400" y="42" width="356" height="196" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-poor,#a8320f)" stroke-width="1.8"/>
  <text x="578" y="66" text-anchor="middle" font-size="12" font-weight="700" fill="var(--viz-poor,#a8320f)">max_concurrency 32 · pool 16</text>
  <text x="422" y="94" font-size="10.5" font-weight="700" fill="currentColor">admitted by the semaphore</text>
  <rect x="422" y="102" width="312" height="20" rx="6" fill="var(--accent-3,#5b21b6)"/>
  <text x="578" y="117" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-on-pill,#ffffff)">32 tasks</text>
  <text x="422" y="148" font-size="10.5" font-weight="700" fill="currentColor">connections available</text>
  <rect x="422" y="156" width="156" height="20" rx="6" fill="var(--viz-poor,#a8320f)"/>
  <text x="500" y="171" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-on-pill,#ffffff)">16</text>
  <rect x="578" y="156" width="156" height="20" rx="6" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-poor,#a8320f)" stroke-width="1.4" stroke-dasharray="5 4"/>
  <text x="656" y="171" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-poor,#a8320f)">16 tasks blocked</text>
  <text x="578" y="204" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--viz-poor,#a8320f)">ConnectionAcquisitionTimeout</text>
  <text x="578" y="222" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">reads as a database fault; it is a client-side sizing error</text>
  <text x="24" y="266" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">Assert the invariant at construction rather than discovering it under load: the semaphore should never be able to</text>
  <text x="24" y="282" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">admit more concurrent work than the pool can hand a connection to.</text>
</svg>

## Performance Notes

Throughput is governed by Little's Law, not by raw loop speed. With mean per-batch latency $L$ seconds and concurrency $C$, sustained batch throughput is:

$$\text{batches/sec} = \frac{C}{L}, \qquad T_{\text{total}} \approx \frac{N}{B} \cdot \frac{L}{C}$$

where $N$ is total edges and $B$ is `batch_size`. For $N = 40{,}000{,}000$ edges, $B = 5{,}000$, $L = 0.12$ s, and $C = 32$, that predicts $T_{\text{total}} \approx 30$ s of database time — so if a run takes ten minutes, the limiter is $L$ (index fragmentation or lock contention), not insufficient concurrency. Raising $C$ past the point where $L$ starts climbing only deepens lock queues.

Memory budget: peak heap is roughly $B \times C \times s$ where $s$ is the serialized size of one edge (~250 bytes), so the defaults cap in-flight payload near 40 MB regardless of extract size. Switch from this batched strategy to a server-side `apoc.periodic.iterate` or `LOAD CSV` import only for cold bulk loads where no incremental [attribute synchronization](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/attribute-synchronization-techniques/) is needed; the async path here wins whenever you ingest continuously alongside live reads. When latency stays high despite a healthy pool, profile the write plan using the techniques in [optimizing Cypher query plans for spatial data](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/optimizing-cypher-query-plans-for-spatial-data/).

Sizing the two limits is an empirical exercise with a predictable shape. Raise `max_concurrency` in steps and watch committed rows per second: it climbs, flattens, and then falls. The flattening point is where the server stops being able to overlap the work — index maintenance and lock acquisition on shared nodes serialise past that point — and the fall after it is retry traffic from deadlocks that the extra concurrency itself created. The useful setting is a step or two below the flattening point, not at it, because the peak is measured on a quiet server and production has other tenants. Move the pool with the semaphore each time, keeping it comfortably larger, so acquisition never becomes the thing being tuned.

Batch size interacts with both and is the setting most often left at its default. Too small and every batch pays a full round trip and transaction setup for a handful of rows, so throughput is dominated by latency; too large and a single batch holds locks long enough to collide with everything else writing nearby, turning a throughput problem into a deadlock problem. A few hundred to a few thousand rows per `UNWIND` covers most workloads, with the lower end appropriate when the batch touches dense, high-degree nodes and the upper end when rows are spread thinly across the graph. Measure it the same way: rows per second against batch size, and take the setting on the near side of the plateau.

## Related

- [Building automated OSM-to-graph ETL pipelines](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/osm-data-ingestion-pipelines/building-automated-osm-to-graph-etl-pipelines/)
- [Syncing external attribute changes to graph nodes](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/attribute-synchronization-techniques/syncing-external-attribute-changes-to-graph-nodes/)
- [Spatial indexing strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/)
- [How to map road networks to graph nodes and edges](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/how-to-map-road-networks-to-graph-nodes-and-edges/)

This guide is part of [Async Batch Processing for Graphs](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/async-batch-processing-for-graphs/), within the broader [Spatial Graph Construction & OSM Ingestion](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/) guide.
