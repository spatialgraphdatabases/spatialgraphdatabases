---
pageTitle: Parsing OSM PBF with PyOsmium
title: Parsing OSM PBF Extracts with PyOsmium
description: Stream a .osm.pbf extract with PyOsmium to emit routing nodes and ways, resolve node-refs via a location cache, and feed an async Neo4j writer.
slug: parsing-osm-pbf-extracts-with-pyosmium
type: article
breadcrumb: Parsing PBF with PyOsmium
datePublished: 2026-07-14
dateModified: 2026-07-14
---
# Parsing OSM PBF Extracts with PyOsmium

A regional `.osm.pbf` extract is a few gigabytes on disk and tens of gigabytes once its nodes, ways, and relations are materialized as Python objects. The naive loader — parse everything into dictionaries, then build edges — runs out of heap on anything larger than a city before it writes a single relationship. The symptom is an importer that works on a suburb extract and gets OOM-killed on a country one. The root cause is materialization: PBF stores nodes and ways in separate fileblocks, and a way references its nodes by id only, so a loader that wants coordinates on its edges either keeps every node in memory or makes a second pass. PyOsmium solves both halves — it streams fileblocks through callbacks and maintains a compact node-location index so each way arrives with its geometry already attached. This page wires that streaming handler to a bounded async Neo4j writer so the resident set stays flat regardless of extract size. It is the PBF-parsing stage that feeds the broader [OSM data ingestion pipelines](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/osm-data-ingestion-pipelines/).

## Prerequisites & Versions

The location index (`locations=True`) and the `w.nodes[i].location` back-fill are stable across PyOsmium 3.x. The bridge to the async driver is pure `asyncio` and version-independent.

| Requirement | Minimum version | Note |
| --- | --- | --- |
| Python | 3.10+ | `asyncio.to_thread`, union types used below |
| osmium (PyOsmium) | 3.6+ | `SimpleHandler`, `apply_file(..., locations=True)` |
| neo4j (driver) | 5.x | `AsyncGraphDatabase`, native `point` serialization |
| Neo4j server | 5.13+ | `MERGE` on `point` properties, uniqueness constraints |

```bash
pip install "osmium>=3.6" "neo4j>=5.18"
```

Provision the backing constraint before the first run so every `MERGE (:Node {id})` resolves as an index seek rather than a label scan:

```cypher
CREATE CONSTRAINT node_id_unique IF NOT EXISTS
FOR (n:Node) REQUIRE n.id IS UNIQUE;
```

## Implementation

The parser runs in a worker thread because `apply_file` is a blocking C++ loop that cannot `await`. It hands completed edge batches to the event loop through a **bounded** queue, and a single async consumer drains that queue into Neo4j. The bounded queue is the backpressure valve: when the writer falls behind, the queue fills, and the parser thread blocks on `run_coroutine_threadsafe(...).result()` until room frees up — so the file is read exactly as fast as the graph can absorb it.

