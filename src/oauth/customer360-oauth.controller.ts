import { Controller, Post, Body, Res, HttpStatus, Head, Query } from "@nestjs/common";
import { Response } from "express";
import { PrismaService } from "../prisma/prisma.service";
import { GreenApiLogger } from "@green-api/greenapi-integration";
import { ApiTags } from "@nestjs/swagger";

/**
 * OAuth install handler для **второго** B24-приложения — `customer-360-bridge`.
 *
 * Цель: разделить нагрузку B24-API между двумя OAuth-app'ами:
 * - `social_connector` (текущий, /oauth/install) — imconnector/OpenLines/widget
 * - `customer-360-bridge` (этот, /oauth/customer360/install) — все CRM-операции
 *   Customer-360 (UF поля, event.bind, sync UUID, timeline-comment).
 *
 * Преимущества:
 * - Лимиты B24 (50 req/sec, ~30K/hour) — per app, не per portal. Два app
 *   дают ×2 запас и изолируют риск бана между потоками.
 * - Если customer-360 app забанят — social_connector продолжает работать
 *   и наоборот.
 *
 * Установка (одноразово, требует Дмитрия в B24 admin):
 *
 * 1. В B24 портале «Разработчикам → Другое → Локальное приложение»:
 *    - Название: customer-360-bridge
 *    - Тип: server
 *    - Адрес приложения: https://social.9wb.ru/oauth/customer360/install
 *    - Адрес обработчика установки: тот же
 *    - Права (scope): crm, user, placement, event
 *
 * 2. Получить CLIENT_ID и CLIENT_SECRET → положить в .env adapter'а:
 *    BITRIX24_CUSTOMER360_CLIENT_ID=local....
 *    BITRIX24_CUSTOMER360_CLIENT_SECRET=...
 *
 * 3. Перезапустить adapter (`docker compose up -d --build adapter`).
 *
 * 4. Открыть установленное приложение в B24 (Маркет → Установленные).
 *    B24 пришлёт POST на /oauth/customer360/install с access/refresh токенами.
 *    Adapter сохранит их в OAuthApp[customer360].
 *
 * 5. После этого все Customer-360 операции (ensureUfField,
 *    syncCustomerUuidBatch, registerB24CrmEvents, handleB24CrmEvent,
 *    addTimelineCommentByPhone) автоматически идут через customer-360 токен.
 *
 * До п. 4 callBitrix24Method(appKind='customer360') делает graceful fallback
 * на social_connector — Customer-360 продолжает работать на одном app.
 */
@ApiTags("oauth")
@Controller("oauth/customer360")
export class Customer360OAuthController {
	private readonly logger = GreenApiLogger.getInstance(Customer360OAuthController.name);

	constructor(private readonly prisma: PrismaService) {}

	@Head("install")
	async installHead(@Res() res: Response) {
		res.status(200).send();
	}

	@Post("install")
	async install(
		@Body() body: any,
		@Query() query: any,
		@Res() res: Response,
	) {
		this.logger.info("Customer-360 OAuth install received", {
			event: body.event,
			domain: query.DOMAIN,
			hasAuthId: !!body.AUTH_ID,
		});

		const domain = String(query.DOMAIN || body?.auth?.domain || "");
		const accessToken = String(body.AUTH_ID || body?.auth?.access_token || "");
		const refreshToken = String(body.REFRESH_ID || body?.auth?.refresh_token || "");
		const expiresIn = body.AUTH_EXPIRES || body?.auth?.expires_in;
		const clientId = process.env.BITRIX24_CUSTOMER360_CLIENT_ID || "";
		const clientSecret = process.env.BITRIX24_CUSTOMER360_CLIENT_SECRET || "";

		if (!domain || !accessToken) {
			this.logger.error("Customer-360 install: missing params", { domain, hasAccessToken: !!accessToken });
			return res.status(HttpStatus.BAD_REQUEST).json({ error: "missing domain or access_token" });
		}
		if (!clientId || !clientSecret) {
			this.logger.error("Customer-360 install: BITRIX24_CUSTOMER360_CLIENT_ID/SECRET not configured");
			return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
				error: "BITRIX24_CUSTOMER360_CLIENT_ID/SECRET must be set in adapter .env before install",
			});
		}

		const expiresAt = expiresIn
			? new Date(Date.now() + parseInt(String(expiresIn)) * 1000)
			: undefined;

		try {
			await this.prisma.upsertOAuthApp({
				portalDomain: domain,
				appKind: "customer360",
				clientId,
				clientSecret,
				accessToken,
				refreshToken: refreshToken || undefined,
				tokenExpiresAt: expiresAt,
				applicationToken: body.APPLICATION_TOKEN || undefined,
				scope: String(body.SCOPE || body?.auth?.scope || ""),
			});

			this.logger.log(`Customer-360 OAuth installed for portal: ${domain}`);

			res.setHeader("Content-Type", "text/html");
			res.setHeader("X-Frame-Options", "ALLOWALL");
			res.setHeader("Content-Security-Policy", "frame-ancestors *");
			return res.status(HttpStatus.CREATED).send(`<!DOCTYPE html>
<html lang="ru"><head><title>Customer-360 установлено</title>
<script src="//api.bitrix24.com/api/v1/"></script>
<style>body{font-family:Arial,sans-serif;padding:40px;background:#f8f9fa;text-align:center;margin:0}
.box{max-width:500px;margin:0 auto;background:white;border-radius:12px;padding:40px;box-shadow:0 4px 20px rgba(0,0,0,0.08)}
.ok{background:#d4edda;color:#155724;padding:20px;border-radius:8px;font-weight:bold}</style>
</head><body><div class="box"><div class="ok">✅ Customer-360 Bridge установлен</div>
<p>Customer-360 операции теперь идут через отдельный OAuth-токен. Social Connector работает независимо.</p>
</div><script>if(typeof BX24!=='undefined'){BX24.init(()=>BX24.installFinish())}</script></body></html>`);
		} catch (error: any) {
			this.logger.error(`Customer-360 install failed: ${error.message}`, error);
			return res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: error.message });
		}
	}
}
