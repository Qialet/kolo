# Архитектура Kolo

## Потоки данных
- Сервер (apps/api) владеет живой симуляцией: SimulationService строит город из packages/sim и крутит шаг 50 мс.
- Каждые 100 мс шлюз LiveGateway рассылает кадр (позиции машин, фазы светофоров) в namespace socket.io «/live».
- Раз в секунду рассылается KPI; бизнес-события (заказы, поломки, смены статусов) идут сразу как события ленты и обновления заказов.
- Клиент (apps/web) строит тот же город локально из того же seed, поэтому по сети ходят только динамические данные.
- Детали выбранного объекта (маршрут такси, светофор, автобус) клиент опрашивает по REST раз в секунду через TanStack Query.

## Персистентность
- PostgreSQL через Prisma 8 (contract-first). Источник схемы — apps/api/src/prisma/contract.prisma.
- В БД: партнёры, парки, водители, машины, журнал смен статусов, заказы, события заказов, возражения.
- В памяти: позиции, полосы, фазы светофоров, активные заказы. Хуки симуляции пишут в БД через последовательную очередь, чтобы событие не опередило строку заказа.
- При старте незавершённые заказы прошлого запуска закрываются со статусом «Перезапуск системы»; нумерация кодов продолжается с максимума в БД.
- Пустая БД заполняется автоматически при старте (SeedService), отдельный сид-скрипт не нужен.

## Prisma 8 — как работать
- После правки контракта: в apps/api выполнить prisma contract emit (обновит contract.json и contract.d.ts, их коммитим).
- Миграции: prisma migration plan с именем, затем prisma db migrate. Папка apps/api/migrations под git.
- Запросы только через db.orm.public.Модель — см. скил prisma-8 в apps/api/.claude/skills.
- Даты хранятся как TimestamptzString (строки), на клиент отдаются в ISO через common/time.

## Модули API (NestJS 12, ESM)
- DatabaseModule (глобальный): DatabaseService с единственным клиентом Prisma и SeedService.
- SimulationModule: SimulationService, LiveGateway, SimulationController (/api/sim: состояние, управление, детали такси, автобусов и светофоров, режим светофора).
- FleetModule: /api/fleet/parks, /api/fleet/vehicles, смена статуса машины, история статусов.
- OrdersModule: /api/orders (список, деталь с событиями и возражениями, создание, отмена, ручное назначение, возражения и их решение).
- Валидация тела и query — zod-схемы из packages/contracts через ZodPipe.

## Фронтенд (Next.js 16)
- Одна страница: LiveConsole — полноэкранный Canvas и плавающие панели.
- Canvas грузится через next/dynamic без SSR. Сцена: статический город, светофоры, машины, оверлеи, проектор меток.
- Подписи над 3D — обычный DOM-слой (SceneLabels и WorldLabel), позиции проецирует LabelProjector раз в кадр. drei Html не используется: в dev он ломает рендер.
- Машины — instanced-меши; интерполяция кадров в FrameBuffer (lib/live) с задержкой 140 мс; позы делятся через livePoses.
- Состояние UI — zustand (lib/ui-store), живые данные — zustand (lib/live), серверные данные — TanStack Query (lib/queries).
- Включён React Compiler: не обращаться к ref в render, не мутировать значения хуков (камеру брать из state в useFrame). Проверка — pnpm lint.

## Запуск и порты
- pnpm dev в корне: turbo собирает пакеты, запускает tsc watch пакетов, раннер API (apps/api/scripts/dev.mjs) и next dev (порт 3000).
- Раннер API: tsc watch плюс перезапуск сервера (порт 4000) с дебаунсом при изменении dist API, packages/sim или packages/contracts.
- Переменные: apps/api/.env (DATABASE_URL, PORT, WEB_ORIGIN), фронт — NEXT_PUBLIC_API_URL (по умолчанию localhost:4000/api).

## Тесты
- packages/sim: город, светофоры, 10-минутный прогон симуляции без коллизий и дедлоков, сервисный цикл такси.
- apps/api: unit (ZodPipe, даты) и e2e (health, парки) — e2e требует локальный Postgres.
- Визуальная проверка: скриншоты через playwright-core и системный Chrome; в dev доступны window.__koloUi и window.__koloFrames.
