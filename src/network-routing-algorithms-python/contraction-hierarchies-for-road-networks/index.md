---
pageTitle: Contraction Hierarchies for Roads
---
# Contraction Hierarchies for Road Networks

A plain weighted shortest-path query on a continental road network settles millions of nodes before it returns, because Dijkstra expands outward in every direction and A\* only narrows the cone toward the goal — neither of them knows that a Munich-to-Hamburg route spends almost all of its length on a handful of motorways. Contraction hierarchies (CH) encode exactly that structure ahead of time. A one-off preprocessing pass ranks every node by importance and inserts *shortcut edges* that let a query skip over unimportant local streets, so the actual point-to-point search touches a few hundred nodes instead of a few million and answers in microseconds. The cost is that the overlay is a precomputed artifact: it is correct only for the topology it was built against, so CH belongs to static or slowly-changing road graphs, not to networks under constant live edits. This guide explains what the ranking and shortcut structure are, how to store a CH overlay in Neo4j, and how to run the bidirectional upward search from async Python. It sits under [Network Routing Algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/) and accelerates the same problem solved directly by [Routing Algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/routing-algorithms-python/).

<svg viewBox="-44 0 864 430" role="img" aria-labelledby="chSearchTitle chSearchDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="chSearchTitle">Bidirectional upward search meeting at the highest-ranked node on the route</title>
  <desc id="chSearchDesc">Two searches climb the rank hierarchy. From the source on the lower left, a forward search relaxes only edges that lead to higher-ranked nodes, climbing up and to the right. From the target on the lower right, a backward search over reversed edges also climbs, up and to the left. Both frontiers only ever move upward in rank, so they settle very few nodes and meet at a single high-rank apex node in the middle. The full route is the forward up-path joined to the reversed backward up-path. Faded downward edges are never explored.</desc>
  <defs>
    <marker id="ch-up-fwd" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="var(--accent,#0a656d)"/>
    </marker>
    <marker id="ch-up-bwd" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="var(--accent-2,#a8380b)"/>
    </marker>
  </defs>
  <!-- rank guide bands -->
  <g stroke="var(--line,#e5e0d2)" stroke-width="1" stroke-dasharray="2 6" opacity="0.7">
    <line x1="40" y1="350" x2="780" y2="350"/>
    <line x1="40" y1="268" x2="780" y2="268"/>
    <line x1="40" y1="186" x2="780" y2="186"/>
    <line x1="40" y1="104" x2="780" y2="104"/>
  </g>
  <g font-size="10.5" fill="currentColor" opacity="0.6" text-anchor="end">
    <text x="34" y="354">low rank</text>
    <text x="34" y="108">high rank</text>
  </g>
  <text x="410" y="28" text-anchor="middle" font-size="15" font-weight="700" fill="currentColor">Query settles only upward — the frontiers meet at the apex</text>
  <!-- faded downward edges never explored -->
  <g stroke="currentColor" stroke-width="1.3" opacity="0.16" fill="none" stroke-dasharray="4 4">
    <path d="M200 268 L120 350"/>
    <path d="M330 186 L250 350"/>
    <path d="M620 268 L700 350"/>
    <path d="M490 186 L570 350"/>
  </g>
  <!-- forward up-path -->
  <g stroke="var(--accent,#0a656d)" stroke-width="2.6" fill="none" marker-end="url(#ch-up-fwd)">
    <path d="M105 350 L188 273"/>
    <path d="M212 262 L318 192"/>
    <path d="M342 180 L392 118"/>
  </g>
  <!-- backward up-path -->
  <g stroke="var(--accent-2,#a8380b)" stroke-width="2.6" fill="none" marker-end="url(#ch-up-bwd)">
    <path d="M715 350 L632 273"/>
    <path d="M608 262 L502 192"/>
    <path d="M478 180 L428 118"/>
  </g>
  <!-- forward nodes -->
  <g>
    <circle cx="90" cy="350" r="15" fill="var(--accent,#0a656d)"/>
    <text x="90" y="354" text-anchor="middle" font-size="12" font-weight="700" fill="#ffffff">S</text>
    <circle cx="200" cy="268" r="12" fill="var(--surface-2,#fff)" stroke="var(--accent,#0a656d)" stroke-width="2"/>
    <circle cx="330" cy="186" r="12" fill="var(--surface-2,#fff)" stroke="var(--accent,#0a656d)" stroke-width="2"/>
  </g>
  <!-- backward nodes -->
  <g>
    <circle cx="730" cy="350" r="15" fill="var(--accent-2,#a8380b)"/>
    <text x="730" y="354" text-anchor="middle" font-size="12" font-weight="700" fill="#ffffff">T</text>
    <circle cx="620" cy="268" r="12" fill="var(--surface-2,#fff)" stroke="var(--accent-2,#a8380b)" stroke-width="2"/>
    <circle cx="490" cy="186" r="12" fill="var(--surface-2,#fff)" stroke="var(--accent-2,#a8380b)" stroke-width="2"/>
  </g>
  <!-- apex meeting node -->
  <circle cx="410" cy="104" r="17" fill="var(--accent-3,#5b21b6)"/>
  <text x="410" y="108" text-anchor="middle" font-size="12" font-weight="700" fill="#ffffff">M</text>
  <text x="410" y="76" text-anchor="middle" font-size="11.5" font-weight="700" fill="var(--accent-3,#5b21b6)">apex — highest rank on the route</text>
  <!-- legend -->
  <g font-size="11" fill="currentColor">
    <line x1="120" y1="404" x2="150" y2="404" stroke="var(--accent,#0a656d)" stroke-width="2.6"/>
    <text x="158" y="408">forward upward search (from S)</text>
    <line x1="440" y1="404" x2="470" y2="404" stroke="var(--accent-2,#a8380b)" stroke-width="2.6"/>
    <text x="478" y="408">backward upward search (from T)</text>
  </g>
