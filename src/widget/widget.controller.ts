import { All, Body, Controller, Get, HttpException, HttpStatus, Post, Req, Res } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Request, Response } from "express";
import axios from "axios";
import { PrismaService } from "../prisma/prisma.service";
import { Bitrix24Service } from "../bitrix24/bitrix24.service";

// Карта префикса idInstance → API URL Green API. У свежих instance shard в host'е,
// у старых (вроде 1101948511) — общий api.green-api.com.
function greenApiUrl(idInstance: string): string {
	const known: Record<string, string> = {
		"1103487233": "https://1103.api.green-api.com",
		"1101948511": "https://api.green-api.com",
		"3100621187": "https://3100.api.green-api.com",
		"4100621194": "https://4100.api.green-api.com",
	};
	return known[idInstance] || "https://api.green-api.com";
}

@Controller("widget")
export class WidgetController {
	constructor(
		private readonly config: ConfigService,
		private readonly prisma: PrismaService,
		private readonly bitrix24: Bitrix24Service,
	) {}

	@Get("instances")
	async listInstances() {
		// Используется фронтендом виджета — список доступных инстансов для выбора.
		const insts = await this.prisma.instance.findMany({
			select: { idInstance: true, bitrixLine: true, stateInstance: true, settings: true },
		});
		const list = insts.map(i => ({
			idInstance: i.idInstance.toString(),
			bitrixLine: i.bitrixLine,
			stateInstance: i.stateInstance,
			label: (i.settings as any)?.label || `Instance ${i.idInstance}`,
			provider: ((i.settings as any)?.provider || "wa"),
		}));

		// Виртуальный инстанс Instagram через i2crm Public API. У 1begovoy.ru
		// гибридное подключение — Direct работает без 24h-окна Meta.
		const igAccountId = this.config.get<string>("I2CRM_INSTAGRAM_ACCOUNT_ID");
		const igKey = this.config.get<string>("I2CRM_TARGET_KEY_PUBLICAPI");
		const igLineDirect = this.config.get<string>("I2CRM_LINE_ID_IG_DIRECT");
		if (igAccountId && igKey) {
			list.push({
				idInstance: `i2crm:${igAccountId}`,
				bitrixLine: igLineDirect ? Number(igLineDirect) : null,
				stateInstance: "authorized",
				label: `Instagram Direct — @1begovoy.ru`,
				provider: "instagram",
			} as any);
		}

		return list;
	}

	@Get("entity-phone")
	async getEntityPhone(
		@Req() req: Request,
	): Promise<{ phone: string | null }> {
		const portal = String(req.query.portal || "");
		const type = String(req.query.type || "");
		const id = String(req.query.id || "");
		if (!portal || !type || !id) return { phone: null };
		const phone = await this.prisma.getEntityPhonePref(portal, type, id);
		return { phone };
	}

	@Post("entity-phone")
	async setEntityPhone(
		@Body() body: { portal?: string; type?: string; id?: string; phone?: string },
	): Promise<{ ok: boolean }> {
		if (!body?.portal || !body?.type || !body?.id || !body?.phone) {
			throw new HttpException("portal, type, id, phone required", HttpStatus.BAD_REQUEST);
		}
		await this.prisma.setEntityPhonePref(body.portal, body.type, body.id, body.phone);
		return { ok: true };
	}

	// B24 placement шлёт POST с form-data, прямой переход из браузера — GET.
	// Принимаем оба через @All, кроме POST /widget/send (см. ниже).
	@All("send-first")
	render(@Req() req: Request, @Body() body: any, @Res() res: Response) {
		res.setHeader("X-Frame-Options", "ALLOWALL");
		res.setHeader("Content-Security-Policy", "frame-ancestors *");
		// B24 при открытии placement шлёт в body AUTH_ID/REFRESH_ID/DOMAIN — это
		// свежий OAuth-токен Social Connector app, валиден ~1 час. Передаём в JS,
		// чтобы виджет мог отправить mirror через application context.
		const authId = (body && body.AUTH_ID) || "";
		const domain = (body && body.DOMAIN) || ((req.query.DOMAIN as string) || "");
		res.type("html").send(this.renderHtml(authId, domain));
	}

	@Post("check-account")
	async checkAccount(@Body() body: { phone?: string; idInstance?: string }) {
		const phone = (body.phone || "").replace(/[^\d]/g, "");
		if (phone.length < 10 || phone.length > 15) {
			throw new HttpException(`Неверный номер: "${body.phone}"`, HttpStatus.BAD_REQUEST);
		}
		if (!body.idInstance) {
			throw new HttpException("idInstance required", HttpStatus.BAD_REQUEST);
		}
		const inst = await this.prisma.instance.findUnique({
			where: { idInstance: BigInt(body.idInstance) },
		});
		if (!inst) {
			throw new HttpException("Instance не найден в БД", HttpStatus.NOT_FOUND);
		}
		const idInstance = inst.idInstance.toString();
		const apiToken = inst.apiTokenInstance;
		const apiUrl = greenApiUrl(idInstance);
		const provider = ((inst.settings as any)?.provider || "wa").toLowerCase();

		try {
			if (provider === "wa") {
				const r = await axios.post(
					`${apiUrl}/waInstance${idInstance}/checkWhatsapp/${apiToken}`,
					{ phoneNumber: Number(phone) },
					{ timeout: 15000 },
				);
				return { exist: !!r.data?.existsWhatsapp, provider, phone };
			}
			// MAX-shard принимает string, Telegram-shard — integer.
			const phoneForApi = provider === "telegram" ? Number(phone) : phone;
			const r = await axios.post(
				`${apiUrl}/waInstance${idInstance}/CheckAccount/${apiToken}`,
				{ phoneNumber: phoneForApi },
				{ timeout: 15000 },
			);
			return {
				exist: !!r.data?.exist,
				chatId: r.data?.chatId || null,
				provider,
				phone,
			};
		} catch (err: any) {
			const msg = err.response?.data || err.message;
			throw new HttpException(
				`Green API check: ${typeof msg === "string" ? msg : JSON.stringify(msg)}`,
				HttpStatus.BAD_GATEWAY,
			);
		}
	}

