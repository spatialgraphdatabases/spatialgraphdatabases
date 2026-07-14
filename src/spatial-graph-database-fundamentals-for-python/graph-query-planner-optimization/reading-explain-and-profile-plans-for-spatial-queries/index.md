---
pageTitle: Reading EXPLAIN & PROFILE Plans
title: Reading EXPLAIN and PROFILE Plans for Spatial Queries
description: A practical guide to reading Neo4j operator trees for spatial and routing queries — the operators that matter, what DbHits and rows mean, and how to find the widest operator.
slug: reading-explain-and-profile-plans-for-spatial-queries
type: article
breadcrumb: Reading EXPLAIN & PROFILE
datePublished: 2026-07-14
dateModified: 2026-07-14
---
# Reading EXPLAIN and PROFILE Plans for Spatial Queries

A spatial query that returns forty rows can still read forty million. The gap between what a routing query *returns* and what it *touches* is invisible in the result set and glaring in the operator tree — and if you cannot read that tree, every tuning decision is a guess. The specific trap for spatial workloads is a proximity or path query whose widest operator sits three levels below the row you actually wanted: a `NodeByLabelScan` that fed a `CartesianProduct`, an `Expand(All)` that fanned out before the distance `Filter` clipped it. This page is a field guide to reading those trees — which operators matter for spatial and routing queries, what `DbHits`, `Rows`, and estimated rows each tell you, and how to locate the one operator that is doing all the work. Once you can name the widest operator you can decide whether it needs a reshaped predicate or, as a last resort, [forcing index seeks with Cypher planner hints](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/forcing-index-seeks-with-cypher-planner-hints/).

## Prerequisites & Versions

| Requirement | Minimum version | Note |
| --- | --- | --- |
| Python | 3.10+ | `dict`/`list` generics in the plan walker |
| Neo4j | 5.x | Operator names below match the 5.x runtime |
| neo4j (driver) | 5.x | `result.consume()` exposes `.plan` (EXPLAIN) and `.profile` (PROFILE) |
| pytest / pytest-asyncio | 0.23+ | For the plan-shape assertion |

```bash
pip install "neo4j>=5.18" "pytest>=8.0" "pytest-asyncio>=0.23"
```

`EXPLAIN` compiles the query and returns the plan with *estimated* rows but never runs it — cheap, safe on production, and correct for asserting plan shape in CI. `PROFILE` executes the query and annotates every operator with *actual* `Rows` and `DbHits`. Use `EXPLAIN` to catch a regression before it ships; use `PROFILE` to explain one that already did.

## Implementation

The driver exposes the plan as a nested dict on the result summary: `summary.plan` for `EXPLAIN`, `summary.profile` for `PROFILE`. Each node carries an `operatorType`, a `children` list, and — for a profiled plan — `dbHits`, `rows`, and an `args` map holding `EstimatedRows`. The code below profiles a proximity-plus-expansion query, walks the tree, and reports the widest operator by actual rows. The pytest case then asserts the base operator is a seek, so a refactor that reintroduces a scan fails in CI.

```python
import asyncio
from neo4j import AsyncGraphDatabase

# Nearest transit stops that link onward to a station, within a radius.
QUERY = """
MATCH (s:TransitStop)
WHERE point.distance(s.location,
      point({srid: 4326, latitude: $lat, longitude: $lon})) <= $radius
MATCH (s)-[:LINKS]->(station:Station)
RETURN station.name AS name, count(*) AS links
ORDER BY links DESC
"""


def flatten(plan: dict) -> list[dict]:
    """Depth-first list of operator nodes from a driver plan/profile tree."""
    out: list[dict] = [plan]
    for child in plan.get("children", []):
        out.extend(flatten(child))
    return out


def widest_operator(profile: dict) -> dict:
    """The operator whose actual row count is largest — the row-explosion point."""
    return max(flatten(profile), key=lambda n: n.get("rows", 0))


async def main() -> None:
    driver = AsyncGraphDatabase.driver(
        "neo4j://localhost:7687",
        auth=("neo4j", "password"),
        max_connection_pool_size=20,
        connection_acquisition_timeout=5.0,
    )
    params = {"lat": 37.7749, "lon": -122.4194, "radius": 3000.0}
    try:
        async with driver.session(database="neo4j") as session:
            result = await session.run(f"PROFILE {QUERY}", **params)
            _ = [row async for row in result]      # drain so counters fill
            summary = await result.consume()
            profile = summary.profile
            for op in flatten(profile):
                print(f"{op['operatorType']:<28} "
                      f"rows={op.get('rows'):>10} "
                      f"dbHits={op.get('dbHits'):>10} "
                      f"est={op.get('args', {}).get('EstimatedRows', '?')}")
            hot = widest_operator(profile)
            print(f"\nwidest operator: {hot['operatorType']} @ {hot.get('rows')} rows")
    finally:
        await driver.close()


if __name__ == "__main__":
    asyncio.run(main())
```

