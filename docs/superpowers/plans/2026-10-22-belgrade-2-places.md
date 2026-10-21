# Белград, план 2: здания, места, депо и приложение на файле района

> Для агента: исполнять по задачам (superpowers:executing-plans или subagent-driven-development), чекбоксы отмечать по ходу.

**Цель:** сервер и клиент работают на реальном Белграде из файла района: здания, зелень, вода, адреса, POI и депо партнёров в ядре сети; процедурный город удалён.
**Архитектура:** импорт дописывает в файл района полигоны, точки адресов и POI, площадки депо; packages/sim привязывает их к полосам ядра и раскладывает двор депо; api читает файл с диска, web — статическим ассетом с хэшем; рендер строит полилинии дорог и полигоны.
**Стек:** TypeScript, vitest, three (ShapeUtils, ExtrudeGeometry — уже в зависимостях web), Prisma 8 RC; без новых пакетов.
**Спек:** docs/superpowers/specs/2026-10-21-belgrade-design.md; план 1 — docs/superpowers/plans/2026-10-21-belgrade-1-roads.md.

## Глобальные ограничения
- Ничего не скачивать и не устанавливать без явного разрешения пользователя; сырьё — data/raw/osm/district.json (снимок 21.10.2026).
- Координаты: x — восток, z — юг, метры, опорная точка Славии; рамка BELGRADE_BBOX без изменений; точность 0,1 м.
- Строки UI на русском, названия улиц и мест латиницей (name:sr-Latn, иначе toLatin).
- На карте атрибуция «© OpenStreetMap contributors».
- Решения пользователя: депо P1 Avala Fleet — OSM way 527970079 (Hercegovačka), P2 Sava Motors — 393230621 (parking «Slavija 1»; двор на Sarajevskoj закрыт домами), P3 Dunav Taxi — 1191458362 (Dobračina); резерв — 394469286, 741151667. Флот 60 такси (24/18/18), фоновых машин до 300.
- Автобусов до плана 3 нет: busStops и busLines пустые, всё, что их читает, должно это пережить.
- pnpm test, pnpm build и pnpm lint (web) зелёные после каждой задачи; коммиты conventional; после задачи — чекбоксы ROADMAP.

## Фокус ревью
- Пустые busStops: pickOrigin, hotspots, поиск, диалог заказа и инспекторы не падают (rng.pick пустого массива).
- Адрес на односторонней улице и на улице без ядра: точка подачи на ближайшей подходящей полосе ядра, а не на выезде из рамки или psv-only.
- Мультиполигоны с дырами и реки через рамку (Sava): кольца собраны из нескольких путей и обрезаны, без самопересечений и NaN.
- Старая БД: заказы процедурного города удалены, P1–P3 получили новые адрес, координаты и вместимость, флот дополнен до 60 без дублей номеров.
- Клиент со старым кэшем файла района: при расхождении версии с сервером — тост с перезагрузкой, а не тихая рассинхронизация.

### Задача 1: импорт зданий, площадей, деревьев, адресов, POI и площадок депо
**Файлы:** создать packages/sim/src/import/polygons.ts (сборка колец мультиполигона, обрезка Сазерленда — Ходжмена по рамке, Дуглас — Пекер, площадь, point-in-polygon), import/osm-places.ts (+ osm-places.test.ts); изменить city/district.ts, import/district.ts, scripts/import-district.mjs.
**Интерфейсы:** District получает buildings, areas, trees, addresses, pois, depotSites.
- DistrictBuilding: id (w123 или r123), pts — плоское внешнее кольцо, holes, h (м), levels, use (residential, house, office, retail, civic, religious, industrial, other), name, addr {street, number}.
- Высота: height числом; иначе building:levels × 3,2; иначе этажность по building: apartments и residential 5, house и detached 2, office 6, retail и commercial 2, hospital, school, university 4, kiosk 1, church и cathedral — 18 м, прочее 4. Пропускать roof, bridge, wall, construction и building:part. Здание с центроидом вне рамки отбрасывается целиком, не режется.
- DistrictArea: kind (water, park, grass, forest, plaza, pitch, parking, playground), rings (первое — внешнее). Источники: natural=water и waterway=riverbank — water; leisure park, garden — park; landuse grass, flowerbed, recreation_ground, natural grassland и scrub — grass; landuse forest и natural wood — forest; area:highway pedestrian и footway, place=square — plaza; leisure pitch — pitch; amenity=parking с parking=surface — parking; leisure playground — playground. Площади обрезаются рамкой.
- Упрощение: здания 0,3 м, площади 1 м; отбрасывать здания меньше 4 м², площади меньше 20 м².
- trees: плоский массив x, z — узлы natural=tree плюс natural=tree_row с шагом 9 м.
- DistrictAddress: id (n… или w…), street (латиница), number строкой, x, z, building (id здания, если точка внутри контура или адрес на самом здании); дубль по улице и номеру — оставить адрес здания.
- DistrictPoi: id, name, kind (mall, hospital, station, market, university, hotel, park), weight (mall 3, station 3, market 2, hospital 2, park 2 при площади больше 3 га иначе 1, university 1, hotel 1), x, z, building. Для площадных POI точка — вершина контура, ближайшая к проезжему ребру района. Парки без имени не POI.
- DistrictDepotSite: id, name, osm, pts — контур площадки по списку из ограничений.
- [ ] Тесты на синтетике: мультиполигон из двух внешних путей и дыры собирается в кольцо с дырой; квадрат 100×100, наполовину за рамкой, после обрезки — 5000 м²; building:levels 6 → 19,2 м; height «21 m» → 21; apartments без этажности → 16 м; здание с центроидом вне рамки отброшено; «Кнеза Михаила» → «Kneza Mihaila»; дубль адреса схлопнут.
- [ ] Тест на реальном файле (пропуск, если сырья нет): зданий больше 5500, с levels не меньше 80%; есть water площадью больше 50 000 м²; адресов больше 4000; среди POI Kalemegdan, Kalenić pijaca, Univerzitetski klinički centar Srbije; три площадки депо; файл района меньше 4 МБ.
- [ ] Перегенерировать data/districts/belgrade-center.json; CLI печатает число зданий, площадей, адресов и POI; коммит feat(sim): import buildings, areas, addresses and POIs.

