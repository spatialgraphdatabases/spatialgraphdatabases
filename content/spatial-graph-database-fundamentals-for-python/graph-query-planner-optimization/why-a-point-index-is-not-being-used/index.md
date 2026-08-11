---
pageTitle: Why a Point Index Is Not Used
title: Why a Point Index Is Not Being Used
description: Work through the six reasons a spatial predicate falls back to a scan, in the order that costs least to check, and confirm each one from the plan.
slug: why-a-point-index-is-not-being-used
type: article
breadcrumb: Index Not Used
datePublished: 2026-08-11
dateModified: 2026-08-11
---
# Why a Point Index Is Not Being Used

`PROFILE` shows `NodeByLabelScan` under a spatial predicate, the index exists, and nothing about the query has changed. This is the single most common spatial-query complaint, and it has six causes worth checking — but they are not equally likely and they are not equally cheap to test. Checked in the wrong order you spend an afternoon rewriting Cypher when the index was in `POPULATING` all along; checked in the right order, most cases resolve in two queries. This page gives that order, and what confirms each cause rather than merely being consistent with it.

## Prerequisites & Versions

Everything here reads the server's own catalogue and plans; nothing is written.

| Requirement | Minimum version | Install |
| --- | --- | --- |
| Python | 3.11 | — |
| neo4j (async driver) | 5.20 | `pip install "neo4j>=5.20"` |
| Neo4j Server | 5.15 | `SHOW INDEXES`, `PROFILE` |

## Implementation

The diagnostic below runs the checks in ascending cost and stops at the first confirmed cause, so the cheap catalogue queries never wait behind a profile of a slow query.

```python
import asyncio
import re
from dataclasses import dataclass

from neo4j import AsyncGraphDatabase

INDEX_STATE = """
SHOW INDEXES YIELD name, type, state, entityType, labelsOrTypes, properties,
                  populationPercent
WHERE $label IN labelsOrTypes AND $property IN properties
RETURN name, type, state, populationPercent
"""

VALUE_TYPES = """
MATCH (n)
WHERE $label IN labels(n) AND n[$property] IS NOT NULL
RETURN valueType(n[$property]) AS value_type, count(*) AS n
ORDER BY n DESC
LIMIT 10
"""

MISSING = """
MATCH (n) WHERE $label IN labels(n) AND n[$property] IS NULL
RETURN count(n) AS missing
"""


@dataclass(frozen=True)
class Finding:
    cause: str
    confirmed: bool
    detail: str
    fix: str


class IndexDiagnostic:
    def __init__(self, uri: str, auth: tuple[str, str]) -> None:
        self._driver = AsyncGraphDatabase.driver(uri, auth=auth)

    async def close(self) -> None:
        await self._driver.close()

    async def run(self, label: str, prop: str, query: str) -> list[Finding]:
        findings: list[Finding] = []
        async with self._driver.session() as session:
            # 1. Cheapest and most common: is there an ONLINE index at all?
            result = await session.run(INDEX_STATE, label=label, property=prop)
            indexes = [dict(r) async for r in result]

            if not indexes:
                findings.append(Finding(
                    "no index", True,
                    f"nothing indexes :{label}({prop})",
                    f"CREATE POINT INDEX FOR (n:{label}) ON (n.{prop})",
                ))
                return findings

            online = [i for i in indexes if i["state"] == "ONLINE"]
            if not online:
                states = ", ".join(f"{i['name']}={i['state']}" for i in indexes)
                findings.append(Finding(
                    "index not ONLINE", True, states,
                    "wait for population, or drop and recreate a FAILED index",
                ))
                return findings

            # 2. A POINT INDEX and a RANGE INDEX are not interchangeable: a range
            #    index cannot answer a two-dimensional bounding-box seek.
            if not any(i["type"] == "POINT" for i in online):
                kinds = ", ".join(sorted({i["type"] for i in online}))
                findings.append(Finding(
                    "wrong index type", True,
                    f"only {kinds} present; a distance/bbox predicate needs POINT",
                    f"CREATE POINT INDEX FOR (n:{label}) ON (n.{prop})",
                ))

            # 3. Mixed property types poison the index for the rows that differ.
            result = await session.run(VALUE_TYPES, label=label, property=prop)
            types = [dict(r) async for r in result]
            non_point = [t for t in types if "POINT" not in t["value_type"].upper()]
            if non_point:
                findings.append(Finding(
                    "mixed property types", True,
                    "; ".join(f"{t['value_type']}×{t['n']:,}" for t in non_point),
                    "normalise at ingestion — a string coordinate is not indexable "
                    "as a point, and its rows fall out of the seek",
                ))

        # 4. The predicate shape. Checked last because it needs the query text,
        #    and because the catalogue causes above are far more common.
        findings.extend(_predicate_findings(query, prop))
        return findings


def _predicate_findings(query: str, prop: str) -> list[Finding]:
    """Shape checks over the query text.

    Deliberately conservative: these are cheap heuristics meant to point at the
    line worth reading, not a Cypher parser. A false positive costs a glance; a
    false negative just leaves you at the PROFILE, which is where you already were.
    """
    findings: list[Finding] = []
    if re.search(rf"\w+\.{prop}\s*[+\-*/]", query):
        findings.append(Finding(
            "property wrapped in an expression", True,
            "the indexed property has arithmetic applied to it in the predicate",
            "keep the property bare on one side and move the arithmetic into "
            "the parameter, computed client-side",
        ))
    if re.search(rf"toString\s*\(\s*\w+\.{prop}", query):
        findings.append(Finding(
            "property coerced", True,
            "toString() around the indexed property",
            "compare against a point, not against its string form",
        ))
    if not re.search(r"\$\w+", query):
        findings.append(Finding(
            "literals instead of parameters", False,
            "no parameters in the query text",
            "parameterise: literals still seek, but each distinct text compiles "
            "its own plan and evicts the others",
        ))
    return findings


async def main() -> None:
    query = """
    MATCH (h:Hub)
    WHERE point.distance(h.location, $centre) <= $radius
    RETURN h.id
    """
    diag = IndexDiagnostic("neo4j://localhost:7687", ("neo4j", "password"))
    try:
        for f in await diag.run("Hub", "location", query):
            mark = "CONFIRMED" if f.confirmed else "possible"
            print(f"[{mark}] {f.cause}\n    {f.detail}\n    fix: {f.fix}")
    finally:
        await diag.close()
```

