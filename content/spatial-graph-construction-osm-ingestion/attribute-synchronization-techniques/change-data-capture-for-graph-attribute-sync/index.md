---
pageTitle: CDC for Graph Attribute Sync
datePublished: 2026-07-14
dateModified: 2026-07-14
---
# Change Data Capture for Graph Attribute Sync

The symptom that brings teams to this page is a routing graph that quietly diverges from its system of record: a point of interest that closed weeks ago still resolves as an active waypoint, a category correction never lands, and a full re-import — the usual sledgehammer fix — takes hours and thrashes the page cache every night. The root cause is treating the upstream database as something you periodically re-read in full, when what you actually have is a stream of changes. A change-data-capture (CDC) feed emits an ordered log of inserts, updates, and deletes with a monotonic sequence number per row, and applying only those deltas is orders of magnitude cheaper than re-scanning the source. The trap is that CDC delivery is at-least-once and only ordered *per key*, so a naive consumer replays stale events over fresh ones and never handles deletes. This page resolves that with one runnable async consumer that applies CDC deltas idempotently: a version-guarded `MERGE`/`SET` for upserts, a tombstone for deletes, and per-key deduplication so out-of-order redelivery collapses to the correct terminal state. It is the event-log counterpart to the general write-back approach in [syncing external attribute changes to graph nodes](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/attribute-synchronization-techniques/syncing-external-attribute-changes-to-graph-nodes/).

