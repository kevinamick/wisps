#!/bin/bash
# Install Wisps as a systemd service (Linux server or VM): starts on boot, restarts on crash.
# Run from the repo root on the server:  sudo deploy/install-service.sh
set -euo pipefail
cd "$(dirname "$0")/.."
DIR=$(pwd)
RUN_AS=${SUDO_USER:-$USER}
HOME_DIR=$(getent passwd "$RUN_AS" | cut -d: -f6)
NODE=$(sudo -u "$RUN_AS" bash -lc 'command -v node')
[ -n "$NODE" ] || { echo "node not found for $RUN_AS"; exit 1; }
cat > /etc/systemd/system/wisps.service <<UNIT
[Unit]
Description=Wisps: always-on agents on Claude Code
After=network-online.target
Wants=network-online.target

[Service]
User=$RUN_AS
WorkingDirectory=$DIR
EnvironmentFile=-$DIR/deploy/wisps.env
Environment=PATH=$HOME_DIR/.local/bin:$(dirname "$NODE"):/usr/local/bin:/usr/bin:/bin
ExecStart=$NODE server/index.js
Restart=always
RestartSec=5
KillSignal=SIGTERM
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now wisps
systemctl --no-pager status wisps | head -5
