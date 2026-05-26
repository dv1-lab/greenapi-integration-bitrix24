// Pure helpers для handleI2crmIncoming (Bitrix24Service). Вынесены сюда,
// чтобы протестировать без NestJS DI и mock'ов Prisma/Config/Bitrix24Service.
//
// Сама handleI2crmIncoming — orchestrator на 300 строк, тестировать её
// целиком с моками всех зависимостей хрупко. Эти helpers покрывают
// 80% решений (валидация payload, ключи, формирование текста, парс
// response), а сама handleI2crmIncoming остаётся под smoke-тестом
// early-return'ов через Test module (bitrix24.service.spec.ts).
//
// Связано:
//  - bitrix24.service.ts: handleI2crmIncoming, handleOutgoingMessageStatus
//  - docs/INSTAGRAM_FLOW.md — A2 формат, instdir vs instcom
//  - docs/PRODUCT_RULES.md — chat.id префиксы

export type I2crmChannel = "instdir" | "instcom";

export interface I2crmValidationResult {
	valid: boolean;
	reason?: string;
	// echo: payload.incoming === false — outgoing вернулся, мы должны
	// игнорировать (success: true с reason: "outgoing-echo-ignored").
	echo?: boolean;
}

/**
 * Проверяет i2crm webhook payload: должен быть incoming=true, должны быть
 * client_id и message_id, канал должен быть один из поддерживаемых.
 *
 * См. handleI2crmIncoming early returns (bitrix24.service.ts L3160-3181).
 */
export function validateI2crmIncoming(payload: any): I2crmValidationResult {
	// Эхо: outgoing от оператора возвращается нам обратно — игнорируем.
	if (payload?.incoming === false) {
		return { valid: false, echo: true, reason: "outgoing-echo-ignored" };
	}
	const clientId = payload?.client_id;
	const messageId = payload?.message_id;
	const channel = String(payload?.channel || "");
	if (!clientId || !messageId) {
		return { valid: false, reason: "missing client_id or message_id" };
	}
	if (channel !== "instdir" && channel !== "instcom") {
		return { valid: false, reason: `unsupported channel: ${channel}` };
	}
	return { valid: true };
}

/**
 * user.id = **идентификатор клиента в B24**. Один и тот же для всех
 * постов и каналов IG одного клиента (instdir + instcom). При совпадении
 * user.id B24 узнаёт клиента и через `CRM_FORWARD=Y` прикрепляет новую
 * сессию к **существующему открытому лиду/сделке** (если есть).
 *
 * См. ADR `2026-05-26-ig-comments-attach-to-open-entity.md` и
 * PRODUCT_RULES.md §2.1.
 */
export function buildI2crmUserId(
	_channel: I2crmChannel,
	clientId: string | number,
): string {
	return `i2crm_ig_${clientId}`;
}

/**
 * chat.id = **идентификатор сессии в B24 OpenLine**. Для instcom — отдельный
 * на каждый пост (mediaId), чтобы у каждого поста была своя сессия в линии 22.
 * Для instdir — один на клиента.
 *
 * Совмещён с user.id: B24 узнаёт **клиента** по user.id, а **сессии** — по chat.id.
 * Разные chat.id'ы для одного user.id порождают разные сессии, **все прикреплённые
 * к одному лиду** клиента (через CRM_FORWARD).
 *
 * См. ADR `2026-05-26-ig-comments-attach-to-open-entity.md`.
 */
export function buildI2crmChatId(
	channel: I2crmChannel,
	clientId: string | number,
	mediaId?: string | number | null,
): string {
	if (channel === "instcom" && mediaId) {
		return `i2crm_ig_${clientId}_c${mediaId}`;
	}
	return `i2crm_ig_${clientId}`;
}

/**
 * @deprecated Используй buildI2crmUserId + buildI2crmChatId раздельно.
 * Оставлено для обратной совместимости тестов до миграции.
 */
export function buildI2crmUserKey(
	channel: I2crmChannel,
	clientId: string | number,
	mediaId?: string | number | null,
): string {
	return buildI2crmChatId(channel, clientId, mediaId);
}

/**
 * Имя окружения для LINE-id по каналу.
 *  - instdir → I2CRM_LINE_ID_IG_DIRECT
 *  - instcom → I2CRM_LINE_ID_IG_COMMENT
 */
export function envKeyForI2crmLine(channel: I2crmChannel): string {
	return channel === "instdir" ? "I2CRM_LINE_ID_IG_DIRECT" : "I2CRM_LINE_ID_IG_COMMENT";
}

/**
 * Финальный текст сообщения для B24 open-line. Для comment-канала
 * добавляем контекст «[Instagram комментарий ...]» + ссылку на пост.
 * Для Direct'а — добавляем quoted-note сверху если есть.
 *
 * См. bitrix24.service.ts L3262-3273.
 */
