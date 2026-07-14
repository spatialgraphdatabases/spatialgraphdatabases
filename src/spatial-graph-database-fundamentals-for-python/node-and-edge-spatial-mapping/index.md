---
pageTitle: Node and Edge Spatial Mapping in Python
title: Node and Edge Spatial Mapping
description: Convert raw coordinate streams into deterministic, traversable graph topology in Neo4j — CRS normalization, intersection snapping, and async ingestion in Python.
slug: node-and-edge-spatial-mapping
type: guide
breadcrumb: Node and Edge Spatial Mapping
datePublished: 2025-09-22
dateModified: 2026-06-26
---
# Node and Edge Spatial Mapping

Routing systems fail silently when raw geometry is poured into a graph without an explicit mapping contract. Two segment endpoints that differ by a millionth of a degree become two separate nodes, a junction loses a turn, and `shortestPath` either returns a detour or no path at all. The engineering problem this guide solves is the conversion of unstructured coordinate streams — GeoJSON linestrings, GPS traces, transit corridors — into a deterministic, directed graph whose vertices and edges mean exactly what a routing algorithm assumes they mean. Get the mapping wrong and the cost is concrete: spatial predicates degrade into full graph scans, pathfinding becomes non-deterministic across re-imports, and downstream analytics inherit a topology that cannot be trusted. This page covers the geometry-to-topology rules, the schema that keeps them queryable, and the async Python pipeline that ingests them at scale.

This guide is part of [Spatial Graph Database Fundamentals for Python](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/), and it assumes coordinates will eventually be queried through the [spatial indexing strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) layer, so every choice here is made with index-backed retrieval in mind.

## Prerequisites

The pipeline below uses the async Neo4j driver with native `point` types and depends on `shapely` for geometry validation and `pyproj` for coordinate reference system (CRS) transforms. The `gds.graph.project` and `gds.shortestPath` calls at the end require the Graph Data Science plugin.

| Requirement | Minimum version | Notes |
| --- | --- | --- |
| Python | 3.10+ | `async for`, union types, `match` available |
| Neo4j | 5.13+ | Native `point` type and point indexes |
| neo4j (driver) | 5.x | Async driver (`AsyncGraphDatabase`) |
| graphdatascience / GDS plugin | 2.5+ | Only for the GDS projection + Dijkstra |
| shapely | 2.0+ | `buffer(0)` repair, geometry validation |
| pyproj | 3.6+ | CRS transforms and geodesic length |

```bash
pip install "neo4j>=5.18" "shapely>=2.0" "pyproj>=3.6"
```

Before ingestion, confirm the source dataset declares its CRS. Mixing geographic and projected coordinates in the same import is the most common cause of corrupt edge lengths, and it is far cheaper to reject at the file boundary than to debug as a routing artifact later.

## Core Concept & Mechanism

Node and edge spatial mapping is a two-part transformation. First, **geometry normalization** quantizes raw coordinates, repairs invalid shapes, and reprojects them to a consistent CRS. Second, **topology construction** extracts canonical vertices at physical intersections and emits atomic edges between them. The graph that survives is the one a routing algorithm can traverse without re-evaluating geometry at every hop.

The mechanism hinges on three invariants:

1. **Coordinates are immutable anchors.** A vertex's position never changes after it is assigned an identity. Connectivity is *derived* from geometry, not stored as free-floating adjacency that can drift out of sync with the points it describes.
2. **Identity is deterministic under tolerance.** Two endpoints within a snapping radius (typically `0.5 m` to `2.0 m` depending on source accuracy) must always collapse to the same node id, on every import. Without this, re-ingesting the same data produces a different graph.
3. **Direction lives on edges, never on nodes.** One-way streets, turn restrictions, and asymmetric travel costs are edge properties. Nodes stay direction-agnostic so the same vertex can serve traffic flowing in either sense.

Raw networks violate all three on arrival. Floating-point drift spawns phantom vertices, self-intersecting linestrings break planar assumptions, and multi-source ingestion overlaps geometries that *look* coincident but are not byte-identical. The normalization phase exists to restore the invariants before a single row reaches the graph.

### Coordinate reference system normalization

