---
pageTitle: Tuning Heap for GDS Projections
title: Tuning JVM Heap for GDS Projections
description: Estimate a projection before you build it, keep the transaction that streams its results off the heap, and stop a routing service from being killed by its own graph.
slug: tuning-jvm-heap-for-gds-projections
type: article
breadcrumb: Heap for Projections
datePublished: 2026-08-11
dateModified: 2026-08-11
---
# Tuning JVM Heap for GDS Projections

The failure has a recognisable shape. A routing endpoint works in staging against a city extract, ships, runs fine for a week, and then one request against a larger region takes the whole instance down with an `OutOfMemoryError` — not the request, the instance. Every other tenant's queries die with it, the container restarts cold, and the next few minutes are served at storage latency while the cache reloads. The cause is almost never the algorithm. It is that a Graph Data Science projection was built without anyone asking what it would weigh, and that the results were collected onto the heap instead of streamed off it. This page covers both halves: estimating a projection before committing to it, and consuming its output without materialising it.

## Prerequisites & Versions

Estimation procedures require GDS 2.x; the async streaming pattern needs a 5.x driver.

| Requirement | Minimum version | Install |
| --- | --- | --- |
| Python | 3.11 | — |
| neo4j (async driver) | 5.20 | `pip install "neo4j>=5.20"` |
| Neo4j Server | 5.15 | — |
| Graph Data Science | 2.6 | `gds.graph.project.estimate` |

## Implementation

The guard below refuses to project a graph it cannot afford, and streams the algorithm's results rather than collecting them. Both halves matter: the estimate keeps the projection from exhausting off-heap memory at build time, and the streaming consumption keeps the *results* from exhausting the heap afterwards.

```python
import asyncio
from dataclasses import dataclass
from typing import AsyncIterator

from neo4j import AsyncGraphDatabase
from neo4j.exceptions import ClientError


class ProjectionTooLarge(RuntimeError):
    """Raised before any memory is committed, rather than after it runs out."""


@dataclass(frozen=True)
class Estimate:
    bytes_min: int
    bytes_max: int
    node_count: int
    relationship_count: int

    def headroom_against(self, budget_bytes: int) -> float:
        return budget_bytes / self.bytes_max if self.bytes_max else float("inf")


class SafeProjection:
    """Project, run, drop — with the size checked first and the results streamed.

    The budget is the memory this service is *allowed* to spend on projections,
    which is not the same as the memory currently free: two concurrent requests
    that each check "is there room right now" will both say yes and both build.
    """

    def __init__(
        self,
        uri: str,
        auth: tuple[str, str],
        budget_bytes: int,
        min_headroom: float = 1.5,
    ) -> None:
        self._driver = AsyncGraphDatabase.driver(uri, auth=auth)
        self._budget = budget_bytes
        self._min_headroom = min_headroom
        self._lock = asyncio.Lock()

    async def close(self) -> None:
        await self._driver.close()

    async def estimate(self, node_spec, rel_spec) -> Estimate:
        async with self._driver.session() as session:
            result = await session.run(
                "CALL gds.graph.project.estimate($nodes, $rels) "
                "YIELD bytesMin, bytesMax, nodeCount, relationshipCount "
                "RETURN bytesMin, bytesMax, nodeCount, relationshipCount",
                nodes=node_spec,
                rels=rel_spec,
            )
            record = await result.single()
        return Estimate(
            bytes_min=int(record["bytesMin"]),
            bytes_max=int(record["bytesMax"]),
            node_count=int(record["nodeCount"]),
            relationship_count=int(record["relationshipCount"]),
        )

    async def shortest_path(
        self, graph_name: str, node_spec, rel_spec, source_id: str, target_id: str
    ) -> AsyncIterator[dict]:
        estimate = await self.estimate(node_spec, rel_spec)
        headroom = estimate.headroom_against(self._budget)
        if headroom < self._min_headroom:
            raise ProjectionTooLarge(
                f"{estimate.node_count:,} nodes / {estimate.relationship_count:,} rels "
                f"would need up to {estimate.bytes_max / 1024 ** 3:.1f} GiB against a "
                f"{self._budget / 1024 ** 3:.1f} GiB budget (headroom {headroom:.2f}×)"
            )

        # One projection at a time per process: the estimate answers "does this
        # fit", not "does this fit alongside whatever else is being built".
        async with self._lock:
            async with self._driver.session() as session:
                await session.run(
                    "CALL gds.graph.project($name, $nodes, $rels)",
                    name=graph_name, nodes=node_spec, rels=rel_spec,
                )
                try:
                    result = await session.run(
                        """
                        MATCH (s:RoadNode {id: $source}), (t:RoadNode {id: $target})
                        CALL gds.shortestPath.dijkstra.stream($name, {
                          sourceNode: s, targetNode: t,
                          relationshipWeightProperty: 'drive_s'
                        })
                        YIELD nodeIds, totalCost
                        RETURN totalCost,
                               [nid IN nodeIds | gds.util.asNode(nid).id] AS route
                        """,
                        name=graph_name, source=source_id, target=target_id,
                    )
                    # `async for` pulls records in batches as they arrive. A
                    # `collect()` in Cypher, or a list() here, would put the whole
                    # result on the heap first — which is the second way this
                    # endpoint kills the instance.
                    async for record in result:
                        yield {"cost": record["totalCost"], "route": record["route"]}
                finally:
                    # `false` means "do not fail if it is already gone", so a
                    # failed projection cannot strand a partially built graph.
                    await session.run(
                        "CALL gds.graph.drop($name, false)", name=graph_name
                    )


async def main() -> None:
    NODES = "RoadNode"
    RELS = {"SEGMENT": {"properties": "drive_s"}}

    projection = SafeProjection(
        "neo4j://localhost:7687", ("neo4j", "password"),
        budget_bytes=6 * 1024 ** 3,
    )
    try:
        async for hop in projection.shortest_path(
            "route-req-8841", NODES, RELS, "junction:4471", "junction:9902"
        ):
            print(f"{hop['cost']:.0f}s over {len(hop['route'])} nodes")
    except ProjectionTooLarge as exc:
        print(f"refused: {exc}")
    except ClientError as exc:
        print(f"server rejected the projection: {exc.message}")
    finally:
        await projection.close()


if __name__ == "__main__":
    asyncio.run(main())
```

