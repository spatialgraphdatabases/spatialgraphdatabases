---
pageTitle: Warming Caches Before Serving
title: Warming Caches Before Serving Routes
description: Turn the first minutes after a restart from a user-visible outage into a startup delay, by warming the page cache, the plan cache and the projection before taking traffic.
slug: warming-caches-before-serving-routes
type: article
breadcrumb: Cache Warming
datePublished: 2026-08-11
dateModified: 2026-08-11
---
# Warming Caches Before Serving Routes

Every deploy of a routing service has the same shape if nobody has thought about it: the instance starts, passes its health check in a few hundred milliseconds, joins the load balancer, and serves the next several minutes of traffic at storage latency with a p95 an order of magnitude above normal. Nothing is broken. Three caches are empty — the page cache holds no store pages, the plan cache holds no compiled plans, and any Graph Data Science projection does not exist — and every one of them is filled by real user requests paying the cost. Warming them deliberately converts that from an incident into a startup delay nobody sees.

## Prerequisites & Versions

Everything here runs from the service's own startup path.

| Requirement | Minimum version | Install |
| --- | --- | --- |
| Python | 3.11 | — |
| neo4j (async driver) | 5.20 | `pip install "neo4j>=5.20"` |
| Neo4j Server | 5.15 | `db.awaitIndexes` |
| Graph Data Science | 2.6 | optional, if a projection is held |

## Implementation

```python
import asyncio
import time
from dataclasses import dataclass, field

from neo4j import AsyncGraphDatabase

# Ordered deliberately. Indexes first, because a query planned against a
# POPULATING index caches a scan plan that outlives the index coming online —
# warming the plan cache before the index is ready poisons it.
AWAIT_INDEXES = "CALL db.awaitIndexes($timeout_s)"

# Touch the point index and the densest region, which is what routing reads
# first. A full label scan would be worse than useless: it evicts the pages the
# service actually wants with pages it will never read again.
WARM_PAGES = """
MATCH (n:Junction)
WHERE n.location.latitude  >= $min_lat AND n.location.latitude  <= $max_lat
  AND n.location.longitude >= $min_lon AND n.location.longitude <= $max_lon
RETURN count(n) AS touched
"""

# One execution per query SHAPE compiles and caches its plan. The parameter
# values are irrelevant — only the text is the cache key — so a cheap synthetic
# value is enough, and is preferable to a real one that does expensive work.
WARM_PLANS = [
    ("""MATCH (h:Hub) WHERE h.location.latitude >= $min_lat
        AND h.location.latitude <= $max_lat
        AND h.location.longitude >= $min_lon AND h.location.longitude <= $max_lon
        WITH h, point.distance(h.location, $centre) AS m WHERE m <= $radius
        RETURN h.id ORDER BY m LIMIT $k""", "radius search"),
    ("""MATCH (a:Junction {id: $from_id}), (b:Junction {id: $to_id})
        MATCH p = shortestPath((a)-[:SEGMENT*..15]->(b))
        RETURN length(p)""", "point-to-point route"),
]


@dataclass
class WarmupReport:
    steps: list[tuple[str, float, str]] = field(default_factory=list)

    def add(self, name: str, seconds: float, detail: str = "") -> None:
        self.steps.append((name, seconds, detail))

    @property
    def total_s(self) -> float:
        return sum(s for _, s, _ in self.steps)


class Warmer:
    def __init__(self, uri: str, auth: tuple[str, str]) -> None:
        self._driver = AsyncGraphDatabase.driver(uri, auth=auth)

    async def close(self) -> None:
        await self._driver.close()

    async def warm(self, hot_box: dict, timeout_s: int = 600) -> WarmupReport:
        report = WarmupReport()
        async with self._driver.session() as session:
            t = time.monotonic()
            await session.run(AWAIT_INDEXES, timeout_s=timeout_s)
            report.add("indexes online", time.monotonic() - t)

            t = time.monotonic()
            result = await session.run(WARM_PAGES, **hot_box)
            touched = int((await result.single())["touched"])
            report.add("page cache", time.monotonic() - t, f"{touched:,} nodes")

            for query, label in WARM_PLANS:
                t = time.monotonic()
                # Consume the result: a plan is not compiled until the query runs.
                await (await session.run(query, **_synthetic_params(hot_box))).consume()
                report.add(f"plan: {label}", time.monotonic() - t)
        return report


def _synthetic_params(hot_box: dict) -> dict:
    return {
        **hot_box,
        "centre": None, "radius": 1.0, "k": 1,
        "from_id": "warmup:a", "to_id": "warmup:b",
    }
```

