---
pageTitle: Grade-Aware Bicycle Weights
title: Grade-Aware Weights for Bicycle Routing
description: Derive a rider's speed on each gradient from a power model, add a rideability ceiling, and produce a directed weight that stops sending cyclists up walls.
slug: grade-aware-weights-for-bicycle-routing
type: article
breadcrumb: Bicycle Weights
datePublished: 2026-08-11
dateModified: 2026-08-11
---
# Grade-Aware Weights for Bicycle Routing

Cycling is the mode where a flat graph fails most visibly, because the cost of a hill to a rider is wildly non-linear and the shortest route in a hilly city is frequently the one nobody would take. A router weighting by distance sends a commuter over a twelve per cent ramp to save three hundred metres; one weighting by a fixed speed does the same thing, because it thinks the ramp takes the same time as the flat road beside it. The correction is not a penalty added to steep edges — it is a speed derived from the rider's available power against the gradient, plus a ceiling above which the edge stops being a road and becomes a push. This page builds both.

## Prerequisites & Versions

The model consumes `grade_pct` and `length_m` from the [elevation enrichment](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/elevation-and-terrain-enrichment/) and writes a directed weight.

| Requirement | Minimum version | Install |
| --- | --- | --- |
| Python | 3.11 | — |
| neo4j (async driver) | 5.20 | `pip install "neo4j>=5.20"` |
| Neo4j Server | 5.15 | directed relationships |

## Implementation

The rider is modelled as a constant sustainable power. Solving the power balance for speed on each gradient gives a per-edge duration, and a rideability ceiling converts anything steeper into a walking speed.

```python
import math
from dataclasses import dataclass

G = 9.80665
AIR_DENSITY = 1.225


@dataclass(frozen=True)
class Rider:
    """A rider plus bike, described by the numbers that change the answer."""
    mass_kg: float = 88.0                 # rider plus bike plus load
    sustainable_w: float = 165.0          # power held for the length of a commute
    frontal_area_m2: float = 0.42
    drag_coefficient: float = 1.0
    rolling_resistance: float = 0.005
    drivetrain_efficiency: float = 0.97
    max_speed_mps: float = 12.0           # comfort and braking limit on descents
    push_grade_pct: float = 14.0          # above this, most riders dismount
    push_speed_mps: float = 1.1           # pushing a bike uphill


def speed_on_grade(rider: Rider, grade_pct: float) -> float:
    """Steady-state speed where available power equals the power demanded.

    P = (F_roll + F_grav + F_drag) · v, and F_drag itself depends on v², so this
    is a cubic in v. Bisection is used rather than a closed form because it is
    trivially robust across the sign change at the top of a descent, where the
    gravity term becomes a power SOURCE and the cubic's roots move.
    """
    if grade_pct >= rider.push_grade_pct:
        # Not a riding speed at all — the rider is walking, and no power model
        # describes that. Returning the walk speed keeps the cost finite and
        # honest instead of producing an absurdly slow "ride".
        return rider.push_speed_mps

    theta = math.atan(grade_pct / 100.0)
    available_w = rider.sustainable_w * rider.drivetrain_efficiency

    def net_power_at(v: float) -> float:
        roll = rider.rolling_resistance * rider.mass_kg * G * math.cos(theta)
        grav = rider.mass_kg * G * math.sin(theta)
        drag = 0.5 * AIR_DENSITY * rider.drag_coefficient * rider.frontal_area_m2 * v * v
        return available_w - (roll + grav + drag) * v

    lo, hi = 0.05, 25.0
    if net_power_at(hi) > 0:              # freewheeling faster than the ceiling
        return rider.max_speed_mps
    for _ in range(60):
        mid = (lo + hi) / 2
        if net_power_at(mid) > 0:
            lo = mid
        else:
            hi = mid
    return min((lo + hi) / 2, rider.max_speed_mps)


def edge_seconds(rider: Rider, length_m: float, grade_pct: float) -> float:
    return length_m / max(speed_on_grade(rider, grade_pct), 0.05)


WRITE_WEIGHTS = """
UNWIND $batch AS row
MATCH ()-[s:SEGMENT {id: row.id}]->()
SET s.bike_s = row.seconds, s.bike_rideable = row.rideable
RETURN count(s) AS updated
"""
```

