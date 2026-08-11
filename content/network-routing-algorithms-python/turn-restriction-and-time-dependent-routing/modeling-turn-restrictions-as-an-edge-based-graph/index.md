---
pageTitle: Turn Restrictions Edge-Based Graph
title: Modeling Turn Restrictions as an Edge-Based Graph
description: Transform a node-based road graph into an edge-based line graph in Neo4j so banned turns and turn penalties become plain edge properties, driven from async Python.
slug: modeling-turn-restrictions-as-an-edge-based-graph
type: article
breadcrumb: Edge-Based Turn Graph
datePublished: 2026-07-14
dateModified: 2026-07-14
---
# Modeling Turn Restrictions as an Edge-Based Graph

The symptom is a route that tells a driver to make a turn a sign forbids. The root cause is structural: in a node-based road graph a junction is a single vertex, and a shortest-path algorithm treats every relationship arriving at that vertex as freely chainable to every relationship leaving it. There is no place to say "an arrival on Prinsengracht may not continue onto Leidsestraat." Consulting a turn table at query time fixes it but forces a custom, turn-aware search. This page resolves it a different way — by transforming the graph itself so that turns become ordinary edges. Each original road segment becomes a *node*, each legal movement between two segments becomes an *edge*, and a banned turn is simply a link that was never created. The payoff is that any standard weighted shortest-path algorithm, including the built-in `gds.shortestPath.dijkstra`, honours turn restrictions with zero special-case logic. This is the transformation behind the flexible turn-table approach described in [Turn-Restriction and Time-Dependent Routing](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/turn-restriction-and-time-dependent-routing/).

## Prerequisites & Versions

The transformation is pure Cypher plus an async orchestration layer. No GDS is required to *build* the edge-based graph, though you will typically route over it with GDS afterwards.

| Requirement | Minimum version | Install / note |
| --- | --- | --- |
| Python | 3.10+ | `asyncio`, `dataclass`, native async driver usage |
| Neo4j | 5.13+ | Native `point`, `MERGE`, relationship property indexes |
| neo4j (driver) | 5.x | `AsyncGraphDatabase`, parameterized batched writes |

```bash
pip install "neo4j>=5.18"
```

This assumes the source graph already follows sound [Node and Edge Spatial Mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/) conventions — directed segments that respect one-way rules, stable segment ids, and geometry on native `point` properties — because the edge-based expansion inherits every topology defect in the source and multiplies it.

## Implementation

The line-graph construction is one idempotent Cypher statement, orchestrated from async Python so it can run in bounded batches over a large network. It reads every directed pair of segments that share a junction, and for each pair that is *not* forbidden by a `Restriction`, it creates a `TURN` edge between the two segment-nodes carrying the turn penalty as its weight.

```cypher
// Source model:  (:Segment {id, from_junction, to_junction, cost_s})
// A Restriction bans a specific ordered pair meeting at a via junction.
//   (:Restriction {via, from_segment, to_segment})
// Optional via-way restrictions add an intermediate segment (see failures below).

// One-time: index the join keys so the pairwise match seeks, not scans.
CREATE INDEX segment_from IF NOT EXISTS FOR (s:Segment) ON (s.from_junction);
CREATE INDEX segment_to   IF NOT EXISTS FOR (s:Segment) ON (s.to_junction);
```

```cypher
// Materialize the edge-based graph: legal movements become TURN edges.
MATCH (a:Segment)-[]->()  // batch anchor; in practice page by a.id ranges
WHERE a.id >= $lo AND a.id < $hi
MATCH (b:Segment)
WHERE a.to_junction = b.from_junction        // a ends where b begins → they meet
  AND NOT (a.to_junction = b.to_junction AND a.from_junction = b.from_junction)  // skip exact twins
WITH a, b, a.to_junction AS via
// Reject banned movements: leave the TURN edge uncreated entirely.
WHERE NOT EXISTS {
  MATCH (:Restriction {via: via, from_segment: a.id, to_segment: b.id})
}
// U-turn penalty: returning onto the reverse of the arriving segment.
WITH a, b, via,
     CASE WHEN b.to_junction = a.from_junction THEN 300.0 ELSE 0.0 END AS uturn_penalty
MERGE (a)-[t:TURN {via: via}]->(b)
SET t.weight_s = b.cost_s + uturn_penalty
```

The orchestration pages the build by segment-id range so no single transaction holds the whole network, and it runs the ranges concurrently under a bounded pool:

```python
import asyncio
from neo4j import AsyncGraphDatabase

BUILD_TURNS = """
MATCH (a:Segment)
WHERE a.id >= $lo AND a.id < $hi
MATCH (b:Segment)
WHERE a.to_junction = b.from_junction
WITH a, b, a.to_junction AS via
WHERE NOT EXISTS {
  MATCH (:Restriction {via: via, from_segment: a.id, to_segment: b.id})
}
WITH a, b, via,
     CASE WHEN b.to_junction = a.from_junction THEN 300.0 ELSE 0.0 END AS uturn_penalty
MERGE (a)-[t:TURN {via: via}]->(b)
SET t.weight_s = b.cost_s + uturn_penalty
RETURN count(t) AS turns_built
"""


async def build_edge_based_graph(
    uri: str, auth: tuple[str, str], id_ranges: list[tuple[int, int]]
) -> int:
    """Materialize TURN edges in bounded batches; returns total turns built."""
    driver = AsyncGraphDatabase.driver(
        uri, auth=auth,
        max_connection_pool_size=8,
        connection_acquisition_timeout=30.0,
    )
    total = 0
    try:
        sem = asyncio.Semaphore(4)  # cap concurrent write transactions

        async def run_range(lo: int, hi: int) -> int:
            async with sem:
                async with driver.session(database="neo4j") as s:
                    rec = await (await s.run(BUILD_TURNS, lo=lo, hi=hi)).single()
                    return rec["turns_built"]

        results = await asyncio.gather(*(run_range(lo, hi) for lo, hi in id_ranges))
        total = sum(results)
    finally:
        await driver.close()
    return total


if __name__ == "__main__":
    # Amsterdam centre extract: segment ids 0..40000 in 5k batches.
    ranges = [(i, i + 5000) for i in range(0, 40000, 5000)]
    built = asyncio.run(
        build_edge_based_graph(
            "neo4j+s://your-cluster.databases.neo4j.io",
            ("neo4j", "secure-password"),
            ranges,
        )
    )
    print(f"Edge-based graph built: {built} TURN edges.")
```

Once the `TURN` edges exist, routing is a plain weighted shortest path over segment-nodes — no turn-aware search, no special state. A GDS projection of `(:Segment)-[:TURN]->(:Segment)` weighted by `weight_s` routes correctly because every illegal movement is already missing from the projection.

