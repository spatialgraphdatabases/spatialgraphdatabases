---
pageTitle: R-tree vs Geohash vs Quadtree
title: R-tree vs Geohash vs Quadtree for Road Graphs
description: A workload-driven guide to choosing R-tree, geohash, or quadtree indexing for a Neo4j road and logistics graph, with a runnable async selectivity benchmark.
slug: r-tree-vs-geohash-vs-quadtree-for-road-graphs
type: article
breadcrumb: R-tree vs Geohash vs Quadtree
datePublished: 2026-07-14
dateModified: 2026-07-14
---
# R-tree vs Geohash vs Quadtree for Road Graphs

Most road-graph teams pick a spatial index once, by reflex, and pay for it later. The default reflex is Neo4j's native point index — an R-tree variant — and for point-to-point routing and nearest-node snapping that is usually correct. The pain arrives when the same graph has to be sharded across a database cluster, or has to absorb a firehose of vehicle telemetry that rewrites coordinates thousands of times a second, or spans a metro where downtown holds a thousand times the node density of the exurbs. At that point the R-tree stops being the obvious answer, and a geohash prefix key or an adaptive quadtree starts to look better — for *those specific* access patterns, not in general. This page is the decision framework: it scores the three families by workload (bounding-box queries, KNN, sharding, write-heavy telemetry), by data distribution (dense urban versus sparse rural), and by write amplification, then hands you a runnable async benchmark so the choice comes from measured candidate-set sizes on your own data rather than from folklore. It is the comparison behind the hands-on build in [implementing geohash vs quadtree indexing in Neo4j](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/implementing-geohash-vs-quadtree-indexing-in-neo4j/).

<svg viewBox="0 0 720 404" role="img" aria-labelledby="mtxTitle mtxDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="mtxTitle">Decision matrix scoring R-tree, geohash, and quadtree indexes across five road-graph criteria</title>
  <desc id="mtxDesc">A five-row by three-column matrix. Rows are the criteria range or bounding-box query, point-to-point and nearest-neighbour routing, sharding or partition key, write amplification when nodes move, and skew tolerance across dense and sparse regions. Columns are the Neo4j native R-tree point index, geohash or H3 prefix encoding, and quadtree bounds. The winning cell in each row is filled and marked: R-tree wins range queries and nearest-neighbour routing, geohash wins the sharding key and write amplification, and the quadtree wins skew tolerance.</desc>
  <!-- column headers -->
  <rect x="252" y="52" width="148" height="38" rx="6" fill="var(--accent,#0a656d)" opacity="0.12"/>
  <rect x="404" y="52" width="148" height="38" rx="6" fill="var(--accent,#0a656d)" opacity="0.12"/>
  <rect x="556" y="52" width="148" height="38" rx="6" fill="var(--accent,#0a656d)" opacity="0.12"/>
  <text x="326" y="70" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">R-tree</text>
  <text x="326" y="84" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">native point index</text>
  <text x="478" y="70" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">Geohash / H3</text>
  <text x="478" y="84" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">prefix encoding</text>
  <text x="630" y="70" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">Quadtree</text>
  <text x="630" y="84" text-anchor="middle" font-size="9.5" fill="currentColor" opacity="0.7">bounds model</text>
  <text x="16" y="80" font-size="11" font-weight="700" fill="currentColor" opacity="0.75">Criterion</text>
  <!-- row separators -->
  <g stroke="var(--line,#e5e0d2)" stroke-width="1">
    <line x1="12" y1="96" x2="704" y2="96"/>
    <line x1="12" y1="152" x2="704" y2="152"/>
    <line x1="12" y1="208" x2="704" y2="208"/>
    <line x1="12" y1="264" x2="704" y2="264"/>
    <line x1="12" y1="320" x2="704" y2="320"/>
    <line x1="12" y1="376" x2="704" y2="376"/>
  </g>
  <!-- row 1: range / bbox -> R-tree -->
  <text x="16" y="120" font-size="11.5" fill="currentColor">Range / bounding-box</text>
  <text x="16" y="135" font-size="11.5" fill="currentColor">query</text>
  <rect x="258" y="104" width="136" height="40" rx="6" fill="var(--accent,#0a656d)"/>
  <text x="326" y="129" text-anchor="middle" font-size="11.5" font-weight="700" fill="#ffffff">&#10003; best</text>
  <text x="478" y="129" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.8">fair · 9-cell</text>
  <text x="630" y="129" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.8">good</text>
  <!-- row 2: KNN -> R-tree -->
  <text x="16" y="176" font-size="11.5" fill="currentColor">Point-to-point</text>
  <text x="16" y="191" font-size="11.5" fill="currentColor">&amp; KNN routing</text>
  <rect x="258" y="160" width="136" height="40" rx="6" fill="var(--accent,#0a656d)"/>
  <text x="326" y="185" text-anchor="middle" font-size="11.5" font-weight="700" fill="#ffffff">&#10003; best</text>
  <text x="478" y="185" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.8">fair</text>
  <text x="630" y="185" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.8">good</text>
  <!-- row 3: sharding -> Geohash -->
  <text x="16" y="232" font-size="11.5" fill="currentColor">Sharding /</text>
  <text x="16" y="247" font-size="11.5" fill="currentColor">partition key</text>
  <text x="326" y="241" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.8">weak · opaque</text>
  <rect x="410" y="216" width="136" height="40" rx="6" fill="var(--accent,#0a656d)"/>
  <text x="478" y="241" text-anchor="middle" font-size="11.5" font-weight="700" fill="#ffffff">&#10003; best</text>
  <text x="630" y="241" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.8">fair</text>
  <!-- row 4: write amplification -> Geohash -->
  <text x="16" y="288" font-size="11.5" fill="currentColor">Write amplification</text>
  <text x="16" y="303" font-size="11.5" fill="currentColor">(nodes move)</text>
  <text x="326" y="297" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.8">fair</text>
  <rect x="410" y="272" width="136" height="40" rx="6" fill="var(--accent,#0a656d)"/>
  <text x="478" y="297" text-anchor="middle" font-size="11.5" font-weight="700" fill="#ffffff">&#10003; best</text>
  <text x="630" y="297" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.8">weak</text>
  <!-- row 5: skew tolerance -> Quadtree -->
  <text x="16" y="344" font-size="11.5" fill="currentColor">Skew tolerance</text>
  <text x="16" y="359" font-size="11.5" fill="currentColor">(dense vs sparse)</text>
  <text x="326" y="353" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.8">good</text>
  <text x="478" y="353" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.8">weak · fixed</text>
  <rect x="562" y="328" width="136" height="40" rx="6" fill="var(--accent,#0a656d)"/>
  <text x="630" y="353" text-anchor="middle" font-size="11.5" font-weight="700" fill="#ffffff">&#10003; best</text>
  <text x="360" y="396" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.62">No single winner — the right index is the one that matches your dominant access pattern</text>
