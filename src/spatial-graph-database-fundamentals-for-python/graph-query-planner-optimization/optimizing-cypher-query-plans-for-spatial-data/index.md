---
pageTitle: Cypher Query Plans for Spatial Data
---
# Optimizing Cypher Query Plans for Spatial Data

Logistics routing engines and mobility analytics platforms routinely see p99 latency blow out when a spatial proximity filter sits in the same `MATCH` clause as a relationship expansion. The exact symptom is a `PROFILE` operator tree where a `NodeByLabelScan` feeds straight into `Expand(All)`, with the `point.distance()` predicate demoted to a trailing `Filter`. The root cause is the cost-based optimizer refusing to anchor the spatial index when a distance function wraps a `point` property, so every candidate node is materialized before the radius constraint runs. This page resolves that by splitting the query into a deterministic two-phase plan — index-anchored spatial lookup first, traversal second — and shows the async Python that drives it. It is the planner-level counterpart to the index design covered in [spatial indexing strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/).

<figure class="diagram">
<svg viewBox="0 0 760 478" role="img" aria-labelledby="planTitle planDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="planTitle">Eager versus isolated Cypher operator trees for a spatial proximity query</title>
  <desc id="planDesc">Left: the eager plan reads NodeByLabelScan into Expand(All) into a trailing Filter on point.distance, materializing every node and producing millions of DbHits. Right: the isolated plan reads NodeIndexSeekByRange on hub_location_idx, crosses a WITH planner barrier, then runs Expand(Into) on only the qualifying hubs, producing sub-500 DbHits.</desc>
  <defs>
    <marker id="planArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <line x1="380" y1="44" x2="380" y2="448" stroke="currentColor" stroke-width="1" stroke-dasharray="3 6" opacity="0.3"/>
  <!-- LEFT: eager plan -->
  <text x="190" y="26" text-anchor="middle" font-size="14.5" font-weight="700" fill="currentColor">Eager plan — predicate post-filtered</text>
  <text x="190" y="44" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7">single MATCH, distance wraps the point property</text>
  <g fill="none" stroke="var(--accent-coral,#ff6b6b)" stroke-width="1.6">
    <rect x="60" y="56" width="260" height="56" rx="8"/>
    <rect x="60" y="156" width="260" height="56" rx="8"/>
    <rect x="60" y="256" width="260" height="56" rx="8" stroke-width="2.4"/>
  </g>
  <line x1="190" y1="112" x2="190" y2="154" stroke="currentColor" stroke-width="1.6" marker-end="url(#planArrow)"/>
  <line x1="190" y1="212" x2="190" y2="254" stroke="currentColor" stroke-width="1.6" marker-end="url(#planArrow)"/>
  <text x="190" y="80" text-anchor="middle" font-size="13.5" font-weight="700" fill="currentColor">NodeByLabelScan</text>
  <text x="190" y="98" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.72">(h:LogisticsHub) — every labeled node</text>
  <text x="190" y="180" text-anchor="middle" font-size="13.5" font-weight="700" fill="currentColor">Expand(All)</text>
  <text x="190" y="198" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.72">walks :SERVES from each candidate</text>
  <text x="190" y="280" text-anchor="middle" font-size="13.5" font-weight="700" fill="currentColor">Filter</text>
  <text x="190" y="298" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.72">point.distance(…) ≤ r runs last</text>
  <rect x="60" y="368" width="260" height="48" rx="8" fill="var(--accent-coral,#ff6b6b)" opacity="0.14"/>
  <rect x="60" y="368" width="260" height="48" rx="8" fill="none" stroke="var(--accent-coral,#ff6b6b)" stroke-width="1.4"/>
  <text x="190" y="389" text-anchor="middle" font-size="12.5" font-weight="700" fill="currentColor">millions of DbHits</text>
  <text x="190" y="406" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.78">cost ≈ 10⁴ · scales with N</text>
  <!-- RIGHT: isolated plan -->
  <text x="570" y="26" text-anchor="middle" font-size="14.5" font-weight="700" fill="currentColor">Isolated plan — index-anchored seek</text>
  <text x="570" y="44" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7">spatial lookup split behind a WITH barrier</text>
  <g fill="none" stroke="var(--accent,#0e7c86)" stroke-width="1.6">
    <rect x="440" y="56" width="260" height="56" rx="8" stroke-width="2.4"/>
    <rect x="440" y="156" width="260" height="56" rx="8" stroke-dasharray="6 4"/>
    <rect x="440" y="256" width="260" height="56" rx="8"/>
  </g>
  <line x1="570" y1="112" x2="570" y2="154" stroke="currentColor" stroke-width="1.6" marker-end="url(#planArrow)"/>
  <line x1="570" y1="212" x2="570" y2="254" stroke="currentColor" stroke-width="1.6" marker-end="url(#planArrow)"/>
  <text x="570" y="80" text-anchor="middle" font-size="13.5" font-weight="700" fill="currentColor">NodeIndexSeekByRange</text>
  <text x="570" y="98" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.72">hub_location_idx — hubs inside radius</text>
  <text x="570" y="180" text-anchor="middle" font-size="13.5" font-weight="700" fill="currentColor">WITH hub</text>
  <text x="570" y="198" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.72">eager planner barrier · row set resolved</text>
  <text x="570" y="280" text-anchor="middle" font-size="13.5" font-weight="700" fill="currentColor">Expand(Into)</text>
  <text x="570" y="298" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.72">:SERVES on qualifying hubs only</text>
  <rect x="440" y="368" width="260" height="48" rx="8" fill="var(--accent,#0e7c86)" opacity="0.14"/>
  <rect x="440" y="368" width="260" height="48" rx="8" fill="none" stroke="var(--accent,#0e7c86)" stroke-width="1.4"/>
  <text x="570" y="389" text-anchor="middle" font-size="12.5" font-weight="700" fill="currentColor">sub-500 DbHits</text>
  <text x="570" y="406" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.78">cost ≈ log N + sN · scales with density</text>
  <text x="380" y="468" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.62">PROFILE operator order — data flows downward · same query, two plan shapes</text>
