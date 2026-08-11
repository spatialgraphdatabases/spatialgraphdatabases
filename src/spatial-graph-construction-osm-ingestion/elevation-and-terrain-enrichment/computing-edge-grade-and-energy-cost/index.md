---
pageTitle: Edge Grade & Energy Cost
title: Computing Edge Grade and Energy Cost
description: Turn a directed gradient into watt-hours per edge with a physical model, including the regeneration cut-off that makes descent cheap but never free.
slug: computing-edge-grade-and-energy-cost
type: article
breadcrumb: Energy Cost
datePublished: 2026-08-11
dateModified: 2026-08-11
---
# Computing Edge Grade and Energy Cost

Routing an electric vehicle on driving time and reporting range separately is the arrangement that strands people. The fastest route over a pass and the cheapest route around it are different routes, and a system that optimises one while displaying the other will confidently show a battery percentage that turns out to be wrong at the top of the climb. Making energy a first-class edge cost fixes that — the router minimises what actually runs out, and the arrival estimate is the thing that was optimised rather than a number computed afterwards. This page derives watt-hours per edge from gradient, speed and vehicle mass, and handles the asymmetry that makes descending cheap without ever making it free.

## Prerequisites & Versions

The model is arithmetic over properties the [elevation enrichment](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/elevation-and-terrain-enrichment/) has already written.

| Requirement | Minimum version | Install |
| --- | --- | --- |
| Python | 3.11 | — |
| neo4j (async driver) | 5.20 | `pip install "neo4j>=5.20"` |
| Neo4j Server | 5.15 | native `point`, directed relationships |

## Implementation

The model computes the force balance on a segment, converts it to energy over the segment's length, and applies drivetrain and regeneration efficiencies on the appropriate side of zero.

```python
import asyncio
import math
from dataclasses import dataclass

from neo4j import AsyncGraphDatabase

G = 9.80665           # m/s²
AIR_DENSITY = 1.225   # kg/m³ at sea level, 15 °C


@dataclass(frozen=True)
class Vehicle:
    mass_kg: float
    frontal_area_m2: float
    drag_coefficient: float
    rolling_resistance: float
    drivetrain_efficiency: float = 0.90
    regen_efficiency: float = 0.60      # what fraction of braking energy returns
    accessory_w: float = 900.0          # HVAC, lights, electronics


@dataclass(frozen=True)
class EdgeEnergy:
    segment_id: str
    wh: float
    regenerating: bool


def edge_energy_wh(v: Vehicle, length_m: float, grade_pct: float,
                   speed_mps: float) -> EdgeEnergy | float:
    """Watt-hours to traverse one directed segment.

    Three forces oppose motion and one can assist it. Rolling resistance and
    aerodynamic drag always oppose; the gravity term opposes on a climb and
    assists on a descent, which is where the sign of grade_pct enters.
    """
    theta = math.atan(grade_pct / 100.0)

    rolling_n = v.rolling_resistance * v.mass_kg * G * math.cos(theta)
    drag_n = 0.5 * AIR_DENSITY * v.drag_coefficient * v.frontal_area_m2 * speed_mps ** 2
    gravity_n = v.mass_kg * G * math.sin(theta)      # negative when descending

    net_n = rolling_n + drag_n + gravity_n
    mechanical_j = net_n * length_m

    if mechanical_j >= 0:
        # Driving: the battery supplies the work, and the drivetrain loses some.
        battery_j = mechanical_j / v.drivetrain_efficiency
    else:
        # Descending steeply enough that gravity exceeds the resistances. Only a
        # fraction of the surplus comes back, and it comes back through the same
        # drivetrain — so this is never the mirror image of the climb.
        battery_j = mechanical_j * v.regen_efficiency * v.drivetrain_efficiency

    # Accessories draw whether the vehicle is climbing, descending or stopped,
    # so they scale with TIME on the edge, not with distance.
    seconds = length_m / max(speed_mps, 0.1)
    battery_j += v.accessory_w * seconds

    return battery_j / 3600.0


WRITE_ENERGY = """
UNWIND $batch AS row
MATCH ()-[s:SEGMENT {id: row.id}]->()
SET s.energy_wh = row.wh
RETURN count(s) AS updated
"""

READ_SEGMENTS = """
MATCH ()-[s:SEGMENT]->()
WHERE s.grade_pct IS NOT NULL AND s.length_m > 0
RETURN s.id AS id, s.length_m AS length_m, s.grade_pct AS grade_pct,
       coalesce(s.free_flow_mps, 13.9) AS speed_mps
"""


async def annotate(uri: str, auth: tuple[str, str], vehicle: Vehicle,
                   batch: int = 10_000) -> int:
    driver = AsyncGraphDatabase.driver(uri, auth=auth)
    written = 0
    try:
        async with driver.session() as session:
            result = await session.run(READ_SEGMENTS)
            buffer: list[dict] = []
            async for record in result:
                wh = edge_energy_wh(
                    vehicle,
                    float(record["length_m"]),
                    float(record["grade_pct"]),
                    float(record["speed_mps"]),
                )
                buffer.append({"id": record["id"], "wh": round(wh, 4)})
                if len(buffer) >= batch:
                    written += await _flush(session, buffer)
                    buffer.clear()
            if buffer:
                written += await _flush(session, buffer)
    finally:
        await driver.close()
    return written


async def _flush(session, buffer: list[dict]) -> int:
    result = await session.run(WRITE_ENERGY, batch=buffer)
    return int((await result.single())["updated"])
```

