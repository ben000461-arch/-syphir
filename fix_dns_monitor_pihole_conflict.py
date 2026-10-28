#!/usr/bin/env python3
"""
fix_dns_monitor_pihole_conflict.py

Real fix for the port 53 conflict caught during the first live run of
server.py today: RealDNSListener binds its own raw UDP socket on port
53 to watch DNS queries directly - but Pi-hole is ALSO bound to that
same port, since that's Pi-hole's whole job. Confirmed via `ss -tulpn`
showing both processes attached to :53 at the same time. Since Pi-hole
is a fixed, permanent part of Block's stack, not a competing program,
that's the wrong design for the real setup - Pi-hole already sees
every query, so this reads from Pi-hole's own log instead of standing
up a second listener to fight it for the same port.

New PiholeLogListener class:
  - Polls Pi-hole's own SQLite database (/etc/pihole/pihole-FTL.db,
    `queries` view) every 2 seconds for new rows since the last check
  - Opens it read-only (mode=ro) - Pi-hole's own FTL service writes to
    this file constantly, we never want to risk locking it
  - Produces the EXACT same event shape RealDNSListener did (domain,
    ip, timestamp, bytes, source) so nothing downstream in server.py
    needs to change at all - this is a drop-in swap
  - Same domain filtering RealDNSListener already did (skip .local,
    skip anything without a dot)

RealDNSListener itself is left in the file, untouched, just no longer
wired up as the live-mode default - it's not deletable-safe to remove
outright tonight, but it's also never going to be correct for this
product's real architecture (Pi-hole is permanent), so it's dead code
now, left in place with a comment explaining why rather than silently
vanishing.

Usage (run this ON THE PI, from inside Block_device/):
    cd ~/-syphir/Block_device
    python3 fix_dns_monitor_pihole_conflict.py
"""

import sys
from pathlib import Path

TARGET = Path(__file__).resolve().parent / "dns_monitor.py"

IMPORT_OLD = "import json\nimport time\nimport socket"
IMPORT_NEW = "import json\nimport time\nimport socket\nimport sqlite3"

# The chunk of new code to insert, placed right before "class SimDNSListener:"
NEW_CLASS_CODE = '''

# ---- Pi-hole log listener (real deployment - reads Pi-hole's own DB) ----

class PiholeLogListener:
    """
    Reads DNS queries from Pi-hole's own database instead of binding a
    competing raw socket. Pi-hole already sees every query on the
    network - this polls the data it's already collecting rather than
    fighting it for port 53.
    """

    PIHOLE_DB    = '/etc/pihole/pihole-FTL.db'
    POLL_SECONDS = 2

    def __init__(self, callback):
        self.callback  = callback
        self._running  = False
        self._last_id  = 0

    def start(self):
        self._running = True
        try:
            conn = self._connect()
            cur  = conn.cursor()
            cur.execute('SELECT MAX(id) FROM queries')
            row  = cur.fetchone()
            self._last_id = row[0] or 0
            conn.close()
        except Exception as e:
            log.error(f"Could not read Pi-hole database: {e}")
            raise
        threading.Thread(target=self._poll_loop, daemon=True, name='pihole-log-listener').start()
        log.info(f"DNS listener reading Pi-hole query log (starting after id {self._last_id})")

    def stop(self):
        self._running = False

    def _connect(self):
        # Read-only - Pi-hole's own FTL service writes to this file
        # constantly, we never want to risk locking it from our side.
        return sqlite3.connect(f'file:{self.PIHOLE_DB}?mode=ro', uri=True)

    def _poll_loop(self):
        log.info("Pi-hole log listener active - watching query log")
        while self._running:
            try:
                conn = self._connect()
                cur  = conn.cursor()
                cur.execute(
                    'SELECT id, timestamp, domain, client FROM queries WHERE id > ? ORDER BY id ASC',
                    (self._last_id,)
                )
                rows = cur.fetchall()
                conn.close()

                for qid, ts, domain, client in rows:
                    self._last_id = qid
                    if not domain or domain.endswith('.local') or '.' not in domain:
                        continue
                    self.callback({
                        'domain':    domain,
                        'ip':        client,
                        'timestamp': datetime.utcfromtimestamp(ts).isoformat(),
                        'bytes':     self._estimate_query_size(domain),
                        'source':    'dns',
                    })
            except Exception as e:
                if self._running:
                    log.debug(f"Pi-hole log poll error: {e}")

            time.sleep(self.POLL_SECONDS)

    def _estimate_query_size(self, domain):
        # Same conservative placeholder RealDNSListener used - Pi-hole's
        # log doesn't record payload size either.
        return 1024

'''

