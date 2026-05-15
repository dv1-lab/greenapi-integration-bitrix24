CREATE TABLE `MaxContact` (
    `id`         BIGINT NOT NULL AUTO_INCREMENT,
    `idInstance` BIGINT NOT NULL,
    `phone`      VARCHAR(32) NOT NULL,
    `chatId`     VARCHAR(64) NOT NULL,
    `createdAt`  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt`  DATETIME(3) NOT NULL,

    UNIQUE INDEX `MaxContact_idInstance_phone_key`(`idInstance`, `phone`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
