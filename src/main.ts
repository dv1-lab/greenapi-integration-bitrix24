import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { AppModule } from "./app.module";
import { Settings, GreenApiLogger } from "@green-api/greenapi-integration";
import helmet from "helmet";
import { urlencoded, json } from "express";
import { mask, maskString } from "./common/mask";

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

	await app.listen(3000);
}

void bootstrap();