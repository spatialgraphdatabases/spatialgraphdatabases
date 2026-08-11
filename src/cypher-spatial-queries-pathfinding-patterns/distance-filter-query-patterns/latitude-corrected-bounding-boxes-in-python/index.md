---
pageTitle: Latitude-Corrected Bounding Boxes
title: Latitude-Corrected Bounding Boxes in Python
description: Build the box a radius query seeks against so it stays the intended ground width at every latitude, clamps at the poles, and splits at the antimeridian.
slug: latitude-corrected-bounding-boxes-in-python
type: article
breadcrumb: Corrected Boxes
datePublished: 2026-08-11
dateModified: 2026-08-11
---
# Latitude-Corrected Bounding Boxes in Python

The bounding box is the smallest piece of a spatial query and the one most often written from memory, which is why the same defect appears in codebase after codebase: a fixed degree offset applied to both axes. It produces a box that is the intended width in exactly one place on Earth and wrong everywhere else — too wide near the equator, so the seek returns candidates the distance filter then throws away; too narrow toward the poles, so genuinely close results are missed and nothing reports it. This page builds the box properly: latitude-corrected on the longitude axis, clamped where the correction blows up, and split where the range wraps.

## Prerequisites & Versions

Pure client-side arithmetic; the box is passed to the query as parameters.

| Requirement | Minimum version | Install |
| --- | --- | --- |
| Python | 3.11 | — |
| neo4j (async driver) | 5.20 | `pip install "neo4j>=5.20"` |
| Neo4j Server | 5.15 | native `point`, `POINT INDEX` |

## Implementation

```python
import math
from dataclasses import dataclass

EARTH_R = 6_371_008.8
MAX_LAT = 90.0
MAX_LON = 180.0


@dataclass(frozen=True)
class LonRange:
    """A closed longitude interval. A wrapped box needs two of these."""
    lo: float
    hi: float


@dataclass(frozen=True)
class Box:
    min_lat: float
    max_lat: float
    lon_ranges: tuple[LonRange, ...]

    @property
    def wraps(self) -> bool:
        return len(self.lon_ranges) > 1

    def as_params(self) -> dict:
        return {
            "min_lat": self.min_lat,
            "max_lat": self.max_lat,
            "lon_ranges": [{"lo": r.lo, "hi": r.hi} for r in self.lon_ranges],
        }


def bounding_box(lat: float, lon: float, radius_m: float) -> Box:
    """The smallest lat/lon box containing every point within radius_m.

    Latitude is easy: a degree of latitude is a constant ground distance, so the
    offset is the same everywhere. Longitude is not: a degree of longitude spans
    111 km at the equator and 55 km at 60 degrees, so the offset has to be
    divided by cos(latitude) or the box is only correct on the equator.
    """
    if not (-MAX_LAT <= lat <= MAX_LAT and -MAX_LON <= lon <= MAX_LON):
        raise ValueError(f"coordinate out of range: {lat}, {lon}")
    if radius_m <= 0:
        raise ValueError("radius must be positive")

    d_lat = math.degrees(radius_m / EARTH_R)
    min_lat = lat - d_lat
    max_lat = lat + d_lat

    # The correction must use the latitude where the box is WIDEST, which is the
    # edge nearer the pole — using the centre latitude leaves the far corners
    # outside the box and silently drops results there.
    widest_lat = max(abs(min_lat), abs(max_lat))

    if widest_lat >= 89.0 or min_lat <= -MAX_LAT or max_lat >= MAX_LAT:
        # A box containing a pole spans every longitude. cos() is heading for
        # zero here and the correction would explode; the honest answer is the
        # full circle of longitude, and the exact distance filter does the rest.
        return Box(
            min_lat=max(min_lat, -MAX_LAT),
            max_lat=min(max_lat, MAX_LAT),
            lon_ranges=(LonRange(-MAX_LON, MAX_LON),),
        )

    d_lon = d_lat / math.cos(math.radians(widest_lat))
    if d_lon >= MAX_LON:
        return Box(min_lat, max_lat, (LonRange(-MAX_LON, MAX_LON),))

    lo, hi = lon - d_lon, lon + d_lon
    if lo < -MAX_LON:
        # Western overshoot: two disjoint ranges, one ending at +180 and one
        # starting at -180, so a station is matched by at most one of them.
        ranges = (LonRange(lo + 360.0, MAX_LON), LonRange(-MAX_LON, hi))
    elif hi > MAX_LON:
        ranges = (LonRange(lo, MAX_LON), LonRange(-MAX_LON, hi - 360.0))
    else:
        ranges = (LonRange(lo, hi),)

    return Box(min_lat=min_lat, max_lat=max_lat, lon_ranges=ranges)


SEEK = """
MATCH (n:Station)
WHERE n.location.latitude  >= $min_lat AND n.location.latitude  <= $max_lat
  AND any(r IN $lon_ranges WHERE
          n.location.longitude >= r.lo AND n.location.longitude <= r.hi)
WITH n, point.distance(n.location, $centre) AS metres
WHERE metres <= $radius_m
RETURN n.id AS id, metres
ORDER BY metres
LIMIT $k
"""
```