<svg viewBox="0 0 940 386" role="img" aria-labelledby="pbfTitle pbfDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="pbfTitle">Streaming PBF fileblocks through PyOsmium callbacks into a bounded async writer</title>
  <desc id="pbfDesc">Left: a PBF extract holds separate fileblocks for nodes, ways, and relations. Centre: PyOsmium dispatches each primitive to a callback. The node callback populates a compact location index; the way callback reads that index to resolve its node-refs to coordinates and keeps only highway-tagged ways, emitting consecutive coordinate pairs as routing edges; the relation callback is deferred to turn-restriction handling. Right: edge batches cross a bounded queue that applies backpressure into an async Neo4j writer that upserts Node and ROUTE primitives.</desc>
  <defs>
    <marker id="pbf-arr" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
    <marker id="pbf-arr-a" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="var(--accent,#0a656d)"/>
    </marker>
  </defs>
  <!-- column captions -->
  <g font-size="11" letter-spacing="0.6" opacity="0.7" text-anchor="middle" fill="currentColor">
    <text x="90" y="26">PBF FILEBLOCKS</text>
    <text x="410" y="26">PYOSMIUM CALLBACKS</text>
    <text x="828" y="26">ASYNC WRITER</text>
  </g>
  <!-- PBF fileblocks -->
  <g font-size="12.5" fill="currentColor">
    <rect x="24" y="52" width="132" height="52" rx="8" fill="var(--surface-3)" stroke="var(--line)"/>
    <text x="90" y="83" text-anchor="middle">nodes · lat/lon</text>
    <rect x="24" y="150" width="132" height="52" rx="8" fill="var(--surface-3)" stroke="var(--line)"/>
    <text x="90" y="181" text-anchor="middle">ways · node-refs</text>
    <rect x="24" y="248" width="132" height="52" rx="8" fill="var(--surface-3)" stroke="var(--line)"/>
    <text x="90" y="279" text-anchor="middle">relations</text>
  </g>
  <!-- callbacks -->
  <g font-size="13" fill="currentColor">
    <rect x="284" y="48" width="150" height="60" rx="9" fill="var(--surface-2)" stroke="var(--ink-soft)" stroke-width="2"/>
    <text x="359" y="74" text-anchor="middle" font-weight="600">node(n)</text>
    <text x="359" y="94" text-anchor="middle" font-size="10.5" opacity="0.75">index n.location</text>
    <rect x="284" y="146" width="150" height="60" rx="9" fill="var(--surface-2)" stroke="var(--accent)" stroke-width="2.4"/>
    <text x="359" y="172" text-anchor="middle" font-weight="600" fill="var(--accent,#0a656d)">way(w)</text>
    <text x="359" y="192" text-anchor="middle" font-size="10.5" opacity="0.75">filter highway=*</text>
    <rect x="284" y="244" width="150" height="60" rx="9" fill="var(--surface-2)" stroke="var(--line)" stroke-dasharray="5 4"/>
    <text x="359" y="270" text-anchor="middle" font-weight="600">relation(r)</text>
    <text x="359" y="290" text-anchor="middle" font-size="10.5" opacity="0.75">deferred</text>
  </g>
  <!-- location index store -->
  <g>
    <path d="M470 118 a44 11 0 0 0 88 0 v34 a44 11 0 0 1 -88 0 z" fill="var(--surface-2)" stroke="var(--accent-4)" stroke-width="2"/>
    <ellipse cx="514" cy="118" rx="44" ry="11" fill="var(--surface-2)" stroke="var(--accent-4)" stroke-width="2"/>
    <text x="514" y="122" text-anchor="middle" font-size="11.5" fill="currentColor">location</text>
    <text x="514" y="150" text-anchor="middle" font-size="11.5" fill="currentColor">index</text>
  </g>
  <!-- fileblock -> callback arrows -->
  <g stroke="currentColor" stroke-width="1.8" fill="none">
    <path d="M156 78 H282" marker-end="url(#pbf-arr)"/>
    <path d="M156 176 H282" marker-end="url(#pbf-arr)"/>
    <path d="M156 274 H282" marker-end="url(#pbf-arr)"/>
  </g>
  <!-- node -> index (write) and index -> way (read) -->
  <path d="M434 88 C 470 96 480 104 490 112" stroke="var(--accent-4)" stroke-width="1.8" fill="none" marker-end="url(#pbf-arr)"/>
  <path d="M500 158 C 470 168 452 172 436 174" stroke="var(--accent-4)" stroke-width="1.8" fill="none" marker-end="url(#pbf-arr)"/>
  <text x="592" y="120" font-size="9.5" fill="var(--accent-4,#b58900)">write refs</text>
  <text x="592" y="152" font-size="9.5" fill="var(--accent-4,#b58900)">resolve coords</text>
  <!-- deferred relation note -->
  <path d="M434 274 H520" stroke="currentColor" stroke-width="1.4" stroke-dasharray="5 4" fill="none" marker-end="url(#pbf-arr)"/>
  <text x="612" y="278" text-anchor="middle" font-size="10" fill="currentColor" opacity="0.7">turn restrictions</text>
  <!-- way -> bounded queue -->
  <path d="M434 176 H648" stroke="var(--accent,#0a656d)" stroke-width="2.4" fill="none" marker-end="url(#pbf-arr-a)"/>
  <text x="560" y="168" text-anchor="middle" font-size="10.5" fill="var(--accent,#0a656d)" font-weight="600">edge batches</text>
  <!-- bounded queue -->
  <g font-size="11.5" fill="currentColor">
    <rect x="656" y="150" width="120" height="60" rx="9" fill="var(--surface-3)" stroke="var(--accent)" stroke-width="2"/>
    <text x="716" y="176" text-anchor="middle" font-weight="600">bounded</text>
    <text x="716" y="194" text-anchor="middle" font-weight="600">queue</text>
    <text x="716" y="230" text-anchor="middle" font-size="10" opacity="0.75">backpressure</text>
  </g>
  <!-- writer + graph -->
  <path d="M776 180 H812" stroke="var(--accent,#0a656d)" stroke-width="2.4" fill="none" marker-end="url(#pbf-arr-a)"/>
  <g font-size="12.5" fill="currentColor">
    <rect x="820" y="52" width="108" height="60" rx="9" fill="var(--accent)" stroke="var(--accent)"/>
    <text x="874" y="78" text-anchor="middle" fill="#ffffff" font-weight="600">writer</text>
    <text x="874" y="98" text-anchor="middle" fill="#ffffff" font-size="10.5">execute_write</text>
    <rect x="820" y="150" width="108" height="60" rx="9" fill="var(--surface-2)" stroke="var(--accent-3)" stroke-width="2"/>
    <text x="874" y="176" text-anchor="middle" font-weight="600">:Node</text>
    <text x="874" y="196" text-anchor="middle" font-size="11">:ROUTE</text>
  </g>
  <path d="M874 150 V114" stroke="currentColor" stroke-width="1.6" fill="none" marker-end="url(#pbf-arr)"/>
