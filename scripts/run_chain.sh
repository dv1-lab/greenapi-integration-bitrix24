#!/bin/bash
# Ждёт завершения migrate_ig_username, затем запускает backfill_ig_chat_id.
set -e
LOG=/home/dv/greenapi-b24/chain.log
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Waiting for mig_ig tmux session to finish..." | tee -a $LOG
while tmux has-session -t mig_ig 2>/dev/null; do
  sleep 30
done
echo "[$(date '+%Y-%m-%d %H:%M:%S')] mig_ig finished, sleeping 120s to let B24 quota recover..." | tee -a $LOG
sleep 120
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting backfill_ig_chat_id..." | tee -a $LOG
cd /home/dv/greenapi-b24/source
PYTHONUNBUFFERED=1 RATE_DELAY=0.5 python3 scripts/backfill_ig_chat_id.py 2>&1 | tee -a /home/dv/greenapi-b24/backfill_ig_chat_id.log
echo "[$(date '+%Y-%m-%d %H:%M:%S')] backfill_ig_chat_id done" | tee -a $LOG
