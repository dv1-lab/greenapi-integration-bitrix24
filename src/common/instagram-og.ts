/**
 * Pure-функции для Instagram OG-fetcher.
 *
 * Вынесено из Bitrix24Service в отдельный модуль 26.05.2026 для
 * smoke-тестируемости. Bitrix24Service.fetchInstagramPostMedia +
 * _sourceFromConnector — обёртки над этими функциями (TODO: после
 * рефакторинга оставить только импорты, dual-кода больше не будет).
 *
 * Контекст почему так работает:
 *  - Instagram отдаёт og:image только OG-ботам соцсетей (whitelist
 *    Meta) — Chrome UA получает login-wall.
 *  - og:image в HTML приходит с HTML-entities (`&amp;` вместо `&`).
 *    Без unescape — Telegram/B24 не парсят query string CDN URL → 403.
 *  - Грабли проверены: sha cbe8bdf (UA fix), 5276e41 (html.unescape).
 *  - См. memory `[[ig_og_fetch_trick]]`.
 */
import axios from "axios";

export const IG_OG_USER_AGENT =
	"facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";

export type IgPostMediaKind = "photo" | "video" | "none";

export interface IgPostMedia {
	kind: IgPostMediaKind;
	url: string | null;
}

/**
 * HTML-entities декодер для значений og:image / og:video.
 * Не использует библиотек — покрывает 5 наиболее частых entities
 * которые Instagram реально отдаёт. Полноценный decoder — overkill.
 */
export function htmlUnescape(s: string): string {
	return s
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#039;/g, "'")
		.replace(/&#39;/g, "'");
}

/** Извлекает og:video и og:image meta из IG HTML-страницы.
 *  Приоритет: video > image. Возвращает kind=none если ничего нет. */
export function parseOgMedia(html: string): IgPostMedia {
	const mv = html.match(/<meta\s+property="og:video"\s+content="([^"]+)"/i);
	if (mv) return { kind: "video", url: htmlUnescape(mv[1]) };
	const mi = html.match(/<meta\s+property="og:image"\s+content="([^"]+)"/i);
	if (mi) return { kind: "photo", url: htmlUnescape(mi[1]) };
	return { kind: "none", url: null };
}

/** Скачивает HTML страницы IG-поста и парсит og-media.
 *  В Production-коде используется axios; в тестах axios мокается. */
export async function fetchInstagramPostMedia(
	postUrl: string,
): Promise<IgPostMedia> {
	try {
		const r = await axios.get(postUrl, {
			timeout: 10000,
			headers: {
				"User-Agent": IG_OG_USER_AGENT,
				"Accept":
					"text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
				"Accept-Language": "ru-RU,ru;q=0.9,en;q=0.8",
			},
			maxRedirects: 5,
			validateStatus: () => true,
		});
		if (r.status !== 200 || typeof r.data !== "string") {
			return { kind: "none", url: null };
		}
		return parseOgMedia(r.data);
	} catch {
		return { kind: "none", url: null };
	}
}

/**
 * connector_id → (source, channel) для Customer-360 events.
 * Используется в delivery-status emit когда у нас connector_id из
 * outgoingMessage записи, и нужно нормализовать источник.
 *
 * Источники (source) совпадают с тем что эмитит bridge.py:
 *   bridge_wa / bridge_max / bridge_tg / bridge_ig / adapter (fallback).
 */
export function sourceFromConnector(
	connector: string,
): { source: string; channel: string } {
	const c = (connector || "").toLowerCase();
	if (c.includes("whatsapp") || c.includes("wa_"))
		return { source: "bridge_wa", channel: "WA" };
	if (c.includes("max")) return { source: "bridge_max", channel: "MAX" };
	if (c.includes("telegram") || c === "tg" || c.includes("tg_"))
		return { source: "bridge_tg", channel: "TG" };
	if (c.includes("instagram") || c.includes("ig_") || c === "i2crm")
		return { source: "bridge_ig", channel: "IG" };
	return { source: "adapter", channel: connector || "" };
}
