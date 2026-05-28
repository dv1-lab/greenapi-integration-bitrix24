// In-memory rolling counter всех B24 REST вызовов. Запись из
// `Bitrix24Service.callBitrix24Method`, чтение через `GET /metrics/b24`.
//
// Цель — видеть текущую нагрузку на B24 (per app) ДО блокировки OVERLOAD_LIMIT.
// 18.05.2026 первый OVERLOAD на Social Connector V1, 28.05.2026 второй на
// customer-360-bridge V1 → миграция V1→V2. Без счётчика мы летим вслепую.
//
// Не хранит сами вызовы, только timestamp + (app, method, result) tag.
// Rolling window: 24 часа (с фильтром при snapshot). Hard cap 100K событий
// (~50 r/sec × 30 мин буфер) — при превышении старые удаляются.
//
// thread-safe: Node single-thread → ок.
// O(1) на запись. O(N) на snapshot (фильтр массива, ~30K-100K событий).

import { Injectable } from "@nestjs/common";

export type B24CallResult = "ok" | "overload" | "4xx" | "5xx" | "timeout" | "network" | "expired_token" | "other";

interface CallRecord {
	ts: number;          // ms-unix
	app: string;         // "social" | "customer360"
	method: string;      // "crm.lead.add", "imconnector.send.messages" и т.п.
	result: B24CallResult;
	durationMs: number;
}

const MAX_EVENTS = 100_000;
const RETENTION_MS = 25 * 3600 * 1000; // 25 часов — чтобы 24h-окно не теряло хвост при GC

@Injectable()
export class B24MetricsService {
	private events: CallRecord[] = [];

	/** Записать вызов B24. Должно быть дёшево — это горячий путь. */
	record(app: string, method: string, result: B24CallResult, durationMs: number): void {
		const ts = Date.now();
		this.events.push({ ts, app, method, result, durationMs });
		// Lazy GC: периодически сбрасываем хвост >25ч. Не на каждой записи —
		// дорого. Раз в 100 записей достаточно.
		if (this.events.length % 100 === 0) {
			const cutoff = ts - RETENTION_MS;
			let i = 0;
			while (i < this.events.length && this.events[i].ts < cutoff) i++;
			if (i > 0) this.events.splice(0, i);
			// Hard cap
			if (this.events.length > MAX_EVENTS) {
				this.events.splice(0, this.events.length - MAX_EVENTS);
			}
		}
	}

	/** Snapshot текущего состояния — формат для /metrics/b24 endpoint. */
	snapshot(): B24MetricsSnapshot {
		const now = Date.now();
		const apps = new Set<string>();
		for (const e of this.events) apps.add(e.app);
		const result: B24MetricsSnapshot = {
			as_of: new Date(now).toISOString(),
			apps: {},
			thresholds: {
				per_hour_warn: Number(process.env.B24_HOUR_WARN || 2400),
				per_hour_critical: Number(process.env.B24_HOUR_CRITICAL || 3000),
				per_day_warn: Number(process.env.B24_DAY_WARN || 24000),
				per_day_critical: Number(process.env.B24_DAY_CRITICAL || 30000),
			},
			total_buffered: this.events.length,
		};
		for (const app of apps) {
			const cutoff_1m = now - 60 * 1000;
			const cutoff_1h = now - 3600 * 1000;
			const cutoff_24h = now - 24 * 3600 * 1000;

			let calls_1m = 0, calls_1h = 0, calls_24h = 0;
			let errors_1h = 0, overload_24h = 0, timeout_1h = 0;
			const methodCounts = new Map<string, { ok: number; err: number }>();

			for (const e of this.events) {
				if (e.app !== app) continue;
				if (e.ts <= cutoff_24h) continue;
				calls_24h++;
				if (e.result === "overload") overload_24h++;
				if (e.ts > cutoff_1h) {
					calls_1h++;
					if (e.result !== "ok") errors_1h++;
					if (e.result === "timeout") timeout_1h++;
					const mc = methodCounts.get(e.method) || { ok: 0, err: 0 };
					if (e.result === "ok") mc.ok++; else mc.err++;
					methodCounts.set(e.method, mc);
				}
				if (e.ts > cutoff_1m) calls_1m++;
			}

			const top_methods_1h = Array.from(methodCounts.entries())
				.map(([method, c]) => ({ method, count: c.ok + c.err, errors: c.err }))
				.sort((a, b) => b.count - a.count)
				.slice(0, 15);

			result.apps[app] = {
				calls_last_1m: calls_1m,
				calls_last_1h: calls_1h,
				calls_last_24h: calls_24h,
				errors_last_1h: errors_1h,
				timeouts_last_1h: timeout_1h,
				overload_last_24h: overload_24h,
				blocked: overload_24h > 0,
				top_methods_1h,
			};
		}
		return result;
	}

	/** Только для тестов — сбросить buffer. */
	_reset(): void {
		this.events = [];
	}
}

export interface B24AppSnapshot {
	calls_last_1m: number;
	calls_last_1h: number;
	calls_last_24h: number;
	errors_last_1h: number;
	timeouts_last_1h: number;
	overload_last_24h: number;
	blocked: boolean;
	top_methods_1h: Array<{ method: string; count: number; errors: number }>;
}

export interface B24MetricsSnapshot {
	as_of: string;
	apps: Record<string, B24AppSnapshot>;
	thresholds: {
		per_hour_warn: number;
		per_hour_critical: number;
		per_day_warn: number;
		per_day_critical: number;
	};
	total_buffered: number;
}
