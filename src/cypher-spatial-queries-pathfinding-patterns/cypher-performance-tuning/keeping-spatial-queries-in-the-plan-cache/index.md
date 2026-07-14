---
pageTitle: Keeping Queries in the Plan Cache
title: Keeping Spatial Queries in the Plan Cache
description: Why literal coordinates baked into Cypher strings thrash Neo4j's plan cache, and how parameterizing lat, lon and radius restores cache hits and cuts replans
slug: keeping-spatial-queries-in-the-plan-cache
type: article
breadcrumb: Plan Cache Reuse
datePublished: 2026-07-14
dateModified: 2026-07-14
---
# Keeping Spatial Queries in the Plan Cache

A spatial service that compiles fine under light traffic starts burning CPU on query planning the moment real request volume arrives — flame graphs point not at execution but at the Cypher compiler, and p99 latency climbs even though every individual query is fast once it runs. The symptom is a planning-time cost that should be paid once per query shape but is instead paid on almost every request. The root cause is coordinates baked into the query string: each request builds a distinct text like `WHERE n.location.latitude >= 41.8802 …`, and because Neo4j keys its plan cache on the query string, every new coordinate is a cache miss that forces a fresh compile and evicts an older entry. This page shows why that thrash happens, how parameterizing `$lat`, `$min_lon`, and `$radius` collapses thousands of one-off plans into a single reused one, and how to measure the replan rate so you can prove the fix. It is a core concern of [Cypher Performance Tuning](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/).

## Prerequisites & Versions

The behavior below is stable on Neo4j 5.x. The Python side uses the official async driver and measures replans client-side by counting distinct query strings — the exact key the cache uses — plus wall-clock latency.

| Requirement | Minimum version | Note |
| --- | --- | --- |
| Python | 3.10+ | `async for`, f-strings used to demonstrate the anti-pattern |
| Neo4j | 5.13+ | Native `point`, string-keyed query cache, `db.stats` procedures |
| neo4j (driver) | 5.x | `AsyncGraphDatabase`, parameter serialization over Bolt |

```bash
pip install "neo4j>=5.18"
```

The graph is a set of `:Sensor` nodes across metropolitan Chicago, each with a native `location` point indexed for bounding-box range seeks. The seek itself is the technique from [distance filter query patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/); this page is about keeping the *plan* for that seek warm across requests.

