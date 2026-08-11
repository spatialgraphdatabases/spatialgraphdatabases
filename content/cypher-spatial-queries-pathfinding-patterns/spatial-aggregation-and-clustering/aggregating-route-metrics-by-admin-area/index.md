---
pageTitle: Route Metrics by Admin Area
title: Aggregating Route Metrics by Administrative Area
description: Attribute a route's distance, time and emissions to the districts it crosses, splitting each segment proportionally instead of counting the whole route once.
slug: aggregating-route-metrics-by-admin-area
type: article
breadcrumb: Metrics by Area
datePublished: 2026-08-11
dateModified: 2026-08-11
---
# Aggregating Route Metrics by Administrative Area

"How many kilometres did we drive in each borough last month" sounds like a group-by and is not. A route is a line, not a point, and a line crosses boundaries — so attributing the whole route to wherever it started double-counts one district and erases every other one it passed through. The usual first implementation picks the origin's district, produces a report that looks plausible, and is wrong by whatever fraction of driving happened elsewhere. On an urban fleet that fraction is most of it. This page attributes each segment to the area containing it, keeps the arithmetic additive so totals reconcile, and handles the segments that genuinely straddle a boundary.

## Prerequisites & Versions

The containment is resolved once at ingestion, so the aggregation itself is a traversal. No GDS or APOC is required.

| Requirement | Minimum version | Install |
| --- | --- | --- |
| Python | 3.11 | — |
| neo4j (async driver) | 5.20 | `pip install "neo4j>=5.20"` |
| Neo4j Server | 5.15 | native `point`, variable-length patterns |

## Implementation

Segments carry their area assignment as a relationship property, written once when the graph is built. The aggregation then walks the recorded routes and sums per area — no geometry is evaluated at query time.

```python
import asyncio
from dataclasses import dataclass

from neo4j import AsyncGraphDatabase

# The route is stored as an ordered list of segment ids on the trip, so the
# aggregation does not have to re-walk the graph to know which edges were used.
AGGREGATE = """
MATCH (t:Trip)
WHERE t.tenant_id = $tenant
  AND t.completed_at >= datetime($since)
  AND t.completed_at <  datetime($until)
UNWIND t.segment_ids AS seg_id
MATCH ()-[s:SEGMENT {id: seg_id}]->()
UNWIND s.area_shares AS share
RETURN share.area_id                              AS area_id,
       sum(s.length_m  * share.fraction) / 1000.0 AS km,
       sum(s.drive_s   * share.fraction) / 3600.0 AS hours,
       count(DISTINCT t)                          AS trips
ORDER BY km DESC
"""

RESOLVE_NAMES = """
UNWIND $ids AS area_id
MATCH (a:AdminArea {id: area_id})
OPTIONAL MATCH (a)-[:WITHIN]->(parent:AdminArea)
RETURN a.id AS area_id, a.name AS name, a.level AS level,
       parent.name AS parent_name
"""


@dataclass(frozen=True)
class AreaTotals:
    area_id: str
    name: str
    parent: str | None
    km: float
    hours: float
    trips: int


class RouteMetrics:
    def __init__(self, uri: str, auth: tuple[str, str]) -> None:
        self._driver = AsyncGraphDatabase.driver(uri, auth=auth)

    async def close(self) -> None:
        await self._driver.close()

    async def by_area(self, tenant: str, since: str, until: str) -> list[AreaTotals]:
        async with self._driver.session() as session:
            result = await session.run(
                AGGREGATE, tenant=tenant, since=since, until=until
            )
            rows = [dict(record) async for record in result]

            names = {}
            if rows:
                lookup = await session.run(
                    RESOLVE_NAMES, ids=[r["area_id"] for r in rows]
                )
                names = {r["area_id"]: dict(r) async for r in lookup}

        return [
            AreaTotals(
                area_id=row["area_id"],
                name=names.get(row["area_id"], {}).get("name", row["area_id"]),
                parent=names.get(row["area_id"], {}).get("parent_name"),
                km=float(row["km"]),
                hours=float(row["hours"]),
                trips=int(row["trips"]),
            )
            for row in rows
        ]


def reconcile(totals: list[AreaTotals], expected_km: float, tol: float = 0.005) -> None:
    """Per-area kilometres must sum to the fleet total, or a fraction is missing.

    This is the check that catches an unassigned segment: a stretch of road whose
    area_shares were never written contributes to no area at all, and the report
    simply comes out short without saying so.
    """
    got = sum(t.km for t in totals)
    drift = abs(got - expected_km) / expected_km if expected_km else 0.0
    if drift > tol:
        raise AssertionError(
            f"per-area total {got:,.1f} km vs fleet total {expected_km:,.1f} km "
            f"({drift:.2%} unattributed — check for segments with no area_shares)"
        )


async def main() -> None:
    metrics = RouteMetrics("neo4j://localhost:7687", ("neo4j", "password"))
    try:
        totals = await metrics.by_area(
            "acme-logistics", since="2026-07-01T00:00:00Z", until="2026-08-01T00:00:00Z"
        )
    finally:
        await metrics.close()

    for t in totals[:15]:
        parent = f" ({t.parent})" if t.parent else ""
        print(f"{t.name + parent:<38}{t.km:>10,.1f} km{t.hours:>10,.1f} h{t.trips:>8,}")


if __name__ == "__main__":
    asyncio.run(main())
```

