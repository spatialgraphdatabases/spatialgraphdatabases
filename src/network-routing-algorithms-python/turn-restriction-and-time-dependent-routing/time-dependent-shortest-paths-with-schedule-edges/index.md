---
pageTitle: Time-Dependent Shortest Paths
title: Time-Dependent Shortest Paths with Schedule Edges
description: Route on a Neo4j graph where edge cost depends on departure time — per-edge time-bucket weights, transit schedule edges, and a FIFO-safe time-aware Dijkstra in Python.
slug: time-dependent-shortest-paths-with-schedule-edges
type: article
breadcrumb: Time-Dependent Paths
datePublished: 2026-07-14
dateModified: 2026-07-14
---
# Time-Dependent Shortest Paths with Schedule Edges

A router that costs every edge at free-flow speed returns a path that is optimal at 3 a.m. and wrong at 8 a.m. The symptom is an ETA that is confidently twenty minutes short, or a route that sends a vehicle down an arterial that is a parking lot at rush hour because the graph says it is the fastest link. The root cause is that the edge carries a single scalar weight, and travel time on a real road — or the wait for the next train on a transit line — is a function of *when you arrive at the edge*, not a constant. This page resolves it with a cost model where each edge weight depends on departure time, stored as per-edge time buckets for roads or as discrete schedule edges for transit, and routed with a time-aware Dijkstra that stays optimal as long as the network is FIFO. It is the time dimension of the two constraints introduced in [Turn-Restriction and Time-Dependent Routing](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/turn-restriction-and-time-dependent-routing/).

## Prerequisites & Versions

The search is pure Python over an in-memory adjacency loaded once from Neo4j via the async driver. No GDS or APOC dependency is required.

| Requirement | Minimum version | Install / note |
| --- | --- | --- |
| Python | 3.10+ | `heapq`, `dataclass`, `bisect` for bucket lookup |
| Neo4j | 5.13+ | Native `point`, relationship/node property indexes |
| neo4j (driver) | 5.x | `AsyncGraphDatabase`, native serialization |

```bash
pip install "neo4j>=5.18"
```

This assumes the base topology already follows sound [Node and Edge Spatial Mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/) conventions, so that time weights attach to segments whose direction and identity are stable across re-import.

## Implementation

Two edge kinds coexist. A road edge stores a small, sorted set of departure-time buckets, each giving the traversal cost inside a half-open window. A schedule edge (for transit) stores an explicit departure and arrival time, so its cost includes the wait for the next service. The loader pulls both into a compact adjacency, and a single time-aware Dijkstra searches for the earliest arrival.

```cypher
// Road edge with time-bucket weights (seconds since midnight, fixed reference tz).
//   (:Stop)-[:HOP {kind:'road', buckets:[[0,25200,55],[25200,32400,190],[32400,86400,80]]}]->(:Stop)
// Transit schedule edge: one row per scheduled departure.
//   (:Stop)-[:HOP {kind:'sched', depart_s:27000, arrive_s:27420, route:'U2'}]->(:Stop)

CREATE INDEX hop_kind IF NOT EXISTS FOR ()-[h:HOP]-() ON (h.kind);
```

