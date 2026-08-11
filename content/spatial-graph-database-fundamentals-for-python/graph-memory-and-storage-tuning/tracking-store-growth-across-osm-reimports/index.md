---
pageTitle: Tracking Store Growth
title: Tracking Store Growth Across OSM Re-imports
description: Watch the store grow while the graph's logical size stays flat, tell property churn apart from real data, and know when a compaction is overdue.
slug: tracking-store-growth-across-osm-reimports
type: article
breadcrumb: Store Growth
datePublished: 2026-08-11
dateModified: 2026-08-11
---
# Tracking Store Growth Across OSM Re-imports

Here is a number that surprises people the first time they see it: a graph whose node and relationship counts have not moved in three months, whose store files have grown forty per cent. Nothing was added. The weekly OSM re-import updated tags on existing ways, a live feed kept `travel_s` current, and every one of those updates left something behind. Store growth that is not matched by logical growth is property churn, and it matters because the store is what the page cache has to cover — a graph that is quietly getting larger on disk is quietly getting slower, without a single query changing. This page separates the two kinds of growth and shows when the difference has become worth acting on.

## Prerequisites & Versions

The counts come from `db.stats`, which is available on all supported 5.x servers. File sizes come from the filesystem, so the sampler needs to run where the store lives — or read them from whatever already exports them.

| Requirement | Minimum version | Install |
| --- | --- | --- |
| Python | 3.11 | — |
| neo4j (async driver) | 5.20 | `pip install "neo4j>=5.20"` |
| Neo4j Server | 5.15 | `db.stats.retrieve` |

## Implementation

The recorder below takes one sample per import and keeps them in a small history. The value is entirely in the comparison: bytes per node is flat on a healthy graph and rises on one that is accumulating dead property records.

```python
import asyncio
import json
import pathlib
from dataclasses import dataclass, asdict

from neo4j import AsyncGraphDatabase

COUNTS = """
CALL db.stats.retrieve('GRAPH COUNTS') YIELD data
RETURN data.nodes AS nodes, data.relationships AS relationships
"""


@dataclass(frozen=True)
class StoreSample:
    label: str
    nodes: int
    relationships: int
    store_bytes: int

    @property
    def bytes_per_element(self) -> float:
        elements = self.nodes + self.relationships
        return self.store_bytes / elements if elements else 0.0


class StoreHistory:
    """A per-import record of logical size against physical size.

    Neither number means much alone. A store that grows because the graph grew
    is doing its job; one that grows while the element count is flat is holding
    records nothing references, and only the ratio shows the difference.
    """

    def __init__(self, path: pathlib.Path) -> None:
        self._path = path
        self._samples: list[StoreSample] = []
        if path.exists():
            self._samples = [StoreSample(**row) for row in json.loads(path.read_text())]

    def add(self, sample: StoreSample) -> None:
        self._samples.append(sample)
        self._path.write_text(json.dumps([asdict(s) for s in self._samples], indent=2))

    def churn_ratio(self, window: int = 6) -> float:
        """How much bytes-per-element has drifted over the last `window` imports.

        1.0 means physical size is tracking logical size exactly. Above about
        1.25 there is materially more store than the current data needs.
        """
        recent = self._samples[-window:]
        if len(recent) < 2:
            return 1.0
        first, last = recent[0], recent[-1]
        if not first.bytes_per_element:
            return 1.0
        return last.bytes_per_element / first.bytes_per_element

    def report(self) -> str:
        lines = [f"{'import':<22}{'nodes':>12}{'rels':>14}{'store GiB':>12}{'B/elem':>10}"]
        for s in self._samples:
            lines.append(
                f"{s.label:<22}{s.nodes:>12,}{s.relationships:>14,}"
                f"{s.store_bytes / 1024 ** 3:>12.2f}{s.bytes_per_element:>10.1f}"
            )
        ratio = self.churn_ratio()
        verdict = (
            "compaction overdue" if ratio > 1.25
            else "watch" if ratio > 1.10
            else "healthy"
        )
        lines.append(f"\nbytes-per-element drift over the window: {ratio:.2f}× — {verdict}")
        return "\n".join(lines)


async def sample(uri: str, auth: tuple[str, str], store_dir: pathlib.Path,
                 label: str) -> StoreSample:
    driver = AsyncGraphDatabase.driver(uri, auth=auth)
    try:
        async with driver.session() as session:
            result = await session.run(COUNTS)
            record = await result.single()
    finally:
        await driver.close()

    # Every file under the database directory, not just the node store: the
    # index files are the ones a spatial query reads first.
    store_bytes = sum(f.stat().st_size for f in store_dir.rglob("*") if f.is_file())

    return StoreSample(
        label=label,
        nodes=int(record["nodes"]),
        relationships=int(record["relationships"]),
        store_bytes=store_bytes,
    )


async def main() -> None:
    history = StoreHistory(pathlib.Path("store-history.json"))
    current = await sample(
        "neo4j://localhost:7687",
        ("neo4j", "password"),
        pathlib.Path("/var/lib/neo4j/data/databases/neo4j"),
        label="2026-W32 import",
    )
    history.add(current)
    print(history.report())


if __name__ == "__main__":
    asyncio.run(main())
```

