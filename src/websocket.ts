import WebSocket from 'ws';
import { config } from './config';
import { logger } from './logger';
import { stateManager } from './state';
import { EventEmitter } from 'events';

export interface CloudMessage {
  type: string;
  [key: string]: any;
}

/**
 * WebSocket client with auto-reconnect and exponential backoff.
 * Emits typed events for each cloud message type.
 */
export class CloudConnection extends EventEmitter {
  private ws: WebSocket | null = null;
  private token: string = '';
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private sendQueue: string[] = [];

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(token: string): void {
    this.token = token;
    this.closed = false;
    this.doConnect();
  }

  disconnect(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, 'Agent shutting down');
      this.ws = null;
    }
  }

  send(message: CloudMessage): void {
    const payload = JSON.stringify(message);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(payload);
    } else {
      // Queue for when we reconnect
      this.sendQueue.push(payload);
      if (this.sendQueue.length > 1000) {
        this.sendQueue.shift(); // Drop oldest if queue too large
      }
    }
  }

  private doConnect(): void {
    if (this.closed) return;

    const url = `${config.CLOUD_URL}?token=${this.token}`;
    logger.info(`Connecting to cloud: ${config.CLOUD_URL}`);

    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      logger.info('Connected to cloud');
      this.reconnectAttempt = 0;

      // Flush queued messages
      while (this.sendQueue.length > 0) {
        const msg = this.sendQueue.shift()!;
        this.ws?.send(msg);
      }

      this.emit('connected');
    });

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const message: CloudMessage = JSON.parse(data.toString());
        this.handleMessage(message);
      } catch (err) {
        logger.error('Failed to parse cloud message', { error: (err as Error).message });
      }
    });

    this.ws.on('close', (code: number, reason: Buffer) => {
      logger.warn(`Disconnected from cloud: code=${code} reason=${reason.toString()}`);
      this.ws = null;
      this.emit('disconnected', code);

      if (!this.closed) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', (err: Error) => {
      logger.error('WebSocket error', { error: err.message });
      // close event will fire after this
    });
  }

  private handleMessage(message: CloudMessage): void {
    switch (message.type) {
      case 'connected':
        logger.info(`Cloud welcome: agentId=${message.agentId}, siteId=${message.siteId}`);
        this.emit('connected', message);
        // Request initial sync
        this.send({ type: 'sync_request' });
        break;

      case 'heartbeat':
        this.send({ type: 'heartbeat_ack' });
        break;

      case 'sync_response':
        this.emit('sync', message);
        break;

      case 'metrics_ack':
        logger.debug(`Metrics acknowledged: ${message.inserted}/${message.total} inserted`);
        break;

      case 'command_response_ack':
        logger.debug(`Command response acked: ${message.miner_command_id}`);
        break;

      case 'error':
        logger.error(`Cloud error: ${message.message}`);
        break;

      default:
        logger.debug(`Unhandled cloud message type: ${message.type}`);
        this.emit(message.type, message);
    }
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;

    const delay = Math.min(
      config.WS_RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempt),
      config.WS_RECONNECT_MAX_MS
    );
    this.reconnectAttempt++;

    logger.info(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, delay);
  }
}
