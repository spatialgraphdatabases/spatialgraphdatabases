---
pageTitle: One-Sided Corridors
title: One-Sided Corridors for Divided Highways
description: Split a corridor by carriageway using the signed cross product of the segment bearing, so a stop on the far side of a barrier stops being offered.
slug: one-sided-corridors-for-divided-highways
type: article
breadcrumb: One-Sided Corridors
datePublished: 2026-08-11
dateModified: 2026-08-11
---
# One-Sided Corridors for Divided Highways

On an undivided street, both sides of the road are equally reachable and a symmetric corridor is correct. On a motorway, a dual carriageway or a road with a central reservation, the two sides are different places — a service area two hundred metres to the left may require driving twelve kilometres to the next interchange and back. A corridor that ignores which side a candidate is on will keep offering those, and the routing-based ranking will keep rejecting them after paying for two shortest-path queries each. Filtering by side first is a few floating-point operations per candidate and removes roughly half the set before any routing happens. This page derives the side test, handles the cases where it does not apply, and shows where it belongs in the pipeline.

## Prerequisites & Versions

Pure client-side geometry over the corridor's candidate set; no server-side dependency beyond the corridor query itself.

| Requirement | Minimum version | Install |
| --- | --- | --- |
| Python | 3.11 | — |
| neo4j (async driver) | 5.20 | `pip install "neo4j>=5.20"` |
| Neo4j Server | 5.15 | native `point` |

## Implementation

The side of a point relative to a directed segment is the sign of a two-dimensional cross product. The only subtlety is doing it in a local metric frame so that a degree of longitude and a degree of latitude are comparable.

```python
import math
from dataclasses import dataclass
from typing import Literal

EARTH_R = 6_371_008.8
Side = Literal["left", "right", "on"]


@dataclass(frozen=True)
class Segment:
    a_lat: float
    a_lon: float
    b_lat: float
    b_lon: float
    divided: bool          # is there a barrier between the carriageways?
    drive_side: Side       # "left" in the UK and Japan, "right" in most of Europe


def _to_local_m(lat: float, lon: float, ref_lat: float, ref_lon: float
                ) -> tuple[float, float]:
    """Metres east and north of a reference point.

    Working in degrees would make the cross product meaningless away from the
    equator, because a degree of longitude is shorter than a degree of latitude
    everywhere except there — the sign would still usually be right, and would
    flip in exactly the near-parallel cases this test exists to resolve.
    """
    east = math.radians(lon - ref_lon) * EARTH_R * math.cos(math.radians(ref_lat))
    north = math.radians(lat - ref_lat) * EARTH_R
    return east, north


def side_of(segment: Segment, lat: float, lon: float,
            tolerance_m: float = 3.0) -> Side:
    """Which side of the directed segment a point lies on.

    The cross product of the segment vector with the vector to the point is
    positive on the left and negative on the right, in a right-handed frame with
    east as x and north as y. Points within `tolerance_m` of the centreline are
    reported as "on", because a signed test on a point that is essentially on the
    line is noise rather than information.
    """
    ax, ay = _to_local_m(segment.a_lat, segment.a_lon, segment.a_lat, segment.a_lon)
    bx, by = _to_local_m(segment.b_lat, segment.b_lon, segment.a_lat, segment.a_lon)
    px, py = _to_local_m(lat, lon, segment.a_lat, segment.a_lon)

    seg_x, seg_y = bx - ax, by - ay
    seg_len = math.hypot(seg_x, seg_y)
    if seg_len < 1e-6:
        return "on"

    cross = seg_x * (py - ay) - seg_y * (px - ax)
    perpendicular_m = cross / seg_len          # signed distance, in metres
    if abs(perpendicular_m) <= tolerance_m:
        return "on"
    return "left" if perpendicular_m > 0 else "right"


def reachable_without_uturn(segment: Segment, lat: float, lon: float) -> bool:
    """A candidate is directly reachable when no barrier separates it.

    On an undivided road either side is fine. On a divided one, only the side the
    vehicle is driving on can be entered directly; the other requires an
    interchange, which is a routing cost rather than a geometric one.
    """
    if not segment.divided:
        return True
    side = side_of(segment, lat, lon)
    return side in ("on", segment.drive_side)
```

## How It Works

Three pieces make the test correct rather than merely plausible.

**The local metric frame is not optional.** In raw degrees the cross product mixes two units — a degree of longitude is about 111 km at the equator and 55 km at 60° north — so the sign is computed on a distorted plane. For a candidate well off to one side that distortion does not flip the answer; for one nearly in line with the segment, which is precisely the ambiguous case, it can. Converting to metres east and north around the segment's own start point removes the distortion at negligible cost.

**The tolerance band is what stops noise becoming a decision.** A candidate whose recorded coordinate sits a metre from the centreline is not meaningfully on either side, and the sign of its cross product is a property of GPS error rather than of geography. Reporting those as `"on"` and treating them as reachable avoids a filter that silently drops legitimate stops because a survey put them on the wrong pixel.

