---
pageTitle: Geohash vs Quadtree Indexing in Neo4j
---
# Implementing Geohash vs Quadtree Indexing in Neo4j

A bounding-box or proximity query over millions of `Location` nodes suddenly costs hundreds of milliseconds, and `PROFILE` shows a `NodeByLabelScan` feeding a `Filter` on `point.distance` instead of an index seek. The root cause is almost always that the access pattern no longer matches the index: Neo4j's native point index is excellent at point range and nearest-neighbor lookups but does not help when you need region sharding or recursive multi-scale containment. This page resolves that mismatch by showing two index encodings you build yourself on top of the graph — a **geohash prefix index** for cache-friendly, shardable lookups, and a **quadtree bounds model** for adaptive partitioning of clustered data — with one runnable async script that ingests, queries, and diagnoses both. It is the hands-on comparison behind the broader [spatial indexing strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) decision.

<svg viewBox="0 0 760 420" role="img" aria-labelledby="gqTitle gqDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="gqTitle">Uniform geohash grid versus adaptive quadtree for the same query window</title>
  <desc id="gqDesc">Left: a uniform 4-by-4 geohash grid where every cell is the same fixed size; a query window overlaps a 3-by-3 block, so the lookup seeks 9 cells (the home cell plus its 8 neighbours) regardless of how many points each holds. Right: a quadtree over the same region that only subdivides where points cluster, producing large leaves in sparse areas and small leaves in the dense corner; the same query window touches 7 small leaves, each holding a bounded number of points.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="760" height="420" fill="var(--viz-bg,#ffffff)"/>
  <text x="195" y="26" text-anchor="middle" font-size="14.5" font-weight="700" fill="currentColor">Uniform geohash grid</text>
  <text x="195" y="44" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.7">fixed cell size · base-32 prefix containment</text>
  <text x="565" y="26" text-anchor="middle" font-size="14.5" font-weight="700" fill="currentColor">Adaptive quadtree</text>
  <text x="565" y="44" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.7">depth follows point density · bounds overlap</text>
  <line x1="380" y1="58" x2="380" y2="360" stroke="currentColor" stroke-width="1" stroke-dasharray="3 6" opacity="0.3"/>
  <!-- LEFT: geohash uniform grid -->
  <rect x="125" y="70" width="210" height="210" fill="var(--accent,#0e7c86)" opacity="0.13"/>
  <g stroke="currentColor" stroke-width="1" opacity="0.55">
    <line x1="55" y1="70" x2="335" y2="70"/>
    <line x1="55" y1="140" x2="335" y2="140"/>
    <line x1="55" y1="210" x2="335" y2="210"/>
    <line x1="55" y1="280" x2="335" y2="280"/>
    <line x1="55" y1="350" x2="335" y2="350"/>
    <line x1="55" y1="70" x2="55" y2="350"/>
    <line x1="125" y1="70" x2="125" y2="350"/>
    <line x1="195" y1="70" x2="195" y2="350"/>
    <line x1="265" y1="70" x2="265" y2="350"/>
    <line x1="335" y1="70" x2="335" y2="350"/>
  </g>
  <g fill="currentColor" opacity="0.75">
    <circle cx="88" cy="108" r="3"/><circle cx="160" cy="120" r="3"/><circle cx="230" cy="105" r="3"/><circle cx="300" cy="118" r="3"/>
    <circle cx="95" cy="178" r="3"/><circle cx="165" cy="188" r="3"/><circle cx="235" cy="175" r="3"/><circle cx="298" cy="185" r="3"/>
    <circle cx="90" cy="248" r="3"/><circle cx="168" cy="252" r="3"/><circle cx="232" cy="245" r="3"/><circle cx="300" cy="250" r="3"/>
    <circle cx="160" cy="318" r="3"/><circle cx="235" cy="315" r="3"/>
  </g>
  <text x="230" y="178" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.85">dr5ru</text>
  <rect x="160" y="105" width="140" height="140" fill="none" stroke="var(--accent,#0e7c86)" stroke-width="2" stroke-dasharray="6 4"/>
  <text x="195" y="376" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">9 cells seeked</text>
  <text x="195" y="392" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">home + 8 neighbours · fixed size</text>
  <!-- RIGHT: adaptive quadtree -->
  <g fill="var(--accent,#0e7c86)" opacity="0.13">
    <rect x="565" y="70" width="70" height="70"/>
    <rect x="635" y="70" width="70" height="70"/>
    <rect x="565" y="140" width="70" height="70"/>
    <rect x="635" y="140" width="35" height="35"/>
    <rect x="670" y="140" width="35" height="35"/>
    <rect x="635" y="175" width="35" height="35"/>
    <rect x="670" y="175" width="35" height="35"/>
  </g>
  <g stroke="currentColor" stroke-width="1" opacity="0.55" fill="none">
    <rect x="425" y="70" width="280" height="280"/>
    <line x1="565" y1="70" x2="565" y2="350"/>
    <line x1="425" y1="210" x2="705" y2="210"/>
    <line x1="635" y1="70" x2="635" y2="210"/>
    <line x1="565" y1="140" x2="705" y2="140"/>
    <line x1="670" y1="140" x2="670" y2="210"/>
    <line x1="635" y1="175" x2="705" y2="175"/>
  </g>
  <g fill="currentColor" opacity="0.75">
    <circle cx="495" cy="140" r="3"/>
    <circle cx="490" cy="290" r="3"/>
    <circle cx="635" cy="290" r="3"/>
    <circle cx="600" cy="95" r="3"/><circle cx="615" cy="112" r="3"/><circle cx="660" cy="100" r="3"/><circle cx="680" cy="118" r="3"/>
    <circle cx="585" cy="160" r="3"/><circle cx="610" cy="170" r="3"/><circle cx="648" cy="158" r="3"/><circle cx="685" cy="165" r="3"/>
    <circle cx="650" cy="192" r="3"/><circle cx="688" cy="195" r="3"/>
  </g>
  <rect x="585" y="95" width="110" height="110" fill="none" stroke="var(--accent,#0e7c86)" stroke-width="2" stroke-dasharray="6 4"/>
  <text x="565" y="376" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">7 leaves seeked</text>
  <text x="565" y="392" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">small where dense · ≤ k points each</text>
  <text x="380" y="412" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.6">Same query window · the uniform grid uses fixed cells, the quadtree scales depth to density</text>
