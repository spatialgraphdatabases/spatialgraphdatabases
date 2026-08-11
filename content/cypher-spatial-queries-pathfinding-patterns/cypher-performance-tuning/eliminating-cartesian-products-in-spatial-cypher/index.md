---
pageTitle: Eliminating Cartesian Products
title: Eliminating Cartesian Products in Spatial Cypher
description: Spot accidental Cartesian products in spatial Cypher with PROFILE, then rewrite disconnected MATCH patterns into a pipelined, bounded join that stays fast
slug: eliminating-cartesian-products-in-spatial-cypher
type: article
breadcrumb: Eliminating Cartesian Products
datePublished: 2026-07-14
dateModified: 2026-07-14
---
# Eliminating Cartesian Products in Spatial Cypher

A dispatch query that ran in milliseconds against a seed graph suddenly takes forty seconds in production, and the query log shows one operator responsible: a `CartesianProduct` sitting between two `MATCH` clauses that were never connected. The symptom is a routing endpoint whose latency scales with the *product* of two node sets instead of their sum — a thousand depots crossed against five thousand stops is five million intermediate rows built before a single distance predicate runs. The root cause is almost always a comma-separated `MATCH` (or two standalone `MATCH` clauses) that share no relationship or join variable, so the planner has no choice but to pair every row on the left with every row on the right. This page resolves it: how to see the blow-up in `PROFILE`, and the three rewrites — connect the patterns, pipeline with `WITH`, or scope the second set with `OPTIONAL MATCH` — that turn an `O(N \times M)` cross-join back into a bounded traversal. It is a focused case of the discipline in [Cypher Performance Tuning](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/).

