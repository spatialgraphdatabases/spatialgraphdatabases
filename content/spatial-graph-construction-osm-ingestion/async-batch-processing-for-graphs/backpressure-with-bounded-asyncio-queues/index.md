---
pageTitle: Backpressure with asyncio Queues
datePublished: 2026-07-14
dateModified: 2026-07-14
---
# Backpressure with Bounded asyncio Queues for Graph Writes

An OpenStreetMap importer that parses features faster than Neo4j can absorb them has exactly two ways to die: it exhausts the connection pool or it exhausts the heap. The symptom is a resident-set graph that climbs steadily through a country-scale run until the process is `OOMKilled`, or a flood of `ConnectionAcquisitionTimeout` errors the moment the writer falls behind. The root cause is the same in both cases — the producer and the consumer are decoupled with no shared limit, so a parser reading a memory-mapped extract at hundreds of thousands of features per second keeps buffering work that the database has not yet accepted. This page resolves it with one runnable pattern: a bounded `asyncio.Queue` sitting between a single fast producer and a fixed pool of Neo4j writer workers, so that when the database slows, `await queue.put()` blocks the producer and the slow tier sets the pace for the whole pipeline. It is the focused mechanism behind the broader techniques in [scaling async graph ingestion with Python asyncio](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/async-batch-processing-for-graphs/scaling-async-graph-ingestion-with-python-asyncio/).

