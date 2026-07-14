---
pageTitle: Index-Probe Spatial Joins
title: Index-Probe Spatial Joins in Cypher
description: Join two spatial datasets in Neo4j with a per-row bounding-box index probe instead of a Cartesian product, and read the plan difference in PROFILE
slug: index-probe-spatial-joins-in-cypher
type: article
breadcrumb: Index-Probe Joins
datePublished: 2026-07-14
dateModified: 2026-07-14
---
# Index-Probe Spatial Joins in Cypher

The symptom is a batch job that maps a few thousand pickup events to their nearest road nodes in staging in under a second, then wedges for minutes and blows the heap the first time a full day of events lands. The root cause is almost always a single query shape: two labels correlated with a comma-separated `MATCH` and a `point.distance()` predicate, which the planner resolves as a `CartesianProduct` — every event paired with every road node before a single pair is rejected. The work grows as the product of the two label sizes, so an input that doubles quadruples the cost. This page resolves it with a *nested-index-loop* join: drive one row at a time from the outer (event) side and probe the inner (road node) side through a bounding-box index seek, so each driving row touches only the handful of candidates geometrically near it. This is the focused mechanic behind the broader [spatial join techniques](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/spatial-join-techniques/) collection.

## Prerequisites & Versions

The probe relies on native `point` support and index-backed range predicates, both stable on Neo4j 5.x. The bounding-box arithmetic is pure client-side Python. No APOC or GDS dependency is needed.

| Requirement | Minimum version | Note |
| --- | --- | --- |
| Python | 3.10+ | `dataclass` and union syntax used below |
| Neo4j | 5.13+ | Native `point`, `CREATE POINT INDEX`, `PointIndexSeekByRange` |
| neo4j (driver) | 5.x | `AsyncGraphDatabase`, native point serialization |

```bash
pip install "neo4j>=5.18"
```

The probe only stays index-bound if the inner label carries a native `point` index on the property you seek — the convention set out in [node and edge spatial mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/) and backed by a deliberate [spatial indexing strategy](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/). Without it, every probe below degrades to a full label scan repeated once per driving row — strictly worse than the Cartesian product it was meant to replace.

```cypher
CREATE POINT INDEX road_node_location IF NOT EXISTS
FOR (n:RoadNode) ON (n.location);

CREATE CONSTRAINT pickup_id IF NOT EXISTS
FOR (e:PickupEvent) REQUIRE e.id IS UNIQUE;
```

## Implementation

The join reads as: for each `PickupEvent`, seek the `RoadNode` label through a per-event bounding box, then keep the single nearest survivor inside the radius. The box comes from Python as scalar parameters so the range predicate is index-seekable; the exact `point.distance()` clip runs only on the bounded candidates.

```cypher
UNWIND $events AS ev
MATCH (e:PickupEvent {id: ev.id})               // outer: one anchored driving row
MATCH (n:RoadNode)                              // inner: probed via the box below
WHERE n.location.latitude  >= ev.min_lat AND n.location.latitude  <= ev.max_lat
  AND n.location.longitude >= ev.min_lon AND n.location.longitude <= ev.max_lon
WITH e, n, point.distance(e.location, n.location) AS dist_m
WHERE dist_m <= ev.radius_m
WITH e, n, dist_m ORDER BY dist_m ASC
WITH e, collect({node_id: n.id, dist_m: dist_m})[0] AS nearest
RETURN e.id AS event_id, nearest.node_id AS node_id, nearest.dist_m AS dist_m
```

