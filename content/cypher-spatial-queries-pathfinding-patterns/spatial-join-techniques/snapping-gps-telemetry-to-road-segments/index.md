---
pageTitle: Snapping GPS to Road Segments
title: Snapping GPS Telemetry to Road Segments
description: Map-match noisy GPS telemetry to the nearest road segment in Neo4j using a bounding-box spatial join and point-to-segment perpendicular distance
slug: snapping-gps-telemetry-to-road-segments
type: article
breadcrumb: Snapping GPS to Roads
datePublished: 2026-07-14
dateModified: 2026-07-14
---
# Snapping GPS Telemetry to Road Segments

A fleet telematics feed reports a vehicle at a point that lands in the middle of a block, tens of meters from any intersection. Snap it to the nearest *node* and you attach it to the wrong end of the street — or to a parallel road whose intersection happens to sit closer than the segment the vehicle is actually on. The consumed trace then routes over links the vehicle never traveled, and downstream speed and dwell metrics quietly corrupt. The fix is map-matching lite: join each GPS point to the nearest road *segment* by perpendicular distance, not to the nearest endpoint. This page builds that join as a bounding-box spatial pre-filter feeding a point-to-segment distance computed in Python, picking the best segment per fix. It is one focused case within [spatial join techniques](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/spatial-join-techniques/).

## Prerequisites & Versions

The candidate lookup uses native `point` support and index-backed range predicates, stable on Neo4j 5.x. The projection geometry is client-side Python with no external geospatial dependency.

| Requirement | Minimum version | Note |
| --- | --- | --- |
| Python | 3.10+ | `dataclass` and union syntax used below |
| Neo4j | 5.13+ | Native `point`, `CREATE POINT INDEX`, range-seekable coordinates |
| neo4j (driver) | 5.x | `AsyncGraphDatabase`, native point serialization |

```bash
pip install "neo4j>=5.18"
```

Model each road segment as a relationship between two coordinate-bearing nodes, following the topology conventions in [node and edge spatial mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/). The bounding-box pre-filter seeks the endpoints, so a point index on `RoadNode.location` is mandatory — the same [spatial indexing strategy](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) that backs every other spatial join.

```cypher
CREATE POINT INDEX road_node_location IF NOT EXISTS
FOR (n:RoadNode) ON (n.location);

// Representative shape:
// (:RoadNode {id, location: point({srid:4326, latitude, longitude})})
//   -[:ROAD_SEGMENT {way_id}]->
// (:RoadNode)
```

## Implementation

The pipeline is three stages. Cypher seeks road nodes inside a box around the GPS fix and returns the segments incident to them as endpoint-coordinate pairs. Python projects those endpoints to a local metric plane, computes the perpendicular point-to-segment distance for each candidate, and keeps the closest within tolerance.

```cypher
// Candidate segments: any segment with an endpoint inside the fix's box
MATCH (a:RoadNode)
WHERE a.location.latitude  >= $min_lat AND a.location.latitude  <= $max_lat
  AND a.location.longitude >= $min_lon AND a.location.longitude <= $max_lon
MATCH (a)-[s:ROAD_SEGMENT]-(b:RoadNode)
RETURN DISTINCT s.way_id AS way_id,
       a.location.latitude  AS a_lat, a.location.longitude AS a_lon,
       b.location.latitude  AS b_lat, b.location.longitude AS b_lon
```

The perpendicular distance is a point-to-line-segment projection. For a fix $p$ and a segment from $a$ to $b$, the projection parameter and clamped distance are:

$$t = \operatorname{clamp}\!\left(\frac{(p-a)\cdot(b-a)}{\lVert b-a\rVert^{2}},\; 0,\; 1\right), \qquad d = \bigl\lVert\, p - \bigl(a + t\,(b-a)\bigr)\bigr\rVert$$

The clamp on $t$ to $[0,1]$ is what makes it a *segment* rather than an infinite line: when the foot of the perpendicular falls beyond an endpoint, $t$ pins to $0$ or $1$ and the distance is measured to that endpoint instead.

