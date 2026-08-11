---
pageTitle: Corridor & Buffer Queries
title: Corridor and Buffer Queries Along a Route
description: Find what lies within a distance of a whole route rather than a point, without buffering the geometry or scanning the label once per segment.
slug: corridor-and-buffer-queries
type: article
breadcrumb: Corridor & Buffer
datePublished: 2026-08-11
dateModified: 2026-08-11
---
# Corridor and Buffer Queries Along a Route

"Which charging stations are within two kilometres of this route" is a different question from "which are within two kilometres of this point", and the difference is not a detail. A point query is one index seek. A route query is the union of a seek per segment, and a long-distance route has thousands of segments — so the obvious implementation issues thousands of queries, returns the same station once per nearby segment, and takes long enough that the feature ships with a spinner. The version that works treats the corridor as one shape rather than as a sequence of circles, resolves it with a single bounded seek per envelope rather than per segment, and does the exact perpendicular distance only on what survives. This topic covers that shape, and the ranking question that always follows it: not "what is near the route" but "what costs least to divert to".

## Prerequisites

The geometry is client-side Python; the seeks are ordinary point-index range predicates.

| Requirement | Minimum version | Install |
| --- | --- | --- |
| Python | 3.11 | — |
| neo4j (async driver) | 5.20 | `pip install "neo4j>=5.20"` |
| Neo4j Server | 5.15 | native `point`, `POINT INDEX` |
| shapely | 2.0 | `pip install "shapely>=2.0"` (optional, for exact clipping) |

## Core Concept & Mechanism

A corridor is a route polyline widened by a radius. Three ways of resolving it exist, and they differ by orders of magnitude.

**Per-segment radius queries** are the naive form: for each segment, seek everything within the radius of its midpoint, then union. It is correct if the radius exceeds half the segment length — otherwise it leaves gaps between the circles — and it costs one seek per segment. On a 400-segment urban route that is 400 round trips, and the deduplication happens client-side over a result set several times larger than the answer.

**One envelope for the whole route** is the opposite extreme: take the route's bounding box, expand it by the radius, and seek that once. It is a single query, and on a straight route it is close to optimal. On a route that turns — an L-shaped city crossing, or anything with a detour — the envelope covers vast areas the corridor does not, and the exact distance filter then has to reject nearly everything the seek returned.

**Envelope per chunk** is what works in practice. Split the polyline into runs of segments that stay within one compact bounding box, seek each chunk's expanded envelope, and clip the union with an exact perpendicular distance to the polyline. The chunk count is set by the route's shape rather than by its segment count — a straight motorway run is one chunk however many segments it has, and a winding urban route is a few dozen. That is the difference between thousands of queries and tens.

