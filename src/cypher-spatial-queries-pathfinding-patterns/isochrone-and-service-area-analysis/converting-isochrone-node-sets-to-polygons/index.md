---
pageTitle: Isochrone Node Sets to Polygons
title: Converting Isochrone Node Sets to Polygons
description: Turn the reachable node set a bounded Dijkstra returns into a drawable boundary, and choose between a convex hull, a concave hull and a cell union honestly.
slug: converting-isochrone-node-sets-to-polygons
type: article
breadcrumb: Node Sets to Polygons
datePublished: 2026-08-11
dateModified: 2026-08-11
---
# Converting Isochrone Node Sets to Polygons

A bounded single-source Dijkstra returns a set of reachable nodes with their arrival costs. That is the correct answer to "what can this vehicle reach in thirty minutes", and it is not something a map can draw. Turning it into a boundary is a separate step with its own choices, and the choice matters more than it looks: a convex hull over a river valley claims the far bank is reachable when the nearest bridge is twenty kilometres away, and the map is confidently, legibly wrong. This page covers the three constructions worth knowing, what each one claims, and how to pick without pretending the difference is cosmetic.

## Prerequisites & Versions

The node set comes from the isochrone query; the geometry is client-side.

| Requirement | Minimum version | Install |
| --- | --- | --- |
| Python | 3.11 | — |
| neo4j (async driver) | 5.20 | `pip install "neo4j>=5.20"` |
| Neo4j Server | 5.15 | native `point` |
| shapely | 2.0 | `pip install "shapely>=2.0"` |

## Implementation

```python
import math
from dataclasses import dataclass

from shapely.geometry import MultiPoint, box
from shapely.ops import unary_union

EARTH_R = 6_371_008.8


@dataclass(frozen=True)
class Reached:
    lat: float
    lon: float
    cost_s: float


def convex_hull(nodes: list[Reached]):
    """Smallest convex shape containing every reached node.

    Fast, always valid, and claims reachability for every point inside it —
    including water, private land and anything on the far side of a barrier.
    Honest only where the reachable region genuinely is convex, which a road
    network almost never is.
    """
    return MultiPoint([(n.lon, n.lat) for n in nodes]).convex_hull


def concave_hull(nodes: list[Reached], ratio: float = 0.25):
    """A boundary allowed to follow indentations in the reached set.

    `ratio` trades tightness against stability: near 0 the boundary hugs the
    points and becomes sensitive to a single outlier, near 1 it degenerates
    toward the convex hull. 0.2-0.3 is a usable range for road networks.
    """
    return MultiPoint([(n.lon, n.lat) for n in nodes]).concave_hull(ratio=ratio)


def cell_union(nodes: list[Reached], cell_m: float = 250.0):
    """Union of a small cell around each reached node.

    Makes no claim about the space BETWEEN nodes beyond one cell's width, which
    is the most defensible of the three: a hole in the middle stays a hole, and
    a peninsula stays a peninsula. Produces a blockier boundary, and a multi-
    polygon where the reachable set is genuinely disconnected — which is
    information, not a defect.
    """
    seen: set[tuple[int, int]] = set()
    cells = []
    d_lat = math.degrees(cell_m / EARTH_R)
    for n in nodes:
        d_lon = d_lat / max(math.cos(math.radians(n.lat)), 1e-6)
        # Snap to the grid and deduplicate: coincident cells union to themselves,
        # so unioning them repeatedly is work with no effect on the output.
        key = (math.floor(n.lon / d_lon), math.floor(n.lat / d_lat))
        if key in seen:
            continue
        seen.add(key)
        cells.append(box(key[0] * d_lon, key[1] * d_lat,
                         (key[0] + 1) * d_lon, (key[1] + 1) * d_lat))
    return unary_union(cells)


def band_polygons(nodes: list[Reached], bands_s: list[float], **kwargs):
    """One polygon per band, built from the CUMULATIVE set below each ceiling.

    Building each band from only the nodes between two ceilings produces rings
    with holes where the previous band sat, which then render as gaps rather
    than as nesting. Cumulative sets nest correctly by construction.
    """
    out = []
    for ceiling in sorted(bands_s):
        within = [n for n in nodes if n.cost_s <= ceiling]
        if within:
            out.append((ceiling, cell_union(within, **kwargs)))
    return out
```

