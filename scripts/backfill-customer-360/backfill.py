#!/usr/bin/env python3
"""
Customer-360 backfill — исторические данные из Bitrix24 в customer-service + customer_events.

Стадии:
  1. contacts — crm.contact.list → /customers/find-or-create (b24_contact, phone, email, UF chat_ids) + event contact_added
  2. leads    — crm.lead.list    → resolveAlias by phone/UF chat_ids → event lead_added (+ lead_updated если status финальный)
  3. deals    — crm.deal.list    → event deal_added (+ deal_won/lost для финальных стадий)
  4. calls    — voximplant.statistic.get → event call_in/out/missed

Особенности:
  - Checkpoint в state.json (last entity ID per stage), atomic rename
  - Rate-limit: 2 req/s к B24 webhook (semaphore=2)
  - skipKbd=true — не пушим в KBD-bridge (массовый импорт)
  - Phone/email/b24_*/IG/TG aliases используются ТОЛЬКО для устойчивых якорей
    (phone — НЕ retro для backfill, добавляем как alias только на contact-level,
     для leads/deals резолвим через b24_lead/b24_deal или ig_client/tg_user)
  - Лог: backfill.log (rotate ежедневно через systemd-журнал)

Запуск: nohup .venv/bin/python backfill.py [stage] &> backfill.log &
        stage: all | contacts | leads | deals | calls
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import sys
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Iterable

import httpx

# === конфиг ===
ROOT = Path(__file__).resolve().parent
STATE_FILE = ROOT / "state.json"
LOG_FILE = ROOT / "backfill.log"

B24_WEBHOOK_URL_FILE = "/home/dv/.secrets/backfill-webhook.url"
CS_BASE = "http://127.0.0.1:3002"
CS_SECRET_ENV_FILE = "/home/dv/customer-service/.env"

B24_RATE_LIMIT_PER_SEC = 5  # token bucket: ≤5 запросов в скользящем 1-сек окне
B24_CONCURRENCY = 5         # parallel B24 calls (latency на больших batch'ах ~1-2s, retry-backoff включён)
B24_PAGE_SIZE = 50          # B24 default, не меняется через REST
CS_CONCURRENCY = 32         # customer-service local NestJS — на 4 vCPU держит

CHECKPOINT_EVERY_N = 50
RETRY_MAX = 5
RETRY_BACKOFF_BASE = 2.0

# Финальные статусы лидов (B24 default + кастомные)
LEAD_STATUS_FINAL = {"CONVERTED", "JUNK"}
DEAL_STAGE_WON = {"WON"}
DEAL_STAGE_LOST = {"LOSE"}


def load_b24_url() -> str:
	with open(B24_WEBHOOK_URL_FILE, "r") as f:
		url = f.read().strip()
	if not url.endswith("/"):
		url += "/"
	return url


def load_cs_secret() -> str:
	with open(CS_SECRET_ENV_FILE, "r") as f:
		for line in f:
			if line.startswith("SERVICE_SECRET="):
				return line[len("SERVICE_SECRET="):].strip()
	raise RuntimeError("SERVICE_SECRET not found in customer-service .env")


class SecretRedactor(logging.Filter):
	"""Маскируем токен webhook B24 во всех логах (httpx сует URL в текст ошибки)."""
	_pat = re.compile(r"(/rest/\d+/)[A-Za-z0-9]{10,}(/)")
	def filter(self, record: logging.LogRecord) -> bool:
		if isinstance(record.msg, str):
			record.msg = self._pat.sub(r"\1<masked>\2", record.msg)
		if record.args:
			try:
				record.args = tuple(self._pat.sub(r"\1<masked>\2", str(a)) if isinstance(a, str) else a
				                    for a in (record.args if isinstance(record.args, tuple) else (record.args,)))
			except Exception:
				pass
		return True


def setup_logging():
	root = logging.getLogger()
	root.setLevel(logging.INFO)
	fmt = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
	redactor = SecretRedactor()
	for h in (logging.FileHandler(LOG_FILE), logging.StreamHandler(sys.stdout)):
		h.setFormatter(fmt)
		h.addFilter(redactor)
		root.addHandler(h)
	# httpx тоже глушим INFO до WARNING (его «HTTP Request: ...» шумит)
	logging.getLogger("httpx").setLevel(logging.WARNING)


def load_state() -> dict:
	if STATE_FILE.exists():
		return json.loads(STATE_FILE.read_text())
	return {
		"contacts":  {"last_start": 0, "processed": 0, "errors": 0, "finished_at": None},
		"leads":     {"last_start": 0, "processed": 0, "errors": 0, "finished_at": None},
		"deals":     {"last_start": 0, "processed": 0, "errors": 0, "finished_at": None},
		"calls":     {"last_start": 0, "processed": 0, "errors": 0, "finished_at": None},
		"openlines": {"last_start": 0, "processed": 0, "msgs_in": 0, "msgs_out": 0,
		              "msgs_sys": 0, "errors": 0, "finished_at": None},
	}


def save_state(state: dict):
	tmp = STATE_FILE.with_suffix(".json.tmp")
	tmp.write_text(json.dumps(state, indent=2, ensure_ascii=False))
	tmp.replace(STATE_FILE)


# === B24 client ===

class PermanentB24Error(Exception):
	"""Не retry'им — ошибка от B24 которая повторится с тем же запросом."""
	def __init__(self, code: str, desc: str = ""):
		super().__init__(f"{code}: {desc}")
		self.code = code
		self.desc = desc

