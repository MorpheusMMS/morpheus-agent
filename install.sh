#!/usr/bin/env bash
#
# Morpheus Agent Installer
# Usage: curl -sSL https://raw.githubusercontent.com/MorpheusMMS/morpheus-agent/main/install.sh | bash -s -- --server URL --token TOKEN [--channel stable|beta]
#
set -euo pipefail

MORPHEUS_DIR="/opt/morpheus-agent"
MORPHEUS_USER="morpheus"
MORPHEUS_SERVICE="morpheus-agent"
REPO_URL="https://github.com/MorpheusMMS/morpheus-agent.git"
NODE_MAJOR=22
LOG_FILE="/tmp/morpheus-agent-install.log"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[MORPHEUS]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
err()  { echo -e "${RED}[ERROR]${NC} $1" >&2; }

# ─── Parse Arguments ──────────────────────────────────────────────────────────

CLOUD_SERVER=""
BOOTSTRAP_TOKEN=""
CHANNEL="stable"
WS_PORT="18302"
API_PORT="18300"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --server)   CLOUD_SERVER="$2"; shift 2 ;;
    --token)    BOOTSTRAP_TOKEN="$2"; shift 2 ;;
    --channel)  CHANNEL="$2"; shift 2 ;;
    --ws-port)  WS_PORT="$2"; shift 2 ;;
    --api-port) API_PORT="$2"; shift 2 ;;
    *) err "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ -z "$CLOUD_SERVER" ]]; then
  err "Missing required --server argument"
  echo "Usage: $0 --server https://morph.example.com --token <BOOTSTRAP_TOKEN>"
  exit 1
fi

if [[ -z "$BOOTSTRAP_TOKEN" ]]; then
  err "Missing required --token argument"
  echo "Usage: $0 --server https://morph.example.com --token <BOOTSTRAP_TOKEN>"
  exit 1
fi

# Strip trailing slash
CLOUD_SERVER="${CLOUD_SERVER%/}"

# Derive WebSocket URL from server URL (via /ws path — proxied by NPM to WS port)
CLOUD_WS_URL=$(echo "$CLOUD_SERVER" | sed 's|^https://|wss://|; s|^http://|ws://|')
CLOUD_WS_URL="${CLOUD_WS_URL}/ws"
CLOUD_API_URL="${CLOUD_SERVER}/api"

log "Morpheus Agent Installer"
log "═══════════════════════════════════════════"
log "Cloud Server:  ${CYAN}${CLOUD_SERVER}${NC}"
log "Channel:       ${CYAN}${CHANNEL}${NC}"
log "Install Path:  ${CYAN}${MORPHEUS_DIR}${NC}"
echo ""

# ─── Check Root ───────────────────────────────────────────────────────────────

if [[ $EUID -ne 0 ]]; then
  err "This script must be run as root (or with sudo)"
  exit 1
fi

# ─── Detect OS ────────────────────────────────────────────────────────────────

if [[ -f /etc/os-release ]]; then
  . /etc/os-release
  OS_ID="${ID}"
  OS_VERSION="${VERSION_ID}"
else
  err "Cannot detect OS. Only Ubuntu 20.04+ and Debian 11+ are supported."
  exit 1
fi

log "Detected OS: ${OS_ID} ${OS_VERSION}"

case "$OS_ID" in
  ubuntu|debian) ;;
  *)
    warn "Untested OS: ${OS_ID}. Proceeding anyway..."
    ;;
esac

# ─── Install System Dependencies ─────────────────────────────────────────────

log "Installing system dependencies..."
apt-get update -qq >> "$LOG_FILE" 2>&1
apt-get install -y -qq curl git nmap net-tools iputils-ping iproute2 ca-certificates gnupg >> "$LOG_FILE" 2>&1
log "System dependencies installed"

# ─── Install Node.js ─────────────────────────────────────────────────────────

if command -v node &>/dev/null; then
  CURRENT_NODE=$(node -v | sed 's/v//' | cut -d. -f1)
  if [[ "$CURRENT_NODE" -ge 20 ]]; then
    log "Node.js $(node -v) already installed"
  else
    warn "Node.js $(node -v) is too old, upgrading..."
    INSTALL_NODE=true
  fi
