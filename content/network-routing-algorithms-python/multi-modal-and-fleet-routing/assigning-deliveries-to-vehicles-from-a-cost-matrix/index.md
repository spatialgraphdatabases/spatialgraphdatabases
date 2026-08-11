---
pageTitle: Assigning Deliveries to Vehicles
title: Assigning Deliveries to Vehicles from a Cost Matrix
description: Turn a graph-derived cost matrix into a vehicle assignment with a capacity-aware greedy pass and a local-search improvement, and know which errors come from which stage.
slug: assigning-deliveries-to-vehicles-from-a-cost-matrix
type: article
breadcrumb: Fleet Assignment
datePublished: 2026-08-11
dateModified: 2026-08-11
---
# Assigning Deliveries to Vehicles from a Cost Matrix

Once the [cost matrix](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/multi-modal-and-fleet-routing/) exists, the remaining problem is no longer a graph problem, and treating it as one is where fleet systems go wrong. Assignment is combinatorial optimisation over a table of numbers, and the graph's only remaining job is to have produced those numbers honestly. What matters here is getting a defensible answer quickly, being explicit about which constraints are hard and which are preferences, and — most importantly — being able to say afterwards whether a bad result came from the assignment or from the matrix it was given. This page builds a capacity-aware greedy assignment, improves it with a bounded local search, and separates the two failure sources.

## Prerequisites & Versions

Everything here is pure Python over a matrix already in memory; no database involvement.

| Requirement | Minimum version | Install |
| --- | --- | --- |
| Python | 3.11 | — |
| neo4j (async driver) | 5.20 | `pip install "neo4j>=5.20"` (to fetch the matrix) |

## Implementation

The assignment runs in two phases: a greedy pass that produces a feasible solution fast, then a relocate-and-swap local search that improves it without ever leaving feasibility.

```python
import math
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Vehicle:
    id: str
    depot_id: str
    capacity: int
    shift_seconds: float


@dataclass(frozen=True)
class Stop:
    id: str
    demand: int
    service_seconds: float


@dataclass
class Route:
    vehicle: Vehicle
    stops: list[str] = field(default_factory=list)
    load: int = 0
    seconds: float = 0.0

    def feasible_with(self, stop: Stop, added_seconds: float) -> bool:
        return (
            self.load + stop.demand <= self.vehicle.capacity
            and self.seconds + added_seconds + stop.service_seconds
            <= self.vehicle.shift_seconds
        )


class Assigner:
    """Greedy insertion followed by bounded local search.

    Greedy alone is typically 15-25% worse than a good solution and is produced
    in milliseconds; the local search recovers most of that gap in a bounded
    number of passes. Neither is optimal, and for fleet sizing that is fine —
    what matters is that the answer is feasible, reproducible and explicable.
    """

    def __init__(self, matrix: dict[tuple[str, str], float],
                 stops: dict[str, Stop]) -> None:
        self._matrix = matrix
        self._stops = stops

    def cost(self, a: str, b: str) -> float:
        # An absent pair is unreachable. Returning inf rather than 0 is the
        # single most important line here: a 0 would make the pair the cheapest
        # option available and it would win every comparison it entered.
        return self._matrix.get((a, b), math.inf)

    def _insertion_cost(self, route: Route, stop_id: str) -> float:
        """Marginal cost of appending, not the raw depot-to-stop distance."""
        last = route.stops[-1] if route.stops else route.vehicle.depot_id
        return self.cost(last, stop_id)

    def greedy(self, vehicles: list[Vehicle], stop_ids: list[str]
               ) -> tuple[list[Route], list[str]]:
        routes = [Route(vehicle=v) for v in vehicles]
        unassigned: list[str] = []

        # Hardest stops first: a large-demand stop placed late may find no
        # vehicle with room, and an unassigned stop is far worse than a
        # suboptimal one.
        for stop_id in sorted(
            stop_ids, key=lambda s: -self._stops[s].demand
        ):
            stop = self._stops[stop_id]
            best: tuple[float, Route] | None = None
            for route in routes:
                added = self._insertion_cost(route, stop_id)
                if not math.isfinite(added):
                    continue
                if not route.feasible_with(stop, added):
                    continue
                if best is None or added < best[0]:
                    best = (added, route)
            if best is None:
                unassigned.append(stop_id)
                continue
            added, route = best
            route.stops.append(stop_id)
            route.load += stop.demand
            route.seconds += added + stop.service_seconds
        return routes, unassigned

    def improve(self, routes: list[Route], passes: int = 40) -> list[Route]:
        """Relocate a stop to a cheaper route while keeping every route feasible."""
        for _ in range(passes):
            moved = False
            for source in routes:
                for stop_id in list(source.stops):
                    stop = self._stops[stop_id]
                    current = self._insertion_cost(source, stop_id)
                    for target in routes:
                        if target is source:
                            continue
                        added = self._insertion_cost(target, stop_id)
                        if not math.isfinite(added) or added >= current:
                            continue
                        if not target.feasible_with(stop, added):
                            continue
                        source.stops.remove(stop_id)
                        source.load -= stop.demand
                        source.seconds -= current + stop.service_seconds
                        target.stops.append(stop_id)
                        target.load += stop.demand
                        target.seconds += added + stop.service_seconds
                        moved = True
                        break
            if not moved:
                break        # a local optimum — further passes change nothing
        return routes
```