<svg viewBox="0 0 720 380" role="img" aria-labelledby="snapTitle snapDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="snapTitle">A noisy GPS fix snapped to the nearest road segment by perpendicular distance</title>
  <desc id="snapDesc">A coral GPS fix sits inside a dashed accuracy tolerance circle. Three candidate road segments run nearby. A dashed perpendicular drops from the fix to a point partway along the closest segment, which is drawn in teal, and the foot of that perpendicular is marked as the snapped position. The nearest graph node, an endpoint of that segment, is ringed and labelled as the wrong target because it is much farther away than the perpendicular foot.</desc>
  <defs>
    <marker id="snapArr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <rect class="viz-backdrop" x="0" y="0" width="720" height="380" fill="var(--viz-bg,#ffffff)"/>
  <text x="20" y="28" font-size="14.5" font-weight="700" fill="currentColor">Snap to the segment, not the node</text>
  <!-- tolerance circle -->
  <circle cx="300" cy="190" r="70" fill="var(--accent-coral,#ff6b6b)" opacity="0.05"/>
  <circle cx="300" cy="190" r="70" fill="none" stroke="var(--accent-coral,#ff6b6b)" stroke-width="1.2" stroke-dasharray="4 5" opacity="0.7"/>
  <text x="300" y="272" text-anchor="middle" font-size="9.5" fill="var(--accent-coral,#ff6b6b)" opacity="0.9">accuracy tolerance</text>
  <!-- candidate segment 2 (parallel road, above) -->
  <line x1="150" y1="120" x2="520" y2="90" stroke="currentColor" stroke-width="2" opacity="0.45"/>
  <text x="470" y="80" font-size="10" fill="currentColor" opacity="0.6">candidate · parallel road</text>
  <!-- candidate segment 3 (below) -->
  <line x1="170" y1="300" x2="480" y2="330" stroke="currentColor" stroke-width="2" opacity="0.45"/>
  <text x="330" y="345" font-size="10" fill="currentColor" opacity="0.6">candidate</text>
  <!-- chosen segment (teal) -->
  <line x1="150" y1="250" x2="520" y2="210" stroke="var(--accent,#0e7c86)" stroke-width="3" marker-end="url(#snapArr)"/>
  <text x="392" y="235" font-size="10.5" font-weight="700" fill="var(--accent,#0e7c86)">chosen segment (way 41)</text>
  <!-- segment endpoints (nodes) -->
  <circle cx="150" cy="250" r="6" fill="none" stroke="currentColor" stroke-width="2"/>
  <circle cx="520" cy="210" r="6" fill="none" stroke="currentColor" stroke-width="2"/>
  <!-- nearest node ring (wrong target) -->
  <circle cx="150" cy="250" r="12" fill="none" stroke="var(--accent-coral,#ff6b6b)" stroke-width="2" stroke-dasharray="3 3"/>
  <text x="150" y="286" text-anchor="middle" font-size="10" fill="var(--accent-coral,#ff6b6b)">nearest node (wrong)</text>
  <text x="150" y="300" text-anchor="middle" font-size="9.5" fill="var(--accent-coral,#ff6b6b)" opacity="0.85">161 m away</text>
  <!-- perpendicular from fix to chosen segment -->
  <line x1="300" y1="190" x2="305" y2="233" stroke="var(--accent,#0e7c86)" stroke-width="1.8" stroke-dasharray="5 4"/>
  <text x="322" y="216" font-size="11" font-weight="700" fill="var(--accent,#0e7c86)">d = 44 m</text>
  <!-- snapped point (foot of perpendicular) -->
  <circle cx="305" cy="233" r="6" fill="var(--accent,#0e7c86)"/>
  <text x="305" y="256" text-anchor="middle" font-size="9.5" fill="var(--accent,#0e7c86)">snapped position</text>
  <!-- GPS fix -->
  <circle cx="300" cy="190" r="7" fill="var(--accent-coral,#ff6b6b)"/>
  <text x="300" y="176" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--accent-coral,#ff6b6b)">GPS fix</text>
</svg>

The async driver runs the candidate query per fix and the geometry stays in Python, so the trigonometry never touches the query planner and the plan stays cacheable:

```python
import asyncio
import math
from dataclasses import dataclass
from neo4j import AsyncGraphDatabase, AsyncDriver

EARTH_RADIUS_M = 6_371_008.8

CANDIDATES = """
MATCH (a:RoadNode)
WHERE a.location.latitude  >= $min_lat AND a.location.latitude  <= $max_lat
  AND a.location.longitude >= $min_lon AND a.location.longitude <= $max_lon
MATCH (a)-[s:ROAD_SEGMENT]-(b:RoadNode)
RETURN DISTINCT s.way_id AS way_id,
       a.location.latitude AS a_lat, a.location.longitude AS a_lon,
       b.location.latitude AS b_lat, b.location.longitude AS b_lon
"""


@dataclass(frozen=True)
class Snap:
    way_id: int
    distance_m: float
    snap_lat: float
    snap_lon: float


def _to_local_m(lat: float, lon: float, lat0: float, lon0: float) -> tuple[float, float]:
    """Equirectangular projection to meters about (lat0, lon0)."""
    x = math.radians(lon - lon0) * math.cos(math.radians(lat0)) * EARTH_RADIUS_M
    y = math.radians(lat - lat0) * EARTH_RADIUS_M
    return x, y


def _point_to_segment(px, py, ax, ay, bx, by) -> tuple[float, float]:
    """Return (distance_m, t) for point p against segment a-b, t clamped to [0, 1]."""
    dx, dy = bx - ax, by - ay
    seg_sq = dx * dx + dy * dy
    if seg_sq == 0.0:                       # degenerate: a == b
        return math.hypot(px - ax, py - ay), 0.0
    t = ((px - ax) * dx + (py - ay) * dy) / seg_sq
    t = max(0.0, min(1.0, t))
    fx, fy = ax + t * dx, ay + t * dy
    return math.hypot(px - fx, py - fy), t


def _best_segment(lat, lon, rows) -> Snap | None:
    best: Snap | None = None
    for r in rows:
        ax, ay = _to_local_m(r["a_lat"], r["a_lon"], lat, lon)
        bx, by = _to_local_m(r["b_lat"], r["b_lon"], lat, lon)
        dist, t = _point_to_segment(0.0, 0.0, ax, ay, bx, by)
        if best is None or dist < best.distance_m:
            snap_lat = r["a_lat"] + t * (r["b_lat"] - r["a_lat"])
            snap_lon = r["a_lon"] + t * (r["b_lon"] - r["a_lon"])
            best = Snap(r["way_id"], dist, snap_lat, snap_lon)
    return best


async def snap_fix(driver: AsyncDriver, lat: float, lon: float,
                   tolerance_m: float = 30.0) -> Snap | None:
    d_lat = math.degrees(tolerance_m / EARTH_RADIUS_M)
    d_lon = math.degrees(tolerance_m / (EARTH_RADIUS_M * math.cos(math.radians(lat))))
    params = {
        "min_lat": lat - d_lat, "max_lat": lat + d_lat,
        "min_lon": lon - d_lon, "max_lon": lon + d_lon,
    }
    async with driver.session() as session:
        result = await session.run(CANDIDATES, **params)
        rows = [r.data() async for r in result]
    best = _best_segment(lat, lon, rows)
    return best if best and best.distance_m <= tolerance_m else None


async def main():
    driver = AsyncGraphDatabase.driver(
        "neo4j+s://your-cluster.databases.neo4j.io",
        auth=("neo4j", "secure-password"),
        max_connection_pool_size=20,
        connection_acquisition_timeout=5.0,
    )
    try:
        fix = await snap_fix(driver, 52.5205, 13.4095, tolerance_m=30.0)  # Berlin Mitte
        print("no match within tolerance" if fix is None
              else f"snapped to way {fix.way_id} at {fix.distance_m:.1f} m")
    finally:
        await driver.close()


if __name__ == "__main__":
    asyncio.run(main())
```

## How It Works

The box widened by the tolerance is the seekable part; everything geometric happens client-side on the small candidate set the seek returns.

- **Endpoint box, not segment box.** The `WHERE` range on `a.location` seeks the point index, so only road nodes near the fix are read. Matching `(a)-[s:ROAD_SEGMENT]-(b)` undirected then pulls in every segment touching those nodes — including segments whose *other* endpoint lies outside the box, which is exactly what you want when the fix sits mid-block. `DISTINCT` collapses the duplicate a segment produces when both its endpoints fall in the box.
- **Local projection keeps the math cheap and correct.** `_to_local_m` maps the fix and endpoints onto a metric plane centered on the fix, where the longitude axis is scaled by $\cos(\text{lat})$. Over the tens of meters a snap spans, the equirectangular error is negligible and the projection turns great-circle geometry into plain 2-D vector algebra.
- **The clamped projection is the whole trick.** Computing $t$ and clamping it to $[0,1]$ gives the true nearest point on the segment; unclamped, a fix beyond the segment's end would report a bogus foot out on the line's extension. The returned `snap_lat`/`snap_lon` interpolate the endpoints at $t$, so you get the position *on the road*, not just a distance.

Ranking the closest of several bounded candidates is the same shape as [k-nearest-neighbor routing](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/k-nearest-neighbor-routing/) — here the neighbors are segments scored by perpendicular distance rather than nodes scored by radius.

## Common Failure Patterns

**1. Snapping to the nearest node instead of the nearest segment.** Returning the closest `RoadNode` is a one-liner, and it is wrong whenever the vehicle is between intersections — the nearest endpoint can belong to a different street than the one the vehicle is on. Always score the *segment* by perpendicular distance:

```python
# WRONG: nearest endpoint — picks the wrong street mid-block
best_node = min(rows, key=lambda r: math.hypot(*_to_local_m(r["a_lat"], r["a_lon"], lat, lon)))
# RIGHT: nearest segment by clamped perpendicular distance (see _best_segment)
```

**2. Parallel-road and overpass ambiguity.** When two segments are nearly equidistant — a service road beside a highway, or a bridge over the road beneath it — perpendicular distance alone flips between them on consecutive noisy fixes, producing a trace that jumps between roads. Break the tie with heading: keep the vehicle's bearing from recent fixes and prefer the candidate whose segment azimuth is closest to it. For stacked overpasses, distance in the horizontal plane cannot separate them at all; you need an elevation attribute or the route context from adjacent snapped fixes.

**3. No candidate within tolerance.** In a tunnel, a parking structure, or a coverage gap, the nearest segment can be hundreds of meters off. Returning it anyway fabricates a match. Enforce the tolerance ceiling — `snap_fix` returns `None` when the best distance exceeds it — and let the caller drop the fix or carry the last confident position forward, rather than snapping to a road the vehicle is not on.

<svg viewBox="0 0 780 316" role="img" aria-labelledby="stTitle stDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="stTitle">Where the snap tolerance ceiling decides the answer</title>
  <desc id="stDesc">Three fixes against the same tolerance ceiling. A fix 6 metres from a segment snaps confidently. A fix 9 metres from two nearly parallel candidates — a service road and the highway beside it — is within tolerance for both, so perpendicular distance alone flips between them and the tie is broken on heading. A fix 240 metres out in a tunnel has no candidate inside the ceiling at all; snap_fix returns None so the caller can drop it or carry the last confident position, rather than fabricating a match to a road the vehicle is not on.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="316" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">One tolerance ceiling, three outcomes</text>
  <rect x="24" y="42" width="236" height="212" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="1.8"/>
  <text x="142" y="66" text-anchor="middle" font-size="11.5" font-weight="700" fill="var(--viz-good,#0a656d)">confident</text>
  <line x1="52" y1="150" x2="232" y2="126" stroke="var(--viz-stroke,#9ca3af)" stroke-width="9" stroke-linecap="round"/>
  <line x1="52" y1="150" x2="232" y2="126" stroke="var(--viz-good,#0a656d)" stroke-width="2.4" stroke-linecap="round"/>
  <line x1="140" y1="184" x2="146" y2="139" stroke="var(--viz-good,#0a656d)" stroke-width="1.6" stroke-dasharray="4 3"/>
  <circle cx="140" cy="184" r="6" fill="var(--accent-3,#5b21b6)"/>
  <text x="168" y="170" font-size="10" font-weight="700" fill="var(--viz-good,#0a656d)">6 m</text>
  <text x="142" y="222" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">one segment inside tolerance</text>
  <text x="142" y="238" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">snap and move on</text>
  <rect x="272" y="42" width="236" height="212" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-ok,#7d6200)" stroke-width="1.8"/>
  <text x="390" y="66" text-anchor="middle" font-size="11.5" font-weight="700" fill="var(--viz-ok,#7d6200)">ambiguous</text>
  <line x1="300" y1="140" x2="480" y2="116" stroke="var(--viz-stroke,#9ca3af)" stroke-width="9" stroke-linecap="round"/>
  <line x1="300" y1="140" x2="480" y2="116" stroke="var(--viz-ok,#7d6200)" stroke-width="2.4" stroke-linecap="round"/>
  <line x1="300" y1="176" x2="480" y2="152" stroke="var(--viz-stroke,#9ca3af)" stroke-width="9" stroke-linecap="round"/>
  <line x1="300" y1="176" x2="480" y2="152" stroke="var(--viz-ok,#7d6200)" stroke-width="2.4" stroke-linecap="round"/>
  <circle cx="392" cy="146" r="6" fill="var(--accent-3,#5b21b6)"/>
  <text x="404" y="132" font-size="9.5" font-weight="700" fill="var(--viz-ok,#7d6200)">9 m</text>
  <text x="404" y="176" font-size="9.5" font-weight="700" fill="var(--viz-ok,#7d6200)">9 m</text>
  <text x="390" y="222" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">two candidates equidistant</text>
  <text x="390" y="238" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">break the tie on heading</text>
  <rect x="520" y="42" width="236" height="212" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-poor,#a8320f)" stroke-width="1.8"/>
  <text x="638" y="66" text-anchor="middle" font-size="11.5" font-weight="700" fill="var(--viz-poor,#a8320f)">no match</text>
  <line x1="548" y1="112" x2="728" y2="98" stroke="var(--viz-stroke,#9ca3af)" stroke-width="9" stroke-linecap="round"/>
  <line x1="548" y1="112" x2="728" y2="98" stroke="var(--viz-stroke,#9ca3af)" stroke-width="2.4" stroke-linecap="round"/>
  <line x1="636" y1="194" x2="640" y2="118" stroke="var(--viz-poor,#a8320f)" stroke-width="1.6" stroke-dasharray="4 3"/>
  <circle cx="636" cy="194" r="6" fill="var(--accent-3,#5b21b6)"/>
  <text x="654" y="164" font-size="10" font-weight="700" fill="var(--viz-poor,#a8320f)">240 m</text>
  <text x="638" y="222" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">tunnel · nothing inside tolerance</text>
  <text x="638" y="238" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">return None, do not fabricate</text>
  <text x="24" y="286" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">The ceiling is what separates the third case from the first. Without it the tunnel fix snaps to whatever road happens</text>
  <text x="24" y="302" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">to be nearest, and the trace reads as a vehicle that drove through a building.</text>
</svg>

## Performance Notes

Cost per fix is one index seek plus geometry over the candidate set. The seek returns $k$ segments where $k \approx \rho \cdot 4r^2$ for road-node density $\rho$ and tolerance $r$; each candidate costs a constant handful of floating-point operations, so total per-fix work is $O(k)$ and independent of total graph size. Keep the tolerance close to the sensor's real 95th-percentile accuracy — a 30 m tolerance in an urban grid typically yields single-digit candidates, while inflating it to 200 m pulls in dozens and invites the parallel-road ambiguity above. For a live stream, run fixes concurrently with bounded `asyncio` fan-out against the pooled driver, and size the page cache to hold the road-node point index so each seek stays in memory. Batching many fixes into one `UNWIND` query amortizes round-trip latency when replaying historical traces.

## Related

- [Spatial Join Techniques](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/spatial-join-techniques/) — the join family this segment-snapping join belongs to.
- [K-Nearest-Neighbor Routing](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/k-nearest-neighbor-routing/) — ranking a bounded candidate set, the pattern the segment scoring reuses.
- [Distance Filter Query Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/) — the bounding-box pre-filter that seeds the candidate lookup.
- [Node and Edge Spatial Mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/) — modeling road segments as coordinate-bearing relationships.

This guide is part of [Spatial Join Techniques](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/spatial-join-techniques/), within the broader [Cypher Spatial Queries & Pathfinding Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/) knowledge base.

For authoritative reference on native spatial functions and geometry standards, consult the [Neo4j Cypher Spatial Functions Documentation](https://neo4j.com/docs/cypher-manual/current/functions/spatial/) and the [OGC Simple Features Specification](https://www.ogc.org/standards/sfa).
