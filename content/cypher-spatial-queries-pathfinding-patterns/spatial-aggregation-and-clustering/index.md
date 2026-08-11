---
pageTitle: Spatial Aggregation & Clustering
title: Spatial Aggregation and Clustering in Cypher
description: Group millions of spatial nodes into cells, regions and density clusters without a per-row geometry scan, and keep the aggregation index-seekable.
slug: spatial-aggregation-and-clustering
type: article
breadcrumb: Aggregation & Clustering
datePublished: 2026-08-11
dateModified: 2026-08-11
---
# Spatial Aggregation and Clustering in Cypher

Counting is where a spatial graph stops being a routing engine and starts being an analytics one, and it is where the index-first discipline that makes routing fast quietly stops applying. A distance filter narrows to a handful of candidates and the exact geometry runs on those; an aggregation has no such narrowing — "how many deliveries per district" touches every delivery by definition. Write it the obvious way and the query computes a polygon containment test per row over the whole label, materialises the result on the heap to group it, and turns a dashboard tile into a four-minute query that also evicts the page cache the routing endpoint was using. This topic covers the shapes that avoid that: precomputing the grouping key so the aggregation is a scan over an indexed integer rather than a geometry test, and reaching for a real clustering algorithm only where a grid genuinely cannot answer the question.

## Prerequisites

The grid arithmetic is pure Python. The clustering section needs the Graph Data Science library; everything else is plain Cypher.

| Requirement | Minimum version | Install |
| --- | --- | --- |
| Python | 3.11 | — |
| neo4j (async driver) | 5.20 | `pip install "neo4j>=5.20"` |
| Neo4j Server | 5.15 | native `point`, range and point indexes |
| Graph Data Science | 2.6 | `pip install graphdatascience` (optional) |
| h3 | 4.1 | `pip install h3` (optional, for hexagonal cells) |

## Core Concept & Mechanism

Every spatial aggregation is a `GROUP BY` over a key that does not exist yet. The whole design question is when that key gets computed.

**Computed per row at query time**, the key is a polygon containment test or a coordinate truncation evaluated once per node. There is nothing for an index to seek, because the grouping expression is not a stored property — the planner has no choice but a label scan followed by a projection followed by an `EagerAggregation` that materialises every row before it can emit a count. The cost is linear in the label and the constant factor is a geometry call.

**Computed once at write time and stored**, the key is an ordinary indexed integer. The same aggregation becomes a scan over an index-ordered property, the geometry has already been paid for, and the group-by is a counting pass rather than a geometric one. The trade is that the key must be maintained: a node whose coordinate changes needs its cell recomputed, which is one more thing for the [attribute synchronization](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/attribute-synchronization-techniques/) path to keep honest.

The second shape is nearly always right for a dashboard and nearly always wrong for an ad-hoc question, and the reason is resolution. A stored cell key fixes the resolution at write time. Aggregating to a coarser level is free — coarser cells are prefixes or divisions of finer ones — but a finer level than you stored is not recoverable without going back to the geometry. So the resolution decision is really a decision about which questions the system will be able to answer cheaply, and it is worth making deliberately rather than defaulting to whatever the first dashboard needed.

There is a third shape worth naming, because reaching for it too early is the most common mistake in this area. **Density clustering** — grouping points by proximity to each other rather than by membership of a fixed cell — answers a genuinely different question. A grid tells you how many deliveries fell in each square; a cluster tells you where the deliveries actually concentrate, regardless of where the squares happen to fall. Grids are cheap, stable and comparable across time; clusters are expensive, resolution-free and move when the data moves. Use a grid unless the square boundaries are themselves the problem.

