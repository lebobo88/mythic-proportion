"use strict";

// ---------------------------------------------------------------------------
// Fetch resilience -- Wiki (/api/pages) and Graph (/api/graph) must never
// blank the currently rendered view on a slow/failed request; callers keep
// showing the last-known-good content and surface a subtle hint instead.
// ---------------------------------------------------------------------------

const PAGES_FETCH_TIMEOUT_MS = 20000;

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = PAGES_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function setStatusHint(elementId, message) {
  const el = document.getElementById(elementId);
  if (!el) return;
  if (!message) {
    el.textContent = "";
    el.classList.add("hidden");
    return;
  }
  el.textContent = message;
  el.classList.remove("hidden");
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

(function initTheme() {
  const saved = localStorage.getItem("mp-theme");
  const theme = saved || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.setAttribute("data-theme", theme);
})();

document.getElementById("theme-toggle").addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme") || "light";
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("mp-theme", next);
});

// ---------------------------------------------------------------------------
// Tabs / views
// ---------------------------------------------------------------------------

const VIEWS = ["wiki", "search", "ask", "graph", "ingest", "lint", "settings"];

function showView(name) {
  for (const v of VIEWS) {
    document.getElementById(`view-${v}`).classList.toggle("active", v === name);
  }
  document.querySelectorAll("#tabs button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === name);
  });
  if (name === "lint") loadLint();
  if (name === "graph") loadGraph();
  if (name === "settings") loadSettingsView();
}

document.getElementById("tabs").addEventListener("click", (event) => {
  const btn = event.target.closest("button[data-view]");
  if (btn) showView(btn.dataset.view);
});

// ---------------------------------------------------------------------------
// Hash-based wikilink routing: anchors rendered server-side point at
// "/#/page?path=<encoded path>" -- this is the single place that pattern is
// interpreted client-side.
// ---------------------------------------------------------------------------