</svg>

The matrix already tells the headline: there is no universal winner. The R-tree owns proximity work, geohash owns partitioning and cheap writes, and the quadtree earns its keep only when density varies wildly across the map. The rest of this page turns each of those verdicts into something you can measure.

## Prerequisites & Versions

The benchmark encodes geohash and quadtree keys client-side, so only the index DDL is Neo4j-version specific.

| Library / runtime | Min version | Notes |
| --- | --- | --- |
| Python | 3.10+ | `match`, union types, `asyncio.run` |
| Neo4j | 5.13+ | native `point`, `CREATE POINT/TEXT/RANGE INDEX` |
| neo4j (driver) | 5.18+ | async API (`AsyncGraphDatabase`) |
| geohash2 | 1.1+ | `encode`, `neighbors` for prefix cells |

```bash
pip install "neo4j>=5.18" "geohash2>=1.1"
```

All three encodings sit alongside the canonical `location` point, following the same [node and edge spatial mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/) conventions — the `geohash` string and the quadtree `qminlat`/`qminlon` bounds are derived shard keys, never a replacement for the point the router actually measures against.

## What each index optimizes

Before the numbers, the one-line character of each candidate on a road graph:

- **R-tree (native point index).** Neo4j builds a balanced hierarchy of minimum bounding rectangles over your `location` points. It seeks an arbitrary query box directly and answers nearest-K without over-fetch, which is exactly the shape of snapping a GPS fix to the closest intersection or expanding a route frontier. Its weakness is that the tree is an opaque internal structure — you cannot use it as a partition key, and every coordinate change re-inserts the node into the tree.
- **Geohash / H3 prefix.** A base-32 string (or an H3 cell id) where a shared prefix *is* spatial containment. It is ordered, human-inspectable, and trivially shardable: route all keys starting `dp3w` to one partition. It writes cheaply — a moved node rewrites one string. Its weakness is the fixed-resolution grid, which over-fetches a 3×3 block of cells for any point query and overflows in dense cores.
- **Quadtree.** Recursive subdivision that only deepens where points cluster, so leaf occupancy stays bounded no matter how skewed the map is. Its weakness is churn: a node that crosses a leaf boundary forces a bounds recompute and a range-index update.

## Implementation

