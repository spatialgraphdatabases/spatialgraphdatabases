---
pageTitle: Clipping Extracts Safely
title: Clipping Extracts Without Breaking Boundary Ways
description: Choose an extract strategy that keeps boundary ways whole, and detect the severed topology that a naive bounding-box clip leaves behind.
slug: clipping-extracts-without-breaking-boundary-ways
type: article
breadcrumb: Clipping Extracts
datePublished: 2026-08-11
dateModified: 2026-08-11
---
# Clipping Extracts Without Breaking Boundary Ways

Clipping a continental file down to the region you actually serve is the obvious first step of any OSM pipeline, and the obvious way to do it produces a graph with a ring of damage around its edge. A simple bounding-box extract keeps nodes inside the box and drops those outside, which severs every way crossing the boundary — the motorway that leaves the region loses its far endpoints, its segments lose their geometry, and the junction where it met the local network becomes a dead end. Routing then works perfectly in the middle and fails in a band around the outside, which is the hardest kind of failure to attribute because the graph is not obviously broken.

## Prerequisites & Versions

Extraction is done by the osmium toolchain before Python sees the data.

| Requirement | Minimum version | Install |
| --- | --- | --- |
| Python | 3.11 | — |
| osmium-tool | 1.16 | `apt install osmium-tool` |
| PyOsmium | 3.6 | `pip install "osmium>=3.6"` |
| neo4j (async driver) | 5.20 | `pip install "neo4j>=5.20"` |

## Implementation

```python
import subprocess
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class ExtractSpec:
    source: Path
    output: Path
    poly: Path              # a polygon file, not a bounding box
    buffer_km: float = 25.0 # routing room outside the served area


class Extractor:
    """Wraps `osmium extract` with the strategy that keeps ways whole.

    `complete_ways` keeps every node referenced by any way that has at least one
    node inside the region — so a road crossing the boundary retains its full
    geometry rather than being truncated at the edge. The file is larger than a
    simple clip and the difference is exactly the data that makes the boundary
    routable.
    """

    STRATEGIES = {
        # Keeps only nodes inside the region. Smallest output, severed ways.
        "simple": [],
        # Keeps all nodes of any way with a node inside. What routing needs.
        "complete_ways": ["--strategy=complete_ways"],
        # Also keeps relations' members. Needed for turn restrictions that
        # reference a way just outside the boundary.
        "smart": ["--strategy=smart", "--option=types=multipolygon,restriction"],
    }

    def run(self, spec: ExtractSpec, strategy: str = "smart") -> Path:
        if strategy not in self.STRATEGIES:
            raise ValueError(f"unknown strategy: {strategy}")
        cmd = [
            "osmium", "extract",
            "--polygon", str(spec.poly),
            *self.STRATEGIES[strategy],
            "--overwrite",
            "-o", str(spec.output),
            str(spec.source),
        ]
        subprocess.run(cmd, check=True)
        return spec.output


# After import, the damage a bad extract leaves is detectable in the graph.
BOUNDARY_DAMAGE = """
// Dead ends within the buffer are expected at the very edge and suspicious
// anywhere inside it. A cluster of them along a straight line is a clipped
// boundary rather than a real set of cul-de-sacs.
MATCH (n:Junction)
WHERE size([(n)-[:SEGMENT]-() | 1]) = 1
  AND n.location.latitude  >= $min_lat AND n.location.latitude  <= $max_lat
  AND n.location.longitude >= $min_lon AND n.location.longitude <= $max_lon
RETURN count(n) AS dead_ends
"""

SEVERED_TRUNK = """
// A motorway or trunk road ending in a dead end is almost never real.
MATCH (n:Junction)-[s:SEGMENT]-()
WHERE s.highway IN ['motorway', 'trunk', 'primary']
WITH n, count(s) AS degree
WHERE degree = 1
RETURN n.id AS junction, n.location AS location
ORDER BY junction
"""
```

## How It Works

