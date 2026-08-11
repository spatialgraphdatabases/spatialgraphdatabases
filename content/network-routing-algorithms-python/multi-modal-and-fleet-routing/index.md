---
pageTitle: Multi-Modal & Fleet Routing
title: Multi-Modal and Fleet Routing on a Spatial Graph
description: Model transfers between modes as first-class edges, build the many-to-many cost matrix a fleet assignment needs, and keep both affordable at production size.
slug: multi-modal-and-fleet-routing
type: article
breadcrumb: Multi-Modal & Fleet
datePublished: 2026-08-11
dateModified: 2026-08-11
---
# Multi-Modal and Fleet Routing on a Spatial Graph

Two problems sit just past single-vehicle shortest path, and both break the assumptions that made it easy. **Multi-modal routing** asks for a journey that changes mode — drive to a station, take a train, walk to the door — where the cost of changing is not the cost of any edge and the wait for the next departure depends on when you arrive. **Fleet routing** asks not for one route but for an assignment: which of forty vehicles serves which of three hundred stops, which needs the cost between every relevant pair before any decision can be made. The first needs the graph to represent transfers honestly; the second needs a cost matrix computed at a scale where issuing one shortest-path query per pair is not an option. This topic covers both, and the place they meet — a fleet whose vehicles are not all the same mode.

## Prerequisites

The matrix work uses Graph Data Science; the transfer modelling is plain schema design.

| Requirement | Minimum version | Install |
| --- | --- | --- |
| Python | 3.11 | — |
| neo4j (async driver) | 5.20 | `pip install "neo4j>=5.20"` |
| Neo4j Server | 5.15 | native `point` |
| Graph Data Science | 2.6 | `gds.allShortestPaths.dijkstra` |

## Core Concept & Mechanism

**A transfer is an edge, not an exception.** The instinct is to route each mode separately and stitch the legs together in application code, adding a fixed penalty at each join. That produces journeys that are individually optimal and jointly wrong, because the search never had the chance to trade a longer drive against a better connection. Modelling the transfer as a real relationship — `(:CarPark)-[:TRANSFER {seconds: 240}]->(:Platform)` — puts the cost inside the graph where the algorithm can see it, and the search then optimises the whole journey rather than each leg in isolation.

**Mode changes make the graph layered.** The clean structure is one node set per mode, connected only at transfer points. A road junction and a station platform are different nodes even when they are the same place, because what you can do next differs entirely. That layering is what stops a search from walking along a railway line or driving down a platform, and it does so structurally rather than by filtering — the same argument that makes an [edge-based turn graph](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/turn-restriction-and-time-dependent-routing/modeling-turn-restrictions-as-an-edge-based-graph/) preferable to a rule that has to be checked.

**A cost matrix is one search per source, not one per pair.** This is the observation that makes fleet routing tractable. A single-source Dijkstra settles every reachable node in one pass, so the cost from one depot to all three hundred stops comes from *one* search rather than three hundred. For $S$ sources and $T$ targets the work is $O(S)$ searches rather than $O(S \times T)$ — on forty vehicles and three hundred stops, forty searches instead of twelve thousand.

