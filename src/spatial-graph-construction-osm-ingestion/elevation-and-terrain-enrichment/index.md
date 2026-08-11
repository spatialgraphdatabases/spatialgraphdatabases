---
pageTitle: Elevation & Terrain Enrichment
title: Elevation and Terrain Enrichment for Routing Graphs
description: Attach elevation from a DEM to road nodes, derive per-edge gradient, and turn that into directional cost so a route stops treating a climb like a descent.
slug: elevation-and-terrain-enrichment
type: article
breadcrumb: Elevation & Terrain
datePublished: 2026-08-11
dateModified: 2026-08-11
---
# Elevation and Terrain Enrichment for Routing Graphs

A flat graph routes a cyclist up a fourteen per cent hill because it is two hundred metres shorter, sends a loaded truck over a pass that its gearbox will crawl, and tells an electric vehicle it has range it does not have. None of those is a routing bug — the algorithm found the cheapest path through the graph it was given, and the graph did not know the road went uphill. Elevation is the one attribute that turns a symmetric edge into an asymmetric one, and adding it changes not just the cost of a route but which route is chosen. This topic covers sampling a digital elevation model onto graph nodes, deriving a gradient per edge in each direction, and the failure modes that make terrain data quietly wrong rather than obviously missing.

## Prerequisites

Sampling a DEM needs a raster reader; everything downstream is arithmetic and Cypher.

| Requirement | Minimum version | Install |
| --- | --- | --- |
| Python | 3.11 | — |
| neo4j (async driver) | 5.20 | `pip install "neo4j>=5.20"` |
| Neo4j Server | 5.15 | native `point` |
| rasterio | 1.3 | `pip install "rasterio>=1.3"` |
| numpy | 1.26 | `pip install "numpy>=1.26"` |

## Core Concept & Mechanism

Elevation enters the graph as a node property and leaves it as a *directed* edge property, and that transformation is the whole point.

**Sampling is a raster lookup per node.** A digital elevation model is a grid of height values; a node's elevation is the value at its coordinate, interpolated from the surrounding cells. Nearest-neighbour sampling is fast and produces visible stair-stepping along a road that crosses cells diagonally; bilinear interpolation over the four neighbours costs a little more and produces a profile smooth enough to differentiate. For gradient work the interpolation is not a nicety — a stair-stepped profile produces alternating zero and extreme gradients on consecutive segments, and any cost model built on it is noise.

**Gradient is a per-direction property of the edge, not of the road.** The rise between two nodes is the same magnitude whichever way you travel, but its sign flips, and cost is not symmetric in that sign. A cyclist climbing eight per cent is doing several times the work of one descending it; a truck descending eight per cent may be slower than one climbing four, because of braking limits. So the model has to store gradient with a direction, which means either two relationships per road or one relationship whose cost function is evaluated with the direction of travel.

**Cost is a function of gradient, not a term added to it.** The temptation is to add a penalty proportional to the climb. That produces plausible results in the middle of the range and nonsense at the ends — it never makes a descent free, and it never makes a wall impassable. The models that behave are non-linear: for a cyclist, power required rises with gradient and speed falls out of it; for a vehicle, energy consumption per metre is roughly linear in gradient with a sharp regeneration cut-off on the descending side.

