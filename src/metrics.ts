import { config } from './config';
import { logger } from './logger';
import { stateManager } from './state';
import { driverManager } from './miners/driver-manager';
import { CloudConnection } from './websocket';
import { MinerMetrics } from './miners/types';

/**
 * Periodically collects metrics from all known miners and pushes to cloud.
 */
export interface MetricsStatus {
  name: string;
  status: 'idle' | 'scanning' | 'error';
  progress: { current: number; total: number } | null;
  last_run: string | null;
  last_duration_ms: number | null;
  last_result: { found: number; updated: number; errors: number; duration_ms: number } | null;
  next_run: string | null;
  interval_ms: number;
  error: string | null;
}

export class MetricsCollector {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private cloud: CloudConnection;

  private status: MetricsStatus = {
    name: 'critical_metrics',
    status: 'idle',
    progress: null,
    last_run: null,
    last_duration_ms: null,
    last_result: null,
    next_run: null,
    interval_ms: config.METRICS_INTERVAL_MS,
    error: null,
  };

  getStatus(): MetricsStatus {
    return { ...this.status };
  }

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
    this.status.status = 'scanning';
    this.status.last_run = new Date().toISOString();
    this.status.error = null;

    try {
      const miners = stateManager.getAllMiners().filter(m => m.id); // Only miners with cloud IDs
      if (miners.length === 0) {
        logger.debug('No miners to collect metrics from');
        this.status.status = 'idle';
        this.status.next_run = new Date(Date.now() + config.METRICS_INTERVAL_MS).toISOString();
        return;
      }
      this.status.progress = { current: 0, total: miners.length };

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

      const elapsed = Date.now() - startTime;
      logger.info(`Metrics collected: ${allMetrics.length}/${miners.length} miners, ${(elapsed/1000).toFixed(1)}s`);
      this.status.status = 'idle';
      this.status.progress = null;
      this.status.last_duration_ms = elapsed;
      this.status.last_result = { found: allMetrics.length, updated: allMetrics.length, errors: miners.length - allMetrics.length, duration_ms: elapsed };
      this.status.next_run = new Date(Date.now() + config.METRICS_INTERVAL_MS).toISOString();
    } catch (err) {
      logger.error('Metrics collection failed', { error: (err as Error).message });
      this.status.status = 'error';
      this.status.error = (err as Error).message;
    } finally {
      this.running = false;
    }
  }
}