class B24Client:
	def __init__(self, base_url: str):
		self.base_url = base_url
		# концурентность — отдельно от rate-limit (большие batch'и упираются в latency, не в RPS)
		self.client = httpx.AsyncClient(timeout=httpx.Timeout(60.0),
		                                 limits=httpx.Limits(max_keepalive_connections=10, max_connections=20))
		self._sem = asyncio.Semaphore(B24_CONCURRENCY)
		self._tokens: list[float] = []  # timestamps выданных токенов в последнюю секунду
		self._lock = asyncio.Lock()

	async def aclose(self):
		await self.client.aclose()

	async def _acquire_token(self):
		"""Token bucket: max B24_RATE_LIMIT_PER_SEC выдач в скользящем 1-секундном окне."""
		while True:
			async with self._lock:
				now = time.monotonic()
				self._tokens = [t for t in self._tokens if t > now - 1.0]
				if len(self._tokens) < B24_RATE_LIMIT_PER_SEC:
					self._tokens.append(now)
					return
				wait = 1.0 - (now - self._tokens[0]) + 0.005
			await asyncio.sleep(max(wait, 0.01))

	async def call(self, method: str, params: dict | None = None) -> dict:
		url = self.base_url + method
		async with self._sem:
			for attempt in range(RETRY_MAX):
				await self._acquire_token()
				try:
					r = await self.client.post(url, data=params or {})
					if r.status_code >= 500 or r.status_code == 429:
						wait = RETRY_BACKOFF_BASE ** attempt
						logging.warning("B24 %s HTTP %s — retry in %.1fs", method, r.status_code, wait)
						await asyncio.sleep(wait)
						continue
					try:
						data = r.json()
					except ValueError:
						r.raise_for_status()
						raise
					if "error" in data:
						err = data["error"]
						desc = (data.get("error_description") or "")[:120]
						if err in ("ACCESS_DENIED", "INVALID_SESSION_ID", "NOT_FOUND",
						           "ERROR_METHOD_NOT_FOUND", "INVALID_CREDENTIALS",
						           "INVALID_REQUEST", "MISSING_REQUIRED_PARAM"):
							raise PermanentB24Error(err, desc)
						if err == "QUERY_LIMIT_EXCEEDED":
							wait = RETRY_BACKOFF_BASE ** attempt
							logging.warning("B24 rate limit on %s — backoff %.1fs", method, wait)
							await asyncio.sleep(wait)
							continue
						if attempt < RETRY_MAX - 1:
							wait = RETRY_BACKOFF_BASE ** attempt
							logging.warning("B24 %s error %s — retry %.1fs (%s)", method, err, wait, desc)
							await asyncio.sleep(wait)
							continue
						raise RuntimeError(f"B24 {err}: {desc}")
					return data
				except PermanentB24Error:
					raise
				except httpx.HTTPError as e:
					if attempt == RETRY_MAX - 1:
						raise
					wait = RETRY_BACKOFF_BASE ** attempt
					logging.warning("B24 transport error on %s — retry %.1fs", method, wait)
					await asyncio.sleep(wait)
		raise RuntimeError(f"B24 {method} failed after {RETRY_MAX} retries")

	async def batch(self, cmds: dict[str, tuple[str, dict]], halt: int = 0) -> dict[str, dict | None]:
		"""Batch API B24: до 50 sub-calls за 1 HTTP. cmds: {tag: (method, params)}.

		Возвращает {tag: result_or_error_dict}.
		Successful: {tag: <данные result для этого sub-call>}
		Error: {tag: {"__error__": code, "__desc__": desc}}
		Считается как 1 B24-вызов в rate-limit.
		"""
		from urllib.parse import urlencode
		if not cmds:
			return {}
		params: dict[str, Any] = {"halt": halt}
		for tag, (m, p) in cmds.items():
			qs = urlencode([(k, v) for k, v in (p or {}).items()], doseq=True)
			params[f"cmd[{tag}]"] = f"{m}?{qs}" if qs else m
		data = await self.call("batch", params)
		result = data.get("result") or {}
		ok = result.get("result") or {}
		err = result.get("result_error") or {}
		out: dict[str, dict | None] = {}
		for tag in cmds:
			if tag in err:
				e = err[tag]
				if isinstance(e, dict):
					out[tag] = {"__error__": e.get("error", "UNKNOWN"),
					            "__desc__": (e.get("error_description") or "")[:120]}
				else:
					out[tag] = {"__error__": "UNKNOWN", "__desc__": str(e)[:120]}
			elif tag in ok:
				out[tag] = ok[tag]
			else:
				out[tag] = None
		return out

	async def list_paginated(self, method: str, *, start: int = 0, params: dict | None = None) -> Iterable[tuple[int, list[dict]]]:
		"""Generator: yields (start_offset, batch_results). Завершается когда next отсутствует."""
		cur = start
		while True:
			p = dict(params or {})
			p["start"] = cur
			data = await self.call(method, p)
			batch = data.get("result", [])
			if isinstance(batch, dict):
				# некоторые методы возвращают dict вместо list (e.g. crm.deal.list)
				batch = list(batch.values()) if all(isinstance(v, dict) for v in batch.values()) else [batch]
			yield (cur, batch)
			nxt = data.get("next")
			if nxt is None:
				break
			cur = nxt


