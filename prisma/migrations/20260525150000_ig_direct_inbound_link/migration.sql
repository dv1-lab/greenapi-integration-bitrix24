-- IG Direct: связь b24 chat-message ↔ внешний IG message_id для нативного
-- reply через цитирование в B24 → i2crm передаст в Instagram как reply.
CREATE TABLE `IgDirectInboundB24Link` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `b24ChatId` VARCHAR(64) NOT NULL,
    `b24MessageId` VARCHAR(64) NOT NULL,
    `clientId` VARCHAR(40) NOT NULL,
    `externalMessageId` VARCHAR(120) NOT NULL,
    `messageText` VARCHAR(500) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `IgDirectInboundB24Link_b24ChatId_b24MessageId_key`(`b24ChatId`, `b24MessageId`),
    INDEX `IgDirectInboundB24Link_clientId_idx`(`clientId`),
    INDEX `IgDirectInbound_b24ChatId_idx`(`b24ChatId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
