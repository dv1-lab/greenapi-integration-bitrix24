import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { AppModule } from "./app.module";
import { Settings } from "@green-api/greenapi-integration";
import helmet from "helmet";
import { urlencoded } from "express";

declare global {
	namespace PrismaJson {
		// noinspection JSUnusedGlobalSymbols
		type InstanceSettings = Settings;
	}
}

async function bootstrap() {
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

	await app.listen(3000);
}

void bootstrap();