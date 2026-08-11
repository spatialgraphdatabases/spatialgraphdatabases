---
pageTitle: Bounding-Box Across Antimeridian
title: Bounding-Box Search Across the Antimeridian
description: Why a bounding-box radius query returns nothing near the plus or minus 180 degree meridian, and how to detect the wrap and split it into two seekable boxes
slug: bounding-box-search-across-the-antimeridian
type: article
breadcrumb: Antimeridian Search
datePublished: 2026-07-14
dateModified: 2026-07-14
---
# Bounding-Box Search Across the Antimeridian

A radius query that works flawlessly over Europe returns an empty set the instant an operator runs it near Fiji, the Aleutians, or Kiribati — and no error is thrown. The cause is arithmetic, not data. A bounding box is built as `min_lon = lon - Δλ` and `max_lon = lon + Δλ`, and near ±180° one of those crosses the seam: a box centred at 178.4° with a half-width of 2° wants to span from 176.4° to 180.4°, but longitude does not go to 180.4° — it wraps to −179.6°. The naive result is `min_lon = 176.4`, `max_lon = -179.6`, so the predicate `longitude >= 176.4 AND longitude <= -179.6` is unsatisfiable and the index seek returns zero rows. The fix is to *detect* the wrap in client code and split the search into two index-seekable boxes — one running east to +180°, one from −180° back to the far edge. This page builds that detection and split, plus the pole case where the longitude band overflows entirely. It is a focused edge case of the broader [distance filter query patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/).

