---
pageTitle: Retry & Idempotency
title: Retry and Idempotency for Graph Writes
description: Classify errors before retrying them, make every write safe to repeat, and stop a retry storm from turning a transient blip into an outage.
slug: retry-and-idempotency-for-graph-writes
type: article
breadcrumb: Retry & Idempotency
datePublished: 2026-08-11
dateModified: 2026-08-11
---
# Retry and Idempotency for Graph Writes

Retrying a failed write is only safe if two things are true, and most ingestion code checks neither. The write has to be idempotent, or a retry after a commit the client never saw about doubles the data; and the error has to be transient, or the retry is a guaranteed second failure that consumes a connection and delays the batches behind it. Get the first wrong and a deadlock retry silently duplicates relationships. Get the second wrong and a syntax error becomes five identical syntax errors with exponential backoff between them. This page separates the two decisions, and adds the third that stops a recovering database from being knocked over by its own clients.

## Prerequisites & Versions

Standard driver exceptions; the idempotency is a property of the Cypher.

| Requirement | Minimum version | Install |
| --- | --- | --- |
| Python | 3.11 | — |
| neo4j (async driver) | 5.20 | `pip install "neo4j>=5.20"` |
| Neo4j Server | 5.15 | uniqueness constraints |

## Implementation

```python
import asyncio
import random
from dataclasses import dataclass

from neo4j import AsyncGraphDatabase
from neo4j.exceptions import (
    ClientError,
    DatabaseError,
    Neo4jError,
    ServiceUnavailable,
    SessionExpired,
    TransientError,
)

# Idempotent by construction: MERGE on a key that identifies the element, and
# SET only properties derived from the payload. Re-running this with the same
# batch converges to the same graph, so a retry after an unseen commit is a
# no-op rather than a duplicate.
UPSERT = """
UNWIND $batch AS row
MERGE (src:Junction {id: row.src_id})
  ON CREATE SET src.location = point({latitude: row.src_lat, longitude: row.src_lon})
MERGE (tgt:Junction {id: row.tgt_id})
  ON CREATE SET tgt.location = point({latitude: row.tgt_lat, longitude: row.tgt_lon})
MERGE (src)-[s:SEGMENT {id: row.edge_id}]->(tgt)
SET s.length_m = row.length_m, s.drive_s = row.drive_s
RETURN count(s) AS written
"""


@dataclass(frozen=True)
class RetryPolicy:
    max_attempts: int = 5
    base_delay_s: float = 0.2
    max_delay_s: float = 8.0

    def delay_for(self, attempt: int) -> float:
        """Exponential backoff with full jitter.

        The jitter is not decoration. Without it, every client that failed
        during the same blip retries at the same instant, and the database
        recovers into a synchronised thundering herd that knocks it over again.
        """
        ceiling = min(self.max_delay_s, self.base_delay_s * 2 ** attempt)
        return random.uniform(0, ceiling)


def is_retryable(exc: BaseException) -> bool:
    """Transient means 'the same request might succeed later'.

    Deadlocks, leader elections and acquisition timeouts qualify. A syntax
    error, a constraint violation or a type mismatch will fail identically
    every time, and retrying them wastes a connection slot that a batch which
    could succeed is waiting for.
    """
    if isinstance(exc, (TransientError, ServiceUnavailable, SessionExpired)):
        return True
    if isinstance(exc, ClientError):
        return False              # our bug — schema, syntax, constraint
    if isinstance(exc, DatabaseError):
        return False              # server-side fault a retry will not fix
    return False


class ResilientWriter:
    def __init__(self, uri: str, auth: tuple[str, str],
                 policy: RetryPolicy | None = None, concurrency: int = 16) -> None:
        self._driver = AsyncGraphDatabase.driver(
            uri, auth=auth, max_connection_pool_size=concurrency * 2
        )
        self._policy = policy or RetryPolicy()
        self._semaphore = asyncio.Semaphore(concurrency)

    async def close(self) -> None:
        await self._driver.close()

    async def write(self, batch: list[dict]) -> int:
        last: BaseException | None = None
        for attempt in range(self._policy.max_attempts):
            try:
                async with self._semaphore:
                    async with self._driver.session() as session:
                        result = await session.run(UPSERT, batch=batch)
                        record = await result.single()
                        return int(record["written"])
            except Neo4jError as exc:
                last = exc
                if not is_retryable(exc):
                    # Fail fast and loudly. A ClientError retried five times is
                    # five identical failures and eight seconds of delay.
                    raise
                if attempt == self._policy.max_attempts - 1:
                    break
                await asyncio.sleep(self._policy.delay_for(attempt))
        raise RuntimeError(
            f"batch of {len(batch)} failed after {self._policy.max_attempts} "
            f"attempts: {last}"
        ) from last
```

