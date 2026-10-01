#!/bin/bash
# Push code changes from your dev machine to a server running Wisps, then restart it once no agent is busy.
# Data on the server is never overwritten. The server address comes from $WISPS_VM or deploy/.vm (not committed),
# e.g. "you@203.0.113.10". The repo lives at ~/wisps on the server.
set -e
cd "$(dirname "$0")/.."
VM=${WISPS_VM:-$(cat deploy/.vm 2>/dev/null || true)}
[ -n "$VM" ] || { echo "Set WISPS_VM=user@host or put it in deploy/.vm"; exit 1; }
rsync -az --exclude node_modules --exclude data --exclude .git --exclude deploy/.vm --exclude deploy/wisps.env ./ "$VM:wisps/"
ssh "$VM" 'cd wisps && npm ci --no-audit --no-fund --silent
for i in $(seq 1 80); do
  busy=$(curl -s -m 10 localhost:${PORT:-4777}/api/state | node -pe "s=JSON.parse(require(\"fs\").readFileSync(0)); s.tasks.some(t=>[\"running\",\"waiting\"].includes(t.status))||Object.values(s.live.wisps).some(d=>d.chat||d.checkin||d.waiting)")
  [ "$busy" = "false" ] && break; sleep 15; done
sudo systemctl restart wisps && sleep 8 && systemctl is-active wisps && sudo journalctl -u wisps -n 3 --no-pager -o cat'
