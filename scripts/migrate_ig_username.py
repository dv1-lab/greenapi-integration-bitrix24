#!/usr/bin/env python3
"""Перенос UF_CRM_INSTAGRAM (url) → UF_CRM_IG_USERNAME (string) для lead и contact.

Что делает:
- Идёт постранично по записям с непустым UF_CRM_INSTAGRAM (фильтр %i%).
- Нормализует URL «https://instagram.com/<username>/» → «<username>».
- Если UF_CRM_IG_USERNAME пусто на этой записи — записывает.
- Старое UF_CRM_INSTAGRAM не трогает (остаётся как кликабельная URL для оператора).

Используется один раз для бэкфилла исторических данных. После прогона ensureLead
сможет матчить incoming Instagram-сообщения с существующими контактами.

Запуск на my-server в tmux:
    cd /home/dv/greenapi-b24/scripts
    BITRIX_PORTAL=1begovoy.bitrix24.ru python3 migrate_ig_username.py
Auth берётся из adapter БД (User.accessToken/refreshToken) — auto-refresh при 401.
"""
import os
import re
import sys
import time
import subprocess
import requests


PORTAL = os.environ.get("BITRIX_PORTAL", "1begovoy.bitrix24.ru")
ENV_FILE = os.environ.get("ADAPTER_ENV", "/home/dv/greenapi-b24/.env")
COMPOSE_DIR = os.environ.get("ADAPTER_COMPOSE_DIR", "/home/dv/greenapi-b24/source")
DRY_RUN = os.environ.get("DRY_RUN", "0") == "1"
RATE_DELAY = float(os.environ.get("RATE_DELAY", "0.25"))  # секунды между записями
PAGE_SIZE = 50  # B24 дефолт

# Допустимые сегменты URL: пользовательский профиль идёт сразу за instagram.com/.
# Сегменты-пути типа /p/, /reels/, /stories/, /explore/, /direct/ — это пост/коллекция,
# а не профиль; их игнорируем.
NON_USER_SEGMENTS = {
    "p", "reels", "reel", "stories", "explore", "direct", "tv",
    "accounts", "developer", "about", "press",
}

# Извлекает первый сегмент после instagram.com/. Точки в username — норма
# (sergei.031, _p.r.i.m.a.v.e.r.a_), поэтому проверку «есть точка → значит URL»
# делать нельзя.
URL_RE = re.compile(r"instagr(?:am)?(?:\.com)?/+([^/?#\s]+)", re.IGNORECASE)
USERNAME_RE = re.compile(r"^[a-z0-9._]+$")


def load_env():
    env = {}
    with open(ENV_FILE) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            env[k.strip()] = v.strip()
    return env


def get_initial_tokens(env):
    """Берём accessToken/refreshToken из MySQL adapter."""
    cmd = [
        "docker", "compose", "exec", "-T", "db",
        "mysql",
        "-uroot",
        f"-p{env['MYSQL_ROOT_PASSWORD']}",
        env["MYSQL_DATABASE"],
        "-N", "-B", "-e",
        f'SELECT accessToken, refreshToken FROM User WHERE id="{PORTAL}";',
    ]
    out = subprocess.check_output(cmd, cwd=COMPOSE_DIR, stderr=subprocess.DEVNULL)
    parts = out.decode().strip().split("\t")
    if len(parts) != 2:
        print(f"ERROR: cannot read tokens from db (got: {parts})", file=sys.stderr)
        sys.exit(1)
    return parts[0], parts[1]


class Bitrix:
    def __init__(self, env):
        self.env = env
        self.access_token, self.refresh_token = get_initial_tokens(env)
        self.client_id = env["BITRIX24_CLIENT_ID"]
        self.client_secret = env["BITRIX24_CLIENT_SECRET"]

    def refresh(self):
        r = requests.get(
            "https://oauth.bitrix.info/oauth/token/",
            params={
                "grant_type": "refresh_token",
                "client_id": self.client_id,
                "client_secret": self.client_secret,
                "refresh_token": self.refresh_token,
            },
            timeout=30,
        )
        r.raise_for_status()
        d = r.json()
        self.access_token = d["access_token"]
        self.refresh_token = d["refresh_token"]
        # Также сохраняем в БД adapter чтобы он подхватил
        try:
            cmd = [
                "docker", "compose", "exec", "-T", "db",
                "mysql",
                "-uroot",
                f'-p{self.env["MYSQL_ROOT_PASSWORD"]}',
                self.env["MYSQL_DATABASE"],
                "-e",
                f'UPDATE User SET accessToken="{self.access_token}", refreshToken="{self.refresh_token}", '
                f'tokenExpiresAt=DATE_ADD(NOW(), INTERVAL {d.get("expires_in", 3600)} SECOND) '
                f'WHERE id="{PORTAL}";',
            ]
            subprocess.check_call(cmd, cwd=COMPOSE_DIR, stderr=subprocess.DEVNULL)
        except Exception as e:
            print(f"WARN: failed to persist new token to DB: {e}", file=sys.stderr)
        print(f"[token] refreshed (new len={len(self.access_token)})", file=sys.stderr)

    def call(self, method, params, _retry=False, timeout=30):
        params = dict(params)
        params["auth"] = self.access_token
        url = f"https://{PORTAL}/rest/{method}"
        r = requests.post(url, data=params, timeout=timeout)
        if r.status_code == 401 and not _retry:
            self.refresh()
            return self.call(method, params, _retry=True)
        # B24 может вернуть 200 с error в теле (expired_token)
        try:
            data = r.json()
        except Exception:
            r.raise_for_status()
            raise
        if isinstance(data, dict) and data.get("error") in (
            "expired_token", "invalid_token", "NO_AUTH_FOUND", "ACCESS_DENIED",
        ) and not _retry:
            self.refresh()
            return self.call(method, params, _retry=True)
        if isinstance(data, dict) and data.get("error"):
            raise RuntimeError(f"B24 {method} error: {data.get('error')} {data.get('error_description')}")
        return data


