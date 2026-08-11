---
pageTitle: Many-to-Many Cost Matrices
title: Many-to-Many Cost Matrices with Neo4j GDS
description: Build a bounded, cached, concurrently-computed cost matrix from one projection, and keep the unreachable cells visible instead of silently zero.
slug: many-to-many-cost-matrices-with-gds
type: article
breadcrumb: Cost Matrices
datePublished: 2026-08-11
dateModified: 2026-08-11
---
# Many-to-Many Cost Matrices with Neo4j GDS

The cost matrix is the piece of fleet routing that decides whether the whole thing is a batch job or an interactive one. A naive build issues one point-to-point query per cell, holds a projection open for the duration, explores the entire national network on every one of them, and returns a table with zeros where the graph had no answer. Each of those four decisions is independently fixable, and fixing them together turns a twenty-minute job into a few seconds. This page builds the matrix the way it should be built: one bounded single-source search per origin against one resident projection, run concurrently, cached by input, and explicit about what it could not reach.

## Prerequisites & Versions

Single-source Dijkstra from the standard GDS distribution; the concurrency and caching are ordinary Python.

| Requirement | Minimum version | Install |
| --- | --- | --- |
| Python | 3.11 | — |
| neo4j (async driver) | 5.20 | `pip install "neo4j>=5.20"` |
| Neo4j Server | 5.15 | native `point` |
| Graph Data Science | 2.6 | `gds.allShortestPaths.dijkstra` |

## Implementation

```python
import asyncio
import math
from dataclasses import dataclass

from neo4j import AsyncGraphDatabase

ROW = """
MATCH (src:Stop {id: $source_id})
CALL gds.allShortestPaths.dijkstra.stream($graph, {
  sourceNode: src,
  relationshipWeightProperty: 'seconds'
})
YIELD targetNode, totalCost
WITH gds.util.asNode(targetNode) AS t, totalCost
WHERE totalCost <= $max_seconds AND t.id IN $target_ids
RETURN t.id AS target_id, totalCost AS seconds
"""


@dataclass(frozen=True)
class MatrixResult:
    cells: dict[tuple[str, str], float]
    unreachable: list[tuple[str, str]]

    def get(self, source: str, target: str) -> float:
        # Never 0.0 for a missing pair: a zero is the cheapest value in the
        # table and will win every comparison it enters, so an unreachable
        # stop would be assigned to every vehicle in preference to a real one.
        return self.cells.get((source, target), math.inf)

    @property
    def coverage(self) -> float:
        total = len(self.cells) + len(self.unreachable)
        return len(self.cells) / total if total else 1.0


class MatrixBuilder:
    def __init__(self, uri: str, auth: tuple[str, str], graph: str,
                 concurrency: int = 8) -> None:
        self._driver = AsyncGraphDatabase.driver(uri, auth=auth)
        self._graph = graph
        self._semaphore = asyncio.Semaphore(concurrency)

    async def close(self) -> None:
        await self._driver.close()

    async def _row(self, source_id: str, target_ids: list[str],
                   max_seconds: float) -> dict[str, float]:
        # The semaphore bounds concurrent sessions against the pool, exactly as
        # the write path does — these are independent reads, but an unbounded
        # fan-out over 300 origins will exhaust the pool just as fast.
        async with self._semaphore:
            async with self._driver.session() as session:
                result = await session.run(
                    ROW, graph=self._graph, source_id=source_id,
                    target_ids=target_ids, max_seconds=max_seconds,
                )
                return {r["target_id"]: float(r["seconds"]) async for r in result}

    async def build(self, sources: list[str], targets: list[str],
                    max_seconds: float = 7_200) -> MatrixResult:
        rows = await asyncio.gather(
            *(self._row(s, targets, max_seconds) for s in sources)
        )

        cells: dict[tuple[str, str], float] = {}
        unreachable: list[tuple[str, str]] = []
        for source_id, row in zip(sources, rows):
            for target_id in targets:
                if target_id in row:
                    cells[(source_id, target_id)] = row[target_id]
                elif source_id != target_id:
                    # Either genuinely disconnected, or beyond the bound. Both
                    # are "cannot serve", and both belong in the report.
                    unreachable.append((source_id, target_id))
        return MatrixResult(cells=cells, unreachable=unreachable)


async def main() -> None:
    builder = MatrixBuilder(
        "neo4j://localhost:7687", ("neo4j", "password"), graph="road-network"
    )
    try:
        depots = [f"depot:{i}" for i in range(40)]
        stops = [f"stop:{i}" for i in range(300)]
        matrix = await builder.build(depots, stops, max_seconds=5_400)
    finally:
        await builder.close()

    print(f"{len(matrix.cells):,} cells · coverage {matrix.coverage:.1%}")
    if matrix.unreachable:
        print(f"unreachable: {len(matrix.unreachable):,} pairs, "
              f"e.g. {matrix.unreachable[:3]}")
```