## How It Works

Three parts of the model matter more than the constants.

**Gravity is the only term whose sign flips.** Rolling resistance and drag oppose motion in both directions; the gravity term is `m·g·sin(θ)`, and `sin` is negative for a descent. That single sign change is what makes the edge cost directional, and it is why the graph needs two relationships per two-way road rather than one with a magnitude.

**Regeneration is bounded twice, which is why descending never repays the climb.** The surplus energy on a descent is multiplied by the regeneration efficiency *and* by the drivetrain efficiency, because it travels back through the same machinery it went out through. At typical figures, roughly half of what a climb cost comes back on the matching descent. A model that returns the full surplus produces routes that treat hills as free and, worse, produces range estimates that improve when the road goes down.

**Accessories scale with time, not distance.** Climate control and electronics draw a roughly constant power whether the vehicle is moving fast, slowly or not at all. Attaching that draw to distance rather than to time makes a slow congested edge look cheap and a fast motorway edge look expensive, which is exactly backwards — the slow edge is occupied for longer and therefore costs more accessory energy.

<svg viewBox="0 0 780 316" role="img" aria-labelledby="energyCurveTitle energyCurveDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="energyCurveTitle">Energy per kilometre against gradient, and the kink where regeneration starts</title>
  <desc id="energyCurveDesc">Watt-hours per kilometre plotted against road gradient for a 2,100 kilogram vehicle at 90 kilometres per hour. On the climbing side the curve rises steeply and almost linearly with gradient. Around minus one and a half per cent the gravity term cancels the rolling and aerodynamic resistances and the net demand reaches zero. Below that the vehicle begins recovering energy, but the recovered curve is much shallower than the climbing one, because the surplus passes back through both the regeneration and the drivetrain efficiencies. A symmetric model would mirror the climbing curve and overstate recovery by roughly a factor of two.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="316" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Wh per km against gradient — 2,100 kg at 90 km/h</text>
  <line x1="96" y1="48" x2="96" y2="232" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <line x1="96" y1="180" x2="720" y2="180" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <g font-size="9.5" fill="var(--viz-ink-mute,#565f6d)" text-anchor="end">
    <text x="88" y="60">600</text><text x="88" y="100">400</text><text x="88" y="140">200</text><text x="88" y="184">0</text><text x="88" y="224">−200</text>
  </g>
  <g font-size="9.5" fill="var(--viz-ink-mute,#565f6d)" text-anchor="middle">
    <text x="96" y="252">−8%</text><text x="252" y="252">−4%</text><text x="408" y="252">0%</text><text x="564" y="252">+4%</text><text x="720" y="252">+8%</text>
  </g>
  <text x="408" y="272" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">gradient</text>
  <path d="M96 222 L174 212 L252 202 L330 190 L360 180 L408 156 L486 116 L564 84 L642 62 L720 52" fill="none" stroke="var(--accent,#0a656d)" stroke-width="2.8"/>
  <path d="M96 108 L174 126 L252 144 L330 166 L360 180" fill="none" stroke="var(--viz-poor,#a8320f)" stroke-width="2.2" stroke-dasharray="8 5"/>
  <circle cx="360" cy="180" r="6" fill="var(--viz-ok,#7d6200)"/>
  <text x="176" y="102" font-size="10" font-weight="700" fill="var(--viz-poor,#a8320f)">a symmetric model would follow this</text>
  <text x="120" y="242" font-size="10" font-weight="700" fill="var(--accent,#0a656d)">actual recovery — half as steep</text>
  <text x="372" y="150" font-size="10" font-weight="700" fill="var(--viz-ok,#7d6200)">−1.5%: gravity cancels the resistances</text>
  <text x="600" y="76" text-anchor="end" font-size="10" font-weight="700" fill="var(--accent,#0a656d)">climbing</text>
  <text x="24" y="296" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">The zero crossing is not at 0% gradient. A vehicle needs a slight descent before it stops drawing power at all, which is</text>
  <text x="24" y="312" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">why a rolling road costs more than its net elevation change suggests.</text>
