---
pageTitle: Composite Index Key Order
title: Composite Index Key Order for Spatial Filters
description: Decide which predicate leads a composite index, why an equality must come first, and how to tell a real seek from one that degraded into a filter.
slug: composite-index-key-order-for-spatial-filters
type: article
breadcrumb: Composite Key Order
datePublished: 2026-08-11
dateModified: 2026-08-11
---
# Composite Index Key Order for Spatial Filters

A composite index over the wrong pair of properties, in the wrong order, is worse than no index at all — it consumes store, slows every write, and produces a plan that says `NodeIndexSeek` while doing most of the work of a scan. The rule that governs it is short and easy to state: a composite index can seek on a prefix of its keys, an equality predicate on the leading key narrows to a slice, and the first range predicate ends the seekable prefix. Everything after that is a filter over whatever the seek returned. Getting the order right is therefore not a tuning detail but a statement about which predicate is doing the selecting, and on a spatial workload the answer is rarely the geometric one.

## Prerequisites & Versions

Range and composite indexes as they exist on any supported 5.x server.

| Requirement | Minimum version | Install |
| --- | --- | --- |
| Python | 3.11 | — |
| neo4j (async driver) | 5.20 | `pip install "neo4j>=5.20"` |
| Neo4j Server | 5.15 | composite range indexes, `SHOW INDEXES` |

## Implementation

The decision procedure is mechanical once the predicate shapes are known, and the code below turns a query's predicates into the index it wants.

```python
from dataclasses import dataclass
from enum import Enum


class Shape(Enum):
    EQUALITY = "equality"    # tenant_id = $t
    RANGE = "range"          # geocell >= $lo AND geocell <= $hi
    MEMBERSHIP = "membership"  # geocell IN $cells — a set of bounded ranges


@dataclass(frozen=True)
class Predicate:
    property: str
    shape: Shape
    selectivity: float   # fraction of the label this predicate alone admits


def index_key_order(predicates: list[Predicate]) -> list[str]:
    """Order the keys so the seekable prefix is as long and as narrow as possible.

    Equalities first, most selective first among them: each one narrows the
    descent to a slice and the NEXT key is still seekable inside that slice.
    Then at most one range or membership, because the first non-equality ends
    the seekable prefix — anything after it is evaluated as a filter over rows
    the seek already produced, and contributes nothing to the access path.
    """
    equalities = sorted(
        (p for p in predicates if p.shape is Shape.EQUALITY),
        key=lambda p: p.selectivity,
    )
    ranges = sorted(
        (p for p in predicates if p.shape is not Shape.EQUALITY),
        key=lambda p: p.selectivity,
    )
    keys = [p.property for p in equalities]
    if ranges:
        keys.append(ranges[0].property)   # only the first one can be seeked
    return keys


def wasted_keys(predicates: list[Predicate]) -> list[str]:
    """Keys that would sit past the seekable prefix and buy nothing.

    Worth reporting: they cost write throughput and store on every insert, and
    the plan will still say 'index seek', so nothing complains.
    """
    ordered = index_key_order(predicates)
    return [p.property for p in predicates if p.property not in ordered]


DDL = "CREATE INDEX {name} IF NOT EXISTS FOR (n:{label}) ON ({keys});"


def ddl_for(label: str, name: str, predicates: list[Predicate]) -> str:
    keys = ", ".join(f"n.{k}" for k in index_key_order(predicates))
    return DDL.format(name=name, label=label, keys=keys)


if __name__ == "__main__":
    query_predicates = [
        Predicate("geocell", Shape.MEMBERSHIP, selectivity=0.004),
        Predicate("tenant_id", Shape.EQUALITY, selectivity=0.02),
        Predicate("status", Shape.EQUALITY, selectivity=0.60),
    ]
    print(ddl_for("Location", "location_tenant_status_cell", query_predicates))
    # CREATE INDEX location_tenant_status_cell IF NOT EXISTS
    # FOR (n:Location) ON (n.tenant_id, n.status, n.geocell);
    print("past the prefix:", wasted_keys(query_predicates))   # []
```

