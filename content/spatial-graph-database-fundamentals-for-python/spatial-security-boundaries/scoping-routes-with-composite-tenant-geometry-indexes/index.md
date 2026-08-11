---
pageTitle: Composite Tenant-Geometry Indexes
title: Scoping Routes with Composite Tenant-Geometry Indexes
description: Build a composite tenant-geometry index so a tenant-scoped radius or route query resolves the tenant filter and spatial predicate in one Neo4j index seek
slug: scoping-routes-with-composite-tenant-geometry-indexes
type: article
breadcrumb: Composite Tenant Indexes
datePublished: 2026-07-14
dateModified: 2026-07-14
---
# Scoping Routes with Composite Tenant-Geometry Indexes

A tenant-scoped radius query that leans on a native point index seeks the bounding box first and checks tenancy last. On a shared graph that is exactly backwards: the point index ranks candidates by proximity alone, so a `NodeIndexSeek` on `location` reads every tenant's nodes inside the corridor, and a trailing `Filter tenant_id = $t` drops the foreign ones only after they have been materialized. The db hits scale with the number of tenants co-located in that box, and the gap between the seek and the filter is the same window where a missing predicate leaks a neighbour's depot into a route. This page fixes the access path rather than the query text: it folds `tenant_id` into a single composite index so one seek resolves the tenant equality and the spatial range together — and it confronts head-on the fact that Neo4j point indexes cannot be composite, which is where most attempts at this quietly fall back to a scan.

The broader isolation model — parameterized Cypher, per-tenant GDS projections, and why the boundary is a security control — lives in [enforcing multi-tenant security in spatial graphs](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-security-boundaries/enforcing-multi-tenant-security-in-spatial-graphs/). Here the scope is narrower and mechanical: the index structure that makes the composite seek possible, and proving push-down with `PROFILE`.

## Prerequisites & Versions

The technique needs a composite range index and a precomputed scalar spatial key on every routable node. No GDS or APOC dependency is required for the seek itself.

| Requirement | Minimum version | Note |
| --- | --- | --- |
| Python | 3.10+ | `dataclass` and union syntax used below |
| Neo4j | 5.15+ | Composite `RANGE` index, native `point`, `point.distance()` |
| neo4j (driver) | 5.x | `AsyncGraphDatabase`, native point serialization |

```bash
pip install "neo4j>=5.18"
```

Every `:Location` node must already carry a `tenant_id`, a WGS 84 `location` point, and a precomputed `geocell` grid key before the index is built — back-filling the scalar key afterward leaves nodes that satisfy the geometry but sit outside the composite seek.

