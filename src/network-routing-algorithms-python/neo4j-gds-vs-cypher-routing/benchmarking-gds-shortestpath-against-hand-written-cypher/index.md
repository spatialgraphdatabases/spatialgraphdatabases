---
pageTitle: Benchmarking GDS vs Cypher Paths
title: Benchmarking GDS shortestPath Against Hand-Written Cypher
description: A runnable async Python harness that benchmarks Neo4j GDS Dijkstra against bounded Cypher shortestPath, reporting p50 and p95 latency with projection build cost counted honestly
slug: benchmarking-gds-shortestpath-against-hand-written-cypher
type: article
breadcrumb: Benchmarking GDS vs Cypher
datePublished: 2026-07-14
dateModified: 2026-07-14
---
# Benchmarking GDS shortestPath Against Hand-Written Cypher

Someone posts a benchmark showing GDS Dijkstra is "50× faster than Cypher," and someone else posts one showing the opposite, and both ran real code. The reason they disagree is that one timed only the algorithm on a resident projection and the other timed the projection build on every call. A benchmark that leaves out the `gds.graph.project` cost is comparing a warm cache against a cold engine — apples to oranges — and it will send you to the wrong architecture. This page gives you one async harness that times three things on the *same* graph and driver: GDS with the projection built once and reused, GDS with the projection built and dropped per query (the honest cold number), and a bounded live Cypher traversal. It reports p50 and p95 for each so you can read where the crossover actually sits on your data instead of on someone's blog. The decision this measurement feeds is laid out in [Neo4j GDS vs Custom Cypher Routing](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/neo4j-gds-vs-cypher-routing/).

## Prerequisites & Versions

The harness uses only the async driver, the standard library, and the GDS plugin already installed on the server. No `graphdatascience` client is required — GDS procedures are called as ordinary Cypher.

| Requirement | Minimum version | Note |
| --- | --- | --- |
| Python | 3.10+ | `perf_counter`, list comprehensions over async results |
| Neo4j | 5.13+ | `CALL {}` subqueries, native `point` |
| neo4j (driver) | 5.x | `AsyncGraphDatabase`, async sessions |
| Graph Data Science | 2.6+ | `gds.graph.project`, `gds.shortestPath.dijkstra.stream` |

```bash
pip install "neo4j>=5.18"
```

The graph must already carry a stable `id` index and a numeric routing weight (`travel_s`) on the relationship, exactly as modeled in the parent guide. Benchmark against a graph whose size and topology resemble production — the whole point is defeated by a toy graph, as the failure patterns below explain.

## Implementation