<svg viewBox="0 0 780 320" role="img" aria-labelledby="corrShapeTitle corrShapeDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="corrShapeTitle">Three ways to cover a corridor, and how much ground each one reads</title>
  <desc id="corrShapeDesc">An L-shaped route with a two-kilometre corridor around it, resolved three ways. A circle per segment covers the corridor accurately but needs one seek per segment and overlaps heavily, so the same candidate is returned many times. A single envelope around the whole route is one seek but covers a large rectangle including the entire area inside the L, which the corridor does not touch, so the exact filter rejects most of what it reads. Chunked envelopes follow the route's shape with a handful of boxes, reading a little more than the corridor and far less than the bounding box.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="320" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">One L-shaped route, one 2 km corridor</text>
  <rect x="24" y="42" width="236" height="212" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-ok,#7d6200)" stroke-width="1.6"/>
  <text x="142" y="66" text-anchor="middle" font-size="11" font-weight="700" fill="var(--viz-ok,#7d6200)">circle per segment</text>
  <g fill="var(--viz-ok,#7d6200)" opacity="0.16">
    <circle cx="66" cy="96" r="22"/><circle cx="88" cy="96" r="22"/><circle cx="110" cy="96" r="22"/><circle cx="132" cy="96" r="22"/>
    <circle cx="154" cy="96" r="22"/><circle cx="176" cy="96" r="22"/><circle cx="198" cy="96" r="22"/>
    <circle cx="198" cy="118" r="22"/><circle cx="198" cy="140" r="22"/><circle cx="198" cy="162" r="22"/><circle cx="198" cy="184" r="22"/>
  </g>
  <path d="M66 96 H198 V196" fill="none" stroke="var(--viz-ok,#7d6200)" stroke-width="2.6"/>
  <text x="142" y="228" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">400 seeks · heavy re-return</text>
  <text x="142" y="244" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-ok,#7d6200)">accurate, unaffordable</text>
  <rect x="272" y="42" width="236" height="212" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-poor,#a8320f)" stroke-width="1.6"/>
  <text x="390" y="66" text-anchor="middle" font-size="11" font-weight="700" fill="var(--viz-poor,#a8320f)">one envelope</text>
  <rect x="292" y="74" width="196" height="144" fill="var(--viz-poor,#a8320f)" opacity="0.14"/>
  <rect x="292" y="74" width="196" height="144" fill="none" stroke="var(--viz-poor,#a8320f)" stroke-width="1.8"/>
  <path d="M314 96 H446 V196" fill="none" stroke="var(--viz-poor,#a8320f)" stroke-width="2.6"/>
  <text x="366" y="160" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--viz-poor,#a8320f)">read, not in the corridor</text>
  <text x="390" y="228" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">1 seek · most rows rejected</text>
  <text x="390" y="244" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-poor,#a8320f)">cheap query, expensive filter</text>
  <rect x="520" y="42" width="236" height="212" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="1.8"/>
  <text x="638" y="66" text-anchor="middle" font-size="11" font-weight="700" fill="var(--viz-good,#0a656d)">chunked envelopes</text>
  <g fill="var(--viz-good,#0a656d)" opacity="0.16">
    <rect x="540" y="76" width="56" height="40"/><rect x="600" y="76" width="52" height="40"/><rect x="656" y="76" width="48" height="40"/>
    <rect x="666" y="120" width="40" height="44"/><rect x="666" y="168" width="40" height="48"/>
  </g>
  <g fill="none" stroke="var(--viz-good,#0a656d)" stroke-width="1.5">
    <rect x="540" y="76" width="56" height="40"/><rect x="600" y="76" width="52" height="40"/><rect x="656" y="76" width="48" height="40"/>
    <rect x="666" y="120" width="40" height="44"/><rect x="666" y="168" width="40" height="48"/>
  </g>
  <path d="M562 96 H694 V196" fill="none" stroke="var(--viz-good,#0a656d)" stroke-width="2.6"/>
  <text x="638" y="228" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">5 seeks · little waste</text>
  <text x="638" y="244" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-good,#0a656d)">chunk count follows shape, not length</text>
  <text x="24" y="284" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">The middle panel is the one that gets shipped, because it is a single query and looks efficient. Its cost is hidden in the</text>
  <text x="24" y="300" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">filter above the seek, where PROFILE shows a healthy index seek handing tens of thousands of rows to a distance test.</text>
</svg>

## Schema & Data Model

Nothing special is needed on the candidate label beyond a point index, but the route representation matters.

```cypher
// Candidates: an ordinary point index is all the corridor seek needs.
CREATE POINT INDEX station_location IF NOT EXISTS
FOR (s:ChargingStation) ON (s.location);

// A composite where corridor queries are always scoped by operator or network.
CREATE INDEX station_network_location IF NOT EXISTS
FOR (s:ChargingStation) ON (s.network_id, s.location);
```

The route itself should be available as an ordered coordinate list, not only as a chain of graph relationships. A corridor query needs the geometry, and re-walking `(:Junction)-[:SEGMENT*]->(:Junction)` to rebuild a polyline for every corridor request is a traversal that produces something the caller already had. Store the polyline on the trip or hand it in with the request; the graph is for routing, and the corridor is a geometric operation over the route the routing produced.

## Step-by-Step Implementation

**1. Chunk the polyline into compact runs.** A greedy pass that starts a new chunk whenever the running bounding box would exceed a target diagonal produces chunks that follow the route's shape.

