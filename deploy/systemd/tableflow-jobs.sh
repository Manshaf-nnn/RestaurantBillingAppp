#!/bin/sh
# ============================================================================
# Ticks the TableFlow background job runner.  →  /usr/local/bin/tableflow-jobs.sh
#   install -m 0750 -o root -g root deploy/systemd/tableflow-jobs.sh \
#           /usr/local/bin/tableflow-jobs.sh
#
# A wrapper script rather than an inline ExecStart= because systemd's ${VAR}
# expansion does not survive being embedded inside a quoted header argument.
#
# `curl -f` exits non-zero on the 500 the route returns when a run fails, so
# real failures show up in `systemctl status` and journalctl instead of being
# logged as a successful tick.
# ============================================================================
set -eu

# JOBS_SECRET lives here, root-owned and 0600 — deliberately not the app's
# .env, which is owned by the tableflow user.
. /etc/tableflow/jobs.env

exec curl -fsS --max-time 300 -X POST \
  -H "authorization: Bearer ${JOBS_SECRET}" \
  -H "content-type: application/json" \
  -d '{"source":"systemd"}' \
  http://127.0.0.1:3010/api/jobs/run