	@Post("send")
	async send(@Body() body: { phone?: string; text?: string; authId?: string; domain?: string; idInstance?: string; chatIdOverride?: string; usernameOverride?: string }) {
		const phone = (body.phone || "").replace(/[^\d]/g, "");
		const text = (body.text || "").trim();
		const chatIdOverride = (body.chatIdOverride || "").trim();
		// Telegram-only: @username, который оператор ввёл вручную. Не путать с
		// chatIdOverride (числовой user_id из B24-привязки). Сами @ срезаем —
		// добавим позже в нужном формате под Green API.
		const usernameOverride = (body.usernameOverride || "").trim().replace(/^@/, "");

		// Virtual idInstance `i2crm:<accountId>` → Instagram через i2crm Public API.
		// Отдельный pipeline (не Green API). Делаем здесь до проверки phone/Instance.
		if (body.idInstance && body.idInstance.startsWith("i2crm:")) {
			if (!text) {
				throw new HttpException("Текст пуст", HttpStatus.BAD_REQUEST);
			}
			return this.sendInstagramDirect({
				clientId: chatIdOverride || usernameOverride,
				text,
				authId: body.authId,
				domain: body.domain,
				username: usernameOverride || undefined,
			});
		}

		// phone обязателен только если нет chatIdOverride/usernameOverride
		// (для MAX/Telegram валидно отправлять без phone, по известному chatId/username).
		if (!chatIdOverride && !usernameOverride && (phone.length < 10 || phone.length > 15)) {
			throw new HttpException(`Неверный номер: "${body.phone}"`, HttpStatus.BAD_REQUEST);
		}
		if (!text) {
			throw new HttpException("Текст пуст", HttpStatus.BAD_REQUEST);
		}

		// Поиск Instance по выбору фронта; если не указан — берём первый authorized.
		// Подгружаем user — нужен portalDomain для ensureOpenLeadForPhone.
		let inst;
		if (body.idInstance) {
			inst = await this.prisma.instance.findUnique({
				where: { idInstance: BigInt(body.idInstance) },
				include: { user: true },
			});
		}
		if (!inst) {
			inst = await this.prisma.instance.findFirst({
				where: { stateInstance: "authorized" },
				orderBy: { idInstance: "asc" },
				include: { user: true },
			});
		}
		if (!inst) {
			throw new HttpException("Нет авторизованных Green API инстансов в БД adapter", HttpStatus.INTERNAL_SERVER_ERROR);
		}

		const idInstance = inst.idInstance.toString();
		const apiToken = inst.apiTokenInstance;
		const apiUrl = greenApiUrl(idInstance);

		// Определяем провайдера. WhatsApp использует chatId=phone@c.us, MAX —
		// внутренний chatId (CheckAccount). Telegram аналогично — внутренний
		// user_id, причём резолв phone→user_id требует чтобы номер был в адресной
		// книге нашего Telegram-аккаунта (Telegram privacy).
		const provider = ((inst.settings as any)?.provider || "wa").toLowerCase();
		let chatId: string;
		if (provider === "max" || provider === "telegram") {
			// Приоритет 1: явный chatId от фронта (виджет нашёл его в B24 open-line
			// привязке контакта).
			if (chatIdOverride) {
				chatId = chatIdOverride;
				if (phone.length >= 10) {
					await this.prisma.maxContact.upsert({
						where: { idInstance_phone: { idInstance: BigInt(idInstance), phone } },
						create: { idInstance: BigInt(idInstance), phone, chatId },
						update: { chatId },
					});
				}
			} else if (usernameOverride && (provider === "telegram" || provider === "max")) {
				// Приоритет 2: @username от оператора. И Telegram, и MAX
				// поддерживают идентификацию по username (нику) в обход
				// privacy-настроек поиска по phone. Green API принимает
				// chatId в формате `<username>@c.us`.
				chatId = `${usernameOverride}@c.us`;
			} else {
				// Приоритет 3: локальный кеш phone → chatId (заполнялся при
				// прошлой успешной отправке).
				let cached = await this.prisma.maxContact.findUnique({
					where: { idInstance_phone: { idInstance: BigInt(idInstance), phone } },
				});
				if (!cached) {
					// Приоритет 4: CheckAccount у Green API. Для MAX — резолвит
					// если номер в контактах MAX-аккаунта. Для Telegram — если
					// номер в адресной книге Telegram-аккаунта И клиент в
					// privacy "находить по номеру" не запретил.
					const providerLabel = provider === "max" ? "MAX" : "Telegram";
					try {
						// Telegram-shard валидирует phoneNumber как integer (выкидывает
						// "Validation failed" на string). MAX-shard принимает string.
						// Приводим к int если это валидное число — иначе ошибка пользователю.
						const phoneNumeric = Number(phone);
						const phoneForApi = provider === "telegram"
							? (Number.isFinite(phoneNumeric) ? phoneNumeric : phone)
							: phone;
						const r = await axios.post(
							`${apiUrl}/waInstance${idInstance}/CheckAccount/${apiToken}`,
							{ phoneNumber: phoneForApi },
							{ timeout: 15000 },
						);
						if (!r.data?.exist || !r.data?.chatId) {
							const hint = provider === "telegram"
								? `Telegram: номер +${phone} не найден. Telegram отдаёт user_id по номеру только если: (а) номер в адресной книге Telegram-аккаунта 79584983354, ИЛИ (б) у клиента в Telegram-privacy "Кто может найти меня по номеру" = Все. Если уже была переписка — открой виджет в карточке клиента где привязан Telegram-чат. Альтернатива — введи @username клиента в поле ниже.`
								: `MAX: номер +${phone} не найден. Возможно у клиента нет MAX, либо его нет в контактах MAX-аккаунта 79584983354. Если уже была переписка — попробуйте из карточки клиента где привязан MAX-чат.`;
							throw new HttpException(hint, HttpStatus.NOT_FOUND);
						}
						cached = await this.prisma.maxContact.create({
							data: { idInstance: BigInt(idInstance), phone, chatId: String(r.data.chatId) },
						});
					} catch (err: any) {
						if (err instanceof HttpException) throw err;
						const msg = err.response?.data || err.message;
						throw new HttpException(`${providerLabel} CheckAccount: ${typeof msg === "string" ? msg : JSON.stringify(msg)}`, HttpStatus.BAD_GATEWAY);
					}
				}
				chatId = cached.chatId;
			}
		} else {
			chatId = `${phone}@c.us`;
		}

		let idMessage: string | undefined;
		try {
			const r = await axios.post(
				`${apiUrl}/waInstance${idInstance}/sendMessage/${apiToken}`,
				{ chatId, message: text },
				{ timeout: 15000 },
			);
			idMessage = r.data?.idMessage;
		} catch (err: any) {
			const msg = err.response?.data || err.message;
			throw new HttpException(`Green API: ${typeof msg === "string" ? msg : JSON.stringify(msg)}`, HttpStatus.BAD_GATEWAY);
		}

		// Зеркалим в ту B24 open line, к которой привязан выбранный инстанс.
		// Для MAX/Telegram используем chatId (внутренний) как ключ user/chat — тот же,
		// что adapter ставит для входящих, иначе будет два разных диалога.
		const lineForMirror = inst.bitrixLine || undefined;
		const mirrorKey = (provider === "max" || provider === "telegram") ? chatId : phone;

		// Поиск существующего B24-контакта и привязка к нему. Для WA — по phone.
		// Для MAX/Telegram — по сохранённому chatId в UF_CRM_*_CHAT_ID
		// (адаптер заполняет это поле при incoming, если уже было общение).
		if (lineForMirror && inst.user?.portalDomain) {
			const phoneE164 = (phone.length >= 10 && phone.length <= 15) ? `+${phone}` : "";
			const channelLabel = provider === "max" ? "MAX" : provider === "telegram" ? "Telegram" : "WhatsApp";
			const chatIdForUf = (provider === "max" || provider === "telegram") ? chatId : undefined;
			if (phoneE164 || chatIdForUf) {
				try {
					await this.bitrix24.ensureOpenLeadForPhone(
						inst.user.portalDomain,
						phoneE164,
						phoneE164 || (chatIdForUf || ""),
						lineForMirror,
						channelLabel,
						chatIdForUf,
					);
				} catch (e: any) {
					console.warn("[widget] ensureOpenLeadForPhone failed:", e?.message);
				}
			}
		}

		const mirrored = await this.mirrorToBitrix(mirrorKey, text, idMessage, body.authId, body.domain, lineForMirror, provider);
		return { ok: true, idMessage, chatId, idInstance, line: lineForMirror, mirrored };
	}