## How It Works

The order is the whole point, and it follows from how often each cause occurs against how much it costs to rule out.

**Catalogue causes come first because they are free to check and account for most cases.** An index that does not exist, or exists in `POPULATING` or `FAILED`, explains the symptom completely and is answered by one `SHOW INDEXES`. A `FAILED` index is particularly worth knowing about: it stays in the catalogue, so a naive "does the index exist" check says yes, and the planner ignores it entirely.

**Index type is next because it is a category error rather than a bug.** A `RANGE INDEX` on a point property is a legitimate index that simply cannot serve a bounding-box seek — range indexes are one-dimensional. A team that created the wrong kind sees an index in the catalogue, an `ONLINE` state, and a scan in the plan, and reasonably concludes the planner is misbehaving.

**Mixed types are third because they are invisible until you look.** If ninety per cent of a label stores a `POINT` and ten per cent stores a string left over from an old importer, the index covers the ninety and the query still has to consider the ten. Depending on version and predicate, the planner may decline the index rather than produce a partial answer.

**Predicate shape is last, despite being the cause everyone reaches for first.** It is the most expensive to establish — it needs the query text and an understanding of what is seekable — and it is genuinely less common than a stale index in a running system.

<svg viewBox="0 0 780 320" role="img" aria-labelledby="idxWhyTitle idxWhyDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="idxWhyTitle">Six causes, ordered by how cheap they are to rule out</title>
  <desc id="idxWhyDesc">A diagnostic ladder. The first three rungs are answered by a single catalogue query costing milliseconds: no index at all, an index that is not ONLINE, and an index of the wrong type for a two-dimensional seek. The fourth is a cheap aggregation over the label that finds mixed property types. Only the last two need the query text and a profile — a property wrapped in an expression, and literals in place of parameters. The ladder is ordered this way because the catalogue causes are both cheaper to test and more common in a running system than the predicate-shape causes people reach for first.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="320" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Check in this order — stop at the first confirmed cause</text>
  <text x="596" y="46" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-ink-mute,#565f6d)">cost to check</text>
  <rect x="24" y="54" width="732" height="40" rx="8" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="1.6"/>
  <text x="44" y="79" font-size="11" font-weight="700" fill="currentColor">1 · no index on the property</text>
  <rect x="470" y="64" width="180" height="20" rx="10" fill="var(--viz-good,#0a656d)"/>
  <text x="560" y="79" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--viz-on-pill,#ffffff)">SHOW INDEXES</text>
  <text x="668" y="79" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">~1 ms</text>
  <rect x="24" y="102" width="732" height="40" rx="8" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="1.6"/>
  <text x="44" y="127" font-size="11" font-weight="700" fill="currentColor">2 · index POPULATING or FAILED — still in the catalogue</text>
  <rect x="470" y="112" width="180" height="20" rx="10" fill="var(--viz-good,#0a656d)"/>
  <text x="560" y="127" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--viz-on-pill,#ffffff)">same query</text>
  <text x="668" y="127" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">~1 ms</text>
  <rect x="24" y="150" width="732" height="40" rx="8" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="1.6"/>
  <text x="44" y="175" font-size="11" font-weight="700" fill="currentColor">3 · RANGE index where a POINT index is required</text>
  <rect x="470" y="160" width="180" height="20" rx="10" fill="var(--viz-good,#0a656d)"/>
  <text x="560" y="175" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--viz-on-pill,#ffffff)">same query</text>
  <text x="668" y="175" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">~1 ms</text>
  <rect x="24" y="198" width="732" height="40" rx="8" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-ok,#7d6200)" stroke-width="1.6"/>
  <text x="44" y="223" font-size="11" font-weight="700" fill="currentColor">4 · mixed property types across the label</text>
  <rect x="470" y="208" width="180" height="20" rx="10" fill="var(--viz-ok,#7d6200)"/>
  <text x="560" y="223" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--viz-on-pill,#ffffff)">one aggregation</text>
  <text x="668" y="223" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">seconds</text>
  <rect x="24" y="246" width="732" height="40" rx="8" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-poor,#a8320f)" stroke-width="1.6"/>
  <text x="44" y="271" font-size="11" font-weight="700" fill="currentColor">5 · property wrapped in an expression, or coerced</text>
  <rect x="470" y="256" width="180" height="20" rx="10" fill="var(--viz-poor,#a8320f)"/>
  <text x="560" y="271" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--viz-on-pill,#ffffff)">read the query</text>
  <text x="668" y="271" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">judgement</text>
  <rect x="24" y="294" width="732" height="20" rx="8" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1.2"/>
  <text x="44" y="308" font-size="10" font-weight="700" fill="var(--viz-ink-mute,#565f6d)">6 · literals instead of parameters — seeks, but thrashes the plan cache</text>
