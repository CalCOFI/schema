// CalCOFI Schema — client-side schema browser
//
// Fetches per-release sidecars from GCS (metadata.json, erd.mmd,
// relationships.json, catalog.json, RELEASE_NOTES.md), populates the
// version dropdown from versions.json + latest.txt, and renders five
// tabs: ERD (Mermaid + svg-pan-zoom), Tables, Columns, Datasets,
// Measurement types. Vanilla ES module — no framework, no DuckDB-WASM.
//
// State is intentionally global on `window.SchemaApp` so the browser
// devtools can poke at it.

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

// GCS base from Jekyll config → injected via inline script tag below
const GCS = window.SCHEMA_GCS_BASE
         || "https://storage.googleapis.com/calcofi-db/ducklake/releases";

const State = window.SchemaApp = {
  versions:        [],     // [{version, release_date, ...}, ...]
  latestVersion:   null,   // resolved from latest.txt
  activeVersion:   null,
  activeTab:       "erd",
  byVersion:       new Map(), // version → {metadata, erd, relationships, catalog, notes}
  filters:         new Set(), // active "provider_dataset" tag filters (OR across)
  datasetColor:    {},        // provider_dataset → hex (from metadata.erd_legend)
  _apply:          {},        // tab → fn re-applying text+tag filters for that tab
};

// ─── utility ────────────────────────────────────────────────────────────

function setStatus(msg, cls = "muted") {
  const el = $("#status");
  el.textContent = msg;
  el.className = `status ${cls}`;
}

