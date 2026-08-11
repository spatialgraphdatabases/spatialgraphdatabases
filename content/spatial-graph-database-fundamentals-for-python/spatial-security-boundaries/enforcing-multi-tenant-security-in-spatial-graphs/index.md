---
pageTitle: Multi-Tenant Spatial Graph Security
title: Enforcing Multi-Tenant Security in Spatial Graphs
description: Stop cross-tenant leakage in spatial routing graphs with composite tenant-geometry scoping, parameterized Cypher, and tenant-projected GDS routing in async Python.
slug: enforcing-multi-tenant-security-in-spatial-graphs
type: article
breadcrumb: Multi-Tenant Security
datePublished: 2025-10-06
dateModified: 2026-06-26
---
# Enforcing Multi-Tenant Security in Spatial Graphs

Cross-tenant data leakage in spatial routing graphs rarely starts with broken authentication — it starts with an unscoped index. The symptom is a logistics route that returns a node belonging to another customer, or a `point.distance` filter that returns counts no single tenant could explain. The root cause is that geometric indexes (R-trees, geohash grids, native point indexes) rank candidates by proximity alone and know nothing about tenancy, so when the tenant predicate is evaluated *after* the spatial seek, the planner has already materialized cross-tenant candidate rows. This page resolves that by binding the tenant identifier to the spatial seek itself: a composite `(tenant_id, location)` access path, parameterized queries that the planner can push down, and a GDS projection scoped to one tenant's subgraph so traversal can never escape the boundary.

This guide is part of [Spatial Security Boundaries](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-security-boundaries/), and it builds directly on the [node and edge spatial mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/) contract — the `zone`/tenant tag added at ingestion is the seam enforced here.

## Prerequisites & Versions

The implementation uses the async Neo4j driver, native `point` types, and the Graph Data Science plugin for tenant-scoped A* routing. Pin these minimums.

| Library | Min version | Install |
| --- | --- | --- |
| Python | 3.10+ | system / pyenv |
| neo4j (driver) | 5.18+ | `pip install "neo4j>=5.18"` |
| Neo4j server | 5.13+ | native `point` + point indexes |
| GDS plugin | 2.5+ | server plugin (`gds.shortestPath.astar`) |

```bash
pip install "neo4j>=5.18"
```

Confirm every routable node already carries a `tenant_id` property and a WGS 84 `location` point before you build the index — back-filling tenancy after the fact leaves orphaned nodes that satisfy spatial predicates but escape the composite seek.