<svg viewBox="0 0 780 316" role="img" aria-labelledby="elevAsymTitle elevAsymDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="elevAsymTitle">The same road, two directions, two costs — which is why gradient is an edge property</title>
  <desc id="elevAsymDesc">A 1.4 kilometre road climbing 84 metres, a six per cent gradient. Travelled uphill by a cyclist it costs about eight minutes; travelled downhill it costs about three. A flat graph gives both directions the same cost derived from length alone and picks a route that is often right in one direction and clearly wrong in the other. Because the sign of the gradient flips with the direction of travel while its magnitude does not, the cost has to be stored per direction rather than per road, which is what makes an elevation-aware graph directed even where the road itself is two-way.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="316" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">1.4 km road · 84 m rise · 6% gradient</text>
  <rect x="24" y="42" width="732" height="150" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.2"/>
  <path d="M72 164 L708 74 L708 164 Z" fill="var(--viz-ok,#7d6200)" opacity="0.14"/>
  <path d="M72 164 L708 74" fill="none" stroke="var(--viz-ok,#7d6200)" stroke-width="3"/>
  <circle cx="72" cy="164" r="8" fill="var(--accent,#0a656d)"/>
  <circle cx="708" cy="74" r="8" fill="var(--accent,#0a656d)"/>
  <text x="72" y="186" text-anchor="middle" font-size="10" font-weight="700" fill="var(--accent,#0a656d)">A · 42 m</text>
  <text x="708" y="66" text-anchor="middle" font-size="10" font-weight="700" fill="var(--accent,#0a656d)">B · 126 m</text>
  <path d="M200 132 L320 115" fill="none" stroke="var(--viz-poor,#a8320f)" stroke-width="2.4"/>
  <path d="M320 115 L306 111 L308 121 Z" fill="var(--viz-poor,#a8320f)"/>
  <text x="256" y="106" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-poor,#a8320f)">A → B climbing</text>
  <path d="M560 96 L440 113" fill="none" stroke="var(--viz-good,#0a656d)" stroke-width="2.4"/>
  <path d="M440 113 L454 117 L452 107 Z" fill="var(--viz-good,#0a656d)"/>
  <text x="500" y="142" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-good,#0a656d)">B → A descending</text>
  <text x="24" y="222" font-size="11" font-weight="700" fill="currentColor">cyclist cost</text>
  <g font-size="10.5" font-weight="700" text-anchor="middle">
    <rect x="150" y="208" width="150" height="22" rx="11" fill="var(--viz-poor,#a8320f)"/><text x="225" y="224" fill="var(--viz-on-pill,#ffffff)">A → B  8.1 min</text>
    <rect x="320" y="208" width="150" height="22" rx="11" fill="var(--viz-good,#0a656d)"/><text x="395" y="224" fill="var(--viz-on-pill,#ffffff)">B → A  2.9 min</text>
  </g>
  <text x="490" y="224" font-size="10" fill="var(--viz-ink-mute,#565f6d)">a factor of 2.8 between the two directions</text>
  <text x="24" y="256" font-size="11" font-weight="700" fill="currentColor">flat graph</text>
  <g font-size="10.5" font-weight="700" text-anchor="middle">
    <rect x="150" y="242" width="150" height="22" rx="11" fill="var(--viz-ink-mute,#565f6d)"/><text x="225" y="258" fill="var(--viz-on-pill,#ffffff)">A → B  5.0 min</text>
    <rect x="320" y="242" width="150" height="22" rx="11" fill="var(--viz-ink-mute,#565f6d)"/><text x="395" y="258" fill="var(--viz-on-pill,#ffffff)">B → A  5.0 min</text>
  </g>
  <text x="490" y="258" font-size="10" fill="var(--viz-ink-mute,#565f6d)">wrong in both, and wrong in opposite ways</text>
  <text x="24" y="296" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">The flat figure is not a compromise between the two — it is a number that describes neither journey, and a router using it</text>
  <text x="24" y="312" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">will send a rider up the hill to save two hundred metres.</text>
</svg>

## Schema & Data Model

Elevation lives on the node; gradient and its derived costs live on the relationship, per direction.

```cypher
// Node elevation, plus the provenance that makes a resample decidable later.
CREATE INDEX junction_elevation IF NOT EXISTS
FOR (n:Junction) ON (n.elevation_m);

// Directed segments carry their own gradient. A two-way road is two
// relationships precisely so the two gradients can differ in sign.
CREATE INDEX segment_grade IF NOT EXISTS
FOR ()-[s:SEGMENT]-() ON (s.grade_pct);

// Sanity constraint on the source: a node with no elevation must be visible,
// not silently defaulted to zero.
MATCH (n:Junction) WHERE n.elevation_m IS NULL
RETURN count(n) AS missing_elevation;
```

Storing `dem_source` and `dem_resolution_m` alongside the elevation is worth the two properties. Elevation data is patched, replaced and improved; without provenance there is no way to tell which nodes came from a 30-metre global model and which from a 1-metre national LiDAR survey, and the two disagree by enough to matter on exactly the steep, narrow roads where the gradient matters most.

## Step-by-Step Implementation

**1. Sample the DEM with bilinear interpolation, in batches.**