<svg viewBox="0 0 780 320" role="img" aria-labelledby="mmLayerTitle mmLayerDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="mmLayerTitle">Three mode layers joined only at transfer edges</title>
  <desc id="mmLayerDesc">A layered graph with a walking layer, a road layer and a rail layer. Each layer holds its own nodes and its own edges, and no edge crosses between layers except an explicit TRANSFER relationship carrying the cost of changing mode — four minutes to park and reach a platform, two minutes to leave a station on foot. Because the layers share no nodes, a search cannot accidentally drive along a railway or walk down a motorway; the restriction is structural rather than a filter that has to be applied and could be forgotten. The transfer cost sits inside the graph, so the search can trade a longer drive against a better connection.</desc>
  <defs>
    <marker id="mmArr" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="var(--accent-2,#a8380b)"/>
    </marker>
  </defs>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="320" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">One journey, three layers, two transfers</text>
  <rect x="24" y="42" width="732" height="66" rx="9" fill="var(--viz-panel,#f4f4f5)" stroke="var(--accent,#0a656d)" stroke-width="1.6"/>
  <text x="44" y="64" font-size="11" font-weight="700" fill="var(--accent,#0a656d)">road layer</text>
  <text x="44" y="82" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">junctions and segments</text>
  <g font-size="9.5" font-weight="700" text-anchor="middle">
    <circle cx="250" cy="74" r="13" fill="var(--accent,#0a656d)"/><text x="250" y="78" fill="var(--viz-on-pill,#ffffff)">j1</text>
    <circle cx="340" cy="74" r="13" fill="var(--accent,#0a656d)"/><text x="340" y="78" fill="var(--viz-on-pill,#ffffff)">j2</text>
    <circle cx="430" cy="74" r="13" fill="var(--accent,#0a656d)"/><text x="430" y="78" fill="var(--viz-on-pill,#ffffff)">P</text>
  </g>
  <line x1="263" y1="74" x2="327" y2="74" stroke="var(--accent,#0a656d)" stroke-width="2"/>
  <line x1="353" y1="74" x2="417" y2="74" stroke="var(--accent,#0a656d)" stroke-width="2"/>
  <text x="430" y="100" text-anchor="middle" font-size="9" fill="var(--viz-ink-mute,#565f6d)">car park</text>
  <rect x="24" y="128" width="732" height="66" rx="9" fill="var(--viz-panel,#f4f4f5)" stroke="var(--accent-3,#5b21b6)" stroke-width="1.6"/>
  <text x="44" y="150" font-size="11" font-weight="700" fill="var(--accent-3,#5b21b6)">rail layer</text>
  <text x="44" y="168" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">platforms and scheduled services</text>
  <g font-size="9.5" font-weight="700" text-anchor="middle">
    <circle cx="430" cy="160" r="13" fill="var(--accent-3,#5b21b6)"/><text x="430" y="164" fill="var(--viz-on-pill,#ffffff)">A</text>
    <circle cx="560" cy="160" r="13" fill="var(--accent-3,#5b21b6)"/><text x="560" y="164" fill="var(--viz-on-pill,#ffffff)">B</text>
  </g>
  <line x1="443" y1="160" x2="547" y2="160" stroke="var(--accent-3,#5b21b6)" stroke-width="2"/>
  <text x="495" y="152" text-anchor="middle" font-size="9" fill="var(--viz-ink-mute,#565f6d)">08:30 → 08:44</text>
  <rect x="24" y="214" width="732" height="66" rx="9" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="1.6"/>
  <text x="44" y="236" font-size="11" font-weight="700" fill="var(--viz-good,#0a656d)">walking layer</text>
  <text x="44" y="254" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">footways, both directions</text>
  <g font-size="9.5" font-weight="700" text-anchor="middle">
    <circle cx="560" cy="246" r="13" fill="var(--viz-good,#0a656d)"/><text x="560" y="250" fill="var(--viz-on-pill,#ffffff)">w1</text>
    <circle cx="650" cy="246" r="13" fill="var(--viz-good,#0a656d)"/><text x="650" y="250" fill="var(--viz-on-pill,#ffffff)">w2</text>
  </g>
  <line x1="573" y1="246" x2="637" y2="246" stroke="var(--viz-good,#0a656d)" stroke-width="2"/>
  <line x1="430" y1="88" x2="430" y2="126" stroke="var(--accent-2,#a8380b)" stroke-width="2.4" marker-end="url(#mmArr)"/>
  <text x="442" y="118" font-size="10" font-weight="700" fill="var(--accent-2,#a8380b)">TRANSFER 4 min — park, walk to the platform</text>
  <line x1="560" y1="174" x2="560" y2="212" stroke="var(--accent-2,#a8380b)" stroke-width="2.4" marker-end="url(#mmArr)"/>
  <text x="330" y="204" font-size="10" font-weight="700" fill="var(--accent-2,#a8380b)">TRANSFER 2 min — leave the station on foot</text>
  <text x="24" y="304" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">No node is in two layers, so no search can drive along the railway. The restriction is in the shape of the graph.</text>
</svg>

## Schema & Data Model

```cypher
// Transfers are their own relationship type so a projection can include or
// exclude them, and so their cost is auditable independently of any road edge.
CREATE INDEX transfer_mode_pair IF NOT EXISTS
FOR ()-[t:TRANSFER]-() ON (t.from_mode, t.to_mode);

// A layered graph needs its labels kept honest: a node in the road layer must
// never also be a platform, or the layering has been defeated.
MATCH (n) WHERE n:Junction AND n:Platform
RETURN count(n) AS layering_violations;

// Depots and stops for the fleet side. The matrix is keyed on these ids.
CREATE CONSTRAINT stop_id IF NOT EXISTS
FOR (s:Stop) REQUIRE s.id IS UNIQUE;
```

