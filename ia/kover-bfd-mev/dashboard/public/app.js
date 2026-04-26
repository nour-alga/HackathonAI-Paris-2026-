/* eslint-env browser */
'use strict';

/**
 * KOVER.IA dashboard — front-end runtime.
 *
 * Connects to /events (SSE), fans incoming events into:
 *   - per-row append in the live feed
 *   - KPI counter updates
 *   - "last incident" sidebar card
 *   - full-screen attack overlay on `attack` events
 *
 * Filters are stored in localStorage so the operator's preference persists
 * across reloads.
 */

(() => {
  const $       = (id) => document.getElementById(id);
  const feed    = $('feed');
  const kpi     = {
    tx:     $('kpi-tx'),
    cand:   $('kpi-cand'),
    sim:    $('kpi-sim'),
    tp:     $('kpi-tp'),
    halt:   $('kpi-halt'),
    tps:    $('kpi-tps'),
    uptime: $('kpi-uptime'),
  };
  const connDot   = $('conn-dot');
  const connLabel = $('conn-label');
  const incidentCard   = $('incident-card');
  const incidentDetail = $('incident-detail');
  const analysisCard   = $('analysis-card');

  const FILTERS = ['pending', 'candidate', 'simulation', 'attack', 'riposte', 'analysis'];
  const FILTER_KEY = 'kover.filters';
  const stored = loadFilters();
  for (const f of FILTERS) {
    const cb = $(`filter-${f}`);
    cb.checked = stored[f] !== false;
    cb.addEventListener('change', () => {
      stored[f] = cb.checked;
      saveFilters(stored);
    });
  }

  $('clear-feed').addEventListener('click', () => { feed.innerHTML = ''; });

  // -------------------------------------------------------------------------
  // SSE connection
  // -------------------------------------------------------------------------

  let es;
  function connect() {
    setStatus(false, 'connecting');
    es = new EventSource('/events');
    es.addEventListener('open',     () => setStatus(true, 'live — SSE connected'));
    es.addEventListener('error',    () => setStatus(false, 'reconnecting…'));
    es.addEventListener('hello',    (e) => log('system',     'connected to sentinel pid=' + safeJson(e).pid));
    es.addEventListener('pending',  (e) => onEvent('pending',     safeJson(e)));
    es.addEventListener('candidate',(e) => onEvent('candidate',   safeJson(e)));
    es.addEventListener('simulation',(e)=> onEvent('simulation',  safeJson(e)));
    es.addEventListener('attack',   (e) => onAttack(safeJson(e)));
    es.addEventListener('riposte',  (e) => onEvent('riposte',     safeJson(e)));
    es.addEventListener('halt',     (e) => onEvent('halt',        safeJson(e)));
    es.addEventListener('analysis', (e) => onAnalysis(safeJson(e)));
    es.addEventListener('burst',    (e) => onBurst(safeJson(e)));
    es.addEventListener('multichain', (e) => onMultichain(safeJson(e)));
    es.addEventListener('error',    (e) => onEvent('error',       safeJson(e)));
    es.addEventListener('stats',    (e) => onStats(safeJson(e)));
  }

  function safeJson(ev) {
    try { return JSON.parse(ev.data); } catch { return {}; }
  }

  function setStatus(ok, label) {
    connDot.className = 'dot ' + (ok ? 'dot-on' : 'dot-off');
    connLabel.textContent = label;
  }

  // -------------------------------------------------------------------------
  // Event handlers
  // -------------------------------------------------------------------------

  /** Feed pruning — keeps the DOM bounded under heavy mainnet load. */
  const FEED_MAX_ROWS = 600;

  function onEvent(type, p) {
    if (stored[type] === false) return;
    appendRow(type, formatBody(type, p), p.ts);
  }

  function onAttack(p) {
    appendRow('attack', formatBody('attack', p), p.ts);
    showIncident(p);
  }

  function onAnalysis(p) {
    if (stored.analysis !== false) {
      appendRow('analysis', formatBody('analysis', p), p.ts);
    }
    renderAnalysisCard(p);
  }

  /**
   * Renders the AI Threat Analyst card (sidebar) with the LLM verdict.
   */
  function renderAnalysisCard(p) {
    analysisCard.hidden = false;

    const verdictEl    = $('analysis-verdict');
    const severityEl   = $('analysis-severity');
    const classEl      = $('analysis-class');
    const confidenceEl = $('analysis-confidence');
    const summaryEl    = $('analysis-summary');
    const explainEl    = $('analysis-explanation');
    const fixEl        = $('analysis-fix');
    const metaEl       = $('analysis-meta');

    verdictEl.textContent = p.verdict || '?';
    verdictEl.className = 'analysis-badge verdict-' + (p.verdict || 'unknown').toLowerCase();
    severityEl.textContent = p.severity || '?';
    severityEl.className = 'analysis-badge severity-' + (p.severity || 'info').toLowerCase();
    classEl.textContent = p.exploitClass || '?';
    confidenceEl.textContent = (typeof p.confidence === 'number')
      ? `${(p.confidence * 100).toFixed(0)} %` : '—';

    summaryEl.textContent     = p.summary || '';
    explainEl.textContent     = p.explanation || '';
    fixEl.textContent         = p.recommendedFix || '— (no fix needed)';
    metaEl.textContent =
      `${p.model || 'heuristic'}` +
      (p.latencyMs ? ` · ${(p.latencyMs / 1000).toFixed(1)}s` : '') +
      (p.mock ? ' · mock' : '');
  }

  function onStats(p) {
    // When the burst analyser is active, "tx analyzed" reflects the REAL
    // total transactions processed by the deep-flow engine, not the
    // sampled-to-SSE count (which would be tiny by design).
    const totalAnalyzed = (typeof p.burstTotalProcessed === 'number' && p.burstTotalProcessed > 0)
      ? p.burstTotalProcessed
      : p.tx;
    kpi.tx.textContent     = fmt(totalAnalyzed);
    kpi.cand.textContent   = fmt(p.candidates);
    kpi.sim.textContent    = fmt(p.simulations);
    kpi.tp.textContent     = fmt(p.truePositives);
    kpi.halt.textContent   = fmt(p.halts);
    kpi.tps.textContent    = (typeof p.burstMeasuredEps === 'number' && p.burstMeasuredEps > 0)
      ? fmtEps(p.burstMeasuredEps) + ' eps'
      : fmt(p.tps) + ' tx/s';
    kpi.uptime.textContent = fmtDuration(p.uptimeMs);
  }

  /**
   * Burst-mode stats — surfaces the high-throughput pre-filter benchmark.
   * Renders eps in a human-friendly form (1.5M, 850K, …).
   */
  function onBurst(p) {
    const value      = document.getElementById('kpi-burst');
    const vsSolana   = document.getElementById('kpi-vs-solana');
    if (!value) return;
    if (!p?.enabled) {
      value.textContent    = 'off';
      if (vsSolana) vsSolana.textContent = 'off';
      return;
    }
    value.textContent = fmtEps(p.measuredEps || 0);
    if (vsSolana && typeof p.vsSolanaMainnet === 'number') {
      vsSolana.textContent = fmt(p.vsSolanaMainnet) + ' ×';
    }
  }

  /**
   * Multi-chain stats — surfaces how many chains are connected and their
   * aggregate pending counts.
   */
  function onMultichain(p) {
    const value = document.getElementById('kpi-chains');
    if (!value) return;
    const active = p?.activeChains ?? 0;
    const total  = p?.chainCount ?? 0;
    value.textContent = total > 0 ? `${active} / ${total}` : '—';
  }

  function fmtEps(n) {
    if (!n || n < 0) return '0';
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + ' M';
    if (n >= 1_000)     return (n / 1_000).toFixed(1) + ' K';
    return String(n);
  }

  function appendRow(type, html, ts) {
    const row = document.createElement('div');
    row.className = `row ${type}`;
    row.innerHTML =
      `<span class="ts">${time(ts)}</span>` +
      `<span class="type">${type}</span>` +
      `<span class="body">${html}</span>`;
    feed.appendChild(row);
    while (feed.childElementCount > FEED_MAX_ROWS) feed.removeChild(feed.firstChild);
    feed.scrollTop = feed.scrollHeight;
  }

  function log(kind, msg) {
    appendRow(kind, esc(msg), Date.now());
  }

  function showIncident(p) {
    incidentCard.hidden = false;
    incidentDetail.innerHTML = '';
    const rows = [
      ['attacker',   short(p.from)],
      ['hash',       short(p.hash)],
      ['drained',    `${(p.drainedEth || 0).toFixed(2)} ETH`],
      ['ratio',      `${(p.ratio || 0).toFixed(2)} %`],
      ['threshold',  `${p.threshold || '?'} ETH`],
      ['detected',   time(p.ts)],
    ];
    for (const [k, v] of rows) {
      const dt = document.createElement('dt'); dt.textContent = k;
      const dd = document.createElement('dd'); dd.textContent = v;
      incidentDetail.appendChild(dt);
      incidentDetail.appendChild(dd);
    }
  }

  // -------------------------------------------------------------------------
  // Body formatters per event type
  // -------------------------------------------------------------------------

  function formatBody(type, p) {
    const safe = (v) => esc(String(v ?? ''));
    switch (type) {
      case 'pending':
        return `${safe(short(p.hash))}`;
      case 'candidate': {
        const reasons = (p.reasons || []).map((r) => `<em>${safe(r)}</em>`).join(' · ');
        return `${safe(short(p.hash))}  ${safe(short(p.from))} → ${safe(short(p.to))}  ${reasons || ''}`;
      }
      case 'simulation':
        return `${safe(short(p.hash))}  drained=<em>${safe((p.drainedEth || 0).toFixed(4))} ETH</em>  ` +
               `latency=<em>${safe(p.latencyMs?.toFixed?.(1) || '?')} ms</em>`;
      case 'attack':
        return `<strong>${safe(short(p.hash))}</strong>  drain=<strong>${safe((p.drainedEth || 0).toFixed(2))} ETH</strong>  ` +
               `ratio=<strong>${safe((p.ratio || 0).toFixed(2))}%</strong>  from ${safe(short(p.from))}`;
      case 'riposte':
        return `riposte=${safe(short(p.riposteHash))}  hacker=${safe(short(p.hackerHash))}  ` +
               `prio=<em>${safe(p.maxPriority || '?')} gwei</em>  maxFee=<em>${safe(p.maxFee || '?')} gwei</em>`;
      case 'halt':
        return `included @ block ${safe(p.blockNumber)} pos ${safe(p.position)} — ${safe(short(p.riposteHash))}`;
      case 'analysis':
        return `<strong>${safe(p.verdict)}</strong>  ` +
               `severity=<strong>${safe(p.severity)}</strong>  ` +
               `class=<em>${safe(p.exploitClass)}</em>  ` +
               `conf=${safe(((p.confidence || 0) * 100).toFixed(0))}%  ` +
               `<em>"${safe((p.summary || '').slice(0, 80))}…"</em>`;
      case 'error':
        return `<em>${safe(p.stage)}</em>: ${safe(p.msg)}`;
      default:
        return safe(JSON.stringify(p));
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function short(a) {
    if (!a) return '';
    return a.length > 13 ? `${a.slice(0, 8)}…${a.slice(-4)}` : a;
  }
  function time(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  }
  function fmt(n) {
    return Number(n || 0).toLocaleString('en-US');
  }
  function fmtDuration(ms) {
    const s = Math.floor((ms || 0) / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60), rs = s % 60;
    if (m < 60) return `${m}m${String(rs).padStart(2, '0')}s`;
    const h = Math.floor(m / 60), rm = m % 60;
    return `${h}h${String(rm).padStart(2, '0')}m`;
  }
  function loadFilters() {
    try { return JSON.parse(localStorage.getItem(FILTER_KEY) || '{}'); }
    catch { return {}; }
  }
  function saveFilters(f) {
    try { localStorage.setItem(FILTER_KEY, JSON.stringify(f)); } catch {}
  }

  connect();
})();
