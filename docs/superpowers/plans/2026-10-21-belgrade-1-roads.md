# Белград, план 1: общий дорожный граф и импорт дорог

> Для агента: исполнять по задачам (superpowers:executing-plans), чекбоксы отмечать по ходу.

**Цель:** движок симуляции работает на произвольном графе, а реальные улицы правого берега импортированы в файл района, на котором 10 минут трафика идут без коллизий и дедлоков.
**Архитектура:** сначала обобщаем модель города и движок на процедурном городе (старые тесты — страховка), затем офлайн-импорт OSM в файл района и сборка City из него в packages/sim.
**Стек:** TypeScript, vitest, Node 25; без новых зависимостей.
**Спек:** docs/superpowers/specs/2026-10-21-belgrade-design.md. Следующие планы: 2 — здания, адреса, депо и переключение приложения; 3 — транспорт по GTFS и часы; 4 — трамваи; 5 — LOD и финал.

## Глобальные ограничения
- Ничего не скачивать и не устанавливать без явного разрешения пользователя.
- Координаты: x — восток, z — юг, метры; опорная точка — центр кольца Славии: 44.802480 N, 20.466320 E.
- Проекция: равнопромежуточная от опорной точки, радиус Земли 6371008.8 м, косинус опорной широты.
- Рамка района: юг 44.7980, запад 20.4470, север 44.8235, восток 20.4730 (сырьё выгружено с запасом 200 м).
- Сырьё в data/raw (вне git); файл района — data/districts/belgrade-center.json (в git).
- pnpm test и pnpm lint (web) держать зелёными после каждой задачи; коммиты conventional.

## Фокус ревью
- Короткие рёбра двойных проезжих частей: перекрёсток бульвара из 2–4 узлов OSM должен стать одним узлом, иначе дедлоки.
- Многополосное кольцо Славии: въезды уступают кольцу, машины не застревают на кольце.
- Улицы, обрезанные рамкой: машины уходят в сток, а не стоят в тупике.
- Пешеходные и автобусные улицы (Кнез Михаилова, psv-only) не попадают в маршруты легковых.
- Тоннели и мосты: разные layer не дают перекрёстка.

### Задача 1: фазы светофоров вместо осей
**Файлы:** packages/sim/src/engine/signals.ts, city/types.ts, city/build.ts, engine/traffic.ts, engine/simulation.ts; packages/contracts/src/live.ts и enums.ts; apps/web inspector.tsx и traffic-lights.tsx; apps/api simulation.controller.ts.
**Интерфейсы:**
- SignalPlan: список фаз (у каждой green в секундах) и offset; cycleOf суммирует зелёные и на каждый переход AMBER 3 + ALL_RED 1 + RED_AMBER 2.
- signalState возвращает aspects и left — массивы по фазам; переходы между соседними фазами по кругу в сербской последовательности.
- LightMode: AUTO, FLASHING, HOLD; удерживаемая фаза — поле holdPhase в SignalRuntime и в теле REST-запроса режима.
- Connector.approach заменяется на phase (индекс фазы узла); CityNode.priority заменяется на Segment.rank (больше — главнее).
- LightTuple: плоский массив — аспекты всех фаз, затем секунды до смены по фазам (-1 — удержание).
- LightDetail: phases — список {label, aspect, green, queue}; label — названия улиц подходов фазы.
- [ ] Тест signals.test.ts: план из 3 фаз (20, 15, 10) — цикл 63 с; в момент 0 фаза 0 GREEN, остальные RED; при t = 21 фаза 0 AMBER; при t = 24 фаза 1 RED_AMBER; HOLD 1 — фаза 1 GREEN, остальные RED, left Infinity.
- [ ] Реализовать; процедурный build выдаёт 2 фазы (С–Ю = 0, З–В = 1), rank бульвара 2, местной 1.
- [ ] Инспектор показывает карточку на фазу; кнопки «Держать фазу N» с подписями улиц.
- [ ] pnpm test, pnpm lint, коммит refactor(sim): signal phases instead of axes.

### Задача 2: полилинейные полосы и направления сегментов
**Файлы:** city/types.ts, city/build.ts, engine/traffic.ts, engine/routing.ts, apps/web city-geometry.ts и traffic-lights.tsx.
**Интерфейсы:**
- Lane получает line: Polyline; start и end остаются как концы line; dir и right удаляются.
- Segment.dir заменяется на dirIn (касательная в начале) и dirOut (касательная в конце); Segment.axis и Street.axis/coord — только во внутренних данных процедурного build, движок их не читает.
- lanePose(lane, s, lateral) берёт poseAt по line и сдвигает вправо от касательной.
- turnBetween(a, b) сравнивает a.dirOut и b.dirIn: S при угле до 35°, R/L по знаку cross, null для разворота.
- [ ] Тест geometry.test.ts: lanePose на L-образной полилинии — точка на изгибе и сдвиг lateral по нормали каждого участка.
- [ ] Тест routing: turnBetween для 30° — S, для 80° вправо — R, для 170° — null.
- [ ] Реализовать; все существующие тесты sim зелёные без правки порогов; рендер процедурного города не изменился (визуально — по скриншоту, если пользователь разрешит инструмент).
- [ ] Коммит refactor(sim): polyline lanes and segment tangents.

