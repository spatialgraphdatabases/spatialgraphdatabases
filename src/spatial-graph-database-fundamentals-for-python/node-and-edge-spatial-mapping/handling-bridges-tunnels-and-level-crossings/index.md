---
pageTitle: Bridges, Tunnels & Crossings
title: Handling Bridges, Tunnels and Level Crossings
description: Stop snapping from welding a bridge to the road beneath it, using the layer tag as the third dimension a 2-D tolerance cannot see.
slug: handling-bridges-tunnels-and-level-crossings
type: article
breadcrumb: Bridges & Tunnels
datePublished: 2026-08-11
dateModified: 2026-08-11
---
# Handling Bridges, Tunnels and Level Crossings

Coordinate snapping works because two endpoints within a tolerance of each other are almost always the same junction. Almost. The exception is grade separation: a bridge deck and the road beneath it share a coordinate to within centimetres and are not connected at all, and a snapping pass that does not know this welds them into one node. The graph then contains a junction that lets traffic turn off a motorway onto the canal towpath crossing under it, and the router will use it — it is the shortest path, and nothing in the data says it is impossible. This page adds the third dimension that separates them, using the tag the source already carries.

## Prerequisites & Versions

The layer information comes from OSM tags; the snapping is the same grid used elsewhere.

| Requirement | Minimum version | Install |
| --- | --- | --- |
| Python | 3.11 | — |
| neo4j (async driver) | 5.20 | `pip install "neo4j>=5.20"` |
| Neo4j Server | 5.15 | native `point` |

## Implementation

The snap key gains a layer component, so two endpoints only merge when they are close in space *and* on the same level.

```python
import math
from dataclasses import dataclass

EARTH_R = 6_371_008.8


@dataclass(frozen=True)
class Endpoint:
    lat: float
    lon: float
    layer: int          # OSM `layer`: 0 at grade, +1 a bridge, -1 a tunnel
    way_id: str
    is_structure: bool  # carries a bridge or tunnel tag


@dataclass(frozen=True)
class SnapKey:
    cell_x: int
    cell_y: int
    layer: int          # part of the key — this is the whole fix


class LayeredSnapGrid:
    """Snapping that refuses to merge across grade separation.

    A plain 2-D grid merges anything within the tolerance, which is correct for
    two ends of the same junction and catastrophic for a bridge deck and the
    road under it: they are within centimetres horizontally and are not
    connected in any sense a vehicle can use.
    """

    def __init__(self, tol_m: float = 1.5) -> None:
        self._tol_m = tol_m
        self._deg = math.degrees(tol_m / EARTH_R)

    def key(self, e: Endpoint) -> SnapKey:
        cos_lat = max(math.cos(math.radians(e.lat)), 1e-6)
        return SnapKey(
            cell_x=math.floor(e.lon / (self._deg / cos_lat)),
            cell_y=math.floor(e.lat / self._deg),
            layer=e.layer,
        )

    def may_merge(self, a: Endpoint, b: Endpoint) -> bool:
        """Two endpoints merge only when they agree on the level.

        The layer comparison is exact rather than approximate on purpose. A
        bridge at layer 1 and a road at layer 0 are never the same junction,
        however close their coordinates are — there is no tolerance at which
        that becomes true.
        """
        if a.layer != b.layer:
            return False
        return self._ground_distance(a, b) <= self._tol_m

    def _ground_distance(self, a: Endpoint, b: Endpoint) -> float:
        p1, p2 = math.radians(a.lat), math.radians(b.lat)
        dp, dl = p2 - p1, math.radians(b.lon - a.lon)
        h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
        return 2 * EARTH_R * math.asin(math.sqrt(h))


def layer_of(tags: dict[str, str]) -> int:
    """Derive the level from the tags, defaulting to grade.

    `layer` is the authoritative tag but is frequently absent on structures that
    obviously have one, so a bridge or tunnel tag without an explicit layer is
    inferred rather than left at 0 — leaving it at 0 is precisely the case that
    produces a weld.
    """
    if "layer" in tags:
        try:
            return int(tags["layer"])
        except ValueError:
            pass
    if tags.get("bridge") not in (None, "no"):
        return 1
    if tags.get("tunnel") not in (None, "no"):
        return -1
    return 0


CROSSING_CHECK = """
// Level crossings ARE connected, unlike bridges — a road and a railway at the
// same layer meeting at a point is a real junction with real rules.
MATCH (n:Junction)
WHERE n.layer = 0 AND n.crossing_type IS NOT NULL
RETURN n.id AS id, n.crossing_type AS kind, n.barrier AS barrier
"""
```

