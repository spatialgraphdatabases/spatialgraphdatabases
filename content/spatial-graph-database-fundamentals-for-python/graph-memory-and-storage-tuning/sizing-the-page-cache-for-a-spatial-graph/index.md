---
pageTitle: Sizing the Page Cache
title: Sizing the Page Cache for a Spatial Graph
description: Measure the working set a routing service actually reads, then size the Neo4j page cache from that number instead of from the store size or the host's RAM.
slug: sizing-the-page-cache-for-a-spatial-graph
type: article
breadcrumb: Sizing the Page Cache
datePublished: 2026-08-11
dateModified: 2026-08-11
---
# Sizing the Page Cache for a Spatial Graph

The advice you will find first is "give the page cache as much as the store." On a spatial routing graph that advice is expensive and usually wrong, because a routing service almost never reads its store uniformly. A national graph serving one metropolitan area touches maybe four per cent of its own nodes in a day, and the pages behind those nodes are the only ones that need to be resident. Size the cache to the store and you buy memory the heap needed; size it to the host and you have not answered the question at all. This page measures the working set — the pages the service actually reads — and derives a cache size from that, using nothing but the counters Neo4j already keeps.

## Prerequisites & Versions

The measurement uses page-cache counters exposed through JMX-backed procedures, available on all supported 5.x servers. Nothing here writes to the graph.

| Requirement | Minimum version | Install |
| --- | --- | --- |
| Python | 3.11 | — |
| neo4j (async driver) | 5.20 | `pip install "neo4j>=5.20"` |
| Neo4j Server | 5.15 | `dbms.listPools`, `db.stats` |

## Implementation

The sampler below runs alongside production traffic, takes page-cache counters at a fixed interval, and reports the two numbers that decide the size: the hit ratio the service is currently achieving, and the rate at which it is faulting pages in. A cache that is correctly sized shows a high ratio *and* a fault rate that decays toward zero as the working set loads; a cache that is too small shows a fault rate that never settles, because it is evicting pages it is about to need again.