## How It Works

Four decisions, each worth a large factor.

**One row per search.** `gds.allShortestPaths.dijkstra` settles every reachable node from the source in one pass, so filtering its output to the target set yields a complete matrix row. A point-to-point query per cell repeats almost the same exploration once per target and discards everything it learned about the other 299.

**The cost bound is what stops each search exploring a continent.** Without `totalCost <= $max_seconds`, a single-source search on a national graph settles millions of nodes to report on three hundred. The bound turns that into a disc around the origin whose radius is the operational limit you already have — a shift length, a service-level promise — so it is not an approximation but a statement of the problem.

**One projection, held across every row.** Building the projection inside the row function would pay the load cost forty times, which on a large graph dwarfs everything else. The projection is created once, used by every concurrent search, and dropped when the matrix is complete — with the sizing discipline the [projection heap guide](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-memory-and-storage-tuning/tuning-jvm-heap-for-gds-projections/) sets out, because it is now resident for minutes rather than seconds.

**Unreachable is recorded, not defaulted.** A pair the search never reached is absent from the row. Filling it with zero makes it the most attractive cell in the table; filling it with infinity makes it correctly unusable; recording it in a list makes it visible as the data-quality signal it usually is.

<svg viewBox="0 0 780 300" role="img" aria-labelledby="mtxBoundTitle mtxBoundDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="mtxBoundTitle">The cost bound turns a national exploration into a local one, per origin</title>
  <desc id="mtxBoundDesc">The settled node set for a single-source search from one depot, with and without a ninety-minute cost bound. Unbounded, the search settles the whole reachable component — about four million nodes on a national graph — to report costs to three hundred stops. Bounded, it settles a disc around the depot containing roughly ninety thousand nodes, which still contains every stop the vehicle could serve within its shift. The answers for every reachable stop are identical; only the work differs, and the bound is a constraint the fleet already had rather than an approximation introduced to make the query faster.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="300" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Settled nodes for one origin</text>
  <rect x="24" y="42" width="356" height="196" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-poor,#a8320f)" stroke-width="1.6"/>
  <text x="202" y="66" text-anchor="middle" font-size="11.5" font-weight="700" fill="var(--viz-poor,#a8320f)">unbounded</text>
  <rect x="56" y="80" width="292" height="120" rx="8" fill="var(--viz-poor,#a8320f)" opacity="0.2"/>
  <circle cx="202" cy="140" r="7" fill="var(--accent-3,#5b21b6)"/>
  <text x="202" y="164" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--accent-3,#5b21b6)">depot</text>
  <text x="202" y="220" text-anchor="middle" font-size="12" font-weight="700" fill="var(--viz-poor,#a8320f)">~4,000,000 nodes settled</text>
  <rect x="400" y="42" width="356" height="196" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="1.8"/>
  <text x="578" y="66" text-anchor="middle" font-size="11.5" font-weight="700" fill="var(--viz-good,#0a656d)">bounded at 90 minutes</text>
  <rect x="432" y="80" width="292" height="120" rx="8" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1"/>
  <circle cx="578" cy="140" r="52" fill="var(--viz-good,#0a656d)" opacity="0.24"/>
  <circle cx="578" cy="140" r="52" fill="none" stroke="var(--viz-good,#0a656d)" stroke-width="1.8" stroke-dasharray="6 4"/>
  <circle cx="578" cy="140" r="7" fill="var(--accent-3,#5b21b6)"/>
  <text x="578" y="164" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--accent-3,#5b21b6)">depot</text>
  <text x="578" y="220" text-anchor="middle" font-size="12" font-weight="700" fill="var(--viz-good,#0a656d)">~90,000 nodes settled</text>
  <text x="24" y="266" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">Every stop the vehicle could actually serve within its shift is inside the disc, so no usable cell is lost. The bound is</text>
  <text x="24" y="282" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">the shift length the fleet already works to, expressed to the search rather than applied afterwards.</text>
