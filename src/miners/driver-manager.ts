import { MinerDriver, MinerInfo, MinerMetrics, MinerCommand, CommandResult } from './types';
import { CGMinerDriver } from './cgminer-driver';
import { WhatsminerDriver } from './whatsminer-driver';
import { WhatsminerM60Driver } from './whatsminer-m60-driver';
import { logger } from '../logger';
import { config } from '../config';

/**
 * Manages multiple miner drivers and auto-detects which driver
 * to use for each miner IP via sequential probing.
 */
class DriverManager {
  private drivers: { name: string; driver: MinerDriver }[] = [];
  private driverCache: Map<string, string> = new Map(); // ip -> driver name

  constructor() {
    this.drivers = [
      { name: 'cgminer', driver: new CGMinerDriver() },
      { name: 'whatsminer-m60', driver: new WhatsminerM60Driver() },
      { name: 'whatsminer', driver: new WhatsminerDriver() },
    ];
  }

  /**
   * Probe an IP with all drivers to find a supported miner.
   */
  async probe(ip: string, credentials: { username: string; password: string }[]): Promise<MinerInfo | null> {
    for (const { name, driver } of this.drivers) {
      try {
        const info = await driver.probe(ip, credentials);
        if (info) {
          this.driverCache.set(ip, name);
          logger.debug(`Probe ${ip}: matched driver=${name}, model=${info.model}`);
          return info;
        }
      } catch {
        // This driver doesn't support this miner
      }
    }
    return null;
  }

  /**
   * Get metrics from a miner. Uses cached driver if available, otherwise probes first.
   */
  async getMetrics(
    ip: string,
    credentials: { username: string; password: string }[],
    method?: string
  ): Promise<MinerMetrics | null> {
    const driver = this.resolveDriver(ip, method);
    if (!driver) {
      // Try probing
      const info = await this.probe(ip, credentials);
      if (!info) return null;
      return this.getMetrics(ip, credentials, info.method);
    }
    return driver.getMetrics(ip, credentials);
  }

  /**
   * Execute a command on a miner.
   */
  async executeCommand(
    ip: string,
    command: MinerCommand,
    payload: any,
    credentials: { username: string; password: string }[],
    method?: string
  ): Promise<CommandResult> {
    const driver = this.resolveDriver(ip, method);
    if (!driver) {
      return { success: false, message: `No driver found for miner at ${ip}` };
    }
    return driver.executeCommand(ip, command, payload, credentials);
  }

  private resolveDriver(ip: string, method?: string): MinerDriver | null {
    // Method hint from cloud
    if (method) {
      const match = this.drivers.find(d => d.name === method || method.includes(d.name));
      if (match) return match.driver;
    }

    // Cached driver from previous probe
    const cached = this.driverCache.get(ip);
    if (cached) {
      const match = this.drivers.find(d => d.name === cached);
      if (match) return match.driver;
    }

    return null;
  }
}

export const driverManager = new DriverManager();