</svg>

## Common Failure Patterns

**1. Negative edge weights reaching Dijkstra.** A regenerating segment has negative energy, and Dijkstra's correctness proof requires non-negative weights — with a negative edge it can finalise a node before finding a cheaper path to it. Shift the whole scale so the minimum is zero, and subtract the constant back out of the total afterwards.

```python
# The most negative any edge can be, computed once over the graph.
OFFSET_WH = 42.0

# Stored weight: never negative, so Dijkstra stays correct.
s.routing_wh = s.energy_wh + OFFSET_WH * (s.length_m / 1000.0)
# Reported total: the offset removed again, so the number means watt-hours.
total_wh = sum(routing_wh) - OFFSET_WH * (total_length_m / 1000.0)
```

**2. Speed taken from the speed limit rather than from expected flow.** Drag scales with the square of speed, so a segment costed at 130 km/h when traffic actually moves at 80 will report roughly two and a half times the aerodynamic component. Use the same expected-speed property the time-based cost uses, so the two models agree about the journey they are describing.

**3. One vehicle profile baked into the graph.** A van and a compact car differ by a factor of three in energy per kilometre, and writing `energy_wh` for one of them makes the graph unusable for the other. Store the geometry-derived quantities — `grade_pct`, `length_m`, expected speed — on the edge, and evaluate the vehicle-specific cost either at query time or into a per-profile property.

## Performance Notes

The arithmetic is trivial; where the cost lands is in the write. Annotating every segment in a continental graph is a property write per relationship, which grows the store and invalidates cached pages:

$$C_{\text{annotate}} \approx R \cdot \big(c_{\text{read}} + c_{\text{write}}\big)$$

For a graph with tens of millions of relationships that is a substantial batch job, and it is worth doing in resumable chunks with periodic commits rather than one transaction. It is also worth doing *only* for the profiles that are actually served: writing four vehicle profiles onto every edge quadruples the property count for a benefit that only materialises if all four get used.

The alternative — computing energy at query time from the stored gradient — avoids the write entirely, keeps the store small, and supports unlimited profiles. Its cost is that the expression is not index-seekable, so it cannot be used to prune and it must be evaluated per candidate edge during the search. For a Graph Data Science projection that is fine, because the property can be computed into the projection once at build time and the search then runs against a precomputed array. That is generally the best arrangement: geometry in the store, vehicle costs in the projection, and the projection [sized and dropped deliberately](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-memory-and-storage-tuning/tuning-jvm-heap-for-gds-projections/).

