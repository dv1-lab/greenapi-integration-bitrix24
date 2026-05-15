-- CreateTable
CREATE TABLE `EntityPhonePref` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `portalDomain` VARCHAR(190) NOT NULL,
    `entityType` VARCHAR(20) NOT NULL,
    `entityId` VARCHAR(40) NOT NULL,
    `phone` VARCHAR(32) NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `EntityPhonePref_portalDomain_entityType_entityId_key`(`portalDomain`, `entityType`, `entityId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
