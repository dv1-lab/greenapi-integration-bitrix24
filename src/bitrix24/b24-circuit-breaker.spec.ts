import { B24CircuitBreaker } from "./b24-circuit-breaker";

describe("B24CircuitBreaker", () => {
	const make = (t: { v: number }) =>
		new B24CircuitBreaker({ baseCooldownMs: 1000, maxCooldownMs: 8000, now: () => t.v });

	it("закрыт по умолчанию — ждать не нужно", () => {
		const t = { v: 0 };
		expect(make(t).msUntilClosed()).toBe(0);
	});

	it("после overload открывается на base, по истечении времени закрывается", () => {
		const t = { v: 0 };
		const cb = make(t);
		cb.recordOverload();
		expect(cb.msUntilClosed()).toBe(1000);
		t.v = 999;
		expect(cb.msUntilClosed()).toBe(1);
		t.v = 1000;
		expect(cb.msUntilClosed()).toBe(0);
	});

	it("подряд идущие overload растут экспоненциально до max", () => {
		const t = { v: 0 };
		const cb = make(t);
		cb.recordOverload(); // 1000
		expect(cb.msUntilClosed()).toBe(1000);
		t.v = 1000; cb.recordOverload(); // 2000
		expect(cb.msUntilClosed()).toBe(2000);
		t.v = 3000; cb.recordOverload(); // 4000
		expect(cb.msUntilClosed()).toBe(4000);
		t.v = 7000; cb.recordOverload(); // 8000 (cap), не 16000
		expect(cb.msUntilClosed()).toBe(8000);
	});

	it("recordSuccess сбрасывает рост и закрывает breaker", () => {
		const t = { v: 0 };
		const cb = make(t);
		cb.recordOverload(); cb.recordOverload();
		cb.recordSuccess();
		expect(cb.msUntilClosed()).toBe(0);
		cb.recordOverload(); // снова с base, т.к. счётчик сброшен
		expect(cb.msUntilClosed()).toBe(1000);
	});
});
