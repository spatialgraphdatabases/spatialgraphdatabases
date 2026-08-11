---
pageTitle: Graph Memory & Storage Tuning
title: Graph Memory and Storage Tuning for Spatial Workloads
description: Size the page cache, heap and store files for a spatial routing graph, and read the symptoms that tell you which of the three is actually short.
slug: graph-memory-and-storage-tuning
type: article
breadcrumb: Memory & Storage
datePublished: 2026-08-11
dateModified: 2026-08-11
---
# Graph Memory and Storage Tuning for Spatial Workloads

A spatial routing graph fails under memory pressure in a way that reads like an algorithm problem. Latency does not degrade evenly; it develops a long tail. The p50 stays flat, the p95 triples, and the queries that got slow have nothing in common except that they touched a part of the map nobody had asked about recently. That is not a query-planning defect and no index will fix it — it is a working set that no longer fits, and the fix is a memory budget derived from the store rather than guessed from the host's RAM. This page covers the three pools that matter, how a spatial workload loads each of them differently from an ordinary graph, and how to tell which one is short from the symptom alone.

## Prerequisites

The measurements here use Neo4j 5.x with the standard store format and the official async Python driver; the Graph Data Science procedures are needed only for the projection-sizing section.

| Requirement | Minimum version | Install |
| --- | --- | --- |
| Python | 3.11 | — |
| neo4j (async driver) | 5.20 | `pip install "neo4j>=5.20"` |
| Neo4j Server | 5.15 | includes `db.stats`, `dbms.memory.*` procedures |
| Graph Data Science | 2.6 | `gds.graph.project.estimate` |

## Core Concept & Mechanism

Three pools hold a running graph, and they compete for the same physical memory.

The **page cache** holds store-file pages — nodes, relationships, properties, and index pages — exactly as they sit on disk. It is not a query cache and it does not hold results; it holds the file. A read that finds its page here costs a memory access, and one that misses costs a random read against storage. On a routing workload that difference is not marginal, because traversal is a long chain of dependent random reads: each hop's address is only known once the previous hop has been read, so misses cannot be overlapped the way a sequential scan's can. A path of twenty hops with a ninety per cent hit rate still expects two synchronous storage reads in series, and that is what the p95 is measuring.

The **JVM heap** holds transaction state, intermediate result rows, and the machinery of query execution. A spatial query's heap footprint is dominated by whatever it materialises: a `collect()` over a large expansion, an `ORDER BY` that must see every row before it emits the first, or a variable-length path pattern whose intermediate frontier is proportional to branching factor raised to depth. This is the pool that produces sharp, obvious failures — an `OutOfMemoryError` or a transaction terminated for exceeding its limit — rather than the quiet degradation the page cache produces.

**Graph Data Science projections** live outside both. A projection is a separate, compact, in-memory copy of the topology plus whatever properties were named, held for the lifetime of the named graph. It is fast precisely because it is not the store: adjacency is a packed array rather than a linked structure, so a traversal that costs random reads against the store costs sequential ones against the projection. The price is that the memory is committed for as long as the graph exists, and it is invisible to both of the other budgets.