<svg viewBox="0 0 780 320" role="img" aria-labelledby="aggWhenTitle aggWhenDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="aggWhenTitle">The same count, with the grouping key computed at two different times</title>
  <desc id="aggWhenDesc">Two plans for one aggregation over 4.2 million delivery nodes. Computing the cell per row means a label scan, a geometry call on every node, and an eager aggregation that materialises the whole projection before emitting a count. Storing the cell at write time turns the same query into a scan over an index-ordered integer property, with the geometry already paid for during ingestion and the group-by reduced to counting. The answer is identical; the work is not, and the second plan also leaves the page cache intact for whatever else the instance is serving.</desc>
  <defs>
    <marker id="aggArr" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="320" fill="var(--viz-bg,#ffffff)"/>
  <text x="196" y="24" text-anchor="middle" font-size="13" font-weight="700" fill="var(--viz-poor,#a8320f)">cell computed per row</text>
  <text x="584" y="24" text-anchor="middle" font-size="13" font-weight="700" fill="var(--viz-good,#0a656d)">cell stored at write time</text>
  <text x="196" y="42" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">read bottom-up</text>
  <text x="584" y="42" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">read bottom-up</text>
  <line x1="390" y1="54" x2="390" y2="286" stroke="var(--line,#e5e0d2)" stroke-width="1" stroke-dasharray="3 6"/>
  <g font-size="11" text-anchor="middle" font-weight="700">
    <rect x="52" y="240" width="288" height="42" rx="8" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-poor,#a8320f)" stroke-width="2"/>
    <text x="196" y="259" fill="var(--viz-poor,#a8320f)">NodeByLabelScan</text>
    <text x="196" y="274" font-size="9.5" font-weight="400" fill="var(--viz-ink-mute,#565f6d)">4,200,000 :Delivery</text>
    <rect x="52" y="176" width="288" height="42" rx="8" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-poor,#a8320f)" stroke-width="1.6"/>
    <text x="196" y="195" fill="currentColor">Projection: cell from point</text>
    <text x="196" y="210" font-size="9.5" font-weight="400" fill="var(--viz-ink-mute,#565f6d)">4,200,000 geometry calls</text>
    <rect x="52" y="112" width="288" height="42" rx="8" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-poor,#a8320f)" stroke-width="1.6"/>
    <text x="196" y="131" fill="currentColor">EagerAggregation</text>
    <text x="196" y="146" font-size="9.5" font-weight="400" fill="var(--viz-ink-mute,#565f6d)">all rows held before the first count</text>
    <rect x="52" y="62" width="288" height="30" rx="8" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1.2"/>
    <text x="196" y="82" font-size="10.5" fill="currentColor">1,840 rows returned</text>
  </g>
  <g stroke="currentColor" stroke-width="1.6" marker-end="url(#aggArr)">
    <line x1="196" y1="240" x2="196" y2="220"/><line x1="196" y1="176" x2="196" y2="156"/><line x1="196" y1="112" x2="196" y2="96"/>
  </g>
  <g font-size="11" text-anchor="middle" font-weight="700">
    <rect x="440" y="240" width="288" height="42" rx="8" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="2"/>
    <text x="584" y="259" fill="var(--viz-good,#0a656d)">NodeIndexScan on cell</text>
    <text x="584" y="274" font-size="9.5" font-weight="400" fill="var(--viz-ink-mute,#565f6d)">index-ordered, no geometry</text>
    <rect x="440" y="176" width="288" height="42" rx="8" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="1.6"/>
    <text x="584" y="195" fill="currentColor">OrderedAggregation</text>
    <text x="584" y="210" font-size="9.5" font-weight="400" fill="var(--viz-ink-mute,#565f6d)">groups close as the key changes</text>
    <rect x="440" y="112" width="288" height="42" rx="8" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1.2"/>
    <text x="584" y="131" font-size="10.5" fill="currentColor">1,840 rows returned</text>
    <text x="584" y="146" font-size="9.5" font-weight="400" fill="var(--viz-ink-mute,#565f6d)">heap flat in label size</text>
  </g>
  <g stroke="currentColor" stroke-width="1.6" marker-end="url(#aggArr)">
    <line x1="584" y1="240" x2="584" y2="220"/><line x1="584" y1="176" x2="584" y2="156"/>
  </g>
  <text x="584" y="80" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">the geometry was paid for once, during ingestion</text>
  <text x="24" y="306" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">Same answer, same 1,840 groups. The left plan also evicts the page cache that the routing endpoint was using.</text>
</svg>

## Schema & Data Model

The stored key needs three properties on the aggregated node, and an index on the one that gets grouped.