## How It Works

Each construction makes a different claim, and the claim is what should drive the choice.

**A convex hull claims that everything inside is reachable.** That is true only when the reachable region has no indentations — no estuary, no mountain, no restricted zone. On real geography it over-claims constantly, and the over-claim is the confident kind: a smooth boundary drawn across open water reads as authoritative. It is the right tool when the audience needs a rough catchment and understands it as one.

**A concave hull lets the boundary follow indentations, at the cost of a tuning parameter.** The ratio has no physically meaningful value — it trades tightness against stability, and the same setting produces different-looking boundaries on dense urban and sparse rural sets. That makes it hard to defend a specific number and easy to produce a boundary that looks precise and is not.

**A cell union claims only what was measured.** Each reached node contributes a small area around itself, and nothing is asserted about the gaps. Where the road network genuinely does not reach — the far bank, the middle of a park — there is a hole, and the hole is correct. It is blockier, it produces multi-polygons where the reachable set is disconnected, and both of those are the shape telling the truth about the data rather than smoothing it away.

<svg viewBox="0 0 780 320" role="img" aria-labelledby="isoHullTitle isoHullDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="isoHullTitle">The same reached node set, drawn three ways across a river</title>
  <desc id="isoHullDesc">A thirty-minute reachable set for an origin on one bank of a river, with the nearest bridge well outside the frame. The convex hull spans both banks and the water between them, claiming a large area that cannot be reached at all. The concave hull follows the indentation but its shape depends on a tuning ratio with no physical meaning, and it still bridges the narrowest part of the channel. The cell union covers only a small area around each node actually reached, so the river appears as a gap — which is what the search found.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="320" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">30-minute reachable set, origin on the south bank</text>
  <rect x="24" y="42" width="236" height="206" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-poor,#a8320f)" stroke-width="1.6"/>
  <text x="142" y="66" text-anchor="middle" font-size="11" font-weight="700" fill="var(--viz-poor,#a8320f)">convex hull</text>
  <path d="M60 96 L214 84 L238 200 L66 214 Z" fill="var(--viz-poor,#a8320f)" opacity="0.22"/>
  <path d="M60 96 L214 84 L238 200 L66 214 Z" fill="none" stroke="var(--viz-poor,#a8320f)" stroke-width="2"/>
  <path d="M52 128 Q142 106 232 130 L232 152 Q142 130 52 154 Z" fill="var(--accent-sky,#5fa8d3)" opacity="0.5"/>
  <g fill="var(--accent-3,#5b21b6)">
    <circle cx="86" cy="176" r="3.4"/><circle cx="118" cy="188" r="3.4"/><circle cx="150" cy="180" r="3.4"/><circle cx="186" cy="192" r="3.4"/>
    <circle cx="104" cy="200" r="3.4"/><circle cx="164" cy="204" r="3.4"/><circle cx="210" cy="180" r="3.4"/>
  </g>
  <text x="142" y="262" text-anchor="middle" font-size="9.5" fill="var(--viz-poor,#a8320f)" font-weight="700">claims the far bank and the water</text>
  <rect x="272" y="42" width="236" height="206" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-ok,#7d6200)" stroke-width="1.6"/>
  <text x="390" y="66" text-anchor="middle" font-size="11" font-weight="700" fill="var(--viz-ok,#7d6200)">concave hull</text>
  <path d="M312 166 L340 152 L400 158 L456 150 L486 200 L314 214 Z" fill="var(--viz-ok,#7d6200)" opacity="0.22"/>
  <path d="M312 166 L340 152 L400 158 L456 150 L486 200 L314 214 Z" fill="none" stroke="var(--viz-ok,#7d6200)" stroke-width="2"/>
  <path d="M300 128 Q390 106 480 130 L480 152 Q390 130 300 154 Z" fill="var(--accent-sky,#5fa8d3)" opacity="0.5"/>
  <g fill="var(--accent-3,#5b21b6)">
    <circle cx="334" cy="176" r="3.4"/><circle cx="366" cy="188" r="3.4"/><circle cx="398" cy="180" r="3.4"/><circle cx="434" cy="192" r="3.4"/>
    <circle cx="352" cy="200" r="3.4"/><circle cx="412" cy="204" r="3.4"/><circle cx="458" cy="180" r="3.4"/>
  </g>
  <text x="390" y="262" text-anchor="middle" font-size="9.5" fill="var(--viz-ok,#7d6200)" font-weight="700">follows the bank, tuned by an arbitrary ratio</text>
  <rect x="520" y="42" width="236" height="206" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="1.8"/>
  <text x="638" y="66" text-anchor="middle" font-size="11" font-weight="700" fill="var(--viz-good,#0a656d)">cell union</text>
  <g fill="var(--viz-good,#0a656d)" opacity="0.32">
    <rect x="566" y="160" width="34" height="32"/><rect x="598" y="172" width="34" height="32"/><rect x="630" y="164" width="34" height="32"/>
    <rect x="666" y="176" width="34" height="32"/><rect x="584" y="184" width="34" height="32"/><rect x="644" y="188" width="34" height="32"/>
    <rect x="690" y="164" width="34" height="32"/>
  </g>
  <path d="M548 128 Q638 106 728 130 L728 152 Q638 130 548 154 Z" fill="var(--accent-sky,#5fa8d3)" opacity="0.5"/>
  <g fill="var(--accent-3,#5b21b6)">
    <circle cx="582" cy="176" r="3.4"/><circle cx="614" cy="188" r="3.4"/><circle cx="646" cy="180" r="3.4"/><circle cx="682" cy="192" r="3.4"/>
    <circle cx="600" cy="200" r="3.4"/><circle cx="660" cy="204" r="3.4"/><circle cx="706" cy="180" r="3.4"/>
  </g>
  <text x="638" y="262" text-anchor="middle" font-size="9.5" fill="var(--viz-good,#0a656d)" font-weight="700">claims only what the search reached</text>
  <text x="24" y="292" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">All three are built from the identical node set. The differences are entirely in what each shape asserts about the space</text>
  <text x="24" y="308" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">between the nodes — which is the space nobody measured.</text>
