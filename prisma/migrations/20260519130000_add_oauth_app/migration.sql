-- Дополнительные OAuth-приложения для split-режима B24. См. memory
-- customer_360_split_b24.

CREATE TABLE `OAuthApp` (
    `id`               INT NOT NULL AUTO_INCREMENT,
    `portalDomain`     VARCHAR(190) NOT NULL,
    `appKind`          VARCHAR(32) NOT NULL,
    `clientId`         VARCHAR(100) NOT NULL,
    `clientSecret`     TEXT NOT NULL,
    `accessToken`      TEXT NOT NULL,
    `refreshToken`     TEXT NULL,
    `tokenExpiresAt`   DATETIME(3) NULL,
    `applicationToken` TEXT NULL,
    `scope`            VARCHAR(500) NULL,
    `createdAt`        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt`        DATETIME(3) NOT NULL,
    PRIMARY KEY (`id`),
    UNIQUE INDEX `OAuthApp_portalDomain_appKind_key` (`portalDomain`, `appKind`),
    INDEX `OAuthApp_appKind_idx` (`appKind`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