## How It Works

Three details separate this from the version that mostly works.

**The correction uses the widest latitude, not the centre.** A box centred at 55°N with a 50 km radius spans roughly 54.55° to 55.45°. Correcting with `cos(55°)` sizes the box for the centre line, and the top edge — nearer the pole, where a degree of longitude is shorter — ends up narrower in ground terms than intended. The corners there fall outside the box, and any candidate in them is missed. Using the edge nearer the pole makes the box a strict superset of the circle, which is what a prefilter has to be.

**The pole case is not a correction, it is a different answer.** As latitude approaches 90°, `cos` approaches zero and the longitude offset approaches infinity. There is no box to compute: a region containing a pole contains every longitude. Returning the full range is exact rather than approximate, and it is the exact distance filter that then does the real work — which is fine, because the latitude bound has already reduced the candidate set to a small polar cap.

**Wrapping produces two disjoint ranges, not a reversed one.** A box crossing the antimeridian has `lo > hi` if written as a single range, and a range predicate with the bounds reversed matches nothing at all — the query succeeds and returns zero rows. Splitting into two closed ranges keeps every bound in order, and because one ends at +180 and the other starts at −180, no candidate is returned twice.

<svg viewBox="0 0 780 320" role="img" aria-labelledby="latBoxTitle latBoxDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="latBoxTitle">A fixed degree offset, and what it does to the same 50 km radius at three latitudes</title>
  <desc id="latBoxDesc">The same 50 kilometre search radius drawn at the equator, at 45 degrees and at 65 degrees, with a box built from a fixed 0.45 degree offset on both axes. At the equator the box is close to correct. At 45 degrees a degree of longitude is 30 per cent shorter, so the box is 30 per cent narrower in ground terms than the circle it is meant to contain, and the shaded slivers to the east and west are inside the radius but outside the box — candidates there are missed. At 65 degrees the box covers well under half the circle's width and most of the east-west extent is lost. Dividing the longitude offset by the cosine of the latitude restores the box to a strict superset at every latitude.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="320" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">One 50 km radius, one fixed 0.45° offset, three latitudes</text>
  <rect x="24" y="42" width="236" height="204" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="1.6"/>
  <text x="142" y="66" text-anchor="middle" font-size="11.5" font-weight="700" fill="var(--viz-good,#0a656d)">equator</text>
  <ellipse cx="142" cy="152" rx="72" ry="72" fill="var(--accent-3,#5b21b6)" opacity="0.14"/>
  <ellipse cx="142" cy="152" rx="72" ry="72" fill="none" stroke="var(--accent-3,#5b21b6)" stroke-width="1.8" stroke-dasharray="6 4"/>
  <rect x="70" y="80" width="144" height="144" fill="none" stroke="var(--viz-good,#0a656d)" stroke-width="2"/>
  <text x="142" y="236" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">box contains the circle</text>
  <rect x="272" y="42" width="236" height="204" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-ok,#7d6200)" stroke-width="1.6"/>
  <text x="390" y="66" text-anchor="middle" font-size="11.5" font-weight="700" fill="var(--viz-ok,#7d6200)">45° — 30% too narrow</text>
  <ellipse cx="390" cy="152" rx="72" ry="72" fill="var(--accent-3,#5b21b6)" opacity="0.14"/>
  <ellipse cx="390" cy="152" rx="72" ry="72" fill="none" stroke="var(--accent-3,#5b21b6)" stroke-width="1.8" stroke-dasharray="6 4"/>
  <path d="M318 152 a72 72 0 0 1 33 -60 L351 212 a72 72 0 0 1 -33 -60 Z" fill="var(--viz-ok,#7d6200)" opacity="0.4"/>
  <path d="M462 152 a72 72 0 0 0 -33 -60 L429 212 a72 72 0 0 0 33 -60 Z" fill="var(--viz-ok,#7d6200)" opacity="0.4"/>
  <rect x="351" y="80" width="78" height="144" fill="none" stroke="var(--viz-ok,#7d6200)" stroke-width="2"/>
  <text x="390" y="236" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">shaded area is inside the radius, outside the box</text>
  <rect x="520" y="42" width="236" height="204" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-poor,#a8320f)" stroke-width="1.8"/>
  <text x="638" y="66" text-anchor="middle" font-size="11.5" font-weight="700" fill="var(--viz-poor,#a8320f)">65° — 58% too narrow</text>
  <ellipse cx="638" cy="152" rx="72" ry="72" fill="var(--accent-3,#5b21b6)" opacity="0.14"/>
  <ellipse cx="638" cy="152" rx="72" ry="72" fill="none" stroke="var(--accent-3,#5b21b6)" stroke-width="1.8" stroke-dasharray="6 4"/>
  <path d="M566 152 a72 72 0 0 1 57 -70 L623 222 a72 72 0 0 1 -57 -70 Z" fill="var(--viz-poor,#a8320f)" opacity="0.4"/>
  <path d="M710 152 a72 72 0 0 0 -57 -70 L653 222 a72 72 0 0 0 57 -70 Z" fill="var(--viz-poor,#a8320f)" opacity="0.4"/>
  <rect x="623" y="80" width="30" height="144" fill="none" stroke="var(--viz-poor,#a8320f)" stroke-width="2"/>
  <text x="638" y="236" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">most of the east-west extent is lost</text>
  <text x="24" y="276" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">Nothing fails. The seek is healthy, the distance filter is correct, and the answer is short — by an amount that depends</text>
  <text x="24" y="292" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">on latitude, so the bug is invisible in a test suite whose fixtures all sit in one city.</text>
  <text x="24" y="310" font-size="10" fill="var(--viz-ink-mute,#565f6d)">Dividing the longitude offset by cos(latitude) makes the box a strict superset of the circle everywhere.</text>