**The buffer and the strategy solve different halves of the problem.** The buffer gives the router room to leave the served area and come back — a route between two points near the edge frequently goes outside it, and without the surrounding roads that route does not exist. The strategy decides whether the ways that *do* cross the buffer's own boundary survive intact. Both are needed: a generous buffer with a simple clip just moves the ring of damage further out.

**`complete_ways` keeps every node of a partially-included way.** That is the property that matters, because a way's nodes carry its geometry. Truncating a way at the boundary leaves segments whose length and bearing are computed from a coordinate that was never loaded, and the pipeline either drops them or writes something wrong — the [PyOsmium guard](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/osm-data-ingestion-pipelines/parsing-osm-pbf-extracts-with-pyosmium/) that skips ways with unresolved node locations exists precisely for what a simple clip produces.

**`smart` additionally keeps relation members.** Turn restrictions are relations referencing two ways and a junction node, and a restriction whose *via* way sits just outside the boundary is dropped by `complete_ways` — leaving the junction with no restriction, which is a silently permitted illegal turn. On a graph that models [turn restrictions as edges](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/turn-restriction-and-time-dependent-routing/modeling-turn-restrictions-as-an-edge-based-graph/), that is a fabricated movement of exactly the kind that arrangement was chosen to make impossible.

<svg viewBox="0 0 780 316" role="img" aria-labelledby="clipStratTitle clipStratDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="clipStratTitle">The same region under three extract strategies</title>
  <desc id="clipStratDesc">A road crossing the extract boundary, under three strategies. A simple clip keeps only the nodes inside the region, so the way is truncated at the edge and its final segment has one endpoint whose coordinate was never loaded — the junction becomes a dead end. The complete_ways strategy keeps every node of any way with a node inside, so the road retains its full geometry and leaves the region cleanly. The smart strategy additionally keeps relation members, so a turn restriction whose via way lies just outside the boundary survives rather than silently permitting an illegal movement.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="316" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">One road crossing the boundary, three strategies</text>
  <rect x="24" y="42" width="236" height="200" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-poor,#a8320f)" stroke-width="1.6"/>
  <text x="142" y="66" text-anchor="middle" font-size="11" font-weight="700" fill="var(--viz-poor,#a8320f)">simple</text>
  <rect x="52" y="82" width="120" height="132" fill="var(--accent,#0a656d)" opacity="0.1" stroke="var(--accent,#0a656d)" stroke-width="1.6" stroke-dasharray="6 4"/>
  <text x="112" y="98" text-anchor="middle" font-size="9" font-weight="700" fill="var(--accent,#0a656d)">region</text>
  <line x1="66" y1="150" x2="172" y2="150" stroke="var(--viz-poor,#a8320f)" stroke-width="3"/>
  <circle cx="172" cy="150" r="6" fill="var(--viz-poor,#a8320f)"/>
  <text x="196" y="154" font-size="9.5" font-weight="700" fill="var(--viz-poor,#a8320f)">dead end</text>
  <text x="142" y="232" text-anchor="middle" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">way truncated, geometry incomplete</text>
  <rect x="272" y="42" width="236" height="200" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-ok,#7d6200)" stroke-width="1.6"/>
  <text x="390" y="66" text-anchor="middle" font-size="11" font-weight="700" fill="var(--viz-ok,#7d6200)">complete_ways</text>
  <rect x="300" y="82" width="120" height="132" fill="var(--accent,#0a656d)" opacity="0.1" stroke="var(--accent,#0a656d)" stroke-width="1.6" stroke-dasharray="6 4"/>
  <text x="360" y="98" text-anchor="middle" font-size="9" font-weight="700" fill="var(--accent,#0a656d)">region</text>
  <line x1="314" y1="150" x2="486" y2="150" stroke="var(--viz-ok,#7d6200)" stroke-width="3"/>
  <circle cx="486" cy="150" r="6" fill="var(--viz-ok,#7d6200)"/>
  <text x="390" y="232" text-anchor="middle" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">way whole; a restriction outside is still lost</text>
  <rect x="520" y="42" width="236" height="200" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="1.8"/>
  <text x="638" y="66" text-anchor="middle" font-size="11" font-weight="700" fill="var(--viz-good,#0a656d)">smart</text>
  <rect x="548" y="82" width="120" height="132" fill="var(--accent,#0a656d)" opacity="0.1" stroke="var(--accent,#0a656d)" stroke-width="1.6" stroke-dasharray="6 4"/>
  <text x="608" y="98" text-anchor="middle" font-size="9" font-weight="700" fill="var(--accent,#0a656d)">region</text>
  <line x1="562" y1="150" x2="734" y2="150" stroke="var(--viz-good,#0a656d)" stroke-width="3"/>
  <circle cx="734" cy="150" r="6" fill="var(--viz-good,#0a656d)"/>
  <circle cx="668" cy="150" r="7" fill="var(--accent-2,#a8380b)"/>
  <text x="668" y="132" text-anchor="middle" font-size="9" font-weight="700" fill="var(--accent-2,#a8380b)">restriction kept</text>
  <text x="638" y="232" text-anchor="middle" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">ways and relations both survive</text>
  <text x="24" y="272" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">All three imports succeed and report sensible counts. The first produces a ring of dead ends around the region, the</text>
  <text x="24" y="288" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">second a ring of permitted illegal turns, and only the third leaves the boundary behaving like the middle.</text>
  <text x="24" y="308" font-size="10" fill="var(--viz-ink-mute,#565f6d)">The cost is file size, which is the cheapest resource in the pipeline.</text>