## How It Works

**Idempotency comes from `MERGE` on a stable key, not from the retry logic.** The retry can only be safe if repeating the write is safe, and that is a property of the Cypher. `MERGE` on `edge_id` converges; `CREATE` does not, and no amount of care in the client makes it. The `ON CREATE SET` for the coordinate is deliberate too: it writes the location when the node is first seen and leaves it alone afterwards, so a retry cannot overwrite a corrected coordinate with the original one.

**Classification decides whether to retry at all.** `TransientError` covers the cases where the same request genuinely might succeed later — a deadlock between two batches touching the same high-degree junction, a leader election, a momentarily exhausted pool. `ClientError` covers the cases where it will not: a typo in the Cypher, a constraint violation, a parameter of the wrong type. Retrying the second category is worse than useless, because it occupies a connection and delays batches that would have succeeded.

**Full jitter is what prevents the second outage.** A blip that fails a hundred concurrent batches gives a hundred clients the same backoff schedule, and without jitter they all return at the same instant to a database that has just started recovering. Randomising each delay across the whole window spreads the return, and it is the difference between a recovery and a sawtooth of repeated collapses.

<svg viewBox="0 0 780 316" role="img" aria-labelledby="retryHerdTitle retryHerdDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="retryHerdTitle">Jitter turns a synchronised retry wave into a smooth recovery</title>
  <desc id="retryHerdDesc">Concurrent write attempts over time after a two-second database blip that failed 120 batches. Without jitter every client waits the same backoff interval, so all 120 return simultaneously; the spike exceeds what the recovering server can absorb, they fail again, and the pattern repeats with a longer period each time. With full jitter each client waits a random interval within its backoff window, so the returns are spread across the window, the server absorbs them, and the queue drains monotonically. The total work is identical in both cases — only its distribution in time differs.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="316" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">120 batches fail during a 2-second blip</text>
  <line x1="88" y1="48" x2="88" y2="176" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <line x1="88" y1="176" x2="736" y2="176" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <text x="44" y="120" font-size="10" font-weight="700" fill="currentColor" transform="rotate(-90 44 120)">attempts/s</text>
  <line x1="88" y1="86" x2="736" y2="86" stroke="var(--viz-ok,#7d6200)" stroke-width="1.5" stroke-dasharray="6 4"/>
  <text x="732" y="80" text-anchor="end" font-size="9.5" font-weight="700" fill="var(--viz-ok,#7d6200)">what the recovering server can absorb</text>
  <rect x="120" y="48" width="44" height="128" fill="var(--viz-ink-mute,#565f6d)" opacity="0.18"/>
  <text x="142" y="196" text-anchor="middle" font-size="9" font-weight="700" fill="var(--viz-ink-mute,#565f6d)">blip</text>
  <path d="M88 174 L120 174 L164 174 L232 174 L234 56 L244 56 L246 174 L360 174 L362 62 L372 62 L374 174 L560 174 L562 70 L572 70 L574 174 L736 174" fill="none" stroke="var(--viz-poor,#a8320f)" stroke-width="2.4"/>
  <text x="252" y="52" font-size="9.5" font-weight="700" fill="var(--viz-poor,#a8320f)">all 120 return at once, fail, repeat</text>
  <path d="M88 174 L120 174 L164 174 L216 150 L268 132 L330 138 L400 148 L480 158 L570 166 L660 172 L736 174" fill="none" stroke="var(--viz-good,#0a656d)" stroke-width="2.6"/>
  <text x="400" y="130" font-size="9.5" font-weight="700" fill="var(--viz-good,#0a656d)">spread across the window, absorbed, drains</text>
  <text x="412" y="212" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">time</text>
  <rect x="24" y="230" width="732" height="66" rx="9" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-stroke-soft,#cdc6b3)" stroke-width="1.2"/>
  <text x="44" y="252" font-size="11" font-weight="700" fill="currentColor">the same total work, distributed differently</text>
  <text x="44" y="272" font-size="10" fill="var(--viz-ink-mute,#565f6d)">Both runs perform 120 successful writes. Without jitter they take four times as long and each wave re-triggers the</text>
  <text x="44" y="288" font-size="10" fill="var(--viz-ink-mute,#565f6d)">condition that caused the failure — the retry policy has become the load problem.</text>