```python
import asyncio
import time
from dataclasses import dataclass

from neo4j import AsyncGraphDatabase

SAMPLE = """
CALL dbms.listPools() YIELD pool, nativeMemoryUsed
WHERE pool CONTAINS 'Page Cache'
RETURN sum(coalesce(nativeMemoryUsed, 0)) AS resident
"""

COUNTERS = """
CALL db.stats.retrieve('GRAPH COUNTS') YIELD data
RETURN data
"""


@dataclass(frozen=True)
class Sample:
    at: float
    hits: int
    faults: int
    evictions: int
    resident_bytes: int

    def delta(self, previous: "Sample") -> "Window":
        return Window(
            seconds=self.at - previous.at,
            hits=self.hits - previous.hits,
            faults=self.faults - previous.faults,
            evictions=self.evictions - previous.evictions,
            resident_bytes=self.resident_bytes,
        )


@dataclass(frozen=True)
class Window:
    seconds: float
    hits: int
    faults: int
    evictions: int
    resident_bytes: int

    @property
    def hit_ratio(self) -> float:
        total = self.hits + self.faults
        return self.hits / total if total else 1.0

    @property
    def fault_rate(self) -> float:
        return self.faults / self.seconds if self.seconds else 0.0

    @property
    def eviction_rate(self) -> float:
        return self.evictions / self.seconds if self.seconds else 0.0

    @property
    def thrashing(self) -> bool:
        """Evicting nearly as fast as faulting means the cache is a revolving door.

        A cache that is merely warming faults without evicting, because there is
        still free space; one that is too small for the working set has to throw
        a page out for every page it reads in, and the ratio approaches 1.
        """
        return self.faults > 0 and self.evictions / self.faults > 0.85


class PageCacheSampler:
    def __init__(self, uri: str, auth: tuple[str, str], database: str = "neo4j") -> None:
        self._driver = AsyncGraphDatabase.driver(uri, auth=auth)
        self._database = database

    async def close(self) -> None:
        await self._driver.close()

    async def _sample(self) -> Sample:
        async with self._driver.session(database=self._database) as session:
            result = await session.run(
                "CALL dbms.queryJmx('neo4j.metrics:*') YIELD attributes "
                "RETURN attributes LIMIT 1"
            )
            record = await result.single()
            attrs = (record["attributes"] if record else {}) or {}

            def counter(name: str) -> int:
                entry = attrs.get(name) or {}
                return int(entry.get("value", 0) or 0)

            resident = await session.run(SAMPLE)
            resident_record = await resident.single()

        return Sample(
            at=time.monotonic(),
            hits=counter("Hits"),
            faults=counter("Faults"),
            evictions=counter("Evictions"),
            resident_bytes=int((resident_record or {}).get("resident", 0) or 0),
        )

    async def observe(self, minutes: int = 30, every: int = 60) -> list[Window]:
        """Sample under real traffic. Short runs measure warm-up, not steady state."""
        windows: list[Window] = []
        previous = await self._sample()
        for _ in range(max(1, (minutes * 60) // every)):
            await asyncio.sleep(every)
            current = await self._sample()
            windows.append(current.delta(previous))
            previous = current
        return windows


def verdict(windows: list[Window]) -> str:
    """Read the tail of the run, not its head: the head is always warm-up."""
    if not windows:
        return "no samples"
    tail = windows[len(windows) // 2:]
    ratio = sum(w.hit_ratio for w in tail) / len(tail)
    thrashing = sum(1 for w in tail if w.thrashing)

    if thrashing > len(tail) // 2:
        return f"UNDERSIZED — hit ratio {ratio:.1%}, evicting as fast as faulting"
    if ratio < 0.95:
        return f"TIGHT — hit ratio {ratio:.1%}; the working set does not quite fit"
    if all(w.fault_rate < 1.0 for w in tail):
        return f"COMFORTABLE — hit ratio {ratio:.1%}, faults have settled"
    return f"ADEQUATE — hit ratio {ratio:.1%}, still faulting on new regions"


async def main() -> None:
    sampler = PageCacheSampler("neo4j://localhost:7687", ("neo4j", "password"))
    try:
        windows = await sampler.observe(minutes=30, every=60)
    finally:
        await sampler.close()

    for i, w in enumerate(windows, 1):
        print(f"{i:3d}  hit {w.hit_ratio:6.2%}  faults/s {w.fault_rate:8.1f}  "
              f"evict/s {w.eviction_rate:8.1f}  {'THRASH' if w.thrashing else ''}")
    print(verdict(windows))


if __name__ == "__main__":
    asyncio.run(main())
```

## How It Works

The counters answer two different questions and it matters which one you read.

**The hit ratio is an outcome, not a target.** It tells you what proportion of reads found their page resident over the window. Read alone it is misleading, because it rises naturally as a service warms and it stays high even on a badly sized cache if most traffic hammers one small region. A ratio of 97 per cent on a routing workload can still mean one storage read on every third route, because a route is dozens of dependent reads and the misses do not overlap.

**The eviction-to-fault ratio is the diagnosis.** A cache with free space faults without evicting: it is loading pages it has never seen. A cache that has to discard a page for every page it reads is at capacity, and the question becomes whether the pages it discards are ones it will want again. When that ratio sits close to one *and* the fault rate refuses to decay, the cache is a revolving door — the working set does not fit, and every eviction is buying a future fault.

The reason to read the tail of the run rather than the whole of it is that the head is always warm-up, and warm-up looks exactly like an undersized cache: high fault rate, low hit ratio, everything cold. The difference is only visible over time. A correctly sized cache's fault rate decays toward the rate at which traffic reaches genuinely new regions, which on a regional service is close to zero and on a nationwide one is a slow trickle. An undersized cache's fault rate flattens out at a level set by the eviction rate and stays there for as long as you watch.