```python
import asyncio
from dataclasses import dataclass

import numpy as np
import rasterio
from neo4j import AsyncGraphDatabase

WRITE_ELEVATION = """
UNWIND $batch AS row
MATCH (n:Junction {id: row.id})
SET n.elevation_m = row.elevation_m,
    n.dem_source = $source,
    n.dem_resolution_m = $resolution
RETURN count(n) AS updated
"""


@dataclass(frozen=True)
class Sampled:
    id: str
    elevation_m: float | None


class DemSampler:
    """Bilinear sampling of a DEM at node coordinates.

    Nearest-neighbour would be faster and is a trap: a road crossing cells
    diagonally comes out as a staircase, and differentiating a staircase gives
    alternating zero and extreme gradients on consecutive segments. Every cost
    model downstream then inherits that noise as if it were terrain.
    """

    def __init__(self, dem_path: str) -> None:
        self._dataset = rasterio.open(dem_path)
        self._nodata = self._dataset.nodata

    def close(self) -> None:
        self._dataset.close()

    def sample(self, points: list[tuple[str, float, float]]) -> list[Sampled]:
        coords = [(lon, lat) for _, lat, lon in points]
        values = list(self._dataset.sample(coords, indexes=1, masked=True))

        out: list[Sampled] = []
        for (node_id, _, _), value in zip(points, values):
            raw = float(value[0]) if not np.ma.is_masked(value[0]) else None
            if raw is None or (self._nodata is not None and raw == self._nodata):
                # A void in the DEM — over water, or outside coverage. Record it
                # as missing rather than as sea level, which is a real elevation.
                out.append(Sampled(node_id, None))
            else:
                out.append(Sampled(node_id, round(raw, 2)))
        return out


async def load_elevation(driver, sampler: DemSampler, rows, source: str,
                         resolution: float, batch: int = 5_000) -> int:
    updated = 0
    async with driver.session() as session:
        for i in range(0, len(rows), batch):
            chunk = rows[i:i + batch]
            sampled = sampler.sample(chunk)
            payload = [
                {"id": s.id, "elevation_m": s.elevation_m}
                for s in sampled if s.elevation_m is not None
            ]
            if not payload:
                continue
            result = await session.run(
                WRITE_ELEVATION, batch=payload, source=source, resolution=resolution
            )
            updated += int((await result.single())["updated"])
    return updated
```

**2. Derive gradient per directed segment.** The gradient is rise over run, and the run is the road's length rather than the straight-line distance between endpoints — a hairpin gains little height over a lot of tarmac.

```cypher
MATCH (a:Junction)-[s:SEGMENT]->(b:Junction)
WHERE a.elevation_m IS NOT NULL AND b.elevation_m IS NOT NULL
  AND s.length_m > 0
SET s.rise_m   = b.elevation_m - a.elevation_m,
    s.grade_pct = 100.0 * (b.elevation_m - a.elevation_m) / s.length_m
RETURN count(s) AS graded;
```

**3. Turn gradient into a cost the router can minimise.** That step is specific to the vehicle, and is worked through for cyclists in [grade-aware weights for bicycle routing](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/elevation-and-terrain-enrichment/grade-aware-weights-for-bicycle-routing/) and for energy in [computing edge grade and energy cost](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/elevation-and-terrain-enrichment/computing-edge-grade-and-energy-cost/).

## Query Patterns & Variants

**Find the segments a profile cannot use.** A loaded truck with a gradient limit, or an accessibility route with a wheelchair limit, is a filter over `grade_pct` — and because it is a stored property, it is index-seekable rather than computed per row.

```cypher
MATCH (a:Junction)-[s:SEGMENT]->(b:Junction)
WHERE s.grade_pct > $max_grade_pct
RETURN s.id AS segment_id, s.grade_pct AS grade, s.length_m AS length
ORDER BY grade DESC;
```

**Total ascent along a route**, which is the number cyclists actually compare routes on — and note that it sums only the positive rises, because descending does not undo a climb in any metric a rider cares about.

```cypher
MATCH (t:Trip {id: $trip_id})
UNWIND t.segment_ids AS seg_id
MATCH ()-[s:SEGMENT {id: seg_id}]->()
RETURN sum(CASE WHEN s.rise_m > 0 THEN s.rise_m ELSE 0 END) AS ascent_m,
       sum(CASE WHEN s.rise_m < 0 THEN -s.rise_m ELSE 0 END) AS descent_m;
```

**Detect elevation that disagrees with the road network.** A bridge sampled from a bare-earth DEM takes the height of the valley floor beneath it, producing an impossible gradient in and out. Segments whose gradient exceeds anything a road is built to is a cheap, effective detector.

## Performance Tuning

Sampling dominates the enrichment, and it is I/O-bound on the raster rather than on the graph:

$$C_{\text{sample}} \approx N \cdot \big(c_{\text{seek}} + c_{\text{interp}}\big)$$

