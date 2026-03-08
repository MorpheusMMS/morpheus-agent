import { config } from './config';
import { logger } from './logger';
import { stateManager } from './state';
import { driverManager } from './miners/driver-manager';
import { CloudConnection } from './websocket';
import { MinerCommand } from './miners/types';

interface PendingCommand {
  miner_command_id: string;
  miner_id: string;
  command_type: string;
  payload: any;
}

/**
 * Processes commands queued by the cloud and executes them against miners.
 */
export class CommandExecutor {
  private cloud: CloudConnection;
  private processing = false;

  constructor(cloud: CloudConnection) {
    this.cloud = cloud;
  }

  /**
   * Called when sync_response includes pending commands.
   */
  async processCommands(commands: PendingCommand[]): Promise<void> {
    if (this.processing) {
      logger.warn('Command processing already in progress');
      return;
    }

    if (commands.length === 0) return;

    this.processing = true;
    logger.info(`Processing ${commands.length} pending commands`);

    const credentials = stateManager.getCredentials().map(c => ({
      username: c.username,
      password: c.password,
    }));

    if (credentials.length === 0) {
      credentials.push({ username: 'root', password: 'root' });
    }

    try {
      for (const cmd of commands) {
        await this.executeOne(cmd, credentials);
      }
    } finally {
      this.processing = false;
    }
  }

  private async executeOne(
    cmd: PendingCommand,
    credentials: { username: string; password: string }[]
  ): Promise<void> {
    const miner = stateManager.getMinerById(cmd.miner_id);
    if (!miner) {
      logger.warn(`Command ${cmd.miner_command_id}: miner ${cmd.miner_id} not found locally`);
      this.cloud.send({
        type: 'command_response',
        miner_command_id: cmd.miner_command_id,
        status: 'failed',
        error: 'Miner not found on this agent',
      });
      return;
    }

    logger.info(`Executing ${cmd.command_type} on ${miner.ip} (${miner.model || 'unknown'})`);

    // Report in-progress
    this.cloud.send({
      type: 'command_response',
      miner_command_id: cmd.miner_command_id,
      status: 'sent',
    });

    try {
      const result = await driverManager.executeCommand(
        miner.ip,
        cmd.command_type as MinerCommand,
        cmd.payload,
        credentials,
        miner.method
      );

      this.cloud.send({
        type: 'command_response',
        miner_command_id: cmd.miner_command_id,
        status: result.success ? 'completed' : 'failed',
        result: result.message,
        error: result.success ? undefined : result.message,
      });

      logger.info(
        `Command ${cmd.command_type} on ${miner.ip}: ${result.success ? 'OK' : 'FAILED'} — ${result.message}`
      );
    } catch (err) {
      this.cloud.send({
        type: 'command_response',
        miner_command_id: cmd.miner_command_id,
        status: 'failed',
        error: (err as Error).message,
      });

      logger.error(`Command ${cmd.command_type} on ${miner.ip} failed`, {
        error: (err as Error).message,
      });
    }
  }
}
