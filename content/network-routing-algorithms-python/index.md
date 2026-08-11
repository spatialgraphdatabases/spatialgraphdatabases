---
pageTitle: Network Routing Algorithms in Python
title: Network Routing Algorithms in Python
description: How to choose and implement shortest-path algorithms — Dijkstra, A*, bidirectional search, and contraction hierarchies — on a Neo4j road graph in Python.
slug: network-routing-algorithms-python
type: overview
breadcrumb: Routing Algorithms
datePublished: 2026-07-14
dateModified: 2026-07-14
---
# Network Routing Algorithms in Python

The routing endpoint that returns the *wrong* fastest route is worse than the one that is slow, and both come from the same mistake: picking a search algorithm without understanding what governs its frontier. A team ships `shortestPath`, watches it minimize hop count instead of drive time, and papers over it with post-filters. Another reaches for a full Dijkstra on a continental graph and discovers it expands a million nodes to answer a query that geometrically touches a few thousand. A third precomputes contraction hierarchies, then silently serves stale routes for a week after a road closure because nobody rebuilt the shortcut set. This reference is for the backend and mobility engineers who own those failures — it is the "which algorithm, and why" home for routing across a spatial road graph in Python. It covers the shortest-path families you will actually choose between (breadth-first `shortestPath`, Dijkstra, A\*, bidirectional search, and contraction hierarchies), the edge-weight schema they all depend on, how each maps onto hand-written Cypher versus the Neo4j GDS library, and how to operate them under real query volume without leaking optimality or latency.

It assumes you have already modeled the graph correctly. The storage layout, coordinate geometry, and index design behind everything here live in [Spatial Graph Database Fundamentals for Python](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/); this reference starts one layer up, at the moment two anchored endpoints need a cost-optimal path between them. Every routing request follows the same lifecycle, and only one stage of it actually depends on which algorithm you chose:

<svg viewBox="0 0 940 220" role="img" aria-label="The routing request lifecycle in five stages: the request supplies origin and destination, endpoints are anchored to graph nodes through a spatial index, a candidate corridor is pruned with a distance filter, a frontier is expanded using a priority queue, and a path plus its total cost is returned. Only the frontier-expansion stage depends on the algorithm choice." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title>The routing request lifecycle and the single stage the algorithm choice governs</title>
  <desc>A left-to-right pipeline of five stages: request with origin and destination, anchor endpoints to nodes via a spatial index seek, prune a candidate corridor with a distance filter, expand the frontier through a priority queue, and return the path with its total cost. The frontier-expansion box is highlighted because it is the only stage whose behaviour changes with the algorithm — Dijkstra, A star, bidirectional search, or contraction hierarchies.</desc>
  <defs>
    <marker id="nra-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <rect class="viz-backdrop" x="0" y="0" width="940" height="220" fill="var(--viz-bg,#ffffff)"/>
  <g fill="currentColor">
    <g font-size="11" letter-spacing="0.5" opacity="0.7" text-anchor="middle">
      <text x="94"  y="26">REQUEST</text>
      <text x="282" y="26">ANCHOR</text>
      <text x="470" y="26">PRUNE</text>
      <text x="658" y="26">EXPAND</text>
      <text x="846" y="26">RETURN</text>
    </g>
    <g stroke-width="2" fill="var(--surface-2)">
      <rect x="10"  y="44" width="168" height="96" rx="10" stroke="var(--ink-soft)"/>
      <rect x="198" y="44" width="168" height="96" rx="10" stroke="var(--accent)"/>
      <rect x="386" y="44" width="168" height="96" rx="10" stroke="var(--accent-4)"/>
      <rect x="574" y="44" width="168" height="96" rx="10" stroke="var(--accent-3)" stroke-width="3"/>
      <rect x="762" y="44" width="168" height="96" rx="10" stroke="var(--accent-2)"/>
    </g>
    <g font-size="13.5" text-anchor="middle">
      <text x="94"  y="90">Origin +</text><text x="94"  y="110">destination</text>
      <text x="282" y="90">Anchor to nodes</text><text x="282" y="110">index seek</text>
      <text x="470" y="90">Candidate corridor</text><text x="470" y="110">distance filter</text>
      <text x="658" y="90">Frontier expansion</text><text x="658" y="110">priority queue</text>
      <text x="846" y="90">Path + cost</text><text x="846" y="110">ordered result</text>
    </g>
    <g stroke="currentColor" stroke-width="2" fill="none" marker-end="url(#nra-arrow)">
      <path d="M178 92 H196"/>
      <path d="M366 92 H384"/>
      <path d="M554 92 H572"/>
      <path d="M742 92 H760"/>
    </g>
    <path d="M658 140 V166" stroke="var(--accent-3)" stroke-width="1.5" stroke-dasharray="4 4" fill="none"/>
    <text x="470" y="188" text-anchor="middle" font-size="12.5" fill="var(--ink-soft)">Frontier expansion is the only stage the algorithm choice governs —</text>
    <text x="470" y="206" text-anchor="middle" font-size="12.5" fill="var(--ink-soft)">Dijkstra · A* · bidirectional Dijkstra · contraction hierarchies all reshape this box, nothing else.</text>
  </g>
</svg>

## Concept and Architecture

A routing query is a search over a state space, and the state space is the graph. Every shortest-path algorithm in this reference is a variation on one loop: keep a *frontier* of nodes discovered but not yet finalized, repeatedly remove the most promising node, mark it settled, and *relax* its outgoing edges — offering each neighbor a cheaper tentative cost if the path through the settled node beats what the neighbor already had. The algorithms differ only in how they order the frontier and how much they precompute. That single sentence is the whole taxonomy, and holding it in mind is what lets you reason about a new algorithm instead of memorizing it.

The frontier is a priority queue, and its ordering key is the entire story. Dijkstra keys the queue on $g(n)$ — the best known cost from the origin to node $n$. Because it always expands the lowest-$g$ node next, it grows outward as an expanding cost contour, like a circular wavefront on a uniform grid, and it settles a node only once its optimal cost is proven. A\* keys the queue on $g(n) + h(n)$, where $h(n)$ is a heuristic estimate of the *remaining* cost to the target. That single added term rotates the wavefront toward the goal: the frontier stops ballooning symmetrically and instead stretches along the corridor between origin and destination. Bidirectional search runs two of these loops at once, one forward from the origin and one backward from the target, and stops when the frontiers meet — halving the effective search radius. Contraction hierarchies keep the same relaxation loop but run it over a graph that has been augmented offline with shortcut edges, so the frontier skips whole chains of degree-two nodes in a single hop.

<svg viewBox="0 0 900 372" role="img" aria-label="The routing frontier modeled as a priority queue. On the left, a small graph shows settled nodes filled, frontier nodes ringed, and the target faint. On the right, a priority queue lists three frontier nodes ordered by their key, with the minimum-key node at the top ready to be popped. The pop-settle-relax-push cycle drives the search." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title>The routing frontier as a priority queue ordered by g plus h</title>
  <desc>Left panel: a graph with origin S and two settled neighbours filled in the accent colour, three frontier nodes drawn as rings, and a faint dashed target node D. Each frontier node carries a key value. Right panel: a priority queue of the three frontier nodes sorted by key, with the smallest key at the top marked as the next pop. A caption explains that Dijkstra keys on g while A star keys on g plus h, so the heuristic only reorders which node pops next.</desc>
  <defs>
    <marker id="nra-fr-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <rect class="viz-backdrop" x="0" y="0" width="900" height="372" fill="var(--viz-bg,#ffffff)"/>
  <g fill="currentColor">
    <rect x="16"  y="44" width="470" height="280" rx="12" fill="var(--surface-2)" stroke="var(--line)"/>
    <rect x="506" y="44" width="378" height="280" rx="12" fill="var(--surface-2)" stroke="var(--line)"/>
    <text x="32"  y="70" font-size="14" font-weight="600">Search graph</text>
    <text x="522" y="70" font-size="14" font-weight="600">Frontier priority queue</text>
    <!-- edges -->
    <g stroke="currentColor" stroke-width="2" fill="none" opacity="0.55">
      <path d="M80 190 L185 120"/>
      <path d="M80 190 L185 265"/>
      <path d="M185 120 L325 95"/>
      <path d="M185 120 L330 190"/>
      <path d="M185 265 L330 190"/>
      <path d="M185 265 L325 285"/>
    </g>
    <g stroke="var(--ink-soft)" stroke-width="1.6" stroke-dasharray="5 4" fill="none" opacity="0.5">
      <path d="M325 95 L445 190"/>
      <path d="M330 190 L445 190"/>
      <path d="M325 285 L445 190"/>
    </g>
    <!-- settled nodes -->
    <g fill="var(--accent)">
      <circle cx="80"  cy="190" r="15"/>
      <circle cx="185" cy="120" r="15"/>
      <circle cx="185" cy="265" r="15"/>
    </g>
    <g fill="var(--viz-on-pill,#ffffff)" font-size="11" font-weight="700" text-anchor="middle">
      <text x="80"  y="194">S</text>
      <text x="185" y="124">n1</text>
      <text x="185" y="269">n2</text>
    </g>
    <!-- frontier nodes -->
    <g fill="var(--surface-2)" stroke="var(--accent-4)" stroke-width="2.5">
      <circle cx="325" cy="95"  r="15"/>
      <circle cx="330" cy="190" r="15"/>
      <circle cx="325" cy="285" r="15"/>
    </g>
    <g font-size="11" font-weight="700" text-anchor="middle" fill="currentColor">
      <text x="325" y="99">n3</text>
      <text x="330" y="194">n4</text>
      <text x="325" y="289">n5</text>
    </g>
    <g font-size="10" text-anchor="middle" fill="var(--ink-soft)">
      <text x="325" y="70">key 11.0</text>
      <text x="372" y="192">key 9.2</text>
      <text x="325" y="312">key 12.4</text>
    </g>
    <!-- target -->
    <circle cx="445" cy="190" r="15" fill="none" stroke="var(--ink-soft)" stroke-width="2" stroke-dasharray="4 3"/>
    <text x="445" y="194" font-size="11" font-weight="700" text-anchor="middle">D</text>
    <!-- priority queue -->
    <g>
      <rect x="540" y="92"  width="310" height="46" rx="8" fill="var(--accent)" opacity="0.14"/>
      <rect x="540" y="92"  width="310" height="46" rx="8" fill="none" stroke="var(--accent)" stroke-width="2.5"/>
      <rect x="540" y="150" width="310" height="46" rx="8" fill="var(--surface-3)" stroke="var(--line)"/>
      <rect x="540" y="208" width="310" height="46" rx="8" fill="var(--surface-3)" stroke="var(--line)"/>
    </g>
    <g font-size="13" font-weight="600">
      <text x="560" y="120">n4</text><text x="830" y="120" text-anchor="end">g + h = 9.2</text>
      <text x="560" y="178">n3</text><text x="830" y="178" text-anchor="end">g + h = 11.0</text>
      <text x="560" y="236">n5</text><text x="830" y="236" text-anchor="end">g + h = 12.4</text>
    </g>
    <text x="695" y="86" font-size="10.5" text-anchor="middle" fill="var(--accent)" font-weight="700">next pop — minimum key</text>
    <text x="695" y="284" font-size="12" text-anchor="middle" fill="var(--ink-soft)">pop min &#8594; settle &#8594; relax neighbours &#8594; push</text>
  </g>
  <text x="450" y="352" text-anchor="middle" font-size="12" fill="var(--ink-soft)" font-family="var(--font-sans,sans-serif)">Dijkstra keys the queue on g alone; A* keys on g + h, so an admissible h only reorders pops toward the goal — it never changes the optimum.</text>
</svg>

Two invariants make this loop trustworthy, and every correctness bug in routing traces back to violating one of them. The first is that a node is settled *at most once*, and when it is settled its cost is final — this is what lets the search stop the instant it pops the target instead of enumerating every path. The second is that the frontier key is a *lower bound* on the true cost of any path completed through that node; for Dijkstra the key is exactly $g$, and for A\* the key is $g + h$ where $h$ never exceeds the real remaining cost. Break the first invariant with a negative weight and settled nodes get cheaper after the fact; break the second with an overestimating heuristic and the search settles the target before its optimal cost is proven. Both failures are silent — the loop still returns a path — which is why they dominate the hardening section later.

This model is why the endpoint of the pipeline — the *shape* of the graph — dominates everything. On a road network the branching factor at each node is tiny (most intersections have three or four exits), but the graph is deep: a cross-city route crosses hundreds of segments. That combination rewards algorithms that keep the frontier narrow and punishes any that expand it radially. It is also why the spatial index does its work only at the very start, anchoring the endpoints and pruning the corridor, and never again during the traversal itself — the constant-time neighbor expansion of the adjacency layout is what makes routing a connectivity problem rather than a repeated index join.

## Schema Design

Routing algorithms read exactly two things off the graph: which edges leave a node, and what each edge costs. Everything else is the ingestion and modeling layer's concern. So the schema the routing layer cares about is narrow and non-negotiable: a stable node identity, a directed relationship, and a *precomputed* cost on that relationship. If cost is derived at query time from geometry, every frontier pop pays for trigonometry, and the search that should touch thousands of nodes recomputes distance millions of times.

Store the cost as a scalar, and store more than one of them. A road segment has a physical `length_m`, a routing `weight` (an abstract impedance that can fold in road class, surface, or turn penalties), and a `travel_s` in seconds for time-based routing. Keep them distinct: conflating length with time produces routes that are short in kilometers but slow in practice, and conflating weight with distance breaks the A\* heuristic, which must compare against a cost in the *same unit* the edges carry. Direction is load-bearing — a one-way street is a single directed `(:Node)-[:ROUTE]->(:Node)`, and a two-way street is two relationships (or one relationship queried without a direction arrow). Getting direction wrong is the classic source of a route that "cheats" the wrong way down a one-way segment.

```cypher
CREATE CONSTRAINT node_id_unique IF NOT EXISTS
FOR (n:Node) REQUIRE n.id IS UNIQUE;

CREATE POINT INDEX node_location IF NOT EXISTS
FOR (n:Node) ON (n.location);
```

```cypher
// Routing edge: precomputed costs, direction, and a routable profile.
// (:Node {id, location: point({srid:4326, latitude, longitude})})
//   -[:ROUTE {length_m, weight, travel_s, profile}]->
// (:Node)
CREATE INDEX route_profile IF NOT EXISTS
FOR ()-[r:ROUTE]-() ON (r.profile);
```

The `location` point on the node is not there for the traversal — it is there for the *heuristic*. A\* needs the coordinates of the target and of each expanded node to compute a straight-line lower bound, so the point index that anchors the endpoints doubles as the coordinate source for the search. The `profile` property (`car`, `truck`, `bike`) lets a single graph serve multiple vehicle classes by filtering relationships during relaxation; the point-index and index-hint mechanics that keep those anchor lookups fast are covered under [spatial indexing strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/).

One structural decision deserves its own note, because it changes the graph and not just its properties: **edge-based expansion**. A plain node-based graph cannot express "you may enter segment B from segment A, but not from segment C" — a turn restriction is a property of a *pair* of edges, not of any single node. The fix is to expand the graph so that each directed road segment becomes a node and each legal turn becomes an edge between them; the search then runs unchanged over this dual graph, and forbidden turns simply have no edge. That transformation roughly triples the node count and is the foundation of both turn-restriction and time-dependent routing, worked through in [Turn-Restriction and Time-Dependent Routing](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/turn-restriction-and-time-dependent-routing/). Reach for it only when turn penalties actually matter; for most freight and delivery routing the node-based graph with directed edges is enough.

## Core Python Integration

The example below is a complete, runnable A\* router driven by the official async `neo4j` driver. It does not offload the search to a stored procedure — it *is* the algorithm, in Python, expanding the graph on demand: each time it settles a node it asks Neo4j only for that node's outgoing edges, so the driver streams exactly the frontier and nothing more. The heuristic is the straight-line travel time to the target (Haversine distance divided by the network's top speed), which is admissible by construction. After the search, `validate_route` re-reads the reconstructed path's edges from the database and asserts that their summed `travel_s` equals the cost the search reported — a route that fails this check is a topology or bookkeeping bug, not a valid answer.

```python
import asyncio
import heapq
import math
from dataclasses import dataclass, field
from typing import Optional

from neo4j import AsyncDriver, AsyncGraphDatabase

EARTH_RADIUS_KM = 6371.0088


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in kilometers on the WGS84 mean-radius sphere."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return 2 * EARTH_RADIUS_KM * math.asin(math.sqrt(a))


def init_driver(uri: str, user: str, password: str, pool_size: int = 20) -> AsyncDriver:
    return AsyncGraphDatabase.driver(
        uri,
        auth=(user, password),
        max_connection_pool_size=pool_size,
        connection_acquisition_timeout=15.0,
        max_connection_lifetime=300,
    )


ENDPOINT_QUERY = """
MATCH (n:Node {id: $node_id})
RETURN n.location.latitude AS lat, n.location.longitude AS lon
"""

NEIGHBOUR_QUERY = """
MATCH (n:Node {id: $node_id})-[r:ROUTE {profile: $profile}]->(m:Node)
RETURN m.id AS id,
       m.location.latitude  AS lat,
       m.location.longitude AS lon,
       r.travel_s           AS travel_s
"""

VALIDATE_QUERY = """
UNWIND range(0, size($ids) - 2) AS i
MATCH (a:Node {id: $ids[i]})-[r:ROUTE {profile: $profile}]->(b:Node {id: $ids[i + 1]})
RETURN sum(r.travel_s) AS total_s, count(r) AS hops
"""


@dataclass(order=True)
class FrontierItem:
    priority: float
    node_id: str = field(compare=False)


async def astar_route(
    driver: AsyncDriver,
    origin_id: str,
    dest_id: str,
    profile: str = "car",
    top_speed_kmh: float = 130.0,
) -> Optional[dict]:
    """On-demand A* over :ROUTE edges. Cost is travel_s; the heuristic is a
    straight-line travel-time lower bound, admissible while top_speed_kmh is a
    true upper bound on any edge's speed."""
    async with driver.session() as session:
        target = await (await session.run(ENDPOINT_QUERY, node_id=dest_id)).single()
        source = await (await session.run(ENDPOINT_QUERY, node_id=origin_id)).single()
        if target is None or source is None:
            return None
        t_lat, t_lon = target["lat"], target["lon"]

        def heuristic(lat: float, lon: float) -> float:
            # kilometers / (km/h) * 3600 -> seconds; never overestimates travel time
            return haversine_km(lat, lon, t_lat, t_lon) / top_speed_kmh * 3600.0

        g: dict[str, float] = {origin_id: 0.0}
        came_from: dict[str, str] = {}
        settled: set[str] = set()
        open_heap = [FrontierItem(heuristic(source["lat"], source["lon"]), origin_id)]

        while open_heap:
            current = heapq.heappop(open_heap).node_id
            if current in settled:
                continue  # a stale, higher-cost queue entry for an already-settled node
            if current == dest_id:
                break
            settled.add(current)

            result = await session.run(NEIGHBOUR_QUERY, node_id=current, profile=profile)
            async for row in result:
                nbr = row["id"]
                if nbr in settled:
                    continue
                tentative = g[current] + float(row["travel_s"])
                if tentative < g.get(nbr, math.inf):
                    g[nbr] = tentative
                    came_from[nbr] = current
                    f = tentative + heuristic(row["lat"], row["lon"])
                    heapq.heappush(open_heap, FrontierItem(f, nbr))

        if dest_id not in g:
            return None

        path = [dest_id]
        while path[-1] != origin_id:
            path.append(came_from[path[-1]])
        path.reverse()
        return {"path": path, "cost_s": g[dest_id], "settled": len(settled)}


async def validate_route(driver: AsyncDriver, route: dict, profile: str) -> bool:
    """Re-read the path's edges and confirm the summed cost matches the search."""
    ids = route["path"]
    async with driver.session() as session:
        rec = await (await session.run(VALIDATE_QUERY, ids=ids, profile=profile)).single()
    if rec is None or rec["hops"] != len(ids) - 1:
        return False  # a hop in the path has no matching directed edge -> broken route
    return abs(float(rec["total_s"]) - route["cost_s"]) < 1e-6


async def main():
    driver = init_driver("neo4j://localhost:7687", "neo4j", "secure_password")
    try:
        route = await astar_route(driver, "n_1", "n_920", profile="car", top_speed_kmh=130.0)
        if route is None:
            print("No route between endpoints.")
            return
        ok = await validate_route(driver, route, profile="car")
        print(
            f"Route: {len(route['path'])} nodes, {route['cost_s']:.1f} s, "
            f"{route['settled']} nodes settled, validated={ok}"
        )
    finally:
        await driver.close()


if __name__ == "__main__":
    asyncio.run(main())
```

Four patterns in this code recur across every routing implementation on this site:

1. **The algorithm lives in Python; the database serves the frontier.** The priority queue, the `g`-cost table, and the settled set are ordinary Python objects. Neo4j is queried only to expand a node's neighbors, so the network traffic is bounded by the frontier size, not the graph size. This is the pattern to reach for when you need full control over the search; the trade-off against pushing the whole thing into GDS is the subject of a later section.
2. **Admissible-by-construction heuristic.** Dividing straight-line distance by a true top speed can only *underestimate* travel time, which is exactly the admissibility guarantee A\* needs to stay optimal. Get the top speed wrong on the high side and you break optimality silently.
3. **Stale-entry skipping.** `heapq` has no decrease-key, so a node can sit in the queue multiple times at different priorities. Checking `settled` on pop discards the stale copies — the standard, correct way to run A\*/Dijkstra on Python's binary heap.
4. **Independent validation.** The cost is re-derived from the database's own edges, not trusted from the search. This catches directional defects, weight drift, and reconstruction bugs before they reach a user.

## Algorithm Selection

The decision is not "which algorithm is fastest" — under an admissible heuristic they all return an optimal path — but "which one expands the fewest nodes for *this* workload, given how often the graph changes." Four candidates cover essentially every production case.

**Dijkstra** is the baseline for weighted shortest paths. It expands strictly by `g`, guarantees optimality with no heuristic, and settles every node cheaper than the target before it stops. That last property is a feature when you need *many* answers at once: a single Dijkstra run from one origin yields the optimal cost to *every* reachable node — the one-to-many cost surface behind isochrones, service areas, and nearest-facility queries. Its weakness is point-to-point on a large graph, where it expands a huge disc of nodes in every direction, most of them away from the target.

**A\*** is Dijkstra plus a heuristic $h(n)$ that estimates remaining cost, expanding by $g(n)+h(n)$. On a geographic graph you get $h$ for free from coordinates, so A\* is the default for interactive point-to-point routing. Optimality holds precisely when the heuristic is **admissible** — it never overestimates the true remaining cost $c^{*}(n,t)$ from $n$ to the target $t$:

$$h(n) \le c^{*}(n, t)$$

For time-based routing the admissible heuristic is straight-line travel time at the network's maximum speed. The distance term is the Haversine great-circle distance between node $n$ at $(\varphi_n, \lambda_n)$ and target $t$ at $(\varphi_t, \lambda_t)$:

$$h(n) = \frac{2R}{v_{\max}} \cdot \arcsin\!\sqrt{\sin^2\!\frac{\Delta\varphi}{2} + \cos\varphi_n \cos\varphi_t \sin^2\!\frac{\Delta\lambda}{2}}$$

where $R$ is the mean Earth radius and $v_{\max}$ the top feasible speed. Divide by too small a $v_{\max}$ and $h$ overestimates, A\* stops being optimal, and you ship a subtly wrong route. The step-by-step build of this heuristic is in [Routing Algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/routing-algorithms-python/).

**Bidirectional Dijkstra** runs two searches — forward from the origin, backward from the target over reversed edges — and terminates when their frontiers touch. Because a search radius of $r$ costs roughly $r^2$ nodes on a planar graph, two searches of radius $r/2$ together expand far fewer nodes than one of radius $r$. It needs no heuristic, which makes it the pragmatic choice for long point-to-point routes where no good geometric estimate exists (abstract or multi-modal weights), though the meeting-condition bookkeeping is fiddlier than a single-direction search.

**Contraction hierarchies (CH)** move the work offline. A preprocessing pass orders nodes by "importance" and, for each node contracted, inserts *shortcut* edges that preserve shortest-path costs across it. Queries then run a bidirectional search that only ever moves "upward" in the hierarchy, answering point-to-point queries on country-scale networks in microseconds — one to two orders of magnitude faster than A\*. The cost is a preprocessing pass measured in minutes to hours and, critically, a shortcut set that goes **stale** the moment an edge weight changes. CH fits static or slowly changing graphs with high query volume; it is the wrong tool for a graph under constant live edits. The shortcut-precomputation mechanics are in [Contraction Hierarchies for Road Networks](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/contraction-hierarchies-for-road-networks/).

<svg viewBox="0 0 980 336" role="img" aria-label="A comparison matrix of four routing algorithms across five criteria. Dijkstra: optimal, high radial frontier, no heuristic, no preprocessing, best for one-to-many cost surfaces. A star: optimal, low goal-biased frontier, needs an admissible heuristic, no preprocessing, best for point-to-point geographic routing, and marked the recommended default. Bidirectional Dijkstra: optimal, medium frontier split across two halves, no heuristic, no preprocessing, best for long point-to-point routes without a heuristic. Contraction hierarchies: optimal, very low frontier, no heuristic, heavy preprocessing that must be rebuilt, best for static large road graphs with high query volume." xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title>Routing algorithm selection matrix across four candidates</title>
  <desc>A five-row table comparing Dijkstra, A star, bidirectional Dijkstra, and contraction hierarchies on optimality, frontier size or nodes expanded, whether a heuristic is required, preprocessing cost, and best-fit workload. The A star column is highlighted as the recommended interactive default.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="980" height="336" fill="var(--viz-bg,#ffffff)"/>
  <g fill="currentColor">
    <rect x="380" y="8" width="196" height="306" fill="var(--accent)" opacity="0.08"/>
    <g>
      <rect x="184" y="8" width="196" height="46" fill="var(--surface-3)"/>
      <rect x="380" y="8" width="196" height="46" fill="var(--accent)"/>
      <rect x="576" y="8" width="196" height="46" fill="var(--surface-3)"/>
      <rect x="772" y="8" width="196" height="46" fill="var(--surface-3)"/>
    </g>
    <g stroke="var(--line)" stroke-width="1" fill="none">
      <rect x="8" y="8" width="960" height="306"/>
      <line x1="184" y1="8" x2="184" y2="314"/>
      <line x1="380" y1="8" x2="380" y2="314"/>
      <line x1="576" y1="8" x2="576" y2="314"/>
      <line x1="772" y1="8" x2="772" y2="314"/>
      <line x1="8" y1="54"  x2="968" y2="54"/>
      <line x1="8" y1="106" x2="968" y2="106"/>
      <line x1="8" y1="158" x2="968" y2="158"/>
      <line x1="8" y1="210" x2="968" y2="210"/>
      <line x1="8" y1="262" x2="968" y2="262"/>
    </g>
    <g font-size="13.5" font-weight="600" text-anchor="middle">
      <text x="282" y="35">Dijkstra</text>
      <text x="478" y="28" fill="var(--viz-on-pill,#ffffff)">A*</text>
      <text x="478" y="46" fill="var(--viz-on-pill,#ffffff)" font-size="10" font-weight="400">recommended default</text>
      <text x="674" y="28">Bidirectional</text>
      <text x="674" y="45" font-size="11" font-weight="400">Dijkstra</text>
      <text x="870" y="28">Contraction</text>
      <text x="870" y="45" font-size="11" font-weight="400">hierarchies</text>
    </g>
    <g font-size="13" font-weight="600">
      <text x="24" y="85">Optimality</text>
      <text x="24" y="137">Frontier size</text>
      <text x="24" y="189">Needs heuristic</text>
      <text x="24" y="241">Preprocessing</text>
      <text x="24" y="293">Best-fit workload</text>
    </g>
    <g font-size="12.5" text-anchor="middle">
      <text x="282" y="85">optimal</text>
      <text x="478" y="85">optimal</text>
      <text x="674" y="85">optimal</text>
      <text x="870" y="85">optimal</text>
      <text x="282" y="137">high (radial)</text>
      <text x="478" y="137">low (goal-biased)</text>
      <text x="674" y="137">medium (two halves)</text>
      <text x="870" y="137">very low</text>
      <text x="282" y="189">no</text>
      <text x="478" y="189">yes (admissible)</text>
      <text x="674" y="189">no</text>
      <text x="870" y="189">no</text>
      <text x="282" y="241">none</text>
      <text x="478" y="241">none</text>
      <text x="674" y="241">none</text>
      <text x="870" y="241">heavy (rebuild)</text>
      <text x="282" y="287">one-to-many</text><text x="282" y="303">cost surfaces</text>
      <text x="478" y="287">point-to-point</text><text x="478" y="303">geographic</text>
      <text x="674" y="287">long routes,</text><text x="674" y="303">no heuristic</text>
      <text x="870" y="287">static graphs,</text><text x="870" y="303">high query volume</text>
    </g>
  </g>
</svg>

The decision rule, distilled: **start with A\* for interactive point-to-point routing** because coordinates hand you an admissible heuristic for free. Drop to **Dijkstra** when you need cost-to-all-targets (isochrones, nearest-of-many) or when weights have no geometric meaning and no heuristic applies. Add **bidirectional search** when routes are long and no heuristic exists. Invest in **contraction hierarchies** only once query volume on a stable graph is high enough to amortize the preprocessing — and only if you have an operational answer for rebuilding shortcuts after edits.

## Query Planning: GDS versus Custom Cypher

The A\* router above expands the frontier from Python. That is the right architecture when the search needs custom logic — turn penalties, time-dependent weights, per-request constraints — but it pays a network round trip per settled node. Two other execution strategies avoid that, and choosing between them is the central query-planning decision for routing.

**Hand-written Cypher** with `shortestPath`/`allShortestPaths` runs entirely inside the engine, but it minimizes *hop count*, not weight — correct only for unweighted graphs or where every edge costs the same. Bounded variable-length matches with a `reduce()` cost accumulator can approximate weighted routing, but they enumerate paths rather than running a true priority-queue search, so they blow up combinatorially on dense graphs. Keep hand-written Cypher for unweighted reachability, small hop-bounded corridors, and cases where you want the whole query in one plan.

**Neo4j GDS** projects the graph into an in-memory columnar structure and runs compiled, parallel implementations of `gds.shortestPath.dijkstra` and `gds.shortestPath.astar` over it. Once a projection is resident, a shortest-path call is dramatically faster than either hand-written Cypher or a Python-side expansion, because there is no per-hop round trip and the graph lives in a cache-friendly layout. The cost is the projection itself: building it takes time and memory, and it is a *snapshot* — writes to the database after projection are invisible until you refresh it. The break-even is workload shape. Ad hoc, low-volume, or highly custom searches favor the Python or Cypher path; sustained high-volume routing over a graph that changes on a schedule favors a maintained GDS projection. The full trade-off, with benchmarks, is in [Neo4j GDS vs Custom Cypher Routing](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/neo4j-gds-vs-cypher-routing/).

Whichever engine runs the search, the anchoring stage is still index-bound. The endpoint lookups and the corridor filter must be index seeks, not label scans — confirm it with `PROFILE`, and use the [distance filter query patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/) to bound the candidate set before any expansion begins. Those patterns, and the broader query-shaping techniques, live under [Cypher Spatial Queries & Pathfinding Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/).

## Performance and Scale

Routing performance is governed by one number above all others: **the count of nodes the frontier settles.** Everything else — heap operations, memory, latency — scales off it.

**Frontier size and the heap.** Each settle triggers a relaxation of the node's out-edges and up to that many heap pushes. On a binary heap, a search that settles $N$ nodes costs $O(N \log N)$ in queue operations, so cutting nodes-settled is worth far more than shaving constant factors. This is the entire justification for A\* over Dijkstra and for bidirectional over unidirectional: they settle fewer nodes for the same answer. Measure `settled` (as the example does) and treat a growing count as the leading indicator of a regression — a broken heuristic that reverts A\* toward Dijkstra shows up here long before latency alarms fire.

**Preprocessing trade-offs.** Contraction hierarchies and other speedup techniques trade one-time build cost for per-query speed. The math is a simple amortization: preprocessing pays off when `build_cost < queries_per_rebuild_window × savings_per_query`. A graph rebuilt nightly and serving millions of routes clears that bar easily; a graph edited continuously never does, because the rebuild window collapses. This is why CH belongs to static topologies — the denominator, not the numerator, decides it.

**One-to-many cost surfaces.** Isochrones and nearest-facility queries are not point-to-point problems, and forcing them through A\* means one search per target. A single Dijkstra from the source settles every node once and yields all costs together — the correct and far cheaper primitive. When the surface must be materialized (drive-time bands), GDS Dijkstra over a projection is the production tool, tied to the isochrone workflows under the Cypher reference.

**Corridor pruning as a multiplier.** The cheapest node is the one never expanded. Bounding the search to a geometric corridor between origin and destination — a bounding box or distance envelope applied at the anchoring stage — cuts the reachable frontier before the first pop, and it compounds with the heuristic rather than competing with it. On a continental graph the corridor is often the difference between a search that settles thousands of nodes and one that settles millions, and it is pure setup cost paid once at the index. Cap any variable-length expansion, too: an unbounded hop count will materialize a whole component regardless of how tight the cost budget reads.

**Driver and pool discipline.** A Python-side expansion holds a session for the life of the search, so long routes hold connections longer; size `max_connection_pool_size` to real query concurrency and set `connection_acquisition_timeout` so a saturated pool fails fast instead of hanging. For GDS, the projection lives on the server — watch its memory footprint, because an oversized projection competes with the page cache that keeps the underlying graph fast, and a projection that no longer fits in memory turns a microsecond query back into a disk-bound one.

## Failure Modes and Hardening

Routing failures are quiet: the endpoint returns *a* path, just not the right one. Four modes cause almost all of them.

**Non-admissible heuristics.** The most insidious A\* bug. If $h(n)$ overestimates true remaining cost — a top speed set too low, a heuristic in the wrong unit, a Euclidean estimate on a graph with detour-heavy weights — A\* returns a suboptimal path and *reports it as optimal*. There is no exception, no log line. Harden with a differential test: on a sample of queries, run A\* and plain Dijkstra and assert identical costs. Any divergence is an inadmissible heuristic, full stop.

**Negative or zero weights.** Dijkstra and A\* assume non-negative edge costs; a negative weight (a data-entry error, a miscomputed penalty, an incentive edge) breaks the settled-once invariant and yields wrong paths silently. Zero-weight edges are subtler — they are valid but can create cycles the search loops through without progress. Enforce a positive floor on `weight` and `travel_s` at ingestion, and assert it before projecting a graph into GDS.

**Disconnected components.** No path exists between the endpoints, yet the code must not hang or crash. The example returns `None` when the target never enters `g`; the failure mode is the *un*guarded version that expands the entire reachable component looking for an unreachable target. Precheck component membership for large graphs (a component label computed once, or a GDS WCC pass) so an impossible request is rejected in O(1) instead of after a full-component scan.

**Stale contraction hierarchies.** After a road closure, a new one-way restriction, or a weight update, the shortcut set encodes the *old* graph and CH queries serve routes that ignore the change. This is the operational tax of preprocessing. Harden it by versioning: stamp every projection or shortcut set with the source graph's revision, refuse to answer if the live graph has advanced past it, and wire graph edits to a rebuild trigger. The change-capture patterns that feed that trigger connect back to the ingestion side; treat a stale hierarchy as a correctness incident, not a performance one.

## Operational Checklist

Use this as a pre-production gate for any routing service and as a recurring review:

- [ ] **Weight integrity** — `weight` and `travel_s` present, positive, and unit-consistent on every `:ROUTE`; a floor enforced at ingestion so no zero or negative cost reaches the search.
- [ ] **Heuristic admissibility** — A\* heuristic proven never to overestimate (top speed is a true upper bound, units match edge cost); a differential test against Dijkstra asserts identical optimal cost on a query sample.
- [ ] **Direction correctness** — one-way segments modeled as single directed edges; a route audit confirms no path traverses a `:ROUTE` against its direction.
- [ ] **Index-bound anchoring** — endpoint lookups and corridor filters confirmed as point-index seeks in `PROFILE`, never label-scan-then-filter.
- [ ] **Frontier instrumentation** — nodes-settled recorded per query; alarms on frontier growth that signal a degraded heuristic or a missing corridor bound.
- [ ] **Disconnection handling** — unreachable targets rejected in bounded time; no query expands a whole component searching for an absent path.
- [ ] **Engine fit** — algorithm and execution engine matched to workload (A\* for point-to-point, Dijkstra for one-to-many, GDS projection for high-volume static routing, CH only where rebuild is operationalized).
- [ ] **Preprocessing freshness** — CH shortcuts and GDS projections stamped with a graph revision; queries refuse or refresh when the live graph has advanced.
- [ ] **Pool discipline** — `max_connection_pool_size` matched to concurrency; every session in an `async with`; acquisition timeout set so pool exhaustion fails fast.
- [ ] **Route validation** — returned paths re-costed from the database's own edges before serving; a mismatch treated as a correctness failure.

## Related

- [Routing Algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/routing-algorithms-python/) — building Dijkstra and the A\* Haversine heuristic step by step, in async Python and GDS.
- [Contraction Hierarchies for Road Networks](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/contraction-hierarchies-for-road-networks/) — precomputing shortcut edges and keeping them fresh after graph edits.
- [Turn-Restriction and Time-Dependent Routing](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/turn-restriction-and-time-dependent-routing/) — edge-based expansion for legal turns and schedule-aware, time-dependent weights.
- [Neo4j GDS vs Custom Cypher Routing](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/neo4j-gds-vs-cypher-routing/) — when an in-memory GDS projection beats a hand-written Cypher or Python-side search.
- [Cypher Spatial Queries & Pathfinding Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/) — the distance filters and query shaping that bound the corridor before a search runs.

This guide anchors the routing track of the [Python for Spatial Graph Databases & Network Routing](https://www.spatialgraphdatabases.org/) knowledge base; its foundation is [Spatial Graph Database Fundamentals for Python](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/), and its query-shaping companion is [Cypher Spatial Queries & Pathfinding Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/).
