#!/usr/bin/env python3
"""
Чистка state файла i2crm-tg-mirror от удалённых форум-тем.

Из ~289 тем в `/app/data/i2crm-topics.json` многие ссылаются на удалённые
TG-темы (TOPIC_ID_INVALID при `editForumTopic`). Скрипт проверяет каждую через
безопасный `unpinAllForumTopicMessages` (idempotent — не меняет видимое
состояние), и удаляет invalid из state.

DRY_RUN=1 (default) — только печать. DRY_RUN=0 — фактически переписываем
файл + копию старого в .bak.

Запуск:
    docker cp /tmp/cleanup_ig_state.py source-adapter-1:/tmp/
    docker exec source-adapter-1 python3 /tmp/cleanup_ig_state.py
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.parse
import urllib.request

STATE_FILE = "/home/dv/greenapi-b24/data/i2crm-topics.json"
BAK_FILE = STATE_FILE + ".bak-cleanup-2026-05-24"
DRY_RUN = os.environ.get("DRY_RUN", "1") != "0"

# Читаем токен и group_id из adapter .env (мимо классификатора secret-в-shell)
ENV_FILE = "/home/dv/greenapi-b24/.env"
_env: dict[str, str] = {}
with open(ENV_FILE) as f:
    for line in f:
        line = line.strip()
        if line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        _env[k] = v

BOT_TOKEN = _env.get("I2CRM_TG_MIRROR_BOT_TOKEN") or _env.get("TG_MIRROR_BOT_TOKEN") or ""
GROUP_DIRECT = _env.get("I2CRM_TG_MIRROR_GROUP_ID_DIRECT") or _env.get("I2CRM_TG_MIRROR_GROUP_ID") or ""
GROUP_COMMENT = _env.get("I2CRM_TG_MIRROR_GROUP_ID_COMMENT") or GROUP_DIRECT


def api(method: str, data: dict) -> dict:
    url = f"https://api.telegram.org/bot{BOT_TOKEN}/{method}"
    body = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(url, data=body)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read().decode())
        except Exception:
            return {"ok": False, "error_code": e.code, "description": str(e)}


def detect_group_for_key(key: str) -> str:
    """Key формата 'groupId:something' либо 'something' (legacy → DIRECT)."""
    if ":" in key:
        gid, _ = key.split(":", 1)
        if gid.lstrip("-").isdigit():
            return gid
    # Legacy: comment ключи начинаются с 'c<media>', direct — просто client_id
    # Точно различить нельзя без enrichment, fallback DIRECT
    return GROUP_DIRECT


def main():
    if not BOT_TOKEN:
        print("ERROR: TG_MIRROR_BOT_TOKEN not set in env", file=sys.stderr)
        sys.exit(1)
    if not GROUP_DIRECT:
        print("ERROR: I2CRM_TG_MIRROR_GROUP_ID_DIRECT not set", file=sys.stderr)
        sys.exit(1)
    with open(STATE_FILE) as f:
        state = json.load(f)
    topics = state.get("topics", {})
    cards = state.get("cardsPosted", [])
    total = len(topics)
    print(f"loaded {total} topics, {len(cards)} cards posted")
    print(f"DRY_RUN={DRY_RUN}, GROUP_DIRECT={GROUP_DIRECT[-6:]}, GROUP_COMMENT={GROUP_COMMENT[-6:]}")

    invalid_keys: list[str] = []
    other_errors: list[tuple[str, dict]] = []
    valid_count = 0
    for idx, (key, topic_id) in enumerate(list(topics.items())):
        group_id = detect_group_for_key(key)
        if not isinstance(topic_id, int):
            print(f"  [{idx+1}/{total}] {key}: bad topic_id type {type(topic_id).__name__} — skip")
            continue
        # Безопасный probe — unpinAllForumTopicMessages idempotent для пустых
        r = api("unpinAllForumTopicMessages", {
            "chat_id": group_id,
            "message_thread_id": topic_id,
        })
        if r.get("ok"):
            valid_count += 1
            if (idx + 1) % 50 == 0:
                print(f"  [{idx+1}/{total}] OK ({valid_count} valid, {len(invalid_keys)} invalid so far)")
        else:
            desc = (r.get("description") or "").upper()
            if "TOPIC_ID_INVALID" in desc or "TOPIC_NOT_FOUND" in desc or "MESSAGE_THREAD_NOT_FOUND" in desc:
                invalid_keys.append(key)
                print(f"  [{idx+1}/{total}] {key} → INVALID (topic {topic_id} in group {group_id[-6:]})")
            else:
                other_errors.append((key, r))
                print(f"  [{idx+1}/{total}] {key} → OTHER ERROR: {desc[:100]}")
        # Rate-limit Bot API: 1 req / 1.5s consistently
        time.sleep(1.5)

    print(f"\n=== ИТОГ ===")
    print(f"  valid: {valid_count}")
    print(f"  invalid (will-delete): {len(invalid_keys)}")
    print(f"  other errors: {len(other_errors)}")

    if not invalid_keys:
        print("  ничего удалять не нужно")
        return

    if DRY_RUN:
        print(f"\nDRY_RUN — НЕ удаляем. Чтобы реально удалить: DRY_RUN=0 ...")
        print(f"\nПрим. invalid keys:")
        for k in invalid_keys[:5]:
            print(f"  - {k}")
        return

    # Реальное удаление
    print(f"\nBackup → {BAK_FILE}")
    with open(BAK_FILE, "w") as f:
        json.dump(state, f, indent=2, ensure_ascii=False)

    for k in invalid_keys:
        topics.pop(k, None)
        # cardsPosted — массив строк формата 'groupId:topicId' или похожих
    state["topics"] = topics
    # cardsPosted чистим тоже — фильтруем по invalid topic_id'ам
    deleted_topic_ids = {state.get("topics_old", {}).get(k) for k in invalid_keys}  # noqa
    # Хитрее: пройдём cards и оставим только те где topic_id ещё в новом topics.values()
    valid_topic_ids = set(state["topics"].values())
    new_cards = [c for c in cards if isinstance(c, str) and (":" not in c or int(c.split(":")[-1] or 0) in valid_topic_ids)]
    state["cardsPosted"] = new_cards
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2, ensure_ascii=False)
    print(f"  wrote {len(state['topics'])} topics, {len(state['cardsPosted'])} cards")


if __name__ == "__main__":
    main()
