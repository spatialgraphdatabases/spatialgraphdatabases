---
pageTitle: Turn & Time-Dependent Routing
title: Turn-Restriction and Time-Dependent Routing
description: Model banned turns and time-varying edge costs in a Neo4j spatial graph so shortest-path stays correct — edge-based expansion, turn penalties, and time-dependent weights from async Python.
slug: turn-restriction-and-time-dependent-routing
type: guide
breadcrumb: Turn & Time Routing
datePublished: 2026-07-14
dateModified: 2026-07-14
---
# Turn-Restriction and Time-Dependent Routing

A shortest-path query is only as correct as the graph it runs on, and the two constraints that most often make a mathematically optimal route physically illegal or impossibly slow are the ones a plain node-and-edge model cannot express: a banned or penalized turn at a junction, and an edge whose cost changes with the time of day. Ignore them and the failure is not a crash — it is worse. The endpoint returns a route, the route looks plausible, and a driver is told to take a left that a "No Left Turn" sign forbids, or the ETA is computed against free-flow speed and lands twenty minutes short at rush hour. This guide covers why a node-based graph structurally cannot represent "you may not turn from this street onto that one," how an edge-based expansion or a turn table fixes it, and why time-varying weights break the static preprocessing that fast routing engines depend on. It is one of the core techniques in [Network Routing Algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/).

<svg viewBox="0 0 760 372" role="img" aria-labelledby="trnTitle trnDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="trnTitle">Why a node-based junction cannot express a banned turn</title>
  <desc id="trnDesc">Left: a physical four-way intersection where a vehicle entering from the west may continue straight to the east arm and turn right to the south arm, but is banned from turning left onto the north arm. Right: the same junction as a single node J connected to west, north, east, and south nodes; because any incoming edge chains to any outgoing edge, the path from west through J to north is still traversable, so the banned turn is unrepresentable.</desc>
  <defs>
    <marker id="trn-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
    <marker id="trn-ok" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="var(--accent,#0a656d)"/>
    </marker>
    <marker id="trn-ban" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="var(--accent-2,#a8380b)"/>
    </marker>
  </defs>
  <rect class="viz-backdrop" x="0" y="0" width="760" height="372" fill="var(--viz-bg,#ffffff)"/>
  <text x="188" y="26" text-anchor="middle" font-size="14.5" font-weight="700" fill="currentColor">At the intersection</text>
  <text x="188" y="44" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.72">left turn onto the north arm is banned</text>
  <rect x="12" y="52" width="352" height="300" rx="10" fill="var(--surface-2)" stroke="var(--line)"/>
  <!-- roads -->
  <path d="M160 66 H200 V182 H334 V222 H200 V338 H160 V222 H26 V182 H160 Z" fill="var(--surface-3)"/>
  <!-- arm labels -->
  <text x="180" y="82" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7">N</text>
  <text x="322" y="206" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7">E</text>
  <text x="180" y="330" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7">S</text>
  <text x="40" y="206" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7">W</text>
  <!-- through (allowed) -->
  <path d="M60 202 H300" fill="none" stroke="var(--accent,#0a656d)" stroke-width="2.4" marker-end="url(#trn-ok)"/>
  <!-- right turn to south (allowed) -->
  <path d="M120 202 Q180 202 180 300" fill="none" stroke="var(--accent,#0a656d)" stroke-width="2.4" marker-end="url(#trn-ok)"/>
  <!-- left turn to north (banned) -->
  <path d="M120 202 Q180 202 180 104" fill="none" stroke="var(--accent-2,#a8380b)" stroke-width="2.4" stroke-dasharray="7 5" marker-end="url(#trn-ban)"/>
  <!-- ban sign -->
  <circle cx="150" cy="120" r="15" fill="var(--surface-2)" stroke="var(--accent-2,#a8380b)" stroke-width="3"/>
  <line x1="140" y1="130" x2="160" y2="110" stroke="var(--accent-2,#a8380b)" stroke-width="3"/>
  <text x="188" y="234" text-anchor="middle" font-size="10.5" fill="var(--accent,#0a656d)" font-weight="600">through &amp; right: legal</text>
  <!-- RIGHT: node-based graph -->
  <text x="572" y="26" text-anchor="middle" font-size="14.5" font-weight="700" fill="currentColor">Node-based graph loses it</text>
  <text x="572" y="44" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.72">any in-edge chains to any out-edge</text>
  <rect x="396" y="52" width="352" height="300" rx="10" fill="var(--surface-2)" stroke="var(--line)"/>
  <line x1="450" y1="202" x2="694" y2="202" stroke="currentColor" stroke-width="1.6" opacity="0.5"/>
  <line x1="572" y1="96" x2="572" y2="308" stroke="currentColor" stroke-width="1.6" opacity="0.5"/>
  <!-- banned path highlighted W->J->N -->
  <path d="M462 202 H560" fill="none" stroke="var(--accent-2,#a8380b)" stroke-width="2.6"/>
  <path d="M572 190 V108" fill="none" stroke="var(--accent-2,#a8380b)" stroke-width="2.6" marker-end="url(#trn-ban)"/>
  <g font-size="11" font-weight="700">
    <circle cx="572" cy="202" r="16" fill="var(--accent-3,#5b21b6)"/>
    <text x="572" y="206" text-anchor="middle" fill="var(--viz-on-pill,#ffffff)">J</text>
    <circle cx="450" cy="202" r="14" fill="var(--surface-2)" stroke="var(--ink-soft)" stroke-width="2"/>
    <text x="450" y="206" text-anchor="middle" fill="currentColor">W</text>
    <circle cx="694" cy="202" r="14" fill="var(--surface-2)" stroke="var(--ink-soft)" stroke-width="2"/>
    <text x="694" y="206" text-anchor="middle" fill="currentColor">E</text>
    <circle cx="572" cy="96" r="14" fill="var(--surface-2)" stroke="var(--ink-soft)" stroke-width="2"/>
    <text x="572" y="100" text-anchor="middle" fill="currentColor">N</text>
    <circle cx="572" cy="308" r="14" fill="var(--surface-2)" stroke="var(--ink-soft)" stroke-width="2"/>
    <text x="572" y="312" text-anchor="middle" fill="currentColor">S</text>
  </g>
  <text x="572" y="340" text-anchor="middle" font-size="10.5" fill="var(--accent-2,#a8380b)" font-weight="600">W → J → N is still a valid path</text>
