import { config } from './config';
import { logger } from './logger';
import { stateManager } from './state';
import { driverManager } from './miners/driver-manager';
import { CloudConnection } from './websocket';
import { MinerMetrics } from './miners/types';

/**
 * Periodically collects metrics from all known miners and pushes to cloud.
 */
export class MetricsCollector {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private cloud: CloudConnection;

  constructor(cloud: CloudConnection) {
    this.cloud = cloud;
  }

  start(): void {
    logger.info(`Metrics collection starting: interval=${config.METRICS_INTERVAL_MS}ms, concurrency=${config.MINER_CONCURRENCY}`);

    // First collection after 10 seconds (let discovery run first)
    setTimeout(() => {
      this.collect();
      this.timer = setInterval(() => this.collect(), config.METRICS_INTERVAL_MS);
    }, 10000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async collect(): Promise<void> {
    if (this.running) {
      logger.debug('Metrics collection already running, skipping');
      return;
    }

    this.running = true;
    const startTime = Date.now();

    try {
      const miners = stateManager.getAllMiners().filter(m => m.id); // Only miners with cloud IDs
      if (miners.length === 0) {
        logger.debug('No miners to collect metrics from');
        return;
      }

      const credentials = stateManager.getCredentials().map(c => ({
        username: c.username,
        password: c.password,
      }));

      if (credentials.length === 0) {
        credentials.push({ username: 'root', password: 'root' });
      }

      logger.debug(`Collecting metrics from ${miners.length} miners`);

      const allMetrics: MinerMetrics[] = [];

      // Process in batches for concurrency control
      const batchSize = config.MINER_CONCURRENCY;
      for (let i = 0; i < miners.length; i += batchSize) {
        const batch = miners.slice(i, i + batchSize);
        const results = await Promise.allSettled(
          batch.map(async miner => {
            const metrics = await driverManager.getMetrics(miner.ip, credentials, miner.method);
            if (metrics) {
              metrics.miner_id = miner.id;
              metrics.mac = miner.mac;
              return metrics;
            }
            return null;
          })
        );

        for (const result of results) {
          if (result.status === 'fulfilled' && result.value) {
            allMetrics.push(result.value);
          }
        }
      }

      // Push metrics to cloud in batches
      if (allMetrics.length > 0) {
        for (let i = 0; i < allMetrics.length; i += config.METRICS_BATCH_SIZE) {
          const batch = allMetrics.slice(i, i + config.METRICS_BATCH_SIZE);
          this.cloud.send({
            type: 'metrics_push',
            metrics: batch,
          });
        }

        // Update local miner status
        for (const m of allMetrics) {
          const miner = stateManager.getMiner(m.ip);
          if (miner) {
            miner.status = m.state;
            miner.lastSeen = Date.now();
            stateManager.setMiner(miner);
          }
        }
      }

      // Mark offline miners (no metrics for 3 cycles)
      const offlineThreshold = Date.now() - (config.METRICS_INTERVAL_MS * 3);
      for (const miner of miners) {
        if (miner.lastSeen > 0 && miner.lastSeen < offlineThreshold && miner.status !== 'offline') {
          miner.status = 'offline';
          stateManager.setMiner(miner);
        }
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.info(`Metrics collected: ${allMetrics.length}/${miners.length} miners, ${elapsed}s`);
    } catch (err) {
      logger.error('Metrics collection failed', { error: (err as Error).message });
    } finally {
      this.running = false;
    }
  }
}
