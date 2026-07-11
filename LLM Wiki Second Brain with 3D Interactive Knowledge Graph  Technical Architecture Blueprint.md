# LLM Wiki Second Brain with 3D Interactive Knowledge Graph: Technical Architecture Blueprint
## Executive Technical Summary
This report defines a production-grade architecture for an LLM-powered "Wiki Second Brain" that combines a professional 3D interactive knowledge graph UI with a GraphRAG-based memory engine and MCP-compliant agent interfaces. The design emphasizes deterministic graph traversal plus semantic vector retrieval, non-gimmicky visualization, and safe multi-agent read/write orchestration to support both human users and autonomous coding agents.[^1][^2][^3]

At a high level, the system consists of four layers:

- **Storage & Knowledge Graph**: Markdown note store, hybrid graph + vector indices, and a unified logical schema that abstracts over Neo4j or SQLite/FTS5 + lightweight graph tables.[^4][^5]
- **3D Visualization Engine**: A WebGL-based graph renderer using Three.js + React Three Fiber or three-forcegraph / 3d-force-graph, with instanced rendering, LOD, and Web Worker-based force layout to sustain thousands of nodes.[^6][^7][^8]
- **Hybrid Retrieval Engine (GraphRAG + VectorRAG)**: An indexing/query pipeline inspired by Microsoft GraphRAG, extracting entities/relations/claims, building community hierarchies, producing summaries, and combining vector search with query-aware spreading activation over the graph.[^9][^2][^1]
- **Agentic Layer & MCP Interface**: A set of LLM agents (Extractor, Refiner, Librarian) exposed via MCP-style tools (read_graph, upsert_entity, search_vectors, fetch_context) backed by a memory server similar to existing MCP memory implementations.[^10][^11]

The remainder of this report details schema design, rendering performance strategies, UX interaction patterns, retrieval algorithms, agent prompts, file/code organization, and risk mitigation for scaling to tens of thousands of nodes.
## Core Graph System Architecture
### Storage Stack Choices
Hybrid RAG workloads benefit from both efficient embedding search and explicit relational traversal; recent comparative evaluations show vector databases excel at high-throughput semantic search, while graph databases outperform on multi-hop reasoning at the cost of higher latency. For a developer-focused second brain, the recommended baseline stack is:[^12][^5]

- **Primary note store**: Markdown files in a local or syncable filesystem (user control, easy editing, Git-friendly).
- **Graph storage options**:
  - **Neo4j** when complex multi-hop queries, Cypher support, and rich tooling are priorities; it is widely used for RAG knowledge graphs and offers high performance on connected data.[^4][^5][^13]
  - **SQLite + FTS5 + graph tables** when simplicity, zero external services, and tight desktop integration are key; modern work shows SQLite can act as a lightweight graph store via recursive CTEs, combined with FTS and embeddings for semantic search.[^14]
- **Vector store**: A local or hosted engine such as Qdrant, FAISS, or LanceDB, integrated via a hybrid RAG framework; multiple open-source GraphRAG and hybrid RAG projects pair Neo4j graphs with FAISS or Qdrant vectors for scientific and enterprise workloads.[^15][^16][^2]

The architecture should treat the knowledge model as an abstraction layer, following Microsoft GraphRAG’s pattern: pipelines write Parquet/relational tables and embeddings to a configurable vector store, while graph topology can be backed by any supported DB.[^1][^17]
### Logical Knowledge Model & Schema
GraphRAG’s knowledge model distinguishes entities, relationships, text units, claims, communities, and community reports; this separation enables hierarchical reasoning and multi-level summarization.[^1][^2]
For a developer wiki second brain, a simplified but compatible schema can be:

```json
{
  "Entity": {
    "id": "uuid",
    "type": "Note | Concept | Person | Project | API | CodeModule",
    "title": "string",
    "slug": "string",
    "primary_markdown_path": "string | null",
    "canonical_url": "string | null",
    "summary": "string",
    "created_at": "datetime",
    "updated_at": "datetime"
  },
  "Relationship": {
    "id": "uuid",
    "source_entity_id": "uuid",
    "target_entity_id": "uuid",
    "type": "References | DependsOn | Implements | SimilarTo | Tag",
    "weight": "float",
    "metadata": "json"
  },
  "TextUnit": {
    "id": "uuid",
    "entity_id": "uuid",
    "source_path": "string",
    "chunk_index": "int",
    "content": "string",
    "embedding_vector_id": "string"
  },
  "Claim": {
    "id": "uuid",
    "text_unit_id": "uuid",
    "entity_ids": "uuid[]",
    "claim_text": "string",
    "supporting_citations": "json"
  },
  "Community": {
    "id": "uuid",
    "name": "string",
    "level": "int",
    "parent_community_id": "uuid | null",
    "entity_ids": "uuid[]",
    "summary": "string",
    "embedding_vector_id": "string"
  }
}
```