</svg>

## Prerequisites & Versions

These examples use the official async driver and library-side encoding, so the geohash and quadtree logic is version-independent; only the Cypher index syntax assumes Neo4j 5.x.

| Library / runtime | Min version | Install / notes |
| --- | --- | --- |
| Python | 3.10+ | Uses `match`, union types, `asyncio.run` |
| Neo4j | 5.13+ | `CREATE TEXT INDEX`, `CREATE RANGE INDEX`, native `point` |
| neo4j (driver) | 5.18+ | Async API (`AsyncGraphDatabase`) |
| geohash2 | 1.1+ | `encode`, `decode`, `neighbors` for prefix grids |

```bash
pip install "neo4j>=5.18" "geohash2>=1.1"
```

This guide assumes coordinates are already stored as native `point` values following sound [node and edge spatial mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/) conventions — the geohash string and quadtree bounds are *derived* shard keys layered alongside the canonical `location` point, never a replacement for it.

## Implementation

The script below is self-contained. It creates a `TEXT` index for geohash prefix seeks and a `RANGE` index for quadtree bound comparisons, ingests a node populated with both encodings, then runs each query strategy. Both query methods are index-seekable; neither falls back to a label scan.

```python
import asyncio
import math
from neo4j import AsyncGraphDatabase
import geohash2

URI = "neo4j+s://your-cluster.databases.neo4j.io"
AUTH = ("neo4j", "secure_password")

# A geohash precision-8 cell is ~38 m; level-16 quadtree leaf is ~275 m at the equator.
GEOHASH_PRECISION = 8


def quad_bounds(lat: float, lon: float, level: int) -> dict:
    """Snap a coordinate to the quadtree leaf bounds at the given level.

    Level 0 spans the whole globe (lon -180..180, lat -90..90); each level
    halves the extent on both axes, so a leaf at `level` is one of 4**level cells.
    """
    lon_span = 360.0 / (2 ** level)
    lat_span = 180.0 / (2 ** level)
    min_lon = math.floor((lon + 180.0) / lon_span) * lon_span - 180.0
    min_lat = math.floor((lat + 90.0) / lat_span) * lat_span - 90.0
    return {
        "min_lon": min_lon, "max_lon": min_lon + lon_span,
        "min_lat": min_lat, "max_lat": min_lat + lat_span,
    }


def radius_to_quad_level(radius_km: float, lat: float) -> int:
    """Pick the deepest quadtree level whose cell still contains the radius."""
    lat_deg = radius_km / 111.32
    lon_deg = lat_deg / max(math.cos(math.radians(lat)), 1e-6)
    span = max(lat_deg, lon_deg) * 2.0          # cell must cover the diameter
    return max(1, int(math.floor(math.log2(360.0 / span))))


class SpatialIndexRouter:
    def __init__(self, uri: str, auth: tuple[str, str], pool_size: int = 50):
        self.driver = AsyncGraphDatabase.driver(
            uri, auth=auth,
            max_connection_pool_size=pool_size,
            connection_acquisition_timeout=10.0,
        )

    async def create_indexes(self) -> None:
        async with self.driver.session(database="neo4j") as s:
            # TEXT index makes STARTS WITH prefix seeks index-backed.
            await s.run(
                "CREATE TEXT INDEX loc_geohash IF NOT EXISTS "
                "FOR (n:Location) ON (n.geohash)"
            )
            # Composite RANGE index backs the quadtree bound comparisons.
            await s.run(
                "CREATE RANGE INDEX loc_quad IF NOT EXISTS "
                "FOR (n:Location) ON (n.min_lat, n.min_lon)"
            )

    async def ingest(self, node_id: int, lat: float, lon: float,
                     quad_level: int = 16) -> None:
        gh = geohash2.encode(lat, lon, GEOHASH_PRECISION)
        b = quad_bounds(lat, lon, quad_level)
        async with self.driver.session(database="neo4j") as s:
            await s.run(
                """
                MERGE (n:Location {id: $id})
                SET n.location = point({srid: 4326, latitude: $lat, longitude: $lon}),
                    n.geohash    = $gh,
                    n.quad_level = $level,
                    n.min_lat = $min_lat, n.max_lat = $max_lat,
                    n.min_lon = $min_lon, n.max_lon = $max_lon
                """,
                id=node_id, lat=lat, lon=lon, gh=gh, level=quad_level, **b,
            )

    async def query_geohash(self, lat: float, lon: float, prefix_len: int = 6):
        """Prefix-seek the home cell plus its 8 neighbours, then sort by exact distance."""
        home = geohash2.encode(lat, lon, prefix_len)
        cells = {home, *geohash2.neighbors(home)}
        async with self.driver.session(database="neo4j") as s:
            result = await s.run(
                """
                WITH point({srid: 4326, latitude: $lat, longitude: $lon}) AS t
                UNWIND $cells AS cell
                MATCH (n:Location)
                WHERE n.geohash STARTS WITH cell
                WITH DISTINCT n, t, point.distance(n.location, t) AS dist_m
                RETURN n.id AS id, dist_m ORDER BY dist_m ASC LIMIT 25
                """,
                lat=lat, lon=lon, cells=list(cells),
            )
            return [r.data() async for r in result]

    async def query_quadtree(self, lat: float, lon: float, radius_km: float):
        """Range-seek every leaf whose bounds overlap the query window."""
        level = radius_to_quad_level(radius_km, lat)
        d_lat = radius_km / 111.32
        d_lon = d_lat / max(math.cos(math.radians(lat)), 1e-6)
        async with self.driver.session(database="neo4j") as s:
            result = await s.run(
                """
                WITH point({srid: 4326, latitude: $lat, longitude: $lon}) AS t
                MATCH (n:Location)
                WHERE n.min_lat <= $max_lat AND n.max_lat >= $min_lat
                  AND n.min_lon <= $max_lon AND n.max_lon >= $min_lon
                WITH n, t, point.distance(n.location, t) AS dist_m
                WHERE dist_m <= $radius_km * 1000
                RETURN n.id AS id, n.quad_level AS level, dist_m
                ORDER BY dist_m ASC LIMIT 25
                """,
                lat=lat, lon=lon, radius_km=radius_km,
                min_lat=lat - d_lat, max_lat=lat + d_lat,
                min_lon=lon - d_lon, max_lon=lon + d_lon,
            )
            return [r.data() async for r in result]

    async def close(self) -> None:
        await self.driver.close()


async def main():
    router = SpatialIndexRouter(URI, AUTH)
    try:
        await router.create_indexes()
        await router.ingest(8842, 40.7128, -74.0060)   # Lower Manhattan
        print("geohash:", await router.query_geohash(40.7130, -74.0065))
        print("quadtree:", await router.query_quadtree(40.7130, -74.0065, radius_km=2.0))
    finally:
        await router.close()


if __name__ == "__main__":
    asyncio.run(main())
```

