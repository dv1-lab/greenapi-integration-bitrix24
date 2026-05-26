// NestJS interceptor — меряет latency каждого endpoint и регистрирует в
// PerfMetricsService. Глобальный, без opt-in/out (для baseline нужен
// полный обзор).
//
// Endpoint key = `${method} ${route}`. route берётся из NestJS reflector
// (через ExecutionContext) — там нормализованный path с :params, а не
// resolved URL. Это даёт нам стабильные buckets вне зависимости от
// конкретных id.

import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from "@nestjs/common";
import { Observable } from "rxjs";
import { tap, catchError } from "rxjs/operators";
import { throwError } from "rxjs";
import { PerfMetricsService } from "./perf-metrics.service";

@Injectable()
export class PerformanceInterceptor implements NestInterceptor {
	constructor(private readonly metrics: PerfMetricsService) {}

	intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
		const httpCtx = context.switchToHttp();
		const req = httpCtx.getRequest();
		const res = httpCtx.getResponse();

		const method = req.method || "GET";
		// route.path — NestJS resolved pattern (например "/webhooks/:hook")
		// Если нет — fallback на req.path.
		const route = req.route?.path || req.path || "/";
		const endpoint = `${method} ${route}`;

		const start = process.hrtime.bigint();

		return next.handle().pipe(
			tap(() => {
				const elapsed = Number(process.hrtime.bigint() - start) / 1_000_000; // ms
				const statusCode = res.statusCode || 200;
				this.metrics.record(endpoint, elapsed, statusCode);
			}),
			catchError((err) => {
				const elapsed = Number(process.hrtime.bigint() - start) / 1_000_000;
				const statusCode = err?.status || err?.statusCode || 500;
				this.metrics.record(endpoint, elapsed, statusCode);
				return throwError(() => err);
			}),
		);
	}
}
