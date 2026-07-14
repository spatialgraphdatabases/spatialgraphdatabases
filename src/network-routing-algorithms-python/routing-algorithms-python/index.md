---
pageTitle: Routing Algorithms in Python
title: "Routing Algorithms in Python: Dijkstra, A*, and Contraction Hierarchies"
description: "Choosing and implementing shortest-path algorithms on a spatial road graph in Python: Dijkstra, A*, and contraction hierarchies over async Neo4j"
slug: routing-algorithms-python
type: guide
breadcrumb: Routing Algorithms
datePublished: 2026-07-14
dateModified: 2026-07-14
---
# Routing Algorithms in Python: Dijkstra, A*, and Contraction Hierarchies

Picking the wrong shortest-path algorithm is the quietest way to blow a latency budget. A Dijkstra pass that expands uniformly across a metropolitan graph touches hundreds of thousands of nodes to answer a query that A\* would settle in a few thousand; a contraction-hierarchy build that runs for twenty minutes is wasted preprocessing if your topology changes every hour. The three algorithms in this guide are not interchangeable — they trade optimality guarantees, preprocessing cost, and per-query node expansion against each other, and the correct choice is a function of graph size, query volume, and how often the edges move. This is the decision framework, grounded in runnable code: a hand-written priority-queue Dijkstra and A\* that pull edges from an async Neo4j session, the Cypher and GDS equivalents, and the profiling discipline to know which one your workload actually needs. It sits under [Network Routing Algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/).

<svg viewBox="0 0 780 392" role="img" aria-labelledby="ra-front-title ra-front-desc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="ra-front-title">Dijkstra's uniform circular frontier versus A star's goal-biased elliptical frontier</title>
  <desc id="ra-front-desc">Two panels sharing the same source and destination. On the left, Dijkstra expands a broad circular frontier centred on the source until it reaches the destination, touching many nodes in every direction. On the right, an admissible heuristic biases A star's frontier into a narrow ellipse stretched along the source-to-destination axis, so far fewer nodes are ever expanded to find the same optimal path.</desc>
  <defs>
    <marker id="ra-front-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <line x1="390" y1="52" x2="390" y2="360" stroke="currentColor" stroke-width="1" stroke-dasharray="3 6" opacity="0.3"/>
  <!-- LEFT: Dijkstra -->
  <text x="190" y="28" text-anchor="middle" font-size="14.5" font-weight="700" fill="currentColor">Dijkstra — uniform frontier</text>
  <text x="190" y="46" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7">expands by cost in every direction</text>
  <circle cx="150" cy="210" r="140" fill="var(--accent-coral,#ff6b6b)" opacity="0.08"/>
  <circle cx="150" cy="210" r="140" fill="none" stroke="var(--accent-coral,#ff6b6b)" stroke-width="1.5" stroke-dasharray="5 5"/>
  <circle cx="150" cy="210" r="96" fill="none" stroke="var(--accent-coral,#ff6b6b)" stroke-width="1" stroke-dasharray="3 5" opacity="0.6"/>
  <circle cx="150" cy="210" r="52" fill="none" stroke="var(--accent-coral,#ff6b6b)" stroke-width="1" stroke-dasharray="3 5" opacity="0.5"/>
  <g fill="var(--accent-coral,#ff6b6b)" opacity="0.75">
    <circle cx="150" cy="118" r="2.6"/> <circle cx="90" cy="150" r="2.6"/> <circle cx="220" cy="150" r="2.6"/> <circle cx="60" cy="210" r="2.6"/> <circle cx="120" cy="270" r="2.6"/> <circle cx="200" cy="270" r="2.6"/> <circle cx="150" cy="300" r="2.6"/> <circle cx="240" cy="210" r="2.6"/> <circle cx="110" cy="160" r="2.6"/> <circle cx="190" cy="120" r="2.6"/> <circle cx="80" cy="260" r="2.6"/> <circle cx="230" cy="260" r="2.6"/>
  </g>
  <line x1="150" y1="210" x2="300" y2="210" stroke="currentColor" stroke-width="2" marker-end="url(#ra-front-arrow)"/>
  <circle cx="150" cy="210" r="9" fill="var(--accent-2,#a8380b)"/>
  <text x="150" y="213" text-anchor="middle" font-size="10" font-weight="700" fill="#ffffff">S</text>
  <circle cx="312" cy="210" r="9" fill="var(--accent-3,#5b21b6)"/>
  <text x="312" y="213" text-anchor="middle" font-size="10" font-weight="700" fill="#ffffff">D</text>
  <text x="190" y="352" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.72">nodes expanded ≈ π·r² (whole disk)</text>
  <!-- RIGHT: A* -->
  <g transform="translate(400,0)">
    <text x="190" y="28" text-anchor="middle" font-size="14.5" font-weight="700" fill="currentColor">A* — goal-biased frontier</text>
    <text x="190" y="46" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7">heuristic pulls expansion toward D</text>
    <ellipse cx="231" cy="210" rx="105" ry="42" fill="var(--accent,#0a656d)" opacity="0.1"/>
    <ellipse cx="231" cy="210" rx="105" ry="42" fill="none" stroke="var(--accent,#0a656d)" stroke-width="1.6"/>
    <ellipse cx="205" cy="210" rx="66" ry="26" fill="none" stroke="var(--accent,#0a656d)" stroke-width="1" stroke-dasharray="3 5" opacity="0.6"/>
    <g fill="var(--accent,#0a656d)" opacity="0.85">
      <circle cx="180" cy="200" r="2.6"/> <circle cx="210" cy="222" r="2.6"/> <circle cx="240" cy="198" r="2.6"/> <circle cx="270" cy="216" r="2.6"/> <circle cx="195" cy="216" r="2.6"/> <circle cx="255" cy="204" r="2.6"/>
    </g>
    <line x1="150" y1="210" x2="300" y2="210" stroke="currentColor" stroke-width="2" marker-end="url(#ra-front-arrow)"/>
    <circle cx="150" cy="210" r="9" fill="var(--accent-2,#a8380b)"/>
    <text x="150" y="213" text-anchor="middle" font-size="10" font-weight="700" fill="#ffffff">S</text>
    <circle cx="312" cy="210" r="9" fill="var(--accent-3,#5b21b6)"/>
    <text x="312" y="213" text-anchor="middle" font-size="10" font-weight="700" fill="#ffffff">D</text>
    <text x="190" y="352" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.72">nodes expanded ≈ thin corridor S→D</text>
  </g>