</svg>

## Prerequisites

The examples run against a Neo4j 5.x instance driven by the official async `neo4j` driver. Turn expansion and turn tables are pure Cypher plus client-side Python; the time-dependent Dijkstra runs entirely in Python over a small in-memory adjacency built from the graph. The Graph Data Science library is optional and used only where noted.

| Requirement | Minimum version | Notes |
| --- | --- | --- |
| Python | 3.10+ | `dataclass`, `heapq`, structural typing in examples |
| Neo4j | 5.13+ | Native `point`, `CREATE POINT INDEX`, relationship property indexes |
| neo4j (driver) | 5.x | Async driver `AsyncGraphDatabase`, native point serialization |
| pytest / pytest-asyncio | 0.23+ | Correctness assertions in the testing section |

```bash
pip install "neo4j>=5.18" "pytest>=8.0" "pytest-asyncio>=0.23"
```

Both techniques assume the underlying topology already follows sound [Node and Edge Spatial Mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/) conventions — coordinates on native `point` properties, edge direction that matches physical one-way rules, and stable application ids so turn relations and time buckets attach to primitives that will not shift on re-import.

## Core Concept & Mechanism

The two constraints look unrelated but share a root cause: the standard property graph attaches cost to a single edge, and both a turn and a time window are properties of *how two edges connect* or *when an edge is used* — dimensions the single-edge model has nowhere to store.

**Turns are a property of edge pairs, not nodes.** A junction where four roads meet is, in the naive model, one node `J` with four incident relationships. A shortest-path algorithm treats every incoming relationship as freely chainable to every outgoing one, because that is what a node *means*: a point where any arriving path may continue along any departing edge. There is no slot on `J` that says "an approach from the west may not continue to the north." Encoding a turn cost or a ban therefore requires representing the *movement itself* — the ordered pair (incoming edge, outgoing edge) — as a first-class object. Two structures do this: a **turn table** that stores penalties keyed by edge pairs and is consulted by the traversal, or an **edge-based graph** (a line graph) where each original road segment becomes a node and each legal movement becomes an edge, so the ban is simply an absent link. The full edge-based transformation is the subject of [Modeling Turn Restrictions as an Edge-Based Graph](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/turn-restriction-and-time-dependent-routing/modeling-turn-restrictions-as-an-edge-based-graph/).