This logical model can be translated to Neo4j labels and relationships (e.g., `(:Entity)-[:REL {type}]→(:Entity)`) or to SQLite tables plus adjacency lists. It aligns closely with GraphRAG’s default indexing outputs (entities, relationships, community reports, embeddings), easing reuse of existing tooling.[^4][^17][^18][^14][^1]
### Markdown-to-Graph Sync Pipeline
Following GraphRAG’s indexing pipeline, the ingestion process should:

- Load Markdown files as documents (`LoadDocuments`).[^2][^19]
- Chunk documents into text units by headings and semantic boundaries (`ChunkDocuments`).
- Extract entities and relationships using an Extractor agent or GraphRAG-style workflows (`ExtractGraph`).[^20][^2]
- Extract key claims and statements (`ExtractClaims`).
- Embed text units and entities for vector search (`EmbedChunks`, `EmbedEntities`).[^1][^17]
- Perform community detection using Leiden or similar clustering (`DetectCommunities`).[^2]
- Generate multi-level summaries/reports per community (`GenerateReports`).

The system should maintain idempotent incremental indexing: a file change triggers re-chunking only that file’s text units, re-embedding, and localized graph updates; GraphRAG’s factory-based architecture and cached LLM calls demonstrate robust patterns for repeated, fault-tolerant indexing.[^1][^2]
## 3D Visualization Engine Specification
### Rendering Technology Selection
Web-based 3D visualization requires balancing control, performance, and development ergonomics. React Three Fiber wraps Three.js into React, simplifying scene management and integration with UI components, at the cost of some bundle overhead. For a highly interactive knowledge graph with rich UI, the recommended stack is:[^6]

- **Frontend framework**: Next.js or Vite + React for SPA/SSR flexibility.
- **3D engine**: React Three Fiber (`@react-three/fiber`) with Drei helpers for controls, HTML overlays, and performance monitoring.[^15][^6]
- **Graph layout**:
  - Use `3d-force-graph` / `three-forcegraph` or custom d3-force-3d integration with WebGL rendering for force-directed layouts.[^7][^21][^22]
  - Offload layout computation to Web Workers using d3-force, following existing patterns for worker-based layouts.[^8][^23][^24]

Alternative stacks include vanilla Three.js plus three-forcegraph, or WebGPU-based engines for future-proofing, but current production libraries, docs, and community support are strongest around Three.js + R3F and vasturiano’s force graph components.[^25][^7]
### Performance Bottlenecks & Optimizations
Empirical reports show that naive use of InstancedMesh and high-poly models can result in worse performance: instancing removes CPU-side draw calls but disables automatic frustum culling unless custom bounding volumes are maintained. On low-end GPUs, sending thousands of instances through the vertex shader each frame can reduce FPS without additional optimizations.[^26][^27][^28]

Key patterns for scaling to thousands of nodes:

- **Instanced rendering for nodes**: Use `InstancedMesh` for simple glyphs (spheres/cubes) and set an upper capacity, adjusting `count` per frame to only render visible instances, as recommended in Three.js discussions.[^29][^28]
- **Geometry simplification**: Use low-poly meshes or points/particles for nodes; performance feedback from large 3D force graphs shows edges and labels, not nodes, often dominate the cost.[^30]
- **Frustum culling and LOD**:
  - Maintain custom bounding boxes per cluster or region and dynamically adjust instanced mesh `count` to render only entities within view.[^27][^28]
  - Use multiple instanced meshes for different LOD levels and move instances between them depending on camera distance.[^27]
- **Worker-based layout**: Compute force layout in a Web Worker (or separate thread) and periodically sync positions to the main thread; this pattern has been used successfully in large WebGL graph components to support ~100k nodes and links.[^8][^23][^24]
- **Avoid heavy raycasting**: Raycasting against thousands of high-poly instances in mousemove events can become a bottleneck; using simplified proxy geometries for picking, or throttling raycasts, improves performance significantly.[^31]