<svg viewBox="0 0 780 292" role="img" aria-labelledby="msTitle msDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="msTitle">Reading the symptom back to the pool that is actually short</title>
  <desc id="msDesc">A decision table mapping four observable symptoms to the pool responsible. A p95 that rises while p50 stays flat, on an unchanged plan, is the page cache. A query terminated for exceeding a transaction memory limit, or an out-of-memory error, is the heap. A projection call that fails or a slow monotonic loss of cache to nothing visible in profiling is a projection that was never dropped. And a plan whose operators changed is not a memory problem at all — it is planning, and belongs with the planner.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="292" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Symptom first, then the pool — the three fail in distinguishable ways</text>
  <text x="42" y="52" font-size="10" font-weight="700" fill="var(--viz-ink-mute,#565f6d)">what you observe</text>
  <text x="560" y="52" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-ink-mute,#565f6d)">what is short</text>
  <rect x="24" y="60" width="732" height="48" rx="8" fill="var(--viz-panel,#f4f4f5)" stroke="var(--accent,#0a656d)" stroke-width="1.5"/>
  <text x="42" y="80" font-size="11" font-weight="700" fill="currentColor">p95 rises, p50 flat, plan and row counts unchanged</text>
  <text x="42" y="98" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">slow queries have nothing in common but an unvisited region</text>
  <rect x="470" y="72" width="180" height="24" rx="12" fill="var(--accent,#0a656d)"/>
  <text x="560" y="89" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--viz-on-pill,#ffffff)">page cache</text>
  <text x="666" y="89" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">degrades</text>
  <rect x="24" y="118" width="732" height="48" rx="8" fill="var(--viz-panel,#f4f4f5)" stroke="var(--accent-3,#5b21b6)" stroke-width="1.5"/>
  <text x="42" y="138" font-size="11" font-weight="700" fill="currentColor">transaction terminated over its memory limit, or an OOM</text>
  <text x="42" y="156" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">reproducible on one query shape, usually a collect or an ORDER BY</text>
  <rect x="470" y="130" width="180" height="24" rx="12" fill="var(--accent-3,#5b21b6)"/>
  <text x="560" y="147" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--viz-on-pill,#ffffff)">JVM heap</text>
  <text x="666" y="147" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">fails hard</text>
  <rect x="24" y="176" width="732" height="48" rx="8" fill="var(--viz-panel,#f4f4f5)" stroke="var(--accent-2,#a8380b)" stroke-width="1.5"/>
  <text x="42" y="196" font-size="11" font-weight="700" fill="currentColor">cache shrinks over days with nothing in profiling to explain it</text>
  <text x="42" y="214" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">gds.graph.list shows graphs older than any live request</text>
  <rect x="470" y="188" width="180" height="24" rx="12" fill="var(--accent-2,#a8380b)"/>
  <text x="560" y="205" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--viz-on-pill,#ffffff)">leaked projection</text>
  <text x="666" y="205" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">accumulates</text>
  <rect x="24" y="234" width="732" height="42" rx="8" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1.2"/>
  <text x="42" y="254" font-size="11" font-weight="700" fill="currentColor">the operators in PROFILE are different from before</text>
  <text x="42" y="270" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">not a memory problem — the plan changed, so start with the planner</text>
  <rect x="470" y="243" width="180" height="24" rx="12" fill="var(--viz-ink-mute,#565f6d)"/>
  <text x="560" y="260" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--viz-on-pill,#ffffff)">nothing — look elsewhere</text>
</svg>


The interaction between the three is what makes tuning non-obvious. Enlarging the page cache to fix a tail-latency problem takes memory from the heap, which turns a slow query into a failing one. Holding a projection resident to make routing fast takes memory from the page cache, which makes every non-projected query slower. There is no setting that is correct in isolation; there is only an allocation that matches the workload's shape.

## Schema & Data Model

Store size, and therefore the page cache a graph needs, is mostly a function of decisions made at ingestion rather than at tuning time. Four of them dominate on a spatial graph.

**Point properties are compact; string coordinates are not.** A native `point` stores as a fixed-width value inline with the node record. The same coordinate kept as `"51.5074,-0.1278"` is a dynamic string record, stored out of line and reached by a pointer — larger, and, worse, a second random read on every access. A graph that stores coordinates as strings pays for that twice: once in store size, and once in the page-cache miss rate that the extra indirection creates.

**Every property on a hot node competes for the same pages.** Node records are fixed-width and property values hang off them; a node with forty tags loads its whole property chain when any one of them is read. On a routing graph the nodes read most often are junctions, and a junction needs a coordinate and very little else. Keeping descriptive tags on the relationship, or on a separate node linked from the junction, keeps the hot record small and the cache dense.

**Relationship direction doubles or halves the store.** A two-way street modelled as two directed relationships costs two records; modelled as one relationship traversed in both directions it costs one. The second form is smaller and cheaper to cache, at the price of needing a `oneway` flag consulted at query time.

**Indexes are store too.** A point index over a continental node set is a substantial file in its own right, and it is the file a routing query reads first. Sizing the page cache from the node and relationship stores alone, and forgetting the index, is the most common way to end up with a cache that is technically large and practically cold.

```cypher
// What each store file actually costs, before guessing at a cache size.
CALL db.stats.retrieve('GRAPH COUNTS') YIELD data
RETURN data;

// Store file sizes, which is the number the page cache has to cover.
CALL dbms.listPools() YIELD pool, databaseName, heapMemoryUsed, nativeMemoryUsed
WHERE databaseName = 'neo4j'
RETURN pool, heapMemoryUsed, nativeMemoryUsed
ORDER BY nativeMemoryUsed DESC;
```