</svg>

## Prerequisites

The overlay is stored as ordinary relationships and node properties, so nothing here needs a Neo4j plugin — the preprocessing and query are plain Cypher plus async Python. Neo4j GDS ships Dijkstra and A\* but not a native CH implementation, so the hierarchy is an artifact you build and manage yourself; the trade-off against those built-in algorithms is covered under [Neo4j GDS vs Cypher Routing](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/neo4j-gds-vs-cypher-routing/).

| Requirement | Minimum version | Notes |
| --- | --- | --- |
| Python | 3.10+ | `heapq`-based search, union type hints in the examples |
| Neo4j | 5.13+ | Native `point` type, `CREATE POINT INDEX`, index-backed lookups |
| neo4j (driver) | 5.x | Async driver (`AsyncGraphDatabase`), native point serialization |
| pytest / pytest-asyncio | 0.23+ | For the correctness assertions in the testing section |

```bash
pip install "neo4j>=5.18" "pytest>=8.0" "pytest-asyncio>=0.23"
```

The graph must already follow sound [node and edge spatial mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/) conventions — a stable `id` on every node, `point` geometry, and a directed `:ROUTE` edge carrying a numeric `weight` — because CH is layered *on top of* a correct base graph, and it will faithfully preserve any topology defect you feed it.

## Core Concept and Mechanism