# === customer-service client ===

class CSClient:
	def __init__(self, base: str, secret: str):
		self.base = base.rstrip("/")
		self.headers = {"Content-Type": "application/json", "X-Service-Secret": secret}
		self.client = httpx.AsyncClient(timeout=httpx.Timeout(15.0))
		self._sem = asyncio.Semaphore(CS_CONCURRENCY)

	async def aclose(self):
		await self.client.aclose()

	async def _post(self, path: str, body: dict) -> dict:
		async with self._sem:
			for attempt in range(RETRY_MAX):
				try:
					r = await self.client.post(self.base + path, headers=self.headers, json=body)
					if r.status_code >= 500:
						wait = RETRY_BACKOFF_BASE ** attempt
						logging.warning("CS %s HTTP %s — retry %.1fs", path, r.status_code, wait)
						await asyncio.sleep(wait)
						continue
					if r.status_code == 400:
						# bad alias / validation — пропустим, не fatal
						logging.warning("CS %s HTTP 400: %s", path, r.text[:200])
						return {}
					r.raise_for_status()
					return r.json()
				except httpx.HTTPError as e:
					if attempt == RETRY_MAX - 1:
						logging.error("CS %s failed: %s body=%s", path, e, json.dumps(body)[:300])
						return {}
					await asyncio.sleep(RETRY_BACKOFF_BASE ** attempt)
			return {}

	async def find_or_create(self, alias_type: str, alias_value: str, added_by: str = "backfill") -> str | None:
		r = await self._post("/customers/find-or-create", {
			"aliasType": alias_type,
			"aliasValue": alias_value,
			"addedBy": added_by,
		})
		return (r.get("customer") or {}).get("uuid")

	async def add_alias(self, uuid: str, alias_type: str, alias_value: str, added_by: str = "backfill"):
		await self._post(f"/customers/{uuid}/aliases", {
			"aliasType": alias_type,
			"aliasValue": alias_value,
			"addedBy": added_by,
		})

	async def promote(self, uuid: str, b24_contact_id: int, added_by: str = "backfill"):
		await self._post(f"/customers/{uuid}/promote", {
			"b24ContactId": str(b24_contact_id),
			"addedBy": added_by,
		})

	async def ingest_event(self, *, customer_uuid: str | None, resolve_alias: dict | None,
	                       ts: str | None, source: str, event_type: str, channel: str = "",
	                       summary: str, payload: dict | None = None,
	                       b24_lead_id: int | None = None, b24_contact_id: int | None = None,
	                       b24_deal_id: int | None = None, operator: str = ""):
		body: dict[str, Any] = {
			"source": source,
			"eventType": event_type,
			"channel": channel,
			"summary": summary,
			"skipKbd": True,
		}
		if customer_uuid:
			body["customerUuid"] = customer_uuid
		if resolve_alias:
			body["resolveAlias"] = resolve_alias
		if ts:
			body["ts"] = ts
		if payload is not None:
			body["payload"] = payload
		if b24_lead_id is not None:
			body["b24LeadId"] = int(b24_lead_id)
		if b24_contact_id is not None:
			body["b24ContactId"] = int(b24_contact_id)
		if b24_deal_id is not None:
			body["b24DealId"] = int(b24_deal_id)
		if operator:
			body["operator"] = operator
		await self._post("/events/ingest", body)


# === helpers ===

def normalize_phone(raw: str) -> str | None:
	if not raw:
		return None
	digits = re.sub(r"\D+", "", raw)
	if len(digits) == 11 and digits.startswith("8"):
		digits = "7" + digits[1:]
	if len(digits) == 10:
		digits = "7" + digits
	if len(digits) < 10:
		return None
	return "+" + digits


def iso_from_b24(ts: str) -> str | None:
	# B24 даёт ISO с offset, customer-service ждёт ISO8601 — нормально как есть
	return ts or None


def extract_phones_emails(entity: dict) -> tuple[list[str], list[str]]:
	phones: list[str] = []
	emails: list[str] = []
	for fld in entity.get("PHONE") or []:
		v = normalize_phone(str(fld.get("VALUE") or ""))
		if v and v not in phones:
			phones.append(v)
	for fld in entity.get("EMAIL") or []:
		v = (fld.get("VALUE") or "").strip().lower()
		if v and v not in emails:
			emails.append(v)
	return phones, emails


