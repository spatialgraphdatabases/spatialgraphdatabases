---
pageTitle: Spatial Security Boundaries in Graphs
title: Spatial Security Boundaries
description: Constrain graph routing to geographic and administrative perimeters in Neo4j — boundary-stamped edges, predicate-before-expansion Cypher, and async Python enforcement.
slug: spatial-security-boundaries
type: guide
breadcrumb: Spatial Security Boundaries
datePublished: 2025-09-22
dateModified: 2026-06-26
---
# Spatial Security Boundaries: Production Workflows for Graph-Based Access Control

A routing engine that ignores geographic perimeters will happily return the cheapest path — straight through a restricted military zone, a competitor's exclusive delivery territory, or a toll cordon the customer never agreed to pay. Spatial security boundaries are the engineering control that prevents this: they constrain graph traversal and shortest-path computation to a set of explicitly permitted geographic or administrative regions, so a route is rejected the moment it would cross an unauthorized segment rather than after an expensive client-side audit. The failure cost is concrete and asymmetric. A single leaked path can breach a service-level agreement, expose another tenant's network topology, or send a vehicle into a regulated area — and because the violation is *correct* shortest-path output, it never trips a unit test that only checks reachability. This guide covers how to stamp boundaries onto graph edges, how to make the planner resolve those boundaries *before* it expands a frontier, and how to enforce all of it from async Python without sacrificing routing latency.

This guide is part of [Spatial Graph Database Fundamentals for Python](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/), and it builds directly on the topology produced by [node and edge spatial mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/) — every boundary check below assumes edges already carry stable identities and indexed geometry.

## Prerequisites

Boundary enforcement is a Cypher-and-Python pattern layered on the async Neo4j driver. The polygon-to-edge assignment step depends on `shapely` for containment tests, and the optional region-scoped routing path uses the Graph Data Science plugin's relationship filtering.

| Requirement | Minimum version | Notes |
| --- | --- | --- |
| Python | 3.10+ | Union types (`dict \| None`), structural `match` |
| Neo4j | 5.13+ | Native `point` type and point indexes |
| neo4j (driver) | 5.x | Async driver (`AsyncGraphDatabase`) |
| graphdatascience / GDS plugin | 2.5+ | Only for boundary-filtered Dijkstra projections |
| shapely | 2.0+ | Polygon containment for boundary stamping |
| pyproj | 3.6+ | CRS alignment before containment tests |

```bash
pip install "neo4j>=5.18" "shapely>=2.0" "pyproj>=3.6"
```

Before any enforcement logic runs, confirm that the boundary polygons and the graph geometry share a coordinate reference system. A containment test between a WGS 84 segment and a Web Mercator polygon silently returns wrong answers, and a misassigned `boundary_id` is far harder to detect than a crash.

## Core Concept & Mechanism

A spatial security boundary is, mechanically, a set membership stamped onto the graph. Each routable edge is tagged with the identifier of the region it lies inside; each request carries the set of regions the caller is permitted to traverse. Enforcement reduces to a single invariant: **every relationship in a returned path must belong to the permitted set.** The subtlety is not the predicate — it is *when* the predicate runs.

There are two places a boundary check can happen, and only one of them is safe at scale:

1. **Post-traversal filtering.** The engine computes a shortest path, then the application discards it if any segment is out of bounds. This is correct but ruinous: the planner explores and ranks paths it will throw away, latency tracks the *unconstrained* graph size, and a disconnected permitted region can force the engine to traverse the entire network before discovering there is no legal route.
2. **Predicate-before-expansion.** The boundary set is pushed into the traversal itself, so an out-of-bounds edge is never added to the frontier. The candidate space collapses to the permitted region, and the cost of enforcement is bounded by the size of what the caller is actually allowed to see.

The mechanism that makes option 2 work rests on three invariants:

- **Boundary identity lives on the edge, not inferred at query time.** Computing polygon containment during a traversal would re-run a point-in-polygon test per hop. Instead, containment is resolved once at ingestion and frozen as a `boundary_id` property, turning an O(geometry) test into an O(1) property comparison.
- **The permitted set is a parameter, never interpolated geometry.** Callers pass a list of boundary identifiers, not raw polygons. This keeps the query plan cache warm and removes an injection surface.
- **Spatial scoping precedes cost evaluation.** The bounding-box pre-filter that the [spatial indexing strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) layer provides shrinks the candidate edge set to the request envelope *before* any weight is summed, so the boundary predicate runs over a small, index-resolved set.

