# Kolo — живая изометрическая админка такси (демо, Белград)

Агрегатор такси уровня «Яндекс Go»: партнёрские таксопарки, машины, водители, заказы. Главное — интерактивный изометрический 3D-город, где в реальном времени ездят такси, автобусы и фоновые машины, работают светофоры, а админ влияет на систему (статусы машин, заказы, светофоры, плотность трафика, спрос).

## Как продолжить работу в новом чате
1. Прочитай этот файл, затем docs/ROADMAP.md (текущий фокус и чек-листы), затем нужный документ: docs/ARCHITECTURE.md, docs/DOMAIN.md, docs/DESIGN.md, docs/SIMULATION.md.
2. Источник правды по прогрессу — чекбоксы в docs/ROADMAP.md и история git (git log --oneline).
3. Перед решением, не описанным в роадмапе и docs, спроси пользователя; предлагай улучшения и более удачные технологии.
4. После каждого законченного шага: обнови чекбоксы роадмапа, закоммить (conventional commits).

## Правила документации
- Любой файл в docs/, этот файл и роадмап: не более 100 строк, без строк кода, без истории изменений.
- Документация пишется для агента, пользователь её не читает.

## Стек и структура (pnpm workspaces + Turborepo)
- apps/api — NestJS 12 (ESM), Prisma 8 RC (contract-first, src/prisma/contract.prisma), socket.io.
- apps/web — Next.js 16 (App Router, React 19, React Compiler), Tailwind 4, shadcn/ui, React Three Fiber + drei.
- packages/sim — детерминированный генератор города и движок симуляции (чистый TS, без зависимостей).
- packages/contracts — общие enum'ы, wire-формат WebSocket, zod-схемы REST.

## Окружение
- Node 25, pnpm 12 (политика: пакеты младше 24 ч не ставятся — выбирать более старые версии).
- Локальный PostgreSQL 18 на localhost:5432, пользователь и пароль postgres. Docker не использовать.
- На Node 25 нет глобального Temporal: даты в контракте Prisma — типы TimestamptzString.

## Скилы агента
- Корень .claude/skills: shadcn, vercel-react-best-practices, prisma-orm-setup (вне git, восстанавливаются по skills-lock.json).
- apps/api/.claude/skills: prisma-8 и др. — вне git, синхронизируются командой prisma skills sync, читать перед работой с БД.
- Next.js 16 отличается от обучающих данных: читать документацию в node_modules/next/dist/docs перед кодом.

## Команды (в корне)
- pnpm dev — собрать пакеты и запустить api (порт 4000) и web (порт 3000).
- pnpm test — тесты (vitest) во всех пакетах; pnpm build — сборка всего.
- В apps/api: pnpm prisma contract emit после правки контракта; миграции — см. docs/ARCHITECTURE.md.
- pnpm lint в apps/web проверяет правила React Compiler — держать чистым.
- Визуальная проверка: скриншоты headless Chrome (playwright-core) по localhost:3000; dev-хуки window.__koloUi, window.__koloFrames и window.__koloGl.
- Бюджет кадра: pnpm perf --budget в apps/web при запущенном pnpm dev.
- Геометрия дорог: node scripts/road-audit.mjs [--map ...] в packages/sim — метрики дефектов и карты сверху (tmp/ вне git).

## Ключевые соглашения
- Координаты мира в метрах: x — восток, z — юг, y — вверх; правостороннее движение.
- Симуляция авторитетна на сервере; клиент интерполирует кадры 10 Гц и строит тот же город из того же файла района.
- Статусы и события заказов — в packages/contracts; строки UI — на русском.
