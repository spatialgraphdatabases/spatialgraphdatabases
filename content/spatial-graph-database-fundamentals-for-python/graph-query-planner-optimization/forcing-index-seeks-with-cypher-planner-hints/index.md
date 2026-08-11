---
pageTitle: Forcing Index Seeks with Hints
title: Forcing Index Seeks with Cypher Planner Hints
description: When and how to use USING INDEX, USING POINT INDEX, USING SCAN and USING JOIN hints to force a point-index seek on a spatial predicate, and why a hint is the last resort.
slug: forcing-index-seeks-with-cypher-planner-hints
type: article
breadcrumb: Cypher Planner Hints
datePublished: 2026-07-14
dateModified: 2026-07-14
---
# Forcing Index Seeks with Cypher Planner Hints

The symptom is narrow and infuriating: a proximity query that ran as a `PointIndexSeekByRange` in staging quietly regresses to a `NodeByLabelScan` in production, and p99 latency triples overnight. Nothing in the query text changed. What changed is the statistics the cost-based planner reads — a bulk load skewed the row estimates, or an index came online after the plan was already cached — and the optimizer now believes a full scan is cheaper than a seek it can no longer cost correctly. A `USING` hint pins the planner to the index, restoring the seek. This page shows how to apply `USING INDEX`, `USING POINT INDEX`, `USING SCAN`, and `USING JOIN` to a spatial predicate from async Python — and, more importantly, why reaching for a hint before you have fixed the predicate shape usually hides the real defect. If your query never seeked in the first place, start with [optimizing Cypher query plans for spatial data](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/optimizing-cypher-query-plans-for-spatial-data/); a hint cannot rescue a non-sargable predicate.

## Prerequisites & Versions

| Requirement | Minimum version | Note |
| --- | --- | --- |
| Python | 3.10+ | `list[str]` generics used in the plan walker |
| Neo4j | 5.9+ | Typed index hints (`USING POINT INDEX`, `USING RANGE INDEX`) land in the 5.x line |
| neo4j (driver) | 5.x | `AsyncGraphDatabase`, `result.consume()` profile access |
| A point index on the filtered property | n/a | `CREATE POINT INDEX ... ON (w.location)`, state `ONLINE` |

```bash
pip install "neo4j>=5.18"
```

A hint only names an index; it does not create one. Provision the point index first, and confirm the property is stored as a native `point` — the index and the CRS foundation are covered in [spatial indexing strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/).

## Implementation

The script below profiles a distance query twice against the same warehouse graph: once as the planner compiles it unaided, once with `USING POINT INDEX` forcing the seek. It walks the profile tree returned by `result.consume().profile`, reports the base operator of each plan, and asserts that the hint produced a seek rather than a scan.

```cypher
// One-time: the index the hint will name. Without an ONLINE point index,
// USING POINT INDEX raises a SyntaxError at plan time, not a silent fallback.
CREATE POINT INDEX warehouse_location IF NOT EXISTS
FOR (w:Warehouse) ON (w.location);
```

