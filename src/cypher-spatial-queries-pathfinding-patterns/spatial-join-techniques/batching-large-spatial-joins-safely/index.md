---
pageTitle: Batching Large Spatial Joins
title: Batching Large Spatial Joins Safely
description: Run a join over millions of rows in resumable committed chunks, so a failure costs one batch rather than the whole run and the transaction never outgrows its budget.
slug: batching-large-spatial-joins-safely
type: article
breadcrumb: Batching Joins
datePublished: 2026-08-11
dateModified: 2026-08-11
---
# Batching Large Spatial Joins Safely

An index-probe join that runs beautifully over ten thousand driving rows will terminate the transaction over ten million. The query is unchanged and the plan is unchanged; what changed is that the whole result now has to be held until commit, and the transaction memory limit — or the heap, if nobody set one — arrives first. Splitting the work into committed chunks fixes that, and introduces two problems of its own: the run is no longer atomic, so a failure halfway leaves the graph partly updated, and the chunks have to be chosen so that resuming does not redo or skip work. This page does all three: bounded transactions, a resumable cursor, and a chunking key that keeps each batch's probes spatially local.

## Prerequisites & Versions

Ordinary Cypher plus a checkpoint the job owns.

| Requirement | Minimum version | Install |
| --- | --- | --- |
| Python | 3.11 | — |
| neo4j (async driver) | 5.20 | `pip install "neo4j>=5.20"` |
| Neo4j Server | 5.15 | native `point`, `POINT INDEX` |

## Implementation

```python
import asyncio
from dataclasses import dataclass

from neo4j import AsyncGraphDatabase

# One batch = one transaction. The keyset predicate on the chunk key is what
# makes it resumable: a restart continues strictly past the last committed
# chunk rather than re-scanning from the beginning.
JOIN_CHUNK = """
MATCH (e:PickupEvent)
WHERE e.geocell > $after_cell
   OR (e.geocell = $after_cell AND e.id > $after_id)
WITH e ORDER BY e.geocell, e.id LIMIT $size
// The probe: one bounding-box seek per driving row, then the exact clip.
CALL (e) {
  WITH e
  MATCH (n:RoadNode)
  WHERE n.location.latitude  >= e.min_lat AND n.location.latitude  <= e.max_lat
    AND n.location.longitude >= e.min_lon AND n.location.longitude <= e.max_lon
  WITH e, n, point.distance(e.location, n.location) AS metres
  WHERE metres <= $radius_m
  RETURN n, metres ORDER BY metres LIMIT 1
}
MERGE (e)-[r:SNAPPED_TO]->(n)
SET r.metres = metres, r.run_id = $run_id
RETURN e.geocell AS last_cell, e.id AS last_id, count(r) AS written
ORDER BY last_cell DESC, last_id DESC
LIMIT 1
"""

CHECKPOINT = """
MERGE (c:JoinCheckpoint {job: $job})
SET c.after_cell = $cell, c.after_id = $id,
    c.written = coalesce(c.written, 0) + $written, c.updated_at = datetime()
"""

READ_CHECKPOINT = """
MATCH (c:JoinCheckpoint {job: $job})
RETURN c.after_cell AS cell, c.after_id AS id, c.written AS written
"""


@dataclass(frozen=True)
class Progress:
    batches: int
    written: int
    last_cell: int
    last_id: str


class BatchedJoin:
    def __init__(self, uri: str, auth: tuple[str, str], job: str) -> None:
        self._driver = AsyncGraphDatabase.driver(uri, auth=auth)
        self._job = job

    async def close(self) -> None:
        await self._driver.close()

    async def run(self, radius_m: float = 60.0, size: int = 2_000,
                  run_id: str = "run-1") -> Progress:
        async with self._driver.session() as session:
            record = await (await session.run(READ_CHECKPOINT, job=self._job)).single()
            cell = int(record["cell"]) if record else -1
            last_id = str(record["id"]) if record else ""
            written = int(record["written"] or 0) if record else 0
            batches = 0

            while True:
                result = await session.run(
                    JOIN_CHUNK, after_cell=cell, after_id=last_id,
                    size=size, radius_m=radius_m, run_id=run_id,
                )
                row = await result.single()
                if row is None or row["written"] == 0:
                    break        # nothing left past the cursor

                cell, last_id = int(row["last_cell"]), str(row["last_id"])
                written += int(row["written"])
                batches += 1
                # Checkpoint AFTER the batch commits. The other order records
                # progress that a crash would then have discarded, and the
                # resume skips work that was never done.
                await session.run(
                    CHECKPOINT, job=self._job, cell=cell, id=last_id,
                    written=int(row["written"]),
                )

        return Progress(batches=batches, written=written,
                        last_cell=cell, last_id=last_id)
```

