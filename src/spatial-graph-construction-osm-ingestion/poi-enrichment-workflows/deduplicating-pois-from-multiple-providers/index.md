---
pageTitle: Deduplicating POIs
title: Deduplicating POIs from Multiple Providers
description: Match the same place across feeds using a blocked candidate search and a weighted score, and keep the merge reversible when the match turns out to be wrong.
slug: deduplicating-pois-from-multiple-providers
type: article
breadcrumb: POI Deduplication
datePublished: 2026-08-11
dateModified: 2026-08-11
---
# Deduplicating POIs from Multiple Providers

Two feeds describe the same café forty metres apart with names that differ by a suffix, and a third has it at the right coordinate under its former owner's name. Deciding whether those are one place or three is the whole of POI deduplication, and neither extreme is safe: merging too eagerly collapses a shopping centre's twelve units into one, and merging too cautiously leaves a map showing three cafés on one corner. What makes it tractable is that the decision does not have to be binary — a scored match with a review band, and a merge that keeps its sources, turns an irreversible guess into an auditable one.

## Prerequisites & Versions

Candidate search uses the point index; scoring is client-side.

| Requirement | Minimum version | Install |
| --- | --- | --- |
| Python | 3.11 | — |
| neo4j (async driver) | 5.20 | `pip install "neo4j>=5.20"` |
| Neo4j Server | 5.15 | native `point`, `POINT INDEX` |
| rapidfuzz | 3.9 | `pip install "rapidfuzz>=3.9"` |

## Implementation

```python
import math
import re
from dataclasses import dataclass

from rapidfuzz import fuzz

EARTH_R = 6_371_008.8

# Suffixes that carry no identity. Stripping them before comparison stops
# "Blue Door Cafe" and "Blue Door Cafe Ltd" scoring as different places.
NOISE = re.compile(
    r"\b(ltd|limited|plc|inc|llc|gmbh|the|co|company|store|shop|branch)\b|[^\w\s]",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class Poi:
    id: str
    provider: str
    name: str
    lat: float
    lon: float
    category: str | None = None
    phone: str | None = None


@dataclass(frozen=True)
class Match:
    a: Poi
    b: Poi
    score: float
    distance_m: float

    @property
    def verdict(self) -> str:
        # Three bands rather than two. The middle one is the point: a system
        # that must decide every pair will decide the ambiguous ones badly.
        if self.score >= 0.85:
            return "merge"
        if self.score >= 0.60:
            return "review"
        return "distinct"


def normalise(name: str) -> str:
    return " ".join(NOISE.sub(" ", name).lower().split())


def haversine_m(a: Poi, b: Poi) -> float:
    p1, p2 = math.radians(a.lat), math.radians(b.lat)
    dp, dl = p2 - p1, math.radians(b.lon - a.lon)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_R * math.asin(math.sqrt(h))


def score(a: Poi, b: Poi, tolerance_m: float = 60.0) -> Match:
    """Weighted agreement across the signals, each contributing independently.

    Distance alone is not enough — a shopping centre packs dozens of distinct
    businesses inside the tolerance. Name alone is not enough either, because
    chains repeat the same name across a city. The combination is what
    discriminates, which is why this is a weighted sum rather than a cascade
    of thresholds.
    """
    d = haversine_m(a, b)

    # Decays to zero at the tolerance rather than stepping, so a pair at 59 m
    # and one at 61 m are not treated as categorically different.
    proximity = max(0.0, 1.0 - d / tolerance_m)
    name = fuzz.token_sort_ratio(normalise(a.name), normalise(b.name)) / 100.0

    weights = {"proximity": 0.45, "name": 0.40}
    total = proximity * 0.45 + name * 0.40

    # Corroborating signals only add; their absence never penalises, because
    # most feeds carry them sparsely and a missing phone is not evidence of
    # difference.
    if a.phone and b.phone and _digits(a.phone) == _digits(b.phone):
        total += 0.15
    elif a.category and b.category and a.category == b.category:
        total += 0.05

    return Match(a=a, b=b, score=min(total, 1.0), distance_m=d)


def _digits(phone: str) -> str:
    return re.sub(r"\D", "", phone)[-9:]


# Blocking: only pairs within the tolerance are ever scored. Without this the
# comparison is quadratic in the feed size and unusable past a few thousand rows.
CANDIDATES = """
MATCH (p:Poi)
WHERE p.provider <> $provider
  AND p.location.latitude  >= $min_lat AND p.location.latitude  <= $max_lat
  AND p.location.longitude >= $min_lon AND p.location.longitude <= $max_lon
RETURN p.id AS id, p.provider AS provider, p.name AS name,
       p.location.latitude AS lat, p.location.longitude AS lon,
       p.category AS category, p.phone AS phone
"""

# The merge keeps its inputs. A canonical node links to every source record, so
# a wrong match is undone by deleting one relationship rather than by trying to
# reconstruct data that was overwritten.
MERGE_INTO_CANONICAL = """
MERGE (c:Place {canonical_id: $canonical_id})
  ON CREATE SET c.location = point({latitude: $lat, longitude: $lon}),
                c.name = $name, c.created_at = datetime()
WITH c
UNWIND $source_ids AS sid
MATCH (p:Poi {id: sid})
MERGE (p)-[r:SAME_AS]->(c)
  ON CREATE SET r.score = $score, r.matched_at = datetime(), r.method = 'auto'
RETURN count(r) AS linked
"""
```

