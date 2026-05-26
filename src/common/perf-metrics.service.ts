// In-memory сбор латенции endpoints. Ring-buffer per endpoint, рассчёт
// percentile при запросе /health/metrics. Нулевая внешняя инфраструктура —
// ничего не льётся в логи/CH/файлы, только память (одна стрелка на ~50KB).
//
// При рестарте adapter'а — данные обнуляются. Это норма: baseline-цифры
// собираются за час-два соотв. снимка, не для long-term retention.
// Для long-term — нужен Prometheus / OTel + storage (gap #).
//
// Endpoint = `${method} ${routePath}`, route без query/params. Пример:
//   "POST /webhooks/green-api", "GET /widget/instances", "GET /api"
//
// Скрытые требования:
//   - thread-safe (Node single-thread → не нужен mutex)
//   - O(1) на запись (ring buffer)
//   - O(n log n) на percentile (sort) — но n = 1000, ok

import { Injectable } from "@nestjs/common";

const RING_SIZE = 1000;  // последние N запросов на endpoint
const MAX_ENDPOINTS = 200;  // защита от взрыва памяти (мало ли route variant'ы)

interface RingBuffer {
	samples: number[];  // ms (мс с float точностью)
	cursor: number;
	count: number;
	totalCount: number;  // абсолютный счётчик (не урезается ring'ом)
	errorCount: number;  // 5xx / throw — для error rate
	statusCounts: Record<number, number>;  // 200: N, 4xx: M, 5xx: K
}

export interface EndpointMetrics {
	endpoint: string;
	count: number;
	errorCount: number;
	errorRate: number;
	statusCodes: Record<number, number>;
	avg: number;
	p50: number;
	p95: number;
	p99: number;
	min: number;
	max: number;
}

@Injectable()
export class PerfMetricsService {
	private readonly buffers: Map<string, RingBuffer> = new Map();
	private readonly startedAt = Date.now();

	record(endpoint: string, latencyMs: number, statusCode: number): void {
		let buf = this.buffers.get(endpoint);
		if (!buf) {
			// Защита от cardinality-взрыва: 200 разных endpoint'ов нам выше крыши
			if (this.buffers.size >= MAX_ENDPOINTS) {
				return;
			}
			buf = {
				samples: new Array(RING_SIZE).fill(0),
				cursor: 0,
				count: 0,
				totalCount: 0,
				errorCount: 0,
				statusCounts: {},
			};
			this.buffers.set(endpoint, buf);
		}
		buf.samples[buf.cursor] = latencyMs;
		buf.cursor = (buf.cursor + 1) % RING_SIZE;
		if (buf.count < RING_SIZE) buf.count++;
		buf.totalCount++;
		buf.statusCounts[statusCode] = (buf.statusCounts[statusCode] || 0) + 1;
		if (statusCode >= 500) {
			buf.errorCount++;
		}
	}

	getMetrics(endpoint: string): EndpointMetrics | null {
		const buf = this.buffers.get(endpoint);
		if (!buf || buf.count === 0) return null;
		const samples = buf.samples.slice(0, buf.count).sort((a, b) => a - b);
		return {
			endpoint,
			count: buf.totalCount,
			errorCount: buf.errorCount,
			errorRate: buf.totalCount > 0 ? buf.errorCount / buf.totalCount : 0,
			statusCodes: { ...buf.statusCounts },
			avg: samples.reduce((s, v) => s + v, 0) / samples.length,
			p50: percentile(samples, 0.5),
			p95: percentile(samples, 0.95),
			p99: percentile(samples, 0.99),
			min: samples[0],
			max: samples[samples.length - 1],
		};
	}

	getAllMetrics(): EndpointMetrics[] {
		const out: EndpointMetrics[] = [];
		for (const endpoint of this.buffers.keys()) {
			const m = this.getMetrics(endpoint);
			if (m) out.push(m);
		}
		// Сортируем по count убыванию — самые частые сверху
		out.sort((a, b) => b.count - a.count);
		return out;
	}

	getSummary(): {
		uptimeSec: number;
		endpointsTracked: number;
		totalRequests: number;
		totalErrors: number;
		globalErrorRate: number;
	} {
		let totalRequests = 0;
		let totalErrors = 0;
		for (const buf of this.buffers.values()) {
			totalRequests += buf.totalCount;
			totalErrors += buf.errorCount;
		}
		return {
			uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
			endpointsTracked: this.buffers.size,
			totalRequests,
			totalErrors,
			globalErrorRate: totalRequests > 0 ? totalErrors / totalRequests : 0,
		};
	}

	// Для тестов
	reset(): void {
		this.buffers.clear();
	}
}

/**
 * Линейная интерполяция percentile на отсортированном массиве.
 * Простая и достаточно точная для baseline (не Prometheus-уровень).
 */
export function percentile(sortedSamples: number[], p: number): number {
	if (sortedSamples.length === 0) return 0;
	if (sortedSamples.length === 1) return sortedSamples[0];
	const idx = p * (sortedSamples.length - 1);
	const lo = Math.floor(idx);
	const hi = Math.ceil(idx);
	if (lo === hi) return sortedSamples[lo];
	const frac = idx - lo;
	return sortedSamples[lo] * (1 - frac) + sortedSamples[hi] * frac;
}
