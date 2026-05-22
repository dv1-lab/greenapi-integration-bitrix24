CREATE TABLE `TgBotEventLog` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `updateId` VARCHAR(48) NOT NULL,
    `chatId` VARCHAR(40) NOT NULL,
    `messageId` VARCHAR(40) NULL,
    `direction` VARCHAR(8) NOT NULL,
    `payload` TEXT NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'pending',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `lastError` TEXT NULL,
    `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `sentAt` DATETIME(3) NULL,

    UNIQUE INDEX `TgBotEventLog_updateId_key`(`updateId`),
    INDEX `TgBotEventLog_status_receivedAt_idx`(`status`, `receivedAt`),
    INDEX `TgBotEventLog_chatId_idx`(`chatId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
