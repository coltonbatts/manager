#!/bin/sh
# Runs `manager serve` at login via a macOS LaunchAgent, restarting it if it crashes.
#   scripts/launch-agent.sh install     write the agent and start it now
#   scripts/launch-agent.sh uninstall   stop it and remove the agent
#   scripts/launch-agent.sh status      is it running?
# Logs go to data/logs/serve.log (inside Manager, like everything else).

set -eu

LABEL="com.alternativedesign.manager"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
PORT="${MANAGER_PORT:-4747}"
DOMAIN="gui/$(id -u)"

case "${1:-}" in
  install)
    NODE="$(command -v node)"
    "$NODE" -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=18)?0:1)' \
      || { echo "Node >= 22.18 required (found $("$NODE" -v) at $NODE)"; exit 1; }
    mkdir -p "$ROOT/data/logs" "$HOME/Library/LaunchAgents"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>--disable-warning=ExperimentalWarning</string>
    <string>$ROOT/src/cli.ts</string>
    <string>serve</string>
    <string>--port</string>
    <string>$PORT</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$HOME/.local/bin:$(dirname "$NODE"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
    <key>NO_COLOR</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$ROOT/data/logs/serve.log</string>
  <key>StandardErrorPath</key><string>$ROOT/data/logs/serve.log</string>
</dict>
</plist>
EOF
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "Installed. Manager starts at login: http://127.0.0.1:$PORT"
    echo "Node pinned to $NODE. Re-run install after changing Node versions."
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Removed."
    ;;
  status)
    if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
      launchctl print "$DOMAIN/$LABEL" | grep -E "^\s+(state|pid|last exit code) =" || true
    else
      echo "Not installed."
    fi
    ;;
  *)
    echo "usage: $0 install|uninstall|status"
    exit 1
    ;;
esac