## How It Works

Three points carry it.

**The layer joins the snap key rather than modifying the tolerance.** It is tempting to treat height as another distance and widen or narrow the tolerance accordingly, but grade separation is categorical: a deck six metres up and a deck sixty metres up are equally not-connected to the road below. Making the layer part of the key means the merge simply never considers the pair, which is both correct and cheaper than any distance test.

**Missing layer tags are inferred, not defaulted.** A way tagged `bridge=yes` with no `layer` is extremely common, and treating its layer as 0 puts it on the same level as everything it crosses — reintroducing exactly the weld this page exists to prevent. Inferring +1 for a bridge and −1 for a tunnel is a better default because it is right far more often than it is wrong, and where it is wrong (a bridge over a bridge) the error is a missing connection rather than a fabricated one.

**Level crossings are the opposite case and must not be caught by the same rule.** A road crossing a railway at grade genuinely is a junction — the layers agree, the point is shared, and the connection is real, subject to whatever the crossing's rules are. A rule that separates by proximity alone would either weld the bridges or split the crossings; separating by layer gets both right, because the layer is exactly what distinguishes them.

<svg viewBox="0 0 780 320" role="img" aria-labelledby="bridgeWeldTitle bridgeWeldDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="bridgeWeldTitle">Three crossings that look identical from above and are not</title>
  <desc id="bridgeWeldDesc">Three places where two ways share a coordinate. A motorway bridge over a towpath: the ways are at layer 1 and layer 0, there is no connection, and snapping them together creates a turn that cannot be driven. A tunnel under a street: layer minus 1 against layer 0, again no connection. A level crossing where a road meets a railway at grade: both at layer 0, and this one is a genuine junction. Viewed only as coordinates all three are the same picture; the layer tag is the only thing that distinguishes the first two from the third.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="320" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Same coordinate, three different truths</text>
  <rect x="24" y="42" width="236" height="196" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-poor,#a8320f)" stroke-width="1.6"/>
  <text x="142" y="66" text-anchor="middle" font-size="11" font-weight="700" fill="var(--viz-poor,#a8320f)">bridge over towpath</text>
  <line x1="52" y1="126" x2="232" y2="126" stroke="var(--accent,#0a656d)" stroke-width="7" stroke-linecap="round"/>
  <text x="142" y="112" text-anchor="middle" font-size="9" font-weight="700" fill="var(--accent,#0a656d)">layer 1</text>
  <line x1="142" y1="160" x2="142" y2="212" stroke="var(--accent-3,#5b21b6)" stroke-width="4" stroke-linecap="round"/>
  <line x1="142" y1="80" x2="142" y2="112" stroke="var(--accent-3,#5b21b6)" stroke-width="4" stroke-linecap="round"/>
  <text x="176" y="196" font-size="9" font-weight="700" fill="var(--accent-3,#5b21b6)">layer 0</text>
  <rect x="60" y="220" width="164" height="12" rx="6" fill="var(--viz-poor,#a8320f)"/>
  <text x="142" y="252" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--viz-poor,#a8320f)">not a junction</text>
  <rect x="272" y="42" width="236" height="196" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-poor,#a8320f)" stroke-width="1.6"/>
  <text x="390" y="66" text-anchor="middle" font-size="11" font-weight="700" fill="var(--viz-poor,#a8320f)">tunnel under street</text>
  <line x1="300" y1="126" x2="480" y2="126" stroke="var(--accent-3,#5b21b6)" stroke-width="5" stroke-linecap="round"/>
  <text x="390" y="112" text-anchor="middle" font-size="9" font-weight="700" fill="var(--accent-3,#5b21b6)">layer 0</text>
  <line x1="390" y1="160" x2="390" y2="212" stroke="var(--accent,#0a656d)" stroke-width="6" stroke-linecap="round" stroke-dasharray="8 5"/>
  <line x1="390" y1="80" x2="390" y2="112" stroke="var(--accent,#0a656d)" stroke-width="6" stroke-linecap="round" stroke-dasharray="8 5"/>
  <text x="424" y="196" font-size="9" font-weight="700" fill="var(--accent,#0a656d)">layer −1</text>
  <rect x="308" y="220" width="164" height="12" rx="6" fill="var(--viz-poor,#a8320f)"/>
  <text x="390" y="252" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--viz-poor,#a8320f)">not a junction</text>
  <rect x="520" y="42" width="236" height="196" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="1.8"/>
  <text x="638" y="66" text-anchor="middle" font-size="11" font-weight="700" fill="var(--viz-good,#0a656d)">level crossing</text>
  <line x1="548" y1="126" x2="728" y2="126" stroke="var(--accent-2,#a8380b)" stroke-width="5" stroke-linecap="round"/>
  <text x="638" y="112" text-anchor="middle" font-size="9" font-weight="700" fill="var(--accent-2,#a8380b)">layer 0</text>
  <line x1="638" y1="80" x2="638" y2="212" stroke="var(--accent,#0a656d)" stroke-width="5" stroke-linecap="round"/>
  <text x="672" y="196" font-size="9" font-weight="700" fill="var(--accent,#0a656d)">layer 0</text>
  <circle cx="638" cy="126" r="8" fill="var(--viz-good,#0a656d)"/>
  <rect x="556" y="220" width="164" height="12" rx="6" fill="var(--viz-good,#0a656d)"/>
  <text x="638" y="252" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--viz-good,#0a656d)">a real junction</text>
  <text x="24" y="284" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">A tolerance-only rule has to choose: weld all three, or split all three. Both choices are wrong for two of the cases —</text>
  <text x="24" y="300" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">which is why the layer belongs in the snap key rather than in the tolerance.</text>
  <text x="24" y="316" font-size="10" fill="var(--viz-ink-mute,#565f6d)">The fabricated turn is the worse failure: a router will use it, and a driver will be told to take it.</text>