**Time-dependent cost breaks the "one weight per edge" assumption.** Static routing assumes an edge has a fixed traversal cost, which is what lets preprocessing schemes like [Contraction Hierarchies for Road Networks](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/contraction-hierarchies-for-road-networks/) precompute shortcuts once and reuse them for every query. The moment a segment costs 60 seconds at 3 a.m. and 210 seconds at 8 a.m., a precomputed shortcut is only valid for the departure time it was built against, and the whole point of the preprocessing evaporates. Time-dependent routing instead stores a cost *function* per edge — a set of time-bucket weights or a schedule of departures — and runs a time-aware Dijkstra that evaluates the weight at the moment the search reaches the edge. That approach, and the ordering property it depends on, is developed in [Time-Dependent Shortest Paths with Schedule Edges](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/turn-restriction-and-time-dependent-routing/time-dependent-shortest-paths-with-schedule-edges/).

The diagram below shows why a static weight is a lie for most urban edges: the same segment's travel time swings by a factor of three across the day, and any preprocessing that bakes in a single number is wrong for most of it.

<svg viewBox="0 0 760 330" role="img" aria-labelledby="tdTitle tdDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="tdTitle">Travel time on one road segment across a full day versus the single static weight</title>
  <desc id="tdDesc">A profile of one edge's traversal time in seconds plotted against time of day from midnight to midnight. Travel time hovers near sixty seconds overnight, climbs to a morning peak of about two hundred twenty seconds at eight, eases mid-day, rises again to an evening peak near two hundred fifty seconds at five in the afternoon, then falls back overnight. A dashed horizontal line marks the single static weight that contraction-hierarchy preprocessing would assume, which is wrong for most of the day.</desc>
  <!-- axes -->
  <rect class="viz-backdrop" x="0" y="0" width="760" height="330" fill="var(--viz-bg,#ffffff)"/>
  <line x1="70" y1="60" x2="70" y2="250" stroke="currentColor" stroke-width="1.5"/>
  <line x1="70" y1="250" x2="724" y2="250" stroke="currentColor" stroke-width="1.5"/>
  <g font-size="10.5" fill="currentColor" opacity="0.75" text-anchor="middle">
    <text x="70" y="268">00:00</text>
    <text x="232" y="268">06:00</text>
    <text x="395" y="268">12:00</text>
    <text x="557" y="268">18:00</text>
    <text x="720" y="268">24:00</text>
  </g>
  <g font-size="10" fill="currentColor" opacity="0.7" text-anchor="end">
    <text x="63" y="253">0</text>
    <text x="63" y="212">100</text>
    <text x="63" y="149">200</text>
    <text x="63" y="90">300</text>
  </g>
  <text x="20" y="150" font-size="11" fill="currentColor" opacity="0.8" transform="rotate(-90 20 150)" text-anchor="middle">travel time (s)</text>
  <!-- rush bands -->
  <rect x="260" y="60" width="55" height="190" fill="var(--accent-2,#a8380b)" opacity="0.07"/>
  <rect x="503" y="60" width="55" height="190" fill="var(--accent-2,#a8380b)" opacity="0.07"/>
  <!-- static assumption line at ~110s -> y=250-110*0.633=180 -->
  <line x1="70" y1="180" x2="724" y2="180" stroke="var(--accent-3,#5b21b6)" stroke-width="1.6" stroke-dasharray="7 5"/>
  <text x="718" y="174" text-anchor="end" font-size="10" fill="var(--accent-3,#5b21b6)" font-weight="600">static weight assumed by preprocessing</text>
  <!-- profile polyline -->
  <polyline fill="none" stroke="var(--accent,#0a656d)" stroke-width="2.6"
    points="70,212 205,209 260,161 287,111 314,149 368,193 422,190 476,168 530,92 557,123 612,187 666,209 720,212"/>
  <!-- peak markers -->
  <circle cx="287" cy="111" r="3.6" fill="var(--accent,#0a656d)"/>
  <text x="287" y="102" text-anchor="middle" font-size="10" fill="currentColor" font-weight="600">AM peak</text>
  <circle cx="530" cy="92" r="3.6" fill="var(--accent,#0a656d)"/>
  <text x="530" y="83" text-anchor="middle" font-size="10" fill="currentColor" font-weight="600">PM peak</text>
  <text x="395" y="308" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.72">one edge, one number cannot be right — cost must be a function of departure time</text>
