CREATE TABLE `I2crmEventLog` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `messageId` VARCHAR(64) NOT NULL,
    `clientId` VARCHAR(40) NOT NULL,
    `channel` VARCHAR(16) NOT NULL,
    `incoming` BOOLEAN NOT NULL,
    `payload` TEXT NOT NULL,
    `status` VARCHAR(16) NOT NULL DEFAULT 'pending',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `lastError` TEXT NULL,
    `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `sentAt` DATETIME(3) NULL,

    UNIQUE INDEX `I2crmEventLog_messageId_key`(`messageId`),
    INDEX `I2crmEventLog_status_receivedAt_idx`(`status`, `receivedAt`),
    INDEX `I2crmEventLog_clientId_idx`(`clientId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