## Step-by-Step Implementation

The following helper reports the three budgets side by side, which is the view that makes an allocation decision possible. It reads the server's own accounting rather than inferring from the host, so it stays correct on a container with a limit lower than the machine's RAM.

```python
import asyncio
from dataclasses import dataclass

from neo4j import AsyncGraphDatabase


@dataclass(frozen=True)
class MemoryReport:
    """The three pools, in bytes, plus the ratio that matters most."""
    store_bytes: int
    page_cache_bytes: int
    heap_max_bytes: int
    projections_bytes: int

    @property
    def cache_coverage(self) -> float:
        """Fraction of the store the page cache can hold at once.

        Below about 1.0 the working set decides latency; a routing workload
        whose traversals wander over the whole map wants this at or above 1.0,
        while one that serves a single dense city can run happily far below it.
        """
        return self.page_cache_bytes / self.store_bytes if self.store_bytes else 0.0


class MemoryInspector:
    def __init__(self, uri: str, auth: tuple[str, str]) -> None:
        self._driver = AsyncGraphDatabase.driver(uri, auth=auth)

    async def close(self) -> None:
        await self._driver.close()

    async def report(self, database: str = "neo4j") -> MemoryReport:
        async with self._driver.session(database=database) as session:
            store = await self._store_bytes(session)
            page_cache = await self._setting_bytes(session, "server.memory.pagecache.size")
            heap = await self._setting_bytes(session, "server.memory.heap.max_size")
            projections = await self._projection_bytes(session)
        return MemoryReport(store, page_cache, heap, projections)

    @staticmethod
    async def _store_bytes(session) -> int:
        result = await session.run(
            "CALL dbms.listPools() YIELD pool, nativeMemoryUsed "
            "WHERE pool STARTS WITH 'Bolt' = false "
            "RETURN sum(coalesce(nativeMemoryUsed, 0)) AS total"
        )
        record = await result.single()
        return int(record["total"] or 0)

    @staticmethod
    async def _setting_bytes(session, name: str) -> int:
        result = await session.run(
            "CALL dbms.listConfig($name) YIELD value RETURN value LIMIT 1", name=name
        )
        record = await result.single()
        return _parse_size(record["value"]) if record else 0

    @staticmethod
    async def _projection_bytes(session) -> int:
        # A projection that no longer has a caller is still holding its memory.
        result = await session.run(
            "CALL gds.graph.list() YIELD graphName, memoryUsage, nodeCount "
            "RETURN collect({name: graphName, bytes: memoryUsage, nodes: nodeCount}) AS graphs"
        )
        record = await result.single()
        total = 0
        for graph in record["graphs"] if record else []:
            total += _parse_size(graph["bytes"])
        return total


def _parse_size(value) -> int:
    """Neo4j reports sizes as '4.00 GiB' in some procedures and as ints in others."""
    if isinstance(value, (int, float)):
        return int(value)
    text = str(value).strip()
    units = {"b": 1, "kib": 1024, "mib": 1024 ** 2, "gib": 1024 ** 3, "tib": 1024 ** 4}
    for suffix, factor in sorted(units.items(), key=lambda kv: -len(kv[0])):
        if text.lower().endswith(suffix):
            return int(float(text[: -len(suffix)].strip()) * factor)
    return int(float(text))


async def main() -> None:
    inspector = MemoryInspector("neo4j://localhost:7687", ("neo4j", "password"))
    try:
        report = await inspector.report()
    finally:
        await inspector.close()

    gib = 1024 ** 3
    print(f"store        {report.store_bytes / gib:8.2f} GiB")
    print(f"page cache   {report.page_cache_bytes / gib:8.2f} GiB  "
          f"({report.cache_coverage:.0%} of store)")
    print(f"heap max     {report.heap_max_bytes / gib:8.2f} GiB")
    print(f"projections  {report.projections_bytes / gib:8.2f} GiB")


if __name__ == "__main__":
    asyncio.run(main())
```

