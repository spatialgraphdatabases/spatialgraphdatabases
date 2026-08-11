---
pageTitle: Finding Dense Clusters with GDS
title: Finding Dense Delivery Clusters with Neo4j GDS
description: Build a mutual-KNN proximity graph and run community detection over it to find where deliveries genuinely concentrate, without a grid's arbitrary boundaries.
slug: finding-dense-delivery-clusters-with-gds
type: article
breadcrumb: Density Clusters
datePublished: 2026-08-11
dateModified: 2026-08-11
---
# Finding Dense Delivery Clusters with Neo4j GDS

A grid answers "how many deliveries fell in each square". It cannot answer "where do deliveries concentrate", because the squares are arbitrary: shift the grid half a cell and a single hot block becomes two warm ones, or the reverse. When the shape of the concentration is the finding — sizing a depot catchment, spotting a new demand pocket, grouping stops into service areas nobody drew in advance — the cell boundary is the thing getting in the way. This page builds a proximity graph over the delivery points and runs community detection on it, so the clusters come out of the data's own structure rather than out of a coordinate system's.

## Prerequisites & Versions

The proximity graph is built with `gds.knn` and clustered with Louvain, both in the standard GDS distribution.

| Requirement | Minimum version | Install |
| --- | --- | --- |
| Python | 3.11 | — |
| neo4j (async driver) | 5.20 | `pip install "neo4j>=5.20"` |
| Neo4j Server | 5.15 | native `point` |
| Graph Data Science | 2.6 | server plugin |

## Implementation

The routine below runs as a scheduled job, not in a request path. It projects the delivery points, builds a mutual-KNN graph whose edges only connect genuinely near pairs, runs Louvain over that graph, and writes a cluster id back — then drops everything it created.

```python
import asyncio
from dataclasses import dataclass

from neo4j import AsyncGraphDatabase

PROJECT = """
CALL gds.graph.project.cypher(
  $graph,
  'MATCH (d:Delivery) WHERE d.tenant_id = $tenant AND d.location IS NOT NULL
   RETURN id(d) AS id, [d.location.latitude, d.location.longitude] AS coord',
  'RETURN null AS source, null AS target LIMIT 0',
  {parameters: {tenant: $tenant}}
)
YIELD graphName, nodeCount
RETURN nodeCount
"""

# Two passes. gds.knn writes a NEAR edge per node; the mutual filter then keeps
# only the pairs where BOTH nodes chose each other, which is what stops a lone
# outlier from being dragged into its nearest neighbour's cluster.
KNN = """
CALL gds.knn.mutate($graph, {
  nodeProperties: ['coord'],
  topK: $top_k,
  similarityCutoff: $cutoff,
  sampleRate: 1.0,
  deltaThreshold: 0.0,
  mutateRelationshipType: 'NEAR',
  mutateProperty: 'similarity'
})
YIELD relationshipsWritten, nodesCompared
RETURN relationshipsWritten, nodesCompared
"""

LOUVAIN = """
CALL gds.louvain.stream($graph, {
  relationshipTypes: ['NEAR'],
  relationshipWeightProperty: 'similarity'
})
YIELD nodeId, communityId
RETURN gds.util.asNode(nodeId).id AS delivery_id, communityId
"""

WRITE_BACK = """
UNWIND $rows AS row
MATCH (d:Delivery {id: row.delivery_id})
SET d.cluster_id = row.communityId, d.clustered_at = datetime()
RETURN count(d) AS updated
"""


@dataclass(frozen=True)
class ClusterRun:
    nodes: int
    edges: int
    clusters: int
    largest: int
    singletons: int


class DeliveryClusterer:
    def __init__(self, uri: str, auth: tuple[str, str]) -> None:
        self._driver = AsyncGraphDatabase.driver(uri, auth=auth)

    async def close(self) -> None:
        await self._driver.close()

    async def run(
        self, tenant: str, top_k: int = 8, cutoff: float = 0.9995
    ) -> ClusterRun:
        graph = f"cluster-{tenant}"
        async with self._driver.session() as session:
            result = await session.run(PROJECT, graph=graph, tenant=tenant)
            nodes = int((await result.single())["nodeCount"])
            try:
                result = await session.run(
                    KNN, graph=graph, top_k=top_k, cutoff=cutoff
                )
                record = await result.single()
                edges = int(record["relationshipsWritten"])

                result = await session.run(LOUVAIN, graph=graph)
                rows = [
                    {"delivery_id": r["delivery_id"], "communityId": r["communityId"]}
                    async for r in result
                ]
            finally:
                await session.run("CALL gds.graph.drop($graph, false)", graph=graph)

            for chunk in _chunks(rows, 5_000):
                await session.run(WRITE_BACK, rows=chunk)

        sizes: dict[int, int] = {}
        for row in rows:
            sizes[row["communityId"]] = sizes.get(row["communityId"], 0) + 1
        return ClusterRun(
            nodes=nodes,
            edges=edges,
            clusters=len(sizes),
            largest=max(sizes.values()) if sizes else 0,
            singletons=sum(1 for n in sizes.values() if n == 1),
        )


def _chunks(rows: list[dict], size: int):
    for i in range(0, len(rows), size):
        yield rows[i:i + size]


async def main() -> None:
    clusterer = DeliveryClusterer("neo4j://localhost:7687", ("neo4j", "password"))
    try:
        run = await clusterer.run(tenant="acme-logistics")
    finally:
        await clusterer.close()
    print(f"{run.nodes:,} points → {run.edges:,} NEAR edges → {run.clusters:,} clusters")
    print(f"largest {run.largest:,} · singletons {run.singletons:,}")
```