</svg>

## Prerequisites

The examples run against a Neo4j 5.x instance with native `point` geometry and, for the library-backed path, the Graph Data Science plugin installed. The hand-written traversals need only the core async driver; the GDS variant needs the plugin and the `graphdatascience` client (or plain Cypher `CALL gds.*`).

| Requirement | Minimum version | Notes |
| --- | --- | --- |
| Python | 3.10+ | `match` statements and `X | Y` unions used below |
| Neo4j | 5.13+ | Native `point`, `CREATE POINT INDEX`, `shortestPath` |
| neo4j (driver) | 5.x | Async driver (`AsyncGraphDatabase`) |
| GDS plugin | 2.6+ | Only for the `gds.shortestPath.dijkstra` variant |
| pytest / pytest-asyncio | 0.23+ | For the correctness harness |

```bash
pip install "neo4j>=5.18" "pytest>=8.0" "pytest-asyncio>=0.23"
```

The graph these algorithms traverse must already carry coordinates as native `point` values and keep a routing cost distinct from raw length — the modelling groundwork lives in [node and edge spatial mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/), and the index that makes the endpoint lookups seek rather than scan comes from your [spatial indexing strategy](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/).

## Core Concept & Mechanism

Every shortest-path algorithm in this family is a variation on the same loop: maintain a frontier of reachable nodes ordered by some key, pop the most promising one, relax its outgoing edges, and repeat until the destination is settled. What separates the algorithms is the ordering key and whether the graph is preprocessed first.

**Dijkstra** orders the frontier by $g(n)$, the confirmed lowest cost from the source to node $n$. Because it always settles the cheapest unsettled node next, it never has to revisit a settled node, and the first time it pops the destination that cost is provably optimal. The price is directional blindness: with nothing but $g$ to go on, the frontier grows as a roughly circular wavefront, so a query between two points 40 km apart on a continental graph will happily explore nodes 40 km in the *wrong* direction before the wave reaches the goal.

