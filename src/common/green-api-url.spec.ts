import { greenApiUrl } from "./green-api-url";

describe("greenApiUrl — маппинг idInstance → API URL", () => {
	it.each([
		// Известные инстансы (5 ротировано 26.05) — shard URLs
		["1103487233", "https://1103.api.green-api.com"], // WA 84566
		["3100621187", "https://3100.api.green-api.com"], // MAX 79584983354
		["4100621194", "https://4100.api.green-api.com"], // TG 79584983354
		// Старый инстанс на общем URL
		["1101948511", "https://api.green-api.com"], // WA 79240778566
	])("instance %s → %s", (id, expected) => {
		expect(greenApiUrl(id)).toBe(expected);
	});

	it("неизвестный instance → fallback на общий URL", () => {
		expect(greenApiUrl("9999999999")).toBe("https://api.green-api.com");
	});

	it("пустая строка → fallback", () => {
		expect(greenApiUrl("")).toBe("https://api.green-api.com");
	});

	// Защита от грабли: новый инстанс с shard URL добавляется в коде, забыли
	// обновить мапу → отправка падает в `api.green-api.com` (общий), Green API
	// отвечает 401 «wrong instance». Если такое случится — добавить в .ts +
	// сюда тест-кейс.
});
