-- A2: контексты IG-комментов теперь хранятся по (clientId, mediaId) — у клиента
-- под разными постами разные media_id, последний контекст не перезаписывает
-- предыдущий. PK переходит с (clientId) на (clientId, mediaId).
ALTER TABLE `IgCommentContext` DROP PRIMARY KEY;
ALTER TABLE `IgCommentContext` ADD PRIMARY KEY (`clientId`, `mediaId`);
