import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { WidgetController } from "./widget.controller";
import { PrismaModule } from "../prisma/prisma.module";

@Module({
	imports: [ConfigModule, PrismaModule],
	controllers: [WidgetController],
})
export class WidgetModule {}