</svg>

## Common Failure Patterns

**1. Catching `Exception` and retrying.** The broadest possible net, and it turns a schema bug into a slow schema bug. A Cypher syntax error retried with backoff takes eight seconds to report something that was knowable immediately, and in a batch loop it does that for every batch. Catch the driver's own exception hierarchy and let everything else propagate.

```python
# WRONG: a typo in the Cypher is now a five-attempt, eight-second failure.
except Exception:
    await asyncio.sleep(backoff)

# RIGHT: only the errors where a later attempt could genuinely differ.
except (TransientError, ServiceUnavailable, SessionExpired):
    await asyncio.sleep(policy.delay_for(attempt))
```

**2. Assuming a failed write did not commit.** A connection dropped between commit and acknowledgement leaves the client believing the write failed and the database holding it. That is precisely the scenario idempotency exists for, and it is why `CREATE` in an ingestion path is a defect rather than a style choice — the duplicate it produces is invisible until something counts relationships.

**3. Retrying the batch rather than the transaction.** If a batch is split across multiple statements without a transaction boundary, a retry re-runs the whole batch including the parts that already committed. With idempotent statements that is harmless; with any non-idempotent step it compounds. Keep the retryable unit and the transactional unit the same thing.

## Performance Notes

The cost of getting classification wrong is easy to quantify. A batch that fails permanently and is retried $n$ times with exponential backoff occupies a connection for

$$T_{\text{wasted}} \approx \sum_{i=0}^{n-1} \frac{b \cdot 2^{i}}{2}$$

which for five attempts at a 200 ms base is roughly three seconds of a pool slot, per doomed batch. On an ingestion run where a schema problem affects every batch, that is the entire run spent waiting to fail.

The concurrency interaction is worth stating explicitly: retries consume the same semaphore permits as first attempts, so a burst of transient failures reduces effective throughput exactly when the system is already struggling. That is the correct behaviour — it is backpressure — but it means the retry budget and the concurrency limit have to be chosen together. A large retry budget with a tight semaphore converts a brief blip into a long stall, because the retrying batches hold the permits that new work needs.

Deadlocks deserve a specific note because they are the most common transient error in graph ingestion and they are partly self-inflicted. Two batches that both `MERGE` the same high-degree junction contend for the same lock, and the probability rises with concurrency and with batch size. Partitioning batches so that co-located writes land in the same batch — the same discipline the [POI enrichment path](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/poi-enrichment-workflows/enriching-poi-data-with-real-time-demographics/) uses for its H3 buckets — removes most of them at source, which is better than retrying them well.