## How It Works

Three things make this behave like cycling rather than like arithmetic.

**Speed comes out of the model; it is not an input.** Given a rider's sustainable power, the speed on a gradient is whatever makes demanded power equal available power. On the flat that lands around 22 km/h for the default rider; at six per cent it falls to about 8 km/h; at ten per cent to under 5. Those ratios are what make a hill expensive — a 300-metre climb at ten per cent costs more than a kilometre of flat, which is the trade a router has to be able to see.

**The push threshold is a discontinuity, and modelling it as one is correct.** Above roughly twelve to fourteen per cent, most riders on a commuting bike get off and walk. That is not a slightly slower ride; it is a different activity with a speed that does not depend on gradient at all. A continuous power model extrapolated into that range predicts riding speeds of 2 km/h that nobody experiences, and — worse — makes a twenty per cent ramp merely four times as expensive as a ten per cent one, when in practice the first is a wall and the second is a hill.

**Descents are capped by comfort, not by physics.** The power balance on a steep descent has a solution around 90 km/h; no commuter rides it. `max_speed_mps` is the ceiling that makes descents cheap without making them free, and it is what stops the router from routing *over* a hill to enjoy the way down.

<svg viewBox="0 0 780 316" role="img" aria-labelledby="bikeSpeedTitle bikeSpeedDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="bikeSpeedTitle">Rider speed against gradient, with the two ceilings that bound it</title>
  <desc id="bikeSpeedDesc">Speed plotted against gradient for a rider holding 165 watts. On descents the physical solution rises past 60 kilometres per hour but is capped by a comfort ceiling at about 43. On the flat the rider holds roughly 22 kilometres per hour. Climbing, speed falls steeply: about 13 at three per cent, 8 at six, and under 5 at ten. At 14 per cent the curve stops entirely and is replaced by a walking speed of about 4 kilometres per hour, because above that gradient most riders dismount — a discontinuity that a continuous model would smooth over and get wrong in both directions.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="316" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Speed against gradient — rider holding 165 W</text>
  <line x1="96" y1="48" x2="96" y2="228" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <line x1="96" y1="228" x2="720" y2="228" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <g font-size="9.5" fill="var(--viz-ink-mute,#565f6d)" text-anchor="end">
    <text x="88" y="60">50</text><text x="88" y="102">40</text><text x="88" y="144">25</text><text x="88" y="186">12</text><text x="88" y="232">0</text>
  </g>
  <text x="44" y="146" font-size="10" font-weight="700" fill="currentColor" transform="rotate(-90 44 146)">km/h</text>
  <g font-size="9.5" fill="var(--viz-ink-mute,#565f6d)" text-anchor="middle">
    <text x="96" y="248">−10%</text><text x="252" y="248">−4%</text><text x="370" y="248">0%</text><text x="486" y="248">+5%</text><text x="604" y="248">+10%</text><text x="720" y="248">+18%</text>
  </g>
  <text x="408" y="268" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">gradient</text>
  <line x1="96" y1="96" x2="370" y2="96" stroke="var(--viz-ok,#7d6200)" stroke-width="1.6" stroke-dasharray="6 4"/>
  <text x="110" y="90" font-size="9.5" font-weight="700" fill="var(--viz-ok,#7d6200)">comfort ceiling — the physical solution is far above this</text>
  <path d="M96 96 L200 96 L252 100 L310 122 L370 150 L430 174 L486 190 L546 204 L604 213 L650 218" fill="none" stroke="var(--accent,#0a656d)" stroke-width="2.8"/>
  <line x1="650" y1="48" x2="650" y2="228" stroke="var(--viz-poor,#a8320f)" stroke-width="1.6" stroke-dasharray="5 4"/>
  <text x="658" y="66" font-size="10" font-weight="700" fill="var(--viz-poor,#a8320f)">14% — riders dismount</text>
  <line x1="650" y1="222" x2="720" y2="222" stroke="var(--viz-poor,#a8320f)" stroke-width="2.8"/>
  <text x="686" y="212" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--viz-poor,#a8320f)">pushing</text>
  <circle cx="370" cy="150" r="5" fill="var(--accent,#0a656d)"/>
  <text x="380" y="146" font-size="9.5" font-weight="700" fill="var(--accent,#0a656d)">flat: 22 km/h</text>
  <circle cx="486" cy="190" r="5" fill="var(--accent,#0a656d)"/>
  <text x="496" y="186" font-size="9.5" font-weight="700" fill="var(--accent,#0a656d)">5%: 9 km/h</text>
  <text x="24" y="296" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">The steep part of this curve is between zero and six per cent, which is why a route planner that treats gradient as a</text>
  <text x="24" y="312" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">small linear penalty gets ordinary city hills wrong long before it gets mountains wrong.</text>