</svg>

## Common Failure Patterns

**1. Correcting with the centre latitude.** Better than not correcting, and still wrong at the corners: the edge nearer the pole needs a wider offset than the centre does, so the two far corners fall outside the box. The error is small — a fraction of a per cent for a city-scale radius — and grows with the radius, which means it surfaces first on exactly the wide-area queries that are hardest to verify.

**2. Deriving the box inside Cypher.** Computing `cos` and the offsets per row makes the predicate an expression over the indexed property, which is not seekable, so the plan falls back to a scan. The box must be arithmetic done in the client and passed as parameters — the same reason the [planner hint guide](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/forcing-index-seeks-with-cypher-planner-hints/) insists the property stays bare on one side.

**3. Treating the box as the answer.** The box is a superset; the circle is the answer. Skipping the `point.distance()` clip returns the corners — up to 27% more area than the circle — as if they were within the radius. On a KNN query with a `LIMIT` that is not merely imprecise, it can return a corner candidate in place of a genuinely nearer one.

```python
# The box is a prefilter. The exact metric decides membership.
box = bounding_box(lat, lon, radius_m)
params = box.as_params() | {"centre": centre_point, "radius_m": radius_m, "k": 10}
```

## Performance Notes

The box's job is to make the candidate set small enough that the exact metric is cheap, and its efficiency is the ratio of areas:

$$\frac{A_{\text{box}}}{A_{\text{circle}}} = \frac{(2r)^2}{\pi r^2} = \frac{4}{\pi} \approx 1.27$$

A correct box reads about 27% more than the circle needs, and that surplus is irreducible for an axis-aligned rectangle. An over-wide box from an uncorrected offset reads far more — at 65° an uncorrected box built the *other* way, wide enough to contain the circle, is more than twice the necessary area — and every one of those extra rows pays a great-circle distance computation.

The wrapped case deserves a note on plan stability. Passing the ranges as a parameter list means the query text is identical whether the box wraps or not, so one plan is cached and reused; branching in the client to emit a different query for the wrapped case doubles the plan count for no benefit. That is the same discipline as [keeping spatial queries in the plan cache](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/keeping-spatial-queries-in-the-plan-cache/), applied to a branch that is easy to overlook because it fires so rarely.

