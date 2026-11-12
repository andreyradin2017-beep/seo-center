---
description: Установить (распаковать) SEO-центр из архива на этом ПК
---
Пользователь просит установить SEO-центр из архива.

Если передан путь к архиву в $ARGUMENTS — выполни:

    bash .opencode/skills/seo-center-backup/scripts/restore.sh $ARGUMENTS

Если путь не указан — найди свежие архивы (`~/seo-center-archives/*.tar.gz`,
`./seo-center-archives/*.tar.gz`) и уточни у пользователя нужный файл.

После установки сообщи: версию, папку проекта, адреса панели
(http://localhost:4180/ и http://<IP>:4180/) и OmniRoute (http://localhost:20128/v1),
а также путь резервной копии прежней установки.
