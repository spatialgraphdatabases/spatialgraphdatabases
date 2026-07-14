---
pageTitle: Snapping & Intersection Detection
title: Snapping Coordinates and Detecting Intersections
description: Snap near-identical vertices to a metric tolerance and detect true road crossings so two segments share one graph node instead of leaving phantom dead-ends
slug: snapping-coordinates-and-detecting-intersections
type: article
breadcrumb: Snapping & Intersections
datePublished: 2026-07-14
dateModified: 2026-07-14
---
# Snapping Coordinates and Detecting Intersections

Two streets that visibly meet on the map route as if they were on separate continents, because their shared corner was digitized as two vertices a millionth of a degree apart. The topology now holds two distinct nodes with no edge between them, so a pathfinder reports a dead-end where a turn plainly exists. The reflex fix — rounding every coordinate to a fixed number of decimals — half-works and then betrays you at the grid boundary: two points a centimetre apart still round to different cells whenever they straddle a boundary line, and the duplicate survives. The durable fix is tolerance-based snapping: cluster every vertex that falls within a chosen metric radius onto one canonical node regardless of grid alignment, and detect the crossings where distinct roads intersect without sharing a vertex at all. This page builds that routine and writes the merged nodes to Neo4j.

It is the focused snapping-and-intersection step inside the [node and edge spatial mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/) contract; the surrounding geometry-to-topology converter — splitting linestrings, assigning directed geodesic weights, persisting in bulk — is built in [how to map road networks to graph nodes and edges](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/how-to-map-road-networks-to-graph-nodes-and-edges/).

## Prerequisites & Versions

| Library / Component | Min version | Install |
| --- | --- | --- |
| Python | 3.10 | needs `dict`/`tuple` generics |
| `shapely` | 2.0 | `pip install "shapely>=2.0"` (STRtree, stable predicates) |
| `neo4j` async driver | 5.14 | `pip install "neo4j>=5.14"` (persistence step only) |

Input segments are assumed to be in WGS 84 (`EPSG:4326`) with coordinates in `(longitude, latitude)` order, Shapely's native `(x, y)`. If your source CRS differs, reproject before snapping — the tolerance below is reasoned about in metres and would be meaningless in a projected unit that has not been normalized by the [node and edge spatial mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/) layer first.

<svg viewBox="0 0 820 350" role="img" aria-labelledby="snapTitle snapDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="snapTitle">Two nearly-touching road ends before snapping become one merged intersection node after</title>
  <desc id="snapDesc">Left panel: two road segments approach a corner but end at two separate open vertices about one millionth of a degree apart, inside a dashed tolerance circle of radius tau; because no vertex is shared and no edge bridges them, the pair reads as a phantom dead-end. Right panel: the same two ends are clustered within the tolerance onto a single solid canonical node, so all four segment ends now meet there and the turn becomes routable.</desc>
  <defs>
    <marker id="snap-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <line x1="410" y1="46" x2="410" y2="300" stroke="currentColor" stroke-width="1" stroke-dasharray="3 6" opacity="0.3"/>
  <!-- transform arrow -->
  <text x="410" y="150" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">snap</text>
  <text x="410" y="163" text-anchor="middle" font-size="10" fill="var(--accent,#0a656d)" font-weight="700">within &#964;</text>
  <line x1="386" y1="180" x2="434" y2="180" stroke="currentColor" stroke-width="1.6" marker-end="url(#snap-arrow)"/>
  <!-- ===== LEFT: before ===== -->
  <text x="205" y="28" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">Before — float noise</text>
  <!-- two segment stubs approaching the corner -->
  <line x1="60" y1="90" x2="188" y2="176" stroke="currentColor" stroke-width="2"/>
  <line x1="60" y1="270" x2="202" y2="188" stroke="currentColor" stroke-width="2"/>
  <text x="66" y="84" font-size="10" fill="currentColor" opacity="0.7">road A</text>
  <text x="66" y="286" font-size="10" fill="currentColor" opacity="0.7">road B</text>
  <!-- tolerance circle -->
  <circle cx="196" cy="182" r="34" fill="none" stroke="var(--accent-coral,#ff6b6b)" stroke-width="1.2" stroke-dasharray="3 4" opacity="0.85"/>
  <!-- two distinct open vertices -->
  <circle cx="188" cy="176" r="5.4" fill="none" stroke="var(--accent-coral,#ff6b6b)" stroke-width="2"/>
  <circle cx="202" cy="188" r="5.4" fill="none" stroke="var(--accent-coral,#ff6b6b)" stroke-width="2"/>
  <text x="248" y="150" font-size="10" fill="var(--accent-coral,#ff6b6b)">&#964; radius</text>
  <text x="205" y="318" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.85">2 vertices, ~1e-6&#176; apart</text>
  <text x="205" y="333" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--accent-coral,#ff6b6b)">no edge &#8594; phantom dead-end</text>
  <!-- ===== RIGHT: after ===== -->
  <text x="615" y="28" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">After — clustered to &#964;</text>
  <!-- four stubs meeting one node at (606,182) -->
  <line x1="470" y1="90" x2="606" y2="182" stroke="currentColor" stroke-width="2"/>
  <line x1="470" y1="270" x2="606" y2="182" stroke="currentColor" stroke-width="2"/>
  <line x1="606" y1="182" x2="742" y2="96" stroke="currentColor" stroke-width="2"/>
  <line x1="606" y1="182" x2="748" y2="262" stroke="currentColor" stroke-width="2"/>
  <!-- merged canonical node -->
  <circle cx="606" cy="182" r="9" fill="var(--accent,#0a656d)"/>
  <circle cx="606" cy="182" r="16" fill="none" stroke="var(--accent,#0a656d)" stroke-width="1.2" opacity="0.7"/>
  <text x="615" y="318" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.85">1 canonical node within &#964;</text>
  <text x="615" y="333" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--accent,#0a656d)">all ends meet &#8594; turn is routable</text>
