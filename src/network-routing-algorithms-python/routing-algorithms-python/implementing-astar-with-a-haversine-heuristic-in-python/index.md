---
pageTitle: A* with a Haversine Heuristic
title: Implementing A* with a Haversine Heuristic in Python
description: A complete async A* over a Neo4j spatial graph, with the Haversine heuristic and the scaling factor that keeps it admissible for time-weighted edges
slug: implementing-astar-with-a-haversine-heuristic-in-python
type: article
breadcrumb: A* Haversine Heuristic
datePublished: 2026-07-14
dateModified: 2026-07-14
---
# Implementing A* with a Haversine Heuristic in Python

A\* is only as good as its heuristic, and the most common way engineers break it is subtle: they wire the straight-line Haversine distance in metres straight into an A\* whose edge weights are travel time in seconds. The search still runs, still returns a path, and still looks plausible in a demo — but the heuristic now overestimates remaining cost by orders of magnitude, A\* loses its optimality guarantee, and it starts returning routes that are shorter in kilometres yet slower to drive. The fix is to make the heuristic *admissible* in the edge's own unit: a lower bound that can never exceed the true remaining cost. This page builds one complete async A\* over a Neo4j-backed spatial graph, derives the scaling factor that keeps the Haversine estimate admissible against time-weighted edges, and shows the three failure modes that quietly corrupt the result. It is the focused implementation behind the [Routing Algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/routing-algorithms-python/) decision guide.

## Prerequisites & Versions

The search reads edges from Neo4j through the official async driver and computes the heuristic client-side, so no APOC or GDS dependency is needed.

| Requirement | Minimum version | Note |
| --- | --- | --- |
| Python | 3.10+ | `heapq`, `dataclasses`, union syntax |
| Neo4j | 5.13+ | Native `point`, unique constraint on the node id |
| neo4j (driver) | 5.x | `AsyncGraphDatabase`, native point serialization |

```bash
pip install "neo4j>=5.18"
```

The graph must store coordinates as native `point` values and carry a scalar routing weight on each relationship, following the [node and edge spatial mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/) conventions. A unique constraint on the node id is non-negotiable: A\* anchors on the source and target by id, and without the constraint each lookup degrades to a label scan.

## The heuristic and why admissibility matters

A\* orders its frontier by $f(n) = g(n) + h(n)$: $g(n)$ is the confirmed cost from the source to $n$, and $h(n)$ estimates the remaining cost from $n$ to the goal. The guarantee that A\* returns the optimal path holds if and only if $h$ is **admissible** — it never overestimates:

$$h(n) \le h^{*}(n) \quad \text{for every node } n,$$

where $h^{*}(n)$ is the true optimal remaining cost. The great-circle (Haversine) distance is a natural lower bound on remaining *distance*, because no road is shorter than the straight line across the sphere:

$$d(n, t) = 2R \arcsin\!\left(\sqrt{\sin^{2}\!\tfrac{\Delta\varphi}{2} + \cos\varphi_n \cos\varphi_t \sin^{2}\!\tfrac{\Delta\lambda}{2}}\,\right)$$

with $R$ the mean Earth radius and $t$ the target. If edge weights are metres, $d(n,t)$ is admissible as written. But if edge weights are **travel time in seconds**, a distance in metres is not a valid lower bound on seconds — it is a different unit entirely, and treating metres as seconds wildly overestimates. Convert the distance lower bound into a time lower bound by dividing by the *fastest speed any edge in the graph could possibly be traversed at*:

$$h_{\text{time}}(n) = \frac{d(n, t)}{v_{\max}}$$

Because $v_{\max}$ is the top speed anywhere in the network, no real route can beat it, so $h_{\text{time}}(n)$ can never exceed the true remaining travel time — it stays admissible. Choosing $v_{\max}$ too low makes the heuristic inadmissible; choosing it too high makes it weak (closer to zero, so A\* drifts back toward Dijkstra). Set it to the graph's genuine maximum, not a typical speed.