## How It Works

**Chunking on a spatial key keeps each batch's probes local.** Ordering by `geocell` rather than by id means the driving rows in one batch are geographically adjacent, so their bounding-box seeks land on overlapping index pages and the same pages serve the whole batch. Chunking by id instead scatters each batch across the country, and every probe is a fresh page fault — the same work, several times the wall-clock, and a page cache thrashing against itself.

**The cursor is a keyset, not an offset.** `SKIP` would re-produce and discard every already-processed row on each batch, making the run quadratic; the compound predicate on `(geocell, id)` seeks directly past the last committed position. It also makes the run resumable across process restarts for free, since the cursor lives in the checkpoint rather than in memory.

**The checkpoint is written after the batch commits, and that ordering is the whole safety argument.** Recording progress first and committing second means a crash in between leaves a checkpoint claiming work that was rolled back, and the resume skips it permanently. Committing first means a crash leaves work done but unrecorded, so the resume redoes one batch — which is harmless, because the `MERGE` is idempotent.

<svg viewBox="0 0 780 316" role="img" aria-labelledby="joinChunkTitle joinChunkDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="joinChunkTitle">Chunking by id scatters the probes; chunking by cell keeps them together</title>
  <desc id="joinChunkDesc">Two batches of two thousand driving rows over the same dataset. Ordered by id, the rows in one batch are scattered across the whole country, so each bounding-box probe lands on a different part of the index and almost every one is a page fault. Ordered by grid cell, the rows in one batch are geographically adjacent, so their probes land on overlapping index pages and the pages loaded for the first probe serve most of the rest. The rows processed and the result written are identical; only the page-cache behaviour differs, and on a large run that is most of the wall-clock.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="316" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">One batch of 2,000 driving rows, two orderings</text>
  <rect x="24" y="42" width="356" height="212" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-poor,#a8320f)" stroke-width="1.6"/>
  <text x="202" y="66" text-anchor="middle" font-size="11.5" font-weight="700" fill="var(--viz-poor,#a8320f)">ORDER BY id</text>
  <rect x="56" y="82" width="292" height="132" rx="6" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1"/>
  <g fill="var(--viz-poor,#a8320f)">
    <circle cx="86" cy="102" r="4"/><circle cx="196" cy="96" r="4"/><circle cx="312" cy="118" r="4"/><circle cx="118" cy="164" r="4"/>
    <circle cx="256" cy="142" r="4"/><circle cx="330" cy="188" r="4"/><circle cx="72" cy="196" r="4"/><circle cx="220" cy="200" r="4"/>
    <circle cx="150" cy="120" r="4"/><circle cx="290" cy="164" r="4"/><circle cx="180" cy="176" r="4"/><circle cx="106" cy="136" r="4"/>
  </g>
  <text x="202" y="234" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">every probe a fresh index page</text>
  <rect x="400" y="42" width="356" height="212" rx="10" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="1.8"/>
  <text x="578" y="66" text-anchor="middle" font-size="11.5" font-weight="700" fill="var(--viz-good,#0a656d)">ORDER BY geocell, id</text>
  <rect x="432" y="82" width="292" height="132" rx="6" fill="var(--viz-panel-2,#ece9df)" stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1"/>
  <rect x="486" y="112" width="96" height="76" rx="4" fill="var(--viz-good,#0a656d)" opacity="0.16"/>
  <g fill="var(--viz-good,#0a656d)">
    <circle cx="502" cy="126" r="4"/><circle cx="524" cy="120" r="4"/><circle cx="548" cy="132" r="4"/><circle cx="566" cy="126" r="4"/>
    <circle cx="510" cy="148" r="4"/><circle cx="534" cy="154" r="4"/><circle cx="558" cy="146" r="4"/><circle cx="496" cy="168" r="4"/>
    <circle cx="520" cy="174" r="4"/><circle cx="544" cy="170" r="4"/><circle cx="568" cy="162" r="4"/><circle cx="506" cy="138" r="4"/>
  </g>
  <text x="578" y="234" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">one page set serves the whole batch</text>
  <text x="24" y="284" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">Identical rows, identical output, identical plan. The right-hand ordering costs a sort the left-hand one does not — and</text>
  <text x="24" y="300" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">pays for it many times over in page faults it never takes.</text>
