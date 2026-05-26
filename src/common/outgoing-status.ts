// Pure helpers для handleOutgoingMessageStatus (Bitrix24Service).
// Вынесены, чтобы протестировать dedup-ordering без mock'ов Prisma.
//
// См. bitrix24.service.ts L5664-5736.

export type OutgoingStatus = "sent" | "delivered" | "read";

/**
 * Порядок статусов Green API. delivered и read — продвинутые статусы
 * (если уже видели delivered, повторное sent игнорируем).
 *
 * Original: bitrix24.service.ts L5685 STATUS_ORDER.
 */
export const OUTGOING_STATUS_ORDER: Record<OutgoingStatus, number> = {
	sent: 1,
	delivered: 2,
	read: 3,
};

/**
 * true — если status уже устаревший (последний обработанный ≥ нового).
 * Используется для дедуп дублирующихся webhook'ов Green API.
 *
 * lastSeen=null/"" — первый webhook, не skip.
 *
 * Original: bitrix24.service.ts L5687.
 */
export function shouldSkipOutgoingStatus(
	lastSeen: string | null | undefined,
	incoming: string,
): boolean {
	if (!lastSeen) return false;
	const lastOrder = OUTGOING_STATUS_ORDER[lastSeen as OutgoingStatus] || 0;
	const incomingOrder = OUTGOING_STATUS_ORDER[incoming as OutgoingStatus] || 0;
	return lastOrder >= incomingOrder;
}

/**
 * Status валиден если один из sent/delivered/read.
 * Любые другие значения (например, "noAccount", "pending") — игнор.
 *
 * Original: bitrix24.service.ts L5667.
 */
export function isValidOutgoingStatus(status: string): status is OutgoingStatus {
	const s = String(status || "").toLowerCase();
	return s === "sent" || s === "delivered" || s === "read";
}

/**
 * Истёк ли срок хранения записи OutgoingMessage (TTL 24 часа после доставки).
 * После expiry — Green API больше не пришлёт статус, запись бесполезна.
 *
 * Original: bitrix24.service.ts L5677.
 */
export function isOutgoingExpired(expiresAt: Date | string, now: Date = new Date()): boolean {
	const t = expiresAt instanceof Date ? expiresAt.getTime() : new Date(expiresAt).getTime();
	return t < now.getTime();
}

/**
 * Превращает connector_id в source/channel для customer_events.
 * Дубликат _sourceFromConnector в bitrix24.service.ts L1195 — оба
 * указывают на одну и ту же логику. См. также src/common/instagram-og.ts
 * `sourceFromConnector` (там немного другие правила matching'а).
 *
 * Эта версия — точная копия из bitrix24.service.ts, поэтому safer
 * для использования в outgoing-status flow без риска регрессии маппинга.
 */
export function sourceFromConnectorOutgoing(connector: string): {
	source: string;
	channel: string;
} {
	const c = (connector || "").toLowerCase();
	if (c.includes("whatsapp") || c.includes("wa_")) return { source: "bridge_wa", channel: "WA" };
	if (c.includes("max")) return { source: "bridge_max", channel: "MAX" };
	if (c.includes("telegram") || c === "tg" || c.includes("tg_")) return { source: "bridge_tg", channel: "TG" };
	if (c.includes("instagram") || c.includes("ig_") || c === "i2crm") return { source: "bridge_ig", channel: "IG" };
	return { source: "adapter", channel: connector || "" };
}