<svg viewBox="0 0 860 340" role="img" aria-labelledby="cdcTitle cdcDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="cdcTitle">A change-data-capture pipeline applying version-guarded deltas from a source database to a spatial graph</title>
  <desc id="cdcDesc">A left-to-right pipeline. A source database emits change events into a CDC log ordered by log sequence number, shown as four chips carrying operations: an update at version five, a delete at version six, a stale update at version three, and a create at version seven. The consumer deduplicates to the highest version per key and applies each delta with a version guard. Updates and creates go to a version-guarded MERGE and SET; deletes become a tombstone that marks the node deleted rather than removing it. The result lands in a PoiNode graph whose cdc_version only ever increases. A callout band at the bottom states the guard predicate.</desc>
  <defs>
    <marker id="cdc-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <!-- source db -->
  <rect class="viz-backdrop" x="0" y="0" width="860" height="340" fill="var(--viz-bg,#ffffff)"/>
  <g stroke="var(--ink-soft)" stroke-width="1.7" fill="var(--surface-2)">
    <path d="M26 66 a28 9 0 0 1 56 0 v54 a28 9 0 0 1 -56 0 z"/>
    <ellipse cx="54" cy="66" rx="28" ry="9"/>
  </g>
  <text x="54" y="140" text-anchor="middle" font-size="11.5" font-weight="700" fill="currentColor">Source DB</text>
  <text x="54" y="156" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.75">system of record</text>
  <line x1="86" y1="92" x2="146" y2="92" stroke="currentColor" stroke-width="1.7" marker-end="url(#cdc-arrow)"/>
  <!-- cdc log -->
  <rect x="148" y="46" width="252" height="120" rx="9" fill="var(--accent,#0a656d)" opacity="0.06"/>
  <rect x="148" y="46" width="252" height="120" rx="9" fill="none" stroke="var(--accent,#0a656d)" stroke-width="1.7"/>
  <text x="274" y="66" text-anchor="middle" font-size="12" font-weight="700" fill="var(--accent,#0a656d)">CDC log · ordered by LSN</text>
  <g font-size="10.5" text-anchor="middle">
    <rect x="164" y="78"  width="106" height="24" rx="5" fill="none" stroke="currentColor" stroke-width="1.3"/>
    <text x="217" y="94"  fill="currentColor">v5 · update</text>
    <rect x="278" y="78"  width="106" height="24" rx="5" fill="none" stroke="var(--accent-2,#a8380b)" stroke-width="1.3"/>
    <text x="331" y="94"  fill="var(--accent-2,#a8380b)">v6 · delete</text>
    <rect x="164" y="110" width="106" height="24" rx="5" fill="none" stroke="currentColor" stroke-width="1.3" opacity="0.5"/>
    <text x="217" y="126" fill="currentColor" opacity="0.6">v3 · stale</text>
    <rect x="278" y="110" width="106" height="24" rx="5" fill="none" stroke="currentColor" stroke-width="1.3"/>
    <text x="331" y="126" fill="currentColor">v7 · create</text>
  </g>
  <text x="274" y="154" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.75">at-least-once · ordered per key</text>
  <line x1="400" y1="106" x2="440" y2="106" stroke="currentColor" stroke-width="1.7" marker-end="url(#cdc-arrow)"/>
  <!-- consumer -->
  <rect x="442" y="52" width="184" height="108" rx="9" fill="var(--surface-2)" stroke="var(--accent-3,#5b21b6)" stroke-width="1.8"/>
  <text x="534" y="76" text-anchor="middle" font-size="12.5" font-weight="700" fill="var(--accent-3,#5b21b6)">CDC consumer</text>
  <text x="534" y="98" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.85">dedupe → latest / key</text>
  <text x="534" y="116" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.85">version-guarded MERGE</text>
  <text x="534" y="134" text-anchor="middle" font-size="10" fill="var(--accent-2,#a8380b)" opacity="0.9">delete → tombstone</text>
  <text x="534" y="152" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">commit offset after write</text>
  <line x1="626" y1="106" x2="672" y2="106" stroke="currentColor" stroke-width="1.7" marker-end="url(#cdc-arrow)"/>
  <!-- graph store -->
  <g stroke="var(--ink-soft)" stroke-width="1.7" fill="var(--surface-2)">
    <path d="M690 80 a30 9 0 0 1 60 0 v52 a30 9 0 0 1 -60 0 z"/>
    <ellipse cx="720" cy="80" rx="30" ry="9"/>
  </g>
  <text x="720" y="152" text-anchor="middle" font-size="11.5" font-weight="700" fill="currentColor">PoiNode graph</text>
  <text x="720" y="168" text-anchor="middle" font-size="9.5" fill="var(--accent,#0a656d)">cdc_version ↑ only</text>
  <!-- bottom callout -->
  <rect x="20" y="238" width="820" height="86" rx="9" fill="var(--accent,#0a656d)" opacity="0.07"/>
  <rect x="20" y="238" width="820" height="86" rx="9" fill="none" stroke="var(--accent,#0a656d)" stroke-width="1.2"/>
  <text x="40" y="264" font-size="11.5" font-weight="700" fill="var(--accent,#0a656d)">Monotonic version guard — idempotency for at-least-once delivery</text>
  <text x="40" y="288" font-size="11" font-family="var(--font-mono,monospace)" fill="currentColor">MERGE (n {external_id}) WHERE ev.version &gt; n.cdc_version SET n += ev.after, n.cdc_version = ev.version</text>
  <text x="40" y="310" font-size="9.5" fill="currentColor" opacity="0.8">A stale or duplicate delta simply fails the guard and is a no-op; a delete bumps the version and sets a tombstone instead of erasing the row.</text>
</svg>

## Prerequisites & Versions