<svg viewBox="0 0 860 360" role="img" aria-labelledby="am-title am-desc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="am-title">A bounding box centred near plus 180 degrees longitude split into two seekable boxes across the antimeridian seam</title>
  <desc id="am-desc">A horizontal longitude strip runs from minus 180 on the left to plus 180 on the right, with the antimeridian seam marked at both edges. The top row shows the desired search box centred at 178.4 degrees that overshoots past plus 180, so its naive range where longitude is at least 176.4 and at most minus 179.6 is unsatisfiable and returns nothing. The bottom row shows the fix: the box is split at the seam into box A, from 176.4 up to plus 180, and box B, from minus 180 up to minus 179.6, the two disjoint ranges that together cover the true search area with no overlap.</desc>
  <defs>
    <marker id="am-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="var(--accent,#0a656d)"/></marker>
  </defs>
  <!-- TOP: naive, broken -->
  <rect class="viz-backdrop" x="0" y="0" width="860" height="360" fill="var(--viz-bg,#ffffff)"/>
  <text x="30" y="34" font-size="13.5" font-weight="700" fill="var(--accent-2,#a8380b)">Naive box — wraps the seam, seeks nothing</text>
  <!-- strip -->
  <rect x="60" y="52" width="740" height="52" rx="4" fill="var(--surface-3,#f1ede2)" stroke="var(--line,#e5e0d2)" stroke-width="1"/>
  <line x1="60" y1="46" x2="60" y2="110" stroke="var(--accent-2,#a8380b)" stroke-width="2.5"/>
  <line x1="800" y1="46" x2="800" y2="110" stroke="var(--accent-2,#a8380b)" stroke-width="2.5"/>
  <text x="60" y="128" text-anchor="middle" font-size="10.5" fill="var(--ink-soft,#455062)">−180°</text>
  <text x="800" y="128" text-anchor="middle" font-size="10.5" fill="var(--ink-soft,#455062)">+180°</text>
  <text x="430" y="128" text-anchor="middle" font-size="10.5" fill="var(--ink-soft,#455062)">0°</text>
  <line x1="430" y1="52" x2="430" y2="104" stroke="var(--line,#e5e0d2)" stroke-width="1" stroke-dasharray="2 4"/>
  <!-- desired box overshoot (drawn as impossible span) -->
  <rect x="726" y="56" width="74" height="44" rx="2" fill="var(--accent-2,#a8380b)" opacity="0.18" stroke="var(--accent-2,#a8380b)" stroke-width="1.4" stroke-dasharray="5 3"/>
  <text x="763" y="82" text-anchor="middle" font-size="10" fill="var(--ink,#1b2330)">176.4°→</text>
  <text x="746" y="20" text-anchor="middle" font-size="10.5" fill="var(--accent-2,#a8380b)">lon ≥ 176.4 AND lon ≤ −179.6  ✗ empty</text>
  <!-- ARROW down -->
  <line x1="430" y1="150" x2="430" y2="188" stroke="var(--accent,#0a656d)" stroke-width="1.8" marker-end="url(#am-arrow)"/>
  <text x="452" y="174" font-size="11" fill="var(--accent,#0a656d)">detect wrap → split</text>
  <!-- BOTTOM: split, fixed -->
  <text x="30" y="216" font-size="13.5" font-weight="700" fill="var(--accent,#0a656d)">Split boxes — two disjoint index seeks</text>
  <rect x="60" y="234" width="740" height="52" rx="4" fill="var(--surface-3,#f1ede2)" stroke="var(--line,#e5e0d2)" stroke-width="1"/>
  <line x1="60" y1="228" x2="60" y2="292" stroke="var(--accent,#0a656d)" stroke-width="2.5"/>
  <line x1="800" y1="228" x2="800" y2="292" stroke="var(--accent,#0a656d)" stroke-width="2.5"/>
  <text x="60" y="310" text-anchor="middle" font-size="10.5" fill="var(--ink-soft,#455062)">−180°</text>
  <text x="800" y="310" text-anchor="middle" font-size="10.5" fill="var(--ink-soft,#455062)">+180°</text>
  <!-- box A: 176.4 -> +180 (right end of strip) -->
  <rect x="726" y="238" width="74" height="44" rx="2" fill="var(--accent,#0a656d)" opacity="0.2" stroke="var(--accent,#0a656d)" stroke-width="1.6"/>
  <text x="763" y="264" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--accent,#0a656d)">A</text>
  <text x="763" y="330" text-anchor="middle" font-size="9.5" fill="var(--ink-soft,#455062)">176.4° → +180°</text>
  <!-- box B: -180 -> -179.6 (left end) -->
  <rect x="60" y="238" width="15" height="44" rx="2" fill="var(--accent,#0a656d)" opacity="0.2" stroke="var(--accent,#0a656d)" stroke-width="1.6"/>
  <text x="67" y="264" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--accent,#0a656d)">B</text>
  <text x="95" y="330" text-anchor="middle" font-size="9.5" fill="var(--ink-soft,#455062)">−180° → −179.6°</text>
</svg>

## Prerequisites & Versions

The wrap detection is pure client-side Python; the query is the standard two-stage box-then-distance filter on Neo4j's native `point`. No APOC or GDS is needed.

| Requirement | Minimum version | Note |
| --- | --- | --- |
| Python | 3.10+ | `dict`/list handling and match syntax used below |
| Neo4j | 5.13+ | Native `point`, `CREATE POINT INDEX`, index-backed range predicates |
| neo4j (driver) | 5.x | `AsyncGraphDatabase`, async sessions |

```bash
pip install "neo4j>=5.18"
```

Coordinates must be stored as native `point` values per sound [node and edge spatial mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/), with the point index in place:

```cypher
CREATE POINT INDEX station_location IF NOT EXISTS
FOR (s:Station) ON (s.location);
// (:Station {station_id, location: point({srid:4326, latitude, longitude})})
```

## Implementation

`seam_aware_box` computes the latitude band, then the longitude band, and returns a **list** of `(min_lon, max_lon)` ranges: one range in the normal case, two when the band crosses ±180°, and the full `[-180, 180]` when a pole falls inside the radius. The query OR-joins the ranges so each stays an index seek, and always keeps the exact `point.distance()` clip so the answer is a true radius, not two rectangles.

```python
import asyncio
import math
from neo4j import AsyncGraphDatabase

EARTH_RADIUS_M = 6_371_000.0


def seam_aware_box(lat: float, lon: float, radius_m: float) -> dict:
    """Bounding box that survives the antimeridian and the poles.

    Returns min/max latitude plus a list of (min_lon, max_lon) longitude
    ranges — two ranges when the band wraps ±180°, one range otherwise.
    """
    d_lat = math.degrees(radius_m / EARTH_RADIUS_M)
    min_lat = max(lat - d_lat, -90.0)
    max_lat = min(lat + d_lat, 90.0)

    # Clamp the latitude used for the cos() term so a near-pole query
    # does not blow up as cos(phi) -> 0.
    cos_phi = math.cos(math.radians(min(abs(lat), 89.9)))
    d_lon = math.degrees(radius_m / (EARTH_RADIUS_M * cos_phi))

    if d_lon >= 180.0:
        # Radius spans a full parallel (pole inside the circle): all longitudes.
        lon_ranges = [(-180.0, 180.0)]
    else:
        lo, hi = lon - d_lon, lon + d_lon
        if lo < -180.0:
            lon_ranges = [(-180.0, hi), (lo + 360.0, 180.0)]
        elif hi > 180.0:
            lon_ranges = [(lo, 180.0), (-180.0, hi - 360.0)]
        else:
            lon_ranges = [(lo, hi)]

    return {"min_lat": min_lat, "max_lat": max_lat, "lon_ranges": lon_ranges}


QUERY = """
WITH point({srid:4326, latitude:$lat, longitude:$lon}) AS target
MATCH (s:Station)
WHERE s.location.latitude >= $min_lat AND s.location.latitude <= $max_lat
  AND any(rng IN $lon_ranges
          WHERE s.location.longitude >= rng[0] AND s.location.longitude <= rng[1])
WITH s, point.distance(s.location, target) AS metres
WHERE metres <= $radius
RETURN s.station_id AS station_id, metres
ORDER BY metres ASC
LIMIT 200
"""


async def search_radius(driver, lat: float, lon: float, radius_m: float) -> list[dict]:
    box = seam_aware_box(lat, lon, radius_m)
    async with driver.session(database="neo4j") as session:
        result = await session.run(
            QUERY, lat=lat, lon=lon, radius=radius_m,
            min_lat=box["min_lat"], max_lat=box["max_lat"],
            lon_ranges=[list(r) for r in box["lon_ranges"]],
        )
        return [rec.data() async for rec in result]


async def main() -> None:
    driver = AsyncGraphDatabase.driver(
        "neo4j+s://your-cluster.databases.neo4j.io",
        auth=("neo4j", "secure-password"),
        max_connection_pool_size=40,
        connection_acquisition_timeout=5.0,
    )
    try:
        # Suva, Fiji — a 200 km radius straddles the +180° seam.
        rows = await search_radius(driver, -18.1416, 178.4419, 200_000)
        print(f"resolved {len(rows)} stations across the seam")
    finally:
        await driver.close()


if __name__ == "__main__":
    asyncio.run(main())
```

## How It Works

The whole correctness argument rests on keeping longitude a set of *ordered* ranges rather than a single min/max pair.

- **Wrap detection is a sign test on the raw bounds.** Before clamping, `lon - d_lon` and `lon + d_lon` are computed on the real number line, where they can fall below −180 or above +180. That overflow is exactly the wrap signal. Rather than modulo the bounds silently (which produces the unsatisfiable `min > max`), the function branches: an eastern overshoot (`hi > 180`) yields `(lo, 180)` plus `(-180, hi - 360)`; a western overshoot mirrors it. The two ranges are **disjoint** — one ends at +180, the other starts at −180 — so a station is matched by at most one, which is what keeps the seam from being double-counted.
- **`any()` over the ranges stays index-seekable.** The Cypher `any(rng IN $lon_ranges WHERE …)` expands to an OR of range predicates on `location.longitude`. The planner resolves an OR of ranges on the same indexed property as multiple `PointIndexSeekByRange` operations, so both boxes are seeks, not scans — the mechanism explored in [graph query planner optimization](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/). Passing the ranges as a parameter keeps one cacheable plan whether there are one or two boxes.
- **The distance clip is unchanged.** `point.distance()` computes the true great-circle metre distance and treats +179.9° and −179.9° as 0.2° apart, not 359.8° — the seam is invisible to the ellipsoidal metric. So the box split only fixes the *seek*; the exact radius semantics still come from the final `WHERE metres <= $radius`, exactly as in the endpoint filter described in [filtering graph paths by Haversine distance in Cypher](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/filtering-graph-paths-by-haversine-distance-in-cypher/).

<svg viewBox="0 0 780 336" role="img" aria-labelledby="amTitle amDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="amTitle">How a two-range longitude parameter still plans as index seeks</title>
  <desc id="amDesc">The plan for the wrapped query. The any() predicate over the longitude ranges parameter expands to an OR of range predicates on the same indexed property, which the planner resolves as two PointIndexSeekByRange operations — one for the eastern range ending at plus 180, one for the western range starting at minus 180 — feeding a Union. Because the ranges are disjoint no station appears twice. The union output then passes through the ordinary latitude range check and the exact point.distance clip, which is unaware of the seam. The query text is identical whether the parameter holds one range or two, so a single plan is cached.</desc>
  <defs>
    <marker id="am-a" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="336" fill="var(--viz-bg,#ffffff)"/>
  <text x="390" y="24" text-anchor="middle" font-size="13.5" font-weight="700" fill="currentColor">$lon_ranges arrives as one parameter and plans as two seeks</text>
  <!-- parameter -->
  <rect x="252" y="38" width="276" height="44" rx="8" fill="var(--viz-panel,#f4f4f5)" stroke="var(--accent-3,#5b21b6)" stroke-width="1.8"/>
  <text x="390" y="58" text-anchor="middle" font-size="11.5" font-weight="700" fill="currentColor">any(rng IN $lon_ranges WHERE …)</text>
  <text x="390" y="74" text-anchor="middle" font-size="10" font-family="var(--font-mono,monospace)" fill="var(--viz-ink-mute,#565f6d)">[(178.6, 180.0), (-180.0, -179.4)]</text>
  <path d="M330 82 V102 H186 V122" fill="none" stroke="currentColor" stroke-width="1.6" marker-end="url(#am-a)"/>
  <path d="M450 82 V102 H594 V122" fill="none" stroke="currentColor" stroke-width="1.6" marker-end="url(#am-a)"/>
  <!-- two seeks -->
  <rect x="52" y="124" width="268" height="58" rx="8" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="1.8"/>
  <text x="186" y="144" text-anchor="middle" font-size="11.5" font-weight="700" fill="var(--viz-good,#0a656d)">PointIndexSeekByRange</text>
  <text x="186" y="161" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">eastern box · lon ∈ [178.6, 180]</text>
  <text x="186" y="176" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">ends exactly at the seam</text>
  <rect x="460" y="124" width="268" height="58" rx="8" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="1.8"/>
  <text x="594" y="144" text-anchor="middle" font-size="11.5" font-weight="700" fill="var(--viz-good,#0a656d)">PointIndexSeekByRange</text>
  <text x="594" y="161" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">western box · lon ∈ [−180, −179.4]</text>
  <text x="594" y="176" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">starts exactly at the seam</text>
  <path d="M186 182 V202 H330 V222" fill="none" stroke="currentColor" stroke-width="1.6" marker-end="url(#am-a)"/>
  <path d="M594 182 V202 H450 V222" fill="none" stroke="currentColor" stroke-width="1.6" marker-end="url(#am-a)"/>
  <text x="390" y="198" text-anchor="middle" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">disjoint — no station is in both</text>
  <rect x="270" y="224" width="240" height="36" rx="8" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <text x="390" y="247" text-anchor="middle" font-size="11.5" font-weight="700" fill="currentColor">Union</text>
  <line x1="390" y1="260" x2="390" y2="280" stroke="currentColor" stroke-width="1.6" marker-end="url(#am-a)"/>
  <rect x="192" y="282" width="396" height="38" rx="8" fill="var(--viz-panel-2,#ece9df)" stroke="var(--accent-2,#a8380b)" stroke-width="1.6"/>
  <text x="390" y="299" text-anchor="middle" font-size="11.5" font-weight="700" fill="currentColor">Filter: latitude range, then point.distance() ≤ $radius</text>
  <text x="390" y="314" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">the ellipsoidal metric never sees a seam — 179.9°E and 179.9°W are 0.2° apart</text>
</svg>

## Common Failure Patterns

**1. Silent empty result (the wrap swallowed).** The default symptom — a query that returns nothing near the date line and no exception. Because `longitude >= 176.4 AND longitude <= -179.6` is simply false for every row, the seek is valid and fast; it just matches nobody. Guard against it in tests with a fixture on the seam and assert non-empty:

```python
# WRONG — a single min/max pair goes unsatisfiable across ±180°:
#   longitude >= 176.5 AND longitude <= -179.7  →  matches no row, no error
# RIGHT — a list of ranges; the wrap case carries two, tested explicitly
box = seam_aware_box(-18.14, 178.44, 200_000)
assert len(box["lon_ranges"]) == 2         # wrap split into two disjoint ranges
assert box["lon_ranges"][0][1] == 180.0    # first range closes at +180
assert box["lon_ranges"][1][0] == -180.0   # second range opens at −180
```

**2. Double-counting the seam.** A tempting shortcut is to run two overlapping queries and `UNION ALL` the results — but overlap at the seam returns a station twice, inflating counts and corrupting a nearest-K `LIMIT`. Keep the ranges disjoint (one closes at +180, the other opens at −180) and OR them inside a single `MATCH` so each node is evaluated once. If you must issue two separate queries, dedupe on `station_id` or use `UNION` (which removes duplicates) rather than `UNION ALL`.

**3. High-latitude band overflow.** Near the poles the longitude band balloons because meridians converge, and a modest radius can demand a Δλ larger than 180° — mathematically the circle wraps *all* the way around. The `d_lon >= 180` branch catches this and returns the full `[-180, 180]` range so the latitude band alone bounds the seek; without it, `lon + d_lon` overshoots into a nonsense split. The `cos_phi` clamp at 89.9° prevents a division-by-near-zero that would otherwise produce infinities at the pole itself.

## Performance Notes

The longitude half-width driving the whole edge case is

$$\Delta\lambda = \frac{r}{R\cos\phi}\cdot\frac{180}{\pi}$$

for radius $r$ at latitude $\phi$. The $\cos\phi$ in the denominator is why the band widens with latitude: at the equator $\cos\phi = 1$ and $\Delta\lambda$ is small, but as $\phi \to 90°$, $\cos\phi \to 0$ and $\Delta\lambda \to \infty$. Two thresholds fall out of that. First, $\Delta\lambda$ crossing the distance from the origin to ±180° is when the split fires — purely a function of how close the origin sits to the seam. Second, $\Delta\lambda \ge 180°$ is when the band covers a full parallel and the split collapses to an all-longitudes scan bounded only by latitude.

The split costs essentially nothing at the seam: two index seeks over disjoint ranges together touch the same node count a single seek would if the world did not wrap, so latency tracks the box hit count $M$ just as in the non-wrapping case. The genuine cost centre is the pole branch — bounding by latitude alone over a full parallel can return a large $M$, so cap the radius near the poles or add a secondary attribute filter. Keep the query text fixed and the ranges parameterised so the plan cache stays warm across seam and non-seam calls alike; the PROFILE loop for confirming both boxes seek is the one in [cypher performance tuning](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/).

## Related

- [Filtering Graph Paths by Haversine Distance in Cypher](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/filtering-graph-paths-by-haversine-distance-in-cypher/) — the exact great-circle clip that treats the seam as invisible.
- [Distance Filter Query Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/) — the two-stage box-then-distance primitive this edge case extends.
- [K-Nearest-Neighbor Routing](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/k-nearest-neighbor-routing/) — where a seam-crossing candidate set feeds a graph projection and re-rank.
- [Spatial Indexing Strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) — the point index that makes both split boxes seekable.

This guide is part of [Distance Filter Query Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/), within the [Cypher Spatial Queries & Pathfinding Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/) section.

For authoritative reference, consult the [Neo4j Cypher spatial functions documentation](https://neo4j.com/docs/cypher-manual/current/functions/spatial/) and the [OGC Simple Features specification](https://www.ogc.org/standards/sfa).