## How It Works

**Order matters, and index readiness comes first.** A query planned while an index is still `POPULATING` gets a scan plan, and that plan is cached — so warming the plan cache before the index is online is actively harmful: it installs the wrong plans and they persist after the index is ready. `db.awaitIndexes` blocks until every index is `ONLINE`, which makes the rest of the sequence meaningful.

**The page cache is warmed selectively, not exhaustively.** A full label scan pulls the entire store through the cache and evicts, at the end, everything it loaded at the start — the cache ends up holding whatever the scan touched last, which is nothing the service will read. Touching the point index over the region that actually receives traffic loads the pages that will be hit, and it is a bounded amount of work.

**A plan is cached by query text, so warming needs the shape and not the data.** One execution per distinct query shape compiles and stores its plan, and the parameter values never enter the cache key — which is exactly the property that makes [parameterised queries reusable](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/keeping-spatial-queries-in-the-plan-cache/) and makes warming cheap. Synthetic parameters that match nothing are ideal: the plan is compiled, and no real work is done.

<svg viewBox="0 0 780 312" role="img" aria-labelledby="warmOrderTitle warmOrderDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="warmOrderTitle">The warm-up sequence, and what happens when the order is wrong</title>
  <desc id="warmOrderDesc">Two orderings of the same three warm-up steps. Done correctly, indexes are awaited first, then the page cache is warmed over the hot region, then one execution per query shape compiles its plan against a ready index — and the instance takes traffic with all three caches populated. Done in the wrong order, the plans are compiled while the index is still populating, so scan plans are cached; the index then comes online but the cached plans do not re-plan themselves, and the instance serves scan plans against a perfectly good index until something evicts them.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="312" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Three steps, and the order is not interchangeable</text>
  <text x="24" y="52" font-size="11.5" font-weight="700" fill="var(--viz-good,#0a656d)">correct order</text>
  <g font-size="10" font-weight="700" text-anchor="middle">
    <rect x="140" y="38" width="160" height="26" rx="6" fill="var(--viz-good,#0a656d)"/><text x="220" y="55" fill="var(--viz-on-pill,#ffffff)">1 · await indexes</text>
    <rect x="312" y="38" width="160" height="26" rx="6" fill="var(--viz-good,#0a656d)"/><text x="392" y="55" fill="var(--viz-on-pill,#ffffff)">2 · warm pages</text>
    <rect x="484" y="38" width="160" height="26" rx="6" fill="var(--viz-good,#0a656d)"/><text x="564" y="55" fill="var(--viz-on-pill,#ffffff)">3 · compile plans</text>
  </g>
  <text x="660" y="55" font-size="10" font-weight="700" fill="var(--viz-good,#0a656d)">then take traffic</text>
  <rect x="24" y="80" width="732" height="30" rx="8" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="1.4"/>
  <text x="44" y="100" font-size="10" fill="var(--viz-ink-mute,#565f6d)">plans are compiled against an ONLINE index, so every cached plan is a seek plan</text>
  <line x1="24" y1="132" x2="756" y2="132" stroke="var(--line,#e5e0d2)" stroke-width="1" stroke-dasharray="3 6"/>
  <text x="24" y="146" font-size="11.5" font-weight="700" fill="var(--viz-poor,#a8320f)">plans too early</text>
  <g font-size="10" font-weight="700" text-anchor="middle">
    <rect x="140" y="150" width="160" height="26" rx="6" fill="var(--viz-poor,#a8320f)"/><text x="220" y="167" fill="var(--viz-on-pill,#ffffff)">1 · compile plans</text>
    <rect x="312" y="150" width="160" height="26" rx="6" fill="var(--viz-ink-mute,#565f6d)"/><text x="392" y="167" fill="var(--viz-on-pill,#ffffff)">2 · warm pages</text>
    <rect x="484" y="150" width="160" height="26" rx="6" fill="var(--viz-ink-mute,#565f6d)"/><text x="564" y="167" fill="var(--viz-on-pill,#ffffff)">3 · await indexes</text>
  </g>
  <rect x="24" y="192" width="732" height="30" rx="8" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-poor,#a8320f)" stroke-width="1.6"/>
  <text x="44" y="212" font-size="10" fill="var(--viz-poor,#a8320f)" font-weight="600">the index was POPULATING, so scan plans were cached — and they outlive the index coming online</text>
  <rect x="24" y="238" width="732" height="56" rx="9" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1.2"/>
  <text x="44" y="260" font-size="11" font-weight="700" fill="currentColor">the second ordering is worse than not warming at all</text>
  <text x="44" y="280" font-size="10" fill="var(--viz-ink-mute,#565f6d)">Without warming, the first real query compiles a correct plan. With warming in the wrong order, a wrong plan is installed deliberately.</text>