```python
import pytest
from neo4j import AsyncGraphDatabase


@pytest.mark.asyncio
async def test_plan_enters_on_a_seek():
    driver = AsyncGraphDatabase.driver("bolt://localhost:7687", auth=("neo4j", "test"))
    query = """
    MATCH (s:TransitStop)
    WHERE point.distance(s.location,
          point({srid: 4326, latitude: 37.7749, longitude: -122.4194})) <= 3000.0
    RETURN s.id
    """
    async with driver.session(database="neo4j") as session:
        result = await session.run(f"EXPLAIN {query}")
        summary = await result.consume()          # no rows for EXPLAIN
        ops = {n["operatorType"] for n in flatten(summary.plan)}
    await driver.close()
    assert any("IndexSeek" in op for op in ops), f"expected a seek, got {ops}"
    assert "NodeByLabelScan" not in ops, "predicate regressed to a full label scan"
```

## How It Works

Read the tree **bottom-up**. The driver prints the root — usually `ProduceResults` — first, but execution starts at the leaves and flows upward, so the base operators are where data enters and where a scan-versus-seek decision is made. The operators that decide spatial-query cost are a short list:

- **`NodeByLabelScan`** reads every node of a label. As a base operator under a spatial predicate it is almost always the defect: the point index was not seeked.
- **`PointIndexSeekByRange`** (and `NodeIndexSeekByRange`) is the healthy base — the index descended to a bounding region and returned only candidates. This is what you want feeding the rest of the tree.
- **`Expand(All)`** walks relationships from each incoming row. Its output rows are the input rows times the average out-degree, so it is the most common row-explosion point in routing queries. `Expand(Into)` is the cheaper cousin used when both endpoints are already bound.
- **`Filter`** applies a predicate to rows already produced. A `point.distance()` filter sitting above a scan means the distance math ran once per node in the label — the exact cost the index was meant to avoid.
- **`CartesianProduct`** multiplies two row streams. Two disconnected `MATCH` clauses produce it, and it turns two thousand-row inputs into two million rows; on a spatial join it is a silent latency bomb.
- **`EagerAggregation`** materialises all input to compute a `count`, `collect`, or `ORDER BY`. It is a memory checkpoint — a wide input here is what fills the heap before the final `LIMIT` ever runs.

Three numbers annotate each operator, and reading them in the right order is the whole skill. **`Rows`** is the actual output count — trace it upward and the operator where it jumps by orders of magnitude is your row explosion. **`DbHits`** is the count of storage-engine accesses; it is the truest proxy for work, and an operator can be cheap in rows but expensive in `DbHits` if it probes properties per row. **`EstimatedRows`** is what the planner *predicted* from statistics — compare it against actual `Rows`, and a large divergence means the planner is costing blind, which is the root cause behind most mis-plans that a hint has to correct.