</svg>

## Schema & Data Model

Both techniques extend the same base topology rather than replacing it. Keep the physical graph — nodes with `location`, directed `ROUTE` relationships with a base cost — and add the two dimensions as explicit structure.

```cypher
// Base spatial topology (unchanged)
CREATE CONSTRAINT junction_id IF NOT EXISTS
FOR (n:Junction) REQUIRE n.id IS UNIQUE;
CREATE POINT INDEX junction_location IF NOT EXISTS
FOR (n:Junction) ON (n.location);

// Turn table: a movement is a first-class relationship keyed by the edge pair.
// from_edge / to_edge are the stable ids of the two ROUTE segments meeting at a junction.
CREATE (:TurnRule {via_junction: 'j_18', from_edge: 'e_west', to_edge: 'e_north',
                   penalty_s: -1, banned: true});   // -1 sentinel = impassable

// Time-dependent cost: per-edge weights bucketed by a half-open departure window.
// A ROUTE keeps its base weight; TimeWeight rows override it inside [start_s, end_s).
CREATE INDEX timeweight_edge IF NOT EXISTS
FOR (t:TimeWeight) ON (t.edge_id);
CREATE (:TimeWeight {edge_id: 'e_north', start_s: 28800, end_s: 32400, weight_s: 220});
```

Two design rules keep this queryable. First, a banned turn is stored as an explicit rule with a sentinel penalty rather than by deleting an edge, because the same segment pair may be legal for one vehicle profile and banned for another — you filter, you do not mutate topology. Second, time buckets are half-open intervals `[start_s, end_s)` keyed to seconds-since-midnight in a **fixed reference timezone**, never local wall-clock, so a daylight-saving transition does not silently duplicate or drop an hour. The consequences of getting that wrong are covered under time-dependent routing.

## Step-by-Step Implementation

The runnable service below loads both dimensions from Neo4j and runs a time-aware Dijkstra in Python that consults the turn table between consecutive edges and evaluates each edge's weight at the arrival time. It is deliberately self-contained: one async load, one pure-Python search, no external routing library.

### 1. Load the topology, turn rules, and time weights

```python
import asyncio
import heapq
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Optional

from neo4j import AsyncGraphDatabase

LOAD_GRAPH = """
MATCH (a:Junction)-[r:ROUTE]->(b:Junction)
RETURN a.id AS src, b.id AS dst, r.edge_id AS edge_id, r.base_weight_s AS base
"""
LOAD_TURNS = """
MATCH (t:TurnRule)
RETURN t.via_junction AS via, t.from_edge AS from_edge,
       t.to_edge AS to_edge, t.penalty_s AS penalty, t.banned AS banned
"""
LOAD_TIMEWEIGHTS = """
MATCH (t:TimeWeight)
RETURN t.edge_id AS edge_id, t.start_s AS start_s, t.end_s AS end_s, t.weight_s AS weight_s
"""


@dataclass
class Edge:
    src: str
    dst: str
    edge_id: str
    base: float
    buckets: list = field(default_factory=list)  # (start_s, end_s, weight_s)

    def weight_at(self, depart_s: float) -> float:
        """Cost of traversing this edge when departure falls in a time bucket."""
        tod = depart_s % 86_400  # seconds since midnight, fixed reference tz
        for start_s, end_s, w in self.buckets:
            if start_s <= tod < end_s:
                return w
        return self.base


async def load_network(driver) -> tuple[dict, dict]:
    """Build an in-memory adjacency plus a turn-penalty lookup from the graph."""
    adjacency: dict[str, list[Edge]] = defaultdict(list)
    edges_by_id: dict[str, Edge] = {}
    turns: dict[tuple[str, str, str], float] = {}

    async with driver.session(database="neo4j") as s:
        async for rec in await s.run(LOAD_GRAPH):
            e = Edge(rec["src"], rec["dst"], rec["edge_id"], float(rec["base"]))
            adjacency[e.src].append(e)
            edges_by_id[e.edge_id] = e
        async for rec in await s.run(LOAD_TIMEWEIGHTS):
            edges_by_id[rec["edge_id"]].buckets.append(
                (rec["start_s"], rec["end_s"], float(rec["weight_s"]))
            )
        async for rec in await s.run(LOAD_TURNS):
            # A banned turn is an infinite penalty; a penalized turn adds seconds.
            cost = float("inf") if rec["banned"] else float(rec["penalty"])
            turns[(rec["via"], rec["from_edge"], rec["to_edge"])] = cost
    return adjacency, turns
```