```cypher
// Cell keys at two resolutions, so a dashboard can roll up without recomputing.
// `cell_r7` is the finest level anything will ever ask for; `cell_r5` is the
// level most tiles use, and is derivable from r7 but cheaper to read directly.
CREATE INDEX delivery_cell_r7 IF NOT EXISTS
FOR (d:Delivery) ON (d.cell_r7);

CREATE INDEX delivery_cell_r5 IF NOT EXISTS
FOR (d:Delivery) ON (d.cell_r5);

// The point index stays: aggregation is not the only thing that reads this label.
CREATE POINT INDEX delivery_location IF NOT EXISTS
FOR (d:Delivery) ON (d.location);

// A composite where a tenant or region always scopes the aggregation. The
// leading key must be the equality predicate, or the seek degrades to a filter.
CREATE INDEX delivery_tenant_cell IF NOT EXISTS
FOR (d:Delivery) ON (d.tenant_id, d.cell_r7);
```

The choice of cell system is worth a moment. A **square grid** derived by truncating projected coordinates is trivial to compute, trivially reversible, and has cells whose ground area varies with latitude. A **geohash** is a string prefix, so rolling up is a substring operation and cells nest exactly, at the cost of cells that are not square and vary in aspect ratio by latitude. **H3 hexagons** have near-uniform area, no diagonal-neighbour ambiguity, and a clean parent-child relationship, at the cost of a dependency and cells that do not nest perfectly. For counting things on a map, hexagons produce the least misleading picture; for anything that has to line up with an existing tile scheme, the square grid is the only one that will.

## Step-by-Step Implementation

**1. Compute the key at ingestion, alongside the point.** The cell is derived from the same coordinate the `location` property comes from, so the natural place to compute it is where that coordinate is validated.

```python
import asyncio
import math
from dataclasses import dataclass

from neo4j import AsyncGraphDatabase

EARTH_R = 6_371_008.8


@dataclass(frozen=True)
class Cell:
    """A square-grid cell key at a chosen edge length in metres.

    Latitude is divided by a constant, because a degree of latitude is a constant
    ground distance. Longitude is divided by a value corrected with cos(lat),
    because a degree of longitude is not — omit that correction and cells become
    progressively wider than they are tall as you move away from the equator.
    """
    x: int
    y: int

    @property
    def key(self) -> int:
        # Pack into one integer so the group-by is on a single indexed property.
        return (self.x & 0xFFFFFFFF) << 32 | (self.y & 0xFFFFFFFF)


def cell_for(lat: float, lon: float, edge_m: float) -> Cell:
    if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
        raise ValueError(f"coordinate out of range: {lat}, {lon}")
    deg_lat = edge_m / (math.pi / 180 * EARTH_R)
    cos_lat = max(math.cos(math.radians(lat)), 1e-6)
    deg_lon = deg_lat / cos_lat
    return Cell(x=math.floor(lon / deg_lon), y=math.floor(lat / deg_lat))


UPSERT = """
UNWIND $batch AS row
MATCH (d:Delivery {id: row.id})
SET d.location = point({latitude: row.lat, longitude: row.lon}),
    d.cell_r7  = row.cell_r7,
    d.cell_r5  = row.cell_r5
RETURN count(d) AS updated
"""


async def load(driver, rows: list[dict]) -> int:
    batch = []
    for row in rows:
        batch.append({
            "id": row["id"],
            "lat": row["lat"],
            "lon": row["lon"],
            "cell_r7": cell_for(row["lat"], row["lon"], edge_m=150).key,
            "cell_r5": cell_for(row["lat"], row["lon"], edge_m=1200).key,
        })
    async with driver.session() as session:
        result = await session.run(UPSERT, batch=batch)
        record = await result.single()
    return int(record["updated"])
```

**2. Aggregate over the stored key.** With the key indexed, the count is a scan over an ordered property and the planner can close each group as the key changes rather than holding every row.

```cypher
MATCH (d:Delivery)
WHERE d.tenant_id = $tenant_id
RETURN d.cell_r5 AS cell, count(*) AS deliveries,
       avg(d.service_seconds) AS mean_service
ORDER BY deliveries DESC
LIMIT 200;
```

**3. Convert the cell back to a shape only at the edge.** Cells are integers everywhere inside the system; a cell becomes a polygon exactly once, in the response serialiser, and never in the database.

## Query Patterns & Variants

**Counting within a bounding box, not the whole label.** A tile request has an extent, and the extent should bound the scan. Because cell keys are ordered by construction, a bounded range on the key is seekable.

```cypher
MATCH (d:Delivery)
WHERE d.cell_r7 >= $cell_lo AND d.cell_r7 <= $cell_hi
  AND d.location.latitude  >= $min_lat AND d.location.latitude  <= $max_lat
  AND d.location.longitude >= $min_lon AND d.location.longitude <= $max_lon
RETURN d.cell_r7 AS cell, count(*) AS n;
```