React Three Fiber guides emphasize avoiding state updates in render loops, minimizing mount/unmount churn, and monitoring calls/polygons via tools like `r3f-perf` to keep frame times stable. Obsidian’s graph view demonstrates a WebGL canvas-based renderer controlled via CSS-mapped color classes, with hover highlighting and fading interactions; this provides a useful baseline for a professional, non-game aesthetic.[^32][^33][^15][^34]
### UX Design Principles for Professional Look
Obsidian and similar tools illustrate that a 2D/3D graph can feel premium when visual hierarchy and motion are subtle: nodes scale with degree, hover highlights connections, and the palette is themeable via CSS converted to WebGL commands. For a non-gimmicky 3D knowledge graph UI:[^32][^33]

- **Camera & controls**:
  - Use orbit controls with constrained pitch and distance, avoiding aggressive fly-through behaviors that feel game-like.[^6]
  - Implement focus-on-node transitions using smooth easing (e.g., cubic ease-in-out) and moderate duration to avoid disorienting jumps.
- **Visual styling**:
  - Choose a restrained dark theme: dark charcoal background, dim grid floor, and desaturated node colors by community; reserve accent neon hues for active selections and hover highlights.[^25][^32]
  - Render edges as subtle lines with thickness only at close zoom; fade distant edges to reduce clutter.
  - Use orthographic projection for overview modes and perspective for focused modes, switching with a soft transition.
- **Information density & clutter control**:
  - Cluster nodes by community and visually group them with translucent hulls or bounding boxes around clusters.[^2][^35]
  - Provide filters by entity type, tag, project, and time; hide or dim low-importance nodes by default.
  - Integrate a side panel that shows note content, claims, and related entities while the 3D view focuses primarily on topology.
- **Interaction patterns**:
  - Hover: highlight node, its immediate neighbors, and edges; reduce opacity of unrelated elements.
  - Click: lock focus, show detail panel, and animate camera to frame the local neighborhood.
  - Multi-select: allow lasso or search-based selection to focus on subgraphs.

Existing WebGL graph visualization blogs and libraries show that combining Three.js rendering with d3-force physics via Web Workers yields smooth interactions even on large datasets, provided that node representation and edge drawing are carefully optimized.[^8][^24][^25]
## Hybrid Retrieval Mechanics (RAG + GraphRAG)
### GraphRAG Indexing & Query Modes
Microsoft’s GraphRAG system extracts a knowledge graph from text, performs hierarchical community detection (e.g., Leiden), generates community-level summaries, embeds entities and chunks, and supports global, local, DRIFT, and basic query modes.[^1][^2][^17]

For a second brain, the indexing pipeline should:

- Produce embeddings for text units (chunk-level) and community summaries, stored in a vector DB.[^17][^1]
- Maintain entity and relationship tables, plus community hierarchies, in the graph store.[^13][^1]
- Cache LLM calls for extraction and summarization to ensure idempotent indexing.[^1]

At query time, use hybrid strategies:

- **Global search**: Retrieve top community summaries relevant to the query via vector search over community embeddings and include them as high-level context.[^2]
- **Local search**: Identify salient entities (via semantic mapping or explicit mention resolution), then expand neighbors using graph traversal and fetch local text units and claims.[^9][^2]
- **DRIFT-like search**: Anchor on specific entities but modulate traversal and selection by community-level information, similar to DRIFT search modes.[^2]
- **Baseline semantic search**: Use standard top-k vector retrieval over text units for simple factual queries.[^12][^2]
### Query-Aware Graph Traversal
Recent work on spreading-activation and query-aware graph traversal shows that incorporating semantic gating within graph expansion improves multi-hop QA over knowledge graphs; an approach expresses seed selection, propagation, and top-k selection entirely in Cypher for Neo4j, avoiding in-memory Python graph loading.[^9]

Adapting this:

- Map query to seed entities (string matching, entity embeddings, or prior usage).
- At each iteration, compute activation scores for neighbor entities based on edge weights and cosine similarity between entity descriptions and query embedding.[^9]
- Limit iterations and propagate within a controllable radius, collecting top-K activated entities and their associated text units.

For SQLite-based graphs, similar logic can be implemented via recursive CTEs and join conditions; for Neo4j, the full traversal can be encoded as a single Cypher query.[^14][^9]
### Chunking & Embedding Strategy
Hybrid RAG pipelines that mix graph and vector retrieval typically:

- Chunk long Markdown documents into sections based on headings and semantic boundaries to preserve context.[^19][^20]
- Use an embedding model (e.g., OpenAI `text-embedding-3-large` or similar) and store vectors in Qdrant or FAISS.[^16][^10]
- Index claims separately to allow claim-centric retrieval when precise statements are needed.[^4][^1]

