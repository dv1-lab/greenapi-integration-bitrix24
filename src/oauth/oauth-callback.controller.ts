import { Controller, Get, HttpException, HttpStatus, Query, Res } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Response } from "express";
import axios from "axios";
import { PrismaService } from "../prisma/prisma.service";
import { ApiTags } from "@nestjs/swagger";

/**
 * GET /oauth/callback — кастомный OAuth redirect endpoint.
 *
 * SDK Green API использует /oauth/install ждущий POST от B24 (server-side install
 * flow), но мы видели, что B24 на текущем портале такой POST не шлёт. Поэтому
 * добавляем явный OAuth Authorization Code flow: пользователь идёт по /oauth/authorize,
 * B24 редиректит сюда с ?code=... — обмениваем на access/refresh, кладём в БД.
 */
@ApiTags("oauth")
@Controller("oauth")
export class OAuthCallbackController {
	constructor(
		private readonly config: ConfigService,
		private readonly prisma: PrismaService,
	) {}

	@Get("callback")
	async callback(
		@Query() q: {
			code?: string;
			domain?: string;
			server_domain?: string;
			member_id?: string;
			error?: string;
		},
		@Res() res: Response,
	) {
		if (q.error) {
			throw new HttpException(`OAuth error: ${q.error}`, HttpStatus.BAD_REQUEST);
		}
		if (!q.code || !q.domain) {
			throw new HttpException("Missing code/domain", HttpStatus.BAD_REQUEST);
		}

		const clientId = this.config.get<string>("BITRIX24_CLIENT_ID");
		const clientSecret = this.config.get<string>("BITRIX24_CLIENT_SECRET");
		if (!clientId || !clientSecret) {
			throw new HttpException("Server: B24 OAuth credentials not configured", HttpStatus.INTERNAL_SERVER_ERROR);
		}

		const server = q.server_domain || "oauth.bitrix.info";
		let tokens: any;
		try {
			const r = await axios.get(`https://${server}/oauth/token/`, {
				params: {
					client_id: clientId,
					client_secret: clientSecret,
					grant_type: "authorization_code",
					code: q.code,
				},
				timeout: 15000,
			});
			tokens = r.data;
		} catch (err: any) {
			// Не выводим URL — клиент_секрет может быть в нём при axios error
			throw new HttpException(
				`Token exchange failed: ${err.response?.status || err.code || "?"}`,
				HttpStatus.BAD_GATEWAY,
			);
		}

		if (!tokens?.access_token) {
			throw new HttpException("Token exchange returned no access_token", HttpStatus.BAD_GATEWAY);
		}

		const expiresAt = new Date(Date.now() + (tokens.expires_in || 3600) * 1000);

		await this.prisma.createUser({
			id: q.domain,
			portalDomain: q.domain,
			accessToken: tokens.access_token,
			refreshToken: tokens.refresh_token || "",
			tokenExpiresAt: expiresAt,
			// Заполнится позже при первом B24 webhook'е через Bitrix24WebhookGuard.
			applicationToken: "",
		});

		res.type("html").send(`<!DOCTYPE html>
<html lang="ru"><head><meta charset="utf-8"><title>OAuth установлен</title>
<style>body{font-family:-apple-system,sans-serif;max-width:520px;margin:50px auto;padding:24px;color:#1a1a1a}
h1{color:#2d8f4e}code{background:#eef;padding:2px 6px;border-radius:4px;font-size:13px}</style></head><body>
<h1>✓ OAuth установлен</h1>
<p>Portal: <code>${q.domain}</code></p>
<p>Scope: <code>${tokens.scope || "—"}</code></p>
<p>Tokens сохранены в БД adapter. Закрой окно.</p>
</body></html>`);
	}
}