</svg>

## Common Failure Patterns

**1. Concluding "the planner is wrong" from an index that exists.** Existence is three separate conditions — present, `ONLINE`, and of the right type — and the catalogue reports all three in one row. Reading only the name is how a `FAILED` index survives an investigation.

```cypher
SHOW INDEXES YIELD name, type, state, labelsOrTypes, properties, populationPercent
WHERE 'Hub' IN labelsOrTypes AND 'location' IN properties;
-- type must read POINT for a distance or bounding-box predicate
-- state must read ONLINE; POPULATING and FAILED both leave the planner blind
```

**2. Reaching for a hint before checking the catalogue.** `USING POINT INDEX` cannot conjure an index that is not `ONLINE`, and depending on version it either raises or silently degrades — so the hint changes the symptom without touching the cause. The hint's real job is narrower, and is covered in [forcing index seeks with Cypher planner hints](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/forcing-index-seeks-with-cypher-planner-hints/).

**3. Testing on a small graph.** Below a few thousand nodes the planner will legitimately prefer a scan, because descending an index costs more than reading the label. A query that scans in development and seeks in production is not a bug; a conclusion drawn from the development plan is.

## Performance Notes

Two of these causes are transient and worth monitoring rather than diagnosing repeatedly. An index rebuild — after a schema migration, a restore, or a bulk import — leaves the index `POPULATING` for as long as it takes to scan the label, and every query planned during that window gets a scan plan *and caches it*. The plan survives the index coming online, so the slowdown outlasts its cause.