The consumer is transport-agnostic — it reads `CDCEvent` records from any async source (Kafka with Debezium, Neo4j's own CDC feed, a polled outbox table). Only the async driver and a uniqueness constraint on the business key are required.

| Library | Min version | Install / note |
| --- | --- | --- |
| Python | 3.10+ | `dataclass`, `asyncio`, union typing |
| `neo4j` async driver | 5.14 | `pip install "neo4j>=5.14"` |
| Neo4j server | 5.x | `docker run -p7687:7687 -e NEO4J_AUTH=neo4j/password neo4j:5` |

This layer assumes the `PoiNode` records already exist with a stable `external_id` and a `location`, established upstream by the [OSM data ingestion pipelines](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/osm-data-ingestion-pipelines/) stage. CDC is a delta write-back on top of that graph; if you are still loading the base topology, build that first.

## Implementation

Two Cypher statements do the mutation: a version-guarded upsert for creates and updates, and a version-guarded tombstone for deletes. Both `MERGE` on `external_id` so the match is an index seek, seed a sentinel `cdc_version` of `-1` on first sight, and only mutate when the incoming version strictly exceeds the stored one. The `CDCApplier` reads events from an async stream, deduplicates each batch to the highest version per key, applies upserts and deletes, then commits the source offset — in that order — so an at-least-once redelivery re-runs harmlessly.

```python
import asyncio
import logging
from dataclasses import dataclass
from typing import Any, AsyncIterator, Awaitable, Callable

from neo4j import AsyncGraphDatabase

logging.basicConfig(level=logging.INFO)

UPSERT = """
UNWIND $events AS ev
MERGE (n:PoiNode {external_id: ev.key})
  ON CREATE SET n.cdc_version = -1
WITH n, ev
WHERE ev.version > n.cdc_version
SET n.name        = ev.after.name,
    n.category    = ev.after.category,
    n.location     = point({srid: 4326, longitude: ev.after.lon, latitude: ev.after.lat}),
    n.deleted     = false,
    n.cdc_version = ev.version
"""

TOMBSTONE = """
UNWIND $events AS ev
MERGE (n:PoiNode {external_id: ev.key})
  ON CREATE SET n.cdc_version = -1
WITH n, ev
WHERE ev.version > n.cdc_version
SET n.deleted = true, n.cdc_version = ev.version
"""


@dataclass
class CDCEvent:
    key: str                 # business key (external_id) — CDC orders per key
    version: int             # monotonic log sequence number from the source
    op: str                  # "c" (create), "u" (update), or "d" (delete)
    after: dict[str, Any] | None
    offset: int              # position in the CDC log, committed after apply


class CDCApplier:
    def __init__(
        self,
        uri: str,
        auth: tuple[str, str],
        *,
        database: str = "neo4j",
        batch_size: int = 1_000,
    ) -> None:
        self.driver = AsyncGraphDatabase.driver(
            uri, auth=auth,
            max_connection_pool_size=20,
            connection_acquisition_timeout=10.0,
        )
        self.database = database
        self.batch_size = batch_size
        self.log = logging.getLogger("cdc")

    async def close(self) -> None:
        await self.driver.close()

    async def ensure_schema(self) -> None:
        async with self.driver.session(database=self.database) as s:
            await s.run(
                "CREATE CONSTRAINT poi_extid IF NOT EXISTS "
                "FOR (n:PoiNode) REQUIRE n.external_id IS UNIQUE"
            )
            await s.run(
                "CREATE POINT INDEX poi_location IF NOT EXISTS "
                "FOR (n:PoiNode) ON (n.location)"
            )

    @staticmethod
    def _dedupe_latest(events: list[CDCEvent]) -> list[CDCEvent]:
        """Collapse each key to its highest-version event so one batch commits
        the correct terminal state regardless of intra-batch delivery order."""
        latest: dict[str, CDCEvent] = {}
        for ev in events:
            cur = latest.get(ev.key)
            if cur is None or ev.version > cur.version:
                latest[ev.key] = ev
        return list(latest.values())

    async def _apply_batch(self, events: list[CDCEvent]) -> None:
        events = self._dedupe_latest(events)
        upserts = [
            {"key": e.key, "version": e.version, "after": e.after}
            for e in events if e.op in ("c", "u") and e.after is not None
        ]
        deletes = [{"key": e.key, "version": e.version} for e in events if e.op == "d"]
        async with self.driver.session(database=self.database) as s:
            if upserts:
                await (await s.run(UPSERT, events=upserts)).consume()
            if deletes:
                await (await s.run(TOMBSTONE, events=deletes)).consume()

    async def run(
        self,
        stream: AsyncIterator[CDCEvent],
        commit_offset: Callable[[int], Awaitable[None]],
    ) -> None:
        await self.ensure_schema()
        buffer: list[CDCEvent] = []
        last_offset = -1
        async for ev in stream:
            buffer.append(ev)
            last_offset = ev.offset
            if len(buffer) >= self.batch_size:
                await self._apply_batch(buffer)
                await commit_offset(last_offset)  # commit only after the write is durable
                buffer.clear()
        if buffer:
            await self._apply_batch(buffer)
            await commit_offset(last_offset)
        self.log.info("CDC stream drained; last committed offset %d", last_offset)


async def demo_stream() -> AsyncIterator[CDCEvent]:
    """Stand-in for a Kafka/Debezium consumer. Note the out-of-order v3 and the delete."""
    lon, lat = -87.6298, 41.8781  # Chicago
    events = [
        CDCEvent("poi:1001", 5, "u", {"name": "Depot A", "category": "hub", "lon": lon, "lat": lat}, 5),
        CDCEvent("poi:1002", 7, "c", {"name": "Kiosk 7", "category": "retail", "lon": lon + 0.01, "lat": lat}, 6),
        CDCEvent("poi:1001", 3, "u", {"name": "OLD NAME", "category": "hub", "lon": lon, "lat": lat}, 7),
        CDCEvent("poi:1002", 9, "d", None, 8),
    ]
    for ev in events:
        yield ev


async def main() -> None:
    applier = CDCApplier("bolt://localhost:7687", ("neo4j", "password"))
    committed = {"offset": -1}

    async def commit_offset(offset: int) -> None:
        committed["offset"] = offset  # in production: commit to Kafka / checkpoint store

    try:
        await applier.run(demo_stream(), commit_offset)
    finally:
        await applier.close()
    print(f"last committed offset: {committed['offset']}")


if __name__ == "__main__":
    asyncio.run(main())
```

## How It Works

Three mechanics make the consumer correct under at-least-once, per-key-ordered delivery, and each maps to a specific line:

- **The monotonic version guard (`WHERE ev.version > n.cdc_version`).** This is optimistic concurrency without locks. Every event carries the source log sequence number in `version`; the `SET` fires only when that number strictly beats the stored `cdc_version`. A redelivered or reordered event with an older version matches the node but fails the guard and does nothing — an idempotent no-op. Replaying the same offset after a crash therefore cannot corrupt state, which is what lets the consumer commit offsets safely and resume from the last checkpoint. The guard shape mirrors the one detailed in [syncing external attribute changes to graph nodes](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/attribute-synchronization-techniques/syncing-external-attribute-changes-to-graph-nodes/); here the version is the CDC log position rather than an application counter.
- **Per-key deduplication (`_dedupe_latest`).** CDC guarantees ordering only within a key, and a single poll can contain several events for the same row. Collapsing each key to its highest-version event before writing means the batch commits the correct *terminal* state in one pass, regardless of the order events sit in the buffer, and turns a chatty burst into one write per node. The dedupe also resolves the update-versus-delete race: if a key has both an update at v5 and a delete at v9 in the same batch, the delete wins because it carries the higher version.
- **Tombstone deletes, not hard deletes.** The delete path does not `DETACH DELETE`; it sets `deleted = true` and bumps `cdc_version`. Hard-deleting the node would also destroy the stored version, so a later-arriving stale create for the same key would resurrect a row that should stay gone. The tombstone keeps the version record alive as a gravestone, so out-of-order redelivery still fails the guard. A separate compaction job can physically remove tombstoned nodes past a retention window once no older offsets remain in flight.

<svg viewBox="0 0 780 330" role="img" aria-labelledby="cgTitle cgDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="cgTitle">Replaying an offset cannot corrupt state, because the version guard is the only writer</title>
  <desc id="cgDesc">A key's stored cdc_version as five deliveries arrive. Version 4 applies and moves the stored version to 4. Version 7 applies and moves it to 7. Version 4 redelivered after a crash matches the node but fails the strictly-greater guard, so it is an idempotent no-op and the stored version stays at 7. A delete at version 9 applies as a tombstone, setting deleted true and moving the version to 9 rather than removing the node. A late create at version 6 then fails the guard as well, so the tombstone survives and the row is not resurrected.</desc>
  <defs>
    <marker id="cg-a" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="330" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">WHERE ev.version &gt; n.cdc_version — five deliveries, one key</text>
  <text x="24" y="60" font-size="10.5" font-weight="700" fill="currentColor">delivered</text>
  <g font-size="10.5" font-weight="700" text-anchor="middle">
    <rect x="110" y="46" width="112" height="30" rx="7" fill="var(--viz-good,#0a656d)"/><text x="166" y="66" fill="var(--viz-on-pill,#ffffff)">update v4</text>
    <rect x="238" y="46" width="112" height="30" rx="7" fill="var(--viz-good,#0a656d)"/><text x="294" y="66" fill="var(--viz-on-pill,#ffffff)">update v7</text>
    <rect x="366" y="46" width="112" height="30" rx="7" fill="var(--viz-poor,#a8320f)"/><text x="422" y="66" fill="var(--viz-on-pill,#ffffff)">update v4 again</text>
    <rect x="494" y="46" width="112" height="30" rx="7" fill="var(--viz-good,#0a656d)"/><text x="550" y="66" fill="var(--viz-on-pill,#ffffff)">delete v9</text>
    <rect x="622" y="46" width="112" height="30" rx="7" fill="var(--viz-poor,#a8320f)"/><text x="678" y="66" fill="var(--viz-on-pill,#ffffff)">create v6</text>
  </g>
  <g stroke="currentColor" stroke-width="1.5" marker-end="url(#cg-a)">
    <line x1="166" y1="76" x2="166" y2="112"/><line x1="294" y1="76" x2="294" y2="112"/>
    <line x1="422" y1="76" x2="422" y2="112"/><line x1="550" y1="76" x2="550" y2="112"/><line x1="678" y1="76" x2="678" y2="112"/>
  </g>
  <text x="24" y="134" font-size="10.5" font-weight="700" fill="currentColor">guard</text>
  <g font-size="10" text-anchor="middle" font-weight="700">
    <rect x="110" y="114" width="112" height="26" rx="6" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="1.5"/><text x="166" y="131" fill="var(--viz-good,#0a656d)">4 &gt; 0 · apply</text>
    <rect x="238" y="114" width="112" height="26" rx="6" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="1.5"/><text x="294" y="131" fill="var(--viz-good,#0a656d)">7 &gt; 4 · apply</text>
    <rect x="366" y="114" width="112" height="26" rx="6" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-poor,#a8320f)" stroke-width="1.5"/><text x="422" y="131" fill="var(--viz-poor,#a8320f)">4 &gt; 7 false</text>
    <rect x="494" y="114" width="112" height="26" rx="6" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="1.5"/><text x="550" y="131" fill="var(--viz-good,#0a656d)">9 &gt; 7 · apply</text>
    <rect x="622" y="114" width="112" height="26" rx="6" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-poor,#a8320f)" stroke-width="1.5"/><text x="678" y="131" fill="var(--viz-poor,#a8320f)">6 &gt; 9 false</text>
  </g>
  <text x="24" y="184" font-size="10.5" font-weight="700" fill="currentColor">stored</text>
  <line x1="110" y1="176" x2="736" y2="176" stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1.2"/>
  <g font-size="11" font-weight="700" text-anchor="middle">
    <circle cx="166" cy="176" r="15" fill="var(--accent-3,#5b21b6)"/><text x="166" y="180" fill="var(--viz-on-pill,#ffffff)">4</text>
    <circle cx="294" cy="176" r="15" fill="var(--accent-3,#5b21b6)"/><text x="294" y="180" fill="var(--viz-on-pill,#ffffff)">7</text>
    <circle cx="422" cy="176" r="15" fill="var(--accent-3,#5b21b6)"/><text x="422" y="180" fill="var(--viz-on-pill,#ffffff)">7</text>
    <circle cx="550" cy="176" r="15" fill="var(--accent-3,#5b21b6)"/><text x="550" y="180" fill="var(--viz-on-pill,#ffffff)">9</text>
    <circle cx="678" cy="176" r="15" fill="var(--accent-3,#5b21b6)"/><text x="678" y="180" fill="var(--viz-on-pill,#ffffff)">9</text>
  </g>
  <text x="24" y="228" font-size="10.5" font-weight="700" fill="currentColor">node</text>
  <g font-size="9.5" text-anchor="middle">
    <text x="166" y="216" fill="var(--viz-ink-mute,#565f6d)">live</text><text x="294" y="216" fill="var(--viz-ink-mute,#565f6d)">live</text>
    <text x="422" y="216" fill="var(--viz-ink-mute,#565f6d)">unchanged</text>
    <text x="550" y="216" fill="var(--viz-ink-mute,#565f6d)">deleted = true</text>
    <text x="678" y="216" fill="var(--viz-ink-mute,#565f6d)">still deleted</text>
    <text x="422" y="230" fill="var(--viz-ink-mute,#565f6d)">no-op</text>
    <text x="550" y="230" fill="var(--viz-ink-mute,#565f6d)">tombstone</text>
    <text x="678" y="230" fill="var(--viz-ink-mute,#565f6d)">not resurrected</text>
  </g>
  <text x="24" y="272" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">The third delivery is why offsets can be committed after the write rather than before: a crash-and-replay is a no-op,</text>
  <text x="24" y="288" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">not a rewind. The fifth is why the delete is a tombstone — DETACH DELETE would destroy the version that rejects it,</text>
  <text x="24" y="304" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">and the stale create would then find no node, no guard, and nothing stopping it from writing the row back.</text>
</svg>

The `location` is written from the CDC payload in Neo4j's `point({longitude, latitude})` convention (WGS84 / EPSG:4326) so it stays seekable by the [spatial indexing strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) layer.

## Common Failure Patterns

**1. Out-of-order events overwriting newer data.** Without the guard, an event that is redelivered or arrives late clobbers a fresher value, because whichever write commits last wins — and CDC gives no global ordering promise. The version comparison must live in Cypher, not in application code where a concurrent worker can still race it:

```cypher
// WRONG — last delivery to commit wins, even if it is older
MATCH (n:PoiNode {external_id: ev.key}) SET n.name = ev.after.name
// RIGHT — only a strictly newer log position mutates the node
MERGE (n:PoiNode {external_id: ev.key}) ON CREATE SET n.cdc_version = -1
WITH n, ev WHERE ev.version > n.cdc_version
SET n.name = ev.after.name, n.cdc_version = ev.version
```

**2. Missing delete handling leaves ghost nodes.** A consumer that only processes `c` and `u` events silently ignores every `d`, so deleted rows linger in the graph forever and routing keeps returning waypoints that no longer exist. Route the `d` operation to a tombstone that participates in the same version guard, rather than dropping it or issuing an unguarded delete that a stale replay can undo.

**3. Committing the offset before the write is durable.** Advancing the CDC offset first and writing second means a crash between the two loses the delta permanently — the source considers it delivered, but the graph never applied it. Always apply the batch, confirm the write with `consume()`, and only then commit the offset; on restart the consumer safely re-applies the last batch because the guard makes re-application a no-op.

## Performance Notes

CDC cost tracks the volume of *delivered* events, while committed writes track the number of *distinct keys* after deduplication. For a batch of $B$ raw events spanning $K$ distinct keys with an at-least-once redundancy factor $A = B / K$, the dedupe step reduces the work sent to the database:

$$W_{\text{commit}} \le K, \qquad C_{\text{apply}} = K \cdot c_{\text{idx}}, \qquad \text{lag} = o_{\text{head}} - o_{\text{commit}}$$

where $c_{\text{idx}}$ is the cost of one index-seek `MERGE`. As $A$ climbs — a hot row re-emitted many times per poll — deduplication saves proportionally more, because $B - K$ events never reach a transaction. Consumer lag, the gap between the log head offset and the last committed offset, is the metric to alarm on: a steadily growing lag means apply throughput has fallen behind the source's change rate, and the fix is a larger `batch_size` (fewer round trips) or profiling the write plan before adding consumers, since more concurrency only helps if the `MERGE` is genuinely index-bound rather than lock-bound. Confirm that with the techniques in [optimizing Cypher query plans for spatial data](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/optimizing-cypher-query-plans-for-spatial-data/). Keep memory flat by bounding `batch_size`; peak buffer is roughly `batch_size × bytes_per_event` regardless of total stream volume.

## Related

- [Syncing external attribute changes to graph nodes](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/attribute-synchronization-techniques/syncing-external-attribute-changes-to-graph-nodes/)
- [Scaling async graph ingestion with Python asyncio](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/async-batch-processing-for-graphs/scaling-async-graph-ingestion-with-python-asyncio/)
- [Building automated OSM-to-graph ETL pipelines](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/osm-data-ingestion-pipelines/building-automated-osm-to-graph-etl-pipelines/)
- [Optimizing Cypher query plans for spatial data](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/optimizing-cypher-query-plans-for-spatial-data/)

This guide is part of [Attribute Synchronization Techniques](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/attribute-synchronization-techniques/), within the broader [Spatial Graph Construction & OSM Ingestion](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/) guide.
