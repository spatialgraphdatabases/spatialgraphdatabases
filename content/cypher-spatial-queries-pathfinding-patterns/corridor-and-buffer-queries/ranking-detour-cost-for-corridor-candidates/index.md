---
pageTitle: Ranking Detour Cost
title: Ranking Detour Cost for Corridor Candidates
description: Replace perpendicular distance with the extra driving time a stop actually costs, using a two-leg routing query and a cheap lower bound to avoid running it on everything.
slug: ranking-detour-cost-for-corridor-candidates
type: article
breadcrumb: Detour Cost
datePublished: 2026-08-11
dateModified: 2026-08-11
---
# Ranking Detour Cost for Corridor Candidates

A corridor query gives you fifty charging stations within two kilometres of the route. Sorting them by that distance produces a list whose top entry is frequently the worst choice on it: four hundred metres away, on the far side of a dual carriageway, reachable only by a junction three kilometres back. The number a driver cares about is not how close the stop is — it is how much longer the trip becomes if they use it. That is a routing question, not a geometric one, and the reason it does not get asked is that running two shortest-path queries per candidate is expensive. This page makes it affordable: compute a cheap lower bound first, use it to eliminate most candidates without routing them at all, and route only the survivors.

## Prerequisites & Versions

The detour legs use ordinary weighted shortest paths, so either a GDS projection or hand-written Cypher works. The bound is pure Python.

| Requirement | Minimum version | Install |
| --- | --- | --- |
| Python | 3.11 | — |
| neo4j (async driver) | 5.20 | `pip install "neo4j>=5.20"` |
| Neo4j Server | 5.15 | native `point` |
| Graph Data Science | 2.6 | optional, for the resident-projection path |

## Implementation

The ranker takes the corridor's candidate set and the route, computes a lower bound per candidate, and routes only those whose bound leaves them able to beat the current best.

```python
import asyncio
import math
from dataclasses import dataclass

from neo4j import AsyncGraphDatabase

EARTH_R = 6_371_008.8

DETOUR = """
MATCH (entry:Junction {id: $entry_id}), (stop:Junction {id: $stop_id}),
      (rejoin:Junction {id: $rejoin_id})
CALL gds.shortestPath.dijkstra.stream($graph, {
  sourceNode: entry, targetNode: stop, relationshipWeightProperty: 'drive_s'
}) YIELD totalCost AS to_stop
CALL gds.shortestPath.dijkstra.stream($graph, {
  sourceNode: stop, targetNode: rejoin, relationshipWeightProperty: 'drive_s'
}) YIELD totalCost AS from_stop
RETURN to_stop + from_stop AS via_cost
"""


@dataclass(frozen=True)
class Candidate:
    id: str
    lat: float
    lon: float
    entry_id: str      # nearest route junction before the stop
    rejoin_id: str     # nearest route junction after it
    on_route_s: float  # cost of the route between those two junctions


@dataclass(frozen=True)
class Ranked:
    candidate: Candidate
    detour_s: float
    bound_s: float
    routed: bool


def lower_bound_s(c: Candidate, max_mps: float) -> float:
    """A detour can never be cheaper than the straight-line there-and-back.

    Straight-line distance divided by the network's top speed is a strict
    underestimate of driving time, so a candidate whose BOUND already exceeds
    the best known real detour cannot possibly win, and never needs routing.
    This is the same admissibility argument an A* heuristic rests on.
    """
    entry_leg = _haversine(c.lat, c.lon, c.entry_lat, c.entry_lon)
    exit_leg = _haversine(c.lat, c.lon, c.rejoin_lat, c.rejoin_lon)
    return max(0.0, (entry_leg + exit_leg) / max_mps - c.on_route_s)


def _haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_R * math.asin(math.sqrt(a))


class DetourRanker:
    def __init__(self, uri: str, auth: tuple[str, str], graph: str,
                 max_mps: float = 33.0) -> None:
        self._driver = AsyncGraphDatabase.driver(uri, auth=auth)
        self._graph = graph
        self._max_mps = max_mps

    async def close(self) -> None:
        await self._driver.close()

    async def rank(self, candidates: list[Candidate], top_k: int = 5) -> list[Ranked]:
        # Cheapest bound first: routing in bound order means the best real answer
        # is found early, which raises the cut-off that eliminates everything else.
        ordered = sorted(candidates, key=lambda c: lower_bound_s(c, self._max_mps))

        results: list[Ranked] = []
        worst_kept = math.inf

        async with self._driver.session() as session:
            for c in ordered:
                bound = lower_bound_s(c, self._max_mps)
                if len(results) >= top_k and bound >= worst_kept:
                    # Every remaining candidate has a bound at least this large,
                    # so none of them can enter the top k. Stop entirely.
                    results.append(Ranked(c, detour_s=math.inf, bound_s=bound,
                                          routed=False))
                    continue

                record = await (await session.run(
                    DETOUR, graph=self._graph, entry_id=c.entry_id,
                    stop_id=c.id, rejoin_id=c.rejoin_id,
                )).single()

                detour = float(record["via_cost"]) - c.on_route_s if record else math.inf
                results.append(Ranked(c, detour_s=detour, bound_s=bound, routed=True))

                kept = sorted((r for r in results if r.routed),
                              key=lambda r: r.detour_s)[:top_k]
                if len(kept) >= top_k:
                    worst_kept = kept[-1].detour_s

        return sorted(results, key=lambda r: r.detour_s)


async def main() -> None:
    ranker = DetourRanker("neo4j://localhost:7687", ("neo4j", "password"),
                          graph="road-network")
    try:
        ranked = await ranker.rank(await load_corridor_candidates(), top_k=5)
    finally:
        await ranker.close()

    routed = sum(1 for r in ranked if r.routed)
    print(f"routed {routed} of {len(ranked)} candidates")
    for r in ranked[:5]:
        print(f"{r.candidate.id:<24}+{r.detour_s / 60:5.1f} min "
              f"(bound {r.bound_s / 60:4.1f})")
```