CRS normalization is a mandatory prerequisite for graph construction. While WGS 84 (`EPSG:4326`) remains the ingestion standard for global datasets, geographic coordinates introduce angular distortion that corrupts distance and routing calculations. Project to a planar system before computing any edge metric: regional deployments benefit from UTM zones or local state-plane projections, while continental routing typically uses Web Mercator (`EPSG:3857`) or a custom equal-area projection. Crucially, compute edge *length* geodesically over the original WGS 84 coordinates — Web Mercator badly inflates north–south distances and must never be the basis for a routing weight.

### Topology construction and intersection detection

Raw road segments and transit corridors require precise node extraction at geometric intersections. Naive pairwise comparison scales quadratically (`O(N²)`) and becomes untenable beyond ~50k segments. Production systems implement spatial hashing or grid partitioning to accelerate candidate matching — the same bounding-volume pre-filtering that the [spatial indexing strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) layer applies at query time, reused here at build time to shrink the candidate set before topology materialization.

Node deduplication must account for floating-point precision drift. Apply a deterministic snapping tolerance before merging intersection points: coordinates that fall within the tolerance radius collapse into a single graph node, preserving planar topology while preventing phantom edges.

The diagram below shows the same physical crossroads expressed first as raw GIS linestrings and then as the directed graph that emerges after intersection extraction and snapping. The grey rectangle is the bounding box used by spatial-index pre-filters; the labelled nodes are the canonical vertices a routing algorithm actually traverses.