else
  INSTALL_NODE=true
fi

if [[ "${INSTALL_NODE:-false}" == "true" ]]; then
  log "Installing Node.js ${NODE_MAJOR}..."
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg 2>/dev/null
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq >> "$LOG_FILE" 2>&1
  apt-get install -y -qq nodejs >> "$LOG_FILE" 2>&1
  log "Node.js $(node -v) installed"
fi

# ─── Create Morpheus User ────────────────────────────────────────────────────

if ! id "$MORPHEUS_USER" &>/dev/null; then
  log "Creating user: ${MORPHEUS_USER}"
  useradd --system --home-dir "$MORPHEUS_DIR" --shell /usr/sbin/nologin "$MORPHEUS_USER"
fi

# ─── Download Agent ───────────────────────────────────────────────────────────

log "Downloading morpheus-agent..."
rm -rf "$MORPHEUS_DIR"
BRANCH="main"
[[ "$CHANNEL" == "beta" ]] && BRANCH="beta"
git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$MORPHEUS_DIR" >> "$LOG_FILE" 2>&1 || \
  git clone --depth 1 "$REPO_URL" "$MORPHEUS_DIR" >> "$LOG_FILE" 2>&1

cd "$MORPHEUS_DIR"
log "Agent downloaded"

# ─── Install Dependencies & Build ────────────────────────────────────────────

log "Installing npm dependencies..."
npm ci --omit=dev >> "$LOG_FILE" 2>&1 || npm install --omit=dev >> "$LOG_FILE" 2>&1

# Install dev deps temporarily for build, then prune
npm install >> "$LOG_FILE" 2>&1
log "Building TypeScript..."
npx tsc >> "$LOG_FILE" 2>&1
npm prune --omit=dev >> "$LOG_FILE" 2>&1
log "Agent built successfully"

# ─── Create Data Directory ────────────────────────────────────────────────────

mkdir -p /var/lib/morpheus-agent
chown "$MORPHEUS_USER:$MORPHEUS_USER" /var/lib/morpheus-agent

# ─── Write Environment File ──────────────────────────────────────────────────

log "Configuring agent..."

# Preserve existing AGENT_TOKEN across reinstalls (avoid needing a new bootstrap token each time)
PRESERVED_TOKEN=""
if [[ -f /etc/morpheus-agent.env ]]; then
  PRESERVED_TOKEN=$(grep "^AGENT_TOKEN=" /etc/morpheus-agent.env | cut -d= -f2 || true)
fi

cat > /etc/morpheus-agent.env << ENVEOF
# Morpheus Agent Configuration
# Generated by installer on $(date -u +%Y-%m-%dT%H:%M:%SZ)
CLOUD_URL=${CLOUD_WS_URL}
CLOUD_API_URL=${CLOUD_API_URL}
BOOTSTRAP_TOKEN=${BOOTSTRAP_TOKEN}
DESIGNATION=morpheus-agent
LOG_LEVEL=info
STATE_FILE=/var/lib/morpheus-agent/state.json
DISCOVERY_ENABLED=true
DISCOVERY_INTERVAL=300
METRICS_INTERVAL=60
ENVEOF

chmod 600 /etc/morpheus-agent.env
log "Configuration written to /etc/morpheus-agent.env"

# ─── Register Agent ──────────────────────────────────────────────────────────

log "Registering agent with cloud..."
LOCAL_IP=$(hostname -I | awk '{print $1}')
AGENT_VERSION=$(node -e "console.log(require('./package.json').version)")
log "Agent version:   ${CYAN}v${AGENT_VERSION}${NC}"

REGISTER_RESPONSE=$(curl -s -X POST "${CLOUD_API_URL}/agents/register" \
  -H "Content-Type: application/json" \
  -d "{
    \"bootstrap_token\": \"${BOOTSTRAP_TOKEN}\",
    \"designation\": \"morpheus-agent\",
    \"ip\": \"${LOCAL_IP}\",
    \"version\": \"${AGENT_VERSION}\"
  }" 2>&1) || true

