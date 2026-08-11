---
pageTitle: Bidirectional Dijkstra
title: Bidirectional Dijkstra in Python
description: Search from both ends and halve the explored area, with the stopping rule that makes it correct and the reverse-graph handling one-way streets demand.
slug: bidirectional-dijkstra-in-python
type: article
breadcrumb: Bidirectional Dijkstra
datePublished: 2026-08-11
dateModified: 2026-08-11
---
# Bidirectional Dijkstra in Python

A one-directional Dijkstra from London to Manchester settles most of the Midlands before it arrives, because the frontier is a disc and the disc has to grow until it touches the target. Searching from both ends instead grows two smaller discs that meet in the middle, and two discs of half the radius cover half the area — a factor of two on a plane, and more on a road network where the frontier is shaped by the topology. The saving is free in the sense that no preprocessing is needed. What it costs is a stopping rule that is genuinely easy to get wrong, and the wrong rule returns a route that is plausible, slightly too long, and passes every test that only checks a path was found.

## Prerequisites & Versions

Pure Python over an adjacency structure; no server-side dependency.

| Requirement | Minimum version | Install |
| --- | --- | --- |
| Python | 3.11 | — |
| neo4j (async driver) | 5.20 | `pip install "neo4j>=5.20"` (to load the graph) |

## Implementation

```python
import heapq
import itertools
import math
from dataclasses import dataclass, field


@dataclass
class Graph:
    """Forward and reverse adjacency.

    The reverse side is not the forward side with the endpoints swapped — on a
    one-way network they are genuinely different graphs, and the backward search
    must traverse edges against their direction of travel.
    """
    out_adj: dict[str, list[tuple[str, float]]] = field(default_factory=dict)
    in_adj: dict[str, list[tuple[str, float]]] = field(default_factory=dict)

    def add_edge(self, u: str, v: str, weight: float) -> None:
        if weight < 0:
            raise ValueError("Dijkstra requires non-negative weights")
        self.out_adj.setdefault(u, []).append((v, weight))
        self.in_adj.setdefault(v, []).append((u, weight))
        self.out_adj.setdefault(v, [])
        self.in_adj.setdefault(u, [])


@dataclass(frozen=True)
class Result:
    cost: float
    path: list[str]
    settled: int


def bidirectional_dijkstra(g: Graph, source: str, target: str) -> Result | None:
    if source == target:
        return Result(cost=0.0, path=[source], settled=0)

    counter = itertools.count()          # stable tie-break; never compares node ids
    dist = [{source: 0.0}, {target: 0.0}]
    prev: list[dict[str, str]] = [{}, {}]
    done: list[set[str]] = [set(), set()]
    heaps = [[(0.0, next(counter), source)], [(0.0, next(counter), target)]]
    adj = [g.out_adj, g.in_adj]

    best = math.inf
    meeting: str | None = None
    settled = 0

    while heaps[0] and heaps[1]:
        # Alternate on the SMALLER frontier so the two searches meet near the
        # middle rather than one of them doing most of the work.
        side = 0 if heaps[0][0][0] <= heaps[1][0][0] else 1
        other = 1 - side

        d, _, u = heapq.heappop(heaps[side])
        if u in done[side]:
            continue
        done[side].add(u)
        settled += 1

        # The stopping rule. NOT "stop when the searches first touch" — the first
        # node settled by both is frequently not on the shortest path. The correct
        # condition is that the two frontiers can no longer combine to beat the
        # best complete path already seen.
        if d + heaps[other][0][0] >= best:
            break

        for v, w in adj[side].get(u, ()):
            nd = d + w
            if nd < dist[side].get(v, math.inf):
                dist[side][v] = nd
                prev[side][v] = u
                heapq.heappush(heaps[side], (nd, next(counter), v))
            # Every edge that reaches a node the other side has already settled
            # is a candidate complete path — record it and keep going.
            if v in dist[other]:
                total = nd + dist[other][v]
                if total < best:
                    best, meeting = total, v

    if meeting is None:
        return None
    return Result(cost=best, path=_stitch(prev, meeting, source, target),
                  settled=settled)


def _stitch(prev, meeting: str, source: str, target: str) -> list[str]:
    forward = [meeting]
    while forward[-1] != source:
        forward.append(prev[0][forward[-1]])
    forward.reverse()

    node = meeting
    while node != target:
        node = prev[1][node]
        forward.append(node)
    return forward
```