To minimize context drift:

- Maintain explicit links from text units back to entities and communities, so the Librarian agent can assemble coherent context windows rather than random snippet sets.[^1][^2]
- Use instruction-tuned LLMs for summarization and retrieval orchestration, as hybrid RAG frameworks have shown improved relevance and reduced hallucinations when an agent chooses between GraphRAG and VectorRAG dynamically.[^16]
## AI Agent System Architecture & MCP Utilities
### Agent Roles & Responsibilities
Agentic hybrid RAG frameworks encapsulate retrieval pipelines within autonomous agents that can dynamically pick GraphRAG or VectorRAG and adjust instructions. For this system, define three primary agents:[^15][^16]

- **Extractor Agent**: Ingests new or modified Markdown, identifies entities and relationships, creates/upserts graph nodes and edges, and updates text units and claims.
- **Refiner Agent**: Deduplicates entities, merges overlapping notes, resolves conflicts, and maintains canonical summaries.[^1][^17]
- **Librarian Agent**: Responds to user or downstream agent queries by orchestrating hybrid retrieval, selecting context slices, and assembling final context windows.

These agents should operate via tool-based APIs exposed through MCP-compliant servers. Existing MCP memory servers demonstrate patterns for add/update/delete/search operations over vector-backed memories, and one implementation describes a knowledge graph-based memory system with semantic search and cross-session memory.[^10][^36]
### MCP Server & Tools Design
The Model Context Protocol defines standard mechanisms to expose tools and resources to LLMs; MCP memory servers typically implement tools like `add_memory`, `search_memories`, `update_memory`, `delete_memory`, and structural operations.[^10][^11]

For the second brain, an MCP server should provide tools such as:

- `add_entity`, `update_entity`, `delete_entity` – CRUD for graph entities.
- `add_relationship`, `update_relationship`, `delete_relationship` – CRUD for edges.
- `add_text_unit`, `search_text_units` – chunk insertion and semantic search.
- `search_graph` – graph queries: local neighborhoods, communities, multi-hop paths.
- `get_context_bundle` – high-level retrieval that returns a structured context set for a query.

These tools would be backed by the storage and retrieval layers described earlier; LLM agents interact via the MCP protocol, allowing both local coding assistants and remote agents to leverage the same second brain as a memory substrate.[^3][^11]
### Agent Orchestration Patterns
Hybrid RAG experiments with agentic frameworks show benefits from dynamic selection between graph and vector retrieval based on query type and uncertainty estimates. An orchestration strategy:[^16]

- Librarian agent examines query and metadata.
- It decides between pure vector, pure graph, or hybrid retrieval (graph seeds + vector claims around seeds).
- It calls `search_graph` with a query embedding and seed set; the server returns activated entities and associated text units.
- It optionally calls `search_text_units` for pure semantic retrieval.
- It merges results, prunes redundant chunks, and produces a ranked context bundle.

Refiner agent periodically runs maintenance workflows, such as merging nearly duplicate entities (based on name similarity and shared neighbors), re-clustering communities, and updating community summaries.[^1][^2]
## Concrete Core Prompts & Agent Skills (Conceptual Overview)
### Extractor Agent Prompting
- System: "You are an information extraction agent for a personal knowledge graph. Given Markdown content, you identify entities (concepts, projects, APIs, code modules), relationships between entities, and key claims. You output structured JSON according to the schema, without prose." (Detailed prompt text omitted by design.)

- Behavior:
  - Use heading structure to determine entity boundaries and primary entities per file.
  - Extract references (links, mentions) as relationships with inferred types.
  - Summarize each entity succinctly and identify claims that reference entities.

This aligns with GraphRAG’s extraction pipeline and supports direct mapping to the defined schema.[^1][^20]
### Refiner Agent Prompting
- System: "You are a graph refiner and deduplication agent. You operate on existing entity and relationship sets and propose merges, canonical summaries, and edge normalization. You minimize redundancy while preserving detail and avoid deleting entities without clear equivalence." (Detailed prompt text omitted.)

- Behavior:
  - Identify entities with highly similar titles, overlapping neighbors, or identical primary markdown paths.
  - Propose merges and updated summaries.
  - Normalize relationship types and weights.

This function keeps the graph coherent over time and avoids exponential growth of near-duplicate nodes.[^13][^1]
### Librarian Agent Prompting
- System: "You are a retrieval orchestration agent for a graph + vector second brain. For each query, you decide if graph, vector, or hybrid retrieval is best, call appropriate tools, and construct a context window with entities, text units, claims, and community summaries in a structured format for downstream reasoning." (Detailed prompt text omitted.)

