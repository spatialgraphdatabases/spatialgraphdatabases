---
pageTitle: Automated OSM to Graph ETL Pipelines
---
# Building Automated OSM to Graph ETL Pipelines

Routing solvers collapse the moment raw OpenStreetMap data reaches production with unresolved topological fragmentation: shortest-path queries return null traversals, A* heuristics loop on phantom self-edges, and dispatch latency spikes as the planner scans disconnected components. The root cause is almost always geometric debt baked in at load time — overlapping ways, floating nodes, and micro-duplications that fracture the adjacency model. This guide resolves that with a deterministic, idempotent ETL layer that snaps coordinates in metric space, deduplicates edges by an order-independent hash, and upserts the result through the async Neo4j driver so a re-run never corrupts an existing graph.

<svg viewBox="0 0 960 300" role="img" aria-labelledby="etl-title etl-desc" xmlns="http://www.w3.org/2000/svg">
  <title id="etl-title">Idempotent OSM-to-graph ETL pipeline as a left-to-right data flow</title>
  <desc id="etl-desc">Raw OpenStreetMap data flows through six stages. A PBF extract is diagnosed for node degree, orphan, and duplicate problems, then projected from EPSG:4326 to EPSG:3857 so distances are metric. A k-d tree snaps proximate nodes within a 1.5 metre tolerance and union-find collapses each group of proximate nodes to one canonical node. A deterministic sha256 hash of the sorted min and max id pair deduplicates undirected edges, and the result is upserted into Neo4j with an idempotent MERGE on the CONNECTS relationship. A dashed feedback arc shows that re-running the pipeline is a no-op because the hashed MERGE never duplicates an existing edge.</desc>
  <style>
    .etl-cap{font:700 11px var(--font-sans,system-ui,sans-serif);fill:var(--ink-mute,#6b7280);letter-spacing:.08em;text-transform:uppercase;}
    .etl-box{fill:var(--viz-panel,#f4f4f5);stroke:var(--line-strong,#9ca3af);stroke-width:1.5;}
    .etl-acc{fill:var(--viz-panel,#f4f4f5);stroke:var(--accent,#0e7c86);stroke-width:2.5;}
    .etl-t{font:600 12.5px var(--font-sans,system-ui,sans-serif);fill:var(--ink,#1f2937);}
    .etl-tc{font:600 12.5px var(--font-sans,system-ui,sans-serif);fill:var(--accent,#0e7c86);}
    .etl-s{font:10.5px var(--font-mono,ui-monospace,monospace);fill:var(--ink-mute,#6b7280);}
    .etl-flow{fill:none;stroke:var(--accent,#0e7c86);stroke-width:2.5;}
    .etl-loop{fill:none;stroke:currentColor;stroke-width:2;opacity:.5;stroke-dasharray:6 4;}
    .etl-tol{fill:none;stroke:var(--accent,#0e7c86);stroke-width:1.3;stroke-dasharray:4 3;}
    .etl-note{font:italic 11px var(--font-sans,system-ui,sans-serif);fill:var(--accent,#0e7c86);}
    .etl-loopt{font:italic 11px var(--font-sans,system-ui,sans-serif);fill:currentColor;opacity:.7;}
  </style>
  <defs>
    <marker id="etl-arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="var(--accent,#0e7c86)"/>
    </marker>
    <marker id="etl-larr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor" opacity=".5"/>
    </marker>
  </defs>
  <!-- stage 1: extract -->
  <rect class="viz-backdrop" x="0" y="0" width="960" height="300" fill="var(--viz-bg,#ffffff)"/>
  <text class="etl-cap" x="80" y="68" text-anchor="middle">Extract</text>
  <rect class="etl-box" x="14" y="84" width="132" height="84" rx="10"/>
  <text class="etl-t" x="80" y="122" text-anchor="middle">PBF extract</text>
  <text class="etl-s" x="80" y="142" text-anchor="middle">region.osm.pbf</text>
  <!-- stage 2: diagnose -->
  <text class="etl-cap" x="240" y="68" text-anchor="middle">Diagnose</text>
  <rect class="etl-box" x="174" y="84" width="132" height="84" rx="10"/>
  <text class="etl-t" x="240" y="122" text-anchor="middle">Diagnostics</text>
  <text class="etl-s" x="240" y="142" text-anchor="middle">degree · orphan</text>
  <text class="etl-s" x="240" y="156" text-anchor="middle">· duplicate</text>
  <!-- stage 3: project -->
  <text class="etl-cap" x="400" y="68" text-anchor="middle">Project</text>
  <rect class="etl-box" x="334" y="84" width="132" height="84" rx="10"/>
  <text class="etl-t" x="400" y="122" text-anchor="middle">Metric reproj.</text>
  <text class="etl-s" x="400" y="142" text-anchor="middle">4326 &#8594; 3857</text>
  <text class="etl-s" x="400" y="156" text-anchor="middle">Web Mercator</text>
  <!-- stage 4: snap (accent) -->
  <text class="etl-cap" x="560" y="68" text-anchor="middle">Snap</text>
  <rect class="etl-acc" x="494" y="84" width="132" height="84" rx="10"/>
  <text class="etl-tc" x="560" y="118" text-anchor="middle">k-d snap +</text>
  <text class="etl-tc" x="560" y="134" text-anchor="middle">union-find</text>
  <text class="etl-s" x="560" y="154" text-anchor="middle">query_pairs(r)</text>
  <!-- stage 5: dedup -->
  <text class="etl-cap" x="720" y="68" text-anchor="middle">Dedup</text>
  <rect class="etl-box" x="654" y="84" width="132" height="84" rx="10"/>
  <text class="etl-t" x="720" y="122" text-anchor="middle">Hash + dedup</text>
  <text class="etl-s" x="720" y="142" text-anchor="middle">sha256(min|max)</text>
  <!-- stage 6: load (accent) -->
  <text class="etl-cap" x="880" y="68" text-anchor="middle">Load</text>
  <rect class="etl-acc" x="814" y="84" width="132" height="84" rx="10"/>
  <text class="etl-tc" x="880" y="122" text-anchor="middle">MERGE upsert</text>
  <text class="etl-s" x="880" y="142" text-anchor="middle">Neo4j :CONNECTS</text>
  <text class="etl-s" x="880" y="156" text-anchor="middle">async pool</text>
  <!-- flow arrows -->
  <path class="etl-flow" d="M146 126 H174" marker-end="url(#etl-arr)"/>
  <path class="etl-flow" d="M306 126 H334" marker-end="url(#etl-arr)"/>
  <path class="etl-flow" d="M466 126 H494" marker-end="url(#etl-arr)"/>
  <path class="etl-flow" d="M626 126 H654" marker-end="url(#etl-arr)"/>
  <path class="etl-flow" d="M786 126 H814" marker-end="url(#etl-arr)"/>
  <!-- tolerance annotation on snap stage -->
  <path class="etl-tol" d="M560 168 V206"/>
  <text class="etl-note" x="560" y="222" text-anchor="middle">tolerance_m = 1.5</text>
  <text class="etl-s" x="560" y="238" text-anchor="middle">collapse cluster &#8594; 1 canonical node</text>
  <!-- idempotency feedback loop -->
  <path class="etl-loop" d="M880 168 V264 H80 V168" marker-end="url(#etl-larr)"/>
  <text class="etl-loopt" x="480" y="282" text-anchor="middle">re-run is a no-op &#8212; MERGE on deterministic hash never duplicates</text>
</svg>

## Prerequisites & Versions

This pipeline targets Python 3.11+ and Neo4j 5.x. The transformation stays in columnar memory (Arrow/NumPy) and never touches pandas, so it scales to regional extracts on a single worker.

| Library | Min version | Install command |
| --- | --- | --- |
| `neo4j` (async driver) | 5.14 | `pip install "neo4j>=5.14"` |
| `pyarrow` | 14.0 | `pip install "pyarrow>=14.0"` |
| `numpy` | 1.26 | `pip install "numpy>=1.26"` |
| `scipy` | 1.11 | `pip install "scipy>=1.11"` |
| `pyproj` | 3.6 | `pip install "pyproj>=3.6"` |

Before loading, create the supporting constraint and index so `MERGE` resolves against the planner rather than scanning every `Node`:

```cypher
CREATE CONSTRAINT node_id_unique IF NOT EXISTS
FOR (n:Node) REQUIRE n.id IS UNIQUE;

CREATE INDEX edge_hash_idx IF NOT EXISTS
FOR ()-[r:CONNECTS]-() ON (r.hash);
```

The uniqueness constraint also provisions a backing index, which is what makes the repeated `MERGE (s:Node {id: ...})` calls O(log N) instead of O(N). Mapping raw ways onto this `Node`/`CONNECTS` shape follows the same conventions covered in [node and edge spatial mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/).

## Implementation

The pipeline has two halves: a pure transformation that produces a deduplicated Arrow table of edges, and an async loader that streams those edges into the graph through pooled connections. Both are self-contained and runnable.

```python
import asyncio
import hashlib

import numpy as np
import pyarrow as pa
import pyarrow.compute as pc
from neo4j import AsyncGraphDatabase
from pyproj import Transformer
from scipy.spatial import cKDTree


class SpatialGraphETL:
    def __init__(self, uri: str, user: str, password: str, pool_size: int = 25):
        self.driver = AsyncGraphDatabase.driver(
            uri, auth=(user, password), max_connection_pool_size=pool_size
        )

    async def ingest_batch(self, batch_edges: list[dict]):
        """Transactional upsert with deterministic edge hashing."""
        query = """
        UNWIND $batch AS row
        MERGE (s:Node {id: row.source})
        MERGE (t:Node {id: row.target})
        MERGE (s)-[r:CONNECTS {hash: row.edge_hash}]->(t)
        ON CREATE SET r.weight = row.weight, r.surface = row.surface
        ON MATCH SET r.updated_at = timestamp()
        """
        async with self.driver.session() as session:
            await session.run(query, batch=batch_edges)

    async def ingest_table(self, edges: pa.Table, batch_size: int = 25_000,
                           max_inflight: int = 8):
        """Stream an Arrow table into the graph with bounded concurrency."""
        rows = edges.to_pylist()
        sem = asyncio.Semaphore(max_inflight)

        async def _send(chunk: list[dict]):
            async with sem:
                await self.ingest_batch(chunk)

        tasks = [
            _send(rows[i:i + batch_size])
            for i in range(0, len(rows), batch_size)
        ]
        await asyncio.gather(*tasks)

    async def close(self):
        await self.driver.close()


def normalize_topology_pyarrow(
    nodes_table: pa.Table,
    edges_table: pa.Table,
    tolerance_m: float = 1.5,
) -> pa.Table:
    """Snap proximate nodes via a metric k-d tree, then emit deduplicated edges
    that carry every attribute the Cypher upsert expects.

    ``nodes_table`` columns: ``node_id``, ``lat``, ``lon``.
    ``edges_table`` columns: ``source``, ``target``, ``weight``, ``surface``.
    Returns an Arrow table with columns: ``source``, ``target``, ``edge_hash``,
    ``weight``, ``surface``.
    """
    # 1. Project to metric space for accurate Euclidean distance
    transformer = Transformer.from_crs("EPSG:4326", "EPSG:3857", always_xy=True)
    x, y = transformer.transform(
        nodes_table.column("lon").to_numpy(),
        nodes_table.column("lat").to_numpy(),
    )

    # 2. k-d tree spatial index & proximity query
    tree = cKDTree(np.column_stack((x, y)))
    pairs = tree.query_pairs(r=tolerance_m, output_type="ndarray")

    # 3. Union-Find for connected component resolution
    parent = np.arange(len(nodes_table))

    def find(i: int) -> int:
        path = []
        while parent[i] != i:
            path.append(i)
            i = parent[i]
        for node in path:
            parent[node] = i
        return i

    def union(i: int, j: int) -> None:
        root_i, root_j = find(i), find(j)
        if root_i != root_j:
            parent[root_j] = root_i

    for i, j in pairs:
        union(int(i), int(j))

    # 4. Canonical id mapping (node row index -> canonical row index -> node_id)
    node_ids = nodes_table.column("node_id").to_numpy()
    id_index = {nid: idx for idx, nid in enumerate(node_ids)}
    canonical_for = np.array([node_ids[find(i)] for i in range(len(node_ids))])

    src_canonical = np.array([canonical_for[id_index[s]] for s in edges_table.column("source").to_numpy()])
    tgt_canonical = np.array([canonical_for[id_index[t]] for t in edges_table.column("target").to_numpy()])

    # 5. Drop self-loops introduced by snapping
    keep = src_canonical != tgt_canonical
    src_canonical = src_canonical[keep]
    tgt_canonical = tgt_canonical[keep]
    weights = edges_table.column("weight").to_numpy()[keep]
    surfaces = edges_table.column("surface").to_numpy(zero_copy_only=False)[keep]

    # 6. Deterministic, order-independent edge hash
    edge_hashes = np.array([
        hashlib.sha256(f"{min(s, t)}|{max(s, t)}".encode()).hexdigest()
        for s, t in zip(src_canonical, tgt_canonical)
    ])

    edges = pa.table({
        "source": src_canonical,
        "target": tgt_canonical,
        "edge_hash": edge_hashes,
        "weight": weights,
        "surface": surfaces,
    })

    # Arrow has no drop_duplicates(); group by the hash and keep the first row.
    grouped = edges.group_by("edge_hash").aggregate([
        ("source", "first"), ("target", "first"),
        ("weight", "first"), ("surface", "first"),
    ])
    return grouped.rename_columns(["edge_hash", "source", "target", "weight", "surface"])


async def run_pipeline(uri, user, password, nodes_table, edges_table):
    edges = normalize_topology_pyarrow(nodes_table, edges_table, tolerance_m=1.5)
    etl = SpatialGraphETL(uri, user, password)
    try:
        await etl.ingest_table(edges)
    finally:
        await etl.close()
```

The Cypher executed per batch is the contract between transformation and storage. `MERGE` on the deterministic `hash` is what makes a re-run a no-op instead of a duplication event:

```cypher
// Idempotent edge ingestion with schema enforcement
UNWIND $batch AS row
MERGE (s:Node {id: row.source})
MERGE (t:Node {id: row.target})
MERGE (s)-[r:CONNECTS {hash: row.edge_hash}]->(t)
ON CREATE SET r.weight = row.weight, r.surface = row.surface
ON MATCH SET r.updated_at = timestamp()
```

## How It Works

Spatial snapping on raw latitude/longitude is mathematically invalid for meter-based tolerances because one degree of longitude shrinks toward the poles. Step 1 projects every node into Web Mercator (EPSG:3857) so the `tolerance_m` radius is an honest Euclidean distance. Step 2 builds a `cKDTree` and calls `query_pairs`, which returns only the node pairs closer than the tolerance — turning an O(N²) all-pairs comparison into a localized index probe.

Steps 3 and 4 are the part most naive snappers get wrong. When three or more endpoints sit within tolerance of each other, pairwise merging produces inconsistent results depending on iteration order. The union-find structure (with path compression in `find`) collapses each proximity cluster into a single canonical node deterministically, so every edge endpoint resolves to a stable id regardless of input ordering.

Step 5 drops self-loops created when both endpoints of a short segment snap to the same canonical node, and step 6 computes the `edge_hash` from the sorted `(min, max)` id pair. Because the hash is order-independent, an undirected street loaded as `A→B` in one extract and `B→A` in the next collapses to one relationship. That single property is what lets the `MERGE` in the loader stay idempotent across repeated regional imports. The bounded-concurrency `ingest_table` then saturates network bandwidth without exhausting the connection pool — the same async batching principle developed in depth under [async batch processing for graphs](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/async-batch-processing-for-graphs/).

## Common Failure Patterns

**Self-loops survive snapping and poison routing weights.** If step 5 is skipped, a snapped micro-segment becomes a zero-length `CONNECTS` relationship that A* will happily traverse forever. Guard it both in transform and at the query layer:

```cypher
MATCH (n:Node)-[r:CONNECTS]->(n)
DELETE r;
```

**`KeyError` during canonical id mapping.** When `edges_table` references a `source` or `target` that is missing from `nodes_table` (a common artifact of clipping ways at a bounding-box boundary), the `id_index[s]` lookup raises. Filter dangling edges before remapping rather than letting the comprehension crash:

<svg viewBox="0 0 780 296" role="img" aria-labelledby="esTitle esDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="esTitle">A snapped micro-segment becomes a zero-weight self-loop that a search will sit on</title>
  <desc id="esDesc">Left: two way endpoints 8 centimetres apart, before snapping, joined by a short segment. Middle: at six-decimal precision both round to the same canonical node, so the segment now starts and ends on that node — a self-loop of length zero. Right: what a weighted search does with it. Relaxing a zero-cost edge never increases the tentative distance, so the node can be re-relaxed indefinitely and the frontier stops advancing. The guard deletes any CONNECTS whose start and end node are the same, in the transform and again at the query layer.</desc>
  <defs>
    <marker id="es-a" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
  </defs>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="296" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">How a rounding step manufactures an edge no router can leave</text>
  <rect x="24" y="42" width="236" height="176" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <text x="142" y="66" text-anchor="middle" font-size="11.5" font-weight="700" fill="currentColor">before snapping</text>
  <circle cx="112" cy="140" r="11" fill="var(--accent,#0a656d)"/>
  <circle cx="176" cy="140" r="11" fill="var(--accent,#0a656d)"/>
  <line x1="123" y1="140" x2="164" y2="140" stroke="currentColor" stroke-width="2"/>
  <text x="144" y="128" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">8 cm</text>
  <text x="142" y="182" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">two distinct endpoints</text>
  <text x="142" y="198" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">one very short segment</text>
  <rect x="272" y="42" width="236" height="176" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-ok,#7d6200)" stroke-width="1.6"/>
  <text x="390" y="66" text-anchor="middle" font-size="11.5" font-weight="700" fill="var(--viz-ok,#7d6200)">after snapping to 6 dp</text>
  <circle cx="390" cy="140" r="13" fill="var(--viz-ok,#7d6200)"/>
  <path d="M390 127 C 358 108, 422 108, 390 127" fill="none" stroke="var(--viz-ok,#7d6200)" stroke-width="2.2" marker-end="url(#es-a)"/>
  <text x="390" y="100" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-ok,#7d6200)">length 0</text>
  <text x="390" y="182" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">both endpoints round together</text>
  <text x="390" y="198" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">the segment closes on itself</text>
  <rect x="520" y="42" width="236" height="176" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-poor,#a8320f)" stroke-width="1.8"/>
  <text x="638" y="66" text-anchor="middle" font-size="11.5" font-weight="700" fill="var(--viz-poor,#a8320f)">what the search does</text>
  <g font-size="10" text-anchor="middle">
    <text x="638" y="96" font-weight="700" fill="currentColor">relax: 412.0 + 0.0 = 412.0</text>
    <text x="638" y="116" fill="var(--viz-ink-mute,#565f6d)">not worse — push again</text>
    <text x="638" y="140" font-weight="700" fill="currentColor">relax: 412.0 + 0.0 = 412.0</text>
    <text x="638" y="160" fill="var(--viz-ink-mute,#565f6d)">not worse — push again</text>
    <text x="638" y="184" font-weight="700" fill="var(--viz-poor,#a8320f)">frontier stops advancing</text>
  </g>
  <text x="24" y="252" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">The pipeline is otherwise correct — the nodes are right, the topology is right, and the import reports success. Guard</text>
  <text x="24" y="268" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">it in the transform, and again with a delete at the query layer, because a single missed run leaves the loop behind</text>
  <text x="24" y="284" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">for every query that follows.</text>
</svg>

```python
valid = set(nodes_table.column("node_id").to_pylist())
mask = pc.and_(
    pc.is_in(edges_table.column("source"), value_set=pa.array(valid)),
    pc.is_in(edges_table.column("target"), value_set=pa.array(valid)),
)
edges_table = edges_table.filter(mask)
```

**Connection pool exhaustion under unbounded fan-out.** Calling `asyncio.gather` over every batch without a semaphore opens more sessions than `max_connection_pool_size` allows; the driver then blocks or raises acquisition timeouts mid-load. The `max_inflight` semaphore in `ingest_table` caps concurrent sessions below the pool ceiling — keep `max_inflight` at roughly one-third of `pool_size` to leave headroom for retries.

## Performance Notes

Continental extracts will not fit a single `cKDTree` in heap, so the pipeline partitions by administrative boundary or UTM zone. Peak memory and partition count follow directly from the partition size $N_{\text{part}}$:

$$
P = \left\lceil \frac{N}{N_{\text{part}}} \right\rceil, \qquad
M_{\text{peak}} \approx N_{\text{part}}\,\bigl(c_{\text{kd}} + c_{\text{arrow}}\bigr)
$$

where $c_{\text{kd}} \approx 8\text{–}12$ bytes per coordinate pair for the tree and $c_{\text{arrow}}$ is the columnar buffer footprint per row. With $N_{\text{part}} = 500{,}000$, each partition tree builds in roughly $O(N_{\text{part}} \log N_{\text{part}})$ and stays well under a 1 GB worker budget, so partitions can be processed in parallel.

Tolerance is the dominant precision/throughput knob. A tight tolerance (≤0.5 m) preserves curb-level accuracy but inflates vertex count and adjacency sparsity; a loose tolerance (≥3.0 m) accelerates ingestion but fabricates shortcuts in pedestrian networks. For mixed road classes, scale tolerance dynamically — 1.0 m for residential streets, 2.5 m for motorways. Switch from in-memory snapping to a tiled, disk-backed strategy once a single partition exceeds available heap. After load, verify topology rather than trusting it: confirm the largest connected component holds ≥99.8% of routable edges, then push routing weight tuning into [Cypher performance tuning](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/) and index selection into [spatial indexing strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/).

## Related

- [OSM Data Ingestion Pipelines](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/osm-data-ingestion-pipelines/) — the ingestion pipeline guide this page belongs to.
- [Attribute Synchronization Techniques](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/attribute-synchronization-techniques/) — keep surface, weight, and POI metadata current after the initial load.
- [POI Enrichment Workflows](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/poi-enrichment-workflows/) — attach demographic and amenity context to the normalized node set.
- [Async Batch Processing for Graphs](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/async-batch-processing-for-graphs/) — scale the loader with `asyncio` backpressure controls.

This guide is part of the [OSM Data Ingestion Pipelines](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/osm-data-ingestion-pipelines/) topic, which sits within the broader [Spatial Graph Construction & OSM Ingestion](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/) section.