<svg viewBox="0 0 760 486" role="img" aria-labelledby="seekTitle seekDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="seekTitle">Unscoped spatial seek versus composite tenant-geometry seek</title>
  <desc id="seekDesc">Left: a location-only index seek ranks candidates by proximity and materializes nodes from tenant A and tenant B together, opening a leak window before a trailing tenant_id filter drops tenant B. Right: a composite (tenant_id, location) index makes tenant_id the leading key, so the seek admits only tenant A nodes and no foreign rows are ever read.</desc>
  <defs>
    <marker id="seekArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <rect class="viz-backdrop" x="0" y="0" width="760" height="486" fill="var(--viz-bg,#ffffff)"/>
  <line x1="380" y1="44" x2="380" y2="456" stroke="currentColor" stroke-width="1" stroke-dasharray="3 6" opacity="0.3"/>
  <!-- LEFT: unscoped seek -->
  <text x="190" y="26" text-anchor="middle" font-size="14.5" font-weight="700" fill="currentColor">Unscoped seek — leak window</text>
  <text x="190" y="44" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7">index ON (location) · tenant checked last</text>
  <g fill="none" stroke="var(--accent,#0e7c86)" stroke-width="1.6">
    <rect x="60" y="56" width="260" height="56" rx="8"/>
    <rect x="60" y="256" width="260" height="56" rx="8"/>
  </g>
  <rect x="60" y="156" width="260" height="64" rx="8" fill="var(--accent-coral,#ff6b6b)" opacity="0.13"/>
  <rect x="60" y="156" width="260" height="64" rx="8" fill="none" stroke="var(--accent-coral,#ff6b6b)" stroke-width="2.4"/>
  <line x1="190" y1="112" x2="190" y2="154" stroke="currentColor" stroke-width="1.6" marker-end="url(#seekArrow)"/>
  <line x1="190" y1="220" x2="190" y2="254" stroke="currentColor" stroke-width="1.6" marker-end="url(#seekArrow)"/>
  <text x="190" y="80" text-anchor="middle" font-size="13.5" font-weight="700" fill="currentColor">NodeIndexSeek — location</text>
  <text x="190" y="98" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.72">bounding box ranks by proximity only</text>
  <text x="190" y="178" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">Candidate set: tenant A + B</text>
  <g>
    <circle cx="139" cy="200" r="4.6" fill="var(--accent,#0e7c86)"/>
    <circle cx="161" cy="200" r="4.6" fill="var(--accent,#0e7c86)"/>
    <circle cx="183" cy="200" r="4.6" fill="var(--accent,#0e7c86)"/>
    <circle cx="205" cy="200" r="4.6" fill="var(--accent-coral,#ff6b6b)"/>
    <circle cx="227" cy="200" r="4.6" fill="var(--accent-coral,#ff6b6b)"/>
    <circle cx="249" cy="200" r="4.6" fill="var(--accent-coral,#ff6b6b)"/>
  </g>
  <text x="190" y="280" text-anchor="middle" font-size="13.5" font-weight="700" fill="currentColor">Filter tenant_id = A</text>
  <text x="190" y="298" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.72">drops tenant B — already read</text>
  <rect x="60" y="372" width="260" height="48" rx="8" fill="var(--accent-coral,#ff6b6b)" opacity="0.14"/>
  <rect x="60" y="372" width="260" height="48" rx="8" fill="none" stroke="var(--accent-coral,#ff6b6b)" stroke-width="1.4"/>
  <text x="190" y="393" text-anchor="middle" font-size="12.5" font-weight="700" fill="currentColor">foreign rows materialized</text>
  <text x="190" y="410" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.78">leak window between seek and filter</text>
  <!-- RIGHT: composite seek -->
  <text x="570" y="26" text-anchor="middle" font-size="14.5" font-weight="700" fill="currentColor">Composite seek — boundary by key</text>
  <text x="570" y="44" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7">index ON (tenant_id, location) · leading key</text>
  <g fill="none" stroke="var(--accent,#0e7c86)" stroke-width="1.6">
    <rect x="440" y="56" width="260" height="56" rx="8" stroke-width="2.4"/>
    <rect x="440" y="256" width="260" height="56" rx="8"/>
  </g>
  <rect x="440" y="156" width="260" height="64" rx="8" fill="var(--accent,#0e7c86)" opacity="0.12"/>
  <rect x="440" y="156" width="260" height="64" rx="8" fill="none" stroke="var(--accent,#0e7c86)" stroke-width="1.6"/>
  <line x1="570" y1="112" x2="570" y2="154" stroke="currentColor" stroke-width="1.6" marker-end="url(#seekArrow)"/>
  <line x1="570" y1="220" x2="570" y2="254" stroke="currentColor" stroke-width="1.6" marker-end="url(#seekArrow)"/>
  <text x="570" y="80" text-anchor="middle" font-size="13.5" font-weight="700" fill="currentColor">NodeIndexSeek — (tenant_id, location)</text>
  <text x="570" y="98" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.72">tenant_id pins the seek before geometry</text>
  <text x="570" y="178" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">Candidate set: tenant A only</text>
  <g>
    <circle cx="548" cy="200" r="4.6" fill="var(--accent,#0e7c86)"/>
    <circle cx="570" cy="200" r="4.6" fill="var(--accent,#0e7c86)"/>
    <circle cx="592" cy="200" r="4.6" fill="var(--accent,#0e7c86)"/>
  </g>
  <text x="570" y="280" text-anchor="middle" font-size="13.5" font-weight="700" fill="currentColor">A* on tenant-A projection</text>
  <text x="570" y="298" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.72">isolation by construction</text>
  <rect x="440" y="372" width="260" height="48" rx="8" fill="var(--accent,#0e7c86)" opacity="0.14"/>
  <rect x="440" y="372" width="260" height="48" rx="8" fill="none" stroke="var(--accent,#0e7c86)" stroke-width="1.4"/>
  <text x="570" y="393" text-anchor="middle" font-size="12.5" font-weight="700" fill="currentColor">no cross-tenant rows</text>
  <text x="570" y="410" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.78">foreign nodes never read</text>
  <text x="380" y="448" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.62">data flows downward · teal = tenant A, coral = tenant B · same data, two access paths</text>
</svg>

## Implementation

A single class owns the whole boundary: it creates the composite index, validates request geometry client-side, projects a *per-tenant* GDS subgraph, and runs A* against that projection. Every Cypher call is parameterized — no f-string interpolation of tenant values — so the planner can reuse a cached plan and push the tenant predicate into the index seek.

```python
import asyncio
import math
from typing import Any, Dict, List, Tuple

from neo4j import AsyncGraphDatabase


class TenantScopedSpatialRouter:
    def __init__(self, uri: str, user: str, password: str, max_pool: int = 100):
        self.driver = AsyncGraphDatabase.driver(
            uri,
            auth=(user, password),
            max_connection_pool_size=max_pool,
            liveness_check_timeout=30.0,
        )

    async def close(self) -> None:
        await self.driver.close()

    async def ensure_schema(self) -> None:
        """Composite index makes tenant + geometry one seek, not a seek + filter."""
        async with self.driver.session() as session:
            await session.run(
                """
                CREATE INDEX location_tenant_geo IF NOT EXISTS
                FOR (n:Location) ON (n.tenant_id, n.location)
                """
            )
            await session.run(
                """
                CREATE CONSTRAINT location_tenant_id IF NOT EXISTS
                FOR (n:Location) REQUIRE (n.tenant_id, n.id) IS UNIQUE
                """
            )

    @staticmethod
    def validate_spatial_bounds(
        start: Tuple[float, float], end: Tuple[float, float], max_radius_m: float
    ) -> bool:
        R = 6_371_000.0  # WGS84 mean radius in metres
        dlat = math.radians(end[0] - start[0])
        dlon = math.radians(end[1] - start[1])
        a = (
            math.sin(dlat / 2) ** 2
            + math.cos(math.radians(start[0]))
            * math.cos(math.radians(end[0]))
            * math.sin(dlon / 2) ** 2
        )
        return (2 * R * math.asin(math.sqrt(a))) <= max_radius_m

    async def project_tenant_graph(self, tenant_id: str) -> str:
        """Project ONLY this tenant's subgraph into GDS — isolation by construction."""
        graph_name = f"routing_{tenant_id}"
        cypher = """
        CALL gds.graph.exists($name) YIELD exists
        WITH exists WHERE NOT exists
        CALL gds.graph.project.cypher(
            $name,
            'MATCH (n:Location {tenant_id: $tid})
             RETURN id(n) AS id,
                    n.location.latitude  AS latitude,
                    n.location.longitude AS longitude',
            'MATCH (a:Location {tenant_id: $tid})-[r:CONNECTS]->(b:Location {tenant_id: $tid})
             RETURN id(a) AS source, id(b) AS target,
                    coalesce(r.distance_m, 1.0) AS weight',
            { parameters: { tid: $tid } }
        ) YIELD graphName
        RETURN graphName
        """
        async with self.driver.session() as session:
            await (await session.run(cypher, name=graph_name, tid=tenant_id)).consume()
        return graph_name

    async def compute_tenant_route(
        self,
        tenant_id: str,
        start_id: str,
        end_id: str,
        start: Tuple[float, float],
        end: Tuple[float, float],
    ) -> List[Dict[str, Any]]:
        if not self.validate_spatial_bounds(start, end, 50_000.0):
            raise ValueError("Route exceeds tenant spatial boundary constraints.")

        graph_name = await self.project_tenant_graph(tenant_id)

        # Anchor nodes are matched by (tenant_id, id) — the composite seek — then
        # handed to A*, which can only traverse the tenant-scoped projection.
        query = """
        MATCH (s:Location {tenant_id: $tenant_id, id: $start_id})
        MATCH (e:Location {tenant_id: $tenant_id, id: $end_id})
        CALL gds.shortestPath.astar.stream($graph, {
            sourceNode: s,
            targetNode: e,
            latitudeProperty: 'latitude',
            longitudeProperty: 'longitude',
            relationshipWeightProperty: 'weight'
        })
        YIELD totalCost, path
        RETURN totalCost, [n IN nodes(path) | n.id] AS route
        """
        async with self.driver.session() as session:
            result = await session.run(
                query,
                tenant_id=tenant_id,
                start_id=start_id,
                end_id=end_id,
                graph=graph_name,
            )
            return await result.data()
```

## How It Works

Three mechanisms carry the isolation guarantee, each tied to a line in the code above.

- **The composite index does the work.** `CREATE INDEX ... ON (n.tenant_id, n.location)` gives the planner a single access path where `tenant_id` is the leading key. A `MATCH (s:Location {tenant_id: $tenant_id, id: $start_id})` then resolves both predicates inside one seek, so non-tenant nodes are never read into a candidate set. Without the leading tenant key, the engine seeks on geometry and *then* drops other tenants — the window where a leak or a heap blow-up happens.
- **Parameters keep the plan honest.** Tenant context is always passed as `$tenant_id`, never interpolated. Beyond injection safety, this lets the planner cache and reuse a pushed-down plan; dynamic string queries disable that path and degrade into label scans. This is the same planner-seek discipline covered under [graph query planner optimization](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/).
- **The projection is the hard wall.** `gds.graph.project.cypher` is filtered to `{tenant_id: $tid}` on *both* the node and relationship queries. A* receives a graph that physically contains only one tenant's nodes and edges, so even a logic bug in the anchor `MATCH` cannot route across the boundary — the foreign nodes do not exist in the projection.

<svg viewBox="0 0 780 306" role="img" aria-labelledby="tkTitle tkDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="tkTitle">Which key leads the composite index decides whether other tenants are ever read</title>
  <desc id="tkDesc">The same query against two index definitions. With tenant_id leading, the descent goes straight to that tenant's slice and the geometry predicate resolves inside it, so no other tenant's node is ever loaded. With location leading, the seek resolves on geometry across all tenants, loads their nodes into a candidate set, and drops them in a filter above — the answer is the same but foreign rows were read into memory first, which is both the leak window and the heap risk.</desc>
  <defs>
    <marker id="tk-a" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="306" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Same predicates, same result, different set of rows ever loaded</text>
  <rect x="24" y="42" width="356" height="212" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="1.8"/>
  <text x="202" y="66" text-anchor="middle" font-size="11" font-weight="700" fill="var(--viz-good,#0a656d)">ON (n.tenant_id, n.location)</text>
  <rect x="52" y="84" width="300" height="26" rx="6" fill="var(--viz-good,#0a656d)"/>
  <text x="202" y="102" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--viz-on-pill,#ffffff)">descend to tenant_id = $tenant_id</text>
  <line x1="202" y1="110" x2="202" y2="130" stroke="currentColor" stroke-width="1.5" marker-end="url(#tk-a)"/>
  <rect x="52" y="132" width="300" height="26" rx="6" fill="var(--viz-good,#0a656d)"/>
  <text x="202" y="150" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--viz-on-pill,#ffffff)">resolve geometry inside that slice</text>
  <text x="202" y="184" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">rows loaded from other tenants</text>
  <text x="202" y="212" text-anchor="middle" font-size="26" font-weight="700" fill="var(--viz-good,#0a656d)">0</text>
  <text x="202" y="234" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">isolation is a property of the access path</text>
  <rect x="400" y="42" width="356" height="212" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-poor,#a8320f)" stroke-width="1.8"/>
  <text x="578" y="66" text-anchor="middle" font-size="11" font-weight="700" fill="var(--viz-poor,#a8320f)">ON (n.location, n.tenant_id)</text>
  <rect x="428" y="84" width="300" height="26" rx="6" fill="var(--viz-poor,#a8320f)"/>
  <text x="578" y="102" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--viz-on-pill,#ffffff)">seek geometry across all tenants</text>
  <line x1="578" y1="110" x2="578" y2="130" stroke="currentColor" stroke-width="1.5" marker-end="url(#tk-a)"/>
  <rect x="428" y="132" width="300" height="26" rx="6" fill="var(--viz-poor,#a8320f)"/>
  <text x="578" y="150" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--viz-on-pill,#ffffff)">Filter drops the foreign rows</text>
  <text x="578" y="184" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">rows loaded from other tenants</text>
  <text x="578" y="212" text-anchor="middle" font-size="26" font-weight="700" fill="var(--viz-poor,#a8320f)">18,400</text>
  <text x="578" y="234" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">isolation depends on a filter running correctly</text>
  <text x="24" y="284" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">Both queries return the same rows to the caller, so a test that only checks the result set passes on either index.</text>
  <text x="24" y="300" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">The GDS projection is the second wall for the same reason: foreign nodes are not filtered out of it, they are absent.</text>
</svg>

Client-side `validate_spatial_bounds` rejects out-of-range requests with a Haversine check before any database round-trip, trimming wasted seeks under load.

## Common Failure Patterns

**1. Geometry-first index, tenant-second filter.** If you create `ON (n.location)` alone, the planner seeks the bounding box and post-filters tenancy. Fix it by making `tenant_id` the leading composite key and confirming the plan with `PROFILE`:

```cypher
PROFILE
MATCH (s:Location {tenant_id: $tenant_id, id: $start_id})
RETURN s.id
// The first operator must read NodeIndexSeek on location_tenant_geo,
// not NodeByLabelScan followed by a Filter on tenant_id.
```

**2. Mixed coordinate reference systems inside one tenant.** A geographic `point({latitude, longitude})` (SRID 4326) and a Cartesian `point({x, y})` (SRID 7203) are not comparable — `point.distance` across them returns `null`, and a `null` predicate silently drops rows, so a tenant sees fewer reachable nodes than it owns. Normalize CRS at ingestion, the same discipline applied by the [spatial indexing strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) layer:

```cypher
// Audit: any tenant node not stored as a geographic point is a routing hole
MATCH (n:Location {tenant_id: $tenant_id})
WHERE n.location.srid <> 4326
RETURN count(n) AS non_wgs84_nodes
```

**3. Stale or shared GDS projections.** Re-using one `routing` projection across tenants, or keeping a projection after re-ingestion, leaks topology and routes against pre-update edges. Name projections per tenant (`routing_<tenant_id>`) and drop them on data change:

```cypher
CALL gds.graph.exists($name) YIELD exists
WITH exists WHERE exists
CALL gds.graph.drop($name) YIELD graphName
RETURN graphName
```

## Performance Notes

The composite index adds write amplification: every insert updates both the geometric structure and the tenant-ordered key. Absorb it with partitioned batch loads (ingest a tenant's data into its own pass, then merge edges), not per-row writes.

The decision that matters most is *project-per-request* versus *cache-the-projection*. A tenant subgraph of `n` nodes and `m` edges costs roughly

$$ C_{\text{project}} \approx \alpha\,(n + m) $$

per projection, while each cached A* run costs about

$$ C_{\text{route}} \approx \beta\,(m + n\log n) $$

If a tenant issues `q` routes between topology changes, projecting per request pays `q \cdot C_{\text{project}}` of avoidable scan cost; caching pays it once. Cache the projection for stable tenants (high `q`, infrequent edits) and project on demand only for high-churn tenants where the topology changes faster than it is queried. For very granular tenancy, hierarchical scoping (`region_id` → `org_id` → `tenant_id`) lets you route at the coarsest index tier that still satisfies isolation, avoiding the index fragmentation that thousands of tiny per-tenant partitions create. Connection lifecycle for these concurrent projections follows the [Neo4j Python driver connection guide](https://neo4j.com/docs/python-manual/current/connect/).

One further property makes this arrangement worth the setup cost: it fails closed. A query that forgets the tenant predicate against a single-tenant projection returns nothing rather than everything, because the foreign nodes are not present to be returned. That is the opposite of the usual outcome for a forgotten filter, and it is the reason to spend the projection cost even where the composite index alone would have been fast enough — the index makes the correct query cheap, and the projection makes the incorrect one harmless.

## Related

- [Spatial Security Boundaries](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-security-boundaries/) — the boundary-aware routing patterns this tenant isolation extends.
- [Spatial Indexing Strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) — choosing the index whose composite key carries the tenant seam.
- [Graph Query Planner Optimization](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/) — making the planner seek the composite index instead of scanning the label.
- [Node and Edge Spatial Mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/) — where the per-tenant `zone`/`tenant_id` tag is first attached to the graph.

This guide is part of [Spatial Security Boundaries](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-security-boundaries/), within [Spatial Graph Database Fundamentals for Python](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/).

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": [
    {
      "@type": "ListItem",
      "position": 1,
      "name": "Spatial Graph Database Fundamentals for Python",
      "item": "https://spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/"
    },
    {
      "@type": "ListItem",
      "position": 2,
      "name": "Spatial Security Boundaries",
      "item": "https://spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-security-boundaries/"
    },
    {
      "@type": "ListItem",
      "position": 3,
      "name": "Enforcing Multi-Tenant Security in Spatial Graphs",
      "item": "https://spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-security-boundaries/enforcing-multi-tenant-security-in-spatial-graphs/"
    }
  ]
}
</script>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "TechArticle",
  "headline": "Enforcing Multi-Tenant Security in Spatial Graphs",
  "description": "Stop cross-tenant leakage in spatial routing graphs with composite tenant-geometry scoping, parameterized Cypher, and tenant-projected GDS routing in async Python.",
  "datePublished": "2025-10-06",
  "dateModified": "2026-06-26",
  "articleSection": "Spatial Security Boundaries",
  "keywords": "multi-tenant spatial graph, tenant isolation, composite spatial index, Neo4j GDS, async Python routing",
  "mainEntityOfPage": {
    "@type": "WebPage",
    "@id": "https://spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-security-boundaries/enforcing-multi-tenant-security-in-spatial-graphs/"
  }
}
</script>