**Side is not the same as reachability, and the `divided` flag is what connects them.** On an ordinary street, both sides are reachable and the test should not be applied at all — running it there would halve the candidate set for no reason. The flag comes from the source data: OSM's `dual_carriageway`, a physical `barrier` tag, or the presence of two parallel one-way ways with the same name. Getting that flag right at [ingestion](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/osm-data-ingestion-pipelines/) matters more than the geometry does, because the geometry is exact and the flag is a judgement.

<svg viewBox="0 0 780 308" role="img" aria-labelledby="sideXTitle sideXDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="sideXTitle">The cross product's sign, and the band where its sign means nothing</title>
  <desc id="sideXDesc">A directed segment from A to B with three candidate points. The cross product of the segment vector with the vector to each point is positive for the point on the left, negative for the one on the right, and close to zero for the one nearly on the centreline. Because a coordinate a metre or two from the centre is within survey error, points inside a three-metre tolerance band are reported as on the line rather than assigned a side — otherwise the filter drops legitimate stops on the strength of GPS noise.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="308" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Sign of (B − A) × (P − A), in a local east-north frame</text>
  <rect x="24" y="42" width="732" height="180" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.2"/>
  <rect x="72" y="118" width="640" height="28" fill="var(--viz-ok,#7d6200)" opacity="0.16"/>
  <line x1="72" y1="132" x2="700" y2="132" stroke="var(--accent,#0a656d)" stroke-width="3"/>
  <path d="M700 132 L686 126 L686 138 Z" fill="var(--accent,#0a656d)"/>
  <circle cx="72" cy="132" r="6" fill="var(--accent,#0a656d)"/>
  <text x="72" y="164" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--accent,#0a656d)">A</text>
  <text x="700" y="164" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--accent,#0a656d)">B</text>
  <text x="386" y="112" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--viz-ok,#7d6200)">±3 m tolerance — reported as "on"</text>
  <circle cx="260" cy="76" r="7" fill="var(--viz-good,#0a656d)"/>
  <text x="274" y="72" font-size="10.5" font-weight="700" fill="var(--viz-good,#0a656d)">cross &gt; 0 → left</text>
  <line x1="260" y1="83" x2="260" y2="126" stroke="var(--viz-good,#0a656d)" stroke-width="1.3" stroke-dasharray="4 3"/>
  <circle cx="500" cy="192" r="7" fill="var(--accent-3,#5b21b6)"/>
  <text x="514" y="182" font-size="10.5" font-weight="700" fill="var(--accent-3,#5b21b6)">cross &lt; 0 → right</text>
  <line x1="500" y1="185" x2="500" y2="140" stroke="var(--accent-3,#5b21b6)" stroke-width="1.3" stroke-dasharray="4 3"/>
  <circle cx="380" cy="134" r="7" fill="var(--viz-ok,#7d6200)"/>
  <text x="240" y="200" font-size="10.5" font-weight="700" fill="var(--viz-ok,#7d6200)">|cross| ≈ 0 → "on", keep it</text>
  <line x1="374" y1="141" x2="330" y2="190" stroke="var(--viz-ok,#7d6200)" stroke-width="1.3" stroke-dasharray="4 3"/>
  <text x="24" y="254" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">Computed in degrees rather than metres, the same three points still classify correctly here — and the middle one</text>
  <text x="24" y="270" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">can flip at high latitude, because mixing a degree of longitude with a degree of latitude tilts the plane the sign is</text>
  <text x="24" y="286" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">measured on. The conversion costs two multiplications and removes the whole class of error.</text>
</svg>

## Common Failure Patterns

**1. Applying the side filter to undivided roads.** Half the candidates disappear for no reason, and the ones that disappear are the ones on the other side of an ordinary street — which any driver can reach by turning. The `divided` flag has to gate the test, and a graph that does not carry it should not be running this filter at all.

**2. Taking the side from the wrong segment.** A candidate near a junction is close to several segments with different bearings, and the side is only meaningful relative to the one the vehicle is actually on. Use the segment the candidate's perpendicular projection falls within — the same clamped projection the [corridor's exact clip](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/corridor-and-buffer-queries/) already computes, so it is available for free.

**3. Hard-coding the driving side.** A service that ships to both the UK and continental Europe with `drive_side="left"` compiled in offers the wrong carriageway in half its markets. It is a property of the region, and it belongs alongside the region's other routing configuration rather than in the geometry code.

```python
# WRONG: correct in Tokyo and London, wrong in Paris and Berlin.
if side_of(segment, lat, lon) == "left":
    keep(candidate)

# RIGHT: the side comes from the road, which got it from the region.
if reachable_without_uturn(segment, lat, lon):
    keep(candidate)
```

## Performance Notes

The filter costs a handful of arithmetic operations per candidate and removes, on a divided road, close to half of them:

$$N_{\text{routed}} \approx N_{\text{corridor}} \cdot \big(1 - f_{\text{divided}} \cdot 0.5\big)$$

where $f_{\text{divided}}$ is the fraction of the route on divided carriageway. On a long-distance trip that fraction is high and the saving is close to the full half; on an urban route it is small and so is the benefit. Either way the filter is essentially free, because it runs on data already in memory — the corridor query has just returned these candidates and their coordinates.

