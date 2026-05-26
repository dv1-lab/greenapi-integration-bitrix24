import { PerfMetricsService, percentile } from "./perf-metrics.service";

describe("percentile", () => {
	it("пустой массив → 0", () => {
		expect(percentile([], 0.5)).toBe(0);
	});

	it("один элемент → он сам", () => {
		expect(percentile([42], 0.5)).toBe(42);
		expect(percentile([42], 0.95)).toBe(42);
	});

	it("p50 на отсортированном", () => {
		// 5 элементов: idx = 0.5 * 4 = 2 → elements[2] = 30
		expect(percentile([10, 20, 30, 40, 50], 0.5)).toBe(30);
	});

	it("p95 на 20 элементах с linear interpolation", () => {
		const samples = Array.from({ length: 20 }, (_, i) => (i + 1) * 10); // 10..200
		// idx = 0.95 * 19 = 18.05 → between samples[18]=190 and samples[19]=200
		// 190 * 0.95 + 200 * 0.05 = 190.5
		expect(percentile(samples, 0.95)).toBeCloseTo(190.5, 1);
	});

	it("p99 на 100 элементах", () => {
		const samples = Array.from({ length: 100 }, (_, i) => i + 1);
		// idx = 0.99 * 99 = 98.01 → ~99.01
		expect(percentile(samples, 0.99)).toBeCloseTo(99.01, 1);
	});

	it("p0 → min, p1.0 → max (или close)", () => {
		const samples = [5, 10, 15, 20, 25];
		expect(percentile(samples, 0)).toBe(5);
		expect(percentile(samples, 1)).toBe(25);
	});
});

describe("PerfMetricsService", () => {
	let service: PerfMetricsService;

	beforeEach(() => {
		service = new PerfMetricsService();
	});

	it("первый record создаёт buffer", () => {
		service.record("GET /api", 12.5, 200);
		const m = service.getMetrics("GET /api");
		expect(m).not.toBeNull();
		expect(m!.count).toBe(1);
		expect(m!.avg).toBe(12.5);
		expect(m!.min).toBe(12.5);
		expect(m!.max).toBe(12.5);
	});

	it("getMetrics → null для неизвестного endpoint", () => {
		expect(service.getMetrics("GET /unknown")).toBeNull();
	});

	it("несколько records — корректные avg/min/max", () => {
		[10, 20, 30, 40, 50].forEach((v) => service.record("GET /a", v, 200));
		const m = service.getMetrics("GET /a")!;
		expect(m.count).toBe(5);
		expect(m.avg).toBe(30);
		expect(m.min).toBe(10);
		expect(m.max).toBe(50);
		expect(m.p50).toBe(30);
	});

	it("error rate — записи с 5xx", () => {
		service.record("POST /b", 100, 200);
		service.record("POST /b", 200, 200);
		service.record("POST /b", 300, 500);
		service.record("POST /b", 400, 502);
		const m = service.getMetrics("POST /b")!;
		expect(m.count).toBe(4);
		expect(m.errorCount).toBe(2);
		expect(m.errorRate).toBe(0.5);
		expect(m.statusCodes).toEqual({ 200: 2, 500: 1, 502: 1 });
	});

	it("4xx НЕ считается error (это клиентская проблема)", () => {
		service.record("GET /c", 5, 404);
		service.record("GET /c", 5, 400);
		const m = service.getMetrics("GET /c")!;
		expect(m.errorCount).toBe(0);
		expect(m.errorRate).toBe(0);
	});

	it("ring-buffer не растёт бесконечно (1000 элементов max)", () => {
		// Запишем 1500 — count должен застыть на 1000
		for (let i = 0; i < 1500; i++) {
			service.record("GET /high-load", i, 200);
		}
		const m = service.getMetrics("GET /high-load")!;
		// count в getMetrics — это RING_SIZE, не totalCount
		expect(m.count).toBe(1500); // count = totalCount (счётчик всех запросов)
		// А вот sample-buffer ограничен 1000 — min будет 500 (значения 500..1499)
		expect(m.min).toBe(500);
		expect(m.max).toBe(1499);
	});

	it("getAllMetrics сортирует по count убыванию", () => {
		service.record("GET /low", 5, 200);
		for (let i = 0; i < 10; i++) service.record("GET /high", 5, 200);
		for (let i = 0; i < 5; i++) service.record("GET /mid", 5, 200);
		const all = service.getAllMetrics();
		expect(all.map((m) => m.endpoint)).toEqual(["GET /high", "GET /mid", "GET /low"]);
	});

	it("getSummary агрегирует по всем endpoints", () => {
		for (let i = 0; i < 100; i++) service.record("GET /a", 5, 200);
		for (let i = 0; i < 50; i++) service.record("POST /b", 5, 500);
		const s = service.getSummary();
		expect(s.endpointsTracked).toBe(2);
		expect(s.totalRequests).toBe(150);
		expect(s.totalErrors).toBe(50);
		expect(s.globalErrorRate).toBeCloseTo(50 / 150);
	});

	it("reset() очищает state", () => {
		service.record("GET /x", 1, 200);
		service.reset();
		expect(service.getAllMetrics()).toEqual([]);
		expect(service.getSummary().totalRequests).toBe(0);
	});

	it("percentile реалистичный кейс — p99 ловит outlier'ы", () => {
		// 100 запросов: 90 нормальных (10-30 мс), 10 медленных (200-500 мс)
		// p50 = ~20 мс (медиан в нормальных)
		// p95 = idx 0.95*99 = 94.05 → между 94м и 95м, после sort это уже медленные
		// p99 = idx 0.99*99 = 98.01 → точно в медленных
		for (let i = 0; i < 90; i++) service.record("GET /e", 10 + Math.random() * 20, 200);
		for (let i = 0; i < 10; i++) service.record("GET /e", 200 + Math.random() * 300, 200);
		const m = service.getMetrics("GET /e")!;
		expect(m.count).toBe(100);
		expect(m.p50).toBeLessThan(35); // быстрый медиан
		expect(m.p95).toBeGreaterThan(150); // p95 ловит хвост (10% медленных)
		expect(m.p99).toBeGreaterThan(150);
	});
});
