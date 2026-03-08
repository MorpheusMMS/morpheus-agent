import net from 'net';
import axios from 'axios';
import { MinerDriver, MinerInfo, MinerMetrics, MinerCommand, CommandResult } from './types';
import { config } from '../config';
import { logger } from '../logger';

/**
 * Driver for Antminer S9/S17/S19/S21 and compatible miners using
 * CGMiner/BMMiner API (port 4028) + Digest HTTP API.
 */
export class CGMinerDriver implements MinerDriver {
  private readonly cgPort = 4028;
  private readonly httpPort = 80;

  async probe(ip: string, credentials: { username: string; password: string }[]): Promise<MinerInfo | null> {
    // Try CGMiner API first (faster, no auth needed)
    try {
      const stats = await this.cgminerCommand(ip, 'stats');
      if (!stats) return null;

      const info = this.parseStatsForInfo(ip, stats);
      if (info) return info;
    } catch {
      // Not a cgminer device
    }

    // Fallback: try HTTP API with auth
    for (const cred of credentials) {
      try {
        const response = await axios.get(`http://${ip}/cgi-bin/get_system_info.cgi`, {
          auth: { username: cred.username, password: cred.password },
          timeout: config.MINER_TIMEOUT_MS,
        });

        if (response.data) {
          const d = response.data;
          return {
            mac: d.macaddr || d.mac || '',
            ip,
            model: d.minertype || d.model || 'Antminer',
            serial: d.serial || '',
            firmwareType: 'antminer',
            firmwareVersion: d.firmware_version || d.fw_ver || '',
            method: 'cgminer',
            hostname: d.hostname || '',
          };
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  async getMetrics(ip: string, credentials: { username: string; password: string }[]): Promise<MinerMetrics | null> {
    try {
      const [statsRaw, summaryRaw, poolsRaw] = await Promise.all([
        this.cgminerCommand(ip, 'stats'),
        this.cgminerCommand(ip, 'summary'),
        this.cgminerCommand(ip, 'pools'),
      ]);

      if (!summaryRaw) return null;

      const summary = this.parseSummary(summaryRaw);
      const stats = statsRaw ? this.parseStats(statsRaw) : {};
      const pools = poolsRaw ? this.parsePools(poolsRaw) : [];

      const metrics: MinerMetrics = {
        ip,
        hashrate_now: summary.ghs5s || summary.ghsav || 0,
        hashrate_1m: summary.ghs1m || summary.ghs5s || 0,
        hashrate_5m: summary.ghsav || 0,
        accepted_shares: summary.accepted || 0,
        rejected_shares: summary.rejected || 0,
        hw_errors: summary.hardwareErrors || 0,
        temp_chip: stats.tempChip || 0,
        temp_pcb: stats.tempPcb || 0,
        fan_1: stats.fan1 || 0,
        fan_2: stats.fan2 || 0,
        fan_3: stats.fan3 || 0,
        fan_4: stats.fan4 || 0,
        power_watts: stats.powerWatts || 0,
        uptime_seconds: summary.elapsed || 0,
        pool_1_url: pools[0]?.url || '',
        pool_1_worker: pools[0]?.worker || '',
        pool_2_url: pools[1]?.url || '',
        pool_2_worker: pools[1]?.worker || '',
        pool_3_url: pools[2]?.url || '',
        pool_3_worker: pools[2]?.worker || '',
        power_mode: stats.powerMode || 'normal',
        state: summary.ghs5s > 0 ? 'mining' : 'idle',
      };

      return metrics;
    } catch (err) {
      logger.debug(`CGMiner metrics failed for ${ip}: ${(err as Error).message}`);
      return null;
    }
  }

  async executeCommand(
    ip: string,
    command: MinerCommand,
    payload: any,
    credentials: { username: string; password: string }[]
  ): Promise<CommandResult> {
    const cred = credentials[0];
    if (!cred) return { success: false, message: 'No credentials available' };

    try {
      switch (command) {
        case 'reboot': {
          // Try CGMiner restart first, then HTTP reboot
          try {
            await this.cgminerCommand(ip, 'restart');
          } catch {
            await axios.get(`http://${ip}/cgi-bin/reboot.cgi`, {
              auth: { username: cred.username, password: cred.password },
              timeout: config.MINER_TIMEOUT_MS,
            });
          }
          return { success: true, message: 'Reboot command sent' };
        }

        case 'restart_mining': {
          await this.cgminerCommand(ip, 'restart');
          return { success: true, message: 'Mining restart command sent' };
        }

        case 'set_pools': {
          const pools = payload?.pools || [];
          for (let i = 0; i < pools.length && i < 3; i++) {
            await this.cgminerCommand(ip, 'addpool', `${pools[i].url},${pools[i].worker},${pools[i].password || ''}`);
          }
          return { success: true, message: `Set ${pools.length} pools` };
        }

        case 'set_power_mode': {
          // Antminer power mode via HTTP API
          const mode = payload?.mode || 'Normal';
          await axios.post(
            `http://${ip}/cgi-bin/set_miner_conf.cgi`,
            `_ant_power_mode=${mode}`,
            {
              auth: { username: cred.username, password: cred.password },
              timeout: config.MINER_TIMEOUT_MS,
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            }
          );
          return { success: true, message: `Power mode set to ${mode}` };
        }

        case 'get_config': {
          const conf = await this.cgminerCommand(ip, 'config');
          return { success: true, message: 'Config retrieved', data: conf };
        }

        default:
          return { success: false, message: `Unsupported command: ${command}` };
      }
    } catch (err) {
      return { success: false, message: `Command failed: ${(err as Error).message}` };
    }
  }

  // --- CGMiner TCP API ---

  private cgminerCommand(ip: string, command: string, parameter?: string): Promise<any> {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let data = '';

      socket.setTimeout(config.MINER_TIMEOUT_MS);

      socket.connect(this.cgPort, ip, () => {
        const cmd: any = { command };
        if (parameter) cmd.parameter = parameter;
        socket.write(JSON.stringify(cmd));
      });

      socket.on('data', (chunk) => {
        data += chunk.toString();
      });

      socket.on('end', () => {
        try {
          // CGMiner sometimes returns invalid JSON with trailing NUL
          const cleaned = data.replace(/\0/g, '').trim();
          resolve(JSON.parse(cleaned));
        } catch {
          resolve(null);
        }
      });

      socket.on('timeout', () => {
        socket.destroy();
        reject(new Error(`CGMiner timeout: ${ip}`));
      });

      socket.on('error', (err) => {
        socket.destroy();
        reject(err);
      });
    });
  }

  // --- Response parsers ---

  private parseStatsForInfo(ip: string, stats: any): MinerInfo | null {
    try {
      const statsData = stats.STATS || stats.stats || [];
      for (const s of statsData) {
        if (s.Type || s.ID) {
          return {
            mac: '',
            ip,
            model: s.Type || s.ID || 'Unknown Antminer',
            serial: s.Serial || '',
            firmwareType: 'antminer',
            firmwareVersion: s.CompileTime || s.Miner || '',
            method: 'cgminer',
          };
        }
      }
    } catch { /* ignore */ }
    return null;
  }

  private parseSummary(data: any): any {
    try {
      const s = (data.SUMMARY || data.summary || [{}])[0];
      return {
        ghs5s: parseFloat(s['GHS 5s'] || s['GHS5s'] || 0),
        ghs1m: parseFloat(s['GHS 1m'] || 0),
        ghsav: parseFloat(s['GHS av'] || s['GHSav'] || 0),
        accepted: parseInt(s.Accepted || 0),
        rejected: parseInt(s.Rejected || 0),
        hardwareErrors: parseInt(s['Hardware Errors'] || s.HardwareErrors || 0),
        elapsed: parseInt(s.Elapsed || 0),
      };
    } catch {
      return {};
    }
  }

  private parseStats(data: any): any {
    try {
      const statsArr = data.STATS || data.stats || [];
      const result: any = {};

      for (const s of statsArr) {
        // Temperature: look for chain temps
        for (let i = 1; i <= 16; i++) {
          const chipKey = `temp${i}`;
          const pcbKey = `temp2_${i}`;
          if (s[chipKey] && !result.tempChip) result.tempChip = parseFloat(s[chipKey]);
          if (s[pcbKey] && !result.tempPcb) result.tempPcb = parseFloat(s[pcbKey]);
        }

        // Fans
        if (s.fan1 !== undefined) result.fan1 = parseInt(s.fan1);
        if (s.fan2 !== undefined) result.fan2 = parseInt(s.fan2);
        if (s.fan3 !== undefined) result.fan3 = parseInt(s.fan3);
        if (s.fan4 !== undefined) result.fan4 = parseInt(s.fan4);

        // Power
        if (s.Power !== undefined) result.powerWatts = parseFloat(s.Power);
        if (s.total_power !== undefined) result.powerWatts = parseFloat(s.total_power);

        // Power mode
        if (s.Mode !== undefined) result.powerMode = s.Mode;
      }

      return result;
    } catch {
      return {};
    }
  }

  private parsePools(data: any): { url: string; worker: string }[] {
    try {
      const pools = data.POOLS || data.pools || [];
      return pools.map((p: any) => ({
        url: p.URL || p.Stratum || '',
        worker: p.User || p.Worker || '',
      }));
    } catch {
      return [];
    }
  }
}