The script below makes the comparison empirical. It seeds a deliberately skewed sample — 80% of stops packed into the Chicago Loop, 20% scattered across the surrounding region — then, for the *same* query window, reports how many candidate rows each index would hand to the distance filter and how many of those are true hits. Selectivity is `hits / candidates`: higher means less wasted scoring.

```cypher
// Schema: one canonical point plus two derived shard keys, each with its own index
CREATE POINT INDEX stop_loc  IF NOT EXISTS FOR (n:Stop) ON (n.location);
CREATE TEXT  INDEX stop_gh   IF NOT EXISTS FOR (n:Stop) ON (n.geohash);
CREATE RANGE INDEX stop_quad IF NOT EXISTS FOR (n:Stop) ON (n.qminlat, n.qminlon);
```

```python
import asyncio
import math
import random
from neo4j import AsyncGraphDatabase
import geohash2

URI = "neo4j+s://your-cluster.databases.neo4j.io"
AUTH = ("neo4j", "secure_password")

CORE_LAT, CORE_LON = 41.8781, -87.6298   # Chicago Loop — the dense core
GEOHASH_PREC = 7                          # ~153 m cell, roughly one arterial block
QUAD_LEVEL = 15                           # ~600 m leaf at this latitude
EARTH_M = 6_371_000.0


def geohash_of(lat: float, lon: float, prec: int = GEOHASH_PREC) -> str:
    return geohash2.encode(lat, lon, prec)


def quad_leaf(lat: float, lon: float, level: int = QUAD_LEVEL) -> dict:
    """Snap a coordinate to its quadtree leaf bounds (4**level cells over the globe)."""
    span_lon = 360.0 / (2 ** level)
    span_lat = 180.0 / (2 ** level)
    lo = math.floor((lon + 180.0) / span_lon) * span_lon - 180.0
    la = math.floor((lat + 90.0) / span_lat) * span_lat - 90.0
    return {"qminlat": la, "qmaxlat": la + span_lat,
            "qminlon": lo, "qmaxlon": lo + span_lon}


def skewed_sample(n: int = 5000, seed: int = 7) -> list[dict]:
    rng = random.Random(seed)
    rows = []
    for i in range(n):
        if rng.random() < 0.80:                        # dense downtown cluster
            lat = CORE_LAT + rng.gauss(0, 0.02)
            lon = CORE_LON + rng.gauss(0, 0.02)
        else:                                          # sparse regional spread
            lat = CORE_LAT + rng.uniform(-1.5, 1.5)
            lon = CORE_LON + rng.uniform(-1.5, 1.5)
        rows.append({"id": i, "lat": lat, "lon": lon,
                     "gh": geohash_of(lat, lon), **quad_leaf(lat, lon)})
    return rows


class IndexSelectivityBench:
    def __init__(self, uri: str, auth: tuple[str, str]):
        self.driver = AsyncGraphDatabase.driver(
            uri, auth=auth,
            max_connection_pool_size=20,
            connection_acquisition_timeout=10.0,
        )

    async def setup(self, rows: list[dict]) -> None:
        async with self.driver.session(database="neo4j") as s:
            await s.run("MATCH (n:Stop) DETACH DELETE n")
            await s.run("CREATE POINT INDEX stop_loc IF NOT EXISTS FOR (n:Stop) ON (n.location)")
            await s.run("CREATE TEXT INDEX stop_gh IF NOT EXISTS FOR (n:Stop) ON (n.geohash)")
            await s.run("CREATE RANGE INDEX stop_quad IF NOT EXISTS "
                        "FOR (n:Stop) ON (n.qminlat, n.qminlon)")
            await s.run(
                """
                UNWIND $rows AS r
                CREATE (n:Stop {
                    id: r.id,
                    location: point({srid: 4326, latitude: r.lat, longitude: r.lon}),
                    geohash: r.gh,
                    qminlat: r.qminlat, qmaxlat: r.qmaxlat,
                    qminlon: r.qminlon, qmaxlon: r.qmaxlon})
                """, rows=rows)

    async def probe_rtree(self, lat: float, lon: float, radius_m: float):
        d_lat = math.degrees(radius_m / EARTH_M)
        d_lon = d_lat / max(math.cos(math.radians(lat)), 1e-6)
        return await self._count(
            """
            WITH point({srid: 4326, latitude: $lat, longitude: $lon}) AS t
            MATCH (n:Stop)
            WHERE n.location.latitude  >= $minlat AND n.location.latitude  <= $maxlat
              AND n.location.longitude >= $minlon AND n.location.longitude <= $maxlon
            WITH t, collect(n) AS cand
            RETURN size(cand) AS candidates,
                   size([n IN cand WHERE point.distance(n.location, t) <= $radius]) AS hits
            """,
            lat=lat, lon=lon, radius=radius_m,
            minlat=lat - d_lat, maxlat=lat + d_lat,
            minlon=lon - d_lon, maxlon=lon + d_lon)

    async def probe_geohash(self, lat: float, lon: float, radius_m: float):
        home = geohash_of(lat, lon)
        cells = list({home, *geohash2.neighbors(home)})   # home + 8 neighbours
        return await self._count(
            """
            WITH point({srid: 4326, latitude: $lat, longitude: $lon}) AS t
            UNWIND $cells AS c
            MATCH (n:Stop) WHERE n.geohash STARTS WITH c
            WITH t, collect(DISTINCT n) AS cand
            RETURN size(cand) AS candidates,
                   size([n IN cand WHERE point.distance(n.location, t) <= $radius]) AS hits
            """,
            lat=lat, lon=lon, radius=radius_m, cells=cells)

    async def probe_quadtree(self, lat: float, lon: float, radius_m: float):
        d_lat = math.degrees(radius_m / EARTH_M)
        d_lon = d_lat / max(math.cos(math.radians(lat)), 1e-6)
        return await self._count(
            """
            WITH point({srid: 4326, latitude: $lat, longitude: $lon}) AS t
            MATCH (n:Stop)
            WHERE n.qminlat <= $maxlat AND n.qmaxlat >= $minlat
              AND n.qminlon <= $maxlon AND n.qmaxlon >= $minlon
            WITH t, collect(n) AS cand
            RETURN size(cand) AS candidates,
                   size([n IN cand WHERE point.distance(n.location, t) <= $radius]) AS hits
            """,
            lat=lat, lon=lon, radius=radius_m,
            minlat=lat - d_lat, maxlat=lat + d_lat,
            minlon=lon - d_lon, maxlon=lon + d_lon)

    async def _count(self, query: str, **params):
        async with self.driver.session(database="neo4j") as s:
            rec = await (await s.run(query, **params)).single()
            return rec["candidates"], rec["hits"]

    async def close(self) -> None:
        await self.driver.close()


async def main():
    bench = IndexSelectivityBench(URI, AUTH)
    windows = {"dense core (Loop)": (41.8781, -87.6298),
               "sparse edge (exurb)": (42.90, -88.70)}
    try:
        await bench.setup(skewed_sample(5000))
        for label, (qlat, qlon) in windows.items():
            print(f"\n== query window: {label} · r = 150 m ==")
            for name, probe in (("R-tree", bench.probe_rtree),
                                ("Geohash", bench.probe_geohash),
                                ("Quadtree", bench.probe_quadtree)):
                cand, hits = await probe(qlat, qlon, 150.0)
                sel = hits / cand if cand else 0.0
                print(f"{name:9} candidates={cand:5d}  hits={hits:4d}  selectivity={sel:6.1%}")
    finally:
        await bench.close()


if __name__ == "__main__":
    asyncio.run(main())
```