	// Отправка в Instagram Direct через i2crm Public API. Для клиентов, чей
	// client_id уже сохранён в UF_CRM_IG_CHAT_ID (записан automatic backfill
	// после incoming через webhook). Без client_id i2crm не примет — username
	// не resolveится через их API.
	private async sendInstagramDirect(input: {
		clientId: string;
		text: string;
		authId?: string;
		domain?: string;
		username?: string;
	}): Promise<any> {
		const clientId = (input.clientId || "").trim().replace(/^@/, "");
		if (!clientId) {
			throw new HttpException(
				"Не нашли Instagram client_id у клиента. Открой карточку лида созданного из Instagram (там IG_CHAT_ID есть), либо введи числовой client_id вручную.",
				HttpStatus.BAD_REQUEST,
			);
		}
		// client_id у Instagram — числовой. Если ввели @username, мы не сможем
		// его сразу резолвить (нет такого endpoint у i2crm). Заставим ввести
		// именно client_id.
		if (!/^\d+$/.test(clientId)) {
			throw new HttpException(
				`Instagram client_id должен быть числом, получено "${clientId}". Либо открой карточку лида с Instagram — там UF_CRM_IG_CHAT_ID подставится автоматически.`,
				HttpStatus.BAD_REQUEST,
			);
		}

		const apiBase = this.config.get<string>("I2CRM_API_BASE") || "https://app.i2crm.ru/api_v1";
		const targetKey = this.config.get<string>("I2CRM_TARGET_KEY_PUBLICAPI");
		const accountId = this.config.get<string>("I2CRM_INSTAGRAM_ACCOUNT_ID");
		const lineDirect = Number(this.config.get<string>("I2CRM_LINE_ID_IG_DIRECT"));
		if (!targetKey || !accountId) {
			throw new HttpException("I2CRM не настроен (TARGET_KEY/ACCOUNT_ID)", HttpStatus.INTERNAL_SERVER_ERROR);
		}

		const body = {
			domain: "instagram",
			source: String(accountId),
			client: String(clientId),
			type: "direct",
			text: input.text,
		};

		let idMessage: string | undefined;
		try {
			const r = await axios.post(`${apiBase}/target/feedback`, body, {
				params: { key: targetKey },
				timeout: 15000,
				validateStatus: () => true,
			});
			const result = r.data;
			if (result?.error) {
				const errMsg = typeof result.error === "string" ? result.error : JSON.stringify(result.error);
				throw new HttpException(`i2crm: ${errMsg}`, HttpStatus.BAD_GATEWAY);
			}
			idMessage = String(result?.data?.id || result?.data?.external_ids?.[0] || `i2crm_${Date.now()}`);
		} catch (err: any) {
			if (err instanceof HttpException) throw err;
			throw new HttpException(`i2crm transport: ${err.message}`, HttpStatus.BAD_GATEWAY);
		}

		// Зеркалим в B24 open line (Instagram Direct = 18) — как для других каналов.
		// Это создаст карточку диалога в B24 чтобы оператор видел свою же отправку.
		// displayName = @username клиента (без пробелов) — иначе B24 покажет
		// «i2crm_ig_<id>» в имени chat-user.
		const displayName = input.username && !/\s/.test(input.username)
			? input.username
			: undefined;
		const mirrored = await this.mirrorToBitrix(
			`i2crm_ig_${clientId}`,
			input.text,
			idMessage,
			input.authId,
			input.domain,
			lineDirect || undefined,
			"instagram",
			displayName,
		);

		return { ok: true, idMessage, chatId: `i2crm_ig_${clientId}`, idInstance: `i2crm:${accountId}`, line: lineDirect, mirrored };
	}

