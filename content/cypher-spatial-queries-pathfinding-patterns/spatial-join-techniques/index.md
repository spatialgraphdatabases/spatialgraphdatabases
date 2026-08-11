---
pageTitle: Spatial Join Techniques for Graphs
---
# Spatial Join Techniques for Production Graph Networks

A spatial join correlates two sets of geometry-bearing nodes by a proximity predicate — attaching delivery points to the hubs that serve them, snapping sensor readings to the road segment they sit on, binding incidents to the zones that contain them. Done naively in a graph database, it is the single most reliable way to take a healthy cluster down: the planner pairs every node on the left with every node on the right, the result set explodes quadratically, the transaction log balloons, and the JVM heap or native page cache is exhausted before the join ever finishes. The failure is silent in staging — a few thousand nodes join fine — and catastrophic the first time a real metro-scale dataset lands. This guide shows how to build spatial joins that stay index-bound: how the two-phase probe works internally, how to model the data so the index can seek it, the async Python that drives the join in bounded batches, the query variants you will actually reach for, and the precision and cardinality traps that corrupt results or melt memory. It is one of the core techniques in [Cypher Spatial Queries & Pathfinding Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/).

<svg viewBox="0 0 780 432" role="img" aria-labelledby="joinTitle joinDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="joinTitle">Naive all-pairs spatial join versus an index-probe join</title>
  <desc id="joinDesc">Left: a naive spatial join pairs every LogisticsHub square with every DeliveryPoint dot, drawn as a dense lattice of faint lines — an O(L times R) Cartesian explosion. Right: an index-probe join drives from each hub, seeks an index-aligned bounding box so only the points inside it are read (points outside are faded and never touched), fans out only to those candidates, then an inscribed circle clips the box corners back to the true within-radius survivors.</desc>
  <defs>
    <marker id="joinArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="var(--accent,#0e7c86)"/>
    </marker>
  </defs>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="432" fill="var(--viz-bg,#ffffff)"/>
  <line x1="390" y1="56" x2="390" y2="396" stroke="currentColor" stroke-width="1" stroke-dasharray="3 6" opacity="0.3"/>
  <!-- LEFT: naive all-pairs -->
  <text x="195" y="28" text-anchor="middle" font-size="14.5" font-weight="700" fill="currentColor">Naive all-pairs join</text>
  <text x="195" y="46" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7">every hub × every point → O(L × R)</text>
  <!-- lattice of faint lines: 3 hubs × 6 points -->
  <g stroke="var(--accent-coral,#ff6b6b)" stroke-width="1" opacity="0.4">
    <line x1="78" y1="120" x2="312" y2="92"/><line x1="78" y1="120" x2="312" y2="142"/><line x1="78" y1="120" x2="312" y2="192"/><line x1="78" y1="120" x2="312" y2="242"/><line x1="78" y1="120" x2="312" y2="292"/><line x1="78" y1="120" x2="312" y2="342"/>
    <line x1="78" y1="216" x2="312" y2="92"/><line x1="78" y1="216" x2="312" y2="142"/><line x1="78" y1="216" x2="312" y2="192"/><line x1="78" y1="216" x2="312" y2="242"/><line x1="78" y1="216" x2="312" y2="292"/><line x1="78" y1="216" x2="312" y2="342"/>
    <line x1="78" y1="312" x2="312" y2="92"/><line x1="78" y1="312" x2="312" y2="142"/><line x1="78" y1="312" x2="312" y2="192"/><line x1="78" y1="312" x2="312" y2="242"/><line x1="78" y1="312" x2="312" y2="292"/><line x1="78" y1="312" x2="312" y2="342"/>
  </g>
  <!-- hubs (squares) -->
  <g fill="var(--accent,#0e7c86)">
    <rect x="60" y="110" width="20" height="20" rx="3"/><rect x="60" y="206" width="20" height="20" rx="3"/><rect x="60" y="302" width="20" height="20" rx="3"/>
  </g>
  <!-- delivery points (dots) -->
  <g fill="currentColor" opacity="0.75">
    <circle cx="312" cy="92" r="4"/><circle cx="312" cy="142" r="4"/><circle cx="312" cy="192" r="4"/><circle cx="312" cy="242" r="4"/><circle cx="312" cy="292" r="4"/><circle cx="312" cy="342" r="4"/>
  </g>
  <text x="195" y="388" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.7">3 × 6 = 18 pairs evaluated · grows quadratically</text>
  <!-- RIGHT: index probe -->
  <g transform="translate(400,0)">
    <text x="195" y="28" text-anchor="middle" font-size="14.5" font-weight="700" fill="currentColor">Index-probe join</text>
    <text x="195" y="46" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7">per-hub box seek, then distance clip</text>
    <!-- points outside the box: never read -->
    <g fill="currentColor" opacity="0.2">
      <circle cx="120" cy="92" r="4"/><circle cx="300" cy="100" r="4"/><circle cx="330" cy="170" r="4"/><circle cx="110" cy="300" r="4"/><circle cx="150" cy="350" r="4"/><circle cx="300" cy="330" r="4"/><circle cx="340" cy="260" r="4"/><circle cx="95" cy="180" r="4"/><circle cx="320" cy="350" r="4"/><circle cx="125" cy="345" r="4"/>
    </g>
    <!-- bounding box (index-seekable) -->
    <rect x="150" y="120" width="160" height="170" rx="4" fill="var(--accent,#0e7c86)" opacity="0.06"/>
    <rect x="150" y="120" width="160" height="170" rx="4" fill="none" stroke="var(--accent,#0e7c86)" stroke-width="1.6" stroke-dasharray="6 4"/>
    <text x="230" y="113" text-anchor="middle" font-size="10" fill="var(--accent,#0e7c86)" font-weight="700">bounding box · index seek</text>
    <!-- inscribed radius -->
    <circle cx="230" cy="205" r="80" fill="none" stroke="var(--accent,#0e7c86)" stroke-width="1.6"/>
    <!-- driving hub -->
    <rect x="34" y="195" width="22" height="22" rx="3" fill="var(--accent,#0e7c86)"/>
    <!-- fan-out probe lines only into the box -->
    <g stroke="var(--accent,#0e7c86)" stroke-width="1.2" opacity="0.55" marker-end="url(#joinArrow)">
      <line x1="58" y1="206" x2="214" y2="182"/><line x1="58" y1="206" x2="245" y2="200"/><line x1="58" y1="206" x2="206" y2="228"/><line x1="58" y1="206" x2="252" y2="238"/><line x1="58" y1="206" x2="198" y2="208"/>
    </g>
    <!-- read but clipped (box corners, outside circle) -->
    <g fill="none" stroke="var(--accent-coral,#ff6b6b)" stroke-width="1.6">
      <circle cx="166" cy="132" r="4"/><circle cx="296" cy="132" r="4"/><circle cx="166" cy="278" r="4"/><circle cx="296" cy="278" r="4"/>
    </g>
    <!-- survivors (within radius) -->
    <g fill="var(--accent,#0e7c86)">
      <circle cx="214" cy="182" r="4.4"/><circle cx="245" cy="200" r="4.4"/><circle cx="206" cy="228" r="4.4"/><circle cx="252" cy="238" r="4.4"/><circle cx="198" cy="208" r="4.4"/>
    </g>
    <text x="195" y="388" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.7">box seek reads few · 5 survive the distance clip</text>
  </g>
</svg>

## Prerequisites

These examples assume an async Python service talking to a Neo4j instance with native `point` support. The `point.distance()` semantics and index-backed range predicates are stable on Neo4j 5.x; the bounding-box arithmetic is pure client-side Python and version-independent. The optional Graph Data Science (GDS) path in the variants section needs the GDS plugin installed on the server.

| Requirement | Minimum version | Notes |
| --- | --- | --- |
| Python | 3.10+ | Union types and `dataclass(frozen=True)` used in examples |
| Neo4j | 5.13+ | Native `point` type, `CREATE POINT INDEX`, index-backed range predicates |
| neo4j (driver) | 5.x | Async driver (`AsyncGraphDatabase`), native point serialization |
| Neo4j GDS | 2.6+ | Only for the `gds.knn` join variant; optional |
| pytest / pytest-asyncio | 0.23+ | For the correctness assertions in the testing section |

```bash
pip install "neo4j>=5.18" "pytest>=8.0" "pytest-asyncio>=0.23"
```

A spatial join only stays cheap if both sides of the correlation are modelled for it. That means coordinates stored as native `point` values on the primitives you actually probe — the convention covered in [node and edge spatial mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/) — and the right [spatial indexing strategy](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) backing the `location` property on each label. Without an index on at least the inner (probed) side, every join below collapses to a full label scan no matter how tight the predicate reads.

## Core Concept & Mechanism

A spatial join in a graph database is fundamentally different from a raster overlay or a PostGIS `ST_DWithin` table join. There is no intermediate result table and no materialized geometry layer; the engine resolves the proximity predicate directly against node properties and writes the correlation back as relationships. That makes the join a graph-write operation, and it inherits all of graph write economics: every surviving pair becomes an edge, so cardinality is the variable that dictates whether the operation costs megabytes or gigabytes.

Neo4j stores geography with the native `point()` type, which defaults to the WGS 84 ellipsoid (SRID 4326) for latitude/longitude coordinates. The `point.distance()` function returns the great-circle distance in meters between two such points. The trap is identical to the one in [distance filter query patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/): `point.distance()` is a computed function, not an indexable property. Used alone in a `WHERE`, it gives the planner no seekable range, so it falls back to a label scan and evaluates the function once per candidate. In a join that means once per *pair* — the dreaded `O(L × R)` Cartesian product across the two labels.

The mechanism that defuses this is a **two-phase probe**. For each node on the driving (outer) side, phase one constrains the inner side with a coordinate-aligned bounding box — four range comparisons on `location.latitude` and `location.longitude` that the native point index (an R-tree variant) seeks directly via `PointIndexSeekByRange`. Phase two applies exact `point.distance()` only to the bounded survivors, clipping the square box corners back to a true circle. In a dense metro graph this collapses the per-driver candidate set by 90–99% before a single trigonometric call runs, which is the difference between an index seek and a full scan repeated for every outer node.

What makes phase one seekable is **predicate push-down**: the planner recognizes the bounding-box range comparison as index-descendable and enters the inner label through a seek rather than a scan. The deeper plan-selection and cost-model details live in [graph query planner optimization](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/); for a join, the operative rule is simply that the box must be expressed as plain range comparisons on the indexed coordinate components — anything computed per-row defeats the seek.

<svg viewBox="-8 -4 788 168" role="img" aria-labelledby="probeTitle probeDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="probeTitle">The two-phase spatial-join probe, stage by stage</title>
  <desc id="probeDesc">A left-to-right pipeline. The driving side is the indexed LogisticsHub label. Phase one seeks a per-hub bounding box with PointIndexSeekByRange on DeliveryPoint, producing a candidate set of tens of pairs rather than millions. Phase two applies exact great-circle point.distance only to those candidates. The surviving pairs are written back as bounded SERVES relationships.</desc>
  <defs>
    <marker id="probeArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7.5" markerHeight="7.5" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <!-- phase band labels -->
  <rect class="viz-backdrop" x="-8" y="-4" width="788" height="168" fill="var(--viz-bg,#ffffff)"/>
  <rect x="8" y="12" width="446" height="20" rx="10" fill="var(--accent,#0e7c86)" opacity="0.1"/>
  <text x="231" y="26" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--accent,#0e7c86)">Phase 1 — index seek (cheap, bounded)</text>
  <rect x="466" y="12" width="298" height="20" rx="10" fill="var(--accent-coral,#ff6b6b)" opacity="0.12"/>
  <text x="615" y="26" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">Phase 2 — exact distance &amp; write</text>
  <!-- box 1: driving side -->
  <g>
    <rect x="8" y="52" width="132" height="96" rx="9" fill="currentColor" opacity="0.05"/>
    <rect x="8" y="52" width="132" height="96" rx="9" fill="none" stroke="currentColor" stroke-width="1.4" opacity="0.55"/>
    <text x="74" y="88" text-anchor="middle" font-size="12.5" font-weight="700" fill="currentColor">Driving side</text>
    <text x="74" y="108" text-anchor="middle" font-size="11" fill="currentColor">LogisticsHub</text>
    <text x="74" y="124" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.7">(indexed)</text>
  </g>
  <line x1="142" y1="100" x2="158" y2="100" stroke="currentColor" stroke-width="1.6" marker-end="url(#probeArrow)"/>
  <!-- box 2: bounding box seek -->
  <g>
    <rect x="160" y="52" width="132" height="96" rx="9" fill="var(--accent,#0e7c86)" opacity="0.08"/>
    <rect x="160" y="52" width="132" height="96" rx="9" fill="none" stroke="var(--accent,#0e7c86)" stroke-width="1.8"/>
    <text x="226" y="84" text-anchor="middle" font-size="12.5" font-weight="700" fill="currentColor">Per-hub box</text>
    <text x="226" y="104" text-anchor="middle" font-size="10" fill="var(--accent,#0e7c86)" font-weight="700">PointIndexSeek</text>
    <text x="226" y="118" text-anchor="middle" font-size="10" fill="var(--accent,#0e7c86)" font-weight="700">ByRange</text>
    <text x="226" y="134" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">on DeliveryPoint</text>
  </g>
  <line x1="294" y1="100" x2="310" y2="100" stroke="currentColor" stroke-width="1.6" marker-end="url(#probeArrow)"/>
  <!-- box 3: candidate set -->
  <g>
    <rect x="312" y="52" width="132" height="96" rx="9" fill="var(--accent,#0e7c86)" opacity="0.08"/>
    <rect x="312" y="52" width="132" height="96" rx="9" fill="none" stroke="var(--accent,#0e7c86)" stroke-width="1.4"/>
    <text x="378" y="92" text-anchor="middle" font-size="12.5" font-weight="700" fill="currentColor">Candidate pairs</text>
    <text x="378" y="112" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.7">tens, not millions</text>
  </g>
  <line x1="446" y1="100" x2="462" y2="100" stroke="currentColor" stroke-width="1.6" marker-end="url(#probeArrow)"/>
  <!-- box 4: distance -->
  <g>
    <rect x="464" y="52" width="132" height="96" rx="9" fill="none" stroke="var(--accent-coral,#ff6b6b)" stroke-width="1.5"/>
    <text x="530" y="92" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">point.distance()</text>
    <text x="530" y="112" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.7">exact great-circle</text>
  </g>
  <line x1="598" y1="100" x2="614" y2="100" stroke="currentColor" stroke-width="1.6" marker-end="url(#probeArrow)"/>
  <!-- box 5: write -->
  <g>
    <rect x="616" y="52" width="148" height="96" rx="9" fill="var(--accent-coral,#ff6b6b)" opacity="0.12"/>
    <rect x="616" y="52" width="148" height="96" rx="9" fill="none" stroke="var(--accent-coral,#ff6b6b)" stroke-width="1.8"/>
    <text x="690" y="88" text-anchor="middle" font-size="12.5" font-weight="700" fill="currentColor">SERVES edge</text>
    <text x="690" y="108" text-anchor="middle" font-size="10" fill="currentColor">(hub)-[:SERVES]→(point)</text>
    <text x="690" y="124" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.7">bounded write</text>
  </g>
</svg>

## Schema & Data Model

Both labels participating in the join need a native `point` on the property you probe, and both should carry an indexed identity property so you can assert correctness and re-run the join idempotently. Store coordinates as `point({latitude, longitude})` rather than detached `lat`/`lon` numbers — only the native type is index-seekable, and only it normalizes onto the WGS 84 CRS automatically.

```cypher
// Identity + uniqueness on both sides of the join
CREATE CONSTRAINT hub_id IF NOT EXISTS
FOR (h:LogisticsHub) REQUIRE h.id IS UNIQUE;

CREATE CONSTRAINT point_id IF NOT EXISTS
FOR (p:DeliveryPoint) REQUIRE p.id IS UNIQUE;

// Point indexes on BOTH labels: the inner side must be seekable; the outer
// side benefits when the join is driven from a sub-region rather than all rows.
CREATE POINT INDEX hub_location IF NOT EXISTS
FOR (h:LogisticsHub) ON (h.location);

CREATE POINT INDEX point_location IF NOT EXISTS
FOR (p:DeliveryPoint) ON (p.location);
```

The `SERVES` relationship is the join output. Give it a `distance_m` property so downstream routing can rank by proximity without recomputing, and decide deliberately whether the join is one-to-many (each point served by its single nearest hub) or many-to-many (each point linked to every hub within radius). The cardinality of that decision is the dominant cost driver, not the geometry. For correlating graph nodes against geometry that arrives from outside the database — a fresh OSM extract or a vendor feed — the same probe is the join step at the tail of [OSM data ingestion pipelines](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/osm-data-ingestion-pipelines/) and [POI enrichment workflows](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/poi-enrichment-workflows/).

## Step-by-Step Implementation

The implementation drives the join from Python: compute bounding boxes client-side, stream the inner geometry in bounded batches, and let the engine seek. Synchronous execution in one monolithic transaction is the anti-pattern — it holds locks on the spatial index for the whole run and exhausts the connection pool under any concurrency.

**Step 1 — Compute the bounding box in Python, not Cypher.** A box derived inside Cypher with per-row trigonometry cannot be pushed down. Compute the four corners client-side from a center and radius, then pass them as scalar parameters so the range predicate stays index-seekable and the plan stays cacheable.

```python
from math import radians, cos
from dataclasses import dataclass

EARTH_RADIUS_M = 6_371_000.0

@dataclass(frozen=True)
class BBox:
    min_lat: float
    max_lat: float
    min_lon: float
    max_lon: float

def bounding_box(lat: float, lon: float, radius_m: float) -> BBox:
    """Latitude/longitude envelope that fully contains a radius_m circle.

    Latitude degrees are ~constant length; longitude degrees shrink by
    cos(latitude), so the lon delta must be widened near the poles.
    """
    lat_delta = (radius_m / EARTH_RADIUS_M) * (180.0 / 3.141592653589793)
    lon_delta = lat_delta / max(cos(radians(lat)), 1e-12)
    return BBox(lat - lat_delta, lat + lat_delta, lon - lon_delta, lon + lon_delta)
```

**Step 2 — Express the join as a two-phase Cypher query.** Phase one filters the inner label by the box (index seek); phase two clips with `point.distance()`. The `UNWIND` lets one round trip drive many outer nodes, amortizing latency.

```cypher
UNWIND $drivers AS d
MATCH (hub:LogisticsHub {id: d.hub_id})
// Phase 1: index-seekable bounding-box pre-filter on the inner label
MATCH (c:DeliveryPoint)
WHERE c.location.latitude  >= d.min_lat AND c.location.latitude  <= d.max_lat
  AND c.location.longitude >= d.min_lon AND c.location.longitude <= d.max_lon
  AND c.status = 'active'
// Phase 2: exact great-circle distance only on the bounded survivors
WITH hub, c, point.distance(hub.location, c.location) AS dist_m
WHERE dist_m <= d.max_distance_m
MERGE (hub)-[s:SERVES]->(c)
SET   s.distance_m = dist_m
```

`MERGE` rather than `CREATE` makes the join idempotent — re-running it updates `distance_m` instead of duplicating edges, which matters when the pipeline retries after a transient failure.

**Step 3 — Drive it from the async driver in bounded batches.** Each batch is its own transaction so locks are released frequently and memory stays flat. The driver manages the connection lifecycle; you own the batching and the bounding-box precomputation.

```python
import asyncio
import neo4j
from typing import Iterable
from dataclasses import dataclass

@dataclass(frozen=True)
class SpatialJoinConfig:
    uri: str
    auth: tuple[str, str]
    batch_size: int = 1_000
    max_distance_m: float = 5_000.0
    pool_size: int = 12

JOIN_CYPHER = """
UNWIND $drivers AS d
MATCH (hub:LogisticsHub {id: d.hub_id})
MATCH (c:DeliveryPoint)
WHERE c.location.latitude  >= d.min_lat AND c.location.latitude  <= d.max_lat
  AND c.location.longitude >= d.min_lon AND c.location.longitude <= d.max_lon
  AND c.status = 'active'
WITH hub, c, point.distance(hub.location, c.location) AS dist_m
WHERE dist_m <= d.max_distance_m
MERGE (hub)-[s:SERVES]->(c)
SET   s.distance_m = dist_m
RETURN count(s) AS edges
"""

def _driver_rows(hubs: list[dict], cfg: SpatialJoinConfig) -> list[dict]:
    rows = []
    for h in hubs:
        box = bounding_box(h["lat"], h["lon"], cfg.max_distance_m)
        rows.append({
            "hub_id": h["id"],
            "min_lat": box.min_lat, "max_lat": box.max_lat,
            "min_lon": box.min_lon, "max_lon": box.max_lon,
            "max_distance_m": cfg.max_distance_m,
        })
    return rows

async def run_spatial_join(cfg: SpatialJoinConfig, hubs: list[dict]) -> int:
    driver = neo4j.AsyncGraphDatabase.driver(
        cfg.uri, auth=cfg.auth, max_connection_pool_size=cfg.pool_size
    )
    total = 0
    try:
        for i in range(0, len(hubs), cfg.batch_size):
            batch = _driver_rows(hubs[i:i + cfg.batch_size], cfg)
            async with driver.session() as session:
                summary = await session.execute_write(_apply_batch, batch)
                total += summary
    finally:
        await driver.close()
    return total

async def _apply_batch(tx: neo4j.AsyncManagedTransaction, drivers: list[dict]) -> int:
    result = await tx.run(JOIN_CYPHER, drivers=drivers)
    record = await result.single()
    return record["edges"] if record else 0
```

Using `session.execute_write` rather than a hand-rolled `begin_transaction` gives you the driver's built-in retry on transient (deadlock, leader-switch) errors for free, while still bounding each unit of work to one batch.

## Query Patterns & Variants

Three join shapes cover almost every production need. Pick by the cardinality you actually want, because that — not syntax — sets the cost.

**Variant A — Radius (many-to-many).** Every inner node within `max_distance_m` of a driver becomes an edge. This is the query in the implementation above. Use it for coverage and service-zone modelling where one point legitimately belongs to several hubs. Watch cardinality: in a dense center a single hub can match tens of thousands of points, so always pair it with a sane radius and a status predicate.

**Variant B — Nearest-one (one-to-many).** Snap each inner node to its single closest driver — the canonical "assign each delivery to its nearest hub" join. Keep the bounding box for the seek, then order and limit per driver group.

```cypher
UNWIND $drivers AS d
MATCH (hub:LogisticsHub {id: d.hub_id})
MATCH (c:DeliveryPoint)
WHERE c.location.latitude  >= d.min_lat AND c.location.latitude  <= d.max_lat
  AND c.location.longitude >= d.min_lon AND c.location.longitude <= d.max_lon
WITH c, hub, point.distance(hub.location, c.location) AS dist_m
ORDER BY dist_m ASC
WITH c, head(collect({hub: hub, dist: dist_m})) AS nearest
MERGE (nearest.hub)-[s:SERVES]->(c)
SET   s.distance_m = nearest.dist
```

Note the `collect` + `head` idiom selects the minimum per inner node without a correlated subquery. For a true k-nearest assignment (closest *k* hubs per point), this is exactly the boundary where you switch to the dedicated [k-nearest-neighbor routing](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/k-nearest-neighbor-routing/) technique rather than over-extending a join.

**Variant C — GDS KNN join.** When you need k-nearest across the *entire* graph at once rather than from a hand-supplied driver set, project both labels and let GDS compute a similarity join on the coordinate vector. This trades the per-batch control of the Cypher path for one bulk parallel pass — appropriate for periodic full rebuilds, not incremental updates.

```cypher
CALL gds.graph.project(
  'serve-join',
  ['LogisticsHub', 'DeliveryPoint'],
  '*',
  { nodeProperties: ['embedding'] }   // [latitude, longitude] as a 2-vector
)
YIELD graphName;

CALL gds.knn.write('serve-join', {
  nodeProperties: ['embedding'],
  topK: 3,
  writeRelationshipType: 'SERVES',
  writeProperty: 'similarity',
  sampleRate: 0.8
})
YIELD relationshipsWritten;
```

GDS KNN works on a similarity metric over the property vector, not great-circle meters, so it is an approximation of geographic nearest unless you convert results back to distance. Treat it as a fast first pass and validate against `point.distance()` if exact radii matter.

## Performance Tuning

Profile every join before trusting it. Run `PROFILE` on a representative batch and read the plan from the bottom up: the inner-label access must be a `PointIndexSeekByRange` (or `PointIndexSeekByPrefix`). If you see `NodeByLabelScan` feeding a `Filter`, push-down failed — the usual causes are a missing point index, coordinates stored as raw numbers instead of `point`, or a bounding box computed per-row in Cypher instead of passed as parameters. This is the same PROFILE-driven loop documented in [Cypher performance tuning](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/).

The cost of a correctly index-bound join is dominated by output cardinality. For a radius join the expected work per driver scales with the candidate count inside the box, roughly:

$$
C_\text{driver} \approx \rho \cdot \pi r^2 \cdot \frac{4}{\pi} = \rho \cdot 4 r^2
$$

where $\rho$ is inner-node density (nodes per m²) and $r$ is the radius — the box is $\frac{4}{\pi}$ larger than the inscribed circle, which is why the phase-two distance clip removes roughly 21% of box survivors. Total join cost is $C_\text{driver}$ summed over all drivers, so halving the radius quarters the work. The practical levers:

- **Right-size the batch.** Start at 1,000 drivers per transaction and tune against transaction-log growth. Larger batches amortize round-trip latency but hold locks longer and raise peak heap.
- **Keep R-tree leaves resident.** Spatial joins are page-cache hungry; size `server.memory.pagecache.size` to hold the inner label's index, and watch `dbms.memory.heap.max_size` during bulk runs.
- **Partition drivers by geography.** Grouping batches by region keeps each transaction's index reads spatially local, reducing page-cache churn — the same partitioning that high-throughput ingestion uses.
- **Add a selective property predicate early.** A `status = 'active'` or `tenant_id` filter on the inner label shrinks survivors before the distance call and, if backed by its own index, can intersect with the point seek.

## Edge Cases & Gotchas

- **Antimeridian and pole wrap.** A bounding box that straddles ±180° longitude produces `min_lon > max_lon`, and the naive range predicate silently returns nothing. Detect the wrap in Python and split into two boxes (`>= min_lon` OR `<= max_lon`). Near the poles, the `cos(latitude)` longitude widening blows up — clamp the longitude delta to ±180° rather than dividing by a near-zero cosine.
- **CRS drift.** Mixing coordinate reference systems is the classic silent corruptor. If some nodes were ingested as Cartesian `point({x, y})` and others as WGS 84 `point({latitude, longitude})`, `point.distance()` either errors or returns meaningless values. Normalize everything to EPSG:4326 at ingestion, conforming to the [OGC Simple Features specification](https://www.ogc.org/standards/sfa).
- **Coordinate precision traps.** Storing coordinates as truncated floats (5 decimal places ≈ 1.1 m) is usually fine, but down-casting to `float32` somewhere in the Python path introduces meter-scale jitter that flips edges in and out near the radius boundary. Keep the full `float64` precision the driver gives you.
- **Cartesian explosion from a missing anchor.** If the driving `MATCH` fails to bind a single hub (typo'd label, wrong id), the inner `MATCH` runs unanchored against the whole label — the exact O(L × R) blow-up the pattern exists to prevent. Always anchor the driver by a unique, constrained id.
- **GDS projection staleness.** A projected graph is a snapshot. Edges written by a Cypher join *after* projection are invisible to a subsequent `gds.knn` run, and points added after projection are missing entirely. Re-project before each GDS pass, and drop the named graph afterward to free heap.

## Verification & Testing

A spatial join is only correct if every written edge genuinely satisfies the predicate and no qualifying pair was missed. Assert both directions: recompute distance for a sample of written edges in Python and confirm it is within radius, and spot-check that a known close pair actually produced an edge.

```python
import math
import pytest
import neo4j

def haversine_m(a: tuple[float, float], b: tuple[float, float]) -> float:
    R = 6_371_000.0
    (lat1, lon1), (lat2, lon2) = a, b
    dlat, dlon = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    h = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2))
         * math.sin(dlon / 2) ** 2)
    return R * 2 * math.asin(math.sqrt(h))

@pytest.mark.asyncio
async def test_every_served_edge_within_radius(driver: neo4j.AsyncDriver):
    max_m = 5_000.0
    query = """
    MATCH (h:LogisticsHub)-[s:SERVES]->(c:DeliveryPoint)
    RETURN h.location.latitude AS hlat, h.location.longitude AS hlon,
           c.location.latitude AS clat, c.location.longitude AS clon,
           s.distance_m AS stored
    LIMIT 5000
    """
    async with driver.session() as session:
        result = await session.run(query)
        async for r in result:
            recomputed = haversine_m((r["hlat"], r["hlon"]), (r["clat"], r["clon"]))
            # No edge should exceed the radius...
            assert recomputed <= max_m + 1.0
            # ...and the stored distance must match the geometry within 0.5%.
            assert abs(recomputed - r["stored"]) <= 0.005 * recomputed
```

For completeness, count expected versus actual edges on a small fixture where you know the answer by hand, and assert no duplicate `SERVES` edges exist between any pair (`MATCH (h)-[s:SERVES]->(c) WITH h, c, count(s) AS n WHERE n > 1 RETURN count(*)` must return 0). The duplicate check is what catches a `CREATE` that should have been a `MERGE`.

## FAQ

<details>
<summary>Why does my spatial join blow up to O(n²) even with an index?</summary>

Because the inner `MATCH` is not being seeked. Two common causes: the driving node never binds (wrong id or label), so the inner label runs unanchored against every node; or the proximity predicate is only `point.distance(...) <= r` with no bounding-box range comparison ahead of it. Add the four-corner box on `location.latitude`/`location.longitude`, anchor the driver by a unique constrained id, and confirm a `POINT INDEX` exists on the inner label. `PROFILE` should show `PointIndexSeekByRange`, not `NodeByLabelScan` feeding a `Filter`.
</details>

<details>
<summary>Should I use CREATE or MERGE for the join edges?</summary>

Use `MERGE` in any pipeline that can retry. `CREATE` writes a fresh `SERVES` edge every run, so a transient failure that triggers a re-run leaves duplicate edges that corrupt downstream counts and routing weights. `MERGE` is idempotent — it updates `distance_m` on the existing edge instead. The small cost is a uniqueness check per pair, which is negligible next to the distance math.
</details>

<details>
<summary>Plain Cypher join or GDS KNN — which should I reach for?</summary>

Use the two-phase Cypher join for incremental, driver-supplied, exact-radius work where you control batching and want great-circle meters. Use `gds.knn` for periodic full-graph rebuilds where you want the k-nearest across every node in one parallel pass and can tolerate a similarity approximation. GDS operates on a projected snapshot and on a similarity metric, not live meters, so validate its output against `point.distance()` whenever exact radii matter.
</details>

<details>
<summary>How big should each join batch be?</summary>

Start at roughly 1,000 driving nodes per transaction and tune from the transaction-log growth and peak heap you observe. Larger batches amortize network round trips but hold index locks longer and raise memory pressure; smaller batches release locks sooner and keep memory flat at the cost of more round trips. Because the join is a write, the batch size that works depends on output cardinality, not just input count — a radius join in a dense center may need far smaller batches than the same query in a rural region.
</details>

<details>
<summary>My join misses points near the date line. What is wrong?</summary>

Your bounding box straddles the ±180° antimeridian, so it has `min_lon > max_lon` and the simple `>=`/`<=` range matches nothing. Detect the wrap when you compute the box in Python and split it into two predicates joined by `OR` (one running up to +180°, one from −180°). The same care applies near the poles, where the `cos(latitude)` longitude widening must be clamped to ±180° rather than dividing by a near-zero cosine.
</details>

## Related

- [Index-Probe Spatial Joins in Cypher](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/spatial-join-techniques/index-probe-spatial-joins-in-cypher/) — the nested-index-loop join that replaces a Cartesian product with per-row index seeks.
- [Snapping GPS Telemetry to Road Segments](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/spatial-join-techniques/snapping-gps-telemetry-to-road-segments/) — map-matching noisy fixes to the nearest segment by perpendicular distance.
- [Distance Filter Query Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/) — the bounding-box-then-distance predicate that every join phase one depends on.
- [K-Nearest-Neighbor Routing](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/k-nearest-neighbor-routing/) — when nearest-k assignment outgrows a join and needs a dedicated technique.
- [Cypher Performance Tuning](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/) — the PROFILE-driven loop for keeping the join's inner access index-bound.
- [Spatial Indexing Strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) — choosing the point index that makes the join seekable on both sides.
- [OSM Data Ingestion Pipelines](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/osm-data-ingestion-pipelines/) — where the join step attaches freshly ingested geometry to the existing graph.

This guide is part of [Cypher Spatial Queries & Pathfinding Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/).

For authoritative reference on native spatial functions and geometry standards, consult the [Neo4j Cypher Spatial Functions Documentation](https://neo4j.com/docs/cypher-manual/current/functions/spatial/), the [Neo4j GDS KNN documentation](https://neo4j.com/docs/graph-data-science/current/algorithms/knn/), and the [OGC Simple Features Specification](https://www.ogc.org/standards/sfa).

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "Why does my spatial join blow up to O(n squared) even with an index?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Because the inner MATCH is not being seeked. Two common causes: the driving node never binds (wrong id or label) so the inner label runs unanchored against every node; or the proximity predicate is only point.distance() with no bounding-box range comparison ahead of it. Add the four-corner box on location.latitude and location.longitude, anchor the driver by a unique constrained id, and confirm a POINT INDEX exists on the inner label. PROFILE should show PointIndexSeekByRange, not NodeByLabelScan feeding a Filter."
      }
    },
    {
      "@type": "Question",
      "name": "Should I use CREATE or MERGE for the join edges?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Use MERGE in any pipeline that can retry. CREATE writes a fresh SERVES edge every run, so a transient failure that triggers a re-run leaves duplicate edges that corrupt downstream counts and routing weights. MERGE is idempotent, updating distance_m on the existing edge instead. The small cost is a uniqueness check per pair, which is negligible next to the distance math."
      }
    },
    {
      "@type": "Question",
      "name": "Plain Cypher join or GDS KNN, which should I reach for?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Use the two-phase Cypher join for incremental, driver-supplied, exact-radius work where you control batching and want great-circle meters. Use gds.knn for periodic full-graph rebuilds where you want the k-nearest across every node in one parallel pass and can tolerate a similarity approximation. GDS operates on a projected snapshot and on a similarity metric, not live meters, so validate its output against point.distance() whenever exact radii matter."
      }
    },
    {
      "@type": "Question",
      "name": "How big should each join batch be?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Start at roughly 1,000 driving nodes per transaction and tune from the transaction-log growth and peak heap you observe. Larger batches amortize network round trips but hold index locks longer and raise memory pressure; smaller batches release locks sooner and keep memory flat at the cost of more round trips. Because the join is a write, the right batch size depends on output cardinality, not just input count."
      }
    },
    {
      "@type": "Question",
      "name": "My join misses points near the date line. What is wrong?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Your bounding box straddles the plus-or-minus 180 degree antimeridian, so it has min_lon greater than max_lon and the simple range matches nothing. Detect the wrap when you compute the box in Python and split it into two predicates joined by OR, one running up to plus 180 and one from minus 180. The same care applies near the poles, where the cosine-of-latitude longitude widening must be clamped to plus-or-minus 180 rather than dividing by a near-zero cosine."
      }
    }
  ]
}
</script>
