#!/bin/bash
# co|op Block — first-boot provisioning script
#
# What this does, and why each step exists:
#   1. Confirms this is real Linux hardware, not someone's Mac dev environment
#      (simulation_mode exists specifically so config.json's default is safe
#      to run on a Mac with no hardware — this script is the "we're for real
#      now" switch).
#   2. Installs iptables if it's missing. Without this, isolate/block commands
#      would previously report success while doing nothing — the original
#      "false success" bug. This script fixes it at the root instead of just
#      making it visible on the dashboard (which was the earlier fix).
#   3. Generates a real, unique device_key. NOTE: the backend API doesn't
#      actually use device_key anywhere yet (everything today is keyed by
#      org_key only) — this is forward-compatible housekeeping, not something
#      that unlocks new functionality today.
#   4. Flips simulation_mode to false so real commands actually run.
#
# What this does NOT do (known gaps, not this script's job):
#   - Does not set up a systemd service for server.py — it's still run
#     manually. Worth fixing separately so the Pi doesn't need a manual
#     restart after every reboot, but that's a different task.
#   - Does not touch org_key — that still has to be set manually per customer,
#     since it identifies which business this Block belongs to.

set -e  # stop immediately on any real error — a half-finished provisioning
        # run is worse than one that clearly fails partway through

CONFIG_FILE="$(dirname "$0")/config.json"
LOG_PREFIX="[install.sh]"

echo "$LOG_PREFIX Starting co|op Block provisioning..."

# ── Step 1: confirm real hardware ───────────────────────────────────────────
if [[ "$(uname -s)" != "Linux" ]]; then
  echo "$LOG_PREFIX ERROR: this doesn't look like Linux (got: $(uname -s))."
  echo "$LOG_PREFIX This script is for provisioning real Block hardware only."
  echo "$LOG_PREFIX If you're doing Mac dev testing, leave simulation_mode as-is in config.json — don't run this."
  exit 1
fi

if [[ ! -f "$CONFIG_FILE" ]]; then
  echo "$LOG_PREFIX ERROR: config.json not found at $CONFIG_FILE"
  exit 1
fi

echo "$LOG_PREFIX Confirmed: running on real Linux hardware."

# ── Step 2: check for and install iptables ──────────────────────────────────
if command -v iptables >/dev/null 2>&1; then
  echo "$LOG_PREFIX iptables already installed — good."
else
  echo "$LOG_PREFIX iptables not found. Installing..."
  if command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update -qq
    sudo apt-get install -y iptables
  else
    echo "$LOG_PREFIX ERROR: no apt-get found — this script currently only supports Debian/Raspberry Pi OS."
    echo "$LOG_PREFIX Install iptables manually for your OS, then re-run this script."
    exit 1
  fi

  if command -v iptables >/dev/null 2>&1; then
    echo "$LOG_PREFIX iptables installed successfully."
  else
    echo "$LOG_PREFIX ERROR: iptables install appeared to succeed but the command still isn't found."
    echo "$LOG_PREFIX Not proceeding — running with simulation_mode:false and no working iptables"
    echo "$LOG_PREFIX would recreate the exact false-success bug this script exists to prevent."
    exit 1
  fi
fi

# ── Step 3: generate a real device_key ───────────────────────────────────────
# Format matches the existing SYP-NET-XXXX-XXXX placeholder shape.
# Uses /dev/urandom — no extra dependencies needed, works on any Linux box.
random_segment() {
  tr -dc 'A-Z0-9' < /dev/urandom | head -c 4
}
NEW_DEVICE_KEY="SYP-NET-$(random_segment)-$(random_segment)"
echo "$LOG_PREFIX Generated device key: $NEW_DEVICE_KEY"
echo "$LOG_PREFIX (Note: the backend doesn't use this yet — it's stored locally for when per-device tracking is built.)"

# ── Step 4: update config.json ───────────────────────────────────────────────
# python3 is already a hard dependency of this whole project (server.py etc.),
# so using it here for safe JSON editing is more reliable than sed on JSON.
python3 - "$CONFIG_FILE" "$NEW_DEVICE_KEY" <<'PYEOF'
import json, sys

config_path, new_device_key = sys.argv[1], sys.argv[2]

with open(config_path, 'r') as f:
    config = json.load(f)

was_simulation = config.get('simulation_mode', True)
was_placeholder_key = config.get('device_key', '') in ('SYP-NET-XXXX-XXXX', '', None)

config['simulation_mode'] = False
if was_placeholder_key:
    config['device_key'] = new_device_key
else:
    print(f"[install.sh] device_key already set to something real ({config.get('device_key')}) — leaving it alone.")

with open(config_path, 'w') as f:
    json.dump(config, f, indent=2)

print(f"[install.sh] simulation_mode: {was_simulation} -> False")
PYEOF

echo "$LOG_PREFIX Config updated."
echo "$LOG_PREFIX"
echo "$LOG_PREFIX ⚠️  IMPORTANT — org_key was NOT touched by this script."
echo "$LOG_PREFIX Confirm config.json's org_key matches the real customer's license key before going further."
echo "$LOG_PREFIX"
echo "$LOG_PREFIX Provisioning complete. server.py must be restarted for these changes to take effect:"
echo "$LOG_PREFIX   (stop the current server.py process, then run: python3 server.py)"
echo "$LOG_PREFIX"
echo "$LOG_PREFIX After restart, confirm on the dashboard's Network Security page that the"
echo "$LOG_PREFIX simulation-mode warning banner is gone — that's the real end-to-end proof this worked."