	private async mirrorToBitrix(
		idKey: string, text: string, idMessage?: string,
		authId?: string, domain?: string, lineOverride?: number,
		provider: string = "wa",
		displayNameOverride?: string,
	): Promise<boolean | string> {
		const line = lineOverride ?? Number(this.config.get<string>("BITRIX_LINE_ID"));
		if (!line) return false; // нет линии — пропускаем

		// Для WA idKey = phone (10-15 цифр) → можно сформировать E.164 + user.phone.
		// Для MAX/Telegram idKey = chatId (внутренний user_id), телефона нет.
		const isPhoneLike = provider === "wa" && /^\d{10,15}$/.test(idKey);
		const phoneE164 = isPhoneLike ? `+${idKey}` : null;
		// Префикс должен совпадать с тем что adapter ставит при входящих:
		//   WA → wa_ (там идентификатор реально телефон).
		//   MAX и Telegram → sc_. Раньше Telegram использовал wa_ для legacy
		//   compat — но из-за этого B24 авто-генерил TITLE «<id> WhatsApp - …»
		//   (видел wa_ → решил что это WhatsApp). Перешли на sc_ в adapter
		//   2026-05-16, виджет синхронизирован.
		// Instagram: adapter в handleI2crmIncoming уже формирует user.id как
		// `i2crm_ig_<clientId>`. Если idKey уже с этим префиксом — используем
		// без добавления `sc_`, иначе будет mismatch с входящими (B24 видит
		// как разных chat-users → создаст дубль лида).
		const useWaPrefix = isPhoneLike;
		const userKey = provider === "instagram" && idKey.startsWith("i2crm_ig_")
			? idKey
			: useWaPrefix ? `wa_${idKey}` : `sc_${idKey}`;
		// ВАЖНО: name без пробелов. B24 при создании лида/контакта разбивает
		// name по пробелу и кладёт хвост в LAST_NAME. «WhatsApp 79228124797»
		// → NAME=«WhatsApp», LAST_NAME=«79228124797» — мусор в карточке.
		// Для Instagram передаём username клиента (UF_CRM_IG_USERNAME) через
		// displayNameOverride, иначе оператор увидит «i2crm_ig_<id>» вместо
		// dima_kuznetsov.
		// Для IG без username делаем читаемый fallback «IG <client_id>» — без
		// технического префикса «i2crm_ig_», иначе TITLE лида и имя контакта
		// получаются вида «i2crm_ig_27986508» (видел 2026-05-18).
		const igClientId = provider === "instagram" && idKey.startsWith("i2crm_ig_")
			? idKey.slice("i2crm_ig_".length)
			: idKey;
		const displayName = (displayNameOverride && !/\s/.test(displayNameOverride))
			? displayNameOverride
			: (isPhoneLike
				? (phoneE164 as string)
				: provider === "instagram"
					? `IG ${igClientId}`
					: idKey);
		const userBlock: any = { id: userKey, name: displayName };
		if (phoneE164) userBlock.phone = phoneE164;
		const payload = {
			CONNECTOR: "social_connector",
			LINE: Number(line),
			MESSAGES: [{
				user: userBlock,
				message: { id: idMessage || String(Date.now()), date: Math.floor(Date.now() / 1000), text },
				chat: { id: userKey, name: displayName, url: null },
				extra: { is_self_message: true },
			}],
		};

		// Используем OAuth-токен Social Connector V2 из БД (через
		// Bitrix24Service.sendImconnectorMessage). Inbound Webhook для этого
		// метода не работает — B24 отвечает «Application context required».
		// Placement authId тоже бывает протухает; токен из БД adapter сам
		// рефрешит, если нужно.
		const portalDomain = domain || this.config.get<string>("BITRIX_PORTAL_DOMAIN") || "1begovoy.bitrix24.ru";
		try {
			const r: any = await this.bitrix24.sendImconnectorMessage(portalDomain, payload);
			if (r?.error) return `b24:${r.error}`;
			return true;
		} catch (err: any) {
			return `b24 mirror via app-OAuth failed: ${err.response?.data?.error_description || err.message}`;
		}
	}

