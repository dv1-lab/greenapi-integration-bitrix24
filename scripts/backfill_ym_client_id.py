#!/usr/bin/env python3
"""Разовый backfill UF_CRM_NF_YM_CLIENT_ID="-" для всех открытых лидов
без значения. С сайта это поле заполняется через NetForm, у лидов из
мессенджеров его нет. B24 требует поле при смене стадии — оператор
не может двинуть лид. Дмитрий попросил проставить "-" всем открытым.

Запуск:
    cd /home/dv/greenapi-b24/source
    PYTHONUNBUFFERED=1 RATE_DELAY=3.0 python3 scripts/backfill_ym_client_id.py

Идемпотентно: повторный запуск возьмёт только тех, у кого поле всё ещё пустое.
"""
import os
import sys
import time
from threading import Lock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from migrate_ig_username import Bitrix, load_env  # type: ignore

RATE_DELAY = float(os.environ.get("RATE_DELAY", "3.0"))
BLOCK_BASE_SEC = int(os.environ.get("BLOCK_BASE_SEC", "180"))
BLOCK_STEP_SEC = int(os.environ.get("BLOCK_STEP_SEC", "60"))

_block_until = 0.0
_block_lock = Lock()


def wait_if_blocked():
    while True:
        with _block_lock:
            remaining = _block_until - time.time()
        if remaining <= 0:
            return
        time.sleep(min(remaining, 5))


def mark_blocked(seconds):
    global _block_until
    with _block_lock:
        _block_until = max(_block_until, time.time() + seconds)
    print(f"  [block] paused for {seconds}s (OPERATION_TIME_LIMIT)", flush=True)


def list_targets(bx):
    """Возвращает список ID открытых лидов без UF_CRM_NF_YM_CLIENT_ID."""
    print("=== fetching list of open leads without YM_CLIENT_ID ===", flush=True)
    all_ids = []
    start = 0
    while True:
        wait_if_blocked()
        try:
            r = bx.call("crm.lead.list", {
                "filter[!STATUS_SEMANTIC_ID]": "F",
                "filter[=UF_CRM_NF_YM_CLIENT_ID]": "",
                "select[0]": "ID",
                "start": start,
            }, timeout=60)
        except Exception as e:
            if "OPERATION_TIME_LIMIT" in str(e):
                mark_blocked(BLOCK_BASE_SEC)
                continue
            print(f"  list failed at start={start}: {e}", flush=True)
            break
        items = r.get("result", []) or []
        if not items:
            break
        all_ids.extend(int(x["ID"]) for x in items)
        total = r.get("total", 0)
        print(f"  fetched {len(all_ids)}/{total}", flush=True)
        next_start = r.get("next")
        if next_start is None:
            break
        start = next_start
        time.sleep(RATE_DELAY)
    print(f"=== total targets: {len(all_ids)} ===", flush=True)
    return all_ids


def update_one(bx, lead_id, counters):
    for attempt in range(1, 5):
        wait_if_blocked()
        try:
            bx.call("crm.lead.update", {
                "id": lead_id,
                "fields[UF_CRM_NF_YM_CLIENT_ID]": "-",
            }, timeout=60)
            if RATE_DELAY > 0:
                time.sleep(RATE_DELAY)
            counters["upd"] += 1
            return True
        except Exception as e:
            msg = str(e)
            if "OPERATION_TIME_LIMIT" in msg and attempt < 4:
                mark_blocked(BLOCK_BASE_SEC + attempt * BLOCK_STEP_SEC)
                continue
            counters["errors"] += 1
            if counters["errors"] <= 15:
                print(f"  lead {lead_id} attempt {attempt}: {e}", flush=True)
            return False
    return False


def main():
    env = load_env()
    bx = Bitrix(env)
    bx.refresh()
    ids = list_targets(bx)
    if not ids:
        print("nothing to backfill", flush=True)
        return
    counters = {"upd": 0, "errors": 0}
    total = len(ids)
    t0 = time.time()
    for i, lead_id in enumerate(ids, 1):
        update_one(bx, lead_id, counters)
        if i % 100 == 0 or i == total:
            elapsed = time.time() - t0
            rate = i / elapsed if elapsed else 0
            eta_min = (total - i) / rate / 60 if rate else 0
            print(
                f"  progress {i}/{total} upd={counters['upd']} errors={counters['errors']} "
                f"rate={rate:.2f}/s ETA={eta_min:.1f}min",
                flush=True,
            )
    print(f"=== DONE upd={counters['upd']} errors={counters['errors']} ===", flush=True)


if __name__ == "__main__":
    main()