## How It Works

**Blocking makes the problem linear.** Comparing every POI against every other is quadratic and impossible past a few thousand records; restricting candidates to those within the tolerance turns it into a bounded index seek per record. The block is the same latitude-corrected box a [radius query](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/latitude-corrected-bounding-boxes-in-python/) uses, and the tolerance doubles as both the block radius and the proximity denominator.

**No single signal discriminates, which is why the score is a weighted sum.** Distance fails inside a shopping centre where dozens of distinct businesses sit within metres of each other. Name fails on chains, where a dozen genuinely different branches share a name across a city. Together they separate cleanly: same name *and* same place is a strong signal that neither provides alone. Corroborating signals like a matching phone number add confidence without being required, because feeds carry them inconsistently and a missing field is not evidence of difference.

**Three bands, not two.** The middle band is the design decision that makes this safe to run automatically. A system forced to decide every pair will decide the genuinely ambiguous ones arbitrarily; routing them to review means the automatic merges are the confident ones and a human sees exactly the cases where the evidence is mixed. On real feeds that band is small — typically a few per cent of pairs — which is what makes reviewing it affordable.

<svg viewBox="0 0 780 316" role="img" aria-labelledby="dedupSigTitle dedupSigDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="dedupSigTitle">Why neither distance nor name discriminates alone</title>
  <desc id="dedupSigDesc">Three pairs of records plotted against name similarity and separation distance. Twelve units inside one shopping centre are all within twenty metres of each other and have completely different names — close but distinct. Two branches of a coffee chain across the same city have identical names and are four kilometres apart — same name but distinct. The same café listed by two providers is thirty metres apart with names differing only by a company suffix — the only pair that scores highly on both axes, and the only one that should merge. A threshold on either axis alone would misclassify two of the three.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="316" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Name similarity against separation</text>
  <line x1="150" y1="48" x2="150" y2="220" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <line x1="150" y1="220" x2="720" y2="220" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <g font-size="9.5" fill="var(--viz-ink-mute,#565f6d)" text-anchor="end">
    <text x="142" y="60">100%</text><text x="142" y="140">50%</text><text x="142" y="216">0%</text>
  </g>
  <text x="52" y="140" font-size="10" font-weight="700" fill="currentColor" transform="rotate(-90 52 140)">name match</text>
  <g font-size="9.5" fill="var(--viz-ink-mute,#565f6d)" text-anchor="middle">
    <text x="152" y="240">0 m</text><text x="300" y="240">60 m</text><text x="480" y="240">500 m</text><text x="660" y="240">5 km</text>
  </g>
  <text x="420" y="260" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">separation</text>
  <rect x="180" y="48" width="152" height="60" fill="var(--viz-good,#0a656d)" opacity="0.14"/>
  <text x="256" y="42" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--viz-good,#0a656d)">merge band</text>
  <circle cx="212" cy="70" r="8" fill="var(--viz-good,#0a656d)"/>
  <text x="230" y="76" font-size="10" font-weight="700" fill="var(--viz-good,#0a656d)">same café, two providers — 30 m, names differ by "Ltd"</text>
  <circle cx="192" cy="196" r="8" fill="var(--viz-poor,#a8320f)"/>
  <text x="210" y="200" font-size="10" font-weight="700" fill="var(--viz-poor,#a8320f)">12 units in one shopping centre — close, unrelated names</text>
  <circle cx="660" cy="60" r="8" fill="var(--viz-poor,#a8320f)"/>
  <text x="646" y="88" text-anchor="end" font-size="10" font-weight="700" fill="var(--viz-poor,#a8320f)">two branches of a chain — identical name, 4 km apart</text>
  <rect x="24" y="272" width="732" height="34" rx="8" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1.2"/>
  <text x="44" y="294" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">A distance threshold alone merges the shopping centre; a name threshold alone merges the chain. Only the corner does both.</text>
</svg>

## Common Failure Patterns

**1. Merging destructively.** Overwriting one record with another loses the evidence that would let a wrong match be undone, and wrong matches are inevitable at any threshold. Linking sources to a canonical node with `SAME_AS` keeps every original intact, so reversing a merge is deleting a relationship rather than restoring from a backup.

**2. Letting a missing field count against a pair.** A provider that does not publish phone numbers would otherwise score systematically lower against every other feed, purely because of what it omits. Corroborating signals should only ever add — absence is not evidence.

**3. Applying one tolerance everywhere.** Sixty metres is generous in a dense high street and tight in a retail park where the same store's two records sit either side of a car park. Deriving the tolerance from local POI density, or simply from the category, keeps the same score meaningful in both.

```python
# Density-aware tolerance: tighter where places are packed together.
def tolerance_for(local_poi_count: int, area_km2: float) -> float:
    density = local_poi_count / max(area_km2, 0.01)
    return 30.0 if density > 400 else 60.0 if density > 80 else 120.0
```