```python
import math
from dataclasses import dataclass

EARTH_R = 6_371_008.8


@dataclass(frozen=True)
class Box:
    min_lat: float
    min_lon: float
    max_lat: float
    max_lon: float

    def expanded(self, metres: float) -> "Box":
        """Grow by a ground distance, correcting longitude for latitude.

        Using a fixed degree offset here is the single most common corridor bug:
        it over-widens near the equator and under-widens near the poles, so a
        service that works in one region silently misses candidates in another.
        """
        d_lat = metres / (math.pi / 180 * EARTH_R)
        mid_lat = (self.min_lat + self.max_lat) / 2
        d_lon = d_lat / max(math.cos(math.radians(mid_lat)), 1e-6)
        return Box(
            min_lat=max(self.min_lat - d_lat, -90.0),
            min_lon=self.min_lon - d_lon,
            max_lat=min(self.max_lat + d_lat, 90.0),
            max_lon=self.max_lon + d_lon,
        )

    @property
    def diagonal_m(self) -> float:
        return _haversine(self.min_lat, self.min_lon, self.max_lat, self.max_lon)


def _haversine(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_R * math.asin(math.sqrt(a))


def chunk_route(
    polyline: list[tuple[float, float]], max_diagonal_m: float = 12_000
) -> list[tuple[Box, list[tuple[float, float]]]]:
    """Greedy runs whose bounding box stays compact.

    The chunk count tracks how much the route TURNS, not how long it is: a
    motorway run of 300 segments is one chunk, and a winding city crossing of
    the same length is a dozen.
    """
    chunks: list[tuple[Box, list[tuple[float, float]]]] = []
    current: list[tuple[float, float]] = []

    def box_of(points: list[tuple[float, float]]) -> Box:
        lats = [p[0] for p in points]
        lons = [p[1] for p in points]
        return Box(min(lats), min(lons), max(lats), max(lons))

    for point in polyline:
        candidate = current + [point]
        if len(candidate) > 1 and box_of(candidate).diagonal_m > max_diagonal_m:
            chunks.append((box_of(current), current))
            current = [current[-1], point]  # overlap by one so the corridor is continuous
        else:
            current = candidate
    if len(current) > 1:
        chunks.append((box_of(current), current))
    return chunks
```

**2. Seek each chunk's expanded envelope.** One parameterised query, issued once per chunk, so the plan is compiled once and reused.

```cypher
MATCH (s:ChargingStation)
WHERE s.location.latitude  >= $min_lat AND s.location.latitude  <= $max_lat
  AND s.location.longitude >= $min_lon AND s.location.longitude <= $max_lon
RETURN s.id AS id, s.location.latitude AS lat, s.location.longitude AS lon;
```

**3. Clip with an exact perpendicular distance.** The envelope is square and the corridor is not, so the final filter is a point-to-polyline distance — clamped to the segment, exactly as in [snapping GPS telemetry to road segments](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/spatial-join-techniques/snapping-gps-telemetry-to-road-segments/), because the nearest point on a segment is frequently neither of its endpoints.

## Query Patterns & Variants

**Corridor with a one-sided width.** A corridor around a one-way road is often asymmetric — services on the far carriageway are not reachable without a U-turn. Signing the perpendicular offset by the segment's bearing separates the two sides, and the filter keeps only the half that matters.

**Corridor restricted to the remaining route.** For an in-progress trip, the useful question is what lies ahead, not what has been passed. Clipping the polyline at the vehicle's current position before chunking turns a whole-route corridor into a look-ahead one and roughly halves the work on average.

**Corridor as an exclusion.** The same machinery answers "which of our depots is *not* near any planned route", which is a coverage question rather than a proximity one. Run the corridor to build the near-set, then subtract — cheaper than testing each depot against every route.

## Performance Tuning

The cost has two terms, and chunking is the lever on the ratio between them:

$$C \approx K \cdot \big(\log N + \rho \cdot A_{\text{chunk}}\big) + M \cdot c_{\text{exact}}$$