<svg viewBox="0 0 780 424" role="img" aria-labelledby="cpTitle cpDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="cpTitle">Comma MATCH Cartesian blow-up versus a WITH-pipelined bounded join</title>
  <desc id="cpDesc">Left: two disconnected MATCH clauses, one over 1,000 depots and one over 5,000 stops, feed a CartesianProduct operator that materializes 5,000,000 rows before any filter runs. Right: the same depots flow through a WITH pipeline into a connected SERVES expansion, so only the roughly 4,000 real depot-to-stop edges are ever built. Same inputs, two plan shapes.</desc>
  <defs>
    <marker id="cp-arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="424" fill="var(--viz-bg,#ffffff)"/>
  <line x1="390" y1="52" x2="390" y2="398" stroke="currentColor" stroke-width="1" stroke-dasharray="3 6" opacity="0.3"/>
  <!-- LEFT: cartesian -->
  <text x="195" y="26" text-anchor="middle" font-size="14.5" font-weight="700" fill="currentColor">Comma MATCH — Cartesian product</text>
  <text x="195" y="44" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7">disconnected patterns multiply</text>
  <rect x="34" y="64" width="150" height="54" rx="8" fill="var(--accent-coral,#ff6b6b)" opacity="0.12"/>
  <rect x="34" y="64" width="150" height="54" rx="8" fill="none" stroke="var(--accent-coral,#ff6b6b)" stroke-width="1.6"/>
  <text x="109" y="86" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">MATCH (d:Depot)</text>
  <text x="109" y="104" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.75">1,000 rows</text>
  <rect x="206" y="64" width="150" height="54" rx="8" fill="var(--accent-coral,#ff6b6b)" opacity="0.12"/>
  <rect x="206" y="64" width="150" height="54" rx="8" fill="none" stroke="var(--accent-coral,#ff6b6b)" stroke-width="1.6"/>
  <text x="281" y="86" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">MATCH (s:Stop)</text>
  <text x="281" y="104" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.75">5,000 rows</text>
  <line x1="109" y1="118" x2="165" y2="166" stroke="currentColor" stroke-width="1.6" marker-end="url(#cp-arr)"/>
  <line x1="281" y1="118" x2="225" y2="166" stroke="currentColor" stroke-width="1.6" marker-end="url(#cp-arr)"/>
  <rect x="95" y="168" width="200" height="48" rx="8" fill="none" stroke="var(--accent-coral,#ff6b6b)" stroke-width="2.2"/>
  <text x="195" y="197" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">CartesianProduct</text>
  <line x1="195" y1="216" x2="195" y2="258" stroke="currentColor" stroke-width="1.6" marker-end="url(#cp-arr)"/>
  <rect x="55" y="262" width="280" height="64" rx="8" fill="var(--accent-coral,#ff6b6b)" opacity="0.14"/>
  <rect x="55" y="262" width="280" height="64" rx="8" fill="none" stroke="var(--accent-coral,#ff6b6b)" stroke-width="1.6"/>
  <text x="195" y="290" text-anchor="middle" font-size="13.5" font-weight="700" fill="currentColor">1,000 × 5,000 = 5,000,000</text>
  <text x="195" y="310" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.78">rows built before any filter</text>
  <!-- RIGHT: pipelined -->
  <text x="585" y="26" text-anchor="middle" font-size="14.5" font-weight="700" fill="currentColor">Pipelined with WITH — bounded</text>
  <text x="585" y="44" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7">the relationship connects the patterns</text>
  <rect x="505" y="64" width="160" height="50" rx="8" fill="var(--accent,#0e7c86)" opacity="0.08"/>
  <rect x="505" y="64" width="160" height="50" rx="8" fill="none" stroke="var(--accent,#0e7c86)" stroke-width="1.6"/>
  <text x="585" y="84" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">MATCH (d:Depot)</text>
  <text x="585" y="102" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.75">1,000 rows</text>
  <line x1="585" y1="114" x2="585" y2="140" stroke="currentColor" stroke-width="1.6" marker-end="url(#cp-arr)"/>
  <rect x="525" y="142" width="120" height="38" rx="8" fill="none" stroke="var(--accent,#0e7c86)" stroke-width="1.6"/>
  <text x="585" y="166" text-anchor="middle" font-size="12.5" font-weight="700" fill="currentColor">WITH d</text>
  <line x1="585" y1="180" x2="585" y2="204" stroke="currentColor" stroke-width="1.6" marker-end="url(#cp-arr)"/>
  <rect x="465" y="206" width="240" height="50" rx="8" fill="none" stroke="var(--accent,#0e7c86)" stroke-width="1.6"/>
  <text x="585" y="228" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">(d)-[:SERVES]-&gt;(s)</text>
  <text x="585" y="246" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.75">expand only real edges</text>
  <line x1="585" y1="256" x2="585" y2="282" stroke="currentColor" stroke-width="1.6" marker-end="url(#cp-arr)"/>
  <rect x="505" y="284" width="160" height="52" rx="8" fill="var(--accent,#0e7c86)" opacity="0.14"/>
  <rect x="505" y="284" width="160" height="52" rx="8" fill="none" stroke="var(--accent,#0e7c86)" stroke-width="1.6"/>
  <text x="585" y="308" text-anchor="middle" font-size="13.5" font-weight="700" fill="currentColor">≈ 4,000 rows</text>
  <text x="585" y="326" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.78">one row per served stop</text>
  <text x="390" y="414" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.65">Same depots and stops — the Cartesian plan materializes five million rows to keep a few thousand.</text>
</svg>

## Prerequisites & Versions

The plan operators and syntax below are stable on Neo4j 5.x. The Python side uses the official async driver and reads the `PROFILE` tree straight off the result summary — no APOC, no GDS.

| Requirement | Minimum version | Note |
| --- | --- | --- |
| Python | 3.10+ | `async for`, union typing used in the script |
| Neo4j | 5.13+ | Native `point`, `CartesianProduct` named in the profile tree |
| neo4j (driver) | 5.x | `AsyncGraphDatabase`, `summary.profile` as a nested dict |

```bash
pip install "neo4j>=5.18"
```

The graph is a fleet model over Greater London: `:Depot` nodes each `:SERVES` a set of `:Stop` nodes, every node carrying a native `location` point. A point index on `Stop.location` backs the bounding box, so the correct query seeks rather than scans — the same index discipline covered in [distance filter query patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/).

## Implementation

The script below profiles the same intent — "for each depot, its stops inside a search box, with the depot-to-stop distance" — written two ways. The first uses a comma `MATCH` that forgets to connect depot to stop and pays a Cartesian product; the second pipelines through `WITH` and expands the `:SERVES` relationship. A small helper walks the profile tree, flags any `CartesianProduct` operator, and reports the widest row count so the blow-up is visible as a number, not a guess.

```python
import asyncio
from neo4j import AsyncGraphDatabase

# Accidental Cartesian: (d) and (s) share no relationship, so every depot
# is paired with every stop before the box filter or distance runs.
CROSS = """
PROFILE
MATCH (d:Depot), (s:Stop)
WHERE s.location.latitude  >= $min_lat AND s.location.latitude  <= $max_lat
  AND s.location.longitude >= $min_lon AND s.location.longitude <= $max_lon
RETURN d.id AS depot, s.id AS stop,
       point.distance(s.location, d.location) AS dist_m
"""

# Rewrite: WITH pipelines each depot, then the :SERVES expansion joins the
# patterns so only real depot-stop pairs are ever built.
JOINED = """
PROFILE
MATCH (d:Depot)
WITH d
MATCH (d)-[:SERVES]->(s:Stop)
WHERE s.location.latitude  >= $min_lat AND s.location.latitude  <= $max_lat
  AND s.location.longitude >= $min_lon AND s.location.longitude <= $max_lon
RETURN d.id AS depot, s.id AS stop,
       point.distance(s.location, d.location) AS dist_m
"""

PARAMS = {
    "min_lat": 51.470, "max_lat": 51.545,
    "min_lon": -0.170, "max_lon": -0.040,   # a box over central London
}


def walk(plan):
    """Depth-first walk over the nested PROFILE operator tree."""
    yield plan
    for child in plan.get("children", ()):
        yield from walk(child)


async def profile(session, cypher: str) -> dict:
    result = await session.run(cypher, **PARAMS)
    rows = [record async for record in result]        # drain before consume
    summary = await result.consume()
    plan = summary.profile
    has_cartesian = any(
        op.get("operatorType", "").startswith("CartesianProduct")
        for op in walk(plan)
    )
    widest = max((op.get("rows", 0) for op in walk(plan)), default=0)
    return {"rows_returned": len(rows), "widest_operator_rows": widest,
            "cartesian_product": has_cartesian}


async def main() -> None:
    driver = AsyncGraphDatabase.driver(
        "neo4j+s://your-cluster.databases.neo4j.io",
        auth=("neo4j", "secure-password"),
        connection_acquisition_timeout=5.0,
    )
    try:
        async with driver.session(database="neo4j") as session:
            cross = await profile(session, CROSS)
            joined = await profile(session, JOINED)
    finally:
        await driver.close()

    print(f"comma MATCH : {cross}")
    print(f"WITH join   : {joined}")
    assert not joined["cartesian_product"], "rewrite must not plan a CartesianProduct"


if __name__ == "__main__":
    asyncio.run(main())
```

Against a graph of a thousand depots and five thousand stops, `CROSS` reports `cartesian_product: True` and a `widest_operator_rows` in the millions, while `JOINED` reports `False` and a widest operator in the low thousands — the same rows returned, three orders of magnitude less work.

## How It Works

The planner builds a `CartesianProduct` whenever two pattern fragments in the same query part have no variable in common. In `MATCH (d:Depot), (s:Stop)` the depot and the stop are independent, so the only join the engine can form is the full cross-product, evaluated *before* the `WHERE` clause can prune anything. This is the trap: the bounding-box predicate you added to cut the result set runs on the far side of the blow-up, so it filters five million rows down to a few thousand instead of preventing the five million from ever being built.

The three rewrites all share one idea — give the planner a join key so it can pair rows selectively instead of exhaustively:

- **Connect the patterns.** The `JOINED` query replaces the comma with a `MATCH (d)-[:SERVES]->(s)` expansion. Now the second `MATCH` is anchored on `d`; the engine expands each depot's relationships and only visits the stops that depot actually serves. The `CartesianProduct` operator disappears from the plan entirely, replaced by an `Expand(All)` whose cardinality is bounded by average out-degree.
- **Pipeline with `WITH`.** The `WITH d` between the two `MATCH` clauses is not cosmetic — it establishes `d` as the driving row of the downstream expansion, so the planner streams one depot at a time rather than assembling both sets and joining them. `WITH` is the seam where you can also `ORDER BY`, `LIMIT`, or aggregate before the second pattern runs, shrinking the frontier further.
- **Scope the second set with `OPTIONAL MATCH`.** When a depot may legitimately have no in-box stop and you still want the depot row, `OPTIONAL MATCH (d)-[:SERVES]->(s:Stop) WHERE …` keeps the depot and yields `null` for the missing side — again anchored on `d`, so no cross-product forms. This preserves left-join semantics without falling back to the comma form.

Whether a legitimate all-pairs join is ever what you want is a real question: sometimes it is, for example scoring every candidate depot against every open order. In that case the cross-product is not accidental, but it should still be an index-probe rather than a raw scan of both labels — the technique in [index-probe spatial joins in Cypher](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/spatial-join-techniques/index-probe-spatial-joins-in-cypher/), where one side seeks the other's spatial index instead of materializing the full grid. The operator-ordering decisions behind all of this belong to [graph query planner optimization](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/).

## Common Failure Patterns

**1. The comma `MATCH` you didn't mean to write.** `MATCH (a:A), (b:B)` reads like "match A and B" but means "match every A paired with every B." Split the concerns and connect them through a relationship or a shared property.

```cypher
// Blows up: no shared variable between the two patterns
MATCH (d:Depot), (s:Stop) WHERE s.region = d.region RETURN d, s
// Fixed: join on the relationship, or pipeline the shared key
MATCH (d:Depot)-[:SERVES]->(s:Stop) RETURN d, s
```

Note that the `WHERE s.region = d.region` in the broken form does *not* save you — the equality is checked after the product is built, so the operator still materializes N×M rows first.

**2. A correlated subquery missing its join key.** A `CALL { … }` subquery that imports a variable but never uses it to constrain the inner pattern re-scans the whole inner label per outer row — a Cartesian product hiding inside the call.

```cypher
// Bug: d is imported but the inner MATCH is unconstrained by it
MATCH (d:Depot)
CALL (d) { MATCH (s:Stop) RETURN s LIMIT 3 }
RETURN d.id, s.id
// Fix: tie the inner pattern back to d
MATCH (d:Depot)
CALL (d) { WITH d MATCH (d)-[:SERVES]->(s:Stop) RETURN s LIMIT 3 }
RETURN d.id, s.id
```

**3. An `Eager` operator buffering the whole product.** When a downstream `DISTINCT`, aggregation, or write forces an `Eager` operator above a `CartesianProduct`, the entire N×M set is buffered in heap before the next stage runs — turning a slow query into an `OutOfMemoryError`. Spot the `Eager` in `PROFILE` directly above the product; the cure is the same as for the product itself, since removing the cross-join removes the rows the `Eager` has to hold.

<svg viewBox="0 0 780 350" role="img" aria-labelledby="csqTitle csqDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="csqTitle">A Cartesian product hiding inside a CALL subquery</title>
  <desc id="csqDesc">Above: a subquery that imports the outer depot variable but never uses it to constrain the inner pattern. Each of the 1,000 outer rows drives a full scan of all 5,000 stops, so the engine reads 5,000,000 stops to return 3,000 rows. Below: the same subquery with the imported variable bound into the inner pattern. Each outer row expands only its own SERVES relationships, so the engine reads about 4,000 stops for the same answer.</desc>
  <defs>
    <marker id="csq-a" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="350" fill="var(--viz-bg,#ffffff)"/>
  <!-- ===== broken ===== -->
  <text x="24" y="26" font-size="13.5" font-weight="700" fill="var(--viz-poor,#a8320f)">Imported but unused — the inner MATCH is free</text>
  <rect x="24" y="40" width="150" height="52" rx="8" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <text x="99" y="62" text-anchor="middle" font-size="11.5" font-weight="700" fill="currentColor">MATCH (d:Depot)</text>
  <text x="99" y="79" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">1,000 outer rows</text>
  <line x1="174" y1="66" x2="236" y2="66" stroke="currentColor" stroke-width="1.6" marker-end="url(#csq-a)"/>
  <text x="205" y="58" text-anchor="middle" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">per row</text>
  <rect x="238" y="34" width="238" height="64" rx="8" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-poor,#a8320f)" stroke-width="2"/>
  <text x="357" y="56" text-anchor="middle" font-size="11.5" font-weight="700" fill="currentColor">CALL (d) { MATCH (s:Stop) … }</text>
  <text x="357" y="73" text-anchor="middle" font-size="10" fill="var(--viz-poor,#a8320f)" font-weight="600">d is never mentioned inside</text>
  <text x="357" y="89" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">full :Stop scan, 5,000 rows, every time</text>
  <line x1="476" y1="66" x2="538" y2="66" stroke="currentColor" stroke-width="1.6" marker-end="url(#csq-a)"/>
  <rect x="540" y="40" width="216" height="52" rx="8" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-poor,#a8320f)" stroke-width="1.6"/>
  <text x="648" y="62" text-anchor="middle" font-size="12" font-weight="700" fill="var(--viz-poor,#a8320f)">5,000,000 stops read</text>
  <text x="648" y="79" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">to return 3,000 rows</text>
  <!-- work bar, broken -->
  <text x="24" y="126" font-size="10.5" font-weight="700" fill="currentColor">work</text>
  <rect x="70" y="115" width="686" height="14" rx="7" fill="var(--viz-poor,#a8320f)"/>
  <line x1="24" y1="158" x2="756" y2="158" stroke="var(--line,#e5e0d2)" stroke-width="1" stroke-dasharray="3 6"/>
  <!-- ===== fixed ===== -->
  <text x="24" y="192" font-size="13.5" font-weight="700" fill="var(--viz-good,#0a656d)">Bound into the pattern — the inner MATCH is anchored</text>
  <rect x="24" y="206" width="150" height="52" rx="8" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <text x="99" y="228" text-anchor="middle" font-size="11.5" font-weight="700" fill="currentColor">MATCH (d:Depot)</text>
  <text x="99" y="245" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">1,000 outer rows</text>
  <line x1="174" y1="232" x2="236" y2="232" stroke="currentColor" stroke-width="1.6" marker-end="url(#csq-a)"/>
  <text x="205" y="224" text-anchor="middle" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">per row</text>
  <rect x="238" y="200" width="238" height="64" rx="8" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="2"/>
  <text x="357" y="222" text-anchor="middle" font-size="11.5" font-weight="700" fill="currentColor">CALL (d) { WITH d</text>
  <text x="357" y="238" text-anchor="middle" font-size="11.5" font-weight="700" fill="currentColor">MATCH (d)-[:SERVES]-&gt;(s) }</text>
  <text x="357" y="255" text-anchor="middle" font-size="10" fill="var(--viz-good,#0a656d)" font-weight="600">expansion from d, ~4 rows</text>
  <line x1="476" y1="232" x2="538" y2="232" stroke="currentColor" stroke-width="1.6" marker-end="url(#csq-a)"/>
  <rect x="540" y="206" width="216" height="52" rx="8" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-good,#0a656d)" stroke-width="1.6"/>
  <text x="648" y="228" text-anchor="middle" font-size="12" font-weight="700" fill="var(--viz-good,#0a656d)">~4,000 stops read</text>
  <text x="648" y="245" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">for the same answer</text>
  <text x="24" y="292" font-size="10.5" font-weight="700" fill="currentColor">work</text>
  <rect x="70" y="281" width="6" height="14" rx="3" fill="var(--viz-good,#0a656d)"/>
  <text x="24" y="326" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">The import list makes a variable visible inside the call. Only a pattern that mentions it makes the call selective.</text>
</svg>

## Performance Notes

A cross-join and a connected expansion differ not by a constant factor but by their growth law. For left and right sets of size $|A|$ and $|B|$, and an average out-degree $\bar{d}$ on the connecting relationship:

$$R_{\times} = |A|\cdot|B| \qquad\text{versus}\qquad R_{\bowtie} = |A|\cdot\bar{d}$$

With $|A|=10^3$, $|B|=5\times10^3$, and $\bar{d}\approx 4$, that is five million intermediate rows against four thousand — and because the product is built before the filter, heap and CPU both track $R_{\times}$, not the size of the final result. The lever is structural: connect the patterns so the planner joins on a key. Confirm it the same way the rest of [Cypher Performance Tuning](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/) does — run `PROFILE`, read bottom-up, and treat any `CartesianProduct` on a query that should be a traversal as a defect to fix before it ships, not a latency figure to tune around. In CI, assert the plan is free of `CartesianProduct` for hot queries; a refactor that reintroduces the comma form changes only latency, so a correctness test alone will not catch it.

## Related

- [Distance Filter Query Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/) — bounding the candidate set with an index-seekable predicate before any join runs.
- [Index-Probe Spatial Joins in Cypher](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/spatial-join-techniques/index-probe-spatial-joins-in-cypher/) — when an all-pairs correlation is intended, probe the index instead of building the grid.
- [Keeping Spatial Queries in the Plan Cache](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/keeping-spatial-queries-in-the-plan-cache/) — the sibling tuning concern of plan reuse and parameterization.
- [Graph Query Planner Optimization](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/) — reading operator order and forcing the join shape you want.

This guide is part of [Cypher Performance Tuning](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/), one of the workflows in [Cypher Spatial Queries & Pathfinding Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/).

For authoritative reference, consult the [Neo4j Cypher Manual](https://neo4j.com/docs/cypher-manual/current/) and its [Execution Plan Operators](https://neo4j.com/docs/cypher-manual/current/planning-and-tuning/operators/) documentation.