**A\*** orders the frontier by $f(n) = g(n) + h(n)$, where $h(n)$ is a heuristic estimate of the remaining cost from $n$ to the destination. On a geographic graph the straight-line great-circle distance to the goal is a free, admissible heuristic — it never overestimates, because no road is shorter than the crow-flies path. Admissibility is exactly the property that preserves Dijkstra's optimality guarantee while collapsing the frontier from a disk into a narrow ellipse aimed at the goal. The full derivation, and the scaling factor you need when edge weights are travel time rather than distance, is the subject of [Implementing A* with a Haversine Heuristic in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/routing-algorithms-python/implementing-astar-with-a-haversine-heuristic-in-python/).

**Contraction hierarchies (CH)** attack the problem from the other side. Instead of a smarter per-query search, they precompute a node ordering by importance and insert *shortcut* edges that preserve shortest-path distances while letting a query skip whole chains of low-importance nodes. A bidirectional search over the contracted graph then answers point-to-point queries on a country-scale network in microseconds — but the preprocessing must be rebuilt when edge weights change, so CH fits static or slowly-changing topologies, not graphs under constant live edits.

$$\underbrace{g(n)}_{\text{cost so far}} \;+\; \underbrace{h(n)}_{\substack{0 \text{ for Dijkstra} \\ \text{admissible estimate for A*}}} \;=\; f(n) \quad\text{(the frontier ordering key)}$$

Setting $h(n) = 0$ turns A\* back into Dijkstra — they are the same algorithm with a different priority key, which is why a single priority-queue implementation can serve both.

## Schema & Data Model

The traversal reads two things per edge: the neighbour it points to and the cost of crossing it. Store the cost as a precomputed scalar on the relationship so the search never recomputes geometry mid-loop, and keep it distinct from raw length so a time-based route and a distance-based route can share one graph.

```cypher
CREATE CONSTRAINT junction_id_unique IF NOT EXISTS
FOR (j:Junction) REQUIRE j.id IS UNIQUE;

CREATE POINT INDEX junction_location IF NOT EXISTS
FOR (j:Junction) ON (j.location);
```

```cypher
// Representative shape of the routable graph
// (:Junction {id, location: point({srid:4326, latitude, longitude})})
//   -[:ROAD {cost_s, length_m}]->
// (:Junction)
```

Here `cost_s` is the traversal weight the algorithms minimise (travel time in seconds), and `length_m` is retained separately for the heuristic and for reporting. Directionality is load-bearing: a one-way street is a single `:ROAD` relationship, a two-way street is two. The hand-written search below reads only outgoing relationships, so encoding direction in the edges is what keeps illegal manoeuvres out of the result.

## Step-by-Step Implementation

We build one priority-queue search that runs as Dijkstra or A\* depending on the heuristic passed to it, streaming a node's neighbours from Neo4j on demand rather than loading the whole graph into memory. This is the shape you reach for when the graph is too large to materialise client-side but each query only touches a corridor of it.

### 1. Load a node's outgoing edges asynchronously

The traversal calls this once per settled node. It returns each neighbour with the edge cost and the neighbour's coordinates so an A\* heuristic can be computed without a second round trip.

```python
import asyncio
import heapq
import itertools
import math
from typing import Callable, Optional

from neo4j import AsyncGraphDatabase, AsyncSession

NEIGHBOUR_QUERY = """
MATCH (u:Junction {id: $node_id})-[r:ROAD]->(v:Junction)
RETURN v.id AS to_id,
       r.cost_s AS cost,
       v.location.latitude  AS lat,
       v.location.longitude AS lon
"""


async def expand(session: AsyncSession, node_id: str):
    """Yield (neighbour_id, edge_cost, lat, lon) for one node's out-edges."""
    result = await session.run(NEIGHBOUR_QUERY, node_id=node_id)
    return [
        (rec["to_id"], float(rec["cost"]), rec["lat"], rec["lon"])
        async for rec in result
    ]
```

### 2. Run the shared search loop

The heuristic is a plain callable. Pass `lambda *_: 0.0` and the loop is Dijkstra; pass a great-circle estimate and it is A\*. A monotonically increasing counter breaks ties on equal `f`, which keeps the heap from ever comparing node ids and makes the ordering deterministic.

