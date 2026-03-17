import net from 'net';
import axios from 'axios';
import crypto from 'crypto';
import { MinerDriver, MinerInfo, MinerMetrics, MinerCommand, CommandResult } from './types';
import { config } from '../config';
import { logger } from '../logger';

/**
 * Driver for Whatsminer M30/M50/M60 series using the btminer API (port 4028).
 * Whatsminer uses a token-based auth with enc/dec commands.
 */
export class WhatsminerDriver implements MinerDriver {
  private readonly port = 4028;

  async probe(ip: string, credentials: { username: string; password: string }[]): Promise<MinerInfo | null> {
    try {
      // Whatsminer responds to 'get_version' on port 4028
      const versionData = await this.btminerCommand(ip, { cmd: 'get_version' });
      if (!versionData || !versionData.Msg) return null;

      const msg = versionData.Msg;
      // Confirm it's a Whatsminer by checking response fields
      if (!msg.fw_ver && !msg.model) return null;

      return {
        mac: msg.mac || '',
        ip,
        model: msg.model || 'Whatsminer',
        serial: msg.serial || '',
        firmwareType: 'whatsminer',
        firmwareVersion: msg.fw_ver || '',
        method: 'btminer',
        hostname: msg.hostname || '',
      };
    } catch {
      return null;
    }
  }

  async getMetrics(ip: string, credentials: { username: string; password: string }[]): Promise<MinerMetrics | null> {
    try {
      const [summaryData, poolsData] = await Promise.all([
        this.btminerCommand(ip, { cmd: 'summary' }),
        this.btminerCommand(ip, { cmd: 'pools' }),
      ]);

      // Whatsminer returns data in Msg field (not SUMMARY like CGMiner)
      const s = summaryData?.Msg;
      if (!s) return null;

      // Pools use CGMiner-style POOLS array
      const pools = (poolsData?.POOLS || []).map((p: any) => ({
        url: p.URL || '',
        worker: p.User || '',
      }));

      // MHS av is in MH/s — convert to GH/s
      const mhsToGhs = (v: any) => parseFloat(v || 0) / 1000;

      const metrics: MinerMetrics = {
        ip,
        hashrate_now: mhsToGhs(s['MHS 1m'] || s['HS RT'] || s['MHS av']),
        hashrate_1m: mhsToGhs(s['MHS 1m'] || s['MHS av']),
        hashrate_5m: mhsToGhs(s['MHS 15m'] || s['MHS av']),
        accepted_shares: parseInt(s.Accepted || 0),
        rejected_shares: parseInt(s.Rejected || 0),
        hw_errors: 0,
        temp_chip: parseFloat(s['Chip Temp Avg'] || s['Chip Temp Max'] || 0),
        temp_pcb: parseFloat(s['Env Temp'] || 0),
        fan_1: parseInt(s['Fan Speed In'] || 0),
        fan_2: parseInt(s['Fan Speed Out'] || 0),
        fan_3: 0,
        fan_4: 0,
        power_watts: parseFloat(s.Power || 0),
        uptime_seconds: parseInt(s.Uptime || s.Elapsed || 0),
        pool_1_url: pools[0]?.url || '',
        pool_1_worker: pools[0]?.worker || '',
        pool_2_url: pools[1]?.url || '',
        pool_2_worker: pools[1]?.worker || '',
        pool_3_url: pools[2]?.url || '',
        pool_3_worker: pools[2]?.worker || '',
        power_mode: (s['Power Mode'] || 'Normal').toLowerCase(),
        state: mhsToGhs(s['MHS av']) > 0 ? 'mining' : 'idle',
      };

      return metrics;
    } catch (err) {
      logger.debug(`Whatsminer metrics failed for ${ip}: ${(err as Error).message}`);
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
      // Whatsminer write commands require token auth
      const token = await this.getWriteToken(ip, cred.password);

      switch (command) {
        case 'reboot': {
          await this.btminerCommand(ip, { cmd: 'reboot', token });
          return { success: true, message: 'Reboot command sent' };
        }

        case 'restart_mining': {
          await this.btminerCommand(ip, { cmd: 'restart_btminer', token });
          return { success: true, message: 'Mining restart sent' };
        }

        case 'set_pools': {
          const pools = payload?.pools || [];
          if (pools.length > 0) {
            await this.btminerCommand(ip, {
              cmd: 'update_pools',
              pool1: pools[0]?.url || '',
              worker1: pools[0]?.worker || '',
              passwd1: pools[0]?.password || '',
              pool2: pools[1]?.url || '',
              worker2: pools[1]?.worker || '',
              passwd2: pools[1]?.password || '',
              pool3: pools[2]?.url || '',
              worker3: pools[2]?.worker || '',
              passwd3: pools[2]?.password || '',
              token,
            });
          }
          return { success: true, message: `Set ${pools.length} pools` };
        }

        case 'set_power_mode': {
          const mode = payload?.mode || 'normal';
          await this.btminerCommand(ip, {
            cmd: 'set_target_freq',
            percent: mode === 'low' ? '-10' : mode === 'high' ? '+10' : '0',
            token,
          });
          return { success: true, message: `Power mode set to ${mode}` };
        }

        case 'get_config': {
          const result = await this.btminerCommand(ip, { cmd: 'get_miner_info' });
          return { success: true, message: 'Config retrieved', data: result };
        }

        default:
          return { success: false, message: `Unsupported command: ${command}` };
      }
    } catch (err) {
      return { success: false, message: `Command failed: ${(err as Error).message}` };
    }
  }

