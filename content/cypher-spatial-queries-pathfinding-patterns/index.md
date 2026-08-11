---
pageTitle: Cypher Spatial Queries and Pathfinding
title: Cypher Spatial Queries & Pathfinding Patterns
description: Index-backed distance filters, KNN search, GDS routing, and query-plan tuning for production spatial graph pathfinding in async Python with Neo4j.
slug: cypher-spatial-queries-pathfinding-patterns
type: overview
breadcrumb: Cypher Spatial Queries & Pathfinding
datePublished: 2025-09-22
dateModified: 2026-06-26
---
# Cypher Spatial Queries & Pathfinding Patterns

A spatial routing API fails in three ways that all trace back to the query layer: a distance predicate skips the index and the p99 latency jumps from 20 ms to 4 seconds, a pathfinding call expands the whole graph because the cost function was never index-anchored, or a concurrent burst exhausts the connection pool and every request times out at once. This guide is for the backend and data engineers who own those failure modes — the people writing the Cypher and the async Python that turns a graph of coordinates into a route under a latency budget. It covers how the Cypher planner resolves spatial predicates, how to keep distance filters and nearest-neighbor searches index-backed, which traversal algorithm to reach for (`shortestPath`, Dijkstra, A\*, or contraction hierarchies), and how to harden the whole path against the fragmentation and contention that only surface under production load.

The diagram below is the mental model for every query on this page: a request never touches the full graph — the planner seeds from the spatial index, hands a small candidate set to the traversal engine, and evaluates exact cost last.