<svg viewBox="0 0 780 400" role="img" aria-labelledby="ipTitle ipDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="ipTitle">Cartesian product matrix versus a per-row index probe</title>
  <desc id="ipDesc">Two matrices with six driving rows and eight inner columns. Left: a comma-separated MATCH resolves to a CartesianProduct, so every one of the forty-eight cells is evaluated. Right: an anchored MATCH resolves to an Apply operator whose inner side is a PointIndexSeekByRange, so each row evaluates only the two candidate cells inside its bounding box while the rest are never read.</desc>
  <line x1="390" y1="70" x2="390" y2="360" stroke="currentColor" stroke-width="1" stroke-dasharray="3 6" opacity="0.3"/>
  <!-- LEFT: cartesian -->
  <text x="190" y="28" text-anchor="middle" font-size="14.5" font-weight="700" fill="currentColor">Comma MATCH → CartesianProduct</text>
  <text x="190" y="46" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7">every event × every node, then filter</text>
  <g fill="var(--accent-coral,#ff6b6b)" opacity="0.85">
    <circle cx="60" cy="96" r="6"/><circle cx="98" cy="96" r="6"/><circle cx="136" cy="96" r="6"/><circle cx="174" cy="96" r="6"/><circle cx="212" cy="96" r="6"/><circle cx="250" cy="96" r="6"/><circle cx="288" cy="96" r="6"/><circle cx="326" cy="96" r="6"/>
    <circle cx="60" cy="136" r="6"/><circle cx="98" cy="136" r="6"/><circle cx="136" cy="136" r="6"/><circle cx="174" cy="136" r="6"/><circle cx="212" cy="136" r="6"/><circle cx="250" cy="136" r="6"/><circle cx="288" cy="136" r="6"/><circle cx="326" cy="136" r="6"/>
    <circle cx="60" cy="176" r="6"/><circle cx="98" cy="176" r="6"/><circle cx="136" cy="176" r="6"/><circle cx="174" cy="176" r="6"/><circle cx="212" cy="176" r="6"/><circle cx="250" cy="176" r="6"/><circle cx="288" cy="176" r="6"/><circle cx="326" cy="176" r="6"/>
    <circle cx="60" cy="216" r="6"/><circle cx="98" cy="216" r="6"/><circle cx="136" cy="216" r="6"/><circle cx="174" cy="216" r="6"/><circle cx="212" cy="216" r="6"/><circle cx="250" cy="216" r="6"/><circle cx="288" cy="216" r="6"/><circle cx="326" cy="216" r="6"/>
    <circle cx="60" cy="256" r="6"/><circle cx="98" cy="256" r="6"/><circle cx="136" cy="256" r="6"/><circle cx="174" cy="256" r="6"/><circle cx="212" cy="256" r="6"/><circle cx="250" cy="256" r="6"/><circle cx="288" cy="256" r="6"/><circle cx="326" cy="256" r="6"/>
    <circle cx="60" cy="296" r="6"/><circle cx="98" cy="296" r="6"/><circle cx="136" cy="296" r="6"/><circle cx="174" cy="296" r="6"/><circle cx="212" cy="296" r="6"/><circle cx="250" cy="296" r="6"/><circle cx="288" cy="296" r="6"/><circle cx="326" cy="296" r="6"/>
  </g>
  <text x="190" y="346" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.8">6 × 8 = 48 pairs · cost = N × M</text>
  <text x="190" y="364" text-anchor="middle" font-size="10" fill="var(--accent-coral,#ff6b6b)" opacity="0.9">doubling input quadruples work</text>
  <!-- RIGHT: index probe -->
  <g transform="translate(400,0)">
    <text x="190" y="28" text-anchor="middle" font-size="14.5" font-weight="700" fill="currentColor">Anchored MATCH → Apply + seek</text>
    <text x="190" y="46" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7">per row: box seek → k candidates</text>
    <!-- faded (never read) -->
    <g fill="currentColor" opacity="0.16">
      <circle cx="60" cy="96" r="6"/><circle cx="98" cy="96" r="6"/><circle cx="212" cy="96" r="6"/><circle cx="250" cy="96" r="6"/><circle cx="288" cy="96" r="6"/><circle cx="326" cy="96" r="6"/>
      <circle cx="60" cy="136" r="6"/><circle cx="136" cy="136" r="6"/><circle cx="174" cy="136" r="6"/><circle cx="212" cy="136" r="6"/><circle cx="288" cy="136" r="6"/><circle cx="326" cy="136" r="6"/>
      <circle cx="60" cy="176" r="6"/><circle cx="98" cy="176" r="6"/><circle cx="136" cy="176" r="6"/><circle cx="250" cy="176" r="6"/><circle cx="288" cy="176" r="6"/><circle cx="326" cy="176" r="6"/>
      <circle cx="98" cy="216" r="6"/><circle cx="136" cy="216" r="6"/><circle cx="174" cy="216" r="6"/><circle cx="212" cy="216" r="6"/><circle cx="250" cy="216" r="6"/><circle cx="326" cy="216" r="6"/>
      <circle cx="60" cy="256" r="6"/><circle cx="98" cy="256" r="6"/><circle cx="174" cy="256" r="6"/><circle cx="212" cy="256" r="6"/><circle cx="250" cy="256" r="6"/><circle cx="288" cy="256" r="6"/>
      <circle cx="60" cy="296" r="6"/><circle cx="136" cy="296" r="6"/><circle cx="174" cy="296" r="6"/><circle cx="212" cy="296" r="6"/><circle cx="288" cy="296" r="6"/><circle cx="326" cy="296" r="6"/>
    </g>
    <!-- probed candidates (2 per row) -->
    <g fill="var(--accent,#0e7c86)">
      <circle cx="136" cy="96" r="6.4"/><circle cx="174" cy="96" r="6.4"/>
      <circle cx="98" cy="136" r="6.4"/><circle cx="250" cy="136" r="6.4"/>
      <circle cx="174" cy="176" r="6.4"/><circle cx="212" cy="176" r="6.4"/>
      <circle cx="60" cy="216" r="6.4"/><circle cx="288" cy="216" r="6.4"/>
      <circle cx="136" cy="256" r="6.4"/><circle cx="326" cy="256" r="6.4"/>
      <circle cx="98" cy="296" r="6.4"/><circle cx="250" cy="296" r="6.4"/>
    </g>
    <text x="190" y="346" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.8">≈ 6 × 2 = 12 pairs · cost = N × k</text>
    <text x="190" y="364" text-anchor="middle" font-size="10" fill="var(--accent,#0e7c86)" opacity="0.95">k set by local density, not by M</text>
  </g>