## How It Works

Three decisions carry the result, and each is the place a naive version goes wrong.

**The similarity cutoff is doing the spatial work.** `gds.knn` will happily connect every node to its `topK` nearest neighbours no matter how far away they are — in a sparse rural area that means edges spanning kilometres, which then merge unrelated villages into one community. The cutoff is what makes the graph *proximity* rather than *ranking*: below it, a pair simply gets no edge. Because the metric is Euclidean over a `[lat, lon]` vector, the cutoff is in degree space rather than metres, so it has to be derived from the latitude the data sits at rather than copied from another deployment.

**Mutual KNN is what keeps outliers out.** Plain KNN is directional: a remote delivery has a nearest neighbour, and that edge alone is enough to pull it into a cluster it has no business in. `gds.knn.mutate` combined with keeping only reciprocated pairs means an edge exists when *both* points regard the other as near — so a genuine outlier ends up with no edges at all and falls out as a singleton, which is the correct answer.

**Louvain finds communities, not circles.** Given a graph whose edges mean "these two are close", Louvain groups nodes that are more densely connected to each other than to the rest. That is a structural definition, and it is why the result follows the shape of the demand rather than a template — a cluster can be a long ribbon along an arterial road, which is exactly what a delivery concentration in a city often looks like and exactly what a radius-based method cannot produce.

