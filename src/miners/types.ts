/**
 * Unified miner data types across all hardware vendors.
 */

export interface MinerInfo {
  mac: string;
  ip: string;
  model: string;
  serial: string;
  firmwareType: string;
  firmwareVersion: string;
  method: string; // 'cgminer' | 'btminer' | 'bosminer' | 'http'
  hostname?: string;
}

export interface MinerMetrics {
  mac?: string;
  ip: string;
  miner_id?: string;

  // Hashrate (GH/s stored as integer for bigint compat)
  hashrate_now: number;
  hashrate_1m: number;
  hashrate_5m: number;

  // Shares
  accepted_shares: number;
  rejected_shares: number;
  hw_errors: number;

  // Temperatures (Celsius)
  temp_chip: number;
  temp_pcb: number;

  // Fan speeds (RPM)
  fan_1: number;
  fan_2: number;
  fan_3: number;
  fan_4: number;

  // Power
  power_watts: number;
  uptime_seconds: number;

  // Pool config
  pool_1_url: string;
  pool_1_worker: string;
  pool_2_url: string;
  pool_2_worker: string;
  pool_3_url: string;
  pool_3_worker: string;

  // Per-board data (optional)
  hashboard_data?: Array<{
    slot: number;
    temp: number;
    freq_mhz: number;
    hashrate_ghs: number;
    effective_chips: number;
    pcb_sn?: string;
  }>;

  // Fan data (optional, keyed by fan index)
  fan_data?: Record<string, number>;

  // State
  power_mode: string;
  state: string; // 'mining' | 'idle' | 'error' | 'rebooting'
}

export interface CommandResult {
  success: boolean;
  message: string;
  data?: any;
}

export type MinerCommand =
  | 'reboot'
  | 'restart_mining'
  | 'set_pools'
  | 'set_power_mode'
  | 'get_config'
  | 'update_firmware';

export interface MinerDriver {
  /** Probe an IP to determine if it's a supported miner */
  probe(ip: string, credentials: { username: string; password: string }[]): Promise<MinerInfo | null>;

  /** Collect metrics from a known miner */
  getMetrics(ip: string, credentials: { username: string; password: string }[]): Promise<MinerMetrics | null>;

  /** Execute a command on a miner */
  executeCommand(
    ip: string,
    command: MinerCommand,
    payload: any,
    credentials: { username: string; password: string }[]
  ): Promise<CommandResult>;

  /** Optional: test a single credential, returns true if it authenticates successfully */
  testCredential?(ip: string, username: string, password: string): Promise<boolean>;
}
