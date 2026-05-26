import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { AppModule } from "./app.module";
import { Settings, GreenApiLogger } from "@green-api/greenapi-integration";
import helmet from "helmet";
import { urlencoded, json } from "express";
import { mask, maskString } from "./common/mask";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import type { Request, Response, NextFunction } from "express";

declare global {
	namespace PrismaJson {
		// noinspection JSUnusedGlobalSymbols
		type InstanceSettings = Settings;
	}
}

// Перехватываем logEntry GreenApiLogger чтобы все логи (наши + из SDK)
// автоматически маскировали accessToken/refreshToken/applicationToken/
// apiTokenInstance/api-keys/passwords. SDK логирует Instance целиком при
// каждом B24 REST-вызове — без этого патча токены попадают в docker logs.
function patchGreenApiLogger() {
	const proto: any = (GreenApiLogger as any).prototype;
	if (!proto || proto.__maskingPatched) return;
	const origLogEntry = proto.logEntry;
	proto.logEntry = function (level: string, message: any, additionalContext: any = {}) {
		const safeMessage = typeof message === "string" ? maskString(message) : message;
		const safeContext = additionalContext && typeof additionalContext === "object"
			? mask(additionalContext)
			: additionalContext;
		return origLogEntry.call(this, level, safeMessage, safeContext);
	};
	proto.__maskingPatched = true;
}

async function bootstrap() {
	patchGreenApiLogger();
	const app = await NestFactory.create(AppModule, {});
	app.useGlobalPipes(new ValidationPipe());
	app.use(helmet({
		contentSecurityPolicy: false,
		frameguard: false,
		crossOriginEmbedderPolicy: false,
		crossOriginOpenerPolicy: false,
		crossOriginResourcePolicy: false,
	}));
	app.enableCors();
	// B24 placement POST шлёт application/x-www-form-urlencoded — без этого @Body пустой.
	app.use(urlencoded({ extended: true, limit: "5mb" }));
	// Сохраняем raw body для JSON-запросов — нужно для /webhooks/i2crm
	// чтобы обойти JS Number precision loss на 64-bit IDs клиентов IG.
	app.use(json({
		limit: "5mb",
		verify: (req: any, _res, buf) => {
			req.rawBody = buf;
		},
	}));

	setupSwagger(app);

	await app.listen(3000);
}

// OpenAPI / Swagger UI — Swagger UI на /api, JSON на /api-json.
// Защищено basic_auth: env SWAGGER_USER + SWAGGER_PASSWORD. Если переменные
// не заданы — Swagger UI **выключен** (prod-safe default, не оставляем
// открытый attack surface).
function setupSwagger(app: any) {
	const swaggerUser = process.env.SWAGGER_USER;
	const swaggerPassword = process.env.SWAGGER_PASSWORD;
	if (!swaggerUser || !swaggerPassword) {
		// Тихо пропускаем — если env не заданы, Swagger UI не запускается.
		// Деплоится только когда сознательно выставили credentials.
		return;
	}

	// Простой Basic Auth middleware на /api и /api-json.
	const basicAuth = (req: Request, res: Response, next: NextFunction) => {
		const header = req.headers.authorization || "";
		const expected = "Basic " + Buffer.from(`${swaggerUser}:${swaggerPassword}`).toString("base64");
		if (header !== expected) {
			res.setHeader("WWW-Authenticate", 'Basic realm="Swagger"');
			res.status(401).send("Authentication required");
			return;
		}
		next();
	};
	app.use(["/api", "/api-json"], basicAuth);

	const config = new DocumentBuilder()
		.setTitle("Social Connector adapter")
		.setDescription(
			"NestJS-адаптер B24 ↔ Green API / i2crm / TG-боты для «Первого Бегового».\n\n" +
			"См. также: [docs/README.md](https://github.com/dv1-lab/greenapi-integration-bitrix24/blob/main/docs/README.md)",
		)
		.setVersion(process.env.npm_package_version || "0.3.2")
		.addTag("webhooks", "Внешние webhooks (Green API, B24, i2crm) + internal endpoints")
		.addTag("oauth", "B24 OAuth flow (Social Connector + Customer-360)")
		.addTag("widget", "B24 placement widget (отправка через виджет операторам)")
		.addTag("media", "Кэш медиа-файлов для зеркал")
		.addTag("health", "Health-check endpoints (для Healthchecks / Uptime Kuma)")
		.build();
	const document = SwaggerModule.createDocument(app, config);
	SwaggerModule.setup("api", app, document, {
		swaggerOptions: { persistAuthorization: true },
	});
}

void bootstrap();