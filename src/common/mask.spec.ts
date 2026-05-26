import { mask } from "./mask";

describe("mask — защита от утечек секретов в логи", () => {
	// Каждый из этих случаев был реальной грабли в прошлом (#26 task).

	describe("маскирует чувствительные ключи", () => {
		it.each([
			"access_token",
			"accessToken",
			"refresh_token",
			"refreshToken",
			"apiTokenInstance",
			"api_token_instance",
			"api_key",
			"apiKey",
			"token",
			"password",
			"secret",
			"client_secret",
			"clientSecret",
			"authorization",
			"auth",
			"x_api_key",
			"webhook_secret",
			"bot_token",
			"botToken",
			"target_key",
			"i2crm_user_token",
			"stalwart_token",
		])("ключ %s маскируется", (key) => {
			const out = mask({ [key]: "supersecret123" }) as Record<string, unknown>;
			expect(out[key]).not.toBe("supersecret123");
			expect(JSON.stringify(out[key])).toContain("masked");
		});
	});

	describe("НЕ маскирует безобидные ключи", () => {
		it.each([
			"auth_type",
			"authorized",
			"authentication_method",
			"username",
			"email",
			"phone",
			"name",
			"text",
			"chatId",
			"messageId",
		])("ключ %s остаётся как есть", (key) => {
			const out = mask({ [key]: "value123" }) as Record<string, unknown>;
			expect(out[key]).toBe("value123");
		});
	});

	it("рекурсивно проходит nested objects", () => {
		const input = {
			outer: {
				inner: {
					password: "secret",
					public_data: "visible",
				},
			},
		};
		const out = mask(input) as any;
		expect(out.outer.inner.password).toContain("masked");
		expect(out.outer.inner.public_data).toBe("visible");
	});

	it("обрабатывает arrays", () => {
		const out = mask([
			{ access_token: "x" },
			{ name: "y" },
		]) as any[];
		expect(out[0].access_token).toContain("masked");
		expect(out[1].name).toBe("y");
	});

	it("обрабатывает circular references без crash", () => {
		const obj: any = { name: "x" };
		obj.self = obj;
		expect(() => mask(obj)).not.toThrow();
		const out = mask(obj) as any;
		expect(out.self).toBe("[Circular]");
	});

	it("primitives возвращаются как есть", () => {
		expect(mask(null)).toBe(null);
		expect(mask(undefined)).toBe(undefined);
		expect(mask("string")).toBe("string");
		expect(mask(42)).toBe(42);
		expect(mask(true)).toBe(true);
	});

	it("маска включает length значения (для debug)", () => {
		const out = mask({ token: "abc123" }) as any;
		expect(out.token).toBe("<masked len=6>");
	});

	it("оба варианта DATABASE_URL — auth объект в OAuth callback", () => {
		// Из реального инцидента: `auth: { access_token: ... }` в OAuth callback —
		// маскируем сам access_token, но `auth` рекурсивно проходит.
		const out = mask({
			auth: {
				access_token: "real_token",
				domain: "1begovoy.bitrix24.ru",
			},
		}) as any;
		expect(out.auth).not.toBe("<masked>");
		expect(out.auth.access_token).toContain("masked");
		expect(out.auth.domain).toBe("1begovoy.bitrix24.ru");
	});
});