$K$ is the chunk count, $A_{\text{chunk}}$ the area of each expanded envelope, $\rho$ the candidate density and $M$ the rows surviving to the exact test. Fewer, larger chunks reduce $K$ and inflate $A_{\text{chunk}}$; more, smaller chunks do the reverse. The minimum is broad, which is good news — anything in the region of a ten-to-twenty-kilometre chunk diagonal behaves similarly on real routes, and the setting is not worth agonising over.

What *is* worth attention is the overlap. Chunks must share an endpoint, or the corridor has gaps at the joins, and candidates near a join are returned by both neighbours. Deduplicating on the candidate id before the exact test — not after — avoids computing the same perpendicular distance twice, and on a route with many chunks that is a measurable fraction of the total.

Issue the chunk queries concurrently, bounded by the same semaphore discipline the [async ingestion path](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/async-batch-processing-for-graphs/) uses. They are independent reads and there is no reason to serialise them, but an unbounded fan-out over a long route will exhaust the connection pool exactly as a write fan-out would.

<svg viewBox="0 0 780 296" role="img" aria-labelledby="corrChunkTitle corrChunkDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="corrChunkTitle">Chunk size trades seek count against wasted envelope area</title>
  <desc id="corrChunkDesc">Total corridor cost plotted against chunk diagonal for a typical mixed urban and motorway route. With very small chunks the seek count dominates and the cost is high. With very large chunks each envelope covers far more ground than the corridor, so the exact distance filter has to reject most of what the seeks return, and the cost rises again. Between roughly eight and twenty-five kilometres the curve is nearly flat, which means the setting does not need to be precise — only inside the range.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="296" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Corridor cost against chunk diagonal</text>
  <line x1="96" y1="48" x2="96" y2="208" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <line x1="96" y1="208" x2="720" y2="208" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <g font-size="9.5" fill="var(--viz-ink-mute,#565f6d)" text-anchor="middle">
    <text x="96" y="228">1 km</text><text x="252" y="228">5 km</text><text x="408" y="228">15 km</text><text x="564" y="228">40 km</text><text x="720" y="228">100 km</text>
  </g>
  <text x="408" y="248" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">chunk diagonal</text>
  <text x="44" y="128" font-size="10" font-weight="700" fill="currentColor" transform="rotate(-90 44 128)">total cost</text>
  <path d="M96 60 L170 106 L252 142 L330 158 L408 160 L486 156 L564 134 L642 96 L720 56" fill="none" stroke="var(--accent,#0a656d)" stroke-width="2.8"/>
  <rect x="290" y="48" width="236" height="160" fill="var(--viz-good,#0a656d)" opacity="0.1"/>
  <text x="408" y="188" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--viz-good,#0a656d)">flat between ~8 and ~25 km</text>
  <text x="140" y="88" font-size="10" font-weight="700" fill="var(--viz-poor,#a8320f)">seek count dominates</text>
  <text x="560" y="80" text-anchor="end" font-size="10" font-weight="700" fill="var(--viz-poor,#a8320f)">wasted envelope dominates</text>
  <text x="24" y="276" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">A broad minimum is worth knowing about: it means this is a setting to pick once from the route mix and then leave alone.</text>
</svg>

## Edge Cases & Gotchas

- **A fixed degree offset instead of a latitude-corrected one.** Expanding an envelope by a constant number of degrees produces a corridor that is the intended width at one latitude and wrong everywhere else — too wide near the equator, too narrow near the poles. The `expanded` helper above divides the longitude offset by `cos(lat)` for exactly this reason.
- **Chunks that do not overlap.** A chunk boundary with no shared vertex leaves a wedge of corridor covered by neither envelope, and a candidate sitting in it is silently missed. Always carry the last point of one chunk into the next.
- **Corridors crossing the antimeridian.** An envelope whose longitude range wraps produces `min > max` and matches nothing. The same range-splitting used for a [bounding-box search across the antimeridian](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/bounding-box-search-across-the-antimeridian/) applies unchanged.
- **Distance to the polyline, not to its vertices.** Testing against route vertices misses anything nearest to the middle of a long segment, which on a motorway is most of the corridor. Clamp the projection to the segment.
- **Near the route is not the same as reachable from it.** A station on the far side of a motorway barrier is a hundred metres away and a ten-kilometre diversion. Where that matters, the corridor is a candidate generator and the real ranking is a routing question.
- **Very long routes need a bound on the answer, not just on the query.** A continental corridor at two kilometres will match tens of thousands of candidates, and returning all of them is rarely useful. Rank and limit server-side or the response becomes the bottleneck.