## How It Works

**The stopping rule is the entire correctness argument.** The tempting condition — stop as soon as some node has been settled by both searches — is wrong, and wrong in a way that produces a valid path with a suboptimal cost. The first node both searches reach is the first one cheap from *both* ends independently, which is not the same as being on the cheapest path between them. The correct rule compares the sum of the two frontier keys against the best complete path found so far: while that sum is below the best, some undiscovered combination could still beat it, and once it is not, nothing remaining can.

**Candidate paths are recorded on edge relaxation, not on settling.** A node can be relaxed from one side and already settled from the other, which forms a complete path even though neither search has finished with it. Checking only at settle time misses those and can terminate before the best path has been observed.

**The reverse adjacency is a separate structure.** On a one-way network `in_adj` is not derivable from `out_adj` by swapping arguments at query time without doing the same work; and more importantly, the backward search must follow edges *against* their direction, because it is asking "what can reach the target", not "what can the target reach". Building both at load time makes that explicit and costs one pass.

<svg viewBox="0 0 780 320" role="img" aria-labelledby="biStopTitle biStopDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="biStopTitle">Stopping at first contact returns a path that is valid and not shortest</title>
  <desc id="biStopDesc">A small network where the forward and backward searches first meet at node M, giving a complete path of cost 21. Continuing the search finds a second meeting at node N with a total cost of 18, which is the true shortest path. At the moment the searches touched at M, the sum of the two frontier keys was 13, well below the 21 found so far, so the correct stopping rule would not have terminated. Stopping at first contact returns the 21 route: a real path, three units too long, and indistinguishable from correct unless someone compares against a one-directional search.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="320" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">First contact is not the answer</text>
  <rect x="24" y="42" width="732" height="176" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.2"/>
  <g font-size="10" font-weight="700" text-anchor="middle">
    <circle cx="80" cy="130" r="16" fill="var(--accent,#0a656d)"/><text x="80" y="134" fill="var(--viz-on-pill,#ffffff)">S</text>
    <circle cx="700" cy="130" r="16" fill="var(--accent,#0a656d)"/><text x="700" y="134" fill="var(--viz-on-pill,#ffffff)">T</text>
    <circle cx="390" cy="82" r="15" fill="var(--viz-poor,#a8320f)"/><text x="390" y="86" fill="var(--viz-on-pill,#ffffff)">M</text>
    <circle cx="390" cy="180" r="15" fill="var(--viz-good,#0a656d)"/><text x="390" y="184" fill="var(--viz-on-pill,#ffffff)">N</text>
    <circle cx="235" cy="106" r="13" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/><text x="235" y="110" fill="currentColor">a</text>
    <circle cx="545" cy="106" r="13" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/><text x="545" y="110" fill="currentColor">b</text>
    <circle cx="235" cy="180" r="13" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/><text x="235" y="184" fill="currentColor">c</text>
    <circle cx="545" cy="180" r="13" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/><text x="545" y="184" fill="currentColor">d</text>
  </g>
  <g stroke="var(--viz-poor,#a8320f)" stroke-width="2.2" fill="none">
    <line x1="96" y1="126" x2="222" y2="110"/><line x1="248" y1="102" x2="376" y2="86"/>
    <line x1="404" y1="86" x2="532" y2="102"/><line x1="558" y1="110" x2="684" y2="126"/>
  </g>
  <g stroke="var(--viz-good,#0a656d)" stroke-width="2.6" fill="none">
    <line x1="94" y1="142" x2="222" y2="176"/><line x1="248" y1="180" x2="375" y2="180"/>
    <line x1="405" y1="180" x2="532" y2="180"/><line x1="558" y1="176" x2="686" y2="142"/>
  </g>
  <g font-size="9.5" text-anchor="middle" fill="var(--viz-ink-mute,#565f6d)">
    <text x="158" y="104">6</text><text x="312" y="80">5</text><text x="468" y="80">5</text><text x="622" y="104">5</text>
    <text x="158" y="172">4</text><text x="312" y="172">5</text><text x="468" y="172">4</text><text x="622" y="172">5</text>
  </g>
  <text x="390" y="62" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-poor,#a8320f)">first contact at M — total 21</text>
  <text x="390" y="208" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-good,#0a656d)">true shortest via N — total 18</text>
  <text x="24" y="248" font-size="11" font-weight="700" fill="currentColor">at the moment the searches touched at M</text>
  <text x="24" y="268" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">forward frontier key 6 + backward frontier key 7 = 13, which is below the 21 found so far — so the correct rule keeps going.</text>
  <text x="24" y="296" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">Stopping at contact returns a genuine path that is three units too long. Nothing about it looks wrong: it is connected,</text>
  <text x="24" y="312" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">it is drivable, and its cost is only detectably wrong against a reference search.</text>
