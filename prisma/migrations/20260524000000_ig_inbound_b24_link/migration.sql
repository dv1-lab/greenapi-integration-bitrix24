-- Этап 3: связь b24 chat-message ↔ Instagram comment для reply на конкретный
-- коммент в треде. Заполняется при IG-incoming, читается при reply из B24.
CREATE TABLE `IgInboundB24Link` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `b24ChatId` VARCHAR(64) NOT NULL,
    `b24MessageId` VARCHAR(64) NOT NULL,
    `clientId` VARCHAR(40) NOT NULL,
    `mediaId` VARCHAR(64) NOT NULL,
    `commentId` VARCHAR(64) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `IgInboundB24Link_b24ChatId_b24MessageId_key`(`b24ChatId`, `b24MessageId`),
    INDEX `IgInboundB24Link_clientId_mediaId_idx`(`clientId`, `mediaId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
