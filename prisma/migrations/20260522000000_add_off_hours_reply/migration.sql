CREATE TABLE `OffHoursReply` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `chatKey` VARCHAR(191) NOT NULL,
    `lastRepliedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `OffHoursReply_chatKey_key`(`chatKey`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