<svg viewBox="0 0 780 284" role="img" aria-labelledby="energyWhereTitle energyWhereDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="energyWhereTitle">Three places the vehicle cost can be evaluated, and what each one costs</title>
  <desc id="energyWhereDesc">A comparison of storing the energy cost as a property, computing it per query, and computing it once into a Graph Data Science projection. Storing it is fastest to read and cheapest at query time but adds a property per relationship per vehicle profile and has to be rewritten when anything changes. Computing per query costs nothing in store and supports unlimited profiles, but is evaluated on every candidate edge during the search and cannot prune. Computing into the projection pays once per projection build, supports a profile per projection, and lets the search run against a packed array.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="284" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Where to evaluate the vehicle-specific cost</text>
  <rect x="24" y="42" width="732" height="66" rx="9" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-ok,#7d6200)" stroke-width="1.5"/>
  <text x="44" y="64" font-size="11.5" font-weight="700" fill="var(--viz-ok,#7d6200)">stored as a relationship property</text>
  <text x="44" y="82" font-size="10" fill="var(--viz-ink-mute,#565f6d)">fastest read · one property per profile per edge · rewritten on every change</text>
  <rect x="500" y="54" width="230" height="20" rx="10" fill="var(--viz-ok,#7d6200)"/>
  <text x="615" y="69" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-on-pill,#ffffff)">store grows per profile</text>
  <text x="44" y="100" font-size="10" fill="var(--viz-ink-mute,#565f6d)">good when exactly one profile is served and the graph is stable</text>
  <rect x="24" y="118" width="732" height="66" rx="9" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-poor,#a8320f)" stroke-width="1.5"/>
  <text x="44" y="140" font-size="11.5" font-weight="700" fill="var(--viz-poor,#a8320f)">computed per query from grade_pct</text>
  <text x="44" y="158" font-size="10" fill="var(--viz-ink-mute,#565f6d)">no store cost · unlimited profiles · evaluated on every candidate edge</text>
  <rect x="500" y="130" width="230" height="20" rx="10" fill="var(--viz-poor,#a8320f)"/>
  <text x="615" y="145" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-on-pill,#ffffff)">not seekable, cannot prune</text>
  <text x="44" y="176" font-size="10" fill="var(--viz-ink-mute,#565f6d)">good for ad-hoc analysis, poor for a hot routing endpoint</text>
  <rect x="24" y="194" width="732" height="66" rx="9" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="1.8"/>
  <text x="44" y="216" font-size="11.5" font-weight="700" fill="var(--viz-good,#0a656d)">computed into the GDS projection at build time</text>
  <text x="44" y="234" font-size="10" fill="var(--viz-ink-mute,#565f6d)">paid once per projection · one profile per projection · search reads a packed array</text>
  <rect x="500" y="206" width="230" height="20" rx="10" fill="var(--viz-good,#0a656d)"/>
  <text x="615" y="221" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-on-pill,#ffffff)">store stays geometry-only</text>
  <text x="44" y="252" font-size="10" fill="var(--viz-ink-mute,#565f6d)">the usual answer for a service with a handful of profiles and a stable network</text>
</svg>

A word on validating the model rather than trusting it. Every constant above is an estimate, and the way to find out whether the estimate is any good is to compare predicted consumption against telemetry on trips that already happened. Summing `energy_wh` along a completed trip's segments and comparing with the battery delta the vehicle actually reported gives a per-trip ratio; plotting that ratio against the trip's total ascent separates the two failure modes cleanly. A ratio that is consistently off by a fixed factor means the mass or the drag estimate is wrong and a single scaling fixes it. A ratio that drifts with ascent means the gravity or regeneration handling is wrong, which is a structural problem no scaling will cure.

That comparison is also the honest way to set the regeneration efficiency, which is the constant with the widest range across vehicles and the one manufacturers are least specific about. Rather than picking a plausible number, fit it: the regeneration term only contributes on descending segments, so the residual between predicted and observed consumption on descent-heavy trips is almost entirely attributable to it. A few dozen trips is enough to pin it within a few points, and it is worth re-fitting seasonally, because cold weather moves it substantially.

## Related

- [Elevation and Terrain Enrichment for Routing Graphs](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/elevation-and-terrain-enrichment/) — where `grade_pct` comes from and how it is validated.
- [Grade-Aware Weights for Bicycle Routing](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/elevation-and-terrain-enrichment/grade-aware-weights-for-bicycle-routing/) — the same gradient with a very different cost curve.
- [Weighted Dijkstra Routing with Neo4j GDS](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/routing-algorithms-python/weighted-dijkstra-routing-with-neo4j-gds/) — the search these weights feed, and why they must stay non-negative.
- [Look-Ahead Corridors for In-Progress Trips](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/corridor-and-buffer-queries/look-ahead-corridors-for-in-progress-trips/) — using an energy budget as a range horizon.

This guide is part of [Elevation and Terrain Enrichment for Routing Graphs](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/elevation-and-terrain-enrichment/), within [Spatial Graph Construction & OSM Ingestion](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/).
