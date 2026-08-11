---
pageTitle: Transfer Penalties
title: Transfer Penalties in Multi-Modal Graphs
description: Separate the clock cost of a change from the dislike of changing, keep both in seconds, and tune journeys toward fewer legs without corrupting the reported time.
slug: transfer-penalties-in-multi-modal-graphs
type: article
breadcrumb: Transfer Penalties
datePublished: 2026-08-11
dateModified: 2026-08-11
---
# Transfer Penalties in Multi-Modal Graphs

A journey planner that minimises pure travel time will happily offer a route with four changes that saves ninety seconds over one with a single change, and nobody will take it. Travellers dislike changing far more than the clock says they should — the change carries risk, luggage, unfamiliar platforms and the chance of missing a connection — and a planner that cannot express that dislike produces technically optimal results that read as unusable. The fix is one extra number per transfer, but it has to be the right kind of number, kept separate from the time it takes to change and expressed in the same unit as everything else. This page builds that, and shows how to tune it without corrupting the journey time you report back.

## Prerequisites & Versions

The penalty is a relationship property consumed by an ordinary weighted search.

| Requirement | Minimum version | Install |
| --- | --- | --- |
| Python | 3.11 | — |
| neo4j (async driver) | 5.20 | `pip install "neo4j>=5.20"` |
| Neo4j Server | 5.15 | directed relationships |
| Graph Data Science | 2.6 | optional, for projected search |

## Implementation

Every transfer carries two numbers: how long it takes, and how much it is disliked. The search minimises their sum; the reported journey time uses only the first.

```python
import asyncio
from dataclasses import dataclass

from neo4j import AsyncGraphDatabase

# Two properties, deliberately. `seconds` is a physical duration; `penalty_s` is
# a preference expressed in the same unit so the search can add them. Folding
# them into one number makes the reported journey time a fiction.
SET_PENALTIES = """
UNWIND $rows AS row
MATCH (a)-[t:TRANSFER {id: row.id}]->(b)
SET t.seconds    = row.seconds,
    t.penalty_s  = row.penalty_s,
    t.search_s   = row.seconds + row.penalty_s
RETURN count(t) AS updated
"""

JOURNEY = """
MATCH (o {id: $origin}), (d {id: $destination})
CALL gds.shortestPath.dijkstra.stream($graph, {
  sourceNode: o, targetNode: d, relationshipWeightProperty: 'search_s'
})
YIELD nodeIds, costs, path
WITH [rel IN relationships(path) | rel] AS legs
RETURN
  // What the traveller experiences: the real durations only.
  reduce(s = 0.0, r IN legs | s + coalesce(r.seconds, 0.0))   AS journey_s,
  // What the search minimised: durations plus dislike.
  reduce(s = 0.0, r IN legs | s + coalesce(r.search_s, r.seconds)) AS search_s,
  size([r IN legs WHERE type(r) = 'TRANSFER'])                AS changes
"""


@dataclass(frozen=True)
class TransferPolicy:
    """Dislike of changing, in seconds, by the kind of change it is.

    These are preferences, not measurements. They are expressed in seconds only
    so the search can add them to durations — a 300-second penalty does not mean
    the change takes five minutes, it means a traveller would spend five extra
    minutes travelling to avoid it.
    """
    base_s: float = 300.0
    same_platform_s: float = 60.0        # step across, minimal risk
    cross_station_s: float = 480.0       # street crossing, unfamiliar entrance
    mode_change_s: float = 240.0         # extra on top of base when the mode changes
    accessibility_s: float = 900.0       # stairs-only interchange, if step-free is required

    def for_transfer(self, *, same_platform: bool, cross_station: bool,
                     mode_changes: bool, step_free: bool) -> float:
        if same_platform:
            penalty = self.same_platform_s
        elif cross_station:
            penalty = self.cross_station_s
        else:
            penalty = self.base_s
        if mode_changes:
            penalty += self.mode_change_s
        if not step_free:
            penalty += self.accessibility_s
        return penalty


async def apply(driver, transfers: list[dict], policy: TransferPolicy) -> int:
    rows = [
        {
            "id": t["id"],
            "seconds": t["seconds"],
            "penalty_s": policy.for_transfer(
                same_platform=t["same_platform"],
                cross_station=t["cross_station"],
                mode_changes=t["from_mode"] != t["to_mode"],
                step_free=t["step_free"],
            ),
        }
        for t in transfers
    ]
    async with driver.session() as session:
        result = await session.run(SET_PENALTIES, rows=rows)
        return int((await result.single())["updated"])
```

