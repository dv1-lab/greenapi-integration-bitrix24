-- B24-аналог TG pinned-поста: после imconnector.send.messages для первого
-- сообщения в новой IG-Comment сессии adapter дополнительно шлёт служебное
-- сообщение SYSTEM=Y с RICH_LINK-preview исходного поста IG. Для дедупа в
-- одной (clientId, mediaId) — флаг pinnedMediaSent (timestamp или null).
ALTER TABLE `IgCommentContext`
    ADD COLUMN `pinnedMediaSent` DATETIME NULL;