# Check if registration succeeded (response: {agent: {id, site_id, ...}, token: "..."})
AGENT_TOKEN=$(echo "$REGISTER_RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('token',''))" 2>/dev/null || echo "")
AGENT_ID=$(echo "$REGISTER_RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('agent',{}).get('id',''))" 2>/dev/null || echo "")
SITE_ID=$(echo "$REGISTER_RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('agent',{}).get('site_id',''))" 2>/dev/null || echo "")

if [[ -n "$AGENT_TOKEN" && "$AGENT_TOKEN" != "None" ]]; then
  log "Agent registered successfully (ID: ${AGENT_ID})"
  # Update env with agent token (remove bootstrap token)
  sed -i "s|^BOOTSTRAP_TOKEN=.*|AGENT_TOKEN=${AGENT_TOKEN}|" /etc/morpheus-agent.env
else
  REGISTER_ERROR=$(echo "$REGISTER_RESPONSE" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('error','Unknown error'))" 2>/dev/null || echo "$REGISTER_RESPONSE")
  if [[ -n "$PRESERVED_TOKEN" ]]; then
    log "Registration skipped (${REGISTER_ERROR}) — reusing existing agent token"
    sed -i "s|^BOOTSTRAP_TOKEN=.*|AGENT_TOKEN=${PRESERVED_TOKEN}|" /etc/morpheus-agent.env
    AGENT_TOKEN="$PRESERVED_TOKEN"
  else
    warn "Registration failed: ${REGISTER_ERROR}"
    warn "Agent will attempt registration on first startup using the bootstrap token"
  fi
fi

# ─── Fetch Site Settings & Count IPs ─────────────────────────────────────────