### Задача 3: импорт дорог OSM в файл района
**Файлы:** создать packages/sim/src/import/ (project.ts, osm-roads.ts, district.ts, translit.ts), packages/sim/scripts/import-district.mjs; экспорт подпутём @kolo/sim/import, не из корня пакета.
**Интерфейсы:**
- project(lat, lon) → Vec2 и обратная unproject.
- District: meta {id, name, anchor, bboxDeg, bounds, osmTimestamp, gtfsVersion, version}; roads {nodes, edges, restrictions}.
- Узел: id, x, z, флаги signals, give_way, stop, boundary; osm-id.
- Ребро: id, a, b, плоский массив точек (0,1 м), name (латиница: name:sr-Latn, иначе транслитерация кириллицы), cls, lanesFwd, lanesBwd, speed (м/с), layer, tunnel, bridge, roundabout, psvOnly, turnFwd, turnBwd, trolley, osm-id.
- Ограничение: from-ребро, via-узел, to-ребро, only (true для only_*).
- version — FNV-1a хэш содержимого в hex.
- Правила: проезжие highway от trunk до living_street и *_link; без service, pedestrian, footway, construction, proposed; access=no с bus/psv=yes — psvOnly; maxspeed числом, RS:urban 50, RS:living_street 10, иначе по классу; lanes, lanes:forward/backward, по умолчанию 1 на направление; путь режется в узлах, общих для двух проезжих путей; обрезка по рамке с узлом boundary; остаётся крупнейшая сильно связная компонента.
- [ ] Тесты import на крохотном синтетическом OSM: разрез пути на общем узле, обрезка рамкой, oneway и lanes, транслитерация «Трг Славија» → «Trg Slavija», RS:urban → 13,89 м/с.
- [ ] Тест на реальном файле (пропускается, если файла нет): более 500 рёбер, есть кольцо Trg Slavija из roundabout-рёбер, все точки в пределах bounds.
- [ ] CLI пишет data/districts/belgrade-center.json; размер и число рёбер — в консоль.
- [ ] Коммит feat(sim): offline OSM road import into a district file.

### Задача 4: сборка City из файла района
**Файлы:** создать packages/sim/src/city/district-build.ts (+ district-build.test.ts); экспорт buildCityFromDistrict(district) → City.
**Интерфейсы:** Consumes District (задача 3), Lane.line и Segment.dirIn/dirOut (задача 2), phase и rank (задача 1).
- Кластеризация: узлы-перекрёстки, соединённые рёбрами короче 18 м (не кольцевыми, одного layer), сливаются в один узел; внутренние рёбра удаляются.
- Сегмент на каждое направление ребра; полосы — смещённые полилинии (ширина 3,2 м, для residential и living_street 3,0 м), обрезанные отступом стоп-линии.
- Коннекторы — квадратичные Безье через пересечение касательных; повороты по turn:lanes, иначе L из внутренней, R из крайней, S из всех; запреты поворотов соблюдаются; конфликты — polylinesConflict с зазором 1,6 м.
- Узел boundary — источник и сток; psvOnly-сегменты помечены и исключены из маршрутов легковых.
- [ ] Тесты: нет NaN, каждая полоса длиннее 2 м; не менее 95% сегментов в крупнейшей сильно связной компоненте; у каждой не-тупиковой входящей полосы есть коннектор; ни один коннектор не длиннее 120 м; кольцо Славии — сегменты с rank выше въездов.
- [ ] Коммит feat(sim): build city road graph from a district.

### Задача 5: светофоры и приоритеты на реальном графе
**Файлы:** district-build.ts, traffic.ts (уступка по rank вместо оси).
- Узел регулируемый, если в кластере или на подходе ближе 25 м есть traffic_signals.
- Фазы: подходы сортируются по углу, встречные (разница больше 150°) делят фазу; зелёный 30 с, у фазы с главной дорогой 45 с; offset детерминированно от id узла.
- Нерегулируемые: подход с меньшим rank уступает приближающимся конфликтующим с большим rank; въезд на кольцо уступает кольцу.
- [ ] Тесты: регулируемых узлов от 100 до 220; у каждого не меньше 2 фаз и у каждого входящего сегмента есть фаза.
- [ ] Коммит feat(sim): signals and right of way on the real graph.

### Задача 6: прогон трафика на реальном городе
**Файлы:** создать packages/sim/src/engine/roaming.ts (фоновые машины: появление на boundary-входах и случайных полосах, маршрут к случайному стоку или полосе), roaming.test.ts.
- [ ] Тест: 300 машин, 10 минут при шаге 0,05 с — наложения меньше 0,2%, средняя скорость больше 10 км/ч, congestion меньше 0,5, ни одна машина вне очереди у стока не стоит дольше 120 с; средний шаг меньше 15 мс.
- [ ] Отладка дедлоков по фокусу ревью до зелёного теста.
- [ ] Обновить ROADMAP (этап 1 и часть этапа 2), SIMULATION и ARCHITECTURE; коммит feat(sim): traffic runs on real Belgrade roads.