</svg>

Driven from a pooled async service, the whole join is one coroutine that precomputes each event's box and streams the driving rows in bounded batches. Each batch is its own read transaction, so the connection is released promptly and peak memory stays flat regardless of how many events arrive.

```python
import asyncio
import math
from dataclasses import dataclass
from neo4j import AsyncGraphDatabase, AsyncDriver

EARTH_RADIUS_M = 6_371_008.8  # mean WGS84 radius


def box_deltas(lat: float, radius_m: float) -> tuple[float, float]:
    """Latitude/longitude half-extents (degrees) enclosing a radius_m circle."""
    d_lat = math.degrees(radius_m / EARTH_RADIUS_M)
    d_lon = math.degrees(radius_m / (EARTH_RADIUS_M * math.cos(math.radians(lat))))
    return d_lat, d_lon


PROBE = """
UNWIND $events AS ev
MATCH (e:PickupEvent {id: ev.id})
MATCH (n:RoadNode)
WHERE n.location.latitude  >= ev.min_lat AND n.location.latitude  <= ev.max_lat
  AND n.location.longitude >= ev.min_lon AND n.location.longitude <= ev.max_lon
WITH e, n, point.distance(e.location, n.location) AS dist_m
WHERE dist_m <= ev.radius_m
WITH e, n, dist_m ORDER BY dist_m ASC
WITH e, collect({node_id: n.id, dist_m: dist_m})[0] AS nearest
RETURN e.id AS event_id, nearest.node_id AS node_id, nearest.dist_m AS dist_m
"""


@dataclass(frozen=True)
class ProbeConfig:
    batch_size: int = 500
    radius_m: float = 60.0


def _driver_rows(events: list[dict], cfg: ProbeConfig) -> list[dict]:
    rows = []
    for e in events:
        d_lat, d_lon = box_deltas(e["lat"], cfg.radius_m)
        rows.append({
            "id": e["id"], "radius_m": cfg.radius_m,
            "min_lat": e["lat"] - d_lat, "max_lat": e["lat"] + d_lat,
            "min_lon": e["lon"] - d_lon, "max_lon": e["lon"] + d_lon,
        })
    return rows


async def _run_batch(tx, events: list[dict]) -> list[dict]:
    result = await tx.run(PROBE, events=events)
    return [r.data() async for r in result]


async def snap_events_to_nodes(driver: AsyncDriver, events: list[dict],
                               cfg: ProbeConfig = ProbeConfig()) -> list[dict]:
    matched: list[dict] = []
    for i in range(0, len(events), cfg.batch_size):
        rows = _driver_rows(events[i:i + cfg.batch_size], cfg)
        async with driver.session() as session:
            matched.extend(await session.execute_read(_run_batch, rows))
    return matched


async def main():
    driver = AsyncGraphDatabase.driver(
        "neo4j+s://your-cluster.databases.neo4j.io",
        auth=("neo4j", "secure-password"),
        max_connection_pool_size=20,
        connection_acquisition_timeout=5.0,
    )
    events = [
        {"id": "evt-8801", "lat": 41.8781, "lon": -87.6298},  # Chicago Loop
        {"id": "evt-8802", "lat": 41.8850, "lon": -87.6228},
    ]
    try:
        rows = await snap_events_to_nodes(driver, events)
        for r in rows:
            print(f"{r['event_id']} -> {r['node_id']} ({r['dist_m']:.1f} m)")
    finally:
        await driver.close()


if __name__ == "__main__":
    asyncio.run(main())
```

## How It Works

The performance turns entirely on which operator the planner picks to correlate the two labels, and that is decided by how the second `MATCH` is written.