<svg viewBox="0 0 780 372" role="img" aria-labelledby="pcTitle pcDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="pcTitle">Literal-built queries thrashing the plan cache versus one parameterized plan reused</title>
  <desc id="pcDesc">Left: three requests with different literal coordinates each produce a distinct query string, so the planner compiles each one and the fixed-capacity plan cache evicts older entries, causing a recompile storm. Right: three requests share one parameterized query string, the planner compiles it once, and every later request is a cache hit against the single stored plan.</desc>
  <defs>
    <marker id="pc-arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <line x1="390" y1="50" x2="390" y2="330" stroke="currentColor" stroke-width="1" stroke-dasharray="3 6" opacity="0.3"/>
  <!-- LEFT: literal thrash -->
  <text x="195" y="26" text-anchor="middle" font-size="14.5" font-weight="700" fill="currentColor">Literal coordinates baked in</text>
  <text x="195" y="44" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7">one distinct string per request</text>
  <g font-size="10.5" fill="currentColor">
    <rect x="18" y="58" width="108" height="40" rx="6" fill="var(--accent-coral,#ff6b6b)" opacity="0.12"/>
    <rect x="18" y="58" width="108" height="40" rx="6" fill="none" stroke="var(--accent-coral,#ff6b6b)" stroke-width="1.4"/>
    <text x="72" y="82" text-anchor="middle" font-weight="700">lat 41.8781</text>
    <rect x="141" y="58" width="108" height="40" rx="6" fill="var(--accent-coral,#ff6b6b)" opacity="0.12"/>
    <rect x="141" y="58" width="108" height="40" rx="6" fill="none" stroke="var(--accent-coral,#ff6b6b)" stroke-width="1.4"/>
    <text x="195" y="82" text-anchor="middle" font-weight="700">lat 41.8794</text>
    <rect x="264" y="58" width="108" height="40" rx="6" fill="var(--accent-coral,#ff6b6b)" opacity="0.12"/>
    <rect x="264" y="58" width="108" height="40" rx="6" fill="none" stroke="var(--accent-coral,#ff6b6b)" stroke-width="1.4"/>
    <text x="318" y="82" text-anchor="middle" font-weight="700">lat 41.8802</text>
  </g>
  <line x1="72" y1="98" x2="72" y2="120" stroke="currentColor" stroke-width="1.4" marker-end="url(#pc-arr)"/>
  <line x1="195" y1="98" x2="195" y2="120" stroke="currentColor" stroke-width="1.4" marker-end="url(#pc-arr)"/>
  <line x1="318" y1="98" x2="318" y2="120" stroke="currentColor" stroke-width="1.4" marker-end="url(#pc-arr)"/>
  <rect x="30" y="122" width="330" height="40" rx="8" fill="none" stroke="var(--accent-coral,#ff6b6b)" stroke-width="1.8"/>
  <text x="195" y="146" text-anchor="middle" font-size="12.5" font-weight="700" fill="currentColor">planner compiles each string</text>
  <line x1="195" y1="162" x2="195" y2="186" stroke="currentColor" stroke-width="1.4" marker-end="url(#pc-arr)"/>
  <rect x="30" y="188" width="330" height="86" rx="8" fill="var(--accent-coral,#ff6b6b)" opacity="0.07"/>
  <rect x="30" y="188" width="330" height="86" rx="8" fill="none" stroke="var(--accent-coral,#ff6b6b)" stroke-width="1.4"/>
  <text x="195" y="208" text-anchor="middle" font-size="11.5" font-weight="700" fill="currentColor">Plan cache — capacity C</text>
  <g>
    <rect x="52" y="220" width="40" height="30" rx="4" fill="var(--accent-coral,#ff6b6b)" opacity="0.3"/>
    <rect x="100" y="220" width="40" height="30" rx="4" fill="var(--accent-coral,#ff6b6b)" opacity="0.3"/>
    <rect x="148" y="220" width="40" height="30" rx="4" fill="var(--accent-coral,#ff6b6b)" opacity="0.3"/>
    <rect x="196" y="220" width="40" height="30" rx="4" fill="none" stroke="currentColor" stroke-width="1" stroke-dasharray="3 3" opacity="0.4"/>
  </g>
  <line x1="252" y1="235" x2="300" y2="235" stroke="var(--accent-coral,#ff6b6b)" stroke-width="1.6" marker-end="url(#pc-arr)"/>
  <text x="326" y="230" text-anchor="middle" font-size="10" fill="var(--accent-coral,#ff6b6b)" font-weight="700">evicted</text>
  <text x="326" y="244" text-anchor="middle" font-size="10" fill="var(--accent-coral,#ff6b6b)" font-weight="700">→ recompile</text>
  <!-- RIGHT: parameterized -->
  <text x="585" y="26" text-anchor="middle" font-size="14.5" font-weight="700" fill="currentColor">Parameterized query</text>
  <text x="585" y="44" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7">one string, many requests</text>
  <g font-size="10.5" fill="currentColor">
    <rect x="408" y="58" width="108" height="40" rx="6" fill="var(--accent,#0e7c86)" opacity="0.1"/>
    <rect x="408" y="58" width="108" height="40" rx="6" fill="none" stroke="var(--accent,#0e7c86)" stroke-width="1.4"/>
    <text x="462" y="82" text-anchor="middle" font-weight="700">$lat $lon</text>
    <rect x="531" y="58" width="108" height="40" rx="6" fill="var(--accent,#0e7c86)" opacity="0.1"/>
    <rect x="531" y="58" width="108" height="40" rx="6" fill="none" stroke="var(--accent,#0e7c86)" stroke-width="1.4"/>
    <text x="585" y="82" text-anchor="middle" font-weight="700">$lat $lon</text>
    <rect x="654" y="58" width="108" height="40" rx="6" fill="var(--accent,#0e7c86)" opacity="0.1"/>
    <rect x="654" y="58" width="108" height="40" rx="6" fill="none" stroke="var(--accent,#0e7c86)" stroke-width="1.4"/>
    <text x="708" y="82" text-anchor="middle" font-weight="700">$lat $lon</text>
  </g>
  <line x1="462" y1="98" x2="558" y2="120" stroke="currentColor" stroke-width="1.4" marker-end="url(#pc-arr)"/>
  <line x1="585" y1="98" x2="585" y2="120" stroke="currentColor" stroke-width="1.4" marker-end="url(#pc-arr)"/>
  <line x1="708" y1="98" x2="612" y2="120" stroke="currentColor" stroke-width="1.4" marker-end="url(#pc-arr)"/>
  <rect x="420" y="122" width="330" height="40" rx="8" fill="none" stroke="var(--accent,#0e7c86)" stroke-width="1.8"/>
  <text x="585" y="146" text-anchor="middle" font-size="12.5" font-weight="700" fill="currentColor">planner compiles once</text>
  <line x1="585" y1="162" x2="585" y2="186" stroke="currentColor" stroke-width="1.4" marker-end="url(#pc-arr)"/>
  <rect x="420" y="188" width="330" height="86" rx="8" fill="var(--accent,#0e7c86)" opacity="0.08"/>
  <rect x="420" y="188" width="330" height="86" rx="8" fill="none" stroke="var(--accent,#0e7c86)" stroke-width="1.4"/>
  <text x="585" y="208" text-anchor="middle" font-size="11.5" font-weight="700" fill="currentColor">Plan cache — capacity C</text>
  <rect x="520" y="220" width="130" height="34" rx="5" fill="var(--accent,#0e7c86)" opacity="0.85"/>
  <text x="585" y="242" text-anchor="middle" font-size="11" font-weight="700" fill="#ffffff">one stored plan</text>
  <text x="585" y="268" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.78">every later request is a cache hit</text>
  <text x="390" y="356" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.65">Same seek, same result — the literal build recompiles per request; the parameterized build compiles once.</text>
