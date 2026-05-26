import {
	OUTGOING_STATUS_ORDER,
	shouldSkipOutgoingStatus,
	isValidOutgoingStatus,
	isOutgoingExpired,
	sourceFromConnectorOutgoing,
} from "./outgoing-status";

// =====================================================================
// OUTGOING_STATUS_ORDER
// =====================================================================
describe("OUTGOING_STATUS_ORDER", () => {
	it("sent < delivered < read", () => {
		expect(OUTGOING_STATUS_ORDER.sent).toBeLessThan(OUTGOING_STATUS_ORDER.delivered);
		expect(OUTGOING_STATUS_ORDER.delivered).toBeLessThan(OUTGOING_STATUS_ORDER.read);
	});
});

// =====================================================================
// shouldSkipOutgoingStatus — dedup-логика
// =====================================================================
describe("shouldSkipOutgoingStatus", () => {
	it("первый webhook (lastSeen=null) — НЕ skip", () => {
		expect(shouldSkipOutgoingStatus(null, "sent")).toBe(false);
		expect(shouldSkipOutgoingStatus(undefined, "delivered")).toBe(false);
		expect(shouldSkipOutgoingStatus("", "sent")).toBe(false);
	});

	it("повтор того же статуса — skip", () => {
		expect(shouldSkipOutgoingStatus("sent", "sent")).toBe(true);
		expect(shouldSkipOutgoingStatus("delivered", "delivered")).toBe(true);
		expect(shouldSkipOutgoingStatus("read", "read")).toBe(true);
	});

	it("откат — skip (видели delivered, пришёл sent)", () => {
		expect(shouldSkipOutgoingStatus("delivered", "sent")).toBe(true);
		expect(shouldSkipOutgoingStatus("read", "sent")).toBe(true);
		expect(shouldSkipOutgoingStatus("read", "delivered")).toBe(true);
	});

	it("прогресс — НЕ skip (sent → delivered)", () => {
		expect(shouldSkipOutgoingStatus("sent", "delivered")).toBe(false);
		expect(shouldSkipOutgoingStatus("sent", "read")).toBe(false);
		expect(shouldSkipOutgoingStatus("delivered", "read")).toBe(false);
	});

	it("неизвестный lastSeen — fallback на order 0, любой incoming проходит", () => {
		expect(shouldSkipOutgoingStatus("garbage", "sent")).toBe(false);
		expect(shouldSkipOutgoingStatus("garbage", "delivered")).toBe(false);
	});

	it("неизвестный incoming — fallback на order 0, всегда skip (≤ известного)", () => {
		expect(shouldSkipOutgoingStatus("sent", "garbage")).toBe(true);
	});
});

// =====================================================================
// isValidOutgoingStatus
// =====================================================================
describe("isValidOutgoingStatus", () => {
	it("sent/delivered/read валидны", () => {
		expect(isValidOutgoingStatus("sent")).toBe(true);
		expect(isValidOutgoingStatus("delivered")).toBe(true);
		expect(isValidOutgoingStatus("read")).toBe(true);
	});

	it("uppercase — валидно (нормализуется toLowerCase)", () => {
		expect(isValidOutgoingStatus("SENT")).toBe(true);
		expect(isValidOutgoingStatus("Delivered")).toBe(true);
	});

	it("прочие Green API статусы — не валидны (не форвардим)", () => {
		expect(isValidOutgoingStatus("noAccount")).toBe(false);
		expect(isValidOutgoingStatus("pending")).toBe(false);
		expect(isValidOutgoingStatus("failed")).toBe(false);
		expect(isValidOutgoingStatus("")).toBe(false);
	});

	it("null / undefined / non-string — не падает", () => {
		expect(() => isValidOutgoingStatus(null as any)).not.toThrow();
		expect(isValidOutgoingStatus(null as any)).toBe(false);
		expect(isValidOutgoingStatus(undefined as any)).toBe(false);
	});
});

// =====================================================================
// isOutgoingExpired
// =====================================================================
describe("isOutgoingExpired", () => {
	const NOW = new Date("2026-05-26T12:00:00Z");

	it("в прошлом → истёк", () => {
		const past = new Date("2026-05-25T12:00:00Z");
		expect(isOutgoingExpired(past, NOW)).toBe(true);
	});

	it("в будущем → не истёк", () => {
		const future = new Date("2026-05-27T12:00:00Z");
		expect(isOutgoingExpired(future, NOW)).toBe(false);
	});

	it("ровно now → не истёк (lt сравнение, не lte)", () => {
		expect(isOutgoingExpired(NOW, NOW)).toBe(false);
	});

	it("принимает ISO-строку", () => {
		expect(isOutgoingExpired("2026-05-25T00:00:00Z", NOW)).toBe(true);
		expect(isOutgoingExpired("2026-05-27T00:00:00Z", NOW)).toBe(false);
	});

	it("по умолчанию now=new Date() — old date истёк", () => {
		// Sanity: дата в далёком прошлом всегда истекшая, без явного now.
		expect(isOutgoingExpired(new Date("2020-01-01"))).toBe(true);
	});
});

// =====================================================================
// sourceFromConnectorOutgoing
// =====================================================================
describe("sourceFromConnectorOutgoing", () => {
	it("whatsapp / wa_* → bridge_wa", () => {
		expect(sourceFromConnectorOutgoing("whatsapp")).toEqual({
			source: "bridge_wa",
			channel: "WA",
		});
		expect(sourceFromConnectorOutgoing("wa_business")).toEqual({
			source: "bridge_wa",
			channel: "WA",
		});
		expect(sourceFromConnectorOutgoing("WhatsApp")).toEqual({
			source: "bridge_wa",
			channel: "WA",
		});
	});

	it("max → bridge_max", () => {
		expect(sourceFromConnectorOutgoing("max")).toEqual({ source: "bridge_max", channel: "MAX" });
		expect(sourceFromConnectorOutgoing("max_messenger")).toEqual({
			source: "bridge_max",
			channel: "MAX",
		});
	});

	it("telegram / tg / tg_* → bridge_tg", () => {
		expect(sourceFromConnectorOutgoing("telegram")).toEqual({
			source: "bridge_tg",
			channel: "TG",
		});
		expect(sourceFromConnectorOutgoing("tg")).toEqual({ source: "bridge_tg", channel: "TG" });
		expect(sourceFromConnectorOutgoing("tg_bot")).toEqual({
			source: "bridge_tg",
			channel: "TG",
		});
	});

	it("instagram / ig_* / i2crm → bridge_ig", () => {
		expect(sourceFromConnectorOutgoing("instagram")).toEqual({
			source: "bridge_ig",
			channel: "IG",
		});
		expect(sourceFromConnectorOutgoing("ig_direct")).toEqual({
			source: "bridge_ig",
			channel: "IG",
		});
		expect(sourceFromConnectorOutgoing("i2crm")).toEqual({
			source: "bridge_ig",
			channel: "IG",
		});
	});

	it("неизвестный connector → adapter + raw channel", () => {
		expect(sourceFromConnectorOutgoing("livechat")).toEqual({
			source: "adapter",
			channel: "livechat",
		});
		expect(sourceFromConnectorOutgoing("")).toEqual({ source: "adapter", channel: "" });
	});
});
