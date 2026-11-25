#!/bin/bash
# usage: run.sh PORT USERS SECS CONC [phases]   (env: DB_FILE, VIES_MS)
rm -f /tmp/perf.db*; cd /downloads/perf
PORT=$1 DB_FILE=/tmp/perf.db node server.mjs > /tmp/perf-srv.log 2>&1 &
SP=$!; sleep 1.5
node /downloads/perf/load.mjs http://127.0.0.1:$1 $2 $3 $4 $5
kill -USR2 $SP; sleep 0.3; grep STATS /tmp/perf-srv.log
echo "server RSS MB: $(( $(grep VmRSS /proc/$SP/status | awk '{print $2}') / 1024 ))"
kill $SP