<svg viewBox="0 0 840 478" role="img" aria-labelledby="sb-title sb-desc" xmlns="http://www.w3.org/2000/svg">
  <title id="sb-title">Post-traversal filtering versus predicate-before-expansion</title>
  <desc id="sb-desc">Two side-by-side route graphs over the same network, each with a shaded restricted zone containing an interior node M. The left panel, post-traversal filtering, expands every edge including the cheap path through the restricted zone, then discards that path with a rejection mark because a segment is out of bounds. The right panel, predicate-before-expansion, fades and prunes the in-zone edges so they never enter the frontier, and expands only the compliant detour from origin O through P1 and P2 to destination D.</desc>
  <style>
    .sb-ttl{fill:var(--ink,#1f2937);font:700 15px var(--font-sans,system-ui,sans-serif);}
    .sb-sub{fill:var(--ink-mute,#6b7280);font:12px var(--font-mono,ui-monospace,monospace);}
    .sb-zlbl{fill:var(--accent-coral,#ff6b6b);font:700 11px var(--font-sans,system-ui,sans-serif);}
    .sb-nlbl{fill:var(--viz-on-pill,#ffffff);font:700 13px var(--font-sans,system-ui,sans-serif);}
    .sb-tag{fill:var(--ink-mute,#6b7280);font:11px var(--font-mono,ui-monospace,monospace);}
    .sb-leg{fill:var(--ink-mute,#6b7280);font:12px var(--font-sans,system-ui,sans-serif);}
    .sb-e-exp{stroke:var(--ink-mute,#6b7280);stroke-width:2;fill:none;}
    .sb-e-prune{stroke:var(--ink-mute,#6b7280);stroke-width:2;fill:none;stroke-dasharray:5 5;opacity:.4;}
    .sb-e-rej{stroke:var(--accent-coral,#ff6b6b);stroke-width:3.2;fill:none;}
    .sb-e-ok{stroke:var(--accent,#0e7c86);stroke-width:3.6;fill:none;}
    .sb-node{fill:var(--ink-mute,#6b7280);}
    .sb-node-o{fill:var(--accent,#0e7c86);}
    .sb-node-fade{fill:var(--ink-mute,#6b7280);opacity:.35;}
  </style>
  <defs>
    <marker id="sb-ah-ok" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="var(--accent,#0e7c86)"/></marker>
    <marker id="sb-ah-rej" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="var(--accent-coral,#ff6b6b)"/></marker>
    <marker id="sb-ah-exp" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L6,3 L0,6 Z" fill="var(--ink-mute,#6b7280)"/></marker>
  </defs>
  <!-- ===== Panel 1: post-traversal filtering ===== -->
  <rect class="viz-backdrop" x="0" y="0" width="840" height="478" fill="var(--viz-bg,#ffffff)"/>
  <text class="sb-ttl" x="40" y="32">1 &#183; Post-traversal filtering</text>
  <text class="sb-sub" x="40" y="52">expand everything, then discard</text>
  <!-- restricted zone -->
  <rect x="128" y="118" width="150" height="150" rx="12" fill="var(--accent-coral,#ff6b6b)" fill-opacity="0.12" stroke="var(--accent-coral,#ff6b6b)" stroke-width="1.5" stroke-dasharray="6 4"/>
  <text class="sb-zlbl" x="203" y="138" text-anchor="middle">restricted zone</text>
  <!-- edges: all explored; through-zone path rejected -->
  <line class="sb-e-exp" x1="65" y1="330" x2="138" y2="370" marker-end="url(#sb-ah-exp)"/>
  <line class="sb-e-exp" x1="150" y1="368" x2="312" y2="280" marker-end="url(#sb-ah-exp)"/>
  <line class="sb-e-exp" x1="328" y1="266" x2="346" y2="116" marker-end="url(#sb-ah-exp)"/>
  <line class="sb-e-rej" x1="65" y1="318" x2="190" y2="200"/>
  <line class="sb-e-rej" x1="216" y1="188" x2="338" y2="104" marker-end="url(#sb-ah-rej)"/>
  <!-- rejection badge on the in-zone segment -->
  <g transform="translate(140,252)"><circle r="13" fill="var(--accent-coral,#ff6b6b)"/><path d="M-5,-5 L5,5 M5,-5 L-5,5" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></g>
  <text class="sb-tag" x="120" y="300">crosses zone &#8594; rejected</text>
  <!-- nodes -->
  <g><circle class="sb-node-o" cx="65" cy="324" r="16"/><text class="sb-nlbl" x="65" y="329" text-anchor="middle">O</text></g>
  <g><circle class="sb-node" cx="203" cy="194" r="16"/><text class="sb-nlbl" x="203" y="199" text-anchor="middle">M</text></g>
  <g><circle class="sb-node" cx="352" cy="92" r="16"/><text class="sb-nlbl" x="352" y="97" text-anchor="middle">D</text></g>
  <g><circle class="sb-node" cx="144" cy="372" r="13"/></g>
  <g><circle class="sb-node" cx="320" cy="272" r="13"/></g>
  <text class="sb-tag" x="100" y="398" text-anchor="middle">P1</text>
  <text class="sb-tag" x="338" y="296">P2</text>
  <!-- divider -->
  <line x1="420" y1="20" x2="420" y2="408" stroke="var(--line-strong,#9ca3af)" stroke-width="1" stroke-dasharray="3 5" opacity=".5"/>
  <!-- ===== Panel 2: predicate-before-expansion ===== -->
  <text class="sb-ttl" x="460" y="32">2 &#183; Predicate-before-expansion</text>
  <text class="sb-sub" x="460" y="52">prune before the frontier grows</text>
  <rect x="548" y="118" width="150" height="150" rx="12" fill="var(--accent-coral,#ff6b6b)" fill-opacity="0.12" stroke="var(--accent-coral,#ff6b6b)" stroke-width="1.5" stroke-dasharray="6 4"/>
  <text class="sb-zlbl" x="623" y="138" text-anchor="middle">restricted zone</text>
  <!-- pruned in-zone edges (never added to frontier) -->
  <line class="sb-e-prune" x1="485" y1="318" x2="610" y2="200"/>
  <line class="sb-e-prune" x1="636" y1="188" x2="758" y2="104"/>
  <text class="sb-tag" x="556" y="244">pruned</text>
  <!-- compliant detour, the only path expanded -->
  <line class="sb-e-ok" x1="485" y1="330" x2="558" y2="370" marker-end="url(#sb-ah-ok)"/>
  <line class="sb-e-ok" x1="570" y1="368" x2="732" y2="280" marker-end="url(#sb-ah-ok)"/>
  <line class="sb-e-ok" x1="748" y1="266" x2="766" y2="116" marker-end="url(#sb-ah-ok)"/>
  <!-- nodes -->
  <g><circle class="sb-node-o" cx="485" cy="324" r="16"/><text class="sb-nlbl" x="485" y="329" text-anchor="middle">O</text></g>
  <g><circle class="sb-node-fade" cx="623" cy="194" r="16"/><text class="sb-nlbl" x="623" y="199" text-anchor="middle" style="fill:var(--ink,#1f2937)">M</text></g>
  <g><circle class="sb-node" cx="772" cy="92" r="16"/><text class="sb-nlbl" x="772" y="97" text-anchor="middle">D</text></g>
  <g><circle class="sb-node" cx="564" cy="372" r="13"/></g>
  <g><circle class="sb-node" cx="740" cy="272" r="13"/></g>
  <text class="sb-tag" x="520" y="398" text-anchor="middle">P1</text>
  <text class="sb-tag" x="758" y="296">P2</text>
  <!-- ===== legend ===== -->
  <g transform="translate(40,438)">
    <line class="sb-e-ok" x1="0" y1="0" x2="34" y2="0"/>
    <text class="sb-leg" x="42" y="4">compliant path expanded</text>
    <line class="sb-e-rej" x1="226" y1="0" x2="260" y2="0"/>
    <text class="sb-leg" x="268" y="4">out-of-bounds &#8212; rejected</text>
    <line class="sb-e-prune" x1="500" y1="0" x2="534" y2="0"/>
    <text class="sb-leg" x="542" y="4">pruned before frontier</text>
  </g>
</svg>

Raw networks arrive without any of this. Segments straddle polygon edges, ingestion mixes coordinate systems, and boundary polygons overlap at administrative seams. The stamping phase exists to resolve every edge to exactly one permitted-set membership before a single routing request is served.

## Schema & Data Model

The contract is only enforceable if `boundary_id` is a first-class, indexed property on both nodes and the relationships that carry traversal cost. Model each junction as a `:Node` with a native `point` `location`, a stable `id`, and the `boundary_id` of the region it sits in; model each traversable segment as a `:ROUTE` relationship carrying `cost` and its own `boundary_id`. The relationship boundary is what enforcement reads — a node can sit exactly on a seam, but an edge always lies within one region.

```cypher
// Stable node identity so boundary stamping is idempotent across re-imports
CREATE CONSTRAINT node_id IF NOT EXISTS
FOR (n:Node) REQUIRE n.id IS UNIQUE;

// Stable segment identity so re-stamping replaces in place, never orphans topology
CREATE CONSTRAINT route_id IF NOT EXISTS
FOR ()-[r:ROUTE]-() REQUIRE r.id IS UNIQUE;

// Point index so the request envelope resolves against the index, not a label scan
CREATE POINT INDEX node_location IF NOT EXISTS
FOR (n:Node) ON (n.location);

// Selective boundary key the planner uses to scope the start set
CREATE INDEX node_boundary IF NOT EXISTS
FOR (n:Node) ON (n.boundary_id);

// Relationship-property index so boundary filtering resolves without scanning every edge
CREATE INDEX route_boundary IF NOT EXISTS
FOR ()-[r:ROUTE]-() ON (r.boundary_id);
```

```cypher
// Representative shape of the boundary-aware routing graph
// (:Node {id, location: point({latitude, longitude}), boundary_id})
//   -[:ROUTE {id, cost, boundary_id}]->
// (:Node {id, location, boundary_id})
```

The physical structure backing `location` — native point index versus R-tree bucket — is a decision owned by the indexing layer; this schema only exposes the geometry and the two selective keys the planner consumes. When several customers share one graph, the same `boundary_id` seam is the isolation primitive enforced in depth by [multi-tenant security in spatial graphs](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-security-boundaries/enforcing-multi-tenant-security-in-spatial-graphs/).

## Step-by-Step Implementation

The pipeline has two halves: a one-time (or on-update) stamping pass that assigns `boundary_id` to every edge, and a per-request routing client that enforces the permitted set. We build it in three stages.

### 1. Stamp edges with their boundary membership

Boundary assignment is a point-in-polygon test against the edge's representative point — the midpoint is robust for segments that begin or end exactly on a seam. Resolve containment once, in Python, and persist the result so the database never re-tests geometry at query time. Use a prepared spatial index over the boundary polygons so assignment stays near-linear in edge count.

```python
import asyncio
from typing import Iterable, Iterator

from shapely.geometry import LineString, shape
from shapely.strtree import STRtree


class BoundaryStamper:
    """Resolve each segment to exactly one boundary_id via midpoint containment."""

    def __init__(self, boundary_features: Iterable[dict]):
        # boundary_features: GeoJSON-like dicts with properties.boundary_id
        self.polygons = []
        self.ids = []
        for feat in boundary_features:
            self.polygons.append(shape(feat["geometry"]))
            self.ids.append(feat["properties"]["boundary_id"])
        # STRtree gives an R-tree pre-filter so we test only candidate polygons
        self.tree = STRtree(self.polygons)

    def boundary_for(self, segment: LineString) -> str | None:
        probe = segment.interpolate(0.5, normalized=True)  # robust midpoint
        for idx in self.tree.query(probe):
            if self.polygons[idx].contains(probe):
                return self.ids[idx]
        return None  # straddles an unassigned zone — reject, do not guess

    def stamp(self, edges: Iterable[dict]) -> Iterator[dict]:
        for edge in edges:
            seg = LineString(edge["coords"])  # [(lon, lat), ...]
            bid = self.boundary_for(seg)
            if bid is None:
                # Surfacing this is mandatory: an unstamped edge is a leak waiting to happen
                raise ValueError(f"edge {edge['id']} falls in no boundary polygon")
            yield {"id": edge["id"], "boundary_id": bid,
                   "cost": edge["cost"], "source_id": edge["source_id"],
                   "target_id": edge["target_id"]}
```

The deliberate choice here is to **reject**, not default, an edge that falls in no polygon. A silent fallback (`"unknown"`, or the nearest polygon) is exactly how leakage enters a system: the edge becomes routable under whatever set happens to include the fallback. Validation that edge midpoints fall within an assigned polygon is the cheapest place to stop a boundary violation.

### 2. Persist the stamps over a pooled async session

Write the stamped edges back with a parameterized `UNWIND`, merging on the constrained `id` so re-stamping an updated network is idempotent. The boundary becomes a frozen property the routing path reads for free.

```python
from neo4j import AsyncGraphDatabase


class BoundaryWriter:
    def __init__(self, uri: str, user: str, password: str, pool_size: int = 8):
        self.driver = AsyncGraphDatabase.driver(
            uri, auth=(user, password), max_connection_pool_size=pool_size
        )

    async def close(self) -> None:
        await self.driver.close()

    async def write_batch(self, batch: list[dict]) -> None:
        query = """
        UNWIND $batch AS row
        MATCH (s:Node {id: row.source_id})
        MATCH (t:Node {id: row.target_id})
        MERGE (s)-[e:ROUTE {id: row.id}]->(t)
        SET e.cost = row.cost,
            e.boundary_id = row.boundary_id
        """
        async with self.driver.session(database="routing") as session:
            await session.run(query, batch=batch)
```

### 3. Enforce the permitted set at request time

The routing client expands the query envelope client-side (so the server never recomputes the bounding box), then runs a boundary-filtered traversal. The `all()` predicate is the enforcement point: a path survives only if *every* segment belongs to the permitted set.

```python
import asyncio
import math

from neo4j import AsyncGraphDatabase
from shapely.geometry import box


class SpatialRoutingClient:
    def __init__(self, uri: str, user: str, password: str):
        self.driver = AsyncGraphDatabase.driver(
            uri,
            auth=(user, password),
            max_connection_pool_size=50,
            connection_acquisition_timeout=5.0,
            max_connection_lifetime=3600,
        )

    async def route_within_boundaries(
        self,
        origin_id: str,
        dest_id: str,
        allowed_boundaries: list[str],
        max_hops: int = 50,
        lat: float = 0.0,
        lon: float = 0.0,
        radius_km: float = 10.0,
    ) -> dict | None:
        # Expand the request envelope using a spherical approximation
        # (~111.32 km per degree of latitude)
        delta_lat = radius_km / 111.32
        delta_lon = radius_km / (111.32 * math.cos(math.radians(lat)))
        query_envelope = box(
            lon - delta_lon, lat - delta_lat, lon + delta_lon, lat + delta_lat
        )

        if not (1 <= max_hops <= 200):
            raise ValueError("max_hops must be between 1 and 200")

        # Cypher requires a literal upper bound on a variable-length pattern,
        # so the validated integer is interpolated by trusted code — never the
        # boundary set, which stays a parameter.
        cypher = f"""
            MATCH (o:Node {{id: $origin_id}})
            MATCH (d:Node {{id: $dest_id}})
            MATCH path = (o)-[rels:ROUTE*1..{max_hops}]->(d)
            WHERE all(rel IN rels WHERE rel.boundary_id IN $allowed_boundaries)
            WITH path, reduce(w = 0.0, rel IN rels | w + rel.cost) AS total_cost
            ORDER BY total_cost ASC
            LIMIT 1
            RETURN path, total_cost
        """

        async with self.driver.session(database="routing") as session:
            result = await session.run(
                cypher,
                origin_id=origin_id,
                dest_id=dest_id,
                allowed_boundaries=allowed_boundaries,
            )
            record = await result.single()
            if record:
                return {
                    "path_nodes": [n["id"] for n in record["path"].nodes],
                    "total_cost": record["total_cost"],
                    "query_envelope_wkt": query_envelope.wkt,
                }
            return None

    async def close(self) -> None:
        await self.driver.close()
```

This client demonstrates the three production essentials together: a bounded connection pool sized for concurrent dispatch, a spatial envelope precomputed client-side, and strict parameterization of the boundary set. The only value baked into the query string is the validated integer hop cap — because Cypher forbids parameters as variable-length bounds — and it is range-checked before interpolation.

## Query Patterns & Variants

Pick the variant whose anchor matches how callers parameterize the request.

**Variant A — strict all-segment compliance (plain Cypher).** Best when the objective is the cheapest *legal* path inside a small, well-connected permitted region. The hop cap prevents runaway expansion in disconnected or cyclic graphs.

```cypher
MATCH (o:Node {id: $origin_id})
MATCH (d:Node {id: $dest_id})
MATCH path = (o)-[rels:ROUTE*1..30]->(d)
WHERE all(rel IN rels WHERE rel.boundary_id IN $allowed_boundaries)
WITH path, reduce(w = 0.0, rel IN rels | w + rel.cost) AS total_cost
ORDER BY total_cost ASC
LIMIT 1
RETURN path, total_cost
// $allowed_boundaries stays a parameter; the *1..30 bound is literal by necessity.
```

**Variant B — boundary-filtered Dijkstra (GDS).** Best for large networks where deterministic latency matters. Project a subgraph that already excludes out-of-bounds relationships, then run weighted Dijkstra over it — enforcement moves into the projection, so the algorithm cannot consider an illegal edge.

```cypher
// One-time projection scoped to the permitted boundaries via a relationship filter
MATCH (s:Node)-[r:ROUTE]->(t:Node)
WHERE r.boundary_id IN $allowed_boundaries
WITH gds.graph.project(
  'compliant_routing',
  s, t,
  { relationshipProperties: r { .cost } }
) AS g
RETURN g.graphName AS graphName;

// Per-request weighted shortest path over the boundary-scoped projection
MATCH (src:Node {id: $origin_id}), (dst:Node {id: $dest_id})
CALL gds.shortestPath.dijkstra.stream('compliant_routing', {
  sourceNode: src, targetNode: dst, relationshipWeightProperty: 'cost'
})
YIELD totalCost, nodeIds
RETURN totalCost, [id IN nodeIds | gds.util.asNode(id).id] AS route;
```

**Variant C — leakage audit.** Run this in CI and after every re-stamp. It surfaces any path that *would* cross out of the permitted set, which is how you prove the enforcement predicate is actually doing its job before customers depend on it.

```cypher
MATCH (o:Node {id: $origin_id})
MATCH path = (o)-[rels:ROUTE*1..30]->(:Node {id: $dest_id})
WITH path, [rel IN rels WHERE NOT rel.boundary_id IN $allowed_boundaries] AS violations
WHERE size(violations) > 0
RETURN size(violations) AS leaked_segments, [rel IN violations | rel.id] AS leaked_ids
LIMIT 5
// Any row returned here is a path that strict enforcement must reject — investigate the stamping.
```

## Performance Tuning

Boundary enforcement trades a small per-edge predicate cost for a drastically smaller candidate set; the net is almost always a win, but only if the planner enters through an index.

- **Profile with `PROFILE`, validate shape with `EXPLAIN`.** Read the plan bottom-up and find the first operator whose `rows` dwarfs the result. A `boundary_id` filter applied *after* a full `ROUTE` expansion means the planner did not use the relationship index — anchor the start node by `boundary_id` or `location` so scoping happens first. This is the same discipline covered under [graph query planner optimization](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/).
- **Watch `boundary_id` cardinality.** If only a handful of distinct boundaries exist, the index is unselective and the planner may rightly prefer a scan. For coarse partitions, combine `boundary_id` with the point index on `location` so the request envelope, not the boundary, drives selectivity.
- **Materialize masks for very large networks.** Above ~10M edges, precompute per-tenant permitted-edge bitsets or zone-crossing penalties so enforcement is a membership test rather than a list scan. Cache compliant paths at the application layer with invalidation tied to topology and re-stamp events.
- **Bound the traversal aggressively.** The `*1..N` cap is a safety valve, not a tuning knob — keep it as tight as the network diameter allows so a disconnected permitted region fails fast instead of exploring the whole graph.
- **Defragment after heavy re-stamps.** Frequent boundary updates fragment the relationship-property index; scheduled drop-and-rebuild cycles (or partitioned index shards) keep lookup latency flat. Pair this with the broader read tuning in [cypher performance tuning](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/).

## Edge Cases & Gotchas

- **Boundary leakage from coordinate drift.** A segment whose endpoints round across a polygon seam can be stamped to the wrong region. Test containment on the *midpoint*, not an endpoint, and reject edges that match no polygon rather than defaulting them.
- **SRID mismatch in containment tests.** A geographic segment (SRID 4326) tested against a projected polygon returns nonsense, and `point.distance` across SRIDs returns `null` — a `null` predicate silently drops rows. Align CRS before stamping and before any in-query distance filter.
- **Variable-length bound interpolation.** Cypher forbids a parameter as a `*1..N` bound, so the cap must be interpolated. Range-check it as an integer first; never let a request value reach the query string unchecked, and never put the boundary set anywhere but a parameter.
- **GDS projection staleness.** A boundary-scoped projection is a snapshot. After re-stamping or a topology change, drop and re-project, or Variant B will route over the *old* permitted set and quietly leak.
- **Unselective boundary keys.** A near-constant `boundary_id` makes the index worthless and pushes the planner to a scan; lean on the spatial envelope for selectivity in that case, or partition the graph by tenant.
- **`relationships(path)` vs a named list.** Binding the relationships once (`-[rels:ROUTE*..]->`) and reusing `rels` in both the `WHERE` and the `reduce` avoids re-deriving the list and keeps the predicate and the cost in lockstep.

<svg viewBox="0 0 780 292" role="img" aria-labelledby="smTitle smDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="smTitle">Stamping a segment on an endpoint puts seam-crossing edges in the wrong region</title>
  <desc id="smDesc">A road segment running alongside a boundary seam, with its start vertex a metre inside region B after coordinate rounding and the rest of its length inside region A. Testing containment on the start endpoint stamps the whole segment to region B, so a route confined to region A cannot use a road that is almost entirely inside it, and a route confined to B gains one it should not have. Testing the midpoint puts the segment in the region that holds most of its length. An edge matching no polygon is rejected rather than defaulted, because a default is the same bug with a different sign.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="292" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Which point on the segment gets tested</text>
  <rect x="24" y="42" width="356" height="188" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-poor,#a8320f)" stroke-width="1.8"/>
  <text x="202" y="66" text-anchor="middle" font-size="11.5" font-weight="700" fill="var(--viz-poor,#a8320f)">tested on the start endpoint</text>
  <path d="M52 196 L120 96 L352 96 L352 196 Z" fill="var(--accent-3,#5b21b6)" opacity="0.1"/>
  <path d="M52 196 L120 96" fill="none" stroke="var(--viz-stroke,#9ca3af)" stroke-width="2" stroke-dasharray="6 4"/>
  <text x="72" y="118" font-size="10" font-weight="700" fill="var(--viz-ink-mute,#565f6d)">region B</text>
  <text x="300" y="118" font-size="10" font-weight="700" fill="var(--accent-3,#5b21b6)">region A</text>
  <line x1="96" y1="164" x2="300" y2="164" stroke="var(--viz-poor,#a8320f)" stroke-width="4" stroke-linecap="round"/>
  <circle cx="96" cy="164" r="6" fill="var(--viz-poor,#a8320f)"/>
  <text x="96" y="188" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--viz-poor,#a8320f)">start</text>
  <text x="216" y="152" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">stamped: region B</text>
  <text x="202" y="216" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">96% of its length is in A, and A cannot use it</text>
  <rect x="400" y="42" width="356" height="188" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="1.8"/>
  <text x="578" y="66" text-anchor="middle" font-size="11.5" font-weight="700" fill="var(--viz-good,#0a656d)">tested on the midpoint</text>
  <path d="M428 196 L496 96 L728 96 L728 196 Z" fill="var(--accent-3,#5b21b6)" opacity="0.1"/>
  <path d="M428 196 L496 96" fill="none" stroke="var(--viz-stroke,#9ca3af)" stroke-width="2" stroke-dasharray="6 4"/>
  <text x="448" y="118" font-size="10" font-weight="700" fill="var(--viz-ink-mute,#565f6d)">region B</text>
  <text x="676" y="118" font-size="10" font-weight="700" fill="var(--accent-3,#5b21b6)">region A</text>
  <line x1="472" y1="164" x2="676" y2="164" stroke="var(--viz-good,#0a656d)" stroke-width="4" stroke-linecap="round"/>
  <circle cx="574" cy="164" r="6" fill="var(--viz-good,#0a656d)"/>
  <text x="574" y="188" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--viz-good,#0a656d)">midpoint</text>
  <text x="592" y="152" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">stamped: region A</text>
  <text x="578" y="216" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">the region that holds the road holds the edge</text>
  <text x="24" y="260" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">Neither run errors, and both produce a fully stamped graph. The endpoint version leaks in one direction and blocks</text>
  <text x="24" y="276" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">in the other, so reject an edge that matches no polygon rather than defaulting it — a default is the same bug, silently.</text>
</svg>

## Verification & Testing

Enforcement is only trustworthy if you can prove a *blocked* path is actually blocked. A reachability test alone passes whether or not boundaries work — the regression you must catch is a path that should be rejected but is returned. Seed a fixture where the only short route crosses a forbidden zone and assert it is refused.

```python
import pytest
from neo4j import AsyncGraphDatabase

SEED = """
CREATE (a:Node {id: 'A', location: point({latitude: 47.60, longitude: -122.33}), boundary_id: 'Z1'})
CREATE (b:Node {id: 'B', location: point({latitude: 47.62, longitude: -122.35}), boundary_id: 'Z1'})
CREATE (c:Node {id: 'C', location: point({latitude: 47.64, longitude: -122.30}), boundary_id: 'Z2'})
CREATE (d:Node {id: 'D', location: point({latitude: 47.66, longitude: -122.28}), boundary_id: 'Z1'})
// Short route A->C->D crosses Z2; long route A->B->D stays in Z1
CREATE (a)-[:ROUTE {id: 'e1', cost: 1.0, boundary_id: 'Z1'}]->(c)
CREATE (c)-[:ROUTE {id: 'e2', cost: 1.0, boundary_id: 'Z2'}]->(d)
CREATE (a)-[:ROUTE {id: 'e3', cost: 5.0, boundary_id: 'Z1'}]->(b)
CREATE (b)-[:ROUTE {id: 'e4', cost: 5.0, boundary_id: 'Z1'}]->(d)
"""

ROUTE = """
MATCH path = (o:Node {id: 'A'})-[rels:ROUTE*1..10]->(d:Node {id: 'D'})
WHERE all(rel IN rels WHERE rel.boundary_id IN $allowed)
WITH path, reduce(w = 0.0, rel IN rels | w + rel.cost) AS cost
ORDER BY cost ASC LIMIT 1
RETURN [r IN relationships(path) | r.id] AS edges, cost
"""


@pytest.mark.asyncio
async def test_boundary_enforcement_rejects_the_cheaper_illegal_path():
    driver = AsyncGraphDatabase.driver("bolt://localhost:7687", auth=("neo4j", "test"))
    async with driver.session(database="neo4j") as s:
        await s.run("MATCH (n) DETACH DELETE n")
        await s.run(SEED)

        # Caller permitted only in Z1: must take the costlier compliant detour
        legal = await (await s.run(ROUTE, allowed=["Z1"])).single()
        assert legal is not None, "a compliant path A->B->D must exist"
        assert legal["edges"] == ["e3", "e4"], "must avoid the Z2 shortcut"
        assert legal["cost"] == 10.0

        # With Z2 permitted, the cheaper crossing path becomes legal
        relaxed = await (await s.run(ROUTE, allowed=["Z1", "Z2"])).single()
        assert relaxed["edges"] == ["e1", "e2"], "Z2 allowed -> take the shortcut"
        assert relaxed["cost"] == 2.0

    await driver.close()
```

The asymmetry is the whole point: the first assertion fails loudly if enforcement regresses and the engine returns the cheaper `e1/e2` path while the caller is scoped to `Z1`. Run the leakage-audit query (Variant C) in the same suite to assert zero out-of-bounds segments after every re-stamp.

## FAQ

<details>
<summary>Why stamp boundary_id onto edges instead of testing polygons at query time?</summary>

Point-in-polygon is an O(geometry) operation. Running it per hop during a traversal multiplies that cost by the frontier size and makes latency depend on polygon complexity. Resolving containment once at ingestion and freezing it as a `boundary_id` property turns the per-hop check into an O(1) property comparison the planner can resolve against an index. The polygons only need to be consulted again when the network or the boundaries change.
</details>

<details>
<summary>Can I pass the permitted boundary set as a parameter, or must I inline it?</summary>

Always pass it as a parameter (`$allowed_boundaries`). Parameters keep the query-plan cache warm across requests and remove an injection surface. The only value that must be interpolated into the query string is the variable-length upper bound (`*1..N`), because Cypher forbids a parameter there — and that value should be range-checked as an integer before it ever touches the string.
</details>

<details>
<summary>What happens to an edge that falls in no boundary polygon?</summary>

Reject it at stamping time and surface the error. The dangerous alternative is a silent default — assigning `"unknown"` or the nearest polygon — because the edge then becomes routable under whatever permitted set happens to include that fallback, which is precisely how leakage enters production. An edge straddling an unassigned zone is a data problem to fix upstream, not a value to guess.
</details>

<details>
<summary>Should I enforce boundaries in plain Cypher or in a GDS projection?</summary>

Use plain Cypher with an `all()` predicate for cheapest-legal-path queries inside small, well-connected regions. Switch to a boundary-filtered GDS projection when networks are large and you need deterministic latency: project a subgraph whose relationship filter already excludes out-of-bounds edges, so the algorithm physically cannot consider an illegal segment. Remember the projection is a snapshot — re-project after any re-stamp.
</details>

<details>
<summary>How does this relate to multi-tenant isolation?</summary>

Boundary enforcement and tenant isolation use the same `boundary_id` seam, but isolation adds a hard requirement that one tenant can never observe another's topology even through planner expansion. That demands composite tenant-geometry index keys and scoping that runs before any spatial predicate. The full treatment lives in [enforcing multi-tenant security in spatial graphs](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-security-boundaries/enforcing-multi-tenant-security-in-spatial-graphs/).
</details>

## Related

- [Node and Edge Spatial Mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/) — the topology and stable identities that boundary stamping is applied to.
- [Spatial Indexing Strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) — the bounding-volume pre-filter that scopes a request before the boundary predicate runs.
- [Graph Query Planner Optimization](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/) — making the planner seek your boundary and point indexes instead of scanning.
- [Enforcing Multi-Tenant Security in Spatial Graphs](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-security-boundaries/enforcing-multi-tenant-security-in-spatial-graphs/) — extending boundary control into hard cross-tenant isolation.
- [Scoping Routes with Composite Tenant-Geometry Indexes](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-security-boundaries/scoping-routes-with-composite-tenant-geometry-indexes/) — making the tenant filter and spatial predicate resolve as one index seek.
- [Distance Filter Query Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/) — the envelope and radius predicates that pair with boundary scoping.

This guide is part of [Spatial Graph Database Fundamentals for Python](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/).

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "Why stamp boundary_id onto edges instead of testing polygons at query time?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Point-in-polygon is an expensive geometric operation. Running it per hop during a traversal multiplies that cost by the frontier size and makes latency depend on polygon complexity. Resolving containment once at ingestion and freezing it as a boundary_id property turns the per-hop check into a constant-time property comparison the planner can resolve against an index. The polygons only need to be consulted again when the network or the boundaries change."
      }
    },
    {
      "@type": "Question",
      "name": "Can I pass the permitted boundary set as a parameter, or must I inline it?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Always pass it as a parameter. Parameters keep the query-plan cache warm across requests and remove an injection surface. The only value that must be interpolated into the query string is the variable-length upper bound, because Cypher forbids a parameter there, and that value should be range-checked as an integer before it ever touches the string."
      }
    },
    {
      "@type": "Question",
      "name": "What happens to an edge that falls in no boundary polygon?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Reject it at stamping time and surface the error. The dangerous alternative is a silent default such as assigning unknown or the nearest polygon, because the edge then becomes routable under whatever permitted set includes that fallback, which is how leakage enters production. An edge straddling an unassigned zone is a data problem to fix upstream, not a value to guess."
      }
    },
    {
      "@type": "Question",
      "name": "Should I enforce boundaries in plain Cypher or in a GDS projection?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Use plain Cypher with an all() predicate for cheapest-legal-path queries inside small, well-connected regions. Switch to a boundary-filtered GDS projection when networks are large and you need deterministic latency: project a subgraph whose relationship filter already excludes out-of-bounds edges so the algorithm cannot consider an illegal segment. The projection is a snapshot, so re-project after any re-stamp."
      }
    },
    {
      "@type": "Question",
      "name": "How does boundary enforcement relate to multi-tenant isolation?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Boundary enforcement and tenant isolation use the same boundary_id seam, but isolation adds a hard requirement that one tenant can never observe another tenant's topology even through planner expansion. That demands composite tenant-geometry index keys and scoping that runs before any spatial predicate."
      }
    }
  ]
}
</script>