<svg viewBox="0 0 920 268" role="img" aria-labelledby="ov-title ov-desc" xmlns="http://www.w3.org/2000/svg">
  <title id="ov-title">Routing request candidate funnel</title>
  <desc id="ov-desc">A left-to-right pipeline of five stages: the async Python driver sends a request to the Cypher planner, which seeds from the spatial point index, hands a small candidate set to the cost-bounded traversal engine, and returns one ranked result. A funnel beneath shows the working set narrowing from millions of graph nodes, to hundreds of index candidates, to a single route.</desc>
  <style>
    .ov-box{fill:var(--surface-2,#fff);stroke:var(--line-strong,#cdc6b3);stroke-width:1.5;}
    .ov-t{fill:var(--ink,#1b2330);font:600 13.5px var(--font-sans,system-ui,sans-serif);}
    .ov-n{fill:var(--viz-on-pill,#ffffff);font:700 12px var(--font-sans,system-ui,sans-serif);}
    .ov-cap{fill:var(--ink-mute,#6f7a8c);font:11.5px var(--font-mono,ui-monospace,monospace);}
    .ov-fl{fill:var(--ink-soft,#455062);font:700 13px var(--font-sans,system-ui,sans-serif);}
  </style>
  <defs>
    <marker id="ov-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="var(--ink-mute,#6f7a8c)"/>
    </marker>
  </defs>
  <!-- stage boxes -->
  <rect class="viz-backdrop" x="0" y="0" width="920" height="268" fill="var(--viz-bg,#ffffff)"/>
  <g>
    <rect class="ov-box" x="20"    y="56" width="150" height="72" rx="10"/>
    <rect class="ov-box" x="202.5" y="56" width="150" height="72" rx="10"/>
    <rect class="ov-box" x="385"   y="56" width="150" height="72" rx="10"/>
    <rect class="ov-box" x="567.5" y="56" width="150" height="72" rx="10"/>
    <rect class="ov-box" x="750"   y="56" width="150" height="72" rx="10"/>
  </g>
  <!-- stage labels -->
  <g text-anchor="middle">
    <text class="ov-t" x="95"  y="88">async Python</text><text class="ov-t" x="95"  y="106">driver</text>
    <text class="ov-t" x="277.5" y="88">Cypher</text><text class="ov-t" x="277.5" y="106">planner</text>
    <text class="ov-t" x="460" y="88">spatial index</text><text class="ov-t" x="460" y="106">seed</text>
    <text class="ov-t" x="642.5" y="88">cost-bounded</text><text class="ov-t" x="642.5" y="106">traversal</text>
    <text class="ov-t" x="825" y="88">ranked</text><text class="ov-t" x="825" y="106">result</text>
  </g>
  <!-- stage number badges -->
  <g>
    <circle cx="38"    cy="56" r="12" fill="var(--accent,#0e7c86)"/><text class="ov-n" x="38"    y="60" text-anchor="middle">1</text>
    <circle cx="220.5" cy="56" r="12" fill="var(--accent,#0e7c86)"/><text class="ov-n" x="220.5" y="60" text-anchor="middle">2</text>
    <circle cx="403"   cy="56" r="12" fill="var(--accent,#0e7c86)"/><text class="ov-n" x="403"   y="60" text-anchor="middle">3</text>
    <circle cx="585.5" cy="56" r="12" fill="var(--accent,#0e7c86)"/><text class="ov-n" x="585.5" y="60" text-anchor="middle">4</text>
    <circle cx="768"   cy="56" r="12" fill="var(--accent,#0e7c86)"/><text class="ov-n" x="768"   y="60" text-anchor="middle">5</text>
  </g>
  <!-- connectors -->
  <g stroke="var(--ink-mute,#6f7a8c)" stroke-width="2" fill="none" marker-end="url(#ov-arrow)">
    <path d="M172 92 H200"/>
    <path d="M354.5 92 H383"/>
    <path d="M537 92 H565"/>
    <path d="M719.5 92 H748"/>
  </g>
  <!-- candidate funnel -->
  <polygon points="40,176 890,196 890,212 40,232" fill="var(--accent,#0e7c86)" opacity="0.14"/>
  <polygon points="40,176 890,196 890,212 40,232" fill="none" stroke="var(--accent,#0e7c86)" stroke-width="1.5" opacity="0.6"/>
  <g text-anchor="middle">
    <text class="ov-fl" x="150" y="170">millions</text>
    <text class="ov-fl" x="500" y="170">hundreds</text>
    <text class="ov-fl" x="845" y="170">1</text>
    <text class="ov-cap" x="150" y="252">full graph</text>
    <text class="ov-cap" x="500" y="252">index candidates</text>
    <text class="ov-cap" x="845" y="252">ranked route</text>
  </g>
</svg>

## Concept & Architecture

Cypher treats geography as a first-class type rather than a bolted-on extension. A coordinate is stored as a native `point({latitude, longitude})` value with the WGS84 CRS, and the engine maintains an R-tree-backed point index over that property. This is the structural reason graph routing outperforms a relational equivalent: in a tabular model a *k*-hop shortest path requires *k* self-joins on an edge table and the optimizer re-estimates join cardinality at every hop, whereas in a graph the same traversal is a sequence of constant-time pointer chases and the spatial index is consulted only at the endpoints — to anchor the origin and destination — never at the intermediate hops. The storage model that makes this possible is covered in depth under [Spatial Graph Database Fundamentals for Python](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/); this guide assumes that foundation and focuses on the query language on top of it.

That endpoint-only indexing is also the single most important invariant to protect. The moment a distance function leaks into a `WHERE` clause without a bounding pre-filter, the planner can no longer use the point index and the query degrades to a full label scan — linear in node count and quadratic the instant a second `MATCH` introduces a Cartesian product. Every pattern below exists to keep the index in the loop: pre-filter to a corridor, anchor the traversal inside it, then compute exact great-circle cost on the survivors.

Spatial primitives in Cypher are deliberately minimal. `point.distance(a, b)` returns the great-circle distance in meters between two WGS84 points; `point.withinBBox(p, lowerLeft, upperRight)` tests bounding-box containment using the index; and arithmetic on `.latitude` / `.longitude` accessors lets you build explicit corridors. There is no native polygon-contains in core Cypher, so polygon membership is approximated with a bounding box plus an exact test in Python — a split that mirrors the two-stage strategy throughout this guide.

## Schema Design

Routing queries are only as fast as the schema they run against. Three decisions determine whether the planner can stay index-backed.

**Node property model and point type.** Anchor every routable vertex on a single native point property, not separate `lat`/`lon` floats. Bare floats force the planner onto two independent range indexes it cannot combine for a distance predicate; a point property gives it one R-tree seek. Keep a stable, application-assigned `id` (distinct from the internal element id) so ingestion and external systems can upsert idempotently.

```cypher
CREATE CONSTRAINT location_id_unique IF NOT EXISTS
FOR (n:Location) REQUIRE n.id IS UNIQUE;

CREATE POINT INDEX location_coord IF NOT EXISTS
FOR (n:Location) ON (n.coord);
```

**Relationship direction and cost.** A `CONNECTED_TO` relationship carries the routing impedance and the access semantics. Store cost as a precomputed scalar (`distance` in meters, or `travel_seconds` for time-based routing) so traversal never recomputes geometry mid-query. Direction is load-bearing: a one-way segment is a single `(:Location)-[:CONNECTED_TO]->(:Location)`, while a two-way segment is either two relationships or one queried without a direction arrow. Encode the travel mode (`travel_mode`) and temporal windows (`valid_from`, `valid_to`) as edge properties. The mechanics of deriving these directional edges from raw road geometry belong to [Node and Edge Spatial Mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/).

```cypher
CREATE INDEX rel_mode IF NOT EXISTS
FOR ()-[r:CONNECTED_TO]-() ON (r.travel_mode);
```

**Tenant isolation.** On multi-tenant routing platforms the isolation boundary must map to physical structure or it will be bypassed. A `tenant_id` property on every node and edge is the cheap option, but it is only safe when paired with a composite index so the filter is resolved at the storage tier, not applied post-scan — and when it is enforced in a query-builder layer rather than left to each caller. Database-per-tenant is the stronger, heavier alternative. The trade-offs and the access-control patterns that stop a route crossing a tenant boundary are detailed in [Spatial Security Boundaries](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-security-boundaries/).

<svg viewBox="0 0 920 312" role="img" aria-labelledby="sc-title sc-desc" xmlns="http://www.w3.org/2000/svg">
  <title id="sc-title">Routing property-graph schema</title>
  <desc id="sc-desc">Two Location node cards connected by a directed CONNECTED_TO relationship. Each Location carries an id constrained unique, a coord point property backed by a point index, and a tenant_id backed by a composite index. The directed relationship carries a precomputed distance, a travel_mode backed by an index, and valid_from and valid_to temporal-window properties. Badges mark which properties back an index.</desc>
  <style>
    .sc-card{fill:var(--surface-2,#fff);stroke:var(--line-strong,#cdc6b3);stroke-width:1.5;}
    .sc-hd{fill:var(--accent,#0e7c86);font:700 15px var(--font-mono,ui-monospace,monospace);}
    .sc-p{fill:var(--ink,#1b2330);font:13px var(--font-mono,ui-monospace,monospace);}
    .sc-badge{font:700 9px var(--font-sans,system-ui,sans-serif);fill:var(--viz-on-pill,#ffffff);}
    .sc-note{fill:var(--ink-mute,#6f7a8c);font:11.5px var(--font-sans,system-ui,sans-serif);}
    .sc-div{stroke:var(--line,#e5e0d2);stroke-width:1;}
  </style>
  <defs>
    <marker id="sc-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="var(--accent,#0e7c86)"/>
    </marker>
  </defs>
  <!-- left Location node -->
  <rect class="viz-backdrop" x="0" y="0" width="920" height="312" fill="var(--viz-bg,#ffffff)"/>
  <rect class="sc-card" x="30" y="40" width="240" height="186" rx="12"/>
  <text class="sc-hd" x="50" y="70">(:Location)</text>
  <line class="sc-div" x1="46" y1="82" x2="254" y2="82"/>
  <text class="sc-p" x="50" y="112">id</text>
  <rect x="196" y="98" width="58" height="20" rx="10" fill="var(--accent-3,#5b21b6)"/><text class="sc-badge" x="225" y="112" text-anchor="middle">UNIQUE</text>
  <text class="sc-p" x="50" y="150">coord : point</text>
  <rect x="190" y="136" width="64" height="20" rx="10" fill="var(--accent,#0e7c86)"/><text class="sc-badge" x="222" y="150" text-anchor="middle">POINT IDX</text>
  <text class="sc-p" x="50" y="188">tenant_id</text>
  <rect x="206" y="174" width="48" height="20" rx="10" fill="var(--accent,#0e7c86)"/><text class="sc-badge" x="230" y="188" text-anchor="middle">IDX</text>
  <!-- relationship card -->
  <rect class="sc-card" x="360" y="58" width="200" height="160" rx="12"/>
  <text class="sc-hd" x="378" y="86" font-size="13">[:CONNECTED_TO]</text>
  <line class="sc-div" x1="376" y1="98" x2="544" y2="98"/>
  <text class="sc-p" x="378" y="124" font-size="12.5">distance</text>
  <text class="sc-p" x="378" y="150" font-size="12.5">travel_mode</text>
  <rect x="500" y="137" width="44" height="18" rx="9" fill="var(--accent,#0e7c86)"/><text class="sc-badge" x="522" y="150" text-anchor="middle">IDX</text>
  <text class="sc-p" x="378" y="176" font-size="12.5">valid_from</text>
  <text class="sc-p" x="378" y="202" font-size="12.5">valid_to</text>
  <!-- right Location node -->
  <rect class="sc-card" x="650" y="40" width="240" height="186" rx="12"/>
  <text class="sc-hd" x="670" y="70">(:Location)</text>
  <line class="sc-div" x1="666" y1="82" x2="874" y2="82"/>
  <text class="sc-p" x="670" y="112">id</text>
  <rect x="816" y="98" width="58" height="20" rx="10" fill="var(--accent-3,#5b21b6)"/><text class="sc-badge" x="845" y="112" text-anchor="middle">UNIQUE</text>
  <text class="sc-p" x="670" y="150">coord : point</text>
  <rect x="810" y="136" width="64" height="20" rx="10" fill="var(--accent,#0e7c86)"/><text class="sc-badge" x="842" y="150" text-anchor="middle">POINT IDX</text>
  <text class="sc-p" x="670" y="188">tenant_id</text>
  <rect x="826" y="174" width="48" height="20" rx="10" fill="var(--accent,#0e7c86)"/><text class="sc-badge" x="850" y="188" text-anchor="middle">IDX</text>
  <!-- directed relationship arrows through the edge card -->
  <g stroke="var(--accent,#0e7c86)" stroke-width="2.5" fill="none" marker-end="url(#sc-arrow)">
    <path d="M272 134 H356"/>
    <path d="M562 134 H646"/>
  </g>
  <text class="sc-note" x="460" y="246" text-anchor="middle">direction is load-bearing: one-way = single edge, two-way = reciprocal pair</text>
  <text class="sc-note" x="460" y="286" text-anchor="middle">badges mark index-backed properties — the planner seeks these at the storage tier</text>
</svg>

## Core Python Integration

The driver layer, not Cypher, is where most production incidents originate — in how Python acquires, scopes, and releases sessions. Use the official `neo4j` async driver, create exactly one driver per process (it is a connection-pool manager, not a connection), and scope each unit of work to its own `session`. The class below sets a bounded pool, an acquisition timeout so a saturated pool fails fast instead of hanging, and a connection lifetime that recycles sockets ahead of load-balancer idle limits. It also demonstrates idempotent spatial ingestion and a parameterized query helper that every later pattern reuses.

```python
import asyncio
from neo4j import AsyncDriver, AsyncGraphDatabase


def init_router_driver(uri: str, user: str, password: str, pool_size: int = 25) -> AsyncDriver:
    """One driver per process: a bounded, fast-failing connection pool."""
    return AsyncGraphDatabase.driver(
        uri,
        auth=(user, password),
        max_connection_pool_size=pool_size,
        connection_acquisition_timeout=10.0,
        max_connection_lifetime=300,
        max_transaction_retry_time=30,
    )


class SpatialRouter:
    def __init__(self, driver: AsyncDriver):
        self.driver = driver

    async def ingest_locations(self, batch: list[dict]) -> None:
        """Idempotent bulk upsert. UNWIND keeps the transaction flat;
        MERGE makes re-runs safe; point() registers the spatial index entry."""
        query = (
            "UNWIND $batch AS row "
            "MERGE (n:Location {id: row.id}) "
            "SET n.coord = point({latitude: row.lat, longitude: row.lon})"
        )
        async with self.driver.session(database="neo4j") as session:
            await session.run(query, batch=batch)

    async def query(self, cypher: str, params: dict) -> list[dict]:
        """Run a parameterized read and materialize records inside the session
        so the connection is released the instant results are drained."""
        async with self.driver.session(database="neo4j") as session:
            result = await session.run(cypher, params)
            return await result.data()

    async def close(self) -> None:
        await self.driver.close()


async def main():
    driver = init_router_driver("neo4j://localhost:7687", "neo4j", "secure_password")
    router = SpatialRouter(driver)
    try:
        await router.ingest_locations([
            {"id": "hub_01", "lat": 40.7128, "lon": -74.0060},
            {"id": "hub_02", "lat": 40.7580, "lon": -73.9855},
        ])
        rows = await router.query(
            "MATCH (n:Location) RETURN count(n) AS total", {}
        )
        print(f"Indexed locations: {rows[0]['total']}")
    finally:
        await router.close()


if __name__ == "__main__":
    asyncio.run(main())
```

Four patterns in this script recur on every page of this guide: one driver built once and closed in a `finally` block; sessions opened with `async with` so they are always released; `MERGE` for idempotent writes so a retried batch never duplicates a node; and `connection_acquisition_timeout` converting pool exhaustion from an unbounded hang into a catchable error you can shed load on. The streaming and back-pressured variants for loading continental datasets through this same driver are covered under [async batch processing for graphs](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/async-batch-processing-for-graphs/), and the end-to-end loaders under [OSM data ingestion pipelines](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/osm-data-ingestion-pipelines/).

## Indexing & Query Planning

A well-tuned routing query follows a strict three-act sequence: the planner consults the spatial index, hands a small candidate set to the traversal engine, and only then evaluates exact distance and cost. Diverging from this ordering is the single most common cause of latency spikes.

<svg viewBox="0 0 920 348" role="img" aria-labelledby="sq-title sq-desc" xmlns="http://www.w3.org/2000/svg">
  <title id="sq-title">Three-act spatial query sequence</title>
  <desc id="sq-desc">A sequence diagram across four lifelines: the Python async driver, the Cypher planner, the spatial index, and the traversal engine. Step 1, the driver sends a Bolt request with parameters to the planner. Step 2, the planner issues a bounding-box or point seek to the spatial index. Step 3, the index returns candidate node ids. Step 4, the planner asks the traversal engine to expand with cost constraints. Step 5, the traversal engine returns ranked paths. Step 6, the planner returns result records to the driver. Returns are drawn as dashed arrows.</desc>
  <style>
    .sq-head{fill:var(--surface-2,#fff);stroke:var(--line-strong,#cdc6b3);stroke-width:1.5;}
    .sq-ht{fill:var(--ink,#1b2330);font:700 13px var(--font-sans,system-ui,sans-serif);}
    .sq-life{stroke:var(--line-strong,#cdc6b3);stroke-width:1.5;stroke-dasharray:4 5;}
    .sq-msg{fill:var(--ink-soft,#455062);font:12.5px var(--font-sans,system-ui,sans-serif);}
    .sq-n{fill:var(--viz-on-pill,#ffffff);font:700 11px var(--font-sans,system-ui,sans-serif);}
  </style>
  <defs>
    <marker id="sq-solid" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="var(--accent,#0e7c86)"/>
    </marker>
    <marker id="sq-ret" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="var(--ink-mute,#6f7a8c)"/>
    </marker>
  </defs>
  <!-- lifelines -->
  <rect class="viz-backdrop" x="0" y="0" width="920" height="348" fill="var(--viz-bg,#ffffff)"/>
  <g class="sq-life">
    <line x1="120" y1="66" x2="120" y2="322"/>
    <line x1="370" y1="66" x2="370" y2="322"/>
    <line x1="615" y1="66" x2="615" y2="322"/>
    <line x1="825" y1="66" x2="825" y2="322"/>
  </g>
  <!-- participant heads -->
  <g text-anchor="middle">
    <rect class="sq-head" x="40"  y="18" width="160" height="40" rx="8"/><text class="sq-ht" x="120" y="43">Python driver</text>
    <rect class="sq-head" x="295" y="18" width="150" height="40" rx="8"/><text class="sq-ht" x="370" y="43">Cypher planner</text>
    <rect class="sq-head" x="545" y="18" width="140" height="40" rx="8"/><text class="sq-ht" x="615" y="43">Spatial index</text>
    <rect class="sq-head" x="745" y="18" width="160" height="40" rx="8"/><text class="sq-ht" x="825" y="43">Traversal engine</text>
  </g>
  <!-- messages -->
  <g>
    <!-- 1 App -> Plan -->
    <line x1="120" y1="100" x2="368" y2="100" stroke="var(--accent,#0e7c86)" stroke-width="2" marker-end="url(#sq-solid)"/>
    <circle cx="120" cy="100" r="9" fill="var(--accent,#0e7c86)"/><text class="sq-n" x="120" y="104" text-anchor="middle">1</text>
    <text class="sq-msg" x="244" y="93" text-anchor="middle">Bolt request + parameters</text>
    <!-- 2 Plan -> Idx -->
    <line x1="370" y1="138" x2="613" y2="138" stroke="var(--accent,#0e7c86)" stroke-width="2" marker-end="url(#sq-solid)"/>
    <circle cx="370" cy="138" r="9" fill="var(--accent,#0e7c86)"/><text class="sq-n" x="370" y="142" text-anchor="middle">2</text>
    <text class="sq-msg" x="492" y="131" text-anchor="middle">bbox / point seek</text>
    <!-- 3 Idx to Plan (return) -->
    <line x1="615" y1="176" x2="372" y2="176" stroke="var(--ink-mute,#6f7a8c)" stroke-width="2" stroke-dasharray="6 4" marker-end="url(#sq-ret)"/>
    <circle cx="615" cy="176" r="9" fill="var(--ink-mute,#6f7a8c)"/><text class="sq-n" x="615" y="180" text-anchor="middle">3</text>
    <text class="sq-msg" x="492" y="169" text-anchor="middle">candidate node ids</text>
    <!-- 4 Plan -> Trav -->
    <line x1="370" y1="214" x2="823" y2="214" stroke="var(--accent,#0e7c86)" stroke-width="2" marker-end="url(#sq-solid)"/>
    <circle cx="370" cy="214" r="9" fill="var(--accent,#0e7c86)"/><text class="sq-n" x="370" y="218" text-anchor="middle">4</text>
    <text class="sq-msg" x="597" y="207" text-anchor="middle">expand with cost constraints</text>
    <!-- 5 Trav to Plan (return) -->
    <line x1="825" y1="252" x2="372" y2="252" stroke="var(--ink-mute,#6f7a8c)" stroke-width="2" stroke-dasharray="6 4" marker-end="url(#sq-ret)"/>
    <circle cx="825" cy="252" r="9" fill="var(--ink-mute,#6f7a8c)"/><text class="sq-n" x="825" y="256" text-anchor="middle">5</text>
    <text class="sq-msg" x="597" y="245" text-anchor="middle">ranked paths</text>
    <!-- 6 Plan to App (return) -->
    <line x1="370" y1="290" x2="122" y2="290" stroke="var(--ink-mute,#6f7a8c)" stroke-width="2" stroke-dasharray="6 4" marker-end="url(#sq-ret)"/>
    <circle cx="370" cy="290" r="9" fill="var(--ink-mute,#6f7a8c)"/><text class="sq-n" x="370" y="294" text-anchor="middle">6</text>
    <text class="sq-msg" x="246" y="283" text-anchor="middle">result records</text>
  </g>
</svg>

Neo4j's native point index is R-tree-backed and is the correct default for road and logistics graphs; the full decision framework against geohash and quadtree alternatives — and the write-amplification trade-offs of each — lives in [Spatial Indexing Strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/). What matters at the query layer is **predicate push-down**: the spatial filter must execute at the storage tier so the planner shrinks the candidate set *before* graph expansion. The query below forces an index-backed scan and bounds the result, so the planner emits a point-index seek feeding the distance computation rather than a label scan followed by a filter.

```cypher
// Index-backed radius search: seed from the point index, compute exact distance last
MATCH (origin:Location {id: $origin_id})
MATCH (target:Location)
WHERE point.distance(origin.coord, target.coord) < $radius_m
RETURN target.id AS id,
       point.distance(origin.coord, target.coord) AS meters
ORDER BY meters
LIMIT 20
```

Verify the plan, never assume it: run `PROFILE` and confirm a point-index seek (not a `NodeByLabelScan` + `Filter`) feeds the distance evaluation, and that the planner consumes the index for the corridor predicate. When it picks the wrong starting point, an index hint or a reordered `MATCH` forces it back — the systematic approach to reading `EXPLAIN`/`PROFILE` and reshaping predicates so they stay sargable is the subject of [Graph Query Planner Optimization](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/). For dense urban grids where even a tight radius returns thousands of candidates, a coordinate-aligned bounding box applied before the distance math prunes harder still; that two-stage refinement is the focus of [Distance Filter Query Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/). One hard rule: never mix Cartesian and WGS84 points in the same predicate — implicit type coercion invalidates planner statistics and triggers a full scan, and when executing against the [EPSG:4326](https://epsg.org/crs_4326/WGS-84.html) reference system Neo4j computes spherical distance natively.

The cost model behind every distance predicate is the Haversine great-circle formula, which also seeds the A\* heuristic discussed next:

$$d = 2R \cdot \arcsin\!\sqrt{\sin^2\!\frac{\Delta\varphi}{2} + \cos\varphi_1 \cos\varphi_2 \sin^2\!\frac{\Delta\lambda}{2}}$$

where $R$ is the mean Earth radius, $\varphi$ is latitude in radians, and $\lambda$ is longitude. Because this value never overestimates the true road distance between two points, it is an admissible heuristic — the property that lets A\* explore a fraction of the graph while still returning the optimal path.

## Routing & Traversal Patterns

Once the corridor is pruned and the endpoints are anchored, the choice of traversal algorithm determines both correctness and latency. Four families cover almost every production case; the right pick depends on graph size, query volume, and how often the topology changes.

**Breadth-first `shortestPath`** is the built-in default and is correct only when edges are unweighted or you need hop count alone. It minimizes hops, not cost, so it is the wrong tool the instant impedance varies.

**Dijkstra** is the baseline for weighted shortest paths. It explores outward by cumulative cost and guarantees the optimal route, but it expands uniformly in all directions, so on a continental graph it touches far more nodes than necessary. Reach for it when you have no admissible heuristic, when edge weights have no geometric meaning, or when you need one-to-many cost surfaces. In Neo4j it runs through the Graph Data Science (GDS) library over an in-memory projection:

```cypher
// Project the routing graph into the GDS catalog (driving edges only)
CALL gds.graph.project(
  'routing_graph',
  'Location',
  {
    CONNECTED_TO: { properties: ['distance', 'travel_mode'] }
  },
  { nodeProperties: ['coord'] }
);

// Weighted shortest path by cumulative distance
CALL gds.shortestPath.dijkstra.stream('routing_graph', {
  sourceNode: $origin_id,
  targetNode: $target_id,
  relationshipWeightProperty: 'distance'
})
YIELD nodeId, totalCost
RETURN gds.util.asNode(nodeId).id AS location_id, totalCost
ORDER BY totalCost;
```

**A\*** adds the Haversine straight-line distance to the destination as a heuristic that biases expansion toward the goal. With that admissible heuristic it returns the same optimal path as Dijkstra while exploring a fraction of the nodes — making it the default for interactive point-to-point routing on geographic graphs, where coordinates hand you the heuristic for free. GDS exposes it as `gds.shortestPath.astar.stream` with `latitudeProperty`/`longitudeProperty` parameters drawn from the projected `coord`. For multi-modal networks with mode-specific cost matrices, project a separate in-memory graph per travel mode rather than filtering relationships post-projection; filtering after the projection still pays to load the unused edges.

**Contraction hierarchies** and related preprocessing schemes trade build time for query speed. By precomputing shortcut edges over a node ordering they answer point-to-point queries on country-scale road networks in microseconds, but the preprocessing must be rebuilt when the topology changes — so they fit static or slowly-changing graphs, not networks under constant live edits.

The practical rule: start with A\* for interactive point-to-point routing, fall back to Dijkstra when no heuristic applies or you need cost-to-all-targets, and invest in contraction hierarchies only once query volume on a stable graph justifies the preprocessing. Proximity-first workloads — "the five nearest depots that are actually reachable" — combine an index seed with a bounded expansion rather than a full shortest-path call:

```python
async def find_knn_locations(router, lat: float, lon: float, k: int, max_dist_m: float):
    """KNN by spatial pre-filter then exact distance sort, memory-bounded by LIMIT."""
    query = (
        "WITH point({latitude: $lat, longitude: $lon}) AS query_pt "
        "MATCH (loc:Location) "
        "WHERE point.distance(query_pt, loc.coord) <= $max_dist_m "
        "RETURN loc.id AS id, point.distance(query_pt, loc.coord) AS dist "
        "ORDER BY dist ASC LIMIT $k"
    )
    return await router.query(
        query, {"lat": lat, "lon": lon, "max_dist_m": max_dist_m, "k": k}
    )
```

The `max_dist_m` bound is a hard spatial filter the index resolves, and `LIMIT` caps the result-set memory. The streaming priority-queue and traffic-weighted variants — where the distance metric folds in live impedance — are detailed under [K-Nearest Neighbor Routing](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/k-nearest-neighbor-routing/). When a query has to correlate two spatial sets — matching deliveries to the nearest available vehicle, or snapping events to road segments — the index-aware join strategies in [Spatial Join Techniques](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/spatial-join-techniques/) avoid the Cartesian product that a naive double-`MATCH` produces.

<svg viewBox="0 0 920 392" role="img" aria-labelledby="mx-title mx-desc" xmlns="http://www.w3.org/2000/svg">
  <title id="mx-title">Traversal algorithm decision matrix</title>
  <desc id="mx-desc">Four traversal algorithms compared across five criteria. shortestPath: minimizes hops only, low node expansion, no heuristic, no preprocessing, best for unweighted hop counts. Dijkstra: returns the optimal cost, high node expansion, no heuristic, no preprocessing, best for cost-to-all-targets queries. A star: returns the optimal cost, low node expansion, needs an admissible heuristic, no preprocessing, the recommended default for point-to-point geographic routing. Contraction hierarchies: returns the optimal cost, very low node expansion, no heuristic, heavy preprocessing, best for static large road graphs.</desc>
  <style>
    .mx-h{fill:var(--ink,#1b2330);font:700 13.5px var(--font-sans,system-ui,sans-serif);}
    .mx-rl{fill:var(--ink,#1b2330);font:600 13px var(--font-sans,system-ui,sans-serif);}
    .mx-row{fill:var(--surface-3,#f1ede2);}
    .mx-pt{fill:var(--viz-on-pill,#ffffff);font:700 12px var(--font-sans,system-ui,sans-serif);}
    .mx-tx{fill:var(--ink-soft,#455062);font:12px var(--font-sans,system-ui,sans-serif);}
    .mx-lg{fill:var(--ink-mute,#6f7a8c);font:12px var(--font-sans,system-ui,sans-serif);}
  </style>
  <!-- alternating row bands -->
  <rect class="viz-backdrop" x="0" y="0" width="920" height="392" fill="var(--viz-bg,#ffffff)"/>
  <rect class="mx-row" x="20" y="64"  width="880" height="48"/>
  <rect class="mx-row" x="20" y="160" width="880" height="48"/>
  <rect class="mx-row" x="20" y="256" width="880" height="64"/>
  <!-- column headers -->
  <g text-anchor="middle">
    <text class="mx-h" x="305" y="40">shortestPath</text>
    <text class="mx-h" x="475" y="40">Dijkstra</text>
    <text class="mx-h" x="645" y="40">A*</text>
    <text class="mx-h" x="815" y="34">contraction</text><text class="mx-h" x="815" y="50">hierarchies</text>
  </g>
  <!-- row labels -->
  <text class="mx-rl" x="36" y="93">Optimal cost?</text>
  <text class="mx-rl" x="36" y="141">Nodes expanded</text>
  <text class="mx-rl" x="36" y="189">Needs heuristic?</text>
  <text class="mx-rl" x="36" y="237">Preprocessing</text>
  <text class="mx-rl" x="36" y="292">Best-fit workload</text>
  <!-- Row 1: Optimal cost -->
  <g text-anchor="middle">
    <rect x="246" y="73" width="118" height="30" rx="15" fill="var(--accent-4,#b58900)"/><text class="mx-pt" x="305" y="93">hops only</text>
    <rect x="416" y="73" width="118" height="30" rx="15" fill="var(--accent,#0e7c86)"/><text class="mx-pt" x="475" y="93">yes</text>
    <rect x="586" y="73" width="118" height="30" rx="15" fill="var(--accent,#0e7c86)"/><text class="mx-pt" x="645" y="93">yes</text>
    <rect x="756" y="73" width="118" height="30" rx="15" fill="var(--accent,#0e7c86)"/><text class="mx-pt" x="815" y="93">yes</text>
  </g>
  <!-- Row 2: Nodes expanded -->
  <g text-anchor="middle">
    <rect x="246" y="121" width="118" height="30" rx="15" fill="var(--accent,#0e7c86)"/><text class="mx-pt" x="305" y="141">low</text>
    <rect x="416" y="121" width="118" height="30" rx="15" fill="var(--accent-coral,#ff6b6b)"/><text class="mx-pt" x="475" y="141">high</text>
    <rect x="586" y="121" width="118" height="30" rx="15" fill="var(--accent,#0e7c86)"/><text class="mx-pt" x="645" y="141">low</text>
    <rect x="756" y="121" width="118" height="30" rx="15" fill="var(--accent,#0e7c86)"/><text class="mx-pt" x="815" y="141">very low</text>
  </g>
  <!-- Row 3: Needs heuristic -->
  <g text-anchor="middle">
    <rect x="246" y="169" width="118" height="30" rx="15" fill="var(--accent,#0e7c86)"/><text class="mx-pt" x="305" y="189">no</text>
    <rect x="416" y="169" width="118" height="30" rx="15" fill="var(--accent,#0e7c86)"/><text class="mx-pt" x="475" y="189">no</text>
    <rect x="586" y="169" width="118" height="30" rx="15" fill="var(--accent-4,#b58900)"/><text class="mx-pt" x="645" y="189">admissible</text>
    <rect x="756" y="169" width="118" height="30" rx="15" fill="var(--accent,#0e7c86)"/><text class="mx-pt" x="815" y="189">no</text>
  </g>
  <!-- Row 4: Preprocessing -->
  <g text-anchor="middle">
    <rect x="246" y="217" width="118" height="30" rx="15" fill="var(--accent,#0e7c86)"/><text class="mx-pt" x="305" y="237">none</text>
    <rect x="416" y="217" width="118" height="30" rx="15" fill="var(--accent,#0e7c86)"/><text class="mx-pt" x="475" y="237">none</text>
    <rect x="586" y="217" width="118" height="30" rx="15" fill="var(--accent,#0e7c86)"/><text class="mx-pt" x="645" y="237">none</text>
    <rect x="756" y="217" width="118" height="30" rx="15" fill="var(--accent-coral,#ff6b6b)"/><text class="mx-pt" x="815" y="237">heavy</text>
  </g>
  <!-- Row 5: Best-fit workload (text) -->
  <g text-anchor="middle">
    <text class="mx-tx" x="305" y="285">unweighted</text><text class="mx-tx" x="305" y="301">hop count</text>
    <text class="mx-tx" x="475" y="285">cost-to-all</text><text class="mx-tx" x="475" y="301">targets</text>
    <text class="mx-tx" x="645" y="285">point-to-point</text><text class="mx-tx" x="645" y="301">(default)</text>
    <text class="mx-tx" x="815" y="285">static large</text><text class="mx-tx" x="815" y="301">road graphs</text>
  </g>
  <!-- legend -->
  <g>
    <rect x="246" y="356" width="15" height="15" rx="4" fill="var(--accent,#0e7c86)"/><text class="mx-lg" x="268" y="368">favorable</text>
    <rect x="378" y="356" width="15" height="15" rx="4" fill="var(--accent-4,#b58900)"/><text class="mx-lg" x="400" y="368">trade-off</text>
    <rect x="500" y="356" width="15" height="15" rx="4" fill="var(--accent-coral,#ff6b6b)"/><text class="mx-lg" x="522" y="368">costly</text>
  </g>
</svg>

## Performance & Scale

Spatial query performance is a budget across three resources: heap, page cache, and the connection pool.

**Memory budgets.** Coordinate precision drives index depth. High-precision WGS84 coordinates deepen the point-index tree and lower cache-hit ratios; truncating to five decimal places (~1.1 m at the equator) is accurate enough for road routing and measurably shrinks the index. Size the page cache to hold the hot index pages and the most-traversed regions of the graph — if the routing working set spills to disk, p99 collapses. Keep the JVM heap separate and bounded; oversized heaps lengthen GC pauses that surface as periodic latency spikes.

**Write amplification.** Every edge insert touches the spatial index, and under dense urban grids the resulting node splits dominate write cost. Batch writes in bounded transactions (a few thousand operations each) so the index amortizes splits, and prefer append-then-reindex over interleaved single-row upserts during bulk loads.

**Batch versus streaming ingestion.** Materializing a whole network in memory before loading is the most common out-of-memory failure. Stream features through generators with back-pressure so the importer footprint stays flat regardless of dataset size — the async mechanics live under [async batch processing for graphs](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/async-batch-processing-for-graphs/).

**Connection-pool sizing and GC pressure.** Size `max_connection_pool_size` to match the server's effective query concurrency, not the number of application coroutines — an oversized pool just moves contention from client to the server's lock manager. Watch for GC pauses correlated with large intermediate result sets; the fix is almost always pushing filters down so fewer rows are materialized, which ties directly into [Cypher Performance Tuning](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/) — execution-plan analysis, relationship directionality, and memory-constrained aggregation.

## Failure Modes & Hardening

Most spatial query outages take one of four shapes. Knowing the symptom-to-cause mapping turns a 2 a.m. page into a checklist.

**Topology corruption.** Self-intersecting geometry, duplicate coordinates, and misaligned directional edges create phantom paths that return wrong-but-plausible routes. The tripwire is a geodesic plausibility check: when the planned cost wildly exceeds the straight-line Haversine distance, suspect a topology defect. Harden against it by enforcing snapping tolerance and directional consistency at ingestion and running periodic degree-and-connectivity audits that flag orphaned nodes and one-way traps.

**Index fragmentation.** Frequent edge mutations leave the spatial index unbalanced and range-query latency creeps up until background compaction catches up. The recovery playbook: schedule online index rebuilds in low-traffic windows, monitor index page-fault rates, and prefer deferred or batched index updates on write-heavy partitions.

**Connection-pool exhaustion.** A leaked session, a slow query holding a connection, or a pool sized below real concurrency all present identically — requests hang, then fail at the acquisition timeout. The `connection_acquisition_timeout` from the integration code converts this from a hang into a fast, sheddable error. Recovery is to cap query time with transaction timeouts, open every session in an `async with` block, and alarm on pool-utilization percentage rather than on errors after the fact.

**Planner regression.** A predicate that was index-backed yesterday can fall back to a full scan after a statistics refresh, a query rewrite, or a data-distribution shift. Guard against it by pinning critical queries with `PROFILE`-verified plans in CI, asserting the expected operator (point-index seek) appears, and re-checking after any schema or version change. The diagnostic workflow sits in [Graph Query Planner Optimization](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/).

### Reading a regression back to its cause

When a spatial query that was fast becomes slow, the cause is nearly always one of four things, and they are distinguishable without guessing. If `PROFILE` shows the base operator changed from a seek to a scan, the predicate stopped being seekable — usually because a code change wrapped the indexed property in an expression, or because an index went offline and the plan was recompiled while it was rebuilding. If the base operator is unchanged but its row count grew by orders of magnitude, the data moved rather than the query: a bounding box calibrated for one density is returning far more candidates in a region that has since been enriched. If rows are stable but `DbHits` climbed, the query is probing more properties per row than it was, typically because a `RETURN` grew to pull whole nodes where it once pulled two fields. And if the plan, rows and hits are all stable but wall time is not, the query is not the problem — look at pool contention, at a concurrent write workload holding locks on the same nodes, or at a projection that is being rebuilt on every request instead of held resident.

The reason this triage works is that each of the three numbers on an operator answers a different question, and only one of them is about the query text. Comparing a current `PROFILE` against one captured when the query was healthy turns a vague performance complaint into a specific one, and it is worth storing that baseline alongside the query rather than reconstructing it under pressure.

## Operational Checklist

Use this as a pre-production gate and a recurring health review:

- [ ] **Schema validation** — uniqueness constraint on `Location.id`; point index on `coord`; `travel_mode` and any `tenant_id` index present and confirmed used via `PROFILE`.
- [ ] **Index warm-up** — hot index and graph regions resident in page cache before serving traffic; cold-start latency measured, not assumed.
- [ ] **Predicate push-down** — every spatial and tenant filter verified as an index seek in `PROFILE`, never label-scan-then-filter.
- [ ] **Pool sizing** — `max_connection_pool_size` matched to server query concurrency; `connection_acquisition_timeout` set; every session opened in `async with`.
- [ ] **Query bounding** — every distance query carries a radius/bbox pre-filter and a `LIMIT`; no unbounded `MATCH` that risks a Cartesian product.
- [ ] **CRS hygiene** — coordinates normalized to WGS84 at ingestion; no Cartesian/WGS84 mixing in a single predicate; precision truncated to routing tolerance.
- [ ] **Algorithm fit** — A\* for point-to-point, Dijkstra for cost-to-all-targets, contraction hierarchies only on stable graphs; GDS projections rebuilt on topology change.
- [ ] **Routing correctness** — geodesic plausibility check on returned paths; degree/connectivity audit flagging orphans and one-way traps.
- [ ] **Monitoring hooks** — alarms on pool utilization, index page-fault rate, GC pause duration, and p99 query latency.

## Related guides

- [Distance Filter Query Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/) — two-stage bounding-box-plus-distance pruning that keeps radius searches index-backed.
- [K-Nearest Neighbor Routing](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/k-nearest-neighbor-routing/) — streaming priority-queue expansion and traffic-weighted nearest-node search.
- [Spatial Join Techniques](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/spatial-join-techniques/) — correlating two spatial sets without a Cartesian product.
- [Cypher Performance Tuning](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/) — `EXPLAIN`/`PROFILE` analysis, index hints, and memory-constrained aggregation.
- [Isochrone and Service-Area Analysis](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/isochrone-and-service-area-analysis/) — cost-bounded traversal that returns everywhere reachable within a time or distance budget.
- [Spatial Indexing Strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) — choosing R-tree, geohash, or quadtree indexes behind these queries.

This guide is a companion track in the [Python for Spatial Graph Databases & Network Routing](https://www.spatialgraphdatabases.org/) knowledge base; it builds on [Spatial Graph Database Fundamentals for Python](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/), feeds the loaders documented under [Spatial Graph Construction & OSM Ingestion](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/), and supplies the query layer for [Network Routing Algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/).

For official implementation details, consult the [Neo4j Cypher Manual on Spatial Indexes](https://neo4j.com/docs/cypher-manual/current/indexes-for-search-performance/#indexes-spatial) and Python's [asyncio documentation](https://docs.python.org/3/library/asyncio.html) for event-loop scheduling.