The way to make it fast is spatial locality. A DEM is stored in tiles, and sampling nodes in coordinate order means each tile is read once and used for thousands of lookups; sampling in node-id order means the same tile is read, evicted and re-read repeatedly. Sorting the node batch by cell before sampling is a few lines and routinely gives an order of magnitude, and it costs nothing because the batch is in memory anyway.

The gradient derivation is a single pass over the relationships and is cheap, but it is worth doing in batches with periodic commits rather than as one transaction — a continental graph's segment count will exceed the [transaction memory budget](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-memory-and-storage-tuning/tuning-jvm-heap-for-gds-projections/) otherwise, and the operation is idempotent so a resumable batch loop loses nothing on failure.

One consequence worth planning for: adding elevation and gradient adds properties to every node and every relationship in the graph, which grows the store and therefore the [page cache requirement](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-memory-and-storage-tuning/sizing-the-page-cache-for-a-spatial-graph/). Two floats per segment on a continental network is not a rounding error, and it is worth measuring before and after rather than discovering it as a latency regression.

<svg viewBox="0 0 780 292" role="img" aria-labelledby="demOrderTitle demOrderDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="demOrderTitle">Sampling order decides how many times each DEM tile is read</title>
  <desc id="demOrderDesc">Two orderings of the same four thousand node lookups against a tiled elevation model. Sampling in node-id order visits tiles in essentially random sequence, so each tile is read, evicted and re-read many times and the raster reader spends its time on I/O. Sorting the batch by tile first means every tile is opened once and serves all the lookups that fall inside it, turning thousands of reads into dozens. The sort costs microseconds on a batch that is already in memory.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="292" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">4,000 lookups against a tiled DEM</text>
  <rect x="24" y="42" width="356" height="180" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-poor,#a8320f)" stroke-width="1.6"/>
  <text x="202" y="66" text-anchor="middle" font-size="11.5" font-weight="700" fill="var(--viz-poor,#a8320f)">node-id order</text>
  <g stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1">
    <line x1="76" y1="82" x2="76" y2="178"/><line x1="140" y1="82" x2="140" y2="178"/><line x1="204" y1="82" x2="204" y2="178"/><line x1="268" y1="82" x2="268" y2="178"/>
    <line x1="52" y1="114" x2="332" y2="114"/><line x1="52" y1="146" x2="332" y2="146"/>
  </g>
  <path d="M64 98 L232 130 L100 162 L296 98 L120 130 L264 162 L88 98 L300 130" fill="none" stroke="var(--viz-poor,#a8320f)" stroke-width="1.6"/>
  <text x="202" y="200" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">each tile opened and evicted repeatedly</text>
  <text x="202" y="216" text-anchor="middle" font-size="11" font-weight="700" fill="var(--viz-poor,#a8320f)">3,180 tile reads</text>
  <rect x="400" y="42" width="356" height="180" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="1.8"/>
  <text x="578" y="66" text-anchor="middle" font-size="11.5" font-weight="700" fill="var(--viz-good,#0a656d)">sorted by tile</text>
  <g stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1">
    <line x1="452" y1="82" x2="452" y2="178"/><line x1="516" y1="82" x2="516" y2="178"/><line x1="580" y1="82" x2="580" y2="178"/><line x1="644" y1="82" x2="644" y2="178"/>
    <line x1="428" y1="114" x2="708" y2="114"/><line x1="428" y1="146" x2="708" y2="146"/>
  </g>
  <path d="M440 98 L508 98 L508 130 L440 130 L440 162 L508 162" fill="none" stroke="var(--viz-good,#0a656d)" stroke-width="1.6"/>
  <path d="M528 98 L636 98 L636 130 L528 130 L528 162 L636 162" fill="none" stroke="var(--viz-good,#0a656d)" stroke-width="1.6"/>
  <text x="578" y="200" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">each tile opened once, then fully used</text>
  <text x="578" y="216" text-anchor="middle" font-size="11" font-weight="700" fill="var(--viz-good,#0a656d)">42 tile reads</text>
  <text x="24" y="256" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">The lookups are identical and the answers are identical. The only difference is the order they are asked in, and the sort</text>
  <text x="24" y="272" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">that produces it runs on a list that is already in memory.</text>
</svg>

## Edge Cases & Gotchas