```python
async def shortest_path(
    session: AsyncSession,
    source: str,
    target: str,
    target_lat: float,
    target_lon: float,
    heuristic: Callable[[float, float], float],
) -> Optional[tuple[float, list[str]]]:
    """Uniform Dijkstra/A* search. heuristic(lat, lon) estimates cost to target."""
    counter = itertools.count()
    frontier: list[tuple[float, int, str]] = [(0.0, next(counter), source)]
    best_g: dict[str, float] = {source: 0.0}
    came_from: dict[str, str] = {}
    settled: set[str] = set()

    while frontier:
        f_score, _, node = heapq.heappop(frontier)
        if node in settled:
            continue
        if node == target:
            return best_g[node], _reconstruct(came_from, source, target)
        settled.add(node)

        for to_id, edge_cost, lat, lon in await expand(session, node):
            tentative = best_g[node] + edge_cost
            if tentative < best_g.get(to_id, math.inf):
                best_g[to_id] = tentative
                came_from[to_id] = node
                f = tentative + heuristic(lat, lon)
                heapq.heappush(frontier, (f, next(counter), to_id))
    return None


def _reconstruct(came_from: dict[str, str], source: str, target: str) -> list[str]:
    path, node = [target], target
    while node != source:
        node = came_from[node]
        path.append(node)
    path.reverse()
    return path
```

### 3. Drive it as either algorithm

The great-circle heuristic here estimates cost in the same unit as `cost_s`. If edges are travel time, the raw distance must be divided by the fastest plausible speed so the estimate never exceeds real travel time — that admissibility scaling is the crux of the [dedicated A* page](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/routing-algorithms-python/implementing-astar-with-a-haversine-heuristic-in-python/).

```python
def great_circle_seconds(lat: float, lon: float, t_lat: float, t_lon: float,
                         max_mps: float = 33.3) -> float:
    """Admissible time estimate: crow-flies metres / top speed (m/s)."""
    R = 6_371_000.0
    p1, p2 = math.radians(lat), math.radians(t_lat)
    dphi = math.radians(t_lat - lat)
    dlam = math.radians(t_lon - lon)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlam / 2) ** 2
    metres = 2 * R * math.asin(math.sqrt(a))
    return metres / max_mps


async def main():
    driver = AsyncGraphDatabase.driver(
        "neo4j://localhost:7687", auth=("neo4j", "secure-password"),
        max_connection_pool_size=20, connection_acquisition_timeout=15.0,
    )
    src, dst = "J-chi-0417", "J-chi-9920"
    dst_lat, dst_lon = 41.8500, -87.6500  # Chicago Loop
    try:
        async with driver.session(database="neo4j") as session:
            dijkstra = await shortest_path(
                session, src, dst, dst_lat, dst_lon, heuristic=lambda *_: 0.0)
            astar = await shortest_path(
                session, src, dst, dst_lat, dst_lon,
                heuristic=lambda lat, lon: great_circle_seconds(lat, lon, dst_lat, dst_lon))
        print(f"Dijkstra cost: {dijkstra[0]:.1f}s over {len(dijkstra[1])} nodes")
        print(f"A* cost:       {astar[0]:.1f}s over {len(astar[1])} nodes")
        assert abs(dijkstra[0] - astar[0]) < 1e-6  # same optimum, fewer expansions
    finally:
        await driver.close()


if __name__ == "__main__":
    asyncio.run(main())
```

Both calls return the identical optimal cost; A\* simply pops fewer nodes off the frontier to get there. That equality is the assertion worth keeping in tests — if it ever fails, the heuristic has become inadmissible.

## Query Patterns & Variants

The hand-written loop is one of three ways to run a shortest path against Neo4j. Match the tool to the workload.

**Variant A — server-side `shortestPath` (unweighted).** When you only need hop count and every edge is equal, the built-in is unbeatable because it never leaves the database. It minimises *hops*, not cost, so it is wrong the moment `cost_s` varies.

```cypher
MATCH (s:Junction {id: $src}), (d:Junction {id: $dst})
MATCH p = shortestPath((s)-[:ROAD*..60]->(d))
RETURN [n IN nodes(p) | n.id] AS route, length(p) AS hops
// Hop-optimal only. Ignores cost_s entirely — never use it for weighted routing.
```