```python
import asyncio
import heapq
from bisect import bisect_right
from dataclasses import dataclass, field
from typing import Optional

from neo4j import AsyncGraphDatabase

DAY = 86_400

LOAD = """
MATCH (a:Stop)-[h:HOP]->(b:Stop)
RETURN a.id AS src, b.id AS dst, h.kind AS kind,
       h.buckets AS buckets, h.depart_s AS depart_s, h.arrive_s AS arrive_s
"""


@dataclass
class Hop:
    dst: str
    kind: str
    # road: sorted bucket starts + parallel weights; sched: (depart_s, arrive_s)
    starts: list = field(default_factory=list)
    weights: list = field(default_factory=list)
    depart_s: int = 0
    arrive_s: int = 0

    def arrival(self, now_s: float) -> Optional[float]:
        """Absolute arrival time if traversal begins at now_s. None = unusable today."""
        if self.kind == "road":
            tod = now_s % DAY
            i = bisect_right(self.starts, tod) - 1     # active bucket index
            return now_s + self.weights[i]
        # schedule edge: must wait for the next departure at or after now_s
        tod = now_s % DAY
        if tod <= self.depart_s:
            wait = self.depart_s - tod
            return now_s + wait + (self.arrive_s - self.depart_s)
        return None  # last service of the day gone; caller rolls to tomorrow if allowed


async def load_time_network(driver) -> dict[str, list[Hop]]:
    adjacency: dict[str, list[Hop]] = {}
    async with driver.session(database="neo4j") as s:
        async for rec in await s.run(LOAD):
            if rec["kind"] == "road":
                buckets = sorted(rec["buckets"], key=lambda w: w[0])
                hop = Hop(
                    dst=rec["dst"], kind="road",
                    starts=[b[0] for b in buckets],
                    weights=[float(b[2]) for b in buckets],
                )
            else:
                hop = Hop(dst=rec["dst"], kind="sched",
                          depart_s=rec["depart_s"], arrive_s=rec["arrive_s"])
            adjacency.setdefault(rec["src"], []).append(hop)
    return adjacency


def earliest_arrival(
    adjacency: dict[str, list[Hop]], origin: str, dest: str, depart_s: float
) -> Optional[tuple[float, list[str]]]:
    """Time-aware Dijkstra: settle stops in non-decreasing arrival-time order."""
    best: dict[str, float] = {origin: depart_s}
    pq: list[tuple[float, str, list[str]]] = [(depart_s, origin, [origin])]
    while pq:
        arrive_s, node, path = heapq.heappop(pq)
        if node == dest:
            return arrive_s - depart_s, path
        if arrive_s > best.get(node, float("inf")):
            continue
        for hop in adjacency.get(node, ()):
            nxt = hop.arrival(arrive_s)
            if nxt is None:
                continue
            if nxt < best.get(hop.dst, float("inf")):
                best[hop.dst] = nxt
                heapq.heappush(pq, (nxt, hop.dst, path + [hop.dst]))
    return None


async def main():
    driver = AsyncGraphDatabase.driver(
        "neo4j://localhost:7687",
        auth=("neo4j", "secure_password"),
        max_connection_pool_size=20,
        connection_acquisition_timeout=15.0,
    )
    try:
        adjacency = await load_time_network(driver)
        depart = 7 * 3600 + 30 * 60  # 07:30 Europe/Berlin reference time
        result = earliest_arrival(adjacency, "stop_alexpl", "stop_zoo", depart)
        if result is None:
            print("No route reachable today.")
        else:
            travel_s, path = result
            print(f"Earliest arrival: {travel_s / 60:.1f} min via {' -> '.join(path)}")
    finally:
        await driver.close()


if __name__ == "__main__":
    asyncio.run(main())
```

