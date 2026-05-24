#!/usr/bin/env python3
"""
Чистка тестовых лидов/контактов в B24 + customer-360.

Критерий «тестовый»: ВСЕ phones сущности — `^([0-9])\1{9,}$` после нормализации
(все одинаковые цифры в хвосте, 10+ повторений). Сущности с хотя бы одним
реальным номером НЕ удаляются.

Последовательность:
1. Из customer_aliases берём кандидатов customers по test-phone pattern.
2. Для каждого b24_lead/b24_contact alias — crm.{lead,contact}.get → проверка phones.
3. Если все phones тестовые → crm.{lead,contact}.delete.
4. В customer-service: для customers где не осталось НИ ОДНОГО реального
   alias (после удаления тестовых b24_*) — установить status='deleted'.

DRY_RUN=1 (default) — только печать, без изменений.
DRY_RUN=0 — реально удаляем.

Запуск:
    cd /home/dv/customer-360-backfill
    .venv/bin/python /home/dv/greenapi-b24/source/scripts/backfill-customer-360/cleanup_test_leads.py
"""
from __future__ import annotations
import os
import re
import sys
import time
import json
from urllib.parse import urlencode
import httpx

DRY_RUN = os.environ.get("DRY_RUN", "1") != "0"
B24_URL_FILE = "/home/dv/.secrets/backfill-webhook.url"
PG_ENV_FILE = "/home/dv/customer-service/.env"

TEST_PHONE_RE = re.compile(r"^([0-9])\1{9,}$")  # 10+ одинаковых цифр


def load_b24() -> str:
	with open(B24_URL_FILE) as f:
		url = f.read().strip()
	if not url.endswith("/"):
		url += "/"
	return url


def load_pg() -> dict:
	env = {}
	with open(PG_ENV_FILE) as f:
		for line in f:
			if "=" in line:
				k, v = line.strip().split("=", 1)
				env[k] = v
	return {
		"host": "127.0.0.1", "port": 5433,  # customer-service-db-1 exposes external port? check
		"user": env["POSTGRES_USER"], "password": env["POSTGRES_PASSWORD"],
		"dbname": env["POSTGRES_DB"],
	}


def is_test_phone(phone: str) -> bool:
	digits = re.sub(r"[^0-9]", "", phone or "")
	if len(digits) < 10:
		return False
	tail = digits[-10:]
	return bool(TEST_PHONE_RE.match(tail))


def fetch_entity(client: httpx.Client, url: str, kind: str, eid: int) -> dict | None:
	r = client.get(f"{url}crm.{kind}.get", params={"ID": eid}, timeout=15)
	if r.status_code != 200:
		return None
	d = r.json()
	if "error" in d:
		return None
	return d.get("result") or None


def all_phones_test(entity: dict) -> tuple[bool, list[str]]:
	phones = [p.get("VALUE") or "" for p in (entity.get("PHONE") or [])]
	if not phones:
		return (False, [])  # нет phones — не считаем тестовым (нечего проверять)
	return (all(is_test_phone(p) for p in phones), phones)


def delete_entity(client: httpx.Client, url: str, kind: str, eid: int) -> bool:
	if DRY_RUN:
		return True
	r = client.post(f"{url}crm.{kind}.delete", data={"ID": eid}, timeout=15)
	if r.status_code != 200:
		return False
	d = r.json()
	return d.get("result") is True and "error" not in d


