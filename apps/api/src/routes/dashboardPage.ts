export const dashboardPage = (requiresToken: boolean) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TRAWL · Metrics</title>
<style>
:root{font:13px "Geist Mono","JetBrains Mono","Fira Code",ui-monospace,SFMono-Regular,Menlo,monospace;color:#f0f0f2;background:#0d0d10;color-scheme:dark;--accent:#00e87a;--surface:#17171b;--border:#2a2a30;--muted:#9898a6}
*{box-sizing:border-box}body{max-width:1440px;margin:auto;padding:0 36px 72px;min-height:100vh;background:radial-gradient(ellipse 55% 22% at 48% 0%,#00e87a0a,transparent 75%)}
h1,h2,p{margin-top:0}h1{font-size:clamp(29px,3.3vw,46px);font-weight:700;letter-spacing:-.055em;line-height:1.08;margin:0 0 12px}h2{font-size:15px;font-weight:650;letter-spacing:-.03em;margin-bottom:5px}p,small{color:var(--muted)}.muted{color:var(--muted)}.accent{color:var(--accent)}
header{height:68px;display:flex;align-items:center;justify-content:space-between;gap:18px;border-bottom:1px solid var(--border)}.brand,.header-actions{display:flex;align-items:center;gap:18px}.wordmark{font-size:18px;font-weight:800;letter-spacing:-.09em}.brand-path{color:var(--muted);font-size:12px;border-left:1px solid var(--border);padding-left:18px}
.status{display:flex;align-items:center;gap:8px;color:#c5c5cd;font-size:11px;text-transform:uppercase;letter-spacing:.08em}.status-dot{width:7px;height:7px;background:#74747e}.status.live .status-dot{background:var(--accent);box-shadow:0 0 0 3px #00e87a20}.status.paused .status-dot{background:#edb568}
.intro{padding:38px 0 31px}.intro p{font-size:12px;margin:0}.eyebrow{display:flex;align-items:center;gap:12px;font-size:10px;font-weight:650;letter-spacing:.16em;color:var(--accent);margin-bottom:16px}.intro-dot{font-size:18px;line-height:1;letter-spacing:0}
button,input{font:inherit}button{cursor:pointer;border:1px solid #3a3a42;background:#1b1b20;color:#e5e5e8;border-radius:0;padding:9px 12px;transition:background .15s,border-color .15s}button:hover{background:#26262c;border-color:#5a5a64}button:focus-visible,input:focus-visible,a:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.primary{background:var(--accent);border-color:var(--accent);color:#07140e;font-weight:700}.primary:hover{background:#31f096}
#login{display:flex;gap:8px;max-width:510px;margin:0 0 24px}#login input{flex:1;min-width:0}input{border:1px solid #3a3a42;border-radius:0;background:#1b1b20;color:#f0f0f2;padding:9px 11px}input::placeholder{color:#777782}#error{color:#ffad91;min-height:18px;margin:0}
.toolbar{display:flex;justify-content:space-between;align-items:center;gap:12px;margin:0 0 15px;flex-wrap:wrap}.toolbar-group{display:flex;align-items:center;gap:5px;flex-wrap:wrap}.toolbar button{font-size:11px}.range[aria-pressed="true"]{background:#00e87a18;border-color:var(--accent);color:var(--accent)}.toolbar-label{font-size:10px;color:var(--muted);margin-right:8px;letter-spacing:.07em}
.kpis{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:0;margin-bottom:14px;border-top:1px solid var(--border);border-left:1px solid var(--border)}.kpi{padding:21px 23px 20px;border-right:1px solid var(--border);border-bottom:1px solid var(--border);background:#151519}.kpi strong{display:block;font-size:34px;font-weight:700;letter-spacing:-.06em;line-height:1.06;font-variant-numeric:tabular-nums}.kpi span{display:block;color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.06em;margin-top:11px}.kpi:nth-child(2) strong{color:var(--accent)}.kpi:nth-child(3) strong{color:#ffae78}
.layout{display:grid;grid-template-columns:minmax(0,1.65fr) minmax(300px,1fr);gap:14px}.panel{border:1px solid var(--border);background:var(--surface);padding:21px 23px;min-width:0}.panel p{font-size:11px;margin-bottom:13px}.wide{grid-column:1/-1}.panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;flex-wrap:wrap}.legend{display:flex;align-items:center;gap:14px;font-size:10px;color:#b7b7c0}.key{display:inline-block;width:8px;height:8px;margin-right:6px}.good{background:var(--accent)}.bad{background:#f4aa6a}
#trend{width:100%;height:auto;min-height:190px;display:block}.trend-bar:focus-visible{outline:none}.trend-bar:focus-visible rect:first-of-type{stroke:#ededed;stroke-width:2}.trend-tooltip{position:fixed;z-index:20;pointer-events:none;max-width:260px;padding:12px 14px;border:1px solid #5a5a62;background:#111114;box-shadow:0 12px 32px #000a;color:#f0f0f2;font-size:11px;line-height:1.6}.trend-tooltip strong{display:block;margin-bottom:5px;font-size:12px}.trend-tooltip .detail{display:flex;justify-content:space-between;gap:18px}.trend-tooltip .detail span:first-child{color:var(--muted)}
.meter-list{display:grid;gap:13px;margin-top:17px}.meter-row{display:grid;grid-template-columns:76px minmax(0,1fr) 78px;align-items:center;gap:11px;font-size:11px}.meter-row .name{color:#d0d0d6}.meter-row .value{text-align:right;color:#aaaab5;font-variant-numeric:tabular-nums}.track{height:8px;background:#2b2b31;overflow:hidden}.activity{height:100%;background:#53535d;overflow:hidden}.win-fill,.category-fill,.source-fill{height:100%;background:var(--accent)}.category-fill{background:#eea568}.source-fill{background:#7ab59c}
.table-scroll{overflow:auto;max-height:410px}table{width:100%;border-collapse:collapse;font-size:11px;text-align:left}th{position:sticky;top:0;background:var(--surface);color:#a7a7b2;font-weight:600;white-space:nowrap;text-transform:uppercase;font-size:10px;letter-spacing:.04em}th,td{padding:11px 9px;border-bottom:1px solid var(--border)}td{color:#d3d3d8}td:first-child,th:first-child{padding-left:0}td:last-child,th:last-child{padding-right:0}td.number{font-variant-numeric:tabular-nums;text-align:right}th.number{text-align:right}.failure-search{width:min(310px,100%);font-size:11px}.footnote{font-size:10px;color:#82828e;margin:18px 1px}
[hidden]{display:none!important}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
@media(max-width:900px){body{padding:0 18px 55px}.layout{grid-template-columns:1fr}.wide{grid-column:1}.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:600px){header{height:62px}.brand,.header-actions{gap:10px}.brand-path{padding-left:10px}.intro{padding:28px 0 24px}.toolbar{align-items:flex-start}.toolbar-group{width:100%}.kpi{padding:16px}.kpi strong{font-size:26px}.panel{padding:16px}.meter-row{grid-template-columns:70px minmax(0,1fr) 64px;gap:7px}}
</style>
</head>
<body data-auth-required="${requiresToken}">
<header><div class="brand"><span class="wordmark">trawl<span class="accent">.</span></span><span class="brand-path">/ metrics</span></div><div class="header-actions"><div id="status" class="status"><span class="status-dot"></span><span id="status-text">Locked</span></div></div></header>
<div class="intro"><div class="eyebrow">LOCAL OBSERVABILITY <span class="intro-dot" aria-hidden="true">·</span> SCRAPE ACTIVITY</div><h1>every request<span class="accent">.</span> in view<span class="accent">.</span></h1><p>Persistent history, tier outcomes and failure signals from this TRAWL instance.</p></div>
<form id="login"${requiresToken ? "" : " hidden"}><input id="token" type="password" autocomplete="off" placeholder="Dashboard token" aria-label="Dashboard token" required><button class="primary">Open dashboard</button></form>
<p id="error" role="alert"></p>
<main id="content" hidden>
<div class="toolbar"><div class="toolbar-group"><span class="toolbar-label">TIME RANGE</span><button class="range" data-minutes="15" aria-pressed="false">15 min</button><button class="range" data-minutes="60" aria-pressed="true">60 min</button><button class="range" data-minutes="1440" aria-pressed="false">24 h</button><button class="range" data-minutes="10080" aria-pressed="false">7 d</button><button class="range" data-minutes="43200" aria-pressed="false">30 d</button></div><div class="toolbar-group"><span id="updated" class="toolbar-label">Waiting for data</span><button id="refresh" type="button">Refresh</button><button id="pause" type="button" aria-pressed="false">Pause live</button><button id="export" type="button">Export JSON</button></div></div>
<div class="kpis"><div class="kpi"><strong id="requests">0</strong><span>TRAWL scrape requests</span></div><div class="kpi"><strong id="success-rate">0%</strong><span>Success rate</span></div><div class="kpi"><strong id="failures">0</strong><span>Failures</span></div><div class="kpi"><strong id="average">0 ms</strong><span>Average duration</span></div></div>
<div class="layout">
<section class="panel wide"><div class="panel-head"><div><h2>Request activity</h2><p>Completed requests in the selected period · hover or focus a bar for details</p></div><div class="legend"><span><i class="key good"></i>Success</span><span><i class="key bad"></i>Failure</span></div></div><svg id="trend" role="img" aria-label="Successful and failed requests over time" viewBox="0 0 720 220"></svg><div id="trend-tooltip" class="trend-tooltip" role="tooltip" hidden></div><p id="trend-summary" class="sr-only"></p></section>
<section class="panel"><h2>Tier outcomes</h2><p>Attempts and successful final responses</p><div id="tiers" class="meter-list"></div></section>
<section class="panel"><h2>Failure causes</h2><p>Best-effort classification in the selected period</p><div id="categories" class="meter-list"></div></section>
<section class="panel"><h2>Domains with failures</h2><p>Highest failure counts in the selected period</p><div class="table-scroll"><table><thead><tr><th>Domain</th><th class="number">Requests</th><th class="number">Failed</th><th class="number">Rate</th></tr></thead><tbody id="domains"></tbody></table></div></section>
<section class="panel"><h2>Request sources</h2><p>Completed operations by entry point</p><div id="sources" class="meter-list"></div></section>
<section class="panel wide"><h2>WAF providers</h2><p id="waf-summary">Provider signatures in observed responses, independent of active challenges</p><div class="table-scroll"><table><thead><tr><th>Provider</th><th class="number">Requests</th><th class="number">Failed</th><th class="number">Rate</th></tr></thead><tbody id="waf-providers"></tbody></table></div></section>
<section class="panel wide"><div class="panel-head"><div><h2>Recent failures</h2><p>Last 50 failures in the selected period, newest first</p></div><input id="failure-search" class="failure-search" type="search" placeholder="Filter domain, cause, provider or source" aria-label="Filter recent failures"></div><div class="table-scroll"><table><thead><tr><th>Time</th><th>Domain</th><th>Source</th><th>Tier</th><th>Status</th><th>HTTP</th><th>Cause</th><th>WAF</th><th>Severity</th></tr></thead><tbody id="recent"></tbody></table></div></section>
<section class="panel wide"><div class="panel-head"><div><h2>Recent activity</h2><p>Last 100 completed requests in the selected period</p></div></div><div class="table-scroll"><table><thead><tr><th>Time</th><th>Domain</th><th>Source</th><th>Tier</th><th>HTTP</th><th>Duration</th><th>WAF</th><th>Outcome</th></tr></thead><tbody id="events"></tbody></table></div></section>
</div><p class="footnote" id="history-note">Hostnames only · local history · no remote telemetry</p><p class="footnote">Only scrape calls that reach TRAWL appear here. Requests sent directly to a target by another application are outside this history.</p>
</main>
<script>
let token = '';
const authRequired = document.body.dataset.authRequired === 'true';
let timer;
let streamAbort;
let reconnectTimer;
let paused = false;
let loading = false;
let minutes = window.matchMedia('(max-width: 600px)').matches ? 15 : 60;
let currentData;
const byId = id => document.getElementById(id);
const svgNS = 'http://www.w3.org/2000/svg';
const number = value => new Intl.NumberFormat().format(value);

function element(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = String(value);
  return node;
}

function drawRows(id, items, emptyMessage) {
  const body = byId(id);
  body.replaceChildren();
  if (!items.length) {
    const row = element('tr');
    const cell = element('td', 'muted', emptyMessage);
    cell.colSpan = body.closest('table').querySelectorAll('thead th').length;
    row.append(cell);
    body.append(row);
    return;
  }
  for (const item of items) {
    const row = element('tr');
    for (let i = 0; i < item.length; i++) {
      const cell = element('td', i > 0 && (id === 'domains' || id === 'waf-providers') ? 'number' : '', item[i]);
      row.append(cell);
    }
    body.append(row);
  }
}

function svgNode(tag, attrs) {
  const node = document.createElementNS(svgNS, tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, String(value));
  return node;
}

function shortTime(date, range) {
  if (range <= 60) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (range <= 10080) return date.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit' });
  return date.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

function detailLine(root, name, value) {
  const row = element('div', 'detail');
  row.append(element('span', '', name), element('span', '', value));
  root.append(row);
}

function showTrendTooltip(point, data, clientX, clientY) {
  const tooltip = byId('trend-tooltip');
  tooltip.replaceChildren();
  const start = new Date(point.minute);
  const end = new Date(start.getTime() + data.bucketMs);
  tooltip.append(element('strong', '', start.toLocaleString() + ' - ' + end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
  detailLine(tooltip, 'Requests', number(point.requests));
  detailLine(tooltip, 'Successful', number(point.requests - point.failures));
  detailLine(tooltip, 'Failed', number(point.failures));
  if (point.requests) {
    detailLine(tooltip, 'Success rate', Math.round((point.requests - point.failures) / point.requests * 100) + '%');
    detailLine(tooltip, 'Average duration', number(point.averageMs) + ' ms');
    const sources = Object.entries(point.sources).map(([name, count]) => name + ' ' + count).join(', ');
    const tiers = Object.entries(point.tiers).map(([tier, count]) => 'T' + tier + ' ' + count).join(', ');
    if (sources) detailLine(tooltip, 'Sources', sources);
    if (tiers) detailLine(tooltip, 'Final tiers', tiers);
  }
  tooltip.hidden = false;
  const rect = tooltip.getBoundingClientRect();
  tooltip.style.left = Math.max(8, Math.min(clientX + 14, window.innerWidth - rect.width - 8)) + 'px';
  tooltip.style.top = Math.max(8, Math.min(clientY - rect.height - 12, window.innerHeight - rect.height - 8)) + 'px';
}

function drawTrend(data) {
  const points = data.timeline;
  const svg = byId('trend');
  byId('trend-tooltip').hidden = true;
  svg.replaceChildren();
  const max = Math.max(1, ...points.map(point => point.requests));
  const compact = window.matchMedia('(max-width: 600px)').matches;
  const width = compact ? 360 : 720;
  svg.setAttribute('viewBox', '0 0 ' + width + ' 220');
  const plotLeft = compact ? 32 : 44;
  const plotBottom = 182;
  const plotHeight = 150;
  const plotWidth = width - plotLeft - 26;
  const step = plotWidth / points.length;
  const barWidth = Math.max(2, step - (points.length >= 50 ? 3 : 7));
  const labels = compact ? 3 : 5;
  const tickIndices = new Set(Array.from({ length: labels }, (_, index) => Math.round(index * (points.length - 1) / (labels - 1))));
  const lines = Math.min(3, max);
  for (let i = 0; i <= lines; i++) {
    const y = plotBottom - i * plotHeight / lines;
    svg.append(svgNode('line', { x1: plotLeft, y1: y, x2: width - 9, y2: y, stroke: '#34343b', 'stroke-width': 1 }));
    const label = svgNode('text', { x: plotLeft - 8, y: y + 4, fill: '#a7a7b2', 'font-size': 11, 'text-anchor': 'end' });
    label.textContent = String(Math.round(max * i / lines));
    svg.append(label);
  }
  points.forEach((point, index) => {
    const x = plotLeft + index * step + (step - barWidth) / 2;
    const success = point.requests - point.failures;
    const successHeight = success / max * plotHeight;
    const failureHeight = point.failures / max * plotHeight;
    const group = svgNode('g', { class: 'trend-bar', 'aria-label': new Date(point.minute).toLocaleString() + ', ' + point.requests + ' requests, ' + point.failures + ' failed' });
    if (point.requests) group.setAttribute('tabindex', '0');
    group.append(svgNode('rect', { x: plotLeft + index * step, y: plotBottom - plotHeight, width: step, height: plotHeight, fill: 'transparent' }));
    if (successHeight) group.append(svgNode('rect', { x, y: plotBottom - successHeight, width: barWidth, height: successHeight, rx: 2, fill: '#00e87a' }));
    if (failureHeight) group.append(svgNode('rect', { x, y: plotBottom - successHeight - failureHeight, width: barWidth, height: failureHeight, rx: 2, fill: '#f4aa6a' }));
    group.addEventListener('pointermove', event => showTrendTooltip(point, data, event.clientX, event.clientY));
    group.addEventListener('pointerleave', () => { byId('trend-tooltip').hidden = true; });
    group.addEventListener('focus', () => {
      const rect = group.getBoundingClientRect();
      showTrendTooltip(point, data, rect.x + rect.width / 2, rect.y);
    });
    group.addEventListener('blur', () => { byId('trend-tooltip').hidden = true; });
    svg.append(group);
    if (tickIndices.has(index)) {
      const tick = svgNode('text', { x: x + barWidth / 2, y: 209, fill: '#a7a7b2', 'font-size': 11, 'text-anchor': index === 0 ? 'start' : index === points.length - 1 ? 'end' : 'middle' });
      tick.textContent = shortTime(new Date(point.minute), minutes);
      svg.append(tick);
    }
  });
  const total = points.reduce((sum, point) => sum + point.requests, 0);
  const failed = points.reduce((sum, point) => sum + point.failures, 0);
  byId('trend-summary').textContent = total + ' requests in the selected period; ' + failed + ' failed.';
}

function meter(name, value, max, annotation, kind) {
  const row = element('div', 'meter-row');
  row.append(element('span', 'name', name));
  const track = element('div', 'track');
  const activity = element('div', 'activity');
  activity.style.width = (max ? value / max * 100 : 0) + '%';
  if (kind === 'category') activity.className = 'category-fill';
  if (kind === 'source') activity.className = 'source-fill';
  track.append(activity);
  row.append(track, element('span', 'value', annotation));
  return row;
}

function drawMeters(data) {
  const tierRoot = byId('tiers');
  tierRoot.replaceChildren();
  const tiers = Object.entries(data.byTier);
  const maxAttempts = Math.max(1, ...tiers.map(([, value]) => value.attempts));
  for (const [tier, value] of tiers) {
    const row = meter('Tier ' + tier, value.attempts, maxAttempts, value.successes + ' / ' + value.attempts);
    const activity = row.querySelector('.activity');
    const wins = element('div', 'win-fill');
    wins.style.width = (value.attempts ? value.successes / value.attempts * 100 : 0) + '%';
    activity.append(wins);
    tierRoot.append(row);
  }
  const causeRoot = byId('categories');
  causeRoot.replaceChildren();
  const causes = Object.entries(data.byFailure);
  const maxCause = Math.max(1, ...causes.map(([, count]) => count));
  for (const [cause, count] of causes) causeRoot.append(meter(cause, count, maxCause, number(count), 'category'));
  const sourceRoot = byId('sources');
  sourceRoot.replaceChildren();
  const sources = Object.entries(data.bySource);
  const maxSource = Math.max(1, ...sources.map(([, count]) => count));
  const sourceNames = { native: 'Native API', flaresolverr: '/v1', mcp: 'MCP', proxy: 'Proxy' };
  for (const [source, count] of sources) sourceRoot.append(meter(sourceNames[source] ?? source, count, maxSource, number(count), 'source'));
}

function wafLabel(waf) {
  if (!waf) return '-';
  return waf.products.length ? waf.products.join(', ') : waf.state === 'unavailable' ? 'Unavailable: ' + (waf.reason ?? 'unknown') : 'No match';
}

function drawFailures() {
  if (!currentData) return;
  const query = byId('failure-search').value.trim().toLowerCase();
  const entries = currentData.recentFailures.filter(item =>
    !query || [item.domain, item.source, item.category, item.severity, wafLabel(item.waf)].some(value => String(value ?? '').toLowerCase().includes(query))
  );
  drawRows('recent', entries.map(item => [
    new Date(item.at).toLocaleString(), item.domain, item.source,
    item.tier ?? '-', item.tierStatus ?? '-', item.statusCode ?? '-', item.category, wafLabel(item.waf), item.severity
  ]), query ? 'No matching failures' : 'No failures recorded');
}

function render(data) {
  currentData = data;
  byId('requests').textContent = number(data.requests);
  byId('success-rate').textContent = (data.requests ? Math.round(data.successes / data.requests * 100) : 0) + '%';
  byId('failures').textContent = number(data.failures);
  byId('average').textContent = number(data.averageMs) + ' ms';
  drawTrend(data);
  drawMeters(data);
  drawRows('domains', data.domains.filter(item => item.failures).map(item => [
    item.domain, number(item.requests), number(item.failures), Math.round(item.failures / item.requests * 100) + '%'
  ]), 'No failing domains');
  drawFailures();
  const waf = data.waf;
  drawRows('waf-providers', (waf?.providers ?? []).map(item => [
    item.product, number(item.requests), number(item.failures), Math.round(item.failures / item.requests * 100) + '%'
  ]), 'No provider signatures recorded');
  byId('waf-summary').textContent = waf ? number(waf.observations) + ' observations · ' + number(waf.states.incomplete) + ' incomplete · ' + number(waf.states.unavailable) + ' unavailable · ' + waf.averageMs + ' ms mean detection time. Provider signatures do not prove an active block.' : 'No WAF observations in this period';
  drawRows('events', data.recentEvents.map(item => [
    new Date(item.at).toLocaleString(), item.domain, item.source, item.tier ?? '-',
    item.statusCode ?? '-', number(item.durationMs) + ' ms', wafLabel(item.waf), item.success ? 'Success' : (item.category ?? 'Failure')
  ]), 'No requests recorded in this period');
  byId('history-note').textContent = 'Hostnames only · local history' + (data.startedAt ? ' since ' + new Date(data.startedAt).toLocaleString() : ' starts with the first request') + ' · ' + number(data.retainedEvents) + ' retained events · no remote telemetry';
  byId('updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
}

function setStatus(state, label) {
  byId('status').className = 'status ' + state;
  byId('status-text').textContent = label;
}

async function refresh() {
  if (loading || (authRequired && !token)) return;
  loading = true;
  try {
    const response = await fetch('/dashboard/metrics?minutes=' + minutes, {
      headers: token ? { Authorization: 'Bearer ' + token } : {}, cache: 'no-store'
    });
    if (!response.ok) throw Error(response.status === 401 ? 'Invalid token' : 'Metrics unavailable');
    render(await response.json());
    byId('error').textContent = '';
    byId('content').hidden = false;
    byId('login').hidden = true;
    setStatus(paused ? 'paused' : 'live', paused ? 'Paused' : 'Live');
  } catch (error) {
    byId('error').textContent = error.message;
    setStatus('', 'Connection issue');
    if (error.message === 'Invalid token') {
      token = '';
      streamAbort?.abort();
      byId('content').hidden = true;
      byId('login').hidden = false;
    }
  } finally {
    loading = false;
  }
}

async function connectEvents() {
  streamAbort?.abort();
  clearTimeout(reconnectTimer);
  if (authRequired && !token) return;
  const controller = new AbortController();
  streamAbort = controller;
  try {
    const response = await fetch('/dashboard/events', {
      headers: token ? { Authorization: 'Bearer ' + token } : {}, cache: 'no-store', signal: controller.signal
    });
    if (!response.ok || !response.body) throw Error('Live connection unavailable');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\\n\\n');
      buffer = frames.pop() || '';
      if (frames.some(frame => frame.startsWith('event: update')) && !paused) refresh();
    }
  } catch (error) {
    if (error.name !== 'AbortError') setStatus('', 'Reconnecting');
  }
  if (!controller.signal.aborted && (!authRequired || token)) reconnectTimer = setTimeout(connectEvents, 2000);
}

function startUpdates() {
  refresh();
  connectEvents();
  if (!timer) timer = setInterval(() => { if (!paused) refresh(); }, 30000);
}

byId('login').addEventListener('submit', event => {
  event.preventDefault();
  token = byId('token').value;
  byId('token').value = '';
  startUpdates();
});
if (!authRequired) startUpdates();
for (const button of document.querySelectorAll('.range')) button.addEventListener('click', () => {
  minutes = Number(button.dataset.minutes);
  for (const option of document.querySelectorAll('.range')) option.setAttribute('aria-pressed', String(option === button));
  refresh();
});
byId('refresh').addEventListener('click', refresh);
byId('pause').addEventListener('click', event => {
  paused = !paused;
  event.currentTarget.textContent = paused ? 'Resume live' : 'Pause live';
  event.currentTarget.setAttribute('aria-pressed', String(paused));
  setStatus(paused ? 'paused' : 'live', paused ? 'Paused' : 'Live');
  if (!paused) refresh();
});
byId('failure-search').addEventListener('input', drawFailures);
window.addEventListener('resize', () => { if (currentData) drawTrend(currentData); });
for (const option of document.querySelectorAll('.range')) option.setAttribute('aria-pressed', String(Number(option.dataset.minutes) === minutes));
byId('export').addEventListener('click', () => {
  if (!currentData) return;
  const file = new Blob([JSON.stringify(currentData, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(file);
  link.download = 'trawl-metrics.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});
</script>
</body>
</html>`
