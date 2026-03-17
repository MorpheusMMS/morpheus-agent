import fs from 'fs';
import path from 'path';
import { config } from './config';
import { logger } from './logger';

export interface AgentState {
  agentId: string;
  agentToken: string;
  siteId: string;
  designation: string;
  registeredAt: string;
}

export interface MinerRecord {
  id: string;
  mac: string;
  ip: string;
  model: string;
  serial: string;
  firmware_type: string;
  method: string;
  status: string;
  lastSeen: number;
}

export interface Credential {
  id: string;
  username: string;
  password: string;
  priority: number;
}

/**
 * Persistent state manager — survives restarts.
 * Stores agent identity and known miner cache.
 */
class StateManager {
  private state: AgentState | null = null;
  private miners: Map<string, MinerRecord> = new Map(); // keyed by IP
  private credentials: Credential[] = [];
  private pendingCommands: any[] = [];

  constructor() {
    this.load();
  }

  private get filePath(): string {
    return config.STATE_FILE;
  }

  load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const data = JSON.parse(raw);
        this.state = data.agent || null;
        if (data.miners) {
          for (const m of data.miners) {
            this.miners.set(m.ip, m);
          }
        }
        if (data.credentials) {
          this.credentials = data.credentials;
        }
        logger.info(`State loaded: agent=${this.state?.agentId || 'none'}, miners=${this.miners.size}`);
      }
    } catch (err) {
      logger.warn('Failed to load state file, starting fresh', { error: (err as Error).message });
    }
  }

  save(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data = {
        agent: this.state,
        miners: Array.from(this.miners.values()),
        credentials: this.credentials,
      };
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
    } catch (err) {
      logger.error('Failed to save state', { error: (err as Error).message });
    }
  }

  // Agent identity
  getAgent(): AgentState | null {
    return this.state;
  }

  setAgent(agent: AgentState): void {
    this.state = agent;
    this.save();
  }

  updateFromWelcome(agentId: string, siteId: string): void {
    if (!this.state) {
      this.state = { agentId, agentToken: '', siteId, designation: '', registeredAt: '' };
    } else {
      if (agentId) this.state.agentId = agentId;
      if (siteId) this.state.siteId = siteId;
    }
    this.save();
  }

  isRegistered(): boolean {
    return !!(this.state?.agentToken);
  }

  getToken(): string {
    // Prefer env override, then persisted
    return config.AGENT_TOKEN || this.state?.agentToken || '';
  }

  getSiteId(): string {
    return config.SITE_ID || this.state?.siteId || '';
  }

  // Miners
  getMiner(ip: string): MinerRecord | undefined {
    return this.miners.get(ip);
  }

  getMinerById(id: string): MinerRecord | undefined {
    for (const m of this.miners.values()) {
      if (m.id === id) return m;
    }
    return undefined;
  }

  setMiner(miner: MinerRecord): void {
    this.miners.set(miner.ip, miner);
  }

  getAllMiners(): MinerRecord[] {
    return Array.from(this.miners.values());
  }

  syncMiners(cloudMiners: any[]): void {
    for (const cm of cloudMiners) {
      if (cm.ip) {
        const existing = this.miners.get(cm.ip);
        this.miners.set(cm.ip, {
          id: cm.id,
          mac: cm.mac || existing?.mac || '',
          ip: cm.ip,
          model: cm.model || existing?.model || '',
          serial: cm.serial || existing?.serial || '',
          firmware_type: cm.firmware_type || existing?.firmware_type || '',
          method: cm.method || existing?.method || 'http',
          status: cm.status || 'unknown',
          lastSeen: existing?.lastSeen || 0,
        });
      }
    }
    this.save();
  }

  // Credentials
  getCredentials(): Credential[] {
    return this.credentials;
  }

  setCredentials(creds: Credential[]): void {
    this.credentials = creds;
    this.save();
  }

  // Pending commands
  getPendingCommands(): any[] {
    return this.pendingCommands;
  }

  setPendingCommands(commands: any[]): void {
    this.pendingCommands = commands;
  }

  removeCommand(minerCommandId: string): void {
    this.pendingCommands = this.pendingCommands.filter(c => c.miner_command_id !== minerCommandId);
  }
}

export const stateManager = new StateManager();