## How It Works

**A composite index is sorted lexicographically by its key tuple.** That single fact explains every rule that follows. With keys `(tenant_id, geocell)`, all of tenant A's entries are contiguous, and within them the geocells are in order. Pinning `tenant_id` to one value therefore selects a contiguous slice, and a range on `geocell` selects a contiguous run *inside that slice* — two levels of narrowing, both resolved by descending the tree.

**A range on the leading key ends the prefix immediately.** With the keys reversed to `(geocell, tenant_id)`, a range on `geocell` selects a contiguous run, but the tenants inside that run are interleaved — every cell holds entries for every tenant. There is no contiguous region for one tenant, so `tenant_id` cannot narrow the descent and becomes a filter over everything the geocell range returned. The plan still reports a seek, because a seek genuinely happened; it simply returned far more than it needed to.

**Selectivity orders the equalities, not the whole list.** Among leading equalities, putting the most selective first makes the first descent the narrowest, which matters when the index is large enough that the tree depth is doing real work. But no amount of selectivity promotes a range predicate past an equality — the shape of the predicate outranks how much it filters, because it is the shape that decides whether the *next* key is still seekable.

<svg viewBox="0 0 780 320" role="img" aria-labelledby="ckoTitle ckoDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="ckoTitle">Why an equality must lead: the same entries, two key orders</title>
  <desc id="ckoDesc">Index entries for three tenants across four grid cells, laid out in the sorted order each key arrangement produces. With tenant leading, all of tenant B's entries are contiguous, so pinning the tenant selects one slice and the cell range then selects a contiguous run inside it — twelve entries read. With the cell leading, entries are grouped by cell and the tenants are interleaved within each, so no contiguous region exists for one tenant; the cell range selects its run and the tenant predicate becomes a filter over all of it — thirty-six entries read to return the same twelve.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="320" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">tenant_id = 'B' AND geocell IN [c2, c3]</text>
  <text x="24" y="52" font-size="11.5" font-weight="700" fill="var(--viz-good,#0a656d)">ON (n.tenant_id, n.geocell)</text>
  <text x="24" y="68" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">sorted by tenant, then cell</text>
  <g font-size="9" font-weight="700" text-anchor="middle">
    <rect x="24" y="78" width="228" height="26" rx="5" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1"/>
    <text x="138" y="95" fill="var(--viz-ink-mute,#565f6d)">A · c1 c2 c3 c4</text>
    <rect x="256" y="78" width="228" height="26" rx="5" fill="var(--viz-good,#0a656d)"/>
    <text x="370" y="95" fill="var(--viz-on-pill,#ffffff)">B · c1 c2 c3 c4</text>
    <rect x="488" y="78" width="228" height="26" rx="5" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1"/>
    <text x="602" y="95" fill="var(--viz-ink-mute,#565f6d)">C · c1 c2 c3 c4</text>
  </g>
  <rect x="313" y="112" width="114" height="20" rx="5" fill="var(--viz-good,#0a656d)"/>
  <text x="370" y="127" text-anchor="middle" font-size="9" font-weight="700" fill="var(--viz-on-pill,#ffffff)">c2, c3 — contiguous</text>
  <text x="440" y="127" font-size="10" font-weight="700" fill="var(--viz-good,#0a656d)">12 entries read, 12 returned</text>
  <line x1="24" y1="152" x2="756" y2="152" stroke="var(--line,#e5e0d2)" stroke-width="1" stroke-dasharray="3 6"/>
  <text x="24" y="182" font-size="11.5" font-weight="700" fill="var(--viz-poor,#a8320f)">ON (n.geocell, n.tenant_id)</text>
  <text x="24" y="198" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">sorted by cell, then tenant — the tenants are now interleaved</text>
  <g font-size="9" font-weight="700" text-anchor="middle">
    <rect x="24" y="208" width="168" height="26" rx="5" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1"/>
    <text x="108" y="225" fill="var(--viz-ink-mute,#565f6d)">c1 · A B C</text>
    <rect x="196" y="208" width="168" height="26" rx="5" fill="var(--viz-poor,#a8320f)"/>
    <text x="280" y="225" fill="var(--viz-on-pill,#ffffff)">c2 · A B C</text>
    <rect x="368" y="208" width="168" height="26" rx="5" fill="var(--viz-poor,#a8320f)"/>
    <text x="452" y="225" fill="var(--viz-on-pill,#ffffff)">c3 · A B C</text>
    <rect x="540" y="208" width="168" height="26" rx="5" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1"/>
    <text x="624" y="225" fill="var(--viz-ink-mute,#565f6d)">c4 · A B C</text>
  </g>
  <rect x="196" y="242" width="340" height="20" rx="5" fill="var(--viz-poor,#a8320f)"/>
  <text x="366" y="257" text-anchor="middle" font-size="9" font-weight="700" fill="var(--viz-on-pill,#ffffff)">the cell range is contiguous — every tenant inside it</text>
  <text x="24" y="284" font-size="10" font-weight="700" fill="var(--viz-poor,#a8320f)">36 entries read, 12 returned — the tenant predicate is a filter, not part of the descent</text>
  <text x="24" y="306" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">Both plans report an index seek. Only the row counts distinguish them, which is why PROFILE and not EXPLAIN settles it.</text>
