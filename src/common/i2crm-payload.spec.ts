import {
	validateI2crmIncoming,
	buildI2crmUserKey,
	buildI2crmUserId,
	buildI2crmChatId,
	envKeyForI2crmLine,
	buildI2crmFinalText,
	extractI2crmMediaFile,
	extractB24SessionInfo,
	formatI2crmQuoted,
	isOffHoursMsk,
	offHoursWindowStart,
	normalizePhoneE164,
} from "./i2crm-payload";

// =====================================================================
// validateI2crmIncoming
// =====================================================================
describe("validateI2crmIncoming", () => {
	it("happy path — instdir с client_id + message_id", () => {
		const r = validateI2crmIncoming({
			incoming: true,
			channel: "instdir",
			client_id: "123",
			message_id: "m1",
		});
		expect(r).toEqual({ valid: true });
	});

	it("happy path — instcom", () => {
		const r = validateI2crmIncoming({
			channel: "instcom",
			client_id: "123",
			message_id: "m1",
		});
		expect(r.valid).toBe(true);
	});

	it("echo: incoming=false → not valid + echo:true", () => {
		const r = validateI2crmIncoming({ incoming: false, client_id: "1", message_id: "m" });
		expect(r.valid).toBe(false);
		expect(r.echo).toBe(true);
		expect(r.reason).toBe("outgoing-echo-ignored");
	});

	it("missing client_id → invalid", () => {
		const r = validateI2crmIncoming({ channel: "instdir", message_id: "m" });
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/missing/);
	});

	it("missing message_id → invalid", () => {
		const r = validateI2crmIncoming({ channel: "instdir", client_id: "1" });
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/missing/);
	});

	it("unsupported channel → invalid", () => {
		const r = validateI2crmIncoming({
			channel: "telegram", // не наш канал i2crm
			client_id: "1",
			message_id: "m",
		});
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/unsupported channel: telegram/);
	});

	it("пустой channel → invalid", () => {
		const r = validateI2crmIncoming({ client_id: "1", message_id: "m" });
		expect(r.valid).toBe(false);
		expect(r.reason).toMatch(/unsupported channel/);
	});

	it("payload=null → invalid (не падает)", () => {
		expect(() => validateI2crmIncoming(null)).not.toThrow();
		const r = validateI2crmIncoming(null);
		expect(r.valid).toBe(false);
	});

	it("payload=undefined → invalid (не падает)", () => {
		expect(() => validateI2crmIncoming(undefined)).not.toThrow();
		const r = validateI2crmIncoming(undefined);
		expect(r.valid).toBe(false);
	});
});

// =====================================================================
// buildI2crmUserKey (A2 формат)
// =====================================================================
describe("buildI2crmUserKey", () => {
	it("Direct: client_id без media", () => {
		expect(buildI2crmUserKey("instdir", "123456789")).toBe("i2crm_ig_123456789");
	});

	it("Direct: media_id игнорируется (Direct один на клиента)", () => {
		expect(buildI2crmUserKey("instdir", "123", "media999")).toBe("i2crm_ig_123");
	});

	it("Comment: media_id добавляется суффиксом (A2 — пост = лид)", () => {
		expect(buildI2crmUserKey("instcom", "123", "media999")).toBe("i2crm_ig_123_cmedia999");
	});

	it("Comment без media_id → fallback на просто client_id", () => {
		expect(buildI2crmUserKey("instcom", "123")).toBe("i2crm_ig_123");
		expect(buildI2crmUserKey("instcom", "123", null)).toBe("i2crm_ig_123");
		expect(buildI2crmUserKey("instcom", "123", "")).toBe("i2crm_ig_123");
	});

	it("number client_id принимается", () => {
		expect(buildI2crmUserKey("instdir", 999)).toBe("i2crm_ig_999");
	});

	it("регрессия 2026-05-23 — A2 формат для нового поста: каждый пост свой userKey", () => {
		// Один клиент комментирует два разных поста — должен получить два разных userKey
		// и два разных лида в B24.
		const a = buildI2crmUserKey("instcom", "555", "post-a");
		const b = buildI2crmUserKey("instcom", "555", "post-b");
		expect(a).not.toBe(b);
	});
});

// =====================================================================
// buildI2crmUserId (новое — 2026-05-26 ADR, user.id = клиент)
// =====================================================================
describe("buildI2crmUserId", () => {
	it("Direct — без media: один user.id на клиента", () => {
		expect(buildI2crmUserId("instdir", "123")).toBe("i2crm_ig_123");
	});

	it("Comment — тоже без media: тот же user.id что и для Direct", () => {
		expect(buildI2crmUserId("instcom", "123")).toBe("i2crm_ig_123");
	});

	it("Direct и Comment одного клиента — одинаковый user.id (B24 узнаёт того же клиента)", () => {
		expect(buildI2crmUserId("instdir", "555")).toBe(
			buildI2crmUserId("instcom", "555"),
		);
	});

	it("number client_id принимается", () => {
		expect(buildI2crmUserId("instdir", 999)).toBe("i2crm_ig_999");
	});
});