## How It Works

Two mechanisms produce store growth, and the ratio separates them.

**Real growth** is new nodes and relationships. Bytes and elements rise together, bytes-per-element stays flat, and the correct response is to revisit the [page cache budget](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-memory-and-storage-tuning/sizing-the-page-cache-for-a-spatial-graph/) because the working set has genuinely got bigger.

**Property churn** is an update path leaving records behind. Fixed-width property values are rewritten in place and cost nothing extra, but a value that does not fit inline — a long string tag, a list, a changed-length name — is stored as a chain of dynamic records, and updating it allocates a new chain rather than editing the old one. The old chain stops being referenced but does not stop occupying the file. Do that weekly across a few million ways and the store grows steadily while the graph does not, which is precisely the signal bytes-per-element is built to show.

The asymmetry that makes this a spatial-graph problem specifically is that routing graphs are update-heavy in exactly the way that produces churn. Coordinates are fixed-width and cheap to update. Tags are not: the highway class, the name, the access restrictions, the speed profile as a string — these are the fields an OSM re-import touches, and each touch on a value whose length changed leaves the previous version behind.

<svg viewBox="0 0 780 300" role="img" aria-labelledby="churnTitle churnDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="churnTitle">Bytes per element separates a graph that grew from one that churned</title>
  <desc id="churnDesc">Two series over twelve weekly imports. Element count, the logical size of the graph, rises gently throughout as new ways are mapped. Store size rises far faster. Because the two are plotted as a ratio — bytes per element — the divergence is visible as a rising line rather than as two lines that both go up. A flat ratio means physical size is tracking logical size and the growth is real data; a ratio climbing past about 1.25 times its starting value means the store holds materially more than the current data needs, and a compaction will return it.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="300" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Twelve weekly imports of the same region</text>
  <line x1="88" y1="48" x2="88" y2="212" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <line x1="88" y1="212" x2="720" y2="212" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <g font-size="9.5" fill="var(--viz-ink-mute,#565f6d)" text-anchor="middle">
    <text x="88" y="232">W1</text><text x="246" y="232">W4</text><text x="404" y="232">W7</text><text x="562" y="232">W10</text><text x="720" y="232">W12</text>
  </g>
  <text x="404" y="252" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">weekly OSM re-import</text>
  <path d="M88 200 L141 198 L194 196 L246 194 L299 192 L352 190 L404 188 L457 186 L510 185 L562 183 L615 182 L720 180" fill="none" stroke="var(--accent-3,#5b21b6)" stroke-width="2.6"/>
  <path d="M88 200 L141 190 L194 178 L246 166 L299 152 L352 140 L404 126 L457 114 L510 100 L562 88 L615 76 L720 60" fill="none" stroke="var(--viz-poor,#a8320f)" stroke-width="2.6"/>
  <path d="M88 202 L141 199 L194 194 L246 188 L299 180 L352 172 L404 162 L457 152 L510 140 L562 128 L615 116 L720 96" fill="none" stroke="var(--viz-ok,#7d6200)" stroke-width="2.6" stroke-dasharray="8 5"/>
  <text x="600" y="176" font-size="10" font-weight="700" fill="var(--accent-3,#5b21b6)">elements — +4%</text>
  <text x="596" y="54" font-size="10" font-weight="700" fill="var(--viz-poor,#a8320f)">store bytes — +47%</text>
  <text x="560" y="110" font-size="10" font-weight="700" fill="var(--viz-ok,#7d6200)">bytes / element — 1.41×</text>
  <line x1="404" y1="48" x2="404" y2="212" stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1.2" stroke-dasharray="4 4"/>
  <text x="412" y="60" font-size="9.5" font-weight="700" fill="var(--viz-ink-mute,#565f6d)">crosses 1.25× here</text>
  <text x="24" y="280" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">Nobody added 47 per cent more road. The tags moved, and every tag whose length changed left its previous record behind.</text>
