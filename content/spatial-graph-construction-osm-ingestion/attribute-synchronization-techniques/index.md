# Attribute Synchronization Techniques for Spatial Graphs

A spatial routing graph is only as accurate as its freshest attribute. The topology rarely changes — roads keep connecting the same junctions for years — but the values that decide a route change by the minute: speed limits drop for roadworks, a bridge closes, congestion spikes at rush hour, a depot runs out of dock capacity. When those attributes drift from ground truth, pathfinding silently returns confident, wrong answers: a courier routed onto a closed road, an ambulance sent the long way round a jam. **Attribute synchronization** is the discipline of pushing high-frequency external updates onto an already-loaded graph *without* blocking the routing queries reading from it. Get it wrong and the symptom an engineer sees is either stale routes that ignore live conditions, or — worse — routing latency that sawtooths every time a feed lands because the sync writes contend with reads. This guide covers the mechanism, the schema it needs, a complete runnable sync engine, the query variants that keep it idempotent, and how to prove the result is both fresh and consistent.

This is the maintenance half of [Spatial Graph Construction & OSM Ingestion](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/): the initial import builds the network, but synchronization is what keeps it true between imports. It sits downstream of the [OSM data ingestion pipelines](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/osm-data-ingestion-pipelines/) that produced the topology and runs continuously while routing serves traffic.

## Prerequisites

You need an async Python toolchain and a Neo4j instance whose graph is already populated with `RoadSegment` nodes (or equivalent) carrying stable identifiers. Synchronization assumes the topology exists; it only mutates properties.

| Component | Minimum version | Notes |
| --- | --- | --- |
| Python | 3.10+ | `asyncio` connection management and structural typing |
| Neo4j | 5.x | Property-existence constraints and the 5-series planner for `SET`-on-`MATCH` seeks |
| `neo4j` driver | 5.x | Provides `AsyncGraphDatabase` and `session.execute_write` |
| `numpy` | 1.24+ | Optional, vectorizes spatial validation for high-rate feeds |
| `prometheus-client` | 0.19+ | Optional, exposes sync-health metrics |

```bash
pip install "neo4j>=5.0" "numpy>=1.24" "prometheus-client>=0.19"
```

Confirm the segment identifier your feed carries matches the key already on the graph before you write anything — a mismatched `segment_id` namespace makes every update a silent no-op that looks like success, which is far harder to diagnose than an outright failure.

## Core Concept & Mechanism

Synchronization is hard for one reason: the sync layer and the routing layer want the same nodes at the same time, but for opposite purposes. Routing reads committed state and must see a stable snapshot for the duration of a traversal — an A\* search or a contraction-hierarchy query that watches `weight` change mid-flight can produce an inconsistent path. The sync layer writes new values as fast as feeds arrive. The mechanism reconciles them with three ideas.

**Set-on-match, never merge.** Because the nodes already exist, every update is a `MATCH` followed by a `SET`. You never `MERGE` during synchronization — a `MERGE` against a feed row with a typo'd id would *create* a phantom node with no topology, corrupting the graph. `MATCH` simply fails to bind and writes nothing, which is the safe failure.

**Monotonic timestamp gating.** Feeds arrive out of order, retry, and duplicate. To make writes idempotent you gate every update on a per-node `last_synced_ts`: a row is applied only if its timestamp is strictly newer than what the node already holds. Re-delivering the same row is then a no-op, and a late-arriving stale row can never overwrite a fresher value. This is last-writer-wins keyed on event time, not arrival time.

**Batched, bounded writes.** A single `UNWIND $batch AS row` statement applies thousands of gated updates in one round-trip and one transaction, so the query plan compiles once. Batches are sized to keep transactions short — short transactions hold locks briefly, which is what stops sync from starving the routing plane. The full streaming, backpressure, and worker-pool machinery these batches ride on is shared with [async batch processing for graphs](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/async-batch-processing-for-graphs/); synchronization reuses that transport and adds the gating and validation semantics described here.

