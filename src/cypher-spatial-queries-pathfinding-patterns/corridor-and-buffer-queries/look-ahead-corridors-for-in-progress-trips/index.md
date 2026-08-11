---
pageTitle: Look-Ahead Corridors
title: Look-Ahead Corridors for In-Progress Trips
description: Clip the corridor at the vehicle's current position and at its remaining range, so an in-trip query returns what is reachable ahead rather than everything near the whole route.
slug: look-ahead-corridors-for-in-progress-trips
type: article
breadcrumb: Look-Ahead
datePublished: 2026-08-11
dateModified: 2026-08-11
---
# Look-Ahead Corridors for In-Progress Trips

A corridor computed once at trip planning is the wrong answer twenty minutes later. The vehicle has passed half of it, so half the results are behind the driver; and the far end of it may be beyond the range remaining in the battery or the tank, so some of the results are unreachable. Both errors point the same way — the list gets longer and less useful as the trip progresses, which is the opposite of what a driver needs. This page clips the corridor at both ends: at the current position, using the route progress the vehicle is already reporting, and at the range horizon, using the same cumulative cost the router already computed. What is left is a short list of things that are ahead and attainable.

## Prerequisites & Versions

The clipping is arithmetic over the route's cumulative cost profile; the seek is the ordinary corridor query.

| Requirement | Minimum version | Install |
| --- | --- | --- |
| Python | 3.11 | — |
| neo4j (async driver) | 5.20 | `pip install "neo4j>=5.20"` |
| Neo4j Server | 5.15 | native `point` |

## Implementation

The route is carried with a cumulative cost at every vertex — a profile the router produced anyway. Clipping is then a pair of binary searches over that profile rather than any geometry at all.

```python
import bisect
import math
from dataclasses import dataclass


@dataclass(frozen=True)
class RoutePoint:
    lat: float
    lon: float
    cum_m: float     # metres from the origin along the route
    cum_s: float     # seconds from the origin along the route


@dataclass(frozen=True)
class Progress:
    """Where the vehicle is, and how far it can still go.

    `travelled_m` comes from map-matching the latest fix onto the route, so it is
    the distance ALONG the polyline rather than the straight-line displacement —
    the two diverge sharply on anything with a bend in it.
    """
    travelled_m: float
    range_m: float
    reserve_m: float = 15_000.0   # never plan to arrive empty


class LookAheadClipper:
    def __init__(self, route: list[RoutePoint]) -> None:
        if len(route) < 2:
            raise ValueError("a route needs at least two points")
        self._route = route
        self._cum = [p.cum_m for p in route]

    def clip(self, progress: Progress) -> list[RoutePoint]:
        """The stretch of route that is both ahead of the vehicle and reachable.

        Returns an empty list when the horizon has already been passed, which is
        the honest answer: there is nothing ahead worth offering, and the caller
        should be telling the driver to stop rather than showing an empty map.
        """
        horizon_m = progress.travelled_m + max(
            0.0, progress.range_m - progress.reserve_m
        )

        start = bisect.bisect_left(self._cum, progress.travelled_m)
        end = bisect.bisect_right(self._cum, horizon_m)
        if start >= end:
            return []

        clipped = self._route[max(0, start - 1):end]
        # Interpolate the true endpoints so the corridor starts exactly at the
        # vehicle and ends exactly at the range horizon, not at whichever route
        # vertex happened to fall nearest to each.
        head = _interpolate(self._route, progress.travelled_m)
        tail = _interpolate(self._route, horizon_m)
        return [head, *clipped[1:-1], tail] if len(clipped) > 2 else [head, tail]

    def reachable_fraction(self, progress: Progress) -> float:
        """How much of what remains is actually attainable — 1.0 means the whole
        rest of the trip, and anything below it is a refuelling decision."""
        remaining = self._cum[-1] - progress.travelled_m
        if remaining <= 0:
            return 1.0
        usable = max(0.0, progress.range_m - progress.reserve_m)
        return min(1.0, usable / remaining)


def _interpolate(route: list[RoutePoint], at_m: float) -> RoutePoint:
    cum = [p.cum_m for p in route]
    i = min(max(bisect.bisect_left(cum, at_m), 1), len(route) - 1)
    a, b = route[i - 1], route[i]
    span = b.cum_m - a.cum_m
    t = 0.0 if span <= 0 else (at_m - a.cum_m) / span
    return RoutePoint(
        lat=a.lat + (b.lat - a.lat) * t,
        lon=a.lon + (b.lon - a.lon) * t,
        cum_m=at_m,
        cum_s=a.cum_s + (b.cum_s - a.cum_s) * t,
    )
```