<figure class="diagram">
<svg viewBox="0 0 720 486" role="img" aria-labelledby="treeTitle treeDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="treeTitle">A PROFILE operator tree read bottom-up, marking the row-explosion operator</title>
  <desc id="treeDesc">An operator tree drawn as stacked boxes. At the bottom, PointIndexSeekByRange returns 180 rows. Above it, Expand(All) walks LINKS relationships and its row count jumps to 42,000 — this box is highlighted as the widest operator and the row-explosion point. Above that, Filter drops to 610 rows, EagerAggregation collapses to 40 rows, and ProduceResults returns 40. An upward arrow on the left labels the bottom-up reading direction; a callout points at the Expand box as where rows explode.</desc>
  <defs>
    <marker id="treeArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <!-- reading-direction spine -->
  <line x1="40" y1="430" x2="40" y2="70" stroke="currentColor" stroke-width="1.6" marker-end="url(#treeArrow)" opacity="0.55"/>
  <text x="30" y="250" font-size="11" fill="currentColor" opacity="0.7" transform="rotate(-90 30 250)" text-anchor="middle">read bottom-up · execution flows this way</text>
  <!-- column header -->
  <text x="300" y="34" text-anchor="middle" font-size="14.5" font-weight="700" fill="currentColor">PROFILE operator tree</text>
  <text x="300" y="52" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7">rows and DbHits per operator</text>
  <!-- box 5: ProduceResults (top) -->
  <rect x="150" y="66" width="300" height="52" rx="8" fill="none" stroke="currentColor" stroke-width="1.6" opacity="0.6"/>
  <text x="170" y="90" font-size="13" font-weight="700" fill="currentColor">ProduceResults</text>
  <text x="430" y="90" text-anchor="end" font-size="11" fill="currentColor" opacity="0.8">rows 40</text>
  <text x="430" y="106" text-anchor="end" font-size="10" fill="currentColor" opacity="0.6">DbHits 0</text>
  <!-- box 4: EagerAggregation -->
  <rect x="150" y="142" width="300" height="52" rx="8" fill="none" stroke="var(--accent-3,#5b21b6)" stroke-width="1.6"/>
  <text x="170" y="166" font-size="13" font-weight="700" fill="currentColor">EagerAggregation</text>
  <text x="170" y="182" font-size="10" fill="currentColor" opacity="0.6">count(*) — materialises input</text>
  <text x="430" y="166" text-anchor="end" font-size="11" fill="currentColor" opacity="0.8">rows 40</text>
  <text x="430" y="182" text-anchor="end" font-size="10" fill="currentColor" opacity="0.6">DbHits 0</text>
  <!-- box 3: Filter -->
  <rect x="150" y="218" width="300" height="52" rx="8" fill="none" stroke="currentColor" stroke-width="1.4" opacity="0.7"/>
  <text x="170" y="242" font-size="13" font-weight="700" fill="currentColor">Filter</text>
  <text x="170" y="258" font-size="10" fill="currentColor" opacity="0.6">station.tier = $t</text>
  <text x="430" y="242" text-anchor="end" font-size="11" fill="currentColor" opacity="0.8">rows 610</text>
  <text x="430" y="258" text-anchor="end" font-size="10" fill="currentColor" opacity="0.6">DbHits 42,000</text>
  <!-- box 2: Expand(All) — WIDEST -->
  <rect x="150" y="294" width="300" height="58" rx="8" fill="var(--accent-coral,#ff6b6b)" opacity="0.14"/>
  <rect x="150" y="294" width="300" height="58" rx="8" fill="none" stroke="var(--accent-coral,#ff6b6b)" stroke-width="2.6"/>
  <text x="170" y="318" font-size="13" font-weight="700" fill="currentColor">Expand(All)</text>
  <text x="170" y="336" font-size="10" fill="currentColor" opacity="0.7">(s)-[:LINKS]-&gt;(station)</text>
  <text x="430" y="318" text-anchor="end" font-size="12" font-weight="700" fill="currentColor">rows 42,000</text>
  <text x="430" y="336" text-anchor="end" font-size="10" fill="currentColor" opacity="0.7">DbHits 84,000</text>
  <!-- box 1: PointIndexSeekByRange (base) -->
  <rect x="150" y="376" width="300" height="58" rx="8" fill="var(--accent,#0a656d)" opacity="0.12"/>
  <rect x="150" y="376" width="300" height="58" rx="8" fill="none" stroke="var(--accent,#0a656d)" stroke-width="2.2"/>
  <text x="170" y="400" font-size="12.5" font-weight="700" fill="currentColor">PointIndexSeekByRange</text>
  <text x="170" y="418" font-size="10" fill="currentColor" opacity="0.7">stop_location — bounding region</text>
  <text x="430" y="400" text-anchor="end" font-size="11" fill="currentColor" opacity="0.85">rows 180</text>
  <text x="430" y="418" text-anchor="end" font-size="10" fill="currentColor" opacity="0.7">DbHits 540</text>
  <!-- vertical connectors -->
  <g stroke="currentColor" stroke-width="1.5" opacity="0.7">
    <line x1="300" y1="376" x2="300" y2="354" marker-end="url(#treeArrow)"/>
    <line x1="300" y1="294" x2="300" y2="272" marker-end="url(#treeArrow)"/>
    <line x1="300" y1="218" x2="300" y2="196" marker-end="url(#treeArrow)"/>
    <line x1="300" y1="142" x2="300" y2="120" marker-end="url(#treeArrow)"/>
  </g>
  <!-- callout on the explosion -->
  <path d="M556 323 H460" stroke="var(--accent-coral,#ff6b6b)" stroke-width="1.6" fill="none" marker-end="url(#treeArrow)"/>
  <text x="560" y="316" font-size="11" font-weight="700" fill="var(--accent-coral,#ff6b6b)">widest operator</text>
  <text x="560" y="332" font-size="10" fill="currentColor" opacity="0.75">rows jump 180 → 42k</text>
  <text x="560" y="346" font-size="10" fill="currentColor" opacity="0.75">fan-out before Filter</text>
  <text x="360" y="470" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.62">the seek is healthy; the Expand fan-out — not the base — is where this query spends its budget</text>