### Задача 2: места на реальном городе и удаление процедурного генератора
**Файлы:** создать packages/sim/src/city/places.ts (+ places.test.ts) и city/depots.ts (+ depots.test.ts); изменить city/types.ts, district-build.ts, index.ts, engine/simulation.ts, engine/traffic.ts; удалить city/build.ts, layout.ts, build.test.ts; lanePoint переезжает в city/lanes.ts.
**Интерфейсы:**
- Building: outline и holes (Vec2[]), x, z (центроид), h, levels, kind (use из файла плюс garage и depot-office), tint, addressId, name; Area {kind, outer, holes}; City получает areas и roads (полоса асфальта: base-точки ребра и ширина); Playground получает rot.
- Удаляются Block, City.blocks, lawns, seed, Street.axis, coord, median, Segment.axis, CityNode.col, row, vStreet, hStreet; halfX и halfZ сливаются в CityNode.radius. Address.number — строка.
- bindAddress: кандидаты — бордюрная полоса core-сегментов без psvOnly и колец, длиной не меньше 24 м; порядок: та же улица и точка справа по ходу в пределах 70 м; та же улица в 70 м; любая улица в 35 м; иначе адрес отброшен. s зажат в [8, length − 8]; вход — точка бордюра со сдвигом 2,2 м к дому; label «улица номер»; id — A плюс id из файла.
- POI: адрес здания или синтетический адрес у ближайшего бордюра в 150 м; label «имя, адрес». Деревья: из файла плюс сетка 11 м с дрожанием в park и forest (вне зданий, воды, плазы и дорог), всего не больше 12 000. Детские площадки — из площадей playground по OBB. Припаркованные машины — перенос buildParkedCars на residential, living_street и unclassified ядра, мимо входов, ворот депо и зданий.
- layoutDepot: OBB контура (длинная ось u); ворота — середина стороны OBB, ближайшей к бордюрной полосе ядра; гараж с боксами (P1 4, P2 3, P3 2) — полоса 16 м у торца, дальнего от ворот; офис 13×11 м у ворот; места 2,6×5 м двойными рядами вдоль u с проездом 6,5 м, место остаётся, если целиком внутри контура и не задевает гараж и офис; Depot.lot, garage — полигоны.
- [ ] Тесты places: привязано не меньше 4000 адресов, все на core-полосах, s в допуске, вход в 6 м от бордюра; у 85% и больше улица адреса совпадает с улицей полосы; нет NaN; POI больше 100.
- [ ] Тесты depots: мест у P1 не меньше 24, у P2 и P3 не меньше 18; ворота в 25 м от бордюра; каждое место внутри контура и вне зданий OSM.
- [ ] Коммит feat(sim): addresses, POIs and partner depots on the real city.

### Задача 3: симуляция на файле района
**Файлы:** engine/simulation.ts, simulation.test.ts, roaming.ts.
- Фоновые машины — через Roaming (въезд и выезд по рамке); MAX_CARS 300, плотность по умолчанию 0,6; adjustCars и randomSegment удаляются.
- pickOrigin: доля остановок уходит в POI, если busStops пуст; hotspots — POI с весом не меньше 2 плюс остановки.
- [ ] simulation.test.ts на реальном файле: 10 минут с fleet(60) — наложений меньше 0,2%, средняя скорость больше 8 км/ч, congestion меньше 0,5, выполнено больше 5 заказов, в кадре больше 200 машин; цена по дорожному расстоянию и прогресс поездки; цикл «в сервис и обратно».
- [ ] Коммит feat(sim): simulation runs on the Belgrade district.

