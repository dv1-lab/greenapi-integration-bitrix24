CREATE TABLE `B24EntitySnapshot` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `entityType` VARCHAR(10) NOT NULL,
    `entityId` INTEGER NOT NULL,
    `fields` JSON NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `B24EntitySnapshot_entityType_entityId_key`(`entityType`, `entityId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