## How It Works

The whole saving comes from one property of the bound: it is never larger than the truth.

**The bound underestimates by construction.** Straight-line distance to the stop and back, divided by the network's maximum speed, is a distance no vehicle can beat and a speed no vehicle can exceed. So the real detour is always at least the bound. That is the same admissibility condition an [A* heuristic](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/routing-algorithms-python/implementing-astar-with-a-haversine-heuristic-in-python/) has to satisfy, and it licenses exactly the same pruning: a candidate whose bound already exceeds the worst detour currently in the top *k* cannot enter the top *k*, whatever routing would say.

**Routing in bound order makes the pruning bite early.** Processing candidates from cheapest bound upward means the genuinely good options are routed first, which pushes the cut-off down quickly. Once *k* real answers are in hand, every remaining candidate is tested against a threshold that is already tight, and on a typical corridor the loop stops after routing a handful.

**The detour is measured against the route, not from the origin.** `via_cost - on_route_s` is the *extra* time: the cost of leaving the route at the entry junction, reaching the stop, and rejoining, minus what the route would have cost between those two junctions anyway. That subtraction is what makes a stop directly on the route come out at nearly zero rather than at the full length of the leg.

<svg viewBox="0 0 780 320" role="img" aria-labelledby="detourWhyTitle detourWhyDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="detourWhyTitle">Perpendicular distance and detour cost disagree, and the disagreement is the point</title>
  <desc id="detourWhyDesc">Two candidate stops against the same route. Station A sits 400 metres from the route but on the far side of a divided highway, so reaching it means continuing to the next interchange, doubling back, and returning — an eleven minute detour. Station B sits 1,600 metres away but directly off a junction the route already passes, costing three minutes. Ranked by perpendicular distance A comes first and is the worse choice by a factor of nearly four; ranked by detour cost the order reverses, which is the order a driver would choose.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="320" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Closer is not cheaper</text>
  <rect x="24" y="42" width="732" height="188" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.2"/>
  <line x1="60" y1="128" x2="720" y2="128" stroke="var(--viz-stroke,#9ca3af)" stroke-width="10" stroke-linecap="round"/>
  <line x1="60" y1="124" x2="720" y2="124" stroke="var(--accent,#0a656d)" stroke-width="2.4"/>
  <line x1="60" y1="132" x2="720" y2="132" stroke="var(--viz-stroke,#9ca3af)" stroke-width="2.4" stroke-dasharray="6 5"/>
  <text x="90" y="112" font-size="10" font-weight="700" fill="var(--accent,#0a656d)">direction of travel</text>
  <text x="640" y="150" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">central barrier</text>
  <circle cx="300" cy="168" r="8" fill="var(--viz-poor,#a8320f)"/>
  <text x="300" y="192" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--viz-poor,#a8320f)">Station A</text>
  <text x="300" y="206" text-anchor="middle" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">400 m perpendicular</text>
  <line x1="300" y1="160" x2="300" y2="136" stroke="var(--viz-poor,#a8320f)" stroke-width="1.4" stroke-dasharray="4 3"/>
  <path d="M300 128 H540 V96 H300 V72" fill="none" stroke="var(--viz-poor,#a8320f)" stroke-width="2" stroke-dasharray="7 4"/>
  <text x="546" y="92" font-size="9.5" font-weight="700" fill="var(--viz-poor,#a8320f)">next interchange, then back</text>
  <circle cx="588" cy="196" r="8" fill="var(--viz-good,#0a656d)"/>
  <text x="588" y="220" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--viz-good,#0a656d)">Station B</text>
  <text x="588" y="234" text-anchor="middle" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">1,600 m perpendicular</text>
  <path d="M540 132 V196 H580" fill="none" stroke="var(--viz-good,#0a656d)" stroke-width="2"/>
  <text x="24" y="262" font-size="11" font-weight="700" fill="currentColor">ranked by perpendicular distance</text>
  <g font-size="10.5" font-weight="700" text-anchor="middle">
    <rect x="300" y="248" width="120" height="22" rx="11" fill="var(--viz-poor,#a8320f)"/><text x="360" y="264" fill="var(--viz-on-pill,#ffffff)">A then B</text>
  </g>
  <text x="436" y="264" font-size="10" fill="var(--viz-ink-mute,#565f6d)">recommends an 11-minute detour over a 3-minute one</text>
  <text x="24" y="296" font-size="11" font-weight="700" fill="currentColor">ranked by detour cost</text>
  <g font-size="10.5" font-weight="700" text-anchor="middle">
    <rect x="300" y="282" width="120" height="22" rx="11" fill="var(--viz-good,#0a656d)"/><text x="360" y="298" fill="var(--viz-on-pill,#ffffff)">B then A</text>
  </g>
  <text x="436" y="298" font-size="10" fill="var(--viz-ink-mute,#565f6d)">the order a driver would have chosen unaided</text>