- **Two anchored `MATCH` clauses, not one comma clause.** Binding `e` first, then opening a *separate* `MATCH (n:RoadNode)` whose `WHERE` references the outer row's box parameters, tells the planner the inner side depends on the outer row. It compiles to an `Apply` operator (a nested loop) whose right child is a `PointIndexSeekByRange` re-executed per outer row. A single `MATCH (e), (n)` with no shared variable gives the planner no dependency to exploit, so it falls back to `CartesianProduct`.
- **The box is a parameter, not a computation.** Because `ev.min_lat` … `ev.max_lon` arrive as scalars, the inner range predicate is sargable and descends into the point index. A box derived inside Cypher with per-row trigonometry cannot push down — the seek reverts to a scan.
- **Aggregation selects the nearest without a subquery.** After the distance clip, `WITH e, n, dist_m ORDER BY dist_m` followed by `collect(...)[0]` groups by `e` and keeps its closest node. `collect` respects the incoming order, so the first element is the minimum — no correlated subquery, no second pass.

Confirm the shape with `PROFILE`. The healthy plan shows an `Apply` whose right branch is `PointIndexSeekByRange` on `road_node_location`, fed by the `UNWIND`/anchor on the left. The pathological plan shows a `CartesianProduct` with a trailing `Filter` on `point.distance` — the exact anti-pattern dismantled in [eliminating cartesian products in spatial Cypher](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/eliminating-cartesian-products-in-spatial-cypher/).

## Common Failure Patterns

**1. Accidental `CartesianProduct` from a comma-separated `MATCH`.** The classic. Two labels named in one clause with no shared variable force an all-pairs product:

```cypher
// ANTI-PATTERN: no dependency between e and n → CartesianProduct
MATCH (e:PickupEvent), (n:RoadNode)
WHERE point.distance(e.location, n.location) <= 60
RETURN e.id, n.id
```

Split it into two `MATCH` clauses and give the inner one an index-seekable box predicate that references the outer row, as in the implementation. `PROFILE` should replace `CartesianProduct` with `Apply` + `PointIndexSeekByRange`.

**2. Probing without an index.** If no `POINT INDEX` backs `RoadNode.location`, the box predicate is still correct but the inner access is a `NodeByLabelScan` re-run for *every* driving row — an N-times-full-scan that is slower than the Cartesian product it replaced. Verify the index is `ONLINE` before trusting the query:

```cypher
SHOW INDEXES YIELD name, type, state, properties
WHERE 'location' IN properties;   -- state must read ONLINE
```

**3. Exploding fan-out.** Even with a clean seek, an over-wide radius in a dense center pairs each event with thousands of nodes, and if you keep them all the result set — not the scan — becomes the bottleneck. Bound the fan-out explicitly: keep the radius tight, add a selective inner predicate (`n.routable = true`) so fewer candidates survive, and reduce to the nearest with `collect(...)[0]` rather than returning the whole candidate list unless you genuinely need it.

## Performance Notes

The two plans have fundamentally different cost curves. The Cartesian product evaluates every pair:

$$C_\text{cartesian} = N \cdot M$$

for $N$ driving rows and $M$ inner nodes — quadratic in dataset scale. The index probe instead pays a per-row seek plus the candidates that fall inside each box:

$$C_\text{probe} \approx N \cdot \big(\log M + \rho \cdot 4r^2\big)$$

where $\rho$ is inner-node density (nodes per m²) and $r$ the radius. The `4r²` term is the square box area; the distance clip trims it back toward the inscribed circle $\pi r^2$. Because the candidate count $k \approx \rho \cdot 4r^2$ depends on *local density and radius*, not on $M$, the probe scales with input size while the Cartesian product scales with the product. Halving the radius quarters $k$. In practice, keep batches around 500 driving rows, size the page cache to hold the inner label's point index so each seek stays in memory, and partition batches by region so successive seeks reuse warm index pages.

## Related

- [Spatial Join Techniques](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/spatial-join-techniques/) — the full set of join shapes this per-row probe belongs to.
- [Eliminating Cartesian Products in Spatial Cypher](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/eliminating-cartesian-products-in-spatial-cypher/) — diagnosing and rewriting the accidental product this page joins against.
- [Distance Filter Query Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/) — the box-then-distance predicate each probe reuses.
- [Spatial Indexing Strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) — the point index that makes the inner seek possible.

This guide is part of [Spatial Join Techniques](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/spatial-join-techniques/), within the broader [Cypher Spatial Queries & Pathfinding Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/) knowledge base.

For authoritative reference on native spatial functions and query planning, consult the [Neo4j Cypher Spatial Functions Documentation](https://neo4j.com/docs/cypher-manual/current/functions/spatial/) and the [Neo4j execution plan operators reference](https://neo4j.com/docs/cypher-manual/current/planning-and-tuning/operators/).