// =====================================================================
// buildI2crmChatId (новое — 2026-05-26 ADR, chat.id = сессия per пост)
// =====================================================================
describe("buildI2crmChatId", () => {
	it("Direct: client_id без media (одна сессия Direct на клиента)", () => {
		expect(buildI2crmChatId("instdir", "123")).toBe("i2crm_ig_123");
	});

	it("Direct: media_id игнорируется", () => {
		expect(buildI2crmChatId("instdir", "123", "media999")).toBe("i2crm_ig_123");
	});

	it("Comment с media: отдельная сессия per пост", () => {
		expect(buildI2crmChatId("instcom", "123", "post-a")).toBe(
			"i2crm_ig_123_cpost-a",
		);
		expect(buildI2crmChatId("instcom", "123", "post-b")).toBe(
			"i2crm_ig_123_cpost-b",
		);
	});

	it("Comment без media (необычный случай) → fallback на просто клиент", () => {
		expect(buildI2crmChatId("instcom", "123")).toBe("i2crm_ig_123");
		expect(buildI2crmChatId("instcom", "123", null)).toBe("i2crm_ig_123");
	});

	it("разные посты одного клиента → разные chat.id (отдельные сессии)", () => {
		const a = buildI2crmChatId("instcom", "555", "post-a");
		const b = buildI2crmChatId("instcom", "555", "post-b");
		expect(a).not.toBe(b);
	});

	it("ключевая инвариантность ADR — chat.id отличается, но user.id одинаков", () => {
		const userIdA = buildI2crmUserId("instcom", "555");
		const userIdB = buildI2crmUserId("instcom", "555");
		const chatIdA = buildI2crmChatId("instcom", "555", "post-a");
		const chatIdB = buildI2crmChatId("instcom", "555", "post-b");
		expect(userIdA).toBe(userIdB); // один клиент
		expect(chatIdA).not.toBe(chatIdB); // разные сессии
		// B24 при таком payload узнаёт клиента (user.id) и через CRM_FORWARD
		// прикрепляет новую сессию (chat.id) к существующему открытому лиду.
	});
});

// =====================================================================
// envKeyForI2crmLine
// =====================================================================
describe("envKeyForI2crmLine", () => {
	it("instdir → I2CRM_LINE_ID_IG_DIRECT", () => {
		expect(envKeyForI2crmLine("instdir")).toBe("I2CRM_LINE_ID_IG_DIRECT");
	});
	it("instcom → I2CRM_LINE_ID_IG_COMMENT", () => {
		expect(envKeyForI2crmLine("instcom")).toBe("I2CRM_LINE_ID_IG_COMMENT");
	});
});

// =====================================================================
// buildI2crmFinalText
// =====================================================================
describe("buildI2crmFinalText", () => {
	it("Comment с URL → префикс «[Instagram комментарий к посту URL]»", () => {
		const t = buildI2crmFinalText({
			channel: "instcom",
			text: "Привет",
			igPostUrl: "https://instagram.com/p/abc/",
		});
		expect(t).toBe("[Instagram комментарий к посту https://instagram.com/p/abc/]\nПривет");
	});

	it("Comment без URL → префикс «[Instagram комментарий]»", () => {
		const t = buildI2crmFinalText({ channel: "instcom", text: "hi" });
		expect(t).toBe("[Instagram комментарий]\nhi");
	});

	it("Direct с quoted → quoted сверху", () => {
		const t = buildI2crmFinalText({
			channel: "instdir",
			text: "ответ",
			quotedNote: "↩️ В ответ на: исходник",
		});
		expect(t).toBe("↩️ В ответ на: исходник\nответ");
	});

	it("Direct без quoted → просто текст", () => {
		const t = buildI2crmFinalText({ channel: "instdir", text: "просто" });
		expect(t).toBe("просто");
	});

	it("Direct с пустым text — сохраняем пустоту (медиа без подписи)", () => {
		const t = buildI2crmFinalText({ channel: "instdir", text: "" });
		expect(t).toBe("");
	});

	it("Direct с пустым text и quoted — только quoted с переводом", () => {
		const t = buildI2crmFinalText({
			channel: "instdir",
			text: "",
			quotedNote: "↩️ В ответ на сторис",
		});
		expect(t).toBe("↩️ В ответ на сторис\n");
	});
});