## How It Works

Both strategies share the same two-stage shape — a cheap, index-seekable predicate narrows the candidate set, then exact `point.distance` ranks the survivors — but they differ in how the cheap predicate is encoded.

- **Geohash is a string-prefix containment test.** `geohash2.encode` interleaves latitude/longitude bits into a base-32 string, so a shared prefix *is* spatial containment. `WHERE n.geohash STARTS WITH cell` resolves against the `TEXT` index as a range seek, never touching the spatial subsystem. The crucial correctness detail is in `query_geohash`: a single prefix misses points that sit just across a cell border, so the query always seeks the home cell plus its eight `neighbors` and deduplicates with `DISTINCT`.
- **Quadtree is an interval-overlap test.** Each node carries precomputed `min_lat`/`max_lat`/`min_lon`/`max_lon` for its leaf, and `radius_to_quad_level` chooses the depth whose cell comfortably contains the query diameter. The four range comparisons are seekable against the composite `RANGE` index, so the planner enters through `loc_quad` and only the overlapping leaves reach the distance call.
- **The native point stays canonical.** Both methods still call `point.distance(n.location, t)` for the exact result; the geohash and quadtree encodings only decide *which* nodes are scored. This keeps results identical to a brute-force distance query while collapsing the candidate count — the same selectivity discipline that the planner relies on in [graph query planner optimization](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/).

