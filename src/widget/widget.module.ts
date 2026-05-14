import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { WidgetController } from "./widget.controller";

@Module({
	imports: [ConfigModule],
	controllers: [WidgetController],
})
export class WidgetModule {}
