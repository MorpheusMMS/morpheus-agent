# Morpheus Agent

The Morpheus Agent runs on-site to discover, monitor, and manage cryptocurrency miners. It connects to the [Morpheus cloud platform](https://morph.collinscreations.co.uk) for centralized management.

## Quick Install

SSH into your site server and run:

```bash
curl -sSL https://raw.githubusercontent.com/MorpheusMMS/morpheus-agent/main/install.sh | bash -s -- \
  --server https://morph.collinscreations.co.uk \
  --token YOUR_BOOTSTRAP_TOKEN
```

Get your bootstrap token from the Morpheus dashboard: **Sites > Your Site > Deploy Agent > Generate Bootstrap Token**

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `--server` | Cloud server URL (required) | — |
| `--token` | Bootstrap token (required) | — |
| `--channel` | Update channel: `stable` or `beta` | `stable` |

## What It Does

- **Discovers miners** on your local network using nmap and direct probing
- **Collects metrics** — hashrate, temperatures, fan speeds, power, pool status
- **Executes commands** — reboot, pool changes, power mode switching
- **Reports to cloud** via secure WebSocket connection
- **Auto-updates** from this repo on the selected channel (every 30 minutes)

## Supported Hardware

| Manufacturer | Models | Firmware |
|-------------|--------|----------|
| Bitmain | Antminer S9/S17/S19/S21 | Stock (CGMiner), Braiins, Vnish, Luxor |
| MicroBT | Whatsminer M30/M50/M60 | Stock (BTMiner) |

## Requirements

- Ubuntu 20.04+ or Debian 11+ (x86_64)
- 1 GB RAM minimum (2 GB recommended for large sites)
- Network access to miners (same LAN or reachable subnet)
- Outbound HTTPS to the cloud server and github.com
- Root/sudo access (installer sets up systemd)

The installer handles Node.js and all other dependencies automatically.

## Manual Management

```bash
# Service status
systemctl status morpheus-agent

# View logs
journalctl -u morpheus-agent -f

# Restart
systemctl restart morpheus-agent

# Configuration
cat /etc/morpheus-agent.env

# Force update
/opt/morpheus-agent/update.sh
```

## Docker (Alternative)

```bash
docker run -d \
  --name morpheus-agent \
  --restart unless-stopped \
  --network host \
  -v /var/lib/morpheus-agent:/data \
  -e CLOUD_URL=wss://morph.collinscreations.co.uk \
  -e CLOUD_API_URL=https://morph.collinscreations.co.uk/api \
  -e BOOTSTRAP_TOKEN=your-token-here \
  ghcr.io/morpheusmms/morpheus-agent:latest
```

## Security

- The agent authenticates using a **one-time bootstrap token** (24-hour expiry)
- After registration, it receives a permanent **agent token** (SHA-256 hashed server-side)
- No cloud credentials or secrets are stored in this repository
- All communication uses TLS (WSS/HTTPS)
- The systemd service runs with hardened security settings

## License

Proprietary — MorpheusMMS. See LICENSE for details.