<svg viewBox="0 0 780 316" role="img" aria-labelledby="clShapeTitle clShapeDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="clShapeTitle">A grid, a radius and a proximity graph on the same delivery points</title>
  <desc id="clShapeDesc">The same set of delivery points read three ways. The grid splits one dense ribbon of demand along an arterial road across four cells and reports four moderate cells, none of them remarkable. A fixed-radius method centred on the densest point captures a circle that includes empty ground on one side and cuts the ribbon off on the other. The proximity graph connects each point to the neighbours that also chose it, and community detection over those edges recovers the ribbon as a single cluster with the outliers left unassigned.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="316" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">One ribbon of demand along an arterial road</text>
  <rect x="24" y="42" width="236" height="212" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-ok,#7d6200)" stroke-width="1.6"/>
  <text x="142" y="66" text-anchor="middle" font-size="11.5" font-weight="700" fill="var(--viz-ok,#7d6200)">fixed grid</text>
  <g stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1.2">
    <line x1="142" y1="82" x2="142" y2="230"/><line x1="52" y1="156" x2="232" y2="156"/>
  </g>
  <g fill="var(--viz-ok,#7d6200)">
    <circle cx="86" cy="212" r="4"/><circle cx="100" cy="200" r="4"/><circle cx="114" cy="190" r="4"/><circle cx="128" cy="176" r="4"/>
    <circle cx="142" cy="164" r="4"/><circle cx="156" cy="150" r="4"/><circle cx="170" cy="138" r="4"/><circle cx="184" cy="126" r="4"/>
    <circle cx="198" cy="112" r="4"/><circle cx="212" cy="100" r="4"/><circle cx="120" cy="204" r="4"/><circle cx="164" cy="142" r="4"/>
  </g>
  <text x="142" y="248" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">4 moderate cells, no finding</text>
  <rect x="272" y="42" width="236" height="212" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-poor,#a8320f)" stroke-width="1.6"/>
  <text x="390" y="66" text-anchor="middle" font-size="11.5" font-weight="700" fill="var(--viz-poor,#a8320f)">fixed radius</text>
  <circle cx="390" cy="158" r="62" fill="var(--viz-poor,#a8320f)" opacity="0.12"/>
  <circle cx="390" cy="158" r="62" fill="none" stroke="var(--viz-poor,#a8320f)" stroke-width="1.8" stroke-dasharray="6 4"/>
  <g fill="var(--viz-poor,#a8320f)">
    <circle cx="334" cy="212" r="4"/><circle cx="348" cy="200" r="4"/><circle cx="362" cy="190" r="4"/><circle cx="376" cy="176" r="4"/>
    <circle cx="390" cy="164" r="4"/><circle cx="404" cy="150" r="4"/><circle cx="418" cy="138" r="4"/><circle cx="432" cy="126" r="4"/>
    <circle cx="446" cy="112" r="4"/><circle cx="460" cy="100" r="4"/><circle cx="368" cy="204" r="4"/><circle cx="412" cy="142" r="4"/>
  </g>
  <text x="390" y="248" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">empty ground in, ribbon ends cut off</text>
  <rect x="520" y="42" width="236" height="212" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="1.8"/>
  <text x="638" y="66" text-anchor="middle" font-size="11.5" font-weight="700" fill="var(--viz-good,#0a656d)">mutual-KNN + Louvain</text>
  <g stroke="var(--viz-good,#0a656d)" stroke-width="1.6">
    <line x1="582" y1="212" x2="596" y2="200"/><line x1="596" y1="200" x2="610" y2="190"/><line x1="610" y1="190" x2="624" y2="176"/>
    <line x1="624" y1="176" x2="638" y2="164"/><line x1="638" y1="164" x2="652" y2="150"/><line x1="652" y1="150" x2="666" y2="138"/>
    <line x1="666" y1="138" x2="680" y2="126"/><line x1="680" y1="126" x2="694" y2="112"/><line x1="694" y1="112" x2="708" y2="100"/>
    <line x1="616" y1="204" x2="610" y2="190"/><line x1="660" y1="142" x2="652" y2="150"/>
  </g>
  <g fill="var(--viz-good,#0a656d)">
    <circle cx="582" cy="212" r="4"/><circle cx="596" cy="200" r="4"/><circle cx="610" cy="190" r="4"/><circle cx="624" cy="176" r="4"/>
    <circle cx="638" cy="164" r="4"/><circle cx="652" cy="150" r="4"/><circle cx="666" cy="138" r="4"/><circle cx="680" cy="126" r="4"/>
    <circle cx="694" cy="112" r="4"/><circle cx="708" cy="100" r="4"/><circle cx="616" cy="204" r="4"/><circle cx="660" cy="142" r="4"/>
  </g>
  <text x="638" y="248" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">one cluster, shaped like the demand</text>
  <text x="24" y="284" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">The grid is not wrong — it answers a different question. It is wrong when the shape of the concentration is the finding,</text>
  <text x="24" y="300" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">because a cell boundary that happens to fall through the middle of a ribbon erases it.</text>
</svg>

## Common Failure Patterns

**1. A cutoff copied from another latitude.** The similarity is Euclidean in degree space, so the ground distance a given cutoff represents shrinks as you move away from the equator — a threshold tuned in Singapore joins points in Stockholm that are half as far apart. Derive it from the target distance and the working latitude, and recompute it per region rather than pinning one constant.

```python
import math

EARTH_R = 6_371_008.8

def cutoff_for(target_m: float, at_lat: float) -> float:
    """gds.knn scores EUCLIDEAN as 1 / (1 + distance) over the raw degree vector."""
    deg_lat = target_m / (math.pi / 180 * EARTH_R)
    deg_lon = deg_lat / max(math.cos(math.radians(at_lat)), 1e-6)
    degrees = math.hypot(deg_lat, deg_lon)
    return 1.0 / (1.0 + degrees)
```

**2. Directional KNN dragging outliers in.** Without the mutual filter, every point has `topK` edges whether or not anything is genuinely near it, so there are no singletons and every outlier is assigned. A run that reports zero unassigned points on real delivery data has almost certainly skipped the reciprocity check — real data has outliers, and a method that never finds one is not measuring proximity.

**3. Treating the cluster id as stable across runs.** Louvain's community ids are labels, not identities: a rerun on slightly different data can renumber everything, so a dashboard that joins on `cluster_id` between two runs will show a complete reshuffle that did not happen. If continuity matters, match clusters between runs by centroid proximity or membership overlap and carry a stable id yourself.

## Performance Notes

The cost is dominated by the KNN build, not by Louvain. With `sampleRate: 1.0` the comparison is close to exhaustive, which is right for a correctness-sensitive run and quadratic in the worst case:

$$C_{\text{knn}} \approx N \cdot k \cdot \log N \quad\text{at production sample rates},\qquad O(N^2) \text{ as the sample rate approaches } 1$$