### 2. Run a turn-aware, time-aware Dijkstra

The search state is the pair *(junction, edge used to arrive)* rather than the junction alone — that is what lets the turn table veto an illegal continuation. Each edge's weight is evaluated at the current arrival time, so the traversal is time-dependent by construction.

```python
def route(
    adjacency: dict[str, list[Edge]],
    turns: dict[tuple[str, str, str], float],
    origin: str,
    dest: str,
    depart_s: float,
) -> Optional[tuple[float, list[str]]]:
    """Earliest arrival from origin to dest, respecting turn bans and time buckets."""
    # State = (junction, incoming edge id). None means "started here, no prior edge".
    start = (origin, None)
    best: dict[tuple[str, Optional[str]], float] = {start: depart_s}
    pq: list[tuple[float, tuple[str, Optional[str]], list[str]]] = [(depart_s, start, [])]

    while pq:
        arrive_s, (node, in_edge), path = heapq.heappop(pq)
        if node == dest:
            return arrive_s - depart_s, path
        if arrive_s > best.get((node, in_edge), float("inf")):
            continue
        for e in adjacency[node]:
            penalty = 0.0
            if in_edge is not None:
                penalty = turns.get((node, in_edge, e.edge_id), 0.0)
            if penalty == float("inf"):
                continue  # banned turn — never expand it
            depart_edge = arrive_s + penalty
            next_arrive = depart_edge + e.weight_at(depart_edge)
            state = (e.dst, e.edge_id)
            if next_arrive < best.get(state, float("inf")):
                best[state] = next_arrive
                heapq.heappush(pq, (next_arrive, state, path + [e.edge_id]))
    return None


async def main():
    driver = AsyncGraphDatabase.driver(
        "neo4j://localhost:7687",
        auth=("neo4j", "secure_password"),
        max_connection_pool_size=20,
        connection_acquisition_timeout=15.0,
    )
    try:
        adjacency, turns = await load_network(driver)
        depart = 8 * 3600  # 08:00, into the morning peak
        result = route(adjacency, turns, origin="j_west", dest="j_north", depart_s=depart)
        if result is None:
            print("No legal route.")
        else:
            travel_s, path = result
            print(f"Arrived in {travel_s / 60:.1f} min via {len(path)} segments: {path}")
    finally:
        await driver.close()


if __name__ == "__main__":
    asyncio.run(main())
```

The load is async and pooled; the search itself is CPU-bound pure Python that never touches the driver, so a request handler awaits the load once and then runs the algorithm without holding a session open. For very large networks you would push the search into the [Neo4j GDS versus Cypher routing](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/neo4j-gds-vs-cypher-routing/) territory instead of materializing adjacency in the application — the trade-off is memory footprint against the flexibility of a hand-written time-aware search.

## Query Patterns & Variants

The base pattern above is the flexible in-application search. Two Cypher-side variants cover the cases where you want the database to do more of the work.

**Variant A — filter banned turns inside a variable-length match.** When you only need to *exclude* illegal movements (no penalties, just bans), you can keep the search in Cypher by rejecting any consecutive edge pair that has a banning `TurnRule`. The `apoc.coll` functions or a pairwise `WHERE` over `relationships(path)` express the pairwise check.

