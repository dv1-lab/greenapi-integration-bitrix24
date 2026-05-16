import { Module } from '@nestjs/common';
import { Bitrix24Service } from './bitrix24.service';
import { Bitrix24Transformer } from "./bitrix24.transformer";
import { I2crmTgMirrorService } from "./i2crm-tg-mirror.service";

@Module({
  providers: [Bitrix24Service, Bitrix24Transformer, I2crmTgMirrorService],
  exports: [Bitrix24Service],
})
export class Bitrix24Module {}
