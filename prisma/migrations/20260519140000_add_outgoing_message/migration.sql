-- Persistent mapping для outgoingMessageStatus → B24 send.status.delivery.
-- Раньше было in-memory Map (теряется при рестарте adapter'а).

CREATE TABLE `OutgoingMessage` (
    `idMessage`        VARCHAR(100) NOT NULL,
    `b24_chat_id`      VARCHAR(100) NOT NULL,
    `b24_message_id`   VARCHAR(100) NOT NULL,
    `external_chat_id` VARCHAR(190) NOT NULL,
    `line`             INT NOT NULL,
    `connector`        VARCHAR(64) NOT NULL,
    `createdAt`        DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt`        DATETIME(3) NOT NULL,
    PRIMARY KEY (`idMessage`),
    INDEX `OutgoingMessage_expiresAt_idx` (`expiresAt`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