</svg>

## Common Failure Patterns

**1. A single "avoid hills" multiplier.** Multiplying the flat cost by a factor derived from gradient keeps the ordering of routes almost unchanged, because it scales everything in the same direction. What changes route choice is the *ratio* between a steep short option and a flat long one, and only a speed model produces that ratio correctly. The tell is a router that still picks the ramp when the multiplier is small and refuses every gentle rise when it is large.

**2. Applying the rider's power to a descent.** Adding available power to a descent's already-negative resistance produces speeds bounded only by drag — 70 km/h and upward on a steep hill. Riders coast. Capping at a comfort speed is not an approximation of the physics; it is a better model of the behaviour.

```python
# WRONG: solves the power balance in both directions, and believes the answer.
speed = solve_power_balance(rider, grade_pct)

# RIGHT: the same solve, bounded by what a commuter will actually do.
speed = min(solve_power_balance(rider, grade_pct), rider.max_speed_mps)
```

**3. One rider profile for everyone.** The default above describes an unhurried commuter. A courier with 260 W and a cargo rider at 140 kg with 150 W experience the same city completely differently, and a route optimal for one is unusable for the other. Because the weight is derived rather than measured, generating a weight per profile is cheap — but it should be a deliberate set of profiles rather than a single average that fits nobody.

## Performance Notes

The bisection costs about sixty iterations of a handful of floating-point operations, which sounds wasteful and is not: it is roughly a microsecond, and it happens once per edge per profile at build time rather than per query. Precomputing a lookup table over gradient in quarter-per-cent steps and interpolating between entries reduces it further, and for a graph with tens of millions of edges that is worth doing — the table has a few hundred entries and covers every gradient a road can have.

$$t_{\text{edge}} = \frac{\ell}{v(\gamma)}, \qquad v(\gamma) \text{ solved once per } \gamma \text{ bucket}$$

Because the weight is directional, a two-way road needs both relationships weighted, and it is worth asserting that both were written — a half-completed pass leaves the graph preferring whichever direction still carries the stale, cheaper flat cost, which produces routes that go the long way round a hill in one direction and straight over it in the other.

The rideability flag is worth storing separately from the weight rather than folding into it. A router that must never send a rider onto an unrideable segment wants a hard filter, and a filter on a stored boolean is index-friendly in a way that a threshold on a derived cost is not. It also lets the same graph serve a "prefer rideable" and a "rideable only" profile without recomputing anything.

