---
pageTitle: Drive-Time Isochrones with GDS
title: Computing Drive-Time Isochrones with Neo4j GDS
description: A complete async Python pipeline that uses Neo4j GDS single-source Dijkstra over a travel-time-weighted projection to bucket every reachable node into drive-time bands.
slug: computing-drive-time-isochrones-with-neo4j-gds
type: article
breadcrumb: Drive-Time Isochrones
datePublished: 2026-07-14
dateModified: 2026-07-14
---
# Computing Drive-Time Isochrones with Neo4j GDS

You need the set of every location a depot can reach within 10, 20, and 30 minutes of driving, drawn as nested drive-time bands. The symptom that brings people here is an isochrone that looks reasonable but is measurably wrong: a motorway corridor shows up as slow, a dense grid of side streets shows up as fast, and the 20-minute band barely differs from the 10-minute one. The root cause is almost always the projection — the graph was weighted on segment length instead of travel time, so Dijkstra minimised kilometres when it should have minimised seconds. This page gives one complete, runnable async pipeline that projects a travel-time-weighted graph, runs a single GDS single-source Dijkstra from the origin, and buckets every reachable node into drive-time bands in one pass. It is the concrete build behind the broader [isochrone and service-area analysis](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/isochrone-and-service-area-analysis/) technique.

## Prerequisites & Versions

| Library / component | Min version | Install / note |
| --- | --- | --- |
| Python | 3.10+ | `list[dict]` and union syntax used below |
| Neo4j | 5.13+ | Native `point`, id lookup index on the origin |
| Neo4j GDS | 2.6+ | `gds.graph.project`, `gds.allShortestPaths.dijkstra` |
| neo4j (driver) | 5.x | `AsyncGraphDatabase`, async sessions |

```bash
pip install "neo4j>=5.18"
```

The graph must already store a travel-time cost on each edge — `travel_s` in the model below — kept distinct from geometric `length_m`. Deriving that per-segment time from OSM speed tags is upstream work covered under [node and edge spatial mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/); this page assumes it exists and is correct.

## Implementation

The pipeline is one coroutine. It projects a graph that reads `travel_s` as the relationship weight, runs a single Dijkstra from the origin, keeps every target whose cumulative time is under the largest band ceiling, and assigns each surviving node to its drive-time band. Band edges are 600, 1200, and 1800 seconds — 10, 20, and 30 minutes.

```python
import asyncio
from neo4j import AsyncGraphDatabase

BANDS_S = [600, 1200, 1800]  # 10 / 20 / 30 minutes, in seconds

PROJECT = """
CALL gds.graph.project(
    $graph,
    'RoadNode',
    { CONNECTED_TO: { properties: 'travel_s', orientation: 'NATURAL' } }
)
YIELD graphName, nodeCount, relationshipCount
RETURN nodeCount, relationshipCount
"""

# Single-source Dijkstra weighted on travel time, truncated at the outer band,
# with each reachable node bucketed into its drive-time band in the same pass.
ISOCHRONE = """
MATCH (src:RoadNode {id: $source_id})
CALL gds.allShortestPaths.dijkstra.stream($graph, {
    sourceNode: src,
    relationshipWeightProperty: 'travel_s'
})
YIELD targetNode, totalCost
WITH gds.util.asNode(targetNode) AS n, totalCost
WHERE totalCost <= $outer
RETURN n.id AS node_id,
       n.location.latitude  AS lat,
       n.location.longitude AS lon,
       totalCost AS seconds,
       CASE WHEN totalCost <= $b0 THEN 10
            WHEN totalCost <= $b1 THEN 20
            ELSE 30 END AS band_min
ORDER BY totalCost ASC
"""


async def drive_time_isochrone(driver, source_id: str,
                               graph: str = "iso_dt") -> dict[int, list[dict]]:
    b0, b1, outer = BANDS_S
    async with driver.session(database="neo4j") as session:
        await session.run("CALL gds.graph.drop($g, false) YIELD graphName", g=graph)
        await session.run(PROJECT, graph=graph)
        try:
            result = await session.run(
                ISOCHRONE, graph=graph, source_id=source_id,
                b0=b0, b1=b1, outer=outer,
            )
            bands: dict[int, list[dict]] = {10: [], 20: [], 30: []}
            async for record in result:
                row = record.data()
                bands[row["band_min"]].append(row)
            return bands
        finally:
            await session.run("CALL gds.graph.drop($g, false) YIELD graphName", g=graph)


async def main():
    driver = AsyncGraphDatabase.driver(
        "neo4j+s://your-cluster.databases.neo4j.io",
        auth=("neo4j", "secure-password"),
        max_connection_pool_size=32,
        connection_acquisition_timeout=5.0,
    )
    try:
        # Origin: a hub in central Amsterdam.
        bands = await drive_time_isochrone(driver, source_id="hub-ams-01")
        for minutes in (10, 20, 30):
            print(f"{minutes:>2} min band: {len(bands[minutes])} nodes")
    finally:
        await driver.close()


if __name__ == "__main__":
    asyncio.run(main())
```

