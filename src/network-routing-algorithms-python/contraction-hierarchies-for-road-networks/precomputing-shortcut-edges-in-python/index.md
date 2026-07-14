---
pageTitle: Precomputing CH Shortcut Edges
---
# Precomputing Contraction-Hierarchy Shortcut Edges in Python

The query side of a contraction hierarchy is only ever as good as the shortcuts the preprocessing produced, and this is exactly where builds go wrong: contract nodes in a careless order and the overlay balloons with redundant shortcuts, or set the witness search too aggressively and you drop shortcuts the query genuinely needs — which surfaces as *plausible but wrong* costs, not a crash. The root cause is that shortcut insertion is a decision, not a mechanical step: for every pair of neighbours of the node being contracted, you must prove whether an alternative path already carries the shortest distance before deciding to add an edge. This page gives one complete Python routine that orders nodes by the edge-difference heuristic, runs bounded witness searches to make that decision correctly, and writes the resulting `:SHORTCUT` relationships back to Neo4j through async batched `UNWIND`. It is the build step behind [Contraction Hierarchies for Road Networks](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/contraction-hierarchies-for-road-networks/), within [Network Routing Algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/).

<svg viewBox="0 0 760 380" role="img" aria-labelledby="witTitle witDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="witTitle">Contracting one node: comparing the path through it against a witness path to decide a shortcut</title>
  <desc id="witDesc">Left panel, before contraction: node v sits between neighbours u and w, with edge u to v weight 4 and edge v to w weight 3, so the path through v costs 7. A separate witness path runs u to x to w with weights 5 and 4, costing 9. Right panel, after contraction: v is removed and faded because 7 is less than the best witness of 9, so no alternative path is short enough. A bold dashed shortcut edge from u to w is added with weight 7, and it stores via equals v so it can be unpacked later. The witness path u to x to w remains in the graph.</desc>
  <defs>
    <marker id="wit-arr" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
    <marker id="wit-sc" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7.5" markerHeight="7.5" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="var(--accent-3,#5b21b6)"/>
    </marker>
  </defs>
  <line x1="380" y1="40" x2="380" y2="352" stroke="var(--line,#e5e0d2)" stroke-width="1" stroke-dasharray="3 6" opacity="0.6"/>
  <!-- ===== LEFT: before ===== -->
  <text x="185" y="28" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">Before — evaluate contraction of v</text>
  <!-- witness path edges -->
  <line x1="84" y1="140" x2="181" y2="72" stroke="currentColor" stroke-width="1.8" opacity="0.55" marker-end="url(#wit-arr)"/>
  <line x1="209" y1="72" x2="306" y2="140" stroke="currentColor" stroke-width="1.8" opacity="0.55" marker-end="url(#wit-arr)"/>
  <!-- through-v edges -->
  <line x1="82" y1="164" x2="181" y2="244" stroke="var(--accent,#0a656d)" stroke-width="2.4" marker-end="url(#wit-arr)"/>
  <line x1="209" y1="244" x2="308" y2="164" stroke="var(--accent,#0a656d)" stroke-width="2.4" marker-end="url(#wit-arr)"/>
  <!-- weights -->
  <text x="120" y="98" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.7">5</text>
  <text x="270" y="98" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.7">4</text>
  <text x="118" y="212" text-anchor="middle" font-size="11" fill="var(--accent,#0a656d)" font-weight="600">4</text>
  <text x="272" y="212" text-anchor="middle" font-size="11" fill="var(--accent,#0a656d)" font-weight="600">3</text>
  <!-- nodes -->
  <circle cx="70" cy="150" r="15" fill="var(--accent,#0a656d)"/><text x="70" y="154" text-anchor="middle" font-size="12" font-weight="700" fill="#fff">u</text>
  <circle cx="320" cy="150" r="15" fill="var(--accent,#0a656d)"/><text x="320" y="154" text-anchor="middle" font-size="12" font-weight="700" fill="#fff">w</text>
  <circle cx="195" cy="60" r="13" fill="var(--surface-2,#fff)" stroke="currentColor" stroke-width="1.8"/><text x="195" y="64" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">x</text>
  <circle cx="195" cy="255" r="15" fill="var(--accent-4,#b58900)"/><text x="195" y="259" text-anchor="middle" font-size="12" font-weight="700" fill="#fff">v</text>
  <text x="195" y="300" text-anchor="middle" font-size="11" font-weight="700" fill="var(--accent,#0a656d)">through v = 7</text>
  <text x="195" y="320" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.75">witness u–x–w = 9</text>
  <!-- ===== RIGHT: after ===== -->
  <g transform="translate(390,0)">
    <text x="185" y="28" text-anchor="middle" font-size="14" font-weight="700" fill="currentColor">After — 7 &lt; 9, add shortcut</text>
    <!-- witness path stays -->
    <line x1="84" y1="140" x2="181" y2="72" stroke="currentColor" stroke-width="1.8" opacity="0.4" marker-end="url(#wit-arr)"/>
    <line x1="209" y1="72" x2="306" y2="140" stroke="currentColor" stroke-width="1.8" opacity="0.4" marker-end="url(#wit-arr)"/>
    <!-- shortcut arc through where v was -->
    <path d="M83 162 C 150 250, 240 250, 307 162" fill="none" stroke="var(--accent-3,#5b21b6)" stroke-width="2.8" stroke-dasharray="8 5" marker-end="url(#wit-sc)"/>
    <rect x="112" y="214" width="166" height="42" rx="9" fill="var(--surface-2,#fff)" stroke="var(--accent-3,#5b21b6)" stroke-width="1.6"/>
    <text x="195" y="232" text-anchor="middle" font-size="12" font-weight="700" fill="var(--accent-3,#5b21b6)">:SHORTCUT</text>
    <text x="195" y="248" text-anchor="middle" font-size="10.5" fill="currentColor">weight 7 · via v</text>
    <!-- nodes -->
    <circle cx="70" cy="150" r="15" fill="var(--accent,#0a656d)"/><text x="70" y="154" text-anchor="middle" font-size="12" font-weight="700" fill="#fff">u</text>
    <circle cx="320" cy="150" r="15" fill="var(--accent,#0a656d)"/><text x="320" y="154" text-anchor="middle" font-size="12" font-weight="700" fill="#fff">w</text>
    <circle cx="195" cy="60" r="13" fill="var(--surface-2,#fff)" stroke="currentColor" stroke-width="1.8"/><text x="195" y="64" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">x</text>
    <circle cx="195" cy="120" r="13" fill="var(--surface-3,#f1ede2)" stroke="currentColor" stroke-width="1.6" stroke-dasharray="4 3" opacity="0.7"/>
    <text x="195" y="124" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor" opacity="0.7">v</text>
    <text x="195" y="150" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.6">contracted</text>
  </g>
</svg>

## Prerequisites and Versions

The builder holds the working graph in memory during contraction and talks to Neo4j only to load the base edges and to persist the results, so the algorithm itself has no plugin dependency.

| Requirement | Minimum version | Note |
| --- | --- | --- |
| Python | 3.10+ | `heapq`, `dataclass`, and modern type hints used below |
| Neo4j | 5.13+ | Native `point`, unique constraint on `Node.id`, batched `UNWIND` writes |
| neo4j (driver) | 5.x | `AsyncGraphDatabase`, async sessions |

```bash
pip install "neo4j>=5.18"
```

This routine assumes a base graph that already follows the schema from the parent guide — a unique `id` per node and directed `:ROUTE` edges carrying a numeric `weight`. It writes back a `ch_rank` on every node and `:SHORTCUT` edges with a `via` midpoint.

## Implementation

The builder runs in four phases: load adjacency into memory, seed a lazy priority queue keyed on edge difference, contract nodes one at a time (recomputing witness searches and collecting shortcuts), then flush ranks and shortcuts to Neo4j in bounded batches.

```python
import asyncio
import heapq
from collections import defaultdict
from dataclasses import dataclass, field

from neo4j import AsyncDriver, AsyncGraphDatabase


@dataclass
class CHBuilder:
    """Builds a contraction hierarchy overlay for a directed weighted graph."""
    out_adj: dict = field(default_factory=lambda: defaultdict(dict))  # u -> {v: w}
    in_adj: dict = field(default_factory=lambda: defaultdict(dict))   # v -> {u: w}
    rank: dict = field(default_factory=dict)                          # node -> ch_rank
    shortcuts: list = field(default_factory=list)                     # (u, w, weight, via)
    contracted: set = field(default_factory=set)
    max_settled: int = 60          # witness-search node budget
    lam: int = 1                   # weight on the "spread" term

    # ---- witness search: is there a path u->w (avoiding v) no longer than limit? ----
    def _witness_exists(self, u: str, w: str, via: str, limit: float) -> bool:
        dist = {u: 0.0}
        pq = [(0.0, u)]
        settled = 0
        while pq and settled < self.max_settled:
            d, node = heapq.heappop(pq)
            if d > dist.get(node, float("inf")):
                continue
            if node == w and d <= limit:
                return True
            if d > limit:                       # cannot beat the shortcut anymore
                continue
            settled += 1
            for nbr, wt in self.out_adj[node].items():
                if nbr == via or nbr in self.contracted:
                    continue                    # witness must not use the contracted node
                nd = d + wt
                if nd < dist.get(nbr, float("inf")):
                    dist[nbr] = nd
                    heapq.heappush(pq, (nd, nbr))
        return False

    # ---- simulate contracting v: return the shortcuts it would require ----
    def _needed_shortcuts(self, v: str) -> list:
        needed = []
        preds = {u: wt for u, wt in self.in_adj[v].items() if u not in self.contracted}
        succs = {w: wt for w, wt in self.out_adj[v].items() if w not in self.contracted}
        for u, w_uv in preds.items():
            for w, w_vw in succs.items():
                if u == w:
                    continue
                limit = w_uv + w_vw
                if not self._witness_exists(u, w, via=v, limit=limit):
                    needed.append((u, w, limit))
        return needed

    # ---- edge-difference priority; lower is contracted sooner ----
    def _priority(self, v: str) -> int:
        added = len(self._needed_shortcuts(v))
        degree = len(self.in_adj[v]) + len(self.out_adj[v])
        spread = sum(1 for n in set(self.in_adj[v]) | set(self.out_adj[v])
                     if n in self.contracted)
        return (added - degree) + self.lam * spread

    def build(self) -> None:
        nodes = set(self.out_adj) | set(self.in_adj)
        # lazy PQ: entries may be stale and are revalidated on pop
        pq = [(self._priority(v), v) for v in nodes]
        heapq.heapify(pq)
        order = 0
        while pq:
            _, v = heapq.heappop(pq)
            if v in self.contracted:
                continue
            cur = self._priority(v)             # recompute against current graph
            if pq and cur > pq[0][0]:           # someone is now cheaper: requeue
                heapq.heappush(pq, (cur, v))
                continue
            # commit the contraction of v
            for u, w, weight in self._needed_shortcuts(v):
                self.out_adj[u][w] = min(self.out_adj[u].get(w, float("inf")), weight)
                self.in_adj[w][u] = self.out_adj[u][w]
                self.shortcuts.append((u, w, weight, v))
            self.contracted.add(v)
            self.rank[v] = order
            order += 1


#-- Neo4j I/O (load base edges, persist ranks + shortcuts) --
async def load_graph(driver: AsyncDriver, builder: CHBuilder) -> None:
    async with driver.session() as session:
        result = await session.run(
            "MATCH (a:Node)-[r:ROUTE]->(b:Node) RETURN a.id AS u, b.id AS v, r.weight AS w"
        )
        async for rec in result:
            builder.out_adj[rec["u"]][rec["v"]] = rec["w"]
            builder.in_adj[rec["v"]][rec["u"]] = rec["w"]


async def persist(driver: AsyncDriver, builder: CHBuilder, batch: int = 5_000) -> None:
    ranks = [{"id": n, "rank": r} for n, r in builder.rank.items()]
    scs = [{"u": u, "w": w, "weight": wt, "via": via}
           for (u, w, wt, via) in builder.shortcuts]
    async with driver.session() as session:
        for i in range(0, len(ranks), batch):
            await session.run(
                "UNWIND $rows AS row MATCH (n:Node {id: row.id}) SET n.ch_rank = row.rank",
                rows=ranks[i:i + batch],
            )
        for i in range(0, len(scs), batch):
            await session.run(
                """
                UNWIND $rows AS row
                MATCH (u:Node {id: row.u}), (w:Node {id: row.w})
                MERGE (u)-[s:SHORTCUT]->(w)
                SET s.weight = row.weight, s.via = row.via
                """,
                rows=scs[i:i + batch],
            )


async def main():
    driver = AsyncGraphDatabase.driver(
        "neo4j://localhost:7687", auth=("neo4j", "secure_password"),
        max_connection_pool_size=20, connection_acquisition_timeout=15.0,
    )
    try:
        builder = CHBuilder()
        await load_graph(driver, builder)
        builder.build()
        await persist(driver, builder)
        print(f"contracted {len(builder.rank)} nodes, "
              f"added {len(builder.shortcuts)} shortcuts")
    finally:
        await driver.close()


if __name__ == "__main__":
    asyncio.run(main())
```

## How It Works

The routine is a faithful, compact version of the standard node-ordering CH build. Three pieces do the real work.

**Edge-difference priority.** Contraction order decides overlay quality. The cheapest node to contract is the one that adds the fewest shortcuts relative to the edges it removes. That is the edge difference — the count of shortcuts a contraction would create minus the node's degree — combined with a spread term that pushes contraction away from already-contracted regions so the hierarchy grows evenly:

$$p(v) = \bigl(|S(v)| - \deg(v)\bigr) + \lambda \cdot c(v)$$

Here $S(v)$ is the set of shortcuts contracting $v$ would require, $\deg(v)$ is its in-degree plus out-degree, and $c(v)$ is the number of its neighbours already contracted. Lower $p(v)$ contracts first. Because contracting a node changes its neighbours' priorities, the queue is *lazy*: entries are recomputed on pop and requeued if a cheaper node now exists (the `cur > pq[0][0]` check), which keeps the priorities approximately current without rebuilding the whole heap every step.

**Witness search.** For each pair of a predecessor $u$ and successor $w$ of $v$, the candidate shortcut weight is $w(u,v)+w(v,w)$. `_witness_exists` runs a local Dijkstra from $u$ that is forbidden from using $v$ and asks whether $w$ is reachable within that limit. If a witness path exists, the shortcut is redundant and skipped; if not, it is required to preserve the shortest distance. The search is bounded twice — by the distance `limit` and by `max_settled` — so it stays local instead of exploring the whole graph.

**Marking the rank.** Each committed contraction assigns the node the next `ch_rank` value (`order`), so rank encodes contraction sequence. That integer is what the [query-side upward search](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/contraction-hierarchies-for-road-networks/) walks, and every shortcut records the contracted node in `via` so it can later be unpacked into the underlying road edges.

## Common Failure Patterns

**1. Witness cutoff too tight — spurious shortcuts.** Capping `max_settled` too low, or forgetting the `d > limit` prune's counterpart, makes the witness search give up before it finds a genuinely shorter alternative. It then reports "no witness" and inserts a shortcut that was never needed. The overlay stays *correct* but bloats, and query latency creeps up. The fix is to scale the settle budget to local density rather than a flat constant:

```python
#derive the budget from the node's neighbourhood size, floor at a sane minimum
self.max_settled = max(60, 4 * (len(self.in_adj[v]) + len(self.out_adj[v])))
```

**2. Unbounded shortcut explosion.** Contracting high-degree nodes early is the classic blow-up: each creates a near-complete bipartite set of shortcuts among its neighbours, which raises everyone else's edge difference, which creates still more shortcuts. If shortcut count grows super-linearly with contracted nodes, the ordering is inverted. Keep the priority honest by recomputing it lazily (done above) and by tracking the ratio as a tripwire:

```python
if builder.shortcuts and len(builder.shortcuts) > 4 * len(builder.rank):
    raise RuntimeError("shortcut explosion — check contraction order / witness budget")
```

**3. Forgetting to mark contraction level or rank.** A shortcut set with no `ch_rank` on the nodes is useless — the upward search has no order to climb, so it cannot restrict expansion and silently degrades to a full bidirectional Dijkstra. Equally, non-unique ranks break the strict `>` comparison the query relies on. Assign rank inside the contraction loop (never as a separate pass that can drift) and assert uniqueness before persisting:

```python
assert len(set(builder.rank.values())) == len(builder.rank), "ch_rank must be unique"
```

## Performance Notes

Preprocessing cost is dominated by witness searches, not by the writes. Each contraction runs one bounded Dijkstra per predecessor-successor pair, so the work at node $v$ is roughly

$$T(v) \approx \deg_{\text{in}}(v)\cdot\deg_{\text{out}}(v)\cdot O(\text{max\_settled})$$

which is exactly why contracting low-degree nodes first matters: the product of in- and out-degree is small there, and deferring dense hubs until their neighbourhoods have thinned keeps every witness search cheap. Budget the build as a minutes-to-hours offline job for a country-scale network, run on a snapshot, never in the request path.

On write-back, keep batches bounded (a few thousand rows per `UNWIND`) so each transaction stays within memory and lock limits — the same discipline detailed for [async graph ingestion](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/async-batch-processing-for-graphs/). Because the overlay is an offline artifact, the whole build-and-swap belongs on a schedule, which is why contraction hierarchies fit static topology and constantly-edited graphs need a different approach entirely; that boundary is drawn in the parent guide.

## Related

- [Contraction Hierarchies for Road Networks](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/contraction-hierarchies-for-road-networks/) — the query-side upward search this overlay feeds, plus schema and storage.
- [Routing Algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/routing-algorithms-python/) — the Dijkstra and A star baseline the hierarchy accelerates.
- [Async Batch Processing for Graphs](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/async-batch-processing-for-graphs/) — the batched `UNWIND` write-back pattern used to persist ranks and shortcuts.
- [Graph Query Planner Optimization](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/) — keeping the id lookups in the write-back and query index-backed.

This guide is part of [Contraction Hierarchies for Road Networks](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/contraction-hierarchies-for-road-networks/), within [Network Routing Algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/).

For authoritative background, consult the original [Contraction Hierarchies paper](https://algo2.iti.kit.edu/schultes/hwy/contract.pdf) by Geisberger, Sanders, Schultes, and Delling.