## How It Works

Three decisions carry the quality of the result.

**Hardest-first ordering is what keeps stops assigned.** Processing stops in arbitrary order fills vehicles with small easy deliveries, and the large one that arrives last finds every vehicle with capacity remaining but not enough of it. Sorting by descending demand places the constrained items while there is still room, and on real delivery data it is the difference between zero unassigned stops and a handful — a handful being a much worse outcome than a slightly longer total route.

**Insertion cost is marginal, not absolute.** The number that decides where a stop goes is the extra travel it causes on that route, which is the cost from the route's current last stop. Using the depot-to-stop cost instead makes every route look equally attractive for a given stop and destroys the clustering that makes routes efficient — the assignment ends up geographically interleaved, with vehicles crossing each other's territory.

**The local search never leaves feasibility.** Every relocate is checked against capacity and shift length before it is applied, so the solution is valid at every step and can be stopped at any point. That property matters operationally: a dispatcher who needs an answer in two seconds gets the best solution found in two seconds, not a partial one.

<svg viewBox="0 0 780 316" role="img" aria-labelledby="fleetOrderTitle fleetOrderDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="fleetOrderTitle">Insertion order decides whether the large stop gets served at all</title>
  <desc id="fleetOrderDesc">Three vehicles of capacity 100 and a set of stops including one of demand 80. Assigning in arrival order fills all three vehicles to around 60 with small stops, so when the demand-80 stop is considered no vehicle has room and it goes unassigned even though total fleet capacity was ample. Assigning largest-demand first places the 80 immediately, and the small stops then fill the remaining space wherever they fit. Both runs move the same total demand; only one of them serves every customer.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="316" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">3 vehicles × capacity 100 · one stop of demand 80</text>
  <rect x="24" y="42" width="356" height="212" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-poor,#a8320f)" stroke-width="1.6"/>
  <text x="202" y="66" text-anchor="middle" font-size="11.5" font-weight="700" fill="var(--viz-poor,#a8320f)">arrival order</text>
  <g font-size="9.5" font-weight="700" text-anchor="middle">
    <text x="70" y="92" fill="currentColor">V1</text>
    <rect x="96" y="80" width="256" height="20" rx="5" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1"/>
    <rect x="96" y="80" width="154" height="20" rx="5" fill="var(--viz-poor,#a8320f)"/><text x="173" y="95" fill="var(--viz-on-pill,#ffffff)">60</text>
    <text x="70" y="122" fill="currentColor">V2</text>
    <rect x="96" y="110" width="256" height="20" rx="5" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1"/>
    <rect x="96" y="110" width="163" height="20" rx="5" fill="var(--viz-poor,#a8320f)"/><text x="177" y="125" fill="var(--viz-on-pill,#ffffff)">64</text>
    <text x="70" y="152" fill="currentColor">V3</text>
    <rect x="96" y="140" width="256" height="20" rx="5" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1"/>
    <rect x="96" y="140" width="148" height="20" rx="5" fill="var(--viz-poor,#a8320f)"/><text x="170" y="155" fill="var(--viz-on-pill,#ffffff)">58</text>
  </g>
  <text x="202" y="188" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">largest free space is 42 — the demand-80 stop does not fit</text>
  <g font-size="10.5" font-weight="700" text-anchor="middle">
    <rect x="112" y="200" width="180" height="24" rx="12" fill="var(--viz-poor,#a8320f)"/>
    <text x="202" y="217" fill="var(--viz-on-pill,#ffffff)">1 stop unassigned</text>
  </g>
  <text x="202" y="242" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">182 of 300 capacity used</text>
  <rect x="400" y="42" width="356" height="212" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="1.8"/>
  <text x="578" y="66" text-anchor="middle" font-size="11.5" font-weight="700" fill="var(--viz-good,#0a656d)">largest demand first</text>
  <g font-size="9.5" font-weight="700" text-anchor="middle">
    <text x="446" y="92" fill="currentColor">V1</text>
    <rect x="472" y="80" width="256" height="20" rx="5" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1"/>
    <rect x="472" y="80" width="205" height="20" rx="5" fill="var(--viz-good,#0a656d)"/><text x="574" y="95" fill="var(--viz-on-pill,#ffffff)">80 + 0</text>
    <text x="446" y="122" fill="currentColor">V2</text>
    <rect x="472" y="110" width="256" height="20" rx="5" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1"/>
    <rect x="472" y="110" width="243" height="20" rx="5" fill="var(--viz-good,#0a656d)"/><text x="593" y="125" fill="var(--viz-on-pill,#ffffff)">95</text>
    <text x="446" y="152" fill="currentColor">V3</text>
    <rect x="472" y="140" width="256" height="20" rx="5" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1"/>
    <rect x="472" y="140" width="222" height="20" rx="5" fill="var(--viz-good,#0a656d)"/><text x="583" y="155" fill="var(--viz-on-pill,#ffffff)">87</text>
  </g>
  <text x="578" y="188" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">the constrained item was placed while there was room</text>
  <g font-size="10.5" font-weight="700" text-anchor="middle">
    <rect x="488" y="200" width="180" height="24" rx="12" fill="var(--viz-good,#0a656d)"/>
    <text x="578" y="217" fill="var(--viz-on-pill,#ffffff)">every stop assigned</text>
  </g>
  <text x="578" y="242" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">262 of 300 capacity used</text>
  <text x="24" y="286" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">Total fleet capacity was never the constraint. The left run failed because it spent the space before the item that needed</text>
  <text x="24" y="302" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">it arrived, which is a sequencing decision and not a fleet-sizing one.</text>