## How It Works

Three properties of this arrangement matter.

**Two numbers, one unit.** The penalty is in seconds because the search adds it to seconds, not because a change takes that long. Keeping them separate means the planner can report "48 minutes, one change" while having searched on 53 minutes of effective cost — and the 48 is a real prediction rather than an artefact of the weighting.

**The penalty varies by what kind of change it is.** A cross-platform interchange where the connecting train is already waiting is barely a change at all; one that requires leaving a station, crossing a road and finding another entrance is a different experience entirely, and a single flat penalty cannot distinguish them. Deriving the penalty from the transfer's own attributes — same platform, cross-station, mode change, step-free — is what makes the planner's preferences match a traveller's.

**Accessibility is a penalty, not a filter, until it is a filter.** A stairs-only interchange should be strongly discouraged for a traveller who needs step-free access and merely noted for one who does not. Modelling it as a large penalty handles the first case gracefully; where the requirement is absolute, the transfer should be excluded from the projection entirely, so no search can return it — the same structural argument that makes a [banned turn a missing edge](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/turn-restriction-and-time-dependent-routing/modeling-turn-restrictions-as-an-edge-based-graph/).

<svg viewBox="0 0 780 308" role="img" aria-labelledby="penaltyPickTitle penaltyPickDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="penaltyPickTitle">How the penalty changes which journey wins, without changing what is reported</title>
  <desc id="penaltyPickDesc">Three journeys between the same pair of points. The direct option takes 52 minutes with no change. A two-change option takes 48 minutes, and a four-change option takes 46. Searched on pure travel time the four-change option wins by six minutes, which no traveller would accept. Searched with a five-minute dislike per change the ranking reverses and the two-change option wins on effective cost while still being reported as 48 minutes of real travel. The reported figure is unchanged in every case; only the choice between them moves.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="308" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Three options, two ways of ranking them</text>
  <text x="330" y="52" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-ink-mute,#565f6d)">real travel time</text>
  <text x="530" y="52" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-ink-mute,#565f6d)">effective cost</text>
  <text x="690" y="52" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-ink-mute,#565f6d)">chosen</text>
  <rect x="24" y="60" width="732" height="58" rx="9" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <text x="44" y="82" font-size="11" font-weight="700" fill="currentColor">direct</text>
  <text x="44" y="100" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">no change</text>
  <text x="330" y="94" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">52 min</text>
  <text x="530" y="94" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">52 min</text>
  <text x="690" y="94" text-anchor="middle" font-size="10" fill="var(--viz-ink-mute,#565f6d)">—</text>
  <rect x="24" y="128" width="732" height="58" rx="9" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-good,#0a656d)" stroke-width="1.8"/>
  <text x="44" y="150" font-size="11" font-weight="700" fill="var(--viz-good,#0a656d)">two changes</text>
  <text x="44" y="168" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">one cross-platform, one street-level</text>
  <text x="330" y="162" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">48 min</text>
  <text x="530" y="162" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">57 min</text>
  <g font-size="10" font-weight="700" text-anchor="middle">
    <rect x="646" y="146" width="88" height="22" rx="11" fill="var(--viz-good,#0a656d)"/>
    <text x="690" y="162" fill="var(--viz-on-pill,#ffffff)">with penalty</text>
  </g>
  <rect x="24" y="196" width="732" height="58" rx="9" fill="var(--viz-panel,#f4f4f5)" stroke="var(--viz-poor,#a8320f)" stroke-width="1.6"/>
  <text x="44" y="218" font-size="11" font-weight="700" fill="var(--viz-poor,#a8320f)">four changes</text>
  <text x="44" y="236" font-size="9.5" fill="var(--viz-ink-mute,#565f6d)">two of them cross-station</text>
  <text x="330" y="230" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">46 min</text>
  <text x="530" y="230" text-anchor="middle" font-size="13" font-weight="700" fill="currentColor">72 min</text>
  <g font-size="10" font-weight="700" text-anchor="middle">
    <rect x="646" y="214" width="88" height="22" rx="11" fill="var(--viz-poor,#a8320f)"/>
    <text x="690" y="230" fill="var(--viz-on-pill,#ffffff)">time only</text>
  </g>
  <text x="24" y="284" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">The middle column never changes — it is what the traveller is told, and it is a real prediction. The right-hand column is</text>
  <text x="24" y="300" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">internal, and exists only so the search picks the journey a person would.</text>