</svg>

## Common Failure Patterns

**1. Checkpointing before the commit.** The ordering looks arbitrary and is not: a crash between a recorded checkpoint and a rolled-back transaction leaves a permanent hole in the output, and nothing detects it because the run reports completion. Commit, then record — and accept that a crash costs one redone batch.

**2. Batching without a stable order.** A `LIMIT` with no `ORDER BY` returns an arbitrary subset, so consecutive batches can overlap and miss rows in the same run. The order must be total — the `geocell, id` pair, exactly as a [keyset cursor](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/k-nearest-neighbor-routing/paginating-nearest-neighbour-results/) needs a tiebreak — or the run is not reproducible.

**3. Treating a partial run as a failure.** Once the work is chunked it is no longer atomic, and that is a deliberate trade rather than a defect. What matters is that the intermediate state is *usable*: the `run_id` stamped on each relationship makes it possible to tell which rows this run produced, so a downstream consumer can filter to a completed run or an operator can clean up an abandoned one.

```cypher
// What a resumed or abandoned run left behind.
MATCH ()-[r:SNAPPED_TO]->()
RETURN r.run_id AS run, count(r) AS rows, min(r.metres) AS closest
ORDER BY rows DESC;
```

## Performance Notes

Batch size trades transaction memory against round-trip overhead, and both ends of the range are bad:

$$T_{\text{total}} \approx \frac{N}{B} \cdot t_{\text{rtt}} + N \cdot t_{\text{probe}}, \qquad M_{\text{tx}} \approx B \cdot m_{\text{row}}$$

Small batches make the first term dominate — a hundred-row batch over ten million rows is a hundred thousand round trips. Large batches push $M_{\text{tx}}$ toward the [transaction memory limit](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/graph-memory-and-storage-tuning/tuning-jvm-heap-for-gds-projections/), which is where this whole exercise started. A few thousand rows is the usual landing point, and the right way to choose it is to measure rows-per-second across a range and take the setting on the near side of the plateau.

The spatial ordering has a second benefit worth noting: it makes the run's progress predictable. Because batches sweep the grid in order, the job moves through geography rather than through an opaque id space, so "how far through is it" has a meaningful answer and a stalled batch can be attributed to a specific region — usually the densest one, where each probe returns the most candidates.

Where the join must not interfere with live traffic, the same chunking gives a natural throttle: a short sleep between batches caps the write rate without changing anything else, and because the run is resumable it can be stopped and restarted around peak hours with no bookkeeping beyond the checkpoint that already exists.