Transfers should carry their direction and their asymmetry. Parking a car and walking to a platform takes longer than walking from a platform back to a car, because one includes finding a space; boarding is not the reverse of alighting. Two directed relationships with different costs is the honest model, and collapsing them to one symmetric edge is the same class of error as [ignoring gradient](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/elevation-and-terrain-enrichment/).

## Step-by-Step Implementation

**1. Project the layers the query actually needs.** A walking-only journey should not carry the road layer's memory, and a driving-only fleet problem should not carry rail.

```python
import asyncio
from dataclasses import dataclass

from neo4j import AsyncGraphDatabase

PROJECT_MODES = """
CALL gds.graph.project.cypher(
  $graph,
  'MATCH (n) WHERE any(l IN labels(n) WHERE l IN $labels) RETURN id(n) AS id',
  'MATCH (a)-[r]->(b) WHERE type(r) IN $types
   RETURN id(a) AS source, id(b) AS target, r.seconds AS seconds',
  {parameters: {labels: $labels, types: $types}}
)
YIELD graphName, nodeCount, relationshipCount
RETURN nodeCount, relationshipCount
"""


@dataclass(frozen=True)
class ModeSet:
    labels: list[str]
    types: list[str]

    @staticmethod
    def driving() -> "ModeSet":
        return ModeSet(labels=["Junction"], types=["SEGMENT"])

    @staticmethod
    def park_and_ride() -> "ModeSet":
        # TRANSFER is included deliberately: without it the layers are three
        # disconnected components and every cross-mode query returns no path.
        return ModeSet(
            labels=["Junction", "Platform", "Footway"],
            types=["SEGMENT", "SERVICE", "WALK", "TRANSFER"],
        )
```

**2. Build the matrix with one search per source.**

```python
MATRIX = """
MATCH (src:Stop {id: $source_id})
CALL gds.allShortestPaths.dijkstra.stream($graph, {
  sourceNode: src, relationshipWeightProperty: 'seconds'
})
YIELD targetNode, totalCost
WITH gds.util.asNode(targetNode) AS t, totalCost
WHERE t:Stop AND t.id IN $target_ids
RETURN t.id AS target_id, totalCost AS seconds
"""


async def cost_matrix(driver, graph: str, sources: list[str],
                      targets: list[str]) -> dict[tuple[str, str], float]:
    """One single-source search per SOURCE, not one per pair.

    Dijkstra settles every reachable node in a single pass, so the row for a
    source is a by-product of one search. Issuing a point-to-point query per
    cell instead does the same work |targets| times over and throws away
    everything it learned each time.
    """
    matrix: dict[tuple[str, str], float] = {}
    async with driver.session() as session:
        for source_id in sources:
            result = await session.run(
                MATRIX, graph=graph, source_id=source_id, target_ids=targets
            )
            async for record in result:
                matrix[(source_id, record["target_id"])] = float(record["seconds"])
    return matrix
```

**3. Hand the matrix to an assignment step**, which is no longer a graph problem — it is an optimisation one, worked through in [assigning deliveries to vehicles from a cost matrix](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/multi-modal-and-fleet-routing/assigning-deliveries-to-vehicles-from-a-cost-matrix/).

## Query Patterns & Variants

**Bounding the search so it stops at the useful radius.** A single-source Dijkstra over a continental graph settles millions of nodes to find three hundred. Capping the cost turns that into a local search.

```cypher
CALL gds.allShortestPaths.dijkstra.stream($graph, {
  sourceNode: src, relationshipWeightProperty: 'seconds'
})
YIELD targetNode, totalCost
WHERE totalCost <= $max_seconds
RETURN gds.util.asNode(targetNode).id AS target_id, totalCost;
```

**Penalising transfers beyond their time cost.** Passengers dislike changing more than the clock says. Adding a fixed dislike to every `TRANSFER` — expressed in seconds so it stays in one unit — biases the search toward fewer legs without needing a second objective.

**Asymmetric matrices.** On a one-way network the cost from A to B is not the cost from B to A, so the matrix has no symmetry to exploit and both directions must be computed. Assuming symmetry to halve the work is a common and quiet error.

## Performance Tuning

The matrix dominates everything, and its cost has a shape worth knowing:

$$C_{\text{matrix}} \approx S \cdot \big(|V'| \log |V'| + |E'|\big)$$

where $V'$ and $E'$ are the *settled* portion of the graph, not the whole of it. That is why the cost bound matters so much: without it, each of $S$ searches explores the entire reachable network; with it, each explores a disc around its source. On a national graph with a two-hour bound, that is often two orders of magnitude.

Three further levers. **Reuse one projection for the whole matrix** — building it per source is the single most common way to make this slow, and the [projection sizing guidance](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-memory-and-storage-tuning/tuning-jvm-heap-for-gds-projections/) applies with force here because the projection is held for the duration of many searches. **Run the sources concurrently**, bounded by a semaphore, since they are independent reads. And **cache the matrix by its inputs**: a fleet's depot set changes rarely and its stop set changes daily, so yesterday's matrix is mostly still valid and only the new stops need rows.

For a genuinely large fleet problem — thousands of stops, matrices recomputed continuously — the shape that scales is a [contraction hierarchy](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/contraction-hierarchies-for-road-networks/) over a static network, where the preprocessing is paid once and every matrix cell afterwards is a bounded bidirectional search.

<svg viewBox="0 0 780 300" role="img" aria-labelledby="mmMatrixTitle mmMatrixDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="mmMatrixTitle">One search per source fills a whole row, so the matrix costs S searches and not S times T</title>
  <desc id="mmMatrixDesc">A cost matrix of 40 depots against 300 stops, which is 12,000 cells. Filling it with a point-to-point query per cell means 12,000 searches, each of which settles most of the same nodes and discards everything it learned about every stop except one. Filling it with a single-source search per depot means 40 searches, each producing a complete row as a by-product. The answer in every cell is identical; the work differs by a factor of 300, which is exactly the number of targets.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="300" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">40 depots × 300 stops = 12,000 cells</text>
  <rect x="24" y="42" width="356" height="196" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-poor,#a8320f)" stroke-width="1.6"/>
  <text x="202" y="66" text-anchor="middle" font-size="11.5" font-weight="700" fill="var(--viz-poor,#a8320f)">a point-to-point query per cell</text>
  <g stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1">
    <line x1="80" y1="84" x2="324" y2="84"/><line x1="80" y1="118" x2="324" y2="118"/><line x1="80" y1="152" x2="324" y2="152"/><line x1="80" y1="186" x2="324" y2="186"/>
    <line x1="141" y1="84" x2="141" y2="186"/><line x1="202" y1="84" x2="202" y2="186"/><line x1="263" y1="84" x2="263" y2="186"/>
  </g>
  <g fill="var(--viz-poor,#a8320f)" opacity="0.5">
    <rect x="80" y="84" width="61" height="34"/><rect x="141" y="118" width="61" height="34"/>
    <rect x="202" y="84" width="61" height="34"/><rect x="263" y="152" width="61" height="34"/>
    <rect x="80" y="152" width="61" height="34"/><rect x="202" y="118" width="61" height="34"/>
  </g>
  <text x="202" y="210" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">each cell its own search, each discarding the rest</text>
  <text x="202" y="228" text-anchor="middle" font-size="13" font-weight="700" fill="var(--viz-poor,#a8320f)">12,000 searches</text>
  <rect x="400" y="42" width="356" height="196" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="1.8"/>
  <text x="578" y="66" text-anchor="middle" font-size="11.5" font-weight="700" fill="var(--viz-good,#0a656d)">one single-source search per depot</text>
  <g stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1">
    <line x1="456" y1="84" x2="700" y2="84"/><line x1="456" y1="118" x2="700" y2="118"/><line x1="456" y1="152" x2="700" y2="152"/><line x1="456" y1="186" x2="700" y2="186"/>
    <line x1="517" y1="84" x2="517" y2="186"/><line x1="578" y1="84" x2="578" y2="186"/><line x1="639" y1="84" x2="639" y2="186"/>
  </g>
  <g fill="var(--viz-good,#0a656d)" opacity="0.5">
    <rect x="456" y="84" width="244" height="34"/><rect x="456" y="118" width="244" height="34"/><rect x="456" y="152" width="244" height="34"/>
  </g>
  <text x="578" y="210" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">a whole row falls out of one settled search</text>
  <text x="578" y="228" text-anchor="middle" font-size="13" font-weight="700" fill="var(--viz-good,#0a656d)">40 searches</text>
  <text x="24" y="266" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">The factor between them is the target count, so the gap widens exactly as the problem gets interesting. Bounding the</text>
  <text x="24" y="282" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">search by cost then shrinks each of the 40 from a national exploration to a local one.</text>
</svg>

## Edge Cases & Gotchas

- **Unreachable pairs are not zero cost.** A stop on an island, or one whose nearest junction failed to snap, simply never appears in the search's output. Filling the missing cell with zero makes it the cheapest assignment in the matrix and it will win every time. Fill with infinity, and count the infinities as a data-quality signal.
- **Transfer edges omitted from the projection.** Without them the layers are disconnected components, and every cross-mode query returns "no path" rather than an error. The tell is that single-mode queries work perfectly, which sends the investigation in the wrong direction.
- **Mixing units across layers.** Walking costs in metres and rail costs in seconds will produce a search that finds paths and orders them by nonsense. Pick one unit — seconds is the only one that survives a mode change — and convert at ingestion.
- **Time-dependent legs in a static matrix.** A matrix computed against a schedule is valid only for the departure time it was computed at. Recomputing per departure window is correct and expensive; the cheaper compromise is a matrix per time band, which the [time-dependent routing](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/turn-restriction-and-time-dependent-routing/) material treats properly.
- **Symmetry assumed on a one-way network.** Computing the upper triangle and mirroring it halves the work and produces wrong costs wherever the network is directed, which in a city is everywhere.
- **Projection staleness across a long matrix build.** A build that takes twenty minutes is reading a snapshot taken twenty minutes ago; if the graph is being updated concurrently, the matrix is internally consistent but not current. That is usually the right trade, but it should be a decision rather than a surprise.

## Verification & Testing

```python
import math
import pytest


@pytest.mark.asyncio
async def test_matrix_has_no_silent_zeros(matrix, sources, targets):
    """An unreachable pair must be infinite, never zero — a zero wins every
    assignment it appears in, and looks like an excellent result."""
    for s in sources:
        for t in targets:
            cost = matrix.get((s, t), math.inf)
            assert cost > 0 or s == t, f"zero cost between distinct nodes {s} → {t}"


@pytest.mark.asyncio
async def test_transfer_edges_are_in_the_projection(session, graph_name):
    """Cross-mode queries fail as 'no path' rather than as an error, so assert
    the connectivity rather than waiting for a support ticket."""
    result = await session.run(
        "CALL gds.graph.relationshipTypes($g) YIELD relationshipType "
        "RETURN collect(relationshipType) AS types", g=graph_name)
    types = (await result.single())["types"]
    assert "TRANSFER" in types, f"layers are disconnected: {types}"
```

The first of these is the one worth wiring into the pipeline rather than the test suite, because it fails for reasons outside the code — a new stop that did not snap, a depot moved to an address the graph does not reach.

## FAQ

<details>
<summary>Should each mode be a separate graph or separate labels in one graph?</summary>

One graph, separate labels. Separate graphs make the transfer a join in application code, which is exactly what putting the cost in the graph avoids. Labels give the same isolation — a projection selects the layers it needs — while keeping transfers as ordinary relationships a search can traverse.
</details>

<details>
<summary>How large can a cost matrix get before this approach stops working?</summary>

The limit is the source count, since that sets the search count. A few hundred sources against any number of targets is comfortable with a bounded search and a resident projection. Thousands of sources recomputed continuously is where contraction hierarchies start to pay for their preprocessing.
</details>

<details>
<summary>Do I need the transfer penalty if the transfer time is already modelled?</summary>

They answer different questions. The transfer *time* is how long the change takes; the transfer *penalty* is how much a passenger dislikes changing at all, which is real and not captured by the clock. Keeping them as separate properties lets you tune the preference without corrupting the journey time you report.
</details>

<details>
<summary>Can the fleet contain vehicles with different modes?</summary>

Yes, and it is the case this topic exists for. Build one matrix per mode against the same stop set — a cargo-bike matrix over the cycling layer, a van matrix over the road layer — and let the assignment step choose across them. The rows are directly comparable because both are in seconds.
</details>

<details>
<summary>Why is my many-to-many query slower than the same number of point-to-point ones?</summary>

Almost always because the search is unbounded. A single-source Dijkstra with no cost cap settles the entire reachable component, which on a national graph is millions of nodes per source, while a point-to-point search stops as soon as the target is settled. Add the bound and the ordering reverses sharply.
</details>

## Related

- [Routing Algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/routing-algorithms-python/) — the single-source search this topic issues repeatedly.
- [Turn-Restriction and Time-Dependent Routing](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/turn-restriction-and-time-dependent-routing/) — schedule edges, and why a matrix has a departure time attached.
- [Contraction Hierarchies for Road Networks](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/contraction-hierarchies-for-road-networks/) — the preprocessing that makes very large matrices affordable.
- [Tuning JVM Heap for GDS Projections](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-memory-and-storage-tuning/tuning-jvm-heap-for-gds-projections/) — holding one projection across many searches.

This topic is part of [Network Routing Algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/).
