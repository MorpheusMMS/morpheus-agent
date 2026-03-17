import net from 'net';
import crypto from 'crypto';
import { MinerDriver, MinerInfo, MinerMetrics, MinerCommand, CommandResult } from './types';
import { config } from '../config';
import { logger } from '../logger';

/**
 * Driver for WhatsMiner M60S+ / M50S+ series (firmware 2024+).
 * Identifies via btminer API (port 4028): newer firmware returns `miner_type`
 * instead of `model` and uses `get_miner_info` for MAC address and serial.
 *
 * Default credentials: admin / admin
 * Hardware: H616 platform, btminer API v2.2+
 */
export class WhatsminerM60Driver implements MinerDriver {
  private readonly port = 4028;
  // Newer firmware platforms that this driver handles
  private readonly supportedPlatforms = ['H616', 'H616S', 'H618'];

  async probe(ip: string, credentials: { username: string; password: string }[]): Promise<MinerInfo | null> {
    try {
      const versionData = await this.btminerCommand(ip, { cmd: 'get_version' });
      const msg = versionData?.Msg;
      if (!msg) return null;

      // M60S+/M50S+ firmware identifies itself with miner_type and platform fields
      // Old firmware uses model field instead — handled by WhatsminerDriver
      if (!msg.miner_type && !this.supportedPlatforms.includes(msg.platform)) return null;

      const minerType: string = msg.miner_type || 'WhatsMiner';

      // Fetch network info for MAC address and serial number
      let mac = '';
      let serial = '';
      let hostname = '';
      try {
        const infoData = await this.btminerCommand(ip, { cmd: 'get_miner_info' });
        const info = infoData?.Msg;
        if (info) {
          mac = info.mac || '';
          serial = info.minersn || '';
          hostname = info.hostname || '';
        }
      } catch {
        // Non-fatal — probe succeeds without MAC; device_type will remain 'unknown'
      }

      return {
        mac,
        ip,
        model: minerType,
        serial,
        firmwareType: 'whatsminer',
        firmwareVersion: msg.fw_ver || '',
        method: 'btminer',
        hostname,
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

      const s = summaryData?.Msg;
      if (!s) return null;

      const pools = (poolsData?.POOLS || []).map((p: any) => ({
        url: p.URL || '',
        worker: p.User || '',
      }));

      // MHS av / MHS 1m etc. are in MH/s — convert to GH/s
      const mhsToGhs = (v: any) => Math.round(parseFloat(v || 0) / 1000);

      const metrics: MinerMetrics = {
        ip,
        hashrate_now: mhsToGhs(s['HS RT'] || s['MHS 1m'] || s['MHS av']),
        hashrate_1m:  mhsToGhs(s['MHS 1m']  || s['MHS av']),
        hashrate_5m:  mhsToGhs(s['MHS 15m'] || s['MHS av']),
        accepted_shares: parseInt(pools[0] ? (poolsData?.POOLS?.[0]?.Accepted || 0) : (s.Accepted || 0)),
        rejected_shares: parseInt(pools[0] ? (poolsData?.POOLS?.[0]?.Rejected || 0) : (s.Rejected || 0)),
        hw_errors:    0,
        temp_chip:    parseFloat(s['Chip Temp Avg'] || s['Chip Temp Max'] || 0),
        temp_pcb:     parseFloat(s['Env Temp'] || 0),
        fan_1:        parseInt(s['Fan Speed In']  || 0),
        fan_2:        parseInt(s['Fan Speed Out'] || 0),
        fan_3:        0,
        fan_4:        0,
        power_watts:  parseFloat(s.Power || 0),
        uptime_seconds: parseInt(s.Uptime || s.Elapsed || 0),
        pool_1_url:    pools[0]?.url    || '',
        pool_1_worker: pools[0]?.worker || '',
        pool_2_url:    pools[1]?.url    || '',
        pool_2_worker: pools[1]?.worker || '',
        pool_3_url:    pools[2]?.url    || '',
        pool_3_worker: pools[2]?.worker || '',
        power_mode:   (s['Power Mode'] || 'Normal').toLowerCase(),
        state:        mhsToGhs(s['MHS av']) > 0 ? 'mining' : 'idle',
      };

      return metrics;
    } catch (err) {
      logger.debug(`WhatsminerM60 metrics failed for ${ip}: ${(err as Error).message}`);
      return null;
    }
  }

  async executeCommand(
    ip: string,
    command: MinerCommand,
    payload: any,
    credentials: { username: string; password: string }[]
  ): Promise<CommandResult> {
    // Use admin credentials (M60S+ default), fall back to any configured credential
    const cred = credentials.find(c => c.username === 'admin') || credentials[0];
    if (!cred) return { success: false, message: 'No credentials available' };

    try {
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
          // M60S+ uses set_power_mode command directly
          await this.btminerCommand(ip, {
            cmd: 'set_power_mode',
            power_mode: mode === 'low' ? 'low' : mode === 'high' ? 'high' : 'normal',
            token,
          });
          return { success: true, message: `Power mode set to ${mode}` };
        }

        case 'get_config': {
          const [versionData, infoData] = await Promise.all([
            this.btminerCommand(ip, { cmd: 'get_version' }),
            this.btminerCommand(ip, { cmd: 'get_miner_info' }),
          ]);
          return { success: true, message: 'Config retrieved', data: { version: versionData, info: infoData } };
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
    const tokenData = await this.btminerCommand(ip, { cmd: 'get_token' });
    if (!tokenData?.Msg) {
      throw new Error('Failed to get write token');
    }
    const salt = tokenData.Msg.salt || '';
    // Token: md5(salt + password)
    return crypto.createHash('md5').update(salt + password).digest('hex');
  }
}
