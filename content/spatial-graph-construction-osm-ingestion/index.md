---
pageTitle: Graph Construction & OSM Ingestion
title: Spatial Graph Construction & OSM Ingestion
description: Build production routing graphs from OpenStreetMap with deterministic topology, async Neo4j ingestion, spatial indexing, and hardened transaction boundaries.
slug: spatial-graph-construction-osm-ingestion
type: overview
breadcrumb: Graph Construction & OSM Ingestion
datePublished: 2025-11-18
dateModified: 2026-06-26
---
# Spatial Graph Construction & OSM Ingestion

When an OpenStreetMap extract is loaded naively — one node per coordinate, one transaction per way — a metropolitan region will fragment the heap, bloat the transaction log, and leave the routing graph riddled with phantom edges and disconnected subgraphs. Backend and data engineers building logistics, mobility, or geospatial-analytics systems need an ingestion architecture that produces a deterministic, directed, weighted edge network on the first pass and keeps it correct as the map changes. This guide covers the full construction path: stream deserialization, topology resolution, schema design, the async Neo4j integration layer, spatial indexing and query planning, traversal-readiness, and the failure modes that decide whether the pipeline survives contact with production.

The pipeline decomposes into three resource-bounded stages — stream deserialization, topology resolution, and graph materialization — each running under explicit concurrency and memory limits so that a single large extract never exhausts the driver connection pool or saturates the write-ahead log.