<svg viewBox="0 0 780 316" role="img" aria-labelledby="memPoolsTitle memPoolsDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="memPoolsTitle">Three memory pools competing for one host, and what each one holds</title>
  <desc id="memPoolsDesc">A host's memory divided between the page cache, the JVM heap, resident Graph Data Science projections, and the operating system reserve. The page cache holds store-file pages including the point index and decides read latency. The heap holds transaction and result state and decides whether a query completes at all. Projections hold a separate packed copy of the topology and are invisible to both other budgets. Enlarging any one pool takes memory from the others, so the allocation is a single decision rather than three independent settings.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="316" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">One host, three pools, one budget</text>
  <rect x="24" y="42" width="732" height="42" rx="8" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1.2"/>
  <text x="390" y="68" text-anchor="middle" font-size="11.5" font-weight="700" fill="currentColor">physical memory available to the process</text>
  <rect x="24" y="98" width="300" height="128" rx="9" fill="var(--viz-panel,#f4f4f5)" stroke="var(--accent,#0a656d)" stroke-width="1.8"/>
  <text x="174" y="122" text-anchor="middle" font-size="12" font-weight="700" fill="var(--accent,#0a656d)">page cache</text>
  <text x="174" y="142" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">store-file pages, including the point index</text>
  <text x="174" y="164" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">decides read latency</text>
  <text x="174" y="184" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">short → tail latency, not failure</text>
  <rect x="52" y="196" width="244" height="14" rx="7" fill="var(--viz-panel-2,#ece9df)"/>
  <rect x="52" y="196" width="180" height="14" rx="7" fill="var(--accent,#0a656d)"/>
  <text x="174" y="222" text-anchor="middle" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">74% of the store fits</text>
  <rect x="340" y="98" width="196" height="128" rx="9" fill="var(--viz-panel,#f4f4f5)" stroke="var(--accent-3,#5b21b6)" stroke-width="1.8"/>
  <text x="438" y="122" text-anchor="middle" font-size="12" font-weight="700" fill="var(--accent-3,#5b21b6)">JVM heap</text>
  <text x="438" y="142" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">transaction and result state</text>
  <text x="438" y="164" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">decides completion</text>
  <text x="438" y="184" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">short → hard failure</text>
  <text x="438" y="212" text-anchor="middle" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">sized by the widest query,</text>
  <text x="438" y="224" text-anchor="middle" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">not by the average one</text>
  <rect x="552" y="98" width="204" height="128" rx="9" fill="var(--viz-panel,#f4f4f5)" stroke="var(--accent-2,#a8380b)" stroke-width="1.8"/>
  <text x="654" y="122" text-anchor="middle" font-size="12" font-weight="700" fill="var(--accent-2,#a8380b)">GDS projections</text>
  <text x="654" y="142" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">packed copy of the topology</text>
  <text x="654" y="164" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">outside both budgets</text>
  <text x="654" y="184" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">held until dropped</text>
  <text x="654" y="212" text-anchor="middle" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">an abandoned projection is</text>
  <text x="654" y="224" text-anchor="middle" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">indistinguishable from a leak</text>
  <text x="24" y="258" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">Every arrow between these pools points the wrong way for someone: growing the cache to cure a latency tail shrinks the</text>
  <text x="24" y="274" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">heap and turns slow queries into failing ones; holding a projection resident to make routing fast takes pages away from</text>
  <text x="24" y="290" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">every query that is not projected. Decide the split once, from the workload, and measure it rather than adjusting by feel.</text>
  <text x="24" y="308" font-size="10" fill="var(--viz-ink-mute,#565f6d)">The operating system also needs a reserve; committing the entire host to these three is its own failure mode.</text>
</svg>

## Query Patterns & Variants

**Measure the hit ratio, not the cache size.** The setting is an input; the ratio is the outcome, and only the ratio says whether the input was right.

```cypher
CALL dbms.listPools() YIELD pool, nativeMemoryUsed
WHERE pool CONTAINS 'Page Cache'
RETURN pool, nativeMemoryUsed;
```

**Estimate before you project.** `gds.graph.project.estimate` costs nothing and answers the question that otherwise gets answered by an out-of-memory kill halfway through a country-scale load.

```cypher
CALL gds.graph.project.estimate(
  'RoadNode',
  {SEGMENT: {properties: 'drive_s'}}
) YIELD requiredMemory, bytesMax, nodeCount, relationshipCount
RETURN requiredMemory, bytesMax, nodeCount, relationshipCount;
```

**Find the projections nobody dropped.** A named graph outlives the request that created it, and a service that projects per request and fails before its `finally` block leaks a multi-gigabyte object with no owner.

```cypher
CALL gds.graph.list()
YIELD graphName, nodeCount, relationshipCount, memoryUsage, creationTime
RETURN graphName, nodeCount, relationshipCount, memoryUsage, creationTime
ORDER BY creationTime;
```

