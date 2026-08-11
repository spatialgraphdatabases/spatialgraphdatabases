---
pageTitle: KNN Search for Nearby Logistics Hubs
---
# Implementing KNN Search for Nearby Logistics Hubs

Dispatch services that answer "which depots are closest to this drop-off?" stall the moment the query touches every `LogisticsHub` node: with no spatial index, Neo4j falls back to a `NodeByLabelScan`, computes `point.distance()` for millions of rows, then sorts the entire result before applying `LIMIT k`. Under concurrent dispatch load this exhausts page cache, spikes garbage-collection pauses, and pushes p99 latency past timeout thresholds. The fix is a two-step k-nearest-neighbor (KNN) lookup: a client-computed bounding box drives an index seek that shrinks the candidate set to hundreds of nodes, and only those survivors get the exact ellipsoidal distance sort. This page gives a complete, runnable implementation and the failure modes that bite in production. It is a focused recipe within the broader [K-Nearest Neighbor Routing](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/k-nearest-neighbor-routing/) workflow.

<svg viewBox="0 0 820 470" role="img" aria-labelledby="knn-title knn-desc" xmlns="http://www.w3.org/2000/svg">
  <title id="knn-title">Two-phase KNN lookup: box seek then exact distance sort</title>
  <desc id="knn-desc">A horizontal pipeline of four stages. Stage one is the query point (latitude, longitude, k, radius), feeding millions of candidate nodes. Stage two is a bounding-box pre-filter resolved as a PointIndexSeekByRange, shrinking the set to roughly four times density times radius squared candidates. Stage three is an exact point.distance() filter that clips corner false positives, leaving about pi over four of those rows. Stage four sorts the survivors and applies LIMIT k to return the top-K hubs. Below the pipeline, a geometry inset shows the square bounding box with an inscribed radius circle: hubs inside the circle are true hits that are kept, hubs in the four corners between the square and circle are false positives clipped by the distance guard (about 27 percent extra area, a 1.27 times overshoot), and hubs outside the box are skipped by the seek entirely.</desc>
  <style>
    .kn-box{fill:var(--surface-2,#f4f4f5);stroke:var(--line-strong,#9ca3af);stroke-width:1.5;}
    .kn-box2{fill:var(--surface-2,#f4f4f5);stroke:var(--accent,#0e7c86);stroke-width:2;}
    .kn-t{fill:var(--ink,#1f2937);font:700 14px var(--font-sans,system-ui,sans-serif);}
    .kn-s{fill:var(--ink-mute,#6b7280);font:11px var(--font-mono,ui-monospace,monospace);}
    .kn-edge{stroke:currentColor;stroke-width:1.5;fill:none;opacity:.55;}
    .kn-cnt{fill:var(--ink-mute,#6b7280);font:600 11px var(--font-sans,system-ui,sans-serif);}
    .kn-ph{fill:var(--accent,#0e7c86);font:700 12px var(--font-sans,system-ui,sans-serif);}
    .kn-lg{fill:var(--ink-mute,#6b7280);font:12px var(--font-sans,system-ui,sans-serif);}
    .kn-ann{fill:var(--ink,#1f2937);font:700 12px var(--font-sans,system-ui,sans-serif);}
  </style>
  <defs>
    <marker id="kn-arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor" opacity=".55"/>
    </marker>
  </defs>
  <!-- phase brackets -->
  <rect class="viz-backdrop" x="0" y="0" width="820" height="470" fill="var(--viz-bg,#ffffff)"/>
  <text class="kn-ph" x="120" y="26" text-anchor="middle">Phase 1 — index seek</text>
  <text class="kn-ph" x="630" y="26" text-anchor="middle">Phase 2 — bounded sort</text>
  <!-- stage boxes -->
  <rect class="kn-box"  x="18"  y="44" width="186" height="76" rx="10"/>
  <text class="kn-t" x="111" y="78"  text-anchor="middle">Query point</text>
  <text class="kn-s" x="111" y="98"  text-anchor="middle">(lat, lon) · k · radius</text>
  <rect class="kn-box2" x="222" y="44" width="186" height="76" rx="10"/>
  <text class="kn-t" x="315" y="78"  text-anchor="middle">Box pre-filter</text>
  <text class="kn-s" x="315" y="98"  text-anchor="middle">PointIndexSeekByRange</text>
  <rect class="kn-box2" x="426" y="44" width="186" height="76" rx="10"/>
  <text class="kn-t" x="519" y="78"  text-anchor="middle">Exact distance</text>
  <text class="kn-s" x="519" y="98"  text-anchor="middle">point.distance() ≤ r</text>
  <rect class="kn-box"  x="630" y="44" width="172" height="76" rx="10"/>
  <text class="kn-t" x="716" y="78"  text-anchor="middle">Top-K hubs</text>
  <text class="kn-s" x="716" y="98"  text-anchor="middle">ORDER BY dist LIMIT k</text>
  <!-- arrows + row-count annotations -->
  <line class="kn-edge" x1="204" y1="82" x2="222" y2="82" marker-end="url(#kn-arr)"/>
  <text class="kn-cnt" x="213" y="138" text-anchor="middle">millions</text>
  <line class="kn-edge" x1="408" y1="82" x2="426" y2="82" marker-end="url(#kn-arr)"/>
  <text class="kn-cnt" x="417" y="138" text-anchor="middle">M ≈ 4ρr²</text>
  <line class="kn-edge" x1="612" y1="82" x2="630" y2="82" marker-end="url(#kn-arr)"/>
  <text class="kn-cnt" x="621" y="138" text-anchor="middle">≈ πρr²</text>
  <text class="kn-cnt" x="716" y="138" text-anchor="middle">k rows</text>
  <!-- geometry inset: box vs inscribed radius circle -->
  <!-- bounding box filled coral; circle overlaid in surface leaves corners highlighted -->
  <rect x="310" y="232" width="200" height="200" rx="2" fill="var(--accent-coral,#ff6b6b)" opacity="0.35" stroke="var(--accent-coral,#ff6b6b)" stroke-width="1.5"/>
  <circle cx="410" cy="332" r="100" fill="var(--surface-2,#f4f4f5)" stroke="var(--accent,#0e7c86)" stroke-width="2"/>
  <!-- true hits inside circle -->
  <g fill="var(--accent,#0e7c86)">
    <circle cx="380" cy="312" r="5"/>
    <circle cx="440" cy="352" r="5"/>
    <circle cx="408" cy="298" r="5"/>
    <circle cx="362" cy="360" r="5"/>
    <circle cx="452" cy="302" r="5"/>
  </g>
  <!-- corner false positives (in box, outside circle) -->
  <g fill="none" stroke="var(--accent-coral,#ff6b6b)" stroke-width="2">
    <circle cx="332" cy="252" r="5"/>
    <circle cx="492" cy="412" r="5"/>
    <circle cx="490" cy="256" r="5"/>
    <circle cx="328" cy="416" r="5"/>
  </g>
  <!-- skipped hubs outside box -->
  <g fill="none" stroke="var(--ink-mute,#6b7280)" stroke-width="1.5" opacity="0.7">
    <circle cx="540" cy="392" r="5"/>
    <circle cx="282" cy="404" r="5"/>
  </g>
  <!-- query point -->
  <circle cx="410" cy="332" r="6" fill="var(--ink,#1f2937)"/>
  <circle cx="410" cy="332" r="11" fill="none" stroke="var(--ink,#1f2937)" stroke-width="1" opacity="0.5"/>
  <line x1="410" y1="332" x2="510" y2="332" stroke="var(--accent,#0e7c86)" stroke-width="1.5" stroke-dasharray="4 3"/>
  <text class="kn-s" x="458" y="326" text-anchor="middle" style="fill:var(--accent,#0e7c86)">r</text>
  <!-- inset annotations -->
  <text class="kn-ann" x="410" y="222" text-anchor="middle">Box seek (index) vs. radius circle (exact)</text>
  <text class="kn-ann" x="60" y="276">corner false</text>
  <text class="kn-ann" x="60" y="292">positives</text>
  <text class="kn-cnt" x="60" y="310">≈ 27% extra area</text>
  <text class="kn-cnt" x="60" y="326">(1.27× distance evals)</text>
  <!-- legend -->
  <g>
    <circle cx="558" cy="248" r="5" fill="var(--accent,#0e7c86)"/>
    <text class="kn-lg" x="572" y="252">true hit (kept)</text>
    <circle cx="558" cy="276" r="5" fill="none" stroke="var(--accent-coral,#ff6b6b)" stroke-width="2"/>
    <text class="kn-lg" x="572" y="280">corner false positive (clipped)</text>
    <circle cx="558" cy="304" r="5" fill="none" stroke="var(--ink-mute,#6b7280)" stroke-width="1.5"/>
    <text class="kn-lg" x="572" y="308">outside box (skipped)</text>
    <circle cx="558" cy="332" r="5" fill="var(--ink,#1f2937)"/>
    <text class="kn-lg" x="572" y="336">query point</text>
  </g>
</svg>

## Prerequisites & Versions

| Component | Minimum version | Install / setup |
| --- | --- | --- |
| Python | 3.10 | `pyenv install 3.10` (for `tuple[str, str]` typing) |
| `neo4j` async driver | 5.14 | `pip install "neo4j>=5.14"` |
| Neo4j server | 5.x | native `POINT INDEX` support |
| Hub coordinates | — | stored as native `point` (WGS-84 / EPSG:4326) |

KNN search depends on the same node-and-edge layout described in [node and edge spatial mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/): each `LogisticsHub` carries a single `location` property of the native `point` type. Stringified JSON, flat arrays, or split `lat`/`lon` numeric properties silently disqualify the node from the spatial planner and force a scan.

## Implementation

The implementation has three parts: an index, a client-side bounding-box helper, and an async service class that runs the parameterized seek-and-sort query.

First, create the spatial index. A native point index is what turns the latitude/longitude range predicate into a seek:

```cypher
CREATE POINT INDEX hub_location_idx IF NOT EXISTS
FOR (h:LogisticsHub) ON (h.location)
```

Verify it with `SHOW INDEXES`: `state` must read `ONLINE` and `type` must be `POINT`. During ingestion enforce strict construction with `point({latitude: $lat, longitude: $lon})` so every node lands in the index. Choosing the right index for road-graph workloads is covered in [spatial indexing strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/); for nearest-hub lookups the point index is the only correct choice.

Next, the bounding-box helper. A circular radius search is approximated as a rectangle so the index can resolve it as two range predicates. The longitude offset widens with latitude because meridians converge toward the poles:

```python
import math
from typing import Dict


def compute_bounding_box(lat: float, lon: float, radius_km: float) -> Dict[str, float]:
    """Approximate a circular search radius as a lat/lon bounding box.

    Uses the mean meridional length (~111.32 km/degree) and scales the
    longitude offset by cos(latitude) to correct for parallel shrinkage.
    """
    lat_offset = radius_km / 111.32
    lon_offset = radius_km / (111.32 * math.cos(math.radians(lat)))
    return {
        "min_lat": lat - lat_offset,
        "max_lat": lat + lat_offset,
        "min_lon": lon - lon_offset,
        "max_lon": lon + lon_offset,
    }
```

Finally, the async service. It computes the box client-side, passes every value as a parameter (so the planner caches one reusable plan), seeks on the box, and sorts only the survivors:

```python
import asyncio
from neo4j import AsyncGraphDatabase
from neo4j.exceptions import Neo4jError

KNN_QUERY = """
WITH point({latitude: $lat, longitude: $lon}) AS query_point
MATCH (h:LogisticsHub)
WHERE h.location.latitude  >= $min_lat AND h.location.latitude  <= $max_lat
  AND h.location.longitude >= $min_lon AND h.location.longitude <= $max_lon
  AND point.distance(h.location, query_point) <= $radius_m
RETURN h.id AS hub_id, h.name AS hub_name,
       point.distance(h.location, query_point) / 1000.0 AS dist_km
ORDER BY dist_km ASC
LIMIT $k
"""


class LogisticsKNNService:
    def __init__(self, uri: str, auth: tuple[str, str], pool_size: int = 50):
        self.driver = AsyncGraphDatabase.driver(
            uri,
            auth=auth,
            max_connection_pool_size=pool_size,
            connection_acquisition_timeout=5.0,
            max_connection_lifetime=3600,
        )

    async def find_nearest_hubs(
        self, lat: float, lon: float, radius_km: float, k: int = 5
    ) -> list[dict]:
        bounds = compute_bounding_box(lat, lon, radius_km)
        params = {
            "lat": lat,
            "lon": lon,
            "k": k,
            "radius_m": radius_km * 1000.0,
            **bounds,
        }
        async with self.driver.session(database="neo4j") as session:
            try:
                result = await session.run(KNN_QUERY, **params)
                return [record.data() async for record in result]
            except Neo4jError as exc:
                raise RuntimeError(f"KNN query failed: {exc}") from exc

    async def close(self) -> None:
        await self.driver.close()


async def main() -> None:
    service = LogisticsKNNService("neo4j://localhost:7687", ("neo4j", "password"))
    try:
        hubs = await service.find_nearest_hubs(52.5200, 13.4050, radius_km=25, k=5)
        for hub in hubs:
            print(f"{hub['hub_name']:<24} {hub['dist_km']:.2f} km")
    finally:
        await service.close()


if __name__ == "__main__":
    asyncio.run(main())
```

## How It Works

The query reads top to bottom but the planner executes it as a tight pipeline:

- **The box predicate is the seekable part.** The four `>=` / `<=` comparisons against `h.location.latitude` and `h.location.longitude` are range predicates the point index can push down, so the plan starts with a `PointIndexSeekByRange` instead of a `NodeByLabelScan`. This is the single change that separates a 5 ms query from a 5 s one.
- **`point.distance()` clips the corners.** A bounding box is a square whose corners reach roughly 27% beyond the inscribed radius circle. The `point.distance(...) <= $radius_m` guard restores true radius semantics by discarding those corner false positives. It cannot be pushed to the index — it runs as a `Filter` on the already-seeked rows, which is cheap because there are now only hundreds of them.
- **The sort is bounded.** `ORDER BY dist_km` operates on the filtered survivor set, and `LIMIT $k` caps output. Sorting cost drops from `O(N log N)` over the whole label to `O(M log M)` where `M` is the box hit count.
- **Parameters keep the plan cached.** Passing `lat`, `lon`, the four bounds, `radius_m`, and `k` as parameters means the planner compiles the query once and reuses it across every dispatch call, eliminating recompilation latency. The deeper mechanics of why parameterization preserves plan reuse are covered in [optimizing Cypher query plans for spatial data](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/optimizing-cypher-query-plans-for-spatial-data/).

This box-then-distance shape is the same primitive used across [distance filter query patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/); KNN simply adds `ORDER BY ... LIMIT k` on top of the radius filter to rank rather than just select.

## Common Failure Patterns

**1. The longitude upper-bound typo.** The most common copy-paste bug is writing the longitude guard as two lower-bound checks:

```cypher
-- WRONG: never closes the eastern edge of the box
WHERE h.location.longitude >= $min_lon AND h.location.longitude >= $max_lon
```

Because `$max_lon > $min_lon`, the second clause subsumes the first and the box becomes an unbounded half-plane — the seek returns every hub east of `min_lon`, and the result set silently balloons. Always pair `>= $min_lon` with `<= $max_lon`.

**2. Plan falls back to a label scan.** If `PROFILE` shows `NodeByLabelScan` feeding a `Filter` instead of `PointIndexSeekByRange`, the index is not being used. The usual causes are a mixed-type `location` property (some nodes hold strings), an index stuck in `FAILED` or `POPULATING` state, or building the bounding box inside Cypher with per-row trigonometry — which is not seekable. Fix: enforce point-typed ingestion, confirm `SHOW INDEXES` reads `ONLINE`, and always compute the box in Python.

<svg viewBox="0 0 780 336" role="img" aria-labelledby="hpTitle hpDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="hpTitle">Two lower bounds turn the search box into an unbounded half-plane</title>
  <desc id="hpDesc">Left: the correct pair of longitude guards, greater-than-or-equal min_lon paired with less-than-or-equal max_lon, closes the box on both sides so the index seek returns the eleven hubs inside it. Right: writing both guards as lower bounds means the stricter one subsumes the other, the eastern edge is never closed, and the seek returns every hub east of min_lon across the whole dataset. The query still succeeds and the plan still shows an index seek, so nothing signals the fault except the row count.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="336" fill="var(--viz-bg,#ffffff)"/>
  <text x="196" y="24" text-anchor="middle" font-size="13" font-weight="700" fill="var(--viz-good,#0a656d)">&gt;= $min_lon AND &lt;= $max_lon</text>
  <text x="584" y="24" text-anchor="middle" font-size="13" font-weight="700" fill="var(--viz-poor,#a8320f)">&gt;= $min_lon AND &gt;= $max_lon</text>
  <text x="196" y="42" text-anchor="middle" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">a closed box — 11 candidates</text>
  <text x="584" y="42" text-anchor="middle" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">an open half-plane — 1,940 candidates</text>
  <line x1="390" y1="56" x2="390" y2="300" stroke="var(--line,#e5e0d2)" stroke-width="1" stroke-dasharray="3 6"/>
  <rect x="24" y="60" width="344" height="200" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.2"/>
  <rect x="132" y="94" width="128" height="132" fill="var(--viz-good,#0a656d)" opacity="0.14"/>
  <rect x="132" y="94" width="128" height="132" fill="none" stroke="var(--viz-good,#0a656d)" stroke-width="2"/>
  <g fill="var(--viz-good,#0a656d)">
    <circle cx="152" cy="118" r="4"/><circle cx="184" cy="106" r="4"/><circle cx="228" cy="126" r="4"/><circle cx="164" cy="152" r="4"/>
    <circle cx="206" cy="160" r="4"/><circle cx="242" cy="150" r="4"/><circle cx="146" cy="190" r="4"/><circle cx="192" cy="196" r="4"/>
    <circle cx="236" cy="204" r="4"/><circle cx="214" cy="176" r="4"/><circle cx="170" cy="212" r="4"/>
  </g>
  <g fill="var(--viz-stroke,#9ca3af)" opacity="0.55">
    <circle cx="66" cy="112" r="4"/><circle cx="92" cy="176" r="4"/><circle cx="76" cy="220" r="4"/><circle cx="290" cy="110" r="4"/>
    <circle cx="316" cy="164" r="4"/><circle cx="300" cy="216" r="4"/><circle cx="340" cy="136" r="4"/><circle cx="52" cy="150" r="4"/>
  </g>
  <text x="132" y="86" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--viz-good,#0a656d)">min_lon</text>
  <text x="260" y="86" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--viz-good,#0a656d)">max_lon</text>
  <text x="196" y="248" text-anchor="middle" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">both edges bound the seek</text>
  <rect x="412" y="60" width="344" height="200" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.2"/>
  <rect x="520" y="94" width="228" height="132" fill="var(--viz-poor,#a8320f)" opacity="0.14"/>
  <line x1="520" y1="94" x2="520" y2="226" stroke="var(--viz-poor,#a8320f)" stroke-width="2"/>
  <line x1="520" y1="94" x2="748" y2="94" stroke="var(--viz-poor,#a8320f)" stroke-width="2" stroke-dasharray="6 5"/>
  <line x1="520" y1="226" x2="748" y2="226" stroke="var(--viz-poor,#a8320f)" stroke-width="2" stroke-dasharray="6 5"/>
  <g fill="var(--viz-poor,#a8320f)">
    <circle cx="540" cy="118" r="4"/><circle cx="572" cy="106" r="4"/><circle cx="616" cy="126" r="4"/><circle cx="552" cy="152" r="4"/>
    <circle cx="594" cy="160" r="4"/><circle cx="630" cy="150" r="4"/><circle cx="534" cy="190" r="4"/><circle cx="580" cy="196" r="4"/>
    <circle cx="624" cy="204" r="4"/><circle cx="602" cy="176" r="4"/><circle cx="558" cy="212" r="4"/>
    <circle cx="678" cy="110" r="4"/><circle cx="704" cy="164" r="4"/><circle cx="688" cy="216" r="4"/><circle cx="728" cy="136" r="4"/>
    <circle cx="660" cy="186" r="4"/><circle cx="736" cy="200" r="4"/><circle cx="700" cy="102" r="4"/>
  </g>
  <g fill="var(--viz-stroke,#9ca3af)" opacity="0.55">
    <circle cx="454" cy="112" r="4"/><circle cx="480" cy="176" r="4"/><circle cx="464" cy="220" r="4"/><circle cx="440" cy="150" r="4"/>
  </g>
  <text x="520" y="86" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--viz-poor,#a8320f)">min_lon</text>
  <text x="700" y="86" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--viz-poor,#a8320f)">no eastern edge</text>
  <text x="584" y="248" text-anchor="middle" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">the stricter guard subsumes the weaker one</text>
  <text x="24" y="288" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">The plan is identical in both cases: PointIndexSeekByRange, no scan, no warning. Only the row count moves —</text>
  <text x="24" y="304" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">which is why a k-nearest result that looks merely slow is worth reading as a bounds bug first.</text>
</svg>

**3. Empty results near a sparse radius.** A box calibrated for dense urban depots returns nothing in rural regions. Rather than widening the radius globally (which re-inflates `M` everywhere), retry with an expanding radius until `k` results appear:

```python
async def find_with_backoff(service, lat, lon, k=5, start_km=10, max_km=160):
    radius = start_km
    while radius <= max_km:
        hubs = await service.find_nearest_hubs(lat, lon, radius, k)
        if len(hubs) >= k:
            return hubs
        radius *= 2
    return hubs  # best effort at max radius
```

## Performance Notes

The whole point of the bounding box is to shrink the row count the engine sorts. With hub density $\rho$ (hubs per km²) and search radius $r$ km, the expected number of candidates the seek returns is the box area times density:

$$
M \approx \rho \cdot (2\Delta_{lat})(2\Delta_{lon}) \cdot 111.32^2 \cos\phi
\quad\text{where}\quad
\Delta_{lat} = \frac{r}{111.32},\;\; \Delta_{lon} = \frac{r}{111.32\,\cos\phi}
$$

which simplifies to $M \approx 4\rho r^2$. The exact-distance guard then discards the corner overshoot, leaving roughly $\pi r^2 \rho$ true hits — the box does about $\tfrac{4}{\pi} \approx 1.27\times$ more distance evaluations than the ideal circle, a negligible overhead for the index-seek payoff.

Budget guidance:

- **Latency.** For typical dispatch radii (10–50 km) with $M$ in the hundreds, expect sub-50 ms p99 once the index is warm in page cache. Cold cache forces disk I/O on the range scan and spikes tail latency — warm the index after restart with a representative query.
- **Write amplification.** Heavy ingest into `LogisticsHub` fragments the point index; rebuild it during a maintenance window (`DROP INDEX hub_location_idx; CREATE POINT INDEX ...`) rather than letting fragmentation degrade seek selectivity.
- **When to switch strategies.** Beyond ~10M hubs, partition by geographic region so each tenant or zone seeks a smaller index. And when "nearest" must mean *travel cost* rather than straight-line distance, this query becomes only the candidate-selection phase: materialize the top-K hubs as a subgraph and hand them to a Dijkstra/A\* traversal in a separate transaction, keeping spatial lookup isolated from pathfinding.

## Related

- [K-Nearest Neighbor Routing](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/k-nearest-neighbor-routing/) — the two-phase pre-filter-then-traverse workflow this lookup feeds.
- [Distance Filter Query Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/) — the radius-filter primitive KNN ranks on top of.
- [Filtering Graph Paths by Haversine Distance in Cypher](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/filtering-graph-paths-by-haversine-distance-in-cypher/) — applying spherical distance during traversal, not just selection.
- [Spatial Indexing Strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) — choosing and validating the index behind the seek.

This guide is part of [K-Nearest Neighbor Routing](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/k-nearest-neighbor-routing/), within the [Cypher Spatial Queries & Pathfinding Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/) section.

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "HowTo",
  "name": "Implementing KNN Search for Nearby Logistics Hubs in Neo4j",
  "description": "Build a two-step k-nearest-neighbor lookup that uses a client-computed bounding box and a native point index to return the closest logistics hubs without a full graph scan.",
  "step": [
    {
      "@type": "HowToStep",
      "name": "Create a native point index",
      "text": "Create a POINT INDEX on the LogisticsHub.location property so latitude/longitude range predicates resolve as an index seek instead of a label scan."
    },
    {
      "@type": "HowToStep",
      "name": "Compute the bounding box client-side",
      "text": "In Python, convert the search radius into latitude and longitude offsets, scaling longitude by cos(latitude), and derive the four box corners."
    },
    {
      "@type": "HowToStep",
      "name": "Run the parameterized seek-and-sort query",
      "text": "Seek on the bounding box, clip corner false positives with point.distance() <= radius, then ORDER BY distance and LIMIT k, passing all values as parameters for plan reuse."
    }
  ]
}
</script>