// =====================================================================
// extractI2crmMediaFile
// =====================================================================
describe("extractI2crmMediaFile", () => {
	it("type=text → undefined", () => {
		expect(extractI2crmMediaFile("text", { src: "https://x" })).toBeUndefined();
	});

	it("type=image, src приоритет (instdir IG поста-источника)", () => {
		const r = extractI2crmMediaFile("image", {
			src: "https://cdn/src.jpg",
			media_url: "https://cdn/legacy.jpg",
		});
		expect(r).toEqual({ url: "https://cdn/src.jpg", name: "image.bin" });
	});

	it("type=image, fallback на media_url", () => {
		const r = extractI2crmMediaFile("image", { media_url: "https://cdn/x.jpg" });
		expect(r?.url).toBe("https://cdn/x.jpg");
	});

	it("type=image, fallback на media.url", () => {
		const r = extractI2crmMediaFile("image", { media: { url: "https://cdn/x.jpg" } });
		expect(r?.url).toBe("https://cdn/x.jpg");
	});

	it("file_name берётся из media.file_name", () => {
		const r = extractI2crmMediaFile("video", {
			src: "https://cdn/v.mp4",
			media: { file_name: "клиент_видео.mp4" },
		});
		expect(r?.name).toBe("клиент_видео.mp4");
	});

	it("type=image без URL → undefined", () => {
		expect(extractI2crmMediaFile("image", {})).toBeUndefined();
	});

	it("type=audio — fallback name", () => {
		const r = extractI2crmMediaFile("audio", { media_url: "https://x/a.ogg" });
		expect(r?.name).toBe("audio.bin");
	});

	it("пустой type → undefined", () => {
		expect(extractI2crmMediaFile("", { src: "https://x" })).toBeUndefined();
	});
});

// =====================================================================
// extractB24SessionInfo
// =====================================================================
describe("extractB24SessionInfo", () => {
	it("happy path — sessionId + chatId из DATA.RESULT[0].session", () => {
		const r = extractB24SessionInfo({
			DATA: { RESULT: [{ session: { ID: 12345, CHAT_ID: 67890 } }] },
		});
		expect(r).toEqual({ sessionId: "12345", chatId: "67890" });
	});

	it("string ID → strings возвращаются", () => {
		const r = extractB24SessionInfo({
			DATA: { RESULT: [{ session: { ID: "abc", CHAT_ID: "def" } }] },
		});
		expect(r).toEqual({ sessionId: "abc", chatId: "def" });
	});

	it("response без RESULT → пустой объект", () => {
		expect(extractB24SessionInfo({ DATA: {} })).toEqual({});
	});

	it("response без DATA → пустой объект", () => {
		expect(extractB24SessionInfo({})).toEqual({});
	});

	it("response=null → пустой объект (не падает)", () => {
		expect(() => extractB24SessionInfo(null)).not.toThrow();
		expect(extractB24SessionInfo(null)).toEqual({});
	});

	it("RESULT без session → пустой объект", () => {
		const r = extractB24SessionInfo({ DATA: { RESULT: [{ foo: "bar" }] } });
		expect(r).toEqual({});
	});

	it("частичный session — только ID без CHAT_ID", () => {
		const r = extractB24SessionInfo({
			DATA: { RESULT: [{ session: { ID: 1 } }] },
		});
		expect(r).toEqual({ sessionId: "1" });
	});
});

// =====================================================================
// formatI2crmQuoted
// =====================================================================
describe("formatI2crmQuoted", () => {
	it("null → пустая строка", () => {
		expect(formatI2crmQuoted(null)).toBe("");
		expect(formatI2crmQuoted(undefined)).toBe("");
	});

	it("string → «↩️ В ответ на: текст»", () => {
		expect(formatI2crmQuoted("исходный текст")).toBe("↩️ В ответ на: исходный текст");
	});

	it("пустая строка → пустая строка", () => {
		expect(formatI2crmQuoted("")).toBe("");
		expect(formatI2crmQuoted("   ")).toBe("");
	});

	it("object с text → label «сообщение»", () => {
		expect(formatI2crmQuoted({ text: "hi" })).toBe("↩️ В ответ на сообщение: hi");
	});

	it("object с type=story → label «сторис»", () => {
		expect(formatI2crmQuoted({ type: "story", text: "посмотри" })).toBe(
			"↩️ В ответ на сторис: посмотри",
		);
	});

	it("object с url типа stories → label «сторис»", () => {
		expect(formatI2crmQuoted({ url: "https://instagram.com/stories/abc" })).toBe(
			"↩️ В ответ на сторис: https://instagram.com/stories/abc",
		);
	});

	it("object с caption (вместо text)", () => {
		expect(formatI2crmQuoted({ caption: "caption-text" })).toBe(
			"↩️ В ответ на сообщение: caption-text",
		);
	});

	it("object пустой → label без двоеточия", () => {
		expect(formatI2crmQuoted({})).toBe("↩️ В ответ на сообщение");
	});

	it("number / boolean — не падает, возвращает пустую строку", () => {
		expect(formatI2crmQuoted(42 as any)).toBe("");
		expect(formatI2crmQuoted(true as any)).toBe("");
	});
});