</svg>

## Implementation

The core is a `SnapGrid` that clusters vertices onto canonical nodes within a metric tolerance. It buckets each point into a grid whose cell edge equals the tolerance, then — because a point can straddle a cell boundary — scans the 3×3 neighbourhood of cells before deciding whether the point is new. Intersection detection then finds crossings where distinct segments meet without a shared vertex, snaps those crossing points through the same grid, and splits the segments so the crossing becomes a genuine shared node. Coordinates below are around central London.

```python
import asyncio
import math
from typing import Dict, List, Tuple

from shapely.geometry import LineString, Point
from shapely.strtree import STRtree
from neo4j import AsyncGraphDatabase

EARTH_R_M = 6_371_000.0


def _meters_to_deg_lat(m: float) -> float:
    return math.degrees(m / EARTH_R_M)


def _meters_to_deg_lon(m: float, lat: float) -> float:
    return math.degrees(m / (EARTH_R_M * math.cos(math.radians(lat))))


class SnapGrid:
    """Cluster near-identical vertices within `tol_m` metres onto one canonical node.

    A plain round-to-grid snap drops duplicates that straddle a cell boundary, so
    every lookup scans the 3x3 neighbourhood and reuses any existing representative
    within the tolerance; only a genuinely new location registers a fresh node id.
    """

    def __init__(self, tol_m: float, ref_lat: float):
        self.tol_m = tol_m
        self.cell_lat = _meters_to_deg_lat(tol_m)
        self.cell_lon = _meters_to_deg_lon(tol_m, ref_lat)
        self.cells: Dict[Tuple[int, int], List[int]] = {}
        self.coords: List[Tuple[float, float]] = []  # node id -> (lat, lon)

    def _cell(self, lat: float, lon: float) -> Tuple[int, int]:
        return (math.floor(lat / self.cell_lat), math.floor(lon / self.cell_lon))

    def _dist_m(self, a: Tuple[float, float], b: Tuple[float, float]) -> float:
        d_lat = math.radians(b[0] - a[0])
        d_lon = math.radians(b[1] - a[1])
        h = (
            math.sin(d_lat / 2) ** 2
            + math.cos(math.radians(a[0])) * math.cos(math.radians(b[0])) * math.sin(d_lon / 2) ** 2
        )
        return 2 * EARTH_R_M * math.asin(math.sqrt(h))

    def snap(self, lat: float, lon: float) -> int:
        cx, cy = self._cell(lat, lon)
        for i in (cx - 1, cx, cx + 1):
            for j in (cy - 1, cy, cy + 1):
                for nid in self.cells.get((i, j), ()):
                    if self._dist_m((lat, lon), self.coords[nid]) <= self.tol_m:
                        return nid  # reuse the existing canonical node
        nid = len(self.coords)
        self.coords.append((lat, lon))
        self.cells.setdefault((cx, cy), []).append(nid)
        return nid


def detect_crossings(lines: List[LineString]) -> Dict[int, List[Point]]:
    """Map each segment index to the crossing points where a distinct segment cuts it."""
    tree = STRtree(lines)
    crossings: Dict[int, List[Point]] = {}
    for i, a in enumerate(lines):
        for j in tree.query(a):
            if j == i:
                continue
            b = lines[j]
            if not a.crosses(b):
                continue  # shared endpoints are handled by snapping, not splitting
            hit = a.intersection(b)
            if hit.geom_type == "Point":
                crossings.setdefault(i, []).append(hit)
    return crossings


def build_topology(segments: List[dict], tol_m: float) -> Tuple[SnapGrid, List[Tuple[int, int, bool]]]:
    """Snap every vertex, split at true crossings, and emit directed edges (u, v, oneway)."""
    lines = [LineString([(s["lon1"], s["lat1"]), (s["lon2"], s["lat2"])]) for s in segments]
    crossings = detect_crossings(lines)
    grid = SnapGrid(tol_m, ref_lat=segments[0]["lat1"])
    edges: List[Tuple[int, int, bool]] = []

    for i, seg in enumerate(segments):
        line = lines[i]
        pts = [Point(line.coords[0])] + crossings.get(i, []) + [Point(line.coords[-1])]
        # Order break points from the segment start so sub-edges stay contiguous.
        pts.sort(key=lambda p: line.project(p))
        node_ids = [grid.snap(p.y, p.x) for p in pts]  # shapely y=lat, x=lon
        oneway = bool(seg.get("oneway", False))
        for u, v in zip(node_ids, node_ids[1:]):
            if u == v:
                continue  # zero-length artifact from over-aggressive snapping
            edges.append((u, v, oneway))
            if not oneway:
                edges.append((v, u, oneway))
    return grid, edges


async def persist(grid: SnapGrid, edges: List[Tuple[int, int, bool]], uri: str, auth: Tuple[str, str]) -> None:
    driver = AsyncGraphDatabase.driver(uri, auth=auth, max_connection_pool_size=20)
    node_rows = [{"id": nid, "lat": lat, "lon": lon} for nid, (lat, lon) in enumerate(grid.coords)]
    edge_rows = [{"u": u, "v": v, "oneway": ow} for (u, v, ow) in edges]
    try:
        async with driver.session(database="neo4j") as session:
            await session.run(
                "CREATE POINT INDEX road_node_location IF NOT EXISTS "
                "FOR (n:RoadNode) ON (n.location)"
            )
            await session.run(
                """
                UNWIND $rows AS n
                MERGE (v:RoadNode {id: n.id})
                SET v.location = point({latitude: n.lat, longitude: n.lon, crs: 'wgs-84'})
                """,
                rows=node_rows,
            )
            await session.run(
                """
                UNWIND $rows AS e
                MATCH (a:RoadNode {id: e.u}), (b:RoadNode {id: e.v})
                MERGE (a)-[r:CONNECTS]->(b)
                SET r.oneway = e.oneway
                """,
                rows=edge_rows,
            )
    finally:
        await driver.close()


async def main() -> None:
    # Two roads crossing near a shared corner; the third stub ends a hair off the corner.
    segments = [
        {"lat1": 51.5079, "lon1": -0.1281, "lat2": 51.5074, "lon2": -0.1270, "oneway": False},
        {"lat1": 51.5081, "lon1": -0.1272, "lat2": 51.5072, "lon2": -0.1279, "oneway": True},
        {"lat1": 51.50765, "lon1": -0.12745, "lat2": 51.5069, "lon2": -0.1266, "oneway": False},
    ]
    grid, edges = build_topology(segments, tol_m=1.5)
    print(f"{len(grid.coords)} canonical nodes, {len(edges)} directed edges")
    await persist(grid, edges, "neo4j+s://your-cluster.databases.neo4j.io", ("neo4j", "secure-password"))


if __name__ == "__main__":
    asyncio.run(main())
```

