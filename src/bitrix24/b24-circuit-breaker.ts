export interface B24CircuitBreakerOptions {
	/** Базовый cooldown после первой перегрузки, мс. */
	baseCooldownMs: number;
	/** Потолок cooldown, мс. */
	maxCooldownMs: number;
	/** Источник времени (для тестируемости). По умолчанию Date.now. */
	now?: () => number;
}

/**
 * Размыкатель нагрузки на B24. При перегрузке портала (OVERLOAD_LIMIT/
 * QUERY_LIMIT) «открывается» на растущий cooldown — пока открыт, обёртка REST
 * не должна слать запросы. Без зависимостей от Nest/axios — чистая логика.
 *
 * Применяется ко ВСЕМ appKind (защита от блокировки портала). В отличие от
 * постоянного крана min-interval, который душит только фоновый customer360 —
 * breaker срабатывает лишь при реальном OVERLOAD, поэтому безопасен и для
 * интерактивного social-трафика (сообщения клиентам).
 */
export class B24CircuitBreaker {
	private readonly base: number;
	private readonly max: number;
	private readonly now: () => number;
	private openUntil = 0;
	private consecutive = 0;

	constructor(opts: B24CircuitBreakerOptions) {
		this.base = opts.baseCooldownMs;
		this.max = opts.maxCooldownMs;
		this.now = opts.now ?? Date.now;
	}

	/** Сколько мс ждать до следующего запроса (0 — можно слать). */
	msUntilClosed(): number {
		return Math.max(0, this.openUntil - this.now());
	}

	/** Зафиксировать перегрузку — открыть breaker на растущий cooldown. */
	recordOverload(): void {
		this.consecutive += 1;
		const cooldown = Math.min(this.max, this.base * 2 ** (this.consecutive - 1));
		this.openUntil = this.now() + cooldown;
	}

	/** Успешный ответ — сбросить рост и закрыть breaker. */
	recordSuccess(): void {
		this.consecutive = 0;
		this.openUntil = 0;
	}
}
