---
pageTitle: KNN Routing for Spatial Graphs
---
# K-Nearest Neighbor Routing in Production Spatial Graphs

Asking "which depots are nearest?" with a straight-line distance returns the wrong answer the moment a river, a motorway with no on-ramp, or a one-way grid sits between the query point and the candidate. The crow-flies nearest hub can be a 40-minute detour while the second-nearest is five minutes down a through-road. K-nearest neighbor routing fixes this by ranking candidates on *network travel cost* instead of coordinate proximity: it first uses a spatial index to pull a small, bounded candidate set, then runs a real shortest-path pass over the road graph to re-rank those candidates by the cost a vehicle actually pays. Get the first phase wrong and the database scans the whole graph for every dispatch; get the second phase wrong and you assign the geometrically-close-but-unreachable hub, which surfaces as missed SLAs, idle vehicles, and angry operations dashboards. This guide builds that two-phase pattern as runnable async Python over Neo4j, profiles it, and hardens it against the precision and projection traps that quietly corrupt results. It is one of the core techniques in [Cypher Spatial Queries & Pathfinding Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/).

<svg viewBox="0 0 920 460" role="img" aria-labelledby="knn-geo-title knn-geo-desc" xmlns="http://www.w3.org/2000/svg">
  <title id="knn-geo-title">Geometric nearest hub versus network-nearest hub across a river barrier</title>
  <desc id="knn-geo-desc">A query origin sits south of a river. Hub A is the closest hub by straight-line distance but lies on the far bank with no nearby crossing, so its true road route detours far east to a bridge and back — a long path. Hub B is slightly farther in straight-line distance but on the same bank as the origin, reachable by a short direct road. K-nearest neighbor routing ranks Hub B first because it ranks by network travel cost, not geometric proximity.</desc>
  <style>
    .kg-bad{stroke:var(--viz-poor,#a8320f);}
    .kg-good{stroke:var(--viz-good,#0a656d);}
    .kg-node{fill:var(--ink,#1b2330);opacity:0.16;}
    .kg-river{fill:none;stroke:var(--ink,#1b2330);opacity:0.10;}
    .kg-lab{fill:var(--ink,#1b2330);font:600 13px var(--font-sans,system-ui,sans-serif);}
    .kg-cap{fill:var(--ink-mute,#6f7a8c);font:11.5px var(--font-sans,system-ui,sans-serif);}
    .kg-tag{fill:var(--ink-soft,#455062);font:600 12px var(--font-sans,system-ui,sans-serif);}
    .kg-white{fill:var(--viz-on-pill,#ffffff);font:700 13px var(--font-sans,system-ui,sans-serif);}
  </style>
  <defs>
    <marker id="kg-red" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="var(--viz-poor,#a8320f)"/></marker>
    <marker id="kg-green" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="var(--viz-good,#0a656d)"/></marker>
  </defs>
  <!-- river barrier -->
  <rect class="viz-backdrop" x="0" y="0" width="920" height="460" fill="var(--viz-bg,#ffffff)"/>
  <path class="kg-river" stroke-width="30" d="M0 195 C 150 155, 300 235, 470 190 S 770 150, 920 200"/>
  <text class="kg-cap" x="60" y="160" transform="rotate(-9 60 160)">river — no nearby crossing</text>
  <!-- bridge -->
  <g>
    <rect x="686" y="150" width="28" height="88" rx="3" fill="var(--surface-2,#fff)" stroke="var(--line-strong,#cdc6b3)" stroke-width="1.5"/>
    <line x1="686" y1="172" x2="714" y2="172" stroke="var(--line-strong,#cdc6b3)" stroke-width="1"/>
    <line x1="686" y1="216" x2="714" y2="216" stroke="var(--line-strong,#cdc6b3)" stroke-width="1"/>
    <text class="kg-cap" x="700" y="258" text-anchor="middle">bridge</text>
  </g>
  <!-- scattered dense node field -->
  <g class="kg-node">
    <circle cx="120" cy="280" r="3"/><circle cx="190" cy="395" r="3"/><circle cx="360" cy="300" r="3"/>
    <circle cx="430" cy="370" r="3"/><circle cx="600" cy="300" r="3"/><circle cx="610" cy="385" r="3"/>
    <circle cx="170" cy="90" r="3"/><circle cx="410" cy="80" r="3"/><circle cx="600" cy="95" r="3"/>
    <circle cx="780" cy="110" r="3"/><circle cx="820" cy="320" r="3"/><circle cx="760" cy="370" r="3"/>
    <circle cx="470" cy="120" r="3"/><circle cx="330" cy="150" r="3"/>
  </g>
  <!-- detour road route to Hub A (long, red solid) -->
  <path class="kg-bad" fill="none" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round"
        marker-end="url(#kg-red)" d="M250 330 L670 335 L700 330 L700 140 L560 116 L312 112"/>
  <!-- short road route to Hub B (green solid) -->
  <path class="kg-good" fill="none" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round"
        marker-end="url(#kg-green)" d="M250 330 L380 345 L508 349"/>
  <!-- crow-flies straight line origin to Hub A (red dashed) -->
  <line class="kg-bad" x1="250" y1="330" x2="300" y2="120" stroke-width="2" stroke-dasharray="6 5"/>
  <text class="kg-tag" x="262" y="306" transform="rotate(-77 262 306)" style="fill:var(--viz-poor,#a8320f)">straight-line nearest</text>
  <!-- origin -->
  <circle cx="250" cy="330" r="13" fill="var(--accent,#0e7c86)"/>
  <text class="kg-white" x="250" y="335" text-anchor="middle">Q</text>
  <text class="kg-cap" x="250" y="362" text-anchor="middle">origin (query point)</text>
  <!-- Hub A -->
  <circle cx="300" cy="110" r="11" fill="var(--surface-2,#fff)" stroke="var(--viz-poor,#a8320f)" stroke-width="3"/>
  <text class="kg-lab" x="318" y="100">Hub A</text>
  <text class="kg-cap" x="318" y="116">nearest by geometry — unreachable direct</text>
  <!-- Hub B -->
  <circle cx="520" cy="350" r="11" fill="var(--surface-2,#fff)" stroke="var(--viz-good,#0a656d)" stroke-width="3"/>
  <text class="kg-lab" x="538" y="346">Hub B</text>
  <text class="kg-cap" x="538" y="362">network-nearest — short reachable route</text>
  <!-- legend -->
  <g transform="translate(40 425)">
    <line class="kg-bad" x1="0" y1="0" x2="34" y2="0" stroke-width="2" stroke-dasharray="6 5"/>
    <text class="kg-cap" x="42" y="4">straight-line (filter only)</text>
    <line class="kg-bad" x1="250" y1="0" x2="284" y2="0" stroke-width="3.5"/>
    <text class="kg-cap" x="292" y="4">road route to Hub A — long detour</text>
    <line class="kg-good" x1="595" y1="0" x2="629" y2="0" stroke-width="3.5"/>
    <text class="kg-cap" x="637" y="4">road route to Hub B — short</text>
  </g>
</svg>

## Prerequisites

These examples assume an async Python service talking to Neo4j with the Graph Data Science (GDS) library installed, since the second phase projects a subgraph and runs a shortest-path algorithm. The bounding-box math is pure client-side Python and version-independent; the `point.distance()` and index-backed range semantics are stable on Neo4j 5.x.

| Requirement | Minimum version | Notes |
| --- | --- | --- |
| Python | 3.10+ | Union types and structural `match` used in examples |
| Neo4j | 5.13+ | Native `point` type, `CREATE POINT INDEX`, index-backed range predicates |
| neo4j (driver) | 5.x | Async driver (`AsyncGraphDatabase`), native point serialization |
| Graph Data Science | 2.5+ | `gds.graph.project` Cypher aggregation, `gds.shortestPath.dijkstra` / `.astar` |
| pytest / pytest-asyncio | 0.23+ | For the correctness assertions in the testing section |

```bash
pip install "neo4j>=5.18" "pytest>=8.0" "pytest-asyncio>=0.23"
```

The graph this pattern runs against must already follow sound [node and edge spatial mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/) conventions — coordinates stored as native `point` values on the nodes you filter, and traversable segments stored as weighted directed relationships — backed by the right [spatial indexing strategy](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) on the `location` property. Without a point index, the candidate phase degrades to a full label scan and the latency win disappears.

## Core Concept & Mechanism

K-nearest neighbor routing separates two questions that beginners conflate: *who is geometrically close* and *who is cheapest to reach*. Solving them in one pass is intractable — a true cost-ranked nearest-K over a continental graph would expand shortest paths to every node before sorting. The pattern instead runs in two phases, each using the data structure suited to its question.

**Phase one — spatial pre-filter.** A coordinate-aligned bounding box on `location.latitude`/`location.longitude` lets the native point index (an R-tree variant) seek a small candidate window directly, and `point.distance()` clips that box to a true radius. This is exactly the technique covered in [distance filter query patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/); KNN routing consumes its output. Because straight-line distance is a *lower bound* on network distance, every node within the road-cost answer is guaranteed to sit inside a sufficiently generous straight-line radius — so over-fetching candidates here is safe, and under-fetching is the only correctness risk.

**Phase two — network re-rank.** The bounded candidate set is projected into an in-memory GDS graph along with the relationships connecting them to the origin, and a weighted shortest-path algorithm (Dijkstra, or A\* when a geographic heuristic helps) computes the true travel cost from origin to each candidate. The candidates are then sorted by that cost and the top `k` returned. The straight-line ranking from phase one is discarded — it was only ever a filter, never the answer.

<svg viewBox="0 0 920 360" role="img" aria-labelledby="knn-flow-title knn-flow-desc" xmlns="http://www.w3.org/2000/svg">
  <title id="knn-flow-title">Two-phase K-nearest neighbor routing pipeline</title>
  <desc id="knn-flow-desc">Phase one, spatial pre-filter: a query point of latitude, longitude and k feeds a bounding-box and radius seek on the point index, which is ranked by straight-line point.distance to produce a Top-K candidate set. That candidate set is passed to phase two, network re-rank: the candidates are projected into a GDS subgraph, a weighted shortest path (Dijkstra or A*) computes true travel cost, and the result is the nearest hubs ranked by travel cost.</desc>
  <style>
    .kf-panel{fill:var(--accent,#0e7c86);opacity:0.06;}
    .kf-pstroke{fill:none;stroke:var(--accent,#0e7c86);opacity:0.4;stroke-width:1.5;stroke-dasharray:5 4;}
    .kf-box{fill:var(--surface-2,#fff);stroke:var(--line-strong,#cdc6b3);stroke-width:1.5;}
    .kf-t{fill:var(--ink,#1b2330);font:600 13px var(--font-sans,system-ui,sans-serif);}
    .kf-mono{fill:var(--ink-mute,#6f7a8c);font:11.5px var(--font-mono,ui-monospace,monospace);}
    .kf-ph{fill:var(--accent,#0e7c86);font:700 12.5px var(--font-sans,system-ui,sans-serif);letter-spacing:0.04em;}
    .kf-edge{fill:none;stroke:var(--ink-mute,#6f7a8c);stroke-width:2;}
    .kf-handoff{fill:var(--ink-soft,#455062);font:600 12px var(--font-sans,system-ui,sans-serif);}
  </style>
  <defs>
    <marker id="kf-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="var(--ink-mute,#6f7a8c)"/></marker>
  </defs>
  <!-- Phase 1 panel -->
  <rect class="viz-backdrop" x="0" y="0" width="920" height="360" fill="var(--viz-bg,#ffffff)"/>
  <rect class="kf-panel" x="30" y="44" width="360" height="296" rx="14"/>
  <rect class="kf-pstroke" x="30" y="44" width="360" height="296" rx="14"/>
  <text class="kf-ph" x="50" y="30">PHASE 1 · SPATIAL PRE-FILTER</text>
  <!-- Phase 2 panel -->
  <rect class="kf-panel" x="530" y="44" width="360" height="296" rx="14"/>
  <rect class="kf-pstroke" x="530" y="44" width="360" height="296" rx="14"/>
  <text class="kf-ph" x="550" y="30">PHASE 2 · NETWORK RE-RANK</text>
  <!-- Phase 1 boxes -->
  <g text-anchor="middle">
    <rect class="kf-box" x="60" y="62" width="300" height="46" rx="9"/>
    <text class="kf-t" x="210" y="82">Query point</text><text class="kf-mono" x="210" y="99">(lat, lon, k)</text>
    <rect class="kf-box" x="60" y="132" width="300" height="46" rx="9"/>
    <text class="kf-t" x="210" y="152">Bounding-box + radius seek</text><text class="kf-mono" x="210" y="169">point index range predicate</text>
    <rect class="kf-box" x="60" y="202" width="300" height="46" rx="9"/>
    <text class="kf-t" x="210" y="222">Rank by straight-line</text><text class="kf-mono" x="210" y="239">point.distance()</text>
    <rect class="kf-box" x="60" y="272" width="300" height="46" rx="9"/>
    <text class="kf-t" x="210" y="298">Top-K candidate set</text>
  </g>
  <!-- Phase 2 boxes -->
  <g text-anchor="middle">
    <rect class="kf-box" x="560" y="62" width="300" height="46" rx="9"/>
    <text class="kf-t" x="710" y="88">GDS subgraph projection</text>
    <rect class="kf-box" x="560" y="148" width="300" height="46" rx="9"/>
    <text class="kf-t" x="710" y="168">Weighted shortest path</text><text class="kf-mono" x="710" y="185">Dijkstra / A*</text>
    <path class="kf-box" d="M560 248 a150 9 0 0 1 300 0 v44 a150 9 0 0 1 -300 0 z"/>
    <path d="M560 248 a150 9 0 0 0 300 0" fill="none" stroke="var(--line-strong,#cdc6b3)" stroke-width="1.5"/>
    <text class="kf-t" x="710" y="288">Nearest hubs by travel cost</text>
  </g>
  <!-- Phase 1 vertical edges -->
  <g class="kf-edge" marker-end="url(#kf-arrow)">
    <path d="M210 108 V130"/>
    <path d="M210 178 V200"/>
    <path d="M210 248 V270"/>
  </g>
  <!-- handoff edge phase 1 -> phase 2 -->
  <path class="kf-edge" marker-end="url(#kf-arrow)" d="M360 295 C 450 295, 460 85, 558 85"/>
  <text class="kf-handoff" x="460" y="200" text-anchor="middle">candidate set</text>
  <!-- Phase 2 vertical edges -->
  <g class="kf-edge" marker-end="url(#kf-arrow)">
    <path d="M710 108 V146"/>
    <path d="M710 194 V232"/>
  </g>
</svg>

The safety of over-fetching follows from the metric inequality. For any candidate node, its network distance $d_{net}$ is bounded below by its great-circle distance $d_{geo}$:

$$d_{geo}(\text{origin}, n) \le d_{net}(\text{origin}, n)$$

So if you need the `k` cheapest-to-reach hubs, fetching the `m` straight-line nearest with $m > k$ (typically $m = 3k$ to $5k$) guarantees the true answer is contained in the candidate set, *provided* the straight-line radius is wide enough to admit the detour factor of your network. A grid city has a detour factor near 1.3; mountain or coastal road networks can exceed 2.5, and the over-fetch must widen to match.

## Schema & Data Model

The candidate phase can only seek an index that exists, and the re-rank phase can only project relationships that carry a weight. Store coordinates as a native `point` on each node, keep a stable `node_id` for anchoring, and store the traversal cost as a dedicated relationship property distinct from raw length.

```cypher
// Native point index — backs the bounding-box range predicate and point.distance()
CREATE POINT INDEX network_node_location IF NOT EXISTS
FOR (n:NetworkNode) ON (n.location);

// Lookup index on the stable id used to anchor route queries
CREATE INDEX network_node_id IF NOT EXISTS
FOR (n:NetworkNode) ON (n.node_id);
```

```cypher
// Representative shape of the indexed routing graph
// (:NetworkNode {node_id, location: point({srid:4326, latitude, longitude})})
//   -[:CONNECTED_TO {length_m, travel_s, weight}]->
// (:NetworkNode)
```

Keep `weight` (the value the shortest-path algorithm minimizes) separate from `length_m`. If the business question is "nearest by drive time", `weight` should be `travel_s`; conflating it with raw distance produces hubs that are short in kilometers but slow in minutes — the exact failure KNN routing exists to prevent. Hub or facility nodes can carry a second label (e.g. `:Hub`) so the candidate query filters to assignable targets only, rather than every intersection in the graph.

## Step-by-Step Implementation

The flow is: compute the bounding box client-side, seek an over-fetched candidate set through the index, project just those candidates and the origin's neighborhood into GDS, run a weighted shortest path, and re-rank. We build it as runnable async code.

### 1. Compute the bounding box client-side

Deriving the box in Python keeps the four corners as stable parameters the planner can seek. Never compute the box inside Cypher — a per-row trig expression cannot be pushed down to the index.

```python
import asyncio
import math
from typing import Dict, List, Tuple
from neo4j import AsyncGraphDatabase

EARTH_RADIUS_M = 6_371_000.0  # mean spherical radius


def compute_bounding_box(lat: float, lon: float, radius_m: float) -> Dict[str, float]:
    """WGS84 degree-space bounding box for spatial-index pre-filtering.

    Spherical approximation; the longitude band widens with latitude via cos(phi).
    """
    d_lat = math.degrees(radius_m / EARTH_RADIUS_M)
    d_lon = math.degrees(radius_m / (EARTH_RADIUS_M * math.cos(math.radians(lat))))
    return {
        "min_lat": lat - d_lat, "max_lat": lat + d_lat,
        "min_lon": lon - d_lon, "max_lon": lon + d_lon,
    }
```

### 2. Seek an over-fetched candidate set through the point index

Fetch more candidates than you ultimately need (`fetch_k = k * overfetch`) so the straight-line filter cannot drop a hub that is geometrically farther but cheaper to reach. The bounding-box comparison seeks the index; `point.distance()` clips the corners to a circle and orders the survivors nearest-first.

```python
async def fetch_candidates(
    driver,
    origin: Tuple[float, float],   # (lat, lon)
    fetch_k: int,
    max_radius_m: float,
) -> List[Dict[str, float]]:
    lat, lon = origin
    bbox = compute_bounding_box(lat, lon, max_radius_m)
    query = """
    WITH point({srid: 4326, latitude: $lat, longitude: $lon}) AS target
    MATCH (n:Hub)
    WHERE n.location.latitude  >= $min_lat AND n.location.latitude  <= $max_lat
      AND n.location.longitude >= $min_lon AND n.location.longitude <= $max_lon
    WITH n, point.distance(n.location, target) AS geo_m
    WHERE geo_m <= $radius
    RETURN n.node_id AS node_id, geo_m
    ORDER BY geo_m ASC
    LIMIT $fetch_k
    """
    async with driver.session(database="neo4j") as session:
        result = await session.run(
            query, lat=lat, lon=lon, radius=max_radius_m,
            fetch_k=fetch_k, **bbox,
        )
        return [record.data() async for record in result]
```

### 3. Re-rank candidates by true network cost with GDS

Project a named graph (or use a transient projection) and run Dijkstra from the origin's nearest network node to each candidate, then sort by `totalCost`. Project only the labels and relationship type you need so the in-memory graph stays small. The `gds.graph.project` Cypher aggregation is the current API; the legacy `gds.graph.project.cypher` procedure is deprecated.

```python
async def rank_by_network_cost(
    driver,
    source_node_id: int,
    candidate_ids: List[int],
    k: int,
) -> List[Dict[str, float]]:
    query = """
    // Source node and the candidate targets resolved by stable id
    MATCH (src:NetworkNode {node_id: $source_node_id})
    MATCH (dst:NetworkNode) WHERE dst.node_id IN $candidate_ids
    WITH src, collect(dst) AS targets
    UNWIND targets AS dst
    CALL gds.shortestPath.dijkstra.stream('routing_graph', {
        sourceNode: src,
        targetNode: dst,
        relationshipWeightProperty: 'weight'
    })
    YIELD targetNode, totalCost
    RETURN gds.util.asNode(targetNode).node_id AS node_id,
           totalCost AS travel_cost
    ORDER BY travel_cost ASC
    LIMIT $k
    """
    async with driver.session(database="neo4j") as session:
        result = await session.run(
            query, source_node_id=source_node_id,
            candidate_ids=candidate_ids, k=k,
        )
        return [record.data() async for record in result]
```

### 4. Wire the two phases into a pooled async service

The service caps `max_connection_pool_size` to request-handler concurrency and sets an acquisition timeout so a query that accidentally falls back to a scan fails fast instead of starving the pool. The projection is created once and reused across requests; only re-project when the graph topology changes.

```python
class KNNRoutingService:
    def __init__(self, uri: str, auth: Tuple[str, str], pool_size: int = 40) -> None:
        self.driver = AsyncGraphDatabase.driver(
            uri, auth=auth,
            max_connection_pool_size=pool_size,
            connection_acquisition_timeout=5.0,
            max_transaction_retry_time=10.0,
        )

    async def ensure_projection(self) -> None:
        async with self.driver.session(database="neo4j") as session:
            await session.run("""
            CALL gds.graph.exists('routing_graph') YIELD exists
            WITH exists WHERE NOT exists
            MATCH (s:NetworkNode)-[r:CONNECTED_TO]->(t:NetworkNode)
            WITH gds.graph.project('routing_graph', s, t,
                 {relationshipProperties: r {.weight}}) AS g
            RETURN g.graphName AS name
            """)

    async def nearest_hubs(
        self, origin: Tuple[float, float], source_node_id: int,
        k: int = 3, overfetch: int = 4, max_radius_m: float = 15_000,
    ) -> List[Dict[str, float]]:
        await self.ensure_projection()
        candidates = await fetch_candidates(
            self.driver, origin, fetch_k=k * overfetch, max_radius_m=max_radius_m,
        )
        if not candidates:
            return []  # caller widens max_radius_m and retries
        ids = [c["node_id"] for c in candidates]
        return await rank_by_network_cost(self.driver, source_node_id, ids, k)

    async def close(self) -> None:
        await self.driver.close()


async def main():
    svc = KNNRoutingService(
        "neo4j+s://your-cluster.databases.neo4j.io",
        auth=("neo4j", "secure-password"),
    )
    try:
        hubs = await svc.nearest_hubs(origin=(40.7128, -74.0060), source_node_id=1001, k=3)
        for h in hubs:
            print(f"hub {h['node_id']}: {h['travel_cost']:.0f} cost units")
    finally:
        await svc.close()


if __name__ == "__main__":
    asyncio.run(main())
```

## Query Patterns & Variants

The same "nearest by network cost" intent takes several shapes. Pick the one whose ranking metric and target shape match how dispatch consumes the result.

**Variant A — pure spatial candidates (phase one only).** When straight-line proximity is genuinely good enough (dense uniform grid, no barriers) skip the projection entirely and return the box-clipped nearest-K. This is the cheapest query and the fallback when GDS is unavailable.

```cypher
WITH point({srid: 4326, latitude: $lat, longitude: $lon}) AS target
MATCH (n:Hub)
WHERE n.location.latitude  >= $min_lat AND n.location.latitude  <= $max_lat
  AND n.location.longitude >= $min_lon AND n.location.longitude <= $max_lon
RETURN n.node_id, point.distance(n.location, target) AS geo_m
ORDER BY geo_m ASC LIMIT $k
// $min_*/$max_* always come from compute_bounding_box(); never derive the box in Cypher.
```

**Variant B — A\* re-rank with a geographic heuristic.** On large projections A\* prunes far more of the search space than Dijkstra by using straight-line distance to the target as an admissible heuristic. Supply the `latitudeProperty`/`longitudeProperty` so GDS can compute the heuristic; the candidate must carry a `location` in the projection.

```cypher
MATCH (src:NetworkNode {node_id: $source_node_id})
MATCH (dst:NetworkNode {node_id: $target_node_id})
CALL gds.shortestPath.astar.stream('routing_graph', {
    sourceNode: src,
    targetNode: dst,
    latitudeProperty: 'lat',
    longitudeProperty: 'lon',
    relationshipWeightProperty: 'weight'
})
YIELD totalCost
RETURN totalCost AS travel_cost
// A* wins when targets are far and the heuristic is tight; for tiny projections Dijkstra is simpler.
```

**Variant C — multi-source assignment (which hub serves each request).** Dispatch often inverts the question: given many open requests, assign each to its cheapest hub. Run a single-source shortest path *from each hub* over the candidate set and keep the minimum per request, which amortizes traversal across the batch instead of re-expanding per request.

```cypher
UNWIND $hub_ids AS hub_id
MATCH (h:NetworkNode {node_id: hub_id})
CALL gds.shortestPath.dijkstra.stream('routing_graph', {
    sourceNode: h,
    relationshipWeightProperty: 'weight'
})
YIELD targetNode, totalCost
WITH gds.util.asNode(targetNode).node_id AS request_node, hub_id, totalCost
ORDER BY totalCost ASC
RETURN request_node, head(collect(hub_id)) AS assigned_hub, min(totalCost) AS cost
// Cap the candidate set; an all-pairs expansion over the full graph will exhaust heap.
```

When the candidates must be correlated against external datasets — live capacity feeds, demand telemetry — the join itself becomes the bottleneck; [spatial join techniques](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/spatial-join-techniques/) cover the index-probe joins that avoid a cross-product blowup. For a full worked dispatch scenario, see [Implementing KNN Search for Nearby Logistics Hubs](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/k-nearest-neighbor-routing/implementing-knn-search-for-nearby-logistics-hubs/).

## Performance Tuning

Profiling is the whole game, and KNN routing has two cost centers to watch independently: the candidate seek and the projection traversal.

- **Confirm the candidate phase seeks, not scans.** Run `PROFILE` on `fetch_candidates`; a healthy plan shows a `PointIndexSeekByRange` at the base. A `NodeByLabelScan` feeding a `Filter` on `point.distance` means push-down failed — the box predicate is missing, malformed, or sitting after an expansion. This profiling loop is the same one detailed in [cypher performance tuning](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/), and the cost-model reasoning behind plan selection belongs to [graph query planner optimization](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/).
- **Tune the over-fetch to your detour factor, not a guess.** Too low and you drop a reachable-but-distant hub; too high and the projection wastes heap. Measure the ratio of network to straight-line distance on a sample of real routes and set `overfetch` just above it.
- **Reuse the projection.** Re-projecting the graph per request is the most common latency killer. Project once, keep the named graph resident, and re-project only on topology change. For volatile graphs, project a regional sub-area sized to the candidate radius rather than the whole network.
- **Bound the candidate radius and `k`.** An unbounded radius or a large `k` forces GDS to expand paths to far targets, allocating heap for relationships and triggering stop-the-world GC. Use a sliding window: fetch `k * overfetch`, rank, and widen the radius only if the best path cost exceeds a service threshold.
- **Prefer A\* for far, sparse targets.** When candidates sit far from the origin in a large projection, the A\* heuristic prunes dramatically more than Dijkstra. For tight clusters the heuristic overhead is not worth it — benchmark both against your latency SLO.
- **Parameterize everything.** Literal coordinates baked into the query string force recompilation and thrash the plan cache. Pass `$min_lat`, `$radius`, `$k` as parameters with stable numeric types.

<svg viewBox="0 0 920 320" role="img" aria-labelledby="knn-lat-title knn-lat-desc" xmlns="http://www.w3.org/2000/svg">
  <title id="knn-lat-title">Per-request latency breakdown showing the cost of re-projecting per request</title>
  <desc id="knn-lat-desc">Three horizontal latency bars for one KNN routing request, drawn to scale in milliseconds. The index candidate seek alone is about 8 milliseconds. Re-projecting the GDS graph on every request adds an enormous projection segment of about 240 milliseconds on top of the seek and Dijkstra, totalling roughly 260 milliseconds. Reusing a warm resident projection drops the request to just the seek plus Dijkstra, about 20 milliseconds. Reusing the projection is the dominant latency win.</desc>
  <style>
    .kl-seek{fill:var(--accent,#0e7c86);}
    .kl-proj{fill:var(--viz-poor,#a8320f);}
    .kl-dij{fill:var(--viz-good,#0a656d);}
    .kl-lab{fill:var(--ink,#1b2330);font:600 13px var(--font-sans,system-ui,sans-serif);}
    .kl-val{fill:var(--ink,#1b2330);font:700 12.5px var(--font-mono,ui-monospace,monospace);}
    .kl-cap{fill:var(--ink-mute,#6f7a8c);font:11.5px var(--font-sans,system-ui,sans-serif);}
    .kl-grid{stroke:var(--line,#e5e0d2);stroke-width:1;}
    .kl-axis{fill:var(--ink-mute,#6f7a8c);font:10.5px var(--font-mono,ui-monospace,monospace);}
  </style>
  <!-- gridlines (0 / 100 / 200 ms), scale: 2.143 px per ms from x=250 -->
  <rect class="viz-backdrop" x="0" y="0" width="920" height="320" fill="var(--viz-bg,#ffffff)"/>
  <g>
    <line class="kl-grid" x1="250" y1="58" x2="250" y2="248"/>
    <line class="kl-grid" x1="464" y1="58" x2="464" y2="248"/>
    <line class="kl-grid" x1="678" y1="58" x2="678" y2="248"/>
    <text class="kl-axis" x="250" y="266" text-anchor="middle">0</text>
    <text class="kl-axis" x="464" y="266" text-anchor="middle">100</text>
    <text class="kl-axis" x="678" y="266" text-anchor="middle">200</text>
    <text class="kl-axis" x="678" y="282" text-anchor="middle">milliseconds per request</text>
  </g>
  <!-- Bar 1: index candidate seek (8 ms -> 17px) -->
  <text class="kl-lab" x="234" y="86" text-anchor="end">Index candidate seek</text>
  <rect class="kl-seek" x="250" y="72" width="17" height="26" rx="3"/>
  <text class="kl-val" x="277" y="91">~8 ms</text>
  <!-- Bar 2: re-project every request (8 seek + 240 proj + 12 dij) -->
  <text class="kl-lab" x="234" y="146" text-anchor="end">Re-project every request</text>
  <rect class="kl-seek" x="250" y="132" width="17" height="26" rx="3"/>
  <rect class="kl-proj" x="267" y="132" width="514" height="26"/>
  <rect class="kl-dij"  x="781" y="132" width="26" height="26" rx="3"/>
  <text class="kl-val" x="817" y="151">~260 ms</text>
  <!-- Bar 3: reuse warm projection (8 seek + 12 dij) -->
  <text class="kl-lab" x="234" y="206" text-anchor="end">Reuse warm projection</text>
  <rect class="kl-seek" x="250" y="192" width="17" height="26" rx="3"/>
  <rect class="kl-dij"  x="267" y="192" width="26" height="26" rx="3"/>
  <text class="kl-val" x="303" y="211">~20 ms</text>
  <!-- legend -->
  <g transform="translate(250 291)">
    <rect class="kl-seek" x="0" y="0" width="13" height="13" rx="2"/><text class="kl-cap" x="19" y="11">index seek</text>
    <rect class="kl-proj" x="135" y="0" width="13" height="13" rx="2"/><text class="kl-cap" x="154" y="11">per-request projection</text>
    <rect class="kl-dij" x="345" y="0" width="13" height="13" rx="2"/><text class="kl-cap" x="364" y="11">Dijkstra</text>
  </g>
  <!-- callout -->
  <text class="kl-cap" x="908" y="40" text-anchor="end" font-style="italic">projection reuse: ~260 ms &#8594; ~20 ms</text>
</svg>

## Edge Cases & Gotchas

- **Empty candidate set at the edge of coverage.** A radius tighter than the nearest hub returns nothing, and a naive caller reports "no hubs". Detect the empty result, widen `max_radius_m` (e.g. double it), and retry up to a cap before declaring genuine non-coverage.
- **Disconnected candidate (in the box, unreachable on the graph).** A hub can sit inside the radius yet have no directed path from the origin — a topology gap, a one-way trap, or an unmerged import. `gds.shortestPath.dijkstra` simply omits unreachable targets, so a candidate silently vanishes from the ranking. Assert that the returned count meets your minimum and fall back to the next candidates if not.
- **Straight-line under-fetch drops the true winner.** If `overfetch` is too small for the network's detour factor, the cheapest-to-reach hub never enters the candidate set and the answer is wrong but plausible-looking. This is the single most dangerous KNN bug because it produces no error — only a worse assignment. Validate `overfetch` against measured detour ratios.
- **Mixed CRS coordinates.** A geographic `point({latitude, longitude})` (SRID 4326) and a Cartesian `point({x, y})` (SRID 7203) are not comparable; `point.distance()` across SRIDs returns `null`, and a `null` predicate silently drops the row. Normalize CRS at ingestion and assert the SRID before querying.
- **Stale projection after a graph write.** GDS projections are in-memory snapshots. New or rewired edges added after projection are invisible to the shortest-path pass, so routes follow the old topology. Re-project (or use a write-through projection strategy) whenever the underlying graph changes.
- **`weight` conflated with distance.** Minimizing `length_m` when the question is drive time returns short-but-slow routes. Keep the cost property that matches the business metric and pass it explicitly as `relationshipWeightProperty`.
- **Driver timeout masquerading as pool exhaustion.** A candidate query that falls back to a scan, or a per-request re-projection, blows past `connection_acquisition_timeout` under load and drains the pool. A timeout storm at peak is usually a missing-seek or re-projection symptom, not a pool-size problem.

## Verification & Testing

KNN routing is only safe if the ranked result matches a brute-force network-cost ranking over the same candidates — the bounding box and over-fetch are an optimization, not a change in answer. Assert both correctness (the right hubs, in the right cost order) and that no reachable winner was dropped by an under-sized over-fetch.

```python
import pytest
from neo4j import AsyncGraphDatabase

SEED = """
CREATE (q:NetworkNode:Hub {node_id: 1, location: point({srid:4326, latitude: 40.7128, longitude: -74.0060})})
CREATE (a:NetworkNode:Hub {node_id: 2, location: point({srid:4326, latitude: 40.7150, longitude: -74.0090})})
CREATE (b:NetworkNode:Hub {node_id: 3, location: point({srid:4326, latitude: 40.7135, longitude: -74.0065})})
CREATE (q)-[:CONNECTED_TO {weight: 600.0}]->(a)   // close by road
CREATE (q)-[:CONNECTED_TO {weight: 90.0}]->(b)    // farther in km, cheaper to reach
"""


@pytest.mark.asyncio
async def test_knn_ranks_by_network_cost_not_geometry():
    driver = AsyncGraphDatabase.driver("bolt://localhost:7687", auth=("neo4j", "test"))
    async with driver.session(database="neo4j") as s:
        await s.run("MATCH (n) DETACH DELETE n")
        await s.run(SEED)
        await s.run(
            "CREATE POINT INDEX network_node_location IF NOT EXISTS "
            "FOR (n:NetworkNode) ON (n.location)"
        )

        # Network-cost truth: shortest path from origin to every reachable hub.
        truth = await (await s.run(
            """
            MATCH (q:NetworkNode {node_id: 1})
            MATCH (q)-[r:CONNECTED_TO]->(h:Hub)
            RETURN h.node_id AS id ORDER BY r.weight ASC
            """
        )).values()

    # Hub 3 is geometrically nearer to hub 2's region but, by road, hub 3 is the
    # cheapest to reach — the ranking must follow cost, not straight-line distance.
    assert truth[0] == [3], "nearest hub must be ranked by network cost, not geometry"
    await driver.close()
```

Pair this with a plan-shape check on the candidate query: run `EXPLAIN`, read the plan from `result.consume()`, and assert it contains a point index seek rather than a label scan. Run both in CI so a refactor that drops the box predicate or shrinks the over-fetch is caught before it ships.

## FAQ

<details>
<summary>Why not just use point.distance() and skip the graph traversal?</summary>

Because straight-line distance ignores the network. A hub across an unbridged river or behind a one-way grid can be the crow-flies nearest yet a long detour by road. `point.distance()` is correct only as a *filter* — it is a lower bound on travel cost, so it safely bounds the candidate set, but the final ranking must come from a shortest-path pass over weighted edges. Skip the traversal only when the network has no meaningful barriers.
</details>

<details>
<summary>How many candidates should I over-fetch before the network re-rank?</summary>

Enough to cover your network's detour factor. Measure the ratio of network distance to straight-line distance on a sample of real routes: grid cities sit near 1.3, coastal or mountain networks can exceed 2.5. Set the straight-line radius and `fetch_k = k * overfetch` just above that ratio. Too low silently drops the true winner; too high wastes projection heap. Typical starting points are `overfetch` of 3–5.
</details>

<details>
<summary>Should I use Dijkstra or A* for the re-rank?</summary>

Dijkstra for small, tightly clustered candidate sets — it is simpler and the overhead of an A* heuristic is not repaid. A* for large projections with far targets, where the straight-line-to-target heuristic prunes a large fraction of the search space. A* needs `latitudeProperty`/`longitudeProperty` in the projection so it can compute an admissible heuristic. Benchmark both against your latency SLO on representative data.
</details>

<details>
<summary>Why does a hub inside the radius sometimes not appear in the result?</summary>

It is unreachable on the directed graph — a topology gap, a one-way trap, or an unmerged import means there is no path from the origin. `gds.shortestPath.dijkstra` simply omits unreachable targets, so the candidate vanishes silently. Assert the returned count meets your minimum and fall back to the next candidates; fix the underlying gap during ingestion so reachable hubs are never dropped.
</details>

<details>
<summary>Do I need to re-project the GDS graph for every request?</summary>

No, and doing so is the most common latency killer. Project the named graph once, keep it resident, and reuse it across requests; re-project only when the topology changes. For volatile graphs, project a regional sub-area sized to the candidate radius rather than the whole network. Remember that a projection is an in-memory snapshot — writes after projection are invisible until you refresh it.
</details>

## Related

- [Distance Filter Query Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/) — the bounded candidate-retrieval technique that feeds phase one.
- [Implementing KNN Search for Nearby Logistics Hubs](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/k-nearest-neighbor-routing/implementing-knn-search-for-nearby-logistics-hubs/) — a full worked dispatch scenario for this pattern.
- [GDS kNN vs Bounded-Radius kNN in Neo4j](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/k-nearest-neighbor-routing/gds-knn-vs-bounded-radius-knn-in-neo4j/) — when to precompute a similarity graph versus seek per query.
- [Spatial Join Techniques](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/spatial-join-techniques/) — index-probe joins for correlating candidates with external capacity and demand feeds.
- [Cypher Performance Tuning](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/) — the PROFILE-driven loop for keeping the candidate phase index-backed.
- [Spatial Indexing Strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) — choosing the index that makes the candidate bounding box seekable.

This guide is part of [Cypher Spatial Queries & Pathfinding Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/).

For authoritative reference, consult the [Neo4j Graph Data Science pathfinding documentation](https://neo4j.com/docs/graph-data-science/current/algorithms/pathfinding/), the [Neo4j Cypher spatial functions documentation](https://neo4j.com/docs/cypher-manual/current/functions/spatial/), and the [Python asyncio documentation](https://docs.python.org/3/library/asyncio.html).

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "Why not just use point.distance() and skip the graph traversal?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Because straight-line distance ignores the network. A hub across an unbridged river or behind a one-way grid can be the crow-flies nearest yet a long detour by road. point.distance() is correct only as a filter; it is a lower bound on travel cost, so it safely bounds the candidate set, but the final ranking must come from a shortest-path pass over weighted edges. Skip the traversal only when the network has no meaningful barriers."
      }
    },
    {
      "@type": "Question",
      "name": "How many candidates should I over-fetch before the network re-rank?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Enough to cover your network's detour factor. Measure the ratio of network distance to straight-line distance on a sample of real routes: grid cities sit near 1.3, coastal or mountain networks can exceed 2.5. Set the straight-line radius and fetch_k equal to k times an over-fetch factor just above that ratio. Too low silently drops the true winner; too high wastes projection heap. Typical starting points are an over-fetch factor of 3 to 5."
      }
    },
    {
      "@type": "Question",
      "name": "Should I use Dijkstra or A* for the re-rank?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Dijkstra for small, tightly clustered candidate sets, since it is simpler and an A* heuristic is not repaid. A* for large projections with far targets, where the straight-line-to-target heuristic prunes a large fraction of the search space. A* needs latitude and longitude properties in the projection so it can compute an admissible heuristic. Benchmark both against your latency SLO on representative data."
      }
    },
    {
      "@type": "Question",
      "name": "Why does a hub inside the radius sometimes not appear in the result?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "It is unreachable on the directed graph, because a topology gap, a one-way trap, or an unmerged import means there is no path from the origin. gds.shortestPath.dijkstra simply omits unreachable targets, so the candidate vanishes silently. Assert the returned count meets your minimum and fall back to the next candidates; fix the underlying gap during ingestion so reachable hubs are never dropped."
      }
    },
    {
      "@type": "Question",
      "name": "Do I need to re-project the GDS graph for every request?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "No, and doing so is the most common latency killer. Project the named graph once, keep it resident, and reuse it across requests; re-project only when the topology changes. For volatile graphs, project a regional sub-area sized to the candidate radius rather than the whole network. A projection is an in-memory snapshot, so writes after projection are invisible until you refresh it."
      }
    }
  ]
}
</script>