## How It Works

Every probe follows the same two-stage shape the whole site relies on — a cheap index-seekable predicate narrows candidates, then exact `point.distance` confirms the hits — and each strategy differs only in that cheap predicate. Reporting `candidates` and `hits` side by side is what makes the trade-off concrete rather than rhetorical.

- **R-tree** seeks the tightest possible box because the native index descends its bounding rectangles straight to the query window. On the dense-core query its candidate set is essentially the box contents and nothing more, so selectivity sits near the geometric ceiling of `π/4` (the circle-in-square ratio). This is the same box-then-clip predicate documented under [distance filter query patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/); the R-tree just happens to be the index that seeks it best.
- **Geohash** always pulls a fixed 3×3 block of precision-7 cells. In the dense core that block over-fetches — it drags in a full arterial block of stops around a 150 m query, so `candidates` inflates and selectivity drops. On the sparse-edge query the nine cells may be nearly empty, which looks efficient but only because there was nothing to scan; the fixed grid is doing no adaptive work either way.
- **Quadtree** overlaps whichever leaves intersect the window. With a fixed level it behaves like a coarse grid here, but the point of the model is that leaf depth *can* follow density: subdivide the Loop finely and leave the exurbs as one large leaf, and every query — dense or sparse — returns a bounded candidate count. That is the property the fixed-precision geohash cannot offer.

The dense-versus-sparse split in `main()` is the whole distribution argument in two lines. Run it against a copy of production data and the numbers, not the matrix, decide the index.

## Common Failure Patterns