</svg>

The whole pipeline is one runnable script. The handler emits an edge per consecutive node pair along each routable way; the writer upserts both endpoints and the directed segment between them.

```python
import asyncio
import osmium
from neo4j import AsyncGraphDatabase

ROUTABLE = {  # highway tag values that become routing edges
    "motorway", "trunk", "primary", "secondary", "tertiary",
    "unclassified", "residential", "living_street", "service",
    "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link",
}


class RoutingEdgeHandler(osmium.SimpleHandler):
    """Streams a PBF extract and pushes highway edge batches onto a bounded queue."""

    def __init__(self, loop, queue: asyncio.Queue, batch_size: int = 10_000):
        super().__init__()
        self.loop = loop
        self.queue = queue
        self.batch_size = batch_size
        self._edges: list[dict] = []
        self.nodes_seen = 0
        self.ways_kept = 0

    def node(self, n):
        # Locations are stored in PyOsmium's index (locations=True); we only count.
        self.nodes_seen += 1

    def way(self, w):
        highway = w.tags.get("highway")
        if highway not in ROUTABLE:
            return
        one_way = w.tags.get("oneway") in ("yes", "true", "1")

        coords = []
        for ref in w.nodes:
            if not ref.location.valid():
                # A node-ref the location index could not resolve — drop the way
                # rather than write a segment with a null endpoint.
                return
            coords.append((ref.ref, ref.location.lat, ref.location.lon))

        for (a_id, a_lat, a_lon), (b_id, b_lat, b_lon) in zip(coords, coords[1:]):
            self._edges.append({
                "src": a_id, "src_lat": a_lat, "src_lon": a_lon,
                "dst": b_id, "dst_lat": b_lat, "dst_lon": b_lon,
                "way_id": w.id, "highway": highway, "oneway": one_way,
            })
            if len(self._edges) >= self.batch_size:
                self._drain()
        self.ways_kept += 1

    def _drain(self):
        batch, self._edges = self._edges, []
        # Block the parser thread until the bounded queue accepts the batch.
        asyncio.run_coroutine_threadsafe(self.queue.put(batch), self.loop).result()

    def flush(self):
        if self._edges:
            self._drain()


WRITE_EDGES = """
UNWIND $edges AS e
MERGE (s:Node {id: e.src})
  ON CREATE SET s.location = point({srid: 4326, latitude: e.src_lat, longitude: e.src_lon})
MERGE (d:Node {id: e.dst})
  ON CREATE SET d.location = point({srid: 4326, latitude: e.dst_lat, longitude: e.dst_lon})
MERGE (s)-[r:ROUTE {way_id: e.way_id}]->(d)
  ON CREATE SET r.highway = e.highway, r.oneway = e.oneway
"""


async def _write_edges(tx, edges):
    await tx.run(WRITE_EDGES, edges=edges)


async def consume(queue: asyncio.Queue, driver):
    async with driver.session() as session:
        while True:
            batch = await queue.get()
            try:
                if batch is None:          # sentinel: parser finished
                    return
                await session.execute_write(_write_edges, batch)
            finally:
                queue.task_done()


def _run_parser(handler: RoutingEdgeHandler, pbf_path: str):
    # locations=True keeps a node-location index; flex_mem picks a store sized to
    # the extract. Use a disk-backed idx for continental files (see below).
    handler.apply_file(pbf_path, locations=True, idx="flex_mem")
    handler.flush()


async def main(pbf_path: str, uri: str, auth: tuple[str, str]):
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue(maxsize=8)   # bounded -> backpressure
    driver = AsyncGraphDatabase.driver(uri, auth=auth, max_connection_pool_size=10)
    handler = RoutingEdgeHandler(loop, queue)
    writer = asyncio.create_task(consume(queue, driver))
    try:
        await asyncio.to_thread(_run_parser, handler, pbf_path)
        await queue.put(None)             # signal end of stream
        await writer
        print(f"Parsed {handler.nodes_seen} nodes, kept {handler.ways_kept} routable ways.")
    finally:
        await driver.close()


if __name__ == "__main__":
    asyncio.run(
        main(
            "berlin-latest.osm.pbf",
            "neo4j+s://your-cluster.databases.neo4j.io",
            ("neo4j", "secure-password"),
        )
    )
```