**Aggregating a route metric by area rather than by cell.** When the grouping is an administrative region rather than a grid, the containment has already been resolved into an edge by [reverse geocoding](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/poi-enrichment-workflows/reverse-geocoding-poi-nodes-to-admin-boundaries/), so the aggregation is a traversal and not a geometry test at all.

```cypher
MATCH (d:Delivery)-[:WITHIN*]->(a:AdminArea {level: $level})
RETURN a.id AS area, a.name AS name, count(DISTINCT d) AS deliveries
ORDER BY deliveries DESC;
```

**Weighted density rather than raw counts.** A count per cell says where the events are; a count divided by the cell's ground area says where they concentrate, which is the number a heat map should actually be drawn from. With near-uniform-area cells the division is a constant and can be done client-side; with a square grid it varies by latitude and has to be computed per cell.

## Performance Tuning

The aggregation's cost has two terms and they respond to different things.

$$C_{\text{agg}} \approx N \cdot c_{\text{read}} + G \cdot c_{\text{group}}$$

$N$ is the rows scanned and $G$ the number of distinct groups. Bounding the extent reduces $N$; choosing a coarser resolution reduces $G$. They are not interchangeable — a national query at fine resolution has a large $G$ and will spend its time in the aggregation, while a city query at coarse resolution has a small $G$ and spends everything in the scan. Read the plan to see which one you have before tuning the wrong term.

Two further levers matter in practice. **`EagerAggregation` versus `OrderedAggregation`** is the single largest difference in heap behaviour, and it turns on whether the input arrives sorted by the grouping key. An index scan on the cell property provides that ordering for free; a projection does not. If `PROFILE` shows `EagerAggregation` on a query you expected to stream, the grouping key is not the property being scanned.

**Pre-aggregating into materialised counts** is the answer once the same tiles are requested repeatedly. A nightly pass that writes `(:CellSummary {cell, day, count})` turns a dashboard query into a lookup, and the freshness cost is explicit rather than hidden. The moment to do this is when the aggregation's page-cache footprint starts displacing the routing workload's, which is a decision the [memory budget](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-memory-and-storage-tuning/) makes visible.

<svg viewBox="0 0 780 296" role="img" aria-labelledby="aggResTitle aggResDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="aggResTitle">Resolution decides which half of the cost you are paying</title>
  <desc id="aggResDesc">Scan cost and grouping cost plotted against cell resolution for a fixed extent. At coarse resolution there are few groups, so almost all the time is the scan and the aggregation is nearly free. At fine resolution the scan is unchanged but the group count rises steeply, and the aggregation dominates. The total has a shallow minimum in between. The practical point is that halving the cell edge does not halve anything — it quadruples the group count while leaving the rows scanned exactly as they were.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="296" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Cost split against cell resolution, fixed extent</text>
  <line x1="96" y1="48" x2="96" y2="208" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <line x1="96" y1="208" x2="720" y2="208" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <g font-size="9.5" fill="var(--viz-ink-mute,#565f6d)" text-anchor="middle">
    <text x="96" y="228">2 km</text><text x="252" y="228">600 m</text><text x="408" y="228">150 m</text><text x="564" y="228">40 m</text><text x="720" y="228">10 m</text>
  </g>
  <text x="408" y="248" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">cell edge — finer to the right</text>
  <line x1="96" y1="170" x2="720" y2="170" stroke="var(--accent,#0a656d)" stroke-width="2.6"/>
  <text x="110" y="162" font-size="10" font-weight="700" fill="var(--accent,#0a656d)">scan — flat, the extent did not change</text>
  <path d="M96 204 L252 198 L408 178 L564 130 L720 56" fill="none" stroke="var(--accent-3,#5b21b6)" stroke-width="2.6"/>
  <text x="560" y="106" font-size="10" font-weight="700" fill="var(--accent-3,#5b21b6)">grouping — quadruples per halving</text>
  <path d="M96 136 L252 130 L408 112 L564 70 L720 52" fill="none" stroke="var(--viz-ok,#7d6200)" stroke-width="2.2" stroke-dasharray="7 5"/>
  <text x="150" y="128" font-size="10" font-weight="700" fill="var(--viz-ok,#7d6200)">total</text>
  <circle cx="330" cy="122" r="6" fill="var(--viz-ok,#7d6200)"/>
  <text x="342" y="126" font-size="10" font-weight="700" fill="var(--viz-ok,#7d6200)">shallow minimum</text>
  <text x="24" y="276" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">Bounding the extent moves the teal line; choosing a resolution moves the indigo one. Tuning the wrong one changes nothing.</text>