// =====================================================================
// isOffHoursMsk
// =====================================================================
describe("isOffHoursMsk", () => {
	it("14:00 МСК (11:00 UTC) — рабочее", () => {
		expect(isOffHoursMsk(new Date("2026-05-26T11:00:00Z"))).toBe(false);
	});

	it("09:59 МСК (06:59 UTC) — нерабочее", () => {
		expect(isOffHoursMsk(new Date("2026-05-26T06:59:00Z"))).toBe(true);
	});

	it("10:00 МСК (07:00 UTC) — рабочее (граница)", () => {
		expect(isOffHoursMsk(new Date("2026-05-26T07:00:00Z"))).toBe(false);
	});

	it("18:59 МСК (15:59 UTC) — рабочее", () => {
		expect(isOffHoursMsk(new Date("2026-05-26T15:59:00Z"))).toBe(false);
	});

	it("19:00 МСК (16:00 UTC) — нерабочее (граница)", () => {
		expect(isOffHoursMsk(new Date("2026-05-26T16:00:00Z"))).toBe(true);
	});

	it("23:30 МСК (20:30 UTC) — нерабочее", () => {
		expect(isOffHoursMsk(new Date("2026-05-26T20:30:00Z"))).toBe(true);
	});

	it("03:30 МСК (00:30 UTC) — нерабочее", () => {
		expect(isOffHoursMsk(new Date("2026-05-26T00:30:00Z"))).toBe(true);
	});

	it("00:00 МСК (21:00 UTC) — нерабочее", () => {
		expect(isOffHoursMsk(new Date("2026-05-26T21:00:00Z"))).toBe(true);
	});
});

// =====================================================================
// offHoursWindowStart
// =====================================================================
describe("offHoursWindowStart", () => {
	it("23:00 МСК (20:00 UTC) → начало сегодня 19:00 МСК", () => {
		const now = new Date("2026-05-26T20:00:00Z");
		const start = offHoursWindowStart(now);
		expect(start.toISOString()).toBe("2026-05-26T16:00:00.000Z");
	});

	it("03:00 МСК (00:00 UTC) → начало ВЧЕРА 19:00 МСК", () => {
		// 00 UTC < 16 → откатываем на день назад
		const now = new Date("2026-05-26T00:00:00Z");
		const start = offHoursWindowStart(now);
		expect(start.toISOString()).toBe("2026-05-25T16:00:00.000Z");
	});

	it("09:30 МСК (06:30 UTC) → начало ВЧЕРА", () => {
		const now = new Date("2026-05-26T06:30:00Z");
		const start = offHoursWindowStart(now);
		expect(start.toISOString()).toBe("2026-05-25T16:00:00.000Z");
	});

	it("19:00 МСК (16:00 UTC) → начало сегодня (граница)", () => {
		const now = new Date("2026-05-26T16:00:00Z");
		const start = offHoursWindowStart(now);
		expect(start.toISOString()).toBe("2026-05-26T16:00:00.000Z");
	});
});

// =====================================================================
// normalizePhoneE164
// =====================================================================
describe("normalizePhoneE164", () => {
	it("без + → добавляет +", () => {
		expect(normalizePhoneE164("79991234567")).toBe("+79991234567");
	});

	it("с + → без изменений", () => {
		expect(normalizePhoneE164("+79991234567")).toBe("+79991234567");
	});

	it("number → строка с +", () => {
		expect(normalizePhoneE164(79991234567)).toBe("+79991234567");
	});

	it("пустая строка → пустая", () => {
		expect(normalizePhoneE164("")).toBe("");
	});

	it("null/undefined → пустая", () => {
		expect(normalizePhoneE164(null)).toBe("");
		expect(normalizePhoneE164(undefined)).toBe("");
	});

	it("буквы в номере → пустая", () => {
		expect(normalizePhoneE164("abc123")).toBe("");
	});

	it("слишком короткий (9 цифр) → пустая", () => {
		expect(normalizePhoneE164("123456789")).toBe("");
	});

	it("ровно 10 цифр → валиден", () => {
		expect(normalizePhoneE164("1234567890")).toBe("+1234567890");
	});

	it("слишком длинный (16 цифр) → пустая", () => {
		expect(normalizePhoneE164("1234567890123456")).toBe("");
	});
});