## How It Works

The whole design turns on one property written at build time: `area_shares`, a list of `{area_id, fraction}` on each segment, whose fractions sum to one.

**A segment inside one area has a single share of 1.0.** That is the overwhelming majority of segments, and for them the arithmetic is a no-op — the sum is just the segment's length attributed to one place.

**A segment that crosses a boundary has one share per area, proportional to the length inside each.** This is what makes the totals additive: a 400-metre segment with 300 metres in one borough and 100 in another contributes 0.3 km and 0.1 km, not 0.4 km twice or 0.4 km once to the wrong one. Because the fractions sum to one by construction, the per-area totals reconcile against the fleet total exactly, which is what makes the `reconcile` check meaningful rather than decorative.

**The split is computed once, at ingestion.** Clipping a segment against a boundary polygon is real geometric work, and doing it per query over a month of trips would be several orders of magnitude more of it than doing it per segment once. That is the same trade the [aggregation topic](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/spatial-aggregation-and-clustering/) makes for point data with a stored cell key, applied to lines.

The reason to store shares on the segment rather than an area id is precisely the boundary case. A single `area_id` forces a choice — midpoint, start point, largest overlap — and every one of those choices is lossy in a way that shows up as a systematic bias once you aggregate a million segments. Storing the split keeps the loss at zero.

