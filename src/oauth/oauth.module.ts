import { Module } from "@nestjs/common";
import { OAuthController } from "./oauth.controller";
import { OAuthCallbackController } from "./oauth-callback.controller";
import { Customer360OAuthController } from "./customer360-oauth.controller";
import { Bitrix24Module } from "../bitrix24/bitrix24.module";
import { PrismaModule } from "../prisma/prisma.module";

@Module({
	controllers: [OAuthController, OAuthCallbackController, Customer360OAuthController],
	imports: [Bitrix24Module, PrismaModule],
})
export class OauthModule {}