<svg viewBox="0 0 760 384" role="img" aria-labelledby="dtTitle dtDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="dtTitle">Single-source Dijkstra bucketing reachable nodes into 10, 20, and 30 minute drive-time bands</title>
  <desc id="dtDesc">A source hub on the left fans out along weighted edges into three vertical drive-time band lanes. The first lane holds nodes reachable within ten minutes labelled with their cumulative travel time in seconds, the second lane holds nodes reachable within twenty minutes, and the third within thirty minutes. Each node carries its total cost from the source, and edges chain outward through the lanes showing that cost accumulates as the frontier expands.</desc>
  <defs>
    <marker id="dt-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <!-- band lanes -->
  <rect x="150" y="52" width="180" height="288" rx="10" fill="var(--accent,#0a656d)" opacity="0.08"/>
  <rect x="340" y="52" width="180" height="288" rx="10" fill="var(--accent-3,#5b21b6)" opacity="0.08"/>
  <rect x="530" y="52" width="200" height="288" rx="10" fill="var(--accent-4,#b58900)" opacity="0.08"/>
  <!-- lane header chips -->
  <rect x="185" y="26" width="110" height="22" rx="11" fill="var(--accent,#0a656d)"/>
  <text x="240" y="41" text-anchor="middle" font-size="11.5" font-weight="700" fill="#ffffff">&#8804; 10 min</text>
  <rect x="375" y="26" width="110" height="22" rx="11" fill="var(--accent-3,#5b21b6)"/>
  <text x="430" y="41" text-anchor="middle" font-size="11.5" font-weight="700" fill="#ffffff">&#8804; 20 min</text>
  <rect x="575" y="26" width="110" height="22" rx="11" fill="var(--accent-4,#b58900)"/>
  <text x="630" y="41" text-anchor="middle" font-size="11.5" font-weight="700" fill="#ffffff">&#8804; 30 min</text>
  <!-- source -->
  <circle cx="70" cy="196" r="18" fill="var(--accent-2,#a8380b)"/>
  <text x="70" y="193" text-anchor="middle" font-size="10" font-weight="700" fill="#ffffff">src</text>
  <text x="70" y="206" text-anchor="middle" font-size="8.5" fill="#ffffff">0 s</text>
  <!-- edges + nodes -->
  <g stroke="currentColor" stroke-width="1.4" fill="none" opacity="0.5">
    <path d="M88 188 L212 120" marker-end="url(#dt-arrow)"/>
    <path d="M88 196 L212 210" marker-end="url(#dt-arrow)"/>
    <path d="M88 204 L212 300" marker-end="url(#dt-arrow)"/>
    <path d="M258 120 L402 120" marker-end="url(#dt-arrow)"/>
    <path d="M258 210 L402 250" marker-end="url(#dt-arrow)"/>
    <path d="M258 300 L402 320" marker-end="url(#dt-arrow)"/>
    <path d="M448 120 L592 130" marker-end="url(#dt-arrow)"/>
    <path d="M448 250 L592 250" marker-end="url(#dt-arrow)"/>
  </g>
  <!-- 10-min nodes -->
  <g fill="var(--accent,#0a656d)">
    <circle cx="230" cy="120" r="12"/> <circle cx="230" cy="210" r="12"/> <circle cx="230" cy="300" r="12"/>
  </g>
  <g font-size="9" fill="#ffffff" text-anchor="middle" font-weight="700">
    <text x="230" y="123">372</text> <text x="230" y="213">255</text> <text x="230" y="303">540</text>
  </g>
  <!-- 20-min nodes -->
  <g fill="var(--accent-3,#5b21b6)">
    <circle cx="420" cy="120" r="12"/> <circle cx="420" cy="250" r="12"/> <circle cx="420" cy="320" r="12"/>
  </g>
  <g font-size="9" fill="#ffffff" text-anchor="middle" font-weight="700">
    <text x="420" y="123">910</text> <text x="420" y="253">844</text> <text x="420" y="323">1180</text>
  </g>
  <!-- 30-min nodes -->
  <g fill="var(--accent-4,#b58900)">
    <circle cx="610" cy="130" r="12"/> <circle cx="610" cy="250" r="12"/>
  </g>
  <g font-size="9" fill="#ffffff" text-anchor="middle" font-weight="700">
    <text x="610" y="133">1520</text> <text x="610" y="253">1705</text>
  </g>
  <text x="380" y="368" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.72">node labels are cumulative travel_s from the source — one Dijkstra assigns every node its band</text>
</svg>

## How It Works

Three mechanics carry the pipeline, and each maps to a line in the code.

