import os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { config } from './config';
import { logger } from './logger';
import { stateManager } from './state';
import { ensureRegistered } from './registration';
import { CloudConnection } from './websocket';
import { Discovery } from './discovery';
import { MetricsCollector } from './metrics';
import { CommandExecutor } from './commands';
import { startLocalHttp } from './local-http';

const execAsync = promisify(exec);

const VERSION = '2.3.4';

async function getSystemStats() {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const loadAvg = os.loadavg();

  let diskTotal = 0;
  let diskUsed = 0;
  let diskFree = 0;
  try {
    const { stdout } = await execAsync('df -k / 2>/dev/null', { timeout: 5000 });
    const lines = stdout.trim().split('\n');
    if (lines.length >= 2) {
      const parts = lines[1].split(/\s+/);
      diskTotal = parseInt(parts[1] || '0') * 1024;
      diskUsed  = parseInt(parts[2] || '0') * 1024;
      diskFree  = parseInt(parts[3] || '0') * 1024;
    }
  } catch { /* ignore */ }

  return {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    uptime_seconds: Math.floor(os.uptime()),
    cpu: {
      model: cpus[0]?.model || 'unknown',
      cores: cpus.length,
      load_1m: Math.round(loadAvg[0] * 100) / 100,
      load_5m: Math.round(loadAvg[1] * 100) / 100,
      load_15m: Math.round(loadAvg[2] * 100) / 100,
      usage_pct: Math.round((loadAvg[0] / cpus.length) * 100),
    },
    memory: {
      total_bytes: totalMem,
      used_bytes: usedMem,
      free_bytes: freeMem,
      used_pct: Math.round((usedMem / totalMem) * 100),
    },
    disk: {
      total_bytes: diskTotal,
      used_bytes: diskUsed,
      free_bytes: diskFree,
      used_pct: diskTotal > 0 ? Math.round((diskUsed / diskTotal) * 100) : 0,
    },
  };
}

async function main() {
  logger.info('='.repeat(60));
  logger.info(`Morpheus Agent v${VERSION} starting`);
  logger.info(`Cloud URL: ${config.CLOUD_URL}`);
  logger.info(`Discovery: ${config.DISCOVERY_ENABLED ? 'enabled' : 'disabled'}`);
  logger.info(`Metrics interval: ${config.METRICS_INTERVAL_MS / 1000}s`);
  logger.info('='.repeat(60));

  // Step 1: Register with cloud (or use existing token)
  let token: string;
  try {
    token = await ensureRegistered();
  } catch (err) {
    logger.error('Registration failed', { error: (err as Error).message });
    process.exit(1);
  }

  // Step 2: Connect to cloud via WebSocket
  const cloud = new CloudConnection();
  const discovery = new Discovery(cloud);
  const metricsCollector = new MetricsCollector(cloud);
  const commandExecutor = new CommandExecutor(cloud);

  // Step 3: Start local HTTP UI (works even when cloud is offline)
  if (config.LOCAL_UI_ENABLED) {
    startLocalHttp({
      port: config.LOCAL_UI_PORT,
      getDiscoveryStatus: () => discovery.getStatus(),
      getMetricsStatus: () => metricsCollector.getStatus(),
      getLatestMetrics: () => metricsCollector.getLatestMetrics(),
      isCloudConnected: () => cloud.connected,
    });
  }

  // Handle sync response from cloud
  cloud.on('sync', (message: any) => {
    logger.info(
      `Sync received: ${message.miners?.length || 0} miners, ` +
      `${message.pending_commands?.length || 0} commands, ` +
      `${message.credentials?.length || 0} credentials`
    );

    // Update local state with cloud data
    if (message.miners) {
      stateManager.syncMiners(message.miners);
    }
    if (message.credentials) {
      stateManager.setCredentials(message.credentials);
    }
    if (message.ip_ranges && Array.isArray(message.ip_ranges) && message.ip_ranges.length > 0) {
      discovery.setIpRanges(message.ip_ranges);
    }
    if (message.pending_commands && message.pending_commands.length > 0) {
      stateManager.setPendingCommands(message.pending_commands);
      commandExecutor.processCommands(message.pending_commands).catch(err => {
        logger.error('Command processing error', { error: (err as Error).message });
      });
    }
  });

  // Push scanner + system stats to cloud every 30s
  let statusTimer: NodeJS.Timeout | null = null;
  const pushScannerStatus = async () => {
    if (!cloud.connected) return;
    try {
      const idlePlaceholder = (name: string) => ({
        name,
        status: 'idle',
        progress: null,
        last_run: null,
        last_duration_ms: null,
        last_result: null,
        next_run: null,
        interval_ms: 0,
        error: null,
      });

      const system_stats = await getSystemStats();
      const miners = stateManager.getAllMiners();

      cloud.send({
        type: 'scanner_status',
        timestamp: new Date().toISOString(),
        scanners: {
          ip_scanner: discovery.getStatus(),
          critical_metrics: metricsCollector.getStatus(),
          device_identifier: idlePlaceholder('device_identifier'),
          arp_scanner: idlePlaceholder('arp_scanner'),
        },
        system_stats,
        miner_count: miners.length,
        miners_online: miners.filter(m => m.status === 'mining' || m.status === 'online').length,
      });
    } catch { /* non-fatal */ }
  };

  // Start services when connected — also persist siteId from welcome message
  cloud.on('connected', (welcome: any) => {
    if (welcome?.agentId || welcome?.siteId) {
      stateManager.updateFromWelcome(welcome.agentId || '', welcome.siteId || '');
    }
    discovery.start();
    metricsCollector.start();
    // Send status immediately, then every 30s
    setTimeout(() => pushScannerStatus(), 5000);
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = setInterval(() => pushScannerStatus(), 30000);
  });

  // Stop services on disconnect (they'll restart on reconnect)
  cloud.on('disconnected', () => {
    discovery.stop();
    metricsCollector.stop();
    if (statusTimer) { clearInterval(statusTimer); statusTimer = null; }
  });

  // Connect
  cloud.connect(token);

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    discovery.stop();
    metricsCollector.stop();
    if (statusTimer) clearInterval(statusTimer);
    cloud.disconnect();
    stateManager.save();
    logger.info('Agent stopped');
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection', { reason: String(reason) });
  });
}

main().catch((err) => {
  logger.error('Fatal error', { error: (err as Error).message });
  process.exit(1);
});