</svg>

## Common Failure Patterns

**1. Alternating strictly rather than by frontier key.** Taking one step from each side in turn works, but it lets one search run far ahead when the graph is denser on that side, and the meeting point drifts away from the middle. Expanding whichever frontier currently has the smaller key keeps the two discs balanced, which is where the factor-of-two saving comes from.

**2. Reusing the forward adjacency for the backward search.** On an undirected graph this is harmless and on a road network it is a correctness bug: the backward search will happily travel the wrong way down one-way streets, and the route it returns cannot be driven. The symptom is a route that is shorter than the true optimum, which is the tell — a search that beats the reference is not faster, it is cheating.

```python
# WRONG: the backward search drives against the traffic.
adj = [g.out_adj, g.out_adj]

# RIGHT: backward follows in-edges, asking "what can reach here".
adj = [g.out_adj, g.in_adj]
```

**3. Comparing node ids in the heap.** Pushing `(dist, node)` makes Python compare node ids whenever two distances tie. With string ids that is merely non-deterministic; mix types and it raises mid-search. The monotonic counter as a second key removes the payload from the comparison entirely.

## Performance Notes

The saving comes from area, not from cleverness. A one-directional search settles everything within the optimal cost of the source; a bidirectional one settles everything within roughly half that cost of each endpoint:

$$\frac{|V_{\text{bi}}|}{|V_{\text{uni}}|} \approx \frac{2 \cdot (d/2)^{\alpha}}{d^{\alpha}} = 2^{1-\alpha}$$

with $\alpha$ near 2 for a planar road network, giving roughly half. In practice the observed reduction on real road graphs is between 40 and 60 per cent of settled nodes, and the wall-clock saving is slightly less because the bookkeeping is more involved.

That is a worthwhile constant-factor improvement and it is not a change in complexity — the search is still exploring a region proportional to the distance. Where that matters is on long-distance queries, and it is exactly where [contraction hierarchies](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/contraction-hierarchies-for-road-networks/) earn their preprocessing: they change the shape of the explored region rather than halving it. Bidirectional search is the right tool when preprocessing is unaffordable — a graph that changes continuously, or a cost function chosen per request — and the honest comparison is that it buys a factor of two where a hierarchy buys orders of magnitude at the cost of a build.

It also composes poorly with A\*. A bidirectional A\* needs both heuristics to be *consistent with each other*, not merely admissible individually, and the naive combination of a forward and a backward heuristic breaks the stopping rule in a way that is difficult to detect. If a heuristic is available and the graph is static, a hierarchy is usually the better next step; if the graph is dynamic, plain bidirectional Dijkstra is the safe one.