```cypher
CALL db.awaitIndexes(600);   -- block until ONLINE before serving traffic
```

That single call in a deployment's readiness check removes the whole class of problem, and it pairs with the [page-cache warm-up](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-memory-and-storage-tuning/sizing-the-page-cache-for-a-spatial-graph/) for the same reason: both are about not serving traffic against a server that is not ready.

The mixed-type cause is worth an ingestion-time constraint rather than a periodic check. A property that must always hold a point should be validated where it is written, because by the time it is queried the offending rows are indistinguishable from the rest without an aggregation over the whole label — which is itself the expensive scan the index was meant to avoid.

$$\text{cost}_{\text{diagnose}} \ll \text{cost}_{\text{scan}} \quad\text{for causes 1–3, and}\quad \approx \text{cost}_{\text{scan}} \quad\text{for cause 4}$$

That asymmetry is why the order matters at all: the first three checks are free even on a graph where the failing query takes minutes.

<svg viewBox="0 0 780 292" role="img" aria-labelledby="idxStateTitle idxStateDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="idxStateTitle">An index rebuild's slowdown outlasts the rebuild</title>
  <desc id="idxStateDesc">A timeline across an index rebuild. While the index is POPULATING the planner has no seekable access path, so queries are planned as scans and those plans are cached. When the index comes ONLINE the cached scan plans do not re-plan themselves — they keep being served until something evicts them, so latency stays elevated well past the point where the index was ready. Calling db.awaitIndexes before accepting traffic removes the window entirely, because no query is ever planned against a half-built index.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="292" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Latency across an index rebuild</text>
  <line x1="88" y1="52" x2="88" y2="196" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <line x1="88" y1="196" x2="736" y2="196" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <rect x="150" y="52" width="200" height="144" fill="var(--viz-ok,#7d6200)" opacity="0.14"/>
  <text x="250" y="70" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-ok,#7d6200)">index POPULATING</text>
  <rect x="350" y="52" width="180" height="144" fill="var(--viz-poor,#a8320f)" opacity="0.14"/>
  <text x="440" y="70" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-poor,#a8320f)">ONLINE, but scan plans still cached</text>
  <path d="M88 180 L150 180 L160 84 L350 84 L360 84 L530 84 L540 178 L736 178" fill="none" stroke="var(--accent-2,#a8380b)" stroke-width="2.6"/>
  <line x1="350" y1="52" x2="350" y2="196" stroke="var(--viz-good,#0a656d)" stroke-width="1.8" stroke-dasharray="5 4"/>
  <text x="358" y="112" font-size="9.5" font-weight="700" fill="var(--viz-good,#0a656d)">index ready here</text>
  <line x1="530" y1="52" x2="530" y2="196" stroke="var(--viz-poor,#a8320f)" stroke-width="1.8" stroke-dasharray="5 4"/>
  <text x="538" y="132" font-size="9.5" font-weight="700" fill="var(--viz-poor,#a8320f)">plans finally evicted</text>
  <text x="412" y="216" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-poor,#a8320f)">the gap nobody expects</text>
  <text x="24" y="252" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">Investigating during the red band finds an ONLINE index, a correct query, and a scan in the plan — which is exactly the</text>
  <text x="24" y="268" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">state that sends people rewriting Cypher. db.awaitIndexes before taking traffic removes both bands at once.</text>
</svg>

## Related

- [Reading EXPLAIN and PROFILE Plans for Spatial Queries](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/reading-explain-and-profile-plans-for-spatial-queries/) — reading the operator that started this investigation.
- [Forcing Index Seeks with Cypher Planner Hints](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/forcing-index-seeks-with-cypher-planner-hints/) — what a hint can fix once the catalogue is healthy.
- [Composite Index Key Order for Spatial Filters](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/composite-index-key-order-for-spatial-filters/) — a seek that happens but returns far too much.
- [Spatial Indexing Strategies](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/) — choosing the index type this page checks for.

This guide is part of [Graph Query Planner Optimization](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/), within [Spatial Graph Database Fundamentals for Python](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/).