<svg viewBox="0 0 780 292" role="img" aria-labelledby="corrVertexTitle corrVertexDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="corrVertexTitle">Distance to the vertices is not distance to the route</title>
  <desc id="corrVertexDesc">A long motorway segment between two junctions with a candidate beside its midpoint. Measured to the nearest route vertex the candidate is 4.1 kilometres away and falls outside a 2 kilometre corridor; measured to the segment itself, with the projection clamped between the endpoints, it is 900 metres away and clearly inside. On motorway geometry, where consecutive vertices can be many kilometres apart, most of the corridor lies nearer to the middle of a segment than to either of its ends — so a vertex test silently excludes the majority of it.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="292" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Measure to the segment, not to its endpoints</text>
  <rect x="24" y="42" width="732" height="180" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.2"/>
  <rect x="72" y="96" width="640" height="60" fill="var(--accent,#0a656d)" opacity="0.1"/>
  <text x="88" y="112" font-size="9.5" font-weight="700" fill="var(--accent,#0a656d)">2 km corridor</text>
  <line x1="72" y1="126" x2="712" y2="126" stroke="var(--accent,#0a656d)" stroke-width="3"/>
  <circle cx="72" cy="126" r="8" fill="var(--accent,#0a656d)"/>
  <circle cx="712" cy="126" r="8" fill="var(--accent,#0a656d)"/>
  <text x="72" y="152" text-anchor="middle" font-size="10" font-weight="700" fill="var(--accent,#0a656d)">junction</text>
  <text x="712" y="152" text-anchor="middle" font-size="10" font-weight="700" fill="var(--accent,#0a656d)">junction</text>
  <text x="392" y="172" text-anchor="middle" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">8.2 km between vertices — ordinary on a motorway</text>
  <circle cx="392" cy="80" r="7" fill="var(--viz-good,#0a656d)"/>
  <text x="406" y="70" font-size="10.5" font-weight="700" fill="var(--viz-good,#0a656d)">candidate</text>
  <line x1="392" y1="87" x2="392" y2="120" stroke="var(--viz-good,#0a656d)" stroke-width="2"/>
  <text x="336" y="106" text-anchor="end" font-size="10" font-weight="700" fill="var(--viz-good,#0a656d)">900 m</text>
  <line x1="385" y1="78" x2="86" y2="120" stroke="var(--viz-poor,#a8320f)" stroke-width="1.6" stroke-dasharray="6 4"/>
  <line x1="399" y1="78" x2="698" y2="120" stroke="var(--viz-poor,#a8320f)" stroke-width="1.6" stroke-dasharray="6 4"/>
  <text x="200" y="86" font-size="10" font-weight="700" fill="var(--viz-poor,#a8320f)">4.1 km to a vertex</text>
  <text x="24" y="250" font-size="11" font-weight="700" fill="var(--viz-poor,#a8320f)">vertex test</text>
  <g font-size="10.5" font-weight="700" text-anchor="middle">
    <rect x="140" y="236" width="150" height="22" rx="11" fill="var(--viz-poor,#a8320f)"/><text x="215" y="252" fill="var(--viz-on-pill,#ffffff)">4.1 km — excluded</text>
  </g>
  <text x="24" y="278" font-size="11" font-weight="700" fill="var(--viz-good,#0a656d)">clamped projection</text>
  <g font-size="10.5" font-weight="700" text-anchor="middle">
    <rect x="140" y="264" width="150" height="22" rx="11" fill="var(--viz-good,#0a656d)"/><text x="215" y="280" fill="var(--viz-on-pill,#ffffff)">900 m — included</text>
  </g>
  <text x="310" y="252" font-size="10" fill="var(--viz-ink-mute,#565f6d)">and the corridor loses most of its own area</text>
  <text x="310" y="280" font-size="10" fill="var(--viz-ink-mute,#565f6d)">the answer the geometry actually gives</text>