<svg viewBox="0 0 780 284" role="img" aria-labelledby="latRowsTitle latRowsDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="latRowsTitle">Rows read and results returned, by latitude, for three box constructions</title>
  <desc id="latRowsDesc">For a fixed 50 kilometre radius over a uniform station density, three ways of building the box are compared at the equator, 45 degrees and 65 degrees. The correctly corrected box reads about 27 per cent more rows than the circle needs at every latitude, and returns every result. The uncorrected narrow box reads fewer rows and returns progressively fewer results — 100 per cent at the equator, 78 per cent at 45 degrees, 42 per cent at 65. An over-wide box built by taking the largest offset anywhere returns everything but reads more than twice what is needed at high latitude.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="284" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Completeness of the result, by latitude</text>
  <text x="24" y="52" font-size="10" font-weight="700" fill="var(--viz-ink-mute,#565f6d)">construction</text>
  <text x="330" y="52" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-ink-mute,#565f6d)">equator</text>
  <text x="470" y="52" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-ink-mute,#565f6d)">45°</text>
  <text x="610" y="52" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-ink-mute,#565f6d)">65°</text>
  <rect x="24" y="60" width="732" height="58" rx="9" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-poor,#a8320f)" stroke-width="1.6"/>
  <text x="44" y="82" font-size="11" font-weight="700" fill="var(--viz-poor,#a8320f)">fixed offset, both axes</text>
  <text x="44" y="100" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">reads least, returns least</text>
  <g font-size="12" font-weight="700" text-anchor="middle">
    <text x="330" y="94" fill="currentColor">100%</text>
    <text x="470" y="94" fill="var(--viz-poor,#a8320f)">78%</text>
    <text x="610" y="94" fill="var(--viz-poor,#a8320f)">42%</text>
  </g>
  <rect x="24" y="128" width="732" height="58" rx="9" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="1.8"/>
  <text x="44" y="150" font-size="11" font-weight="700" fill="var(--viz-good,#0a656d)">corrected by cos(widest latitude)</text>
  <text x="44" y="168" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">reads 27% more than the circle</text>
  <g font-size="12" font-weight="700" text-anchor="middle">
    <text x="330" y="162" fill="var(--viz-good,#0a656d)">100%</text>
    <text x="470" y="162" fill="var(--viz-good,#0a656d)">100%</text>
    <text x="610" y="162" fill="var(--viz-good,#0a656d)">100%</text>
  </g>
  <rect x="24" y="196" width="732" height="58" rx="9" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-ok,#7d6200)" stroke-width="1.6"/>
  <text x="44" y="218" font-size="11" font-weight="700" fill="var(--viz-ok,#7d6200)">one global worst-case offset</text>
  <text x="44" y="236" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">complete, but reads 2.4× at 65°</text>
  <g font-size="12" font-weight="700" text-anchor="middle">
    <text x="330" y="230" fill="var(--viz-ok,#7d6200)">100%</text>
    <text x="470" y="230" fill="var(--viz-ok,#7d6200)">100%</text>
    <text x="610" y="230" fill="var(--viz-ok,#7d6200)">100%</text>
  </g>
  <text x="24" y="274" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">Only the first row is wrong, and it is the only one whose error a latency graph will never show.</text>
</svg>

A note on testing this, because it is the kind of arithmetic that passes every test written against the city the authors live in. The property worth asserting is not a specific box for a specific coordinate but the invariant: for a sample of coordinates spread across the full latitude range, every point at exactly the radius must fall inside the box. Generating a ring of points at the radius around each sample centre and checking containment catches an under-wide box immediately, at every latitude, without anyone having to reason about cosines.

The second property worth asserting is that the box is not absurdly large. An implementation that over-corrects — dividing by cosine twice, say, which is an easy copy-paste error — still returns complete results and quietly reads far more than it needs, so no test that only checks correctness will notice. Bounding the box's area against the circle's, and failing above roughly 1.4×, catches that direction and costs nothing. Between the two assertions the whole class of latitude bug is closed, which matters because the failure it produces in production is a shortfall nobody reports: a user in a northern city simply sees fewer nearby results than a user in a southern one, and neither has any reason to think the other is seeing something different.

## Related

- [Distance Filter Query Patterns for Spatial Graph Routing](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/) — the box-then-clip shape this box feeds.
- [Bounding-Box Search Across the Antimeridian](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/bounding-box-search-across-the-antimeridian/) — the wrapped case in full, including how the planner resolves the split.
- [Implementing KNN Search for Nearby Logistics Hubs](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/k-nearest-neighbor-routing/implementing-knn-search-for-nearby-logistics-hubs/) — where an under-wide box changes which results come back, not just how many.
- [Spatial Indexing Strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) — the point index the box is seeked against.

This guide is part of [Distance Filter Query Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/), within [Cypher Spatial Queries & Pathfinding Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/).