<svg viewBox="0 0 960 420" role="img" aria-labelledby="as-title as-desc" xmlns="http://www.w3.org/2000/svg">
  <title id="as-title">Attribute synchronization data flow: feeds to validation gate to bounded batches to a gated write, with routing reading a separate committed snapshot</title>
  <desc id="as-desc">External feeds — traffic speeds, closures, and GPS telemetry — converge into a validation gate that runs a Haversine and bounds check, dropping rows whose coordinates drift. Surviving rows collect in a bounded batch buffer of at most four to five thousand rows per transaction, then pass through a gated UNWIND-SET write whose WHERE clause on last_synced_ts is the idempotency boundary: only strictly newer rows are applied. Writes land in the committed graph. On an independent path, routing queries such as A-star and contraction hierarchies read the committed snapshot, so write bursts never block traversals.</desc>
  <style>
    .as-lbl{font:700 12px var(--font-sans,system-ui,sans-serif);fill:var(--ink-mute,#6b7280);letter-spacing:.04em;text-transform:uppercase;}
    .as-box{fill:var(--viz-panel,#f4f4f5);stroke:var(--line-strong,#9ca3af);stroke-width:1.5;}
    .as-feed{fill:var(--surface-2,#f4f4f5);stroke:var(--line-strong,#9ca3af);stroke-width:1.5;}
    .as-acc{fill:var(--viz-panel,#f4f4f5);stroke:var(--accent,#0e7c86);stroke-width:2.5;}
    .as-t{font:600 13px var(--font-sans,system-ui,sans-serif);fill:var(--ink,#1f2937);}
    .as-tc{font:600 13px var(--font-sans,system-ui,sans-serif);fill:var(--accent,#0e7c86);}
    .as-s{font:11px var(--font-mono,ui-monospace,monospace);fill:var(--ink-mute,#6b7280);}
    .as-flow{fill:none;stroke:var(--accent,#0e7c86);stroke-width:2.5;}
    .as-read{fill:none;stroke:currentColor;stroke-width:2;opacity:.55;stroke-dasharray:6 4;}
    .as-drop{fill:none;stroke:var(--accent-coral,#ff6b6b);stroke-width:2;stroke-dasharray:5 3;}
    .as-dropt{font:italic 11px var(--font-sans,system-ui,sans-serif);fill:var(--accent-coral,#ff6b6b);}
    .as-bound{fill:none;stroke:var(--accent,#0e7c86);stroke-width:1.5;stroke-dasharray:5 4;opacity:.8;}
    .as-node{fill:var(--viz-panel,#f4f4f5);stroke:var(--accent,#0e7c86);stroke-width:2;}
    .as-ed{fill:none;stroke:var(--accent,#0e7c86);stroke-width:2;}
  </style>
  <defs>
    <marker id="as-arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="var(--accent,#0e7c86)"/>
    </marker>
    <marker id="as-rarr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor" opacity=".55"/>
    </marker>
    <marker id="as-darr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="var(--accent-coral,#ff6b6b)"/>
    </marker>
  </defs>
  <!-- column labels -->
  <rect class="viz-backdrop" x="0" y="0" width="960" height="420" fill="var(--viz-bg,#ffffff)"/>
  <text class="as-lbl" x="100" y="30" text-anchor="middle">External feeds</text>
  <text class="as-lbl" x="490" y="30" text-anchor="middle">Synchronization plane</text>
  <text class="as-lbl" x="877" y="30" text-anchor="middle">Graph + routing</text>
  <!-- feeds -->
  <rect class="as-feed" x="25" y="60" width="150" height="46" rx="9"/>
  <text class="as-t" x="100" y="82" text-anchor="middle">Traffic speeds</text>
  <text class="as-s" x="100" y="98" text-anchor="middle">speed_kph, ts</text>
  <rect class="as-feed" x="25" y="128" width="150" height="46" rx="9"/>
  <text class="as-t" x="100" y="150" text-anchor="middle">Closures</text>
  <text class="as-s" x="100" y="166" text-anchor="middle">is_closed, reason</text>
  <rect class="as-feed" x="25" y="196" width="150" height="46" rx="9"/>
  <text class="as-t" x="100" y="218" text-anchor="middle">GPS telemetry</text>
  <text class="as-s" x="100" y="234" text-anchor="middle">lat, lon, ts</text>
  <!-- feeds -> gate -->
  <path class="as-flow" d="M175 83 C198 83 192 150 210 165" marker-end="url(#as-arr)"/>
  <path class="as-flow" d="M175 151 H210" marker-end="url(#as-arr)"/>
  <path class="as-flow" d="M175 219 C198 219 192 152 210 167" marker-end="url(#as-arr)"/>
  <!-- validation gate -->
  <rect class="as-box" x="214" y="108" width="156" height="92" rx="10"/>
  <text class="as-t" x="292" y="138" text-anchor="middle">Validation gate</text>
  <text class="as-s" x="292" y="158" text-anchor="middle">Haversine &#8804; tol</text>
  <text class="as-s" x="292" y="174" text-anchor="middle">lat/lon bounds</text>
  <!-- drop path -->
  <path class="as-drop" d="M292 200 V250" marker-end="url(#as-darr)"/>
  <text class="as-dropt" x="292" y="268" text-anchor="middle">drift &#8594; dropped</text>
  <!-- gate -> buffer -->
  <path class="as-flow" d="M370 154 H410" marker-end="url(#as-arr)"/>
  <!-- bounded batch buffer -->
  <rect class="as-box" x="414" y="116" width="150" height="76" rx="10"/>
  <text class="as-t" x="489" y="143" text-anchor="middle">Batch buffer</text>
  <text class="as-s" x="489" y="161" text-anchor="middle">bounded, &#8804; 4&#8211;5k</text>
  <text class="as-s" x="489" y="177" text-anchor="middle">rows / txn</text>
  <!-- buffer -> gated write -->
  <path class="as-flow" d="M564 154 H606" marker-end="url(#as-arr)"/>
  <!-- gated write (idempotency boundary) -->
  <rect class="as-bound" x="602" y="92" width="180" height="138" rx="13"/>
  <rect class="as-acc" x="610" y="108" width="164" height="92" rx="10"/>
  <text class="as-tc" x="692" y="136" text-anchor="middle">Gated UNWIND SET</text>
  <text class="as-s" x="692" y="158" text-anchor="middle">WHERE n.last_synced_ts</text>
  <text class="as-s" x="692" y="173" text-anchor="middle">&lt; update.timestamp</text>
  <text class="as-tc" x="692" y="220" text-anchor="middle" style="font-size:11px">idempotency boundary</text>
  <!-- write -> graph -->
  <path class="as-flow" d="M782 154 H812" marker-end="url(#as-arr)"/>
  <!-- committed graph -->
  <rect class="as-box" x="816" y="64" width="120" height="140" rx="10"/>
  <text class="as-t" x="876" y="88" text-anchor="middle">Committed</text>
  <text class="as-t" x="876" y="104" text-anchor="middle">graph</text>
  <line class="as-ed" x1="846" y1="140" x2="906" y2="128"/>
  <line class="as-ed" x1="906" y1="128" x2="888" y2="178"/>
  <line class="as-ed" x1="846" y1="140" x2="888" y2="178"/>
  <circle class="as-node" cx="846" cy="140" r="8"/>
  <circle class="as-node" cx="906" cy="128" r="8"/>
  <circle class="as-node" cx="888" cy="178" r="8"/>
  <!-- read path: graph -> routing -->
  <path class="as-read" d="M876 204 V300 H520 V322" marker-end="url(#as-rarr)"/>
  <text class="as-s" x="700" y="294" text-anchor="middle">read path &#183; committed snapshot</text>
  <!-- routing plane -->
  <rect class="as-box" x="214" y="326" width="568" height="64" rx="10"/>
  <text class="as-t" x="498" y="354" text-anchor="middle">Routing queries &#8212; A* / contraction hierarchies</text>
  <text class="as-s" x="498" y="374" text-anchor="middle">stable snapshot, independent of the write path &#8594; bursts never block traversals</text>
</svg>

The result is a clean separation: feeds flow through a validation gate, get grouped into bounded batches, and land via gated `SET` writes, while routing reads the committed snapshot on an independent path.

## Schema & Data Model

The synchronization layer adds three kinds of property to nodes and edges that already exist from ingestion: the **live value** being kept current (`speed_kph`, `congestion_factor`, `is_closed`), the **gating timestamp** (`last_synced_ts`), and an optional **override channel** (`speed_kph_override`) for authoritative manual control. Edge attributes follow the same shape on the `CONNECTS` relationship.

Two schema objects make synchronization both correct and fast:

1. A **uniqueness constraint** on `RoadSegment.segment_id`. Without it, every `MATCH (n:RoadSegment {segment_id: ...})` degrades to a label scan, turning each batch from an index seek into a full traversal that competes directly with routing for CPU. The constraint also backs the lookup index for free.
2. A **range index** on `RoadSegment.last_synced_ts`. Freshness audits and staleness sweeps (below) filter on this property; without the index those audits scan every segment.

```cypher
// Run once, before synchronization starts. IF NOT EXISTS keeps it idempotent.
CREATE CONSTRAINT road_segment_id_unique IF NOT EXISTS
FOR (n:RoadSegment) REQUIRE n.segment_id IS UNIQUE;

CREATE RANGE INDEX road_segment_synced_ts IF NOT EXISTS
FOR (n:RoadSegment) ON (n.last_synced_ts);

// Optional: index the live edge id if you sync edge metrics by relationship id.
CREATE INDEX connects_edge_id IF NOT EXISTS
FOR ()-[r:CONNECTS]-() ON (r.edge_id);
```

Keep the gating timestamp as an integer epoch (milliseconds) or a Neo4j temporal — never a string. String comparison breaks monotonicity the moment a timezone suffix or precision difference sneaks in, which silently lets stale rows win.

## Step-by-Step Implementation

The engine below is the complete, runnable core. It owns one driver, gates every write on event time, validates coordinates before they reach the database, and routes critical updates through an override channel.

### 1. Initialize one driver sized to the sync workload

Create the driver once at startup and share it. Size the pool to your concurrency and set an explicit acquisition timeout so a saturated pool fails fast instead of silently queuing behind routing traffic.

```python
import asyncio
import logging
from typing import List, Dict, Any
from neo4j import AsyncGraphDatabase, AsyncSession
from neo4j.exceptions import ClientError

logger = logging.getLogger(__name__)


class EdgeAttributeSyncEngine:
    def __init__(self, uri: str, auth: tuple[str, str], max_connections: int = 50):
        self.driver = AsyncGraphDatabase.driver(
            uri,
            auth=auth,
            max_connection_pool_size=max_connections,
            connection_acquisition_timeout=10.0,
        )

    async def close(self) -> None:
        await self.driver.close()
```

### 2. Validate spatial alignment before any write

When a feed updates a node attribute, confirm the feed's coordinates actually match the graph node before trusting it. A Haversine check rejects telemetry that has drifted onto the wrong segment, which is the most common way a feed silently corrupts routing. The coordinate conventions this depends on are owned by [node and edge spatial mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/), and the same alignment discipline appears in [POI enrichment workflows](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/poi-enrichment-workflows/).

```python
import math


def validate_spatial_alignment(
    lat: float, lon: float, graph_lat: float, graph_lon: float, tolerance_m: float = 5.0
) -> bool:
    """Reject updates whose telemetry coordinates drift beyond tolerance from the graph node."""
    R = 6_371_000.0  # Earth radius in metres
    d_phi = math.radians(lat - graph_lat)
    d_lambda = math.radians(lon - graph_lon)
    a = (
        math.sin(d_phi / 2) ** 2
        + math.cos(math.radians(graph_lat)) * math.cos(math.radians(lat)) * math.sin(d_lambda / 2) ** 2
    )
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c <= tolerance_m
```

For feeds above ~100k records/second, replace this per-row loop with a vectorized NumPy implementation — the trigonometry is identical, but operating on arrays avoids the Python call overhead that otherwise makes validation the bottleneck.

### 3. Define the gated, idempotent write

A single `UNWIND` statement matches each existing segment and applies the update only when the row is strictly newer. The `WHERE n.last_synced_ts IS NULL OR n.last_synced_ts < update.timestamp` clause is the idempotency boundary: re-delivered or out-of-order rows fall through and write nothing.

```python
    async def _gated_write(self, tx: AsyncSession, batch: List[Dict[str, Any]]) -> int:
        query = """
        UNWIND $batch AS update
        MATCH (n:RoadSegment {segment_id: update.segment_id})
        WHERE n.last_synced_ts IS NULL OR n.last_synced_ts < update.timestamp
        SET n.speed_kph        = update.speed_kph,
            n.congestion_factor = update.congestion_factor,
            n.last_synced_ts    = update.timestamp
        RETURN count(n) AS updated
        """
        result = await tx.run(query, batch=batch)
        record = await result.single()
        return record["updated"] if record else 0
```

### 4. Apply batches under managed transactions

`execute_write` wraps each batch in a retried, managed transaction, so transient failures (leader switches, deadlocks) recover automatically. Chunking keeps each transaction short and its lock footprint small.

```python
    async def sync_edge_attributes(
        self, updates: List[Dict[str, Any]], batch_size: int = 4000
    ) -> int:
        if not updates:
            return 0
        total = 0
        async with self.driver.session(database="neo4j") as session:
            for i in range(0, len(updates), batch_size):
                chunk = updates[i : i + batch_size]
                try:
                    total += await session.execute_write(self._gated_write, chunk)
                except ClientError as e:
                    logger.error("Batch sync failed at offset %d: %s", i, e)
                    raise
        return total
```

### 5. Route critical updates through an override channel

Authoritative events — a municipal closure order, an emergency embargo — must not be silently overwritten by a noisier crowd-sourced feed that happens to carry a later timestamp. Write those to a separate `*_override` property that routing reads with priority, and stamp an immutable audit trail row so post-incident forensics can reconstruct exactly what was forced and when.

```python
    async def apply_override(
        self, segment_id: str, speed_kph: float, source: str, ts: int
    ) -> None:
        query = """
        MATCH (n:RoadSegment {segment_id: $segment_id})
        SET n.speed_kph_override = $speed_kph,
            n.override_source    = $source,
            n.override_ts        = $ts
        CREATE (n)-[:HAS_AUDIT]->(:SyncAudit {
            field: 'speed_kph', value: $speed_kph, source: $source, ts: $ts
        })
        """
        async with self.driver.session(database="neo4j") as session:
            await session.execute_write(
                lambda tx: tx.run(
                    query, segment_id=segment_id, speed_kph=speed_kph, source=source, ts=ts
                )
            )
```

Routing then resolves the effective speed with `coalesce(n.speed_kph_override, n.speed_kph)`, so an active override always wins regardless of feed timestamps, and clearing the override (set it to `null`) restores normal gated behaviour.

## Query Patterns & Variants

Three sync shapes recur. Each is a deliberate variant of the gated `UNWIND` write.

**Variant 1 — edge-metric sync by relationship id.** When live cost belongs on the edge rather than the node, gate the relationship the same way. The `edge_id` index keeps the `MATCH` an index seek.

```cypher
UNWIND $batch AS update
MATCH ()-[r:CONNECTS {edge_id: update.edge_id}]->()
WHERE r.last_synced_ts IS NULL OR r.last_synced_ts < update.timestamp
SET r.travel_time_s  = update.travel_time_s,
    r.last_synced_ts = update.timestamp
RETURN count(r) AS updated
// $batch: list of maps; edge_id must match the value set at ingestion time
```

**Variant 2 — boolean closure flip with reason.** Closures are not numeric metrics; gate them the same way but carry a reason so routing and dashboards can explain the avoidance.

```cypher
UNWIND $batch AS update
MATCH (n:RoadSegment {segment_id: update.segment_id})
WHERE n.last_synced_ts IS NULL OR n.last_synced_ts < update.timestamp
SET n.is_closed      = update.is_closed,
    n.closure_reason = update.reason,
    n.last_synced_ts = update.timestamp
RETURN count(n) AS updated
// reason flows into routing avoidance and into operator UIs; never overwrite with NULL on re-open without a fresh timestamp
```

**Variant 3 — staleness sweep.** Detect segments whose live values have gone stale because their feed went quiet, so routing can fall back to posted limits. This filter seeks the `last_synced_ts` range index rather than scanning every segment.

```cypher
WITH timestamp() - $max_age_ms AS cutoff
MATCH (n:RoadSegment)
WHERE n.last_synced_ts < cutoff
RETURN n.segment_id AS segment_id, n.last_synced_ts AS last_seen
ORDER BY last_seen ASC
LIMIT $k
// $max_age_ms bounds acceptable staleness; results feed a fallback-to-static-speed job
```

## Performance Tuning

Synchronization shifts the bottleneck off the network and onto lock contention and write-ahead-log (WAL) pressure, so tune both.

**Profile the gated write, do not guess.** Prefix the statement with `PROFILE` against a representative batch and confirm the operator is `NodeUniqueIndexSeek`, not `NodeByLabelScan` — a scan means the `segment_id` constraint is missing and every batch is contending with routing for a full traversal. `EXPLAIN` shows the plan without running; `PROFILE` shows actual db-hits, where a missing index betrays itself.

```cypher
PROFILE
UNWIND $batch AS update
MATCH (n:RoadSegment {segment_id: update.segment_id})
WHERE n.last_synced_ts IS NULL OR n.last_synced_ts < update.timestamp
SET n.speed_kph = update.speed_kph, n.last_synced_ts = update.timestamp
RETURN count(n)
```

**Size batches to lock footprint, not to a round number.** 4,000–5,000 gated updates per transaction is the working range. Larger batches lengthen transactions and hold locks on hot segments longer — directly stealing latency from routing; micro-batches amplify per-transaction overhead and recompile costs. If a few arterial segments receive most of the updates, smaller batches reduce contention on those hot nodes.

**Keep the routing plane on a stable snapshot.** When sync windows coincide with routing-latency spikes, route pathfinding to a read replica or a consistent snapshot so a heavy `SET` burst can never block a traversal. The planner-side levers that keep those reads cheap — index hints, predicate ordering — are detailed in [graph query planner optimization](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/), and the index types the proximity reads seek are chosen via [spatial indexing strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/).

**Watch the WAL and the pool.** Sustained gated writes grow the transaction log; if checkpointing falls behind, throughput sawtooths. Expose metrics for `batch_write_duration_ms`, `stale_update_rejection_rate`, and connection-pool saturation, and apply application-level backpressure or a circuit breaker before the pool fills — a full pool turns into queued routing timeouts, not just slow sync.

## Edge Cases & Gotchas

- **Phantom nodes from `MERGE`.** Using `MERGE` instead of `MATCH` in a sync write turns a feed typo into a topology-less node with a `segment_id` that no edge references. It pollutes counts and never routes. Always `MATCH`; let a bad id write nothing.
- **String timestamps break gating.** A `last_synced_ts` stored as an ISO string compares lexicographically, so `"2026-06-26T09:00"` and `"2026-06-26T9:00"` order wrongly and a stale row wins. Store epoch integers or temporals only.
- **Lat/lon swap defeats validation.** Raw OSM and GeoJSON emit `(lon, lat)`; Neo4j points are `{latitude, longitude}`. A silent swap puts telemetry in the wrong hemisphere, so the Haversine gate rejects *everything* — or, near the equator, accepts the wrong segment. Assert bounds tightly so a swap fails loudly.
- **Override never cleared.** An `*_override` left in place after the incident ends pins a segment to a stale forced value forever, because `coalesce` keeps preferring it. Treat override clearing as a first-class step with its own audit row.
- **Re-open with a stale timestamp.** Flipping `is_closed` back to false with an old timestamp is gated out, so the road stays closed in the graph. Re-open events must carry a current event time, not the original closure's.
- **Acquisition-timeout masking.** Raising `connection_acquisition_timeout` to hide a saturated pool only defers the failure into routing latency. Cap concurrency and shed load instead.


<svg viewBox="0 0 780 326" role="img" aria-labelledby="slTitle slDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="slTitle">A latitude and longitude swap does not fail — it changes which error you get</title>
  <desc id="slDesc">One feed coordinate, 51.5 north and 0.12 west, read in the two orders. Read correctly it lands in London and the Haversine gate accepts it. Read as longitude first it becomes 0.12 north, 51.5 east, a point in the Indian Ocean; the distance gate then rejects every row in the batch and the sync appears to be a validation problem. Near the equator the same swap moves the point only a short distance, so the gate accepts it and the attribute is written to the wrong segment instead — which is why the bounds assertion has to be tight rather than merely present.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="326" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Feed emits (lon, lat); Neo4j points are {latitude, longitude}</text>
  <text x="24" y="42" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">one coordinate pair: 51.5, −0.12</text>
  <rect x="24" y="58" width="356" height="172" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="1.8"/>
  <text x="202" y="82" text-anchor="middle" font-size="11.5" font-weight="700" fill="var(--viz-good,#0a656d)">read in the right order</text>
  <text x="202" y="106" text-anchor="middle" font-size="11" font-family="var(--font-mono,monospace)" fill="currentColor">point({latitude: 51.5, longitude: −0.12})</text>
  <rect x="46" y="122" width="316" height="62" rx="7" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1"/>
  <circle cx="132" cy="152" r="7" fill="var(--viz-good,#0a656d)"/>
  <text x="152" y="149" font-size="10.5" font-weight="700" fill="currentColor">London — 40 m from the segment</text>
  <text x="152" y="164" font-size="10" fill="var(--viz-ink-mute,#565f6d)">inside the Haversine gate</text>
  <text x="202" y="206" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--viz-good,#0a656d)">row applies</text>
  <rect x="400" y="58" width="356" height="172" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-poor,#a8320f)" stroke-width="1.8"/>
  <text x="578" y="82" text-anchor="middle" font-size="11.5" font-weight="700" fill="var(--viz-poor,#a8320f)">read swapped</text>
  <text x="578" y="106" text-anchor="middle" font-size="11" font-family="var(--font-mono,monospace)" fill="currentColor">point({latitude: −0.12, longitude: 51.5})</text>
  <rect x="422" y="122" width="316" height="62" rx="7" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1"/>
  <circle cx="508" cy="152" r="7" fill="var(--viz-poor,#a8320f)"/>
  <text x="528" y="149" font-size="10.5" font-weight="700" fill="currentColor">Indian Ocean — 5,700 km away</text>
  <text x="528" y="164" font-size="10" fill="var(--viz-ink-mute,#565f6d)">outside the gate, along with the batch</text>
  <text x="578" y="206" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--viz-poor,#a8320f)">every row rejected — reads as a validation bug</text>
  <rect x="24" y="246" width="732" height="68" rx="9" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-ok,#7d6200)" stroke-width="1.8"/>
  <text x="44" y="268" font-size="11" font-weight="700" fill="var(--viz-ok,#7d6200)">the case that does not announce itself</text>
  <text x="44" y="286" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">Near the equator a swap moves the point only a few kilometres. The gate accepts it, and the</text><text x="44" y="300" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">attribute is written to a real segment — the wrong one.</text>
</svg>

## Verification & Testing

Correctness here is twofold: writes must be *fresh* (the latest event won) and *consistent* (no stale row overwrote a newer one, no phantom node appeared). Assert all three after a sync run.

```python
import asyncio
from neo4j import AsyncGraphDatabase


async def verify_sync(uri: str, auth: tuple[str, str], max_age_ms: int) -> None:
    driver = AsyncGraphDatabase.driver(uri, auth=auth)
    async with driver.session(database="neo4j") as session:
        # 1. Idempotency: replaying the same batch must update zero rows.
        replay = [{"segment_id": "seg-A", "speed_kph": 50,
                   "congestion_factor": 1.0, "timestamp": 1}]
        rec = await (await session.run(
            """
            UNWIND $batch AS u
            MATCH (n:RoadSegment {segment_id: u.segment_id})
            WHERE n.last_synced_ts IS NULL OR n.last_synced_ts < u.timestamp
            SET n.last_synced_ts = u.timestamp
            RETURN count(n) AS updated
            """, batch=replay)).single()
        assert rec["updated"] == 0, "stale replay was not gated out"

        # 2. No phantom nodes: every RoadSegment must carry an id and topology.
        rec = await (await session.run(
            "MATCH (n:RoadSegment) WHERE n.segment_id IS NULL OR NOT (n)--() "
            "RETURN count(n) AS phantoms"
        )).single()
        assert rec["phantoms"] == 0, f"found {rec['phantoms']} phantom/orphan segments"

        # 3. Freshness: bounded fraction of segments may be stale.
        rec = await (await session.run(
            "MATCH (n:RoadSegment) "
            "WITH count(n) AS total, "
            "     count(CASE WHEN n.last_synced_ts < timestamp() - $age THEN 1 END) AS stale "
            "RETURN total, stale", age=max_age_ms)).single()
        assert rec["stale"] / max(rec["total"], 1) < 0.05, "too many stale segments"
    await driver.close()


asyncio.run(verify_sync("bolt://localhost:7687", ("neo4j", "password"), 600_000))
```

Run the idempotency assertion twice in CI against the same fixture: a gating regression only surfaces on the *second* apply, so a one-shot test misses it. For override correctness, assert that `coalesce(n.speed_kph_override, n.speed_kph)` returns the forced value while an override is active and the gated value after it is cleared.

## FAQ

<details>
<summary>Why use MATCH instead of MERGE when syncing attributes?</summary>

The topology already exists from ingestion, so synchronization only mutates properties on known nodes. `MERGE` against a feed row with a bad `segment_id` would create a brand-new, topology-less node — a phantom that pollutes counts and never participates in routing. `MATCH` simply binds nothing for a bad id and writes nothing, which is the correct, safe failure. Reserve `MERGE` for the ingestion stage.
</details>

<details>
<summary>How does timestamp gating make sync idempotent?</summary>

Every node carries `last_synced_ts`, and a write applies only when the incoming row's event time is strictly newer. Re-delivering the same row updates zero nodes, and a late-arriving stale row can never overwrite a fresher value. This is last-writer-wins keyed on event time rather than arrival time, which makes the pipeline safe to retry, replay, and run with at-least-once feeds.
</details>

<details>
<summary>How big should each sync batch be?</summary>

4,000–5,000 gated updates per transaction is the working range. The constraint is not network round-trips but lock footprint: larger transactions hold locks on hot segments longer and steal latency from routing, while micro-batches amplify per-transaction overhead and plan recompilation. Tune toward the lower end if a handful of arterial segments receive most updates, and confirm with `PROFILE`.
</details>

<details>
<summary>How do I stop synchronization from blocking routing queries?</summary>

Keep transactions short (bounded batches), ensure the `segment_id` constraint makes each write an index seek rather than a label scan, and route pathfinding to a read replica or a consistent snapshot during heavy sync windows. Watch connection-pool saturation and apply backpressure before the pool fills, since a full pool converts into queued routing timeouts rather than merely slow sync.
</details>

<details>
<summary>When should I use the override channel instead of normal gating?</summary>

Use it for authoritative events that must not lose to a noisier feed carrying a later timestamp — municipal closures, emergency embargoes, manual operator control. Writes go to a separate `*_override` property that routing reads first via `coalesce`, plus an immutable audit row. Normal gated values keep flowing underneath, so clearing the override instantly restores live behaviour. Everyday telemetry should always go through normal gating.
</details>

## Related

- [Syncing External Attribute Changes to Graph Nodes](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/attribute-synchronization-techniques/syncing-external-attribute-changes-to-graph-nodes/) — a focused walkthrough of wiring a single external feed into the gated write path.
- [Change Data Capture for Graph Attribute Sync](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/attribute-synchronization-techniques/change-data-capture-for-graph-attribute-sync/) — applying an ordered CDC event stream idempotently with version guards.
- [OSM Data Ingestion Pipelines](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/osm-data-ingestion-pipelines/) — the parsing stage that builds the topology synchronization keeps current.
- [Async Batch Processing for Graphs](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/async-batch-processing-for-graphs/) — the bounded-queue and worker-pool transport these batches ride on.
- [POI Enrichment Workflows](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/poi-enrichment-workflows/) — attaching demographic and place attributes once topology is loaded.
- [Spatial Indexing Strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) — choosing the index types the freshness and proximity reads seek against.

This guide is part of [Spatial Graph Construction & OSM Ingestion](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/).

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "Why use MATCH instead of MERGE when syncing attributes?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "The topology already exists from ingestion, so synchronization only mutates properties on known nodes. MERGE against a feed row with a bad segment_id would create a brand-new, topology-less node that pollutes counts and never participates in routing. MATCH binds nothing for a bad id and writes nothing, which is the correct, safe failure. Reserve MERGE for the ingestion stage."
      }
    },
    {
      "@type": "Question",
      "name": "How does timestamp gating make sync idempotent?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Every node carries last_synced_ts, and a write applies only when the incoming row's event time is strictly newer. Re-delivering the same row updates zero nodes, and a late-arriving stale row can never overwrite a fresher value. This is last-writer-wins keyed on event time rather than arrival time, which makes the pipeline safe to retry, replay, and run with at-least-once feeds."
      }
    },
    {
      "@type": "Question",
      "name": "How big should each sync batch be?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "4,000 to 5,000 gated updates per transaction is the working range. The constraint is lock footprint, not network round-trips: larger transactions hold locks on hot segments longer and steal latency from routing, while micro-batches amplify per-transaction overhead and plan recompilation. Tune toward the lower end if a handful of arterial segments receive most updates, and confirm with PROFILE."
      }
    },
    {
      "@type": "Question",
      "name": "How do I stop synchronization from blocking routing queries?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Keep transactions short with bounded batches, ensure the segment_id constraint makes each write an index seek rather than a label scan, and route pathfinding to a read replica or consistent snapshot during heavy sync windows. Watch connection-pool saturation and apply backpressure before the pool fills, since a full pool converts into queued routing timeouts rather than merely slow sync."
      }
    },
    {
      "@type": "Question",
      "name": "When should I use the override channel instead of normal gating?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Use it for authoritative events that must not lose to a noisier feed carrying a later timestamp, such as municipal closures, emergency embargoes, or manual operator control. Writes go to a separate override property that routing reads first via coalesce, plus an immutable audit row. Normal gated values keep flowing underneath, so clearing the override instantly restores live behaviour. Everyday telemetry should always go through normal gating."
      }
    }
  ]
}
</script>