<svg viewBox="0 0 780 312" role="img" aria-labelledby="attrTitle attrDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="attrTitle">Three ways to attribute one route to three districts, and what each reports</title>
  <desc id="attrDesc">A 12 kilometre route crossing three districts, with 3, 6 and 3 kilometres in each. Attributing the whole route to the origin district reports 12 kilometres in the first and nothing in the other two. Attributing each segment to the district containing its midpoint is much closer but misplaces the segments that straddle a boundary, here reporting 3.4, 5.8 and 2.8. Splitting each segment proportionally reports exactly 3, 6 and 3, and the three figures sum to the route length — which is what lets the report be reconciled rather than merely believed.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="312" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">One 12 km route, three districts — 3 km, 6 km, 3 km</text>
  <rect x="24" y="42" width="732" height="72" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.2"/>
  <rect x="52" y="58" width="180" height="40" rx="6" fill="var(--accent,#0a656d)" opacity="0.14"/>
  <rect x="232" y="58" width="336" height="40" rx="6" fill="var(--accent-3,#5b21b6)" opacity="0.14"/>
  <rect x="568" y="58" width="160" height="40" rx="6" fill="var(--accent-2,#a8380b)" opacity="0.14"/>
  <text x="142" y="74" text-anchor="middle" font-size="10" font-weight="700" fill="var(--accent,#0a656d)">District A</text>
  <text x="400" y="74" text-anchor="middle" font-size="10" font-weight="700" fill="var(--accent-3,#5b21b6)">District B</text>
  <text x="648" y="74" text-anchor="middle" font-size="10" font-weight="700" fill="var(--accent-2,#a8380b)">District C</text>
  <line x1="60" y1="90" x2="720" y2="90" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>
  <text x="24" y="140" font-size="11" font-weight="700" fill="var(--viz-poor,#a8320f)">whole route → origin district</text>
  <g font-size="11" font-weight="700" text-anchor="middle">
    <rect x="330" y="128" width="120" height="24" rx="6" fill="var(--viz-poor,#a8320f)"/><text x="390" y="145" fill="var(--viz-on-pill,#ffffff)">12.0 / 0 / 0</text>
  </g>
  <text x="470" y="145" font-size="10" fill="var(--viz-ink-mute,#565f6d)">two districts erased, one inflated fourfold</text>
  <text x="24" y="188" font-size="11" font-weight="700" fill="var(--viz-ok,#7d6200)">per segment → midpoint's district</text>
  <g font-size="11" font-weight="700" text-anchor="middle">
    <rect x="330" y="176" width="120" height="24" rx="6" fill="var(--viz-ok,#7d6200)"/><text x="390" y="193" fill="var(--viz-on-pill,#ffffff)">3.4 / 5.8 / 2.8</text>
  </g>
  <text x="470" y="193" font-size="10" fill="var(--viz-ink-mute,#565f6d)">close, but biased by whichever way each straddle fell</text>
  <text x="24" y="236" font-size="11" font-weight="700" fill="var(--viz-good,#0a656d)">per segment → proportional shares</text>
  <g font-size="11" font-weight="700" text-anchor="middle">
    <rect x="330" y="224" width="120" height="24" rx="6" fill="var(--viz-good,#0a656d)"/><text x="390" y="241" fill="var(--viz-on-pill,#ffffff)">3.0 / 6.0 / 3.0</text>
  </g>
  <text x="470" y="241" font-size="10" fill="var(--viz-ink-mute,#565f6d)">exact, and the three sum back to 12.0</text>
  <text x="24" y="278" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">The midpoint version is the one that survives review, because it is nearly right and its error has no obvious sign.</text>
  <text x="24" y="294" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">The reconciliation check is what turns "nearly right" into a number that either balances or reports that it did not.</text>
</svg>

## Common Failure Patterns

**1. Segments with no `area_shares` at all.** A stretch of road outside every boundary polygon — a ferry link, a private access road, a gap in the boundary set — contributes to no area, and the report simply comes out short. Nothing errors. The reconciliation check is the only thing that catches it, which is why it belongs in the job rather than in a test.

```cypher
// Find the unattributed roads before the monthly report does.
MATCH ()-[s:SEGMENT]->()
WHERE s.area_shares IS NULL OR size(s.area_shares) = 0
RETURN count(s) AS unattributed,
       sum(s.length_m) / 1000.0 AS km_unattributed;
```

**2. Shares that do not sum to one.** A clipping routine that drops a sliver, or one that assigns the same overlap to two areas, breaks the invariant the whole design rests on — and it breaks it quietly, because each individual segment still looks reasonable. Assert the sum at write time, not at read time.

**3. Double counting through the `:WITHIN` hierarchy.** Aggregating over `(:Trip)-[:SEGMENT]->()-[:WITHIN*]->(:AdminArea)` without pinning a level counts every segment once per ancestor, so a borough's kilometres also appear in its city's and its country's totals — and summing that column gives a number several times the fleet's actual driving. Pin the level, and roll up to coarser levels by summing the finest, never by traversing further.

## Performance Notes

The query's cost is set by the trip count and the segments per trip, not by the size of the road graph:

$$C \approx T \cdot \bar{s} \cdot (1 + \bar{a})$$

for $T$ trips, $\bar{s}$ segments per trip and $\bar{a}$ the mean number of area shares per segment, which is barely above one because only boundary-crossing segments have more. A month of ten thousand urban trips at four hundred segments each is four million row expansions — substantial, but linear and index-backed through the segment id lookup.

Two things make it materially faster. **Storing the segment list on the trip** avoids re-walking the route graph to find which edges were used, turning a variable-length traversal into an `UNWIND` over a stored list. And **rolling up from a materialised daily table** rather than from raw trips is the natural next step once the reporting window grows: a nightly job writes `(:AreaDaily {area_id, day, km, hours, trips})`, and the monthly report becomes a sum over thirty rows per area instead of over a month of trips. Because the shares are additive, that roll-up is exact rather than approximate — the same property that makes the reconciliation check work makes the pre-aggregation safe.

