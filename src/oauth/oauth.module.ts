import { Module } from "@nestjs/common";
import { OAuthController } from "./oauth.controller";
import { OAuthCallbackController } from "./oauth-callback.controller";
import { Bitrix24Module } from "../bitrix24/bitrix24.module";
import { PrismaModule } from "../prisma/prisma.module";

@Module({
	controllers: [OAuthController, OAuthCallbackController],
	imports: [Bitrix24Module, PrismaModule],
})
export class OauthModule {}