- Behavior:
  - Identify explicit entity mentions and topics in queries.
  - Choose retrieval mode based on whether multi-hop reasoning or local factual recall is required.[^16][^2]
  - Assemble context bundles with hierarchical ordering: community → entities → text units → claims.

This agent provides a consistent interface for human users and coding agents, ensuring that context windows are both compact and semantically coherent.[^1][^16]
## Code Architecture Assignment for Coding Agents
### High-Level Directory Structure
Based on typical GraphRAG and WebGL graph visualization projects, a recommended repository layout is:

```text
second-brain/
  apps/
    web-ui/                # Next.js/R3F frontend
    mcp-server/            # MCP memory/graph server
  packages/
    graph-core/            # Schema, graph ops, Neo4j/SQLite adapters
    rag-engine/            # Hybrid retrieval, GraphRAG-inspired pipelines
    agents/                # LLM agent wrappers, prompts, tool bindings
  data/
    markdown/              # Source notes
    embeddings/            # Vector DB config or local files
    graph/                 # Neo4j dumps / SQLite DB
  config/
    settings.yaml          # GraphRAG-style pipeline configuration
    mcp.json               # MCP server registration
  docs/
    architecture.md        # Human-readable design
```

GraphRAG uses a config file (`settings.yaml`) for indexing pipelines and stores outputs in an `output` directory with Parquet tables; following this pattern simplifies reuse of its default dataflow.[^17][^19][^37]
### Core Modules & Responsibilities
- `graph-core`:
  - Defines logical schemas and DB adapters (Neo4j/Cypher, SQLite/CTEs).
  - Implements CRUD operations for entities, relationships, communities, claims.
  - Provides graph query APIs for neighborhoods, communities, and spreading activation.

- `rag-engine`:
  - Wraps embedding models and vector store operations.
  - Implements indexing pipelines: markdown loading, chunking, extraction, embedding, community detection, report generation.[^1][^2]
  - Implements query-time hybrid retrieval.

- `agents`:
  - Contains agent definitions and prompt templates.
  - Binds tools for MCP server: mapping between MCP calls and internal APIs.[^10][^11]

- `apps/web-ui`:
  - Implements 3D graph viewer using R3F and three-forcegraph.
  - Provides panels for note content, search, filters, and retrieval results.
  - Includes performance monitor tools and layout worker setup.[^15][^8][^24]

- `apps/mcp-server`:
  - Implements MCP-compliant server exposing tools backed by `graph-core` and `rag-engine`.
  - Reuses patterns from existing MCP memory server projects.[^11][^10]
## Risk, Scale, & Mitigation Matrix
### Visualization Performance & Scaling
**Risks**:

- FPS degradation with thousands of nodes due to instancing limits, heavy raycasting, and edge/label drawing costs.[^26][^31][^30]
- Layout instability or long convergence times for large graphs.

**Mitigations**:

- Use instanced rendering only for simple glyphs and maintain custom frustum culling via bounding boxes and `count` adjustments.[^27][^29][^28]
- Use Web Workers for layout, freezing positions after initial convergence and re-running layout only on major structural changes.[^8][^23][^24]
- Limit visible subgraph size by default; show only local neighborhoods plus a few higher-level community anchors.
### UI Clutter & Hairball Effect
**Risks**:

- Dense graphs become visually unusable; users see an undifferentiated hairball.

**Mitigations**:

- Cluster by communities and visually group them with hulls or bounding volumes.[^2][^35]
- Provide filtering by entity type, tags, projects, and time.
- Use progressive disclosure: start with community view, then expand into local neighborhoods.
### Context Drift & Retrieval Quality
**Risks**:

- Vector search returns semantically similar but contextually irrelevant chunks.
- Graph traversal selects nodes that are structurally close but semantically off-topic.

**Mitigations**:

- Use query-aware spreading activation with semantic gating to make traversal sensitive to query semantics.[^9]
- Maintain tight links between text units, entities, communities, and claims so context bundles are coherent.[^1][^2]
- Incorporate uncertainty estimates or confidence scores from hybrid agentic RAG frameworks to adjust the amount and composition of retrieved context.[^16]
### Multi-Agent Write/Read Integrity
**Risks**:

- Concurrent agents corrupt graph structure via cycles, runaway entity creation, or inconsistent relationship types.

**Mitigations**:

- Implement transactional APIs with validation: enforce acyclic constraints where needed, limit relationship fan-out per entity, and throttle bulk operations.
- Use Refiner agent maintenance passes to normalize and merge entities.[^1]
- Log all agent operations with audit trails; maintain snapshots for rollbacks.
### Storage & Deployment Complexity
**Risks**:

- Neo4j and vector DBs add operational overhead compared to a localized wiki.

**Mitigations**:

- Start with SQLite + FTS5 + simple graph tables and a small vector DB (or file-based embeddings), then upgrade to Neo4j and Qdrant or FAISS as scale requires.[^12][^14]
- Use containerization and infrastructure-as-code for graph/vector services.
## Strategic Tech Stack Recommendations
Based on the literature and existing open-source GraphRAG systems:
### Frontend & Visualization
- **Next.js + React** for SPA/SSR, route-based code splitting, and integration with APIs.
- **React Three Fiber + Drei** for 3D rendering convenience and integration with standard React controls.[^15][^6]
- **three-forcegraph / 3d-force-graph** for 3D force-directed layout with WebGL, leveraging d3-force-3d or ngraph under the hood.[^7][^21][^22]
### Storage & Retrieval
- Initial phase: **SQLite + FTS5** for note indexing and simple graph tables, plus a local vector store such as Qdrant for embeddings.[^10][^14]
- Advanced phase: **Neo4j** for full knowledge graph, plus FAISS/LanceDB/Qdrant for vector search, following GraphRAG and hybrid RAG architectures.[^4][^16][^2]
- Use a GraphRAG-inspired indexing pipeline, reusing existing configurations and dataflows when possible.[^1][^17][^37]
### Agent & MCP Infrastructure
- Implement an MCP server modeled on existing memory servers, providing tools for entity and relationship management, semantic search, and context bundling.[^10][^11]
- Wrap LLM agents (Extractor, Refiner, Librarian) using a framework such as LangChain, LangGraph, or a custom orchestration layer that can interact with MCP tools and the RAG engine.[^15][^16]
## Implementation Roadmap (2–4 Week Sprint View)
### Phase 1 – Data & Storage (Week 1)
- Implement Markdown ingestion and chunking with headings and semantic segmentation.
- Design and create SQLite schemas for entities, relationships, text units, claims, and communities.[^14]
- Integrate an embedding model and a local vector store (e.g., Qdrant) for text units and community embeddings.[^10]
- Build basic GraphRAG-inspired indexing scripts to extract entities/relationships and generate simple community clusters.[^1][^17]
### Phase 2 – Visual Layer (Weeks 1–2)
- Setup Next.js + React Three Fiber project with a canvas-based 3D viewport.[^6]
- Integrate three-forcegraph or similar library for initial visualization of graph data.[^7][^21]
- Implement Web Worker-based d3-force layout to compute positions off the main thread.[^8][^23][^24]
- Add instanced rendering for nodes, frustum culling via `count`, and basic LOD behavior.[^27][^29][^28]
- Create minimalist dark theme, side panels for note content, and hover/click interactions modeled on Obsidian’s graph view.[^32][^33]
### Phase 3 – Agent Layer (Weeks 2–3)
- Implement MCP server with tools for entity, relationship, text unit, and context operations, drawing from existing memory server patterns.[^10][^11]
- Define Extractor, Refiner, and Librarian agents with prompts and tool bindings using an orchestration library.
- Wire Librarian agent to hybrid retrieval engine, implementing global, local, and query-aware traversal modes.[^16][^9][^2]
### Phase 4 – Refinement & Polishing (Weeks 3–4)
- Optimize visualization performance: tune instancing, reduce raycasting overhead, and monitor performance metrics.[^15][^34][^31]
- Improve clustering and clutter control via community hulls, filters, and progressive disclosure.[^2][^35]
- Harden transactional integrity and multi-agent concurrency controls.[^13][^1]
- Add theming options and fine-grained user configuration for camera behavior, colors, and layout parameters.

This roadmap, combined with the architecture and component design described above, gives senior engineers and coding agents a clear blueprint for constructing an LLM Wiki Second Brain with a professional 3D interactive knowledge graph and GraphRAG-based memory engine.

---

## References

