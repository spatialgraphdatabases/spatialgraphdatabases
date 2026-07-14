---
pageTitle: Map Road Networks to Graph Nodes
---
# How to Map Road Networks to Graph Nodes and Edges

A routing engine returns a "no path found" between two streets that visibly cross on the map, or it reports a detour twice the real distance. The symptom traces back to ingestion, not the pathfinder: two `LINESTRING` segments that meet at an intersection were loaded with endpoints that differ in the 12th decimal place, so the graph holds two distinct nodes a few microns apart and no edge bridges them. The root cause is treating raw GIS geometry as if it were already topology — coordinates as continuous floats, segments as edges, intersections left implicit. This page resolves that with a deterministic converter: it quantizes coordinates, splits every linestring at its true crossings, collapses shared endpoints onto one canonical node, and emits a directed graph with geodesic edge weights ready to persist. It is the concrete builder behind the [node and edge spatial mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/) layer.

<svg viewBox="0 0 840 372" role="img" aria-labelledby="pipeTitle pipeDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="pipeTitle">Geometry-to-topology pipeline: raw crossing linestrings, quantize-and-split, directed weighted graph</title>
  <desc id="pipeDesc">Panel one shows two raw LINESTRINGs that visibly cross but whose endpoints differ in the twelfth decimal, producing two distinct nodes and no edge. Panel two shows the same geometry quantized and split at the true crossing, collapsing both endpoints onto one highlighted canonical node so four atomic segments share it. Panel three shows the resulting directed graph: numbered nodes joined by CONNECTS edges carrying geodesic weights in meters, with one one-way arrow and the rest bidirectional.</desc>
  <defs>
    <marker id="pipeArr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <!-- panel separators -->
  <line x1="270" y1="40" x2="270" y2="300" stroke="currentColor" stroke-width="1" stroke-dasharray="3 6" opacity="0.25"/>
  <line x1="570" y1="40" x2="570" y2="300" stroke="currentColor" stroke-width="1" stroke-dasharray="3 6" opacity="0.25"/>
  <!-- inter-panel transform arrows -->
  <text x="270" y="150" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.75">quantize</text>
  <text x="270" y="162" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.75">+ split</text>
  <line x1="246" y1="178" x2="294" y2="178" stroke="currentColor" stroke-width="1.6" marker-end="url(#pipeArr)"/>
  <text x="570" y="150" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.75">weight</text>
  <text x="570" y="162" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.75">+ direct</text>
  <line x1="546" y1="178" x2="594" y2="178" stroke="currentColor" stroke-width="1.6" marker-end="url(#pipeArr)"/>
  <!-- ===== PANEL 1: raw geometry ===== -->
  <text x="120" y="26" text-anchor="middle" font-size="13.5" font-weight="700" fill="currentColor">1 · Raw GIS geometry</text>
  <line x1="30" y1="85" x2="210" y2="245" stroke="currentColor" stroke-width="2" opacity="0.85"/>
  <line x1="30" y1="245" x2="210" y2="85" stroke="currentColor" stroke-width="2" opacity="0.85"/>
  <text x="38" y="80" font-size="10" fill="currentColor" opacity="0.7">road A</text>
  <text x="172" y="80" font-size="10" fill="currentColor" opacity="0.7">road B</text>
  <!-- mismatched endpoints near the crossing: two open dots, no shared node -->
  <circle cx="114" cy="160" r="5" fill="none" stroke="var(--accent-coral,#ff6b6b)" stroke-width="2"/>
  <circle cx="127" cy="171" r="5" fill="none" stroke="var(--accent-coral,#ff6b6b)" stroke-width="2"/>
  <circle cx="120" cy="165" r="26" fill="none" stroke="var(--accent-coral,#ff6b6b)" stroke-width="1.2" stroke-dasharray="3 4" opacity="0.8"/>
  <text x="120" y="300" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.85">2 nodes, ~1e-12° apart</text>
  <text x="120" y="314" text-anchor="middle" font-size="10" font-weight="700" fill="var(--accent-coral,#ff6b6b)">no edge bridges them</text>
  <!-- ===== PANEL 2: quantized + split ===== -->
  <text x="420" y="26" text-anchor="middle" font-size="13.5" font-weight="700" fill="currentColor">2 · Snapped &amp; split</text>
  <line x1="330" y1="85" x2="420" y2="165" stroke="currentColor" stroke-width="2"/>
  <line x1="420" y1="165" x2="510" y2="245" stroke="currentColor" stroke-width="2"/>
  <line x1="330" y1="245" x2="420" y2="165" stroke="currentColor" stroke-width="2"/>
  <line x1="420" y1="165" x2="510" y2="85" stroke="currentColor" stroke-width="2"/>
  <!-- endpoint nodes -->
  <circle cx="330" cy="85" r="5" fill="currentColor"/>
  <circle cx="510" cy="85" r="5" fill="currentColor"/>
  <circle cx="330" cy="245" r="5" fill="currentColor"/>
  <circle cx="510" cy="245" r="5" fill="currentColor"/>
  <!-- single canonical snapped node -->
  <circle cx="420" cy="165" r="9" fill="var(--accent,#0e7c86)"/>
  <circle cx="420" cy="165" r="15" fill="none" stroke="var(--accent,#0e7c86)" stroke-width="1.2" opacity="0.7"/>
  <text x="420" y="300" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.85">1 canonical node,</text>
  <text x="420" y="314" text-anchor="middle" font-size="10" font-weight="700" fill="var(--accent,#0e7c86)">4 atomic segments meet</text>
  <!-- ===== PANEL 3: directed weighted graph ===== -->
  <text x="720" y="26" text-anchor="middle" font-size="13.5" font-weight="700" fill="currentColor">3 · Directed graph</text>
  <!-- edges -->
  <line x1="720" y1="165" x2="641" y2="96" stroke="currentColor" stroke-width="1.8" marker-start="url(#pipeArr)" marker-end="url(#pipeArr)"/>
  <line x1="720" y1="165" x2="799" y2="96" stroke="var(--accent,#0e7c86)" stroke-width="2" marker-end="url(#pipeArr)"/>
  <line x1="720" y1="165" x2="641" y2="234" stroke="currentColor" stroke-width="1.8" marker-start="url(#pipeArr)" marker-end="url(#pipeArr)"/>
  <line x1="720" y1="165" x2="799" y2="234" stroke="currentColor" stroke-width="1.8" marker-start="url(#pipeArr)" marker-end="url(#pipeArr)"/>
  <!-- weight labels -->
  <text x="664" y="124" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.8">88 m</text>
  <text x="772" y="120" text-anchor="middle" font-size="9.5" fill="var(--accent,#0e7c86)" font-weight="700">120 m ›</text>
  <text x="664" y="212" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.8">95 m</text>
  <text x="776" y="212" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.8">140 m</text>
  <!-- nodes -->
  <g font-size="11" font-weight="700" text-anchor="middle">
    <circle cx="630" cy="85" r="14" fill="none" stroke="currentColor" stroke-width="1.8"/><text x="630" y="89" fill="currentColor">0</text>
    <circle cx="810" cy="85" r="14" fill="none" stroke="currentColor" stroke-width="1.8"/><text x="810" y="89" fill="currentColor">1</text>
    <circle cx="630" cy="245" r="14" fill="none" stroke="currentColor" stroke-width="1.8"/><text x="630" y="249" fill="currentColor">2</text>
    <circle cx="810" cy="245" r="14" fill="none" stroke="currentColor" stroke-width="1.8"/><text x="810" y="249" fill="currentColor">3</text>
    <circle cx="720" cy="165" r="15" fill="var(--accent,#0e7c86)"/><text x="720" y="169" fill="#fff">4</text>
  </g>
  <text x="720" y="300" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.85">CONNECTS edges, geodesic weight</text>
  <text x="720" y="314" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.85"><tspan fill="var(--accent,#0e7c86)" font-weight="700">›</tspan> = one-way · others two-way</text>
  <!-- footer caption -->
  <text x="420" y="350" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7">build_spatial_graph(): geometry → topology → weighted directed graph</text>
</svg>

## Prerequisites & Versions

| Library / Component | Min version | Install |
| --- | --- | --- |
| Python | 3.10 | `pyenv install 3.10` (needs `dict`/`tuple` generics) |
| `shapely` | 2.0 | `pip install "shapely>=2.0"` (vectorized predicates, stable `split`) |
| `geopandas` | 0.14 | `pip install "geopandas>=0.14"` |
| `networkx` | 3.2 | `pip install "networkx>=3.2"` |
| `neo4j` async driver | 5.14 | `pip install "neo4j>=5.14"` (only for the persistence step) |

The input is a `GeoDataFrame` of `LineString` geometries already projected to WGS-84 (`EPSG:4326`). If your source CRS differs, reproject before calling the builder — the Haversine weight assumes `(longitude, latitude)` degrees, which is Shapely's native `(x, y)` ordering. CRS handling itself is owned upstream by the [node and edge spatial mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/) cluster's normalization step.

## Implementation

The module below is self-contained. `build_spatial_graph` quantizes geometry, extracts true crossing points, splits each segment at the crossings that lie on it, and assigns every endpoint a canonical integer node id keyed on its rounded coordinate. Edge weights are geodesic meters from the Haversine formula; one-way tags produce a single directed edge, everything else produces both directions.

```python
import math
from typing import Dict, List, Tuple

import geopandas as gpd
import networkx as nx
from shapely.geometry import LineString, MultiLineString, MultiPoint, Point
from shapely.ops import split, unary_union

EARTH_RADIUS_M = 6_371_000
SNAP_PRECISION = 6  # ~0.11 m at the equator


def haversine_distance(p1: Point, p2: Point) -> float:
    """Geodesic distance in meters. Points are (x, y) = (lon, lat)."""
    lat1, lon1 = math.radians(p1.y), math.radians(p1.x)
    lat2, lon2 = math.radians(p2.y), math.radians(p2.x)
    dlat, dlon = lat2 - lat1, lon2 - lon1
    a = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(a))


def quantize_coords(geom: LineString, precision: int) -> LineString:
    """Round every vertex so coincident points become bit-identical."""
    return LineString([(round(x, precision), round(y, precision)) for x, y in geom.coords])


def _crossing_points(geoms: List[LineString]) -> List[Point]:
    """True crossings: each segment intersected against the union of the others.

    Comparing a segment to itself is a no-op, so we subtract it from the full
    union first. Collinear overlaps yield LineStrings, not Points; those are
    ignored here and resolved by endpoint quantization instead.
    """
    points: List[Point] = []
    full_union = unary_union(geoms)
    for g in geoms:
        crossing = g.intersection(full_union.difference(g))
        if crossing.is_empty:
            continue
        if isinstance(crossing, Point):
            points.append(crossing)
        elif isinstance(crossing, MultiPoint):
            points.extend(crossing.geoms)
    return points


def build_spatial_graph(gdf_roads: gpd.GeoDataFrame, precision: int = SNAP_PRECISION) -> nx.DiGraph:
    """Convert raw road linestrings into a directed graph with geodesic weights."""
    gdf = gdf_roads.copy()
    gdf["geometry"] = gdf.geometry.apply(
        lambda g: quantize_coords(g, precision).buffer(0).simplify(1e-5)
    )

    split_pts = _crossing_points(list(gdf.geometry))

    G = nx.DiGraph()
    node_ids: Dict[Tuple[float, float], int] = {}
    next_id = 0

    def node_for(pt: Point) -> int:
        nonlocal next_id
        key = (round(pt.x, precision), round(pt.y, precision))
        if key not in node_ids:
            node_ids[key] = next_id
            G.add_node(next_id, lon=key[0], lat=key[1])
            next_id += 1
        return node_ids[key]

    for _, row in gdf.iterrows():
        # Split this line at every crossing point that actually touches it.
        segments: List[LineString] = [row.geometry]
        for pt in split_pts:
            nxt: List[LineString] = []
            for seg in segments:
                if seg.distance(pt) < 1e-7:
                    result = split(seg, pt)
                    nxt.extend(result.geoms if isinstance(result, MultiLineString) else [result])
                else:
                    nxt.append(seg)
            segments = nxt

        is_oneway = str(row.get("oneway", "no")).lower() in ("yes", "1", "true")
        for seg in segments:
            start, end = Point(seg.coords[0]), Point(seg.coords[-1])
            u, v = node_for(start), node_for(end)
            if u == v:
                continue  # zero-length artifact from over-aggressive snapping
            weight_m = haversine_distance(start, end)
            G.add_edge(u, v, weight=weight_m, length_m=weight_m, oneway=is_oneway)
            if not is_oneway:
                G.add_edge(v, u, weight=weight_m, length_m=weight_m, oneway=False)

    return G
```

Persisting the result to a spatial graph database keeps the topology static and indexable. Store each node's coordinate as a native `point` so the planner can seek it, and `MERGE` on the canonical id so re-ingestion is idempotent:

```cypher
// Run once before ingestion. A point index lets later routing queries seek
// the location property instead of scanning every RoadNode.
CREATE POINT INDEX road_node_location IF NOT EXISTS
FOR (n:RoadNode) ON (n.location);
```

```python
from neo4j import AsyncGraphDatabase

BATCH = 5_000


async def persist_graph(G: nx.DiGraph, uri: str, auth: tuple[str, str]) -> None:
    driver = AsyncGraphDatabase.driver(uri, auth=auth, max_connection_pool_size=20)
    node_q = """
    UNWIND $rows AS n
    MERGE (v:RoadNode {id: n.id})
    SET v.location = point({longitude: n.lon, latitude: n.lat, crs: 'wgs-84'})
    """
    edge_q = """
    UNWIND $rows AS e
    MATCH (u:RoadNode {id: e.u}), (v:RoadNode {id: e.v})
    MERGE (u)-[r:CONNECTS {dir: e.dir}]->(v)
    SET r.weight = e.weight, r.length_m = e.length_m, r.oneway = e.oneway
    """
    nodes = [{"id": n, "lon": d["lon"], "lat": d["lat"]} for n, d in G.nodes(data=True)]
    edges = [{"u": u, "v": v, "weight": d["weight"], "length_m": d["length_m"],
              "oneway": d["oneway"], "dir": f"{u}_{v}"} for u, v, d in G.edges(data=True)]
    try:
        async with driver.session() as session:
            await session.run("CALL db.awaitIndexes(120)")
            for i in range(0, len(nodes), BATCH):
                await session.run(node_q, rows=nodes[i:i + BATCH])
            for i in range(0, len(edges), BATCH):
                await session.run(edge_q, rows=edges[i:i + BATCH])
    finally:
        await driver.close()
```

## How It Works

Read the builder against the topology it produces — three decisions carry the correctness:

- **Quantization makes coincident points identical, not just close.** Rounding to `precision=6` (~11 cm) collapses survey jitter so two segments that meet at a corner round to the *same* `(lon, lat)` key. `node_for` keys the node map on that rounded tuple, so the canonical-node lookup is an exact dict hit — no tolerance search, no spatial join. This is the same coordinate-precision discipline that the [graph query planner optimization](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/) layer depends on downstream.
- **`_crossing_points` returns only true crossings.** Intersecting each segment with the union of the *others* (not itself) yields the points where distinct roads physically cross. Splitting there turns an X-shaped pair of linestrings into four atomic edges meeting at one shared node — the planar-graph invariant every shortest-path algorithm assumes.
- **Direction lives on the edge, never the node.** A `oneway` tag emits one `CONNECTS` edge; an undirected road emits both. The node holds only geometry. That separation is what lets Dijkstra or A* respect one-way restrictions without re-interpreting bidirectional segments mid-traversal, and it keeps the geodesic `weight` symmetric for two-way roads.

The Haversine weight is a great-circle measure on the WGS-84 sphere, so `length_m` reflects real travel distance rather than the degree-space distance a planar Euclidean metric would (mis)report. Once persisted, radius and corridor queries against `n.location` reuse the pattern described in [filtering graph paths by Haversine distance in Cypher](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/filtering-graph-paths-by-haversine-distance-in-cypher/).

## Common Failure Patterns

**1. Duplicate nodes from a precision mismatch.** If `build_spatial_graph` and the consumer round to different decimal places, "the same" intersection maps to two keys and the graph silently fragments. Symptom: inflated node count and unreachable pairs. Assert connectivity right after the build, before persisting:

```python
def assert_topology(G: nx.DiGraph) -> dict:
    deg = dict(G.degree())
    dangling = [n for n, d in deg.items() if d == 1]   # dead-ends OR data errors
    isolated = [n for n, d in deg.items() if d == 0]    # always errors
    assert not isolated, f"{len(isolated)} isolated nodes — precision/snapping bug"
    return {"nodes": G.number_of_nodes(), "edges": G.number_of_edges(),
            "dangling": len(dangling), "components": nx.number_weakly_connected_components(G)}
```

**2. Collinear overlaps leave segments unsplit.** When two roads share a stretch of geometry (a divided highway digitized twice, or a ramp tracing a main road), `intersection` returns a `LineString`, which `_crossing_points` skips. Those overlaps must be deduplicated before the build — `unary_union` the input first, or drop near-identical geometries — otherwise you get parallel edges with conflicting `oneway` tags. Run `unary_union(list(gdf.geometry))` and inspect the result type to detect overlaps early.

**3. Over-aggressive `simplify` drops real intersection vertices.** A `simplify` tolerance set in degrees but reasoned about in meters can delete the very vertex where two roads meet, severing connectivity. Keep the tolerance below your snap precision (here `1e-5` degrees < the `1e-7` split test), and the `if u == v: continue` guard discards any zero-length artifact a collapsed segment would otherwise create.

## Performance Notes

Construction is dominated by the crossing-point pass. `_crossing_points` does one `unary_union` plus a per-segment intersection, so for $N$ input segments the practical cost is roughly

$$
C_{\text{build}} \approx \underbrace{N \log N}_{\text{union / STRtree}} + \underbrace{N \cdot \bar{k}}_{\text{per-segment splits}}
$$

where $\bar{k}$ is the mean number of crossing points touching a segment. The naive variant — intersecting every segment against every other — is $O(N^2)$ and becomes the bottleneck well before a city-scale extract; the union-based form above keeps it near-linear because Shapely 2.x indexes the union with an STRtree internally.

Memory is the real ceiling. `networkx` holds the entire topology in RAM, budgeting on the order of a kilobyte per node and edge once Python object overhead is counted, so a continental extract of tens of millions of edges will not fit. Switch strategies at that scale: stream atomic edges through `persist_graph` in `BATCH`-sized chunks straight to the database — the streaming counterpart developed in [scaling async graph ingestion with Python asyncio](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/async-batch-processing-for-graphs/scaling-async-graph-ingestion-with-python-asyncio/) — and drop the in-memory `DiGraph` entirely, or build per-tile and merge on the canonical node keys. Frequent `MERGE` on a hot point index also fragments it under sustained ingestion; rebuild during a maintenance window if seek latency drifts, and supply explicit spatial bounds on every routing query so the planner seeks `n.location` rather than scanning the full graph.

## Related

- [Node and Edge Spatial Mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/) — CRS normalization and the geometry-to-topology contract this builder implements
- [Implementing Geohash vs Quadtree Indexing in Neo4j](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/implementing-geohash-vs-quadtree-indexing-in-neo4j/) — index the persisted nodes for radius and tile queries
- [Optimizing Cypher Query Plans for Spatial Data](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/optimizing-cypher-query-plans-for-spatial-data/) — make the routing queries seek the point index this graph populates
- [Scaling Async Graph Ingestion with Python asyncio](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/async-batch-processing-for-graphs/scaling-async-graph-ingestion-with-python-asyncio/) — stream the built edges past the in-memory ceiling

This guide is part of [Node and Edge Spatial Mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/), within the [Spatial Graph Database Fundamentals for Python](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/) reference.
