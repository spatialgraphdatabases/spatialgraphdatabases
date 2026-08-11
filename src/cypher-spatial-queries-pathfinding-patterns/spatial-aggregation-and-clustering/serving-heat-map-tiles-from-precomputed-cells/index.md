---
pageTitle: Heat-Map Tiles from Cells
title: Serving Heat-Map Tiles from Precomputed Cells
description: Turn a stored cell key into a tile pyramid so a map pans and zooms against fixed-cost lookups instead of re-aggregating the label on every viewport change.
slug: serving-heat-map-tiles-from-precomputed-cells
type: article
breadcrumb: Heat-Map Tiles
datePublished: 2026-08-11
dateModified: 2026-08-11
---
# Serving Heat-Map Tiles from Precomputed Cells

A density map is the most expensive thing a spatial dashboard does, and the reason is interaction. One aggregation is fine. A user panning a map fires one per viewport change, at a rate limited only by how fast they can drag, and each of those queries scans a slice of the label and returns a differently-shaped result that nothing can cache. The endpoint that looked acceptable in review falls over the first time someone actually uses it. The fix is to stop answering viewport queries at all: precompute counts per cell per zoom level, address them by tile coordinate the way any map server does, and let the aggregation become a bounded lookup with a cacheable key.

## Prerequisites & Versions

Everything here is plain Cypher over a stored cell key, plus whatever HTTP layer already serves the map.

| Requirement | Minimum version | Install |
| --- | --- | --- |
| Python | 3.11 | — |
| neo4j (async driver) | 5.20 | `pip install "neo4j>=5.20"` |
| Neo4j Server | 5.15 | range indexes |

## Implementation

Tiles are addressed by the standard slippy-map `(z, x, y)` triple. The nightly pass writes one `CellSummary` per occupied tile per zoom; the request path reads a rectangle of them.

```python
import asyncio
import math
from dataclasses import dataclass

from neo4j import AsyncGraphDatabase

BUILD = """
MATCH (d:Delivery)
WHERE d.tenant_id = $tenant AND d.location IS NOT NULL
WITH $zoom AS z,
     toInteger(floor((d.location.longitude + 180.0) / 360.0 * $n))        AS tx,
     toInteger(floor((1.0 - log(tan(radians(d.location.latitude)) +
        1.0 / cos(radians(d.location.latitude))) / pi()) / 2.0 * $n))     AS ty,
     d
MERGE (c:CellSummary {tenant_id: $tenant, z: z, x: tx, y: ty})
SET c.count = count(d), c.built_at = datetime()
RETURN count(c) AS tiles
"""

READ = """
MATCH (c:CellSummary)
WHERE c.tenant_id = $tenant AND c.z = $z
  AND c.x >= $x0 AND c.x <= $x1
  AND c.y >= $y0 AND c.y <= $y1
RETURN c.x AS x, c.y AS y, c.count AS n
"""


@dataclass(frozen=True)
class Tile:
    z: int
    x: int
    y: int

    @property
    def cache_key(self) -> str:
        return f"{self.z}/{self.x}/{self.y}"


def tile_for(lat: float, lon: float, zoom: int) -> Tile:
    """Standard Web Mercator tile addressing — the same scheme the map client uses.

    Using the client's own scheme is the whole point: the server never has to
    translate a viewport into anything, because the client already asks in tiles.
    """
    n = 2 ** zoom
    lat_rad = math.radians(max(min(lat, 85.05112878), -85.05112878))
    x = int((lon + 180.0) / 360.0 * n)
    y = int((1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n)
    return Tile(z=zoom, x=min(max(x, 0), n - 1), y=min(max(y, 0), n - 1))


class TileService:
    def __init__(self, uri: str, auth: tuple[str, str]) -> None:
        self._driver = AsyncGraphDatabase.driver(uri, auth=auth)

    async def close(self) -> None:
        await self._driver.close()

    async def build(self, tenant: str, zooms: range = range(6, 15)) -> dict[int, int]:
        """Build every zoom in one pass per level. Coarse levels are cheap; the
        finest level is what the cost is, so cap it at the deepest zoom the UI
        actually offers rather than at the deepest one Mercator defines."""
        written: dict[int, int] = {}
        async with self._driver.session() as session:
            for z in zooms:
                result = await session.run(BUILD, tenant=tenant, zoom=z, n=2 ** z)
                written[z] = int((await result.single())["tiles"])
        return written

    async def viewport(
        self, tenant: str, z: int, x0: int, y0: int, x1: int, y1: int
    ) -> list[dict]:
        # A viewport is a rectangle of tiles, and the count of tiles in it is
        # roughly constant no matter where or how far in the user is — which is
        # what makes this endpoint's cost independent of the data.
        async with self._driver.session() as session:
            result = await session.run(
                READ, tenant=tenant, z=z, x0=x0, x1=x1, y0=y0, y1=y1
            )
            return [dict(record) async for record in result]


async def main() -> None:
    service = TileService("neo4j://localhost:7687", ("neo4j", "password"))
    try:
        counts = await service.build("acme-logistics")
        for z, n in sorted(counts.items()):
            print(f"z{z:<3}{n:>10,} occupied tiles")

        nw = tile_for(51.5400, -0.1900, zoom=12)
        se = tile_for(51.4700, -0.0700, zoom=12)
        cells = await service.viewport(
            "acme-logistics", 12, nw.x, nw.y, se.x, se.y
        )
        print(f"viewport → {len(cells)} tiles, {sum(c['n'] for c in cells):,} deliveries")
    finally:
        await service.close()


if __name__ == "__main__":
    asyncio.run(main())
```