<svg viewBox="0 0 940 372" role="img" aria-labelledby="pl-title pl-desc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,system-ui,sans-serif)">
  <title id="pl-title">Three-stage OSM-to-graph ingestion pipeline</title>
  <desc id="pl-desc">A left-to-right pipeline of three resource-bounded stages. Stage one, stream deserialization, runs outside any transaction and is CPU and I/O bound: PBF blocks flow into a tag filter with WGS84 projection. Stage two, topology resolution, is pure in-memory work over a bounded geographic partition: coordinate snapping at 0.3 to 0.5 metre tolerance feeds directional edge construction from oneway tags and turn restrictions. Stage three, graph materialization, is the only stage that touches the database, in fixed-size batches: UNWIND batches of up to 50,000 nodes and 200,000 edges write into the routing graph. Arrows connect the stages in order.</desc>
  <style>
    .pl-panel{fill:var(--surface-2,#f4f4f5);stroke:var(--line-strong,#9ca3af);stroke-width:1.5;}
    .pl-num{font:700 13px var(--font-mono,ui-monospace,monospace);fill:var(--viz-panel,#f4f4f5);}
    .pl-badge{fill:var(--accent,#0e7c86);}
    .pl-hd{font:700 15px var(--font-sans,system-ui,sans-serif);fill:var(--ink,#1f2937);}
    .pl-sub{font:italic 11.5px var(--font-sans,system-ui,sans-serif);fill:var(--ink-mute,#6b7280);}
    .pl-box{fill:var(--viz-panel,#f4f4f5);stroke:var(--accent,#0e7c86);stroke-width:2;}
    .pl-bt{font:600 13px var(--font-sans,system-ui,sans-serif);fill:var(--ink,#1f2937);}
    .pl-bs{font:11.5px var(--font-mono,ui-monospace,monospace);fill:var(--ink-mute,#6b7280);}
    .pl-db{fill:var(--viz-panel,#f4f4f5);stroke:var(--accent,#0e7c86);stroke-width:2.5;}
    .pl-dbt{font:700 13px var(--font-sans,system-ui,sans-serif);fill:var(--accent,#0e7c86);}
    .pl-flow{fill:none;stroke:var(--accent,#0e7c86);stroke-width:2.5;}
    .pl-link{fill:none;stroke:currentColor;stroke-width:2.5;opacity:.55;}
  </style>
  <defs>
    <marker id="pl-arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="var(--accent,#0e7c86)"/>
    </marker>
    <marker id="pl-larr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor" opacity=".55"/>
    </marker>
  </defs>
  <!-- ===== STAGE 1 ===== -->
  <rect class="viz-backdrop" x="0" y="0" width="940" height="372" fill="var(--viz-bg,#ffffff)"/>
  <rect class="pl-panel" x="16" y="44" width="284" height="300" rx="12"/>
  <circle class="pl-badge" cx="42" cy="70" r="13"/>
  <text class="pl-num" x="42" y="75" text-anchor="middle">1</text>
  <text class="pl-hd" x="64" y="68">Stream deserialization</text>
  <text class="pl-sub" x="64" y="85">outside any transaction · CPU + I/O bound</text>
  <rect class="pl-box" x="44" y="118" width="228" height="62" rx="9"/>
  <text class="pl-bt" x="158" y="145" text-anchor="middle">PBF blocks</text>
  <text class="pl-bs" x="158" y="164" text-anchor="middle">streamed, not buffered whole</text>
  <line class="pl-flow" x1="158" y1="182" x2="158" y2="222" marker-end="url(#pl-arr)"/>
  <rect class="pl-box" x="44" y="224" width="228" height="62" rx="9"/>
  <text class="pl-bt" x="158" y="251" text-anchor="middle">Tag filter + WGS84</text>
  <text class="pl-bs" x="158" y="270" text-anchor="middle">pre-filter ways, project points</text>
  <!-- ===== STAGE 2 ===== -->
  <rect class="pl-panel" x="328" y="44" width="284" height="300" rx="12"/>
  <circle class="pl-badge" cx="354" cy="70" r="13"/>
  <text class="pl-num" x="354" y="75" text-anchor="middle">2</text>
  <text class="pl-hd" x="376" y="68">Topology resolution</text>
  <text class="pl-sub" x="376" y="85">in-memory · bounded partition</text>
  <rect class="pl-box" x="356" y="118" width="228" height="62" rx="9"/>
  <text class="pl-bt" x="470" y="145" text-anchor="middle">Coordinate snapping</text>
  <text class="pl-bs" x="470" y="164" text-anchor="middle">0.3–0.5 m tolerance</text>
  <line class="pl-flow" x1="470" y1="182" x2="470" y2="222" marker-end="url(#pl-arr)"/>
  <rect class="pl-box" x="356" y="224" width="228" height="62" rx="9"/>
  <text class="pl-bt" x="470" y="251" text-anchor="middle">Directional edges</text>
  <text class="pl-bs" x="470" y="270" text-anchor="middle">oneway + turn restrictions</text>
  <!-- ===== STAGE 3 ===== -->
  <rect class="pl-panel" x="640" y="44" width="284" height="300" rx="12"/>
  <circle class="pl-badge" cx="666" cy="70" r="13"/>
  <text class="pl-num" x="666" y="75" text-anchor="middle">3</text>
  <text class="pl-hd" x="688" y="68">Graph materialization</text>
  <text class="pl-sub" x="688" y="85">only DB writer · fixed batches</text>
  <rect class="pl-box" x="668" y="118" width="228" height="62" rx="9"/>
  <text class="pl-bt" x="782" y="145" text-anchor="middle">UNWIND batches</text>
  <text class="pl-bs" x="782" y="164" text-anchor="middle">≤50k nodes / ≤200k edges</text>
  <line class="pl-flow" x1="782" y1="182" x2="782" y2="222" marker-end="url(#pl-arr)"/>
  <ellipse class="pl-db" cx="782" cy="255" rx="100" ry="30"/>
  <text class="pl-dbt" x="782" y="260" text-anchor="middle">Routing graph</text>
  <!-- inter-stage links -->
  <line class="pl-link" x1="272" y1="255" x2="356" y2="255" marker-end="url(#pl-larr)"/>
  <line class="pl-link" x1="584" y1="255" x2="668" y2="255" marker-end="url(#pl-larr)"/>
</svg>

## Concept & Architecture

A road network is a graph before it is anything else: intersections are nodes, the segments between them are edges, and the cost of traversal lives on the edge. Modelling this in a relational store forces every routing query into recursive self-joins against an adjacency table, where each hop is a fresh index probe and the planner has no notion of locality. A native graph store traverses by pointer-following adjacency, so the cost of expanding a path is proportional to the number of edges visited rather than the size of the table — which is exactly the access pattern shortest-path and nearest-neighbour queries need. The trade-off is that the graph must be *constructed* correctly up front; there is no query-time join to paper over a missing edge.

The storage model rests on two spatial primitives. Nodes carry a `location` property typed as a WGS84 `point` (`point({latitude, longitude})`), which Neo4j stores in a dedicated point index and serves to bounding-box and distance predicates without scanning. Edges carry the traversal cost — distance, traversal time, and directional flags — as scalar properties so the cost function is a property read rather than a runtime computation. The mechanics of turning raw geometry into these primitives are covered in depth in [node and edge spatial mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/), and the index structures that make point predicates cheap are the subject of [spatial indexing strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/).

Architecturally, the three stages are deliberately decoupled. Stream deserialization is CPU- and I/O-bound and runs outside any transaction. Topology resolution is pure in-memory computation over a bounded geographic partition. Only graph materialization touches the database, and it does so in fixed-size batches. Keeping the database off the critical path until the last stage means a parsing or snapping bug never leaves a half-written graph, and it lets each stage scale on its own resource axis.

## Schema Design

The node/edge property model is intentionally narrow: a wide core schema is what causes write amplification at metropolitan scale. The routing graph carries only what the cost function and the indexes need; everything else (demographics, curb access, charging metadata) attaches as separate labels or lives on adjacent nodes so it never inflates a traversal frontier.

```cypher
// Uniqueness + existence constraints (these implicitly create the backing index)
CREATE CONSTRAINT node_id_unique IF NOT EXISTS
FOR (n:Node) REQUIRE n.id IS UNIQUE;

CREATE CONSTRAINT node_tenant_present IF NOT EXISTS
FOR (n:Node) REQUIRE n.tenant_id IS NOT NULL;

// Point index drives bbox + distance predicates during construction and routing
CREATE POINT INDEX node_location IF NOT EXISTS
FOR (n:Node) ON (n.location);

// Range index supports tenant-scoped scans and partition replays
CREATE INDEX node_tenant IF NOT EXISTS
FOR (n:Node) ON (n.tenant_id);
```

Each `:Node` holds `id` (the OSM node id, stable across imports), `location` (WGS84 point), `osm_type`, and `tenant_id`. Each `CONNECTS_TO` relationship is directional and holds `distance_m`, `traversal_s` (the normalised cost), `max_speed_kph`, and `surface`. Relationship *direction* is load-bearing: an OSM way tagged `oneway=yes` materialises as a single `(a)-[:CONNECTS_TO]->(b)`, a default bidirectional way materialises as two opposing relationships, and `oneway=-1` reverses the pair. Storing direction explicitly — rather than as a boolean the query must interpret — lets the traversal engine prune at expansion time.

Tenant isolation is enforced by carrying `tenant_id` on every node and partitioning indexes accordingly, so one customer's road network can never bleed into another's routing result. The broader access-control model — label scoping, per-tenant index partitions, and query-time guards — is the remit of [spatial security boundaries](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-security-boundaries/), and should be wired in before the first production ingest rather than retrofitted.

## Core Python Integration

Ingestion uses the official `neo4j` async driver (Python 3.10+). The connection pool is sized once, sessions are scoped to a single partition's batch, and every write goes through `UNWIND` so a batch is one round-trip rather than thousands. The example below is self-contained and runnable: it computes Haversine distances for edge weights, materialises nodes and directional edges in capped batches, and drives the whole thing from an `asyncio` entry point.

```python
import asyncio
import math
from typing import Dict, List
from neo4j import AsyncGraphDatabase
from neo4j.exceptions import Neo4jError, ServiceUnavailable

EARTH_RADIUS_M = 6_371_000.0

def haversine_distance(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance in metres, used to weight edges during materialization."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(math.sqrt(a))


class GraphIngestor:
    """Async OSM-to-graph materializer with bounded pool and capped batches."""

    NODE_CAP = 50_000
    EDGE_CAP = 200_000

    def __init__(self, uri: str, auth: tuple, database: str = "spatial_routing",
                 max_pool: int = 16):
        self._driver = AsyncGraphDatabase.driver(
            uri,
            auth=auth,
            max_connection_pool_size=max_pool,
            connection_acquisition_timeout=10.0,
            max_transaction_retry_time=30.0,
        )
        self._database = database

    async def close(self) -> None:
        await self._driver.close()

    async def materialize(self, batch: List[Dict]) -> int:
        """Commit one partition batch: MERGE nodes, then directional edges."""
        if len(batch) > self.NODE_CAP:
            raise ValueError(f"batch exceeds node cap ({len(batch)} > {self.NODE_CAP})")
        query = """
        UNWIND $batch AS item
        MERGE (n:Node {id: item.node_id})
          SET n.location  = point({latitude: item.lat, longitude: item.lon}),
              n.osm_type   = item.type,
              n.tenant_id  = item.tenant_id
        WITH n, item
        WHERE item.source_id IS NOT NULL
        MATCH (m:Node {id: item.source_id})
        MERGE (m)-[r:CONNECTS_TO]->(n)
          SET r.distance_m    = item.dist_m,
              r.traversal_s    = item.traversal_s,
              r.max_speed_kph  = item.max_speed_kph,
              r.surface        = item.surface
        RETURN count(r) AS edges
        """
        async with self._driver.session(database=self._database) as session:
            try:
                result = await session.run(query, batch=batch)
                record = await result.single()
                await result.consume()
                return record["edges"] if record else 0
            except (Neo4jError, ServiceUnavailable) as exc:
                raise RuntimeError(f"batch commit failed: {exc}") from exc


def build_edge(src: Dict, dst: Dict, max_speed_kph: float, surface: str,
               tenant_id: str) -> Dict:
    """Derive an edge record with distance and normalised traversal time."""
    dist_m = haversine_distance(src["lat"], src["lon"], dst["lat"], dst["lon"])
    speed_mps = max(max_speed_kph, 5.0) / 3.6
    return {
        "node_id": dst["id"], "lat": dst["lat"], "lon": dst["lon"],
        "type": "junction", "tenant_id": tenant_id,
        "source_id": src["id"], "dist_m": dist_m,
        "traversal_s": dist_m / speed_mps,
        "max_speed_kph": max_speed_kph, "surface": surface,
    }


async def main() -> None:
    ingestor = GraphIngestor("bolt://localhost:7687", ("neo4j", "password"))
    try:
        a = {"id": 1, "lat": 52.5200, "lon": 13.4050}
        b = {"id": 2, "lat": 52.5210, "lon": 13.4065}
        batch = [build_edge(a, b, max_speed_kph=50.0, surface="asphalt",
                            tenant_id="acme")]
        edges = await ingestor.materialize(batch)
        print(f"committed {edges} edge(s)")
    finally:
        await ingestor.close()


if __name__ == "__main__":
    asyncio.run(main())
```

The pool is bounded (`max_connection_pool_size=16`) and acquisition is timed out (`connection_acquisition_timeout=10.0`) so a backed-up database surfaces as a fast, retryable failure rather than a stalled event loop. Sessions are scoped with `async with` to a single batch, which keeps transaction lifetimes short and lock windows narrow. The production-grade streaming front end — concurrent PBF block parsing, tag pre-filtering, and back-pressured batch hand-off — is detailed in [OSM data ingestion pipelines](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/osm-data-ingestion-pipelines/), and the concurrency control that fans these batches across worker pools is covered in [async batch processing for graphs](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/async-batch-processing-for-graphs/).

## Indexing & Query Planning

A point index is the difference between a construction pass that finishes in minutes and one that re-scans the node set for every `MERGE`. During ingestion the `MERGE (n:Node {id: ...})` on a unique-constrained `id` is an exact index seek, and the `location` point index lets the snapping and validation queries answer bounding-box questions without a label scan. The right index family per access pattern — point index for distance and bbox, range index for tenant scoping, composite where both apply — is analysed in [spatial indexing strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/).

The cost model the planner applies to a distance predicate is, at its core, the Haversine great-circle distance between two points on a sphere of radius $R$:

$$d = 2R \cdot \arcsin\!\left(\sqrt{\sin^{2}\!\frac{\varphi_2-\varphi_1}{2} + \cos\varphi_1\cos\varphi_2\,\sin^{2}\!\frac{\lambda_2-\lambda_1}{2}}\right)$$

Evaluating this per candidate is cheap; evaluating it per *node in the graph* is not. The planner avoids the latter through predicate push-down: a `point.distance(...) < r` filter is rewritten into a bounding-box seek against the point index, which returns a small candidate set, and only those candidates pay for the exact distance computation. When a query mixes Cartesian and WGS84 points, or compares an indexed property against a computed value, that push-down is lost and the planner falls back to a full scan. Validating the plan with `PROFILE` and shaping it with index hints is the subject of [graph query planner optimization](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/), and the query-side patterns that exploit the index live under [Cypher spatial queries & pathfinding patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/).

The three-panel diagram below traces a single `point.distance(p, q) < r` predicate as the planner narrows it: the full node set is never scanned, the point index returns a small bounding-box candidate set, and only those candidates pay for the exact great-circle test.

<svg viewBox="0 0 900 360" role="img" aria-labelledby="pp-title pp-desc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,system-ui,sans-serif)">
  <title id="pp-title">Bounding-box predicate push-down for a distance filter</title>
  <desc id="pp-desc">Three panels left to right showing how a distance predicate is evaluated. The left panel, the full node set, shows many scattered nodes that the planner never scans. The middle panel shows the point index returning only the nodes inside a dashed bounding box around the query point — a small candidate set. The right panel applies the exact distance test: a circle of radius r centred on the query point, where only candidates inside the circle survive as results, shown highlighted, while bbox candidates outside the circle are discarded. Funnel arrows between panels show the set shrinking from the whole graph to a few candidates to the final survivors.</desc>
  <style>
    .pp-panel{fill:var(--surface-2,#f4f4f5);stroke:var(--line-strong,#9ca3af);stroke-width:1.5;}
    .pp-hd{font:700 14px var(--font-sans,system-ui,sans-serif);fill:var(--ink,#1f2937);}
    .pp-cap{font:11.5px var(--font-mono,ui-monospace,monospace);fill:var(--ink-mute,#6b7280);}
    .pp-dot{fill:var(--ink-mute,#6b7280);opacity:.45;}
    .pp-cand{fill:var(--accent,#0e7c86);opacity:.55;}
    .pp-win{fill:var(--accent,#0e7c86);}
    .pp-q{fill:var(--accent-coral,#ff6b6b);}
    .pp-qlbl{font:600 11px var(--font-mono,ui-monospace,monospace);fill:var(--accent-coral,#ff6b6b);}
    .pp-bbox{fill:none;stroke:var(--accent,#0e7c86);stroke-width:1.8;stroke-dasharray:6 4;}
    .pp-circ{fill:none;stroke:var(--accent-coral,#ff6b6b);stroke-width:1.8;}
    .pp-flow{fill:none;stroke:currentColor;stroke-width:2.5;opacity:.55;}
    .pp-flbl{font:italic 11.5px var(--font-sans,system-ui,sans-serif);fill:var(--ink-mute,#6b7280);}
  </style>
  <defs>
    <marker id="pp-arr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor" opacity=".55"/>
    </marker>
  </defs>
  <!-- ===== PANEL 1: full node set ===== -->
  <rect class="viz-backdrop" x="0" y="0" width="900" height="360" fill="var(--viz-bg,#ffffff)"/>
  <text class="pp-hd" x="135" y="30" text-anchor="middle">Full node set</text>
  <rect class="pp-panel" x="20" y="44" width="230" height="250" rx="10"/>
  <circle class="pp-dot" cx="52" cy="78" r="4"/>
  <circle class="pp-dot" cx="96" cy="64" r="4"/>
  <circle class="pp-dot" cx="150" cy="80" r="4"/>
  <circle class="pp-dot" cx="208" cy="70" r="4"/>
  <circle class="pp-dot" cx="70" cy="118" r="4"/>
  <circle class="pp-dot" cx="124" cy="126" r="4"/>
  <circle class="pp-dot" cx="184" cy="112" r="4"/>
  <circle class="pp-dot" cx="226" cy="140" r="4"/>
  <circle class="pp-dot" cx="44" cy="166" r="4"/>
  <circle class="pp-dot" cx="100" cy="174" r="4"/>
  <circle class="pp-dot" cx="158" cy="162" r="4"/>
  <circle class="pp-dot" cx="200" cy="182" r="4"/>
  <circle class="pp-dot" cx="62" cy="216" r="4"/>
  <circle class="pp-dot" cx="118" cy="224" r="4"/>
  <circle class="pp-dot" cx="170" cy="212" r="4"/>
  <circle class="pp-dot" cx="222" cy="232" r="4"/>
  <circle class="pp-dot" cx="86" cy="262" r="4"/>
  <circle class="pp-dot" cx="148" cy="268" r="4"/>
  <circle class="pp-dot" cx="204" cy="258" r="4"/>
  <text class="pp-cap" x="135" y="284" text-anchor="middle">never scanned</text>
  <!-- ===== PANEL 2: bbox seek ===== -->
  <text class="pp-hd" x="450" y="30" text-anchor="middle">Point-index bbox seek</text>
  <rect class="pp-panel" x="335" y="44" width="230" height="250" rx="10"/>
  <!-- non-candidate dots -->
  <circle class="pp-dot" cx="367" cy="78" r="4"/>
  <circle class="pp-dot" cx="411" cy="64" r="4"/>
  <circle class="pp-dot" cx="523" cy="70" r="4"/>
  <circle class="pp-dot" cx="359" cy="166" r="4"/>
  <circle class="pp-dot" cx="377" cy="216" r="4"/>
  <circle class="pp-dot" cx="401" cy="262" r="4"/>
  <circle class="pp-dot" cx="463" cy="268" r="4"/>
  <circle class="pp-dot" cx="519" cy="258" r="4"/>
  <circle class="pp-dot" cx="541" cy="140" r="4"/>
  <circle class="pp-dot" cx="537" cy="232" r="4"/>
  <!-- bbox + candidates inside -->
  <rect class="pp-bbox" x="408" y="120" width="104" height="96"/>
  <circle class="pp-cand" cx="439" cy="142" r="4.5"/>
  <circle class="pp-cand" cx="485" cy="134" r="4.5"/>
  <circle class="pp-cand" cx="423" cy="184" r="4.5"/>
  <circle class="pp-cand" cx="473" cy="192" r="4.5"/>
  <circle class="pp-cand" cx="499" cy="174" r="4.5"/>
  <circle class="pp-q" cx="460" cy="168" r="5"/>
  <text class="pp-qlbl" x="460" y="114" text-anchor="middle">q</text>
  <text class="pp-cap" x="450" y="284" text-anchor="middle">bbox candidates</text>
  <!-- ===== PANEL 3: exact distance ===== -->
  <text class="pp-hd" x="765" y="30" text-anchor="middle">Exact distance &lt; r</text>
  <rect class="pp-panel" x="650" y="44" width="230" height="250" rx="10"/>
  <circle class="pp-circ" cx="775" cy="168" r="58"/>
  <line class="pp-circ" x1="775" y1="168" x2="833" y2="168"/>
  <text class="pp-qlbl" x="804" y="160" text-anchor="middle">r</text>
  <!-- candidate that falls outside the circle (discarded) -->
  <circle class="pp-cand" cx="754" cy="134" r="4.5"/>
  <circle class="pp-cand" cx="800" cy="126" r="4.5"/>
  <!-- survivors inside the circle -->
  <circle class="pp-win" cx="738" cy="184" r="5"/>
  <circle class="pp-win" cx="788" cy="192" r="5"/>
  <circle class="pp-win" cx="814" cy="174" r="5"/>
  <circle class="pp-q" cx="775" cy="168" r="5"/>
  <text class="pp-qlbl" x="775" y="116" text-anchor="middle">q</text>
  <text class="pp-cap" x="765" y="284" text-anchor="middle">exact survivors</text>
  <!-- funnel arrows -->
  <line class="pp-flow" x1="254" y1="169" x2="331" y2="169" marker-end="url(#pp-arr)"/>
  <text class="pp-flbl" x="292" y="158" text-anchor="middle">seek</text>
  <line class="pp-flow" x1="569" y1="169" x2="646" y2="169" marker-end="url(#pp-arr)"/>
  <text class="pp-flbl" x="607" y="158" text-anchor="middle">filter</text>
</svg>

## Routing & Traversal Patterns

Construction exists to serve traversal, so the edge schema must match the algorithm family the workload will run. Three families dominate, and the graph is built to suit whichever is dominant.

- **Dijkstra** expands the cheapest frontier first and needs only a non-negative `traversal_s` weight. It is the default for one-to-many queries (isochrones, service-area coverage) where there is no single target to aim at. Build cost: nothing beyond clean, non-negative edge weights.
- **A\*** prunes Dijkstra's frontier with an admissible heuristic — typically straight-line Haversine distance to the target divided by the network's maximum speed, which provably never overestimates remaining cost. It wins on point-to-point queries over large graphs. Build cost: the heuristic needs node `location` populated and trustworthy, which makes coordinate accuracy during snapping a routing concern, not just a cosmetic one.
- **Contraction hierarchies** precompute shortcut edges so query-time expansion skips through unimportant nodes. They deliver the lowest query latency on near-static continental graphs, at the price of a heavy preprocessing pass and shortcut storage. Build cost: highest — and the precompute must be re-run when topology changes materially.

The decision is a function of query shape and update frequency: point-to-point over a stable map favours contraction hierarchies; mixed one-to-many over a frequently edited map favours Dijkstra or A\*. Concrete weighting and expansion code — including [k-nearest-neighbour routing](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/k-nearest-neighbor-routing/) and [distance-filter query patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/) — lives in the query guides, but the requirement to keep `traversal_s` non-negative and `location` accurate is owned here, at construction time.

## Performance & Scale

Memory pressure during construction scales linearly with coordinate density, and the only durable defence is spatial partitioning. Geohash-prefix sharding or a quadtree filter isolates each partition to a fixed geographic extent, so worker pools ingest disjoint regions in parallel without cross-node lock contention, and each worker's working set stays inside a predictable RAM budget. Snapping then runs over one partition at a time:

```python
def snap_junctions(coords: List[tuple], tolerance_m: float = 0.5) -> List[tuple]:
    """Merge coordinates within tolerance using grid-based hashing (per partition)."""
    grid: Dict[tuple, tuple] = {}
    snapped: List[tuple] = []
    for lat, lon in coords:
        delta = tolerance_m / 111_320.0          # approx metres-per-degree at equator
        key = (round(lat / delta), round(lon / delta))
        if key not in grid:
            grid[key] = (lat, lon)
            snapped.append((lat, lon))
    return snapped
```

The recurring scale trade-offs:

- **Streaming vs. in-memory:** iterating PBF blocks keeps the RAM footprint flat but re-parses tags repeatedly; pre-filtering tags at the parser level recovers most of the CPU cost while preserving the memory win.
- **Snapping tolerance vs. accuracy:** aggressive snapping (>1.0 m) collapses distinct parallel carriageways into one edge; conservative snapping (<0.2 m) leaves micro-gaps that break A\* and contraction-hierarchy expansion. The 0.3–0.5 m band is the production sweet spot.
- **Batch size vs. write-ahead log:** larger batches cut round-trip latency but risk WAL saturation. The 50k-node / 200k-edge caps align with default Neo4j transaction-log rotation thresholds and bound rollback cost.
- **Write amplification:** every extra core property multiplies per-edge write volume. Keep the routing graph narrow and attach optional context separately — the model used by [POI enrichment workflows](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/poi-enrichment-workflows/), which hangs delivery zones and curb metadata off adjacent nodes without bloating the traversal frontier.

Generator-based batching and memory-mapped buffers keep GC pauses short: by never materialising a whole regional extract as live objects, the collector's young generation stays small and pauses stay sub-millisecond even mid-ingest.

## Incremental Re-import & Change Detection

The first import is the easy one. What decides whether a construction pipeline survives its second year is what happens on the fiftieth import, when the extract has drifted, half the ways have new tags, a few hundred have been deleted outright, and the graph underneath is serving live routing traffic that cannot be paused.

Full reload is the tempting answer and it is almost always the wrong one. Dropping and rebuilding a continental graph means a window where routing has no data, invalidates every GDS projection, discards any attribute written by a downstream enrichment job, and re-pays the entire index build. Worse, it destroys node identity: application state that referenced a junction by its internal id now points at nothing. The discipline that avoids all of this is the same one that makes retries safe — build on stable, source-derived identifiers and make every write idempotent, so an import is a *convergence* toward the extract rather than a replacement of it.

Convergence needs three pieces. **A content hash per element** — a digest over the geometry and the routing-relevant tags — lets the transform skip elements whose hash matches what is already stored, which on a typical weekly extract leaves well under five per cent of ways to write. **A version or import stamp on every node and edge** records which run last touched it, and is what makes deletion detectable at all: an element that exists in the graph, belongs to the region just imported, and was not stamped by the current run is either deleted upstream or filtered out by a changed transform rule. **A region key** bounds that sweep, because "not stamped by this run" is only meaningful over the area the run actually covered — apply it globally after importing one city and the query proposes deleting the rest of the world.

Deletion is where incremental pipelines most often go wrong, and the failure is asymmetric: a missed deletion leaves a road that no longer exists, which routes traffic down it; an over-eager deletion removes a road that does exist, which is worse, because the router silently detours around a corridor and nothing in the result says why. Treat the delete sweep as a proposal rather than an action. Count what it would remove, compare that against the run's own change statistics, and refuse to proceed when the proportion exceeds a threshold — a transform bug that drops a tag class shows up here as a proposal to delete forty per cent of the region, which is a signal, not a workload. Soft-delete first with a `retired_at` stamp so the edge stops routing but the record survives for a retention window, and let a separate compaction job do the physical removal once no rollback is plausible.

The tag drift underneath all of this deserves its own guard. OSM tagging conventions change, regional mapping communities adopt different idioms, and a transform written against one snapshot quietly starts producing different output against the next — not by failing, but by classifying a road as a different highway class and giving it a different speed. Assert on the distribution, not on individual rows: if the share of edges in each speed class moves by more than a few points between consecutive imports of the same region, the transform and the source have diverged, and the routes will change even though every import reported success. Keeping those tags aligned with the live world after the first load is the job of [Attribute Synchronization Techniques](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/attribute-synchronization-techniques/), which handles the continuous stream between imports the same way this section handles the periodic sweep.

## Failure Modes & Hardening

**Topology corruption** is the most common silent failure: a snapping tolerance that is too loose welds separate roads together, and one too tight leaves disconnected subgraphs that routing reports as "no path". Guard it by asserting, post-batch, that every materialised node has a non-zero degree and that the largest connected component covers the expected share of the partition — Haversine validation of each edge length against its claimed `distance_m` catches the rest.

**Index fragmentation** accrues under heavy concurrent writes and degrades point-seek latency until background compaction completes. Throttle write concurrency to the index partition count, and warm the point index after a bulk load before serving routing traffic so the first production queries do not pay the cold-cache penalty.

**Connection pool exhaustion** appears as `connection_acquisition_timeout` errors when batch fan-out outpaces the pool. Treat the bounded pool as a feature: pair it with a semaphore that caps in-flight batches at the pool size, exponential backoff on retryable errors, and a circuit breaker that sheds load during database maintenance windows.

**Duplicate topology from a re-run that changed its identifier scheme** is the failure that survives every other guard. `MERGE` is idempotent only with respect to the key it merges on, so a run that derives node ids from rounded coordinates and a later run that derives them from the source element id will not collide — they will coexist, doubling the junction count and leaving two disconnected copies of the same road network in one graph. Routing still returns paths, because each copy is internally consistent; what breaks is that a start point resolved against one copy can never reach a destination resolved against the other, and the endpoint reports "no route" for a journey that is obviously possible. Pin the identifier derivation in a schema-version constant, store it on the graph, and refuse to import when the constant on disk disagrees with the one in the code.

**Recovery playbook:** commit at partition boundaries, never across them — a cross-partition transaction turns one bad batch into a distributed rollback. Log each committed partition to an immutable checkpoint ledger so a failed run resumes from the last good partition rather than restarting. During schema migrations or regional outages, replay from those checkpoints; because materialization is idempotent (`MERGE`, not `CREATE`), replaying a partition is safe. Keeping the graph current as the underlying map changes — applying road closures and seasonal restrictions without a full rebuild — is the job of [attribute synchronization techniques](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/attribute-synchronization-techniques/), which depends on these same idempotent, checkpointed boundaries.

## Operational Checklist

- [ ] Schema constraints and point/range indexes created **before** the first ingest (`node_id_unique`, `node_location`, `node_tenant`).
- [ ] Snapping tolerance pinned in the 0.3–0.5 m band and recorded with the run config.
- [ ] Spatial partitioning (geohash/quadtree) bounds every worker's RAM budget; partitions are disjoint.
- [ ] Batch caps enforced (≤50k nodes / ≤200k edges) and aligned to WAL rotation.
- [ ] Connection pool sized to index-partition concurrency; semaphore caps in-flight batches to pool size.
- [ ] Post-batch integrity assertions run: zero orphan nodes, expected largest-component coverage, edge length ≈ `distance_m`.
- [ ] Point index warmed after bulk load before routing traffic is served.
- [ ] Per-partition checkpoints written to the immutable ledger; resume-from-checkpoint tested.
- [ ] Monitoring hooks export pool saturation, batch latency, WAL size, and GC pause time.
- [ ] Tenant isolation verified — no routing result crosses `tenant_id` boundaries.

Spatial graph construction from OSM is not a one-time ETL job; it is a continuous topology-reconciliation process. With deterministic snapping, bounded concurrency, routing-ready edge weighting, and checkpointed partition boundaries, a team can hold sub-millisecond query latency while a metropolitan network grows into millions of nodes and edges.

## Related

- [OSM Data Ingestion Pipelines](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/osm-data-ingestion-pipelines/) — the streaming PBF parser and back-pressured batch hand-off.
- [Async Batch Processing for Graphs](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/async-batch-processing-for-graphs/) — semaphore-based concurrency and chunked commits.
- [Attribute Synchronization Techniques](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/attribute-synchronization-techniques/) — propagating closures and restrictions without a rebuild.
- [POI Enrichment Workflows](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/poi-enrichment-workflows/) — attaching context to adjacent nodes without bloating routing topology.
- [Spatial Indexing Strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) — choosing point, range, and composite indexes per access pattern.
- [Cypher Spatial Queries & Pathfinding Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/) — the query-side patterns this graph is built to serve.
- [Network Routing Algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/) — the shortest-path algorithms that run on top of the graph you ingest here.

This guide is part of [Python for Spatial Graph Databases & Network Routing](https://www.spatialgraphdatabases.org/).