<svg viewBox="0 0 840 320" role="img" aria-labelledby="bqTitle bqDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="bqTitle">A bounded asyncio queue applying backpressure between a fast producer and a pool of Neo4j writer workers</title>
  <desc id="bqDesc">A left-to-right pipeline. A single fast producer parses features and calls queue.put into a bounded asyncio.Queue drawn as six slots, four filled and two empty. When the queue is full, put blocks, shown by a dashed backpressure arrow running from the queue back to the producer so the producer stalls instead of buffering unbounded work. The queue fans out to three writer workers, each of which accumulates a local batch and flushes it with an UNWIND write into a single Neo4j store.</desc>
  <defs>
    <marker id="bq-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
    <marker id="bq-bp" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="var(--accent-coral,#ff6b6b)"/>
    </marker>
  </defs>
  <!-- producer -->
  <rect class="viz-backdrop" x="0" y="0" width="840" height="320" fill="var(--viz-bg,#ffffff)"/>
  <rect x="16" y="126" width="134" height="66" rx="9" fill="var(--surface-2)" stroke="var(--ink-soft)" stroke-width="1.6"/>
  <text x="83" y="152" text-anchor="middle" font-size="13.5" font-weight="700" fill="currentColor">Producer</text>
  <text x="83" y="170" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.78">parse features</text>
  <text x="83" y="184" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.78">fast · single task</text>
  <line x1="150" y1="159" x2="194" y2="159" stroke="currentColor" stroke-width="1.7" marker-end="url(#bq-arrow)"/>
  <!-- bounded queue -->
  <rect x="196" y="108" width="216" height="102" rx="9" fill="var(--accent,#0a656d)" opacity="0.07"/>
  <rect x="196" y="108" width="216" height="102" rx="9" fill="none" stroke="var(--accent,#0a656d)" stroke-width="1.8"/>
  <text x="304" y="128" text-anchor="middle" font-size="12" font-weight="700" fill="var(--accent,#0a656d)">asyncio.Queue(maxsize)</text>
  <g>
    <rect x="212" y="142" width="26" height="26" rx="4" fill="var(--accent,#0a656d)"/>
    <rect x="244" y="142" width="26" height="26" rx="4" fill="var(--accent,#0a656d)"/>
    <rect x="276" y="142" width="26" height="26" rx="4" fill="var(--accent,#0a656d)"/>
    <rect x="308" y="142" width="26" height="26" rx="4" fill="var(--accent,#0a656d)"/>
    <rect x="340" y="142" width="26" height="26" rx="4" fill="none" stroke="var(--accent,#0a656d)" stroke-width="1.4"/>
    <rect x="372" y="142" width="26" height="26" rx="4" fill="none" stroke="var(--accent,#0a656d)" stroke-width="1.4"/>
  </g>
  <text x="304" y="196" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.82">full → await put() blocks</text>
  <!-- fan-out arrows -->
  <line x1="412" y1="150" x2="450" y2="97"  stroke="currentColor" stroke-width="1.7" marker-end="url(#bq-arrow)"/>
  <line x1="412" y1="159" x2="450" y2="159" stroke="currentColor" stroke-width="1.7" marker-end="url(#bq-arrow)"/>
  <line x1="412" y1="168" x2="450" y2="221" stroke="currentColor" stroke-width="1.7" marker-end="url(#bq-arrow)"/>
  <!-- workers -->
  <g>
    <rect x="452" y="74"  width="158" height="46" rx="8" fill="var(--surface-2)" stroke="var(--ink-soft)" stroke-width="1.5"/>
    <text x="531" y="93"  text-anchor="middle" font-size="11.5" font-weight="600" fill="currentColor">writer worker</text>
    <text x="531" y="109" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.78">local batch → flush</text>
    <rect x="452" y="136" width="158" height="46" rx="8" fill="var(--surface-2)" stroke="var(--ink-soft)" stroke-width="1.5"/>
    <text x="531" y="155" text-anchor="middle" font-size="11.5" font-weight="600" fill="currentColor">writer worker</text>
    <text x="531" y="171" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.78">UNWIND $batch</text>
    <rect x="452" y="198" width="158" height="46" rx="8" fill="var(--surface-2)" stroke="var(--ink-soft)" stroke-width="1.5"/>
    <text x="531" y="217" text-anchor="middle" font-size="11.5" font-weight="600" fill="currentColor">writer worker</text>
    <text x="531" y="233" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.78">retry + drain</text>
  </g>
  <text x="531" y="262" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">pool of N consumers</text>
  <!-- worker -> store -->
  <line x1="610" y1="97"  x2="756" y2="150" stroke="currentColor" stroke-width="1.7" marker-end="url(#bq-arrow)"/>
  <line x1="610" y1="159" x2="756" y2="159" stroke="currentColor" stroke-width="1.7" marker-end="url(#bq-arrow)"/>
  <line x1="610" y1="221" x2="756" y2="168" stroke="currentColor" stroke-width="1.7" marker-end="url(#bq-arrow)"/>
  <!-- neo4j store -->
  <g stroke="var(--ink-soft)" stroke-width="1.7" fill="var(--surface-2)">
    <path d="M760 138 a30 9 0 0 1 60 0 v46 a30 9 0 0 1 -60 0 z"/>
    <ellipse cx="790" cy="138" rx="30" ry="9"/>
  </g>
  <text x="790" y="200" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">Neo4j</text>
  <!-- backpressure arrow -->
  <path d="M304 108 C304 60 150 56 90 122" fill="none" stroke="var(--accent-coral,#ff6b6b)" stroke-width="1.8" stroke-dasharray="6 4" marker-end="url(#bq-bp)"/>
  <text x="215" y="40" text-anchor="middle" font-size="11" font-weight="700" fill="var(--accent-coral,#ff6b6b)">backpressure: producer stalls when the queue is full</text>
</svg>

## Prerequisites & Versions

The queue and shutdown mechanics are pure `asyncio`; the write side needs the official async driver and a running Neo4j with a uniqueness constraint so the `MERGE` seeks instead of scans.

| Library | Min version | Install / note |
| --- | --- | --- |
| Python | 3.10+ | `asyncio.Queue`, `asyncio.create_task`, union typing |
| `neo4j` async driver | 5.14 | `pip install "neo4j>=5.14"` |
| Neo4j server | 5.x | `docker run -p7687:7687 -e NEO4J_AUTH=neo4j/password neo4j:5` |

This pattern assumes the base topology already follows sound conventions from [OSM data ingestion pipelines](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/osm-data-ingestion-pipelines/) — features flattened into `source`/`target` rows with coordinates — and that a uniqueness constraint on the node key exists so the writer's `MERGE` is an index seek rather than a full scan.

## Implementation

The module below is self-contained and runnable. One producer coroutine pulls parsed features and pushes them onto a bounded `asyncio.Queue`; a fixed pool of writer workers pulls from the same queue, accumulates a local batch, and flushes it with a batched `UNWIND`. Shutdown is explicit: after the producer finishes, one sentinel per worker is enqueued so every worker flushes its partial batch and exits cleanly — no rows are silently dropped on the way out.

