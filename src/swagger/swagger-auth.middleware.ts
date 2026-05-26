// Cookie-сессия для Swagger UI — заменяет HTTP Basic Auth.
//
// Flow:
//   1. GET  /api/login  → HTML форма входа
//   2. POST /api/login  → проверка creds → cookie `swagger_session=...` → redirect /api
//   3. POST /api/logout → очистить cookie → redirect /api/login
//   4. middleware на /api*, /api-json:
//      - если есть валидная cookie → next()
//      - иначе → 302 redirect /api/login (с query ?from=<original>)
//
// Cookie:
//   - HttpOnly (защита от XSS)
//   - Secure (только https в prod)
//   - SameSite=Strict (защита от CSRF)
//   - Max-Age: 30 дней
//
// Подпись: HMAC-SHA256 с ключом = SWAGGER_PASSWORD (использовать пароль как
// secret — норм, при ротации пароля все cookies инвалидируются).
//
// Дизайн: минималистичный, не зависит от внешних CSS.

import type { Request, Response, NextFunction } from "express";
import * as crypto from "crypto";

const COOKIE_NAME = "swagger_session";
const COOKIE_MAX_AGE_SEC = 30 * 24 * 3600; // 30 дней

export function createSwaggerAuthMiddleware(opts: {
	user: string;
	password: string;
}) {
	const { user: expectedUser, password: secret } = opts;

	function sign(payload: string): string {
		return crypto
			.createHmac("sha256", secret)
			.update(payload)
			.digest("base64url");
	}

	function makeCookieValue(): string {
		const expires = Math.floor(Date.now() / 1000) + COOKIE_MAX_AGE_SEC;
		const payload = `${expectedUser}.${expires}`;
		return `${payload}.${sign(payload)}`;
	}

	function verifyCookieValue(value: string): boolean {
		if (!value) return false;
		const parts = value.split(".");
		if (parts.length !== 3) return false;
		const [user, expires, sig] = parts;
		if (user !== expectedUser) return false;
		const expiresNum = parseInt(expires, 10);
		if (!Number.isFinite(expiresNum) || expiresNum < Math.floor(Date.now() / 1000)) {
			return false;
		}
		// Timing-safe сравнение
		const expectedSig = sign(`${user}.${expires}`);
		if (sig.length !== expectedSig.length) return false;
		return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig));
	}

	function parseCookies(header: string | undefined): Record<string, string> {
		if (!header) return {};
		const out: Record<string, string> = {};
		for (const pair of header.split(";")) {
			const idx = pair.indexOf("=");
			if (idx < 0) continue;
			const k = pair.slice(0, idx).trim();
			const v = pair.slice(idx + 1).trim();
			if (k) out[k] = decodeURIComponent(v);
		}
		return out;
	}

	function isAuthenticated(req: Request): boolean {
		const cookies = parseCookies(req.headers.cookie);
		return verifyCookieValue(cookies[COOKIE_NAME] || "");
	}

	function loginPage(error?: string, from?: string): string {
		const errorBlock = error
			? `<div class="error">${escapeHtml(error)}</div>`
			: "";
		const fromInput = from
			? `<input type="hidden" name="from" value="${escapeHtml(from)}">`
			: "";
		return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Вход — Swagger UI</title>
<style>
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background: #0a0a0a;
  color: #f5f5f5;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
}
.card {
  background: #1a1a1a;
  border: 1px solid #2a2a2a;
  border-radius: 12px;
  padding: 32px;
  width: 100%;
  max-width: 360px;
  box-shadow: 0 4px 24px rgba(0,0,0,0.3);
}
h1 {
  margin: 0 0 4px;
  font-size: 18px;
  font-weight: 600;
}
.subtitle {
  margin: 0 0 24px;
  font-size: 13px;
  color: #888;
}
.field {
  margin-bottom: 16px;
}
label {
  display: block;
  font-size: 13px;
  color: #aaa;
  margin-bottom: 6px;
}
input[type="text"], input[type="password"] {
  width: 100%;
  padding: 10px 12px;
  background: #0a0a0a;
  border: 1px solid #333;
  border-radius: 6px;
  color: #f5f5f5;
  font-size: 14px;
  font-family: inherit;
}
input:focus {
  outline: none;
  border-color: #4a9eff;
}
button {
  width: 100%;
  padding: 10px 16px;
  background: #4a9eff;
  color: #fff;
  border: none;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
  margin-top: 8px;
}
button:hover { background: #3a8eef; }
.error {
  padding: 10px 12px;
  background: #2a1010;
  border: 1px solid #5a2020;
  color: #ff8080;
  border-radius: 6px;
  font-size: 13px;
  margin-bottom: 16px;
}
.footer {
  margin-top: 24px;
  font-size: 11px;
  color: #555;
  text-align: center;
}
</style>
</head>
<body>
<div class="card">
  <h1>Swagger UI</h1>
  <p class="subtitle">Social Connector adapter</p>
  ${errorBlock}
  <form method="POST" action="/api/login" autocomplete="on">
    ${fromInput}
    <div class="field">
      <label for="username">Имя пользователя</label>
      <input type="text" id="username" name="username" required autocomplete="username" autofocus>
    </div>
    <div class="field">
      <label for="password">Пароль</label>
      <input type="password" id="password" name="password" required autocomplete="current-password">
    </div>
    <button type="submit">Войти</button>
  </form>
  <div class="footer">Сессия — 30 дней</div>
</div>
</body>
</html>`;
	}

	function escapeHtml(s: string): string {
		return s
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#39;");
	}

	function setSessionCookie(res: Response): void {
		const value = makeCookieValue();
		// SameSite=Lax (а не Strict) — чтобы редирект после POST /api/login
		// корректно нес cookie на GET /api. Strict бы блокировал.
		const cookieAttrs = [
			`${COOKIE_NAME}=${encodeURIComponent(value)}`,
			"HttpOnly",
			"Path=/",
			"SameSite=Lax",
			`Max-Age=${COOKIE_MAX_AGE_SEC}`,
			"Secure",
		];
		res.setHeader("Set-Cookie", cookieAttrs.join("; "));
	}

	function clearSessionCookie(res: Response): void {
		res.setHeader(
			"Set-Cookie",
			`${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0; Secure`,
		);
	}

	// Главный middleware. Возвращает функцию для app.use().
	return function swaggerAuth(req: Request, res: Response, next: NextFunction) {
		const path = req.path;

		// Защищаем только Swagger-пути. Остальное — пропускаем.
		// Логика URL match:
		//  - /api          → Swagger UI
		//  - /api-json     → OpenAPI JSON
		//  - /api/...      → swagger UI assets (csss, js)
		//  - /api/login    → login page
		//  - /api/logout   → logout
		const isSwaggerPath =
			path === "/api" ||
			path === "/api-json" ||
			path.startsWith("/api/");
		if (!isSwaggerPath) {
			return next();
		}

		// --- /api/login GET ---
		if (path === "/api/login" && req.method === "GET") {
			// Если уже залогинен — сразу редиректим на /api
			if (isAuthenticated(req)) {
				res.redirect(302, "/api");
				return;
			}
			res.setHeader("Content-Type", "text/html; charset=utf-8");
			const from = (req.query?.from as string) || "";
			res.status(200).send(loginPage(undefined, from));
			return;
		}

		// --- /api/login POST ---
		if (path === "/api/login" && req.method === "POST") {
			const body = (req.body || {}) as Record<string, string>;
			const submittedUser = String(body.username || "");
			const submittedPass = String(body.password || "");
			// timing-safe сравнение пароля
			let ok = false;
			if (submittedUser === expectedUser && submittedPass.length === secret.length) {
				try {
					ok = crypto.timingSafeEqual(
						Buffer.from(submittedPass),
						Buffer.from(secret),
					);
				} catch {
					ok = false;
				}
			}
			if (!ok) {
				res.setHeader("Content-Type", "text/html; charset=utf-8");
				const from = String(body.from || "");
				res.status(401).send(loginPage("Неверное имя пользователя или пароль", from));
				return;
			}
			setSessionCookie(res);
			const from = String(body.from || "");
			const redirect = from && from.startsWith("/api") ? from : "/api";
			res.redirect(302, redirect);
			return;
		}

		// --- /api/logout ---
		if (path === "/api/logout") {
			clearSessionCookie(res);
			res.redirect(302, "/api/login");
			return;
		}

		// --- /api*, /api-json: требуется auth ---
		if (!isAuthenticated(req)) {
			// Для JSON-spec возвращаем 401 (а не redirect — клиент должен видеть, что не auth)
			if (path === "/api-json") {
				res.status(401)
					.setHeader("Content-Type", "application/json")
					.send(JSON.stringify({ error: "unauthorized", login_url: "/api/login" }));
				return;
			}
			const fromQuery = encodeURIComponent(req.originalUrl || path);
			res.redirect(302, `/api/login?from=${fromQuery}`);
			return;
		}

		next();
	};
}