## How It Works

Four mechanics do the load-bearing work, and each is a line you can point at:

- **Callback dispatch, not materialization.** `apply_file` walks the PBF fileblocks in their stored order — all nodes, then all ways, then relations — and invokes `node`, `way`, and `relation` for each primitive. Your handler only holds the current batch of edges, never the whole extract, so resident memory is flat in the file size.
- **The location index resolves refs for you.** With `locations=True`, PyOsmium populates its own node→coordinate store as the node fileblocks stream past, then back-fills `ref.location` on every `w.nodes[i]` by the time the `way` callback fires. That is the two-pass problem solved internally: you read coordinates off the way without ever storing a node dictionary yourself. The `idx` string selects the store — `flex_mem` for extracts that fit RAM, `sparse_file_array` or `dense_file_array` for larger-than-memory files.
- **Filter at the edge of the parser.** Checking `w.tags.get("highway")` against `ROUTABLE` before emitting anything discards footpaths, boundaries, and building outlines at the cheapest possible point, so the queue and the writer only ever see drivable geometry. Each routable way becomes a chain of one-hop segments between consecutive node-refs — the shape a routing graph actually traverses.
- **Bounded backpressure across the thread boundary.** The parser is synchronous C++, so it runs in `asyncio.to_thread`. `run_coroutine_threadsafe(queue.put(batch), loop).result()` schedules the put on the event loop and blocks the parser thread until it completes — which, on a full bounded queue, is exactly when the writer catches up. This is the same bounded-queue discipline detailed in [backpressure with bounded asyncio queues](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/async-batch-processing-for-graphs/backpressure-with-bounded-asyncio-queues/).

The emitted `:Node`/`:ROUTE` primitives are deliberately raw — one relationship per consecutive node pair, before any geometric cleanup. Snapping near-coincident endpoints and detecting true intersections is a separate stage, covered in [snapping coordinates and detecting intersections](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/snapping-coordinates-and-detecting-intersections/); the deduplication and idempotent upsert that turn this raw stream into a clean routable graph live in [building automated OSM-to-graph ETL pipelines](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/osm-data-ingestion-pipelines/building-automated-osm-to-graph-etl-pipelines/).