The ordering within the pipeline matters more than the filter's own cost. Run it *after* the envelope seek and the exact perpendicular clip, and *before* the [detour-cost ranking](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/corridor-and-buffer-queries/ranking-detour-cost-for-corridor-candidates/). That placement is what makes it worthwhile: the routing step is thousands of times more expensive per candidate than the geometry, so removing a candidate before it is routed saves real work, while removing one before it is clipped saves almost nothing.

There is one case where the filter should be relaxed rather than applied: a long trip with a mandatory stop, where a driver would accept an interchange detour because the alternative is running out of range. Treating "wrong side" as a ranking penalty rather than an exclusion handles that gracefully — the far-side candidates fall to the bottom of the list instead of vanishing from it, and the detour ranking then prices them honestly.

<svg viewBox="0 0 780 284" role="img" aria-labelledby="sidePipeTitle sidePipeDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="sidePipeTitle">Where the side filter belongs in the corridor pipeline</title>
  <desc id="sidePipeDesc">Candidate counts through four stages of a corridor query on a mostly-motorway route. The chunked envelope seek returns 1,240 rows; the exact perpendicular clip reduces that to 96; the side filter removes the 44 on the far carriageway, leaving 52; and only those 52 reach the detour-cost ranking, of which seven are actually routed. Placing the side filter before the ranking rather than after it is what makes it worth having, because the routing stage costs thousands of times more per candidate than the geometry does.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="284" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Candidates surviving each stage — mostly-motorway route</text>
  <rect x="24" y="44" width="732" height="46" rx="8" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <text x="44" y="64" font-size="11" font-weight="700" fill="currentColor">chunked envelope seek</text>
  <text x="44" y="81" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">index range per chunk</text>
  <rect x="330" y="56" width="300" height="20" rx="10" fill="var(--accent-3,#5b21b6)"/>
  <text x="668" y="72" font-size="12" font-weight="700" fill="currentColor">1,240</text>
  <rect x="24" y="98" width="732" height="46" rx="8" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <text x="44" y="118" font-size="11" font-weight="700" fill="currentColor">exact perpendicular clip</text>
  <text x="44" y="135" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">clamped distance to the polyline</text>
  <rect x="330" y="110" width="24" height="20" rx="10" fill="var(--accent,#0a656d)"/>
  <text x="668" y="126" font-size="12" font-weight="700" fill="currentColor">96</text>
  <rect x="24" y="152" width="732" height="46" rx="8" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="1.8"/>
  <text x="44" y="172" font-size="11" font-weight="700" fill="var(--viz-good,#0a656d)">side filter — this page</text>
  <text x="44" y="189" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">44 removed on the far carriageway, for the cost of a cross product</text>
  <rect x="330" y="164" width="14" height="20" rx="7" fill="var(--viz-good,#0a656d)"/>
  <text x="668" y="180" font-size="12" font-weight="700" fill="currentColor">52</text>
  <rect x="24" y="206" width="732" height="46" rx="8" fill="var(--viz-panel,#f4f4f5)" stroke="var(--accent-2,#a8380b)" stroke-width="1.4"/>
  <text x="44" y="226" font-size="11" font-weight="700" fill="currentColor">detour-cost ranking</text>
  <text x="44" y="243" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">two shortest paths each — thousands of times the cost per candidate</text>
  <rect x="330" y="218" width="6" height="20" rx="3" fill="var(--accent-2,#a8380b)"/>
  <text x="668" y="234" font-size="12" font-weight="700" fill="currentColor">7 routed</text>
  <text x="24" y="274" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">Moving the side filter one stage later would have it remove candidates that had already been routed, which is the whole saving gone.</text>
</svg>

A note on where the `divided` flag should live. It is tempting to derive it at query time from the road classification — motorways are divided, residential streets are not — but that rule is wrong often enough to matter: plenty of trunk roads are single carriageway, and plenty of urban avenues have a central reservation with no crossing for half a kilometre. Deriving it once at ingestion from the actual tags, and storing it on the segment, means the query is reading a fact rather than re-guessing it, and a correction to one road fixes every corridor that touches it rather than every code path that asks.

## Related

- [Corridor and Buffer Queries Along a Route](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/corridor-and-buffer-queries/) — the pipeline this filter sits inside.
- [Ranking Detour Cost for Corridor Candidates](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/corridor-and-buffer-queries/ranking-detour-cost-for-corridor-candidates/) — the expensive stage this one protects.
- [Snapping GPS Telemetry to Road Segments](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/spatial-join-techniques/snapping-gps-telemetry-to-road-segments/) — the clamped projection that picks the right segment to measure against.
- [Modeling Turn Restrictions as an Edge-Based Graph](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/turn-restriction-and-time-dependent-routing/modeling-turn-restrictions-as-an-edge-based-graph/) — where "you cannot get there from here" becomes a graph property rather than a geometric one.

This guide is part of [Corridor and Buffer Queries Along a Route](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/corridor-and-buffer-queries/), within [Cypher Spatial Queries & Pathfinding Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/).