</svg>

## Common Failure Patterns

**1. Trusting `layer` to be present.** It is optional and frequently omitted on structures that plainly have one. Inferring from `bridge` and `tunnel` covers most of the gap, and the residue is worth counting rather than ignoring — a region with an unusually high proportion of untagged structures is a data-quality signal about that region's mapping, not about your pipeline.

**2. Splitting genuine level crossings.** Over-correcting by treating any road-railway meeting as separated removes real junctions, and the symptom is the opposite of the weld: routes that detour absurdly because a crossing the driver uses daily does not exist in the graph. The layer test gets this right automatically, which is why it is preferable to a rule based on way types.

**3. Ignoring the vertical dimension in the elevation pass too.** A bridge sampled from a bare-earth model takes the height of what is underneath, which produces impossible gradients at the portals — the same underlying confusion, appearing in a different pipeline stage. The [elevation enrichment](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/elevation-and-terrain-enrichment/) handles it with the same tags.

```cypher
// Post-build audit: junctions that merged endpoints from different layers.
MATCH (j:Junction)
WHERE size(j.source_layers) > 1
RETURN j.id AS junction, j.source_layers AS layers, j.source_ways AS ways
ORDER BY size(j.source_layers) DESC;
```

## Performance Notes

Adding the layer to the key costs nothing measurable — it is one more integer in a tuple that was already being hashed — and it reduces the candidate set inside each cell, because endpoints on different layers no longer need pairwise distance tests. On a dense urban extract with many grade separations, the snapping pass is typically slightly *faster* with the layer included than without.

The real cost sits in the audit, and it is worth paying once per import rather than never:

$$\text{welds} \approx \sum_{\text{cells}} \binom{n_{\text{layers}}}{2}$$

Counting junctions whose contributing endpoints span more than one layer is a single aggregation and gives an exact figure for how many fabricated turns an import created. On a national extract that number should be zero after this change and is typically in the thousands before it — which is a useful thing to be able to state, because "we fixed the bridge problem" is otherwise unverifiable.

One caveat worth planning around: `layer` is a *relative* ordering, not an absolute height. Two ways both at layer 1 in different parts of the map are not at the same altitude, and nothing about the tag implies they are. That is fine for the merge decision, which is local and only ever compares endpoints within a tolerance of each other, but it means the layer must not be reused as an elevation — the [DEM sampling](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/elevation-and-terrain-enrichment/) is what supplies real heights, and the two properties answer different questions.