</svg>
<figcaption>The same proximity query compiled two ways: the eager plan defers <code>point.distance()</code> to a trailing <code>Filter</code> over every node, while the <code>WITH</code> barrier forces an index seek that materializes only hubs inside the radius.</figcaption>
</figure>

## Prerequisites & Versions

| Library / Component | Min version | Install / provision |
| --- | --- | --- |
| Python | 3.10 | `pyenv install 3.10` (needs `tuple[str, str]` syntax) |
| `neo4j` async driver | 5.14 | `pip install "neo4j>=5.14"` |
| Neo4j server | 5.x | point index requires the 5.x range-index engine |
| A point index on the filtered property | n/a | `CREATE INDEX ... FOR (h:LogisticsHub) ON (h.location)` |

The point index is non-negotiable: without an `ONLINE` index on the property you filter, the planner has nothing to seek against and will fall back to a scan regardless of how the query is shaped.

## Implementation

The script below is self-contained: it provisions the index, then runs the isolated two-phase query through the async driver. Reuse a single `SpatialRoutingEngine` per process so the connection pool is shared across requests.

```cypher
// Run once during migration. The planner can only seek a property
// that carries an ONLINE point index.
CREATE INDEX hub_location_idx IF NOT EXISTS
FOR (h:LogisticsHub) ON (h.location);
```

```python
import asyncio
from neo4j import AsyncGraphDatabase
from neo4j.spatial import WGS84Point


class SpatialRoutingEngine:
    """Two-phase spatial routing queries with a shared async pool."""

    def __init__(self, uri: str, auth: tuple[str, str], pool_size: int = 20):
        self.driver = AsyncGraphDatabase.driver(
            uri,
            auth=auth,
            max_connection_pool_size=pool_size,
            connection_acquisition_timeout=10.0,
            max_transaction_retry_time=15.0,
        )

    async def ensure_index(self) -> None:
        async with self.driver.session() as session:
            await session.run(
                "CREATE INDEX hub_location_idx IF NOT EXISTS "
                "FOR (h:LogisticsHub) ON (h.location)"
            )
            # Block until the index finishes building before the first query.
            await session.run("CALL db.awaitIndexes(300)")

    async def find_service_zones(self, lat: float, lon: float, radius_m: float):
        # WGS84Point takes positional (x, y) = (longitude, latitude). The driver
        # serialises it directly over Bolt — no string parsing on the server.
        target = WGS84Point((lon, lat))

        # Phase 1 isolates the spatial seek behind a WITH boundary;
        # phase 2 expands only the qualifying hubs.
        query = """
        MATCH (hub:LogisticsHub)
        WHERE point.distance(hub.location, $target) <= $radius
        WITH hub
        MATCH (hub)-[:SERVES]->(zone:DeliveryZone)
        RETURN zone.id AS zone_id, zone.name AS zone_name,
               count(*) AS route_count
        ORDER BY route_count DESC
        """

        async def _tx_func(tx):
            result = await tx.run(query, target=target, radius=radius_m)
            return await result.data()

        async with self.driver.session() as session:
            return await session.execute_read(_tx_func)

    async def close(self) -> None:
        await self.driver.close()


async def main():
    engine = SpatialRoutingEngine(
        "neo4j://localhost:7687", ("neo4j", "password")
    )
    try:
        await engine.ensure_index()
        zones = await engine.find_service_zones(52.5200, 13.4050, 5000.0)
        for row in zones:
            print(row)
    finally:
        await engine.close()


if __name__ == "__main__":
    asyncio.run(main())
```

## How It Works