</svg>

## Common Failure Patterns

**1. Ordering by selectivity alone.** A geocell membership admitting 0.4% of the label looks far more selective than a tenant equality admitting 2%, so it goes first — and the tenant predicate immediately drops out of the descent. Shape first, then selectivity within the equalities.

**2. Adding a third key past the first range.** `ON (tenant_id, geocell, status)` looks thorough and the third key does nothing: the range on `geocell` has already ended the seekable prefix, so `status` is evaluated as a filter whether it is in the index or not. It costs write throughput and store on every insert for no read benefit.

**3. Reading `NodeIndexSeek` as confirmation.** The operator name says an index was descended, not that the descent was narrow. The number that settles it is rows out of the seek compared with rows out of the filter above it — a seek returning 40,000 rows for a filter that keeps 300 is a seek in name only.

```cypher
PROFILE
MATCH (n:Location)
WHERE n.tenant_id = $tenant AND n.geocell IN $cells
RETURN count(n);
-- Healthy: the seek's Rows is close to the final count.
-- Degraded: the seek's Rows is orders of magnitude larger, and a Filter above
-- it does the real work.
```

## Performance Notes

The read benefit of the correct order grows with the leading key's cardinality:

$$\text{rows}_{\text{seek}} \approx N \cdot \prod_{i \le k} s_i$$

where $k$ is the seekable prefix length and $s_i$ each key's selectivity. Every key that falls past the prefix contributes nothing to that product. On a multi-tenant graph with a thousand tenants, moving the tenant equality to the front changes the product by three orders of magnitude — which is why [scoping routes with a composite tenant-geometry index](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-security-boundaries/scoping-routes-with-composite-tenant-geometry-indexes/) treats the key order as a security property and not only a performance one.

The write cost runs the other way and is worth weighing. Every composite index is maintained on every insert and on every update to any of its keys, so a graph under continuous [attribute synchronization](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/attribute-synchronization-techniques/) pays for each index on each touched row. Two well-chosen composites usually beat five speculative ones, and the ones to drop are exactly those whose trailing keys sit past a range.

A last note on point indexes: they are not composites and this rule does not apply to them. A `POINT INDEX` handles the two-dimensional bounding-box seek natively, which is precisely what a composite range index cannot do — the reason a grid cell exists at all in the composite arrangement is to flatten two dimensions into one seekable key. Where the query is purely geometric with no equality to lead, the point index is the right structure and a composite is the wrong one.