<svg viewBox="0 0 720 404" role="img" aria-labelledby="astar-sets-title astar-sets-desc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="astar-sets-title">A star open and closed sets on a small graph with an f equals g plus h annotation</title>
  <desc id="astar-sets-desc">A small directed graph from a start node S on the left to a goal node G on the right. Two nodes behind the frontier are filled as the closed set of already-settled nodes. Three nodes on the frontier are drawn as rings, forming the open set still to be expanded. One frontier node is annotated with its scores: g equals the confirmed cost from the start, h equals the Haversine lower bound to the goal, and f equals g plus h, the key A star pops next.</desc>
  <defs>
    <marker id="astar-sets-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <!-- edges -->
  <g stroke="currentColor" stroke-width="1.8" fill="none" opacity="0.55" marker-end="url(#astar-sets-arrow)">
    <line x1="96" y1="192" x2="200" y2="130"/>
    <line x1="96" y1="208" x2="200" y2="272"/>
    <line x1="236" y1="120" x2="356" y2="120"/>
    <line x1="236" y1="280" x2="356" y2="280"/>
    <line x1="392" y1="132" x2="520" y2="188"/>
    <line x1="392" y1="268" x2="520" y2="212"/>
    <line x1="556" y1="200" x2="632" y2="200"/>
  </g>
  <!-- closed set (settled, filled) -->
  <g>
    <circle cx="80" cy="200" r="16" fill="var(--accent-2,#a8380b)"/>
    <text x="80" y="204" text-anchor="middle" font-size="12" font-weight="700" fill="#ffffff">S</text>
    <circle cx="220" cy="120" r="15" fill="var(--ink-soft,#455062)"/>
    <text x="220" y="124" text-anchor="middle" font-size="11" font-weight="700" fill="#ffffff">n1</text>
    <circle cx="220" cy="280" r="15" fill="var(--ink-soft,#455062)"/>
    <text x="220" y="284" text-anchor="middle" font-size="11" font-weight="700" fill="#ffffff">n2</text>
  </g>
  <!-- open set (frontier, rings) -->
  <g fill="var(--surface-2,#fff)" stroke="var(--accent,#0a656d)" stroke-width="2.4">
    <circle cx="374" cy="120" r="15"/>
    <circle cx="374" cy="280" r="15"/>
    <circle cx="538" cy="200" r="15"/>
  </g>
  <g font-size="11" font-weight="700" fill="currentColor" text-anchor="middle">
    <text x="374" y="124">n3</text>
    <text x="374" y="284">n4</text>
    <text x="538" y="204">n5</text>
  </g>
  <!-- goal -->
  <circle cx="648" cy="200" r="16" fill="var(--accent-3,#5b21b6)"/>
  <text x="648" y="204" text-anchor="middle" font-size="12" font-weight="700" fill="#ffffff">G</text>
  <!-- annotation on n3 -->
  <line x1="374" y1="105" x2="374" y2="60" stroke="var(--accent,#0a656d)" stroke-width="1" stroke-dasharray="3 3"/>
  <rect x="300" y="18" width="150" height="44" rx="8" fill="var(--accent,#0a656d)" opacity="0.12"/>
  <rect x="300" y="18" width="150" height="44" rx="8" fill="none" stroke="var(--accent,#0a656d)" stroke-width="1.3"/>
  <text x="375" y="36" text-anchor="middle" font-size="11.5" fill="currentColor">g = 210s   h = 168s</text>
  <text x="375" y="53" text-anchor="middle" font-size="11.5" font-weight="700" fill="var(--accent,#0a656d)">f = g + h = 378s</text>
  <!-- legend -->
  <g font-size="11" fill="currentColor">
    <circle cx="70" cy="360" r="9" fill="var(--ink-soft,#455062)"/>
    <text x="86" y="364">closed set (settled)</text>
    <circle cx="270" cy="360" r="9" fill="var(--surface-2,#fff)" stroke="var(--accent,#0a656d)" stroke-width="2.4"/>
    <text x="286" y="364">open set (frontier)</text>
    <text x="470" y="364" opacity="0.75">A* pops the lowest f from the open set</text>
  </g>
</svg>

## Implementation

The class below loads a node's outgoing edges asynchronously, runs a binary-heap A\*, and reconstructs the path. Coordinates for the heuristic ride along with each neighbour so the search never makes a second round trip to fetch geometry. The example routes across Berlin.