## How It Works

Read the routine against the two defects it removes — duplicate vertices and unshared crossings.

- **The tolerance is a metric radius, not a decimal count.** `SnapGrid` sizes its cell edge from `tol_m` converted to degrees, so "within 1.5 m" means the same thing at London's latitude as at the equator. The 3×3 neighbourhood scan is what makes it robust: because the cell edge equals the tolerance, any two points within the tolerance land in the same or an adjacent cell, so scanning ±1 cell in each axis can never miss a valid neighbour. That closes the grid-boundary straddle that plain rounding leaves open.
- **Crossings become real nodes.** `detect_crossings` uses `a.crosses(b)` so it reports only genuine intersections — two roads cutting through each other — and ignores segments that merely share an endpoint, which snapping already handles. Feeding each crossing point back through `grid.snap` means the split vertex is clustered on exactly the same terms as an ordinary endpoint, so a crossing and a nearby endpoint collapse onto one node when they should.
- **Direction survives the merge.** Snapping operates on coordinates only; the `oneway` flag rides on the edge. Splitting a segment emits sub-edges between consecutive snapped nodes and mirrors them only when the road is two-way, so a one-way street stays one-way across every sub-segment and the `u == v` guard discards any self-loop a collapse would otherwise create.

Once persisted with a native `point` on each node, radius and corridor queries seek the point index exactly as in [distance filter query patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/).