### Задача 4: api на файле района и миграция БД
**Файлы:** создать apps/api/src/simulation/district.ts; изменить simulation.service.ts, simulation.controller.ts, live.gateway.ts, seed.service.ts, contract.prisma, packages/contracts live.ts и api.ts; новая миграция в apps/api/migrations (сначала прочитать скил prisma-8).
- resolveDistrictFile: env DISTRICT_FILE, иначе поиск data/districts/belgrade-center.json вверх от cwd; город строится один раз при старте.
- SocketEvent.HELLO при подключении: {districtId, version}; /api/sim/state отдаёт districtVersion вместо citySeed.
- Park получает x и z (Float, nullable); миграция belgrade_parks: колонки и шаг rawSql, удаляющий заказы (события и возражения — каскадом).
- SeedService: PARTNERS 24/18/18; пустая БД заполняется, непустая дополняется до цели (новые id после максимального, номера уникальны); syncParks обновляет address, x, z, capacity, serviceBoxes.
- [ ] e2e: /api/fleet/parks — три парка с x, z и вместимостью не меньше машин парка; unit на resolveDistrictFile.
- [ ] Ручная проверка: старт на старой БД — в логе удалённые заказы, 60 такси; коммит feat(api): serve the Belgrade district and reset procedural data.

### Задача 5: web грузит файл района
**Файлы:** создать apps/web/scripts/sync-districts.mjs; изменить apps/web/package.json (predev, prebuild), .gitignore (public/districts), lib/city.ts, lib/live.ts, live-console.tsx, command-search.tsx, create-order-dialog.tsx, inspector-places.tsx.
- Скрипт копирует data/districts/*.json в public/districts/<id>.<version>.json и пишет manifest.json {id → файл, версия}.
- loadCity: manifest без кэша, файл с force-cache, buildCityFromDistrict, кэш на вкладку; getCity — синхронно после загрузки. LiveConsole показывает «Строим Белград…», пока город не готов (use и Suspense).
- HELLO с другой версией — тост «Карта обновилась на сервере» с кнопкой «Перезагрузить».
- Поиск и диалог заказа на 4000+ адресах: фильтрация с лимитом 50 строк; пустые остановки — без группы.
- [ ] pnpm lint и pnpm build; коммит feat(web): load the district file as a hashed static asset.

### Задача 6: рендер земли, дорог, площадей и депо
**Файлы:** scene/city-geometry.ts, city-static.tsx, traffic-lights.tsx, overlays.tsx, camera-rig.tsx, vehicles.tsx, lib/palette.ts; DESIGN.md.
- Земля — плоскость цвета тротуара по рамке плюс 300 м; площади — триангуляция ShapeUtils с дырами, цвет по kind (вода, парк, газон, лес, плаза, спортплощадка, парковка); асфальт — ленты по city.roads и выпуклые оболочки концов полос у узлов.
- Разметка вдоль полилиний: осевая пунктиром у двусторонних, межполосная у многополосных, стоп-линии на нерегулируемых подходах, зебры поперёк dirIn на radius + 2 м. Светофоры и стоп-бары — от концов полос подхода.
- Депо: полигон площадки, контур, места по heading, ворота, пик-поверхность; детские площадки с поворотом rot. Камера: «домой» — центр рамки, панорама в рамке плюс 200 м.
- Атрибуция «© OpenStreetMap contributors» мелкой подписью в углу карты.
- [ ] Скриншоты (playwright-core): Славия, Теразије, Калемегдан, депо P1; коммит feat(web): render real roads, areas and depots.

### Задача 7: рендер зданий и финал документации
**Файлы:** city-geometry.ts, city-static.tsx, scene-labels.tsx, inspector-places.tsx, overlays.tsx; docs SIMULATION, ARCHITECTURE, DESIGN, DOMAIN, ROADMAP.
- Здания — ExtrudeGeometry с дырами, слитые в один меш; атрибуты: градиент цвета по tint и floorH = h / levels; шейдер окон берёт координату вдоль грани от нормали и этаж из floorH, первый этаж глухой.
- Выбор и наведение по индексу треугольника → здание; выделение — контур выбранного здания. Подписи POI — из city.pois с весом не меньше 2; инспектор здания — площадь по полигону, этажи из levels.
- [ ] Сборка геометрии меньше 1,5 с в браузере, число треугольников — в консоль dev; скриншоты тех же точек.
- [ ] Обновить доки и ROADMAP (этапы 1, 3 и депо этапа 5); коммит feat(web): extruded real buildings.
