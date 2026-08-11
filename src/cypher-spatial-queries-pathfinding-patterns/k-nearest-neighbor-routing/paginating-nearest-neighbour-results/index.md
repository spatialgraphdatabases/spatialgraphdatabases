---
pageTitle: Paginating Nearest Neighbours
title: Paginating Nearest-Neighbour Results Deterministically
description: Page through a radius search with a keyset cursor instead of SKIP, so ties break consistently and a concurrent write cannot duplicate or drop a row.
slug: paginating-nearest-neighbour-results
type: article
breadcrumb: Paginating KNN
datePublished: 2026-08-11
dateModified: 2026-08-11
---
# Paginating Nearest-Neighbour Results Deterministically

A "nearest hubs" endpoint that returns ten results is straightforward. The same endpoint with a *next page* is where it stops being straightforward, because the obvious implementation — `ORDER BY distance SKIP 10 LIMIT 10` — is wrong in two independent ways. It re-runs the whole search and discards the first page, so page five costs five times page one; and it produces a different result set than the user was looking at if anything was inserted, deleted or moved in between, so rows can appear twice or vanish entirely. This page replaces it with a keyset cursor: a stable sort, a compound cursor that survives ties, and a query whose cost is the same on page fifty as on page one.

## Prerequisites & Versions

An ordinary point index; the cursor is encoded client-side.

| Requirement | Minimum version | Install |
| --- | --- | --- |
| Python | 3.11 | — |
| neo4j (async driver) | 5.20 | `pip install "neo4j>=5.20"` |
| Neo4j Server | 5.15 | native `point`, `POINT INDEX` |

## Implementation

```python
import base64
import json
from dataclasses import dataclass

from neo4j import AsyncGraphDatabase

PAGE = """
MATCH (h:Hub)
WHERE h.location.latitude  >= $min_lat AND h.location.latitude  <= $max_lat
  AND h.location.longitude >= $min_lon AND h.location.longitude <= $max_lon
WITH h, point.distance(h.location, $centre) AS metres
WHERE metres <= $radius_m
  // The keyset predicate: strictly past the cursor in the SAME order the
  // results are sorted by. The id tiebreak is what makes it total — without it,
  // two hubs at an identical distance make the boundary ambiguous and one of
  // them is either repeated on the next page or skipped entirely.
  AND ($after_metres IS NULL
       OR metres > $after_metres
       OR (metres = $after_metres AND h.id > $after_id))
RETURN h.id AS id, metres
ORDER BY metres, h.id
LIMIT $limit
"""


@dataclass(frozen=True)
class Cursor:
    metres: float
    id: str

    def encode(self) -> str:
        return base64.urlsafe_b64encode(
            json.dumps({"m": self.metres, "i": self.id}).encode()
        ).decode()

    @staticmethod
    def decode(token: str | None) -> "Cursor | None":
        if not token:
            return None
        raw = json.loads(base64.urlsafe_b64decode(token.encode()))
        return Cursor(metres=float(raw["m"]), id=str(raw["i"]))


@dataclass(frozen=True)
class Page:
    rows: list[dict]
    next_cursor: str | None

    @property
    def has_more(self) -> bool:
        return self.next_cursor is not None


class NearestHubs:
    def __init__(self, uri: str, auth: tuple[str, str]) -> None:
        self._driver = AsyncGraphDatabase.driver(uri, auth=auth)

    async def close(self) -> None:
        await self._driver.close()

    async def page(self, box: dict, centre, radius_m: float,
                   limit: int = 10, after: str | None = None) -> Page:
        cursor = Cursor.decode(after)
        async with self._driver.session() as session:
            result = await session.run(
                PAGE,
                **box,
                centre=centre,
                radius_m=radius_m,
                # Fetch one extra row: its existence is what tells us there is a
                # next page, without a second COUNT query over the same region.
                limit=limit + 1,
                after_metres=cursor.metres if cursor else None,
                after_id=cursor.id if cursor else None,
            )
            rows = [dict(r) async for r in result]

        has_more = len(rows) > limit
        rows = rows[:limit]
        next_cursor = (
            Cursor(metres=rows[-1]["metres"], id=rows[-1]["id"]).encode()
            if has_more and rows else None
        )
        return Page(rows=rows, next_cursor=next_cursor)
```