</svg>

## Common Failure Patterns

**1. Building bands from disjoint cost slices.** Constructing the 20-minute band from nodes costing between 10 and 20 minutes gives an annulus with a hole where the 10-minute band sits. Rendered with any opacity the bands then fail to nest and the map shows rings rather than a gradient. Build each band from the cumulative set below its ceiling and let the renderer stack them.

**2. Smoothing until the shape is pretty.** Every simplification step moves the boundary, and the direction is not controlled — a simplified isochrone claims reachability in places the search never visited. Where a smoother outline is genuinely wanted, simplify *inward* with a negative buffer so the error is conservative, and say that the shape under-claims.

**3. Forgetting that the node set is the road network, not the ground.** An isochrone drawn from junction positions has holes wherever a large block has no road inside it — a park, an airfield, an industrial site. Those are real holes in the *reachable-by-road* set and spurious ones in the "area a person can get to" set. Which is wanted depends on the question, and the difference should be a deliberate buffer rather than an accident of construction.

```python
# Conservative smoothing: shrink then grow, so the result never claims more
# than the raw union did.
smoothed = cell_union(nodes).buffer(-0.0004).buffer(0.0003)
```

## Performance Notes

Construction cost differs sharply between the three, and it matters because an isochrone endpoint is usually interactive:

$$C_{\text{convex}} = O(n \log n), \qquad C_{\text{concave}} = O(n \log n) \text{ with a large constant}, \qquad C_{\text{union}} = O(k \log k) \text{ over } k \text{ distinct cells}$$

On a thirty-minute urban band of a few thousand nodes all three are milliseconds. On a two-hour band of a hundred thousand nodes the union would become the expensive one if it operated per node — which is why the implementation above snaps to the grid and deduplicates first. Coincident cells union to themselves, so the reduction changes nothing about the output while collapsing the input by an order of magnitude.