**Variant B — GDS weighted Dijkstra.** For weighted single-source or one-to-many routing at scale, project a subgraph once and let the library's parallel Dijkstra run in-database over it. This is the production default when the corridor is large or you need cost-to-many-targets; the full projection lifecycle is covered in [Weighted Dijkstra Routing with Neo4j GDS](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/routing-algorithms-python/weighted-dijkstra-routing-with-neo4j-gds/).

```cypher
CALL gds.shortestPath.dijkstra.stream('road_proj', {
  sourceNode: gds.util.asNode($src_internal_id),
  targetNode: gds.util.asNode($dst_internal_id),
  relationshipWeightProperty: 'cost_s'
})
YIELD totalCost, nodeIds
RETURN totalCost, [id IN nodeIds | gds.util.asNode(id).id] AS route
```

**Variant C — client-side A\* (the loop above).** When you want application-level control over the cost function — dynamic edge penalties, per-request road closures, custom tie-breaking — the hand-written search wins, because the logic lives in Python where you can change it per call without reprojecting a graph. It pays a network round trip per expanded node, so it is best on corridors bounded first by a [distance filter](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/) rather than on unbounded continental searches.

The head-to-head numbers behind "when does GDS beat hand-written Cypher" live in [Neo4j GDS vs Custom Cypher Routing](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/neo4j-gds-vs-cypher-routing/).

<svg viewBox="0 0 780 336" role="img" aria-labelledby="ra-dec-title ra-dec-desc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="ra-dec-title">Decision flow for choosing a routing algorithm</title>
  <desc id="ra-dec-desc">A decision tree. First question: are edge weights meaningful. If no, use server-side shortestPath for hop count. If yes, next question: is the topology static enough to preprocess. If yes and query volume is very high, build contraction hierarchies. Otherwise: do you have an admissible geographic heuristic. If yes, use A star for point-to-point queries; if no or you need one-to-many cost surfaces, use Dijkstra, running it in GDS at scale.</desc>
  <defs>
    <marker id="ra-dec-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <g font-size="12" fill="currentColor">
    <!-- Q1 -->
    <rect x="20" y="20" width="180" height="52" rx="9" fill="var(--surface-3,#f1ede2)" stroke="var(--ink-soft,#455062)" stroke-width="1.4"/>
    <text x="110" y="42" text-anchor="middle" font-weight="700">Do edge weights</text>
    <text x="110" y="60" text-anchor="middle" font-weight="700">matter?</text>
    <!-- shortestPath leaf -->
    <rect x="20" y="120" width="180" height="48" rx="9" fill="var(--surface-2,#fff)" stroke="var(--accent-4,#b58900)" stroke-width="1.8"/>
    <text x="110" y="141" text-anchor="middle">shortestPath</text>
    <text x="110" y="158" text-anchor="middle" font-size="10.5" opacity="0.75">hop count only</text>
    <line x1="110" y1="72" x2="110" y2="118" stroke="currentColor" stroke-width="1.5" marker-end="url(#ra-dec-arrow)"/>
    <text x="122" y="98" font-size="10.5" fill="var(--accent-2,#a8380b)" font-weight="700">no</text>
    <!-- Q2 static -->
    <rect x="290" y="20" width="180" height="52" rx="9" fill="var(--surface-3,#f1ede2)" stroke="var(--ink-soft,#455062)" stroke-width="1.4"/>
    <text x="380" y="42" text-anchor="middle" font-weight="700">Static graph +</text>
    <text x="380" y="60" text-anchor="middle" font-weight="700">huge query volume?</text>
    <line x1="200" y1="46" x2="288" y2="46" stroke="currentColor" stroke-width="1.5" marker-end="url(#ra-dec-arrow)"/>
    <text x="232" y="38" font-size="10.5" fill="var(--accent,#0a656d)" font-weight="700">yes</text>
    <!-- CH leaf -->
    <rect x="290" y="120" width="180" height="48" rx="9" fill="var(--accent-3,#5b21b6)" stroke="var(--accent-3,#5b21b6)" stroke-width="1.8"/>
    <text x="380" y="141" text-anchor="middle" fill="#ffffff">Contraction</text>
    <text x="380" y="158" text-anchor="middle" fill="#ffffff" font-size="10.5">hierarchies</text>
    <line x1="380" y1="72" x2="380" y2="118" stroke="currentColor" stroke-width="1.5" marker-end="url(#ra-dec-arrow)"/>
    <text x="392" y="98" font-size="10.5" fill="var(--accent,#0a656d)" font-weight="700">yes</text>
    <!-- Q3 heuristic -->
    <rect x="560" y="20" width="200" height="52" rx="9" fill="var(--surface-3,#f1ede2)" stroke="var(--ink-soft,#455062)" stroke-width="1.4"/>
    <text x="660" y="42" text-anchor="middle" font-weight="700">Admissible geographic</text>
    <text x="660" y="60" text-anchor="middle" font-weight="700">heuristic available?</text>
    <line x1="470" y1="46" x2="558" y2="46" stroke="currentColor" stroke-width="1.5" marker-end="url(#ra-dec-arrow)"/>
    <text x="500" y="38" font-size="10.5" fill="var(--accent-2,#a8380b)" font-weight="700">no</text>
    <!-- A* leaf -->
    <rect x="560" y="120" width="200" height="48" rx="9" fill="var(--accent,#0a656d)" stroke="var(--accent,#0a656d)" stroke-width="1.8"/>
    <text x="660" y="141" text-anchor="middle" fill="#ffffff">A* point-to-point</text>
    <text x="660" y="158" text-anchor="middle" fill="#ffffff" font-size="10.5">goal-biased search</text>
    <line x1="660" y1="72" x2="660" y2="118" stroke="currentColor" stroke-width="1.5" marker-end="url(#ra-dec-arrow)"/>
    <text x="672" y="98" font-size="10.5" fill="var(--accent,#0a656d)" font-weight="700">yes</text>
    <!-- Dijkstra leaf -->
    <rect x="290" y="248" width="360" height="56" rx="9" fill="var(--accent-2,#a8380b)" stroke="var(--accent-2,#a8380b)" stroke-width="1.8"/>
    <text x="470" y="270" text-anchor="middle" fill="#ffffff" font-weight="700">Dijkstra (GDS at scale)</text>
    <text x="470" y="290" text-anchor="middle" fill="#ffffff" font-size="10.5">no heuristic, or one-to-many cost surfaces</text>
    <path d="M660 168 V210 H470 V246" fill="none" stroke="currentColor" stroke-width="1.5" marker-end="url(#ra-dec-arrow)"/>
    <text x="560" y="204" font-size="10.5" fill="var(--accent-2,#a8380b)" font-weight="700">no / one-to-many</text>
  </g>