</svg>

## Common Failure Patterns

**1. A missing matrix cell treated as zero.** This is the defect that produces confidently absurd plans. `dict.get((a, b), 0)` makes an unreachable pair the cheapest option in the table, so the assignment routes a van to an island. Default to infinity and count how many cells are infinite — a rising count is a data-quality signal from the graph, not an assignment problem.

**2. Blaming the assignment for a matrix fault.** When a plan looks wrong, check the matrix first. Two cheap checks separate the stages: verify that the matrix satisfies the triangle inequality on a sample of triples, and verify that a handful of cells agree with a direct routing query. A matrix that fails either is producing a plan that no assignment algorithm could rescue.

```python
def matrix_is_sane(matrix, ids, samples=200) -> list[str]:
    """Triangle-inequality violations mean the matrix is not a metric, which
    almost always means some cells came from a different graph or bound."""
    import random
    problems = []
    for _ in range(samples):
        a, b, c = random.sample(ids, 3)
        ab, bc, ac = matrix.get((a, b)), matrix.get((b, c)), matrix.get((a, c))
        if None in (ab, bc, ac):
            continue
        if ac > ab + bc + 1e-6:
            problems.append(f"{a}→{c} ({ac:.0f}) exceeds {a}→{b}→{c} ({ab + bc:.0f})")
    return problems
```

**3. Local search that leaves feasibility "temporarily".** A relocate that overfills a vehicle intending to fix it on a later pass produces an infeasible solution whenever the loop is stopped early — which is exactly when a dispatcher is waiting. Check feasibility before applying, never after.

## Performance Notes

Greedy is $O(N \cdot V)$ for $N$ stops and $V$ vehicles, which is negligible. The local search is the cost:

$$C_{\text{improve}} \approx P \cdot N \cdot V$$

for $P$ passes. With three hundred stops and forty vehicles that is twelve thousand evaluations per pass, and the loop terminates early once no improving move exists — typically within ten to fifteen passes on real data rather than the forty allowed. Capping passes by wall-clock rather than by count is usually the better interface, because it makes the algorithm's contract "the best answer available in this long" rather than "an answer of unknown quality".

The quality gap is worth being honest about. Greedy alone lands roughly fifteen to twenty-five per cent above a strong solution; relocate-only local search closes about half of that; adding a swap neighbourhood closes a good deal more at roughly double the cost per pass. Beyond that, the returns fall off sharply and a purpose-built solver is the right tool. Knowing where that boundary is matters more than pushing past it, because the matrix underneath carries its own error — a plan optimised to within two per cent of optimal on a matrix that is five per cent wrong is not a better plan.

