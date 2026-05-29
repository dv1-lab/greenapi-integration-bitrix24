// @Global чтобы B24MetricsService был доступен в Bitrix24Module + HealthModule
// без cross-import (избегаем циклической зависимости — HealthModule уже
// imports Bitrix24Module).

import { Global, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { B24MetricsService } from "./b24-metrics.service";
import { B24OverloadAlertService } from "./b24-overload-alert.service";
import { B24MetricsPusherService } from "./b24-metrics-pusher.service";

@Global()
@Module({
	imports: [ConfigModule],
	providers: [B24MetricsService, B24OverloadAlertService, B24MetricsPusherService],
	exports: [B24MetricsService, B24OverloadAlertService],
})
export class B24MetricsModule {}