  // --- btminer TCP API ---

  private btminerCommand(ip: string, cmd: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let data = '';

      socket.setTimeout(config.MINER_TIMEOUT_MS);

      socket.connect(this.port, ip, () => {
        socket.write(JSON.stringify(cmd) + '\n');
      });

      socket.on('data', (chunk) => {
        data += chunk.toString();
      });

      socket.on('end', () => {
        try {
          const cleaned = data.replace(/\0/g, '').trim();
          resolve(JSON.parse(cleaned));
        } catch {
          resolve(null);
        }
      });

      socket.on('timeout', () => {
        socket.destroy();
        reject(new Error(`btminer timeout: ${ip}`));
      });

      socket.on('error', (err) => {
        socket.destroy();
        reject(err);
      });
    });
  }

  private async getWriteToken(ip: string, password: string): Promise<string> {
    // Whatsminer uses a challenge-response for write operations
    const tokenData = await this.btminerCommand(ip, { cmd: 'get_token' });
    if (!tokenData?.Msg) {
      throw new Error('Failed to get write token');
    }

    const salt = tokenData.Msg.salt || '';
    const newsalt = tokenData.Msg.newsalt || '';

    // Create token: md5(salt + password)
    const hash = crypto.createHash('md5').update(salt + password).digest('hex');
    return hash;
  }

  private parseTempsAndFans(devDetails: any): {
    chipTemp: number; pcbTemp: number;
    fan1: number; fan2: number; fan3: number; fan4: number;
  } {
    const result = { chipTemp: 0, pcbTemp: 0, fan1: 0, fan2: 0, fan3: 0, fan4: 0 };
    try {
      const devices = devDetails?.DEVDETAILS || devDetails?.devdetails || [];
      for (const d of devices) {
        if (d.Temperature && !result.chipTemp) result.chipTemp = parseFloat(d.Temperature);
        if (d['Chip Temp'] && !result.chipTemp) result.chipTemp = parseFloat(d['Chip Temp']);
        if (d['PCB Temp'] && !result.pcbTemp) result.pcbTemp = parseFloat(d['PCB Temp']);
      }

      // Fan data often in summary
      if (devDetails?.Msg) {
        const msg = devDetails.Msg;
        if (msg.fan_in) result.fan1 = parseInt(msg.fan_in);
        if (msg.fan_out) result.fan2 = parseInt(msg.fan_out);
      }
    } catch { /* ignore */ }
    return result;
  }
}