</svg>

## Common Failure Patterns

**1. Joining the load balancer before warming finishes.** The readiness probe must fail until the warm-up completes, or the whole exercise is theatre — the instance is warming and serving simultaneously, and the users are still paying. Separating liveness from readiness is what makes this expressible: the process is alive from the start and ready only when its caches are.

```python
# The readiness endpoint reflects the warm-up, not the process.
READY = False

async def startup() -> None:
    global READY
    report = await warmer.warm(hot_box=HOT_REGION)
    log.info("warm-up complete in %.1fs: %s", report.total_s, report.steps)
    READY = True
```

**2. Warming with a full scan.** It feels thorough and it is counterproductive: the scan's own pages evict each other, and the cache ends up holding the tail of the label rather than the working set. Warm the [region the traffic actually reads](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-memory-and-storage-tuning/sizing-the-page-cache-for-a-spatial-graph/), which is a small fraction of a national graph.

**3. Forgetting the projection.** A service that holds a resident Graph Data Science projection has a fourth cold cache, and it is the most expensive one — a country-scale projection is minutes, not seconds. It belongs in the same startup path, and its absence is the reason a "warmed" instance can still be slow on its first routing request.

## Performance Notes

The saving is bounded by how long the caches take to fill under real traffic, which is longer than it takes to fill them deliberately because real traffic is not trying to:

$$T_{\text{user-visible}} \approx \frac{W}{r \cdot h}$$

for a working set $W$, request rate $r$ and pages touched per request $h$. On a service taking fifty requests a second against a working set of a few gigabytes, that is several minutes of degraded p95 — and it recurs on every deploy, every restart and every autoscale event, which on a busy service is many times a day.

Warming costs a fixed startup delay instead, typically tens of seconds. The trade is worth making almost always, and the exception is worth naming: an autoscaler that adds instances in response to load will add them *slower* if each one takes a minute to become ready, so a service that scales reactively under spikes needs the warm-up time counted in its scaling headroom. The answer is usually to scale earlier rather than to warm less.

There is one further benefit that is easy to miss. A warm-up that runs the real query shapes is also a smoke test: if the point index is missing, if a query has a syntax error after a deploy, or if the projection cannot be built within the memory budget, the instance fails to become ready rather than becoming ready and then failing on user traffic. That makes the warm-up a deployment gate as well as a latency optimisation, and it is the reason to run the actual query shapes rather than a generic `RETURN 1`.

