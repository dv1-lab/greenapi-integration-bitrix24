import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { WidgetController } from "./widget.controller";
import { PrismaModule } from "../prisma/prisma.module";
import { Bitrix24Module } from "../bitrix24/bitrix24.module";

@Module({
	imports: [ConfigModule, PrismaModule, Bitrix24Module],
	controllers: [WidgetController],
})
export class WidgetModule {}