<svg viewBox="0 0 780 288" role="img" aria-labelledby="ckoCostTitle ckoCostDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="ckoCostTitle">Rows leaving the seek as tenant count grows, for both key orders</title>
  <desc id="ckoCostDesc">Rows returned by the index seek plotted against the number of tenants in the graph, for a query that ultimately keeps 300 rows. With the tenant equality leading, the seek returns close to 300 regardless of how many tenants exist, because the descent goes straight to one tenant's slice. With the geocell leading, the seek returns every tenant's entries in the cell range, so the row count grows linearly with tenant count and the filter above it discards an ever-larger share. At a thousand tenants the second plan is reading three orders of magnitude more than it returns.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="288" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Rows out of the seek — the query keeps 300</text>
  <line x1="96" y1="48" x2="96" y2="204" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <line x1="96" y1="204" x2="720" y2="204" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <g font-size="9.5" fill="var(--viz-ink-mute,#565f6d)" text-anchor="end">
    <text x="88" y="60">300k</text><text x="88" y="108">30k</text><text x="88" y="156">3k</text><text x="88" y="208">300</text>
  </g>
  <g font-size="9.5" fill="var(--viz-ink-mute,#565f6d)" text-anchor="middle">
    <text x="96" y="224">1</text><text x="252" y="224">10</text><text x="408" y="224">100</text><text x="564" y="224">1,000</text><text x="720" y="224">10,000</text>
  </g>
  <text x="408" y="244" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">tenants in the graph</text>
  <line x1="96" y1="200" x2="720" y2="200" stroke="var(--viz-good,#0a656d)" stroke-width="2.8"/>
  <text x="110" y="192" font-size="10" font-weight="700" fill="var(--viz-good,#0a656d)">ON (tenant_id, geocell) — flat at ~300</text>
  <path d="M96 200 L252 152 L408 104 L564 60 L646 44" fill="none" stroke="var(--viz-poor,#a8320f)" stroke-width="2.8"/>
  <text x="470" y="88" font-size="10" font-weight="700" fill="var(--viz-poor,#a8320f)">ON (geocell, tenant_id)</text>
  <text x="24" y="272" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">The query text, the result and the plan's operator names are identical along both lines. Only the row counts differ.</text>
</svg>

One practical habit closes the loop on all of this. Rather than reasoning about key order once and trusting it, record the seek's row count alongside the final result count for each hot query, and alert when the ratio moves. That ratio is the only number that distinguishes a healthy composite from one whose prefix has quietly stopped applying, and it moves for reasons nobody deploys: a tenant grows until its slice is no longer small, a grid resolution changes and the membership list widens, a new predicate is added to the query and pushes an existing one past the prefix. All three present as a gradual latency drift with an unchanged plan, which is the hardest kind of regression to attribute.

It is also worth writing the intended key order down next to the index definition, in a comment or a migration note, because the reasoning is not recoverable from the DDL. `ON (n.tenant_id, n.geocell)` records what was created; it does not record that the order was chosen because `tenant_id` arrives as an equality and `geocell` as a membership, nor that adding a `status` filter later would need thought rather than a third key. The next person to touch it will otherwise reorder it by selectivity, which is the intuitive thing to do and the wrong one.

## Related

- [Spatial Indexing Strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) — choosing between a point index and a composite in the first place.
- [Scoping Routes with Composite Tenant-Geometry Indexes](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-security-boundaries/scoping-routes-with-composite-tenant-geometry-indexes/) — the same key order read as an isolation guarantee.
- [Reading EXPLAIN and PROFILE Plans for Spatial Queries](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/reading-explain-and-profile-plans-for-spatial-queries/) — the row counts that tell a real seek from a nominal one.
- [Forcing Index Seeks with Cypher Planner Hints](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/forcing-index-seeks-with-cypher-planner-hints/) — what a hint can and cannot do about a badly ordered index.

This guide is part of [Spatial Indexing Strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/), within [Spatial Graph Database Fundamentals for Python](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/).