- **Bridges and tunnels sampled from bare earth.** A bare-earth DEM records the ground, so a bridge deck takes the height of the river below it and a tunnel takes the height of the hill above. Both produce impossible gradients at the portals. Detect them by gradient magnitude and take the elevation from the connecting segments instead, or exclude structures from sampling entirely using the `bridge` and `tunnel` tags.
- **DEM voids are not sea level.** A masked or no-data cell means "unknown", and writing zero for it puts a junction at sea level in the middle of a plateau. Record the absence and let the gradient derivation skip those segments, which is visible, rather than inventing a height, which is not.
- **Vertical datum mismatches.** Elevations may be relative to an ellipsoid or to a geoid, and the two differ by tens of metres — consistently, so a route's total ascent is unaffected, but absolute heights and any threshold expressed in metres above sea level are wrong. Record the datum with the source.
- **Straight-line run instead of road length.** Dividing rise by the distance between endpoints rather than by the segment's own length overstates gradient on every bend, and dramatically on hairpins, which are exactly the steep roads where the number is consulted.
- **Resolution finer than the road network's accuracy.** A one-metre LiDAR DEM sampled at a node whose coordinate is accurate to five metres reads a height from the wrong side of the embankment. Smoothing over a short window along the road is more honest than sampling a single point.
- **Elevation changing under a cached projection.** A GDS projection built before an elevation refresh routes on the old costs indefinitely, because a projection is a snapshot. Re-project after any enrichment pass.

<svg viewBox="0 0 780 288" role="img" aria-labelledby="demBridgeTitle demBridgeDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="demBridgeTitle">A bare-earth DEM puts the bridge deck on the valley floor</title>
  <desc id="demBridgeDesc">A viaduct crossing a valley, with the bare-earth elevation model beneath it. Sampling the deck's junctions against that model returns the ground height under each one, so the two mid-span junctions come out 46 metres below the abutments. The derived gradient is minus 31 per cent onto the bridge and plus 31 per cent off it — steeper than any road is built, on a structure that is level. Interpolating the deck elevations between the abutments instead recovers the true near-zero gradient, and the gradient magnitude check is what flags the segments needing it.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="288" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">A level viaduct, sampled from the ground beneath it</text>
  <rect x="24" y="42" width="732" height="164" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.2"/>
  <path d="M56 90 L200 92 L300 168 L420 176 L520 96 L724 92 L724 190 L56 190 Z" fill="var(--viz-ink-mute,#565f6d)" opacity="0.22"/>
  <text x="360" y="192" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--viz-ink-mute,#565f6d)">bare-earth terrain</text>
  <line x1="120" y1="80" x2="660" y2="80" stroke="var(--accent,#0a656d)" stroke-width="4"/>
  <text x="390" y="70" text-anchor="middle" font-size="10" font-weight="700" fill="var(--accent,#0a656d)">viaduct deck — level</text>
  <g fill="var(--viz-good,#0a656d)">
    <circle cx="160" cy="80" r="6"/><circle cx="620" cy="80" r="6"/>
  </g>
  <g fill="var(--viz-poor,#a8320f)">
    <circle cx="320" cy="170" r="6"/><circle cx="450" cy="176" r="6"/>
  </g>
  <line x1="320" y1="86" x2="320" y2="164" stroke="var(--viz-poor,#a8320f)" stroke-width="1.4" stroke-dasharray="4 3"/>
  <line x1="450" y1="86" x2="450" y2="170" stroke="var(--viz-poor,#a8320f)" stroke-width="1.4" stroke-dasharray="4 3"/>
  <text x="386" y="130" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-poor,#a8320f)">sampled 46 m low</text>
  <text x="160" y="106" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--viz-good,#0a656d)">abutment</text>
  <text x="620" y="106" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--viz-good,#0a656d)">abutment</text>
  <text x="24" y="232" font-size="11" font-weight="700" fill="var(--viz-poor,#a8320f)">derived from the sample</text>
  <g font-size="10.5" font-weight="700" text-anchor="middle">
    <rect x="230" y="218" width="160" height="22" rx="11" fill="var(--viz-poor,#a8320f)"/><text x="310" y="234" fill="var(--viz-on-pill,#ffffff)">−31% then +31%</text>
  </g>
  <text x="406" y="234" font-size="10" fill="var(--viz-ink-mute,#565f6d)">steeper than any road is built — the impossible-grade check catches it</text>
  <text x="24" y="266" font-size="11" font-weight="700" fill="var(--viz-good,#0a656d)">interpolated across the deck</text>
  <g font-size="10.5" font-weight="700" text-anchor="middle">
    <rect x="230" y="252" width="160" height="22" rx="11" fill="var(--viz-good,#0a656d)"/><text x="310" y="268" fill="var(--viz-on-pill,#ffffff)">0.2% throughout</text>
  </g>
  <text x="406" y="268" font-size="10" fill="var(--viz-ink-mute,#565f6d)">what the structure's own geometry says</text>
