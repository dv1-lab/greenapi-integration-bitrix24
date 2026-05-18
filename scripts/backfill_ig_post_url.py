#!/usr/bin/env python3
"""Разовый backfill UF_CRM_1637656407829 = URL поста IG для исторических
IG-Comment лидов. На B24-стороне настроен бизнес-процесс который копирует
значение из этого поля в UF_CRM_1638376742616 («Link0 активная ссылка на
пост источника лида»). До 2026-05-18 adapter писал URL поста в multifield
LINK[VALUE_TYPE=LINK0] (отображалось в UI как «Link 1»), теперь — в
UF_CRM_1637656407829 + BP.

Идём только по in-work лидам с пустым UF_CRM_1637656407829, у которых
в multifield LINK есть запись типа LINK0 с URL содержащим instagram.com/p/.
URL берём оттуда (там уже сидит post URL + ?comment_id=...).

Запуск:
    cd /home/dv/greenapi-b24/source
    PYTHONUNBUFFERED=1 RATE_DELAY=1.0 python3 scripts/backfill_ig_post_url.py
"""
import os
import sys
import time
from threading import Lock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from migrate_ig_username import Bitrix, load_env  # type: ignore

RATE_DELAY = float(os.environ.get("RATE_DELAY", "1.0"))
BLOCK_BASE_SEC = int(os.environ.get("BLOCK_BASE_SEC", "180"))
BLOCK_STEP_SEC = int(os.environ.get("BLOCK_STEP_SEC", "60"))

IN_WORK_STAGES = [
    "NEW", "UC_C2LTOB", "UC_57D70Q", "IN_PROCESS",
    "UC_QK14E6", "8", "UC_4D3GN5", "UC_3SQOCQ",
    "3", "UC_G7R3YA", "1", "9",
]

_block_until = 0.0
_block_lock = Lock()


def wait_if_blocked():
    while True:
        with _block_lock:
            r = _block_until - time.time()
        if r <= 0:
            return
        time.sleep(min(r, 5))


def mark_blocked(s):
    global _block_until
    with _block_lock:
        _block_until = max(_block_until, time.time() + s)
    print(f"  [block] paused for {s}s", flush=True)


def extract_post_url(lead):
    """Из multifield LINK достаём VALUE_TYPE=LINK0 с instagram.com/p/."""
    links = lead.get("LINK") if isinstance(lead.get("LINK"), list) else []
    for l in links:
        if isinstance(l, dict) and l.get("VALUE_TYPE") == "LINK0":
            v = str(l.get("VALUE") or "")
            if "instagram.com/p/" in v:
                return v
    return None


def list_candidates(bx):
    print("=== fetching in-work leads with empty UF_CRM_1637656407829 ===", flush=True)
    all_items = []
    start = 0
    while True:
        wait_if_blocked()
        try:
            params = {
                "filter[=UF_CRM_1637656407829]": "",
                "select[0]": "ID",
                "select[1]": "LINK",
                "start": start,
            }
            for i, st in enumerate(IN_WORK_STAGES):
                params[f"filter[@STATUS_ID][{i}]"] = st
            r = bx.call("crm.lead.list", params, timeout=60)
        except Exception as e:
            if "OPERATION_TIME_LIMIT" in str(e):
                mark_blocked(BLOCK_BASE_SEC)
                continue
            print(f"  list failed at start={start}: {e}", flush=True)
            break
        items = r.get("result", []) or []
        if not items:
            break
        all_items.extend(items)
        total = r.get("total", 0)
        print(f"  fetched {len(all_items)}/{total}", flush=True)
        nxt = r.get("next")
        if nxt is None:
            break
        start = nxt
        time.sleep(RATE_DELAY)
    return all_items


def update_one(bx, lead_id, url, counters):
    for attempt in range(1, 5):
        wait_if_blocked()
        try:
            bx.call("crm.lead.update", {
                "id": lead_id,
                "fields[UF_CRM_1637656407829]": url,
            }, timeout=60)
            if RATE_DELAY > 0:
                time.sleep(RATE_DELAY)
            counters["upd"] += 1
            return
        except Exception as e:
            if "OPERATION_TIME_LIMIT" in str(e) and attempt < 4:
                mark_blocked(BLOCK_BASE_SEC + attempt * BLOCK_STEP_SEC)
                continue
            counters["errors"] += 1
            if counters["errors"] <= 15:
                print(f"  lead {lead_id} attempt {attempt}: {e}", flush=True)
            return


def main():
    env = load_env()
    bx = Bitrix(env)
    bx.refresh()
    items = list_candidates(bx)
    targets = []
    for lead in items:
        url = extract_post_url(lead)
        if url:
            targets.append((int(lead["ID"]), url))
    print(f"=== total leads checked: {len(items)}, with IG post URL to copy: {len(targets)} ===", flush=True)
    if not targets:
        print("nothing to backfill", flush=True)
        return
    counters = {"upd": 0, "errors": 0}
    total = len(targets)
    t0 = time.time()
    for i, (lid, url) in enumerate(targets, 1):
        update_one(bx, lid, url, counters)
        if i % 25 == 0 or i == total:
            elapsed = time.time() - t0
            rate = i / elapsed if elapsed else 0
            eta = (total - i) / rate / 60 if rate else 0
            print(
                f"  progress {i}/{total} upd={counters['upd']} errors={counters['errors']} "
                f"rate={rate:.2f}/s ETA={eta:.1f}min",
                flush=True,
            )
    print(f"=== DONE upd={counters['upd']} errors={counters['errors']} ===", flush=True)


if __name__ == "__main__":
    main()