<svg viewBox="0 0 780 288" role="img" aria-labelledby="joinSizeTitle joinSizeDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="joinSizeTitle">Batch size against throughput and transaction memory</title>
  <desc id="joinSizeDesc">Two curves against batch size. Throughput rises steeply from very small batches as the per-round-trip overhead is amortised, flattens through a broad plateau between roughly one and eight thousand rows, and then falls as transactions become large enough to pressure memory. Transaction memory rises linearly with batch size throughout and crosses the configured limit at around twenty thousand rows. The usable setting is on the near side of the throughput plateau and well below the memory line — which on this workload is anywhere between two and six thousand.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="288" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Throughput and transaction memory against batch size</text>
  <line x1="96" y1="48" x2="96" y2="204" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <line x1="96" y1="204" x2="720" y2="204" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <g font-size="9.5" fill="var(--viz-ink-mute,#565f6d)" text-anchor="middle">
    <text x="96" y="224">100</text><text x="252" y="224">1k</text><text x="408" y="224">5k</text><text x="564" y="224">20k</text><text x="720" y="224">100k</text>
  </g>
  <text x="408" y="244" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">rows per batch</text>
  <path d="M96 186 L174 128 L252 92 L330 84 L408 82 L486 88 L564 108 L642 146 L720 184" fill="none" stroke="var(--accent,#0a656d)" stroke-width="2.8"/>
  <text x="300" y="72" font-size="10" font-weight="700" fill="var(--accent,#0a656d)">throughput</text>
  <path d="M96 202 L252 190 L408 168 L564 124 L720 56" fill="none" stroke="var(--viz-poor,#a8320f)" stroke-width="2.6" stroke-dasharray="7 5"/>
  <text x="640" y="80" text-anchor="end" font-size="10" font-weight="700" fill="var(--viz-poor,#a8320f)">transaction memory</text>
  <line x1="96" y1="124" x2="720" y2="124" stroke="var(--viz-poor,#a8320f)" stroke-width="1.4" stroke-dasharray="5 4"/>
  <text x="110" y="118" font-size="9.5" font-weight="700" fill="var(--viz-poor,#a8320f)">configured limit</text>
  <rect x="290" y="48" width="140" height="156" fill="var(--viz-good,#0a656d)" opacity="0.12"/>
  <text x="360" y="196" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-good,#0a656d)">usable range</text>
  <text x="24" y="272" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">The plateau is broad, so this is a setting to measure once and leave alone rather than one to tune continuously.</text>
</svg>

Two further considerations decide whether this is safe to run against a live system rather than only against a maintenance window.

The first is what the job does to the page cache it shares with everything else. A join sweeping the full grid pulls the entire driving label and a large part of the road index through the cache, and the pages it loads displace whatever the latency-sensitive workload had resident. The spatial ordering helps — each batch's pages are reused within the batch rather than scattered — but it does not change the total volume, and on a shared instance the routing endpoint's p95 will move while the job runs. Where that matters, the answer is to run against a replica, or to accept it and schedule accordingly; what does not work is hoping a job that reads the whole graph will be invisible.

The second is what happens when the job is interrupted permanently rather than temporarily. A run stopped halfway leaves the graph in a state where some driving rows are snapped and some are not, and a consumer reading it cannot distinguish "not snapped yet" from "no road within tolerance". Stamping the run id on the relationships is half the answer; the other half is stamping progress on the driving rows themselves — a `snap_run_id` set as each batch commits — so an unsnapped row that was processed is distinguishable from one that never was. Without that, resuming after an abandoned run requires re-processing everything to find out what was missed, which defeats the resumability the checkpoint was built for.

It is also worth deciding up front whether re-running the job over already-snapped rows should update them. Road geometry moves between imports, so a row snapped six months ago may now have a nearer segment; but re-snapping everything on every run turns an incremental job back into a full one. The usual compromise is to re-snap rows whose local road geometry changed — which the import already knows, since it wrote those changes — and to leave the rest alone.

## Related

- [Spatial Join Techniques for Production Graph Networks](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/spatial-join-techniques/) — the join shape this executes at scale.
- [Index-Probe Spatial Joins in Cypher](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/spatial-join-techniques/index-probe-spatial-joins-in-cypher/) — the per-row probe inside each batch.
- [Paginating Nearest-Neighbour Results Deterministically](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/k-nearest-neighbor-routing/paginating-nearest-neighbour-results/) — the keyset cursor this reuses as a resume point.
- [Retry and Idempotency for Graph Writes](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/async-batch-processing-for-graphs/retry-and-idempotency-for-graph-writes/) — why a redone batch after a crash is harmless.

This guide is part of [Spatial Join Techniques](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/spatial-join-techniques/), within [Cypher Spatial Queries & Pathfinding Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/).
