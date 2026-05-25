-- Reply-to-comment в IG: сохраняем сырой текст коммента клиента, чтобы
-- при reply через B24-цитату матчить по содержимому и подставить нужный
-- commentId (B24 «Ответить» не передаёт parent_id в outgoing webhook).
ALTER TABLE `IgInboundB24Link`
    ADD COLUMN `commentText` VARCHAR(500) NULL;

-- Индекс по (b24ChatId, commentText) ускорит lookup из handleI2crmOutgoing.
CREATE INDEX `IgInboundB24Link_b24ChatId_commentText_idx`
    ON `IgInboundB24Link` (`b24ChatId`, `commentText`(191));