if [[ -n "$SITE_ID" && "$SITE_ID" != "None" && -n "$AGENT_TOKEN" && "$AGENT_TOKEN" != "None" ]]; then
  SITE_RESPONSE=$(curl -s "${CLOUD_API_URL}/sites/${SITE_ID}" \
    -H "X-Agent-Token: ${AGENT_TOKEN}" 2>/dev/null) || SITE_RESPONSE=""
  # Print each range on its own line for easy shell handling
  IP_RANGES=$(echo "$SITE_RESPONSE" | python3 -c "
import json, sys
d = json.load(sys.stdin)
ranges = d.get('ip_ranges') or []
if isinstance(ranges, list):
    print('\n'.join(str(r) for r in ranges))
" 2>/dev/null || echo "")
  if [[ -n "$IP_RANGES" ]]; then
    IP_COUNT=$(python3 - <<PYEOF
import ipaddress

def count_range(r):
    r = r.strip()
    if not r:
        return 0
    try:
        return ipaddress.ip_network(r, strict=False).num_addresses
    except ValueError:
        pass
    # dash-range: e.g. 10.11-15.1-11.1-9
    parts = r.split('.')
    if len(parts) == 4:
        count = 1
        for p in parts:
            if '-' in p:
                lo, hi = p.split('-', 1)
                count *= (int(hi) - int(lo) + 1)
        return count
    return 0

ranges = [l.strip() for l in """${IP_RANGES}""".splitlines() if l.strip()]
total = sum(count_range(r) for r in ranges)
print(f"{len(ranges)} range(s), {total:,} addresses")
PYEOF
)
    log "Site settings:  ${CYAN}${IP_RANGES//$'\n'/ | }${NC}"
    log "IPs to scan:    ${CYAN}${IP_COUNT}${NC}"
  else
    warn "No IP ranges configured for this site — set them in the Morpheus dashboard"
  fi
fi

# ─── Set Ownership ────────────────────────────────────────────────────────────

chown -R "$MORPHEUS_USER:$MORPHEUS_USER" "$MORPHEUS_DIR"
chown -R "$MORPHEUS_USER:$MORPHEUS_USER" /var/lib/morpheus-agent

# ─── Create Systemd Service ──────────────────────────────────────────────────

log "Setting up systemd service..."
cat > /etc/systemd/system/${MORPHEUS_SERVICE}.service << SVCEOF
[Unit]
Description=Morpheus Mining Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${MORPHEUS_USER}
WorkingDirectory=${MORPHEUS_DIR}
EnvironmentFile=/etc/morpheus-agent.env
ExecStart=/usr/bin/node ${MORPHEUS_DIR}/dist/index.js
Restart=always
RestartSec=10
StartLimitIntervalSec=0
StandardOutput=journal
StandardError=journal
SyslogIdentifier=morpheus-agent

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/morpheus-agent
PrivateTmp=true

# Allow network scanning
AmbientCapabilities=CAP_NET_RAW

[Install]
WantedBy=multi-user.target
SVCEOF

systemctl daemon-reload
systemctl enable "$MORPHEUS_SERVICE" >> "$LOG_FILE" 2>&1
systemctl restart "$MORPHEUS_SERVICE"
sleep 2
if systemctl is-active --quiet "$MORPHEUS_SERVICE"; then
  log "Service started and enabled on boot"
  log "Discovery scan: ${CYAN}first scan in ~10s, repeat every 300s${NC}"
else
  warn "Service may not have started — check: journalctl -u ${MORPHEUS_SERVICE} -n 20"
fi

# ─── Setup Auto-Update (cron) ────────────────────────────────────────────────

log "Configuring auto-update (${CHANNEL} channel)..."
BRANCH="main"
[[ "$CHANNEL" == "beta" ]] && BRANCH="beta"

cat > /opt/morpheus-agent/update.sh << 'UPDATEEOF'
#!/usr/bin/env bash
# Morpheus Agent Auto-Updater
set -euo pipefail

cd /opt/morpheus-agent
CURRENT=$(git rev-parse HEAD)
git fetch origin >> /dev/null 2>&1
LATEST=$(git rev-parse origin/BRANCH_PLACEHOLDER)

if [[ "$CURRENT" != "$LATEST" ]]; then
  echo "[$(date)] Updating morpheus-agent..."
  git pull origin BRANCH_PLACEHOLDER
  npm ci --omit=dev
  npm install
  npx tsc
  npm prune --omit=dev
  chown -R morpheus:morpheus /opt/morpheus-agent
  systemctl restart morpheus-agent
  echo "[$(date)] Update complete. New version: $(git rev-parse --short HEAD)"
fi
UPDATEEOF

sed -i "s|BRANCH_PLACEHOLDER|${BRANCH}|g" /opt/morpheus-agent/update.sh
chmod +x /opt/morpheus-agent/update.sh

# Run auto-update every 30 minutes + watchdog every 5 minutes
CRON_TMP=$(mktemp)
crontab -l 2>/dev/null | grep -v morpheus-agent > "$CRON_TMP" || true
echo "*/30 * * * * /opt/morpheus-agent/update.sh >> /var/log/morpheus-agent-update.log 2>&1" >> "$CRON_TMP"
echo "*/5 * * * * systemctl is-active --quiet morpheus-agent || (systemctl reset-failed morpheus-agent 2>/dev/null; systemctl start morpheus-agent) >> /var/log/morpheus-agent-watchdog.log 2>&1" >> "$CRON_TMP"
crontab "$CRON_TMP"
rm -f "$CRON_TMP"
log "Auto-update configured (every 30 minutes, ${CHANNEL} channel)"
log "Watchdog configured (every 5 minutes, auto-recovers from failed state)"

# ─── Done ─────────────────────────────────────────────────────────────────────

echo ""
log "═══════════════════════════════════════════"
log "${GREEN}Morpheus Agent installed successfully!${NC}"
log "═══════════════════════════════════════════"
echo ""
log "Service:    systemctl status ${MORPHEUS_SERVICE}"
log "Logs:       journalctl -u ${MORPHEUS_SERVICE} -f"
log "Config:     /etc/morpheus-agent.env"
log "Data:       /var/lib/morpheus-agent/"
log "Updates:    ${CHANNEL} channel (auto-update every 30m)"
echo ""
log "The agent is now running and will appear in your Morpheus dashboard."