## Performance Tuning

The allocation that works for a spatial routing graph follows from one observation: traversal reads are dependent and random, so cache misses serialise. That argues for spending marginal memory on the page cache before the heap, up to the point where the heap is genuinely at risk — and the heap's requirement is set by the widest query the service will ever run, not by the typical one.

A workable procedure is to size from the store rather than from the host. Measure the store and index files; set the page cache to cover the portion of the graph the service actually reads, which for a regional service is far less than the whole country; set the heap from the observed peak of the widest query with a healthy multiple; and only then check what is left. If nothing is left, the projection is the piece to give up first, because a projection is an optimisation and the other two are requirements.

Warm-up deserves a place in the deployment, not just in the tuning session. After a restart the cache is empty and the first queries pay full storage latency, which on a service with an SLO is indistinguishable from an outage. A warm-up pass that touches the point index and the densest region of the graph before the instance is added to the load balancer converts that from a user-visible event into a startup delay. The same argument applies after a bulk import: the pages the importer touched are not the pages routing will read.

$$T_{\text{traversal}} \approx h \cdot \big(m \cdot t_{\text{storage}} + (1 - m) \cdot t_{\text{memory}}\big)$$

For a path of $h$ hops and a miss rate $m$, the storage term dominates the moment $m$ is anything but tiny, because $t_{\text{storage}}$ exceeds $t_{\text{memory}}$ by orders of magnitude and the hops cannot be overlapped. That asymmetry is why a hit rate of 95 per cent is not "nearly perfect" on a twenty-hop route — it is one storage read per route, every route.

<svg viewBox="0 0 780 296" role="img" aria-labelledby="memTailTitle memTailDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="memTailTitle">Why a high cache hit rate still shows up in the tail of a routing latency distribution</title>
  <desc id="memTailDesc">Expected storage reads per route plotted against page-cache hit rate, for a twenty-hop traversal. At 99 per cent the route still expects about one fifth of a storage read, at 95 per cent it expects one, and at 90 per cent it expects two. Because traversal reads are dependent — each hop's address is only known once the previous hop is read — those reads cannot be overlapped, so each one adds its full latency to the route rather than being absorbed by concurrency. The curve is why tail latency moves long before an average does.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="296" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Expected serialised storage reads per 20-hop route</text>
  <line x1="96" y1="52" x2="96" y2="220" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <line x1="96" y1="220" x2="720" y2="220" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <g font-size="9.5" fill="var(--viz-ink-mute,#565f6d)" text-anchor="end">
    <text x="88" y="224">0</text><text x="88" y="182">1</text><text x="88" y="140">2</text><text x="88" y="98">3</text><text x="88" y="56">4</text>
  </g>
  <g font-size="9.5" fill="var(--viz-ink-mute,#565f6d)" text-anchor="middle">
    <text x="96" y="240">100%</text><text x="252" y="240">99%</text><text x="408" y="240">95%</text><text x="564" y="240">90%</text><text x="720" y="240">80%</text>
  </g>
  <text x="408" y="260" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">page-cache hit rate</text>
  <path d="M96 220 L252 212 L408 178 L564 136 L720 52" fill="none" stroke="var(--accent-2,#a8380b)" stroke-width="2.6"/>
  <g fill="var(--accent-2,#a8380b)">
    <circle cx="252" cy="212" r="5"/><circle cx="408" cy="178" r="5"/><circle cx="564" cy="136" r="5"/>
  </g>
  <text x="252" y="202" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--accent-2,#a8380b)">0.2</text>
  <text x="408" y="168" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--accent-2,#a8380b)">1.0</text>
  <text x="564" y="126" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--accent-2,#a8380b)">2.0</text>
  <text x="24" y="284" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">A rate that would be excellent for a scan is ordinary here, because these reads are in series rather than in parallel.</text>
</svg>

## Edge Cases & Gotchas