## How It Works

Three properties make this cheap and correct.

**Progress is a distance along the route, not a position in space.** Map-matching the latest GPS fix onto the polyline gives `travelled_m`, and that single scalar is enough to clip — no geometry, no comparison of the vehicle's coordinate against every vertex. Using straight-line displacement from the origin instead would be wrong the moment the route bends, and badly wrong on anything with a loop or a doubling-back.

**The horizon is the same arithmetic.** Range remaining, minus a reserve, added to the distance already travelled, is a cumulative distance — the same units the profile is indexed by. So both ends of the clip are binary searches into a sorted list, which is microseconds regardless of how many vertices the route has.

**Interpolating the endpoints matters more than it looks.** Snapping the clip to the nearest route vertex can move the start of the corridor hundreds of metres — kilometres, on motorway geometry where consecutive vertices are far apart — and every one of those metres is corridor either wrongly included behind the vehicle or wrongly excluded ahead of it. Interpolating puts the endpoints exactly where they belong at the cost of one linear blend each.

<svg viewBox="0 0 780 300" role="img" aria-labelledby="lookClipTitle lookClipDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="lookClipTitle">A corridor clipped at both ends, and what each clip removes</title>
  <desc id="lookClipDesc">A route with the vehicle 96 kilometres along it and 180 kilometres of usable range remaining after the reserve. The whole-route corridor spans the full 420 kilometres and returns 214 candidates. Clipping behind the vehicle removes everything already passed. Clipping at the range horizon, 276 kilometres along, removes everything the vehicle cannot reach without stopping first. What remains is the 180 kilometre stretch that is both ahead and attainable, holding 38 candidates — and the fact that the horizon falls short of the destination is itself the finding, because it means a stop is mandatory rather than optional.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="300" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">420 km route · 96 km travelled · 180 km usable range</text>
  <rect x="24" y="42" width="732" height="60" rx="9" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.2"/>
  <text x="44" y="62" font-size="10.5" font-weight="700" fill="currentColor">whole-route corridor</text>
  <rect x="44" y="72" width="692" height="18" rx="9" fill="var(--accent-3,#5b21b6)"/>
  <text x="390" y="86" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-on-pill,#ffffff)">214 candidates</text>
  <rect x="24" y="112" width="732" height="60" rx="9" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.2"/>
  <text x="44" y="132" font-size="10.5" font-weight="700" fill="currentColor">clipped behind the vehicle</text>
  <rect x="44" y="142" width="158" height="18" rx="9" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1"/>
  <text x="123" y="156" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--viz-ink-mute,#565f6d)">passed</text>
  <rect x="206" y="142" width="530" height="18" rx="9" fill="var(--accent-3,#5b21b6)"/>
  <text x="471" y="156" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-on-pill,#ffffff)">151 candidates</text>
  <rect x="24" y="182" width="732" height="60" rx="9" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="1.8"/>
  <text x="44" y="202" font-size="10.5" font-weight="700" fill="var(--viz-good,#0a656d)">clipped at the range horizon too</text>
  <rect x="44" y="212" width="158" height="18" rx="9" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1"/>
  <text x="123" y="226" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--viz-ink-mute,#565f6d)">passed</text>
  <rect x="206" y="212" width="298" height="18" rx="9" fill="var(--viz-good,#0a656d)"/>
  <text x="355" y="226" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-on-pill,#ffffff)">38 candidates</text>
  <rect x="508" y="212" width="228" height="18" rx="9" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-poor,#a8320f)" stroke-width="1.2" stroke-dasharray="5 4"/>
  <text x="622" y="226" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--viz-poor,#a8320f)">out of range without a stop</text>
  <line x1="206" y1="182" x2="206" y2="248" stroke="var(--accent,#0a656d)" stroke-width="1.6"/>
  <text x="206" y="262" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--accent,#0a656d)">vehicle · 96 km</text>
  <line x1="504" y1="182" x2="504" y2="248" stroke="var(--viz-poor,#a8320f)" stroke-width="1.6"/>
  <text x="504" y="262" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--viz-poor,#a8320f)">horizon · 276 km</text>
  <text x="24" y="290" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">The horizon falling short of the destination is not a display detail — it is the trip telling you a stop is mandatory.</text>