## Common Failure Patterns

**1. Unresolved node locations (invalid coordinates on way-refs).** If `apply_file` is called without `locations=True`, or the extract was clipped so a way references nodes outside its boundary, `ref.location.valid()` returns `False` and reading `.lat` yields an invalid coordinate. Guard it explicitly — the handler above drops the whole way rather than write a segment with a null endpoint. For clipped extracts, prefer one produced with `osmium extract --strategy=complete_ways` so boundary ways keep all their nodes:

```python
for ref in w.nodes:
    if not ref.location.valid():
        return  # skip: a segment with an unresolved endpoint corrupts routing
```

**2. Keeping every node in RAM.** The anti-pattern is a `node` callback that appends `{n.id: (lat, lon)}` to a dict "so the way callback can look them up." That rebuilds, in Python, the index PyOsmium already maintains in C++ far more compactly — and it is what OOM-kills the country-scale run. Let the library own the location store; keep your handler stateless except for the current batch.

**3. Awaiting inside the callback.** `node`/`way`/`relation` are invoked from the synchronous parser thread, so `await driver.session()` inside them is a `SyntaxError`, and calling `asyncio.run` per callback spawns a loop per primitive. The batches-plus-bounded-queue bridge is the correct decoupling: the callback only enqueues, and the single async consumer owns all I/O.

**4. Relations and turn restrictions dropped silently.** This stage intentionally defers `relation` handling — a `restriction` relation (a `no_left_turn`, say) references a `from` way, a `via` node, and a `to` way, which cannot be enforced on a plain node-based graph. Emitting edges now and modeling restrictions later is correct sequencing; just record that the `relation` callback is a no-op so nobody assumes turn penalties are already applied. The modeling technique is [turn restrictions as an edge-based graph](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/turn-restriction-and-time-dependent-routing/modeling-turn-restrictions-as-an-edge-based-graph/).

## Performance Notes

Throughput is bounded by the slower of two stages: the parser's sequential scan and the writer's transactional commits. Because the location index is populated during the node pass, the parser cost is dominated by that pass — roughly linear in primitive count. For a total of $N$ primitives emitting $E$ routable edges written in batches of size $B$, the writer issues

$$T = \left\lceil \frac{E}{B} \right\rceil \text{ transactions}, \qquad M_\text{resident} \approx M_\text{idx} + q \cdot B \cdot b_\text{row}$$

where $M_\text{idx}$ is the node-location store, $q$ is the queue's `maxsize`, and $b_\text{row}$ the bytes per edge dict. The second term is the only part that grows with concurrency, and it is capped by the bounded queue — which is the whole point of sizing `maxsize` small. Choose the `idx` store by extract size: `flex_mem` holds the location index in RAM (fine up to large metropolitan extracts), while `sparse_file_array,locations.idx` or `dense_file_array,locations.idx` spills it to disk so $M_\text{idx}$ stops driving the resident set on continental files. Batch size trades transaction overhead against per-transaction memory; 5,000–25,000 edges per `UNWIND` is the usual sweet spot, the same range used across the [OSM data ingestion pipelines](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/osm-data-ingestion-pipelines/).

## Related

- [Building automated OSM-to-graph ETL pipelines](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/osm-data-ingestion-pipelines/building-automated-osm-to-graph-etl-pipelines/) — deduplicating and idempotently upserting the raw stream this parser emits.
- [Backpressure with bounded asyncio queues](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/async-batch-processing-for-graphs/backpressure-with-bounded-asyncio-queues/) — the queue discipline that keeps the parser from outrunning the writer.
- [Snapping coordinates and detecting intersections](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/snapping-coordinates-and-detecting-intersections/) — cleaning the raw node/edge geometry into routable topology.
- [Modeling turn restrictions as an edge-based graph](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/turn-restriction-and-time-dependent-routing/modeling-turn-restrictions-as-an-edge-based-graph/) — handling the relations this stage defers.

This guide is part of the [OSM Data Ingestion Pipelines](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/osm-data-ingestion-pipelines/) collection, within the broader [Spatial Graph Construction & OSM Ingestion](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/) guide.