- **Container limits are not host limits.** A JVM that sizes itself from `/proc/meminfo` inside a container with a lower cgroup limit will happily allocate a heap the kernel then refuses to back, and the failure arrives as an opaque kill rather than an error. Set both pools explicitly whenever the process is containerised.
- **A projection survives the session that made it.** Named graphs are database-scoped, not session-scoped. A request handler that projects and returns without dropping leaks the whole projection, and the symptom is a slow, monotonic loss of page cache to something that never shows up in query profiling.
- **Bulk import poisons the cache it warms.** An import touches every page it writes, so the cache after a load is full of exactly the pages a read workload does not want. Warm deliberately after importing rather than assuming the load did it.
- **The heap peak is set by the widest query, not the busiest hour.** A single unbounded `collect()` in an admin endpoint can require more heap than the entire routing workload, and it will only be run when someone is investigating an incident — which is the worst possible moment for the instance to fail.
- **Store growth from property churn is not reclaimed automatically.** Repeatedly updating a property leaves the old dynamic records in place until a store copy compacts them, so a graph under continuous [attribute synchronization](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/attribute-synchronization-techniques/) grows on disk even when its logical size is constant.
- **Index rebuilds need headroom of their own.** An index that is being repopulated exists twice for the duration, and the second copy comes out of the same budget everything else is using.

## Verification & Testing

Treat the memory budget as an assertion the service checks at startup rather than a configuration someone remembers to review. Three checks catch nearly everything: that the page cache covers the intended fraction of the store, that no projection is resident which the service did not create, and that the widest known query completes within the transaction memory limit against a production-sized graph.

```python
import pytest


@pytest.mark.asyncio
async def test_cache_covers_working_set(inspector):
    report = await inspector.report()
    # The service reads one region, not the whole country: 60% is the target,
    # and anything below 40% has historically shown up as a p95 regression.
    assert report.cache_coverage >= 0.40, (
        f"page cache covers only {report.cache_coverage:.0%} of the store"
    )


@pytest.mark.asyncio
async def test_no_orphan_projections(driver, expected_graphs):
    async with driver.session() as session:
        result = await session.run("CALL gds.graph.list() YIELD graphName RETURN graphName")
        live = {record["graphName"] async for record in result}
    orphans = live - set(expected_graphs)
    assert not orphans, f"projections held by nobody: {sorted(orphans)}"
```

The first test is the one worth running on a schedule rather than only in CI, because it fails for a reason nobody changed: the store grew. A graph under continuous ingestion crosses the coverage threshold without any deploy, and the first symptom otherwise is the latency tail this whole page is about.

## FAQ

<details>
<summary>Should the page cache be large enough to hold the entire store?</summary>

Only if the workload actually reads the entire store. A national graph serving one metropolitan area reads a small fraction of its own data, and sizing the cache to the whole store wastes memory the heap could use. Size it to the working set — measure which regions are read over a representative period rather than assuming uniformity, because spatial traffic is anything but uniform.
</details>

<details>
<summary>Why does my p95 get worse after a deploy that changed nothing about the queries?</summary>

Because the cache is empty after a restart and the first several minutes of traffic pay storage latency. If the instance joins the load balancer immediately it will serve that penalty to real users. Warm the point index and the densest region before accepting traffic, and the same deploy becomes invisible.
</details>

<details>
<summary>Is a resident GDS projection worth its memory?</summary>

It depends entirely on request volume against a stable topology. A projection that serves thousands of routing requests between rebuilds amortises easily; one rebuilt per request is pure overhead and usually slower than a well-planned Cypher traversal. The measurement that settles it is in [benchmarking GDS shortestPath against hand-written Cypher](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/neo4j-gds-vs-cypher-routing/benchmarking-gds-shortestpath-against-hand-written-cypher/).
</details>

<details>
<summary>How do I tell a page-cache problem from a query-planning problem?</summary>

Read the plan first. If `PROFILE` shows the same operators and the same row counts as when the query was fast, the plan is not the problem and the difference is in how long each read took — that is memory. If the operators changed, it is planning, and belongs with [graph query planner optimization](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/) instead.
</details>

<details>
<summary>Does storing coordinates as native points really matter for memory?</summary>

Yes, and more for the miss rate than for the size. A native `point` is inline in the node record; a string coordinate is a separate dynamic record reached by a pointer, so reading it is a second page access that can miss independently. On a traversal that reads a coordinate at every hop, that doubles the number of chances to stall.
</details>

## Related

- [Spatial Indexing Strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) — the index files this page's cache budget has to cover.
- [Graph Query Planner Optimization](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/) — telling a planning regression from a memory one.
- [Node and Edge Spatial Mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/) — the modelling choices that set store size before any tuning happens.
- [Async Batch Processing for Graphs](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/async-batch-processing-for-graphs/) — the write path whose concurrency this budget bounds.

This topic is part of [Spatial Graph Database Fundamentals for Python](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/).