```cypher
MATCH path = (o:Junction {id: $origin})-[:ROUTE*1..12]->(d:Junction {id: $dest})
WHERE NONE(
  i IN range(0, size(relationships(path)) - 2)
  WHERE EXISTS {
    MATCH (:TurnRule {
      from_edge: (relationships(path)[i]).edge_id,
      to_edge:   (relationships(path)[i + 1]).edge_id,
      banned: true
    })
  }
)
RETURN [r IN relationships(path) | r.edge_id] AS segments,
       reduce(c = 0.0, r IN relationships(path) | c + r.base_weight_s) AS cost
ORDER BY cost ASC LIMIT 1
// Cap the *1..12 bound; an unbounded star materializes the whole component.
```

**Variant B — pick the active time bucket in Cypher.** For a single departure time (no in-search time evolution), resolve each edge's weight against the correct bucket in the query with an `OPTIONAL MATCH`, falling back to the base weight. This is correct only when the whole route is assumed to happen within one bucket — a fine approximation for short trips, wrong for long ones that cross a rush-hour boundary.

```cypher
WITH $depart_tod AS tod
MATCH path = (o:Junction {id: $origin})-[:ROUTE*1..10]->(d:Junction {id: $dest})
WITH path, tod, relationships(path) AS rels
UNWIND rels AS r
OPTIONAL MATCH (tw:TimeWeight {edge_id: r.edge_id})
  WHERE tw.start_s <= tod AND tod < tw.end_s
WITH path, sum(coalesce(tw.weight_s, r.base_weight_s)) AS cost
RETURN path, cost ORDER BY cost ASC LIMIT 1
```

**Variant C — edge-based projection for GDS.** When you need genuine turn-cost shortest paths at scale, materialize the edge-based graph and run a standard weighted Dijkstra over it, because in that representation the turn penalty is already baked into the edge weight and no special algorithm is required. Building that projection is exactly what the [edge-based graph transformation](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/turn-restriction-and-time-dependent-routing/modeling-turn-restrictions-as-an-edge-based-graph/) produces.

## Performance Tuning

Both dimensions inflate the search space, and profiling is about confirming the inflation stays bounded.

- **State-space blow-up from turns.** A turn-aware search keys state on *(node, incoming edge)*, so the reachable state count grows with average node degree, not node count. On a grid where junctions have degree four, expect roughly a fourfold increase in settled states versus plain Dijkstra. Cap variable-length Cypher matches hard, and prefer the pre-materialized edge-based graph when query volume is high — you pay the expansion once at build time instead of on every query.
- **Keep the turn lookup O(1).** The turn table must be a hash lookup keyed by `(via, from_edge, to_edge)`. If you resolve turns with an `EXISTS { MATCH ... }` subquery per edge pair, ensure a relationship or node index backs the `from_edge`/`to_edge` properties; a `PROFILE` that shows a `NodeByLabelScan` on `:TurnRule` per hop means the index is missing and the search degrades to a scan.
- **Time buckets: few and coarse.** Five to eight buckets per edge (overnight, AM peak, mid-day, PM peak, evening) capture almost all of the real variation. Storing per-minute weights bloats the graph and thrashes the plan cache without materially improving ETA accuracy. Store buckets sorted so `weight_at` can short-circuit.
- **Warm the load.** The async load in the example reads the whole network once. For an interactive service, load and cache the adjacency and turn table in process memory, invalidating on graph change, so per-request latency is the pure-Python search alone.

## Edge Cases & Gotchas

- **U-turns are turns too.** The movement from an edge back onto its own reverse is a turn like any other, and it is usually either banned or heavily penalized. A model that forgets U-turn movements will happily route a vehicle to reverse direction at every node.
- **Restriction relations with via-ways.** Some real-world bans are not "at junction J you may not go from A to B" but span an intermediate segment — "no right turn from A onto B when reached via way V." A single edge-pair key cannot express these; they need a via-way key. This is the hardest case in the edge-based transformation.
- **Non-FIFO time weights break Dijkstra.** If leaving an edge later can somehow arrive earlier — a weight profile that drops faster than time advances — Dijkstra's optimality guarantee fails, because a later-departing label is no longer dominated. The FIFO property and how to enforce it are central to time-dependent routing.
- **Timezone and DST.** Storing buckets in local wall-clock time means a spring-forward transition skips an hour of weights and a fall-back doubles one. Always bucket in a fixed reference offset and convert at the query boundary.
- **Banned versus deleted.** Deleting an edge to encode a ban corrupts the graph for other vehicle profiles that may legally use the movement. Always model the ban as a filterable rule.