<svg viewBox="0 0 780 300" role="img" aria-labelledby="pcWarmTitle pcWarmDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="pcWarmTitle">Warm-up and an undersized cache look identical for the first ten minutes</title>
  <desc id="pcWarmDesc">Page fault rate over thirty minutes of production traffic for two cache sizes. Both start high because the cache is cold, and for the first ten minutes they are indistinguishable. The correctly sized cache's fault rate then decays toward the rate at which traffic reaches genuinely new regions, close to zero for a regional service. The undersized cache's rate flattens instead, at a level set by its own eviction rate, and stays there — every page it reads in costs it a page it will want again. Reading the tail of the run rather than the average is what separates the two.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="300" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Page faults per second over thirty minutes of real traffic</text>
  <line x1="88" y1="52" x2="88" y2="220" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <line x1="88" y1="220" x2="736" y2="220" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <g font-size="9.5" fill="var(--viz-ink-mute,#565f6d)" text-anchor="end">
    <text x="80" y="224">0</text><text x="80" y="182">400</text><text x="80" y="140">800</text><text x="80" y="98">1200</text><text x="80" y="56">1600</text>
  </g>
  <g font-size="9.5" fill="var(--viz-ink-mute,#565f6d)" text-anchor="middle">
    <text x="88" y="240">0 min</text><text x="304" y="240">10</text><text x="520" y="240">20</text><text x="736" y="240">30</text>
  </g>
  <rect x="88" y="52" width="216" height="168" fill="var(--viz-ok,#7d6200)" opacity="0.08"/>
  <text x="196" y="70" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-ok,#7d6200)">warm-up — both look the same</text>
  <path d="M88 60 L160 96 L232 148 L304 186 L376 206 L448 214 L520 217 L592 218 L664 219 L736 219" fill="none" stroke="var(--viz-good,#0a656d)" stroke-width="2.6"/>
  <path d="M88 62 L160 100 L232 142 L304 160 L376 164 L448 162 L520 165 L592 163 L664 164 L736 163" fill="none" stroke="var(--viz-poor,#a8320f)" stroke-width="2.6" stroke-dasharray="8 5"/>
  <text x="600" y="208" font-size="10" font-weight="700" fill="var(--viz-good,#0a656d)">decays to near zero</text>
  <text x="600" y="152" font-size="10" font-weight="700" fill="var(--viz-poor,#a8320f)">flattens and stays</text>
  <text x="24" y="268" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">The average over the whole run is almost the same for both. Only the shape of the tail distinguishes a cache that has</text>
  <text x="24" y="284" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">finished loading its working set from one that will never finish, which is why a five-minute sample proves nothing.</text>
</svg>

## Common Failure Patterns

**1. Sizing from the store instead of from the traffic.** The store is what exists; the working set is what gets read, and on spatial data those differ by an order of magnitude or more. Traffic follows population and commerce, so a graph covering a country will have a handful of dense regions that carry nearly all queries. Measure which regions are read before deciding how much of the graph has to be resident.

```cypher
// Read distribution by region over a sampling window — run against your own
// request log rather than the graph, but this shape shows the idea.
MATCH (n:RoadNode)
WHERE n.last_read_at > datetime() - duration('P1D')
RETURN n.region AS region, count(*) AS nodes
ORDER BY nodes DESC LIMIT 20;
```

**2. Forgetting that indexes are pages too.** The point index is the first thing a spatial query reads and the last thing anyone remembers to count. A cache sized to cover the node and relationship stores but not the index leaves the seek — the operation the whole query design depends on — faulting on every request, which presents as a slow query rather than as a memory problem.

**3. Measuring during warm-up and concluding the cache is too small.** This is the same reading in both cases for the first several minutes, and a deployment pipeline that samples for two minutes after a restart will condemn a perfectly sized cache every time. Sample for at least twenty minutes under representative traffic, and read the second half.

## Performance Notes

The relationship between cache size and latency is not linear, and knowing its shape saves a lot of money. As the cache grows from nothing, latency improves steeply — each additional page displaces a storage read that was serialised into a traversal. Once the working set fits, the curve goes flat: additional memory holds pages nobody reads. The useful size sits just past the knee, and the knee's position is a property of the traffic rather than of the graph.