## How It Works

**The sort must be total, or the cursor has nothing to anchor to.** `ORDER BY metres` alone is a partial order: two hubs equidistant from the origin can come back in either order, and the database is under no obligation to be consistent between calls. Appending the id makes the order total, which means "everything strictly after this point" identifies exactly one boundary. That is the property the whole approach rests on, and it is why the tiebreak is not optional even though ties feel unlikely — on a grid-planned city, equidistant pairs are common rather than rare.

**The keyset predicate replaces `SKIP`, and its cost does not grow.** `SKIP 500` makes the server produce five hundred rows and throw them away; the keyset version asks the index for rows past a value, which is a seek to a position rather than a walk from the beginning. Page fifty costs what page one costs.

**Fetching `limit + 1` answers "is there more" for free.** The alternative — a separate `count()` over the same region — doubles the work and answers a question nobody asked, since a total count of a radius search is rarely displayed and is expensive precisely when the result set is large.

<svg viewBox="0 0 780 312" role="img" aria-labelledby="pageSkipTitle pageSkipDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="pageSkipTitle">What a concurrent insert does to SKIP, and why a cursor is immune</title>
  <desc id="pageSkipDesc">A user reads page one, then a new hub is inserted nearer than several rows they have already seen. With SKIP and LIMIT, page two is computed by position: the insert has shifted every row down by one, so the last row of page one reappears as the first row of page two. With a keyset cursor, page two is computed by value — everything strictly after the last row the user actually saw — so the new hub is simply not in their sequence and no row repeats. Deleting a row produces the mirror failure under SKIP: one row is skipped entirely and never shown.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="312" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">A hub is inserted between page one and page two</text>
  <text x="24" y="52" font-size="11" font-weight="700" fill="currentColor">page one, as the user saw it</text>
  <g font-size="9.5" font-weight="700" text-anchor="middle">
    <rect x="230" y="38" width="86" height="22" rx="5" fill="var(--accent,#0a656d)"/><text x="273" y="53" fill="var(--viz-on-pill,#ffffff)">A · 120 m</text>
    <rect x="322" y="38" width="86" height="22" rx="5" fill="var(--accent,#0a656d)"/><text x="365" y="53" fill="var(--viz-on-pill,#ffffff)">B · 240 m</text>
    <rect x="414" y="38" width="86" height="22" rx="5" fill="var(--accent,#0a656d)"/><text x="457" y="53" fill="var(--viz-on-pill,#ffffff)">C · 310 m</text>
  </g>
  <g font-size="9.5" font-weight="700" text-anchor="middle">
    <rect x="230" y="76" width="270" height="22" rx="5" fill="var(--accent-2,#a8380b)"/>
    <text x="365" y="91" fill="var(--viz-on-pill,#ffffff)">new hub X inserted at 180 m — now between A and B</text>
  </g>
  <rect x="24" y="112" width="732" height="80" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-poor,#a8320f)" stroke-width="1.6"/>
  <text x="44" y="134" font-size="11" font-weight="700" fill="var(--viz-poor,#a8320f)">SKIP 3 LIMIT 3 — page two by position</text>
  <text x="44" y="152" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">the insert shifted everything down one, so position 4 is now C</text>
  <g font-size="9.5" font-weight="700" text-anchor="middle">
    <rect x="230" y="158" width="86" height="22" rx="5" fill="var(--viz-poor,#a8320f)"/><text x="273" y="173" fill="var(--viz-on-pill,#ffffff)">C · 310 m</text>
    <rect x="322" y="158" width="86" height="22" rx="5" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1"/><text x="365" y="173" fill="var(--viz-ink-mute,#565f6d)">D · 380 m</text>
    <rect x="414" y="158" width="86" height="22" rx="5" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1"/><text x="457" y="173" fill="var(--viz-ink-mute,#565f6d)">E · 450 m</text>
  </g>
  <text x="514" y="173" font-size="10" font-weight="700" fill="var(--viz-poor,#a8320f)">C shown twice</text>
  <rect x="24" y="204" width="732" height="80" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="1.8"/>
  <text x="44" y="226" font-size="11" font-weight="700" fill="var(--viz-good,#0a656d)">cursor after (310, C) — page two by value</text>
  <text x="44" y="244" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">strictly past the last row the user actually saw</text>
  <g font-size="9.5" font-weight="700" text-anchor="middle">
    <rect x="230" y="250" width="86" height="22" rx="5" fill="var(--viz-good,#0a656d)"/><text x="273" y="265" fill="var(--viz-on-pill,#ffffff)">D · 380 m</text>
    <rect x="322" y="250" width="86" height="22" rx="5" fill="var(--viz-good,#0a656d)"/><text x="365" y="265" fill="var(--viz-on-pill,#ffffff)">E · 450 m</text>
    <rect x="414" y="250" width="86" height="22" rx="5" fill="var(--viz-good,#0a656d)"/><text x="457" y="265" fill="var(--viz-on-pill,#ffffff)">F · 520 m</text>
  </g>
  <text x="514" y="265" font-size="10" font-weight="700" fill="var(--viz-good,#0a656d)">no repeat, no gap</text>
  <text x="24" y="304" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">A delete produces the mirror image under SKIP: everything shifts up, and one row is never shown to anyone.</text>
</svg>

## Common Failure Patterns

**1. Sorting by distance alone.** The most common version of this bug, and the hardest to reproduce: it only misbehaves when two rows tie, so it works in development and produces occasional duplicates in production. Any keyset cursor needs a total order, and the id is the cheapest way to get one.

**2. Putting the cursor's distance in the box.** It is tempting to shrink the bounding box on each page since the results are getting further away — but the box is what makes the query seekable, and narrowing its *inner* edge is not something a bounding box can express. The keyset predicate belongs on the computed distance, above the seek; the box stays the same on every page.

**3. Treating the cursor as a durable handle.** It encodes a position in an ordering, not a snapshot. If the origin or radius changes, the cursor is meaningless and must be discarded — so the endpoint should either include those parameters in the token and reject a mismatch, or make it impossible to pass a cursor with different search parameters.

```python
# Bind the cursor to the search it came from, so a changed radius cannot
# silently resume into a different ordering.
def encode(self, centre, radius_m: float) -> str:
    payload = {"m": self.metres, "i": self.id,
               "c": [centre.latitude, centre.longitude], "r": radius_m}
    return base64.urlsafe_b64encode(json.dumps(payload).encode()).decode()
```

## Performance Notes

The cost difference is the whole argument:

$$C_{\text{skip}}(p) \approx p \cdot L \cdot c_{\text{row}}, \qquad C_{\text{keyset}}(p) \approx L \cdot c_{\text{row}}$$

For page $p$ at page size $L$, `SKIP` is linear in the page number and the cursor is constant. On a ten-row page that is invisible until someone builds an export that walks every page, at which point the `SKIP` version is quadratic in the result size and the cursor version is linear.

There is a subtlety worth knowing: the distance is computed, not stored, so the `ORDER BY metres` cannot be served by the index and the sort happens over the candidate set the box returned. That is fine — the box has already reduced it to a manageable size — but it means the cursor's benefit is in avoiding *re-sorting and discarding*, not in avoiding the sort altogether. Where pages are walked exhaustively and the region is large, storing a precomputed grid cell and paging on that instead moves the sort into the index, at the cost of ordering by cell rather than by true distance.

Both approaches read the same rows from the store on page one. The divergence starts at page two and grows, which is why this rarely shows up in a benchmark that measures a single request and always shows up in a support ticket about a slow "load more" button.

<svg viewBox="0 0 780 288" role="img" aria-labelledby="pageCostTitle pageCostDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="pageCostTitle">Cost per page, walking a result set to the end</title>
  <desc id="pageCostDesc">Rows produced by the server per page request, for a ten-row page. With SKIP and LIMIT, page one produces ten rows, page ten produces a hundred and page fifty produces five hundred, because the server must generate and discard everything before the requested page. With a keyset cursor every page produces eleven rows — ten plus the one extra that answers whether more exist. The lines are identical at page one, which is why a benchmark of a single request finds nothing.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="288" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Rows the server produces per page request</text>
  <line x1="96" y1="48" x2="96" y2="204" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <line x1="96" y1="204" x2="720" y2="204" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <g font-size="9.5" fill="var(--viz-ink-mute,#565f6d)" text-anchor="end">
    <text x="88" y="60">500</text><text x="88" y="108">300</text><text x="88" y="156">100</text><text x="88" y="208">0</text>
  </g>
  <g font-size="9.5" fill="var(--viz-ink-mute,#565f6d)" text-anchor="middle">
    <text x="96" y="224">page 1</text><text x="252" y="224">10</text><text x="408" y="224">25</text><text x="564" y="224">40</text><text x="720" y="224">50</text>
  </g>
  <text x="408" y="244" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">page number</text>
  <path d="M96 201 L252 156 L408 108 L564 62 L720 56" fill="none" stroke="var(--viz-poor,#a8320f)" stroke-width="2.8"/>
  <text x="440" y="98" font-size="10" font-weight="700" fill="var(--viz-poor,#a8320f)">SKIP — linear in the page number</text>
  <line x1="96" y1="199" x2="720" y2="199" stroke="var(--viz-good,#0a656d)" stroke-width="2.8"/>
  <text x="110" y="192" font-size="10" font-weight="700" fill="var(--viz-good,#0a656d)">keyset cursor — flat at 11 rows</text>
  <circle cx="96" cy="200" r="5" fill="var(--viz-ok,#7d6200)"/>
  <text x="108" y="172" font-size="9.5" font-weight="700" fill="var(--viz-ok,#7d6200)">identical here — which is where benchmarks look</text>
  <text x="24" y="272" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">Walking the whole set costs O(n²) rows under SKIP and O(n) under a cursor, for exactly the same output.</text>
</svg>

Two design points are worth settling before this reaches an API contract.

The first is what a cursor promises. A keyset cursor guarantees that no row the caller has already seen will be shown again, and that no row which was present and unchanged throughout the walk will be skipped. It does *not* guarantee a consistent snapshot: a hub inserted nearer than the current cursor position will never appear in that caller's sequence, and one moved from beyond the cursor to before it will be missed. That is usually the right trade for a proximity search, where the alternative — holding a transaction open across a user's paging — is far worse. But it is a property worth documenting rather than discovering, because "we never showed them the new depot" is a reasonable complaint from someone who does not know how the pagination works.

The second is what to do about deep paging at all. A radius search that needs fifty pages is usually a radius that is too large rather than a paging problem, and the better answer is often to say so: cap the total result set, return the count that was capped, and let the caller narrow the search. Deep pagination is cheap with a cursor, which makes it tempting to offer without limit — but a caller walking ten thousand hubs one page at a time is almost always building something that would be better served by a single bulk export with no ordering guarantee at all.

## Related

- [K-Nearest Neighbor Routing in Production Spatial Graphs](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/k-nearest-neighbor-routing/) — the search this pages through.
- [Implementing KNN Search for Nearby Logistics Hubs](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/k-nearest-neighbor-routing/implementing-knn-search-for-nearby-logistics-hubs/) — the box-then-clip query the cursor sits on top of.
- [Latitude-Corrected Bounding Boxes in Python](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/latitude-corrected-bounding-boxes-in-python/) — the box that stays constant across every page.
- [Keeping Spatial Queries in the Plan Cache](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/cypher-performance-tuning/keeping-spatial-queries-in-the-plan-cache/) — why the cursor is a parameter and not part of the query text.

This guide is part of [K-Nearest Neighbor Routing](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/k-nearest-neighbor-routing/), within [Cypher Spatial Queries & Pathfinding Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/).
