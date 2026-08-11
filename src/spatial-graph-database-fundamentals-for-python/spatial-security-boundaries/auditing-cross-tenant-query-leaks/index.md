---
pageTitle: Auditing Cross-Tenant Leaks
title: Auditing Cross-Tenant Query Leaks
description: Prove isolation rather than assume it — a property-based audit that asserts no query can return another tenant's nodes, and that none were even read.
slug: auditing-cross-tenant-query-leaks
type: article
breadcrumb: Leak Auditing
datePublished: 2026-08-11
dateModified: 2026-08-11
---
# Auditing Cross-Tenant Query Leaks

Multi-tenant isolation is the one property in a spatial graph that cannot be verified by looking at results, because a leak that returns nothing looks exactly like correctness. A query missing its tenant predicate returns other tenants' nodes only when the geometry happens to match — so it passes every test written against a fixture where the tenants are far apart, and fails in production the first time two customers operate in the same city. The audit that works therefore has to assert two separate things: that no foreign row is *returned*, and that no foreign row is *read*. The second is the one that catches a filter doing work an access path should have done, and it is the one that turns a leak from a possibility into a measurable quantity.

## Prerequisites & Versions

The audit runs against a seeded fixture; `PROFILE` supplies the read counts.

| Requirement | Minimum version | Install |
| --- | --- | --- |
| Python | 3.11 | — |
| neo4j (async driver) | 5.20 | `pip install "neo4j>=5.20"` |
| Neo4j Server | 5.15 | `PROFILE`, composite indexes |
| pytest / pytest-asyncio | 8.0 / 0.23 | `pip install pytest pytest-asyncio` |

## Implementation

The fixture deliberately *interleaves* tenants in space, because a leak is only detectable where the geometry overlaps.

```python
import asyncio
from dataclasses import dataclass

from neo4j import AsyncGraphDatabase

# Two tenants occupying the SAME square kilometre. A fixture that separates them
# geographically cannot detect a missing tenant predicate at all — the distance
# filter alone excludes the other tenant, and the test passes for the wrong reason.
SEED = """
UNWIND range(0, $per_tenant - 1) AS i
WITH i,
     51.5074 + (i % 20) * 0.0009 AS lat,
     -0.1278 + (i / 20) * 0.0014 AS lon
UNWIND $tenants AS tenant
CREATE (:Location {
  id: tenant + ':' + toString(i),
  tenant_id: tenant,
  location: point({latitude: lat, longitude: lon})
})
"""

AUDIT = """
PROFILE
MATCH (n:Location)
WHERE n.tenant_id = $tenant_id
  AND point.distance(n.location, $centre) <= $radius_m
RETURN collect(DISTINCT n.tenant_id) AS tenants_returned, count(n) AS rows
"""


@dataclass(frozen=True)
class AuditResult:
    tenants_returned: list[str]
    rows_returned: int
    db_hits: int
    rows_from_base_operator: int
    base_operator: str

    @property
    def leaked(self) -> bool:
        """A foreign tenant in the OUTPUT. The obvious failure."""
        return len(self.tenants_returned) > 1

    def over_read(self, expected_rows: int, tolerance: float = 3.0) -> bool:
        """Foreign rows READ but filtered out. The failure nobody sees.

        The output is correct here, so no functional test fails — but the engine
        loaded another tenant's nodes into a candidate set before discarding
        them, which is both a heap cost and the window in which a logic bug
        upstream becomes a disclosure.
        """
        return self.rows_from_base_operator > expected_rows * tolerance


class IsolationAudit:
    def __init__(self, uri: str, auth: tuple[str, str]) -> None:
        self._driver = AsyncGraphDatabase.driver(uri, auth=auth)

    async def close(self) -> None:
        await self._driver.close()

    async def audit(self, tenant_id: str, centre, radius_m: float) -> AuditResult:
        async with self._driver.session() as session:
            result = await session.run(
                AUDIT, tenant_id=tenant_id, centre=centre, radius_m=radius_m
            )
            record = await result.single()
            summary = await result.consume()

        plan = summary.profile or {}
        base = _deepest(plan)
        return AuditResult(
            tenants_returned=list(record["tenants_returned"]),
            rows_returned=int(record["rows"]),
            db_hits=int(plan.get("dbHits", 0)),
            rows_from_base_operator=int(base.get("rows", 0)),
            base_operator=str(base.get("operatorType", "unknown")),
        )


def _deepest(plan: dict) -> dict:
    """The base operator — where rows enter the plan.

    Execution starts at the leaves and flows up, so this is the operator that
    decided how much of the store the query would touch.
    """
    children = plan.get("children") or []
    return _deepest(children[0]) if children else plan
```