## How It Works

Three properties make this cheap, and they are all consequences of using the client's own addressing scheme rather than inventing one.

**A viewport is a fixed number of tiles.** A screen shows roughly the same tile count whether the user is looking at a city block or a continent — zooming out makes each tile cover more ground, not the viewport cover more tiles. So the read is bounded by the display, not by the data, and an endpoint whose cost was proportional to the label becomes one whose cost is constant.

**Tile coordinates are integers with a natural range predicate.** `x` and `y` between two bounds is an index range on a composite key, which seeks. Contrast with a viewport expressed as a lat/lon box against a point index: that also seeks, but it returns *rows*, and the number of rows depends entirely on how dense the region is. The tile version returns one row per occupied tile, which is at most the tiles on screen.

**The cache key is the tile address.** `z/x/y` is stable, shared between users, and independent of the exact viewport — two people looking at slightly different parts of the same city request overlapping sets of the same tiles. A lat/lon bounding box has none of those properties: every viewport is a fresh key, so nothing is ever a cache hit and every pan is a fresh query.

The zoom pyramid is what makes the whole thing hold together. Each level is built independently from the source points rather than by aggregating the level below, which costs more at build time but avoids the accumulated rounding that hierarchical roll-up introduces at tile boundaries. Building the fine levels dominates; the coarse ones are almost free, because there are so few tiles at low zoom.