## Performance Notes

Blocking is what makes the cost tractable, and the arithmetic is worth stating because it is the difference between a job that runs and one that does not:

$$C_{\text{naive}} = O(n^2), \qquad C_{\text{blocked}} \approx n \cdot (\log n + \bar{k})$$

with $\bar{k}$ the mean candidate count inside the tolerance — typically under ten even in dense areas. On a million-record feed, the naive comparison is 5 × 10¹¹ pairs and the blocked one is about 10⁷ scored comparisons, which is minutes rather than never.

The string comparison is then the inner-loop cost, and normalising once rather than per comparison matters more than the choice of algorithm: each record's normalised name should be computed when it is loaded and stored, not recomputed for every candidate pair it participates in. That single change is usually worth more than swapping the similarity function.

Deduplication is also a natural fit for incremental work. Most of a feed is unchanged between refreshes, so re-scoring everything is waste — matching only records whose name or coordinate moved, plus their neighbours, reduces a full pass to a few per cent. That requires the same content-hash discipline that makes an [incremental re-import](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/) affordable, and it pays off twice for the same bookkeeping.

<svg viewBox="0 0 780 284" role="img" aria-labelledby="dedupBlockTitle dedupBlockDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="dedupBlockTitle">Pairs scored, with and without spatial blocking</title>
  <desc id="dedupBlockDesc">Scored comparisons against feed size. Without blocking, every record is compared with every other, so the count grows with the square of the feed and reaches five hundred billion pairs at a million records. With blocking, only records inside the tolerance of each other are ever compared, so the count grows close to linearly and reaches about ten million at the same feed size. The answers are identical, because every pair the blocked version skips is further apart than the tolerance and would have scored below the distinct threshold anyway.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="284" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Pairs actually scored, by feed size</text>
  <line x1="112" y1="48" x2="112" y2="204" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <line x1="112" y1="204" x2="720" y2="204" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <g font-size="9.5" fill="var(--viz-ink-mute,#565f6d)" text-anchor="end">
    <text x="104" y="60">10¹²</text><text x="104" y="108">10⁹</text><text x="104" y="156">10⁶</text><text x="104" y="208">10³</text>
  </g>
  <g font-size="9.5" fill="var(--viz-ink-mute,#565f6d)" text-anchor="middle">
    <text x="112" y="224">1k</text><text x="264" y="224">10k</text><text x="416" y="224">100k</text><text x="568" y="224">1M</text><text x="720" y="224">10M</text>
  </g>
  <text x="416" y="244" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">records in the feed</text>
  <path d="M112 172 L264 140 L416 106 L568 72 L720 52" fill="none" stroke="var(--viz-poor,#a8320f)" stroke-width="2.8"/>
  <text x="470" y="94" font-size="10" font-weight="700" fill="var(--viz-poor,#a8320f)">all pairs — 5 × 10¹¹ at 1M</text>
  <path d="M112 196 L264 180 L416 164 L568 148 L720 132" fill="none" stroke="var(--viz-good,#0a656d)" stroke-width="2.8"/>
  <text x="470" y="172" font-size="10" font-weight="700" fill="var(--viz-good,#0a656d)">blocked — 10⁷ at 1M</text>
  <text x="24" y="268" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">Identical output: every pair the blocked version skips is beyond the tolerance and would have scored as distinct regardless.</text>
</svg>

One further property makes the canonical model worth the extra node. Because every source record survives and links to the place rather than being folded into it, provenance is queryable: which providers assert this place exists, when each last confirmed it, and which of them supplied the coordinate currently in use. That turns a class of downstream question from guesswork into a lookup — a place asserted by three feeds and confirmed last week is a different proposition from one asserted by a single feed two years ago, and a consumer choosing which POIs to show can act on that distinction without knowing anything about how the matching worked.

It also gives the review band somewhere to live. A pair in the middle band can be recorded as a candidate link with its score and left unmerged, so the reviewer's queue is a query rather than a separate system, and a decision writes the same `SAME_AS` relationship the automatic path writes with its `method` set to `manual`. Keeping both paths in one shape means the confidence distribution of the whole dataset stays inspectable, which is the thing you want when someone asks how trustworthy the deduplication actually is.

## Related

- [POI Enrichment Workflows](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/poi-enrichment-workflows/) — the pipeline this feeds cleaned records into.
- [Latitude-Corrected Bounding Boxes in Python](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/distance-filter-query-patterns/latitude-corrected-bounding-boxes-in-python/) — the block this candidate search uses.
- [Reverse Geocoding POI Nodes to Admin Boundaries](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/poi-enrichment-workflows/reverse-geocoding-poi-nodes-to-admin-boundaries/) — what a canonical place gets linked to once it exists.
- [Syncing External Attribute Changes to Graph Nodes](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/attribute-synchronization-techniques/syncing-external-attribute-changes-to-graph-nodes/) — keeping the canonical record current once several feeds write to it.

This guide is part of [POI Enrichment Workflows](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/poi-enrichment-workflows/), within [Spatial Graph Construction & OSM Ingestion](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/).