</svg>


## Verification & Testing

Two checks catch nearly all of the failure modes above, and both run on the graph rather than on the raster.

```python
import pytest

# Nothing paved exceeds about 35%; anything above that is a data artefact,
# nearly always a bridge or tunnel sampled from the ground beneath or above it.
IMPOSSIBLE_GRADE_PCT = 35.0


@pytest.mark.asyncio
async def test_no_impossible_gradients(session):
    result = await session.run(
        "MATCH ()-[s:SEGMENT]->() WHERE abs(s.grade_pct) > $limit "
        "RETURN count(s) AS n, collect(s.id)[..5] AS examples",
        limit=IMPOSSIBLE_GRADE_PCT,
    )
    record = await result.single()
    assert record["n"] == 0, (
        f"{record['n']} segments above {IMPOSSIBLE_GRADE_PCT}% — "
        f"check bridges and tunnels: {record['examples']}"
    )


@pytest.mark.asyncio
async def test_reverse_segments_have_opposite_rise(session):
    """A two-way road's two directions must disagree in sign and agree in size."""
    result = await session.run(
        """
        MATCH (a:Junction)-[f:SEGMENT]->(b:Junction)-[r:SEGMENT]->(a)
        WHERE f.rise_m IS NOT NULL AND r.rise_m IS NOT NULL
          AND abs(f.rise_m + r.rise_m) > 0.05
        RETURN count(*) AS mismatched
        """
    )
    assert (await result.single())["mismatched"] == 0
```

The second test is the one that catches a half-finished enrichment pass, where one direction was regraded and the other was not — a state in which routing quietly prefers whichever direction has the stale, cheaper cost.

## FAQ

<details>
<summary>Which DEM resolution should I use?</summary>

Match it to the accuracy of the road geometry rather than maximising it. A 30-metre global model is adequate for long-distance vehicle routing, where gradients are averaged over kilometres. Cycling and accessibility routing want 5 metres or better, because a short steep ramp is exactly what a rider needs to know about and a coarse model averages it away. Sampling a 1-metre model at coordinates accurate to 5 metres buys precision you do not have.
</details>

<details>
<summary>Should elevation be on the node or the relationship?</summary>

Elevation on the node, gradient on the relationship. Elevation is a property of a place and is shared by every segment meeting there; gradient is a property of travelling between two places in a particular direction. Putting elevation on the relationship duplicates it once per incident edge and lets the copies drift.
</details>

<details>
<summary>Do I need two relationships for a two-way road?</summary>

If gradient affects cost, yes — or an equivalent arrangement where the cost function is evaluated with the direction of travel. A single undirected relationship with one `grade_pct` cannot represent a road that is a climb one way and a descent the other, which is every road that is not flat.
</details>

<details>
<summary>How do I stop bridges from corrupting the gradient?</summary>

Exclude structures from DEM sampling and interpolate their elevations from the junctions at either end, which is what a bridge deck actually does. The `bridge`, `tunnel` and `layer` tags from [OSM ingestion](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/osm-data-ingestion-pipelines/) carry the information needed to identify them.
</details>

<details>
<summary>Is total ascent enough to compare two routes?</summary>

For a rough comparison, yes, and it is the number riders quote. For a cost model, no — ascent treats a hundred metres gained at two per cent the same as a hundred metres gained at fourteen, and only one of those is rideable. The cost has to be non-linear in gradient, which is why ascent is a summary rather than a weight.
</details>

## Related

- [OSM Data Ingestion Pipelines](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/osm-data-ingestion-pipelines/) — the graph this enrichment runs against, and the tags that identify structures.
- [Attribute Synchronization Techniques](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/attribute-synchronization-techniques/) — keeping derived properties correct as the underlying data moves.
- [Network Routing Algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/) — the searches that consume these directional costs.
- [Graph Memory and Storage Tuning](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-memory-and-storage-tuning/) — budgeting for the properties this adds to every element.

This topic is part of [Spatial Graph Construction & OSM Ingestion](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/).