	private renderHtml(authId: string = "", domain: string = ""): string {
		const safe = (s: string) => s.replace(/[<>'"&]/g, "");
		const authJs = JSON.stringify({ authId: safe(authId), domain: safe(domain) });
		return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Social Connector — отправить сообщение</title>
<script src="//api.bitrix24.com/api/v1/"></script>
<style>
  * { box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 24px 24px 160px; background: #f5f7fa; color: #1a1a1a; min-height: 100vh; }
  .card { max-width: 560px; margin: 0 auto; background: #fff; border-radius: 12px; padding: 24px; box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
  h1 { margin: 0 0 4px; font-size: 18px; color: #2d8f4e; }
  .subtitle { margin: 0 0 20px; font-size: 13px; color: #6b7280; }
  label { display: block; font-size: 13px; font-weight: 500; margin: 12px 0 6px; }
  input, textarea, select { width: 100%; padding: 10px 12px; border: 1px solid #d1d5db; border-radius: 8px; font: inherit; font-size: 14px; background: #fff; }
  textarea { min-height: 110px; resize: vertical; }
  input:focus, textarea:focus, select:focus { outline: none; border-color: #2d8f4e; box-shadow: 0 0 0 3px rgba(45,143,78,0.15); }
  button { margin-top: 16px; padding: 11px 20px; background: #84cc16; color: #fff; border: 0; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; width: 100%; }
  button:hover { background: #65a30d; }
  button:disabled { background: #9ca3af; cursor: not-allowed; }
  .status { margin-top: 14px; padding: 10px 12px; border-radius: 8px; font-size: 13px; display: none; }
  .status.ok { display: block; background: #d1fae5; color: #065f46; }
  .status.err { display: block; background: #fee2e2; color: #991b1b; }
  .hint { font-size: 12px; color: #6b7280; margin-top: 4px; }
  .chips { display: flex !important; flex-wrap: wrap !important; gap: 6px !important; margin-bottom: 8px !important; }
  .chip { display: inline-flex !important; align-items: center !important; gap: 6px !important; padding: 6px 10px !important; border: 1px solid #d1d5db !important; border-radius: 999px !important; background: #fff !important; cursor: pointer !important; font-size: 13px !important; user-select: none !important; transition: all .15s !important; }
  .chip:hover { border-color: #2d8f4e !important; background: #f0fdf4 !important; }
  .chip.active { border-color: #2d8f4e !important; background: #2d8f4e !important; color: #fff !important; }
  .chip .chip-meta { font-size: 11px !important; opacity: 0.75 !important; }
  .chips-empty { font-size: 12px !important; color: #9ca3af !important; padding: 4px 0 !important; }
</style>
</head>
<body>
<div class="card">
  <h1>📤 Social Connector</h1>
  <p class="subtitle" id="subtitle">Первое сообщение клиенту</p>

  <label for="instance">Отправить с номера</label>
  <select id="instance">
    <option value="">загрузка…</option>
  </select>

  <label>Номер телефона клиента</label>
  <div id="phoneChips" class="chips"></div>
  <div style="display:flex; gap:8px; align-items:stretch;">
    <input id="phone" placeholder="+79261234567 или 79261234567" autocomplete="off" inputmode="tel" style="flex:1;">
    <button type="button" id="checkBtn" title="Проверить наличие WhatsApp / Telegram / MAX по номеру" style="margin-top:0; width:auto; padding: 10px 14px; background:#0ea5e9;">🔍 Проверить</button>
  </div>
  <div class="hint">Кликни нужный номер из списка выше или введи свой (с кодом страны, можно с + или без). Кнопка «Проверить» — запрос к мессенджеру по выбранному инстансу.</div>
  <div id="checkResult" class="status" style="margin-top:6px;"></div>

  <div id="tgUsernameBlock" style="display:none; margin-top:8px;">
    <label for="tgUsername">@username <span id="tgUsernameChannel">Telegram</span> <span style="color:#9ca3af; font-weight: 400;">(если знаешь — попробуем по username, минуя privacy-ограничения phone)</span></label>
    <input id="tgUsername" placeholder="ivan_ivanov" autocomplete="off">
    <div class="hint">Можно с символом @ в начале или без. Используется только для Telegram и MAX (в обоих есть никнеймы).</div>
  </div>

  <label for="text">Сообщение</label>
  <textarea id="text" placeholder="Здравствуйте! Это менеджер «Первый Беговой»…"></textarea>

  <button id="send">Отправить</button>
  <div id="status" class="status"></div>
  <details style="margin-top:14px; font-size:11px; color:#6b7280;">
    <summary style="cursor:pointer;">debug</summary>
    <pre id="debug" style="white-space:pre-wrap; word-break:break-all; margin:6px 0 0;"></pre>
  </details>
</div>

<script>
const B24_AUTH = ${authJs};
(function() {
  const $ = id => document.getElementById(id);
  const status = $("status");
  const debug = $("debug");
  const showStatus = (msg, ok) => {
    status.textContent = msg;
    status.className = "status " + (ok ? "ok" : "err");
  };
  const dbg = (label, data) => {
    if (!debug) return;
    debug.textContent += label + ": " + (typeof data === "string" ? data : JSON.stringify(data, null, 2)) + "\\n";
  };

  function setPhone(raw) {
    if (!raw) return;
    const digits = String(raw).replace(/[^\\d]/g, "");
    if (digits.length >= 10) $("phone").value = digits;
  }

  // Список телефонов из карточки CRM: рендерим чипами (pills).
  // Клик по чипу — подставляет в input #phone. Поле input всегда видимое,
  // если оператору нужен другой номер — просто очищает чип и пишет руками.
  let entityCtx = null;
  let phoneOptions = []; // [{digits, label}]
  function normalize(raw) { return String(raw || "").replace(/[^\\d]/g, ""); }
  function renderChips(preselectDigits) {
    const wrap = $("phoneChips");
    wrap.innerHTML = "";
    const selected = preselectDigits || (phoneOptions[0] && phoneOptions[0].digits) || "";
    if (!phoneOptions.length) {
      const empty = document.createElement("div");
      empty.className = "chips-empty";
      empty.textContent = "У клиента в CRM нет сохранённых номеров — введите ниже";
      wrap.appendChild(empty);
    }
    phoneOptions.forEach(p => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "chip" + (p.digits === selected ? " active" : "");
      btn.innerHTML = '<span>+' + p.digits + '</span>'
        + (p.label ? '<span class="chip-meta">· ' + p.label + '</span>' : '');
      btn.addEventListener("click", () => {
        $("phone").value = p.digits;
        [...wrap.querySelectorAll(".chip")].forEach(c => c.classList.remove("active"));
        btn.classList.add("active");
      });
      wrap.appendChild(btn);
    });
    if (selected) {
      $("phone").value = selected;
    }
  }
  // При ручном вводе в #phone снимаем active с чипов (если введён другой номер)
  // или подсвечиваем совпадающий чип
  $("phone").addEventListener("input", () => {
    const d = normalize($("phone").value);
    const chips = [...$("phoneChips").querySelectorAll(".chip")];
    chips.forEach(c => {
      const num = c.querySelector("span").textContent.replace("+", "");
      if (num === d) c.classList.add("active"); else c.classList.remove("active");
    });
  });
  function collectPhonesFromCrmRow(data, sourceLabel) {
    if (!data || !Array.isArray(data.PHONE)) return;
    data.PHONE.forEach(p => {
      const digits = normalize(p.VALUE);
      if (digits.length < 10) return;
      if (phoneOptions.find(x => x.digits === digits)) return; // де-дубликация
      const typeMap = { MOBILE: "моб", WORK: "раб", HOME: "дом", FAX: "факс", OTHER: "доп" };
      const meta = [sourceLabel, typeMap[p.VALUE_TYPE]].filter(Boolean).join(" · ");
      phoneOptions.push({ digits, label: meta });
    });
  }
  async function loadPrefAndRender() {
    let saved = null;
    if (entityCtx && B24_AUTH.domain) {
      try {
        const r = await fetch("/widget/entity-phone?portal=" + encodeURIComponent(B24_AUTH.domain)
          + "&type=" + encodeURIComponent(entityCtx.type)
          + "&id=" + encodeURIComponent(entityCtx.id));
        const j = await r.json();
        saved = j.phone ? normalize(j.phone) : null;
        dbg("pref", saved);
      } catch (e) { dbg("pref err", e.message); }
    }
    // Если сохранённый номер не в списке — добавляем как «ранее использован»
    if (saved && !phoneOptions.find(x => x.digits === saved)) {
      phoneOptions.unshift({ digits: saved, label: "ранее" });
    }
    renderChips(saved || (phoneOptions[0] && phoneOptions[0].digits));
  }

  // Подгружаем список инстансов (с какого номера слать) из adapter.
  // Labels приходят из БД (Instance.settings.label) через /widget/instances.
  // Карты для multi-channel UX:
  //   PROVIDER_MAP — idInstance → provider (wa/max/telegram) для subtitle
  //   INSTANCE_BY_ID — idInstance → весь Instance объект из API
  //   MAX_CHATS_BY_LINE — line_id → известный chatId из B24 user_code'ов
  const PROVIDER_MAP = {};
  const INSTANCE_BY_ID = {};
  const MAX_CHATS_BY_LINE = {};
  function detectChannelLabel(idInst) {
    const p = (PROVIDER_MAP[idInst] || "wa").toLowerCase();
    if (p === "max") return "MAX";
    if (p === "telegram") return "Telegram";
    if (p === "instagram") return "Instagram Direct";
    return "WhatsApp";
  }
  // B24 placement iframe имеет фиксированную высоту. У разных типов placement
  // разные методы изменения:
  //   - DETAIL_TAB / CONTACT_TAB / DEAL_TAB → BX24.fitWindow() (растягивает
  //     iframe до доступной высоты карточки, со скроллом внутри)
  //   - все остальные (TOOLBAR попапы, page-app) → BX24.resizeWindow(0, h)
  // Дёргаем оба, в нужном контексте сработает один — это безопасно.
  function resizeB24() {
    if (typeof BX24 === "undefined") return;
    try {
      const h = Math.max(
        document.body.scrollHeight,
        document.documentElement.scrollHeight,
        700
      );
      if (BX24.resizeWindow) BX24.resizeWindow(0, h + 200);
      if (BX24.fitWindow) BX24.fitWindow();
    } catch (e) {
      dbg("resize err", String(e));
    }
  }
  // Значения UF-полей из карточки клиента — подставим в @username input
  // в зависимости от выбранного провайдера (Telegram → UF_CRM_IM_TELEGRAM,
  // MAX → UF_CRM_MAX). Заполняется при загрузке crm.{lead,deal,contact}.get.
  const entityUsernames = { telegram: "", max: "", instagram: "" };
  // Стабильный chatId клиента (внутренний user_id мессенджера). Приоритет
  // выше username — chatId не меняется при смене ника. Заполняется тем же
  // путём (UF_CRM_TG_CHAT_ID / UF_CRM_MAX_CHAT_ID / UF_CRM_IG_CHAT_ID на сущности).
  const entityChatIds = { telegram: "", max: "", instagram: "" };
  function collectUsernames(data) {
    const tg = (data && data.UF_CRM_IM_TELEGRAM) ? String(data.UF_CRM_IM_TELEGRAM).replace(/^@/, "") : "";
    const mx = (data && data.UF_CRM_MAX) ? String(data.UF_CRM_MAX).replace(/^@/, "") : "";
    const ig = (data && data.UF_CRM_IG_USERNAME) ? String(data.UF_CRM_IG_USERNAME).replace(/^@/, "") : "";
    if (tg && !entityUsernames.telegram) entityUsernames.telegram = tg;
    if (mx && !entityUsernames.max) entityUsernames.max = mx;
    if (ig && !entityUsernames.instagram) entityUsernames.instagram = ig;
    const tgId = (data && data.UF_CRM_TG_CHAT_ID) ? String(data.UF_CRM_TG_CHAT_ID) : "";
    const mxId = (data && data.UF_CRM_MAX_CHAT_ID) ? String(data.UF_CRM_MAX_CHAT_ID) : "";
    const igId = (data && data.UF_CRM_IG_CHAT_ID) ? String(data.UF_CRM_IG_CHAT_ID) : "";
    if (tgId && !entityChatIds.telegram) entityChatIds.telegram = tgId;
    if (mxId && !entityChatIds.max) entityChatIds.max = mxId;
    if (igId && !entityChatIds.instagram) entityChatIds.instagram = igId;
  }
  function applyUsernameFromUf() {
    const idInst = $("instance").value;
    const p = (PROVIDER_MAP[idInst] || "").toLowerCase();
    const input = $("tgUsername");
    if (!input || input.value.trim()) return; // оператор уже ввёл — не перетираем
    if (p === "telegram" && entityUsernames.telegram) input.value = entityUsernames.telegram;
    else if (p === "max" && entityUsernames.max) input.value = entityUsernames.max;
    else if (p === "instagram" && entityUsernames.instagram) input.value = entityUsernames.instagram;
  }

  function updateSubtitle() {
    const idInst = $("instance").value;
    const channel = detectChannelLabel(idInst);
    $("subtitle").textContent = "Первое сообщение клиенту через " + channel;
    // Telegram, MAX, Instagram поддерживают @username; у WhatsApp — нет.
    const p = (PROVIDER_MAP[idInst] || "").toLowerCase();
    const hasUsername = p === "telegram" || p === "max" || p === "instagram";
    $("tgUsernameBlock").style.display = hasUsername ? "block" : "none";
    const ch = $("tgUsernameChannel");
    if (ch) ch.textContent = p === "max" ? "MAX" : p === "instagram" ? "Instagram" : "Telegram";
    // Для Instagram phone не нужен (i2crm не оперирует phone). Скрываем чипы
    // и поле phone+check, ввод идёт по UF_CRM_IG_CHAT_ID (auto) или вручную
    // @username (Instagram гибридное подключение i2crm — без 24h-окна Meta).
    const isInsta = p === "instagram";
    const phoneRow = $("phone")?.parentElement;
    if (phoneRow) phoneRow.style.display = isInsta ? "none" : "flex";
    const chipsEl = $("phoneChips");
    if (chipsEl) chipsEl.style.display = isInsta ? "none" : "";
    // Подсказка под полем телефона — скрыть для IG
    const hintAll = phoneRow ? phoneRow.parentElement.querySelectorAll(".hint") : [];
    if (hintAll && hintAll[0]) hintAll[0].style.display = isInsta ? "none" : "";
    const checkResult = $("checkResult");
    if (checkResult) checkResult.style.display = isInsta ? "none" : "";
    // Labels: для Instagram переименуем поля
    const phoneLabel = document.querySelector('label[for="phone"]');
    if (phoneLabel) phoneLabel.style.display = isInsta ? "none" : "";
    // При смене инстанса — подставим значение из соответствующего UF-поля,
    // если есть и оператор ещё не вводил руками.
    applyUsernameFromUf();
    resizeB24();
  }
  fetch("/widget/instances").then(r => r.json()).then(list => {
    const sel = $("instance");
    sel.innerHTML = "";
    if (!list.length) {
      sel.innerHTML = '<option value="">(нет инстансов в БД)</option>';
      return;
    }
    list.forEach(it => {
      PROVIDER_MAP[it.idInstance] = (it.provider || "wa");
      INSTANCE_BY_ID[it.idInstance] = it;
      const opt = document.createElement("option");
      opt.value = it.idInstance;
      // Label из БД (Instance.settings.label) с fallback на idInstance.
      opt.textContent = it.label || it.idInstance;
      sel.appendChild(opt);
    });
    sel.addEventListener("change", updateSubtitle);
    updateSubtitle();
  }).catch(e => dbg("instances fetch error", e.message));

  // У B24 для CRM_*_DETAIL_* тип сущности определяется placement-именем,
  // а entity ID лежит в options.ID / options.ENTITY_ID / options.entityId.
  // В LIST_MENU entity id может приходить как options.ID или options.element_id
  // (открыли меню на конкретной строке списка).
  const PLACEMENT_TO_METHOD = {
    // DETAIL_TOOLBAR — кнопка в шапке карточки
    CRM_LEAD_DETAIL_TOOLBAR: "crm.lead.get",
    CRM_DEAL_DETAIL_TOOLBAR: "crm.deal.get",
    CRM_CONTACT_DETAIL_TOOLBAR: "crm.contact.get",
    CRM_COMPANY_DETAIL_TOOLBAR: "crm.company.get",
    // DETAIL_TAB — отдельная вкладка в карточке
    CRM_LEAD_DETAIL_TAB: "crm.lead.get",
    CRM_DEAL_DETAIL_TAB: "crm.deal.get",
    CRM_CONTACT_DETAIL_TAB: "crm.contact.get",
    CRM_COMPANY_DETAIL_TAB: "crm.company.get",
    // DETAIL_ACTIVITY — в панели «Что нужно сделать»
    CRM_LEAD_DETAIL_ACTIVITY: "crm.lead.get",
    CRM_DEAL_DETAIL_ACTIVITY: "crm.deal.get",
    CRM_CONTACT_DETAIL_ACTIVITY: "crm.contact.get",
    CRM_COMPANY_DETAIL_ACTIVITY: "crm.company.get",
    // ACTIVITY_TIMELINE_MENU — три точки на записи timeline
    CRM_LEAD_ACTIVITY_TIMELINE_MENU: "crm.lead.get",
    CRM_DEAL_ACTIVITY_TIMELINE_MENU: "crm.deal.get",
    // LIST_MENU — три точки у строки в списке лидов/сделок/контактов
    CRM_LEAD_LIST_MENU: "crm.lead.get",
    CRM_DEAL_LIST_MENU: "crm.deal.get",
    CRM_CONTACT_LIST_MENU: "crm.contact.get",
  };

  if (typeof BX24 === "undefined") {
    dbg("BX24", "SDK не загружен — окно открыто вне B24 iframe");
    return;
  }

  BX24.init(function() {
    // Растягиваем iframe сразу после init и повторяем через несколько
    // таймаутов — когда отрендерятся инстансы, чипы, селект развернётся.
    // Плюс ResizeObserver на body, чтобы реагировать на любые изменения
    // (показ блока @username для TG, resize textarea вручную, и т.п.).
    resizeB24();
    [120, 350, 800, 1500].forEach(ms => setTimeout(resizeB24, ms));
    if (typeof ResizeObserver !== "undefined") {
      try { new ResizeObserver(() => resizeB24()).observe(document.body); }
      catch (e) { dbg("ResizeObserver err", String(e)); }
    }
    window.addEventListener("resize", resizeB24);
    const info = BX24.placement.info() || {};
    dbg("placement.info", info);

    const placement = info.placement;
    const opts = info.options || {};
    const entityId = opts.OWNER_ID || opts.ID || opts.ENTITY_ID || opts.id || opts.element_id;
    const method = PLACEMENT_TO_METHOD[placement];

    if (!method) { dbg("method", "unknown placement"); renderChips(""); return; }
    if (!entityId) { dbg("entityId", "не нашли в options"); renderChips(""); return; }

    // Определяем тип сущности для pref-ключа
    const ENTITY_TYPE = method === "crm.lead.get" ? "LEAD"
      : method === "crm.deal.get" ? "DEAL"
      : method === "crm.contact.get" ? "CONTACT"
      : method === "crm.company.get" ? "COMPANY" : "OTHER";
    entityCtx = { type: ENTITY_TYPE, id: String(entityId) };

    // Подтянем известные MAX chatId из IMOPENLINES_SESSION-активностей этой
    // CRM-сущности. PROVIDER_PARAMS.USER_CODE содержит формат
    // "social_connector|<line>|sc_<chatId>|<user_id>", откуда и берём chatId.
    // (imopenlines.crm.chat.get пустой возвращает для лидов — баг B24 API.)
    function loadExistingMaxChats(crmEntityType, crmEntityId) {
      const ownerTypeId = crmEntityType === "LEAD" ? 1
        : crmEntityType === "DEAL" ? 2
        : crmEntityType === "CONTACT" ? 3
        : crmEntityType === "COMPANY" ? 4 : null;
      if (!ownerTypeId) return;
      try {
        BX24.callMethod("crm.activity.list", {
          filter: {
            OWNER_TYPE_ID: ownerTypeId,
            OWNER_ID: crmEntityId,
            PROVIDER_ID: "IMOPENLINES_SESSION",
          },
          select: ["ID", "PROVIDER_TYPE_ID", "PROVIDER_PARAMS"],
        }, function(rr) {
          if (rr.error()) { dbg("activity.list err", rr.error_description()); return; }
          const arr = rr.data() || [];
          (Array.isArray(arr) ? arr : Object.values(arr)).forEach(rec => {
            const code = (rec && rec.PROVIDER_PARAMS && rec.PROVIDER_PARAMS.USER_CODE) || "";
            // sc_ — современный префикс (для всех не-WA), wa_ — legacy от
            // ранних версий adapter где Telegram chatId 10 цифр считались phone.
            const m = code.match(/social_connector\\|(\\d+)\\|(?:sc_|wa_)([^|]+)/);
            if (m) {
              const line = m[1], chatId = m[2];
              MAX_CHATS_BY_LINE[line] = chatId;
              dbg("existing MAX chat", { line, chatId });
            }
          });
        });
      } catch (e) { dbg("loadExistingMaxChats err", e.message); }
    }

    BX24.callMethod(method, { id: entityId }, function(res) {
      if (res.error()) { dbg(method + " error", res.error_description()); loadPrefAndRender(); return; }
      const data = res.data() || {};
      dbg(method + ".PHONE", data.PHONE);
      collectPhonesFromCrmRow(data, ENTITY_TYPE === "LEAD" ? "лид" : ENTITY_TYPE === "DEAL" ? "сделка" : "контакт");
      collectUsernames(data);
      dbg("UF usernames", entityUsernames);

      // Сделка — подтянем телефоны и MAX-чаты из связанного контакта
      if (method === "crm.deal.get" && data.CONTACT_ID) {
        loadExistingMaxChats("CONTACT", data.CONTACT_ID);
        BX24.callMethod("crm.contact.get", { id: data.CONTACT_ID }, function(r2) {
          if (r2.error()) { dbg("contact error", r2.error_description()); loadPrefAndRender(); applyUsernameFromUf(); return; }
          const d2 = r2.data() || {};
          dbg("contact.PHONE", d2.PHONE);
          collectPhonesFromCrmRow(d2, "контакт");
          collectUsernames(d2);
          loadPrefAndRender();
          applyUsernameFromUf();
        });
      } else {
        // Для CONTACT/LEAD/COMPANY — ищем MAX-чаты в самой сущности
        loadExistingMaxChats(ENTITY_TYPE, entityId);
        loadPrefAndRender();
        applyUsernameFromUf();
      }
    });
  });


  // Кнопка «🔍 Проверить» — спрашивает у выбранного мессенджера, есть ли
  // аккаунт с этим номером. Для WA → checkWhatsapp, для MAX/TG → CheckAccount.
  $("checkBtn").addEventListener("click", async function() {
    const phone = $("phone").value.replace(/[^\\d]/g, "");
    const idInstance = $("instance").value || undefined;
    const out = $("checkResult");
    out.className = "status";
    if (!phone || phone.length < 10) {
      out.textContent = "Введите номер (с кодом страны)";
      out.className = "status err";
      return;
    }
    if (!idInstance) {
      out.textContent = "Выберите инстанс из списка «Отправить с номера»";
      out.className = "status err";
      return;
    }
    const inst = INSTANCE_BY_ID[idInstance];
    const provider = inst ? (inst.provider || "wa").toLowerCase() : "wa";
    const channelName = detectChannelLabel(idInstance);
    out.textContent = "Проверяю…";
    out.className = "status ok";
    this.disabled = true;
    try {
      const r = await fetch("/widget/check-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, idInstance }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        out.textContent = "✗ " + (j.message || r.statusText);
        out.className = "status err";
        return;
      }
      if (j.exist) {
        let msg = "✓ " + channelName + " найден у +" + phone;
        if (j.chatId) msg += " (chatId: " + j.chatId + ")";
        out.textContent = msg;
        out.className = "status ok";
      } else {
        const hint = provider === "telegram"
          ? " (либо номера нет в адресной книге Telegram-аккаунта, либо у клиента privacy «найти по номеру» = «Мои контакты»)"
          : provider === "max"
            ? " (либо номера нет в адресной книге MAX-аккаунта)"
            : "";
        out.textContent = "✗ " + channelName + " НЕ найден у +" + phone + hint;
        out.className = "status err";
      }
    } catch (e) {
      out.textContent = "✗ Сетевая ошибка: " + e.message;
      out.className = "status err";
    } finally {
      this.disabled = false;
      resizeB24();
    }
  });

  $("send").addEventListener("click", async function() {
    const phone = $("phone").value.trim();
    const text = $("text").value.trim();
    const idInstance = $("instance").value || undefined;
    const usernameOverride = $("tgUsername").value.trim().replace(/^@/, "");
    // Источники chatId в порядке приоритета:
    //   1. UF_CRM_TG_CHAT_ID / UF_CRM_MAX_CHAT_ID — стабильный, верифицированный
    //      (adapter записал при первом ответе клиента).
    //   2. MAX_CHATS_BY_LINE — из IMOPENLINES_SESSION-активностей B24-сущности.
    //      Менее надёжно (может быть chatId старой/чужой сессии).
    let chatIdOverride;
    const inst = INSTANCE_BY_ID[idInstance];
    const instProvider = inst ? (inst.provider || "wa").toLowerCase() : "wa";
    if (instProvider === "telegram" && entityChatIds.telegram) {
      chatIdOverride = entityChatIds.telegram;
      dbg("using UF_CRM_TG_CHAT_ID", chatIdOverride);
    } else if (instProvider === "max" && entityChatIds.max) {
      chatIdOverride = entityChatIds.max;
      dbg("using UF_CRM_MAX_CHAT_ID", chatIdOverride);
    } else if (instProvider === "instagram" && entityChatIds.instagram) {
      chatIdOverride = entityChatIds.instagram;
      dbg("using UF_CRM_IG_CHAT_ID", chatIdOverride);
    } else if (inst && instProvider !== "wa" && instProvider !== "instagram" && inst.bitrixLine != null) {
      const known = MAX_CHATS_BY_LINE[String(inst.bitrixLine)];
      if (known) {
        chatIdOverride = known;
        dbg("using existing chatId from activities", known);
      }
    }
    if (!text) {
      showStatus("Введите текст сообщения", false);
      return;
    }
    if (!phone && !chatIdOverride && !usernameOverride) {
      const hint = instProvider === "wa"
        ? "Введите номер телефона клиента"
        : instProvider === "telegram"
          ? "Введите номер или @username клиента, либо открой виджет в карточке где привязан Telegram-чат"
          : instProvider === "instagram"
            ? "У клиента в карточке нет UF_CRM_IG_CHAT_ID. Открой карточку лида, который пришёл из Instagram (там IG_CHAT_ID записан автоматически), либо введи @username клиента вручную (но i2crm обычно требует client_id, не username)"
            : "Введи номер или открой виджет в карточке клиента — оттуда подтянется chatId";
      showStatus(hint, false);
      return;
    }
    this.disabled = true;
    showStatus("Отправляю…", true);
    try {
      const r = await fetch("/widget/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone, text, idInstance, chatIdOverride, usernameOverride, authId: B24_AUTH.authId, domain: B24_AUTH.domain }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok) {
        const mirrorMsg = j.mirrored === true ? "mirror в B24: ✓"
                        : j.mirrored === false ? "mirror отключён"
                        : "mirror: " + j.mirrored;
        showStatus("✓ Отправлено (" + (j.idMessage || "—") + ") · " + mirrorMsg, true);
        dbg("response", j);
        $("text").value = "";
        // Запоминаем выбранный телефон для этой CRM-сущности
        if (entityCtx && B24_AUTH.domain && phone) {
          fetch("/widget/entity-phone", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ portal: B24_AUTH.domain, type: entityCtx.type, id: entityCtx.id, phone }),
          }).catch(e => dbg("pref save err", e.message));
        }
      } else {
        showStatus("✗ " + (j.message || r.statusText), false);
      }
    } catch (e) {
      showStatus("✗ Сетевая ошибка: " + e.message, false);
    } finally {
      this.disabled = false;
    }
  });
})();
</script>
</body>
</html>`;
	}
}