## How It Works

Three details carry the safety, and each maps to a line above.

**The estimate runs before anything is committed.** `gds.graph.project.estimate` walks the same specification the real projection would and reports a range without allocating. It is cheap enough to run on every request and is the only way to turn "this region is too big" from a crash into a rejected request. The range matters: `bytesMin` assumes the most favourable layout and `bytesMax` the least, and a service should budget against the maximum, because the difference between them is decided by data it does not control.

**The headroom multiplier accounts for what the estimate cannot see.** A projection that exactly fits the budget will still fail, because the estimate covers the graph structure and not the algorithm's own working memory, the result set, or whatever else the instance is doing at that moment. Requiring 1.5× headroom is not superstition — it is the margin between "the graph fits" and "the graph plus the search that runs over it fits".

**Streaming keeps the result off the heap.** This is the half that is usually missed, because it does not look like a memory decision. `gds.shortestPath.dijkstra.stream` yields rows; `async for` consumes them as they arrive; nothing accumulates. Replace that with a `collect()` in the Cypher, or a `list()` in Python, and the whole result set materialises on the server heap before the first row reaches the driver. On a one-to-one route that is harmless. On a one-to-many cost surface over a metropolitan area it is hundreds of megabytes of transaction state, and it is charged to the heap the estimate never covered.