<svg viewBox="0 0 780 288" role="img" aria-labelledby="weldCostTitle weldCostDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="weldCostTitle">What a welded junction does to a route, and why nothing reports it</title>
  <desc id="weldCostDesc">A route computed over a graph containing one welded junction where a motorway bridge was merged with the towpath beneath it. The router finds a path that leaves the motorway, travels 300 metres along the towpath, and rejoins — saving four minutes over the legal route. Every stage of the system behaves correctly: the graph is connected, the search is optimal over that graph, the geometry is valid and the response passes every schema check. The only thing wrong is that the turn does not exist, and nothing in the pipeline is in a position to notice.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="288" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">One welded junction, and every check still green</text>
  <rect x="24" y="42" width="732" height="90" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.2"/>
  <line x1="60" y1="76" x2="720" y2="76" stroke="var(--accent,#0a656d)" stroke-width="6" stroke-linecap="round"/>
  <text x="90" y="64" font-size="9.5" font-weight="700" fill="var(--accent,#0a656d)">motorway</text>
  <line x1="300" y1="112" x2="500" y2="112" stroke="var(--accent-3,#5b21b6)" stroke-width="4" stroke-linecap="round"/>
  <text x="400" y="128" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--accent-3,#5b21b6)">towpath</text>
  <path d="M300 76 L300 112 L500 112 L500 76" fill="none" stroke="var(--viz-poor,#a8320f)" stroke-width="2.4" stroke-dasharray="7 4"/>
  <circle cx="300" cy="76" r="6" fill="var(--viz-poor,#a8320f)"/>
  <circle cx="500" cy="76" r="6" fill="var(--viz-poor,#a8320f)"/>
  <text x="400" y="96" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-poor,#a8320f)">the route the welded junctions permit — saves 4 min</text>
  <g font-size="10.5" font-weight="700" text-anchor="middle">
    <rect x="24" y="152" width="140" height="24" rx="12" fill="var(--viz-good,#0a656d)"/><text x="94" y="169" fill="var(--viz-on-pill,#ffffff)">graph connected</text>
    <rect x="176" y="152" width="140" height="24" rx="12" fill="var(--viz-good,#0a656d)"/><text x="246" y="169" fill="var(--viz-on-pill,#ffffff)">search optimal</text>
    <rect x="328" y="152" width="140" height="24" rx="12" fill="var(--viz-good,#0a656d)"/><text x="398" y="169" fill="var(--viz-on-pill,#ffffff)">geometry valid</text>
    <rect x="480" y="152" width="140" height="24" rx="12" fill="var(--viz-good,#0a656d)"/><text x="550" y="169" fill="var(--viz-on-pill,#ffffff)">schema passes</text>
    <rect x="632" y="152" width="124" height="24" rx="12" fill="var(--viz-poor,#a8320f)"/><text x="694" y="169" fill="var(--viz-on-pill,#ffffff)">turn is fictional</text>
  </g>
  <text x="24" y="212" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">Four of the five are properties the pipeline can assert. The fifth is not derivable from the graph at all once the weld has</text>
  <text x="24" y="228" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">happened — the information that would have contradicted it was discarded during snapping.</text>
  <text x="24" y="256" font-size="10.5" font-weight="700" fill="currentColor">Which is the argument for the layer being in the key: it is cheaper to never create the weld than to detect one.</text>
</svg>

A last structural note. Once the layer is part of the snap key, it becomes worth carrying onto the junction itself rather than discarding it after the merge. A junction that knows it sits at layer 1 lets downstream passes make decisions the geometry alone cannot support — the elevation sampler can skip it and interpolate from the abutments, a turn-restriction importer can reject a restriction whose members span layers as certainly malformed, and the audit query above becomes possible at all. None of those are expensive, and all of them are impossible once the layer has been dropped, because the information that distinguished the bridge from the road beneath it is not recoverable from the merged node.

## Related

- [Node and Edge Spatial Mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/) — the mapping pass this rule belongs to.
- [Snapping Coordinates and Detecting Intersections](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/snapping-coordinates-and-detecting-intersections/) — the grid the layer is added to.
- [Elevation and Terrain Enrichment for Routing Graphs](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/elevation-and-terrain-enrichment/) — the same structures confusing a different pipeline stage.
- [OSM Data Ingestion Pipelines](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/osm-data-ingestion-pipelines/) — where the layer, bridge and tunnel tags are read.

This guide is part of [Node and Edge Spatial Mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/), within [Spatial Graph Database Fundamentals for Python](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/).
