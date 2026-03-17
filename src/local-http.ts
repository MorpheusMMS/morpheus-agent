import * as http from 'http';
import { stateManager } from './state';
import { logger } from './logger';
import { ScannerStatus } from './discovery';
import { MetricsStatus } from './metrics';

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Morpheus Agent</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, system-ui, 'Segoe UI', sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; }
  .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
  h1 { font-size: 1.5rem; color: #f1f5f9; margin-bottom: 4px; }
  .subtitle { color: #64748b; font-size: 0.875rem; margin-bottom: 24px; }
  .grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); margin-bottom: 24px; }
  .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 16px; }
  .card-label { color: #94a3b8; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; }
  .card-value { font-size: 1.5rem; font-weight: 700; color: #f1f5f9; margin-top: 4px; }
  .card-value.green { color: #34d399; }
  .card-value.blue { color: #60a5fa; }
  .card-value.purple { color: #a78bfa; }
  .card-value.amber { color: #fbbf24; }
  h2 { font-size: 1.125rem; color: #f1f5f9; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 0.8125rem; }
  th { text-align: left; padding: 10px 12px; color: #94a3b8; font-weight: 500; border-bottom: 1px solid #334155; background: #1e293b; }
  td { padding: 10px 12px; border-bottom: 1px solid #1e293b; }
  tr:hover td { background: #1e293b; }
  .status { display: inline-flex; align-items: center; gap: 6px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; }
  .dot.online { background: #34d399; }
  .dot.offline { background: #ef4444; }
  .dot.unknown { background: #64748b; }
  .mono { font-family: 'SF Mono', Monaco, monospace; font-size: 0.8125rem; }
  .scanner-grid { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); margin-bottom: 24px; }
  .scanner-card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 16px; }
  .scanner-name { font-weight: 600; font-size: 0.875rem; color: #f1f5f9; }
  .scanner-status { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 0.6875rem; font-weight: 500; }
  .scanner-status.idle { background: #334155; color: #94a3b8; }
  .scanner-status.scanning { background: rgba(59,130,246,0.15); color: #60a5fa; }
  .scanner-status.completed { background: rgba(52,211,153,0.15); color: #34d399; }
  .scanner-status.error { background: rgba(239,68,68,0.15); color: #ef4444; }
  .scanner-meta { color: #64748b; font-size: 0.75rem; margin-top: 8px; }
  .scanner-meta span { display: inline-block; margin-right: 16px; }
  .progress-bar { height: 4px; background: #334155; border-radius: 2px; margin-top: 8px; overflow: hidden; }
  .progress-fill { height: 100%; background: #3b82f6; border-radius: 2px; transition: width 0.5s; }
  .refresh-note { color: #475569; font-size: 0.75rem; text-align: center; margin-top: 24px; }
  .cloud-badge { display: inline-block; padding: 2px 8px; border-radius: 6px; font-size: 0.6875rem; font-weight: 500; margin-left: 8px; }
  .cloud-badge.connected { background: rgba(52,211,153,0.15); color: #34d399; }
  .cloud-badge.disconnected { background: rgba(239,68,68,0.15); color: #ef4444; }
</style>
</head>
<body>
<div class="container">
  <h1>Morpheus Agent <span class="cloud-badge" id="cloud-badge">...</span></h1>
  <div class="subtitle" id="designation">Loading...</div>
  <div class="grid" id="stats"></div>
  <h2>Scanners</h2>
  <div class="scanner-grid" id="scanners"></div>
  <h2>Devices</h2>
  <div class="card" style="overflow-x:auto">
    <table>
      <thead>
        <tr><th>Status</th><th>IP</th><th>MAC</th><th>Model</th><th>Firmware</th><th>Driver</th><th>Last Seen</th></tr>
      </thead>
      <tbody id="miners-tbody"></tbody>
    </table>
  </div>
  <p class="refresh-note">Auto-refreshes every 10 seconds</p>
</div>
<script>
function fmt(ms) {
  if (!ms) return '-';
  if (ms < 1000) return ms + 'ms';
  var s = ms / 1000;
  if (s < 60) return s.toFixed(1) + 's';
  return Math.floor(s/60) + 'm ' + Math.floor(s%60) + 's';
}
function ago(iso) {
  if (!iso) return '-';
  var d = Date.now() - new Date(iso).getTime();
  if (d < 0) return 'soon';
  if (d < 60000) return Math.floor(d/1000) + 's ago';
  if (d < 3600000) return Math.floor(d/60000) + 'm ago';
  return Math.floor(d/3600000) + 'h ago';
}
function load() {
  fetch('/api/status').then(r=>r.json()).then(function(s) {
    document.getElementById('designation').textContent = s.designation + ' | Site: ' + s.site_id + ' | v' + s.version;
    var badge = document.getElementById('cloud-badge');
    badge.textContent = s.cloud_connected ? 'CLOUD CONNECTED' : 'CLOUD OFFLINE';
    badge.className = 'cloud-badge ' + (s.cloud_connected ? 'connected' : 'disconnected');
    var online = s.online || 0, offline = s.offline || 0;
    document.getElementById('stats').innerHTML =
      '<div class="card"><div class="card-label">Devices</div><div class="card-value blue">'+s.total_devices+'</div></div>' +
      '<div class="card"><div class="card-label">Confirmed Miners</div><div class="card-value purple">'+s.confirmed_miners+'</div></div>' +
      '<div class="card"><div class="card-label">Online</div><div class="card-value green">'+online+'</div></div>' +
      '<div class="card"><div class="card-label">Offline</div><div class="card-value amber">'+offline+'</div></div>';
  }).catch(function(){});

  fetch('/api/scanners').then(r=>r.json()).then(function(r) {
    if (!r.scanners) return;
    var names = ['ip_scanner','critical_metrics'];
    var labels = {ip_scanner:'IP Scanner',critical_metrics:'Critical Metrics'};
    var html = '';
    names.forEach(function(n) {
      var sc = r.scanners[n]; if (!sc) return;
      var pbar = '';
      if (sc.status === 'scanning' && sc.progress) {
        var pct = sc.progress.total > 0 ? Math.round(sc.progress.current/sc.progress.total*100) : 0;
        pbar = '<div class="progress-bar"><div class="progress-fill" style="width:'+pct+'%"></div></div>' +
               '<div class="scanner-meta"><span>'+sc.progress.current+'/'+sc.progress.total+'</span>' +
               (sc.progress.target ? '<span class="mono">'+sc.progress.target+'</span>' : '') + '</div>';
      }
      var res = '';
      if (sc.last_result) {
        res = '<span>Found: '+sc.last_result.found+'</span><span>Updated: '+sc.last_result.updated+'</span>';
        if (sc.last_result.errors > 0) res += '<span style="color:#ef4444">Errors: '+sc.last_result.errors+'</span>';
      }
      html += '<div class="scanner-card">' +
        '<div style="display:flex;justify-content:space-between;align-items:center">' +
          '<span class="scanner-name">'+labels[n]+'</span>' +
          '<span class="scanner-status '+sc.status+'">'+sc.status.toUpperCase()+'</span>' +
        '</div>' +
        pbar +
        '<div class="scanner-meta">' +
          '<span>Last: '+ago(sc.last_run)+'</span>' +
          '<span>Duration: '+fmt(sc.last_duration_ms)+'</span>' +
          '<span>Next: '+ago(sc.next_run)+'</span>' +
          res +
        '</div></div>';
    });
    document.getElementById('scanners').innerHTML = html;
  }).catch(function(){});

  fetch('/api/miners').then(r=>r.json()).then(function(miners) {
    var html = '';
    miners.sort(function(a,b){ return (a.ip||'').localeCompare(b.ip||'',undefined,{numeric:true,sensitivity:'base'}); });
    miners.forEach(function(m) {
      var st = (m.status === 'online' || m.status === 'mining') ? 'online' : (m.status === 'offline' ? 'offline' : 'unknown');
      html += '<tr>' +
        '<td><span class="status"><span class="dot '+st+'"></span>'+m.status+'</span></td>' +
        '<td class="mono">'+(m.ip||'-')+'</td>' +
        '<td class="mono">'+(m.mac||'-')+'</td>' +
        '<td>'+(m.model||'Unknown')+'</td>' +
        '<td>'+(m.firmware_type||'-')+'</td>' +
        '<td>'+(m.method||'-')+'</td>' +
        '<td>'+ago(m.last_seen)+'</td></tr>';
    });
    document.getElementById('miners-tbody').innerHTML = html || '<tr><td colspan="7" style="text-align:center;color:#64748b">No devices discovered yet</td></tr>';
  }).catch(function(){});
}
load();
setInterval(load, 10000);
</script>
</body>
</html>`;

interface LocalHttpOptions {
  port: number;
  getDiscoveryStatus: () => ScannerStatus;
  getMetricsStatus: () => MetricsStatus;
  isCloudConnected: () => boolean;
}

export function startLocalHttp(opts: LocalHttpOptions): void {
  const server = http.createServer((req, res) => {
    const url = req.url || '/';

    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(DASHBOARD_HTML);
      return;
    }

    if (url === '/api/status') {
      const agent = stateManager.getAgent();
      const miners = stateManager.getAllMiners();
      const confirmedMiners = miners.filter(m => m.id && m.firmware_type && m.firmware_type !== 'unknown');
      const online = miners.filter(m => m.status === 'online' || m.status === 'mining').length;
      const offline = miners.filter(m => m.status === 'offline').length;

      const status = {
        agent_id: agent?.agentId || stateManager.getSiteId() || 'unknown',
        designation: agent?.designation || 'morpheus-agent',
        site_id: stateManager.getSiteId() || 'unknown',
        version: '2.3.1',
        cloud_connected: opts.isCloudConnected(),
        total_devices: miners.length,
        confirmed_miners: confirmedMiners.length,
        online,
        offline,
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status));
      return;
    }

    if (url === '/api/miners') {
      const miners = stateManager.getAllMiners().map(m => ({
        id: m.id,
        ip: m.ip,
        mac: m.mac,
        model: m.model,
        serial: m.serial,
        firmware_type: m.firmware_type,
        method: m.method,
        status: m.status,
        last_seen: m.lastSeen ? new Date(m.lastSeen).toISOString() : null,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(miners));
      return;
    }

    if (url === '/api/scanners') {
      const discovery = opts.getDiscoveryStatus();
      const metrics = opts.getMetricsStatus();
      const payload = {
        timestamp: new Date().toISOString(),
        scanners: {
          ip_scanner: discovery,
          critical_metrics: metrics,
        },
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      logger.warn(`Local UI port ${opts.port} already in use — skipping local HTTP server`);
    } else {
      logger.error('Local HTTP server error', { error: err.message });
    }
  });

  server.listen(opts.port, '0.0.0.0', () => {
    logger.info(`Local UI running at http://0.0.0.0:${opts.port}`);
  });
}
