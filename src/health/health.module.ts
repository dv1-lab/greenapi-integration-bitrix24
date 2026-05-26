import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { PrismaModule } from "../prisma/prisma.module";
import { Bitrix24Module } from "../bitrix24/bitrix24.module";
import { AlertsService } from "./alerts.service";
import { B24HealthCheckService } from "./b24-health-check.service";
import { MetricsController } from "./metrics.controller";
import { PerfMetricsService } from "../common/perf-metrics.service";

@Module({
	imports: [ConfigModule, PrismaModule, Bitrix24Module],
	controllers: [MetricsController],
	providers: [AlertsService, B24HealthCheckService, PerfMetricsService],
	exports: [AlertsService, PerfMetricsService],
})
export class HealthModule {}