def normalize(raw):
    """URL/строка → чистый @username (lowercased, без @). None если непохоже на профиль."""
    if not raw:
        return None
    s = str(raw).strip().lstrip("@").lower()
    if not s:
        return None
    # Если выглядит как URL (есть «/», «http» или «instagram») — извлекаем
    # username через regex; иначе считаем что вся строка — это уже username.
    if "/" in s or s.startswith("http") or "instagr" in s:
        m = URL_RE.search(s)
        if not m:
            return None
        candidate = m.group(1).lstrip("@")
    else:
        candidate = s
    if candidate in NON_USER_SEGMENTS:
        return None
    if not USERNAME_RE.match(candidate):
        return None
    return candidate


def migrate_entity(bx, entity):
    """Single-update в N параллельных потоках — batch API B24 даёт Read timeout 30s
    на 50 updates."""
    from concurrent.futures import ThreadPoolExecutor, as_completed
    from threading import Lock

    print(f"\n=== migrating {entity} ===", flush=True)
    counters = {"migrated_username": 0, "canonicalized_url": 0,
                "skipped_already": 0, "skipped_no_username": 0, "errors": 0}
    lock = Lock()

    def update_one(item):
        url_raw = item.get("UF_CRM_INSTAGRAM")
        cur_username = item.get("UF_CRM_IG_USERNAME")
        username = normalize(url_raw)
        if not username:
            with lock: counters["skipped_no_username"] += 1
            return
        need_username = not cur_username
        canonical_url = f"https://instagram.com/{username}/"
        need_url = str(url_raw or "").strip() != canonical_url
        if not need_username and not need_url:
            with lock: counters["skipped_already"] += 1
            return
        if DRY_RUN:
            with lock:
                if need_username: counters["migrated_username"] += 1
                if need_url: counters["canonicalized_url"] += 1
            return
        params = {"id": item["ID"]}
        if need_username:
            params["fields[UF_CRM_IG_USERNAME]"] = username
        if need_url:
            params["fields[UF_CRM_INSTAGRAM]"] = canonical_url
        # OPERATION_TIME_LIMIT — B24 защита от накопленного CPU-времени за
        # минуту. После ошибки квота восстанавливается ТОЛЬКО при полном
        # простое 60-90 секунд (любой запрос продлевает блокировку).
        # Стратегия: 5 попыток × возрастающий sleep 60/90/120/180/240 секунд.
        retry_delays = [60, 90, 120, 180, 240]
        for attempt, delay in enumerate(retry_delays, 1):
            try:
                bx.call(f"crm.{entity}.update", params, timeout=60)
                with lock:
                    if need_username: counters["migrated_username"] += 1
                    if need_url: counters["canonicalized_url"] += 1
                # Базовая пауза между апдейтами — снижает нагрузку
                time.sleep(0.5)
                return
            except Exception as e:
                msg = str(e)
                if "OPERATION_TIME_LIMIT" in msg and attempt < len(retry_delays):
                    print(f"  rate-limit on {entity} {item['ID']} attempt {attempt}, sleep {delay}s", flush=True)
                    time.sleep(delay)
                    continue
                with lock:
                    counters["errors"] += 1
                    if counters["errors"] <= 10:
                        print(f"  update error {entity} {item['ID']} (attempt {attempt}): {e}", flush=True)
                return

    start = 0
    total = None
    while True:
        try:
            r = bx.call(f"crm.{entity}.list", {
                "filter[%UF_CRM_INSTAGRAM]": "i",
                "select[0]": "ID",
                "select[1]": "UF_CRM_INSTAGRAM",
                "select[2]": "UF_CRM_IG_USERNAME",
                "order[ID]": "ASC",
                "start": start,
            }, timeout=60)
        except Exception as e:
            print(f"  list error at start={start}: {e}", flush=True)
            with lock: counters["errors"] += 1
            time.sleep(5)
            continue
        items = r.get("result", []) or []
        if not items:
            break
        if total is None:
            total = r.get("total", 0)
            print(f"  total={total}", flush=True)
        # 1 поток — B24 OPERATION_TIME_LIMIT блокирует уже на 2 потоках,
        # квота восстанавливается только при полном простое. С 1 потоком
        # + 0.5с sleep — ~1.5 r/s, безопасно.
        with ThreadPoolExecutor(max_workers=1) as ex:
            futures = [ex.submit(update_one, it) for it in items]
            for _ in as_completed(futures):
                pass
        print(f"  page start={start}: migrated_username={counters['migrated_username']} "
              f"canonicalized_url={counters['canonicalized_url']} "
              f"skipped_already={counters['skipped_already']} "
              f"skipped_no_username={counters['skipped_no_username']} "
              f"errors={counters['errors']}", flush=True)
        next_start = r.get("next")
        if next_start is None or next_start == start:
            break
        start = next_start
    print(f"=== {entity} done: migrated_username={counters['migrated_username']} "
          f"canonicalized_url={counters['canonicalized_url']} "
          f"skipped_already={counters['skipped_already']} "
          f"skipped_no_username={counters['skipped_no_username']} "
          f"errors={counters['errors']} ===", flush=True)


def main():
    env = load_env()
    bx = Bitrix(env)
    bx.refresh()  # стартуем со свежим токеном
    for entity in ("contact", "lead"):  # contact меньше — начнём с него
        migrate_entity(bx, entity)


if __name__ == "__main__":
    main()