</svg>

## Implementation

The script contrasts the two builders over a stream of nearby search points. `literal_query` interpolates coordinates into the Cypher text with an f-string; `parameterized_query` keeps one fixed string and passes coordinates as parameters. For each request the client records the exact query string sent — the plan-cache key — and its latency. The replan rate is then the count of distinct strings over the request count: the literal path approaches 1.0 (a fresh plan almost every request), the parameterized path approaches `1/N`.

```python
import asyncio
import time
from neo4j import AsyncGraphDatabase

# ANTI-PATTERN: coordinates are concatenated into the query text, so every
# request is a distinct string and therefore a distinct plan-cache entry.
def literal_query(min_lat, max_lat, min_lon, max_lon) -> str:
    return f"""
    MATCH (n:Sensor)
    WHERE n.location.latitude  >= {min_lat} AND n.location.latitude  <= {max_lat}
      AND n.location.longitude >= {min_lon} AND n.location.longitude <= {max_lon}
    RETURN n.id AS id
    """

# CORRECT: one fixed string; coordinates ride as parameters over Bolt.
PARAMETERIZED = """
MATCH (n:Sensor)
WHERE n.location.latitude  >= $min_lat AND n.location.latitude  <= $max_lat
  AND n.location.longitude >= $min_lon AND n.location.longitude <= $max_lon
RETURN n.id AS id
"""


async def run_batch(session, boxes, *, parameterized: bool):
    seen_strings: set[str] = set()
    started = time.perf_counter()
    for box in boxes:
        if parameterized:
            cypher, params = PARAMETERIZED, box
        else:
            cypher, params = literal_query(**box), {}
        seen_strings.add(cypher)
        result = await session.run(cypher, **params)
        await result.consume()
    elapsed = time.perf_counter() - started
    return {
        "requests": len(boxes),
        "distinct_query_strings": len(seen_strings),
        "replan_rate": len(seen_strings) / len(boxes),
        "wall_seconds": round(elapsed, 3),
    }


async def main() -> None:
    # 200 slightly different search boxes around the Chicago Loop.
    boxes = [
        {
            "min_lat": 41.8700 + i * 0.0003, "max_lat": 41.8900 + i * 0.0003,
            "min_lon": -87.6400,             "max_lon": -87.6100,
        }
        for i in range(200)
    ]
    driver = AsyncGraphDatabase.driver(
        "neo4j+s://your-cluster.databases.neo4j.io",
        auth=("neo4j", "secure-password"),
        connection_acquisition_timeout=5.0,
    )
    try:
        async with driver.session(database="neo4j") as session:
            literal = await run_batch(session, boxes, parameterized=False)
            params = await run_batch(session, boxes, parameterized=True)
    finally:
        await driver.close()

    print(f"literal build : {literal}")
    print(f"parameterized : {params}")


if __name__ == "__main__":
    asyncio.run(main())
```

The literal batch reports `distinct_query_strings: 200` and `replan_rate: 1.0`; the parameterized batch reports `distinct_query_strings: 1` and `replan_rate: 0.005`. The wall-clock gap widens with concurrency, because compilation contends on a shared latch that execution does not.

## How It Works

