# Белград, план 3: общественный транспорт по GTFS

> Для агента: исполнять по задачам (superpowers:executing-plans или subagent-driven-development), чекбоксы отмечать по ходу.

**Цель:** автобусы, троллейбусы и минибусы ходят по реальному расписанию GTFS на часах Europe/Belgrade: въезжают через рамку или появляются на конечной, стоят на своих остановках, видно опоздание; есть синхронизация часов и инспекторы линии и остановки.
**Архитектура:** импорт кладёт в файл района раздел transit (остановки, линии, варианты трасс с упрощёнными shapes, профили времён и отправления по сервисам); packages/sim привязывает остановки к полосам в buildCityFromDistrict, сервер прокладывает трассы по графу со штрафом от shape и выпускает рейсы по часам симуляции; клиент получает позиции кадрами, расписание остановки и линии — по REST.
**Стек:** TypeScript, vitest, Intl.DateTimeFormat с timeZone (Temporal на Node 25 нет), NestJS, R3F; без новых пакетов.
**Спек:** docs/superpowers/specs/2026-10-21-belgrade-design.md; планы 1 и 2 — в той же папке.

## Глобальные ограничения
- Ничего не скачивать и не устанавливать без разрешения; сырьё — data/raw/gtfs/feed/*.txt (версия 24, действует 02.09.2025–31.12.2026), рамка BELGRADE_BBOX без изменений.
- Решения пользователя: расписание — в файле района (один хэш версии); рейс с конечной внутри рамки появляется у бордюра за 60 с до отправления и исчезает через 20 с после прибытия на последнюю остановку; все рейсы по расписанию без лимита; трасса — маршрут по графу со штрафом от shape.
- Только route_type 3 (автобус) и 11 (троллейбус); трамваи (0) — план 4. Минибус — линии из MINIBUS_LINES (EKO1, EKO2) в импорте.
- Стоянка 15–30 с; раньше графика — ждёт отправления; опоздание больше 60 с — стоянка 8–12 с без ожидания; «по расписанию», если |опоздание| меньше 60 с.
- Строки UI по-русски, названия остановок латиницей; на карте атрибуция «Расписание: data.gov.rs, Grad Beograd».
- pnpm test, pnpm build и pnpm lint (web) зелёные после каждой задачи; коммиты conventional; после задачи — чекбоксы ROADMAP.

## Фокус ревью
- Рейсы после полуночи (времена 24:00–26:30) идут по сервису вчерашнего дня: в 00:30 понедельника работают ночные рейсы воскресенья N.
- Смена часов (DST 29.03 и 25.10.2026): секунды суток и дата берутся по Europe/Belgrade, рейсы не дублируются и не пропадают.
- Синхронизация назад во времени (после ×4): автобусы пересобраны по расписанию, без дублей id и наложений, такси и заказы не тронуты.
- Занятый въезд на рамке или занятая конечная: рейс ждёт до 120 с, потом считается пропущенным, а не ставится в другую машину.
- Остановка без привязки к полосе (пешеходная зона, служебный разворот): рейс её пропускает без зависания, плановые времена следующих остановок не сдвигаются.

### Задача 1: календарь и часы Белграда
**Файлы:** создать packages/sim/src/transit/calendar.ts (+ calendar.test.ts); экспорт из src/index.ts.
**Интерфейсы:** belgradeTime(epochMs) → {date: 'YYYYMMDD', weekday 0–6 (0 — воскресенье), secOfDay}; orthodoxEaster(year) → 'YYYYMMDD' (юлианская Пасха Меёса плюс 13 дней); serbianHolidays(year) → Map даты в русское имя; serviceFor(date, cal: TransitCalendar) → id сервиса; TransitCalendar {week: 7 id сервисов по weekday, extra: пары [date, service] из calendar_dates с exception_type 1}.
- Праздники: 1–2 января «Новый год», 7 января «Рождество», 15–16 февраля «День государственности», Страстная пятница и Пасхальный понедельник, 1–2 мая «Праздник труда», 11 ноября «День перемирия»; если день 1–2 января, 15–16 февраля, 1–2 мая или 11 ноября приходится на воскресенье, выходным становится ближайший следующий будний не праздник. Великая суббота не праздник.
- serviceFor: extra на эту дату; иначе праздник → week[0]; иначе week[weekday]; после конца фида — то же правило.
- [x] Тесты: Пасха 2024-05-05, 2025-04-20, 2026-04-12, 2027-05-02; праздники с понедельника по субботу за 2024 — 0101, 0102, 0215, 0216, 0501, 0502, 0503, 0506, 1111; за 2025 — 0101, 0102, 0107, 0215, 0217, 0418, 0421, 0501, 0502; 2023 — 0102 и 0103 в праздниках; belgradeTime: 2026-03-29T01:30Z → 03:30, 2026-10-25T01:30Z → 02:30; serviceFor 20261022 → RD, 20261111 → N, 20270107 → N, суббота 20261024 → S.
- [x] Коммит feat(sim): Belgrade clock, Serbian holidays and GTFS service days.

### Задача 2: импорт GTFS в файл района
**Файлы:** создать packages/sim/src/import/gtfs.ts (+ gtfs.test.ts); изменить city/district.ts, import/district.ts, import/index.ts, scripts/import-district.mjs.
**Интерфейсы:** importGtfs(files: Record<имя файла, текст CSV>, bbox) → DistrictTransit; District получает transit (пустой раздел без фида), meta.gtfsVersion — feed_version; CLI читает data/raw/gtfs/feed, печатает число остановок, линий, вариантов и отправлений RD.
- DistrictTransit: feed {version, start, end}; calendar (TransitCalendar); stops {id, code, name, x, z, dir: [dx, dz] — средний единичный вектор движения по shapes в точке остановки, 0,01}; lines {id, name (short), longName, mode: bus | trolley | minibus, color, text}; patterns.
- Вариант (pattern) — ключ: линия, direction_id, последовательность остановок в рамке, enter, exit; поля line (индекс), dir, headsign, stops (индексы), shape (плоские x, z внутри рамки плюс 50 м, Дуглас — Пекер 2 м), enter и exit (true, если до или после есть остановки вне рамки), profiles.
- Профиль: t — плоские пары прибытие и отправление в секундах от отправления с первой остановки в рамке; enter и exit — смещения пересечения рамки (линейно по длине shape между соседними остановками снаружи и внутри); starts — по id сервиса возрастающие секунды суток первого отправления в дельта-кодировке (могут быть больше 86 400).
- CSV — свой разбор с кавычками и BOM; stop_times обходится построчно без массива всех строк.
- [x] Синтетика: рейс из пяти остановок, две за рамкой — вариант с enter, без exit, смещение enter отрицательное и пропорционально длине; одинаковые времена схлопываются в один профиль; 25:10:00 → 90 600; route_type 0 отброшен; EKO1 → minibus, тип 11 → trolley.
- [x] Реальный фид (пропуск без сырья): остановок от 120, линий от 90 (trolley от 4), вариантов от 150, отправлений RD от 15 000; раздел transit меньше 900 КБ, файл района меньше 4 МБ. Перегенерировать data/districts/belgrade-center.json.
- [x] Коммит feat(sim): import GTFS stops, lines and timetables into the district.

### Задача 3: остановки и линии в городе
**Файлы:** создать city/transit-places.ts (+ transit-places.test.ts); изменить city/types.ts, district-build.ts, places.ts, packages/contracts enums.ts; traffic.ts и routing.ts (isTransitKind вместо kind === 'BUS').
**Интерфейсы:** BusStop {id, code, name, x, z, heading, lane, s, lines: id линий} — x, z у бордюра; BusLine {id, name, longName, mode, color, textColor}; Segment.trolley из ребра; VEHICLE_KINDS дополняется TROLLEY и MINIBUS в конце (индексы старых не меняются); isTransitKind(kind); makeVehicle: троллейбус 12 м, минибус 7,5 м.
- bindStop: кандидаты — бордюрная полоса любого сегмента уровня улицы (psv-only можно, тоннели нет) в 30 м от точки; направление полосы отличается от dir не больше чем на 60°; ближайшая; s зажат в [10, length − 4]; без кандидата остановки в busStops нет.
- [x] Тесты на файле района: привязано от 90% остановок с вариантами; у всех |угол| ≤ 60° и расстояние ≤ 30 м; у остановок одного имени на двух сторонах улицы разные полосы; в ядре hotspots и pickOrigin работают с непустыми busStops.
- [x] Коммит feat(sim): bind GTFS stops to curb lanes.

### Задача 4: трассы вариантов по графу
**Файлы:** создать engine/transit-net.ts (+ transit-net.test.ts).
**Интерфейсы:** buildTransitNet(city, transit) → TransitNet {patterns: NetPattern[], byLine}; NetPattern {index, line, headsign, mode, segs, stops: {stop (индекс city.busStops), timeIdx (индекс в профиле), segIdx, s, at (м от начала трассы)}[], entryLane | -1, exitSeg | -1, length, profiles}.
- Въезд: полоса сегмента от граничного узла, начало ближе всего к первой точке shape (до 80 м); выезд: сегмент к граничному узлу у последней точки. Ноги между соседними привязанными остановками — routeSegments с allowPsv, toLane полосы остановки и штрафом 4 × длина / скорость сегменту, середина которого дальше 25 м от shape; две остановки на одном сегменте по возрастанию s — без маршрута. Нога не нашлась — вариант обрезается до последней достижимой остановки.
- [ ] Тесты: проложено полностью от 95% вариантов с двумя и более привязанными остановками; у 85% вариантов 90% точек трассы ближе 30 м к shape; at строго растёт; timeIdx равен позиции остановки в варианте файла (пропущенные не сдвигают времена); сборка сети меньше 1,5 с.
- [ ] Коммит feat(sim): route GTFS patterns over the road graph.

### Задача 5: выпуск рейсов по расписанию в симуляции
**Файлы:** создать engine/transit.ts (+ transit.test.ts); изменить engine/simulation.ts (+ simulation.test.ts), traffic.ts (isLaneFree(lane, s, room) — перенос crowded из roaming.ts).
**Интерфейсы:** SimulationOptions.startAt (epoch ms, по умолчанию Date.now()); sim.clock = startAt + t × 1000; sim.syncClock(nowMs = Date.now()); class Transit {update(clockMs) раз в секунду, step(), rebuild(clockMs), trips}; старые Bus, spawnBuses, extendBus и BusLine.segments удаляются.
- Активные рейсы: сервис сегодняшней даты и сервис вчерашней со временами от 86 400 (startS = start − 86 400). Выпуск: enter — в start + enter на entryLane при свободном начале 9 м; конечная — в start − 60 с у остановки (pulled); иначе ждёт до 120 с и считается пропущенным.
- Старт и rebuild: рейсы в пути ставятся по графику — интерполяция at между остановками по времени, на полосе трассы при свободных 14 м, иначе ближайшее свободное место дальше по трассе; стоящий по графику — у остановки pulled.
- Остановки: на сегменте следующей остановки при s < stop.s − 6 — v.stop; проехал — missed и следующая; прибытие — стоянка по правилу из ограничений, при отправлении delay = факт − план; после последней — 20 с и исчезновение либо путь до exitSeg и исчезновение у конца полосы выезда. id машин — B и номер выпуска.
- [ ] Тесты на файле района: будний 15:30 (2026-10-22T13:30Z), 10 минут — машин ОТ от 100; обслужено от 90% остановок пройденных; наложений меньше 0,2%; нет NaN; нет ОТ, стоящих дольше 180 с вне стоянки; 600 с симуляции быстрее 6 с.
- [ ] Тесты: 03:00 — меньше 20 машин ОТ; 00:30 понедельника 2026-10-26 есть рейсы сервиса N; праздник 2026-11-11 идёт по N; въезд, занятый стоящей машиной, — рейс выходит после освобождения, а через 120 с считается пропущенным; syncClock после ×4 возвращает clock к now, число машин ОТ в пределах 15% от свежего старта, такси и заказы те же.
- [ ] Коммит feat(sim): buses run on the GTFS timetable and Belgrade clock.

### Задача 6: контракты и API
**Файлы:** packages/contracts live.ts и api.ts; apps/api simulation.controller.ts, live.gateway.ts, simulation.service.ts; e2e.
**Интерфейсы:** LiveFrame.clock (epoch ms симуляции); SimControlInput.sync (true); BusDetail + kind, lineId, color, headsign, delaySec, nextStopAt; StopDetail {id, code, name, lines, departures: {lineId, name, color, headsign, scheduledAt, expectedAt, vehicleId}[] — до 8 в ближайшие 60 мин}; LineDetail {id, name, longName, mode, color, textColor, directions: {headsign, stops: {id, name}[], headwayMin | null (медиана интервалов отправлений с первой остановки за ближайший час), nextDepartureAt, route}[], vehicles}; GET /api/sim/stops/:id и /api/sim/lines/:id.
- [ ] e2e: остановка и линия 404 и 200, control {sync: true} возвращает state; коммит feat(api): transit clock, stop and line details.

### Задача 7: сцена — ОТ, контактная сеть, остановки
**Файлы:** scene/vehicles.tsx, city-static.tsx, city-geometry.ts, overlays.tsx, lib/palette.ts, DESIGN.md.
- Группы bus (до 260), trolley (до 60, две штанги на крыше), minibus (до 24, корпус 7,5 м); контактная сеть — две тонкие линии на высоте 5,6 м над сегментами с trolley; павильон остановки по heading у бордюра.
- Атрибуция GTFS рядом с OSM.
- [ ] Скриншоты Славии, Теразије и Студентского трга в будний день; коммит feat(web): transit vehicles, trolley wires and stops.

### Задача 8: часы, синхронизация и инспекторы
**Файлы:** console/top-bar.tsx, inspector.tsx, inspector-places.tsx, command-search.tsx, lib/queries.ts, ui-store.ts (Selection line), scene/overlays.tsx; docs SIMULATION, ARCHITECTURE, DOMAIN, DESIGN, ROADMAP.
- Часы — время Белграда из кадра и тип дня (будний, суббота, воскресенье, праздник с именем); при |clock − wall| больше 30 с и скорости не выше ×1 — кнопка «Синхронизировать».
- Инспектор остановки — ближайшие отправления («через N мин», опоздание); инспектор линии — направления, остановки по порядку, интервал, следующий рейс, трасса цветом линии; инспектор автобуса — «по расписанию» или «опаздывает на N мин»; поиск по линиям.
- [ ] Скриншоты инспекторов; обновить доки и ROADMAP (этапы 1 и 4); коммит feat(web): Belgrade clock, sync and transit inspectors.