## Verification & Testing

The correctness property that matters is behavioral: the router must never emit a banned movement, and a later departure must never produce an earlier arrival on a FIFO network. Assert both directly.

```python
import pytest
from neo4j import AsyncGraphDatabase

SEED = """
CREATE (w:Junction {id:'j_west',  location: point({srid:4326, latitude:41.878, longitude:-87.640})})
CREATE (c:Junction {id:'j_ctr',   location: point({srid:4326, latitude:41.878, longitude:-87.632})})
CREATE (n:Junction {id:'j_north', location: point({srid:4326, latitude:41.885, longitude:-87.632})})
CREATE (s:Junction {id:'j_south', location: point({srid:4326, latitude:41.871, longitude:-87.632})})
CREATE (w)-[:ROUTE {edge_id:'e_west',  base_weight_s:60}]->(c)
CREATE (c)-[:ROUTE {edge_id:'e_north', base_weight_s:60}]->(n)
CREATE (c)-[:ROUTE {edge_id:'e_south', base_weight_s:60}]->(s)
CREATE (s)-[:ROUTE {edge_id:'e_s2n',   base_weight_s:200}]->(n)
CREATE (:TurnRule {via_junction:'j_ctr', from_edge:'e_west', to_edge:'e_north', penalty_s:-1, banned:true})
CREATE (:TimeWeight {edge_id:'e_south', start_s:28800, end_s:32400, weight_s:80})
"""


@pytest.mark.asyncio
async def test_router_never_emits_banned_turn():
    driver = AsyncGraphDatabase.driver("bolt://localhost:7687", auth=("neo4j", "test"))
    async with driver.session(database="neo4j") as s:
        await s.run("MATCH (n) DETACH DELETE n")
        await s.run(SEED)
    adjacency, turns = await load_network(driver)

    # The direct left turn e_west -> e_north is banned, so the router must detour
    # west -> centre -> south -> north instead of taking the illegal movement.
    travel_s, path = route(adjacency, turns, "j_west", "j_north", depart_s=8 * 3600)
    assert "e_north" not in path or path.index("e_west") == -1
    assert path == ["e_west", "e_south", "e_s2n"], "must take the legal detour"

    # FIFO check: departing later never arrives earlier on this network.
    early = route(adjacency, turns, "j_west", "j_north", depart_s=8 * 3600)[0] + 8 * 3600
    late = route(adjacency, turns, "j_west", "j_north", depart_s=9 * 3600)[0] + 9 * 3600
    assert late >= early, "FIFO violated: later departure arrived earlier"
    await driver.close()
```

Run this in CI alongside a plan-shape assertion on any Cypher variant you ship, so a refactor that drops the turn filter or the bucket index is caught before it reaches production.

## FAQ

<details>
<summary>Why can't I just store a "no left turn" flag on the junction node?</summary>

Because a flag on the node cannot name *which* pair of edges the ban applies to. A four-way junction has up to twelve distinct movements, and a ban forbids a specific one — say, the approach from the west continuing north — while leaving the other eleven legal. A single node property has no room to distinguish them. The ban is a property of the ordered edge pair, so it must be stored against that pair, either as a turn-table entry keyed by the two edge ids or as an absent link in an edge-based graph.
</details>

<details>
<summary>Do turn restrictions require an edge-based graph, or can I keep the node-based one?</summary>

You can keep the node-based graph and consult a turn table during traversal, keying the search state on the incoming edge so the table can veto an illegal continuation. That is the flexible approach and it needs no rebuild when rules change. The edge-based transformation is worth the extra structure when you want standard shortest-path algorithms or the GDS library to honour turns automatically, because it bakes the penalty into ordinary edge weights so no special search logic is required.
</details>

<details>
<summary>Why does time-dependent cost break contraction hierarchies and similar preprocessing?</summary>