```python
import asyncio
import heapq
import itertools
import math
from dataclasses import dataclass, field
from typing import Optional

from neo4j import AsyncDriver, AsyncGraphDatabase

EARTH_RADIUS_M = 6_371_000.0

NEIGHBOUR_QUERY = """
MATCH (u:Waypoint {id: $node_id})-[r:LINK]->(v:Waypoint)
RETURN v.id AS to_id,
       r.travel_s AS weight,
       v.location.latitude  AS lat,
       v.location.longitude AS lon
"""


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in metres on the WGS84 mean sphere."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlam / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(a))


@dataclass(order=True)
class _Entry:
    f: float
    tie: int
    node: str = field(compare=False)


class AStarRouter:
    def __init__(self, driver: AsyncDriver, max_kmh: float = 130.0):
        self.driver = driver
        self.max_mps = max_kmh / 3.6  # v_max for the admissible time heuristic

    def heuristic_s(self, lat: float, lon: float, t_lat: float, t_lon: float) -> float:
        """Admissible remaining-time lower bound: crow-flies metres / top speed."""
        return haversine_m(lat, lon, t_lat, t_lon) / self.max_mps

    async def route(
        self, source: str, target: str, t_lat: float, t_lon: float
    ) -> Optional[tuple[float, list[str]]]:
        counter = itertools.count()
        open_heap: list[_Entry] = [_Entry(0.0, next(counter), source)]
        g_score: dict[str, float] = {source: 0.0}
        came_from: dict[str, str] = {}
        closed: set[str] = set()

        async with self.driver.session(database="neo4j") as session:
            while open_heap:
                current = heapq.heappop(open_heap).node
                if current == target:
                    return g_score[target], self._path(came_from, source, target)
                if current in closed:
                    continue
                closed.add(current)

                result = await session.run(NEIGHBOUR_QUERY, node_id=current)
                async for rec in result:
                    nxt = rec["to_id"]
                    if nxt in closed:
                        continue
                    tentative = g_score[current] + float(rec["weight"])
                    if tentative < g_score.get(nxt, math.inf):
                        g_score[nxt] = tentative
                        came_from[nxt] = current
                        f = tentative + self.heuristic_s(rec["lat"], rec["lon"], t_lat, t_lon)
                        heapq.heappush(open_heap, _Entry(f, next(counter), nxt))
        return None

    @staticmethod
    def _path(came_from: dict[str, str], source: str, target: str) -> list[str]:
        node, out = target, [target]
        while node != source:
            node = came_from[node]
            out.append(node)
        out.reverse()
        return out


async def main():
    driver = AsyncGraphDatabase.driver(
        "neo4j://localhost:7687", auth=("neo4j", "secure-password"),
        max_connection_pool_size=20, connection_acquisition_timeout=15.0,
    )
    router = AStarRouter(driver, max_kmh=130.0)
    try:
        # Brandenburg Gate -> Alexanderplatz, Berlin
        result = await router.route("W-brb-0001", "W-alx-0001", 52.5219, 13.4132)
        if result is None:
            print("No route found.")
        else:
            cost_s, path = result
            print(f"Fastest route: {cost_s / 60:.1f} min over {len(path)} waypoints")
    finally:
        await driver.close()


if __name__ == "__main__":
    asyncio.run(main())
```

## How It Works

Three mechanics carry the correctness and the speed:

- **The heap key is `f`, not `g`.** `_Entry` is an ordered dataclass whose comparison uses `f` first, so `heapq` always pops the frontier node with the lowest estimated total cost. That is the one line that makes this A\* rather than Dijkstra; feeding `g` alone would expand a uniform wavefront instead of a goal-biased corridor.
- **The heuristic is scaled into seconds.** `heuristic_s` divides Haversine metres by `max_mps`, the top speed anywhere in the graph. The result is a valid lower bound on remaining travel time, so the estimate is admissible and the first pop of the target is provably optimal. Change the edge unit and you must change this divisor to match.
- **The closed set prevents re-expansion.** Once a node is popped it enters `closed` and is never expanded again. With a non-negative, admissible heuristic that is safe: the first time A\* settles a node it has already found that node's optimal cost. A stale heap entry for an already-closed node is discarded by the `if current in closed` guard rather than re-queried.

