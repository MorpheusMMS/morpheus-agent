import dotenv from 'dotenv';
dotenv.config();

export const config = {
  // Connection to cloud
  CLOUD_URL: process.env.CLOUD_URL || 'ws://localhost:3001',
  CLOUD_API_URL: process.env.CLOUD_API_URL || 'http://localhost:3000',

  // Bootstrap (one-time registration)
  BOOTSTRAP_TOKEN: process.env.BOOTSTRAP_TOKEN || '',

  // Agent identity (populated after registration)
  AGENT_TOKEN: process.env.AGENT_TOKEN || '',
  AGENT_ID: process.env.AGENT_ID || '',
  SITE_ID: process.env.SITE_ID || '',
  DESIGNATION: process.env.DESIGNATION || 'morpheus-agent',

  // Discovery
  DISCOVERY_ENABLED: process.env.DISCOVERY_ENABLED !== 'false',
  DISCOVERY_INTERVAL_MS: parseInt(process.env.DISCOVERY_INTERVAL_MS || '300000', 10), // 5 min
  IP_RANGES: process.env.IP_RANGES ? process.env.IP_RANGES.split(',').map(s => s.trim()) : [],

  // Metrics
  METRICS_INTERVAL_MS: parseInt(process.env.METRICS_INTERVAL_MS || '60000', 10), // 1 min
  METRICS_BATCH_SIZE: parseInt(process.env.METRICS_BATCH_SIZE || '50', 10),

  // Miner communication
  MINER_TIMEOUT_MS: parseInt(process.env.MINER_TIMEOUT_MS || '10000', 10),
  MINER_CONCURRENCY: parseInt(process.env.MINER_CONCURRENCY || '10', 10),

  // Reconnect
  WS_RECONNECT_BASE_MS: 1000,
  WS_RECONNECT_MAX_MS: 60000,

  // Persistence
  STATE_FILE: process.env.STATE_FILE || '/data/agent-state.json',

  // Logging
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',
};