Preprocessing schemes precompute shortcut edges whose weights summarize a whole chain of the graph, and they assume those weights are constant. When an edge's cost depends on departure time, a precomputed shortcut is only valid for the single time it was built against, so the preprocessing must either be rebuilt per time slice or abandoned in favour of a time-aware search that evaluates weights at query time. In practice you either accept a static approximation for long-horizon planning or run a time-dependent Dijkstra for accurate ETAs.
</details>

<details>
<summary>What is the FIFO property and why does my router need it?</summary>

FIFO, or first-in-first-out, means that leaving an edge later never lets you arrive earlier. Time-dependent Dijkstra stays optimal only on FIFO networks, because its correctness rests on labels being settled in non-decreasing arrival-time order. If a weight profile ever drops faster than the clock advances, a later departure could overtake an earlier one, a settled label could later be improved, and the algorithm would return a non-optimal path. Road travel-time profiles are almost always FIFO; poorly interpolated schedule data sometimes is not, which is where the property must be enforced.
</details>

## Related

- [Modeling Turn Restrictions as an Edge-Based Graph](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/turn-restriction-and-time-dependent-routing/modeling-turn-restrictions-as-an-edge-based-graph/) — the full node-to-edge line-graph transformation that turns bans into absent links.
- [Time-Dependent Shortest Paths with Schedule Edges](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/turn-restriction-and-time-dependent-routing/time-dependent-shortest-paths-with-schedule-edges/) — time-bucket weights, schedule edges, and the FIFO-safe time-aware Dijkstra.
- [Contraction Hierarchies for Road Networks](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/contraction-hierarchies-for-road-networks/) — the static-cost preprocessing that time-dependence invalidates.
- [Node and Edge Spatial Mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/) — the base topology contract both techniques extend.
- [Neo4j GDS vs Cypher Routing](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/neo4j-gds-vs-cypher-routing/) — where to push the search when in-application adjacency stops scaling.

This guide is part of [Network Routing Algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/).

For authoritative reference on turn-restriction modelling and native spatial functions, consult the [OpenStreetMap turn-restriction relation documentation](https://wiki.openstreetmap.org/wiki/Relation:restriction) and the [Neo4j Cypher spatial functions reference](https://neo4j.com/docs/cypher-manual/current/functions/spatial/).

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "Why can't I just store a no-left-turn flag on the junction node?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Because a flag on the node cannot name which pair of edges the ban applies to. A four-way junction has up to twelve distinct movements, and a ban forbids a specific one, such as the approach from the west continuing north, while leaving the other eleven legal. A single node property has no room to distinguish them. The ban is a property of the ordered edge pair, so it must be stored against that pair, either as a turn-table entry keyed by the two edge ids or as an absent link in an edge-based graph."
      }
    },
    {
      "@type": "Question",
      "name": "Do turn restrictions require an edge-based graph, or can I keep the node-based one?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "You can keep the node-based graph and consult a turn table during traversal, keying the search state on the incoming edge so the table can veto an illegal continuation. That is the flexible approach and it needs no rebuild when rules change. The edge-based transformation is worth the extra structure when you want standard shortest-path algorithms or the GDS library to honour turns automatically, because it bakes the penalty into ordinary edge weights so no special search logic is required."
      }
    },
    {
      "@type": "Question",
      "name": "Why does time-dependent cost break contraction hierarchies and similar preprocessing?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Preprocessing schemes precompute shortcut edges whose weights summarize a whole chain of the graph, and they assume those weights are constant. When an edge cost depends on departure time, a precomputed shortcut is only valid for the single time it was built against, so the preprocessing must either be rebuilt per time slice or abandoned in favour of a time-aware search that evaluates weights at query time. In practice you either accept a static approximation for long-horizon planning or run a time-dependent Dijkstra for accurate arrival times."
      }
    },
    {
      "@type": "Question",
      "name": "What is the FIFO property and why does my router need it?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "FIFO, or first-in-first-out, means that leaving an edge later never lets you arrive earlier. Time-dependent Dijkstra stays optimal only on FIFO networks, because its correctness rests on labels being settled in non-decreasing arrival-time order. If a weight profile ever drops faster than the clock advances, a later departure could overtake an earlier one, a settled label could later be improved, and the algorithm would return a non-optimal path. Road travel-time profiles are almost always FIFO; poorly interpolated schedule data sometimes is not, which is where the property must be enforced."
      }
    }
  ]
}
</script>