1. [Architecture - GraphRAG - Open Source at Microsoft](https://microsoft.github.io/graphrag/index/architecture/)

2. [Query](https://microsoft.github.io/graphrag/)

3. [The Model Context Protocol (MCP) for AI Tool Integration](https://cirra.ai/articles/model-context-protocol-ai-tool-integration) - Learn about the Model Context Protocol (MCP), an open standard for AI-driven data and tool integrati...

4. [Coronary Heart Disease Medical Technology Innovation Knowledge Graph-Enhanced Large Model Intelligent Retrieval QA System](https://francis-press.com/papers/20711) - : This paper designs and implements a large model intelligent retrieval question answering system en...

5. [Performance Comparison Analysis of ArangoDB, MySQL, and Neo4j: An
  Experimental Study of Querying Connected Data](https://arxiv.org/pdf/2401.17482.pdf) - ...aspects such as CPU and memory usage. In
contrast, energy usage and temperature of the servers ar...

6. [React three fiber - 3D for the web](https://techhub.iodigital.com/articles/react-three-fiber-3d-for-the-web) - The simplest way to create interactive 3d experiences

7. [GitHub - vasturiano/three-forcegraph: Force-directed graph as a ThreeJS 3d object](https://github.com/vasturiano/three-forcegraph) - Force-directed graph as a ThreeJS 3d object. Contribute to vasturiano/three-forcegraph development b...

8. [D3 force layout and WebGL integration - GeekPlux](https://geekplux.com/posts/d3-force-and-webgl-integration) - Data Visualization & Full-stack programmer @ finance firm, always exploring

9. [Query-Aware Spreading Activation for Multi-Hop Retrieval over Knowledge Graphs](https://www.semanticscholar.org/paper/648083e9372be16316f25d22d7c3a8ac6c996798) - Retrieval-augmented generation built on knowledge graphs (Graph RAG) outperforms flat passage retrie...

10. [GitHub - yynps737/mcp-memory-server: MCP Memory Server - A Model Context Protocol compliant memory management server for Claude Code](https://github.com/yynps737/mcp-memory-server) - MCP Memory Server - A Model Context Protocol compliant memory management server for Claude Code - yy...

11. [servers/src/memory at main · modelcontextprotocol/servers](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) - Model Context Protocol Servers. Contribute to modelcontextprotocol/servers development by creating a...

12. [A Comparative Performance Analysis: Vector Search vs Graph Databases for RAG Applications](https://ieeexplore.ieee.org/document/11541494/) - Retrieval-Augmented Generation (RAG) systems are increasingly critical in enterprise AI deployments,...

13. [Demystifying Graph Databases: Analysis and Taxonomy of Data
  Organization, System Designs, and Graph Queries](https://arxiv.org/pdf/1910.09017.pdf) - ...analysis, and many others. Numerous graphs such as
web or social networks may contain up to trill...

14. [SQLite as a Graph Database: Recursive CTEs, Semantic Search ...](https://dev.to/rohansx/sqlite-as-a-graph-database-recursive-ctes-semantic-search-and-why-we-ditched-neo4j-1ai) - SQLite as a Graph Database: Recursive CTEs, Semantic Search, and Why We Ditched Neo4j · The Problem:...

15. [Performance pitfalls - React Three Fiber](https://r3f.docs.pmnd.rs/advanced/pitfalls) - Performance pitfalls · Tips and Tricks · Avoid setState in loops · Handle animations in loops · Do n...

16. [Open-Source Agentic Hybrid RAG Framework for Scientific Literature Review](https://arxiv.org/abs/2508.05660) - The surge in scientific publications challenges traditional review methods, demanding tools that int...

17. [graphrag/docs/index/overview.md at main · microsoft/graphrag](https://github.com/microsoft/graphrag/blob/main/docs/index/overview.md) - A modular graph-based Retrieval-Augmented Generation (RAG) system - microsoft/graphrag

18. [Text-to-SQL with GraphRAG on Knowledge Graph Semantic ...](https://github.com/kennethleungty/Text-to-SQL-with-KG-Neo4j-GraphRAG) - Neo4j: A graph database that enables efficient storage and querying of knowledge graphs, providing t...

19. [Getting Started - GraphRAG - Microsoft Open Source](https://microsoft.github.io/graphrag/get_started/)

20. [7 Microsoft's GraphRAG implementation - O'Reilly Media](https://www.oreilly.com/library/view/essential-graphrag/9781633436268/Text/chapter-7.html) - 7 Microsoft’s GraphRAG implementation This chapter covers Introducing Microsoft's GraphRAG Extractin...

21. [3d-force-graph/README.md at master · vasturiano/3d-force-graph](https://github.com/vasturiano/3d-force-graph/blob/master/README.md?accessToken=eyJhbGciOiJIUzI1NiIsImtpZCI6ImRlZmF1bHQiLCJ0eXAiOiJKV1QifQ.eyJleHAiOjE3NDM2NDc1NTUsImZpbGVHVUlEIjoiS3JrRWxRTkRscGZMRW9xSiIsImlhdCI6MTc0MzY0NzI1NSwiaXNzIjoidXBsb2FkZXJfYWNjZXNzX3Jlc291cmNlIiwicGFhIjoiYWxsOmFsbDoiLCJ1c2VySWQiOjUwMDc5MDZ9.1ZhO7EalealllpKAPODrOTVgBCmcxFaN81lrP2WeX7U) - 3D force-directed graph component using ThreeJS/WebGL - vasturiano/3d-force-graph

22. [GitHub - vasturiano/d3-force-3d: Force-directed graph layout in 1D, 2D or 3D using velocity Verlet integration.](https://github.com/vasturiano/d3-force-3d?tab=readme-ov-file) - Force-directed graph layout in 1D, 2D or 3D using velocity Verlet integration. - vasturiano/d3-force...

23. [d3-force WebWorker layout](https://gist.github.com/zakjan/b370057873fec41a5d4449d12c3e46e6) - d3-force WebWorker layout. GitHub Gist: instantly share code, notes, and snippets.

24. [GitHub - jin5354/d3-force-graph: Force-directed graph using D3-force and WebGL, support massive data rendering and custom style.](https://github.com/jin5354/d3-force-graph) - Force-directed graph using D3-force and WebGL, support massive data rendering and custom style. - ji...

25. [Visualizing Graphs in 3D with WebGL](https://medium.com/neo4j/visualizing-graphs-in-3d-with-webgl-9adaaff6fe43) - While looking for efficient graph visualization libraries for large scale rendering, I came across 3...

26. [InstancedMesh significantly slower than Mesh with shared attributes](https://github.com/mrdoob/three.js/issues/30352) - InstancedMesh is significantly slower than Mesh, I have observed this with 5000 sphere meshes with 5...

27. [Three.js InstancedMesh performance optimizations - DevLog 10](https://www.youtube.com/watch?v=fMgIW2Kyad4) - Three.js InstancedMesh performance optimizations - DevLog 10. @vrmeup42 likes1.3K views2 years ago m...

28. [When is InstancedMesh worth it in THREE? - Questions](https://discourse.threejs.org/t/when-is-instancedmesh-worth-it-in-three/62044) - Generally, for 20-30 objects most likely you will not notice any performance boost by using Instance...

29. [Is it possible to optimize instances - add/remove instance dynamically?](https://discourse.threejs.org/t/is-it-possible-to-optimize-instances-add-remove-instance-dynamically/44594) - Yeah, you can initially create the instanced mesh with the count = max. number of instances you will...

30. [Using David Piegza's 3D Force-Directed Graph for LARGE Data; visualization is too slow](https://stackoverflow.com/questions/15371176/using-david-piegzas-3d-force-directed-graph-for-large-data-visualization-is-to) - I am using David Piegza's open source code for visualizing a 3D Force-Directed graph using Three.js....

31. [Seeking Advice on Three.js Instance Placement Performance](https://discourse.threejs.org/t/seeking-advice-on-three-js-instance-placement-performance/67434) - Hello, everyone. I am once again requiring your aid. I’m currently working on a project where my goa...

32. [Graph View - Obsidian Template for Gatsby Theme Primer Wiki](https://demo-obsidian.owenyoung.com/Plugins/Graph%20view/) - To customize graph view, we have provided a way to convert CSS colors into WebGL commands. The follo...

33. [Graph view - Obsidian cứu giúp](https://publish.obsidian.md/help-vi/Plugin/Graph+view) - Hiển thị trình bày biểu đồ của Liên kết nội bộ giữa các ghi chú của bạn. Ghi chú với nhiều ghi chú t...

34. [Scaling performance - Introduction - React Three Fiber](https://r3f.docs.pmnd.rs/advanced/scaling-performance) - This is a short primer on how to scale performance.

35. [Digital Twin Smart City: Integrating IFC and CityGML with Semantic Graph for Advanced 3D City Model Visualization](https://www.mdpi.com/1424-8220/24/12/3761) - The growing interest in building data management, especially the building information model (BIM), h...

36. [GitHub - StevenWangler/mcp-memory-server: mcp-memory-server](https://github.com/StevenWangler/mcp-memory-server) - mcp-memory-server. Contribute to StevenWangler/mcp-memory-server development by creating an account ...

37. [Dataflow - GraphRAG - Microsoft Open Source](https://microsoft.github.io/graphrag/index/default_dataflow/)