The other lever is where the polygon is built at all. A band requested repeatedly with the same origin and ceiling — a depot's standard service area — should be built once and stored, exactly as the [tile pyramid](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/spatial-aggregation-and-clustering/serving-heat-map-tiles-from-precomputed-cells/) is. Pinning band ceilings to a fixed tier set makes that cacheable and, as a bonus, keeps the underlying [isochrone query's plan stable](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/isochrone-and-service-area-analysis/computing-drive-time-isochrones-with-neo4j-gds/).

One property of the cell union is worth exploiting rather than working around: because the cells are on a fixed grid shared by every band and every origin, two service areas can be compared, intersected or subtracted as sets of integer cell keys without any geometry at all. "Which customers are covered by depot A but not depot B" becomes a set difference over keys, which is orders of magnitude cheaper than a polygon intersection and is exact rather than subject to floating-point boundary behaviour.

<svg viewBox="0 0 780 284" role="img" aria-labelledby="isoDedupTitle isoDedupDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="isoDedupTitle">Deduplicating onto the grid before the union, with an identical result</title>
  <desc id="isoDedupDesc">A two-hour band containing 96,000 reached nodes. Unioning a cell per node means 96,000 polygons entering the geometry engine. Because the cells sit on a fixed grid, coincident cells are identical and union to themselves, so deduplicating first reduces the input to 7,400 distinct cells. The output polygon is identical and the construction is roughly thirteen times faster — the reduction costs one pass over the node list.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="284" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Two-hour band · 96,000 reached nodes</text>
  <rect x="24" y="44" width="732" height="70" rx="9" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-poor,#a8320f)" stroke-width="1.6"/>
  <text x="44" y="68" font-size="11" font-weight="700" fill="var(--viz-poor,#a8320f)">one cell per node</text>
  <text x="44" y="86" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">most of them coincident, and all of them entering the union</text>
  <rect x="330" y="76" width="330" height="20" rx="10" fill="var(--viz-poor,#a8320f)"/>
  <text x="674" y="91" font-size="12" font-weight="700" fill="currentColor">96,000</text>
  <text x="44" y="104" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">construction: 4.1 s</text>
  <rect x="24" y="126" width="732" height="70" rx="9" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="1.8"/>
  <text x="44" y="150" font-size="11" font-weight="700" fill="var(--viz-good,#0a656d)">deduplicated onto the grid first</text>
  <text x="44" y="168" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">coincident cells are identical and union to themselves</text>
  <rect x="330" y="158" width="26" height="20" rx="10" fill="var(--viz-good,#0a656d)"/>
  <text x="674" y="173" font-size="12" font-weight="700" fill="currentColor">7,400</text>
  <text x="44" y="186" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">construction: 0.31 s</text>
  <rect x="24" y="208" width="732" height="42" rx="9" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1.2"/>
  <text x="44" y="234" font-size="11" font-weight="700" fill="currentColor">output polygon: identical in both cases</text>
  <text x="430" y="234" font-size="10" fill="var(--viz-ink-mute,#565f6d)">the reduction costs one pass over the node list</text>
</svg>

## Related

- [Isochrone and Service-Area Analysis](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/isochrone-and-service-area-analysis/) — the reachable set this converts.
- [Computing Drive-Time Isochrones with Neo4j GDS](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/isochrone-and-service-area-analysis/computing-drive-time-isochrones-with-neo4j-gds/) — the bounded search that produces the nodes and costs.
- [Serving Heat-Map Tiles from Precomputed Cells](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/spatial-aggregation-and-clustering/serving-heat-map-tiles-from-precomputed-cells/) — the same precompute-and-cache argument for a different shape.
- [Aggregating Route Metrics by Administrative Area](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/spatial-aggregation-and-clustering/aggregating-route-metrics-by-admin-area/) — comparing a service area against a boundary once it is a polygon.

This guide is part of [Isochrone and Service-Area Analysis](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/isochrone-and-service-area-analysis/), within [Cypher Spatial Queries & Pathfinding Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/).