<svg viewBox="0 0 760 340" role="img" aria-labelledby="tdpTitle tdpDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="tdpTitle">Piecewise time-bucket weight profile for one edge and its non-decreasing arrival-time function</title>
  <desc id="tdpDesc">A step chart of one road edge's traversal weight across the day, held constant within each departure-time bucket: about fifty-five seconds overnight, rising to one hundred ninety seconds through the morning peak, easing to eighty seconds mid-day, rising again to two hundred ten seconds in the evening peak, and settling to seventy seconds late. A dashed rising line shows the arrival-time function, which never decreases as departure time advances — the FIFO property that keeps Dijkstra optimal.</desc>
  <!-- axes -->
  <line x1="70" y1="60" x2="70" y2="260" stroke="currentColor" stroke-width="1.5"/>
  <line x1="70" y1="260" x2="724" y2="260" stroke="currentColor" stroke-width="1.5"/>
  <g font-size="10.5" fill="currentColor" opacity="0.75" text-anchor="middle">
    <text x="70" y="278">00:00</text>
    <text x="233" y="278">06:00</text>
    <text x="395" y="278">12:00</text>
    <text x="557" y="278">18:00</text>
    <text x="720" y="278">24:00</text>
  </g>
  <g font-size="10" fill="currentColor" opacity="0.7" text-anchor="end">
    <text x="63" y="263">0</text>
    <text x="63" y="212">80</text>
    <text x="63" y="152">160</text>
    <text x="63" y="98">240</text>
  </g>
  <text x="22" y="160" font-size="11" fill="currentColor" opacity="0.8" transform="rotate(-90 22 160)" text-anchor="middle">weight w(e,t) (s)</text>
  <!-- step profile: buckets [0-7]:55 [7-9]:190 [9-16]:80 [16-19]:210 [19-24]:70 -->
  <!-- scale: x = 70 + h*27.08 ; y = 260 - s*0.6 -->
  <g fill="none" stroke="var(--accent,#0a656d)" stroke-width="2.6">
    <path d="M70,227 H260"/>
    <path d="M260,227 V146 H314"/>
    <path d="M314,146 V212 H503"/>
    <path d="M503,212 V134 H585"/>
    <path d="M585,134 V218 H720"/>
  </g>
  <!-- bucket boundaries -->
  <g stroke="currentColor" stroke-width="1" stroke-dasharray="2 4" opacity="0.35">
    <line x1="260" y1="60" x2="260" y2="260"/>
    <line x1="314" y1="60" x2="314" y2="260"/>
    <line x1="503" y1="60" x2="503" y2="260"/>
    <line x1="585" y1="60" x2="585" y2="260"/>
  </g>
  <!-- arrival-time function (monotone, schematic) -->
  <path d="M70,246 L260,214 L314,150 L503,120 L585,86 L720,70" fill="none"
        stroke="var(--accent-3,#5b21b6)" stroke-width="2" stroke-dasharray="6 4"/>
  <text x="600" y="80" font-size="10" fill="var(--accent-3,#5b21b6)" font-weight="600">arrival a(t) — never decreasing</text>
  <text x="180" y="90" font-size="10.5" fill="var(--accent,#0a656d)" font-weight="600">AM peak</text>
  <text x="470" y="76" font-size="10.5" fill="var(--accent,#0a656d)" font-weight="600">PM peak</text>
  <text x="395" y="316" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.72">weight is constant within a bucket; arrival stays monotone in departure time (FIFO)</text>
</svg>

## How It Works

The search is Dijkstra with one change: the label carried for each stop is an **absolute arrival time**, and relaxing an edge asks the edge how late it makes you rather than adding a fixed weight. For a road edge, the arrival-time function is

$$a(t) = t + w(e, t)$$

where $t$ is the departure time and $w(e, t)$ is the weight of the active bucket at $t$. For a schedule edge, $a(t)$ includes the wait for the next departure: $a(t) = \text{depart} + (\text{arrive} - \text{depart})$ once you have waited from $t$ to the scheduled `depart`. Three mechanics make the search correct:

- **Bucket lookup is a binary search.** `bisect_right` over the sorted bucket starts finds the active window in logarithmic time, so evaluating a weight is cheap even with many buckets. Buckets are half-open `[start, end)` so the boundary second belongs to exactly one window and never both.
- **Settling order is arrival time.** The priority queue is keyed by absolute arrival, so stops are finalized earliest-first. This is why the algorithm remains a Dijkstra and not a general search: once a stop is popped, its earliest arrival is fixed.
- **Schedule edges model waiting implicitly.** A transit hop returns an arrival that already folds in the wait for the next service, so the search naturally prefers a slower road link when the train has just left, and the train when it is about to depart — no separate waiting model is needed.

The correctness of that settling order rests entirely on the **FIFO property**: for any two departure times $t_1 \le t_2$,

$$a(t_1) \le a(t_2).$$

In words, leaving earlier never arrives later — equivalently, you cannot overtake yourself by waiting. Road travel-time profiles built from real speed data satisfy it; the weight may rise steeply into a peak, but never so steeply that departing a second later saves more than a second. When FIFO holds, a settled label can never be improved by a later-arriving one, and Dijkstra is optimal. When it does not, the guarantee is void — which is the first failure pattern below.

## Common Failure Patterns

