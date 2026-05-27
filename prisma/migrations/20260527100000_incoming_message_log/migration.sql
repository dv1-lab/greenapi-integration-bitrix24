-- Журнал incoming-сообщений Green API для идемпотентности backfill (task #71).
-- Записывается в webhooks-контроллере при `incomingMessageReceived`.
-- При backfill через `lastIncomingMessages` проверяем по `idMessage` — если
-- запись уже есть, не обрабатываем повторно (не плодим дублей в TG-зеркале).
CREATE TABLE `IncomingMessage` (
    `idMessage`  VARCHAR(100) NOT NULL,
    `idInstance` BIGINT       NOT NULL,
    `chatId`     VARCHAR(64)  NOT NULL,
    `timestamp`  INT          NOT NULL,
    `source`     VARCHAR(16)  NOT NULL DEFAULT 'webhook',
    `receivedAt` DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (`idMessage`),
    INDEX `IncomingMessage_idInstance_timestamp_idx` (`idInstance`, `timestamp`),
    INDEX `IncomingMessage_chatId_idx` (`chatId`)
) DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