</svg>

## Common Failure Patterns

**1. Watching disk usage instead of the ratio.** A disk alert fires when the volume is nearly full, which is months after the store started growing and long after the page cache stopped covering the working set. The ratio moves first and moves for a reason you can act on.

**2. Attributing the slowdown to the query.** A graph whose store has grown 40 per cent against an unchanged cache has lost 40 per cent of its coverage. Latency rises, plans are unchanged, and the natural instinct is to go looking at Cypher. The tell is in the [plan itself](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-query-planner-optimization/reading-explain-and-profile-plans-for-spatial-queries/) — same operators, same row counts, more wall time — which points at memory rather than planning.

**3. Rewriting properties that did not change.** The most common source of avoidable churn is an import that sets every tag on every element unconditionally, because that is simpler than diffing. Every unchanged long string is rewritten, every rewrite allocates, and the whole extract's worth of dynamic records is orphaned each week. Comparing a content hash before writing turns a full rewrite into a few per cent of one, which is the same discipline that makes an [incremental re-import](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/) affordable in the first place.

```cypher
// Only write when the payload actually differs — the hash is cheap and the
// rewrite is not.
UNWIND $batch AS row
MATCH (w:Way {id: row.id})
WHERE w.tag_hash IS NULL OR w.tag_hash <> row.tag_hash
SET w += row.tags, w.tag_hash = row.tag_hash
RETURN count(w) AS rewritten;
```

## Performance Notes

Compaction — a store copy that rewrites the files without the orphaned records — is the operation that returns the space, and it is worth planning rather than triggering in an incident. It needs room for a second copy of the store while it runs, it is I/O-bound rather than CPU-bound, and it leaves a cold cache behind, so the instance wants warming before it takes traffic again. On a replicated deployment the sequence that avoids user-visible impact is to compact a follower, promote it, and repeat.

The threshold worth acting on is not a universal number, but the reasoning is: compaction is justified when the store's excess exceeds the page cache's spare capacity, because that is the point at which churn has started costing latency rather than merely disk.

$$\text{excess} = S_{\text{now}} - \frac{B_{\text{now}}}{B_{\text{baseline}}} \cdot S_{\text{baseline}}$$

Comparing that excess against the cache's headroom turns "the store is bigger" into a decision. Below the headroom it is disk, which is cheap; above it, every additional byte is displacing a page the working set needed, and the ratio in the sampler above is the early warning that it is coming.