The whole optimization hinges on the `WITH hub` boundary and the order of the two `MATCH` clauses — read the query against the operator tree it produces.

- **The `WITH` clause is a planner barrier.** It forces the spatial predicate to resolve to a complete row set before traversal begins. Instead of `NodeByLabelScan -> Expand -> Filter`, the planner emits `NodeIndexSeekByRange` against `hub_location_idx`, materializing only hubs inside the radius before the `SERVES` expansion runs. This is the same predicate-pushdown discipline that the [distance filter query patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/) cluster applies at the pattern level.
- **`WGS84Point((lon, lat))` keeps the CRS aligned.** The driver serializes the point as native Bolt structure, so the server-side index — also WGS-84 — compares like with like. A mismatched or stringified coordinate triggers a runtime conversion that silently disables the seek.
- **`point.distance()` stays a great-circle (geodesic) measure** on WGS-84 points, returning meters. The seek narrows candidates by bounding region; the exact distance still runs, but only on the reduced set the index handed back.
- **`db.awaitIndexes` gates the first query.** Querying before the index is `ONLINE` makes the planner choose a scan and cache that plan — a cold-start trap covered under failure patterns below.

For a deterministic SLA you can pin the plan with a hint:

```cypher
MATCH (hub:LogisticsHub)
USING INDEX hub:LogisticsHub(location)
WHERE point.distance(hub.location, $target) <= $radius
WITH hub
MATCH (hub)-[:SERVES]->(zone:DeliveryZone)
RETURN zone.id, count(*) AS route_count
```

`USING INDEX` anchors the execution plan explicitly and prevents the planner reverting to a scan after a statistics refresh — at the cost of disabling adaptive planning for that query.

## Common Failure Patterns

**1. The predicate is still post-filtered despite the `WITH`.** If `PROFILE` shows a `Filter` on `point.distance()` after a label scan, the property is not indexed or the parameter CRS does not match the index. Confirm both, then re-profile:

```cypher
SHOW INDEXES YIELD name, type, state, properties
WHERE 'location' IN properties;   // expect type RANGE/POINT, state ONLINE
```

**2. Arithmetic or a function wraps the indexed property.** Writing `WHERE point.distance(hub.location + $offset, $target) <= r` (or any expression on `hub.location`) makes the property non-sargable, so the seek is lost. Keep the indexed property bare on one side and move all math into the parameter you pass from Python.

**3. A stale plan from a cold start.** A query compiled before the index came `ONLINE` is cached as a scan and reused. Force a recompile after index changes:

```cypher
CALL db.clearQueryCaches();
```

## Performance Notes

A typical eager plan on a metropolitan graph exhibits cost in the tens of thousands with millions of `DbHits`; the isolated plan drops to the sub-500 range, with hits scaling against index density rather than total node count. The mechanism is selectivity. Let $N$ be the labeled node count, $s$ the fraction inside the search radius, $r$ the radius, $A_{\text{idx}}$ the indexed extent, $c_d$ the per-node distance cost, and $\bar{d}$ the mean out-degree:

$$
C_{\text{eager}} \approx N\,(c_d + \bar{d}) \qquad
C_{\text{isolated}} \approx \log_b N + sN\,(c_d + \bar{d}), \quad
s \approx \frac{\pi r^2}{A_{\text{idx}}}
$$

The isolated plan wins whenever $s \ll 1$ — the normal case for a few-kilometre radius over a city-scale graph. Two budget caveats:

- **Memory at the `WITH` boundary.** Materializing the qualifying hubs allocates heap proportional to $sN$. When a wide radius pulls in thousands of nodes, that intermediate set can trigger GC pauses; constrain it with a tighter radius or a tenant boundary, as in [node and edge spatial mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/), before the seek runs.
- **When to switch strategies.** Past roughly $s > 0.3$ the seek's selectivity advantage erodes and a bounding-box pre-filter or geohash bucketing becomes cheaper — the trade-off quantified in [implementing geohash vs quadtree indexing in Neo4j](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/implementing-geohash-vs-quadtree-indexing-in-neo4j/). Broader query-cache and config tuning lives in [Cypher performance tuning](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/).

Validate every change by diffing `EXPLAIN`/`PROFILE` output before and after: confirm the `NodeByLabelScan` became a `NodeIndexSeekByRange` and that `DbHits` fell by an order of magnitude.

## Related

- [Spatial Indexing Strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) — choose and provision the index this plan seeks against
- [Distance Filter Query Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/) — pattern-level pushdown that complements planner tuning
- [Cypher Performance Tuning](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/) — config, cache, and memory tuning around these queries
- [K-Nearest Neighbor Routing](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/k-nearest-neighbor-routing/) — a two-phase consumer of index-anchored spatial lookups

This guide is part of [Graph Query Planner Optimization](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/), within the [Spatial Graph Database Fundamentals for Python](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/) reference.