function handleHash() {
  const hash = window.location.hash;
  const match = hash.match(/^#\/page\?path=(.+)$/);
  if (match) {
    const path = decodeURIComponent(match[1]);
    showView("wiki");
    openPage(path);
  }
}
window.addEventListener("hashchange", handleHash);

// ---------------------------------------------------------------------------
// Wiki: page list + reading pane
// ---------------------------------------------------------------------------

let allPages = [];
let selectedPath = null;

async function loadPageList() {
  try {
    const res = await fetchJsonWithTimeout("/api/pages", {}, PAGES_FETCH_TIMEOUT_MS);
    if (!res.ok) throw new Error(`unexpected status ${res.status}`);
    const data = await res.json();
    allPages = data.pages || [];
    renderPageList(allPages);
    setStatusHint("wiki-status-hint", "");
  } catch (err) {
    // Never blank the page list on a slow/failed fetch -- keep whatever was
    // last rendered and surface a subtle, non-blocking hint instead.
    setStatusHint("wiki-status-hint", "Couldn't refresh the page list -- showing the last known list.");
  }
}

function renderPageList(pages) {
  const container = document.getElementById("page-list");
  container.innerHTML = "";
  for (const page of pages) {
    const item = document.createElement("div");
    item.className = "page-list-item" + (page.path === selectedPath ? " selected" : "");
    item.innerHTML = `
      <div class="title">${escapeHtml(page.title)}</div>
      <div class="meta">
        <span class="type-dot ${escapeHtml(page.type)}"></span>
        ${escapeHtml(page.type)} &middot; ${page.link_count} out &middot; ${page.backlink_count} in
      </div>
    `;
    item.addEventListener("click", () => openPage(page.path));
    container.appendChild(item);
  }
  if (pages.length === 0) {
    container.innerHTML = '<div style="padding:1rem; color:var(--text-muted); font-size:0.85rem;">No pages yet.</div>';
  }
}

document.getElementById("page-filter").addEventListener("input", (event) => {
  const q = event.target.value.trim().toLowerCase();
  const filtered = q
    ? allPages.filter((p) => p.title.toLowerCase().includes(q) || p.tags.join(" ").toLowerCase().includes(q))
    : allPages;
  renderPageList(filtered);
});

async function openPage(path) {
  selectedPath = path;
  const pane = document.getElementById("reading-pane");
  pane.innerHTML = '<div class="empty-state"><span class="spinner"></span> Loading...</div>';
  try {
    const res = await fetch(`/api/page?path=${encodeURIComponent(path)}`);
    if (!res.ok) {
      pane.innerHTML = `<div class="empty-state">Page not found: ${escapeHtml(path)}</div>`;
      return;
    }
    const page = await res.json();
    renderPage(page);
    renderPageList(allPages); // refresh selected-highlight
  } catch (err) {
    pane.innerHTML = `<div class="empty-state">Failed to load page: ${escapeHtml(String(err))}</div>`;
  }
}

function renderPage(page) {
  const pane = document.getElementById("reading-pane");
  const tags = (page.tags || [])
    .map((t) => `<span class="tag">${escapeHtml(t)}</span>`)
    .join("");
  const outbound = (page.outbound || [])
    .map((link) =>
      link.path
        ? `<li><a class="wikilink" href="/#/page?path=${encodeURIComponent(link.path)}">${escapeHtml(link.title)}</a></li>`
        : `<li><span class="wikilink dangling">${escapeHtml(link.title)}</span> (missing)</li>`
    )
    .join("");
  const backlinks = (page.backlinks || [])
    .map((link) =>
      link.path
        ? `<li><a class="wikilink" href="/#/page?path=${encodeURIComponent(link.path)}">${escapeHtml(link.title)}</a></li>`
        : `<li>${escapeHtml(link.title)}</li>`
    )
    .join("");

  pane.innerHTML = `
    <div class="page-header">
      <h2>${escapeHtml(page.title)}</h2>
      <span class="badge">${escapeHtml(page.type)}</span>
    </div>
    <div class="page-path">${escapeHtml(page.path)}</div>
    <div class="tag-list">${tags}</div>
    <div class="page-body">${page.html}</div>
    ${outbound ? `<div class="backlinks"><h3>Outbound links (${page.outbound.length})</h3><ul>${outbound}</ul></div>` : ""}
    <div class="backlinks"><h3>Backlinks (${(page.backlinks || []).length})</h3>${
      backlinks ? `<ul>${backlinks}</ul>` : '<p style="color:var(--text-muted)">No backlinks yet.</p>'
    }</div>
    <details class="raw-toggle">
      <summary>Raw Markdown</summary>
      <pre>${escapeHtml(page.raw_markdown)}</pre>
    </details>
  `;
  // Intercept in-page wikilink clicks so navigation stays inside the SPA
  // (they're plain #/page?path=... anchors, but clicking still needs the
  // hash-change handler to run even if the hash string is unchanged).
  pane.querySelectorAll("a.wikilink").forEach((a) => {
    a.addEventListener("click", (event) => {
      const href = a.getAttribute("href");
      if (href === window.location.hash) {
        event.preventDefault();
        handleHash();
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

let searchDebounce = null;
document.getElementById("search-input").addEventListener("input", (event) => {
  const q = event.target.value.trim();
  clearTimeout(searchDebounce);
  if (!q) {
    document.getElementById("search-results").innerHTML = "";
    return;
  }
  searchDebounce = setTimeout(() => runSearch(q), 200);
});

async function runSearch(q) {
  const container = document.getElementById("search-results");
  container.innerHTML = '<p><span class="spinner"></span> Searching...</p>';
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&k=8`);
    const data = await res.json();
    const results = data.results || [];
    if (results.length === 0) {
      container.innerHTML = '<p style="color:var(--text-muted)">No results.</p>';
      return;
    }
    container.innerHTML = results
      .map(
        (r) => `
      <div class="result-card" data-path="${escapeHtml(r.page_path)}">
        <div class="title">${escapeHtml(r.title)}</div>
        <div class="meta">${escapeHtml(r.tier)} &middot; score ${r.score.toFixed(3)} &middot; ${escapeHtml(r.page_path)}</div>
        <div class="snippet">${r.snippet_html}</div>
      </div>`
      )
      .join("");
    container.querySelectorAll(".result-card").forEach((card) => {
      card.addEventListener("click", () => {
        showView("wiki");
        openPage(card.dataset.path);
      });
    });
  } catch (err) {
    container.innerHTML = `<p style="color:var(--danger)">Search failed: ${escapeHtml(String(err))}</p>`;
  }
}

// ---------------------------------------------------------------------------
// Ask
// ---------------------------------------------------------------------------

document.getElementById("ask-submit").addEventListener("click", runAsk);
document.getElementById("ask-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter") runAsk();
});

async function runAsk() {
  const question = document.getElementById("ask-input").value.trim();
  if (!question) return;
  const useLlm = document.getElementById("ask-use-llm").checked;
  const box = document.getElementById("ask-answer");
  box.innerHTML = '<div class="answer-box"><span class="spinner"></span> Thinking...</div>';
  try {
    const res = await fetch("/api/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, use_llm: useLlm, k: 8 }),
    });
    const data = await res.json();
    const citations = (data.citations || []).map((c) => `<span class="tag">${escapeHtml(c)}</span>`).join(" ");
    const errorNotice = data.error
      ? `<div class="answer-box" style="color:var(--danger); margin-bottom:0.6rem">${escapeHtml(data.text)}</div>`
      : `<div class="answer-box">${escapeHtml(data.text)}</div>`;
    box.innerHTML = `
      ${errorNotice}
      ${citations ? `<div class="tag-list" style="margin-top:0.6rem">${citations}</div>` : ""}
      <div class="answer-meta">used_llm=${data.used_llm} &middot; ${(data.hits || []).length} source page(s)</div>
    `;
  } catch (err) {
    box.innerHTML = `<div class="answer-box" style="color:var(--danger)">Query failed: ${escapeHtml(String(err))}</div>`;
  }
}

// ---------------------------------------------------------------------------
// Graph -- dependency-free force-directed canvas
// ---------------------------------------------------------------------------

const TYPE_COLORS = {
  source: "#2f9e5b",
  entity: "#9b5de5",
  concept: "#2f6fed",
  session: "#d9a406",
};

let graphLoaded = false;
let graphNodes = [];
let graphEdges = [];
let graphAnimHandle = null;
let dragNode = null;
let graphCanvas, graphCtx;

async function loadGraph() {
  if (graphLoaded) return;
  graphLoaded = true;
  graphCanvas = document.getElementById("graph-canvas");
  graphCtx = graphCanvas.getContext("2d");
  resizeCanvas();
  window.addEventListener("resize", resizeCanvas);

  try {
    await applyGraphData(await fetchGraphData());
    setStatusHint("graph-status-hint", "");
  } catch (err) {
    // Never blank the graph on a slow/failed fetch -- render with whatever
    // (possibly empty) data we have and surface a subtle hint.
    setStatusHint("graph-status-hint", "Couldn't load the graph -- retry from the Graph tab.");
  }

  setupGraphInteraction();
  runGraphSimulation();
}

async function fetchGraphData() {
  const res = await fetchJsonWithTimeout("/api/graph", {}, PAGES_FETCH_TIMEOUT_MS);
  if (!res.ok) throw new Error(`unexpected status ${res.status}`);
  return res.json();
}

async function applyGraphData(data) {
  const w = graphCanvas.width;
  const h = graphCanvas.height;
  const existingById = Object.fromEntries(graphNodes.map((n) => [n.id, n]));
  graphNodes = (data.nodes || []).map((n) => {
    const prev = existingById[n.id];
    return prev
      ? { ...prev, ...n }
      : {
          ...n,
          x: w / 2 + (Math.random() - 0.5) * w * 0.6,
          y: h / 2 + (Math.random() - 0.5) * h * 0.6,
          vx: 0,
          vy: 0,
        };
  });
  const byId = Object.fromEntries(graphNodes.map((n) => [n.id, n]));
  graphEdges = (data.edges || [])
    .map((e) => ({ source: byId[e.source], target: byId[e.target] }))
    .filter((e) => e.source && e.target);
}

async function refreshGraphIfLoaded() {
  // Only re-fetch if the Graph tab has actually been visited -- avoids an
  // unnecessary request/simulation restart for users who never open it.
  if (!graphLoaded) return;
  try {
    await applyGraphData(await fetchGraphData());
    setStatusHint("graph-status-hint", "");
  } catch (err) {
    // Keep whatever graph is currently rendered; don't blank it.
    setStatusHint("graph-status-hint", "Couldn't refresh the graph -- showing the last known graph.");
  }
}

function resizeCanvas() {
  if (!graphCanvas) return;
  const rect = graphCanvas.parentElement.getBoundingClientRect();
  graphCanvas.width = rect.width;
  graphCanvas.height = rect.height;
}

function runGraphSimulation() {
  const REPULSION = 2600;
  const SPRING = 0.02;
  const SPRING_LEN = 110;
  const DAMPING = 0.85;
  const CENTER_PULL = 0.01;

  function tick() {
    const w = graphCanvas.width;
    const h = graphCanvas.height;

    for (let i = 0; i < graphNodes.length; i++) {
      const a = graphNodes[i];
      if (a === dragNode) continue;
      let fx = 0;
      let fy = 0;
      for (let j = 0; j < graphNodes.length; j++) {
        if (i === j) continue;
        const b = graphNodes[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let distSq = dx * dx + dy * dy || 0.01;
        const force = REPULSION / distSq;
        const dist = Math.sqrt(distSq);
        fx += (dx / dist) * force;
        fy += (dy / dist) * force;
      }
      fx += (w / 2 - a.x) * CENTER_PULL;
      fy += (h / 2 - a.y) * CENTER_PULL;
      a.vx = (a.vx + fx) * DAMPING;
      a.vy = (a.vy + fy) * DAMPING;
    }

    for (const edge of graphEdges) {
      const dx = edge.target.x - edge.source.x;
      const dy = edge.target.y - edge.source.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const force = (dist - SPRING_LEN) * SPRING;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      if (edge.source !== dragNode) {
        edge.source.vx += fx;
        edge.source.vy += fy;
      }
      if (edge.target !== dragNode) {
        edge.target.vx -= fx;
        edge.target.vy -= fy;
      }
    }

    for (const n of graphNodes) {
      if (n === dragNode) continue;
      n.x += n.vx * 0.02;
      n.y += n.vy * 0.02;
      n.x = Math.max(20, Math.min(w - 20, n.x));
      n.y = Math.max(20, Math.min(h - 20, n.y));
    }

    drawGraph();
    graphAnimHandle = requestAnimationFrame(tick);
  }
  tick();
}

function drawGraph() {
  const ctx = graphCtx;
  const w = graphCanvas.width;
  const h = graphCanvas.height;
  const style = getComputedStyle(document.documentElement);
  ctx.clearRect(0, 0, w, h);

  ctx.strokeStyle = style.getPropertyValue("--border") || "#ccc";
  ctx.lineWidth = 1;
  for (const edge of graphEdges) {
    ctx.beginPath();
    ctx.moveTo(edge.source.x, edge.source.y);
    ctx.lineTo(edge.target.x, edge.target.y);
    ctx.stroke();
  }

  ctx.font = "11px sans-serif";
  ctx.textAlign = "center";
  for (const node of graphNodes) {
    ctx.beginPath();
    ctx.fillStyle = TYPE_COLORS[node.type] || "#888";
    ctx.arc(node.x, node.y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = style.getPropertyValue("--text") || "#111";
    ctx.fillText(truncateLabel(node.label), node.x, node.y - 12);
  }
}

function truncateLabel(label) {
  return label.length > 24 ? label.slice(0, 22) + "..." : label;
}

function nodeAt(x, y) {
  for (const node of graphNodes) {
    const dx = node.x - x;
    const dy = node.y - y;
    if (dx * dx + dy * dy <= 12 * 12) return node;
  }
  return null;
}

function setupGraphInteraction() {
  let didDrag = false;
  graphCanvas.addEventListener("mousedown", (event) => {
    const { x, y } = canvasPoint(event);
    const node = nodeAt(x, y);
    if (node) {
      dragNode = node;
      didDrag = false;
    }
  });
  graphCanvas.addEventListener("mousemove", (event) => {
    if (!dragNode) return;
    const { x, y } = canvasPoint(event);
    dragNode.x = x;
    dragNode.y = y;
    dragNode.vx = 0;
    dragNode.vy = 0;
    didDrag = true;
  });
  window.addEventListener("mouseup", () => {
    dragNode = null;
  });
  graphCanvas.addEventListener("click", (event) => {
    if (didDrag) {
      didDrag = false;
      return;
    }
    const { x, y } = canvasPoint(event);
    const node = nodeAt(x, y);
    if (node) {
      showView("wiki");
      openPage(node.id);
    }
  });
}

function canvasPoint(event) {
  const rect = graphCanvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

// ---------------------------------------------------------------------------
// Ingest / drop zone
// ---------------------------------------------------------------------------

const dropZone = document.getElementById("drop-zone");
const fileInput = document.getElementById("file-input");

dropZone.addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => uploadFiles(fileInput.files));

["dragenter", "dragover"].forEach((evt) =>
  dropZone.addEventListener(evt, (event) => {
    event.preventDefault();
    dropZone.classList.add("dragover");
  })
);
["dragleave", "drop"].forEach((evt) =>
  dropZone.addEventListener(evt, (event) => {
    event.preventDefault();
    dropZone.classList.remove("dragover");
  })
);
dropZone.addEventListener("drop", (event) => {
  const files = event.dataTransfer.files;
  if (files && files.length) uploadFiles(files);
});

// Ingestion is asynchronous: `POST /api/upload`/`POST /api/ingest` return a
// `job_id` immediately (the actual ingest/compile/reindex work happens on
// the server's single background worker thread), and this client polls
// `GET /api/ingest/status` roughly once a second to render live per-file
// progress until the job reports `done`.
let ingestPollHandle = null;
let ingestPollJobId = null;

function stopIngestPolling() {
  if (ingestPollHandle !== null) {
    clearInterval(ingestPollHandle);
    ingestPollHandle = null;
  }
  ingestPollJobId = null;
}

function startIngestPolling(jobId) {
  stopIngestPolling();
  ingestPollJobId = jobId;
  pollIngestStatus(jobId);
  ingestPollHandle = setInterval(() => pollIngestStatus(jobId), 1000);
}

async function pollIngestStatus(jobId) {
  try {
    const res = await fetchJsonWithTimeout(
      `/api/ingest/status?job_id=${encodeURIComponent(jobId)}`,
      {},
      10000
    );
    if (!res.ok) throw new Error(`unexpected status ${res.status}`);
    const data = await res.json();
    // A newer job may have superseded this poll loop (e.g. the user
    // triggered another upload); ignore stale responses.
    if (jobId !== ingestPollJobId) return;
    renderIngestProgress(data);
    if (data.done) {
      stopIngestPolling();
      loadPageList();
      refreshGraphIfLoaded();
    }
  } catch (err) {
    // Transient poll failure -- keep the panel as-is and try again on the
    // next tick rather than clearing progress the user has already seen.
  }
}

async function uploadFiles(fileList) {
  const result = document.getElementById("ingest-result");
  result.innerHTML = '<div class="result-panel"><span class="spinner"></span> Uploading...</div>';
  const formData = new FormData();
  for (const file of fileList) formData.append("files", file, file.name);
  try {
    const res = await fetch("/api/upload", { method: "POST", body: formData });
    const data = await res.json();
    if (!res.ok || !data.job_id) throw new Error(data.detail || "no job id returned");
    startIngestPolling(data.job_id);
  } catch (err) {
    result.innerHTML = `<div class="result-panel" style="color:var(--danger)">Upload failed: ${escapeHtml(String(err))}</div>`;
  }
}

document.getElementById("ingest-only-btn").addEventListener("click", async () => {
  const result = document.getElementById("ingest-result");
  result.innerHTML = '<div class="result-panel"><span class="spinner"></span> Queuing ingest of drop/...</div>';
  try {
    const res = await fetch("/api/ingest", { method: "POST" });
    const data = await res.json();
    if (!res.ok || !data.job_id) throw new Error(data.detail || "no job id returned");
    startIngestPolling(data.job_id);
  } catch (err) {
    result.innerHTML = `<div class="result-panel" style="color:var(--danger)">Ingest failed: ${escapeHtml(String(err))}</div>`;
  }
});

function renderIngestProgress(data) {
  const result = document.getElementById("ingest-result");
  const files = data.files || [];
  const settledCount = files.filter((f) => f.status === "done" || f.status === "error").length;
  const pct = files.length ? Math.round((settledCount / files.length) * 100) : data.done ? 100 : 0;
  const statusLabel = data.status === "queued" ? "Queued..." : data.status === "running" ? "Ingesting..." : "Done";

  const fileRows = files
    .map(
      (f) => `
      <li class="job-file job-file-${escapeHtml(f.status)}">
        <span class="job-file-name">${escapeHtml(f.name)}</span>
        <span class="job-file-badge job-file-badge-${escapeHtml(f.status)}">${escapeHtml(f.status)}</span>
        ${f.message ? `<div class="job-file-message">${escapeHtml(f.message)}</div>` : ""}
      </li>`
    )
    .join("");

  const summary = data.done
    ? `<div class="result-panel">Ingested: ${data.ingested}
Compiled: ${data.compiled}
Skipped (duplicates): ${data.skipped}
Errors: ${(data.errors || []).length}</div>`
    : "";

  result.innerHTML = `
    <div class="result-panel">
      <div class="job-status-line">
        ${data.done ? "" : '<span class="spinner"></span>'}
        ${escapeHtml(statusLabel)}${files.length ? ` (${settledCount} / ${files.length} compiled)` : ""}
      </div>
      ${files.length ? `<div class="progress-bar"><div class="progress-fill" style="width:${pct}%"></div></div>` : ""}
      ${fileRows ? `<ul class="job-file-list">${fileRows}</ul>` : ""}
    </div>
    ${summary}
  `;
}

// ---------------------------------------------------------------------------
// Lint
// ---------------------------------------------------------------------------

document.getElementById("lint-refresh-btn").addEventListener("click", loadLint);
document.getElementById("lint-fix-btn").addEventListener("click", async () => {
  const container = document.getElementById("lint-report");
  container.innerHTML = '<p><span class="spinner"></span> Fixing...</p>';
  try {
    const res = await fetch("/api/lint/fix", { method: "POST" });
    await res.json();
    await loadLint();
  } catch (err) {
    container.innerHTML = `<p style="color:var(--danger)">Fix failed: ${escapeHtml(String(err))}</p>`;
  }
});

async function loadLint() {
  const container = document.getElementById("lint-report");
  container.innerHTML = '<p><span class="spinner"></span> Loading lint report...</p>';
  try {
    const res = await fetch("/api/lint");
    const report = await res.json();
    if (report.ok) {
      // `report.summary` already contains the full sentence (e.g. "Vault is
      // clean: no orphans, ..."); rendering it as-is avoids double-prefixing
      // "Vault is clean:" in front of itself.
      container.innerHTML = `<p class="lint-ok">${escapeHtml(report.summary)}</p>`;
      return;
    }
    const section = (title, items, render) =>
      items.length
        ? `<div class="lint-section"><h3>${title} (${items.length})</h3><ul>${items.map(render).join("")}</ul></div>`
        : "";
    container.innerHTML = [
      section("Orphan pages", report.orphans, (o) => `<li>${escapeHtml(o.title)} (${escapeHtml(o.path)})</li>`),
      section(
        "Broken wikilinks",
        report.dangling_links,
        (d) => `<li>${escapeHtml(d.source_title)} &rarr; ${escapeHtml(d.target_title)} (missing)</li>`
      ),
      section(
        "Stale index rows",
        report.stale_index_entries,
        (s) => `<li>${escapeHtml(s.page_path)} (${escapeHtml(s.reason)})</li>`
      ),
      section(
        "Thin pages",
        report.thin_pages,
        (t) => `<li>${escapeHtml(t.title)} (${t.char_count} chars)</li>`
      ),
    ].join("");
  } catch (err) {
    container.innerHTML = `<p style="color:var(--danger)">Failed to load lint report: ${escapeHtml(String(err))}</p>`;
  }
}

// ---------------------------------------------------------------------------
// Settings -- provider/model configuration, populated from AuthHub's live
// model list where available (falls back to a free-text input otherwise).
// ---------------------------------------------------------------------------

async function refreshAskModelHint() {
  try {
    const res = await fetch("/api/config");
    const data = await res.json();
    document.getElementById("ask-model-hint").textContent = `Model: ${data.model} (${data.provider})`;
  } catch (err) {
    document.getElementById("ask-model-hint").textContent = "Model: unavailable";
  }
}

async function loadSettingsView() {
  const providerSelect = document.getElementById("settings-provider");
  const modelSelect = document.getElementById("settings-model-select");
  const modelInput = document.getElementById("settings-model-input");
  const modelsHint = document.getElementById("settings-models-hint");
  const keyHint = document.getElementById("settings-key-hint");

  let config;
  try {
    const res = await fetch("/api/config");
    config = await res.json();
  } catch (err) {
    document.getElementById("settings-status").innerHTML =
      `<p style="color:var(--danger)">Failed to load current config: ${escapeHtml(String(err))}</p>`;
    return;
  }

  providerSelect.value = config.provider;
  keyHint.textContent = config.has_api_key
    ? "An API key is configured for this provider."
    : "No API key is configured for this provider on the server -- synthesis will fail until one is set.";

  try {
    const res = await fetch("/api/models");
    const data = await res.json();
    if (data.models && data.models.length) {
      modelSelect.innerHTML = data.models
        .map((m) => `<option value="${escapeHtml(m)}"${m === config.model ? " selected" : ""}>${escapeHtml(m)}</option>`)
        .join("");
      if (!data.models.includes(config.model)) {
        modelSelect.insertAdjacentHTML(
          "afterbegin",
          `<option value="${escapeHtml(config.model)}" selected>${escapeHtml(config.model)} (current)</option>`
        );
      }
      modelSelect.classList.remove("hidden");
      modelInput.classList.add("hidden");
      modelsHint.textContent = "";
    } else {
      modelInput.value = config.model;
      modelInput.classList.remove("hidden");
      modelSelect.classList.add("hidden");
      modelsHint.textContent = data.error || "No model list available -- enter a model slug manually.";
    }
  } catch (err) {
    modelInput.value = config.model;
    modelInput.classList.remove("hidden");
    modelSelect.classList.add("hidden");
    modelsHint.textContent = `Could not load model list: ${escapeHtml(String(err))}`;
  }
}

document.getElementById("settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const provider = document.getElementById("settings-provider").value;
  const modelSelect = document.getElementById("settings-model-select");
  const modelInput = document.getElementById("settings-model-input");
  const model = modelSelect.classList.contains("hidden") ? modelInput.value.trim() : modelSelect.value;
  const status = document.getElementById("settings-status");

  if (!model) {
    status.innerHTML = '<p style="color:var(--danger)">Model is required.</p>';
    return;
  }

  status.innerHTML = '<p><span class="spinner"></span> Saving...</p>';
  try {
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, model }),
    });
    if (!res.ok) {
      const detail = await res.json().catch(() => ({}));
      status.innerHTML = `<p style="color:var(--danger)">Save failed: ${escapeHtml(detail.detail || res.statusText)}</p>`;
      return;
    }
    const data = await res.json();
    status.innerHTML = `<p class="lint-ok">Model set to ${escapeHtml(data.model)} (${escapeHtml(data.provider)}).</p>`;
    refreshAskModelHint();
  } catch (err) {
    status.innerHTML = `<p style="color:var(--danger)">Save failed: ${escapeHtml(String(err))}</p>`;
  }
});

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value == null ? "" : String(value);
  return div.innerHTML;
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

loadPageList();
handleHash();
refreshAskModelHint();