**1. Non-FIFO edges silently breaking optimality.** If a weight profile drops fast enough that arriving one minute later lets you *leave* the edge more than one minute sooner, then $a(t)$ decreases somewhere and FIFO is violated. Dijkstra will still return a path, but not necessarily the optimal one, because it may settle a stop before discovering a cheaper late-departing label. The usual culprit is not real traffic — it is badly interpolated data, where a coarse bucket boundary creates an artificial cliff. Detect it at load time and clamp:

```python
def enforce_fifo(starts: list[int], weights: list[float]) -> list[float]:
    """A later departure must not arrive earlier. Clamp each bucket so a(t) is monotone."""
    fixed = list(weights)
    for i in range(1, len(fixed)):
        gap = starts[i] - starts[i - 1]
        # If dropping to weights[i] would let a boundary-crosser overtake, clamp it.
        min_allowed = fixed[i - 1] - gap
        if fixed[i] < min_allowed:
            fixed[i] = min_allowed
    return fixed
```

Clamping trades a small optimism error for a hard optimality guarantee; the alternative — a general label-correcting search that tolerates non-FIFO edges — is far more expensive and rarely justified for road data.

**2. Timezone and DST bugs.** Buckets and schedules are stored in seconds-since-midnight, which is meaningless without a fixed reference timezone. Store and compute in one canonical offset (the example uses Europe/Berlin standard time as the reference frame) and convert only at the API boundary. If you bucket in local wall-clock and let it follow DST, the spring-forward transition erases an hour of weights and fall-back applies two overlapping hours — both produce wrong ETAs for exactly the trips crossing 02:00–03:00 twice a year, which is nearly impossible to reproduce in a test that does not pin the clock.

**3. Unbounded waiting at a stop.** A schedule edge whose last service of the day has already departed returns `None`, and a naive search that instead rolls the wait over to *tomorrow's* first departure will happily plan a route that waits nine hours overnight — technically the earliest arrival, practically useless. Bound the wait explicitly: reject a hop whose wait exceeds a policy ceiling (say 90 minutes) so the search treats an overnight gap as unreachable rather than as a very slow edge.

```python
MAX_WAIT_S = 90 * 60
# inside Hop.arrival for schedule edges:
#   wait = self.depart_s - tod
#   if wait > MAX_WAIT_S: return None
```

## Performance Notes

The load reads the whole network once and is async and pooled; the search is CPU-bound pure Python. Let $n$ be stops, $m$ hops, and $B$ the average buckets per edge. The search is standard Dijkstra, $O(m \log n)$, with each relaxation paying an extra $O(\log B)$ for the bucket binary search — negligible for the five-to-eight buckets that capture real daily variation. Memory is the constraint that bites first: storing per-minute weights makes $B \approx 1440$ and inflates the adjacency by two orders of magnitude for no ETA benefit, so keep buckets coarse. For interactive services, cache the loaded adjacency in process and invalidate on graph change, so per-request cost is the search alone. When the network outgrows a single process, push the search server-side; the trade-offs against a static preprocessed router live under [Routing Algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/routing-algorithms-python/), and the static preprocessing that time-dependence rules out is [Contraction Hierarchies for Road Networks](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/contraction-hierarchies-for-road-networks/).

## Related

- [Turn-Restriction and Time-Dependent Routing](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/turn-restriction-and-time-dependent-routing/) — the companion turn-cost constraint and where both fit together.
- [Modeling Turn Restrictions as an Edge-Based Graph](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/turn-restriction-and-time-dependent-routing/modeling-turn-restrictions-as-an-edge-based-graph/) — the other hard constraint, on the same base topology.
- [Routing Algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/routing-algorithms-python/) — Dijkstra and A* foundations this time-aware variant builds on.
- [Contraction Hierarchies for Road Networks](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/contraction-hierarchies-for-road-networks/) — the static-cost preprocessing that time-dependent weights invalidate.

This guide is part of [Turn-Restriction and Time-Dependent Routing](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/turn-restriction-and-time-dependent-routing/), within the [Network Routing Algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/) knowledge base.

For authoritative reference on time-dependent routing and the FIFO property, consult the [GTFS transit schedule specification](https://gtfs.org/schedule/reference/) and the [Neo4j Cypher spatial functions reference](https://neo4j.com/docs/cypher-manual/current/functions/spatial/).