The harness runs a warm-up pass (untimed, to prime the page cache and JIT the driver's serialization path), then collects latency samples for each strategy and prints percentiles. The cold-GDS sample deliberately wraps `project` + `stream` + `drop` in a single timed block, because that is what a request pays when it cannot reuse a projection.

```python
import asyncio
import time
from neo4j import AsyncGraphDatabase

GDS_PROJECT = (
    "CALL gds.graph.project($g, 'RoadNode', "
    "{CONNECTED_TO: {properties: 'travel_s'}}) "
    "YIELD graphName RETURN graphName"
)
GDS_DROP = "CALL gds.graph.drop($g, false) YIELD graphName RETURN graphName"
GDS_STREAM = """
MATCH (s:RoadNode {id: $src}), (t:RoadNode {id: $dst})
CALL gds.shortestPath.dijkstra.stream($g, {
    sourceNode: s, targetNode: t, relationshipWeightProperty: 'travel_s'
})
YIELD totalCost RETURN totalCost AS cost
"""
CYPHER_ROUTE = """
MATCH (s:RoadNode {id: $src}), (t:RoadNode {id: $dst})
MATCH p = (s)-[:CONNECTED_TO*1..15]->(t)
WITH reduce(c = 0.0, r IN relationships(p) | c + r.travel_s) AS cost
RETURN min(cost) AS cost
"""


def percentile(samples: list[float], p: float) -> float:
    """Linear-interpolated percentile; p in [0, 1]."""
    s = sorted(samples)
    k = (len(s) - 1) * p
    lo = int(k)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


async def _time_call(coro_factory) -> float:
    start = time.perf_counter()
    await coro_factory()
    return (time.perf_counter() - start) * 1000.0  # milliseconds


async def bench(driver, src: str, dst: str, reps: int = 200, cold_reps: int = 20):
    async with driver.session(database="neo4j") as s:

        async def gds_stream():
            await (await s.run(GDS_STREAM, g="warm", src=src, dst=dst)).consume()

        async def cypher_route():
            await (await s.run(CYPHER_ROUTE, src=src, dst=dst)).consume()

        async def gds_cold_cycle():
            await (await s.run(GDS_PROJECT, g="cold")).consume()
            try:
                await (await s.run(GDS_STREAM, g="cold", src=src, dst=dst)).consume()
            finally:
                await (await s.run(GDS_DROP, g="cold")).consume()

        # --- warm-up: prime page cache + plan cache, results discarded ---
        await (await s.run(GDS_PROJECT, g="warm")).consume()
        for _ in range(20):
            await gds_stream()
            await cypher_route()

        # --- resident-projection GDS: project once, time the streams ---
        warm_gds = [await _time_call(gds_stream) for _ in range(reps)]

        # --- live Cypher: time each bounded traversal ---
        cypher = [await _time_call(cypher_route) for _ in range(reps)]

        await (await s.run(GDS_DROP, g="warm")).consume()

        # --- cold GDS: project + stream + drop counted as one request ---
        cold_gds = [await _time_call(gds_cold_cycle) for _ in range(cold_reps)]

    return {"gds_warm": warm_gds, "cypher": cypher, "gds_cold": cold_gds}


def report(name: str, samples: list[float]) -> None:
    print(
        f"{name:<12} n={len(samples):<4} "
        f"p50={percentile(samples, 0.50):8.2f} ms  "
        f"p95={percentile(samples, 0.95):8.2f} ms"
    )


async def main():
    driver = AsyncGraphDatabase.driver(
        "neo4j+s://your-cluster.databases.neo4j.io",
        auth=("neo4j", "secure-password"),
        max_connection_pool_size=20,
    )
    try:
        results = await bench(driver, src="N-1001", dst="N-2087")
        report("GDS warm", results["gds_warm"])
        report("Cypher", results["cypher"])
        report("GDS cold", results["gds_cold"])
    finally:
        await driver.close()


if __name__ == "__main__":
    asyncio.run(main())
```

<svg viewBox="0 0 760 372" role="img" aria-labelledby="benchTitle benchDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="benchTitle">Single-run latency bars and the amortized-cost crossover between GDS and Cypher</title>
  <desc id="benchDesc">Left panel, three latency bars: cold GDS including projection is roughly 840 milliseconds and dominates, warm GDS per query is about 6 milliseconds, and live Cypher per query is about 22 milliseconds. Right panel, amortized cost per query against the number of queries served per projection on a log scale: the Cypher line is flat at about 22 milliseconds while the GDS amortized curve starts high and decays, crossing below Cypher at roughly 53 queries. To the left of the crossover Cypher is cheaper; to the right GDS is cheaper.</desc>
  <defs>
    <marker id="benchArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <!-- ===== LEFT PANEL: single-run bars ===== -->
  <text x="40" y="26" font-size="13" font-weight="700" fill="currentColor">Single-run latency</text>
  <!-- axis -->
  <line x1="56" y1="70" x2="56" y2="300" stroke="currentColor" stroke-width="1.3" opacity="0.5"/>
  <line x1="56" y1="300" x2="350" y2="300" stroke="currentColor" stroke-width="1.3" opacity="0.5"/>
  <g font-size="9.5" fill="currentColor" opacity="0.6" text-anchor="end">
    <text x="50" y="303">0</text>
    <text x="50" y="245">10</text>
    <text x="50" y="188">20</text>
    <text x="50" y="131">30</text>
    <text x="50" y="74">40</text>
  </g>
  <text x="20" y="185" font-size="9.5" fill="currentColor" opacity="0.6" transform="rotate(-90 20 185)" text-anchor="middle">ms / request</text>
  <!-- cold GDS bar (broken scale) -->
  <rect x="70" y="90" width="60" height="210" rx="2" fill="var(--accent-2,#a8380b)" opacity="0.85"/>
  <path d="M70 150 l60 -8 M70 158 l60 -8" stroke="var(--surface,#fbfaf6)" stroke-width="3"/>
  <text x="100" y="84" text-anchor="middle" font-size="10" font-weight="700" fill="var(--accent-2,#a8380b)">&#8776;840 ms</text>
  <text x="100" y="316" text-anchor="middle" font-size="10" fill="currentColor">GDS cold</text>
  <text x="100" y="329" text-anchor="middle" font-size="8.5" fill="currentColor" opacity="0.6">incl. projection</text>
  <!-- warm GDS bar: 6ms -->
  <rect x="170" y="266" width="60" height="34" rx="2" fill="var(--accent,#0a656d)"/>
  <text x="200" y="260" text-anchor="middle" font-size="10" font-weight="700" fill="var(--accent,#0a656d)">&#8776;6 ms</text>
  <text x="200" y="316" text-anchor="middle" font-size="10" fill="currentColor">GDS warm</text>
  <text x="200" y="329" text-anchor="middle" font-size="8.5" fill="currentColor" opacity="0.6">resident proj.</text>
  <!-- cypher bar: 22ms -->
  <rect x="270" y="174" width="60" height="126" rx="2" fill="var(--accent-3,#5b21b6)"/>
  <text x="300" y="168" text-anchor="middle" font-size="10" font-weight="700" fill="var(--accent-3,#5b21b6)">&#8776;22 ms</text>
  <text x="300" y="316" text-anchor="middle" font-size="10" fill="currentColor">Cypher</text>
  <text x="300" y="329" text-anchor="middle" font-size="8.5" fill="currentColor" opacity="0.6">live traversal</text>
  <!-- ===== RIGHT PANEL: amortized crossover ===== -->
  <text x="420" y="26" font-size="13" font-weight="700" fill="currentColor">Amortized cost vs reuse</text>
  <line x1="436" y1="70" x2="436" y2="300" stroke="currentColor" stroke-width="1.3" opacity="0.5"/>
  <line x1="436" y1="300" x2="740" y2="300" stroke="currentColor" stroke-width="1.3" opacity="0.5"/>
  <g font-size="9.5" fill="currentColor" opacity="0.6" text-anchor="middle">
    <text x="440" y="314">1</text>
    <text x="553" y="314">10</text>
    <text x="666" y="314">100</text>
  </g>
  <text x="588" y="329" font-size="9.5" fill="currentColor" opacity="0.6" text-anchor="middle">queries per projection (log N)</text>
  <!-- Cypher flat line at 22ms -->
  <line x1="440" y1="174" x2="740" y2="174" stroke="var(--accent-3,#5b21b6)" stroke-width="2.2"/>
  <text x="446" y="167" font-size="9.5" fill="var(--accent-3,#5b21b6)" font-weight="600">Cypher (flat)</text>
  <!-- GDS amortized decay curve -->
  <polyline points="587,70 598,72 607,104 621,145 635,174 655,205 686,233 720,249"
            fill="none" stroke="var(--accent,#0a656d)" stroke-width="2.2"/>
  <text x="700" y="242" font-size="9.5" fill="var(--accent,#0a656d)" font-weight="600" text-anchor="end">GDS amortized</text>
  <!-- crossover -->
  <line x1="635" y1="174" x2="635" y2="300" stroke="currentColor" stroke-width="1" stroke-dasharray="3 4" opacity="0.55"/>
  <circle cx="635" cy="174" r="4.5" fill="var(--surface,#fbfaf6)" stroke="currentColor" stroke-width="1.8"/>
  <text x="635" y="94" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">N* &#8776; 53</text>
  <text x="635" y="107" text-anchor="middle" font-size="9" fill="currentColor" opacity="0.7">crossover</text>
  <text x="500" y="288" text-anchor="middle" font-size="9" fill="var(--accent-3,#5b21b6)">&#8592; Cypher cheaper</text>
  <text x="695" y="288" text-anchor="middle" font-size="9" fill="var(--accent,#0a656d)">GDS cheaper &#8594;</text>
</svg>

Numbers like these are illustrative — the shape is what matters. `GDS cold` is dominated by the projection build, `GDS warm` is a raw in-memory algorithm run, and `Cypher` sits between them. Where your workload lands on the amortized curve decides everything.

## How It Works

Three details make the harness honest, and each maps to a line in the code:

- **Warm-up is separated from measurement.** The first 20 iterations run untimed. This lets the OS page cache load the working set, the Neo4j plan cache compile the query once, and the driver's Bolt serialization path settle. Without it, the first sample carries cold-start cost that has nothing to do with steady-state latency, and it lands disproportionately in p95.
- **The cold GDS sample wraps the full lifecycle.** `gds_cold_cycle` times `project` + `stream` + `drop` as one unit. This is the number a stateless request pays when it cannot reuse a projection, and it is the one dishonest benchmarks omit. Timing only `gds_stream` after a resident projection gives you the `GDS warm` number, which is real but only achievable if your architecture actually keeps the projection resident.
- **Cypher and warm GDS use identical reps and the same session.** Both collect `reps` samples over one pooled session so pool acquisition, network round-trip, and result draining are counted the same way for both. The comparison is only fair if the overhead outside the algorithm is held constant.

`percentile()` interpolates rather than picking a nearest rank, so p95 is stable even at modest sample counts. Reporting p50 *and* p95 together is deliberate: p50 tells you the typical cost, p95 tells you the tail that your SLO actually has to survive. A strategy with a great median and a terrible tail — common for cold GDS, where an occasional large projection stalls — looks fine on averages and fails in production. For the algorithmic reason GDS Dijkstra and the Cypher expansion can even be compared head to head, see [Routing Algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/routing-algorithms-python/).

## Common Failure Patterns

**1. Excluding projection cost.** The headline mistake. Timing `gds.shortestPath.dijkstra.stream` against a projection you built once, then presenting it as "GDS latency," compares a warm in-memory structure against Cypher's cold walk of the live graph. If your service is stateless and rebuilds the projection per request, the honest number is the full cycle:

```python
# WRONG for a stateless service — projection cost hidden
latency = await _time_call(gds_stream)          # 6 ms, but a lie if you re-project
# RIGHT — count what the request actually pays
latency = await _time_call(gds_cold_cycle)      # 840 ms, project + stream + drop
```

Report the number that matches your deployment. If you keep a resident projection, `gds_warm` is honest; if you do not, `gds_cold` is.

**2. Tiny, unrepresentative graphs.** A 50-node test graph makes both engines look instant and inverts the result: projection overhead dominates so Cypher "wins," and you conclude GDS is useless. On a real continental graph the algorithm cost grows and the projection amortizes across many queries, flipping the verdict. Benchmark on a graph whose node count, degree distribution, and query span match production, or the crossover point you measure is fiction.

**3. Ignoring page-cache and JIT warm-up.** The first query after a fresh connection pays for cache misses and query compilation. Fold that into your samples and p95 spikes for reasons unrelated to the algorithm:

```python
# Drop the warm-up loop and the first samples poison the tail
samples = [await _time_call(cypher_route) for _ in range(200)]  # sample 0 is cold
# Prime first, measure second (as bench() does)
for _ in range(20):
    await cypher_route()                                        # discarded
samples = [await _time_call(cypher_route) for _ in range(200)]
```

## Performance Notes

The amortized cost per query for GDS is the projection lifecycle spread across the queries it serves, plus the per-stream algorithm time; Cypher pays a flat per-query cost:

$$C_\text{GDS}(N) = \frac{T_\text{project} + T_\text{drop}}{N} + t_\text{stream}, \qquad C_\text{Cypher} = t_\text{cypher}$$

The crossover $N^{*}$ — the reuse count above which GDS is cheaper per query — is found by setting them equal:

$$N^{*} = \frac{T_\text{project} + T_\text{drop}}{t_\text{cypher} - t_\text{stream}}$$

With the illustrative numbers from the chart ($T_\text{project} + T_\text{drop} \approx 840$ ms, $t_\text{cypher} \approx 22$ ms, $t_\text{stream} \approx 6$ ms), $N^{*} \approx 840 / 16 \approx 53$. Serve fewer than ~53 queries per projection and live Cypher is the cheaper choice; serve more and GDS pulls ahead — the gap widening toward $t_\text{stream}$ as $N$ grows. Plug your own measured values into that formula and you have a defensible architecture decision instead of a vibe.

Budget the benchmark itself against wall time: 200 warm reps plus 20 cold cycles is a few seconds of Cypher and warm GDS but potentially minutes of cold cycles on a large graph, since each cold cycle rebuilds the projection. Keep `cold_reps` small and rely on the resident-projection samples for tight percentiles. The plan-cache and seek-versus-scan hygiene that keeps `t_cypher` stable across runs is covered in [cypher performance tuning](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/).

## Related

- [Neo4j GDS vs Custom Cypher Routing: When to Use Each](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/neo4j-gds-vs-cypher-routing/) — the decision this benchmark informs, with the full cost model and trade-offs.
- [Routing Algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/routing-algorithms-python/) — the Dijkstra and A\* internals both strategies execute.
- [Cypher Performance Tuning](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/) — keeping the live-traversal latency stable and index-backed across runs.

This guide supports [Neo4j GDS vs Custom Cypher Routing](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/neo4j-gds-vs-cypher-routing/), part of [Network Routing Algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/).

For authoritative reference, consult the [Neo4j Graph Data Science documentation](https://neo4j.com/docs/graph-data-science/current/).
