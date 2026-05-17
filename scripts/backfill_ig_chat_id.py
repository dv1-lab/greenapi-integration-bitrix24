#!/usr/bin/env python3
"""Бэкфилл UF_CRM_IG_CHAT_ID для исторических Instagram-лидов из USER_CODE.

В B24 в crm.activity (PROVIDER_ID=IMOPENLINES_SESSION, PROVIDER_TYPE_ID=18/22)
лежат сессии открытых линий 18 (Direct) и 22 (Comment). У старых, созданных
через i2crm-нативный коннектор, в PROVIDER_PARAMS.USER_CODE зашит Meta client_id:

    i2crm|18|inst-<client_id>-<account_id>|<b24_user>
    i2crm|22|inst-<client_id>-<media_id>_<account_id>-<comment_id>|<b24_user>

Скрипт:
1. Постранично проходит активности обеих линий.
2. Парсит USER_CODE → client_id.
3. Группирует по OWNER_ID (B24 лид) — один лид может иметь много активностей.
4. Для каждого уникального лида: lead.get → если UF_CRM_IG_CHAT_ID пусто,
   записываем. Если CONTACT_ID есть → contact.get → запись на контакт.

Запуск:
    python3 backfill_ig_chat_id.py
Эконом: --dry-run через DRY_RUN=1.
"""
import os
import re
import sys
import time
import requests
from concurrent.futures import ThreadPoolExecutor, as_completed
from threading import Lock

# Импортируем хелперы из migrate_ig_username (та же auth-логика)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from migrate_ig_username import Bitrix, load_env, PORTAL  # type: ignore

DRY_RUN = os.environ.get("DRY_RUN", "0") == "1"
RATE_DELAY = float(os.environ.get("RATE_DELAY", "0.25"))

# USER_CODE формата i2crm|<line>|inst-<client_id>-...|<b24_user>
USER_CODE_RE = re.compile(r"^i2crm\|\d+\|inst-(\d+)[-_]")


def _parse_activity_to_entry(a, line_id):
    """Парсит активность → (lead_id, entry) или None."""
    if a.get("OWNER_TYPE_ID") != "1":
        return None
    pp = a.get("PROVIDER_PARAMS") or {}
    uc = pp.get("USER_CODE") if isinstance(pp, dict) else None
    if not uc:
        return None
    m = USER_CODE_RE.match(uc)
    if not m:
        return None
    client_id = m.group(1)
    lead_id = int(a["OWNER_ID"])
    entry = {"client_id": client_id, "media_id": None, "comment_id": None}
    if line_id == 22:
        m2 = re.match(r"^i2crm\|22\|inst-\d+-(\d+)_\d+-(\d+)", uc)
        if m2:
            entry["media_id"] = m2.group(1)
            entry["comment_id"] = m2.group(2)
    return lead_id, entry


def _get_total_activities(bx, line_id):
    """Один list-запрос чтобы узнать total — далее распределим страницы по worker'ам."""
    r = bx.call("crm.activity.list", {
        "filter[PROVIDER_ID]": "IMOPENLINES_SESSION",
        "filter[PROVIDER_TYPE_ID]": str(line_id),
        "select[0]": "ID",
        "start": 0,
    })
    return r.get("total", 0)


def collect_lead_to_client_parallel(bx, line_id, num_workers, lead_data, lock):
    """Параллельный сбор: total делим на num_workers диапазонов, каждый worker
    идёт sequentially по своему диапазону страниц. Пишут в общий lead_data."""
    total = _get_total_activities(bx, line_id)
    print(f"  line {line_id}: total={total}, splitting into {num_workers} workers", flush=True)
    if total == 0:
        return

    # Распределяем по worker'ам: каждый берёт каждую N-ю страницу (start=0, 50N, 100N, ...)
    # B24 next-pagination игнорируем — используем абсолютный start.
    # Каждая страница = 50 записей.
    pages_per_worker = (total + 49) // 50  # всего страниц
    # На worker'а: каждый i-й worker берёт страницы (i, i+N, i+2N, ...)
    progress = {"scanned": 0}

    def worker(worker_idx):
        page_starts = list(range(worker_idx * 50, total, num_workers * 50))
        for start in page_starts:
            try:
                r = bx.call("crm.activity.list", {
                    "filter[PROVIDER_ID]": "IMOPENLINES_SESSION",
                    "filter[PROVIDER_TYPE_ID]": str(line_id),
                    "select[0]": "ID",
                    "select[1]": "OWNER_ID",
                    "select[2]": "OWNER_TYPE_ID",
                    "select[3]": "PROVIDER_PARAMS",
                    "order[ID]": "DESC",
                    "start": start,
                }, timeout=60)
            except Exception as e:
                print(f"  line {line_id} w{worker_idx} list error at start={start}: {e}", flush=True)
                time.sleep(5)
                continue
            items = r.get("result", []) or []
            if not items:
                continue
            for a in items:
                parsed = _parse_activity_to_entry(a, line_id)
                if not parsed:
                    continue
                lead_id, entry = parsed
                with lock:
                    if lead_id not in lead_data:
                        lead_data[lead_id] = entry
                    elif entry.get("media_id") and not lead_data[lead_id].get("media_id"):
                        # Comment-данные приоритетнее (есть media/comment id)
                        lead_data[lead_id] = entry
            with lock:
                progress["scanned"] += len(items)
                if progress["scanned"] % 5000 < 50:
                    print(f"  line {line_id}: scanned {progress['scanned']}/{total}, "
                          f"unique leads total: {len(lead_data)}", flush=True)

    with ThreadPoolExecutor(max_workers=num_workers) as ex:
        futures = [ex.submit(worker, i) for i in range(num_workers)]
        for _ in as_completed(futures):
            pass
    print(f"  line {line_id} done: scanned ~{progress['scanned']} activities", flush=True)