$$m(C) \approx \max\!\left(0,\ 1 - \frac{C}{W}\right)$$

For a cache of size $C$ and a working set of size $W$, the miss rate falls roughly linearly until $C$ reaches $W$ and then stops falling. Everything spent beyond $W$ is memory the [JVM heap and any resident projection](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-memory-and-storage-tuning/) could have used, and on a host under pressure that trade is the one that turns a slow service into a failing one.

Two operational habits follow. Warm deliberately after a restart — touch the point index and the densest region before the instance takes traffic, or the first minutes of every deploy are served at storage latency. And re-measure after each bulk import, because an import both grows the store and fills the cache with exactly the pages a read workload does not want.

<svg viewBox="0 0 780 288" role="img" aria-labelledby="pcKneeTitle pcKneeDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="pcKneeTitle">Latency against cache size has a knee, and it sits at the working set</title>
  <desc id="pcKneeDesc">Median route latency plotted against page-cache size. Latency falls steeply as the cache grows, because each additional resident page removes a storage read that was serialised inside a traversal. At the point where the cache covers the working set the curve flattens, and further memory buys nothing because it holds pages the service never reads. The useful setting is just past that knee. On this graph the working set is about a third of the store, so sizing the cache to the whole store would spend three times the memory for no measurable gain.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="288" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Median route latency against page-cache size</text>
  <line x1="96" y1="48" x2="96" y2="208" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <line x1="96" y1="208" x2="720" y2="208" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <text x="44" y="132" font-size="10" font-weight="700" fill="currentColor" transform="rotate(-90 44 132)">p50 latency</text>
  <g font-size="9.5" fill="var(--viz-ink-mute,#565f6d)" text-anchor="middle">
    <text x="96" y="228">0</text><text x="252" y="228">¼ store</text><text x="408" y="228">½ store</text><text x="564" y="228">¾ store</text><text x="720" y="228">store</text>
  </g>
  <text x="408" y="248" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">page-cache size</text>
  <path d="M96 60 L160 96 L224 132 L288 164 L330 186 L370 196 L440 200 L520 202 L600 203 L720 204" fill="none" stroke="var(--accent,#0a656d)" stroke-width="2.8"/>
  <line x1="330" y1="48" x2="330" y2="208" stroke="var(--viz-ok,#7d6200)" stroke-width="1.6" stroke-dasharray="6 4"/>
  <circle cx="330" cy="186" r="6" fill="var(--viz-ok,#7d6200)"/>
  <text x="342" y="86" font-size="11" font-weight="700" fill="var(--viz-ok,#7d6200)">the knee — the working set fits here</text>
  <text x="342" y="102" font-size="10" fill="var(--viz-ink-mute,#565f6d)">about a third of the store on this graph</text>
  <rect x="330" y="48" width="390" height="160" fill="var(--viz-stroke,#9ca3af)" opacity="0.1"/>
  <text x="525" y="164" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--viz-ink-mute,#565f6d)">memory spent here holds pages nobody reads</text>
  <text x="24" y="276" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">The knee's position is a property of the traffic, not of the graph — the same store serves a different knee in a different city.</text>
</svg>

## Related

- [Graph Memory and Storage Tuning](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-memory-and-storage-tuning/) — the three competing pools this budget comes out of.
- [Spatial Indexing Strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) — the index files the cache has to cover alongside the stores.
- [Reading EXPLAIN and PROFILE Plans for Spatial Queries](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/reading-explain-and-profile-plans-for-spatial-queries/) — proving a regression is memory rather than planning.
- [Keeping Spatial Queries in the Plan Cache](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/keeping-spatial-queries-in-the-plan-cache/) — the other cache whose miss rate shows up as latency.

This guide is part of [Graph Memory and Storage Tuning](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-memory-and-storage-tuning/), within [Spatial Graph Database Fundamentals for Python](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/).
