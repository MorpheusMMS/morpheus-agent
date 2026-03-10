import { exec } from 'child_process';
import { promisify } from 'util';
import axios from 'axios';
import { config } from './config';
import { logger } from './logger';
import { stateManager } from './state';
import { driverManager } from './miners/driver-manager';
import { MinerInfo } from './miners/types';
import { CloudConnection } from './websocket';

const execAsync = promisify(exec);

interface DiscoveredHost {
  ip: string;
  mac?: string;
}

/**
 * Network scanner that discovers miners on configured IP ranges.
 * Uses nmap for host discovery and driver probing for identification.
 */
export class Discovery {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private cloud: CloudConnection;
  private syncedIpRanges: string[] = [];

  constructor(cloud: CloudConnection) {
    this.cloud = cloud;
  }

  /** Called by the sync handler when the cloud sends ip_ranges in sync_response */
  setIpRanges(ranges: string[]): void {
    this.syncedIpRanges = ranges;
    // If discovery hasn't started yet (was waiting for ranges), kick it off now
    if (this.timer === null && config.DISCOVERY_ENABLED && ranges.length > 0) {
      logger.info(`IP ranges received from cloud: ${ranges.join(', ')} — starting discovery`);
      this.runScan();
      this.timer = setInterval(() => this.runScan(), config.DISCOVERY_INTERVAL_MS);
    }
  }

