---
pageTitle: Reverse-Geocoding POIs to Boundaries
title: Reverse-Geocoding POI Nodes to Administrative Boundaries
description: Stamp each POI node with its containing admin areas via STRtree point-in-polygon tests, then store the containment hierarchy as :WITHIN edges in the graph.
slug: reverse-geocoding-poi-nodes-to-admin-boundaries
type: article
breadcrumb: Reverse-Geocoding POIs
datePublished: 2026-07-14
dateModified: 2026-07-14
---
# Reverse-Geocoding POI Nodes to Administrative Boundaries

Analysts ask the graph for "all charging stations in Bavaria" or "delivery hubs inside the Paris city limits," and the query has nothing to filter on — the POI nodes carry a `location` point but no notion of the administrative area that contains them. The naive fix, a `point.distance()` scan against a boundary centroid, is both wrong (a point can be near a centroid yet outside the polygon) and slow (it reads every boundary for every POI). The correct operation is point-in-polygon containment: which admin polygons actually enclose this coordinate, across every level from country down to postal code. This page resolves each POI against nested boundaries with a shapely `STRtree` prefilter, then writes the result as a `:WITHIN` hierarchy in the graph so area filters become a cheap relationship traversal instead of a geometry test at query time. It builds on the [POI enrichment workflows](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/poi-enrichment-workflows/) that established these nodes.

## Prerequisites & Versions

The `STRtree.query(point, predicate="contains")` call — an R-tree bounding-box prefilter fused with the exact containment test — requires shapely 2.x. The write side is the official async driver.

| Requirement | Minimum version | Note |
| --- | --- | --- |
| Python | 3.10+ | `str \| None` unions, dataclasses used below |
| shapely | 2.0+ | `STRtree`, vectorized `query(..., predicate=...)` |
| neo4j (driver) | 5.x | `AsyncGraphDatabase`, `execute_write` |
| Neo4j server | 5.13+ | `MERGE`, uniqueness constraints |

```bash
pip install "shapely>=2.0" "neo4j>=5.18"
```

This guide assumes the `POI` nodes already exist with a stable `id` and a native `location` point, produced upstream by the [OSM data ingestion pipelines](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/osm-data-ingestion-pipelines/) stage and following the [node and edge spatial mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/) conventions — coordinates as a real `point`, not detached `lat`/`lon` strings. Create the anchoring constraints so every `MERGE` seeks an index:

```cypher
CREATE CONSTRAINT poi_id_unique IF NOT EXISTS
FOR (p:POI) REQUIRE p.id IS UNIQUE;

CREATE CONSTRAINT admin_area_id IF NOT EXISTS
FOR (a:AdminArea) REQUIRE a.id IS UNIQUE;
```

## Implementation

The boundaries load once into an `STRtree`; each POI is a point query that returns the containment chain coarsest-first. The graph write upserts every area on that chain, stitches the hierarchy from each area's `parent_id`, and attaches the POI to its most specific enclosing area.