<svg viewBox="0 0 720 558" role="img" aria-labelledby="seqTitle seqDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="seqTitle">Two-stage spatial lookup: index seek narrows candidates, then exact distance ranks them</title>
  <desc id="seqDesc">Flow from top to bottom. The full Location set of about 5 million nodes is never fully scanned. Stage 1 is an index seek using either a geohash TEXT prefix seek or a quadtree RANGE bounds seek, narrowing to roughly 300 candidate rows. Stage 2 scores those candidates with the exact point.distance metric. Stage 3 orders by distance ascending and limits to the 25 nearest rows returned.</desc>
  <defs>
    <marker id="seqArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <rect class="viz-backdrop" x="0" y="0" width="720" height="558" fill="var(--viz-bg,#ffffff)"/>
  <rect x="210" y="28" width="300" height="48" rx="8" fill="none" stroke="currentColor" stroke-width="1.6"/>
  <text x="360" y="49" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">Location nodes</text>
  <text x="360" y="66" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.75">N ≈ 5,000,000 · never fully scanned</text>
  <line x1="360" y1="76" x2="205" y2="127" stroke="currentColor" stroke-width="1.6" marker-end="url(#seqArrow)"/>
  <line x1="360" y1="76" x2="515" y2="127" stroke="currentColor" stroke-width="1.6" marker-end="url(#seqArrow)"/>
  <text x="70" y="118" text-anchor="start" font-size="11" font-weight="700" fill="currentColor" opacity="0.8">Stage 1 · index seek (pick one)</text>
  <rect x="70" y="130" width="270" height="86" rx="8" fill="var(--accent,#0e7c86)" opacity="0.10"/>
  <rect x="70" y="130" width="270" height="86" rx="8" fill="none" stroke="var(--accent,#0e7c86)" stroke-width="1.6"/>
  <text x="205" y="154" text-anchor="middle" font-size="12.5" font-weight="700" fill="currentColor">Geohash prefix seek</text>
  <text x="205" y="174" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.8">TEXT index · n.geohash STARTS WITH cell</text>
  <text x="205" y="191" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.8">home + 8 neighbour cells</text>
  <text x="205" y="208" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.6">range seek — no NodeByLabelScan</text>
  <rect x="380" y="130" width="270" height="86" rx="8" fill="var(--accent,#0e7c86)" opacity="0.10"/>
  <rect x="380" y="130" width="270" height="86" rx="8" fill="none" stroke="var(--accent,#0e7c86)" stroke-width="1.6"/>
  <text x="515" y="154" text-anchor="middle" font-size="12.5" font-weight="700" fill="currentColor">Quadtree bounds seek</text>
  <text x="515" y="174" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.8">RANGE index · min/max lat-lon overlap</text>
  <text x="515" y="191" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.8">leaves intersecting the window</text>
  <text x="515" y="208" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.6">range seek — no NodeByLabelScan</text>
  <line x1="205" y1="216" x2="345" y2="266" stroke="currentColor" stroke-width="1.6" marker-end="url(#seqArrow)"/>
  <line x1="515" y1="216" x2="375" y2="266" stroke="currentColor" stroke-width="1.6" marker-end="url(#seqArrow)"/>
  <rect x="235" y="268" width="250" height="56" rx="8" fill="none" stroke="currentColor" stroke-width="1.6"/>
  <text x="360" y="290" text-anchor="middle" font-size="12.5" font-weight="700" fill="currentColor">Candidate set ≈ 300 rows</text>
  <text x="360" y="308" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">index-narrowed · ~0.006% of N</text>
  <line x1="360" y1="324" x2="360" y2="390" stroke="currentColor" stroke-width="1.6" marker-end="url(#seqArrow)"/>
  <text x="372" y="354" text-anchor="start" font-size="10" fill="currentColor" opacity="0.7">only candidates are scored</text>
  <text x="70" y="388" text-anchor="start" font-size="11" font-weight="700" fill="currentColor" opacity="0.8">Stage 2 · exact scoring</text>
  <rect x="160" y="394" width="400" height="58" rx="8" fill="none" stroke="currentColor" stroke-width="1.6"/>
  <text x="360" y="417" text-anchor="middle" font-size="12.5" font-weight="700" fill="currentColor">point.distance(n.location, t) AS dist_m</text>
  <text x="360" y="435" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.75">exact metric on the canonical SRID-4326 point</text>
  <line x1="360" y1="452" x2="360" y2="492" stroke="currentColor" stroke-width="1.6" marker-end="url(#seqArrow)"/>
  <text x="70" y="510" text-anchor="start" font-size="11" font-weight="700" fill="currentColor" opacity="0.8">Stage 3 · rank &amp; cut</text>
  <rect x="210" y="494" width="300" height="50" rx="8" fill="var(--accent,#0e7c86)" opacity="0.12"/>
  <rect x="210" y="494" width="300" height="50" rx="8" fill="none" stroke="var(--accent,#0e7c86)" stroke-width="1.8"/>
  <text x="360" y="516" text-anchor="middle" font-size="12.5" font-weight="700" fill="currentColor">ORDER BY dist_m ASC LIMIT 25</text>
  <text x="360" y="534" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.78">25 nearest rows returned</text>
</svg>

## Common Failure Patterns

**1. Prefix-only geohash queries silently drop boundary neighbours.** Querying just the home cell returns wrong results for any point near a cell edge — a classic source of "the nearest hub is missing" bugs. Always expand to the surrounding cells before scoring:

```python
home = geohash2.encode(lat, lon, prefix_len)
cells = {home, *geohash2.neighbors(home)}   # 9 cells, not 1
```

**2. The quadtree predicate degrades to a label scan when the index is missing or the property is null.** If `min_lat`/`min_lon` are absent on some nodes (partial ingestion) or no composite `RANGE` index exists, the planner falls back to `NodeByLabelScan` and `DbHits` explode under load. Confirm the seek and backfill missing bounds:

```cypher
// Confirm a seek, not a scan
EXPLAIN
MATCH (n:Location)
WHERE n.min_lat <= $max_lat AND n.max_lat >= $min_lat
RETURN n.id;
// Backfill any nodes that predate the quadtree model
MATCH (n:Location) WHERE n.min_lat IS NULL RETURN count(n);
```

**3. Mixed or missing SRID makes `point.distance` return null, dropping rows.** A geographic `point({srid:4326,...})` and a Cartesian `point({x,y})` are not comparable; the distance is `null`, and a `null <= radius` predicate quietly removes the row instead of erroring. Pin the SRID at ingestion (as the script does with `srid: 4326`) and assert it before querying. These boundary, null, and fallback traps overlap with the predicate-shape pitfalls covered in [distance filter query patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/).

## Performance Notes

The two encodings trade write cost against query locality. Geohash strings are append-only — an updated coordinate just rewrites one string property, so write amplification is low and the `TEXT` index compresses well. Quadtree bounds must be recomputed and re-seeked whenever a node moves across a leaf boundary, so high-churn mobility data pays a relocation cost the geohash model avoids. Choose quadtree only when you genuinely need adaptive depth over clustered data or multi-scale analytics; otherwise geohash wins on simplicity, shardability, and cache locality.

A geohash cell's dimensions follow directly from how many bits each precision level allocates. At precision $p$ there are $5p$ bits split between the two axes, giving cell spans:

$$
\Delta_{\text{lon}} = \frac{360^\circ}{2^{\lceil 5p/2 \rceil}}, \qquad
\Delta_{\text{lat}} = \frac{180^\circ}{2^{\lfloor 5p/2 \rfloor}}
$$

So precision 6 is roughly 1.2 km, precision 7 roughly 150 m, and precision 8 roughly 38 m. Pick the precision whose cell comfortably exceeds your query radius, then seek that cell plus its neighbours — too fine and you scan many cells, too coarse and the candidate set balloons before the distance filter runs. The equivalent quadtree depth $d$ needed to bound a radius $r$ (km) at latitude $\phi$ is:

$$
d = \left\lfloor \log_2\!\frac{360^\circ}{2 \cdot \max(\Delta_\phi, \Delta_\lambda)} \right\rfloor,
\quad \Delta_\phi = \frac{r}{111.32}, \;\; \Delta_\lambda = \frac{\Delta_\phi}{\cos\phi}
$$

Switch from geohash to quadtree when point density varies by more than an order of magnitude across the map — uniform grids waste depth on sparse regions and overflow in dense ones, where adaptive subdivision keeps leaf occupancy bounded. For the inverse pattern (a fixed-k nearest search rather than a fixed radius), the bounded scan generalizes to [k-nearest-neighbor routing](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/k-nearest-neighbor-routing/). Verify index health for either encoding with `SHOW INDEXES YIELD name, state, type` and confirm `state` is `ONLINE`.

For authoritative reference on index syntax and geometry semantics, consult the [Neo4j Cypher Manual on search-performance indexes](https://neo4j.com/docs/cypher-manual/current/indexes/search-performance-indexes/) and the underlying [geohash algorithm](https://en.wikipedia.org/wiki/Geohash).

## Related

- [Spatial Indexing Strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) — choosing R-tree, geohash, or quadtree for a given access pattern.
- [Node and Edge Spatial Mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/) — storing geometry as native points the index can seek.
- [Graph Query Planner Optimization](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/) — making the planner consume the selectivity these encodings expose.
- [Distance Filter Query Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/) — index-seekable predicate shapes for proximity queries.
- [K-Nearest-Neighbor Routing](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/k-nearest-neighbor-routing/) — fixed-k search built on the same bounded scan.

This guide is part of [Spatial Indexing Strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/), within [Spatial Graph Database Fundamentals for Python](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/).