  start(): void {
    if (!config.DISCOVERY_ENABLED) {
      logger.info('Discovery disabled');
      return;
    }

    const ipRanges = this.getIpRanges();
    if (ipRanges.length === 0) {
      logger.warn('No IP ranges configured for discovery — waiting for cloud sync');
      return;
    }

    logger.info(`Discovery enabled: scanning ${ipRanges.join(', ')} every ${config.DISCOVERY_INTERVAL_MS / 1000}s`);

    // Run immediately, then on interval
    this.runScan();
    this.timer = setInterval(() => this.runScan(), config.DISCOVERY_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private getIpRanges(): string[] {
    // Prefer env override, then cloud-synced site config
    if (config.IP_RANGES.length > 0) return config.IP_RANGES;
    return this.syncedIpRanges;
  }

  private async runScan(): Promise<void> {
    if (this.running) {
      logger.debug('Discovery scan already running, skipping');
      return;
    }

    this.running = true;
    const startTime = Date.now();

    try {
      const ipRanges = this.getIpRanges();
      logger.info(`Starting discovery scan: ${ipRanges.join(', ')}`);

      // Phase 1: Find live hosts
      const hosts = await this.findHosts(ipRanges);
      logger.info(`Found ${hosts.length} live hosts`);

      // Phase 2: Probe hosts for miners (with concurrency limit)
      const credentials = stateManager.getCredentials().map(c => ({
        username: c.username,
        password: c.password,
      }));

      // Add default Antminer credentials if none configured
      if (credentials.length === 0) {
        credentials.push({ username: 'root', password: 'root' });
      }

      const knownMiners = stateManager.getAllMiners();
      const knownIps = new Set(knownMiners.map(m => m.ip));

      let newMiners = 0;
      let updatedMiners = 0;

      // Process in batches for concurrency control
      const batchSize = config.MINER_CONCURRENCY;
      for (let i = 0; i < hosts.length; i += batchSize) {
        const batch = hosts.slice(i, i + batchSize);
        const probeResults = await Promise.allSettled(
          batch.map(host => this.probeHost(host, credentials))
        );

        for (let j = 0; j < probeResults.length; j++) {
          const result = probeResults[j];
          if (result.status === 'fulfilled' && result.value) {
            const info = result.value;
            const isNew = !knownIps.has(info.ip);

            if (isNew) {
              await this.registerMiner(info);
              newMiners++;
            } else {
              updatedMiners++;
            }

            // Update local state
            const existing = stateManager.getMiner(info.ip);
            stateManager.setMiner({
              id: existing?.id || '',
              mac: info.mac || existing?.mac || '',
              ip: info.ip,
              model: info.model,
              serial: info.serial,
              firmware_type: info.firmwareType,
              method: info.method,
              status: 'online',
              lastSeen: Date.now(),
            });
          }
        }
      }

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      logger.info(`Discovery complete: ${newMiners} new, ${updatedMiners} updated, ${elapsed}s`);
    } catch (err) {
      logger.error('Discovery scan failed', { error: (err as Error).message });
    } finally {
      this.running = false;
    }
  }

  /**
   * Find live hosts using nmap ping scan.
   */
  private async findHosts(ipRanges: string[]): Promise<DiscoveredHost[]> {
    const hosts: DiscoveredHost[] = [];

    for (const range of ipRanges) {
      try {
        // nmap -sn: ping scan only (no port scan), fast
        // -n: no DNS resolution
        // --max-retries=1: limit retries for speed
        const { stdout } = await execAsync(
          `nmap -sn -n --max-retries=1 ${range} 2>/dev/null`,
          { timeout: 120000 }
        );

        // Parse nmap output
        const lines = stdout.split('\n');
        let currentIp = '';
        for (const line of lines) {
          const ipMatch = line.match(/Nmap scan report for (\d+\.\d+\.\d+\.\d+)/);
          if (ipMatch) {
            currentIp = ipMatch[1];
          }
          const macMatch = line.match(/MAC Address: ([0-9A-Fa-f:]+)/);
          if (currentIp && line.includes('Host is up')) {
            hosts.push({ ip: currentIp, mac: undefined });
          }
          if (macMatch && currentIp) {
            // Update the last host with MAC
            const lastHost = hosts.find(h => h.ip === currentIp);
            if (lastHost) lastHost.mac = macMatch[1];
          }
        }
      } catch (err) {
        // nmap might fail for a range, try arp-scan fallback
        logger.warn(`nmap scan failed for ${range}, trying ping sweep`, { error: (err as Error).message });
        await this.pingSweep(range, hosts);
      }
    }

    return hosts;
  }

  /**
   * Fallback: simple ping sweep when nmap is not available.
   */
  private async pingSweep(range: string, hosts: DiscoveredHost[]): Promise<void> {
    // Only works with /24 ranges
    const baseMatch = range.match(/^(\d+\.\d+\.\d+)\./);
    if (!baseMatch) return;

    const base = baseMatch[1];
    const promises: Promise<void>[] = [];

    for (let i = 1; i < 255; i++) {
      const ip = `${base}.${i}`;
      promises.push(
        execAsync(`ping -c 1 -W 1 ${ip}`, { timeout: 3000 })
          .then(() => { hosts.push({ ip }); })
          .catch(() => { /* not reachable */ })
      );

      // Batch of 50 concurrent pings
      if (promises.length >= 50) {
        await Promise.allSettled(promises);
        promises.length = 0;
      }
    }

    if (promises.length > 0) {
      await Promise.allSettled(promises);
    }
  }

  /**
   * Probe a discovered host to determine if it's a supported miner.
   */
  private async probeHost(
    host: DiscoveredHost,
    credentials: { username: string; password: string }[]
  ): Promise<MinerInfo | null> {
    return driverManager.probe(host.ip, credentials);
  }

  /**
   * Register a newly discovered miner with the cloud.
   */
  private async registerMiner(info: MinerInfo): Promise<void> {
    try {
      const siteId = stateManager.getSiteId();
      if (!siteId) {
        logger.warn('Cannot register miner: no site ID');
        return;
      }

      const response = await axios.post(
        `${config.CLOUD_API_URL}/miners`,
        {
          site_id: siteId,
          mac: info.mac,
          ip: info.ip,
          model: info.model,
          serial: info.serial,
          firmware_type: info.firmwareType,
          firmware_version: info.firmwareVersion,
          method: info.method,
          status: 'online',
        },
        {
          headers: {
            'X-Agent-Token': stateManager.getToken(),
          },
          timeout: config.MINER_TIMEOUT_MS,
        }
      );

      const miner = response.data;
      logger.info(`Registered miner: ${info.model} at ${info.ip} (id=${miner.id})`);

      // Update local state with cloud-assigned ID
      stateManager.setMiner({
        id: miner.id,
        mac: info.mac,
        ip: info.ip,
        model: info.model,
        serial: info.serial,
        firmware_type: info.firmwareType,
        method: info.method,
        status: 'online',
        lastSeen: Date.now(),
      });
    } catch (err) {
      logger.error(`Failed to register miner at ${info.ip}`, { error: (err as Error).message });
    }
  }
}