Neo4j caches compiled query plans keyed on the query text. Two requests reuse a plan only if their strings are byte-for-byte identical after the compiler's normalization. When you interpolate `41.8802` into the `WHERE` clause, the string differs from the request that used `41.8794`, so it is a fresh key: the compiler parses, plans, and stores a new entry. The cache is bounded — governed by a query-cache-size setting, on the order of a thousand entries by default — so a high-cardinality stream of literal coordinates fills it and evicts entries that would otherwise have been reused, and the eviction victims must be recompiled when they recur. Under burst you get a recompilation storm: CPU spent planning the same query shape thousands of times.

Parameters break the cycle. `$min_lat`, `$max_lat`, and `$radius` are transmitted as typed values over the Bolt protocol, separate from the query text, so the string is invariant across all coordinates. The planner compiles it once, stores one entry, and every subsequent request — regardless of where in Chicago it searches — is a cache hit that skips straight to execution. The plan is coordinate-agnostic because the seek strategy (a `PointIndexSeekByRange` over a range predicate) does not depend on the specific bounds, only on their shape. Neo4j does auto-parameterize *some* literals to soften the worst case, but the coverage is partial and version-dependent; explicit parameters are the only reliable guarantee, and they also close the door on injection. Keeping the plan warm is what lets the index-seek discipline from [distance filter query patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/) actually pay off at request rate rather than being recompiled away.

To confirm it server-side rather than by client proxy, sample the query statistics. `CALL db.stats.retrieve('QUERIES')` reports per-query compilation and invocation counts, and the query log records planning time per entry — a query shape whose compile count tracks its invocation count is thrashing; one that compiles once and invokes thousands of times is cached correctly.

## Common Failure Patterns

**1. f-string (or `%`/`.format`) query building.** Any string interpolation of a runtime value into Cypher creates a distinct plan key and, separately, an injection surface. Pass values as parameters; the only thing that ever belongs in the text is fixed structure.

```python
# Thrashes the cache (and unsafe): value is in the string
cypher = f"MATCH (n:Sensor) WHERE n.id = '{sensor_id}' RETURN n"
# Cached and safe: value is a parameter
cypher = "MATCH (n:Sensor) WHERE n.id = $sensor_id RETURN n"
```

**2. Changing property key order between requests.** A map literal built from an unordered `dict` can serialize keys differently across requests — `{latitude: …, longitude: …}` one time, `{longitude: …, latitude: …}` the next — producing distinct query strings for the same intent. Build map and property structure from a fixed template so the text is stable, and let only parameters vary.

**3. Unbounded distinct-parameter cardinality on the `*..N` bound.** Parameters fix the coordinate problem, but the variable-length upper bound in `[:CONNECTED_TO*..N]` must be a literal, so a query template that interpolates a different `N` per request reintroduces distinct plans. Pin `N` to a small set of operational tiers (say 8, 15, 20) rather than passing arbitrary caller values, so at most a handful of plans exist instead of one per depth.

## Performance Notes

The cost is a compiler tax proportional to how many distinct strings you generate. For $q$ distinct query strings issued against a cache of capacity $C$, and $r$ total requests, the number of compilations is roughly $\min(q, r)$ for the literal build and exactly $1$ for the parameterized build:

$$\text{compiles}_{\text{literal}} \approx \min(q,\,r) \qquad \text{compiles}_{\text{param}} = 1$$

and the cache hit ratio the client observes is $H = 1 - q/r$, which the literal path drives toward zero as coordinates diversify and the parameterized path holds at nearly one. Compilation is markedly more expensive than executing a cached plan, so on a hot endpoint the parameterized form is not a micro-optimization — it removes an entire per-request phase. Pin any structural variant (the depth bound, tier thresholds) to a small discrete set so total plan count stays a handful, and verify with `db.stats` that compile counts are not tracking invocation counts. This is the plan-reuse half of the broader loop in [Cypher Performance Tuning](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/); the other half is making sure the plan that gets cached is a seek, not a scan.

## Related

- [Distance Filter Query Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/) — the parameterized bounding-box seek whose plan this page keeps warm.
- [Eliminating Cartesian Products in Spatial Cypher](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/eliminating-cartesian-products-in-spatial-cypher/) — the sibling tuning concern of query shape and join blow-up.
- [K-Nearest Neighbor Routing](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/k-nearest-neighbor-routing/) — parameterized candidate generation that benefits from the same plan reuse.
- [Graph Query Planner Optimization](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/) — how the planner compiles and caches the plan a stable string reuses.

This guide is part of [Cypher Performance Tuning](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/), one of the workflows in [Cypher Spatial Queries & Pathfinding Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/).

For authoritative reference, consult the [Neo4j Cypher Manual](https://neo4j.com/docs/cypher-manual/current/) and its [Parameters](https://neo4j.com/docs/cypher-manual/current/syntax/parameters/) documentation.