</svg>

## Performance Tuning

The single number that predicts routing latency is nodes expanded, and `PROFILE` plus a settled-node counter are how you measure it. For the hand-written search, log `len(settled)` per query and watch the ratio between Dijkstra and A\* on real origin-destination pairs — on a well-formed geographic graph A\* should expand three to ten times fewer nodes; if the ratio is near one, the heuristic is not biasing the search and is almost certainly returning zero or a near-zero estimate.

- **Confirm the endpoint lookup seeks.** Both hand-written and GDS paths anchor on `MATCH (:Junction {id})`. Run `PROFILE` and confirm a `NodeUniqueIndexSeek`, never a `NodeByLabelScan` — a missing constraint on `Junction.id` turns every neighbour fetch into a full scan and dominates the whole query.
- **Bound the corridor before you search.** An unbounded client-side A\* on a continental graph still round-trips per node. Pre-clip candidates with the box-then-distance predicate from [distance filter query patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/) so the frontier can never wander off the map.
- **Batch expansion where possible.** One round trip per settled node is the hand-written loop's ceiling. If latency matters more than per-request cost-function flexibility, push the whole search into GDS where expansion never crosses the wire.
- **Keep weights on the relationship.** Recomputing `cost_s` from geometry inside the loop repeats trig on every edge of every candidate. Precompute it at ingestion and read it as a scalar.

## Edge Cases & Gotchas