export function buildI2crmFinalText(opts: {
	channel: I2crmChannel;
	text: string;
	igPostUrl?: string;
	quotedNote?: string;
}): string {
	const text = opts.text || "";
	if (opts.channel === "instcom") {
		const url = opts.igPostUrl ? " к посту " + opts.igPostUrl : "";
		return `[Instagram комментарий${url}]\n${text}`;
	}
	if (opts.quotedNote) {
		return `${opts.quotedNote}\n${text}`;
	}
	return text;
}

/**
 * Достаёт media-вложение из i2crm payload. i2crm складывает ссылку
 * в одно из полей в зависимости от типа:
 *   - `src` — для Instagram (instdir, в т.ч. картинка поста-источника когда
 *     клиент нажал «отправить сообщение» с поста),
 *   - `media_url` / `media.url` — legacy / другие типы.
 *
 * Для type='text' возвращает undefined (нет файла).
 */
export function extractI2crmMediaFile(
	type: string,
	payload: any,
): { url: string; name: string } | undefined {
	if (!type || type === "text") return undefined;
	const url = payload?.src || payload?.media_url || payload?.media?.url;
	if (!url) return undefined;
	return {
		url: String(url),
		name: payload?.media?.file_name || `${type}.bin`,
	};
}

/**
 * Парсит ответ B24 imconnector.send.messages — извлекает session.ID
 * и session.CHAT_ID. Нужны для карточки клиента в TG-зеркале и для
 * последующих pinned-thumb / linkIgCommentToB24Message / etc.
 *
 * Структура B24 response:
 *   { DATA: { RESULT: [{ session: { ID, CHAT_ID } }] } }
 */
export function extractB24SessionInfo(response: any): { sessionId?: string; chatId?: string } {
	const r0 = response?.DATA?.RESULT?.[0];
	if (!r0?.session) return {};
	const result: { sessionId?: string; chatId?: string } = {};
	if (r0.session.ID !== undefined) result.sessionId = String(r0.session.ID);
	if (r0.session.CHAT_ID !== undefined) result.chatId = String(r0.session.CHAT_ID);
	return result;
}

/**
 * Форматирует quoted_message в текст «↩️ В ответ на ...» для Direct.
 * Поддерживает string-quoted и object-quoted (text+url+type для сторис).
 *
 * См. bitrix24.service.ts formatI2crmQuoted L2701.
 */
export function formatI2crmQuoted(quoted: any): string {
	if (!quoted) return "";
	if (typeof quoted === "string") {
		const s = quoted.trim();
		return s ? `↩️ В ответ на: ${s}` : "";
	}
	if (typeof quoted === "object") {
		const qText = String(quoted.text || quoted.caption || "").trim();
		const qUrl = String(
			quoted.url || quoted.media_url || quoted.src || quoted.story_url || "",
		).trim();
		const qType = String(quoted.type || "").trim();
		const isStory = /story|stories/i.test(qType) || /story|stories/i.test(qUrl);
		const label = isStory ? "сторис" : "сообщение";
		const parts = [qText, qUrl].filter(Boolean);
		return `↩️ В ответ на ${label}${parts.length ? ": " + parts.join(" ") : ""}`;
	}
	return "";
}

/**
 * Off-hours для магазина: до 10:00 МСК и с 19:00 МСК (= UTC <7 или ≥16).
 * Тестируемая версия — принимает `now` параметром для freezing времени.
 *
 * Original: bitrix24.service.ts isOffHoursMsk L2305 (использует new Date()).
 */
export function isOffHoursMsk(now: Date = new Date()): boolean {
	const mskHour = (now.getUTCHours() + 3) % 24;
	return mskHour < 10 || mskHour >= 19;
}

/**
 * Начало текущего нерабочего окна — последние наступившие 19:00 МСК (= 16:00 UTC).
 * Для дедупа автоответа «один за ночь».
 *
 * Original: bitrix24.service.ts offHoursWindowStart L2316.
 */
export function offHoursWindowStart(now: Date = new Date()): Date {
	const d = new Date(now);
	d.setUTCHours(16, 0, 0, 0); // 19:00 МСК
	if (now.getUTCHours() < 16) d.setUTCDate(d.getUTCDate() - 1);
	return d;
}

/**
 * Нормализует phone в E.164 (или пустую строку если не подходит).
 * Принимает «79991234567» / «+79991234567», отвергает короткое/буквы.
 */
export function normalizePhoneE164(phone: any): string {
	if (!phone) return "";
	const s = String(phone);
	if (!/^\+?\d{10,15}$/.test(s)) return "";
	return s.startsWith("+") ? s : `+${s}`;
}