</svg>

## Verification & Testing

Two invariants catch the defects that matter, and both are cheap.

```python
import pytest


def test_chunks_cover_the_polyline_without_gaps():
    """Consecutive chunks must share a vertex, or the corridor has holes."""
    route = [(51.50 + i * 0.004, -0.12 + i * 0.006) for i in range(200)]
    chunks = chunk_route(route, max_diagonal_m=12_000)
    for earlier, later in zip(chunks, chunks[1:]):
        assert earlier[1][-1] == later[1][0], "chunk boundary is not shared"
    assert chunks[0][1][0] == route[0]
    assert chunks[-1][1][-1] == route[-1]


def test_envelope_expansion_is_latitude_corrected():
    """The same metre width must survive a change of latitude."""
    equator = Box(0.0, 0.0, 0.01, 0.01).expanded(2_000)
    northern = Box(60.0, 0.0, 60.01, 0.01).expanded(2_000)
    eq_width = equator.max_lon - equator.min_lon
    north_width = northern.max_lon - northern.min_lon
    # A degree of longitude is half as wide at 60°, so the box must be ~2× wider.
    assert 1.8 < north_width / eq_width < 2.2
```

The first test is the one that matters most in production, because a gap at a chunk join produces a *missing* result rather than a wrong one — nothing errors, the response is simply short, and the only way to notice is to compare against a slower implementation.

## FAQ

<details>
<summary>Why not use a real geometry buffer and a spatial containment test?</summary>

Because Neo4j's native spatial support is points, not polygons — there is no server-side buffer or containment predicate to seek against. Computing a buffer polygon client-side and testing containment per row means shipping every candidate to the client anyway, which is the cost the envelope seek exists to avoid. If a polygon-native database is already in the stack, doing the corridor there and joining on ids is a legitimate architecture; doing it inside the graph is not.
</details>

<details>
<summary>How wide should the corridor be?</summary>

Wide enough to include what a driver would actually divert to, which is a product question rather than a geometric one. Two kilometres is a common default for fuel and charging; a hundred metres is right for "what is on this street". The width matters more than it looks, because the candidate count grows roughly linearly with it and the exact-distance cost grows with the candidate count.
</details>

<details>
<summary>Should the corridor query run per request or be precomputed?</summary>

Per request, unless the routes themselves are fixed. Precomputing a corridor means precomputing a route, and routes change with traffic, restrictions and the vehicle. Fixed scheduled services — a bus line, a daily trunk run — are the exception, and there the corridor is stable enough to store like any other derived set.
</details>

<details>
<summary>Can I rank candidates by diversion cost instead of by distance?</summary>

Yes, and it is almost always the better ranking. Perpendicular distance is a proxy; the real cost is the extra driving time to reach the candidate and return to the route, which is two short routing queries per candidate. Use the corridor to reduce thousands of candidates to tens, then rank those properly — that ordering is what [ranking detour cost](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/corridor-and-buffer-queries/ranking-detour-cost-for-corridor-candidates/) works through.
</details>

<details>
<summary>Does the chunking break if the route doubles back on itself?</summary>

No, but it does produce overlapping envelopes, and the same candidate will be returned by more than one chunk. That is why deduplication happens before the exact distance test rather than after — a route that loops through the same area three times would otherwise pay for the same perpendicular calculation three times.
</details>

## Related

- [Distance Filter Query Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/) — the box-then-clip primitive each chunk seek is built from.
- [Spatial Join Techniques for Production Graph Networks](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/spatial-join-techniques/) — the clamped perpendicular distance the final filter reuses.
- [Isochrone and Service-Area Analysis](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/isochrone-and-service-area-analysis/) — reachability from a point, where this topic is proximity to a line.
- [Spatial Indexing Strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) — the point index every chunk seek depends on.

This topic is part of [Cypher Spatial Queries & Pathfinding Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/).