<svg viewBox="0 0 780 296" role="img" aria-labelledby="biAreaTitle biAreaDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="biAreaTitle">Why two half-radius discs cover half the area of one full-radius disc</title>
  <desc id="biAreaDesc">A one-directional search from the source grows a single disc that must reach the target, so its radius is the full route cost and its area is proportional to the square of that cost. A bidirectional search grows two discs that meet in the middle, each of half the radius, so each has a quarter of the area and the two together have half. On a road network the shapes are not circles and the observed reduction is between 40 and 60 per cent of settled nodes, but the reasoning and the order of magnitude hold.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="296" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Explored area for the same route</text>
  <rect x="24" y="42" width="356" height="184" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-poor,#a8320f)" stroke-width="1.6"/>
  <text x="202" y="66" text-anchor="middle" font-size="11.5" font-weight="700" fill="var(--viz-poor,#a8320f)">one-directional</text>
  <circle cx="122" cy="146" r="84" fill="var(--viz-poor,#a8320f)" opacity="0.2"/>
  <circle cx="122" cy="146" r="84" fill="none" stroke="var(--viz-poor,#a8320f)" stroke-width="1.8"/>
  <circle cx="122" cy="146" r="7" fill="var(--accent,#0a656d)"/>
  <text x="122" y="170" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--accent,#0a656d)">S</text>
  <circle cx="206" cy="146" r="7" fill="var(--accent,#0a656d)"/>
  <text x="206" y="170" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--accent,#0a656d)">T</text>
  <text x="202" y="212" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--viz-poor,#a8320f)">area ∝ d²</text>
  <rect x="400" y="42" width="356" height="184" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="1.8"/>
  <text x="578" y="66" text-anchor="middle" font-size="11.5" font-weight="700" fill="var(--viz-good,#0a656d)">bidirectional</text>
  <circle cx="498" cy="146" r="42" fill="var(--viz-good,#0a656d)" opacity="0.2"/>
  <circle cx="498" cy="146" r="42" fill="none" stroke="var(--viz-good,#0a656d)" stroke-width="1.8"/>
  <circle cx="582" cy="146" r="42" fill="var(--viz-good,#0a656d)" opacity="0.2"/>
  <circle cx="582" cy="146" r="42" fill="none" stroke="var(--viz-good,#0a656d)" stroke-width="1.8"/>
  <circle cx="498" cy="146" r="7" fill="var(--accent,#0a656d)"/>
  <text x="498" y="170" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--accent,#0a656d)">S</text>
  <circle cx="582" cy="146" r="7" fill="var(--accent,#0a656d)"/>
  <text x="582" y="170" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--accent,#0a656d)">T</text>
  <text x="578" y="212" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--viz-good,#0a656d)">2 × (d/2)² = d²/2</text>
  <text x="24" y="256" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">A factor of two, not a change of complexity — the region still grows with the square of the distance. That distinction is</text>
  <text x="24" y="272" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">what decides whether this is enough or whether the workload needs a preprocessed hierarchy.</text>
</svg>

One test is worth writing before this goes anywhere near production, because the failure mode of a wrong stopping rule is a path rather than an error. Run the bidirectional search and a plain one-directional Dijkstra over the same graph for a few hundred random source-target pairs and assert the costs are equal to within a floating-point tolerance. Equality of *cost* is the assertion, not equality of path — ties mean two different routes can both be optimal, and asserting on the node sequence produces flaky failures that mask the real one.

That comparison also catches the reverse-adjacency bug, and catches it in a distinctive way: a backward search that ignores one-way restrictions finds routes the forward search cannot, so the bidirectional cost comes out *lower* than the reference. A result that beats a correct algorithm is never good news, and recognising that signature saves a long investigation into why the faster implementation is also better.

## Related

- [Routing Algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/routing-algorithms-python/) — where this sits among Dijkstra, A* and the hierarchies.
- [Implementing A* with a Haversine Heuristic in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/routing-algorithms-python/implementing-astar-with-a-haversine-heuristic-in-python/) — the other way to shrink the explored region, and why the two do not combine naively.
- [Contraction Hierarchies for Road Networks](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/contraction-hierarchies-for-road-networks/) — preprocessing that changes the shape rather than the size of the search.
- [Many-to-Many Cost Matrices with Neo4j GDS](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/multi-modal-and-fleet-routing/many-to-many-cost-matrices-with-gds/) — where point-to-point search is the wrong primitive entirely.

This guide is part of [Routing Algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/routing-algorithms-python/), within [Network Routing Algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/).