</svg>

## Common Failure Patterns

**1. Projecting inside the loop.** The single most expensive mistake available here, and it looks tidy: each row function creates its graph, uses it and drops it. On a national network that is forty full projections, and the load cost exceeds every search put together.

```python
# WRONG: forty projections of the same graph.
async def row(source_id):
    await session.run("CALL gds.graph.project(...)")
    ...
    await session.run("CALL gds.graph.drop($g, false)", g=name)

# RIGHT: one projection, created before the gather and dropped after it.
await project_once()
try:
    rows = await asyncio.gather(*(self._row(s, targets, bound) for s in sources))
finally:
    await drop_once()
```

**2. Unbounded concurrency over the sources.** `asyncio.gather` over three hundred origins opens three hundred sessions, and the connection pool refuses long before that. The semaphore is the same discipline the [async ingestion path](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/async-batch-processing-for-graphs/) applies to writes, and it applies here for the same reason: the limit is the pool, not the work.

**3. Assuming symmetry.** On a directed network the cost from A to B is not the cost from B to A, and computing only the upper triangle halves the work while producing wrong costs on every one-way street. Symmetry is only safe on a genuinely undirected projection, which a road network is not.

## Performance Notes

Total work is the source count times the settled set per source:

$$C \approx S \cdot \big(|V_b| \log |V_b| + |E_b|\big)$$

where $V_b$ is the bounded settled set rather than the whole graph. Both factors are controllable: $S$ by deduplicating sources that share a depot, and $|V_b|$ by the cost bound. The second is by far the larger lever — halving the bound roughly quarters the settled area, because area grows with the square of radius.

Caching multiplies that again. A fleet's depots are stable for months and its stop set changes daily, so the previous matrix is largely still valid. Keying the cache on `(graph_version, source_id, sorted(target_ids), bound)` and recomputing only the rows whose inputs moved turns the daily rebuild into a handful of rows. The graph version matters: a matrix computed before an [OSM re-import](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/) is silently stale afterwards, and including the version in the key is what makes that a cache miss rather than a wrong answer.

The concurrency setting deserves a measurement rather than a guess. Rows are independent, so throughput rises with concurrency until the server's own parallelism is saturated, after which additional concurrent searches contend for the same projection and the curve flattens or falls. Eight to sixteen is a common landing point on a dedicated instance; on a shared one the right number is lower, because a matrix build that saturates the server is an outage for everything else on it.