```python
import asyncio
from neo4j import AsyncGraphDatabase

# Same predicate, two plans. The hint sits between MATCH and WHERE and names
# the label/property pair the point index is built on.
UNHINTED = """
MATCH (w:Warehouse)
WHERE point.distance(w.location,
      point({srid: 4326, latitude: $lat, longitude: $lon})) <= $radius
RETURN w.id AS id ORDER BY w.id
"""

HINTED = """
MATCH (w:Warehouse)
USING POINT INDEX w:Warehouse(location)
WHERE point.distance(w.location,
      point({srid: 4326, latitude: $lat, longitude: $lon})) <= $radius
RETURN w.id AS id ORDER BY w.id
"""


def base_operators(plan: dict) -> list[str]:
    """Collect leaf operator types from a driver profile/plan tree."""
    leaves: list[str] = []

    def walk(node: dict) -> None:
        children = node.get("children", [])
        if not children:
            leaves.append(node.get("operatorType", "?"))
        for child in children:
            walk(child)

    walk(plan)
    return leaves


async def profile_base(session, query: str, **params) -> list[str]:
    result = await session.run(f"PROFILE {query}", **params)
    await result.consume()  # drain rows so the profile is populated
    summary = await result.consume()
    return base_operators(summary.profile)


async def main() -> None:
    driver = AsyncGraphDatabase.driver(
        "neo4j://localhost:7687",
        auth=("neo4j", "password"),
        max_connection_pool_size=20,
        connection_acquisition_timeout=5.0,
    )
    params = {"lat": 43.6532, "lon": -79.3832, "radius": 4000.0}
    try:
        async with driver.session(database="neo4j") as session:
            before = await profile_base(session, UNHINTED, **params)
            after = await profile_base(session, HINTED, **params)
            print("unhinted base:", before)
            print("hinted base:  ", after)
            assert any("IndexSeek" in op for op in after), (
                "hint failed to force a seek — predicate is not sargable"
            )
    finally:
        await driver.close()


if __name__ == "__main__":
    asyncio.run(main())
```

Run it against a graph whose statistics favour a scan and the first line prints `['NodeByLabelScan']` while the second prints a seek operator such as `['PointIndexSeekByRange']`. The assertion is the load-bearing part: a hint that is silently ignored leaves the base operator unchanged, and only a plan-shape check catches that.

