import { Controller, Post, Req, Res, HttpCode, HttpStatus } from "@nestjs/common";
import { Request, Response } from "express";
import { GreenApiLogger } from "@green-api/greenapi-integration";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { StartupBackfillService } from "./startup-backfill.service";
import { OutgoingAuditService } from "./outgoing-audit.service";

/**
 * REST для ручного запуска startup-backfill (например, после очередного
 * downtime — если хочется не ждать рестарта adapter, а догнать прямо
 * сейчас). Auth: `X-Hint-Secret` от env `BRIDGE_HINT_SECRET`.
 *
 * Использование:
 *   curl -X POST https://social.9wb.ru/recovery/run-backfill \
 *     -H "X-Hint-Secret: $BRIDGE_HINT_SECRET"
 */
@ApiTags("Recovery")
@Controller("recovery")
export class RecoveryController {
	private readonly logger = GreenApiLogger.getInstance(RecoveryController.name);

	constructor(
		private readonly backfill: StartupBackfillService,
		private readonly outgoingAudit: OutgoingAuditService,
	) {}

	@Post("run-backfill")
	@HttpCode(HttpStatus.OK)
	@ApiOperation({
		summary: "Manual startup-backfill (task #71)",
		description:
			"Запускает backfill incoming сообщений Green API за последние BACKFILL_STARTUP_MINUTES " +
			"(дефолт 1440 = 24ч). Auth: X-Hint-Secret. Возвращает агрегат: instances/recovered/skipped/errors.",
	})
	async runBackfill(@Req() req: Request, @Res() res: Response): Promise<void> {
		const expected = process.env.BRIDGE_HINT_SECRET || "";
		const given = String(req.headers["x-hint-secret"] || "");
		if (expected && given !== expected) {
			res.status(HttpStatus.UNAUTHORIZED).json({ error: "unauthorized" });
			return;
		}
		try {
			const result = await this.backfill.runBackfill();
			res.json({ ok: true, ...result });
		} catch (error: any) {
			this.logger.error(`recovery/run-backfill failed: ${error.message}`);
			res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: error.message });
		}
	}

	@Post("outgoing-audit")
	@HttpCode(HttpStatus.OK)
	@ApiOperation({
		summary: "Dry-run audit operator outgoing messages (task #72)",
		description:
			"Сравнивает operator-сообщения в B24 open-line чатах с нашей OutgoingMessage таблицей. " +
			"Возвращает количество потенциально не доставленных + sample. НЕ ретраит, только аудит. " +
			"Параметры: { minutes?: number } (default 1440). Auth: X-Hint-Secret.",
	})
	async runOutgoingAudit(@Req() req: Request, @Res() res: Response): Promise<void> {
		const expected = process.env.BRIDGE_HINT_SECRET || "";
		const given = String(req.headers["x-hint-secret"] || "");
		if (expected && given !== expected) {
			res.status(HttpStatus.UNAUTHORIZED).json({ error: "unauthorized" });
			return;
		}
		const body = (req.body || {}) as { minutes?: number };
		try {
			const result = await this.outgoingAudit.audit({ minutes: body.minutes });
			res.json({ ok: true, ...result });
		} catch (error: any) {
			this.logger.error(`recovery/outgoing-audit failed: ${error.message}`);
			res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: error.message });
		}
	}
}