</svg>
<figcaption>The base operator is a clean seek, yet the query is expensive because <code>Expand(All)</code> fans 180 rows out to 42,000 before the <code>Filter</code> clips them. Reading bottom-up and tracking where <code>Rows</code> jumps points you at the real cost, not the base.</figcaption>
</figure>

## Common Failure Patterns

**1. Reading top-down and blaming the wrong operator.** The driver prints `ProduceResults` first, so it is tempting to read the tree like a call stack and assume the top matters most. It does not — the top usually shows your final row count, which is small by definition. Reconstruct the tree bottom-up (the `flatten` helper preserves child order) and follow `Rows` upward until it jumps. In the diagram above the base seek is fine and the `Expand(All)` is the culprit; a top-down read would have you tuning the aggregation that returns forty rows.

**2. Trusting estimated rows over actual rows.** `EXPLAIN` shows only `EstimatedRows`, and on a graph with stale statistics those estimates can be off by orders of magnitude — which is precisely why the planner mis-chose. Never conclude a query is fine because its *estimated* plan looks cheap. Run `PROFILE` and compare `EstimatedRows` against actual `Rows` operator by operator; the operator with the widest divergence is where the planner is costing blind, and it is the first place to refresh statistics or reshape the predicate. This estimate-versus-actual gap is the same signal that decides whether a query needs [optimizing its plan](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/optimizing-cypher-query-plans-for-spatial-data/) or is genuinely as good as it gets.

**3. Ignoring DbHits when rows look reasonable.** An operator can output few rows while hammering storage — a `Filter` that reads three properties per row shows modest `Rows` but `DbHits` several times higher, and a `Projection` that calls `point.distance()` per row is invisible in the row count entirely. When latency is high but no operator shows a row explosion, sort the operators by `DbHits` instead; the work is hiding in per-row property access, not fan-out.

## Performance Notes

There is no formula for reading a plan, only a loop, and it has a fixed budget: capture `PROFILE`, flatten the tree, sort by `Rows` to find the fan-out and by `DbHits` to find the property-access cost, act on the single widest operator, and re-profile. Bound the work by treating the base operator as the gate — if it is a `NodeByLabelScan` under a spatial predicate, fix that before looking anywhere else, because everything above it inherits its row count. A rough sanity check on any spatial plan: the base operator's `Rows` should be near the count of nodes genuinely inside your search region, not the label total; if it equals the label total, the seek never happened. That widest-operator loop is the same discipline formalised in [Cypher performance tuning](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/), and when the diagnosis is a correctly-shaped predicate that still mis-plans, it hands off to [forcing index seeks with Cypher planner hints](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/forcing-index-seeks-with-cypher-planner-hints/).

## Related

- [Forcing Index Seeks with Cypher Planner Hints](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/forcing-index-seeks-with-cypher-planner-hints/) — what to do once the tree proves the planner chose wrong.
- [Optimizing Cypher Query Plans for Spatial Data](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/optimizing-cypher-query-plans-for-spatial-data/) — reshape the predicate the plan revealed as unbounded.
- [Cypher Performance Tuning](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/) — the full capture-diagnose-reprofile loop.
- [Spatial Indexing Strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) — the index the base seek should be reading.

This guide is part of [Graph Query Planner Optimization](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/), within the [Spatial Graph Database Fundamentals for Python](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/) reference.