<svg viewBox="0 0 780 312" role="img" aria-labelledby="heapWhereTitle heapWhereDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="heapWhereTitle">Two separate allocations, only one of which the estimate covers</title>
  <desc id="heapWhereDesc">Memory committed by a single routing request. The projection itself is off-heap, is what gds.graph.project.estimate reports, and is bounded by the budget check. The algorithm's working memory and the result set are on the JVM heap, are not covered by the estimate at all, and are bounded only by how the results are consumed. Streaming yields rows as they arrive so the result never accumulates; collecting materialises the whole set on the heap before the first row leaves the server. A service that guards only the projection has guarded the smaller of the two risks.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="312" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">What the estimate covers, and what it does not</text>
  <rect x="24" y="42" width="356" height="104" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="1.8"/>
  <text x="202" y="66" text-anchor="middle" font-size="12" font-weight="700" fill="var(--viz-good,#0a656d)">off-heap — the projection</text>
  <text x="202" y="86" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">packed topology plus named properties</text>
  <rect x="56" y="98" width="292" height="18" rx="9" fill="var(--viz-good,#0a656d)"/>
  <text x="202" y="132" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">estimate reports this · budget check bounds it</text>
  <rect x="400" y="42" width="356" height="104" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-poor,#a8320f)" stroke-width="1.8"/>
  <text x="578" y="66" text-anchor="middle" font-size="12" font-weight="700" fill="var(--viz-poor,#a8320f)">on-heap — search state and results</text>
  <text x="578" y="86" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">frontier, settled set, rows in flight</text>
  <rect x="432" y="98" width="292" height="18" rx="9" fill="var(--viz-poor,#a8320f)"/>
  <text x="578" y="132" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">estimate is silent · only consumption bounds it</text>
  <text x="24" y="180" font-size="11.5" font-weight="700" fill="currentColor">how the result is consumed decides the second one</text>
  <rect x="24" y="192" width="732" height="46" rx="8" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="1.5"/>
  <text x="44" y="212" font-size="11" font-weight="700" fill="var(--viz-good,#0a656d)">stream + async for</text>
  <text x="44" y="230" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">rows leave as they are produced; heap holds one batch</text>
  <rect x="470" y="204" width="200" height="22" rx="11" fill="var(--viz-good,#0a656d)"/>
  <text x="570" y="220" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-on-pill,#ffffff)">flat in result size</text>
  <rect x="24" y="248" width="732" height="46" rx="8" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-poor,#a8320f)" stroke-width="1.5"/>
  <text x="44" y="268" font-size="11" font-weight="700" fill="var(--viz-poor,#a8320f)">collect() in Cypher, or list() in Python</text>
  <text x="44" y="286" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">whole set materialised before the first row is sent</text>
  <rect x="470" y="260" width="200" height="22" rx="11" fill="var(--viz-poor,#a8320f)"/>
  <text x="570" y="276" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-on-pill,#ffffff)">linear in result size</text>
</svg>

## Common Failure Patterns

**1. Checking free memory instead of a fixed budget.** Two concurrent requests that each ask "is there room right now" both get told yes, both project, and the second one fails — or worse, both succeed and the third request finds a host with no heap left. The budget has to be a constant the service enforces with a lock, not a reading it takes from the environment.

```python
# WRONG: a race with no loser until the OOM.
if free_memory() > estimate.bytes_max:
    await project(...)

# RIGHT: a fixed allowance, serialised.
async with self._lock:
    if estimate.bytes_max * 1.5 > self._budget:
        raise ProjectionTooLarge(...)
    await project(...)
```

**2. Dropping the projection outside a `finally`.** An exception between `project` and `drop` strands the whole graph, and because named graphs are database-scoped rather than session-scoped, nothing cleans it up when the request's session closes. The symptom is a slow, monotonic loss of memory that does not appear in query profiling at all — the projections are simply there, owned by nobody. Check for them with `gds.graph.list()` and compare against what the service believes it created.

**3. Projecting per request when the topology is stable.** The estimate makes a per-request projection *safe*, not *sensible*. If the graph changes weekly and the service takes thousands of requests a day, the projection should be built once and reused, and the memory reserved permanently rather than churned. The measurement that decides it is in [benchmarking GDS shortestPath against hand-written Cypher](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/neo4j-gds-vs-cypher-routing/benchmarking-gds-shortestpath-against-hand-written-cypher/).

## Performance Notes

Projection memory scales with the topology and with the properties you name, and the two scale differently. Structure grows with node and relationship counts; properties grow with the product of the element count and the number of properties copied. Naming one extra relationship property on a graph with fifty million relationships is not a rounding error — it is another array of fifty million values, held for the projection's lifetime.

$$M_{\text{proj}} \approx c_n N + c_r R + \sum_{p} s_p \cdot |p|$$