<figure class="diagram">
<svg viewBox="0 0 760 470" role="img" aria-labelledby="hintTitle hintDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="hintTitle">Mis-planned label scan versus a hint-forced point-index seek</title>
  <desc id="hintDesc">Left: the planner's chosen plan reads NodeByLabelScan over every Warehouse and feeds a trailing Filter on point.distance, producing millions of DbHits. Right: after adding USING POINT INDEX between MATCH and WHERE, the base operator becomes PointIndexSeekByRange on the warehouse_location index, entering only the bounding region and producing sub-thousand DbHits. A callout marks where the hint clause sits in the query.</desc>
  <defs>
    <marker id="hintArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <rect class="viz-backdrop" x="0" y="0" width="760" height="470" fill="var(--viz-bg,#ffffff)"/>
  <line x1="380" y1="52" x2="380" y2="440" stroke="currentColor" stroke-width="1" stroke-dasharray="3 6" opacity="0.3"/>
  <!-- LEFT: planner's pick -->
  <text x="190" y="26" text-anchor="middle" font-size="14.5" font-weight="700" fill="currentColor">Planner's pick — stats favour a scan</text>
  <text x="190" y="44" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7">no hint · seek mis-costed after bulk load</text>
  <g fill="none" stroke="var(--accent-coral,#ff6b6b)" stroke-width="1.6">
    <rect x="58" y="60" width="264" height="56" rx="8" stroke-width="2.4"/>
    <rect x="58" y="160" width="264" height="56" rx="8"/>
  </g>
  <line x1="190" y1="116" x2="190" y2="158" stroke="currentColor" stroke-width="1.6" marker-end="url(#hintArrow)"/>
  <text x="190" y="84" text-anchor="middle" font-size="13.5" font-weight="700" fill="currentColor">NodeByLabelScan</text>
  <text x="190" y="102" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.72">(w:Warehouse) — every labeled node</text>
  <text x="190" y="184" text-anchor="middle" font-size="13.5" font-weight="700" fill="currentColor">Filter</text>
  <text x="190" y="202" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.72">point.distance(…) ≤ r, once per row</text>
  <rect x="58" y="262" width="264" height="50" rx="8" fill="var(--accent-coral,#ff6b6b)" opacity="0.14"/>
  <rect x="58" y="262" width="264" height="50" rx="8" fill="none" stroke="var(--accent-coral,#ff6b6b)" stroke-width="1.4"/>
  <text x="190" y="284" text-anchor="middle" font-size="12.5" font-weight="700" fill="currentColor">DbHits ≈ 10⁷ · rows = N</text>
  <text x="190" y="301" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.78">latency scales with label size</text>
  <!-- RIGHT: hint-forced -->
  <text x="570" y="26" text-anchor="middle" font-size="14.5" font-weight="700" fill="currentColor">Hint-forced — seek pinned</text>
  <text x="570" y="44" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7">USING POINT INDEX w:Warehouse(location)</text>
  <g fill="none" stroke="var(--accent,#0a656d)" stroke-width="1.6">
    <rect x="438" y="60" width="264" height="56" rx="8" stroke-width="2.4"/>
    <rect x="438" y="160" width="264" height="56" rx="8"/>
  </g>
  <line x1="570" y1="116" x2="570" y2="158" stroke="currentColor" stroke-width="1.6" marker-end="url(#hintArrow)"/>
  <text x="570" y="84" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">PointIndexSeekByRange</text>
  <text x="570" y="102" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.72">warehouse_location — bounding region</text>
  <text x="570" y="184" text-anchor="middle" font-size="13.5" font-weight="700" fill="currentColor">Filter</text>
  <text x="570" y="202" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.72">point.distance(…) clips box corners</text>
  <rect x="438" y="262" width="264" height="50" rx="8" fill="var(--accent,#0a656d)" opacity="0.14"/>
  <rect x="438" y="262" width="264" height="50" rx="8" fill="none" stroke="var(--accent,#0a656d)" stroke-width="1.4"/>
  <text x="570" y="284" text-anchor="middle" font-size="12.5" font-weight="700" fill="currentColor">DbHits ≈ 10³ · rows ≈ sN</text>
  <text x="570" y="301" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.78">latency scales with local density</text>
  <!-- hint callout -->
  <rect x="150" y="356" width="460" height="86" rx="10" fill="var(--surface-3,#f1ede2)" stroke="var(--accent,#0a656d)" stroke-width="1.4"/>
  <text x="380" y="380" text-anchor="middle" font-size="11.5" font-weight="700" fill="currentColor">the hint sits between MATCH and WHERE</text>
  <text x="380" y="404" text-anchor="middle" font-size="12" font-family="var(--font-mono,monospace)" fill="currentColor">MATCH (w:Warehouse)</text>
  <text x="380" y="422" text-anchor="middle" font-size="12" font-family="var(--font-mono,monospace)" fill="var(--accent,#0a656d)" font-weight="700">USING POINT INDEX w:Warehouse(location)</text>
  <text x="380" y="462" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.62">PROFILE operator order — data flows downward · same predicate, two plans</text>
</svg>

<figcaption>The identical distance predicate, compiled by the planner (left) and pinned by <code>USING POINT INDEX</code> (right). The hint only relocates the base operator from a scan to a seek — it changes nothing about the predicate itself.</figcaption>
</figure>

## How It Works

A hint is a directive to the planner, evaluated at compile time, that constrains which starting operator it may choose. Neo4j recognises four families, and each fits a different failure:

- **`USING INDEX w:Warehouse(location)`** tells the planner to enter through *an* index on that label/property. `USING POINT INDEX` and `USING RANGE INDEX` are the typed forms that additionally pin *which kind* of index — essential when a property carries both a point and a range index and the planner picks the wrong one for a spatial predicate.
- **`USING SCAN w:Warehouse`** does the opposite: it forbids the index and forces a label scan. That is the right hint when the predicate matches almost every node, so a seek's per-row index descent costs more than a straight scan would.
- **`USING JOIN ON w`** forces a hash join at a named variable instead of an expand. On a two-endpoint route query it lets the planner seek an index at *both* the origin and destination and join in the middle, rather than seeking one end and expanding the whole corridor.

The hint changes only the *shape* the planner is allowed to consider; it never changes what the predicate can express. That is the entire reason a hint is a last resort. A `point.distance(w.location, $p) <= r` predicate is sargable — the point index can seek a bounding region for it — so a hint sticks. But wrap the indexed property in arithmetic, and no hint in the language can force a seek, because the seekable form no longer exists in the query. Fix the predicate first; hint only when a correctly-shaped predicate still mis-plans because the *statistics* are wrong. The systematic before-and-after diffing that tells you which case you are in is covered in [reading EXPLAIN and PROFILE plans for spatial queries](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/reading-explain-and-profile-plans-for-spatial-queries/).

## Common Failure Patterns

**1. The hint is silently ignored because the predicate is not sargable.** Adding `USING POINT INDEX` to a query whose filter wraps the indexed property — `point.distance(w.location + $shift, $p)` or a `toString(w.location)` comparison — does nothing, because the planner has no seekable form to honour. Depending on version it either raises `Cannot use index hint ... no matching predicate` or degrades back to a scan. The fix is upstream of the hint: keep `w.location` bare on one side and move all math into the parameter.

```cypher
// Wrong — property is wrapped, hint cannot bind, plan falls back to a scan.
MATCH (w:Warehouse) USING POINT INDEX w:Warehouse(location)
WHERE point.distance(point({x: w.location.x + $dx, y: w.location.y}), $p) <= $r
// Right — bare property; precompute the shifted target in Python and pass $p.
MATCH (w:Warehouse) USING POINT INDEX w:Warehouse(location)
WHERE point.distance(w.location, $p) <= $r
```

**2. The hint pins a plan that was optimal only when the data was small.** A `USING INDEX` that made sense at ten thousand nodes can force a seek that touches most of the graph once the label grows and the predicate turns unselective — the seek's descent-per-row now costs more than the scan the planner *would* have chosen unaided. A pinned plan opts out of adaptive re-costing, so it never self-corrects. Re-profile hinted queries after any order-of-magnitude data growth and delete hints that no longer beat the unhinted plan.

<svg viewBox="0 0 780 288" role="img" aria-labelledby="hsTitle hsDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="hsTitle">A hint can only bind to a predicate the planner could already have seeked</title>
  <desc id="hsDesc">The same hint against two predicate shapes. When the indexed property is wrapped in an expression, the planner has no seekable form to bind the hint to, so depending on version it either raises a cannot-use-index-hint error or quietly falls back to a label scan — the hint is present and doing nothing. When the property is left bare on one side and all arithmetic is precomputed into the parameter, the hint binds and the plan is a point index seek. The hint never creates seekability; it only chooses between plans that were already available.</desc>
  <defs>
    <marker id="hs-a" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="288" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">USING POINT INDEX is a preference, not a capability</text>
  <rect x="24" y="42" width="732" height="94" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-poor,#a8320f)" stroke-width="1.8"/>
  <text x="44" y="66" font-size="11" font-weight="700" fill="var(--viz-poor,#a8320f)">property wrapped in an expression</text>
  <text x="44" y="86" font-size="10" font-family="var(--font-mono,monospace)" fill="var(--viz-ink-mute,#565f6d)">point.distance(point({x: w.location.x + $dx, y: w.location.y}), $p) &lt;= $r</text>
  <rect x="44" y="98" width="150" height="24" rx="12" fill="var(--viz-poor,#a8320f)"/>
  <text x="119" y="115" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-on-pill,#ffffff)">nothing to bind to</text>
  <line x1="200" y1="110" x2="240" y2="110" stroke="currentColor" stroke-width="1.5" marker-end="url(#hs-a)"/>
  <rect x="244" y="98" width="190" height="24" rx="12" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-poor,#a8320f)" stroke-width="1.4"/>
  <text x="339" y="115" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-poor,#a8320f)">error, or a silent fallback</text>
  <line x1="440" y1="110" x2="480" y2="110" stroke="currentColor" stroke-width="1.5" marker-end="url(#hs-a)"/>
  <rect x="484" y="98" width="180" height="24" rx="12" fill="var(--viz-poor,#a8320f)"/>
  <text x="574" y="115" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-on-pill,#ffffff)">NodeByLabelScan</text>
  <text x="676" y="115" font-size="10" fill="var(--viz-ink-mute,#565f6d)">hint present</text>
  <rect x="24" y="152" width="732" height="94" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="1.8"/>
  <text x="44" y="176" font-size="11" font-weight="700" fill="var(--viz-good,#0a656d)">property bare, arithmetic moved into the parameter</text>
  <text x="44" y="196" font-size="10" font-family="var(--font-mono,monospace)" fill="var(--viz-ink-mute,#565f6d)">point.distance(w.location, $p) &lt;= $r</text>
  <rect x="44" y="208" width="150" height="24" rx="12" fill="var(--viz-good,#0a656d)"/>
  <text x="119" y="225" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-on-pill,#ffffff)">seekable predicate</text>
  <line x1="200" y1="220" x2="240" y2="220" stroke="currentColor" stroke-width="1.5" marker-end="url(#hs-a)"/>
  <rect x="244" y="208" width="190" height="24" rx="12" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-good,#0a656d)" stroke-width="1.4"/>
  <text x="339" y="225" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-good,#0a656d)">hint binds</text>
  <line x1="440" y1="220" x2="480" y2="220" stroke="currentColor" stroke-width="1.5" marker-end="url(#hs-a)"/>
  <rect x="484" y="208" width="180" height="24" rx="12" fill="var(--viz-good,#0a656d)"/>
  <text x="574" y="225" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-on-pill,#ffffff)">PointIndexSeekByRange</text>
  <text x="676" y="225" font-size="10" fill="var(--viz-ink-mute,#565f6d)">hint honoured</text>
  <text x="24" y="276" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">The fix is always upstream of the hint. If the plan needs a hint to find a seek that the predicate cannot express, the hint is not the missing piece.</text>
</svg>

**3. Over-hinting freezes a plan the optimizer would improve.** Stacking `USING INDEX` on every `MATCH` plus a `USING JOIN` turns the planner into a stenographer: it stops exploring and simply transcribes your instructions, including the parts that a later engine upgrade would have planned better. Hint the single operator that is mis-chosen, verify with `PROFILE`, and leave the rest of the plan free.

## Performance Notes

The hint does not make the seek faster — it makes the planner *choose* the seek. The payoff is the selectivity gap between the two plans. Let $N$ be the labeled node count, $s$ the fraction inside the radius, $c_s$ the per-node scan cost, and $c_i$ the per-row index-descent cost:

$$
C_{\text{scan}} \approx N\,c_s \qquad
C_{\text{seek}} \approx \log_b N + sN\,c_i
$$

The seek wins whenever $sN\,c_i + \log_b N < N\,c_s$, i.e. roughly when $s < c_s / c_i$. For a few-kilometre radius over a city-scale graph $s \ll 1$ and the seek is dramatically cheaper — exactly the case where a mis-costing planner needs the hint. But note the crossover: once $s$ approaches $c_s/c_i$ the scan is genuinely cheaper, which is when `USING SCAN` becomes the correct hint rather than `USING POINT INDEX`. A hint is only ever right on the side of the crossover it pins you to, so measure $s$ for your real radius before committing one. Broader cache and configuration tuning around these plans lives in [Cypher performance tuning](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/).

## Related

- [Optimizing Cypher Query Plans for Spatial Data](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/optimizing-cypher-query-plans-for-spatial-data/) — reshape the predicate so it seeks without a hint at all.
- [Reading EXPLAIN and PROFILE Plans for Spatial Queries](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/reading-explain-and-profile-plans-for-spatial-queries/) — confirm the hint took effect and diff the operator tree.
- [Spatial Indexing Strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) — provision the point index a hint names.
- [Cypher Performance Tuning](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/) — cache, memory, and config around hinted spatial queries.

This guide is part of [Graph Query Planner Optimization](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/), within the [Spatial Graph Database Fundamentals for Python](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/) reference.
