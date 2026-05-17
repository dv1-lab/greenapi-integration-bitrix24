CREATE TABLE `IgCommentContext` (
    `clientId` VARCHAR(40) NOT NULL,
    `mediaId` VARCHAR(64) NOT NULL,
    `commentId` VARCHAR(64) NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`clientId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