</svg>

## Common Failure Patterns

**1. A bound that is not admissible.** Dividing by an average speed rather than the maximum makes the bound an overestimate for fast roads, and an overestimate prunes candidates that would have won. The symptom is subtle: the ranking is still plausible, just occasionally missing the best option, and it will never be noticed without comparing against an unpruned run.

```python
# WRONG: average speed overestimates the bound on motorway legs and prunes winners.
bound = (entry_leg + exit_leg) / mean_mps

# RIGHT: the network's top speed underestimates, which is what pruning requires.
bound = (entry_leg + exit_leg) / max_mps
```

**2. Entry and rejoin junctions chosen by proximity to the stop.** The nearest route junction to a candidate may be behind it in the direction of travel, which produces a "detour" that includes driving backwards along the route. Pick the entry as the last route junction *before* the stop's projection onto the polyline, and the rejoin as the first one after it.

**3. Forgetting that the two legs are directed.** On a one-way network the cost from entry to stop is not the cost from stop to entry, and computing one leg and doubling it understates detours in exactly the situation this page exists to catch. Route both legs.

## Performance Notes

The saving is entirely in how many candidates get routed:

$$C \approx N \cdot c_{\text{bound}} + R \cdot 2 c_{\text{route}}, \qquad R \ll N$$

With $c_{\text{bound}}$ a few microseconds of trigonometry and $c_{\text{route}}$ a bounded Dijkstra, the second term dominates and $R$ is what matters. On real corridors, ordering by bound and stopping once the top *k* is safe typically routes somewhere between five and fifteen per cent of the candidate set — the rest are eliminated arithmetically.

Two things make $R$ smaller. **A tight `top_k`** raises the cut-off faster, so asking for the best three prunes far harder than asking for the best twenty. And **a resident projection** removes the per-leg projection cost entirely, which matters because this pattern issues many small routing queries rather than one large one — precisely the shape where a per-request projection is most wasteful, as the [projection heap guide](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-memory-and-storage-tuning/tuning-jvm-heap-for-gds-projections/) sets out.