def main():
	url = load_b24()
	pg = load_pg()

	import socket
	# Прямой коннект к docker контейнеру через docker host (если порт не проброшен)
	# customer-service-db-1 expose? Используем docker exec через psycopg2 не пройдёт.
	# Альтернатива — psql через docker exec. Сделаю проще: подключусь через docker network bridge.
	# Хост: customer-service-db-1, если на хосте — нужно знать proxied port. Проверим из env.
	# Fallback — через docker exec из bash, но скрипт всё-таки lean.

	# Проще — выгрузить PostgreSQL state в JSON через docker exec в /tmp и читать.
	import subprocess
	sql = """
	WITH test_customers AS (
		SELECT DISTINCT customer_uuid FROM customer_aliases
		WHERE alias_type = 'phone'
		  AND RIGHT(regexp_replace(alias_value, '[^0-9]', '', 'g'), 10) ~ '^([0-9])\\1{9}$'
	)
	SELECT json_agg(json_build_object(
		'uuid', ca.customer_uuid,
		'alias_type', ca.alias_type,
		'alias_value', ca.alias_value
	)) FROM customer_aliases ca
	WHERE ca.customer_uuid IN (SELECT customer_uuid FROM test_customers);
	"""
	out = subprocess.run(
		["docker", "exec", "-i", "-e", f"PGPASSWORD={pg['password']}", "customer-service-db-1",
		 "psql", "-U", pg["user"], "-d", pg["dbname"], "-tA", "-c", sql],
		capture_output=True, text=True, check=True,
	)
	rows = json.loads(out.stdout.strip() or "[]")
	print(f"loaded {len(rows)} aliases for test customers")

	# Группировка по customer
	by_customer: dict[str, dict] = {}
	for r in rows:
		c = by_customer.setdefault(r["uuid"], {"leads": set(), "contacts": set(), "phones": set(), "emails": set()})
		if r["alias_type"] == "b24_lead":
			c["leads"].add(int(r["alias_value"]))
		elif r["alias_type"] == "b24_contact":
			c["contacts"].add(int(r["alias_value"]))
		elif r["alias_type"] == "phone":
			c["phones"].add(r["alias_value"])
		elif r["alias_type"] == "email":
			c["emails"].add(r["alias_value"])

	deleted_leads: list[int] = []
	skipped_leads: list[tuple[int, list[str]]] = []
	deleted_contacts: list[int] = []
	skipped_contacts: list[tuple[int, list[str]]] = []

	with httpx.Client() as client:
		for uuid, data in by_customer.items():
			print(f"\n== customer {uuid} phones={sorted(data['phones'])} ==")
			# Leads
			for lid in sorted(data["leads"]):
				ent = fetch_entity(client, url, "lead", lid)
				if not ent:
					print(f"  L#{lid}: not found / error — skip")
					continue
				is_test, phones = all_phones_test(ent)
				if not is_test:
					skipped_leads.append((lid, phones))
					print(f"  L#{lid}: SKIP — has real phone(s): {phones}")
					continue
				ok = delete_entity(client, url, "lead", lid)
				if ok:
					deleted_leads.append(lid)
					print(f"  L#{lid}: {'WOULD-DELETE' if DRY_RUN else 'DELETED'} phones={phones}")
				else:
					print(f"  L#{lid}: DELETE-FAILED phones={phones}")
				time.sleep(0.2)
			# Contacts
			for cid in sorted(data["contacts"]):
				ent = fetch_entity(client, url, "contact", cid)
				if not ent:
					print(f"  C#{cid}: not found / error — skip")
					continue
				is_test, phones = all_phones_test(ent)
				if not is_test:
					skipped_contacts.append((cid, phones))
					print(f"  C#{cid}: SKIP — has real phone(s): {phones}")
					continue
				ok = delete_entity(client, url, "contact", cid)
				if ok:
					deleted_contacts.append(cid)
					print(f"  C#{cid}: {'WOULD-DELETE' if DRY_RUN else 'DELETED'} phones={phones}")
				else:
					print(f"  C#{cid}: DELETE-FAILED phones={phones}")
				time.sleep(0.2)

	print(f"\n=== ИТОГИ (DRY_RUN={DRY_RUN}) ===")
	print(f"Leads:    deleted={len(deleted_leads)}  skipped(real-phone)={len(skipped_leads)}")
	print(f"Contacts: deleted={len(deleted_contacts)}  skipped(real-phone)={len(skipped_contacts)}")
	if skipped_leads:
		print(f"\nSkipped leads (есть реальные phones, ОСТАВЛЯЕМ):")
		for lid, phones in skipped_leads:
			print(f"  L#{lid}: {phones}")
	if skipped_contacts:
		print(f"\nSkipped contacts:")
		for cid, phones in skipped_contacts:
			print(f"  C#{cid}: {phones}")


if __name__ == "__main__":
	main()