<svg viewBox="0 0 940 420" role="img" aria-labelledby="rgTitle rgDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="rgTitle">Point-in-polygon containment against nested admin boundaries, materialized as a WITHIN hierarchy</title>
  <desc id="rgDesc">Left: four nested administrative polygons — country contains region contains city contains postal area — with a single POI marker falling inside all four. A point-in-polygon test confirms which polygons enclose the point. Right: the resulting graph, where the POI node has a WITHIN edge to its most specific area, the postal code, which in turn has WITHIN edges up the chain through city, region, and country. Area filters become relationship traversals instead of geometry tests.</desc>
  <defs>
    <marker id="rg-arr" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7.5" markerHeight="7.5" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
    <marker id="rg-arr-a" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7.5" markerHeight="7.5" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="var(--accent,#0a656d)"/>
    </marker>
  </defs>
  <!-- LEFT: nested polygons -->
  <rect class="viz-backdrop" x="0" y="0" width="940" height="420" fill="var(--viz-bg,#ffffff)"/>
  <text x="215" y="30" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">Nested admin polygons</text>
  <text x="215" y="48" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.7">point-in-polygon containment</text>
  <rect x="40" y="60" width="350" height="330" rx="10" fill="var(--accent-3)" opacity="0.06"/>
  <rect x="40" y="60" width="350" height="330" rx="10" fill="none" stroke="var(--accent-3)" stroke-width="1.8"/>
  <text x="52" y="80" font-size="11.5" fill="currentColor">country · level 2</text>
  <rect x="78" y="98" width="278" height="262" rx="9" fill="var(--accent)" opacity="0.06"/>
  <rect x="78" y="98" width="278" height="262" rx="9" fill="none" stroke="var(--accent)" stroke-width="1.8"/>
  <text x="90" y="118" font-size="11.5" fill="currentColor">region · level 4</text>
  <rect x="120" y="140" width="200" height="188" rx="8" fill="var(--accent-4)" opacity="0.08"/>
  <rect x="120" y="140" width="200" height="188" rx="8" fill="none" stroke="var(--accent-4)" stroke-width="1.8"/>
  <text x="132" y="160" font-size="11.5" fill="currentColor">city · level 8</text>
  <rect x="166" y="186" width="112" height="104" rx="7" fill="var(--accent-2)" opacity="0.1"/>
  <rect x="166" y="186" width="112" height="104" rx="7" fill="none" stroke="var(--accent-2)" stroke-width="1.8"/>
  <text x="178" y="206" font-size="11.5" fill="currentColor">postal · level 10</text>
  <!-- POI marker -->
  <circle cx="222" cy="248" r="7" fill="var(--accent-2,#a8380b)"/>
  <circle cx="222" cy="248" r="13" fill="none" stroke="var(--accent-2,#a8380b)" stroke-width="1.4" opacity="0.6"/>
  <text x="222" y="278" text-anchor="middle" font-size="10.5" fill="currentColor" font-weight="600">POI</text>
  <!-- transition arrow -->
  <path d="M400 225 H520" stroke="var(--accent,#0a656d)" stroke-width="2.4" fill="none" marker-end="url(#rg-arr-a)"/>
  <text x="460" y="216" text-anchor="middle" font-size="10.5" fill="var(--accent,#0a656d)" font-weight="600">MERGE</text>
  <text x="460" y="244" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">:WITHIN</text>
  <!-- RIGHT: graph hierarchy -->
  <text x="740" y="30" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">:WITHIN hierarchy in the graph</text>
  <g font-size="12" fill="currentColor">
    <!-- POI node -->
    <rect x="676" y="52" width="128" height="42" rx="21" fill="var(--accent-2)" stroke="var(--accent-2)"/>
    <text x="740" y="78" text-anchor="middle" fill="var(--viz-on-pill,#ffffff)" font-weight="600">:POI</text>
    <!-- postal -->
    <rect x="676" y="140" width="128" height="42" rx="10" fill="var(--surface-2)" stroke="var(--accent-2)" stroke-width="2"/>
    <text x="740" y="166" text-anchor="middle" font-weight="600">postal 10</text>
    <!-- city -->
    <rect x="676" y="222" width="128" height="42" rx="10" fill="var(--surface-2)" stroke="var(--accent-4)" stroke-width="2"/>
    <text x="740" y="248" text-anchor="middle" font-weight="600">city 8</text>
    <!-- region -->
    <rect x="676" y="304" width="128" height="42" rx="10" fill="var(--surface-2)" stroke="var(--accent)" stroke-width="2"/>
    <text x="740" y="330" text-anchor="middle" font-weight="600">region 4</text>
    <!-- country -->
    <rect x="676" y="360" width="128" height="42" rx="10" fill="var(--surface-2)" stroke="var(--accent-3)" stroke-width="2"/>
    <text x="740" y="386" text-anchor="middle" font-weight="600">country 2</text>
  </g>
  <!-- WITHIN edges -->
  <g stroke="currentColor" stroke-width="1.8" fill="none">
    <path d="M740 94 V138" marker-end="url(#rg-arr)"/>
    <path d="M740 182 V220" marker-end="url(#rg-arr)"/>
    <path d="M740 264 V302" marker-end="url(#rg-arr)"/>
    <path d="M740 346 V358" marker-end="url(#rg-arr)"/>
  </g>
  <g font-size="9.5" fill="currentColor" opacity="0.72" text-anchor="start">
    <text x="748" y="120">:WITHIN</text>
    <text x="748" y="204">:WITHIN</text>
    <text x="748" y="286">:WITHIN</text>
  </g>
</svg>

```python
import asyncio
import json
from dataclasses import dataclass

from neo4j import AsyncGraphDatabase
from shapely import STRtree, Point
from shapely.geometry import shape


@dataclass(frozen=True)
class AdminArea:
    admin_id: str
    name: str
    level: int           # OSM admin_level: 2 country, 4 region, 8 city, 10 postal
    parent_id: str | None


def load_boundaries(geojson_path: str) -> list[tuple[AdminArea, object]]:
    """Load admin polygons (WGS84 GeoJSON) as (AdminArea, shapely geometry) pairs."""
    with open(geojson_path) as fh:
        collection = json.load(fh)
    pairs = []
    for feature in collection["features"]:
        props = feature["properties"]
        area = AdminArea(
            admin_id=props["admin_id"],
            name=props["name"],
            level=int(props["admin_level"]),
            parent_id=props.get("parent_id"),
        )
        pairs.append((area, shape(feature["geometry"])))
    return pairs


class ReverseGeocoder:
    """Resolves a WGS84 coordinate to its nested admin containment chain."""

    def __init__(self, boundaries: list[tuple[AdminArea, object]]):
        self.areas = [area for area, _ in boundaries]
        self.geoms = [geom for _, geom in boundaries]
        self.tree = STRtree(self.geoms)   # R-tree over polygon bounding boxes

    def locate(self, lat: float, lon: float) -> list[AdminArea]:
        # shapely is planar and axis order is (x=lon, y=lat).
        point = Point(lon, lat)
        # query() prefilters by bounding box; predicate="contains" then applies the
        # exact point-in-polygon test, so only truly enclosing polygons return.
        idx = self.tree.query(point, predicate="contains")
        matched = [self.areas[i] for i in idx]
        matched.sort(key=lambda a: a.level)   # coarsest (country) first
        return matched


WRITE_HIERARCHY = """
UNWIND $rows AS row
// 1. upsert every admin area on the containment chain
UNWIND row.areas AS area
MERGE (a:AdminArea {id: area.admin_id})
  ON CREATE SET a.name = area.name, a.level = area.level
// 2. materialise the hierarchy: each area WITHIN its parent
WITH row, area
WHERE area.parent_id IS NOT NULL
MERGE (child:AdminArea {id: area.admin_id})
MERGE (parent:AdminArea {id: area.parent_id})
MERGE (child)-[:WITHIN]->(parent)
// 3. attach the POI to its most specific enclosing area
WITH DISTINCT row
MATCH (p:POI {id: row.poi_id})
MATCH (finest:AdminArea {id: row.finest_id})
MERGE (p)-[:WITHIN]->(finest)
"""


async def _write(tx, rows):
    await tx.run(WRITE_HIERARCHY, rows=rows)


def _area_dict(area: AdminArea) -> dict:
    return {"admin_id": area.admin_id, "name": area.name,
            "level": area.level, "parent_id": area.parent_id}


async def stamp_pois(driver, geocoder: ReverseGeocoder, pois: list[tuple[str, float, float]]):
    rows = []
    for poi_id, lat, lon in pois:
        chain = geocoder.locate(lat, lon)
        if not chain:
            # A point that lands in no boundary (offshore, border sliver, or a
            # coverage gap) is skipped rather than mis-assigned. See failures below.
            continue
        rows.append({
            "poi_id": poi_id,
            "finest_id": chain[-1].admin_id,
            "areas": [_area_dict(a) for a in chain],
        })
    if rows:
        async with driver.session() as session:
            await session.execute_write(_write, rows)
    return len(rows)


async def main():
    geocoder = ReverseGeocoder(load_boundaries("admin_boundaries.geojson"))
    pois = [
        ("poi:cafe/1", 48.8566, 2.3522),    # central Paris
        ("poi:depot/2", 43.2965, 5.3698),   # Marseille port
    ]
    driver = AsyncGraphDatabase.driver(
        "neo4j+s://your-cluster.databases.neo4j.io",
        auth=("neo4j", "secure-password"),
        max_connection_pool_size=20,
    )
    try:
        stamped = await stamp_pois(driver, geocoder, pois)
        print(f"Stamped {stamped} POIs with their admin hierarchy.")
    finally:
        await driver.close()


if __name__ == "__main__":
    asyncio.run(main())
```

## How It Works

Three decisions carry the correctness and the speed:

- **STRtree prefilter fused with the exact test.** `STRtree.query(point, predicate="contains")` first descends the R-tree to the handful of polygons whose bounding box covers the point, then runs the real `contains` predicate on only those candidates. A metropolitan boundary set can hold thousands of postal polygons; the tree turns a linear scan into a logarithmic descent plus a few exact tests, which is what keeps per-POI cost near constant.
- **Hierarchy from `parent_id`, not from geometry.** Rather than infer nesting by testing polygon-inside-polygon (fragile on shared borders), each area declares its parent, and the write stitches `(:AdminArea)-[:WITHIN]->(:AdminArea)` directly. The POI links only to its finest enclosing area; the chain up to country is reached by traversing `:WITHIN`. That normalization means "everything in this region" is a single variable-length traversal — `MATCH (p:POI)-[:WITHIN*]->(r:AdminArea {id: $region})` — with no geometry evaluated at query time.
- **Coarsest-first ordering.** Sorting the match by `level` makes `chain[-1]` the most specific area deterministically, so `finest_id` is unambiguous even when a coordinate legitimately sits inside four levels at once.

<svg viewBox="0 0 780 306" role="img" aria-labelledby="gsTitle gsDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="gsTitle">Two candidate polygons tested exactly, instead of four thousand</title>
  <desc id="gsDesc">The two-stage lookup for one POI against a boundary set of about four thousand polygons. The R-tree descent compares the point against bounding boxes only and returns the two polygons whose boxes cover it, at logarithmic cost. The exact contains predicate then runs on those two alone, and one of them is a bounding-box match whose real geometry excludes the point. Below, the hierarchy is read from each area's declared parent rather than inferred from geometry, so the chain from the finest enclosing area up to country involves no further polygon tests.</desc>
  <defs>
    <marker id="gs-a" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="306" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Prefilter on boxes, decide on geometry</text>
  <rect x="24" y="42" width="222" height="150" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.2"/>
  <text x="135" y="64" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">4,120 polygons</text>
  <g fill="var(--viz-stroke,#9ca3af)" opacity="0.5">
    <rect x="44" y="76" width="26" height="20" rx="3"/><rect x="78" y="76" width="26" height="20" rx="3"/><rect x="112" y="76" width="26" height="20" rx="3"/>
    <rect x="146" y="76" width="26" height="20" rx="3"/><rect x="180" y="76" width="26" height="20" rx="3"/><rect x="44" y="104" width="26" height="20" rx="3"/>
    <rect x="112" y="104" width="26" height="20" rx="3"/><rect x="146" y="104" width="26" height="20" rx="3"/><rect x="180" y="104" width="26" height="20" rx="3"/>
    <rect x="44" y="132" width="26" height="20" rx="3"/><rect x="78" y="132" width="26" height="20" rx="3"/><rect x="112" y="132" width="26" height="20" rx="3"/>
    <rect x="146" y="132" width="26" height="20" rx="3"/><rect x="180" y="132" width="26" height="20" rx="3"/>
  </g>
  <rect x="78" y="104" width="26" height="20" rx="3" fill="var(--accent-3,#5b21b6)"/>
  <text x="135" y="176" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">a linear scan tests every one</text>
  <line x1="246" y1="116" x2="290" y2="116" stroke="currentColor" stroke-width="1.6" marker-end="url(#gs-a)"/>
  <text x="268" y="106" text-anchor="middle" font-size="9" fill="var(--viz-ink-mute,#565f6d)">query</text>
  <rect x="292" y="42" width="222" height="150" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--accent-3,#5b21b6)" stroke-width="1.8"/>
  <text x="403" y="64" text-anchor="middle" font-size="11" font-weight="700" fill="var(--accent-3,#5b21b6)">STRtree descent</text>
  <text x="403" y="80" text-anchor="middle" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">bounding boxes only</text>
  <g stroke="var(--accent-3,#5b21b6)" stroke-width="1.4" fill="none">
    <path d="M403 92 V104 H351 V116"/><path d="M403 92 V104 H455 V116"/>
    <path d="M351 128 V140 H325 V150"/><path d="M351 128 V140 H377 V150"/>
  </g>
  <g font-size="9" text-anchor="middle" font-weight="700">
    <rect x="331" y="116" width="40" height="14" rx="4" fill="var(--accent-3,#5b21b6)"/><text x="351" y="127" fill="var(--viz-on-pill,#ffffff)">node</text>
    <rect x="435" y="116" width="40" height="14" rx="4" fill="var(--viz-ink-mute,#565f6d)"/><text x="455" y="127" fill="var(--viz-on-pill,#ffffff)">node</text>
    <rect x="305" y="150" width="40" height="14" rx="4" fill="var(--accent-3,#5b21b6)"/><text x="325" y="161" fill="var(--viz-on-pill,#ffffff)">box</text>
    <rect x="357" y="150" width="40" height="14" rx="4" fill="var(--accent-3,#5b21b6)"/><text x="377" y="161" fill="var(--viz-on-pill,#ffffff)">box</text>
  </g>
  <text x="403" y="184" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">2 candidates survive</text>
  <line x1="514" y1="116" x2="558" y2="116" stroke="currentColor" stroke-width="1.6" marker-end="url(#gs-a)"/>
  <rect x="560" y="42" width="196" height="150" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="1.8"/>
  <text x="658" y="64" text-anchor="middle" font-size="11" font-weight="700" fill="var(--viz-good,#0a656d)">exact contains</text>
  <path d="M592 92 L648 82 L706 100 L692 146 L610 150 Z" fill="var(--viz-good,#0a656d)" opacity="0.18"/>
  <path d="M592 92 L648 82 L706 100 L692 146 L610 150 Z" fill="none" stroke="var(--viz-good,#0a656d)" stroke-width="1.8"/>
  <circle cx="650" cy="118" r="5" fill="var(--accent-3,#5b21b6)"/>
  <text x="658" y="176" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">1 contains, 1 box-only match</text>
  <rect x="24" y="208" width="732" height="66" rx="9" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1.2"/>
  <text x="44" y="230" font-size="11" font-weight="700" fill="currentColor">then the chain is read, not computed</text>
  <g font-size="10" text-anchor="middle" font-weight="700">
    <rect x="300" y="216" width="88" height="22" rx="6" fill="var(--viz-good,#0a656d)"/><text x="344" y="231" fill="var(--viz-on-pill,#ffffff)">postal</text>
    <rect x="404" y="216" width="88" height="22" rx="6" fill="var(--accent,#0a656d)"/><text x="448" y="231" fill="var(--viz-on-pill,#ffffff)">city</text>
    <rect x="508" y="216" width="88" height="22" rx="6" fill="var(--accent,#0a656d)"/><text x="552" y="231" fill="var(--viz-on-pill,#ffffff)">region</text>
    <rect x="612" y="216" width="88" height="22" rx="6" fill="var(--accent,#0a656d)"/><text x="656" y="231" fill="var(--viz-on-pill,#ffffff)">country</text>
  </g>
  <g stroke="currentColor" stroke-width="1.4" marker-end="url(#gs-a)">
    <line x1="388" y1="227" x2="400" y2="227"/><line x1="492" y1="227" x2="504" y2="227"/><line x1="596" y1="227" x2="608" y2="227"/>
  </g>
  <text x="44" y="252" font-size="10" fill="var(--viz-ink-mute,#565f6d)">:WITHIN edges come from each area's declared parent_id, so no polygon-inside-polygon test is ever run —</text>
  <text x="44" y="266" font-size="10" fill="var(--viz-ink-mute,#565f6d)">and shared borders, where that test is least reliable, stop mattering.</text>
</svg>

Storing containment as edges is what lets downstream analytics correlate POIs, demographics, and routes by area without a spatial join on every read — the geometric join is paid once here. When you do need to intersect POIs against arbitrary external polygons at query time rather than a fixed hierarchy, that is the province of [spatial join techniques](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/spatial-join-techniques/), and demographic attributes attach to the same nodes through [enriching POI data with real-time demographics](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/poi-enrichment-workflows/enriching-poi-data-with-real-time-demographics/).

## Common Failure Patterns

**1. Points on borders and boundary precision.** A POI exactly on a shared edge, or a simplified boundary whose vertices drift a few meters, can match zero polygons or two adjacent ones. `contains` treats the boundary as open, so a point on the line is *not* contained. When a coordinate must resolve, fall back from `contains` to `intersects` and pick the smallest matching area, or buffer the query point by a sub-meter tolerance:

```python
idx = geocoder.tree.query(point, predicate="intersects")   # includes the boundary
if len(idx) == 0:
    idx = geocoder.tree.query(point.buffer(1e-6), predicate="intersects")
```

**2. Skipping the R-tree — O(N) per point.** Iterating `for geom in geoms: if geom.contains(point)` looks equivalent and is catastrophically slower: every POI tests every polygon's full vertex ring. On a national boundary set this turns a minutes job into hours. Always query the `STRtree` so the bounding-box prefilter runs first; the exact test only touches candidates.

**3. CRS and axis-order mismatch.** shapely is a planar library that trusts whatever coordinates you hand it. Two traps compound here: constructing `Point(lat, lon)` instead of `Point(lon, lat)` silently mirrors every POI across the diagonal, and testing WGS84 points against boundaries stored in a projected CRS (say EPSG:3857) produces containment that is wrong everywhere. Normalize both point and polygons to the same CRS at load time, and keep the `(lon, lat)` axis order explicit:

```python
point = Point(lon, lat)   # x = longitude, y = latitude — never (lat, lon)
```

## Performance Notes

The dominant cost is the containment pass, not the graph write. For $Q$ POIs tested against $N$ boundary polygons where the tree returns $k$ bounding-box candidates per point and each candidate polygon has $\bar{v}$ vertices, total work is

$$C \approx Q\bigl(\log N + k \cdot \bar{v}\bigr)$$

The $\log N$ term is the tree descent; $k \cdot \bar{v}$ is the exact test over the few survivors. Without the tree the cost degrades to $Q \cdot N \cdot \bar{v}$ — the difference between `log N` and `N` candidates is the entire justification for the STRtree. Build the tree once and reuse it across the whole POI batch; rebuilding per point discards the amortization. On the write side, batch the resolved rows into a single `UNWIND` per transaction (the code sends all POIs in one `execute_write`) so the admin-area `MERGE` set amortizes across the batch, and keep boundary geometries pre-simplified to a tolerance matched to your smallest meaningful area — over-detailed polygons inflate $\bar{v}$ without changing which POIs they contain. These area edges then serve the same downstream role as the rest of the [POI enrichment workflows](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/poi-enrichment-workflows/).

## Related

- [Enriching POI data with real-time demographics](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/poi-enrichment-workflows/enriching-poi-data-with-real-time-demographics/) — attaching mobility and census attributes to the same POI nodes.
- [Spatial join techniques](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/spatial-join-techniques/) — intersecting nodes against external polygons at query time rather than a fixed hierarchy.
- [Building automated OSM-to-graph ETL pipelines](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/osm-data-ingestion-pipelines/building-automated-osm-to-graph-etl-pipelines/) — where the POI `id` and `location` anchors are first established.
- [Node and edge spatial mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/) — the point-property conventions the containment test depends on.

This guide is part of [POI Enrichment Workflows](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/poi-enrichment-workflows/), within the broader [Spatial Graph Construction & OSM Ingestion](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/) guide.