<svg viewBox="0 0 760 392" role="img" aria-labelledby="ebTitle ebDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="ebTitle">Node-based junction expanded into an edge-based line graph</title>
  <desc id="ebDesc">Left: a node-based junction J with four incident road segments to neighbours A, B, C, and D. Right: the same junction as an edge-based line graph, where the arriving segment D-to-J becomes a node and the three departing segments become nodes J-to-A, J-to-B, and J-to-C. Solid links from D-to-J to J-to-B and J-to-C are legal turns; the dashed link to J-to-A is a banned turn that is simply never created, so the shortest-path search can never traverse it.</desc>
  <defs>
    <marker id="eb-arrow" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="var(--accent,#0a656d)"/>
    </marker>
    <marker id="eb-plain" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
    <marker id="eb-ban" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="var(--accent-2,#a8380b)"/>
    </marker>
  </defs>
  <!-- LEFT: node-based -->
  <rect class="viz-backdrop" x="0" y="0" width="760" height="392" fill="var(--viz-bg,#ffffff)"/>
  <text x="182" y="26" text-anchor="middle" font-size="14.5" font-weight="700" fill="currentColor">Node-based junction</text>
  <text x="182" y="44" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.72">one vertex, turns invisible</text>
  <rect x="12" y="54" width="340" height="320" rx="10" fill="var(--surface-2)" stroke="var(--line)"/>
  <g stroke="currentColor" stroke-width="2" opacity="0.55">
    <line x1="182" y1="210" x2="182" y2="104"/>
    <line x1="182" y1="210" x2="300" y2="210"/>
    <line x1="182" y1="210" x2="182" y2="316"/>
    <line x1="182" y1="210" x2="64" y2="210"/>
  </g>
  <g font-size="11" font-weight="700">
    <circle cx="182" cy="210" r="16" fill="var(--accent-3,#5b21b6)"/>
    <text x="182" y="214" text-anchor="middle" fill="var(--viz-on-pill,#ffffff)">J</text>
    <circle cx="182" cy="90" r="13" fill="var(--surface-2)" stroke="var(--ink-soft)" stroke-width="2"/>
    <text x="182" y="94" text-anchor="middle" fill="currentColor">A</text>
    <circle cx="314" cy="210" r="13" fill="var(--surface-2)" stroke="var(--ink-soft)" stroke-width="2"/>
    <text x="314" y="214" text-anchor="middle" fill="currentColor">B</text>
    <circle cx="182" cy="330" r="13" fill="var(--surface-2)" stroke="var(--ink-soft)" stroke-width="2"/>
    <text x="182" y="334" text-anchor="middle" fill="currentColor">C</text>
    <circle cx="50" cy="210" r="13" fill="var(--surface-2)" stroke="var(--ink-soft)" stroke-width="2"/>
    <text x="50" y="214" text-anchor="middle" fill="currentColor">D</text>
  </g>
  <text x="182" y="360" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.72">D→J→A cannot be forbidden here</text>
  <!-- RIGHT: edge-based -->
  <text x="576" y="26" text-anchor="middle" font-size="14.5" font-weight="700" fill="currentColor">Edge-based line graph</text>
  <text x="576" y="44" text-anchor="middle" font-size="11" fill="currentColor" opacity="0.72">segments are nodes, turns are edges</text>
  <rect x="404" y="54" width="344" height="320" rx="10" fill="var(--surface-2)" stroke="var(--line)"/>
  <!-- turn links -->
  <path d="M498 212 Q560 160 636 118" fill="none" stroke="var(--accent-2,#a8380b)" stroke-width="2.2" stroke-dasharray="7 5" marker-end="url(#eb-ban)"/>
  <path d="M506 216 H628" fill="none" stroke="var(--accent,#0a656d)" stroke-width="2.4" marker-end="url(#eb-arrow)"/>
  <path d="M498 224 Q560 270 636 312" fill="none" stroke="var(--accent,#0a656d)" stroke-width="2.4" marker-end="url(#eb-arrow)"/>
  <!-- edge-nodes -->
  <g font-size="10.5" font-weight="700">
    <rect x="430" y="196" width="70" height="34" rx="8" fill="var(--accent-3,#5b21b6)"/>
    <text x="465" y="217" text-anchor="middle" fill="var(--viz-on-pill,#ffffff)">D→J</text>
    <rect x="636" y="100" width="72" height="34" rx="8" fill="var(--surface-2)" stroke="var(--accent-2,#a8380b)" stroke-width="2" stroke-dasharray="4 3"/>
    <text x="672" y="121" text-anchor="middle" fill="var(--accent-2,#a8380b)">J→A</text>
    <rect x="636" y="199" width="72" height="34" rx="8" fill="var(--surface-2)" stroke="var(--accent,#0a656d)" stroke-width="2"/>
    <text x="672" y="220" text-anchor="middle" fill="currentColor">J→B</text>
    <rect x="636" y="298" width="72" height="34" rx="8" fill="var(--surface-2)" stroke="var(--accent,#0a656d)" stroke-width="2"/>
    <text x="672" y="319" text-anchor="middle" fill="currentColor">J→C</text>
  </g>
  <text x="600" y="150" font-size="9.5" fill="var(--accent-2,#a8380b)" font-weight="700">banned: link never created</text>
  <text x="576" y="362" text-anchor="middle" font-size="10.5" fill="currentColor" opacity="0.72">the ban is an absent edge — no special search needed</text>
</svg>

## How It Works

The construction is a graph-theoretic *line graph* with turn semantics layered on top. Three mechanics carry it:

- **Segments become nodes, movements become edges.** The join condition `a.to_junction = b.from_junction` finds every ordered pair of segments that physically meet — segment `a` ends at the junction where segment `b` begins. Each such pair is a candidate movement. Creating a `TURN` edge for it promotes the movement to a first-class, weighted object that a shortest-path algorithm can reason about directly.
- **The ban is subtraction, not annotation.** Instead of marking a movement as forbidden, the `WHERE NOT EXISTS { MATCH (:Restriction ...) }` guard simply declines to create its `TURN` edge. A missing edge is unreachable by construction, so no search — Cypher, GDS, or hand-written — can ever emit the banned turn. There is no flag to check and no rule to forget.
- **Penalty rides on the edge weight.** A turn that is legal but costly — a hard left across traffic, a U-turn — carries its penalty in `weight_s`, added to the cost of the segment being entered. Because the penalty is now part of an ordinary edge weight, plain weighted Dijkstra minimizes total time *including* turn cost with no modification.