</svg>

## Common Failure Patterns

**1. Folding the penalty into the transfer's duration.** Setting `seconds = 240 + 300` makes the search behave correctly and makes every reported journey time wrong by the total penalty. Worse, the error is invisible — the number looks plausible, and only comparing against a timetable reveals it. Keep the duration honest and add a separate search weight.

**2. A penalty large enough to dominate the search.** Push it to twenty minutes per change and the planner will route a traveller on a single service for two hours rather than change once, which is as unusable as the no-penalty version in the other direction. The useful range is roughly three to eight minutes for an ordinary change; anything above that is expressing a policy rather than a preference and should be documented as one.

**3. The same penalty for every traveller.** A commuter with a season ticket and no luggage tolerates changes far better than a family with suitcases. Because the penalty lives on the relationship and the search reads one property, supporting profiles means either a property per profile or a projection per profile — both are cheap, and a single average serves nobody well.

```python
# One weight property per profile, computed once.
for profile, policy in PROFILES.items():
    await apply(driver, transfers, policy)   # writes search_s_<profile>
```

## Performance Notes

The penalty costs nothing at search time — it is already summed into `search_s`, so the search reads one property exactly as it would without it. What it does change is the *shape* of the search, and usually favourably: penalising transfers makes routes through interchange-heavy areas more expensive, which prunes a part of the graph that would otherwise be explored, so a penalised search frequently settles fewer nodes than an unpenalised one.

$$w_{\text{search}}(e) = t(e) + \pi(e), \qquad \pi(e) = 0 \text{ for every non-transfer edge}$$

Because $\pi$ is non-negative, the weight stays non-negative and Dijkstra remains correct — a penalty implemented as a negative weight on preferred edges instead would break that, and is the tempting form when someone wants to *reward* a same-platform change rather than penalise the others. Express the preference as a smaller penalty rather than as a negative one.

One consequence to plan for: journeys optimised on `search_s` are not sorted by `journey_s`, so a result set returned in search order will occasionally show a slower journey above a faster one. That is correct behaviour and it looks like a bug to anyone reading the list. Returning both numbers, and labelling the ordering, is what makes the output defensible — the same discipline as reporting the [detour cost alongside the distance](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/corridor-and-buffer-queries/ranking-detour-cost-for-corridor-candidates/) rather than only the one that was optimised.