A contraction hierarchy is two artifacts computed together: a total order over the nodes (each node's `ch_rank`) and a set of shortcut edges that preserve shortest-path distances across the order.

**Node ordering.** Every node is assigned an importance rank. Ordering is a heuristic — a common one blends *edge difference* (how many shortcuts a contraction would add minus the edges it removes) with the number of already-contracted neighbours and the search space it would create. The details of computing that priority live in [precomputing shortcut edges in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/contraction-hierarchies-for-road-networks/precomputing-shortcut-edges-in-python/); here the load-bearing fact is only that ranks are total and reflect how "central" a node is to long routes. Motorway junctions end up high; cul-de-sacs end up low.

**Contraction and shortcuts.** Nodes are removed one at a time in increasing rank. When node $v$ is contracted, the algorithm looks at every pair of remaining neighbours $u$ and $w$. If the only remaining shortest path from $u$ to $w$ runs through $v$, a shortcut edge $u \rightarrow w$ is inserted with the combined weight, so the graph without $v$ still contains the correct distance. A shortcut is required precisely when no *witness path* — an alternative route not through $v$ that is at least as short — exists:

$$\text{shortcut}(u \to w) \iff w(u,v) + w(v,w) < \operatorname{dist}_{G \setminus v}(u, w)$$

**Upward search.** The payoff is on the query side. Define the *upward graph* as every edge (original or shortcut) directed from a lower-rank node to a higher-rank one. A bidirectional Dijkstra runs a forward search from the source and a backward search from the target, and both relax **only upward edges**. Because the shortcut construction guarantees that some shortest path between any two nodes can be written as an up-path from the source followed by a down-path into the target — equivalently, an up-path from the target on the reversed graph — the two upward searches are guaranteed to meet at the single highest-ranked node on the optimal route. Each frontier climbs a short way up the hierarchy and stops, so the settled set is tiny compared to a flat Dijkstra that fans out across the whole plane. That is why point-to-point queries drop from milliseconds to microseconds: the CH query is the same Dijkstra baseline described in [Routing Algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/routing-algorithms-python/), but restricted to a search space the preprocessing made sparse.

## Schema and Data Model

Store the base network and the CH overlay in the same graph. Keep the original directed `:ROUTE` relationships untouched — you still need them to unpack a shortcut back into a turn-by-turn path — and add `:SHORTCUT` relationships for the contraction artifacts. Every node carries a `ch_rank` integer; every shortcut records the contracted midpoint (`via`) so it can be expanded later.

```cypher
// Stable id + geometry (base graph)
CREATE CONSTRAINT node_id_unique IF NOT EXISTS
FOR (n:Node) REQUIRE n.id IS UNIQUE;

CREATE POINT INDEX node_location IF NOT EXISTS
FOR (n:Node) ON (n.location);

// The contraction rank — the total order the upward search walks
CREATE INDEX node_ch_rank IF NOT EXISTS
FOR (n:Node) ON (n.ch_rank);
```

```cypher
// Representative shape of the overlay
// (:Node {id, ch_rank, location: point({srid:4326, latitude, longitude})})
//   -[:ROUTE   {weight}]->            (:Node)   // original edge, unchanged
//   -[:SHORTCUT {weight, via}]->      (:Node)   // added during contraction
```

The `ch_rank` index matters because the upward search filters expansion on a rank comparison; without it, the per-node neighbour lookup degrades toward a scan. Treat `:ROUTE` and `:SHORTCUT` as one logical adjacency at query time (match `[:ROUTE|SHORTCUT]`) but keep them as distinct types so a topology audit, a shortcut rebuild, or a path unpack can address them independently.

<svg viewBox="0 0 820 300" role="img" aria-labelledby="chSchemaTitle chSchemaDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="chSchemaTitle">A SHORTCUT relationship overlaying two original ROUTE edges through a contracted node</title>
  <desc id="chSchemaDesc">Two high-rank nodes u and w sit on the left and right, each carrying a ch_rank property. Below them a low-rank node v is drawn faded, marked as contracted. Two original ROUTE edges, u to v and v to w, carry their own weights and are shown faded. Arcing over the top, a single bold dashed SHORTCUT edge connects u directly to w. It carries a weight equal to the sum of the two ROUTE weights and a via property pointing back at the contracted node v, which is how the shortcut is later unpacked into a full path.</desc>
  <defs>
    <marker id="ch-schema-arr" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7.5" markerHeight="7.5" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="var(--accent-3,#5b21b6)"/>
    </marker>
    <marker id="ch-route-arr" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <!-- shortcut arc -->
  <path d="M150 150 C 300 40, 520 40, 670 150" fill="none" stroke="var(--accent-3,#5b21b6)" stroke-width="2.8" stroke-dasharray="8 5" marker-end="url(#ch-schema-arr)"/>
  <rect x="322" y="52" width="176" height="46" rx="9" fill="var(--surface-2,#fff)" stroke="var(--accent-3,#5b21b6)" stroke-width="1.6"/>
  <text x="410" y="72" text-anchor="middle" font-size="12.5" font-weight="700" fill="var(--accent-3,#5b21b6)">:SHORTCUT</text>
  <text x="410" y="89" text-anchor="middle" font-size="10.5" fill="currentColor">weight = w(u,v)+w(v,w) · via = v</text>
  <!-- original route edges (faded) -->
  <g opacity="0.5">
    <line x1="163" y1="164" x2="392" y2="238" stroke="currentColor" stroke-width="1.8" marker-end="url(#ch-route-arr)"/>
    <line x1="428" y1="238" x2="657" y2="164" stroke="currentColor" stroke-width="1.8" marker-end="url(#ch-route-arr)"/>
    <text x="250" y="196" text-anchor="middle" font-size="10.5" fill="currentColor">:ROUTE w(u,v)</text>
    <text x="570" y="196" text-anchor="middle" font-size="10.5" fill="currentColor">:ROUTE w(v,w)</text>
  </g>
  <!-- node u -->
  <circle cx="150" cy="150" r="20" fill="var(--accent,#0a656d)"/>
  <text x="150" y="155" text-anchor="middle" font-size="14" font-weight="700" fill="#ffffff">u</text>
  <text x="150" y="196" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.85">ch_rank: 812</text>
  <!-- node w -->
  <circle cx="670" cy="150" r="20" fill="var(--accent,#0a656d)"/>
  <text x="670" y="155" text-anchor="middle" font-size="14" font-weight="700" fill="#ffffff">w</text>
  <text x="670" y="196" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.85">ch_rank: 774</text>
  <!-- contracted node v -->
  <circle cx="410" cy="245" r="17" fill="var(--surface-3,#f1ede2)" stroke="currentColor" stroke-width="1.6" stroke-dasharray="4 3" opacity="0.85"/>
  <text x="410" y="250" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">v</text>
  <text x="410" y="284" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.8">contracted first (lowest rank)</text>
</svg>

## Step-by-Step Implementation

The CH query is a client-side bidirectional Dijkstra that pulls upward adjacency from Neo4j on demand. Keeping the search in Python — rather than as one monolithic Cypher traversal — gives you direct control over the two priority queues and the stopping rule, and it maps cleanly onto the async driver. Each expansion is a single parameterized query that returns only the higher-ranked neighbours of one node.

### 1. Build one driver and expose an upward-neighbour query

The driver is created once per process; each expansion opens its own short session. The Cypher matches both `:ROUTE` and `:SHORTCUT` and keeps only edges that climb in rank.

```python
import asyncio
import heapq
import math
from typing import Optional

from neo4j import AsyncDriver, AsyncGraphDatabase

UPWARD_OUT = """
MATCH (n:Node {id: $id})-[r:ROUTE|SHORTCUT]->(m:Node)
WHERE m.ch_rank > n.ch_rank
RETURN m.id AS nbr, r.weight AS w
"""

UPWARD_IN = """
MATCH (n:Node {id: $id})<-[r:ROUTE|SHORTCUT]-(m:Node)
WHERE m.ch_rank > n.ch_rank
RETURN m.id AS nbr, r.weight AS w
"""


def init_driver(uri: str, user: str, password: str) -> AsyncDriver:
    return AsyncGraphDatabase.driver(
        uri,
        auth=(user, password),
        max_connection_pool_size=40,
        connection_acquisition_timeout=10.0,
        max_connection_lifetime=300,
    )
```

### 2. Expand one frontier node against the overlay

The forward search expands *outgoing* upward edges; the backward search expands *incoming* upward edges (equivalent to running the forward rule on the reversed graph). Both share the same shape.

```python
async def upward_neighbours(driver: AsyncDriver, node_id: str, forward: bool):
    query = UPWARD_OUT if forward else UPWARD_IN
    async with driver.session() as session:
        result = await session.run(query, id=node_id)
        return [(record["nbr"], record["w"]) async for record in result]
```

### 3. Run the bidirectional upward search

Both directions settle upward until neither queue can beat the best meeting distance found so far. The stopping rule is the standard CH one: stop a direction once its minimum queue key exceeds the best joined distance `mu`.

```python
async def ch_shortest_path(
    driver: AsyncDriver, source_id: str, target_id: str
) -> Optional[float]:
    """Bidirectional upward Dijkstra over a CH overlay. Returns the optimal
    cost, or None if the two searches never meet."""
    dist = ({source_id: 0.0}, {target_id: 0.0})   # forward, backward
    pq = ([(0.0, source_id)], [(0.0, target_id)])
    settled = ({}, {})
    mu = math.inf                                  # best meeting distance

    while pq[0] or pq[1]:
        for d in (0, 1):                           # 0 = forward, 1 = backward
            if not pq[d]:
                continue
            cost, node = heapq.heappop(pq[d])
            if node in settled[d]:
                continue
            settled[d][node] = cost
            # Meeting check: node settled from the other side closes a route
            if node in settled[1 - d]:
                mu = min(mu, cost + settled[1 - d][node])
            if cost > mu:                          # this side can't improve mu
                pq[d].clear()
                continue
            for nbr, w in await upward_neighbours(driver, node, forward=(d == 0)):
                nd = cost + w
                if nd < dist[d].get(nbr, math.inf):
                    dist[d][nbr] = nd
                    heapq.heappush(pq[d], (nd, nbr))

    return None if mu == math.inf else mu


async def main():
    driver = init_driver("neo4j://localhost:7687", "neo4j", "secure_password")
    try:
        cost = await ch_shortest_path(driver, "muc_hbf", "ham_hbf")
        print("no route" if cost is None else f"optimal cost: {cost:.1f}")
    finally:
        await driver.close()


if __name__ == "__main__":
    asyncio.run(main())
```

This returns the optimal cost. To recover the actual road path, keep parent pointers in each direction, stitch them at the apex node, then recursively replace each `:SHORTCUT` hop with its `via` midpoint until only `:ROUTE` edges remain — the unpacking variant below.

## Query Patterns and Variants

The upward search is the core, but the overlay supports a few related shapes. Pick by what the caller consumes: a cost, a node sequence, or a fully expanded geometry.

**Variant A — pure-Cypher single-direction upward relax.** When you only need cost-to-many upward-reachable targets (for example, a partial CH used as a candidate pre-rank), a single directed variable-length match restricted to climbing edges keeps the expansion inside the hierarchy. Cap the hop count so a pathological chain cannot explode.

```cypher
MATCH path = (s:Node {id: $source})-[:ROUTE|SHORTCUT*1..40]->(t:Node)
WHERE ALL(i IN range(0, length(path) - 1)
          WHERE nodes(path)[i].ch_rank < nodes(path)[i + 1].ch_rank)
RETURN t.id AS target,
       reduce(c = 0.0, r IN relationships(path) | c + r.weight) AS cost
ORDER BY cost ASC
// The ALL(...) guard enforces strictly-increasing rank — the upward-graph restriction.
```

**Variant B — shortcut unpacking to a road-level path.** A CH path is a mix of `:ROUTE` and `:SHORTCUT` hops. Each shortcut stores `via`, the node contracted when it was created, so unpacking is a recursive rewrite: replace `u -[:SHORTCUT]-> w` with `u -> via -> w` and repeat until every hop is an original edge.

```cypher
// Expand one shortcut hop into its two underlying edges
MATCH (u:Node {id: $u})-[sc:SHORTCUT]->(w:Node {id: $w})
MATCH (u)-[:ROUTE|SHORTCUT]->(via:Node {id: sc.via})-[:ROUTE|SHORTCUT]->(w)
RETURN sc.via AS mid, sc.weight AS total
// Recurse on (u, mid) and (mid, w) until both legs are :ROUTE edges.
```

**Variant C — bounded corridor pre-filter before the search.** For interactive routing you often anchor endpoints with a spatial predicate first, so a mis-typed id cannot launch a search from the wrong continent. Anchor both endpoints with the same index-backed bounding box used across the [distance filter query patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/), then hand the resolved ids to the upward search.

```cypher
MATCH (n:Node)
WHERE n.location.latitude  >= $min_lat AND n.location.latitude  <= $max_lat
  AND n.location.longitude >= $min_lon AND n.location.longitude <= $max_lon
RETURN n.id AS id
ORDER BY point.distance(n.location, point({srid:4326, latitude:$lat, longitude:$lon})) ASC
LIMIT 1
```

## Performance Tuning

The whole point of CH is a small settled set, so profiling means confirming the search stays upward and stays sparse.

- **Confirm the rank seek, not a scan.** Run `PROFILE` on the `upward_neighbours` query. A healthy plan enters through the `:Node(id)` lookup and applies the `ch_rank` comparison as a cheap `Filter` on the expanded neighbours — never a `NodeByLabelScan`. If the id lookup is scanning, the uniqueness constraint or its backing index is missing.
- **Count settled nodes, not milliseconds.** The reliable CH health metric is how many nodes each direction settles. On a well-ordered continental hierarchy that number is in the low hundreds; if it climbs into the thousands, the node ordering is poor or shortcuts are missing, and the fix is in preprocessing, not the query.
- **Batch the expansion.** One round-trip per settled node makes network latency, not graph work, the bottleneck. Expand a whole frontier layer in a single query with `UNWIND $ids AS id` rather than per-node calls when you control the frontier — this is the same batching discipline used for [async graph ingestion](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/async-batch-processing-for-graphs/).
- **Keep the overlay resident.** Shortcuts roughly increase edge count, so size the page cache to hold both `:ROUTE` and `:SHORTCUT` adjacency plus the `ch_rank` index. If the overlay spills to disk the microsecond promise evaporates.
- **Parameterize ids and ranks.** Literal ids baked into the query string thrash the plan cache; pass `$id` so the plan stays warm across millions of expansions.

The systematic version of this loop — reading `EXPLAIN`/`PROFILE` and forcing index seeks — is [graph query planner optimization](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/), and choosing the index that keeps the id and rank lookups fast is covered under [spatial indexing strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/).

## Edge Cases and Gotchas

- **Stale overlay after a topology edit.** A single new one-way restriction or a re-weighted segment can invalidate shortcuts anywhere in the hierarchy. CH has no cheap incremental update for arbitrary edits — the correct response is to rebuild (or partially rebuild) the overlay offline and swap it in. Graphs that change every few minutes should not use CH at all; route them with the live-edit-friendly patterns in [Turn-Restriction and Time-Dependent Routing](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/turn-restriction-and-time-dependent-routing/).
- **Rank ties.** If two nodes share a `ch_rank`, the strict `>` comparison drops legitimate upward edges and the search can miss the optimal meeting node. Enforce a total order — break ties by node id during preprocessing so `ch_rank` is unique.
- **Directed shortcuts on one-way streets.** A shortcut inherits direction from the edges it replaces. Storing shortcuts as undirected, or reusing a forward shortcut in the backward search, silently produces routes that drive the wrong way down a one-way. Keep `:SHORTCUT` directed and expand incoming edges for the backward frontier.
- **Forgetting the stopping rule.** Without the `cost > mu` cutoff, both searches keep climbing to the top of the hierarchy and you lose most of the speedup while still getting the right answer — a correctness-safe but performance-fatal bug. Verify the settled count drops sharply once the frontiers meet.
- **Weight unit drift.** The overlay is built against one weight semantics (seconds, or meters). Querying it with a differently scaled `weight` returns confidently wrong costs. Pin the unit at preprocessing and assert it at query time.

## Verification and Testing

A CH overlay is only trustworthy if its answers match a plain Dijkstra over the *base* graph on the same queries. The essential regression test builds a tiny network, contracts it, and asserts the upward search reproduces the ground-truth cost — because a bad node ordering or a missing shortcut changes results silently, not loudly.

```python
import heapq
import pytest
from neo4j import AsyncGraphDatabase

SEED = """
CREATE (a:Node {id:'a', ch_rank:1, location: point({srid:4326, latitude:48.14, longitude:11.56})})
CREATE (b:Node {id:'b', ch_rank:2, location: point({srid:4326, latitude:48.78, longitude:11.42})})
CREATE (c:Node {id:'c', ch_rank:4, location: point({srid:4326, latitude:49.45, longitude:11.07})})
CREATE (d:Node {id:'d', ch_rank:3, location: point({srid:4326, latitude:50.11, longitude:10.00})})
CREATE (a)-[:ROUTE {weight: 5.0}]->(b)
CREATE (b)-[:ROUTE {weight: 4.0}]->(c)
CREATE (c)-[:ROUTE {weight: 6.0}]->(d)
// contracting b (lowest rank among interior) inserts a->c shortcut via b
CREATE (a)-[:SHORTCUT {weight: 9.0, via: 'b'}]->(c)
"""


async def dijkstra_base(session, source, target):
    """Ground truth over ROUTE edges only — no rank restriction."""
    dist, pq = {source: 0.0}, [(0.0, source)]
    while pq:
        cost, node = heapq.heappop(pq)
        if node == target:
            return cost
        res = await session.run(
            "MATCH (n:Node {id:$id})-[r:ROUTE]->(m) RETURN m.id AS nbr, r.weight AS w",
            id=node,
        )
        async for rec in res:
            nd = cost + rec["w"]
            if nd < dist.get(rec["nbr"], float("inf")):
                dist[rec["nbr"]] = nd
                heapq.heappush(pq, (nd, rec["nbr"]))
    return None


@pytest.mark.asyncio
async def test_ch_matches_base_dijkstra():
    driver = AsyncGraphDatabase.driver("bolt://localhost:7687", auth=("neo4j", "test"))
    async with driver.session(database="neo4j") as s:
        await s.run("MATCH (n) DETACH DELETE n")
        await s.run(SEED)
        truth = await dijkstra_base(s, "a", "d")
    from ch_query import ch_shortest_path  # the module under test
    got = await ch_shortest_path(driver, "a", "d")
    assert got == pytest.approx(truth), "CH cost must equal base-graph Dijkstra"
    await driver.close()
```

Pair the cost assertion with a settled-node check: instrument `ch_shortest_path` to count expansions and assert it settles far fewer nodes than the base Dijkstra touches. A regression that quietly reverts the upward restriction still returns the right cost, so only the settled-count assertion catches it.

## FAQ

<details>
<summary>Do contraction hierarchies replace Dijkstra and A star?</summary>

No — CH is an acceleration layer over the same weighted shortest-path problem, not a different result. The query is still a Dijkstra, just bidirectional and restricted to upward edges over a preprocessed overlay. Use plain Dijkstra or A star when the graph changes constantly or when you need cost-to-all-targets; invest in CH only once query volume on a stable graph justifies the preprocessing cost.
</details>

<details>
<summary>Why does the search only follow edges to higher-ranked nodes?</summary>

The shortcut construction guarantees that between any two nodes there is a shortest path that first only climbs in rank and then only descends. Splitting that into a forward up-search from the source and a backward up-search from the target lets both explore a tiny slice of the hierarchy and meet at the single highest-ranked node on the route. Following downward edges would re-introduce the wide fan-out that CH exists to avoid.
</details>

<details>
<summary>How do I turn a CH result back into a real road path?</summary>

The path returned by the upward search is a mix of original and shortcut edges. Each shortcut stores the node that was contracted when it was created, in a via property. Unpacking is a recursive rewrite: replace every shortcut hop with the two edges through its via node, and repeat until every hop is an original road edge. The stitched sequence is the turn-by-turn route.
</details>

<details>
<summary>What happens when the road network changes?</summary>

A contraction hierarchy is valid only for the topology it was built against. A new turn restriction or a re-weighted segment can invalidate shortcuts anywhere in the order, and CH has no cheap incremental update for arbitrary edits. The practical pattern is to rebuild the overlay offline and hot-swap it. Networks that mutate every few minutes are a poor fit and should use live-edit-friendly routing instead.
</details>

<details>
<summary>How much extra storage does the overlay add?</summary>

Contraction inserts shortcut edges, so the overlay increases the edge count of the graph by a modest multiple that depends on the network and the ordering quality. Plan page cache to hold both the original and shortcut adjacency plus the rank index; if the overlay spills to disk the query loses the microsecond latency that motivated building it.
</details>

## Related

- [Precomputing Contraction-Hierarchy Shortcut Edges in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/contraction-hierarchies-for-road-networks/precomputing-shortcut-edges-in-python/) — the node-ordering and witness-search routine that builds the overlay.
- [Routing Algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/routing-algorithms-python/) — the Dijkstra and A star baseline that CH accelerates.
- [Turn-Restriction and Time-Dependent Routing](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/turn-restriction-and-time-dependent-routing/) — the right approach when topology changes too often for a precomputed overlay.
- [Neo4j GDS vs Cypher Routing](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/neo4j-gds-vs-cypher-routing/) — where built-in shortest-path fits versus a custom hierarchy.
- [Spatial Indexing Strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) — keeping the id and rank lookups index-backed.

This guide is part of [Network Routing Algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/).

For authoritative background on the algorithm, consult the original Geisberger, Sanders, Schultes, and Delling paper on [Contraction Hierarchies](https://algo2.iti.kit.edu/schultes/hwy/contract.pdf) and the [Neo4j GDS path-finding documentation](https://neo4j.com/docs/graph-data-science/current/algorithms/pathfinding/).

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "Do contraction hierarchies replace Dijkstra and A star?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "No. CH is an acceleration layer over the same weighted shortest-path problem, not a different result. The query is still a Dijkstra, just bidirectional and restricted to upward edges over a preprocessed overlay. Use plain Dijkstra or A star when the graph changes constantly or when you need cost-to-all-targets, and invest in CH only once query volume on a stable graph justifies the preprocessing cost."
      }
    },
    {
      "@type": "Question",
      "name": "Why does the search only follow edges to higher-ranked nodes?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "The shortcut construction guarantees that between any two nodes there is a shortest path that first only climbs in rank and then only descends. Splitting that into a forward up-search from the source and a backward up-search from the target lets both explore a tiny slice of the hierarchy and meet at the single highest-ranked node on the route. Following downward edges would re-introduce the wide fan-out that CH exists to avoid."
      }
    },
    {
      "@type": "Question",
      "name": "How do I turn a CH result back into a real road path?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "The path returned by the upward search is a mix of original and shortcut edges. Each shortcut stores the node that was contracted when it was created, in a via property. Unpacking is a recursive rewrite: replace every shortcut hop with the two edges through its via node, and repeat until every hop is an original road edge. The stitched sequence is the turn-by-turn route."
      }
    },
    {
      "@type": "Question",
      "name": "What happens when the road network changes?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "A contraction hierarchy is valid only for the topology it was built against. A new turn restriction or a re-weighted segment can invalidate shortcuts anywhere in the order, and CH has no cheap incremental update for arbitrary edits. The practical pattern is to rebuild the overlay offline and hot-swap it. Networks that mutate every few minutes are a poor fit and should use live-edit-friendly routing instead."
      }
    },
    {
      "@type": "Question",
      "name": "How much extra storage does the overlay add?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Contraction inserts shortcut edges, so the overlay increases the edge count of the graph by a modest multiple that depends on the network and the ordering quality. Plan page cache to hold both the original and shortcut adjacency plus the rank index. If the overlay spills to disk the query loses the microsecond latency that motivated building it."
      }
    }
  ]
}
</script>
