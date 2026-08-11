---
pageTitle: Spatial Graph DB Fundamentals Python
title: Spatial Graph Database Fundamentals for Python
description: Architecture, schema design, async Neo4j integration, indexing, routing algorithms, and failure hardening for production spatial graph systems in Python.
slug: spatial-graph-database-fundamentals-for-python
type: overview
breadcrumb: Fundamentals for Python
datePublished: 2025-09-15
dateModified: 2026-06-26
---
# Spatial Graph Database Fundamentals for Python

Production routing systems break in three predictable ways: spatial resolution drifts and returns the wrong nearest node, traversal latency spikes the moment a query plan skips the index, and one tenant's data leaks into another's route response. This guide is for backend and data engineers who own those failure modes — the people wiring logistics, mobility, and spatial analytics pipelines on top of a graph engine. It covers how to model coordinate geometry as graph topology, design schemas that stay queryable at tens of millions of nodes, drive the database from async Python without starving the connection pool, choose the right spatial index and traversal algorithm, and harden the whole stack against the corruption and contention that only show up under load.

The pipeline below sketches how a routing request flows through these layers — coordinates are projected, anchored to a spatial index, planned through the topology, then traversed under cost constraints:

<svg viewBox="-8 -8 924 156" role="img" aria-label="Routing request pipeline across six stages: raw WGS84 coordinates, projection and snapping, spatial index lookup, query planner cost model, graph traversal with Dijkstra or A star, and a returned route plus its cost." xmlns="http://www.w3.org/2000/svg">
  <title>Routing request pipeline across the spatial graph stack</title>
  <desc>A left-to-right flow of six stages. Coordinates are projected and snapped, anchored to an R-tree or point spatial index, planned by a cost-based optimizer, traversed by a shortest-path algorithm, then returned as a route with its total cost.</desc>
  <defs>
    <marker id="pipe-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <rect class="viz-backdrop" x="-8" y="-8" width="924" height="156" fill="var(--viz-bg,#ffffff)"/>
  <g font-family="inherit" fill="currentColor">
    <g font-size="11" letter-spacing="0.5" fill="currentColor" opacity="0.7" text-anchor="middle">
      <text x="74" y="20">INPUT</text>
      <text x="226" y="20">PREPARE</text>
      <text x="378" y="20">INDEX</text>
      <text x="530" y="20">PLAN</text>
      <text x="682" y="20">TRAVERSE</text>
      <text x="834" y="20">OUTPUT</text>
    </g>
    <g stroke-width="2" fill="var(--surface-2)">
      <rect x="8"   y="40" width="132" height="92" rx="10" stroke="var(--ink-soft)"/>
      <rect x="160" y="40" width="132" height="92" rx="10" stroke="var(--ink-soft)"/>
      <rect x="312" y="40" width="132" height="92" rx="10" stroke="var(--accent)"/>
      <rect x="464" y="40" width="132" height="92" rx="10" stroke="var(--accent-4)"/>
      <rect x="616" y="40" width="132" height="92" rx="10" stroke="var(--accent-3)"/>
      <rect x="768" y="40" width="132" height="92" rx="10" stroke="var(--accent-2)"/>
    </g>
    <g font-size="13.5" text-anchor="middle" fill="currentColor">
      <text x="74"  y="82">Raw</text><text x="74"  y="100">coordinates</text>
      <text x="226" y="82">Projection</text><text x="226" y="100">&amp; snapping</text>
      <text x="378" y="82">Spatial index</text><text x="378" y="100">R-tree / point</text>
      <text x="530" y="82">Query planner</text><text x="530" y="100">cost model</text>
      <text x="682" y="82">Graph traversal</text><text x="682" y="100">Dijkstra / A*</text>
      <text x="834" y="82">Route</text><text x="834" y="100">+ cost</text>
    </g>
    <g stroke="currentColor" stroke-width="2" fill="none" marker-end="url(#pipe-arrow)">
      <path d="M140 86 H158"/>
      <path d="M292 86 H310"/>
      <path d="M444 86 H462"/>
      <path d="M596 86 H614"/>
      <path d="M748 86 H766"/>
    </g>
  </g>
</svg>

## Concept and Architecture

Graph engines represent physical space through directed relationships between vertices and edges. Unlike relational spatial databases that bolt a B-tree or GiST spatial extension onto a tabular layout, a spatial graph database embeds adjacency directly into the storage layout: each node holds pointers to its incident relationships, so neighbor resolution is a pointer chase rather than an index join. Coordinates attach to primitives via native `point` types, WKT strings, or binary encodings. The adjacency-list structure gives effectively O(1) neighbor expansion, while a separate spatial layer maintains bounding-volume hierarchies for range and nearest-neighbor queries.

That distinction matters because routing is fundamentally a connectivity problem, not a set-intersection problem. In a relational model, a shortest path of depth *k* requires *k* self-joins on an edge table, and the planner re-evaluates join cardinality at every hop. In a graph model the same traversal is a sequence of constant-time hops, and the spatial index is consulted only at the endpoints — to anchor the origin and destination — rather than at every intermediate step. For dense road networks where the average path crosses dozens of intersections, this is the difference between a query that returns in milliseconds and one that times out.

Memory allocation scales non-linearly with graph density. Storing 64-bit floats per vertex for latitude and longitude consumes significant heap space, and in dense urban networks where node counts exceed tens of millions the adjacency metadata frequently dwarfs the coordinate payload itself. Concurrency bottlenecks emerge when multiple routing threads lock shared spatial buffers or compete for page-cache residency. Production Python services mitigate this through asynchronous connection pooling and batched ingestion pipelines that stream coordinates rather than materializing full arrays in memory — the construction side of this is covered in depth under [Spatial Graph Construction & OSM Ingestion](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/).

<svg viewBox="0 0 920 320" role="img" aria-label="Side-by-side comparison. The relational edge model needs k self-joins for a k-hop path and probes the spatial index at every hop. The graph adjacency model uses constant-time pointer hops between neighbours and probes the spatial index only at the origin and destination endpoints." xmlns="http://www.w3.org/2000/svg">
  <title>Relational edge joins versus graph adjacency traversal</title>
  <desc>Left: a relational model where each hop of a path is a self-join on the edge table, with a spatial index probe at every hop. Right: a graph model where neighbour expansion is a constant-time pointer chase from origin to destination, with the spatial index probed only at the two endpoints.</desc>
  <defs>
    <marker id="rel-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <rect class="viz-backdrop" x="0" y="0" width="920" height="320" fill="var(--viz-bg,#ffffff)"/>
  <g font-family="inherit" fill="currentColor">
    <rect x="6"   y="6" width="446" height="308" rx="12" fill="var(--surface-2)" stroke="var(--line)"/>
    <rect x="468" y="6" width="446" height="308" rx="12" fill="var(--surface-2)" stroke="var(--line)"/>
    <text x="30" y="38" font-size="16" font-weight="600">Relational edge model</text>
    <text x="492" y="38" font-size="16" font-weight="600">Graph adjacency model</text>
    <!-- left: stacked self-joins -->
    <g font-size="13">
      <g>
        <rect x="30" y="58" width="300" height="34" rx="7" fill="var(--surface-3)" stroke="var(--line)"/>
        <text x="46" y="80">self-join &#183; edge hop 1</text>
        <rect x="346" y="62" width="56" height="26" rx="5" fill="var(--accent)"/>
        <text x="374" y="80" fill="var(--viz-on-pill,#ffffff)" text-anchor="middle" font-size="11">IDX</text>
      </g>
      <g>
        <rect x="30" y="100" width="300" height="34" rx="7" fill="var(--surface-3)" stroke="var(--line)"/>
        <text x="46" y="122">self-join &#183; edge hop 2</text>
        <rect x="346" y="104" width="56" height="26" rx="5" fill="var(--accent)"/>
        <text x="374" y="122" fill="var(--viz-on-pill,#ffffff)" text-anchor="middle" font-size="11">IDX</text>
      </g>
      <text x="180" y="160" text-anchor="middle" font-size="18" opacity="0.6">&#8942;</text>
      <g>
        <rect x="30" y="170" width="300" height="34" rx="7" fill="var(--surface-3)" stroke="var(--line)"/>
        <text x="46" y="192">self-join &#183; edge hop k</text>
        <rect x="346" y="174" width="56" height="26" rx="5" fill="var(--accent)"/>
        <text x="374" y="192" fill="var(--viz-on-pill,#ffffff)" text-anchor="middle" font-size="11">IDX</text>
      </g>
    </g>
    <text x="30" y="246" font-size="12.5" fill="var(--ink-soft)">k self-joins for a k-hop path;</text>
    <text x="30" y="266" font-size="12.5" fill="var(--ink-soft)">the planner re-estimates cardinality</text>
    <text x="30" y="286" font-size="12.5" fill="var(--ink-soft)">and probes the spatial index every hop.</text>
    <!-- right: pointer-chase adjacency -->
    <g>
      <g fill="var(--accent-3)">
        <circle cx="520" cy="120" r="16"/>
        <circle cx="840" cy="150" r="16"/>
      </g>
      <g fill="var(--surface-2)" stroke="var(--ink-soft)" stroke-width="2">
        <circle cx="600" cy="95" r="13"/>
        <circle cx="680" cy="150" r="13"/>
        <circle cx="760" cy="100" r="13"/>
      </g>
      <g stroke="currentColor" stroke-width="2" fill="none" marker-end="url(#rel-arrow)">
        <path d="M535 116 L587 99"/>
        <path d="M611 105 L669 141"/>
        <path d="M692 145 L748 106"/>
        <path d="M772 107 L825 142"/>
      </g>
      <text x="520" y="124" fill="var(--viz-on-pill,#ffffff)" text-anchor="middle" font-size="12" font-weight="600">O</text>
      <text x="840" y="154" fill="var(--viz-on-pill,#ffffff)" text-anchor="middle" font-size="12" font-weight="600">D</text>
      <text x="520" y="156" text-anchor="middle" font-size="11" fill="var(--ink-soft)">origin</text>
      <text x="840" y="186" text-anchor="middle" font-size="11" fill="var(--ink-soft)">destination</text>
      <g font-size="11">
        <rect x="492" y="58" width="56" height="24" rx="5" fill="var(--accent)"/>
        <text x="520" y="74" fill="var(--viz-on-pill,#ffffff)" text-anchor="middle">IDX</text>
        <rect x="812" y="206" width="56" height="24" rx="5" fill="var(--accent)"/>
        <text x="840" y="222" fill="var(--viz-on-pill,#ffffff)" text-anchor="middle">IDX</text>
      </g>
    </g>
    <text x="492" y="266" font-size="12.5" fill="var(--ink-soft)">O(1) pointer hops between neighbours;</text>
    <text x="492" y="286" font-size="12.5" fill="var(--ink-soft)">the spatial index is consulted only at O and D.</text>
  </g>
</svg>

## Schema Design

A spatial graph schema is two decisions made together: how geometry attaches to nodes, and how semantics attach to relationships. Get either wrong and every downstream query pays for it.

**Node property model.** Anchor every spatial node on a native point property rather than separate float fields. In Neo4j, `point({latitude: $lat, longitude: $lon})` with the WGS84 CRS lets the planner use a point index for distance and bounding-box predicates; storing bare `lat`/`lon` floats forces range scans on two independent indexes that the planner cannot combine. Keep a stable, application-assigned `id` (not the internal element id) so external systems and ingestion jobs can upsert idempotently:

```cypher
CREATE CONSTRAINT node_id_unique IF NOT EXISTS
FOR (n:Node) REQUIRE n.id IS UNIQUE;

CREATE POINT INDEX node_location IF NOT EXISTS
FOR (n:Node) ON (n.location);
```

**Edge property model and direction.** Relationships carry the routing cost and the access semantics. Store impedance as a precomputed scalar (`impedance_km`, or seconds for time-based routing) so traversal never recomputes geometry mid-query. Direction is load-bearing: a one-way street is a single `(:Node)-[:ROUTE]->(:Node)` relationship, while a bidirectional segment is two relationships or one relationship queried without a direction arrow. Encode turn restrictions and temporal access windows as edge properties (`profile`, `valid_from`, `valid_to`) rather than as separate nodes, unless turn penalties demand an expanded edge-based graph. The mechanics of deriving these relationships from raw geometry belong to [Node and Edge Spatial Mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/), which covers snapping tolerance, intersection detection, and directional consistency.

**Tenant isolation.** When designing multi-tenant routing platforms, logical isolation must map cleanly to physical structure. The two viable patterns are a `tenant_id` property on every node and edge (cheap to write, requires disciplined query filters) and label-per-tenant or database-per-tenant partitioning (stronger isolation, heavier operationally). A `tenant_id` predicate must be paired with a composite index so the filter is index-resolved, not applied post-scan. The trade-offs, and how access control integrates with spatial predicates so a route never crosses a tenant boundary, are detailed in [Spatial Security Boundaries](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-security-boundaries/).

```cypher
CREATE INDEX node_tenant IF NOT EXISTS
FOR (n:Node) ON (n.tenant_id);
```

<svg viewBox="0 0 920 360" role="img" aria-label="Property-graph schema. Two Node entities each carry an id constrained unique, a location point property backed by a point index, and a tenant_id backed by an index. A directed ROUTE relationship between them carries impedance_km, profile, valid_from, and valid_to properties." xmlns="http://www.w3.org/2000/svg">
  <title>Spatial property-graph schema: Node entities and a directed ROUTE relationship</title>
  <desc>Two Node cards joined by a directed ROUTE relationship. Each Node lists id with a unique constraint, location as an indexed point, and tenant_id as an indexed string. The ROUTE edge card lists impedance_km, profile, valid_from, and valid_to. Badges mark which properties are index-backed.</desc>
  <defs>
    <marker id="schema-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <rect class="viz-backdrop" x="0" y="0" width="920" height="360" fill="var(--viz-bg,#ffffff)"/>
  <g font-family="inherit" fill="currentColor">
    <!-- left node card -->
    <g>
      <rect x="20" y="40" width="260" height="150" rx="12" fill="var(--surface-2)" stroke="var(--accent-3)" stroke-width="2"/>
      <rect x="20" y="40" width="260" height="34" rx="12" fill="var(--accent-3)"/>
      <rect x="20" y="58" width="260" height="16" fill="var(--accent-3)"/>
      <text x="36" y="63" fill="var(--viz-on-pill,#ffffff)" font-size="14" font-weight="600">:Node</text>
      <g font-size="13">
        <text x="36" y="100">id : string</text>
        <rect x="190" y="86" width="74" height="20" rx="5" fill="var(--accent-2)"/>
        <text x="227" y="100" fill="var(--viz-on-pill,#ffffff)" text-anchor="middle" font-size="10.5">UNIQUE</text>
        <text x="36" y="134">location : point</text>
        <rect x="198" y="120" width="66" height="20" rx="5" fill="var(--accent)"/>
        <text x="231" y="134" fill="var(--viz-on-pill,#ffffff)" text-anchor="middle" font-size="10.5">INDEX</text>
        <text x="36" y="168">tenant_id : string</text>
        <rect x="198" y="154" width="66" height="20" rx="5" fill="var(--accent)"/>
        <text x="231" y="168" fill="var(--viz-on-pill,#ffffff)" text-anchor="middle" font-size="10.5">INDEX</text>
      </g>
    </g>
    <!-- right node card -->
    <g>
      <rect x="640" y="40" width="260" height="150" rx="12" fill="var(--surface-2)" stroke="var(--accent-3)" stroke-width="2"/>
      <rect x="640" y="40" width="260" height="34" rx="12" fill="var(--accent-3)"/>
      <rect x="640" y="58" width="260" height="16" fill="var(--accent-3)"/>
      <text x="656" y="63" fill="var(--viz-on-pill,#ffffff)" font-size="14" font-weight="600">:Node</text>
      <g font-size="13">
        <text x="656" y="100">id : string</text>
        <rect x="810" y="86" width="74" height="20" rx="5" fill="var(--accent-2)"/>
        <text x="847" y="100" fill="var(--viz-on-pill,#ffffff)" text-anchor="middle" font-size="10.5">UNIQUE</text>
        <text x="656" y="134">location : point</text>
        <rect x="818" y="120" width="66" height="20" rx="5" fill="var(--accent)"/>
        <text x="851" y="134" fill="var(--viz-on-pill,#ffffff)" text-anchor="middle" font-size="10.5">INDEX</text>
        <text x="656" y="168">tenant_id : string</text>
        <rect x="818" y="154" width="66" height="20" rx="5" fill="var(--accent)"/>
        <text x="851" y="168" fill="var(--viz-on-pill,#ffffff)" text-anchor="middle" font-size="10.5">INDEX</text>
      </g>
    </g>
    <!-- directed ROUTE relationship -->
    <path d="M286 115 H634" stroke="currentColor" stroke-width="2.5" fill="none" marker-end="url(#schema-arrow)"/>
    <rect x="412" y="100" width="96" height="26" rx="6" fill="var(--surface)" stroke="var(--accent-4)" stroke-width="2"/>
    <text x="460" y="118" text-anchor="middle" font-size="13" font-weight="600">:ROUTE</text>
    <!-- edge property card -->
    <g>
      <rect x="320" y="200" width="280" height="142" rx="12" fill="var(--surface-2)" stroke="var(--accent-4)" stroke-width="2"/>
      <rect x="320" y="200" width="280" height="32" rx="12" fill="var(--viz-ok,#8a6d00)"/>
      <rect x="320" y="216" width="280" height="16" fill="var(--viz-ok,#8a6d00)"/>
      <text x="336" y="222" fill="var(--viz-on-pill,#ffffff)" font-size="13" font-weight="600">:ROUTE properties</text>
      <g font-size="13">
        <text x="336" y="258">impedance_km : float</text>
        <text x="336" y="284">profile : string</text>
        <text x="336" y="310">valid_from : date</text>
        <text x="336" y="334">valid_to : date</text>
      </g>
    </g>
    <path d="M460 126 V198" stroke="var(--accent-4)" stroke-width="1.5" stroke-dasharray="4 4" fill="none"/>
  </g>
</svg>

## Core Python Integration

The driver layer is where most production incidents originate — not in Cypher, but in how Python acquires, scopes, and releases sessions. Use the official `neo4j` async driver, create exactly one driver per process (it is a connection-pool manager, not a connection), and scope each unit of work to its own `session`. The driver below sets a bounded pool, an acquisition timeout so a saturated pool fails fast instead of hanging, and a connection lifetime that recycles sockets ahead of load-balancer idle limits.

```python
import asyncio
import math
from dataclasses import dataclass
from typing import Any, Dict, Optional

from neo4j import AsyncDriver, AsyncGraphDatabase


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in kilometers (mean Earth radius, WGS84 approximation)."""
    R = 6371.0088
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def init_graph_driver(uri: str, user: str, password: str, pool_size: int = 20) -> AsyncDriver:
    """Production-grade Neo4j async driver with a bounded connection pool."""
    return AsyncGraphDatabase.driver(
        uri,
        auth=(user, password),
        max_connection_pool_size=pool_size,
        connection_acquisition_timeout=15.0,
        max_connection_lifetime=300,
    )


@dataclass
class RoutingQuery:
    origin_id: str
    dest_id: str
    origin_lat: float
    origin_lon: float
    dest_lat: float
    dest_lon: float
    max_cost_km: float
    vehicle_profile: str


async def execute_spatial_routing(
    driver: AsyncDriver, query: RoutingQuery
) -> Optional[Dict[str, Any]]:
    """Async spatial routing with a bounding-box pre-filter and cost-aware traversal."""
    # Bounding box for spatial index pruning (EPSG:4326). ~0.05deg margin ≈ 5.5km buffer.
    margin = 0.05
    bbox_params = {
        "min_lat": min(query.origin_lat, query.dest_lat) - margin,
        "max_lat": max(query.origin_lat, query.dest_lat) + margin,
        "min_lon": min(query.origin_lon, query.dest_lon) - margin,
        "max_lon": max(query.origin_lon, query.dest_lon) + margin,
    }

    cypher = """
    MATCH (o:Node {id: $origin_id})
    MATCH (d:Node {id: $dest_id})
    WHERE o.location.latitude  >= $min_lat AND o.location.latitude  <= $max_lat
      AND o.location.longitude >= $min_lon AND o.location.longitude <= $max_lon
    MATCH path = shortestPath((o)-[:ROUTE*..50]->(d))
    WHERE ALL(e IN relationships(path) WHERE e.profile = $profile)
    WITH path,
         reduce(c = 0.0, e IN relationships(path) | c + e.impedance_km) AS total_cost
    WHERE total_cost < $max_cost
    RETURN path, total_cost
    ORDER BY total_cost ASC
    LIMIT 1
    """

    async with driver.session() as session:
        result = await session.run(
            cypher,
            origin_id=query.origin_id,
            dest_id=query.dest_id,
            profile=query.vehicle_profile,
            max_cost=query.max_cost_km,
            **bbox_params,
        )
        record = await result.single()

        if record is None:
            return None

        # Geodesic validation: planned cost vs straight-line distance.
        path = record["path"]
        nodes = list(path.nodes)
        if len(nodes) >= 2:
            start, end = nodes[0], nodes[-1]
            actual_km = haversine_km(
                start["location"].latitude, start["location"].longitude,
                end["location"].latitude, end["location"].longitude,
            )
            print(f"Geodesic check: straight-line {actual_km:.3f} km / planned {record['total_cost']:.3f} km")

        return {"path": path, "total_cost": record["total_cost"]}


async def main():
    driver = init_graph_driver("neo4j://localhost:7687", "neo4j", "secure_password")
    try:
        query = RoutingQuery(
            origin_id="node_42",
            dest_id="node_99",
            origin_lat=40.7128, origin_lon=-74.0060,
            dest_lat=40.7580, dest_lon=-73.9855,
            max_cost_km=15.0,
            vehicle_profile="heavy_freight",
        )
        route = await execute_spatial_routing(driver, query)
        print(f"Resolved route: {route is not None}")
    finally:
        await driver.close()


if __name__ == "__main__":
    asyncio.run(main())
```

The example demonstrates several patterns that recur across every page on this site:

1. **One driver, many sessions.** The driver is built once and closed in a `finally` block; each request opens its own `async with driver.session()` context so transactions never share state. Acquisition timeout converts pool exhaustion into a fast, catchable error instead of an unbounded await.
2. **Spatial index pruning before expansion.** The bounding-box filter on `o.location` runs against the point index, so `shortestPath` only expands from candidates inside the corridor — reducing traversal fan-out by orders of magnitude.
3. **Cost-aware filtering during traversal.** Edge impedance is aggregated with `reduce` and bounded by `max_cost`, eliminating over-budget paths inside the query rather than in Python.
4. **Geodesic validation after the fact.** A post-query Haversine check compares the planned cost against straight-line distance, catching topology errors where a path is implausibly longer than the crow-flies minimum.

## Indexing and Query Planning

Graph databases rely on spatial indexes to prune the search space before traversal begins. Without index-assisted pruning, a routing query degenerates into a full-graph scan that saturates CPU and I/O. The three structures you will actually choose between are R-trees, which provide balanced bounding-box hierarchies tuned for range and nearest-neighbor queries; geohash (or H3) encodings, which turn proximity into string-prefix matching and excel at sharding and cache locality; and quadtrees, which split dense regions recursively while staying shallow in sparse ones. Native Neo4j point indexes are R-tree-backed and are the correct default for most road and logistics graphs. The full decision framework — including write-amplification trade-offs and how bounding volumes should align with adjacency structure — lives in [Spatial Indexing Strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/).

Index choice is inseparable from planning. A cost-based optimizer estimates I/O, CPU, and index selectivity before committing to a plan, and the single most important behavior to verify is **predicate push-down**: the spatial filter must execute at the storage layer so the planner shrinks the candidate set before graph expansion, not after. Confirm this with `PROFILE` and look for a `NodeIndexSeekByRange` (or point-index seek) feeding the expansion, never a `NodeByLabelScan` followed by a `Filter`. When the planner picks the wrong starting point, an index hint or a restructured `MATCH` ordering forces it back. The systematic approach — reading `EXPLAIN`/`PROFILE` output, applying hints, and reshaping predicates so they are sargable — is the subject of [Graph Query Planner Optimization](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/).

For the cost model itself, distance is the recurring formula. For global routing, replace Euclidean approximations with the Haversine great-circle distance to account for the Earth's curvature:

$$d = 2R \cdot \arcsin\!\sqrt{\sin^2\!\frac{\Delta\varphi}{2} + \cos\varphi_1 \cos\varphi_2 \sin^2\!\frac{\Delta\lambda}{2}}$$

where $R$ is the mean Earth radius, $\varphi$ is latitude in radians, and $\lambda$ is longitude. This same value seeds the A\* heuristic discussed below, and it is the basis for the [distance filter query patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/) used to constrain candidate paths.

## Routing and Traversal Patterns

Once the endpoints are anchored and the corridor is pruned, the choice of traversal algorithm determines both correctness and latency. Four families cover almost every production case, and the right pick depends on graph size, query volume, and how often the topology changes.

**Breadth-first / `shortestPath`** is the built-in default and is correct when edges are unweighted or you only need hop count. It is the wrong tool the moment impedance varies, because it minimizes hops, not cost.

**Dijkstra** is the baseline for weighted shortest paths. It explores outward by cumulative cost and guarantees the optimal route, but it expands uniformly in all directions, so on a continental graph it can touch far more nodes than necessary. Use it when you have no admissible heuristic, when you need many targets at once (one-to-many cost surfaces), or when edge weights have no geometric interpretation.

**A\*** adds a heuristic — typically the straight-line Haversine distance to the destination — that biases expansion toward the goal. With an admissible (never-overestimating) heuristic it returns the same optimal path as Dijkstra while exploring a fraction of the nodes. It is the default choice for point-to-point routing on geographic graphs precisely because coordinates give you a free, admissible heuristic.

**Contraction hierarchies** (and related preprocessing schemes) trade build time for query speed. By precomputing shortcut edges over a node ordering, they answer point-to-point queries on country-scale road networks in microseconds — but the preprocessing must be rebuilt when the graph changes, so they fit static or slowly-changing topologies, not graphs under constant live edits.

The practical rule: start with A\* for interactive point-to-point routing, fall back to Dijkstra when no heuristic applies or you need cost-to-all-targets, and invest in contraction hierarchies only once query volume on a stable graph justifies the preprocessing cost. The full decision framework, with runnable implementations, lives in [Network Routing Algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/). Production implementations — including Neo4j GDS projections and hand-written Cypher variants — are covered across [Cypher Spatial Queries & Pathfinding Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/), and proximity-first patterns such as [k-nearest-neighbor routing](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/k-nearest-neighbor-routing/) layer on top of the same index foundation.

<svg viewBox="0 0 960 336" role="img" aria-label="Comparison matrix of four traversal algorithms across five criteria. shortestPath: minimizes hops only, low node expansion, no heuristic, no preprocessing, fits unweighted hop counts. Dijkstra: optimal, high node expansion, no heuristic, no preprocessing, fits no-heuristic and one-to-many queries. A star: optimal, low node expansion, needs an admissible heuristic, no preprocessing, fits point-to-point geographic routing and is the recommended default. Contraction hierarchies: optimal, very low node expansion, no heuristic, heavy preprocessing, fits static large road graphs." xmlns="http://www.w3.org/2000/svg">
  <title>Traversal algorithm selection matrix</title>
  <desc>A table comparing shortestPath, Dijkstra, A star, and contraction hierarchies across optimality, nodes expanded, heuristic requirement, preprocessing cost, and best-fit workload. The A star column is highlighted as the default for point-to-point geographic routing.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="960" height="336" fill="var(--viz-bg,#ffffff)"/>
  <g font-family="inherit" fill="currentColor">
    <!-- highlight A* column -->
    <rect x="568" y="8" width="192" height="306" fill="var(--accent)" opacity="0.08"/>
    <!-- header row backgrounds -->
    <g>
      <rect x="184" y="8" width="192" height="46" fill="var(--surface-3)"/>
      <rect x="376" y="8" width="192" height="46" fill="var(--surface-3)"/>
      <rect x="568" y="8" width="192" height="46" fill="var(--accent)"/>
      <rect x="760" y="8" width="192" height="46" fill="var(--surface-3)"/>
    </g>
    <!-- grid -->
    <g stroke="var(--line)" stroke-width="1" fill="none">
      <rect x="8" y="8" width="944" height="306"/>
      <line x1="184" y1="8" x2="184" y2="314"/>
      <line x1="376" y1="8" x2="376" y2="314"/>
      <line x1="568" y1="8" x2="568" y2="314"/>
      <line x1="760" y1="8" x2="760" y2="314"/>
      <line x1="8" y1="54" x2="952" y2="54"/>
      <line x1="8" y1="106" x2="952" y2="106"/>
      <line x1="8" y1="158" x2="952" y2="158"/>
      <line x1="8" y1="210" x2="952" y2="210"/>
      <line x1="8" y1="262" x2="952" y2="262"/>
    </g>
    <!-- column headers -->
    <g font-size="13.5" font-weight="600" text-anchor="middle">
      <text x="280" y="35">shortestPath</text>
      <text x="472" y="35">Dijkstra</text>
      <text x="664" y="28" fill="var(--viz-on-pill,#ffffff)">A*</text>
      <text x="664" y="46" fill="var(--viz-on-pill,#ffffff)" font-size="10" font-weight="400">recommended default</text>
      <text x="856" y="28">Contraction</text>
      <text x="856" y="46" font-size="11" font-weight="400">hierarchies</text>
    </g>
    <!-- row headers -->
    <g font-size="13" font-weight="600">
      <text x="24" y="85">Optimality</text>
      <text x="24" y="137">Nodes expanded</text>
      <text x="24" y="189">Needs heuristic</text>
      <text x="24" y="241">Preprocessing</text>
      <text x="24" y="293">Best-fit workload</text>
    </g>
    <!-- cells -->
    <g font-size="12.5" text-anchor="middle" fill="currentColor">
      <!-- Optimality -->
      <text x="280" y="85">hops only</text>
      <text x="472" y="85">optimal</text>
      <text x="664" y="85">optimal</text>
      <text x="856" y="85">optimal</text>
      <!-- Nodes expanded -->
      <text x="280" y="137">low (BFS)</text>
      <text x="472" y="137">high</text>
      <text x="664" y="137">low</text>
      <text x="856" y="137">very low</text>
      <!-- Needs heuristic -->
      <text x="280" y="189">no</text>
      <text x="472" y="189">no</text>
      <text x="664" y="189">yes (admissible)</text>
      <text x="856" y="189">no</text>
      <!-- Preprocessing -->
      <text x="280" y="241">none</text>
      <text x="472" y="241">none</text>
      <text x="664" y="241">none</text>
      <text x="856" y="241">heavy (rebuild)</text>
      <!-- Best-fit workload -->
      <text x="280" y="287">unweighted /</text><text x="280" y="303">hop count</text>
      <text x="472" y="287">no heuristic;</text><text x="472" y="303">1-to-many</text>
      <text x="664" y="287">point-to-point</text><text x="664" y="303">geographic</text>
      <text x="856" y="287">static large</text><text x="856" y="303">road graphs</text>
    </g>
  </g>
</svg>

## Coordinate Reference Systems in Practice

Almost every spatial defect that reaches production in a graph database is, underneath, a coordinate reference system that was assumed rather than asserted. The symptoms look unrelated — a distance filter that returns nothing, a path whose total length is plausible but wrong, a route that prefers one direction over another for no reason a map explains — and they all come back to the same question: what does this pair of numbers mean, and is it the same thing as the pair it is being compared against?

Neo4j settles the ambiguity by making the reference system part of the value. A `point({latitude, longitude})` is a WGS 84 geographic point, SRID 4326, and its `point.distance()` is a geodesic measure returning metres on the ellipsoid. A `point({x, y})` is Cartesian, SRID 7203, and its distance is plain Euclidean in whatever unit the caller happened to be thinking in. The two are not interchangeable and the database will not pretend they are: comparing across them yields `null` rather than a wrong number, which is the correct behaviour and also the reason the failure is quiet. A `null` in a `WHERE` is not `false`, it is unknown, so the row is dropped — the query succeeds, returns fewer rows than it should, and reports nothing. A graph that mixes both types in one `location` property therefore does not fail on the mixed rows; it silently excludes them, and the excluded set grows as ingestion drifts.

The practical rule is to pick geographic storage and never store anything else on the routing graph. WGS 84 is what the sources emit, it is what the point index is built over, and it is the frame in which `point.distance()` means what a router needs it to mean. Projection is a presentation concern: reproject to Web Mercator or a local grid at the edge of the system, for a map tile or a rendering library, and let the result die there. The failure mode of the opposite arrangement — projecting on the way in, so the graph stores planar coordinates — is that planar distance is not ground distance. Web Mercator stretches the north–south axis by a factor that grows with latitude, so an edge weight derived from planar length is inflated in one direction and not the other. A shortest-path search minimising those weights does not merely report the wrong number of metres; it develops a systematic preference for east–west edges, and the route itself changes.

Two habits make the whole class of problem visible early. Assert the axis ranges at ingestion, tightly and separately — latitude within ±90, longitude within ±180 — because the single most common ordering bug swaps them, and a swapped pair often stays inside a loose combined check while landing in the wrong hemisphere. And validate that a `location` property holds exactly one type across the label, because the mixed-CRS graph is the one whose distance filters quietly under-return, and no index, hint or plan will reveal it.

## Performance and Scale

Spatial graph performance is a budget problem across three resources: heap, page cache, and the connection pool.

**Memory budgets.** Coordinate precision drives index depth. High-precision WGS84 coordinates deepen point-index trees and lower cache-hit ratios; truncating to five decimal places (~1.1 m at the equator) is usually accurate enough for road routing and meaningfully reduces index size. Size the page cache to hold the hot index pages and the most-traversed regions of the graph — if routing working sets spill to disk, p99 latency collapses. Keep the JVM heap separate and bounded; oversized heaps lengthen GC pauses that show up as periodic latency spikes.

**Write amplification.** Every edge insert touches the spatial index, and under high-density urban grids the resulting node splits dominate write cost. Batch writes in bounded transactions (a few thousand operations each) so the index amortizes splits, and prefer append-then-reindex over interleaved single-row upserts during bulk loads.

**Batch versus streaming ingestion.** Materializing an entire network in memory before loading is the most common out-of-memory failure. Stream features through generators with backpressure so the importer's footprint stays flat regardless of dataset size; the async patterns for this are detailed under [async batch processing for graphs](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/async-batch-processing-for-graphs/) and the end-to-end loaders under [OSM data ingestion pipelines](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/osm-data-ingestion-pipelines/).

**GC pressure and concurrency.** On the Python side, size `max_connection_pool_size` to match the server's effective query concurrency, not the number of application coroutines — an oversized pool simply moves contention from the client to the server's lock manager. On the server side, watch for GC pauses correlated with large intermediate result sets; the fix is almost always pushing filters down so fewer rows are materialized, which ties back to [cypher performance tuning](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/).

## Failure Modes and Hardening

Most spatial graph outages are one of four shapes. Knowing the symptom-to-cause mapping turns a 2 a.m. page into a checklist.

**Topology corruption.** Self-intersecting geometries, duplicate coordinates, and misaligned directional edges create phantom paths that produce wrong-but-plausible routes. The geodesic check in the integration code above is your tripwire: when planned cost wildly exceeds straight-line distance, a topology defect is the usual cause. Harden against it by enforcing snapping tolerance and directional consistency at ingestion, and by running periodic degree-and-connectivity audits that flag orphaned nodes and one-way traps.

**Index fragmentation.** Frequent edge mutations leave the spatial index unbalanced, and range-query latency creeps up until background compaction catches up. The recovery playbook is to schedule online index rebuilds during low-traffic windows, monitor index page-fault rates, and prefer deferred or batched index updates on write-heavy partitions. The maintenance specifics sit alongside [Spatial Indexing Strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/).

**Connection pool exhaustion.** A leaked session, a slow query holding a connection, or a pool sized below real concurrency all present the same way: requests hang, then fail at the acquisition timeout. The `connection_acquisition_timeout` in the driver setup converts this from a hang into a fast error you can shed load on. Recovery is to cap query time with transaction timeouts, ensure every session is opened in an `async with` block so it is always released, and alarm on pool-utilization percentage rather than on errors after the fact.

**Cross-tenant leakage.** A missing `tenant_id` predicate, or one applied after the scan, lets a route cross into another tenant's subgraph. Treat the tenant filter as a security control, not a query convenience: enforce it in a query-builder layer, index it so it is resolved at the storage tier, and add assertion tests that a route request scoped to tenant A can never return a node owned by tenant B. The enforcement patterns are in [Spatial Security Boundaries](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-security-boundaries/).

## Operational Checklist

Use this as a pre-production gate and a recurring health review:

- [ ] **Schema validation** — uniqueness constraint on `Node.id`; point index on `location`; composite/`tenant_id` index present and used (verify with `PROFILE`).
- [ ] **Index warm-up** — hot index and graph regions resident in page cache before serving traffic; cold-start latency measured, not assumed.
- [ ] **Pool sizing** — `max_connection_pool_size` matched to server query concurrency; `connection_acquisition_timeout` set; every session opened in `async with`.
- [ ] **Predicate push-down** — spatial and tenant filters confirmed as index seeks in `PROFILE` output, never label-scan-then-filter.
- [ ] **Coordinate hygiene** — CRS normalized at ingestion; precision truncated to the routing tolerance; snapping and directional consistency enforced.
- [ ] **Ingestion safety** — writes batched in bounded transactions; streaming importer with backpressure; periodic reindex scheduled.
- [ ] **Routing correctness** — geodesic plausibility check on returned paths; degree/connectivity audit job flagging orphans and one-way traps.
- [ ] **Tenant isolation** — assertion tests proving no cross-tenant node ever appears in a scoped route response.
- [ ] **Monitoring hooks** — alarms on pool utilization, index page-fault rate, GC pause duration, and p99 query latency.

## Related guides

- [Node and Edge Spatial Mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/) — turning raw geometry into validated, directional topology.
- [Spatial Indexing Strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) — choosing and maintaining R-tree, geohash, and quadtree indexes.
- [Graph Query Planner Optimization](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/) — forcing predicate push-down and reading `EXPLAIN`/`PROFILE`.
- [Spatial Security Boundaries](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-security-boundaries/) — multi-tenant isolation and access-controlled routing.
- [Cypher Spatial Queries & Pathfinding Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/) — production routing queries, distance filters, and KNN search.

This guide anchors the [Python for Spatial Graph Databases & Network Routing](https://www.spatialgraphdatabases.org/) knowledge base; its companion tracks are [Cypher Spatial Queries & Pathfinding Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/), [Spatial Graph Construction & OSM Ingestion](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/), and [Network Routing Algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/).