The practical consequence is that the cheapest way to shrink a projection is to stop copying properties into it. A Dijkstra needs exactly one relationship weight; a projection built with `properties: '*'` because it was convenient carries every other one alongside, for the whole time the graph exists.

The transaction memory limit is worth setting as well as the heap maximum. `db.memory.transaction.max` caps what a single transaction may hold, which converts an instance-killing `OutOfMemoryError` into a terminated query with a clear message. That is a far better failure: one request fails, the service stays up, and the error names the query that caused it. Sizing it slightly above the widest legitimate query means the first thing to fail is always the query that went wrong, which is the same reasoning behind the [memory budget for the whole instance](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-memory-and-storage-tuning/).

<svg viewBox="0 0 780 288" role="img" aria-labelledby="heapLimitTitle heapLimitDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="heapLimitTitle">A transaction limit turns an instance failure into a query failure</title>
  <desc id="heapLimitDesc">The same oversized query under two configurations. With no transaction memory limit the query grows until the JVM heap is exhausted, the instance dies, every other tenant's in-flight work dies with it, and the container restarts with a cold cache. With a transaction limit set slightly above the widest legitimate query, that one transaction is terminated with a message naming it, every other query continues, and nothing restarts. The second failure is strictly better in every respect, including that it says what went wrong.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="288" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">One oversized query, two configurations</text>
  <rect x="24" y="42" width="356" height="196" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-poor,#a8320f)" stroke-width="1.8"/>
  <text x="202" y="66" text-anchor="middle" font-size="11.5" font-weight="700" fill="var(--viz-poor,#a8320f)">no transaction limit</text>
  <rect x="52" y="82" width="300" height="20" rx="6" fill="var(--viz-poor,#a8320f)"/>
  <text x="202" y="97" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-on-pill,#ffffff)">the query grows until the heap is gone</text>
  <text x="202" y="126" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">OutOfMemoryError — the instance</text>
  <text x="202" y="150" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">every in-flight query on the host dies</text>
  <text x="202" y="168" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">the container restarts with a cold cache</text>
  <text x="202" y="186" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">the stack trace names the JVM, not the query</text>
  <rect x="52" y="200" width="300" height="20" rx="6" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-poor,#a8320f)" stroke-width="1.2"/>
  <text x="202" y="215" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-poor,#a8320f)">minutes of degraded service</text>
  <rect x="400" y="42" width="356" height="196" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="1.8"/>
  <text x="578" y="66" text-anchor="middle" font-size="11.5" font-weight="700" fill="var(--viz-good,#0a656d)">db.memory.transaction.max set</text>
  <rect x="428" y="82" width="180" height="20" rx="6" fill="var(--viz-good,#0a656d)"/>
  <text x="518" y="97" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-on-pill,#ffffff)">the query hits its ceiling</text>
  <text x="578" y="126" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">TransactionTerminated — the query</text>
  <text x="578" y="150" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">every other query keeps running</text>
  <text x="578" y="168" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">nothing restarts, the cache stays warm</text>
  <text x="578" y="186" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">the message names the offending query</text>
  <rect x="428" y="200" width="300" height="20" rx="6" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-good,#0a656d)" stroke-width="1.2"/>
  <text x="578" y="215" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-good,#0a656d)">one failed request</text>
  <text x="24" y="272" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">Set it above the widest query you intend to run, and the first thing to fail is always the query that went wrong.</text>
</svg>

## Related

- [Graph Memory and Storage Tuning](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-memory-and-storage-tuning/) — the pool this heap competes with.
- [Sizing the Page Cache for a Spatial Graph](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-memory-and-storage-tuning/sizing-the-page-cache-for-a-spatial-graph/) — what the memory you give the heap is taken from.
- [Weighted Dijkstra Routing with Neo4j GDS](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/routing-algorithms-python/weighted-dijkstra-routing-with-neo4j-gds/) — the projection lifecycle this guard wraps.
- [Neo4j GDS vs Cypher Routing](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/neo4j-gds-vs-cypher-routing/) — deciding whether the projection is worth building at all.

This guide is part of [Graph Memory and Storage Tuning](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-memory-and-storage-tuning/), within [Spatial Graph Database Fundamentals for Python](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/).