```python
import asyncio
import logging
from typing import Any, AsyncIterator

from neo4j import AsyncDriver, AsyncGraphDatabase
from neo4j.exceptions import ServiceUnavailable, TransientError

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("bounded_ingest")

_SHUTDOWN = object()  # sentinel: one per worker triggers a graceful drain

WRITE_QUERY = """
UNWIND $batch AS row
MERGE (u:Node {id: row.source})
  ON CREATE SET u.location =
    point({srid: 4326, longitude: row.source_lon, latitude: row.source_lat})
MERGE (v:Node {id: row.target})
  ON CREATE SET v.location =
    point({srid: 4326, longitude: row.target_lon, latitude: row.target_lat})
MERGE (u)-[e:ROUTE {kind: row.kind}]->(v)
  SET e.length_m = row.length_m
"""


async def ensure_schema(driver: AsyncDriver) -> None:
    async with driver.session() as session:
        await session.run(
            "CREATE CONSTRAINT node_id IF NOT EXISTS "
            "FOR (n:Node) REQUIRE n.id IS UNIQUE"
        )
        await session.run(
            "CREATE POINT INDEX node_location IF NOT EXISTS "
            "FOR (n:Node) ON (n.location)"
        )


async def writer_worker(
    wid: int, driver: AsyncDriver, queue: "asyncio.Queue[Any]", flush_size: int
) -> None:
    """Drain the queue into a local batch; flush on size or on the shutdown sentinel."""
    batch: list[dict[str, Any]] = []

    async def flush() -> None:
        if not batch:
            return
        for attempt in range(1, 4):
            try:
                async with driver.session() as session:
                    result = await session.run(WRITE_QUERY, batch=batch)
                    await result.consume()
                break
            except (TransientError, ServiceUnavailable) as exc:
                backoff = 0.25 * (2 ** (attempt - 1))
                log.warning("worker %d transient (%d/3): %s", wid, attempt, exc)
                await asyncio.sleep(backoff)
        else:
            log.error("worker %d dropped %d rows after retries", wid, len(batch))
        batch.clear()

    while True:
        item = await queue.get()
        try:
            if item is _SHUTDOWN:
                await flush()  # drain what we hold before exiting
                return
            batch.append(item)
            if len(batch) >= flush_size:
                await flush()
        finally:
            queue.task_done()


async def produce(queue: "asyncio.Queue[Any]", features: AsyncIterator[dict]) -> None:
    """Push features onto the queue; put() blocks when full — this is the backpressure."""
    async for feature in features:
        await queue.put(feature)


async def run_pipeline(
    driver: AsyncDriver,
    features: AsyncIterator[dict],
    *,
    workers: int = 8,
    queue_max: int = 2_000,
    flush_size: int = 500,
) -> None:
    await ensure_schema(driver)
    queue: "asyncio.Queue[Any]" = asyncio.Queue(maxsize=queue_max)
    consumers = [
        asyncio.create_task(writer_worker(i, driver, queue, flush_size))
        for i in range(workers)
    ]
    await produce(queue, features)          # blocks whenever the DB falls behind
    for _ in consumers:                     # one sentinel per worker
        await queue.put(_SHUTDOWN)
    await asyncio.gather(*consumers)        # every worker flushes, then returns
    log.info("pipeline drained cleanly")


async def demo_features(n: int) -> AsyncIterator[dict]:
    """Stand-in parser: yields edge records with flat memory footprint."""
    base_lat, base_lon = 37.7749, -122.4194  # San Francisco
    for i in range(n):
        yield {
            "source": f"n{i}", "target": f"n{i + 1}", "kind": "residential",
            "source_lon": base_lon + i * 1e-4, "source_lat": base_lat + i * 1e-4,
            "target_lon": base_lon + (i + 1) * 1e-4, "target_lat": base_lat + (i + 1) * 1e-4,
            "length_m": 14.2,
        }


async def main() -> None:
    driver = AsyncGraphDatabase.driver(
        "bolt://localhost:7687",
        auth=("neo4j", "password"),
        max_connection_pool_size=16,        # >= worker count, with headroom
        connection_acquisition_timeout=30.0,
    )
    try:
        await run_pipeline(driver, demo_features(50_000), workers=8)
    finally:
        await driver.close()


if __name__ == "__main__":
    asyncio.run(main())
```

