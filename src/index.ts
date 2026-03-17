import { config } from './config';
import { logger } from './logger';
import { stateManager } from './state';
import { ensureRegistered } from './registration';
import { CloudConnection } from './websocket';
import { Discovery } from './discovery';
import { MetricsCollector } from './metrics';
import { CommandExecutor } from './commands';
import { startLocalHttp } from './local-http';

const VERSION = '2.3.1';

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

  // Start services when connected — also persist siteId from welcome message
  cloud.on('connected', (welcome: any) => {
    if (welcome?.agentId || welcome?.siteId) {
      stateManager.updateFromWelcome(welcome.agentId || '', welcome.siteId || '');
    }
    discovery.start();
    metricsCollector.start();
  });

  // Stop services on disconnect (they'll restart on reconnect)
  cloud.on('disconnected', () => {
    discovery.stop();
    metricsCollector.stop();
  });

  // Connect
  cloud.connect(token);

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    discovery.stop();
    metricsCollector.stop();
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