- **Negative or zero edge weights.** Dijkstra and A\* both assume non-negative weights; a single negative `cost_s` (a mis-signed turn bonus, say) breaks the settled-node invariant and can return a wrong path with no error. Validate weight sign at ingestion, not at query time.
- **Inadmissible heuristic silently loses optimality.** If `h(n)` ever exceeds the true remaining cost, A\* can settle the target on a sub-optimal path. The usual cause is a unit mismatch — a distance-metre heuristic against time-second edge weights. Scale the heuristic into the edge unit; the derivation is in the [A* Haversine page](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/routing-algorithms-python/implementing-astar-with-a-haversine-heuristic-in-python/).
- **Disconnected components.** A query between two nodes in different components expands the entire source component before returning `None`. Cap the search with a settled-node ceiling or a max-cost cutoff so an unreachable target fails fast.
- **Stale contraction hierarchies.** A CH built before an edge-weight update returns distances for the old graph. Treat the preprocessed structure as a cache keyed on a topology version and invalidate it on every write that touches routing weights.
- **Directionality drift.** Reading only out-edges is correct only if two-way streets are modelled as two relationships. A one-way edge stored bidirectionally lets the search cheat through it the wrong way.

## Verification & Testing

Two properties are worth pinning in CI: A\* returns the same cost as Dijkstra (optimality preserved), and both return the known-correct cost on a tiny hand-built graph. The second catches sign and unit bugs; the first catches an inadmissible heuristic sneaking in during a refactor.

```python
import pytest
from neo4j import AsyncGraphDatabase

SEED = """
CREATE (a:Junction {id: 'A', location: point({srid:4326, latitude: 41.88, longitude: -87.64})})
CREATE (b:Junction {id: 'B', location: point({srid:4326, latitude: 41.89, longitude: -87.62})})
CREATE (c:Junction {id: 'C', location: point({srid:4326, latitude: 41.90, longitude: -87.63})})
CREATE (a)-[:ROAD {cost_s: 60.0, length_m: 1800.0}]->(b)
CREATE (b)-[:ROAD {cost_s: 40.0, length_m: 1200.0}]->(c)
CREATE (a)-[:ROAD {cost_s: 150.0, length_m: 4500.0}]->(c)
"""


@pytest.mark.asyncio
async def test_astar_matches_dijkstra_and_optimum():
    driver = AsyncGraphDatabase.driver("bolt://localhost:7687", auth=("neo4j", "test"))
    async with driver.session(database="neo4j") as s:
        await s.run("MATCH (n) DETACH DELETE n")
        await s.run(SEED)
        await s.run("CREATE CONSTRAINT jid IF NOT EXISTS "
                    "FOR (j:Junction) REQUIRE j.id IS UNIQUE")

        d = await shortest_path(s, "A", "C", 41.90, -87.63, heuristic=lambda *_: 0.0)
        a = await shortest_path(
            s, "A", "C", 41.90, -87.63,
            heuristic=lambda lat, lon: great_circle_seconds(lat, lon, 41.90, -87.63))

    assert d[0] == pytest.approx(100.0)      # A->B->C (60+40) beats direct 150
    assert d[1] == ["A", "B", "C"]
    assert a[0] == pytest.approx(d[0])       # A* preserves the optimum
    await driver.close()
```

Run the same assertion over a sample of real origin-destination pairs from production traffic, not just the toy graph — a heuristic that is admissible in one region can drift inadmissible where your speed assumptions break down (mountain passes, ferries, congestion-priced segments).

## FAQ

<details>
<summary>When is Dijkstra actually the right choice over A*?</summary>

Use Dijkstra when you have no admissible heuristic, when edge weights have no geometric interpretation, or when you need cost from one source to many targets at once. A star only helps a single point-to-point query where a lower-bound estimate of remaining cost exists. For a one-to-many cost surface — every reachable node's distance from a depot, for example — the heuristic has no single goal to bias toward, so plain Dijkstra is both correct and simpler.
</details>

<details>
<summary>Can I just set the A* heuristic to zero to reuse the same code?</summary>

Yes, and that is exactly why the implementation takes the heuristic as a parameter. Setting h(n) to zero makes f(n) equal to g(n), which is precisely Dijkstra. One priority-queue loop serves both algorithms; the only difference is the callable you pass in. This also makes testing easy, because you can assert that the zero-heuristic run and the geographic-heuristic run return the same cost.
</details>

<details>
<summary>Why does my A* return a slightly different route than Dijkstra?</summary>

The costs should be identical; if the node sequence differs it is almost always tie-breaking between two equal-cost optimal paths, which is harmless. If the total cost differs, the heuristic is inadmissible — it overestimated remaining cost somewhere, usually a unit mismatch between a distance heuristic and time-based edge weights. Scale the heuristic into the same unit as the edge weight and the costs will converge.
</details>