## How It Works

The design rests on one property of `asyncio.Queue`: a queue created with `maxsize > 0` makes `await queue.put()` suspend the calling coroutine once the queue is full, and resume it only when a worker calls `queue.get()`. That single suspension is the entire backpressure mechanism, and three details make it production-safe:

- **The bound is the memory ceiling.** With `maxsize=queue_max`, resident memory for buffered work is capped at roughly `queue_max × bytes_per_feature` plus `workers × flush_size` for the in-flight batches — a fixed number that does not grow with the size of the extract. Drop the bound (or use `maxsize=0`) and the producer races ahead unthrottled; that is the classic unbounded-queue out-of-memory failure that this whole pattern exists to prevent.
- **A worker pool decouples parse speed from write speed.** The producer never opens a session. It only enqueues. The `workers` writer coroutines are the only tasks that touch the driver, so the number of concurrent transactions is bounded by the pool size, not by how fast features arrive. Sizing `max_connection_pool_size` at or above the worker count keeps every worker's `session()` acquisition immediate; the pool discipline here is the same one described in the [async batch processing for graphs](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/async-batch-processing-for-graphs/) overview.
- **Sentinel shutdown guarantees the last batch is written.** After `produce` returns, the pipeline enqueues exactly one `_SHUTDOWN` object per worker. Each worker, on receiving its sentinel, calls `flush()` one final time before returning — so a worker holding 300 rows below the `flush_size` threshold still commits them. Ending the run by cancelling tasks instead would discard those partial batches, which is the silent data-loss trap.

Coordinates use Neo4j's `point({longitude, latitude})` convention (WGS84 / EPSG:4326) so the populated `location` property can later be seeked by the [spatial indexing strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) layer rather than scanned.

## Common Failure Patterns

**1. Unbounded queue silently OOMs the importer.** The default `asyncio.Queue()` has `maxsize=0`, meaning unbounded. `put()` never blocks, the producer drains the parser at full speed, and buffered features accumulate until the process is killed — usually deep into a long run, which makes it look intermittent. The fix is to always pass a finite bound and let it throttle:

```python
# WRONG — unbounded: producer outruns the writers, heap grows without limit
queue = asyncio.Queue()
# RIGHT — bounded: put() blocks when full, so the DB paces the producer
queue = asyncio.Queue(maxsize=2_000)
```

**2. Cancelling workers instead of draining loses the tail batch.** Tearing down with `task.cancel()` after the producer finishes interrupts any worker mid-accumulation, and every row below the flush threshold is discarded without error. Enqueue one sentinel per worker and `gather` them so each flushes first:

```python
# WRONG — cancels workers holding un-flushed rows
for c in consumers:
    c.cancel()
# RIGHT — sentinel-driven drain; every worker flushes its partial batch
for _ in consumers:
    await queue.put(_SHUTDOWN)
await asyncio.gather(*consumers)
```

**3. One slow worker stalls the whole pipeline.** With a single worker, or a worker wedged on a query holding a lock, the queue fills, `put()` blocks indefinitely, and throughput collapses to that one worker's rate. Run a pool large enough that a transient slowdown on one worker is absorbed by the others, and keep `connection_acquisition_timeout` finite so a genuinely stuck write fails fast instead of pinning a slot forever. If chunks routinely run slow, the bottleneck is the write plan, not the queue — profile it with the techniques in [optimizing Cypher query plans for spatial data](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/optimizing-cypher-query-plans-for-spatial-data/).

## Performance Notes

The queue depth in steady state follows Little's Law. With a producer arrival rate $\lambda_{p}$ (features per second) and a total consumer service rate $\mu = W / s$ — $W$ workers each taking $s$ seconds to flush one batch of $F$ rows, so $\mu = W \cdot F / s$ features per second — the mean number of buffered items is:

$$L = \lambda_{\text{eff}} \cdot t_{\text{wait}}, \qquad \lambda_{\text{eff}} = \min\!\left(\lambda_{p},\; \frac{W \cdot F}{s}\right)$$

