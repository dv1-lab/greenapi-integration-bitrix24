// @Global чтобы B24MetricsService был доступен в Bitrix24Module + HealthModule
// без cross-import (избегаем циклической зависимости — HealthModule уже
// imports Bitrix24Module).

import { Global, Module } from "@nestjs/common";
import { B24MetricsService } from "./b24-metrics.service";

@Global()
@Module({
	providers: [B24MetricsService],
	exports: [B24MetricsService],
})
export class B24MetricsModule {}
