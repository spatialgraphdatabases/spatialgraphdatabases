---
pageTitle: GDS kNN vs Bounded-Radius kNN
title: GDS kNN vs Bounded-Radius kNN in Neo4j
description: When to use the GDS kNN similarity graph versus an exact bounded-radius index seek for nearest-node lookups in Neo4j, with runnable async Python for both
slug: gds-knn-vs-bounded-radius-knn-in-neo4j
type: article
breadcrumb: GDS kNN vs Bounded Radius
datePublished: 2026-07-14
dateModified: 2026-07-14
---
# GDS kNN vs Bounded-Radius kNN in Neo4j

Two Neo4j features answer to the name "kNN" and they are not interchangeable. `gds.knn` builds an *approximate* k-nearest-neighbor graph over node **properties**, comparing every node to a sampled set of others and writing a resident neighbor relationship for each — a batch operation designed to precompute "who is similar to whom" across the whole graph at once. A bounded-radius kNN is the opposite shape: an *exact*, per-query index seek that answers "who is nearest to this one origin, right now" by clipping a bounding box to a radius. Reach for the wrong one and you either pay a full-graph similarity build to answer a single live lookup, or you feed geographic coordinates into a similarity metric that ranks by the wrong geometry and returns plausible-looking nonsense. This page runs both against the same depot graph, shows where each belongs, and catalogues the traps that make `gds.knn` quietly wrong for spatial data. It is one technique inside [K-Nearest-Neighbor Routing](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/k-nearest-neighbor-routing/).