<svg viewBox="0 0 780 288" role="img" aria-labelledby="mtxCacheTitle mtxCacheDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="mtxCacheTitle">What actually changes between two daily matrix builds</title>
  <desc id="mtxCacheDesc">A 40 by 300 matrix rebuilt the next day. The depot set is unchanged, so all forty source rows are candidates for reuse. Of the three hundred stops, 268 are the same addresses as yesterday and 32 are new, so only the new columns need computing — and because a row is produced by one search, the whole row is recomputed for any source whose reachable set could have changed. With an unchanged graph version that is none of them, and the rebuild reduces to filling 32 columns from cached rows. A changed graph version invalidates everything, which is why the version belongs in the cache key.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="288" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Day two of a 40 × 300 matrix</text>
  <rect x="24" y="42" width="732" height="60" rx="9" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="1.6"/>
  <text x="44" y="64" font-size="11" font-weight="700" fill="var(--viz-good,#0a656d)">depots — unchanged</text>
  <text x="44" y="82" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">same 40 origins, same graph version</text>
  <rect x="420" y="54" width="310" height="20" rx="10" fill="var(--viz-good,#0a656d)"/>
  <text x="575" y="69" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-on-pill,#ffffff)">40 rows reusable</text>
  <rect x="24" y="112" width="732" height="60" rx="9" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <text x="44" y="134" font-size="11" font-weight="700" fill="currentColor">stops — mostly repeat addresses</text>
  <text x="44" y="152" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">268 seen before · 32 new</text>
  <rect x="420" y="124" width="277" height="20" rx="10" fill="var(--viz-good,#0a656d)"/>
  <rect x="697" y="124" width="33" height="20" rx="10" fill="var(--accent-2,#a8380b)"/>
  <text x="559" y="139" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-on-pill,#ffffff)">cached</text>
  <text x="713" y="139" text-anchor="middle" font-size="9" font-weight="700" fill="var(--viz-on-pill,#ffffff)">32</text>
  <rect x="24" y="182" width="732" height="60" rx="9" fill="var(--viz-panel,#f4f4f5)" stroke="var(--accent-2,#a8380b)" stroke-width="1.6"/>
  <text x="44" y="204" font-size="11" font-weight="700" fill="var(--accent-2,#a8380b)">work actually required</text>
  <text x="44" y="222" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">32 new columns against 40 cached rows — no new searches at all</text>
  <rect x="420" y="194" width="33" height="20" rx="10" fill="var(--accent-2,#a8380b)"/>
  <text x="470" y="209" font-size="10" font-weight="700" fill="currentColor">~1% of a full rebuild</text>
  <text x="24" y="270" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">Change the graph version and every one of those green bars turns red — which is exactly the behaviour you want, and only get if the version is in the key.</text>
</svg>

Two smaller points are worth stating because they are easy to get wrong once and hard to notice afterwards.

The first is that the bound has to be chosen from the *problem*, not from the runtime. It is tempting to lower it until the matrix builds quickly enough, but a bound below the fleet's real reach silently removes assignments that were legitimate — the cells simply do not appear, and they appear in the unreachable list alongside genuinely disconnected stops where nobody looks at them. If the bound is doing performance work rather than expressing a shift length, that should be an explicit, documented approximation with its own metric, not a constant someone tuned during an incident.

The second is that the matrix and the assignment must agree about what a cell means. If the matrix holds depot-to-stop costs but the assignment also needs stop-to-stop costs to sequence a route, those are two different matrices with different source sets, and computing only the first produces an assignment that is correct about which vehicle serves which stop and silent about the order. Building both from the same projection in one pass is cheap; discovering the gap after the assignment is written is not.

## Related

- [Multi-Modal and Fleet Routing on a Spatial Graph](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/multi-modal-and-fleet-routing/) — the layered graph this matrix is computed over.
- [Assigning Deliveries to Vehicles from a Cost Matrix](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/multi-modal-and-fleet-routing/assigning-deliveries-to-vehicles-from-a-cost-matrix/) — what consumes it, and why the unreachable list matters there.
- [Tuning JVM Heap for GDS Projections](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-memory-and-storage-tuning/tuning-jvm-heap-for-gds-projections/) — sizing a projection held across many searches.
- [Computing Drive-Time Isochrones with Neo4j GDS](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/isochrone-and-service-area-analysis/computing-drive-time-isochrones-with-neo4j-gds/) — the same bounded single-source search, read as an area rather than as a row.

This guide is part of [Multi-Modal and Fleet Routing on a Spatial Graph](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/multi-modal-and-fleet-routing/), within [Network Routing Algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/).