<svg viewBox="0 0 780 336" role="img" aria-labelledby="tlTitle tlDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="tlTitle">Segments become nodes and movements become edges, so a ban is a missing edge</title>
  <desc id="tlDesc">Left: four road segments meeting at one junction, in the ordinary node-and-edge model where the junction is a single node. Right: the edge-based expansion of the same junction. Each segment is now a node, and each legal movement from an incoming segment to an outgoing one is a TURN edge carrying the entered segment's cost plus any penalty. The west-to-north movement has no TURN edge at all, because the guard declined to create it, so no search can emit that turn. The west-to-south movement exists but carries a four second penalty for crossing traffic.</desc>
  <defs>
    <marker id="tl-a" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="currentColor"/>
    </marker>
    <marker id="tl-g" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="var(--viz-good,#0a656d)"/>
    </marker>
    <marker id="tl-o" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="var(--viz-ok,#7d6200)"/>
    </marker>
  </defs>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="336" fill="var(--viz-bg,#ffffff)"/>
  <text x="182" y="24" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">node-based junction</text>
  <text x="182" y="42" text-anchor="middle" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">one node J — every in-edge chains to every out-edge</text>
  <text x="560" y="24" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">edge-based expansion</text>
  <text x="560" y="42" text-anchor="middle" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">segments are nodes, movements are TURN edges</text>
  <line x1="368" y1="56" x2="368" y2="300" stroke="var(--line,#e5e0d2)" stroke-width="1" stroke-dasharray="3 6"/>
  <rect x="24" y="60" width="316" height="240" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.2"/>
  <g stroke="var(--viz-stroke,#9ca3af)" stroke-width="2">
    <line x1="182" y1="180" x2="182" y2="100"/><line x1="182" y1="180" x2="182" y2="260"/>
    <line x1="182" y1="180" x2="100" y2="180"/><line x1="182" y1="180" x2="264" y2="180"/>
  </g>
  <g font-size="10" font-weight="700" text-anchor="middle">
    <circle cx="182" cy="100" r="14" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.5"/><text x="182" y="104" fill="currentColor">N</text>
    <circle cx="182" cy="260" r="14" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.5"/><text x="182" y="264" fill="currentColor">S</text>
    <circle cx="100" cy="180" r="14" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.5"/><text x="100" y="184" fill="currentColor">W</text>
    <circle cx="264" cy="180" r="14" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.5"/><text x="264" y="184" fill="currentColor">E</text>
    <circle cx="182" cy="180" r="17" fill="var(--accent-3,#5b21b6)"/><text x="182" y="184" fill="var(--viz-on-pill,#ffffff)">J</text>
  </g>
  <text x="182" y="288" text-anchor="middle" font-size="10" fill="var(--viz-poor,#a8320f)" font-weight="600">W→J→N is a valid path — the ban is unrepresentable</text>
  <rect x="396" y="60" width="360" height="240" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.2"/>
  <g font-size="10.5" font-weight="700" text-anchor="middle">
    <rect x="416" y="164" width="86" height="32" rx="7" fill="var(--accent,#0a656d)"/><text x="459" y="184" fill="var(--viz-on-pill,#ffffff)">seg W</text>
    <rect x="640" y="86" width="86" height="32" rx="7" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/><text x="683" y="106" fill="currentColor">seg N</text>
    <rect x="640" y="164" width="86" height="32" rx="7" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/><text x="683" y="184" fill="currentColor">seg E</text>
    <rect x="640" y="242" width="86" height="32" rx="7" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/><text x="683" y="262" fill="currentColor">seg S</text>
  </g>
  <path d="M502 176 H570 V180 H636" fill="none" stroke="var(--viz-good,#0a656d)" stroke-width="2.2" marker-end="url(#tl-g)"/>
  <text x="570" y="170" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--viz-good,#0a656d)">TURN w=18 s</text>
  <path d="M502 188 H570 V258 H636" fill="none" stroke="var(--viz-ok,#7d6200)" stroke-width="2.2" marker-end="url(#tl-o)"/>
  <text x="566" y="230" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--viz-ok,#7d6200)">TURN w=22 s</text><text x="566" y="243" text-anchor="middle" font-size="9" fill="var(--viz-ink-mute,#565f6d)">+4 s penalty</text>
  <path d="M502 172 H556 V102 H636" fill="none" stroke="var(--viz-poor,#a8320f)" stroke-width="1.6" stroke-dasharray="6 5"/>
  <text x="556" y="126" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--viz-poor,#a8320f)">no TURN edge</text>
  <text x="576" y="324" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">unreachable by construction — no flag to check, no rule to forget</text>
</svg>