START_OLD = '''        if self._sim_mode:
            self._listener = SimDNSListener(callback=self._handle_event)
            log.info("DNS monitor starting in simulation mode")
        else:
            interface = self.config.get('listen_interface', '0.0.0.0')
            self._listener = RealDNSListener(callback=self._handle_event, interface=interface)
            log.info("DNS monitor starting in live mode")

        self._listener.start()'''

START_NEW = '''        if self._sim_mode:
            self._listener = SimDNSListener(callback=self._handle_event)
            log.info("DNS monitor starting in simulation mode")
        else:
            # PiholeLogListener, not RealDNSListener - Pi-hole is a
            # fixed, permanent part of Block's stack, and RealDNSListener's
            # raw socket on port 53 directly conflicts with it (confirmed
            # via a real port conflict during the first live server.py run).
            # Read Pi-hole's own log instead of competing with it.
            self._listener = PiholeLogListener(callback=self._handle_event)
            log.info("DNS monitor starting in live mode (reading Pi-hole log)")

        self._listener.start()'''

# Unique, simple marker to anchor the insertion point - no decorative
# characters, so there's zero risk of a hand-typed-dash-count mismatch.
INSERT_BEFORE_MARKER = "class SimDNSListener:"


def fail(msg):
    print(f"\n\u274c ABORTED: {msg}")
    print("Nothing was written.")
    sys.exit(1)


def main():
    print("co|op Block: fix DNS monitor port 53 conflict with Pi-hole\n")

    if not TARGET.exists():
        fail(f"dns_monitor.py not found at {TARGET} - run this from inside Block_device/")

    content = TARGET.read_text(encoding="utf-8")

    if content.count(INSERT_BEFORE_MARKER) != 1:
        fail(f"Expected 1 match for 'class SimDNSListener:', found {content.count(INSERT_BEFORE_MARKER)}. File may have changed.")
    if content.count(START_OLD) != 1:
        fail(f"Expected 1 match for the DNSMonitor.start() block, found {content.count(START_OLD)}. File may have changed.")
    if content.count(IMPORT_OLD) != 1:
        fail(f"Expected 1 match for the import block, found {content.count(IMPORT_OLD)}. File may have changed.")
    if "class PiholeLogListener" in content:
        fail("PiholeLogListener already exists in this file - looks like this fix already ran.")

    # Insert the new class right before "class SimDNSListener:"
    content = content.replace(INSERT_BEFORE_MARKER, NEW_CLASS_CODE.strip("\n") + "\n\nclass SimDNSListener:", 1)
    content = content.replace(START_OLD, START_NEW)
    content = content.replace(IMPORT_OLD, IMPORT_NEW)

    TARGET.write_text(content, encoding="utf-8")
    print("\u2713 dns_monitor.py updated")
    print("  - Added: import sqlite3")
    print("  - Added PiholeLogListener (reads Pi-hole's own DB, no port conflict)")
    print("  - DNSMonitor now uses it in live mode instead of RealDNSListener")
    print("\n\u2705 Done.")
    print("\nNext:")
    print("1. python3 -c \"import ast; ast.parse(open('dns_monitor.py').read())\"  # syntax check")
    print("2. Start server.py again and confirm: no more iptables errors changing")
    print("   this, and the log line now reads 'reading Pi-hole log' not 'bound to'")
    print("3. Once confirmed working: git add dns_monitor.py && git commit -m")
    print("   'Fix DNS monitor port 53 conflict - read Pi-hole log instead' && git push")
    print("   (so this fix is in the actual repo, not just this Pi's local copy)")


if __name__ == "__main__":
    main()