**1. Reaching for geohash to serve KNN or tight radius queries.** Because a prefix cell is fixed-size, "the nearest hub to this driver" forces a 3×3 (often larger) cell fan-out and then a client-side merge, and it still misses candidates just outside the ring when the query radius exceeds one cell. The R-tree answers the same question with a single seek. Keep geohash for partitioning; do not make it the primary proximity index:

```python
async def nearest_hub(bench, lat: float, lon: float):
    # Wrong: geohash prefix as the KNN primary — over-fetches and can miss the true nearest
    home = geohash_of(lat, lon)
    ring = {home, *geohash2.neighbors(home)}       # fixed ring, blind to query radius
    # Right: let the native point index seek the box, clip to the circle, then LIMIT k
    return await bench.probe_rtree(lat, lon, radius_m=150.0)
```

**2. Trying to shard on the R-tree.** The native point index is an internal balanced tree with no stable, orderable key you can route on, so teams that adopt it and later need horizontal partitioning have nothing to shard by. If a multi-region cluster is on the roadmap, store a geohash or H3 key *from day one* even while the R-tree serves reads — retrofitting a partition key onto a live graph is a migration, not a config change.

**3. Quadtree write amplification on moving telemetry.** For write-heavy vehicle streams, every position update that crosses a leaf boundary recomputes four bounds and re-seeks the `RANGE` index, so a fleet that idles on a boundary can thrash the index. Geohash rewrites exactly one string on the same move. Detect the churn before it hurts:

```cypher
// How many stops changed quad leaf in the last minute? A high rate signals boundary thrash.
MATCH (n:Stop) WHERE n.leaf_changed_at > datetime() - duration('PT1M')
RETURN count(n) AS relocations_per_min;
```

## Performance Notes

The three indexes differ mainly in the *area* they scan for a radius-$r$ query, and selectivity is just the ratio of the true circle to that scanned area:

$$
S \;=\; \frac{\text{hits}}{\text{candidates}} \;\approx\; \frac{\pi r^{2}}{A_{\text{scan}}},
\qquad
A_{\text{box}} = (2r)^{2},\;\;
A_{\text{grid}} = 9c^{2},\;\;
A_{\text{quad}} \le 4\ell^{2}
$$

where $c$ is the geohash cell side and $\ell$ the quadtree leaf side. The R-tree seeks $A_{\text{box}}$, so its ceiling is the corner-clip ratio $S=\pi/4\approx 0.785$ — the same 27% over-read the bounding box always carries. The geohash grid scans $9c^{2}$; when the cell is much larger than the query ($c \gg r$) selectivity collapses because the nine cells dwarf the circle. The quadtree bounds its scan by leaf capacity $k$ rather than by area, which is why it alone stays selective under extreme skew.

Write amplification tells the opposite story. Per position update, the index entries rewritten are:

$$
W_{\text{geohash}} = 1,\qquad
W_{\text{rtree}} = 1\ (\text{tree re-insert}),\qquad
W_{\text{quad}} = 1 + \mathbb{1}[\text{leaf crossed}]
$$

Geohash and the R-tree both touch one entry, but the R-tree's is a tree mutation (splits and merges under churn) rather than a flat string write, and the quadtree pays an extra bounds recompute whenever a node crosses a boundary. So a mobility graph that updates coordinates continuously favours geohash on write cost, a mostly-static routing graph favours the R-tree on read selectivity, and a graph with order-of-magnitude density swings favours the quadtree on worst-case candidate bounds. Confirm your chosen index is healthy with `SHOW INDEXES YIELD name, state, type` before trusting any benchmark — a `POPULATING` or `FAILED` index quietly turns a seek back into a scan. The deeper build steps for the geohash and quadtree encodings live in the sibling guide on [implementing geohash vs quadtree indexing in Neo4j](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/implementing-geohash-vs-quadtree-indexing-in-neo4j/).

## Related

- [Implementing Geohash vs Quadtree Indexing in Neo4j](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/implementing-geohash-vs-quadtree-indexing-in-neo4j/) — the hands-on build of the two derived encodings this page compares.
- [Distance Filter Query Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/) — the box-then-circle predicate the R-tree seeks best.
- [Node and Edge Spatial Mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/) — storing the canonical `location` point every index measures against.
- [Graph Query Planner Optimization](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/) — making the planner consume the selectivity the winning index exposes.

This guide is part of [Spatial Indexing Strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/), within [Spatial Graph Database Fundamentals for Python](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/).

For authoritative reference on index syntax and geometry semantics, consult the [Neo4j Cypher Manual on search-performance indexes](https://neo4j.com/docs/cypher-manual/current/indexes/search-performance-indexes/) and the [H3 hierarchical grid system](https://h3geo.org/).