The weight convention matters: `weight_s` is set to the entered segment's own cost plus any turn penalty, so the total path cost is the sum of `TURN` edge weights and equals travel time through the segments plus the cost of every turn taken. The origin and destination need bootstrap edges (a virtual source that links to the first segment-node and a virtual sink reachable from the last), which the routing layer adds per query rather than baking into the graph.

## Common Failure Patterns

**1. Doubling — or worse — the graph size.** The edge-based graph has one node per directed segment and one edge per legal movement. Node count therefore roughly doubles a two-way network (each street becomes two directed segments), and edge count grows with the sum of squared junction degrees, because a degree-*d* junction generates up to *d²* movements. On a dense grid this is a several-fold blow-up. Cap it by only expanding junctions that actually carry restrictions or penalties and leaving unrestricted junctions in the cheaper node-based form — a hybrid that keeps the expansion local to where it earns its cost.

```cypher
// Only expand junctions that have at least one restriction or non-trivial penalty.
MATCH (r:Restriction) RETURN collect(DISTINCT r.via) AS via_to_expand
```

**2. Forgetting U-turn edges.** A movement from a segment back onto its own reverse is a legal turn in the graph-theory sense and must be represented, or the router silently loses the ability to route a dead-end reversal — and sometimes finds *no* path where one physically exists. The `CASE WHEN b.to_junction = a.from_junction` clause in the build detects the reversal and applies a heavy penalty rather than dropping it. Omitting U-turn edges entirely is a common and hard-to-spot correctness bug: most routes are unaffected, so tests pass, until a cul-de-sac delivery has no legal route out.

**3. Restriction relations with via-ways.** The simple `(via, from_segment, to_segment)` key handles "at this junction, you may not go from A to B." It cannot express a restriction that spans an intermediate segment — "no right turn from A onto C when the approach used way B." These *via-way* restrictions, common in OpenStreetMap data, need a key that includes the intermediate segment, and the expansion must forbid the two-hop movement `A→B→C` while leaving `A→B` and `B→C` individually legal. Encode them against the *pair* of `TURN` edges, not a single one:

```cypher
// Via-way ban: forbid the A→B then B→C sequence without banning either alone.
MATCH (:Restriction {kind:'via_way', from_segment:'A', via_segment:'B', to_segment:'C'})
MATCH (eab:Segment {id:'A'})-[t1:TURN]->(eb:Segment {id:'B'})-[t2:TURN]->(ec:Segment {id:'C'})
SET t2.forbidden_after = coalesce(t2.forbidden_after, []) + eab.id
// The router then rejects t2 whenever the label arrived via t1 from A.
```

## Performance Notes

Build cost is dominated by the pairwise segment match, which is why the join keys must be indexed. With `segment_from`/`segment_to` indexes in place, matching partners for one segment is an index seek over the junctions it touches, so total build work is proportional to the number of *movements*, not to the square of the segment count. Let $d$ be the average junction degree; the edge-based graph has on the order of

$$|E_{\text{turn}}| \approx |V_{\text{junction}}| \cdot \bar{d}^{\,2}$$

turn edges, so a network of 20,000 junctions at average degree 3.2 produces roughly 200,000 turn edges — comfortably in memory, but a naive full-degree expansion of every junction is what turns a manageable build into an out-of-memory one. Batch the build by id range as shown, keep the write pool small (write contention, not read throughput, is the limit), and prefer the selective-expansion hybrid on dense networks. Query-time routing over the finished graph is ordinary weighted shortest path; its cost model and the GDS-versus-Cypher trade-off are covered under the parent [Network Routing Algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/).

## Related

- [Turn-Restriction and Time-Dependent Routing](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/turn-restriction-and-time-dependent-routing/) — the turn-table alternative and where each approach fits.
- [Time-Dependent Shortest Paths with Schedule Edges](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/turn-restriction-and-time-dependent-routing/time-dependent-shortest-paths-with-schedule-edges/) — the other hard routing constraint, layered on the same base graph.
- [Contraction Hierarchies for Road Networks](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/contraction-hierarchies-for-road-networks/) — preprocessing that can run over the finished edge-based graph.
- [Node and Edge Spatial Mapping](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/) — the source-graph conventions the expansion depends on.

This guide is part of [Turn-Restriction and Time-Dependent Routing](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/turn-restriction-and-time-dependent-routing/), within the [Network Routing Algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/) knowledge base.

For authoritative reference on turn-restriction data and the line-graph construction, consult the [OpenStreetMap turn-restriction relation documentation](https://wiki.openstreetmap.org/wiki/Relation:restriction).