<svg viewBox="0 0 780 288" role="img" aria-labelledby="penaltyTuneTitle penaltyTuneDesc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;font-family:var(--font-sans,sans-serif)">
  <title id="penaltyTuneTitle">Mean changes per journey against the penalty, and where the useful range sits</title>
  <desc id="penaltyTuneDesc">Mean number of changes per suggested journey plotted against the per-change penalty, across a metropolitan network. At zero penalty the planner suggests an average of 2.6 changes, which is far more than travellers accept. The curve falls steeply to about 1.3 changes between two and eight minutes of penalty, then flattens — beyond about ten minutes almost nothing further is gained and mean journey time starts climbing sharply, because the planner is now avoiding changes that were worth making. The shaded band marks the range where the preference is expressed without the policy taking over.</desc>
  <rect class="viz-backdrop" x="0" y="0" width="780" height="288" fill="var(--viz-bg,#ffffff)"/>
  <text x="24" y="24" font-size="13.5" font-weight="700" fill="currentColor">Mean changes and mean journey time against the penalty</text>
  <line x1="96" y1="48" x2="96" y2="204" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <line x1="96" y1="204" x2="720" y2="204" stroke="var(--viz-stroke,#9ca3af)" stroke-width="1.4"/>
  <g font-size="9.5" fill="var(--viz-ink-mute,#565f6d)" text-anchor="middle">
    <text x="96" y="224">0</text><text x="252" y="224">4 min</text><text x="408" y="224">8 min</text><text x="564" y="224">14 min</text><text x="720" y="224">20 min</text>
  </g>
  <text x="408" y="244" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor">penalty per change</text>
  <rect x="174" y="48" width="273" height="156" fill="var(--viz-good,#0a656d)" opacity="0.1"/>
  <text x="310" y="66" text-anchor="middle" font-size="10" font-weight="700" fill="var(--viz-good,#0a656d)">useful range — 2 to 8 minutes</text>
  <path d="M96 76 L174 106 L252 134 L330 152 L408 162 L486 168 L564 172 L642 174 L720 175" fill="none" stroke="var(--accent-3,#5b21b6)" stroke-width="2.8"/>
  <text x="112" y="94" font-size="10" font-weight="700" fill="var(--accent-3,#5b21b6)">mean changes: 2.6</text>
  <text x="600" y="166" font-size="10" font-weight="700" fill="var(--accent-3,#5b21b6)">1.2</text>
  <path d="M96 190 L174 190 L252 189 L330 188 L408 186 L486 176 L564 152 L642 118 L720 74" fill="none" stroke="var(--accent-2,#a8380b)" stroke-width="2.4" stroke-dasharray="7 5"/>
  <text x="640" y="104" text-anchor="end" font-size="10" font-weight="700" fill="var(--accent-2,#a8380b)">mean journey time climbs</text>
  <text x="24" y="266" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">Past about ten minutes the planner buys almost no further reduction in changes and pays for it in journey time —</text><text x="24" y="282" font-size="10.5" fill="var(--viz-ink-mute,#565f6d)">it has stopped expressing a preference and started enforcing a policy.</text>
</svg>

It is worth being deliberate about how the penalty is calibrated, because the temptation is to pick a number that produces routes someone likes on a handful of examples. The defensible method is to compare against observed behaviour: take journeys where travellers had a genuine choice between a faster route with more changes and a slower one with fewer, and find the penalty at which the planner's preference matches the one they actually exercised. On a network with ticketing data that is a direct measurement; without it, a survey question phrased as "how much longer would you travel to avoid one change" gets close enough, and is a far better basis than intuition.

Calibration also has to be revisited when the network changes, because the penalty is partly a proxy for risk. An interchange with a reliable ten-minute frequency carries much less risk of a missed connection than the same interchange at a twenty-minute frequency, and a traveller's dislike of it moves accordingly. Where the schedule is in the graph already, deriving part of the penalty from the headway of the connecting service — rather than treating every change as equally risky — makes the planner noticeably better at off-peak times, which is exactly when a flat penalty is least accurate.

## Related

- [Multi-Modal and Fleet Routing on a Spatial Graph](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/multi-modal-and-fleet-routing/) — the layered graph these transfers connect.
- [Time-Dependent Shortest Paths with Schedule Edges](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/turn-restriction-and-time-dependent-routing/time-dependent-shortest-paths-with-schedule-edges/) — the waiting cost a transfer's duration sits on top of.
- [Modeling Turn Restrictions as an Edge-Based Graph](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/turn-restriction-and-time-dependent-routing/modeling-turn-restrictions-as-an-edge-based-graph/) — when a preference should become a missing edge instead.
- [Many-to-Many Cost Matrices with Neo4j GDS](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/multi-modal-and-fleet-routing/many-to-many-cost-matrices-with-gds/) — building matrices over a graph whose weights include preferences.

This guide is part of [Multi-Modal and Fleet Routing on a Spatial Graph](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/multi-modal-and-fleet-routing/), within [Network Routing Algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/).