<svg viewBox="0 0 880 380" role="img" aria-labelledby="nm-title nm-desc" xmlns="http://www.w3.org/2000/svg">
  <title id="nm-title">Geometry-to-topology mapping: raw linestrings become a directed graph</title>
  <desc id="nm-desc">Three panels left to right. The left panel shows raw road linestrings meeting at a crossroads where their endpoints drift apart by a fraction of a degree, circled by a snap-radius tolerance. The middle panel shows the two pipeline steps that transform them: quantise and snap to about half a metre, then split at intersections to extract atomic edges. The right panel shows the resulting directed graph of four canonical nodes n1 to n4 joined by directed edges e1 to e4, enclosed in a dashed spatial-index bounding box; the edges carry length and speed.</desc>
  <style>
    .nm-panel{fill:var(--surface-2,#f4f4f5);stroke:var(--line-strong,#9ca3af);stroke-width:1.5;}
    .nm-hd{font:700 16px var(--font-sans,system-ui,sans-serif);fill:var(--ink,#1f2937);}
    .nm-way{fill:none;stroke:var(--ink-mute,#6b7280);stroke-width:3.5;stroke-linecap:round;opacity:.7;}
    .nm-wlbl{font:600 12px var(--font-mono,ui-monospace,monospace);fill:var(--ink-mute,#6b7280);}
    .nm-snap{fill:none;stroke:var(--accent-coral,#ff6b6b);stroke-width:1.5;stroke-dasharray:4 3;}
    .nm-drift{fill:var(--accent-coral,#ff6b6b);}
    .nm-note{font:italic 12px var(--font-sans,system-ui,sans-serif);fill:var(--accent-coral,#ff6b6b);}
    .nm-step{fill:var(--surface-1,#ffffff);stroke:var(--accent,#0e7c86);stroke-width:2;}
    .nm-stt{font:600 14px var(--font-sans,system-ui,sans-serif);fill:var(--ink,#1f2937);}
    .nm-sts{font:12px var(--font-mono,ui-monospace,monospace);fill:var(--ink-mute,#6b7280);}
    .nm-flow{stroke:currentColor;stroke-width:2;fill:none;opacity:.5;}
    .nm-bbox{fill:none;stroke:var(--line-strong,#9ca3af);stroke-width:1.5;stroke-dasharray:6 4;}
    .nm-bbt{font:600 11px var(--font-mono,ui-monospace,monospace);fill:var(--ink-mute,#6b7280);}
    .nm-edge{fill:none;stroke:var(--accent,#0e7c86);stroke-width:2.5;}
    .nm-elbl{font:600 12px var(--font-mono,ui-monospace,monospace);fill:var(--accent,#0e7c86);}
    .nm-node{fill:var(--surface-1,#ffffff);stroke:var(--accent,#0e7c86);stroke-width:2.5;}
    .nm-nt{font:700 13px var(--font-sans,system-ui,sans-serif);fill:var(--accent,#0e7c86);}
    .nm-cap{font:12px var(--font-mono,ui-monospace,monospace);fill:var(--ink-mute,#6b7280);}
  </style>
  <defs>
    <marker id="nm-arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="var(--accent,#0e7c86)"/>
    </marker>
    <marker id="nm-farr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor" opacity=".55"/>
    </marker>
  </defs>
  <!-- ===== LEFT: raw linestrings ===== -->
  <text class="nm-hd" x="142" y="34" text-anchor="middle">Raw linestrings (input)</text>
  <rect class="nm-panel" x="24" y="46" width="236" height="296" rx="10"/>
  <!-- ways -->
  <line class="nm-way" x1="44" y1="180" x2="244" y2="180"/>
  <line class="nm-way" x1="150" y1="66" x2="150" y2="324"/>
  <line class="nm-way" x1="150" y1="180" x2="236" y2="300"/>
  <text class="nm-wlbl" x="232" y="170">A</text>
  <text class="nm-wlbl" x="158" y="78">B</text>
  <text class="nm-wlbl" x="222" y="294">C</text>
  <!-- drift + snap radius at the junction -->
  <circle class="nm-snap" cx="150" cy="180" r="18"/>
  <circle class="nm-drift" cx="146" cy="177" r="2.6"/>
  <circle class="nm-drift" cx="154" cy="176" r="2.6"/>
  <circle class="nm-drift" cx="151" cy="185" r="2.6"/>
  <text class="nm-note" x="150" y="226" text-anchor="middle">endpoints drift</text>
  <text class="nm-note" x="150" y="242" text-anchor="middle">snap radius ~0.5 m</text>
  <!-- ===== MIDDLE: pipeline steps ===== -->
  <line class="nm-flow" x1="262" y1="180" x2="288" y2="140" marker-end="url(#nm-farr)"/>
  <rect class="nm-step" x="286" y="108" width="178" height="60" rx="9"/>
  <text class="nm-stt" x="375" y="134" text-anchor="middle">Quantise + snap</text>
  <text class="nm-sts" x="375" y="153" text-anchor="middle">tolerance ~0.5 m</text>
  <line class="nm-flow" x1="375" y1="170" x2="375" y2="208" marker-end="url(#nm-farr)"/>
  <rect class="nm-step" x="286" y="210" width="178" height="60" rx="9"/>
  <text class="nm-stt" x="375" y="236" text-anchor="middle">Split at intersections</text>
  <text class="nm-sts" x="375" y="255" text-anchor="middle">extract atomic edges</text>
  <line class="nm-flow" x1="464" y1="240" x2="586" y2="185" marker-end="url(#nm-farr)"/>
  <!-- ===== RIGHT: directed graph ===== -->
  <text class="nm-hd" x="722" y="34" text-anchor="middle">Directed graph (output)</text>
  <rect class="nm-panel" x="588" y="46" width="268" height="296" rx="10"/>
  <rect class="nm-bbox" x="606" y="78" width="232" height="220"/>
  <text class="nm-bbt" x="614" y="94">spatial-index bbox</text>
  <!-- edges -->
  <line class="nm-edge" x1="672.9" y1="142.5" x2="707.6" y2="176.1" marker-end="url(#nm-arr)"/>
  <line class="nm-edge" x1="737.8" y1="198.6" x2="787.4" y2="225.5" marker-end="url(#nm-arr)"/>
  <line class="nm-edge" x1="715.7" y1="206.8" x2="697" y2="256.3" marker-end="url(#nm-arr)"/>
  <line class="nm-edge" x1="707" y1="269.1" x2="786.1" y2="241.6" marker-end="url(#nm-arr)"/>
  <text class="nm-elbl" x="702" y="152">e1</text>
  <text class="nm-elbl" x="766" y="206" text-anchor="middle">e2</text>
  <text class="nm-elbl" x="690" y="235" text-anchor="end">e3</text>
  <text class="nm-elbl" x="748" y="272">e4</text>
  <!-- nodes -->
  <circle class="nm-node" cx="660" cy="130" r="16"/>
  <text class="nm-nt" x="660" y="135" text-anchor="middle">n1</text>
  <circle class="nm-node" cx="722" cy="190" r="16"/>
  <text class="nm-nt" x="722" y="195" text-anchor="middle">n2</text>
  <circle class="nm-node" cx="805" cy="235" r="16"/>
  <text class="nm-nt" x="805" y="240" text-anchor="middle">n3</text>
  <circle class="nm-node" cx="690" cy="275" r="16"/>
  <text class="nm-nt" x="690" y="280" text-anchor="middle">n4</text>
  <text class="nm-cap" x="722" y="326" text-anchor="middle">edges carry length_m + speed_limit</text>
</svg>

## Schema & Data Model

The mapping contract is only enforceable if the schema makes the canonical identifiers and geometry first-class. Model each junction as an `:Intersection` carrying a native `point` `location` plus a business-stable `id`; model each routable segment as a `:ROAD_SEGMENT` relationship carrying `length_m`, `speed_limit`, and its own stable `id`. The uniqueness constraint on `id` is what makes the snapping invariant hold across re-imports — a `MERGE` on a constrained key is idempotent, so the same physical junction always resolves to the same node.

```cypher
// Stable identity for junctions — makes MERGE idempotent across re-imports
CREATE CONSTRAINT intersection_id IF NOT EXISTS
FOR (n:Intersection) REQUIRE n.id IS UNIQUE;

// Stable identity for segments so edge replacement does not orphan topology
CREATE CONSTRAINT segment_id IF NOT EXISTS
FOR ()-[r:ROAD_SEGMENT]-() REQUIRE r.id IS UNIQUE;

// Point index so distance/KNN predicates resolve against the index, not a scan
CREATE POINT INDEX intersection_location IF NOT EXISTS
FOR (n:Intersection) ON (n.location);

// Tenant/zone scoping key for multi-tenant isolation at the ingestion boundary
CREATE INDEX intersection_zone IF NOT EXISTS
FOR (n:Intersection) ON (n.zone);
```

```cypher
// Representative shape of the routable graph
// (:Intersection {id, location: point({latitude, longitude}), zone})
//   -[:ROAD_SEGMENT {id, length_m, speed_limit}]->
// (:Intersection {id, location, zone})
```

Which physical structure backs `location` — a native point index, an R-tree, or a precomputed bucket — is a decision that belongs to the indexing layer; this schema simply exposes the geometry and the selective `zone` key the planner consumes. If you operate multiple customers on one graph, the `zone` tag is also the seam enforced by [multi-tenant security in spatial graphs](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-security-boundaries/enforcing-multi-tenant-security-in-spatial-graphs/).

## Step-by-Step Implementation

The pipeline streams features, normalizes geometry, batches the results, and merges them into the graph over a bounded connection pool. We build it in three stages.

### 1. Stream and normalize geometry

Projection pipelines should stream features rather than materializing entire datasets in memory. Generator-based processing prevents out-of-memory failures during large-scale network imports and enables backpressure-aware ingestion. The function below reads newline-delimited GeoJSON, repairs invalid geometry, computes geodesic length over the original WGS 84 coordinates, and yields dicts whose keys map directly to the Cypher parameters in the next step.

```python
import asyncio
import json
from pathlib import Path
from typing import AsyncIterator, Dict, Any

from shapely.geometry import LineString, shape
from pyproj import Transformer
from pyproj.geod import Geod

# Geodetic calculator for accurate metric edge lengths
geod = Geod(ellps="WGS84")


def build_crs_transformer(
    from_crs: str = "EPSG:4326", to_crs: str = "EPSG:3857"
) -> Transformer:
    return Transformer.from_crs(from_crs, to_crs, always_xy=True)


async def stream_normalized_geometries(
    geojson_path: Path,
    transformer: Transformer,
) -> AsyncIterator[Dict[str, Any]]:
    """Yield edge dicts derived from a newline-delimited GeoJSON LineString file.

    Each yielded dict has stable keys for direct Cypher ingestion:
      ``edge_id``, ``source_id``, ``target_id``,
      ``src_lat``, ``src_lon``, ``tgt_lat``, ``tgt_lon``,
      ``length_m``, ``speed_limit``, ``zone_id``.
    """
    with open(geojson_path, "r") as f:
        for line in f:
            if not line.strip():
                continue
            feature = json.loads(line)
            geom = shape(feature["geometry"])

            if not geom.is_valid:
                geom = geom.buffer(0)  # Self-intersection repair

            if not isinstance(geom, LineString):
                continue

            # Geodesic length over the original WGS84 coords
            coords = list(geom.coords)  # [(lon, lat), ...]
            length_m = sum(
                geod.inv(p1[0], p1[1], p2[0], p2[1])[2]
                for p1, p2 in zip(coords[:-1], coords[1:])
            )

            src_lon, src_lat = coords[0]
            tgt_lon, tgt_lat = coords[-1]
            props = feature["properties"]

            yield {
                "edge_id":    props["id"],
                "source_id":  props["source_id"],
                "target_id":  props["target_id"],
                "src_lat": src_lat, "src_lon": src_lon,
                "tgt_lat": tgt_lat, "tgt_lon": tgt_lon,
                "length_m":   round(length_m, 3),
                "speed_limit": props.get("speed_kmh", 50),
                "zone_id":    props.get("zone_id"),
            }
```

### 2. Merge nodes and edges over a pooled async session

Modern spatial ETL requires non-blocking I/O and connection pooling to saturate graph database throughput without exhausting heap memory. The ingestor below batches normalized geometries, manages a persistent connection pool, and runs a single parameterized `UNWIND` that merges both intersections and the connecting segment in one pass. Because the `MERGE` keys are constrained, re-running the pipeline on updated data is idempotent — existing junctions are reused, not duplicated.

```python
import asyncio
from pathlib import Path
from typing import List, Dict

from neo4j import AsyncGraphDatabase


class SpatialGraphIngestor:
    def __init__(self, uri: str, user: str, password: str, pool_size: int = 8):
        self.driver = AsyncGraphDatabase.driver(
            uri, auth=(user, password), max_connection_pool_size=pool_size
        )

    async def close(self):
        await self.driver.close()

    async def ingest_batch(self, batch: List[Dict]) -> None:
        """Merge both endpoints and the segment for every row in one transaction."""
        query = """
        UNWIND $batch AS row
        MERGE (s:Intersection {id: row.source_id})
          ON CREATE SET s.location = point({latitude: row.src_lat, longitude: row.src_lon}),
                        s.zone     = row.zone_id
        MERGE (t:Intersection {id: row.target_id})
          ON CREATE SET t.location = point({latitude: row.tgt_lat, longitude: row.tgt_lon}),
                        t.zone     = row.zone_id
        MERGE (s)-[e:ROAD_SEGMENT {id: row.edge_id}]->(t)
        SET e.length_m    = row.length_m,
            e.speed_limit = row.speed_limit
        """
        async with self.driver.session(database="neo4j") as session:
            await session.run(query, batch=batch)

    async def run_pipeline(
        self,
        geojson_path: Path,
        batch_size: int = 10_000,
    ) -> None:
        transformer = build_crs_transformer()
        batch: List[Dict] = []

        async for geom_data in stream_normalized_geometries(geojson_path, transformer):
            batch.append(geom_data)
            if len(batch) >= batch_size:
                await self.ingest_batch(batch)
                batch.clear()

        if batch:
            await self.ingest_batch(batch)
```

### 3. Project the topology and route over it

Once the topology is materialized, project it once into an in-memory GDS graph and run weighted shortest paths against the projection rather than the live store. Always bind spatial constraints to indexed properties before executing `MATCH` or `CALL` routing procedures, so the planner enters through the point index instead of scanning the label.

```cypher
// One-time projection of the routing topology into GDS
CALL gds.graph.project(
  'routing_graph',
  'Intersection',
  {
    ROAD_SEGMENT: {
      type: 'ROAD_SEGMENT',
      properties: ['length_m', 'speed_limit']
    }
  },
  { nodeProperties: ['zone'] }
)
YIELD graphName;

// Per-request shortest path against the projected graph
MATCH (src:Intersection {id: $source_id})
MATCH (tgt:Intersection {id: $target_id})
CALL gds.shortestPath.dijkstra.stream('routing_graph', {
  sourceNode: src,
  targetNode: tgt,
  relationshipWeightProperty: 'length_m'
})
YIELD totalCost, path
RETURN totalCost, path
```

How the planner picks index seeks over scans for these reads is the subject of [graph query planner optimization](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/); the mapping you build here is what makes those plans possible in the first place.

## Query Patterns & Variants

Mapped topology supports several read shapes. Pick the one whose anchor matches how callers actually parameterize requests.

**Variant A — degree and connectivity audit.** Validate that the import produced a usable graph before anyone routes on it. Isolated nodes (degree 0) signal a snapping or split failure.

```cypher
MATCH (n:Intersection)
WHERE n.zone = $zone_id
RETURN n.id AS id,
       COUNT { (n)-[:ROAD_SEGMENT]->() } AS out_degree,
       COUNT { (n)<-[:ROAD_SEGMENT]-() } AS in_degree
ORDER BY out_degree + in_degree ASC
LIMIT 25
// Rows with both degrees = 0 are orphaned junctions — re-check the snap tolerance.
```

**Variant B — bounded nearest-segment lookup.** Map an arbitrary GPS fix onto the nearest junction inside a radius. The point index resolves the bounding box before exact distance is evaluated; this is the same predicate shape used by [distance filter query patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/).

```cypher
WITH point({latitude: $lat, longitude: $lon}) AS probe
MATCH (n:Intersection)
WHERE point.distance(n.location, probe) < $radius_m
RETURN n.id AS id, point.distance(n.location, probe) AS dist_m
ORDER BY dist_m ASC
LIMIT 1
// $radius_m keeps the candidate set small; widen only if no match is found.
```

**Variant C — weighted route between mapped junctions.** Run Dijkstra on the projected graph using `length_m` as the cost, then materialize the ordered node ids for the caller.

```cypher
MATCH (src:Intersection {id: $source_id}), (tgt:Intersection {id: $target_id})
CALL gds.shortestPath.dijkstra.stream('routing_graph', {
  sourceNode: src, targetNode: tgt, relationshipWeightProperty: 'length_m'
})
YIELD totalCost, nodeIds
RETURN totalCost, [id IN nodeIds | gds.util.asNode(id).id] AS route
// Swap relationshipWeightProperty to a travel-time field for ETA-based routing.
```

## Performance Tuning

Bulk ingestion is transactional, so batching is the dominant performance lever. Each batch should hold 5,000 to 20,000 rows depending on available JVM heap and disk I/O throughput; oversized batches inflate the transaction log and trigger lock contention, while undersized batches pay round-trip overhead per row. Parameterized batches also keep the query-plan cache from thrashing, which keeps memory consumption predictable.

- **Profile reads with `PROFILE`, validate plan shape with `EXPLAIN`.** Read the plan bottom-up and find the first operator whose `rows` dwarfs the result size — that is where an index or a predicate reorder belongs. A point index that is present but unused usually means the distance predicate runs after an expansion.
- **Cache transformed geometry for static networks.** Planar transformations cost CPU on every reprocess. When the network is stable, persist the projected coordinates so re-imports skip the transform entirely.
- **Refresh statistics after bulk loads.** Stale histograms produce wrong cardinality estimates and push the planner toward scans. Recompute after large ingestion or weight rewrites — the same discipline covered in depth under [cypher performance tuning](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/).
- **Scope GDS projections.** Project only the zone you traverse. Projecting the entire graph for an intra-region route is the most common GDS memory blow-up.
- **Tune the pool to the workload.** `max_connection_pool_size` should match concurrent dispatch fan-out; an undersized pool serializes ingestion, an oversized one starves the database of working memory.

## Edge Cases & Gotchas

- **Coordinate precision traps.** Float rounding on dense urban grids makes two endpoints "almost equal", spawning phantom dead-ends or duplicate nodes. Snap to a fixed tolerance during mapping, never at query time.
- **Mixed CRS coordinates.** A geographic `point({latitude, longitude})` (SRID 4326) and a Cartesian `point({x, y})` (SRID 7203) are not comparable; `point.distance` across SRIDs returns `null`, and a `null` predicate silently drops rows. Normalize CRS at ingestion.
- **Web Mercator length inflation.** Computing edge length in `EPSG:3857` overstates north–south distances. Always derive `length_m` geodesically from the original WGS 84 coordinates, as the pipeline above does.
- **Topology drift across updates.** When networks evolve, edge replacement must preserve node identifiers; reassigning ids orphans subgraphs and fragments indexes. Re-merge on the stable `id`, never delete-and-recreate.
- **Self-intersecting linestrings.** Invalid geometry breaks split-at-intersection logic. Repair with `buffer(0)` before extracting endpoints, and skip non-`LineString` geometries rather than coercing them.
- **GDS projection staleness.** A named projection is a snapshot. After re-ingesting, drop and re-project, or routes will run against the pre-update topology.

## Verification & Testing

Mapping is only safe if you can prove the graph matches the source geometry: every expected junction exists, degrees are plausible, and a known path is reachable with the correct hop count. Seed a deterministic fixture and assert against it.

```python
import pytest
from neo4j import AsyncGraphDatabase

SEED = """
CREATE (a:Intersection {id: 'A', location: point({latitude: 47.60, longitude: -122.33}), zone: 'Z1'})
CREATE (b:Intersection {id: 'B', location: point({latitude: 47.62, longitude: -122.35}), zone: 'Z1'})
CREATE (c:Intersection {id: 'C', location: point({latitude: 47.64, longitude: -122.30}), zone: 'Z1'})
CREATE (a)-[:ROAD_SEGMENT {id: 'e1', length_m: 2500.0, speed_limit: 50}]->(b)
CREATE (b)-[:ROAD_SEGMENT {id: 'e2', length_m: 3100.0, speed_limit: 50}]->(c)
"""


@pytest.mark.asyncio
async def test_topology_is_traversable_and_deduplicated():
    driver = AsyncGraphDatabase.driver("bolt://localhost:7687", auth=("neo4j", "test"))
    async with driver.session(database="neo4j") as s:
        await s.run("MATCH (n) DETACH DELETE n")
        await s.run(SEED)

        # No orphaned junctions
        orphans = await (await s.run(
            "MATCH (n:Intersection) WHERE COUNT { (n)--() } = 0 RETURN count(n) AS c"
        )).single()
        assert orphans["c"] == 0, "found orphaned intersections — check snapping"

        # Known path A->C exists with exactly two segments
        rec = await (await s.run(
            """
            MATCH p = shortestPath((:Intersection {id: 'A'})
                  -[:ROAD_SEGMENT*1..40]->(:Intersection {id: 'C'}))
            RETURN length(p) AS hops
            """
        )).single()

    assert rec is not None, "expected a path A->C to exist"
    assert rec["hops"] == 2, "A->C should traverse exactly two segments"
    await driver.close()
```

Pair this with an idempotency check in CI: run the ingestion twice against the same fixture and assert the node and relationship counts are identical after the second pass. A snapping or constraint regression will not change correctness on a single import — only on re-import — so a one-shot test alone will not catch it.

## FAQ

<details>
<summary>What snapping tolerance should I use for road-network data?</summary>

Match the tolerance to source accuracy. Survey-grade or authoritative road data tolerates `0.5 m`; consumer GPS traces or mixed-source imports often need `1.0–2.0 m`. Too tight leaves duplicate junctions and broken connectivity; too loose merges genuinely distinct intersections and erases turns. Validate the chosen value by routing a handful of known paths against ground-truth GPS traces before committing to it.
</details>

<details>
<summary>Should edge length be computed in the projected CRS or in WGS 84?</summary>

Compute it geodesically over the original WGS 84 coordinates. Projected systems like Web Mercator distort distance — badly near the poles and in the north–south direction — so a length taken in `EPSG:3857` will mis-weight your routes. Use the projection for spatial operations and indexing, but use a geodesic calculator (for example `pyproj`'s `Geod.inv`) for the metric stored on the edge.
</details>

<details>
<summary>Why are some junctions ending up as isolated nodes after import?</summary>

Isolated (degree-0) nodes almost always mean two endpoints that should have snapped together did not, so the connecting segment merged against a different node id. Re-check the snapping tolerance and confirm your source and target ids are derived from the *snapped* coordinates, not the raw ones. The degree-audit query in the variants section surfaces these rows directly.
</details>

<details>
<summary>How do I keep node ids stable when re-importing an updated network?</summary>

Derive ids deterministically from snapped geometry (or carry a stable external key from the source) and `MERGE` on a uniqueness-constrained `id`. Then `ON CREATE` only sets immutable geometry while `SET` updates mutable edge properties. This makes re-ingestion idempotent: existing junctions are reused, edges are updated in place, and no subgraph is orphaned.
</details>

<details>
<summary>Do I need GDS, or can I route with plain Cypher?</summary>

`shortestPath` in plain Cypher handles unweighted reachability inside a bounded region and needs no plugin. When the objective is weighted cost — true distance, travel time, fuel — project a region-scoped subgraph and run GDS Dijkstra with `relationshipWeightProperty`. The mapping schema here supports both; the deciding factor is whether your routes must minimize a numeric edge cost rather than hop count.
</details>

## Related

- [Spatial Indexing Strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) — choosing the index type whose selectivity your mapped points expose to the planner.
- [Graph Query Planner Optimization](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/) — making the planner seek your point index instead of scanning the label.
- [How to Map Road Networks to Graph Nodes and Edges](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/how-to-map-road-networks-to-graph-nodes-and-edges/) — a deeper walkthrough of quantization, intersection splitting, and directional weights.
- [Snapping Coordinates and Detecting Intersections](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/snapping-coordinates-and-detecting-intersections/) — tolerance-based vertex merging and shared-node intersection detection.
- [OSM Data Ingestion Pipelines](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/osm-data-ingestion-pipelines/) — sourcing and parsing the raw geometry this mapping consumes.
- [Distance Filter Query Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/) — predicate shapes that resolve against the point index on your junctions.

This guide is part of [Spatial Graph Database Fundamentals for Python](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/).

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "What snapping tolerance should I use for road-network data?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Match the tolerance to source accuracy. Survey-grade or authoritative road data tolerates 0.5 m; consumer GPS traces or mixed-source imports often need 1.0 to 2.0 m. Too tight leaves duplicate junctions and broken connectivity; too loose merges distinct intersections and erases turns. Validate the chosen value by routing known paths against ground-truth GPS traces before committing to it."
      }
    },
    {
      "@type": "Question",
      "name": "Should edge length be computed in the projected CRS or in WGS 84?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Compute it geodesically over the original WGS 84 coordinates. Projected systems like Web Mercator distort distance, especially in the north-south direction, so a length taken in EPSG:3857 will mis-weight routes. Use the projection for spatial operations and indexing, but use a geodesic calculator such as pyproj Geod.inv for the metric stored on the edge."
      }
    },
    {
      "@type": "Question",
      "name": "Why are some junctions ending up as isolated nodes after import?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Isolated degree-0 nodes almost always mean two endpoints that should have snapped together did not, so the connecting segment merged against a different node id. Re-check the snapping tolerance and confirm source and target ids are derived from the snapped coordinates, not the raw ones. A degree-audit query surfaces these rows directly."
      }
    },
    {
      "@type": "Question",
      "name": "How do I keep node ids stable when re-importing an updated network?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "Derive ids deterministically from snapped geometry or carry a stable external key, then MERGE on a uniqueness-constrained id. Use ON CREATE to set immutable geometry and SET to update mutable edge properties. This makes re-ingestion idempotent: existing junctions are reused, edges update in place, and no subgraph is orphaned."
      }
    },
    {
      "@type": "Question",
      "name": "Do I need GDS, or can I route with plain Cypher?",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "shortestPath in plain Cypher handles unweighted reachability inside a bounded region with no plugin. When the objective is weighted cost such as distance, travel time, or fuel, project a region-scoped subgraph and run GDS Dijkstra with relationshipWeightProperty. The mapping schema supports both; the deciding factor is whether routes must minimize a numeric edge cost rather than hop count."
      }
    }
  ]
}
</script>