<svg viewBox="0 0 780 288" role="img" aria-labelledby="retryClassTitle retryClassDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="retryClassTitle">What each error class costs when it is retried anyway</title>
  <desc id="retryClassDesc">Three error classes against the outcome of retrying them. A TransientError such as a deadlock or a leader election succeeds on a later attempt, so retrying recovers the batch and the backoff is time well spent. A ClientError such as a syntax error or constraint violation fails identically every time, so five attempts produce five failures and about three seconds of a connection-pool slot per batch. A DatabaseError is a server-side fault that a retry will not resolve either, and retrying it delays the report of a problem that needs a human.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="288" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Retrying each error class, and what it buys</text>
  <rect x="24" y="44" width="732" height="66" rx="9" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="1.8"/>
  <text x="44" y="68" font-size="11.5" font-weight="700" fill="var(--viz-good,#0a656d)">TransientError · ServiceUnavailable · SessionExpired</text>
  <text x="44" y="88" font-size="10" fill="var(--viz-ink-mute,#565f6d)">deadlock, leader election, momentary pool exhaustion — the state that caused it has moved on</text>
  <rect x="560" y="58" width="170" height="24" rx="12" fill="var(--viz-good,#0a656d)"/>
  <text x="645" y="75" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--viz-on-pill,#ffffff)">retry — recovers</text>
  <text x="44" y="104" font-size="10" fill="var(--viz-good,#0a656d)" font-weight="600">backoff is time well spent</text>
  <rect x="24" y="122" width="732" height="66" rx="9" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-poor,#a8320f)" stroke-width="1.8"/>
  <text x="44" y="146" font-size="11.5" font-weight="700" fill="var(--viz-poor,#a8320f)">ClientError</text>
  <text x="44" y="166" font-size="10" fill="var(--viz-ink-mute,#565f6d)">syntax, constraint violation, wrong parameter type — identical outcome every attempt</text>
  <rect x="560" y="136" width="170" height="24" rx="12" fill="var(--viz-poor,#a8320f)"/>
  <text x="645" y="153" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--viz-on-pill,#ffffff)">fail fast</text>
  <text x="44" y="182" font-size="10" fill="var(--viz-poor,#a8320f)" font-weight="600">retried: 5 failures and ~3 s of a pool slot, per batch</text>
  <rect x="24" y="200" width="732" height="66" rx="9" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-ok,#7d6200)" stroke-width="1.8"/>
  <text x="44" y="224" font-size="11.5" font-weight="700" fill="var(--viz-ok,#7d6200)">DatabaseError</text>
  <text x="44" y="244" font-size="10" fill="var(--viz-ink-mute,#565f6d)">server-side fault — a retry does not address it, and delays the report</text>
  <rect x="560" y="214" width="170" height="24" rx="12" fill="var(--viz-ok,#7d6200)"/>
  <text x="645" y="231" text-anchor="middle" font-size="10.5" font-weight="700" fill="var(--viz-on-pill,#ffffff)">surface it</text>
  <text x="44" y="260" font-size="10" fill="var(--viz-ok,#7d6200)" font-weight="600">this one needs a human, sooner rather than later</text>
</svg>

Two things are worth instrumenting rather than inferring. The first is the retry rate as a proportion of attempts, which is a leading indicator of contention long before it becomes a latency problem — a run that quietly climbs from one per cent to fifteen is telling you the concurrency and the batch partitioning have drifted out of balance, usually because the data got denser rather than because anything was changed. The second is the classification breakdown: counting retryable against non-retryable failures separately means a schema regression shows up as a spike in the second series rather than as a vague slowdown in the first.

It is also worth being explicit about what happens after the retry budget is exhausted. Raising is correct, but the batch is then lost unless something catches it, and an ingestion run that loses batches silently is worse than one that stops. The pattern that holds up is a dead-letter list: on final failure, record the batch and its last error, continue with the rest of the run, and report the count at the end. That turns "the import failed" into "the import wrote 4.2 million rows and could not write these 340, for this reason", which is the difference between a run you can act on and one you have to repeat.

## Related

- [Async Batch Processing for Graphs](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/async-batch-processing-for-graphs/) — the write path this policy wraps.
- [Scaling Async Graph Ingestion with Python asyncio](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/async-batch-processing-for-graphs/scaling-async-graph-ingestion-with-python-asyncio/) — the semaphore and pool sizing retries compete for.
- [Backpressure with Bounded asyncio Queues](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/async-batch-processing-for-graphs/backpressure-with-bounded-asyncio-queues/) — why a stalled retry loop must not let the producer run ahead.
- [Enriching POI Data with Real-Time Demographics](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/poi-enrichment-workflows/enriching-poi-data-with-real-time-demographics/) — partitioning writes so the deadlocks never happen.

This guide is part of [Async Batch Processing for Graphs](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/async-batch-processing-for-graphs/), within [Spatial Graph Construction & OSM Ingestion](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/).