def fetch_lead_state(bx, lead_ids):
    """Берёт CONTACT_ID, LINK, UF_CRM_IG_CHAT_ID для всех лидов одним bulk-запросом
    через crm.lead.list с filter[@ID][]. Возвращает dict {lead_id: {contact_id, link, chat_id_present}}.
    Чанки по 50 — B24 list большие filter обрабатывает медленно."""
    print(f"\n=== fetching state for {len(lead_ids)} leads ===", flush=True)
    result = {}
    ids = list(lead_ids)
    for ci in range(0, len(ids), 50):
        chunk = ids[ci:ci+50]
        try:
            params = {
                "select[0]": "ID",
                "select[1]": "CONTACT_ID",
                "select[2]": "LINK",
                "select[3]": "UF_CRM_IG_CHAT_ID",
            }
            for i, lid in enumerate(chunk):
                params[f"filter[@ID][{i}]"] = str(lid)
            r = bx.call("crm.lead.list", params, timeout=60)
            for item in r.get("result", []) or []:
                lid = int(item["ID"])
                cid = item.get("CONTACT_ID")
                link = item.get("LINK")
                result[lid] = {
                    "contact_id": int(cid) if cid else None,
                    "link": link if isinstance(link, list) else [],
                    "chat_id_already": bool(item.get("UF_CRM_IG_CHAT_ID")),
                }
        except Exception as e:
            print(f"  fetch state chunk {ci} failed: {e}", flush=True)
        if (ci // 50 + 1) % 20 == 0:
            print(f"  state fetched {min(ci + 50, len(ids))}/{len(ids)} leads", flush=True)
    print(f"  total: {len(result)}, with contact: {sum(1 for v in result.values() if v['contact_id'])}, "
          f"chat_id already set: {sum(1 for v in result.values() if v['chat_id_already'])}", flush=True)
    return result


def backfill_leads(bx, lead_data):
    """Параллельный backfill: 2 потока, без предварительного lead.get/contact.get.
    Update'ы безусловно перезаписывают UF_CRM_IG_CHAT_ID (по client_id из USER_CODE — safe).
    Для LINK0 на comment-лидах — append через специальный API B24 без чтения LINK[]."""
    from concurrent.futures import ThreadPoolExecutor, as_completed
    from threading import Lock

    lead_ids = list(lead_data.keys())
    lead_state = fetch_lead_state(bx, lead_ids)

    print(f"\n=== backfilling {len(lead_data)} leads (2 threads, bulk state pre-fetched) ===", flush=True)
    counters = {"leads_upd": 0, "leads_skip": 0, "contacts_upd": 0, "links_upd": 0, "errors": 0, "done": 0}
    lock = Lock()
    total = len(lead_data)

    def process_one(lead_id):
        info = lead_data[lead_id]
        state = lead_state.get(lead_id) or {"contact_id": None, "link": [], "chat_id_already": False}
        client_id = info["client_id"]
        post_url = None
        if info.get("media_id") and info.get("comment_id"):
            post_url = f"https://www.instagram.com/p/{info['media_id']}/?comment_id={info['comment_id']}"

        # Если UF уже заполнен И LINK0 уже добавлен — пропускаем (idempotency)
        existing_link0 = next(
            (l for l in (state["link"] or []) if isinstance(l, dict) and l.get("VALUE_TYPE") == "LINK0"),
            None,
        )
        need_chat_id = not state["chat_id_already"]
        need_link0 = post_url and (not existing_link0 or existing_link0.get("VALUE") != post_url)

        if not need_chat_id and not need_link0 and not state["contact_id"]:
            with lock:
                counters["leads_skip"] += 1
                counters["done"] += 1
            return

        # 1. UPDATE LEAD: UF_CRM_IG_CHAT_ID + (для comment) LINK с сохранением существующих
        if need_chat_id or need_link0:
            lead_params = {"id": lead_id}
            if need_chat_id:
                lead_params["fields[UF_CRM_IG_CHAT_ID]"] = client_id
            if need_link0:
                # Сохраняем все НЕ-LINK0 значения и добавляем/обновляем LINK0
                new_links = []
                for l in (state["link"] or []):
                    if isinstance(l, dict) and l.get("VALUE_TYPE") != "LINK0":
                        new_links.append({
                            "ID": l.get("ID"),
                            "VALUE": l.get("VALUE"),
                            "VALUE_TYPE": l.get("VALUE_TYPE"),
                        })
                new_links.append({"VALUE": post_url, "VALUE_TYPE": "LINK0"})
                for i, link in enumerate(new_links):
                    for k, v in link.items():
                        if v is not None:
                            lead_params[f"fields[LINK][{i}][{k}]"] = str(v)
            ok = retry_call(bx, "crm.lead.update", lead_params, counters, lock, lead_id)
            if ok:
                with lock:
                    counters["leads_upd"] += 1
                    if need_link0:
                        counters["links_upd"] += 1

        # 2. UPDATE CONTACT (если есть) — overwrite UF_CRM_IG_CHAT_ID
        # (если уже есть верное значение — overwrite самим собой, безопасно)
        contact_id = state["contact_id"]
        if contact_id:
            ok2 = retry_call(bx, "crm.contact.update", {
                "id": contact_id,
                "fields[UF_CRM_IG_CHAT_ID]": client_id,
            }, counters, lock, contact_id)
            if ok2:
                with lock:
                    counters["contacts_upd"] += 1

        with lock:
            counters["done"] += 1
            if counters["done"] % 100 == 0:
                print(f"  progress {counters['done']}/{total} "
                      f"leads_upd={counters['leads_upd']} leads_skip={counters['leads_skip']} "
                      f"contacts_upd={counters['contacts_upd']} links_upd={counters['links_upd']} "
                      f"errors={counters['errors']}", flush=True)

    if DRY_RUN:
        print("DRY_RUN: would update", total, "leads")
        return

    # 4 потока — больше может упереться в OPERATION_TIME_LIMIT (но retry поможет).
    with ThreadPoolExecutor(max_workers=4) as ex:
        futures = [ex.submit(process_one, lid) for lid in lead_ids]
        for _ in as_completed(futures):
            pass

    print(f"\n=== DONE: leads_upd={counters['leads_upd']} leads_skip={counters['leads_skip']} "
          f"contacts_upd={counters['contacts_upd']} links_upd={counters['links_upd']} "
          f"errors={counters['errors']} ===", flush=True)


def retry_call(bx, method, params, counters, lock, item_id, kind="lead"):
    """Update с retry на OPERATION_TIME_LIMIT (sleep 60/90/120s)."""
    for attempt, delay in enumerate([60, 90, 120, 180], 1):
        try:
            bx.call(method, params, timeout=60)
            return True
        except Exception as e:
            msg = str(e)
            if "OPERATION_TIME_LIMIT" in msg and attempt < 4:
                time.sleep(delay)
                continue
            with lock:
                counters["errors"] += 1
                if counters["errors"] <= 15:
                    print(f"  {method} {item_id} (attempt {attempt}): {e}", flush=True)
            return False
    return False


def main():
    env = load_env()
    bx = Bitrix(env)
    bx.refresh()
    # Защитим refresh от race condition при многопотоке
    if not hasattr(bx, "_refresh_lock"):
        bx._refresh_lock = Lock()
        _orig_refresh = bx.refresh
        def _safe_refresh():
            with bx._refresh_lock:
                _orig_refresh()
        bx.refresh = _safe_refresh

    # Параллельный сбор обеих линий + параллельная pagination внутри line 18.
    # Line 18 — ~90k activities, выделим 2 worker'а
    # Line 22 — ~30k activities, 1 worker'а достаточно
    # Total 3 потока на B24 — приемлемо.
    merged = {}
    lock = Lock()

    print("\n=== collecting line 18 + line 22 IN PARALLEL ===", flush=True)
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=2) as ex:
        f18 = ex.submit(collect_lead_to_client_parallel, bx, 18, 2, merged, lock)
        f22 = ex.submit(collect_lead_to_client_parallel, bx, 22, 1, merged, lock)
        for _ in as_completed([f18, f22]):
            pass
    print(f"\ncollect total: {len(merged)} unique leads in {int(time.time()-t0)}s", flush=True)

    backfill_leads(bx, merged)


if __name__ == "__main__":
    main()