// revalidate sidecars (conditional GET → 304 when unchanged) so a re-uploaded
// release (same URL, new content) is picked up without waiting out the GCS
// max-age=3600 cache. "no-cache" still lets the browser reuse a validated copy.
async function fetchText(url) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}
async function fetchJson(url) {
  const r = await fetch(url, { cache: "no-cache" });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

function fmtBytes(n) {
  if (!n) return "—";
  const u = ["B","KB","MB","GB","TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 ? 0 : 1)} ${u[i]}`;
}
function fmtInt(n) {
  if (n == null) return "—";
  return Number(n).toLocaleString();
}
function safeText(s) { return (s == null) ? "" : String(s); }
function escHtml(s) {
  return safeText(s)
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
    .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
}
function mdToHtml(s) {
  if (!s) return "";
  try   { return marked.parse(s, { breaks: false }); }
  catch { return escHtml(s); }
}

// ─── tag filtering (shared across tabs) ───────────────────────────────────

// the provider_dataset tags a table belongs to. Prefers the authoritative
// contributions block (multi-dataset for shared tables); falls back to the
// table's own provider/dataset. Returns a (possibly empty) array.
function tableDatasets(name, blobs) {
  const meta = blobs.metadata || {};
  const contrib = (meta.contributions || {})[name];
  if (contrib && Array.isArray(contrib.by_dataset) && contrib.by_dataset.length) {
    return contrib.by_dataset.map(c => c.provider_dataset).filter(Boolean);
  }
  const t = (meta.tables || {})[name];
  if (t && t.provider && t.dataset) return [`${t.provider}_${t.dataset}`];
  return [];
}

// does a node (tagged with data-datasets="a b c") pass the active tag filter?
function passesTags(datasets) {
  if (State.filters.size === 0) return true;
  return (datasets || []).some(d => State.filters.has(d));
}

function tagAttr(datasets) {
  return `data-datasets="${escHtml((datasets || []).join(" "))}"`;
}

// toggle a dataset tag and re-apply the current tab's filter
function toggleFilter(ds) {
  if (State.filters.has(ds)) State.filters.delete(ds);
  else                       State.filters.add(ds);
  applyForCurrentTab();
}

function applyForCurrentTab() {
  updateFilterBarUI();
  const fn = State._apply[State.activeTab];
  if (typeof fn === "function") fn();
}

// ─── global filter bar ────────────────────────────────────────────────────

function renderFilterBar(blobs) {
  const bar  = $("#global-filter-bar");
  const wrap = $("#filter-chips");
  if (!bar || !wrap) return;
  const datasets = Object.keys((blobs.metadata || {}).datasets || {}).sort();
  if (!datasets.length) { bar.hidden = true; return; }
  // drop any active filters not present in this version
  for (const f of [...State.filters]) if (!datasets.includes(f)) State.filters.delete(f);
  wrap.innerHTML = datasets.map(d => {
    const col = State.datasetColor[d];
    const sw  = col ? `<span class="ds-swatch" style="background:${escHtml(col)}"></span>` : "";
    return `<button type="button" class="filter-chip" data-dataset="${escHtml(d)}">${sw}${escHtml(d)}</button>`;
  }).join("");
  bar.hidden = false;
  updateFilterBarUI();
}

function updateFilterBarUI() {
  $$("#filter-chips .filter-chip").forEach(b => {
    b.classList.toggle("active", State.filters.has(b.dataset.dataset));
  });
  const clear = $("#filter-clear");
  if (clear) clear.hidden = State.filters.size === 0;
}

// ─── initial load ───────────────────────────────────────────────────────

async function init() {
  setStatus("Loading versions…");

  // versions + latest in parallel
  let versionsJson, latestTxt;
  try {
    [versionsJson, latestTxt] = await Promise.all([
      fetchJson(`${GCS}/versions.json`),
      fetchText(`${GCS}/latest.txt`)
    ]);
  } catch (e) {
    setStatus(`Failed to load versions: ${e.message}`, "error");
    return;
  }

  State.versions      = versionsJson.versions || [];
  State.latestVersion = latestTxt.trim();

  // populate dropdown
  const sel = $("#version-select");
  sel.innerHTML = State.versions
    .map(v => {
      const isLatest = v.version === State.latestVersion;
      const dateBit  = v.release_date ? ` · ${v.release_date}` : "";
      const star     = isLatest ? "★ " : "";
      return `<option value="${escHtml(v.version)}">${star}${escHtml(v.version)}${escHtml(dateBit)}</option>`;
    })
    .join("");

  // resolve initial version + tab from URL hash, else fall back to latest
  const fromHash = parseHash();
  State.activeVersion = fromHash.version
                     && State.versions.some(v => v.version === fromHash.version)
                       ? fromHash.version
                       : State.latestVersion;
  State.activeTab     = ["erd","tables","columns","datasets","measurements"]
                          .includes(fromHash.tab) ? fromHash.tab : "erd";
  sel.value = State.activeVersion;

  bindHeader();
  setActiveTabUI(State.activeTab);
  await loadVersion(State.activeVersion);
  renderActiveTab();
  syncHash();
}

function parseHash() {
  const h = (location.hash || "").replace(/^#/, "");
  if (!h) return {};
  const [tab, qs] = h.split("?");
  const params = new URLSearchParams(qs || "");
  return { tab, version: params.get("v") };
}
function syncHash() {
  const qs = State.activeVersion ? `?v=${encodeURIComponent(State.activeVersion)}` : "";
  history.replaceState(null, "", `#${State.activeTab}${qs}`);
}

// ─── per-version fetch ──────────────────────────────────────────────────

async function loadVersion(version) {
  if (State.byVersion.has(version)) return State.byVersion.get(version);
  setStatus(`Loading ${version}…`);
  const base = `${GCS}/${encodeURIComponent(version)}`;
  // notes + relationships + erd are optional; metadata + catalog are required
  const tasks = {
    metadata:      fetchJson(`${base}/metadata.json`),
    catalog:       fetchJson(`${base}/catalog.json`),
    relationships: fetchJson(`${base}/relationships.json`).catch(() => null),
    erd:           fetchText(`${base}/erd.mmd`).catch(() => null),
    notes:         fetchText(`${base}/RELEASE_NOTES.md`).catch(() => null),
  };
  const out = {};
  for (const k of Object.keys(tasks)) {
    try { out[k] = await tasks[k]; }
    catch (e) {
      if (k === "metadata" || k === "catalog") {
        setStatus(`Required sidecar missing for ${version}: ${e.message}`, "error");
        throw e;
      }
      out[k] = null;
    }
  }
  State.byVersion.set(version, out);
  setStatus(`${version} loaded`, "muted");
  renderReleaseMeta(version, out);
  return out;
}

function renderReleaseMeta(version, blobs) {
  const meta    = blobs.metadata;
  const catalog = blobs.catalog;
  $("#rm-version").textContent = version;
  $("#rm-date").textContent    = (meta && meta.release_date) || (catalog && catalog.release_date) || "—";
  $("#rm-tables").textContent  = (catalog && Array.isArray(catalog.tables)) ? catalog.tables.length : "—";
  $("#rm-rows").textContent    = fmtInt(catalog && catalog.total_rows);
  $("#rm-size").textContent    = fmtBytes(catalog && catalog.total_size);
  $("#release-meta-panel").hidden = false;

  // modal body — populated here so opening the dialog is just .showModal()
  $("#notes-modal-version").textContent = version;
  const body = $("#notes-modal-body");
  if (blobs.notes) {
    body.innerHTML = mdToHtml(blobs.notes);
  } else {
    body.innerHTML = `<em class="muted">No RELEASE_NOTES.md found for ${escHtml(version)}.</em>`;
  }

  // dataset → color map (defensive: erd_legend is new; old releases lack it)
  State.datasetColor = {};
  for (const e of (meta && meta.erd_legend) || []) {
    if (e && e.provider_dataset) State.datasetColor[e.provider_dataset] = e.color;
  }
  renderFilterBar(blobs);
}

// ─── header / tab wiring ────────────────────────────────────────────────

function bindHeader() {
  $("#version-select").addEventListener("change", async (e) => {
    State.activeVersion = e.target.value;
    await loadVersion(State.activeVersion);
    renderActiveTab(true);
    syncHash();
  });
  $$("nav.tab-nav .tab").forEach(btn => {
    btn.addEventListener("click", () => {
      State.activeTab = btn.dataset.tab;
      setActiveTabUI(State.activeTab);
      renderActiveTab();
      syncHash();
    });
  });
  $("#theme-toggle").addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("theme", next);
    // re-render ERD on theme change because mermaid bakes colors into the SVG
    if (State.activeTab === "erd") renderActiveTab(true);
  });
  const notesModal = $("#notes-modal");
  $("#rm-notes-toggle").addEventListener("click", () => {
    if (typeof notesModal.showModal === "function") notesModal.showModal();
    else notesModal.setAttribute("open", "");   // graceful fallback for <dialog>-less browsers
  });
  $("#notes-modal-close").addEventListener("click", () => notesModal.close());
  // click outside the content area closes the modal
  notesModal.addEventListener("click", (e) => {
    if (e.target === notesModal) notesModal.close();
  });
  $("#erd-fit").addEventListener("click", () => {
    if (!State._erdPanZoom) return;
    State._erdPanZoom.fit();
    State._erdPanZoom.center();
  });
  // delegated: any clickable dataset tag (filter bar or in-card chip) toggles
  // the corresponding cross-tab filter
  document.addEventListener("click", (e) => {
    const chip = e.target.closest(".filter-chip[data-dataset]");
    if (chip) { toggleFilter(chip.dataset.dataset); }
  });
  $("#filter-clear").addEventListener("click", () => {
    State.filters.clear();
    applyForCurrentTab();
  });
}

function setActiveTabUI(tab) {
  $$("nav.tab-nav .tab").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  $$(".tab-panel").forEach(p => p.hidden = p.dataset.tab !== tab);
}

// `forceRefresh=true` busts the per-tab "already rendered" cache (used when
// switching version or theme)
function renderActiveTab(forceRefresh = false) {
  const blobs = State.byVersion.get(State.activeVersion);
  if (!blobs) return;
  const t = State.activeTab;
  if (forceRefresh) {
    State._rendered = State._rendered || {};
    delete State._rendered[t];
  }
  State._rendered = State._rendered || {};
  if (!State._rendered[t]) {
    State._rendered[t] = true;
    switch (t) {
      case "erd":          renderErd(blobs);          break;
      case "tables":       renderTables(blobs);       break;
      case "columns":      renderColumns(blobs);      break;
      case "datasets":     renderDatasets(blobs);     break;
      case "measurements": renderMeasurements(blobs); break;
    }
  }
  // re-apply active tag filters for the now-active tab (filters may have
  // changed while a different tab was showing)
  const apply = State._apply[t];
  if (typeof apply === "function") apply();
}

// ─── ERD ────────────────────────────────────────────────────────────────

function renderErdLegend(blobs) {
  const el = $("#erd-legend");
  if (!el) return;
  const legend = (blobs.metadata || {}).erd_legend || [];
  if (!legend.length) { el.innerHTML = ""; return; }
  el.innerHTML = legend.map(e =>
    `<span class="erd-legend-item">
       <span class="ds-swatch" style="background:${escHtml(e.color)}"></span>${escHtml(e.provider_dataset)}
     </span>`).join("");
}

async function renderErd(blobs) {
  renderErdLegend(blobs);
  const wrap = $("#erd-svg-wrap");
  wrap.innerHTML = "";
  if (!blobs.erd) {
    wrap.innerHTML = `<div class="muted" style="padding:1rem">erd.mmd not found for this release.</div>`;
    return;
  }
  const theme = document.documentElement.dataset.theme === "light" ? "default" : "dark";
  mermaid.initialize({ startOnLoad: false, theme, securityLevel: "loose" });
  let svg;
  try {
    const { svg: rendered } = await mermaid.render(`erd-${Date.now()}`, blobs.erd);
    svg = rendered;
  } catch (e) {
    wrap.innerHTML = `<div class="error" style="padding:1rem;color:var(--error)">Mermaid render failed: ${escHtml(e.message)}</div>`;
    return;
  }
  wrap.innerHTML = svg;
  // svg-pan-zoom needs an actual SVG node, not a string
  const svgEl = wrap.querySelector("svg");
  if (svgEl && window.svgPanZoom) {
    svgEl.setAttribute("width", "100%");
    svgEl.setAttribute("height", "100%");
    if (State._erdPanZoom) { try { State._erdPanZoom.destroy(); } catch {} }
    State._erdPanZoom = svgPanZoom(svgEl, {
      panEnabled:    true,
      zoomEnabled:   true,
      controlIconsEnabled: false,
      fit:           true,
      center:        true,
      minZoom:       0.2,
      maxZoom:       8,
      zoomScaleSensitivity: 0.3,
    });
  }
  // make entities clickable (→ table columns) and wire dataset-filter highlight
  decorateErdEntities(blobs);
  State._apply.erd = () => applyErdHighlight(blobs);
  applyErdHighlight(blobs);
}

// entity group ids look like "entity-<table>-<index>"; table names use
// underscores (no hyphens), so strip the prefix and trailing -<index>
function erdEntityName(id) {
  return id.replace(/^entity-/, "").replace(/-\d+$/, "");
}

// make each ER entity clickable: jump to its table's columns
function decorateErdEntities(blobs) {
  $$("#erd-svg-wrap g[id^='entity-']").forEach(g => {
    if (g.dataset.ccWired) return;
    g.dataset.ccWired = "1";
    g.classList.add("erd-entity");
    const name = erdEntityName(g.id);
    // tooltip: table name + dataset(s) on their own line (the pastel stroke
    // colors are hard to tell apart) + the click hint
    const ds = tableDatasets(name, blobs);
    const dsLabel = ds.length ? ds.join(", ") : "—";
    const ttl = document.createElementNS("http://www.w3.org/2000/svg", "title");
    ttl.textContent = `${name}\ndataset: ${dsLabel}\nclick for columns`;
    g.appendChild(ttl);
    g.addEventListener("click", (ev) => {
      // svg-pan-zoom pans on drag; a real click (no drag) still fires here
      ev.stopPropagation();
      showTableColumns(name);
    });
  });
}

// highlight entities (+ their edges) for the active dataset filter; dim the rest
function applyErdHighlight(blobs) {
  if (!$("#erd-svg-wrap svg")) return;
  const active = State.filters.size > 0;
  const dimmed = new Set();
  $$("#erd-svg-wrap g[id^='entity-']").forEach(g => {
    const ds = tableDatasets(erdEntityName(g.id), blobs);
    const match = !active || ds.some(d => State.filters.has(d));
    g.style.opacity = match ? "1" : "0.1";
    g.style.transition = "opacity 0.15s";
    if (!match) dimmed.add(g.id);
  });
  // relationship edge ids embed both entity ids: id_entity-<a>-N_entity-<b>-N_..
  $$("#erd-svg-wrap path[id^='id_entity-']").forEach(p => {
    const touches = [...dimmed].some(eid => p.id.includes(eid));
    p.style.opacity = (active && touches) ? "0.05" : "";
  });
  // FK column labels: dim all when filtering (precise edge mapping not needed)
  $$("#erd-svg-wrap .edgeLabel, #erd-svg-wrap .edgeLabels").forEach(el => {
    el.style.opacity = active ? "0.12" : "";
  });
}

// open a table's columns: switch to Tables tab, filter to it, expand + scroll
function showTableColumns(name) {
  State.activeTab = "tables";
  setActiveTabUI("tables");
  renderActiveTab();
  const input = $("#tables-filter");
  if (input) { input.value = name; input.dispatchEvent(new Event("input")); }
  requestAnimationFrame(() => {
    const sel = `#tables-list .card[data-table-name="${(window.CSS && CSS.escape) ? CSS.escape(name) : name}"]`;
    const card = document.querySelector(sel);
    if (card) {
      const d = card.querySelector("details");
      if (d) d.open = true;
      card.scrollIntoView({ behavior: "smooth", block: "start" });
      card.classList.add("card-flash");
      setTimeout(() => card.classList.remove("card-flash"), 1500);
    }
  });
  syncHash();
}

// ─── Tables ─────────────────────────────────────────────────────────────

function renderTables(blobs) {
  const meta = blobs.metadata;
  const catalog = blobs.catalog;
  const list = $("#tables-list");
  const tables = Object.entries(meta.tables || {});
  // sort: by name (provider+dataset chip handles grouping visually)
  tables.sort((a, b) => a[0].localeCompare(b[0]));

  const rowsByTable = new Map();
  if (catalog && Array.isArray(catalog.tables)) {
    for (const t of catalog.tables) rowsByTable.set(t.name, t.rows);
  }

  // build a per-table column index from metadata.columns ("table.column" key)
  const colsByTable = new Map();
  for (const [key, entry] of Object.entries(meta.columns || {})) {
    const dot = key.indexOf(".");
    if (dot < 0) continue;
    const tbl = key.slice(0, dot);
    const col = key.slice(dot + 1);
    if (!colsByTable.has(tbl)) colsByTable.set(tbl, []);
    colsByTable.get(tbl).push({ column: col, ...entry });
  }

  const knownDatasets = new Set(Object.keys(meta.datasets || {}));
  list.innerHTML = tables.map(([name, t]) => {
    const cols = colsByTable.get(name) || [];
    const rows = rowsByTable.get(name);
    const ds   = tableDatasets(name, blobs);
    // one chip per dataset this table belongs to (shared tables get several);
    // clickable only for registered datasets so it ties into the filter bar
    const dsChips = ds.length
      ? ds.map(d => knownDatasets.has(d)
          ? `<button type="button" class="chip filter-chip" data-dataset="${escHtml(d)}">${escHtml(d)}</button>`
          : `<span class="chip">${escHtml(d)}</span>`).join("")
      : [t.provider, t.dataset].filter(Boolean).map(x => `<span class="chip">${escHtml(x)}</span>`).join("");
    return `
      <article class="card" data-table-name="${escHtml(name)}" ${tagAttr(ds)}>
        <h3>
          <span>${escHtml(name)}</span>
          ${t.name_long ? `<span class="name-long">${escHtml(t.name_long)}</span>` : ""}
        </h3>
        <div class="card-meta">
          ${dsChips}
          ${rows != null ? `<span class="chip">${fmtInt(rows)} rows</span>` : ""}
          <span class="chip">${cols.length} cols</span>
        </div>
        <div class="desc">${mdToHtml(t.description_md)}</div>
        <details>
          <summary class="col-toggle">columns ▾</summary>
          <div class="col-list">
            ${cols.map(c => `
              <div class="col-row">
                <span class="col-name">${escHtml(c.column)}</span>
                <span class="col-type">${escHtml(c.data_type || "")}</span>
                <span class="col-units">${c.units ? escHtml(c.units) : ""}</span>
                <span class="col-desc">${mdToHtml(c.description_md || "")}</span>
              </div>
            `).join("")}
          </div>
        </details>
      </article>
    `;
  }).join("");

  // text + tag filter (registered so the filter bar + tab switches re-apply it)
  const apply = () => {
    const q = ($("#tables-filter").value || "").toLowerCase().trim();
    let visible = 0;
    $$("#tables-list .card").forEach(card => {
      const ds   = (card.dataset.datasets || "").split(" ").filter(Boolean);
      const show = (!q || card.textContent.toLowerCase().includes(q)) && passesTags(ds);
      card.style.display = show ? "" : "none";
      if (show) visible++;
    });
    $("#tables-count").textContent = `${visible} / ${tables.length} tables`;
  };
  State._apply.tables = apply;
  $("#tables-filter").oninput = apply;
  apply();
}

// ─── Columns (flat sortable table) ──────────────────────────────────────

function renderColumns(blobs) {
  const meta = blobs.metadata;
  const dsCache = new Map();
  const dsFor = (tbl) => {
    if (!dsCache.has(tbl)) dsCache.set(tbl, tableDatasets(tbl, blobs));
    return dsCache.get(tbl);
  };
  const all = Object.entries(meta.columns || {}).map(([key, c]) => {
    const dot = key.indexOf(".");
    const table = key.slice(0, dot);
    return {
      table,
      column:      key.slice(dot + 1),
      data_type:   c.data_type || "",
      units:       c.units || "",
      name_long:   c.name_long || "",
      description: c.description_md || "",
      datasets:    dsFor(table),
    };
  });
  all.sort((a, b) => a.table.localeCompare(b.table) || a.column.localeCompare(b.column));

  const wrap = $("#columns-tablewrap");
  wrap.innerHTML = `
    <table class="data" id="columns-table">
      <thead>
        <tr>
          <th data-key="table"     aria-sort="ascending">table</th>
          <th data-key="column">column</th>
          <th data-key="data_type">type</th>
          <th data-key="units">units</th>
          <th data-key="description">description</th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>
  `;
  const tbody = wrap.querySelector("tbody");

  function paint(rows) {
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td class="mono">${escHtml(r.table)}</td>
        <td class="mono">${escHtml(r.column)}${r.name_long ? `<br><span class="muted" style="font-size:0.78rem">${escHtml(r.name_long)}</span>` : ""}</td>
        <td class="mono">${escHtml(r.data_type)}</td>
        <td class="units">${escHtml(r.units)}</td>
        <td>${mdToHtml(r.description)}</td>
      </tr>
    `).join("");
    $("#columns-count").textContent = `${rows.length} / ${all.length} columns`;
  }

  let current = all.slice();
  let filterQ = "";
  let sortKey = "table";
  let sortDir = 1;
  function apply() {
    let rows = all.filter(r => passesTags(r.datasets) && (
      !filterQ ||
      (r.table + " " + r.column + " " + r.units + " " + r.data_type +
       " " + r.name_long + " " + r.description).toLowerCase().includes(filterQ)));
    rows.sort((a, b) => {
      const av = (a[sortKey] || "").toString();
      const bv = (b[sortKey] || "").toString();
      return sortDir * av.localeCompare(bv);
    });
    current = rows;
    paint(rows);
  }
  State._apply.columns = apply;

  $("#columns-filter").oninput = (e) => { filterQ = e.target.value.toLowerCase().trim(); apply(); };
  wrap.querySelectorAll("thead th").forEach(th => {
    th.addEventListener("click", () => {
      const k = th.dataset.key;
      if (sortKey === k) { sortDir = -sortDir; }
      else               { sortKey = k; sortDir = 1; }
      wrap.querySelectorAll("thead th").forEach(x => x.removeAttribute("aria-sort"));
      th.setAttribute("aria-sort", sortDir === 1 ? "ascending" : "descending");
      apply();
    });
  });
  apply();
}

// ─── Datasets ───────────────────────────────────────────────────────────

function renderDatasets(blobs) {
  const meta = blobs.metadata;
  const list = $("#datasets-list");
  const datasets = Object.entries(meta.datasets || {});
  datasets.sort((a, b) => a[0].localeCompare(b[0]));

  // invert contributions → dataset → [{table, rows, pct, workflow}] and note
  // which tables are shared across >1 dataset (so we show % only when meaningful)
  const contribByDs = {};
  const tableShared = {};
  for (const [tbl, c] of Object.entries(meta.contributions || {})) {
    const by = c.by_dataset || [];
    tableShared[tbl] = by.length > 1;
    for (const bd of by) {
      (contribByDs[bd.provider_dataset] ||= []).push(
        { table: tbl, rows: bd.rows, pct: bd.pct, workflow: bd.workflow });
    }
  }

  const datasetTablesHtml = (key, d) => {
    const items  = contribByDs[key] || [];
    const byName = new Map(items.map(it => [it.table, it]));
    const names  = [...new Set([...byName.keys(), ...((d.tables) || [])])].sort();
    if (!names.length) return "";
    const li = names.map(tbl => {
      const it   = byName.get(tbl);
      const rows = it && it.rows != null ? ` — ${fmtInt(it.rows)} rows` : "";
      const pct  = (it && tableShared[tbl]) ? ` <span class="muted">(${it.pct}%)</span>` : "";
      const wf   = (it && it.workflow && it.workflow !== "NA")
        ? ` <a class="ds-wf" href="${escHtml(it.workflow)}" target="_blank" title="ingest workflow">↗</a>` : "";
      return `<li><span class="mono">${escHtml(tbl)}</span>${rows}${pct}${wf}</li>`;
    }).join("");
    return `<details class="ds-tables"><summary>${names.length} tables ▾</summary><ul>${li}</ul></details>`;
  };

  list.innerHTML = datasets.map(([key, d]) => {
    const links = [];
    if (d.link_calcofi_org) links.push(`<a href="${escHtml(d.link_calcofi_org)}" target="_blank">calcofi.org</a>`);
    if (d.link_data_source) links.push(`<a href="${escHtml(d.link_data_source)}" target="_blank">data source</a>`);
    if (d.workflow_url)     links.push(`<a href="${escHtml(d.workflow_url)}" target="_blank">workflow ↗</a>`);
    const col = State.datasetColor[key];
    const sw  = col ? `<span class="ds-swatch" style="background:${escHtml(col)}"></span>` : "";
    return `
      <article class="card" data-dskey="${escHtml(key)}" ${tagAttr([key])}>
        <h3>
          <span>${sw}${escHtml(d.provider || "")} / ${escHtml(d.dataset || "")}</span>
          ${d.dataset_name ? `<span class="name-long">${escHtml(d.dataset_name)}</span>` : ""}
        </h3>
        <div class="card-meta">
          <button type="button" class="chip filter-chip" data-dataset="${escHtml(key)}">filter ▸ ${escHtml(key)}</button>
          ${d.coverage_temporal ? `<span class="chip">${escHtml(d.coverage_temporal)}</span>` : ""}
          ${d.coverage_spatial  ? `<span class="chip">${escHtml(d.coverage_spatial)}</span>`  : ""}
          ${d.license           ? `<span class="chip">${escHtml(d.license)}</span>`           : ""}
        </div>
        <div class="desc">${mdToHtml(d.description || "")}</div>
        ${datasetTablesHtml(key, d)}
        ${d.citation_main ? `<div class="desc"><strong>Cite:</strong> ${mdToHtml(d.citation_main)}</div>` : ""}
        ${d.pi_names ? `<div class="desc muted"><strong>PI:</strong> ${escHtml(d.pi_names)}</div>` : ""}
        ${links.length ? `<div class="links">${links.join("")}</div>` : ""}
      </article>
    `;
  }).join("");

  // tag filter for dataset cards (a card shows if its own key is selected)
  State._apply.datasets = () => {
    $$("#datasets-list .card").forEach(card => {
      const ds = (card.dataset.datasets || "").split(" ").filter(Boolean);
      card.style.display = passesTags(ds) ? "" : "none";
    });
  };
  State._apply.datasets();
}

// ─── Measurement types ──────────────────────────────────────────────────

function renderMeasurements(blobs) {
  const meta = blobs.metadata;
  const all = Object.entries(meta.measurement_types || {}).map(([k, v]) => ({
    measurement_type: k,
    description:      v.description || "",
    units:            v.units || "",
    is_canonical:     !!v.is_canonical,
    datasets:         Array.isArray(v.datasets) ? v.datasets : [],
  }));
  all.sort((a, b) => a.measurement_type.localeCompare(b.measurement_type));

  const wrap = $("#meas-tablewrap");
  wrap.innerHTML = `
    <table class="data" id="meas-table">
      <thead>
        <tr>
          <th data-key="measurement_type" aria-sort="ascending">measurement_type</th>
          <th data-key="units">units</th>
          <th data-key="is_canonical">canonical</th>
          <th data-key="description">description</th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>
  `;
  const tbody = wrap.querySelector("tbody");
  let filterQ = "";
  let canonicalOnly = false;
  let sortKey = "measurement_type";
  let sortDir = 1;

  function apply() {
    let rows = all.filter(r => passesTags(r.datasets));
    if (canonicalOnly) rows = rows.filter(r => r.is_canonical);
    if (filterQ) rows = rows.filter(r =>
      (r.measurement_type + " " + r.units + " " + r.description).toLowerCase().includes(filterQ));
    rows.sort((a, b) => {
      const av = (a[sortKey] ?? "").toString();
      const bv = (b[sortKey] ?? "").toString();
      return sortDir * av.localeCompare(bv);
    });
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td class="mono">${escHtml(r.measurement_type)}</td>
        <td class="units">${escHtml(r.units)}</td>
        <td>${r.is_canonical ? `<span class="badge canonical">canonical</span>` : `<span class="badge">variant</span>`}</td>
        <td>${escHtml(r.description)}</td>
      </tr>
    `).join("");
    $("#meas-count").textContent = `${rows.length} / ${all.length} types`;
  }
  State._apply.measurements = apply;

  $("#meas-filter").oninput = (e)         => { filterQ = e.target.value.toLowerCase().trim(); apply(); };
  $("#meas-canonical-only").onchange = (e) => { canonicalOnly = e.target.checked; apply(); };
  wrap.querySelectorAll("thead th").forEach(th => {
    th.addEventListener("click", () => {
      const k = th.dataset.key;
      if (sortKey === k) { sortDir = -sortDir; }
      else               { sortKey = k; sortDir = 1; }
      wrap.querySelectorAll("thead th").forEach(x => x.removeAttribute("aria-sort"));
      th.setAttribute("aria-sort", sortDir === 1 ? "ascending" : "descending");
      apply();
    });
  });
  apply();
}

// ─── kick off ───────────────────────────────────────────────────────────

init();
