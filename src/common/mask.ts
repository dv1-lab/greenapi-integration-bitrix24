// Маскировка чувствительных значений в structured-логах.
// Применяется и к нашему коду, и к SDK через патч GreenApiLogger.prototype
// в main.ts (Bitrix24 SDK логирует Instance с apiTokenInstance/accessToken
// при каждом REST-вызове — без patch'а токены попадают в docker logs).

// Имена полей (case-insensitive), значения которых маскируются.
// Намеренно широкий regex — лучше замаскировать лишнее, чем пропустить токен.
const SENSITIVE_KEY = /^(access[_-]?token|refresh[_-]?token|application[_-]?token|api[_-]?token[_-]?instance|api[_-]?key|token|password|secret|client[_-]?secret|authorization|auth|x[_-]?api[_-]?key|hash|signature|webhook[_-]?secret|bot[_-]?token|target[_-]?key|user[_-]?token|i2crm[_-]?user[_-]?token|i2crm[_-]?target[_-]?key[_-]?publicapi|tg[_-]?mirror[_-]?bot[_-]?token|stalwart[_-]?token|cloudflare[_-]?token|beget[_-]?(password|api))$/i;

// Глобальное замечание: для тонкого случая когда ключ выглядит безобидно
// (`auth: <масивный access_token>` в OAuth-callback), маскируем по ключу
// «auth», но НЕ маскируем «auth_type», «authorized», «authentication».
// regex с `^...$` это уже делает.

function maskValue(v: unknown): unknown {
	if (typeof v === "string" && v.length > 0) {
		return `<masked len=${v.length}>`;
	}
	if (typeof v === "object" && v !== null) {
		// Объект вместо строки — например `auth: {access_token: ...}`.
		// Не маскируем целиком, рекурсивно проходим внутрь.
		return mask(v);
	}
	return "<masked>";
}

export function mask(input: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
	if (input == null) return input;
	if (typeof input !== "object") return input;
	if (seen.has(input as object)) return "[Circular]";
	seen.add(input as object);

	if (Array.isArray(input)) {
		return input.map((item) => mask(item, seen));
	}

	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
		if (SENSITIVE_KEY.test(key)) {
			out[key] = maskValue(value);
		} else {
			out[key] = mask(value, seen);
		}
	}
	return out;
}

// Дополнительная маскировка URL'ов с auth-параметром в query: Bitrix24 REST
// логирует полный URL `https://.../rest/method?auth=<token>&...`. Заменяем
// auth=<value> на auth=<masked>.
const URL_AUTH_RE = /([?&](?:auth|access_token|key|token|client_secret)=)[^&\s"']+/gi;

export function maskString(s: string): string {
	return s.replace(URL_AUTH_RE, "$1<masked>");
}

// Универсальный маскер для аргументов logger.{info,debug,warn,error}.
export function maskArg(arg: unknown): unknown {
	if (typeof arg === "string") return maskString(arg);
	if (typeof arg === "object" && arg !== null) return mask(arg);
	return arg;
}