<svg viewBox="0 0 780 292" role="img" aria-labelledby="compactTitle compactDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="compactTitle">When churn stops being a disk cost and starts being a latency cost</title>
  <desc id="compactDesc">A store growing against a fixed page cache. While the store is smaller than the cache, orphaned records cost only disk and the working set stays fully resident. Once the store crosses the cache size the excess begins displacing pages the service actually reads, so every further byte of churn is paid in cache misses. The crossing point, not the absolute store size, is what makes a compaction worth scheduling — and it arrives without anyone changing a query.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="292" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">The crossing point is the decision, not the store size</text>
  <line x1="88" y1="48" x2="88" y2="200" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <line x1="88" y1="200" x2="720" y2="200" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <text x="404" y="240" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">imports over time</text>
  <line x1="88" y1="120" x2="720" y2="120" stroke="var(--accent,#0a656d)" stroke-width="2" stroke-dasharray="7 5"/>
  <text x="96" y="112" font-size="10" font-weight="700" fill="var(--accent,#0a656d)">page cache size — fixed</text>
  <path d="M88 188 L200 172 L312 152 L404 120 L512 92 L620 70 L720 56" fill="none" stroke="var(--viz-poor,#a8320f)" stroke-width="2.8"/>
  <text x="150" y="164" font-size="10" font-weight="700" fill="var(--viz-poor,#a8320f)">store</text>
  <rect x="88" y="120" width="316" height="80" fill="var(--viz-good,#0a656d)" opacity="0.1"/>
  <text x="246" y="176" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--viz-good,#0a656d)">churn costs disk only</text>
  <text x="246" y="192" text-anchor="middle" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">working set still fully resident</text>
  <rect x="404" y="48" width="316" height="72" fill="var(--viz-poor,#a8320f)" opacity="0.1"/>
  <text x="562" y="72" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--viz-poor,#a8320f)">churn costs latency</text>
  <text x="562" y="88" text-anchor="middle" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">dead records displace live pages</text>
  <circle cx="404" cy="120" r="6" fill="var(--viz-ok,#7d6200)"/>
  <text x="412" y="140" font-size="10" font-weight="700" fill="var(--viz-ok,#7d6200)">schedule the compaction before here, not after</text>
  <text x="24" y="270" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">A compaction needs room for a second copy of the store and leaves a cold cache, so it wants a maintenance window —</text>
  <text x="24" y="286" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">which is an argument for watching the ratio, because the ratio gives you weeks of notice and the disk alert gives you none.</text>
</svg>

One more source of drift is worth naming because it looks like churn and is not. An index that has been dropped and recreated — during a schema migration, or because a constraint changed — leaves the old index files in place until the store copy that removes them, and those files can be a substantial fraction of a spatial graph. The ratio picks this up as a step change rather than a slope: bytes-per-element jumps between two consecutive imports and then resumes its previous gradient. A slope is churn accumulating; a step is something that happened once. Recording what each import did alongside the sample is what makes the two distinguishable months later, when the graph has grown and nobody remembers the migration.

Finally, treat the history file as an artefact worth keeping rather than a debugging convenience. The value of this measurement is entirely in its trend, and a trend needs a baseline taken before anything went wrong. A service that starts recording once someone notices the disk filling has no way to tell how long the drift has been running or whether the current gradient is unusual, which is the difference between scheduling a compaction and guessing at one. Six months of weekly samples is a few kilobytes and answers both questions immediately.

## Related

- [Graph Memory and Storage Tuning](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-memory-and-storage-tuning/) — why store size is a latency concern and not just a disk one.
- [Sizing the Page Cache for a Spatial Graph](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-memory-and-storage-tuning/sizing-the-page-cache-for-a-spatial-graph/) — the budget this growth erodes.
- [Attribute Synchronization Techniques](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/attribute-synchronization-techniques/) — the continuous update path that produces most of the churn.
- [Building Automated OSM-to-Graph ETL Pipelines](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/osm-data-ingestion-pipelines/building-automated-osm-to-graph-etl-pipelines/) — where the unconditional rewrite usually lives.

This guide is part of [Graph Memory and Storage Tuning](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-memory-and-storage-tuning/), within [Spatial Graph Database Fundamentals for Python](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/).