The tie-breaker deserves a note. `itertools.count()` supplies a strictly increasing integer so that two entries with equal `f` never fall back to comparing the `node` string — the `compare=False` on the `node` field makes that explicit. Beyond avoiding a `TypeError`, the tie-break policy shapes *which* of several equal-cost optimal paths you get; a monotonic counter yields a stable, insertion-ordered choice, which is what you want for reproducible results.

## Common Failure Patterns

**1. Inadmissible heuristic from a unit mismatch.** The classic bug: edge weights are `travel_s` (seconds) but the heuristic returns Haversine *metres*. Metres are numerically far larger than the seconds they are compared against, so `h` dwarfs `g`, A\* charges greedily at the goal, and it can settle the target on a slower-but-straighter path. The symptom is A\* and Dijkstra returning different total costs on the same query. The fix is the divisor:

```python
# WRONG: metres compared against second-valued edge weights — overestimates, inadmissible
f = tentative + haversine_m(lat, lon, t_lat, t_lon)

# RIGHT: convert the distance lower bound into a time lower bound
f = tentative + haversine_m(lat, lon, t_lat, t_lon) / self.max_mps
```

**2. Unstable or missing tie-breaking.** Pushing raw `(f, node)` tuples onto the heap makes Python compare the node key whenever two `f` values tie. If ids are strings that is merely non-deterministic; if you ever mix comparison types it raises `TypeError` mid-search. Always inject a monotonic counter as the second sort key so `f` ties resolve on insertion order and the payload never participates in the comparison.

**3. Floating-point drift in the goal test.** Summing many `float` edge weights accumulates rounding error, so an equality check like `g_score[target] == expected` will flake. Never compare accumulated costs for exact equality — compare with a tolerance. The same drift can make two genuinely-optimal paths differ by a nanosecond of cost and swap order; treat costs within an epsilon as equal.

```python
import math
assert math.isclose(cost_a, cost_b, rel_tol=1e-9, abs_tol=1e-6)
```

## Performance Notes

A\* on a geographic graph expands roughly the nodes inside an ellipse whose foci are the source and target, versus the full disk Dijkstra sweeps. The heuristic's *tightness* controls how thin that ellipse is: with $h = h^{*}$ exactly, A\* expands only nodes on an optimal path; with $h = 0$ it degenerates to Dijkstra. The scaling divisor sets that tightness — a $v_{\max}$ far above real speeds pushes $h$ toward zero and inflates node expansion, so choosing the *genuine* network maximum keeps the corridor narrow while preserving admissibility.

The dominant per-query cost in this streaming design is one round trip per expanded node. On a corridor of a few thousand nodes that is fine; on a continental query it is not, because even a narrow ellipse over millions of nodes is a lot of round trips. Two levers help: pre-clip the search area with the box-then-distance predicate from [distance filter query patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/) so the frontier physically cannot wander, and — when latency matters more than a Python-side cost function — push the whole search into the database with library Dijkstra, covered in [Weighted Dijkstra Routing with Neo4j GDS](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/routing-algorithms-python/weighted-dijkstra-routing-with-neo4j-gds/).

## Related

- [Routing Algorithms in Python: Dijkstra, A*, and Contraction Hierarchies](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/routing-algorithms-python/) — the decision framework that places A\* against its alternatives.
- [Weighted Dijkstra Routing with Neo4j GDS](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/routing-algorithms-python/weighted-dijkstra-routing-with-neo4j-gds/) — the in-database counterpart when you need one-to-many routing at scale.
- [Distance Filter Query Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/) — bounding the corridor so the frontier stays finite.
- [Node and Edge Spatial Mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/) — storing the coordinates and weights this search reads.

This guide is part of [Routing Algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/routing-algorithms-python/), within the [Network Routing Algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/) pillar.

For the authoritative treatment of admissibility and consistency, consult the [Neo4j Graph Data Science A* documentation](https://neo4j.com/docs/graph-data-science/current/algorithms/astar/) and Hart, Nilsson, and Raphael's original 1968 formulation of A\*.