<svg viewBox="0 0 780 292" role="img" aria-labelledby="warmP95Title warmP95Desc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="warmP95Title">p95 after a deploy, with and without a warm-up gate</title>
  <desc id="warmP95Desc">The 95th-percentile latency of a routing endpoint over the six minutes following a deploy. Without warming, the instance joins the load balancer immediately and p95 starts about ten times its steady-state value, decaying over roughly four minutes as real requests populate the caches — a degradation every user sees. With a warm-up gate the instance stays out of the load balancer for forty seconds and then serves at steady-state p95 from its first request. The area between the curves is latency that was paid by users in one case and by the deployment in the other.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="292" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">p95 in the six minutes after a deploy</text>
  <line x1="96" y1="48" x2="96" y2="204" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <line x1="96" y1="204" x2="720" y2="204" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <g font-size="9.5" fill="var(--viz-ink-mute,#565f6d)" text-anchor="middle">
    <text x="96" y="224">deploy</text><text x="252" y="224">1 min</text><text x="408" y="224">3 min</text><text x="564" y="224">5 min</text><text x="720" y="224">6 min</text>
  </g>
  <text x="44" y="130" font-size="10" font-weight="700" fill="currentColor" transform="rotate(-90 44 130)">p95</text>
  <line x1="96" y1="188" x2="720" y2="188" stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1.4" stroke-dasharray="5 4"/>
  <text x="716" y="182" text-anchor="end" font-size="9.5" font-weight="700" fill="var(--viz-ink-mute,#565f6d)">steady state</text>
  <path d="M96 60 L174 88 L252 116 L330 146 L408 168 L486 180 L564 186 L642 188 L720 188" fill="none" stroke="var(--viz-poor,#a8320f)" stroke-width="2.8"/>
  <text x="188" y="76" font-size="10" font-weight="700" fill="var(--viz-poor,#a8320f)">no warm-up — four minutes of degraded service</text>
  <rect x="96" y="48" width="66" height="156" fill="var(--viz-good,#0a656d)" opacity="0.14"/>
  <text x="129" y="120" text-anchor="middle" font-size="9" font-weight="700" fill="var(--viz-good,#0a656d)" transform="rotate(-90 129 120)">warming, not ready</text>
  <path d="M162 188 L252 188 L408 188 L564 188 L720 188" fill="none" stroke="var(--viz-good,#0a656d)" stroke-width="2.8"/>
  <text x="330" y="204" font-size="10" font-weight="700" fill="var(--viz-good,#0a656d)">warmed — steady state from the first request</text>
  <text x="24" y="256" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">The area between the curves is the same latency either way. The difference is whether users pay it or the deployment does —</text>
  <text x="24" y="272" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">and on a service that autoscales, users pay it several times a day.</text>
</svg>

Two refinements are worth adding once the basic sequence is in place.

The first is to derive the hot region from traffic rather than hard-coding it. A bounding box pasted into a config file is right on the day it is written and drifts as the service grows into new cities; recording the regions actually queried over a rolling window and warming the busiest of them keeps the warm-up aimed at the working set without anyone maintaining it. It also surfaces a useful fact for free — if the hot regions have grown beyond what the page cache can hold, the warm-up is now evicting its own earlier work, and that is a sizing decision rather than a warm-up one.

The second is to make the warm-up's duration a monitored quantity rather than an incidental one. It grows with the graph and with the number of query shapes, so a warm-up that took twenty seconds at launch and now takes three minutes is telling you something before it becomes a deployment problem — and on a service that autoscales, warm-up duration is directly part of how quickly capacity can be added. Emitting the per-step timings from the report above makes the growth attributable: index waiting, page loading and plan compilation grow for entirely different reasons and want different responses.

## Related

- [Cypher Performance Tuning for Spatial Routing Workflows](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/) — the tuning loop this closes.
- [Keeping Spatial Queries in the Plan Cache](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/keeping-spatial-queries-in-the-plan-cache/) — why one execution per shape is all the warming a plan needs.
- [Sizing the Page Cache for a Spatial Graph](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-memory-and-storage-tuning/sizing-the-page-cache-for-a-spatial-graph/) — identifying the region worth warming.
- [Why a Point Index Is Not Being Used](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/why-a-point-index-is-not-being-used/) — the populating-index trap this sequence avoids.

This guide is part of [Cypher Performance Tuning](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/), within [Cypher Spatial Queries & Pathfinding Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/).
