import axios from 'axios';
import os from 'os';
import { config } from './config';
import { logger } from './logger';
import { stateManager, AgentState } from './state';

/**
 * Handles one-time agent registration using a bootstrap token.
 * After registration, the agent receives a permanent token.
 */
export async function ensureRegistered(): Promise<string> {
  // Already have a token?
  const existingToken = stateManager.getToken();
  if (existingToken) {
    logger.info('Agent already registered, using stored token');
    return existingToken;
  }

  // Need bootstrap token
  if (!config.BOOTSTRAP_TOKEN) {
    throw new Error(
      'No agent token and no BOOTSTRAP_TOKEN provided. ' +
      'Set BOOTSTRAP_TOKEN to register this agent, or AGENT_TOKEN if already registered.'
    );
  }

  logger.info('Registering agent with bootstrap token...');

  const ip = getLocalIp();
  const version = '2.0.0';

  const response = await axios.post(`${config.CLOUD_API_URL}/api/agents/register`, {
    bootstrap_token: config.BOOTSTRAP_TOKEN,
    designation: config.DESIGNATION,
    ip,
    version,
  });

  const { agent, token } = response.data;

  const agentState: AgentState = {
    agentId: agent.id,
    agentToken: token,
    siteId: agent.site_id,
    designation: agent.designation,
    registeredAt: new Date().toISOString(),
  };

  stateManager.setAgent(agentState);

  logger.info(`Agent registered: id=${agent.id}, site=${agent.site_id}, designation=${agent.designation}`);

  return token;
}

function getLocalIp(): string {
  const interfaces = os.networkInterfaces();
  for (const iface of Object.values(interfaces)) {
    if (!iface) continue;
    for (const addr of iface) {
      if (addr.family === 'IPv4' && !addr.internal) {
        return addr.address;
      }
    }
  }
  return '127.0.0.1';
}