</svg>

## Common Failure Patterns

**1. Recomputing the corridor on every position update.** A vehicle reports its position every few seconds; recomputing the whole corridor at that rate is a self-inflicted load problem, and almost nothing changes between consecutive fixes. Recompute when the vehicle has moved a meaningful fraction of the horizon — every few kilometres — or when the route itself changes, and serve the cached set in between.

**2. Using straight-line displacement as progress.** It is tempting because it needs no map-matching, and it is correct only on a straight route. On anything with a bend, displacement understates progress; on a route that loops back near its origin, it can collapse to nearly zero while the vehicle has driven fifty kilometres. Match onto the polyline, using the same clamped projection as [snapping GPS telemetry to road segments](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/spatial-join-techniques/snapping-gps-telemetry-to-road-segments/).

**3. Forgetting the reserve.** A horizon computed from the full remaining range plans a trip that arrives with nothing left, which no driver will accept and no fleet policy allows. Subtracting a reserve before computing the horizon means the candidate list only ever contains stops that leave a margin — and it means the "out of range" boundary appears earlier, which is the point.

```python
# WRONG: the horizon is where the vehicle would coast to a halt.
horizon_m = progress.travelled_m + progress.range_m

# RIGHT: the horizon is where it can still stop with something in hand.
horizon_m = progress.travelled_m + max(0.0, progress.range_m - progress.reserve_m)
```

## Performance Notes

The clip itself is free — two binary searches over a sorted list, which is $O(\log n)$ in the vertex count and immeasurable next to anything else in the request. What it buys is a proportional reduction in every stage downstream:

$$N_{\text{clipped}} \approx N_{\text{corridor}} \cdot \frac{\min(R - r,\ L - d)}{L}$$

for route length $L$, distance travelled $d$, range $R$ and reserve $r$. Halfway through a trip with range comfortably exceeding what remains, that fraction is about a half; late in a trip with tight range it can be a tenth. Because the chunked envelope seeks, the exact perpendicular clip, the side filter and the detour ranking all scale with the candidate count, the saving compounds through the whole [corridor pipeline](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/corridor-and-buffer-queries/) rather than applying once.

There is a second-order effect worth knowing about: a clipped route has a smaller bounding box, so it produces fewer chunks, so the seek count drops as well as the row count. On a long trip the difference between corridoring 420 kilometres and 180 kilometres is not merely fewer candidates — it is roughly half the queries.

The one thing that gets *harder* is caching. A whole-route corridor has a stable key; a look-ahead corridor's key includes the progress and the range, both of which change continuously. Quantising them — rounding progress to the nearest five kilometres and range to the nearest twenty — restores a usable cache key at the cost of a slightly conservative horizon, which is a trade worth making because the conservative direction is the safe one.