On a few hundred thousand points that is minutes; on tens of millions it is not a job you run at all without partitioning first. The partition that works is geographic: cluster each region separately, because a delivery in one city is never in a community with one in another, and running them independently turns one quadratic problem into many small ones. Region boundaries do introduce an artefact — a genuine concentration straddling a boundary is split — which is the same edge effect a grid has, reintroduced at a much coarser scale where it matters far less.

Louvain itself is near-linear in edges and is not usually the bottleneck. The number that decides its cost is `topK`, because that sets the edge count directly: `topK: 8` on a million points is eight million edges before the mutual filter halves it. Raising `topK` to make clusters "better connected" mostly buys more edges spanning more distance, and the cutoff then has to work harder to undo it.

Because this is a scheduled job holding a projection, it competes for exactly the memory the [routing workload needs](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-memory-and-storage-tuning/tuning-jvm-heap-for-gds-projections/). Estimate before projecting, run it against a replica if one exists, and drop the graph in a `finally` so a failure cannot strand it.

<svg viewBox="0 0 780 292" role="img" aria-labelledby="clCostTitle clCostDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="clCostTitle">Where the time goes, and why partitioning by region changes the shape</title>
  <desc id="clCostDesc">Runtime against point count for two arrangements. Clustering the whole tenant in one pass is dominated by the KNN comparison and curves upward sharply, because at a sample rate near one the comparison approaches exhaustive. Clustering each region separately keeps every individual problem small, so the total grows close to linearly with the number of points. The trade is an edge artefact at region boundaries, which is the same effect a grid has, moved to a scale where a split concentration is far less likely.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="292" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Runtime against point count</text>
  <line x1="96" y1="48" x2="96" y2="212" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <line x1="96" y1="212" x2="720" y2="212" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <g font-size="9.5" fill="var(--viz-ink-mute,#565f6d)" text-anchor="middle">
    <text x="96" y="232">100k</text><text x="252" y="232">400k</text><text x="408" y="232">1M</text><text x="564" y="232">4M</text><text x="720" y="232">10M</text>
  </g>
  <text x="408" y="252" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">delivery points</text>
  <text x="44" y="130" font-size="10" font-weight="700" fill="currentColor" transform="rotate(-90 44 130)">runtime</text>
  <path d="M96 206 L252 192 L408 160 L564 104 L720 56" fill="none" stroke="var(--viz-poor,#a8320f)" stroke-width="2.8"/>
  <path d="M96 208 L252 202 L408 196 L564 186 L720 176" fill="none" stroke="var(--viz-good,#0a656d)" stroke-width="2.8"/>
  <text x="560" y="88" font-size="10" font-weight="700" fill="var(--viz-poor,#a8320f)">one pass over the whole tenant</text>
  <text x="500" y="172" font-size="10" font-weight="700" fill="var(--viz-good,#0a656d)">partitioned by region</text>
  <rect x="96" y="264" width="14" height="6" rx="3" fill="var(--viz-poor,#a8320f)"/>
  <text x="118" y="270" font-size="10" fill="currentColor">KNN dominates; near-exhaustive comparison at sampleRate 1.0</text>
  <rect x="470" y="264" width="14" height="6" rx="3" fill="var(--viz-good,#0a656d)"/>
  <text x="492" y="270" font-size="10" fill="currentColor">many small problems, one boundary artefact</text>
</svg>

Finally, resist the temptation to tune this until every point is in a cluster. The singleton count is a result, not a defect: it is the method telling you which deliveries are genuinely isolated, and on real logistics data that set is never empty. A run configured until it disappears has stopped measuring proximity and started partitioning — at which point a grid would have been cheaper, faster and easier to explain. The useful sanity check is the opposite of the intuitive one: if raising the cutoff sharply increases the singleton count, the threshold is now near the real scale of the data, which is where you want it.

## Related

- [Spatial Aggregation and Clustering in Cypher](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/spatial-aggregation-and-clustering/) — the grid-based alternative and when it is the right one.
- [GDS KNN vs Bounded-Radius KNN in Neo4j](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/k-nearest-neighbor-routing/gds-knn-vs-bounded-radius-knn-in-neo4j/) — why the similarity here is degree-space and not metres.
- [Tuning JVM Heap for GDS Projections](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-memory-and-storage-tuning/tuning-jvm-heap-for-gds-projections/) — sizing the projection this job builds.
- [K-Nearest Neighbor Routing](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/k-nearest-neighbor-routing/) — the request-time counterpart to this batch job.

This guide is part of [Spatial Aggregation and Clustering in Cypher](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/spatial-aggregation-and-clustering/), within [Cypher Spatial Queries & Pathfinding Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/).