def extract_uf_chat_ids(entity: dict) -> dict[str, str]:
	"""UF_CRM_*_CHAT_ID (TG/IG/MAX) — устойчивые якоря, можно retro."""
	out: dict[str, str] = {}
	# Конкретные имена UF могут отличаться; используем шаблонный поиск
	for k, v in entity.items():
		if not k.startswith("UF_CRM_"):
			continue
		s = str(v or "").strip()
		if not s or s == "0" or s == "-":
			continue
		ku = k.upper()
		if "TG_CHAT_ID" in ku or "TG_USER_ID" in ku:
			out["tg_user"] = s
		elif "IG_CLIENT_ID" in ku or "IG_USER_ID" in ku:
			out["ig_client"] = s
		elif "MAX_CHAT_ID" in ku or "MAX_USER_ID" in ku:
			out["max_chat"] = s
	return out


# === stages ===

async def stage_contacts(b24: B24Client, cs: CSClient, state: dict, full_state: dict):
	"""Stage 1: contacts → find-or-create + aliases + event contact_added."""
	st = state
	logging.info("=== Stage: contacts (last_start=%s) ===", st["last_start"])
	processed = st["processed"]
	errors = st["errors"]
	since = time.monotonic()

	select = [
		"ID", "DATE_CREATE", "DATE_MODIFY", "NAME", "LAST_NAME", "SECOND_NAME",
		"PHONE", "EMAIL", "ASSIGNED_BY_ID", "SOURCE_ID", "TYPE_ID",
		# UF_* подтянем select=*
	]
	params = {f"select[{i}]": s for i, s in enumerate(select)}
	params["select[" + str(len(select)) + "]"] = "UF_*"

	async for offset, batch in b24.list_paginated("crm.contact.list", start=st["last_start"], params=params):
		for c in batch:
			try:
				cid = int(c["ID"])
				uuid = await cs.find_or_create("b24_contact", str(cid))
				if not uuid:
					errors += 1
					continue
				phones, emails = extract_phones_emails(c)
				for p in phones:
					await cs.add_alias(uuid, "phone", p)
				for e in emails:
					await cs.add_alias(uuid, "email", e)
				uf_chats = extract_uf_chat_ids(c)
				for at, av in uf_chats.items():
					await cs.add_alias(uuid, at, av)
				name = " ".join(filter(None, [c.get("NAME"), c.get("SECOND_NAME"), c.get("LAST_NAME")])).strip() or f"Contact {cid}"
				await cs.ingest_event(
					customer_uuid=uuid, resolve_alias=None,
					ts=iso_from_b24(c.get("DATE_CREATE") or ""),
					source="b24_contact", event_type="contact_added", channel="",
					summary=f"Контакт #{cid}: {name}",
					payload={"backfill": True, "phones": phones, "emails": emails, "uf_chats": uf_chats,
					         "source_id": c.get("SOURCE_ID"), "type_id": c.get("TYPE_ID")},
					b24_contact_id=cid,
				)
				processed += 1
			except Exception as e:
				errors += 1
				logging.exception("contact %s failed: %s", c.get("ID"), e)
		st["last_start"] = offset + len(batch)
		st["processed"] = processed
		st["errors"] = errors
		if processed % CHECKPOINT_EVERY_N == 0 or len(batch) < B24_PAGE_SIZE:
			save_state(full_state)
		rate = processed / max(time.monotonic() - since, 1)
		logging.info("contacts: offset=%d processed=%d errors=%d rate=%.1f/s",
		             st["last_start"], processed, errors, rate)

	st["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
	save_state(full_state)
	logging.info("=== contacts done: %d processed, %d errors ===", processed, errors)


async def stage_leads(b24: B24Client, cs: CSClient, state: dict, full_state: dict):
	st = state
	logging.info("=== Stage: leads (last_start=%s) ===", st["last_start"])
	processed = st["processed"]
	errors = st["errors"]
	since = time.monotonic()

	select = ["ID", "DATE_CREATE", "DATE_MODIFY", "TITLE", "STATUS_ID", "STATUS_DESCRIPTION",
	          "SOURCE_ID", "SOURCE_DESCRIPTION", "ASSIGNED_BY_ID", "CONTACT_ID",
	          "PHONE", "EMAIL", "UF_*"]
	params = {f"select[{i}]": s for i, s in enumerate(select)}
	params["order[ID]"] = "ASC"

	async for offset, batch in b24.list_paginated("crm.lead.list", start=st["last_start"], params=params):
		for l in batch:
			try:
				lid = int(l["ID"])
				contact_id = l.get("CONTACT_ID")
				phones, emails = extract_phones_emails(l)
				uf_chats = extract_uf_chat_ids(l)

				# Резолв UUID: b24_contact > tg/ig/max > b24_lead (fallback — собственный alias)
				uuid: str | None = None
				if contact_id and str(contact_id) != "0":
					uuid = await cs.find_or_create("b24_contact", str(contact_id))
				if not uuid:
					for at in ("tg_user", "ig_client", "max_chat"):
						if at in uf_chats:
							uuid = await cs.find_or_create(at, uf_chats[at])
							if uuid:
								break
				if not uuid:
					# Лиды без контакта/чата — пишем под собственным b24_lead alias
					uuid = await cs.find_or_create("b24_lead", str(lid))

				# Добавим alias b24_lead если он не первичный
				if uuid:
					await cs.add_alias(uuid, "b24_lead", str(lid))

				title = (l.get("TITLE") or "").strip() or f"Лид #{lid}"
				status = l.get("STATUS_ID") or "NEW"
				await cs.ingest_event(
					customer_uuid=uuid, resolve_alias=None,
					ts=iso_from_b24(l.get("DATE_CREATE") or ""),
					source="b24_lead", event_type="lead_added", channel="",
					summary=f"Лид #{lid}: {title} [{status}]",
					payload={"backfill": True, "status_id": status,
					         "source_id": l.get("SOURCE_ID"), "phones": phones, "emails": emails,
					         "uf_chats": uf_chats, "contact_id": contact_id},
					b24_lead_id=lid,
					b24_contact_id=int(contact_id) if contact_id and str(contact_id) != "0" else None,
				)
				if status in LEAD_STATUS_FINAL:
					await cs.ingest_event(
						customer_uuid=uuid, resolve_alias=None,
						ts=iso_from_b24(l.get("DATE_MODIFY") or l.get("DATE_CREATE") or ""),
						source="b24_lead", event_type="lead_updated", channel="",
						summary=f"Лид #{lid} → {status}",
						payload={"backfill": True, "status_id": status},
						b24_lead_id=lid,
					)
				processed += 1
			except Exception as e:
				errors += 1
				logging.exception("lead %s failed: %s", l.get("ID"), e)
		st["last_start"] = offset + len(batch)
		st["processed"] = processed
		st["errors"] = errors
		if processed % CHECKPOINT_EVERY_N == 0 or len(batch) < B24_PAGE_SIZE:
			save_state(full_state)
		rate = processed / max(time.monotonic() - since, 1)
		logging.info("leads: offset=%d processed=%d errors=%d rate=%.1f/s",
		             st["last_start"], processed, errors, rate)

	st["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
	save_state(full_state)
	logging.info("=== leads done: %d processed, %d errors ===", processed, errors)


async def stage_deals(b24: B24Client, cs: CSClient, state: dict, full_state: dict):
	st = state
	logging.info("=== Stage: deals (last_start=%s) ===", st["last_start"])
	processed = st["processed"]
	errors = st["errors"]
	since = time.monotonic()

	select = ["ID", "DATE_CREATE", "DATE_MODIFY", "TITLE", "STAGE_ID", "OPPORTUNITY",
	          "CURRENCY_ID", "ASSIGNED_BY_ID", "CONTACT_ID", "LEAD_ID", "TYPE_ID",
	          "CATEGORY_ID", "UF_*"]
	params = {f"select[{i}]": s for i, s in enumerate(select)}
	params["order[ID]"] = "ASC"

	async for offset, batch in b24.list_paginated("crm.deal.list", start=st["last_start"], params=params):
		for d in batch:
			try:
				did = int(d["ID"])
				contact_id = d.get("CONTACT_ID")
				lead_id = d.get("LEAD_ID")
				uuid: str | None = None
				if contact_id and str(contact_id) != "0":
					uuid = await cs.find_or_create("b24_contact", str(contact_id))
				if not uuid and lead_id and str(lead_id) != "0":
					uuid = await cs.find_or_create("b24_lead", str(lead_id))
				if not uuid:
					uuid = await cs.find_or_create("b24_deal", str(did))
				if uuid:
					await cs.add_alias(uuid, "b24_deal", str(did))

				title = (d.get("TITLE") or "").strip() or f"Сделка #{did}"
				stage = d.get("STAGE_ID") or ""
				stage_short = stage.split(":")[-1] if ":" in stage else stage
				event_type = "deal_added"
				if stage_short in DEAL_STAGE_WON:
					event_type = "deal_won"
				elif stage_short in DEAL_STAGE_LOST:
					event_type = "deal_lost"

				await cs.ingest_event(
					customer_uuid=uuid, resolve_alias=None,
					ts=iso_from_b24(d.get("DATE_CREATE") or ""),
					source="b24_deal", event_type=event_type, channel="",
					summary=f"Сделка #{did}: {title} [{stage_short}] {d.get('OPPORTUNITY') or ''} {d.get('CURRENCY_ID') or ''}".strip(),
					payload={"backfill": True, "stage_id": stage, "opportunity": d.get("OPPORTUNITY"),
					         "currency": d.get("CURRENCY_ID"), "category_id": d.get("CATEGORY_ID"),
					         "contact_id": contact_id, "lead_id": lead_id},
					b24_deal_id=did,
					b24_lead_id=int(lead_id) if lead_id and str(lead_id) != "0" else None,
					b24_contact_id=int(contact_id) if contact_id and str(contact_id) != "0" else None,
				)
				processed += 1
			except Exception as e:
				errors += 1
				logging.exception("deal %s failed: %s", d.get("ID"), e)
		st["last_start"] = offset + len(batch)
		st["processed"] = processed
		st["errors"] = errors
		if processed % CHECKPOINT_EVERY_N == 0 or len(batch) < B24_PAGE_SIZE:
			save_state(full_state)
		rate = processed / max(time.monotonic() - since, 1)
		logging.info("deals: offset=%d processed=%d errors=%d rate=%.1f/s",
		             st["last_start"], processed, errors, rate)

	st["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
	save_state(full_state)
	logging.info("=== deals done: %d processed, %d errors ===", processed, errors)


async def stage_calls(b24: B24Client, cs: CSClient, state: dict, full_state: dict):
	st = state
	logging.info("=== Stage: calls (last_start=%s) ===", st["last_start"])
	processed = st["processed"]
	errors = st["errors"]
	since = time.monotonic()

	# voximplant.statistic.get параметры: FILTER, SORT, ORDER
	# Поля: ID, CALL_TYPE (1=out, 2=in, 3=missed_in, 4=missed_out), CALL_DURATION,
	#       PHONE_NUMBER, PORTAL_USER_ID, CRM_ENTITY_TYPE, CRM_ENTITY_ID, CRM_ACTIVITY_ID,
	#       CALL_START_DATE, CALL_RECORD_URL, COST, COST_CURRENCY
	params: dict[str, Any] = {"SORT": "CALL_START_DATE", "ORDER": "ASC"}

	async for offset, batch in b24.list_paginated("voximplant.statistic.get", start=st["last_start"], params=params):
		for call in batch:
			try:
				phone = normalize_phone(str(call.get("PHONE_NUMBER") or ""))
				crm_type = (call.get("CRM_ENTITY_TYPE") or "").upper()
				crm_id = call.get("CRM_ENTITY_ID")
				uuid: str | None = None
				if crm_type == "CONTACT" and crm_id:
					uuid = await cs.find_or_create("b24_contact", str(crm_id))
				elif crm_type == "LEAD" and crm_id:
					uuid = await cs.find_or_create("b24_lead", str(crm_id))
				elif crm_type == "DEAL" and crm_id:
					uuid = await cs.find_or_create("b24_deal", str(crm_id))
				if not uuid and phone:
					uuid = await cs.find_or_create("phone", phone)
				if not uuid:
					# нет идентификатора — пропустим
					errors += 1
					continue

				ctype = int(call.get("CALL_TYPE") or 0)
				if ctype == 1:
					et = "call_out"
				elif ctype == 2:
					et = "call_in"
				elif ctype == 3:
					et = "call_missed"
				elif ctype == 4:
					et = "call_missed_out"
				else:
					et = "call_unknown"
				duration = int(call.get("CALL_DURATION") or 0)
				summary = f"{et} {phone or ''} {duration}s".strip()

				await cs.ingest_event(
					customer_uuid=uuid, resolve_alias=None,
					ts=iso_from_b24(call.get("CALL_START_DATE") or ""),
					source="b24_call", event_type=et, channel="telephony",
					summary=summary,
					payload={"backfill": True, "duration": duration, "phone": phone,
					         "record_url": call.get("CALL_RECORD_URL"),
					         "crm_entity_type": crm_type, "crm_entity_id": crm_id,
					         "portal_user_id": call.get("PORTAL_USER_ID")},
					b24_contact_id=int(crm_id) if crm_type == "CONTACT" and crm_id else None,
					b24_lead_id=int(crm_id) if crm_type == "LEAD" and crm_id else None,
					b24_deal_id=int(crm_id) if crm_type == "DEAL" and crm_id else None,
					operator=str(call.get("PORTAL_USER_ID") or ""),
				)
				processed += 1
			except Exception as e:
				errors += 1
				logging.exception("call %s failed: %s", call.get("ID"), e)
		st["last_start"] = offset + len(batch)
		st["processed"] = processed
		st["errors"] = errors
		if processed % CHECKPOINT_EVERY_N == 0 or len(batch) < B24_PAGE_SIZE:
			save_state(full_state)
		rate = processed / max(time.monotonic() - since, 1)
		logging.info("calls: offset=%d processed=%d errors=%d rate=%.1f/s",
		             st["last_start"], processed, errors, rate)

	st["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
	save_state(full_state)
	logging.info("=== calls done: %d processed, %d errors ===", processed, errors)


async def stage_openlines(b24: B24Client, cs: CSClient, state: dict, full_state: dict):
	"""Stage 5: открытые линии — все сессии (activities PROVIDER_ID=IMOPENLINES_SESSION) + история сообщений каждой.

	Структура B24:
	  - crm.activity.list?filter[PROVIDER_ID]=IMOPENLINES_SESSION → ~255k активностей
	  - каждая activity: ASSOCIATED_ENTITY_ID=session_id, OWNER_ID+OWNER_TYPE_ID (1=Lead,2=Deal,3=Contact),
	    PROVIDER_PARAMS.USER_CODE = "telegrambot|8|<bot_id>|<chat_id>" (channel|line|...)
	  - imopenlines.session.history.get?SESSION_ID=N → {chatId, sessionId, message: {id: {senderid,date,text,params}}}

	Events:
	  - source=b24_openlines, event_type=session_opened (для activity)
	  - event_type=message_in / message_out / session_event (для каждого сообщения)
	  channel = первая часть USER_CODE (telegrambot, livechat, network, instagram, ...)
	"""
	st = state
	logging.info("=== Stage: openlines (last_start=%s) ===", st["last_start"])
	processed = st["processed"]
	msgs_in = st.get("msgs_in", 0)
	msgs_out = st.get("msgs_out", 0)
	msgs_sys = st.get("msgs_sys", 0)
	denied = st.get("denied", 0)  # сколько сессий — ACCESS_DENIED (метаданные есть, тексты нет)
	errors = st["errors"]
	since = time.monotonic()

	# OWNER_TYPE_ID enum (B24). DEAL пропускаем — customer-service не знает alias b24_deal
	# (deal-сессии редки; при необходимости резолвить через лид/контакт из сделки отдельно).
	OWNER = {"1": ("b24_lead", "b24_lead_id"), "3": ("b24_contact", "b24_contact_id")}

	def parse_user_code(uc: str) -> tuple[str, str]:
		"""'telegrambot|8|3114035|168' → ('telegrambot', '8')"""
		if not uc:
			return ("", "")
		parts = uc.split("|")
		channel = parts[0] if parts else ""
		line = parts[1] if len(parts) > 1 else ""
		return (channel, line)

	def classify_msg(m: dict) -> str:
		"""message_in (от клиента) / message_out (оператор) / session_event (system/bot)."""
		senderid = str(m.get("senderid") or "0")
		params = m.get("params") or {}
		# senderid=0 → system (например «X завершила работу с диалогом»)
		if senderid == "0":
			return "session_event"
		# Сообщения с connectorMid идут от клиента через connector (incoming)
		if params.get("connectorMid"):
			return "message_in"
		# Иначе — оператор печатал из B24
		return "message_out"

	# Поля для запроса activities
	select = ["ID", "ASSOCIATED_ENTITY_ID", "OWNER_ID", "OWNER_TYPE_ID",
	          "CREATED", "PROVIDER_PARAMS", "RESPONSIBLE_ID", "SUBJECT"]
	params = {f"select[{i}]": s for i, s in enumerate(select)}
	params["filter[PROVIDER_ID]"] = "IMOPENLINES_SESSION"
	params["order[ID]"] = "ASC"

	async for offset, page_acts in b24.list_paginated("crm.activity.list", start=st["last_start"], params=params):
		# 1) Подготовить data для всех activity в странице, отсеять не-CRM owner'ов (Deal=2 и др.)
		page_data: list[dict] = []
		for act in page_acts:
			owner_type = str(act.get("OWNER_TYPE_ID") or "")
			if owner_type not in OWNER:
				# сделки и прочее — пропускаем (см. комментарий у OWNER)
				continue
			session_id = act.get("ASSOCIATED_ENTITY_ID")
			owner_id = act.get("OWNER_ID")
			if not session_id or not owner_id or str(owner_id) == "0":
				continue
			user_code = (act.get("PROVIDER_PARAMS") or {}).get("USER_CODE") or ""
			channel, line = parse_user_code(user_code)
			page_data.append({
				"act_id": act.get("ID"),
				"session_id": str(session_id),
				"owner_type": owner_type,
				"owner_id": owner_id,
				"user_code": user_code,
				"channel": channel,
				"line": line,
				"created": act.get("CREATED") or "",
				"responsible_id": act.get("RESPONSIBLE_ID"),
			})

		# 2) Резолвим UUID для каждой activity (параллельно через CS — semaphore=8)
		async def resolve_uuid(pd: dict) -> str | None:
			alias_type, _ = OWNER[pd["owner_type"]]
			return await cs.find_or_create(alias_type, str(pd["owner_id"]))
		uuids = await asyncio.gather(*[resolve_uuid(pd) for pd in page_data])
		for pd, uuid in zip(page_data, uuids):
			pd["uuid"] = uuid

		# 3) Batch history.get для всех session_id в странице (1 B24 запрос на 50 сессий)
		valid_pd = [pd for pd in page_data if pd["uuid"]]
		hist_results: dict[str, dict | None] = {}
		if valid_pd:
			cmds = {f"s{pd['session_id']}": ("imopenlines.session.history.get",
			                                  {"SESSION_ID": pd["session_id"]})
			        for pd in valid_pd}
			try:
				hist_results = await b24.batch(cmds)
			except Exception as e:
				logging.warning("batch history.get failed for page off=%d: %s", offset, e)
				hist_results = {tag: None for tag in cmds}

		# 4) Для каждой activity — emit session_opened + per-message events
		for pd in page_data:
			if not pd["uuid"]:
				errors += 1
				continue
			uuid = pd["uuid"]
			owner_kw_name = "b24_lead_id" if pd["owner_type"] == "1" else "b24_contact_id"
			owner_kwargs = {owner_kw_name: int(pd["owner_id"])}
			try:
				await cs.ingest_event(
					customer_uuid=uuid, resolve_alias=None,
					ts=iso_from_b24(pd["created"]),
					source="b24_openlines", event_type="session_opened",
					channel=pd["channel"],
					summary=f"OL session #{pd['session_id']} [{pd['channel']}|line {pd['line']}]",
					payload={"backfill": True, "session_id": pd["session_id"],
					         "user_code": pd["user_code"], "line_id": pd["line"],
					         "channel": pd["channel"], "responsible_id": pd["responsible_id"]},
					operator=str(pd["responsible_id"] or ""),
					**owner_kwargs,
				)
			except Exception as e:
				errors += 1
				logging.exception("session_opened sess=%s failed: %s", pd["session_id"], e)
				continue

			# История из batch
			hist = hist_results.get(f"s{pd['session_id']}")
			if hist is None:
				logging.warning("no batch result for session=%s", pd["session_id"])
				processed += 1
				continue
			if isinstance(hist, dict) and "__error__" in hist:
				if hist["__error__"] == "ACCESS_DENIED":
					denied += 1
				processed += 1
				continue

			messages = (hist.get("message") if isinstance(hist, dict) else None) or {}
			chat_id = hist.get("chatId") if isinstance(hist, dict) else None
			sorted_msgs = sorted(messages.values(), key=lambda m: int(m.get("id") or 0))
			for m in sorted_msgs:
				try:
					etype = classify_msg(m)
					text = (m.get("textlegacy") or m.get("text") or "").strip() or "[вложение/системное]"
					summary = text[:200]
					senderid = str(m.get("senderid") or "")
					operator_str = senderid if etype == "message_out" else ""
					await cs.ingest_event(
						customer_uuid=uuid, resolve_alias=None,
						ts=iso_from_b24(m.get("date") or pd["created"]),
						source="b24_openlines", event_type=etype,
						channel=pd["channel"], summary=summary,
						payload={"backfill": True, "session_id": pd["session_id"],
						         "chat_id": chat_id, "msg_id": m.get("id"),
						         "user_code": pd["user_code"], "sender_id": senderid,
						         "text": text, "params": m.get("params") or {}},
						operator=operator_str,
						**owner_kwargs,
					)
					if etype == "message_in":
						msgs_in += 1
					elif etype == "message_out":
						msgs_out += 1
					else:
						msgs_sys += 1
				except Exception as e:
					errors += 1
					logging.exception("msg in session=%s failed: %s", pd["session_id"], e)
			processed += 1
		st["last_start"] = offset + len(page_acts)
		st["processed"] = processed
		st["msgs_in"] = msgs_in
		st["msgs_out"] = msgs_out
		st["msgs_sys"] = msgs_sys
		st["denied"] = denied
		st["errors"] = errors
		save_state(full_state)
		rate = processed / max(time.monotonic() - since, 1)
		logging.info("openlines: off=%d sess=%d in=%d out=%d sys=%d denied=%d err=%d rate=%.2f sess/s",
		             st["last_start"], processed, msgs_in, msgs_out, msgs_sys, denied, errors, rate)

	st["finished_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
	save_state(full_state)
	logging.info("=== openlines done: %d sessions, %d in / %d out / %d sys msgs, %d denied, %d errors ===",
	             processed, msgs_in, msgs_out, msgs_sys, denied, errors)


# === main ===

async def main():
	setup_logging()
	stages = sys.argv[1:] if len(sys.argv) > 1 else ["all"]
	if stages == ["all"]:
		stages = ["contacts", "leads", "deals", "calls", "openlines"]
	logging.info("backfill start: stages=%s", stages)

	state = load_state()
	# back-compat: дополняем недостающие стадии при апгрейде схемы state.json
	state.setdefault("openlines", {"last_start": 0, "processed": 0, "msgs_in": 0,
	                                "msgs_out": 0, "msgs_sys": 0, "errors": 0, "finished_at": None})
	b24 = B24Client(load_b24_url())
	cs = CSClient(CS_BASE, load_cs_secret())
	try:
		for s in stages:
			if s == "contacts":
				await stage_contacts(b24, cs, state["contacts"], state)
			elif s == "leads":
				await stage_leads(b24, cs, state["leads"], state)
			elif s == "deals":
				await stage_deals(b24, cs, state["deals"], state)
			elif s == "calls":
				await stage_calls(b24, cs, state["calls"], state)
			elif s == "openlines":
				await stage_openlines(b24, cs, state["openlines"], state)
			else:
				logging.warning("unknown stage %s — skip", s)
	finally:
		await b24.aclose()
		await cs.aclose()
	logging.info("backfill done")


if __name__ == "__main__":
	asyncio.run(main())