- **Travel-time projection.** `gds.graph.project` copies the topology and the `travel_s` property into an in-memory graph. Passing `relationshipWeightProperty: 'travel_s'` to Dijkstra is what makes the search minimise *time*. If the projection listed `length_m` instead, the identical query would compute a distance isochrone and mislabel it as drive-time — this one property choice decides whether the whole result is correct.
- **Single-source Dijkstra.** `gds.allShortestPaths.dijkstra.stream` settles every reachable node exactly once, in ascending cost order, yielding a `totalCost` that is the cheapest cumulative travel time from the source. One call produces the cost-to-arrive for the entire reachable component; there is no per-node query.
- **In-pass bucketing with a bound.** The `WHERE totalCost <= $outer` predicate truncates the search at the 30-minute ceiling so nothing beyond the outer band is materialised, and the `CASE` expression tags each surviving node with the tightest band it falls in. The client then groups the flat stream into the three band lists. Because the bound and the bucketing both run server-side, the driver only ever receives nodes that belong in the answer.

`orientation: 'NATURAL'` preserves one-way streets. The direction of `CONNECTED_TO` is the direction of legal travel, so the projection must keep it; flipping to `UNDIRECTED` would let the frontier drive against traffic and inflate every band. The deeper mechanics of weighted single-source search — heap behaviour, settling order, and tie-breaking — are covered in [Weighted Dijkstra Routing with Neo4j GDS](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/routing-algorithms-python/weighted-dijkstra-routing-with-neo4j-gds/).

## Common Failure Patterns

**1. Projecting distance instead of travel time.** The defining bug. If `gds.graph.project` reads `length_m`, the bands measure kilometres and every band boundary is meaningless as a drive time. The tell is that motorways look no faster than surface streets. Fix the projection to read the time property, and assert it before trusting output.

```python
# WRONG — distance isochrone mislabelled as drive-time
{ "CONNECTED_TO": { "properties": "length_m" } }
# RIGHT — travel time drives the search
{ "CONNECTED_TO": { "properties": "travel_s", "orientation": "NATURAL" } }
```

**2. Unbounded traversal with no cost cap.** Dropping the `WHERE totalCost <= $outer` predicate does not just return extra rows — it makes GDS settle the entire reachable component and streams all of it to the client before anything is discarded, so a 30-minute request pays the cost of an all-pairs-from-source computation over the whole map. Always push the outer-band ceiling into the query.

```cypher
YIELD targetNode, totalCost
WITH gds.util.asNode(targetNode) AS n, totalCost
WHERE totalCost <= $outer   // truncate the frontier at the largest band — do not omit
```

**3. Disconnected components at the origin.** If the source node sits in a fragment that an ingestion gap severed from the main network, every band comes back nearly empty because the traversal exhausts its tiny component in a few hops. Verify connectivity at the origin before concluding the area is genuinely small:

```cypher
MATCH (src:RoadNode {id: $source_id})-[:CONNECTED_TO]-(nbr)
RETURN count(nbr) AS degree   // a degree of 0–1 at a supposed hub signals a topology break
```

## Performance Notes

Two costs dominate: building the projection and running the search. Project once and reuse the named graph across many origins and budgets — re-projecting per request is the most common latency regression here. For the search itself, a truncated single-source Dijkstra visits only the nodes inside the outer band, so its work grows with the *reachable* subgraph, not the whole network. On a sphere of radius $R$, the straight-line area a band can cover is bounded by

$$A \le \pi (v_{\max}\,t)^2$$

for a top speed $v_{\max}$ and time budget $t$, but real road-network reachability is a fraction of that disc because edges are sparse and indirect — which is exactly why a truncated traversal is cheap: the node count in a 30-minute band on an urban graph is typically thousands, not the millions in the full projection. Keep GDS `concurrency` matched to cores, size projection memory with `gds.graph.project.estimate` before loading a country-scale network, and pin the band ceilings to fixed tiers so the query text — and its plan — stays stable. When you need the polygon rather than the node set, the boundary step is client-side and independent of these budgets, as described in [isochrone and service-area analysis](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/isochrone-and-service-area-analysis/).

## Related

- [Isochrone and Service-Area Analysis](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/isochrone-and-service-area-analysis/) — the reachability concept, boundary hulls, and query variants this pipeline implements.
- [Weighted Dijkstra Routing with Neo4j GDS](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/routing-algorithms-python/weighted-dijkstra-routing-with-neo4j-gds/) — the single-source weighted search internals in detail.
- [Distance Filter Query Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/) — straight-line radius predicates, and why they are not drive-time bands.
- [Network Routing Algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/) — algorithm selection across Dijkstra, A\*, and contraction hierarchies.

This guide is part of [Isochrone and Service-Area Analysis](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/isochrone-and-service-area-analysis/), within the [Cypher Spatial Queries & Pathfinding Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/) pillar.

For authoritative reference, consult the [Neo4j GDS single-source shortest-path documentation](https://neo4j.com/docs/graph-data-science/current/algorithms/dijkstra-single-source/).