Keep an eye on where this runs. A month-wide scan pulls a large slice of the trip store through the page cache, and on a shared instance that displaces the [working set the routing endpoint depends on](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-memory-and-storage-tuning/sizing-the-page-cache-for-a-spatial-graph/). Reporting queries belong on a replica wherever one exists.

<svg viewBox="0 0 780 284" role="img" aria-labelledby="rollupTitle rollupDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="rollupTitle">Additive shares make the daily roll-up exact rather than approximate</title>
  <desc id="rollupDesc">Because each segment's area fractions sum to one, kilometres attributed to an area can be summed across days without any loss. The monthly figure obtained by summing thirty daily rows equals the figure obtained by scanning a month of raw trips, so a pre-aggregation is a performance change and not an accuracy trade. The same property makes rolling a borough up into its city a sum over the finest level rather than a second traversal of the containment hierarchy, which is what would otherwise double count.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="284" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Two ways to the same monthly number</text>
  <rect x="24" y="42" width="336" height="176" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <text x="192" y="66" text-anchor="middle" font-size="11.5" font-weight="700" fill="currentColor">scan a month of trips</text>
  <rect x="52" y="82" width="280" height="22" rx="6" fill="var(--accent-3,#5b21b6)"/>
  <text x="192" y="98" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-on-pill,#ffffff)">310,000 trips</text>
  <rect x="52" y="112" width="280" height="22" rx="6" fill="var(--accent-3,#5b21b6)"/>
  <text x="192" y="128" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-on-pill,#ffffff)">~124,000,000 segment rows</text>
  <text x="192" y="158" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">4,182.6 km in District B</text>
  <text x="192" y="182" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">minutes, and a page cache full of trips</text>
  <rect x="420" y="42" width="336" height="176" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="1.8"/>
  <text x="588" y="66" text-anchor="middle" font-size="11.5" font-weight="700" fill="var(--viz-good,#0a656d)">sum 30 daily rows</text>
  <rect x="448" y="82" width="280" height="22" rx="6" fill="var(--viz-good,#0a656d)"/>
  <text x="588" y="98" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-on-pill,#ffffff)">30 AreaDaily rows</text>
  <rect x="448" y="112" width="94" height="22" rx="6" fill="var(--viz-good,#0a656d)"/>
  <text x="495" y="128" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-on-pill,#ffffff)">30 rows</text>
  <text x="588" y="158" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">4,182.6 km in District B</text>
  <text x="588" y="182" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">milliseconds, and identical</text>
  <text x="24" y="250" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">Identical, not approximately identical. Pre-aggregation is usually a trade against accuracy; here the shares are additive</text>
  <text x="24" y="266" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">by construction, so summing partial totals is the same arithmetic performed in a different order.</text>
</svg>

One structural note before leaving the subject. The shares live on the segment rather than on the trip because a segment's geometry is stable and a trip's is not — the same stretch of road is driven by thousands of trips, and computing its boundary split once rather than once per traversal is the difference between a build-time cost and a per-trip one. It also means a boundary change is a localised fix: when a district is redrawn, only the segments intersecting the changed boundary need their shares recomputed, and every historical trip picks up the correction automatically on the next report. That last property is worth deciding about deliberately, because it cuts both ways — a report run today against last year's trips will use today's boundaries. Where the historical figures have to stay fixed, stamp the boundary-set version onto the daily roll-up and never recompute a day that has already been published.

## Related

- [Spatial Aggregation and Clustering in Cypher](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/spatial-aggregation-and-clustering/) — the point-data counterpart of this line-data problem.
- [Reverse Geocoding POI Nodes to Admin Boundaries](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/poi-enrichment-workflows/reverse-geocoding-poi-nodes-to-admin-boundaries/) — building the `:WITHIN` hierarchy this aggregation reads.
- [Spatial Join Techniques for Production Graph Networks](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/spatial-join-techniques/) — clipping segments against polygons at build time.
- [Isochrone and Service-Area Analysis](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/isochrone-and-service-area-analysis/) — the other way of asking a question about area coverage.

This guide is part of [Spatial Aggregation and Clustering in Cypher](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/spatial-aggregation-and-clustering/), within [Cypher Spatial Queries & Pathfinding Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/).