<svg viewBox="0 0 780 288" role="img" aria-labelledby="bikeRouteTitle bikeRouteDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="bikeRouteTitle">The route flips once the weight comes from a speed model</title>
  <desc id="bikeRouteDesc">Two options between the same pair of points. The direct route is 1.9 kilometres with a 340 metre ramp at eleven per cent; the flat route around the hill is 2.6 kilometres with negligible gradient. Weighted by distance the direct route wins by 700 metres. Weighted by a fixed cycling speed it still wins, because a fixed speed cannot see the ramp. Weighted by speed derived from gradient the ramp alone costs four and a half minutes against the flat route's total of seven, and the longer way round becomes the faster one — which is the route a rider familiar with the city would already have taken.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="288" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Same origin and destination, two options</text>
  <rect x="24" y="42" width="732" height="96" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.2"/>
  <circle cx="72" cy="106" r="8" fill="var(--accent,#0a656d)"/>
  <circle cx="708" cy="106" r="8" fill="var(--accent,#0a656d)"/>
  <path d="M72 106 L300 64 L470 64 L708 106" fill="none" stroke="var(--viz-poor,#a8320f)" stroke-width="2.6"/>
  <text x="385" y="56" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-poor,#a8320f)">direct — 1.9 km, 340 m ramp at 11%</text>
  <path d="M72 106 L280 132 L500 132 L708 106" fill="none" stroke="var(--viz-good,#0a656d)" stroke-width="2.6"/>
  <text x="390" y="150" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-good,#0a656d)">around — 2.6 km, flat</text>
  <text x="24" y="182" font-size="11" font-weight="700" fill="currentColor">weighted by distance</text>
  <g font-size="10.5" font-weight="700" text-anchor="middle">
    <rect x="270" y="168" width="130" height="22" rx="11" fill="var(--viz-poor,#a8320f)"/><text x="335" y="184" fill="var(--viz-on-pill,#ffffff)">direct</text>
  </g>
  <text x="416" y="184" font-size="10" fill="var(--viz-ink-mute,#565f6d)">700 m shorter, and unrideable for many riders</text>
  <text x="24" y="216" font-size="11" font-weight="700" fill="currentColor">weighted at a fixed 18 km/h</text>
  <g font-size="10.5" font-weight="700" text-anchor="middle">
    <rect x="270" y="202" width="130" height="22" rx="11" fill="var(--viz-poor,#a8320f)"/><text x="335" y="218" fill="var(--viz-on-pill,#ffffff)">direct</text>
  </g>
  <text x="416" y="218" font-size="10" fill="var(--viz-ink-mute,#565f6d)">a constant speed cannot see the ramp at all</text>
  <text x="24" y="250" font-size="11" font-weight="700" fill="currentColor">weighted by speed on grade</text>
  <g font-size="10.5" font-weight="700" text-anchor="middle">
    <rect x="270" y="236" width="130" height="22" rx="11" fill="var(--viz-good,#0a656d)"/><text x="335" y="252" fill="var(--viz-on-pill,#ffffff)">around</text>
  </g>
  <text x="416" y="252" font-size="10" fill="var(--viz-ink-mute,#565f6d)">the ramp alone costs 4.5 min; the whole flat route costs 7</text>
  <text x="24" y="280" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">Only the third model produces the route a rider who knows the city would have chosen unprompted.</text>
</svg>

Finally, a note on what this model deliberately does not include. Surface, traffic, junction delay and the presence of a cycle lane all affect a rider's route choice at least as much as gradient does, and none of them is here. That is not an oversight — it is a separation of concerns. Gradient produces a *duration*, which is a physical quantity with a defensible model behind it, and the other factors produce a *preference*, which is a weighting on top of that duration and varies by rider far more than the physics does. Mixing them into one number makes both untunable: nobody can say afterwards whether a route was chosen because the hill was steep or because the surface was bad.

The arrangement that stays maintainable is to keep `bike_s` as the honest time estimate and apply comfort preferences as a separate multiplier at query time. A nervous rider can then weight busy roads at 2.5× and a confident commuter at 1.1×, both against the same underlying durations, and the reported journey time stays the real one rather than the weighted one. It also means an improvement to the gradient model benefits every profile at once, which is not true if each profile has folded its own assumptions into a single blended weight.

## Related

- [Elevation and Terrain Enrichment for Routing Graphs](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/elevation-and-terrain-enrichment/) — the gradient this model consumes, and how it is validated.
- [Computing Edge Grade and Energy Cost](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/elevation-and-terrain-enrichment/computing-edge-grade-and-energy-cost/) — the same gradient under a vehicle's very different cost curve.
- [Implementing A* with a Haversine Heuristic in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/routing-algorithms-python/implementing-astar-with-a-haversine-heuristic-in-python/) — why a time-valued weight needs a time-valued heuristic.
- [Turn-Restriction and Time-Dependent Routing](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/turn-restriction-and-time-dependent-routing/) — the other reason a two-way road needs two directed edges.

This guide is part of [Elevation and Terrain Enrichment for Routing Graphs](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/elevation-and-terrain-enrichment/), within [Spatial Graph Construction & OSM Ingestion](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/).