<svg viewBox="0 0 780 316" role="img" aria-labelledby="tileCostTitle tileCostDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="tileCostTitle">A viewport holds the same number of tiles at every zoom, which is the whole trick</title>
  <desc id="tileCostDesc">The same screen at three zoom levels over the same city. At zoom 10 the viewport covers the whole metropolitan area in about twenty tiles; at zoom 13 it covers a few districts in about twenty tiles; at zoom 16 it covers a few streets in about twenty tiles. The ground area changes by three orders of magnitude and the row count does not. A bounding-box aggregation over the raw points behaves the opposite way — the same three viewports scan wildly different numbers of rows, and the densest one is the one a user is most likely to look at.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="316" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Same screen, three zoom levels, same number of rows</text>
  <rect x="24" y="42" width="236" height="188" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.2"/>
  <text x="142" y="66" text-anchor="middle" font-size="11.5" font-weight="700" fill="currentColor">zoom 10 — the metro area</text>
  <g stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1">
    <line x1="72" y1="82" x2="72" y2="190"/><line x1="120" y1="82" x2="120" y2="190"/><line x1="168" y1="82" x2="168" y2="190"/><line x1="216" y1="82" x2="216" y2="190"/>
    <line x1="52" y1="109" x2="232" y2="109"/><line x1="52" y1="136" x2="232" y2="136"/><line x1="52" y1="163" x2="232" y2="163"/>
  </g>
  <rect x="52" y="82" width="180" height="108" fill="var(--accent,#0a656d)" opacity="0.1"/>
  <rect x="52" y="82" width="180" height="108" fill="none" stroke="var(--accent,#0a656d)" stroke-width="1.8"/>
  <text x="142" y="210" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--accent,#0a656d)">~20 tiles</text>
  <rect x="272" y="42" width="236" height="188" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.2"/>
  <text x="390" y="66" text-anchor="middle" font-size="11.5" font-weight="700" fill="currentColor">zoom 13 — a few districts</text>
  <g stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1">
    <line x1="320" y1="82" x2="320" y2="190"/><line x1="368" y1="82" x2="368" y2="190"/><line x1="416" y1="82" x2="416" y2="190"/><line x1="464" y1="82" x2="464" y2="190"/>
    <line x1="300" y1="109" x2="480" y2="109"/><line x1="300" y1="136" x2="480" y2="136"/><line x1="300" y1="163" x2="480" y2="163"/>
  </g>
  <rect x="300" y="82" width="180" height="108" fill="var(--accent,#0a656d)" opacity="0.1"/>
  <rect x="300" y="82" width="180" height="108" fill="none" stroke="var(--accent,#0a656d)" stroke-width="1.8"/>
  <text x="390" y="210" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--accent,#0a656d)">~20 tiles</text>
  <rect x="520" y="42" width="236" height="188" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.2"/>
  <text x="638" y="66" text-anchor="middle" font-size="11.5" font-weight="700" fill="currentColor">zoom 16 — a few streets</text>
  <g stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1">
    <line x1="568" y1="82" x2="568" y2="190"/><line x1="616" y1="82" x2="616" y2="190"/><line x1="664" y1="82" x2="664" y2="190"/><line x1="712" y1="82" x2="712" y2="190"/>
    <line x1="548" y1="109" x2="728" y2="109"/><line x1="548" y1="136" x2="728" y2="136"/><line x1="548" y1="163" x2="728" y2="163"/>
  </g>
  <rect x="548" y="82" width="180" height="108" fill="var(--accent,#0a656d)" opacity="0.1"/>
  <rect x="548" y="82" width="180" height="108" fill="none" stroke="var(--accent,#0a656d)" stroke-width="1.8"/>
  <text x="638" y="210" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--accent,#0a656d)">~20 tiles</text>
  <rect x="24" y="246" width="732" height="48" rx="9" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-poor,#a8320f)" stroke-width="1.4"/>
  <text x="44" y="266" font-size="11" font-weight="700" fill="var(--viz-poor,#a8320f)">the same three viewports, aggregated over raw points instead</text>
  <text x="44" y="284" font-size="10" fill="var(--viz-ink-mute,#565f6d)">2,100 rows · 88,000 rows · 640 rows — unpredictable, uncacheable, and worst exactly where users look most</text>
</svg>

## Common Failure Patterns

**1. Building only the zoom levels someone asked for.** A pyramid with gaps means the client requests a level that does not exist and the endpoint either returns nothing or silently falls back to re-aggregating — which is the behaviour the whole design exists to avoid, reintroduced at exactly the zoom nobody tested. Build every level the UI can reach, and reject requests for levels outside that range rather than serving them a slow path.

**2. Aggregating the pyramid from the level below.** It is tempting, because summing four child tiles into a parent is trivial and fast. It is also where boundary rounding accumulates: a point that falls just inside one child at zoom 14 can be attributed to a different parent at zoom 12 than the one it belongs to, and the discrepancy compounds up the pyramid. Build each level from the source.

**3. Forgetting that `MERGE` on a four-property key needs an index.** `CellSummary` merged on `(tenant_id, z, x, y)` without a supporting constraint re-scans the label for every tile, which turns a nightly job into an overnight one.

```cypher
CREATE CONSTRAINT cell_summary_key IF NOT EXISTS
FOR (c:CellSummary) REQUIRE (c.tenant_id, c.z, c.x, c.y) IS UNIQUE;
```

## Performance Notes

Build cost is dominated entirely by the finest zoom level, because tile count quadruples per level:

$$T_{\text{total}} = \sum_{z=z_{\min}}^{z_{\max}} \min\!\left(4^{z},\ P\right)$$

