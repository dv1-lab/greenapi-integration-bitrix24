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

# Импортируем хелперы из migrate_ig_username (та же auth-логика)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from migrate_ig_username import Bitrix, load_env, PORTAL  # type: ignore

DRY_RUN = os.environ.get("DRY_RUN", "0") == "1"
RATE_DELAY = float(os.environ.get("RATE_DELAY", "0.25"))

# USER_CODE формата i2crm|<line>|inst-<client_id>-...|<b24_user>
USER_CODE_RE = re.compile(r"^i2crm\|\d+\|inst-(\d+)[-_]")


def collect_lead_to_client(bx, line_id):
    """Возвращает dict {lead_id: {'client_id': str, 'media_id': str|None, 'comment_id': str|None}}.
    Берём ПЕРВУЮ встреченную активность для каждого лида (DESC order — самая свежая).
    """
    print(f"\n=== collecting line {line_id} activities ===", flush=True)
    lead_data = {}
    start = 0
    pages = 0
    total = None
    while True:
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
            })
        except Exception as e:
            print(f"  list error at start={start}: {e}", flush=True)
            time.sleep(5)
            continue
        items = r.get("result", []) or []
        if not items:
            break
        if total is None:
            total = r.get("total", 0)
            print(f"  total activities: {total}", flush=True)
        for a in items:
            if a.get("OWNER_TYPE_ID") != "1":
                continue  # только лиды
            pp = a.get("PROVIDER_PARAMS") or {}
            uc = pp.get("USER_CODE") if isinstance(pp, dict) else None
            if not uc:
                continue
            m = USER_CODE_RE.match(uc)
            if not m:
                continue
            client_id = m.group(1)
            lead_id = int(a["OWNER_ID"])
            if lead_id in lead_data:
                continue
            entry = {"client_id": client_id, "media_id": None, "comment_id": None}
            # Для Comment вытаскиваем media_id + comment_id
            if line_id == 22:
                # inst-<cid>-<media>_<acc>-<comment>
                m2 = re.match(r"^i2crm\|22\|inst-\d+-(\d+)_\d+-(\d+)", uc)
                if m2:
                    entry["media_id"] = m2.group(1)
                    entry["comment_id"] = m2.group(2)
            lead_data[lead_id] = entry
        pages += 1
        if pages % 10 == 0:
            print(f"  scanned {start + len(items)}/{total} activities, "
                  f"unique leads collected: {len(lead_data)}", flush=True)
        nxt = r.get("next")
        if nxt is None or nxt == start:
            break
        start = nxt
    print(f"  line {line_id} done: scanned ~{start} activities, unique i2crm-leads: {len(lead_data)}", flush=True)
    return lead_data


def backfill_leads(bx, lead_data):
    print(f"\n=== backfilling {len(lead_data)} leads ===", flush=True)
    updated_leads = 0
    updated_contacts = 0
    updated_links = 0
    skipped_lead_no_change = 0
    skipped_contact_no_change = 0
    errors = 0
    done = 0

    for lead_id, info in lead_data.items():
        done += 1
        client_id = info["client_id"]
        try:
            lead = bx.call("crm.lead.get", {"id": lead_id}).get("result", {})
        except Exception as e:
            errors += 1
            print(f"  lead.get {lead_id} failed: {e}", flush=True)
            continue

        # Подготавливаем апдейт лида
        lead_fields = {}
        if not lead.get("UF_CRM_IG_CHAT_ID"):
            lead_fields["fields[UF_CRM_IG_CHAT_ID]"] = client_id

        # LINK0 (URL поста) — если знаем media_id, пробуем построить URL из comment_id
        # У i2crm нет shortcode, но можем использовать media_id как fallback в URL
        # к конкретному комменту. Меньшее зло чем оставить пусто.
        if info.get("media_id") and info.get("comment_id"):
            post_url = f"https://www.instagram.com/p/{info['media_id']}/?comment_id={info['comment_id']}"
            existing_links = lead.get("LINK") or []
            has_link0 = any(l.get("VALUE_TYPE") == "LINK0" for l in existing_links) if isinstance(existing_links, list) else False
            if not has_link0:
                new_links = [{"ID": l["ID"], "VALUE": l["VALUE"], "VALUE_TYPE": l["VALUE_TYPE"]}
                             for l in existing_links] if isinstance(existing_links, list) else []
                new_links.append({"VALUE": post_url, "VALUE_TYPE": "LINK0"})
                # B24 multifield update — отдельным ключом в fields
                # Для form-encoded: fields[LINK][0][VALUE]=..., fields[LINK][0][VALUE_TYPE]=...
                for i, link in enumerate(new_links):
                    for k, v in link.items():
                        lead_fields[f"fields[LINK][{i}][{k}]"] = str(v)
                updated_links += 1

        if not lead_fields:
            skipped_lead_no_change += 1
        elif not DRY_RUN:
            try:
                bx.call("crm.lead.update", {"id": lead_id, **lead_fields})
                updated_leads += 1
            except Exception as e:
                errors += 1
                print(f"  lead.update {lead_id} failed: {e}", flush=True)
        else:
            updated_leads += 1

        # Обновляем CONTACT
        contact_id = lead.get("CONTACT_ID")
        if contact_id:
            try:
                contact = bx.call("crm.contact.get", {"id": contact_id}).get("result", {})
                if not contact.get("UF_CRM_IG_CHAT_ID"):
                    if not DRY_RUN:
                        bx.call("crm.contact.update", {
                            "id": contact_id,
                            "fields[UF_CRM_IG_CHAT_ID]": client_id,
                        })
                    updated_contacts += 1
                else:
                    skipped_contact_no_change += 1
            except Exception as e:
                errors += 1
                print(f"  contact {contact_id} backfill failed: {e}", flush=True)

        if not DRY_RUN:
            time.sleep(RATE_DELAY)

        if done % 50 == 0:
            print(f"  progress {done}/{len(lead_data)} "
                  f"leads_upd={updated_leads} contacts_upd={updated_contacts} "
                  f"links_upd={updated_links} lead_skip={skipped_lead_no_change} "
                  f"contact_skip={skipped_contact_no_change} errors={errors}", flush=True)

    print(f"\n=== DONE: leads_updated={updated_leads} contacts_updated={updated_contacts} "
          f"links_updated={updated_links} lead_skip={skipped_lead_no_change} "
          f"contact_skip={skipped_contact_no_change} errors={errors} ===", flush=True)


def main():
    env = load_env()
    bx = Bitrix(env)
    bx.refresh()
    direct = collect_lead_to_client(bx, 18)
    comments = collect_lead_to_client(bx, 22)
    # Comment-данные приоритетнее (там есть media_id/comment_id для LINK0)
    merged = dict(direct)
    for lead_id, info in comments.items():
        if lead_id in merged and not merged[lead_id].get("media_id"):
            merged[lead_id] = info
        elif lead_id not in merged:
            merged[lead_id] = info
    print(f"\ntotal unique leads to process: {len(merged)}", flush=True)
    backfill_leads(bx, merged)


if __name__ == "__main__":
    main()