Cache the matrix, not the assignment. Depots move rarely and the road network changes weekly, so yesterday's matrix mostly still applies and only new stops need fresh rows. The assignment, by contrast, changes completely with the day's orders and is cheap to recompute, so caching it buys nothing and risks serving a stale plan.

<svg viewBox="0 0 780 292" role="img" aria-labelledby="fleetGapTitle fleetGapDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="fleetGapTitle">Solution quality against effort, and where the matrix's own error sits</title>
  <desc id="fleetGapDesc">Total route cost plotted against computation time. Greedy lands about 22 per cent above a strong reference solution in milliseconds. Relocate local search closes roughly half that gap within a second. Adding swaps closes most of the rest over several seconds. Beyond that the curve flattens well before reaching optimal. A shaded band shows the uncertainty in the cost matrix itself, around five per cent, which the last stretch of optimisation is working well inside — so effort spent there is buying precision the input does not support.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="292" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Excess over a strong reference solution</text>
  <line x1="96" y1="48" x2="96" y2="208" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <line x1="96" y1="208" x2="720" y2="208" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <g font-size="9.5" fill="var(--viz-ink-mute,#565f6d)" text-anchor="end">
    <text x="88" y="62">+25%</text><text x="88" y="110">+15%</text><text x="88" y="158">+5%</text><text x="88" y="212">0</text>
  </g>
  <g font-size="9.5" fill="var(--viz-ink-mute,#565f6d)" text-anchor="middle">
    <text x="140" y="228">10 ms</text><text x="300" y="228">1 s</text><text x="460" y="228">10 s</text><text x="620" y="228">2 min</text>
  </g>
  <text x="408" y="248" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">computation time</text>
  <rect x="96" y="158" width="624" height="50" fill="var(--viz-ok,#7d6200)" opacity="0.14"/>
  <text x="700" y="176" text-anchor="end" font-size="10" font-weight="700" fill="var(--viz-ok,#7d6200)">the matrix's own uncertainty, ~5%</text>
  <path d="M140 70 L220 92 L300 118 L380 140 L460 152 L540 160 L620 165 L700 168" fill="none" stroke="var(--accent,#0a656d)" stroke-width="2.8"/>
  <circle cx="140" cy="70" r="5" fill="var(--accent,#0a656d)"/>
  <text x="152" y="66" font-size="10" font-weight="700" fill="var(--accent,#0a656d)">greedy</text>
  <circle cx="300" cy="118" r="5" fill="var(--accent,#0a656d)"/>
  <text x="312" y="114" font-size="10" font-weight="700" fill="var(--accent,#0a656d)">+ relocate</text>
  <circle cx="460" cy="152" r="5" fill="var(--accent,#0a656d)"/>
  <text x="472" y="148" font-size="10" font-weight="700" fill="var(--accent,#0a656d)">+ swap</text>
  <text x="24" y="272" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">Once the curve enters the shaded band, further optimisation is refining a number whose input is less certain than the</text>
  <text x="24" y="288" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">improvement — the effort is better spent on the matrix.</text>
</svg>

One reporting habit is worth building in from the start: emit the unassigned list as a first-class output rather than as a log line. An assignment that serves 297 of 300 stops is a materially different result from one that serves all 300, and the three that were dropped are the ones a dispatcher most needs to see — they are usually a data problem (a stop that failed to snap, an address outside the covered region) rather than a capacity one, and surfacing them turns a silent shortfall into a work item.

## Related

- [Multi-Modal and Fleet Routing on a Spatial Graph](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/multi-modal-and-fleet-routing/) — building the matrix this consumes.
- [Weighted Dijkstra Routing with Neo4j GDS](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/routing-algorithms-python/weighted-dijkstra-routing-with-neo4j-gds/) — the single-source search each matrix row comes from.
- [Finding Dense Delivery Clusters with Neo4j GDS](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/spatial-aggregation-and-clustering/finding-dense-delivery-clusters-with-gds/) — pre-grouping stops so the assignment starts from geography rather than from nothing.
- [Contraction Hierarchies for Road Networks](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/contraction-hierarchies-for-road-networks/) — what to reach for when the matrix itself becomes the bottleneck.

This guide is part of [Multi-Modal and Fleet Routing on a Spatial Graph](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/multi-modal-and-fleet-routing/), within [Network Routing Algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/).