</svg>

## Common Failure Patterns

**1. Clipping to the served area rather than to a buffered one.** A delivery region and a routing region are different things: a route between two addresses in the same district can legitimately leave it, and if the surrounding roads are absent the router either fails or returns an absurd detour along the boundary. Twenty-five kilometres is a reasonable default for road routing and should be larger where the network is sparse.

**2. Using a bounding box where a polygon is meant.** A box around an irregular region includes large areas nobody serves — which costs import time and store — while still cutting through the parts of the region that stick out. A polygon file costs nothing extra and both fits better and clips less.

**3. Trusting the import's own counts.** A severed extract imports cleanly, reports plausible node and relationship totals, and passes every schema check. The damage is in the topology, not in the counts, and the queries above are what expose it — particularly the trunk-road check, since a motorway ending in a dead end is essentially never a real feature.

```cypher
// Dead ends per distance band from the boundary. A real network has them
// scattered; a severed extract has them concentrated in the outermost band.
MATCH (n:Junction)
WHERE size([(n)-[:SEGMENT]-() | 1]) = 1
RETURN n.boundary_distance_km / 5 AS band, count(*) AS dead_ends
ORDER BY band;
```

## Performance Notes

The strategies differ in both extraction cost and output size, and the ordering is the same for both:

$$|F_{\text{simple}}| < |F_{\text{complete}}| < |F_{\text{smart}}|$$

On a metropolitan extract from a continental source, `complete_ways` typically produces a file some 5–15 per cent larger than a simple clip and takes roughly twice as long to produce, because it needs a second pass to collect the referenced nodes. `smart` adds a further pass for relations and a few per cent more. Against an import that takes tens of minutes and a store measured in gigabytes, those are rounding errors — and they buy the removal of an entire class of boundary defect.

The buffer is the more consequential size decision. Extract area grows with the square of the buffer, so doubling it from 25 to 50 km on a compact region can double the imported graph. The right way to choose it is from routing behaviour rather than from instinct: sample real origin-destination pairs, route them against an unclipped graph, and measure how far outside the served region the routes actually stray. On dense urban networks that is usually under ten kilometres; on rural ones with few through routes it can be far more, because the only sensible path between two nearby villages may loop a long way around.

One further habit is worth adopting: keep the polygon and the strategy in the pipeline's configuration rather than in a shell script someone ran once. The extract is the step every downstream defect is eventually traced back to, and being able to say exactly which polygon and which strategy produced the graph currently in production is the difference between a five-minute diagnosis and an afternoon.