</svg>

## Edge Cases & Gotchas

- **Cells straddle the antimeridian and the poles.** A key derived from truncated longitude has a discontinuity at ±180°, so a bounded range on the key silently excludes half of any extent that crosses it. The same box-splitting that fixes a [bounding-box search across the antimeridian](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/bounding-box-search-across-the-antimeridian/) applies to cell ranges, and near the poles the longitude correction blows up — clamp it rather than letting `cos(lat)` approach zero.
- **A stale cell is worse than a missing one.** A node whose coordinate was corrected but whose cell was not is counted in the wrong square, and nothing about the result says so. Recompute the key in the same statement that writes the point, never in a follow-up pass that can be skipped.
- **Coarser roll-ups must come from the key, not from re-deriving.** Rounding a fine cell key to a coarse one by integer division is exact; recomputing the coarse cell from the coordinate is a second geometry call and can disagree at boundaries because of floating-point rounding.
- **Count distinct is not free.** `count(DISTINCT d)` over a variable-length traversal has to hold the identity set, which is a heap cost proportional to the result rather than to the groups. Where the traversal cannot produce duplicates, plain `count(*)` is both cheaper and honest about it.
- **A grid hides the thing a cluster would show.** Two dense concentrations either side of a cell boundary appear as two moderate cells; one concentration in the middle of a cell appears as one dense cell. The picture changes if you shift the grid by half a cell, which is worth knowing before presenting it as a finding.
- **Aggregations evict the cache that routing depends on.** A full-label scan pulls the entire label through the page cache, and the pages it displaces are the ones the latency-sensitive workload had resident. Bound the extent, or run the aggregation against a replica.