## How It Works

Three properties make this an audit rather than a smoke test.

**The fixture interleaves tenants in space.** This is the part most often got wrong. If tenant A's nodes are in London and tenant B's are in Manchester, a query for A with a London radius returns only A's nodes whether or not it filters on tenant — the geometry did the isolation. Such a test passes on a system with no tenant predicate at all. Seeding both tenants into the same grid means the *only* thing that can separate them is the predicate, which is what the audit is for.

**The base operator is inspected, not just the output.** `rows_returned` catches a leak that reached the caller. `rows_from_base_operator` catches the one that did not: an access path that read every tenant's nodes in the radius and let a `Filter` above it discard the foreign ones. The result is correct, so nothing functional fails — but the isolation is now a property of a filter running correctly rather than of the data the query could reach, and that is a materially weaker guarantee.

**The tolerance is a ratio, not a constant.** A healthy composite index with `tenant_id` leading returns close to the answer's row count from the base operator. A degraded one returns roughly the row count times the tenant count. Comparing against a multiple of the expected rows makes the assertion independent of fixture size, so the same test works on ten nodes and ten million.

<svg viewBox="0 0 780 316" role="img" aria-labelledby="leakFixTitle leakFixDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="leakFixTitle">A fixture that separates tenants geographically cannot detect a leak</title>
  <desc id="leakFixDesc">Two fixtures for the same isolation test. On the left, tenant A's nodes are in one city and tenant B's in another; a radius query around A's city returns only A's nodes whether or not the query filters on tenant, because the distance predicate did the separation. That fixture passes against a system with no tenant predicate at all. On the right, both tenants occupy the same grid, so the distance predicate admits both and the only thing that can separate them is the tenant predicate — which is the property under test.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="316" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Where the fixture puts the tenants decides what the test can prove</text>
  <rect x="24" y="42" width="356" height="212" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-poor,#a8320f)" stroke-width="1.6"/>
  <text x="202" y="66" text-anchor="middle" font-size="11.5" font-weight="700" fill="var(--viz-poor,#a8320f)">tenants in different cities</text>
  <circle cx="118" cy="150" r="52" fill="var(--accent,#0a656d)" opacity="0.12"/>
  <circle cx="118" cy="150" r="52" fill="none" stroke="var(--accent,#0a656d)" stroke-width="1.6" stroke-dasharray="6 4"/>
  <g fill="var(--accent,#0a656d)">
    <circle cx="100" cy="132" r="4"/><circle cx="126" cy="140" r="4"/><circle cx="110" cy="164" r="4"/><circle cx="136" cy="168" r="4"/><circle cx="122" cy="118" r="4"/>
  </g>
  <text x="118" y="216" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--accent,#0a656d)">tenant A + radius</text>
  <g fill="var(--accent-2,#a8380b)">
    <circle cx="286" cy="120" r="4"/><circle cx="308" cy="136" r="4"/><circle cx="292" cy="158" r="4"/><circle cx="316" cy="170" r="4"/><circle cx="300" cy="104" r="4"/>
  </g>
  <text x="300" y="216" text-anchor="middle" font-size="9.5" font-weight="700" fill="var(--accent-2,#a8380b)">tenant B, far away</text>
  <text x="202" y="240" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">passes with no tenant predicate at all</text>
  <rect x="400" y="42" width="356" height="212" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="1.8"/>
  <text x="578" y="66" text-anchor="middle" font-size="11.5" font-weight="700" fill="var(--viz-good,#0a656d)">tenants interleaved in one grid</text>
  <circle cx="578" cy="150" r="62" fill="var(--accent,#0a656d)" opacity="0.12"/>
  <circle cx="578" cy="150" r="62" fill="none" stroke="var(--accent,#0a656d)" stroke-width="1.6" stroke-dasharray="6 4"/>
  <g fill="var(--accent,#0a656d)">
    <circle cx="546" cy="120" r="4"/><circle cx="594" cy="128" r="4"/><circle cx="558" cy="160" r="4"/><circle cx="606" cy="166" r="4"/>
    <circle cx="574" cy="140" r="4"/><circle cx="538" cy="176" r="4"/><circle cx="614" cy="142" r="4"/>
  </g>
  <g fill="var(--accent-2,#a8380b)">
    <circle cx="562" cy="132" r="4"/><circle cx="602" cy="150" r="4"/><circle cx="546" cy="148" r="4"/><circle cx="590" cy="180" r="4"/>
    <circle cx="618" cy="120" r="4"/><circle cx="556" cy="192" r="4"/><circle cx="600" cy="110" r="4"/>
  </g>
  <text x="578" y="240" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">only the tenant predicate can separate them</text>
  <text x="24" y="284" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">The left fixture is the one that gets written, because it mirrors how customers are described rather than how their data</text>
  <text x="24" y="300" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">overlaps. Two customers operating in the same city is the normal case, and it is the case the test must model.</text>