<svg viewBox="0 0 780 288" role="img" aria-labelledby="clipBufTitle clipBufDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="clipBufTitle">How far real routes stray outside the served region</title>
  <desc id="clipBufDesc">The distribution of maximum excursion outside the served region, measured over ten thousand real origin-destination pairs routed against an unclipped graph. On a dense urban network the great majority stay within five kilometres and almost all within twelve, so a fifteen-kilometre buffer covers essentially every route. On a rural network the distribution has a long tail — the only sensible path between two nearby villages can loop thirty kilometres around — so the same buffer would break a meaningful share of routes. Measuring the distribution is what turns the buffer from a guess into a decision.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="288" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Maximum excursion outside the served region, 10,000 routes</text>
  <line x1="96" y1="48" x2="96" y2="204" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <line x1="96" y1="204" x2="720" y2="204" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <g font-size="9.5" fill="var(--viz-ink-mute,#565f6d)" text-anchor="middle">
    <text x="96" y="224">0 km</text><text x="252" y="224">10</text><text x="408" y="224">20</text><text x="564" y="224">35</text><text x="720" y="224">50</text>
  </g>
  <text x="408" y="244" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">kilometres outside the region</text>
  <path d="M96 70 L160 96 L224 140 L288 172 L352 190 L416 198 L480 202 L560 203 L720 204" fill="none" stroke="var(--accent,#0a656d)" stroke-width="2.8"/>
  <text x="188" y="86" font-size="10" font-weight="700" fill="var(--accent,#0a656d)">dense urban</text>
  <path d="M96 120 L160 128 L224 138 L288 148 L352 156 L416 166 L480 176 L560 186 L720 198" fill="none" stroke="var(--accent-2,#a8380b)" stroke-width="2.8" stroke-dasharray="7 5"/>
  <text x="520" y="172" font-size="10" font-weight="700" fill="var(--accent-2,#a8380b)">rural — long tail</text>
  <line x1="330" y1="48" x2="330" y2="204" stroke="var(--viz-good,#0a656d)" stroke-width="1.8" stroke-dasharray="5 4"/>
  <text x="338" y="64" font-size="9.5" font-weight="700" fill="var(--viz-good,#0a656d)">a 15 km buffer covers urban and misses the rural tail</text>
  <text x="24" y="272" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">One buffer figure cannot serve both networks. The measurement takes an afternoon and settles it for the life of the pipeline.</text>
</svg>

Two operational habits follow from all of this. The first is to treat the extract as a versioned artefact rather than a step: record the source file's timestamp, the polygon, the strategy and the buffer alongside the resulting graph, so the question "which extract is production running on" has an answer. Every boundary defect is eventually traced back to this step, and the trace is only possible if the inputs were recorded at the time.

The second is to run the damage queries as an acceptance gate rather than as a diagnostic. Dead-end counts and severed trunk roads are cheap to compute immediately after import, they are stable between imports of the same region, and a sudden jump in either is a far better signal than anything a routing test will produce — because a routing test only fails if a sampled route happens to touch the damaged band, while the counts see the whole boundary at once. Gating the promotion of a freshly imported graph on those numbers turns a silent regression into a failed import, which is where you want it.

## Related

- [OSM Data Ingestion Pipelines](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/osm-data-ingestion-pipelines/) — the pipeline this is the first step of.
- [Parsing OSM PBF Extracts with PyOsmium](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/osm-data-ingestion-pipelines/parsing-osm-pbf-extracts-with-pyosmium/) — the unresolved-location guard a severed extract triggers.
- [Modeling Turn Restrictions as an Edge-Based Graph](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/turn-restriction-and-time-dependent-routing/modeling-turn-restrictions-as-an-edge-based-graph/) — why a dropped relation becomes a permitted illegal turn.
- [Handling Bridges, Tunnels and Level Crossings](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/node-and-edge-spatial-mapping/handling-bridges-tunnels-and-level-crossings/) — the other tag-driven topology trap in the same pipeline stage.

This guide is part of [OSM Data Ingestion Pipelines](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/osm-data-ingestion-pipelines/), within [Spatial Graph Construction & OSM Ingestion](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/).