<svg viewBox="0 0 780 296" role="img" aria-labelledby="aggShiftTitle aggShiftDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="aggShiftTitle">The same points, the same resolution, a grid shifted by half a cell</title>
  <desc id="aggShiftDesc">One concentration of points aggregated twice at the same cell size, with the second grid offset by half a cell. In the first the concentration falls in the middle of a cell and reports as one cell of 24. In the second the same points straddle a boundary and report as four cells of 5 to 8, none of which stands out. Nothing about the data changed. This sensitivity is why a grid answers how many fell in each square and not where the concentration is, and why the shape of a concentration needs a method whose boundaries come from the data.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="296" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Identical points, identical cell size, grid offset by half a cell</text>
  <rect x="24" y="42" width="356" height="196" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="1.6"/>
  <text x="202" y="66" text-anchor="middle" font-size="11.5" font-weight="700" fill="var(--viz-good,#0a656d)">grid aligned with the concentration</text>
  <g stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1.2">
    <line x1="112" y1="82" x2="112" y2="214"/><line x1="202" y1="82" x2="202" y2="214"/><line x1="292" y1="82" x2="292" y2="214"/>
    <line x1="52" y1="126" x2="352" y2="126"/><line x1="52" y1="170" x2="352" y2="170"/>
  </g>
  <rect x="112" y="126" width="90" height="44" fill="var(--viz-good,#0a656d)" opacity="0.22"/>
  <g fill="var(--viz-good,#0a656d)">
    <circle cx="126" cy="136" r="3.4"/><circle cx="140" cy="132" r="3.4"/><circle cx="154" cy="140" r="3.4"/><circle cx="168" cy="134" r="3.4"/>
    <circle cx="182" cy="142" r="3.4"/><circle cx="194" cy="136" r="3.4"/><circle cx="130" cy="150" r="3.4"/><circle cx="146" cy="154" r="3.4"/>
    <circle cx="160" cy="148" r="3.4"/><circle cx="174" cy="156" r="3.4"/><circle cx="188" cy="150" r="3.4"/><circle cx="120" cy="160" r="3.4"/>
    <circle cx="136" cy="164" r="3.4"/><circle cx="152" cy="160" r="3.4"/><circle cx="166" cy="166" r="3.4"/><circle cx="180" cy="162" r="3.4"/>
    <circle cx="194" cy="158" r="3.4"/><circle cx="124" cy="144" r="3.4"/><circle cx="158" cy="130" r="3.4"/><circle cx="172" cy="146" r="3.4"/>
    <circle cx="186" cy="132" r="3.4"/><circle cx="142" cy="144" r="3.4"/><circle cx="198" cy="146" r="3.4"/><circle cx="132" cy="140" r="3.4"/>
  </g>
  <text x="157" y="154" text-anchor="middle" font-size="17" font-weight="700" fill="var(--viz-on-pill,#ffffff)"> </text>
  <rect x="238" y="130" width="46" height="22" rx="11" fill="var(--viz-good,#0a656d)"/>
  <text x="261" y="146" text-anchor="middle" font-size="11" font-weight="700" fill="var(--viz-on-pill,#ffffff)">24</text>
  <text x="202" y="232" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">one cell of 24 — an obvious hotspot</text>
  <rect x="400" y="42" width="356" height="196" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-poor,#a8320f)" stroke-width="1.6"/>
  <text x="578" y="66" text-anchor="middle" font-size="11.5" font-weight="700" fill="var(--viz-poor,#a8320f)">grid offset by half a cell</text>
  <g stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1.2">
    <line x1="533" y1="82" x2="533" y2="214"/><line x1="623" y1="82" x2="623" y2="214"/><line x1="713" y1="82" x2="713" y2="214"/>
    <line x1="428" y1="104" x2="728" y2="104"/><line x1="428" y1="148" x2="728" y2="148"/><line x1="428" y1="192" x2="728" y2="192"/>
  </g>
  <rect x="443" y="104" width="90" height="44" fill="var(--viz-poor,#a8320f)" opacity="0.14"/>
  <rect x="533" y="104" width="90" height="44" fill="var(--viz-poor,#a8320f)" opacity="0.14"/>
  <rect x="443" y="148" width="90" height="44" fill="var(--viz-poor,#a8320f)" opacity="0.14"/>
  <rect x="533" y="148" width="90" height="44" fill="var(--viz-poor,#a8320f)" opacity="0.14"/>
  <g fill="var(--viz-poor,#a8320f)">
    <circle cx="502" cy="136" r="3.4"/><circle cx="516" cy="132" r="3.4"/><circle cx="530" cy="140" r="3.4"/><circle cx="544" cy="134" r="3.4"/>
    <circle cx="558" cy="142" r="3.4"/><circle cx="570" cy="136" r="3.4"/><circle cx="506" cy="150" r="3.4"/><circle cx="522" cy="154" r="3.4"/>
    <circle cx="536" cy="148" r="3.4"/><circle cx="550" cy="156" r="3.4"/><circle cx="564" cy="150" r="3.4"/><circle cx="496" cy="160" r="3.4"/>
    <circle cx="512" cy="164" r="3.4"/><circle cx="528" cy="160" r="3.4"/><circle cx="542" cy="166" r="3.4"/><circle cx="556" cy="162" r="3.4"/>
    <circle cx="570" cy="158" r="3.4"/><circle cx="500" cy="144" r="3.4"/><circle cx="534" cy="130" r="3.4"/><circle cx="548" cy="146" r="3.4"/>
    <circle cx="562" cy="132" r="3.4"/><circle cx="518" cy="144" r="3.4"/><circle cx="574" cy="146" r="3.4"/><circle cx="508" cy="140" r="3.4"/>
  </g>
  <g font-size="10.5" font-weight="700" text-anchor="middle">
    <rect x="646" y="98" width="40" height="20" rx="10" fill="var(--viz-poor,#a8320f)"/><text x="666" y="113" fill="var(--viz-on-pill,#ffffff)">8</text>
    <rect x="646" y="122" width="40" height="20" rx="10" fill="var(--viz-poor,#a8320f)"/><text x="666" y="137" fill="var(--viz-on-pill,#ffffff)">6</text>
    <rect x="646" y="146" width="40" height="20" rx="10" fill="var(--viz-poor,#a8320f)"/><text x="666" y="161" fill="var(--viz-on-pill,#ffffff)">5</text>
    <rect x="646" y="170" width="40" height="20" rx="10" fill="var(--viz-poor,#a8320f)"/><text x="666" y="185" fill="var(--viz-on-pill,#ffffff)">5</text>
  </g>
  <text x="578" y="232" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">four unremarkable cells — the hotspot is gone</text>
  <text x="24" y="270" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">Both reports are correct. Neither is a statement about where the concentration is, which is worth knowing before one is</text>
  <text x="24" y="286" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">presented as a finding — and is the reason the clustering guide exists alongside this one.</text>