<details>
<summary>Should I load the whole graph into Python or query edges on demand?</summary>

On demand for large graphs, in memory for small stable ones. The streaming approach shown here keeps the client footprint flat and only touches the corridor a single query needs, at the cost of one round trip per expanded node. If the graph fits in memory and you run thousands of queries against it, load it once into an adjacency structure and skip the per-node round trips, or push the search into GDS where expansion never leaves the database.
</details>

<details>
<summary>How large does the graph need to be before contraction hierarchies pay off?</summary>

Preprocessing pays off when query volume on a stable graph is high enough to amortise the build. For occasional queries or a graph whose weights change frequently, the build cost never returns. As a rule of thumb, reach for contraction hierarchies on country- or continent-scale static road networks serving sustained high query rates, and stay with A star for interactive point-to-point routing on graphs that change often.
</details>

## Related

- [Implementing A* with a Haversine Heuristic in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/routing-algorithms-python/implementing-astar-with-a-haversine-heuristic-in-python/) — the admissible heuristic and the time-versus-distance scaling factor in full.
- [Weighted Dijkstra Routing with Neo4j GDS](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/routing-algorithms-python/weighted-dijkstra-routing-with-neo4j-gds/) — projecting a subgraph and running library Dijkstra for one-to-many routing.
- [Neo4j GDS vs Custom Cypher Routing](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/neo4j-gds-vs-cypher-routing/) — the benchmark that decides when to leave the database and when to stay.
- [Distance Filter Query Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/) — bounding the corridor before a search so the frontier cannot wander.
- [Spatial Graph Database Fundamentals for Python](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/) — the schema, indexing, and driver foundations these algorithms assume.

This guide is part of [Network Routing Algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/).

For authoritative algorithm references, consult the [Neo4j Graph Data Science path-finding documentation](https://neo4j.com/docs/graph-data-science/current/algorithms/pathfinding/) and the original contraction-hierarchies work by [Geisberger et al.](https://algo2.iti.kit.edu/schultes/hwy/contract.pdf).

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "When is Dijkstra actually the right choice over A star?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Use Dijkstra when you have no admissible heuristic, when edge weights have no geometric interpretation, or when you need cost from one source to many targets at once. A star only helps a single point-to-point query where a lower-bound estimate of remaining cost exists. For a one-to-many cost surface such as every reachable node's distance from a depot, the heuristic has no single goal to bias toward, so plain Dijkstra is both correct and simpler."
      }
    },
    {
      "@type": "Question",
      "name": "Can I just set the A star heuristic to zero to reuse the same code?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Yes, and that is exactly why the implementation takes the heuristic as a parameter. Setting the heuristic to zero makes the priority key equal to the cost so far, which is precisely Dijkstra. One priority-queue loop serves both algorithms; the only difference is the callable you pass in. This also makes testing easy, because you can assert that the zero-heuristic run and the geographic-heuristic run return the same cost."
      }
    },
    {
      "@type": "Question",
      "name": "Why does my A star return a slightly different route than Dijkstra?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "The costs should be identical; if the node sequence differs it is almost always tie-breaking between two equal-cost optimal paths, which is harmless. If the total cost differs, the heuristic is inadmissible because it overestimated remaining cost somewhere, usually a unit mismatch between a distance heuristic and time-based edge weights. Scale the heuristic into the same unit as the edge weight and the costs will converge."
      }
    },
    {
      "@type": "Question",
      "name": "Should I load the whole graph into Python or query edges on demand?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "On demand for large graphs, in memory for small stable ones. The streaming approach keeps the client footprint flat and only touches the corridor a single query needs, at the cost of one round trip per expanded node. If the graph fits in memory and you run thousands of queries against it, load it once into an adjacency structure and skip the per-node round trips, or push the search into the Graph Data Science library where expansion never leaves the database."
      }
    },
    {
      "@type": "Question",
      "name": "How large does the graph need to be before contraction hierarchies pay off?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Preprocessing pays off when query volume on a stable graph is high enough to amortise the build. For occasional queries or a graph whose weights change frequently, the build cost never returns. As a rule of thumb, reach for contraction hierarchies on country or continent scale static road networks serving sustained high query rates, and stay with A star for interactive point-to-point routing on graphs that change often."
      }
    }
  ]
}
</script>