where $P$ is the point count — once the level is fine enough that most tiles hold at most one point, tile count stops growing with $4^z$ and starts tracking $P$ instead. That ceiling is worth finding, because levels beyond it cost a full pass over the points and produce a tile set that is essentially the points again, with none of the compression that made the approach worthwhile. On a metropolitan delivery set, that crossover typically lands around zoom 16 or 17, which is coincidentally about as deep as a density map remains meaningful.

Read cost is flat and small, and the useful optimisation is not in the database at all: a tile response is immutable between builds, so it should carry a long cache lifetime and an ETag derived from `built_at`. That turns most pans into cache hits at the edge, and the database sees traffic only for tiles nobody has requested since the last build. Because the key is shared across users, a busy dashboard warms its own cache.

The one thing to keep an eye on is the `CellSummary` label's own size. At fine zooms over a large tenant it can rival the source label, which means it competes for the [page cache](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-memory-and-storage-tuning/sizing-the-page-cache-for-a-spatial-graph/) with everything else. Capping the deepest zoom is the lever, and it is also the honest one — a heat map at street level is a scatter plot wearing a costume.

<svg viewBox="0 0 780 292" role="img" aria-labelledby="tilePyrTitle tilePyrDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="tilePyrTitle">Tile count quadruples per level until it flattens against the point count</title>
  <desc id="tilePyrDesc">Occupied tiles per zoom level for a tenant of 4.2 million delivery points. From zoom 6 to about zoom 15 the count roughly quadruples each level, because each tile subdivides into four. Past zoom 16 most tiles contain at most one point, so the count stops tracking the theoretical four-to-the-z and flattens against the number of points. Levels past that crossover cost a full pass over the source and produce a summary the same size as the data, which is the point at which the pyramid has stopped compressing anything.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="292" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Occupied tiles per zoom — 4.2 M delivery points</text>
  <line x1="96" y1="48" x2="96" y2="212" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <line x1="96" y1="212" x2="720" y2="212" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <g font-size="9.5" fill="var(--viz-ink-mute,#565f6d)" text-anchor="middle">
    <text x="96" y="232">z6</text><text x="200" y="232">z9</text><text x="304" y="232">z12</text><text x="408" y="232">z14</text><text x="512" y="232">z16</text><text x="616" y="232">z18</text><text x="720" y="232">z20</text>
  </g>
  <text x="408" y="252" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">zoom level</text>
  <path d="M96 206 L200 190 L304 156 L408 116 L512 76 L616 66 L720 62" fill="none" stroke="var(--accent,#0a656d)" stroke-width="2.8"/>
  <line x1="96" y1="62" x2="720" y2="62" stroke="var(--viz-poor,#a8320f)" stroke-width="1.6" stroke-dasharray="6 4"/>
  <text x="112" y="56" font-size="10" font-weight="700" fill="var(--viz-poor,#a8320f)">4.2 M — one tile per point</text>
  <circle cx="512" cy="76" r="6" fill="var(--viz-ok,#7d6200)"/>
  <text x="524" y="104" font-size="10.5" font-weight="700" fill="var(--viz-ok,#7d6200)">crossover — cap the build here</text>
  <text x="524" y="120" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">past it the summary is as large as the data</text>
  <rect x="512" y="48" width="208" height="164" fill="var(--viz-poor,#a8320f)" opacity="0.08"/>
  <text x="24" y="272" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">The cap is a product decision as much as a technical one: below a certain cell size a density map is a scatter plot.</text>
</svg>

## Related

- [Spatial Aggregation and Clustering in Cypher](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/spatial-aggregation-and-clustering/) — the stored cell key this pyramid is built from.
- [Finding Dense Delivery Clusters with Neo4j GDS](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/spatial-aggregation-and-clustering/finding-dense-delivery-clusters-with-gds/) — what to reach for when tile boundaries are the problem.
- [Sizing the Page Cache for a Spatial Graph](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-memory-and-storage-tuning/sizing-the-page-cache-for-a-spatial-graph/) — budgeting for a summary label that can rival the source.
- [Distance Filter Query Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/) — the bounding-box read this replaces on the request path.

This guide is part of [Spatial Aggregation and Clustering in Cypher](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/spatial-aggregation-and-clustering/), within [Cypher Spatial Queries & Pathfinding Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/).