<svg viewBox="0 0 760 470" role="img" aria-labelledby="cmpTitle cmpDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="cmpTitle">Post-scan tenant filter versus a composite tenant-geometry index seek</title>
  <desc id="cmpDesc">Left: a point-index seek on location alone reads nodes from tenant A and tenant B inside the bounding box, then a trailing Filter on tenant_id drops tenant B after the rows are already materialized, so db hits scale with tenant count. Right: a composite range index on tenant_id then geocell puts tenant_id as the leading equality key, so the seek admits only tenant A nodes in the covering cells and no foreign rows are ever read before the point.distance guard runs.</desc>
  <defs>
    <marker id="cmp-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <rect class="viz-backdrop" x="0" y="0" width="760" height="470" fill="var(--viz-bg,#ffffff)"/>
  <line x1="380" y1="44" x2="380" y2="440" stroke="currentColor" stroke-width="1" stroke-dasharray="3 6" opacity="0.3"/>
  <!-- LEFT: post-scan filter -->
  <text x="190" y="26" text-anchor="middle" font-size="14.5" font-weight="700" fill="currentColor">Post-scan filter — slow</text>
  <text x="190" y="44" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7">POINT INDEX ON (location) · tenant last</text>
  <g fill="none" stroke="var(--accent,#0a656d)" stroke-width="1.6">
    <rect x="55" y="56" width="270" height="58" rx="8"/>
    <rect x="55" y="252" width="270" height="58" rx="8"/>
  </g>
  <rect x="55" y="150" width="270" height="66" rx="8" fill="var(--accent-coral,#ff6b6b)" opacity="0.13"/>
  <rect x="55" y="150" width="270" height="66" rx="8" fill="none" stroke="var(--accent-coral,#ff6b6b)" stroke-width="2.4"/>
  <line x1="190" y1="114" x2="190" y2="148" stroke="currentColor" stroke-width="1.6" marker-end="url(#cmp-arrow)"/>
  <line x1="190" y1="216" x2="190" y2="250" stroke="currentColor" stroke-width="1.6" marker-end="url(#cmp-arrow)"/>
  <text x="190" y="80" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">NodeIndexSeek — location</text>
  <text x="190" y="98" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.72">box range, all tenants ranked</text>
  <text x="190" y="174" text-anchor="middle" font-size="12.5" font-weight="700" fill="currentColor">rows: tenant A + B</text>
  <g>
    <circle cx="139" cy="196" r="4.6" fill="var(--accent,#0a656d)"/>
    <circle cx="161" cy="196" r="4.6" fill="var(--accent,#0a656d)"/>
    <circle cx="183" cy="196" r="4.6" fill="var(--accent,#0a656d)"/>
    <circle cx="205" cy="196" r="4.6" fill="var(--accent-coral,#ff6b6b)"/>
    <circle cx="227" cy="196" r="4.6" fill="var(--accent-coral,#ff6b6b)"/>
    <circle cx="249" cy="196" r="4.6" fill="var(--accent-coral,#ff6b6b)"/>
  </g>
  <text x="190" y="276" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">Filter tenant_id = A</text>
  <text x="190" y="294" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.72">drops tenant B — already read</text>
  <rect x="55" y="360" width="270" height="50" rx="8" fill="var(--accent-coral,#ff6b6b)" opacity="0.14"/>
  <rect x="55" y="360" width="270" height="50" rx="8" fill="none" stroke="var(--accent-coral,#ff6b6b)" stroke-width="1.4"/>
  <text x="190" y="382" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">db hits scale with tenant count</text>
  <text x="190" y="399" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.78">foreign rows materialized first</text>
  <!-- RIGHT: composite seek -->
  <text x="570" y="26" text-anchor="middle" font-size="14.5" font-weight="700" fill="currentColor">Composite seek — fast</text>
  <text x="570" y="44" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.7">RANGE INDEX ON (tenant_id, geocell)</text>
  <g fill="none" stroke="var(--accent,#0a656d)" stroke-width="1.6">
    <rect x="435" y="56" width="270" height="58" rx="8" stroke-width="2.4"/>
    <rect x="435" y="252" width="270" height="58" rx="8"/>
  </g>
  <rect x="435" y="150" width="270" height="66" rx="8" fill="var(--accent,#0a656d)" opacity="0.12"/>
  <rect x="435" y="150" width="270" height="66" rx="8" fill="none" stroke="var(--accent,#0a656d)" stroke-width="1.6"/>
  <line x1="570" y1="114" x2="570" y2="148" stroke="currentColor" stroke-width="1.6" marker-end="url(#cmp-arrow)"/>
  <line x1="570" y1="216" x2="570" y2="250" stroke="currentColor" stroke-width="1.6" marker-end="url(#cmp-arrow)"/>
  <text x="570" y="80" text-anchor="middle" font-size="12.5" font-weight="700" fill="currentColor">NodeIndexSeek — (tenant_id, geocell)</text>
  <text x="570" y="98" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.72">tenant equality leads, cell range trails</text>
  <text x="570" y="174" text-anchor="middle" font-size="12.5" font-weight="700" fill="currentColor">rows: tenant A only</text>
  <g>
    <circle cx="548" cy="196" r="4.6" fill="var(--accent,#0a656d)"/>
    <circle cx="570" cy="196" r="4.6" fill="var(--accent,#0a656d)"/>
    <circle cx="592" cy="196" r="4.6" fill="var(--accent,#0a656d)"/>
  </g>
  <text x="570" y="276" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">Filter point.distance ≤ r</text>
  <text x="570" y="294" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.72">clips box corners to the circle</text>
  <rect x="435" y="360" width="270" height="50" rx="8" fill="var(--accent,#0a656d)" opacity="0.14"/>
  <rect x="435" y="360" width="270" height="50" rx="8" fill="none" stroke="var(--accent,#0a656d)" stroke-width="1.4"/>
  <text x="570" y="382" text-anchor="middle" font-size="12" font-weight="700" fill="currentColor">db hits scale with local density</text>
  <text x="570" y="399" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.78">foreign rows never read</text>
  <text x="380" y="432" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.62">read bottom-up · teal = tenant A, coral = tenant B · same data, two access paths</text>
</svg>

## Implementation

Neo4j point indexes are single-property, so `ON (n.tenant_id, n.location)` cannot be a point index — that constraint is the whole reason this technique exists. The workaround that keeps a *true* composite seek is to precompute a scalar spatial key, a coarse integer grid cell, alongside the point, then build a composite **range** index whose leading key is `tenant_id` and whose trailing key is that cell. The tenant equality resolves the leading key exactly; the covering cells for the search box resolve the trailing key by membership; the exact `point.distance()` guard clips the box corners afterward.

The Python side computes the search box, enumerates the grid cells overlapping it, and passes `tenant_id` plus the cell list as parameters. Coordinates below are for a Chicago logistics tenant.

```python
import asyncio
import math
from dataclasses import dataclass
from neo4j import AsyncDriver, AsyncGraphDatabase

CELL_DEG = 0.01          # ~1.1 km grid cell near the equator
_ROW_STRIDE = 100_000    # packs (row, col) into one collision-free integer


def geocell(lat: float, lon: float) -> int:
    """Deterministic integer grid cell — the composite index trailing key."""
    row = math.floor((lat + 90.0) / CELL_DEG)
    col = math.floor((lon + 180.0) / CELL_DEG)
    return row * _ROW_STRIDE + col


def bounding_box(lat: float, lon: float, radius_m: float) -> tuple[float, float, float, float]:
    R = 6_371_000.0
    d_lat = math.degrees(radius_m / R)
    d_lon = math.degrees(radius_m / (R * math.cos(math.radians(lat))))
    return lat - d_lat, lat + d_lat, lon - d_lon, lon + d_lon


def covering_cells(min_lat: float, max_lat: float, min_lon: float, max_lon: float) -> list[int]:
    """Every grid cell id that overlaps the query box — the IN-list for the trailing key."""
    r0 = math.floor((min_lat + 90.0) / CELL_DEG)
    r1 = math.floor((max_lat + 90.0) / CELL_DEG)
    c0 = math.floor((min_lon + 180.0) / CELL_DEG)
    c1 = math.floor((max_lon + 180.0) / CELL_DEG)
    return [r * _ROW_STRIDE + c for r in range(r0, r1 + 1) for c in range(c0, c1 + 1)]


@dataclass
class TenantRadiusQuery:
    tenant_id: str
    lat: float
    lon: float
    radius_m: float


RADIUS_CYPHER = """
MATCH (n:Location)
WHERE n.tenant_id = $tenant_id AND n.geocell IN $cells
WITH n, point.distance(
       n.location, point({srid: 4326, latitude: $lat, longitude: $lon})) AS dist_m
WHERE dist_m <= $radius
RETURN n.id AS id, dist_m
ORDER BY dist_m ASC
LIMIT 100
"""


async def ensure_schema(driver: AsyncDriver) -> None:
    """Composite RANGE index: tenant_id (equality) then geocell (range/IN)."""
    async with driver.session() as session:
        await session.run(
            "CREATE INDEX location_tenant_cell IF NOT EXISTS "
            "FOR (n:Location) ON (n.tenant_id, n.geocell)"
        )
        # Point index still backs the exact point.distance guard on the survivors.
        await session.run(
            "CREATE POINT INDEX location_geo IF NOT EXISTS "
            "FOR (n:Location) ON (n.location)"
        )


async def query_tenant_radius(driver: AsyncDriver, q: TenantRadiusQuery) -> list[dict]:
    min_lat, max_lat, min_lon, max_lon = bounding_box(q.lat, q.lon, q.radius_m)
    cells = covering_cells(min_lat, max_lat, min_lon, max_lon)
    async with driver.session(database="neo4j") as session:
        result = await session.run(
            RADIUS_CYPHER,
            tenant_id=q.tenant_id,
            cells=cells,
            lat=q.lat,
            lon=q.lon,
            radius=q.radius_m,
        )
        return [record.data() async for record in result]


async def main() -> None:
    driver = AsyncGraphDatabase.driver(
        "neo4j+s://your-cluster.databases.neo4j.io",
        auth=("neo4j", "secure-password"),
        max_connection_pool_size=40,
        connection_acquisition_timeout=5.0,
    )
    try:
        await ensure_schema(driver)
        q = TenantRadiusQuery(tenant_id="acme-logistics", lat=41.8781, lon=-87.6298, radius_m=3000)
        hits = await query_tenant_radius(driver, q)
        print(f"{len(hits)} nodes within {q.radius_m} m for tenant {q.tenant_id}")
    finally:
        await driver.close()


if __name__ == "__main__":
    asyncio.run(main())
```

To scope a *route* rather than a radius, anchor the endpoints through the same composite predicate — `MATCH (s:Location) WHERE s.tenant_id = $tenant_id AND s.geocell IN $cells AND s.id = $start_id` — so the origin and destination lookups seek the composite index before any `shortestPath` expansion begins, keeping the whole traversal inside the tenant's cells.

## How It Works

The seek behaviour follows from key order, and each piece maps to a line above.

- **The leading key is an equality predicate.** A composite range index is ordered first by `tenant_id`, then by `geocell`. Because the query pins `tenant_id = $tenant_id` exactly, the planner descends straight to that tenant's slice of the index and never touches another tenant's entries. The `geocell IN $cells` membership then resolves the trailing key as a set of bounded sub-seeks within that slice.
- **The grid cell is the spatial key the range index can seek.** A range index cannot do a two-dimensional bounding-box seek the way a point index does, so `covering_cells` flattens the box into a one-dimensional set of integer cells computed client-side. Passing them as an `IN` list keeps the predicate index-seekable and the plan cacheable; deriving cells per row in Cypher would defeat the seek exactly as a per-row trig box does in [distance filter query patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/).
- **The point distance guard restores exact geometry.** Grid cells are square and coarser than the radius, so `point.distance()` on the bounded survivors clips the corners back to a true circle. It runs on a candidate set already reduced to one tenant, so its cost is bounded by local density, not by the whole label.

<svg viewBox="0 0 780 316" role="img" aria-labelledby="gcTitle gcDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="gcTitle">Flattening a box into integer cells is what makes a range index seekable in two dimensions</title>
  <desc id="gcDesc">A range index is one-dimensional and cannot seek a bounding box the way a point index can. The client converts the radius into a bounding box, then into the set of integer grid cells covering it — here six cells. The query pins tenant_id as an equality on the leading key and passes the cells as an IN list on the trailing key, so the plan is a descent into the tenant's slice followed by six bounded sub-seeks. The cells are square and coarser than the radius, so a final point.distance guard clips the corners back to a true circle, on a candidate set already reduced to one tenant.</desc>
  <defs>
    <marker id="gc-a" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="316" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Radius → box → cell set → one seek per cell, inside one tenant</text>
  <rect x="24" y="42" width="216" height="180" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.2"/>
  <text x="132" y="64" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">computed client-side</text>
  <g stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1">
    <line x1="52" y1="84" x2="212" y2="84"/><line x1="52" y1="124" x2="212" y2="124"/><line x1="52" y1="164" x2="212" y2="164"/><line x1="52" y1="204" x2="212" y2="204"/>
    <line x1="52" y1="84" x2="52" y2="204"/><line x1="105" y1="84" x2="105" y2="204"/><line x1="158" y1="84" x2="158" y2="204"/><line x1="212" y1="84" x2="212" y2="204"/>
  </g>
  <rect x="52" y="84" width="160" height="80" fill="var(--accent,#0a656d)" opacity="0.14"/>
  <rect x="52" y="84" width="160" height="80" fill="none" stroke="var(--accent,#0a656d)" stroke-width="1.8"/>
  <circle cx="132" cy="124" r="38" fill="none" stroke="var(--accent-3,#5b21b6)" stroke-width="1.8" stroke-dasharray="6 4"/>
  <circle cx="132" cy="124" r="5" fill="var(--accent-3,#5b21b6)"/>
  <text x="132" y="216" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">6 covering cells</text>
  <line x1="240" y1="124" x2="284" y2="124" stroke="currentColor" stroke-width="1.6" marker-end="url(#gc-a)"/>
  <rect x="288" y="42" width="468" height="180" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="1.8"/>
  <text x="522" y="64" text-anchor="middle" font-size="11" font-weight="700" fill="var(--viz-good,#0a656d)">composite range index (tenant_id, geocell)</text>
  <rect x="308" y="78" width="428" height="24" rx="6" fill="var(--viz-good,#0a656d)"/>
  <text x="522" y="95" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--viz-on-pill,#ffffff)">tenant_id = $tenant_id — equality on the leading key</text>
  <line x1="522" y1="102" x2="522" y2="118" stroke="currentColor" stroke-width="1.5" marker-end="url(#gc-a)"/>
  <text x="522" y="134" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">geocell IN $cells — six bounded sub-seeks in that slice</text>
  <g font-size="9.5" text-anchor="middle" font-weight="700">
    <rect x="316" y="144" width="64" height="22" rx="5" fill="var(--accent,#0a656d)"/><text x="348" y="159" fill="var(--viz-on-pill,#ffffff)">c1</text>
    <rect x="388" y="144" width="64" height="22" rx="5" fill="var(--accent,#0a656d)"/><text x="420" y="159" fill="var(--viz-on-pill,#ffffff)">c2</text>
    <rect x="460" y="144" width="64" height="22" rx="5" fill="var(--accent,#0a656d)"/><text x="492" y="159" fill="var(--viz-on-pill,#ffffff)">c3</text>
    <rect x="532" y="144" width="64" height="22" rx="5" fill="var(--accent,#0a656d)"/><text x="564" y="159" fill="var(--viz-on-pill,#ffffff)">c4</text>
    <rect x="604" y="144" width="64" height="22" rx="5" fill="var(--accent,#0a656d)"/><text x="636" y="159" fill="var(--viz-on-pill,#ffffff)">c5</text>
    <rect x="676" y="144" width="60" height="22" rx="5" fill="var(--accent,#0a656d)"/><text x="706" y="159" fill="var(--viz-on-pill,#ffffff)">c6</text>
  </g>
  <rect x="308" y="180" width="428" height="26" rx="6" fill="var(--viz-panel-2,#ece9df)" stroke="var(--accent-2,#a8380b)" stroke-width="1.4"/>
  <text x="522" y="198" text-anchor="middle" font-size="10.5" font-weight="700" fill="currentColor">point.distance() clips the square corners back to the circle</text>
  <text x="24" y="252" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">Deriving the cells inside Cypher would defeat the whole arrangement: a per-row expression on the indexed property</text>
  <text x="24" y="268" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">is not seekable, so the plan would fall back to a scan and the tenant key would stop being a descent and become a</text>
  <text x="24" y="284" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">filter. Passing the cell list as a parameter also keeps one cached plan whether the box covers two cells or nine.</text>
</svg>

Client-side box and cell computation is what keeps `tenant_id` as the resolved leading key rather than a predicate the engine discovers mid-scan — the same planner-seek discipline detailed in [graph query planner optimization](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/).

## Common Failure Patterns

**1. Trying to make the point index composite.** `CREATE POINT INDEX ... FOR (n:Location) ON (n.tenant_id, n.location)` fails — point indexes take exactly one property. There are two honest ways to get a composite access path, and picking one is a real trade-off:

```cypher
// Option A (this page): composite RANGE index on a precomputed scalar cell.
CREATE INDEX location_tenant_cell IF NOT EXISTS
FOR (n:Location) ON (n.tenant_id, n.geocell);

// Option B: tenant-partitioned label with a native per-tenant POINT index.
// Keeps exact point-index seeks, but multiplies indexes and complicates admin.
CREATE POINT INDEX loc_tenant_acme IF NOT EXISTS
FOR (n:Location:Tenant_acme) ON (n.location);
```

Option A keeps one index for all tenants and a true two-dimensional seek collapses to a cell-set seek; Option B keeps native point semantics but you pay an index and a label per tenant, which fragments badly past a few dozen tenants. Choose A for many small tenants, B for a handful of large ones — and see [spatial indexing strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) for how the cell key relates to geohash and quadtree encodings.

**2. Tenant predicate applied after expansion.** If the tenant filter lands *after* a variable-length `MATCH`, it becomes a post-traversal `Filter` and the expansion has already crossed into foreign subgraphs. Keep `tenant_id = $tenant_id` on the anchor node, before any `-[:CONNECTS*]->`, so the composite seek bounds the traversal at its root.

**3. Wrong key order.** Building the index as `ON (n.geocell, n.tenant_id)` inverts the seek: the leading key is now the cell, so the engine reads every tenant present in those cells and filters tenancy last — the exact post-scan shape this technique is meant to remove. The equality predicate must lead. Prove it with `PROFILE`:

```cypher
PROFILE
MATCH (n:Location)
WHERE n.tenant_id = $tenant_id AND n.geocell IN $cells
RETURN count(n)
// Base operator must be NodeIndexSeek on location_tenant_cell,
// never NodeByLabelScan or a NodeIndexSeek on geocell feeding a Filter on tenant_id.
```

Reading these operator trees end to end is covered in [reading EXPLAIN and PROFILE plans for spatial queries](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/reading-explain-and-profile-plans-for-spatial-queries/).

## Performance Notes

The win is a selectivity change at the storage layer. For a box holding $N_{\text{box}}$ nodes across $T$ evenly distributed tenants, the two plans read

$$\text{rows}_{\text{post-scan}} \approx N_{\text{box}}, \qquad \text{rows}_{\text{composite}} \approx \frac{N_{\text{box}}}{T}$$

so the composite seek cuts db hits by roughly a factor of $T$ before the distance guard runs — and on a platform with hundreds of tenants sharing a metro, that factor is the difference between an index seek and an effective scan.

The trailing-key cost is the covering-cell count. For box half-extents $\Delta\phi, \Delta\lambda$ over a cell edge $c$ degrees, the `IN` list carries

$$\lvert \text{cells} \rvert \approx \left(\frac{2\Delta\phi}{c} + 1\right)\left(\frac{2\Delta\lambda}{c} + 1\right)$$

cells, each a sub-seek. Size $c$ near the typical query radius: too coarse and each cell overfetches nodes the distance guard must discard; too fine and the `IN` list balloons into thousands of sub-seeks. At `CELL_DEG = 0.01` a 3 km radius resolves to a handful of cells, which is the sweet spot for city-scale logistics. The composite index does add write amplification — every insert updates the tenant-ordered key as well as the point index — so absorb it with per-tenant batch loads rather than interleaved single-row writes.

## Related

- [Enforcing Multi-Tenant Security in Spatial Graphs](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-security-boundaries/enforcing-multi-tenant-security-in-spatial-graphs/) — the broader isolation model, parameterized Cypher, and per-tenant GDS projections this index underpins.
- [Spatial Indexing Strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) — geohash, quadtree, and R-tree encodings behind the scalar cell key.
- [Reading EXPLAIN and PROFILE Plans for Spatial Queries](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/reading-explain-and-profile-plans-for-spatial-queries/) — confirming the composite seek instead of a post-scan filter.
- [Distance Filter Query Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/) — the box-then-distance predicate the point guard reuses.

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
      "name": "Scoping Routes with Composite Tenant-Geometry Indexes",
      "item": "https://spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-security-boundaries/scoping-routes-with-composite-tenant-geometry-indexes/"
    }
  ]
}
</script>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "TechArticle",
  "headline": "Scoping Routes with Composite Tenant-Geometry Indexes",
  "description": "Build a composite tenant-geometry index so a tenant-scoped radius or route query resolves the tenant filter and spatial predicate in one Neo4j index seek.",
  "datePublished": "2026-07-14",
  "dateModified": "2026-07-14",
  "articleSection": "Spatial Security Boundaries",
  "keywords": "composite spatial index, tenant scoping, Neo4j range index, predicate push-down, async Python routing",
  "mainEntityOfPage": {
    "@type": "WebPage",
    "@id": "https://spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-security-boundaries/scoping-routes-with-composite-tenant-geometry-indexes/"
  }
}
</script>
