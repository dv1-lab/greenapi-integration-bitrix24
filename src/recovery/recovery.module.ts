import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module";
import { Bitrix24Module } from "../bitrix24/bitrix24.module";
import { StartupBackfillService } from "./startup-backfill.service";
import { RecoveryController } from "./recovery.controller";

/**
 * Recovery — модуль fault-tolerance после downtime adapter.
 *
 * - `StartupBackfillService` — task #71, догоняет пропущенные incoming
 *   через `lastIncomingMessages` Green API при старте.
 * - `RecoveryController` — REST endpoint для ручного запуска backfill
 *   и получения статистики (под `X-Hint-Secret`).
 *
 * См. ADR `decisions/2026-05-27-startup-backfill-incoming.md`.
 */
@Module({
	imports: [PrismaModule, Bitrix24Module],
	controllers: [RecoveryController],
	providers: [StartupBackfillService],
	exports: [StartupBackfillService],
})
export class RecoveryModule {}