The `min` is the whole point: when $\lambda_{p} > \mu$, the queue saturates at `maxsize`, `put()` blocks, and the effective throughput is clamped to the drain rate $\mu$ rather than the parse rate. The system runs at the speed of its slowest tier — the database — with a flat, predictable memory footprint instead of an OOM.

<svg viewBox="0 0 780 320" role="img" aria-labelledby="blTitle blDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="blTitle">The bound turns an unbounded memory curve into a flat one</title>
  <desc id="blDesc">Buffered features over time for the same parse burst under two queue configurations. With maxsize zero the producer never suspends, so resident buffered work tracks the parse rate and climbs until the process is killed. With maxsize set, buffered work rises to the bound and then stays flat: put suspends, effective throughput clamps to the drain rate, and the run finishes at the speed of the database with a fixed memory footprint.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="320" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Buffered features over a parse burst</text>
  <text x="24" y="42" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">producer rate exceeds drain rate for the first two thirds of the run</text>
  <line x1="96" y1="60" x2="96" y2="252" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <line x1="96" y1="252" x2="736" y2="252" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <text x="34" y="160" font-size="10" font-weight="700" fill="currentColor" transform="rotate(-90 34 160)">buffered</text>
  <text x="416" y="272" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">elapsed</text>
  <line x1="96" y1="196" x2="736" y2="196" stroke="var(--viz-good,#0a656d)" stroke-width="1.4" stroke-dasharray="6 5"/>
  <text x="732" y="190" text-anchor="end" font-size="9.5" font-weight="700" fill="var(--viz-good,#0a656d)">maxsize = queue_max</text>
  <path d="M96 252 L200 196 L320 196 L470 196 L600 214 L700 244 L736 250" fill="none" stroke="var(--viz-good,#0a656d)" stroke-width="2.6"/>
  <path d="M96 252 L200 202 L320 152 L470 106 L600 78 L700 66 L736 62" fill="none" stroke="var(--viz-poor,#a8320f)" stroke-width="2.6" stroke-dasharray="8 5"/>
  <circle cx="736" cy="62" r="5" fill="var(--viz-poor,#a8320f)"/>
  <text x="726" y="52" text-anchor="end" font-size="10" font-weight="700" fill="var(--viz-poor,#a8320f)">OOM kill</text>
  <text x="240" y="184" font-size="9.5" font-weight="700" fill="var(--viz-good,#0a656d)">put() suspends here</text>
  <text x="96" y="296" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">Both runs write the same rows in the same order. Only the bounded one has a memory figure you can plan for.</text>
  <rect x="96" y="306" width="14" height="6" rx="3" fill="var(--viz-good,#0a656d)"/>
  <text x="118" y="312" font-size="10" fill="currentColor">bounded — flat at the ceiling</text>
  <rect x="392" y="306" width="14" height="6" rx="3" fill="var(--viz-poor,#a8320f)"/>
  <text x="414" y="312" font-size="10" fill="currentColor">maxsize=0 — tracks the parse rate</text>
</svg>

Tuning follows from that. Raise `workers` (and `max_connection_pool_size` with it) until $\mu$ stops rising, which is the point where server-side lock contention or index-split cost caps write throughput; past that, more workers only deepen lock queues. Size `flush_size` to amortize round-trip latency — a few hundred to a few thousand rows per `UNWIND` — and size `queue_max` to absorb short parse bursts without letting buffered memory grow unbounded. When you need cold bulk-load throughput rather than continuous ingestion alongside live reads, switch to a server-side import path; the async queue here wins whenever writes must interleave with ongoing [attribute synchronization](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/attribute-synchronization-techniques/).

## Related

- [Scaling async graph ingestion with Python asyncio](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/async-batch-processing-for-graphs/scaling-async-graph-ingestion-with-python-asyncio/)
- [Building automated OSM-to-graph ETL pipelines](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/osm-data-ingestion-pipelines/building-automated-osm-to-graph-etl-pipelines/)
- [Optimizing Cypher query plans for spatial data](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/optimizing-cypher-query-plans-for-spatial-data/)
- [Spatial indexing strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/)

This guide is part of [Async Batch Processing for Graphs](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/async-batch-processing-for-graphs/), within the broader [Spatial Graph Construction & OSM Ingestion](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/) guide.