</svg>

## Common Failure Patterns

**1. Asserting on the result set alone.** `assert all(n.tenant_id == tenant for n in results)` passes on both a correct query and one whose isolation is a filter above an unscoped seek. It is worth having, but it is not the audit — it is the half of the audit that a leak can satisfy.

**2. Auditing only the query, not the projection.** A Cypher query can be perfectly scoped while a Graph Data Science projection built for routing contains every tenant, so any algorithm run over that projection crosses the boundary freely. The projection needs its own assertion, and the [multi-tenant enforcement guide](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-security-boundaries/enforcing-multi-tenant-security-in-spatial-graphs/) treats it as the hard wall for exactly this reason.

```python
@pytest.mark.asyncio
async def test_projection_holds_one_tenant(session, graph_name, tenant_id):
    result = await session.run(
        "CALL gds.graph.nodeProperties.stream($g, 'tenant_id') "
        "YIELD propertyValue RETURN collect(DISTINCT propertyValue) AS tenants",
        g=graph_name)
    tenants = (await result.single())["tenants"]
    assert tenants == [tenant_id], f"projection spans {tenants}"
```

**3. Running the audit only in CI.** The properties that break isolation change without a deploy: a tenant grows, an index is rebuilt and re-planned, a new predicate shifts the seekable prefix. Running the over-read assertion continuously against production-shaped data catches those; running it once at merge catches only the code.

## Performance Notes

The over-read ratio is the number worth tracking, because it degrades continuously rather than failing:

$$\rho = \frac{\text{rows from the base operator}}{\text{rows returned}}$$

With `tenant_id` leading a composite index, $\rho$ stays near one regardless of how many tenants exist. With the geometry leading, $\rho$ grows roughly linearly with tenant count — so a system that was fine at ten tenants is reading a hundred times more than it returns at a thousand, with no code change and no failing test. Alerting on $\rho$ rather than on latency catches it while it is still only a cost.

Two other measurements are cheap and worth having alongside. **A canary tenant** seeded into the same space as a real one, queried on a schedule, gives a continuous end-to-end assertion that costs one query per interval. And **the count of distinct tenants observed in any single query's output**, recorded as a metric, turns a leak into an alert rather than a support ticket — it should be exactly one, forever, and anything else is worth waking someone for.

Because the audit uses `PROFILE`, it is not free and should not run on every request. A sampled audit — one query in a thousand, or one per tenant per hour — gives the same signal at negligible cost, since a leak caused by an access path affects every query of that shape rather than an unlucky one.