<svg viewBox="0 0 900 420" role="img" aria-labelledby="gk-title gk-desc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="gk-title">Batch GDS kNN similarity-graph precompute versus a per-query bounded-radius seek</title>
  <desc id="gk-desc">Left panel: GDS kNN runs once in a batch job over all depot nodes, comparing node coordinate properties and writing a resident NEAR relationship from every node to its k approximate neighbours, producing a precomputed similarity graph that is reused but goes stale on writes. Right panel: a bounded-radius kNN runs per query from a single origin, seeking a coordinate bounding box on the point index and clipping it with point.distance to return the exact nearest nodes at query time with no stored edges.</desc>
  <defs>
    <marker id="gk-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="var(--accent,#0a656d)"/></marker>
    <marker id="gk-near" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="var(--accent-3,#5b21b6)"/></marker>
  </defs>
  <line x1="450" y1="44" x2="450" y2="400" stroke="var(--line,#e5e0d2)" stroke-width="1" stroke-dasharray="3 6"/>
  <!-- LEFT: batch GDS knn -->
  <text x="215" y="28" text-anchor="middle" font-size="14.5" font-weight="700" fill="var(--accent-3,#5b21b6)">GDS kNN — batch precompute</text>
  <text x="215" y="46" text-anchor="middle" font-size="11" fill="var(--ink-soft,#455062)">approximate · property similarity · resident graph</text>
  <!-- similarity graph: nodes with NEAR edges -->
  <g stroke="var(--accent-3,#5b21b6)" stroke-width="1.4" opacity="0.6">
    <line x1="130" y1="120" x2="220" y2="150" marker-end="url(#gk-near)"/>
    <line x1="220" y1="150" x2="150" y2="220" marker-end="url(#gk-near)"/>
    <line x1="220" y1="150" x2="320" y2="180" marker-end="url(#gk-near)"/>
    <line x1="320" y1="180" x2="300" y2="270" marker-end="url(#gk-near)"/>
    <line x1="150" y1="220" x2="230" y2="285" marker-end="url(#gk-near)"/>
    <line x1="300" y1="270" x2="230" y2="285" marker-end="url(#gk-near)"/>
    <line x1="130" y1="120" x2="150" y2="220" marker-end="url(#gk-near)"/>
  </g>
  <g fill="var(--surface-2,#fff)" stroke="var(--accent-3,#5b21b6)" stroke-width="2">
    <circle cx="130" cy="120" r="10"/><circle cx="220" cy="150" r="10"/><circle cx="320" cy="180" r="10"/>
    <circle cx="150" cy="220" r="10"/><circle cx="300" cy="270" r="10"/><circle cx="230" cy="285" r="10"/>
  </g>
  <text x="215" y="332" text-anchor="middle" font-size="11" fill="var(--ink-soft,#455062)">every node → its k neighbours (NEAR)</text>
  <rect x="95" y="350" width="240" height="42" rx="8" fill="var(--accent-3,#5b21b6)" opacity="0.1"/>
  <text x="215" y="368" text-anchor="middle" font-size="11" font-weight="700" fill="var(--accent-3,#5b21b6)">built once, reused</text>
  <text x="215" y="384" text-anchor="middle" font-size="10.5" fill="var(--ink-soft,#455062)">stale on every write</text>
  <!-- RIGHT: per-query bounded seek -->
  <text x="685" y="28" text-anchor="middle" font-size="14.5" font-weight="700" fill="var(--accent,#0a656d)">Bounded-radius kNN — per query</text>
  <text x="685" y="46" text-anchor="middle" font-size="11" fill="var(--ink-soft,#455062)">exact · point index seek · no stored edges</text>
  <!-- box + circle + origin -->
  <rect x="560" y="120" width="200" height="170" rx="3" fill="var(--accent,#0a656d)" opacity="0.06" stroke="var(--accent,#0a656d)" stroke-width="1.6" stroke-dasharray="6 4"/>
  <circle cx="660" cy="205" r="85" fill="none" stroke="var(--accent,#0a656d)" stroke-width="1.6"/>
  <g fill="var(--accent,#0a656d)">
    <circle cx="620" cy="185" r="5"/><circle cx="700" cy="230" r="5"/><circle cx="655" cy="150" r="5"/><circle cx="690" cy="180" r="5"/>
  </g>
  <g fill="none" stroke="var(--accent-2,#a8380b)" stroke-width="1.6">
    <circle cx="575" cy="135" r="5"/><circle cx="745" cy="275" r="5"/>
  </g>
  <g fill="none" stroke="var(--line-strong,#cdc6b3)" stroke-width="1.4" opacity="0.7">
    <circle cx="520" cy="300" r="5"/><circle cx="790" cy="130" r="5"/>
  </g>
  <circle cx="660" cy="205" r="8" fill="var(--accent,#0a656d)"/>
  <line x1="660" y1="205" x2="745" y2="205" stroke="var(--accent,#0a656d)" stroke-width="1.4" stroke-dasharray="4 3"/>
  <text x="705" y="199" text-anchor="middle" font-size="11" fill="var(--accent,#0a656d)">r</text>
  <text x="685" y="332" text-anchor="middle" font-size="11" fill="var(--ink-soft,#455062)">one origin → exact nearest, now</text>
  <rect x="565" y="350" width="240" height="42" rx="8" fill="var(--accent,#0a656d)" opacity="0.08"/>
  <text x="685" y="368" text-anchor="middle" font-size="11" font-weight="700" fill="var(--accent,#0a656d)">computed on demand</text>
  <text x="685" y="384" text-anchor="middle" font-size="10.5" fill="var(--ink-soft,#455062)">always current</text>
</svg>

## Prerequisites & Versions

The bounded-radius half needs only a native point index; the GDS half needs the Graph Data Science library and a numeric coordinate property to compare. Both run through the async driver.

| Requirement | Minimum version | Note |
| --- | --- | --- |
| Python | 3.10+ | `dict[str, float]` and structural typing used below |
| Neo4j | 5.13+ | Native `point`, `CREATE POINT INDEX`, index-backed range predicates |
| neo4j (driver) | 5.x | `AsyncGraphDatabase`, async sessions |
| Graph Data Science | 2.5+ | `gds.knn.write`, node-property projection aggregation |

```bash
pip install "neo4j>=5.18"
```

Each depot node carries a native `point` on `location` (what the exact seek filters, per sound [node and edge spatial mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/)) **and** a plain `coord: [latitude, longitude]` float list, because `gds.knn` compares numeric properties, not `point` values. Back `location` with the right [spatial indexing strategy](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) or the exact seek degrades to a scan.

```cypher
CREATE POINT INDEX depot_location IF NOT EXISTS
FOR (d:Depot) ON (d.location);
// (:Depot {depot_id, location: point({srid:4326, latitude, longitude}), coord: [latitude, longitude]})
```

## Implementation

The script below runs both strategies against the same depot set around Amsterdam. `precompute_knn_graph` is the batch path: it projects coordinates, runs `gds.knn` once, and writes a `NEAR` edge per node so later lookups are a cheap relationship read. `nearest_bounded` is the live path: box seek plus `point.distance()`, exact, no stored state.

```python
import asyncio
import math
from neo4j import AsyncGraphDatabase

EARTH_RADIUS_M = 6_371_000.0


def bounding_box(lat: float, lon: float, radius_m: float) -> dict[str, float]:
    """Degree-space box for the point-index pre-filter; longitude widens via cos(phi)."""
    d_lat = math.degrees(radius_m / EARTH_RADIUS_M)
    d_lon = math.degrees(radius_m / (EARTH_RADIUS_M * math.cos(math.radians(lat))))
    return {"min_lat": lat - d_lat, "max_lat": lat + d_lat,
            "min_lon": lon - d_lon, "max_lon": lon + d_lon}


class KNNComparison:
    def __init__(self, uri: str, auth: tuple[str, str]) -> None:
        self.driver = AsyncGraphDatabase.driver(
            uri, auth=auth,
            max_connection_pool_size=40,
            connection_acquisition_timeout=5.0,
        )

    async def precompute_knn_graph(self, top_k: int = 5) -> int:
        """BATCH: build an approximate similarity graph over ALL depots, once."""
        async with self.driver.session(database="neo4j") as s:
            await s.run("""
            CALL gds.graph.exists('depot-knn') YIELD exists
            WITH exists WHERE exists
            CALL gds.graph.drop('depot-knn') YIELD graphName RETURN graphName
            """)
            await s.run("""
            MATCH (d:Depot)
            WITH gds.graph.project('depot-knn', d, null,
                 {sourceNodeProperties: d {.coord}, targetNodeProperties: {}}) AS g
            RETURN g.graphName AS name
            """)
            rec = await (await s.run("""
            CALL gds.knn.write('depot-knn', {
                nodeProperties: {coord: 'EUCLIDEAN'},
                topK: $k,
                sampleRate: 1.0,
                deltaThreshold: 0.0,
                randomSeed: 42,
                concurrency: 1,
                writeRelationshipType: 'NEAR',
                writeProperty: 'similarity'
            })
            YIELD relationshipsWritten
            RETURN relationshipsWritten AS n
            """, k=top_k)).single()
            return rec["n"]

    async def nearest_precomputed(self, depot_id: int, k: int = 5) -> list[dict]:
        """BATCH read: neighbours already materialised by gds.knn."""
        async with self.driver.session(database="neo4j") as s:
            result = await s.run("""
            MATCH (o:Depot {depot_id: $depot_id})-[r:NEAR]->(n:Depot)
            RETURN n.depot_id AS depot_id, r.similarity AS similarity
            ORDER BY r.similarity DESC
            LIMIT $k
            """, depot_id=depot_id, k=k)
            return [rec.data() async for rec in result]

    async def nearest_bounded(self, lat: float, lon: float,
                              radius_m: float, k: int = 5) -> list[dict]:
        """LIVE: exact per-query kNN via point-index box seek + distance clip."""
        box = bounding_box(lat, lon, radius_m)
        async with self.driver.session(database="neo4j") as s:
            result = await s.run("""
            WITH point({srid:4326, latitude:$lat, longitude:$lon}) AS target
            MATCH (d:Depot)
            WHERE d.location.latitude  >= $min_lat AND d.location.latitude  <= $max_lat
              AND d.location.longitude >= $min_lon AND d.location.longitude <= $max_lon
            WITH d, point.distance(d.location, target) AS metres
            WHERE metres <= $radius
            RETURN d.depot_id AS depot_id, metres
            ORDER BY metres ASC
            LIMIT $k
            """, lat=lat, lon=lon, radius=radius_m, k=k, **box)
            return [rec.data() async for rec in result]

    async def close(self) -> None:
        await self.driver.close()


async def main() -> None:
    svc = KNNComparison("neo4j+s://your-cluster.databases.neo4j.io",
                        auth=("neo4j", "secure-password"))
    try:
        written = await svc.precompute_knn_graph(top_k=5)
        print(f"batch: wrote {written} NEAR edges")
        batch = await svc.nearest_precomputed(depot_id=101, k=5)
        print("precomputed neighbours:", [d["depot_id"] for d in batch])
        live = await svc.nearest_bounded(52.3676, 4.9041, radius_m=15_000, k=5)
        print("exact bounded:", [(d["depot_id"], round(d["metres"])) for d in live])
    finally:
        await svc.close()


if __name__ == "__main__":
    asyncio.run(main())
```

## How It Works

The two methods diverge on three axes — *when* the work runs, *what geometry* it measures, and *how exact* the answer is.

- **Batch versus per-query.** `precompute_knn_graph` compares nodes to each other in one pass and persists a `NEAR` edge per node, so a later `nearest_precomputed` is a single-hop relationship read — microseconds, no distance math. But the build touches the whole graph, so it belongs in a scheduled job, not a request handler. `nearest_bounded` inverts that: nothing is stored, each call seeks the point index for one origin and returns exact metres. It is the same box-then-clip primitive detailed under [distance filter query patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/), just capped with `ORDER BY … LIMIT k`.
- **Similarity versus distance.** `gds.knn` does not know what a coordinate is. It reads the `coord` list and applies whatever metric you name — here `EUCLIDEAN`, which scores neighbours by `1 / (1 + euclidean_distance)` over the raw `[lat, lon]` vector. That is a flat-plane approximation in degree space, not a great-circle distance, so it drifts wherever a degree of longitude is not a degree of latitude. `nearest_bounded` calls `point.distance()`, which is the true ellipsoidal metric.
- **Approximate versus exact.** `gds.knn` is an approximate NN-descent algorithm: it samples candidate comparisons rather than checking all pairs. `sampleRate: 1.0` with `deltaThreshold: 0.0` pushes it toward exhaustive — useful for a correct-by-construction demo — but at production `sampleRate` (0.5 or lower) two genuinely-near nodes can be missed if the sampler never compares them. The bounded seek has no such gap: within the radius it is exact by construction.

The short version: **use `gds.knn` to precompute a reusable neighbour graph for every node** (recommendation-style "similar depots", batch clustering, seeding a routing subgraph), and **use the bounded-radius seek for live single-origin lookups** where the origin is arbitrary, the answer must be current, and "nearest" means real distance. When the bounded set then needs cost-ranking over the road network, hand it to the two-phase workflow in [K-Nearest-Neighbor Routing](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/k-nearest-neighbor-routing/).

## Common Failure Patterns

**1. Default (cosine) similarity on coordinates ranks by bearing, not proximity.** `gds.knn` defaults a float-list property to cosine similarity, which measures the *angle* between vectors from the origin `[0, 0]` — a point near the equator and one near the pole on the same meridian look "similar" because they share a direction. The result is geographically meaningless.

```cypher
// WRONG — cosine treats [lat, lon] as a direction from (0,0)
CALL gds.knn.write('depot-knn', {nodeProperties: ['coord'], topK: 5, ...})
// RIGHT — name EUCLIDEAN so distance in degree space drives the score
CALL gds.knn.write('depot-knn', {nodeProperties: {coord: 'EUCLIDEAN'}, topK: 5, ...})
```

Even `EUCLIDEAN` is only a flat-earth approximation; it ignores the `cos(latitude)` narrowing of longitude, so at 52° North a degree of longitude is ~0.61 of a degree of latitude yet scores as equal. For anything wider than a metro area, precompute on a projected coordinate or accept that the neighbour graph is approximate in a *second* way — a good reason to keep the exact `nearest_bounded` seek for lookups that must be right.

**2. Confusing "approximate" with "exact".** Teams wire `gds.knn` neighbours into a dispatch decision and are surprised when a closer depot is missing. That is not a bug — it is the sampled algorithm's design. If you need the guaranteed nearest, either run the exact bounded seek at query time, or, for the batch path, raise `sampleRate` toward 1.0 and drop `deltaThreshold` to 0.0 and accept the near-quadratic cost.

**3. Stale neighbour graph after writes.** The `NEAR` relationships are a snapshot frozen at build time. Add a depot, move one, or delete one and the similarity graph still points at the old topology; `nearest_precomputed` will happily return a decommissioned depot or miss a new one. Re-run `precompute_knn_graph` on a schedule (or on a write-volume trigger) and never treat its output as live. The bounded seek, reading `location` directly, cannot go stale.

## Performance Notes

The cost trade is precompute-once versus compute-every-time. Let $N$ be the total node count and $Q$ the number of lookups you will serve before the graph changes. The batch build is roughly

$$C_{\text{gds}} \approx N \cdot s \cdot N \quad(\text{sampled, } 0 < s \le 1)$$

paid once, after which each read is $O(k)$. The bounded seek pays nothing up front but

$$C_{\text{bounded}} \approx Q \cdot (\log N + M)$$

where $M$ is the box hit count — the index seek is logarithmic, the distance clip runs on the $M$ survivors. Precompute wins when $Q$ is large and the graph is stable between builds (you amortise one expensive pass over many cheap reads). The per-query seek wins when the origin is arbitrary and unbounded (you cannot precompute neighbours for a point that is not a node), when writes are frequent (staleness would dominate), or when the answer must be provably exact. A common production shape uses both: a nightly `gds.knn` graph for analytics and "similar site" features, and the live bounded seek on the dispatch hot path. Keep `sampleRate`, `topK`, and the write relationship type under version control so a rebuild is reproducible, and profile the seek exactly as in [cypher performance tuning](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/) to confirm it stays a `PointIndexSeekByRange`.

## Related

- [Implementing KNN Search for Nearby Logistics Hubs](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/k-nearest-neighbor-routing/implementing-knn-search-for-nearby-logistics-hubs/) — a full worked build of the exact bounded-radius lookup used here.
- [Distance Filter Query Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/) — the box-then-clip primitive the bounded seek is built on.
- [Spatial Indexing Strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) — choosing the point index that makes the exact seek logarithmic.
- [Cypher Performance Tuning](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/) — the PROFILE loop that keeps the seek index-backed.

This guide is part of [K-Nearest-Neighbor Routing](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/k-nearest-neighbor-routing/), within the [Cypher Spatial Queries & Pathfinding Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/) pillar.

For authoritative reference, consult the [Neo4j GDS kNN documentation](https://neo4j.com/docs/graph-data-science/current/algorithms/knn/) and the [Neo4j Cypher spatial functions documentation](https://neo4j.com/docs/cypher-manual/current/functions/spatial/).
