<p align="center">
  <a href="https://www.spatialgraphdatabases.org">
    <img src="https://www.spatialgraphdatabases.org/assets/img/og-image.png" alt="Spatial Graph Databases — a graph network drawn over a coordinate grid with a colored routing path and pin marker" width="100%">
  </a>
</p>

<h1 align="center">Python for Spatial Graph Databases &amp; Network Routing</h1>

<p align="center">
  <strong>Production engineering patterns for building, querying, routing, and scaling spatial graph networks with Python and Neo4j.</strong>
</p>

<p align="center">
  <a href="https://www.spatialgraphdatabases.org"><b>🌐 Read it at spatialgraphdatabases.org →</b></a>
</p>

---

## What this is

[**spatialgraphdatabases.org**](https://www.spatialgraphdatabases.org) is a focused, deeply technical reference for engineers who put spatial data on a graph and route across it. Every guide is grounded in working, runnable Python and Cypher — the official async `neo4j` driver, native `point` geometry, spatial indexes, and the Graph Data Science library — with the goal of treating spatial predicates and shortest‑path search as first‑class database operators rather than post‑processing filters.

It is written for backend and data engineers, logistics and mobility developers, and spatial analytics teams building routing systems that have to stay sub‑second as the graph grows to tens of millions of nodes.

## What's inside

The site is organised into four in‑depth tracks, each with hands‑on guides and complete code:

- **[Spatial Graph Database Fundamentals for Python](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/)** — storage and topology, schema design, async driver integration, spatial indexing, query planning, and multi‑tenant security boundaries.
- **[Cypher Spatial Queries &amp; Pathfinding Patterns](https://www.spatialgraphdatabases.org/cypher-spatial-queries-pathfinding-patterns/)** — index‑backed distance filters, k‑nearest‑neighbour search, spatial joins, isochrone and service‑area analysis, and query‑plan tuning.
- **[Spatial Graph Construction &amp; OSM Ingestion](https://www.spatialgraphdatabases.org/spatial-graph-construction-osm-ingestion/)** — building routing graphs from OpenStreetMap, POI enrichment, attribute synchronization, and async batch ingestion with backpressure.
- **[Network Routing Algorithms in Python](https://www.spatialgraphdatabases.org/network-routing-algorithms-python/)** — Dijkstra, A\* with a Haversine heuristic, contraction hierarchies, turn‑restriction and time‑dependent routing, and choosing between Neo4j GDS and hand‑written Cypher.

## Why read it

- **Runnable, not hand‑wavy.** Every page carries a complete, self‑contained async Python + Cypher example you can copy and run — no pseudo‑code.
- **Production‑first.** Guides lead with what breaks under real load — index push‑down, connection‑pool exhaustion, write amplification, topology corruption — and how to harden against it.
- **Grounded in real cost models.** Haversine distance, A\* admissibility bounds, bounding‑box math, and plan‑cache behaviour are explained with the formulas and `PROFILE` output that back them.
- **Hand‑drawn diagrams.** Each concept is illustrated with an original, theme‑aware SVG built specifically for the page.

## How the site is built

This repository contains the full source of the site, an [Eleventy](https://www.11ty.dev/) (11ty) static build deployed to Cloudflare:

```bash
npm install
npm run build     # generate the static site into _site/
npm run serve     # local dev server at http://localhost:8080
```

Content lives as Markdown under `src/`, with Nunjucks layouts in `src/_includes/` and site data in `src/_data/`.

## Explore

**→ [www.spatialgraphdatabases.org](https://www.spatialgraphdatabases.org)**

Start with the [Fundamentals](https://www.spatialgraphdatabases.org/spatial-graph-database-fundamentals-for-python/), then follow the inline links — every guide cross‑references the deeper and adjacent topics it builds on.