The legs are short by construction, since entry and rejoin are both on the route near the candidate. That means a bidirectional search or a contraction hierarchy is overkill here — the win from [contraction hierarchies](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/contraction-hierarchies-for-road-networks/) comes on long-distance queries, and these are the opposite.

<svg viewBox="0 0 780 288" role="img" aria-labelledby="detourPruneTitle detourPruneDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="detourPruneTitle">Routing in bound order stops after a fraction of the candidates</title>
  <desc id="detourPruneDesc">Fifty corridor candidates ordered by their lower bound. The first few are routed and produce real detour costs, which establishes a cut-off equal to the worst of the current top five. Every candidate whose bound already exceeds that cut-off is eliminated without being routed, and because the list is in bound order the eliminations are contiguous from that point to the end. Here seven candidates are routed and forty-three are dismissed arithmetically.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="288" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">50 candidates, ordered by lower bound</text>
  <line x1="72" y1="48" x2="72" y2="196" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <line x1="72" y1="196" x2="736" y2="196" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <text x="404" y="238" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">candidates in bound order</text>
  <text x="40" y="126" font-size="10" font-weight="700" fill="currentColor" transform="rotate(-90 40 126)">detour</text>
  <line x1="72" y1="128" x2="736" y2="128" stroke="var(--viz-ok,#7d6200)" stroke-width="1.8" stroke-dasharray="6 4"/>
  <text x="736" y="120" text-anchor="end" font-size="9.5" font-weight="700" fill="var(--viz-ok,#7d6200)">cut-off = worst of the current top 5</text>
  <path d="M72 190 L152 172 L232 152 L312 136 L392 118 L472 96 L552 76 L640 62 L736 52" fill="none" stroke="var(--accent-3,#5b21b6)" stroke-width="2.4" stroke-dasharray="5 4"/>
  <text x="600" y="80" text-anchor="end" font-size="9.5" font-weight="700" fill="var(--accent-3,#5b21b6)">lower bound — monotone by construction</text>
  <g fill="var(--viz-good,#0a656d)">
    <circle cx="86" cy="178" r="5"/><circle cx="110" cy="164" r="5"/><circle cx="134" cy="182" r="5"/><circle cx="158" cy="158" r="5"/>
    <circle cx="182" cy="170" r="5"/><circle cx="206" cy="146" r="5"/><circle cx="230" cy="150" r="5"/>
  </g>
  <rect x="72" y="48" width="172" height="148" fill="var(--viz-good,#0a656d)" opacity="0.09"/>
  <text x="158" y="216" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--viz-good,#0a656d)">7 routed</text>
  <rect x="244" y="48" width="492" height="148" fill="var(--viz-stroke,#9ca3af)" opacity="0.1"/>
  <text x="490" y="216" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--viz-ink-mute,#565f6d)">43 eliminated without routing — bound already above the cut-off</text>
  <text x="24" y="266" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">Because the bound is monotone and never overestimates, the first candidate that fails the test guarantees all the rest fail too.</text>
</svg>

One last practical point about the bound's tightness. A very loose bound — one computed with an unrealistically high top speed, say — is still admissible and still correct, but it prunes almost nothing, and the whole approach collapses back into routing everything. The useful setting is the fastest speed the network genuinely supports, not the fastest speed physically imaginable, because every kilometre per hour of headroom you leave in the divisor is pruning power given away. Deriving it from the maximum `drive_s` per metre actually present in the graph, rather than from a legal speed limit, keeps it both admissible and tight.

## Related

- [Corridor and Buffer Queries Along a Route](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/corridor-and-buffer-queries/) — where the candidate set this ranks comes from.
- [Implementing A* with a Haversine Heuristic in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/routing-algorithms-python/implementing-astar-with-a-haversine-heuristic-in-python/) — the admissibility argument the bound reuses.
- [Tuning JVM Heap for GDS Projections](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-memory-and-storage-tuning/tuning-jvm-heap-for-gds-projections/) — why many small routing calls want a resident projection.
- [K-Nearest Neighbor Routing](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/k-nearest-neighbor-routing/) — the same "geometric candidates, routed ranking" two-phase shape from a point rather than a route.

This guide is part of [Corridor and Buffer Queries Along a Route](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/corridor-and-buffer-queries/), within [Cypher Spatial Queries & Pathfinding Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/).