<svg viewBox="0 0 780 292" role="img" aria-labelledby="leakRhoTitle leakRhoDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="leakRhoTitle">The over-read ratio degrades with tenant count while every test stays green</title>
  <desc id="leakRhoDesc">The ratio of rows read to rows returned, plotted against the number of tenants sharing the graph. With the tenant equality leading the composite index, the ratio stays flat at about one — the seek descends straight to one tenant's slice. With the geometry leading, the ratio rises in proportion to tenant count, because the seek returns every tenant's nodes in the search area and a filter above it discards the foreign ones. The returned results are identical along both lines, so no functional test distinguishes them; only the ratio does.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="292" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Rows read ÷ rows returned, as tenants are added</text>
  <line x1="96" y1="48" x2="96" y2="204" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <line x1="96" y1="204" x2="720" y2="204" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <g font-size="9.5" fill="var(--viz-ink-mute,#565f6d)" text-anchor="end">
    <text x="88" y="60">1000×</text><text x="88" y="108">100×</text><text x="88" y="156">10×</text><text x="88" y="208">1×</text>
  </g>
  <g font-size="9.5" fill="var(--viz-ink-mute,#565f6d)" text-anchor="middle">
    <text x="96" y="224">1</text><text x="252" y="224">10</text><text x="408" y="224">100</text><text x="564" y="224">1,000</text><text x="720" y="224">10,000</text>
  </g>
  <text x="408" y="244" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">tenants sharing the graph</text>
  <line x1="96" y1="200" x2="720" y2="200" stroke="var(--viz-good,#0a656d)" stroke-width="2.8"/>
  <text x="110" y="192" font-size="10" font-weight="700" fill="var(--viz-good,#0a656d)">tenant_id leads — flat at 1×</text>
  <path d="M96 200 L252 152 L408 104 L564 58 L646 40" fill="none" stroke="var(--viz-poor,#a8320f)" stroke-width="2.8"/>
  <text x="452" y="90" font-size="10" font-weight="700" fill="var(--viz-poor,#a8320f)">geometry leads — grows with tenant count</text>
  <circle cx="252" cy="152" r="5" fill="var(--viz-poor,#a8320f)"/>
  <text x="264" y="148" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">still fine here, and already wrong</text>
  <text x="24" y="272" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">Both lines return the same rows to the caller at every point, so a functional test cannot tell them apart. Alert on the ratio.</text>
</svg>

Two extensions are worth building once the basic audit is in place, because they cover the paths a query-level assertion cannot see.

The first is an audit of *write* isolation. Everything above concerns reads, and a tenant-scoped read sitting over an unscoped write is a worse defect: a sync job that matches on an external id without a tenant predicate will happily update another tenant's node, and the corruption is silent and permanent. The assertion is the mirror image — seed two tenants with colliding external ids, run the write path for one, and assert the other's properties are byte-identical afterwards. Colliding ids across tenants are normal, since tenants choose their own identifiers, so this is not a contrived fixture.

The second is an audit that runs against the API rather than the database. A query can be perfectly scoped and still leak if the tenant id reaching it came from a request parameter rather than from the authenticated session — the database enforces exactly the boundary it is told about, and it is told by the application. Asserting that a request authenticated as tenant A cannot obtain tenant B's data by supplying B's identifier is a different test from anything in this page, and it catches the failure that the database-level audit is structurally unable to see. Between the three — read path, write path, and identity plumbing — the isolation claim is one you can actually defend, rather than one that has merely never visibly failed.

## Related

- [Enforcing Multi-Tenant Security in Spatial Graphs](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-security-boundaries/enforcing-multi-tenant-security-in-spatial-graphs/) — the composite index and projection this audit verifies.
- [Scoping Routes with Composite Tenant-Geometry Indexes](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-security-boundaries/scoping-routes-with-composite-tenant-geometry-indexes/) — the key order the over-read ratio measures.
- [Composite Index Key Order for Spatial Filters](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-indexing-strategies/composite-index-key-order-for-spatial-filters/) — why the ratio grows when the geometry leads.
- [Reading EXPLAIN and PROFILE Plans for Spatial Queries](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/reading-explain-and-profile-plans-for-spatial-queries/) — locating the base operator the audit reads.

This guide is part of [Spatial Security Boundaries](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/spatial-security-boundaries/), within [Spatial Graph Database Fundamentals for Python](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/).