</svg>

## Verification & Testing

Two properties are worth asserting, and both catch real defects rather than typos.

```python
import pytest


@pytest.mark.asyncio
async def test_cell_counts_sum_to_label_count(session, tenant_id):
    """Every node must land in exactly one cell — no drops, no double counts."""
    grouped = await session.run(
        "MATCH (d:Delivery) WHERE d.tenant_id = $t "
        "RETURN sum(x) AS total FROM (MATCH (d2:Delivery) WHERE d2.tenant_id = $t "
        "RETURN count(*) AS x)", t=tenant_id)
    direct = await session.run(
        "MATCH (d:Delivery) WHERE d.tenant_id = $t RETURN count(*) AS n", t=tenant_id)
    assert (await grouped.single())["total"] == (await direct.single())["n"]


def test_coarse_key_is_derivable_from_fine():
    """A roll-up must be integer arithmetic on the key, not a second geometry call."""
    lat, lon = 51.5074, -0.1278
    fine = cell_for(lat, lon, edge_m=150)
    coarse = cell_for(lat, lon, edge_m=1200)
    assert fine.x // 8 == coarse.x
    assert fine.y // 8 == coarse.y
```

The first test is the one that catches a mis-scoped predicate: if the grouped total and the direct count disagree, some rows are being dropped by the grouping path — usually a `WHERE` on a property that is null for part of the label. The second protects the roll-up invariant, which is the property that makes storing one resolution sufficient.

## FAQ

<details>
<summary>Should I store the cell key or compute it in the query?</summary>

Store it if the same aggregation runs repeatedly — a dashboard, a scheduled report, an API endpoint. Compute it in the query for genuine one-off analysis, where the cost of a single scan is less than the cost of adding a property and a maintenance obligation to every writer. The dividing line is whether the question will be asked again.
</details>

<details>
<summary>Squares, geohashes or hexagons?</summary>

Hexagons if the output is a map a human will read, because near-uniform cell area means the picture is not distorted by latitude and every neighbour is the same distance away. Geohashes if roll-up as a string prefix is convenient and you already use them for partitioning. Squares if the result has to align with an existing tile scheme, which is a requirement that overrides every other consideration.
</details>

<details>
<summary>Why is my aggregation using EagerAggregation when the property is indexed?</summary>

Almost always because the grouping key in the `RETURN` is not the property being scanned. Grouping by an expression over the indexed property — a division, a coalesce, a cast — produces a value the index ordering does not apply to, so the planner falls back to holding every row. Group by the stored property and do the roll-up arithmetic afterwards.
</details>

<details>
<summary>When is density clustering actually the right tool?</summary>

When the boundaries of a fixed grid are themselves misleading — finding where deliveries concentrate irrespective of where squares fall, or grouping stops into service areas whose shape is not known in advance. It costs a projection and a real algorithm run, so it belongs in a scheduled job rather than a request path.
</details>

<details>
<summary>Can I aggregate and route in the same query?</summary>

You can, and it is usually a mistake. An aggregation scans; a route seeks. Putting both in one statement gives the planner a shape where one of the two has to lose, and it is generally the seek. Run them separately and join the results in the application, where the two access patterns stay independent.
</details>

## Related

- [Distance Filter Query Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/) — the index-first shape aggregation has to give up, and what replaces it.
- [Cypher Performance Tuning for Spatial Routing Workflows](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/) — reading the plan that tells you which half of the cost you are paying.
- [Reverse Geocoding POI Nodes to Admin Boundaries](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/poi-enrichment-workflows/reverse-geocoding-poi-nodes-to-admin-boundaries/) — resolving containment once so region aggregation is a traversal.
- [Spatial Indexing Strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) — choosing the index family the grouping key sits in.
- [Graph Memory and Storage Tuning](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-memory-and-storage-tuning/) — why a full-label aggregation is a cache decision as much as a query one.

This topic is part of [Cypher Spatial Queries & Pathfinding Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/).
