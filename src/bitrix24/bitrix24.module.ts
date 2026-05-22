import { Module } from '@nestjs/common';
import { Bitrix24Service } from './bitrix24.service';
import { Bitrix24Transformer } from "./bitrix24.transformer";
import { I2crmTgMirrorService } from "./i2crm-tg-mirror.service";
import { MediaCacheService } from "./media-cache.service";
import { MediaController } from "./media.controller";

@Module({
  providers: [Bitrix24Service, Bitrix24Transformer, I2crmTgMirrorService, MediaCacheService],
  controllers: [MediaController],
  exports: [Bitrix24Service, I2crmTgMirrorService],
})
export class Bitrix24Module {}