## Common Failure Patterns

**1. Tolerance too large — distinct intersections merge.** Set `tol_m` above the spacing of real junctions and a tight diamond interchange or a pair of closely-set corners collapses into a single node, inventing turns the road network does not allow. Keep the tolerance strictly below the minimum true intersection spacing in the extract, and audit for degree spikes that betray an over-merge:

```python
def flag_overmerged(edges, max_degree=8):
    from collections import Counter
    deg = Counter()
    for u, v, _ in edges:
        deg[u] += 1
    return [n for n, d in deg.items() if d > max_degree]  # inspect before persisting
```

**2. Tolerance too small — duplicates survive.** Set it below the coordinate jitter in the source and near-identical endpoints stay as separate nodes, exactly the phantom dead-end the technique is meant to erase. Symptom: an inflated node count and unreachable pairs across visible junctions. Raise `tol_m` just above the ingestion noise floor (often a few decimetres for GPS-derived geometry) and assert that no node ends up isolated.

**3. Snapping that degrades one-way direction.** Snapping both endpoints of a very short one-way segment onto the same node turns it into a self-loop, and a naive de-duplication that reorders coordinates can silently flip the arrow. Preserve orientation explicitly: snap each endpoint independently, keep the emit order start-to-end, drop zero-length self-loops, and never collapse the two endpoints of a directed segment into one node.

```python
if u == v:
    continue                    # never fold a one-way onto itself
edges.append((u, v, oneway))    # forward direction is authoritative
if not oneway:
    edges.append((v, u, oneway))
```

## Performance Notes

Snapping tolerance $\tau$ in metres maps to degree-space cell edges by latitude and longitude:

$$\Delta\phi_\tau = \frac{\tau}{R}\cdot\frac{180}{\pi}, \qquad \Delta\lambda_\tau = \frac{\tau}{R\cos\phi}\cdot\frac{180}{\pi}$$

Sizing the grid cell to exactly $\tau$ is what bounds the neighbour search: any two points within $\tau$ differ by at most one cell index per axis, so the 3×3 scan is exhaustive and $\lvert\Delta_{\text{cell}}\rvert \le 1$ always holds. That keeps clustering at expected $O(n)$ over $n$ vertices — each point touches a constant nine cells — instead of the $O(n^2)$ of pairwise distance comparison, which is the difference between snapping a city extract in seconds and in hours.

Crossing detection is the other cost centre. `STRtree` indexes the segments so each `query` returns only candidates whose envelopes overlap, keeping the pass near $O(n \log n)$ rather than the $O(n^2)$ of testing every pair. Memory is the real ceiling once extracts grow: `SnapGrid` holds every canonical coordinate in RAM, so at continental scale switch to per-tile snapping and merge tiles on their shared boundary coordinates, streaming edges to the database rather than materializing the whole graph — the batched, backpressured path built in [OSM data ingestion pipelines](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/osm-data-ingestion-pipelines/).

## Related

- [How to Map Road Networks to Graph Nodes and Edges](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/how-to-map-road-networks-to-graph-nodes-and-edges/) — the full geometry-to-topology converter this snapping step feeds.
- [OSM Data Ingestion Pipelines](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/osm-data-ingestion-pipelines/) — streaming the snapped, split edges into the graph at scale.
- [Spatial Indexing Strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) — indexing the merged nodes for radius and tile queries.
- [Distance Filter Query Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/) — querying the persisted `location` point once topology is clean.

This guide is part of [Node and Edge Spatial Mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/), within [Spatial Graph Database Fundamentals for Python](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/).

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": [
    {
      "@type": "ListItem",
      "position": 1,
      "name": "Spatial Graph Database Fundamentals for Python",
      "item": "https://spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/"
    },
    {
      "@type": "ListItem",
      "position": 2,
      "name": "Node and Edge Spatial Mapping",
      "item": "https://spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/"
    },
    {
      "@type": "ListItem",
      "position": 3,
      "name": "Snapping Coordinates and Detecting Intersections",
      "item": "https://spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/snapping-coordinates-and-detecting-intersections/"
    }
  ]
}
</script>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "TechArticle",
  "headline": "Snapping Coordinates and Detecting Intersections",
  "description": "Snap near-identical vertices to a metric tolerance and detect true road crossings so two segments share one graph node instead of leaving phantom dead-ends.",
  "datePublished": "2026-07-14",
  "dateModified": "2026-07-14",
  "articleSection": "Node and Edge Spatial Mapping",
  "keywords": "coordinate snapping, intersection detection, snap tolerance, road topology, Neo4j async Python",
  "mainEntityOfPage": {
    "@type": "WebPage",
    "@id": "https://spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/snapping-coordinates-and-detecting-intersections/"
  }
}
</script>