<svg viewBox="0 0 780 288" role="img" aria-labelledby="lookDecayTitle lookDecayDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="lookDecayTitle">Candidate count through the trip, with and without look-ahead clipping</title>
  <desc id="lookDecayDesc">Corridor candidate count plotted against trip progress. Without clipping the count is constant at 214 for the whole journey, because the corridor covers the entire route no matter where the vehicle is. With clipping it falls steadily as the vehicle consumes the route, and falls faster once the range horizon becomes the binding constraint rather than the destination. By three quarters of the way through, the clipped query is returning about a tenth of what the unclipped one returns, and every stage of the pipeline downstream scales with that number.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="288" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Candidates returned as the trip progresses</text>
  <line x1="88" y1="48" x2="88" y2="204" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <line x1="88" y1="204" x2="720" y2="204" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <g font-size="9.5" fill="var(--viz-ink-mute,#565f6d)" text-anchor="end">
    <text x="80" y="208">0</text><text x="80" y="165">60</text><text x="80" y="122">130</text><text x="80" y="79">200</text>
  </g>
  <g font-size="9.5" fill="var(--viz-ink-mute,#565f6d)" text-anchor="middle">
    <text x="88" y="224">start</text><text x="246" y="224">25%</text><text x="404" y="224">50%</text><text x="562" y="224">75%</text><text x="720" y="224">arrival</text>
  </g>
  <text x="404" y="244" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">trip progress</text>
  <line x1="88" y1="72" x2="720" y2="72" stroke="var(--viz-poor,#a8320f)" stroke-width="2.6"/>
  <text x="100" y="64" font-size="10" font-weight="700" fill="var(--viz-poor,#a8320f)">unclipped — 214 every time, most of them behind the driver</text>
  <path d="M88 72 L246 112 L404 146 L562 180 L720 202" fill="none" stroke="var(--viz-good,#0a656d)" stroke-width="2.6"/>
  <circle cx="404" cy="146" r="5" fill="var(--viz-good,#0a656d)"/>
  <text x="416" y="142" font-size="10" font-weight="700" fill="var(--viz-good,#0a656d)">38 — ahead and attainable</text>
  <text x="24" y="268" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">The clipped route also has a smaller bounding box, so it produces fewer chunks — the seek count falls with the row count.</text>
</svg>

Two design consequences follow from the horizon being a first-class output rather than an internal detail. The first is that `reachable_fraction` should be surfaced, not just used: a value below one means the destination is unreachable without stopping, and that is a statement the trip can make before the driver notices the gauge. Reporting it turns a list of nearby stops into a recommendation with a reason attached, which is the difference between a feature drivers use and one they scroll past.

The second is that the horizon has to be recomputed from *observed* consumption rather than from a nominal range figure. Headwind, gradient, load and temperature all move real consumption by double-digit percentages, and a horizon computed from the manufacturer's number will sit optimistically far down the route in exactly the conditions where being wrong is expensive. Feeding back an observed metres-per-unit figure from the trip so far, and using that to project the remainder, costs nothing and makes the clip honest — and where the terrain ahead differs from the terrain behind, the [grade-aware cost model](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/elevation-and-terrain-enrichment/) is what turns that projection into something better than a straight-line extrapolation.

## Related

- [Corridor and Buffer Queries Along a Route](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/corridor-and-buffer-queries/) — the pipeline this clip feeds.
- [Ranking Detour Cost for Corridor Candidates](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/corridor-and-buffer-queries/ranking-detour-cost-for-corridor-candidates/) — the stage that benefits most from a shorter candidate list.
- [Snapping GPS Telemetry to Road Segments](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/spatial-join-techniques/snapping-gps-telemetry-to-road-segments/) — producing the along-route progress this clip depends on.
- [Time-Dependent Shortest Paths with Schedule Edges](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/turn-restriction-and-time-dependent-routing/time-dependent-shortest-paths-with-schedule-edges/) — the cost profile that makes a horizon computable in time rather than distance.

This guide is part of [Corridor and Buffer Queries Along a Route](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/corridor-and-buffer-queries/), within [Cypher Spatial Queries & Pathfinding Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/).
