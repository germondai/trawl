# Referenční katalog rozhraní a chování TRAWLu

Verze katalogu 1.1 · stav zdrojů k 20. listopadu 2026

Tento katalog zachovává konkrétní rozvržení, gesta, indikátory, detaily ovládání a principy, které vznikly při vývoji TRAWLu. Je součástí [plánu produkční aplikace](production-app-blueprint.md). Hlavní plán vysvětluje architekturu a postup tvorby šablony; zde jsou recepty, podle kterých lze naše řešení znovu postavit.

**Při tvorbě další aplikace projdi všechny recepty a každý vědomě převezmi, přizpůsob nebo označ jako nepoužitý.** Výchozí chování se při zjednodušování frameworku nesmí nepozorovaně ztratit. U převzatého receptu zachovej i jeho chybové a přerušovací scénáře.

Každý recept popisuje spouštěč, průběh, důvod a kontrolu. Uvedená čísla jsou aktuální kalibrace TRAWLu v CSS px nebo milisekundách, pokud není uvedeno jinak; nejsou univerzální normou. Existující implementace a testy jsou konkrétní reference. Implementováno neznamená ověřeno na všech OS a fyzických zařízeních. iOS, další TV platformy a budoucí adaptery přebírají specifikaci záměru, nikoli automaticky hotovou podporu.

Obsah: [Rozvržení a bary](#rozvržení-a-bary) · [Historie a vrstvy](#historie-a-vrstvy) · [Gesta](#gesta) · [Text a hledání](#text-hledání-a-tooltipy) · [Zkratky](#zkratky-a-quit) · [macOS](#macos-a-desktopový-lifecycle) · [Android a notifikace](#android-telefon-a-tv) · [Rozsah a původ nastavení](#rozsah-původ-a-aplikace-nastavení) · [Opakované UI vzory](#opakované-ui-vzory) · [Vzhled a animace](#konkrétní-vizuální-základ) · [Build a přenos](#build-vydání-a-přenos-do-šablony) · [Plán lokalizace](production-app-localization-plan.md).

## Rozvržení a bary

### L01 Oddělení rozvržení zařízení a schopností

**Chování:** široké okno používá desktopový shell. Pod 1024 px používá TRAWL kompaktní phone layout, a to i v úzkém desktopovém okně. Android TV je výjimka: zůstává v desktopovém rozvržení bez ohledu na tuto šířku. Nativní Activity zjišťuje televizní režim a předává jej do WebView značkou `TRAWL-TV`.

Rozvržení neříká, které operace umí vybraný runtime. Telefon připojený k desktopovému serveru může zobrazovat jeho funkce; Android lokální instance nabízí jen vlastní podporované nastavení. Dostupnost se nesmí odhadovat z breakpointu.

**Proč:** stejné UI funguje při resize a na více zařízeních, aniž by zaměnilo úzké okno za jiný backend.

**Kontrola:** desktop 1280 px → kompaktní 390 px → zpět; zachovaný kontext a draft. Android TV nesmí přepnout na phone bar. Lokální Android katalog a vzdálený katalog mají vlastní dostupné kategorie.

Reference: [useAppLayout](../../apps/desktop/app/composables/useAppLayout.ts), [MainActivity](../../apps/desktop/src-tauri/gen/android/app/src/main/java/com/germondai/trawl/desktop/MainActivity.kt), [ServerSettings](../../apps/desktop/app/components/ServerSettings.vue), [RemoteSettings](../../apps/desktop/app/components/RemoteSettings.vue).

### L02 Desktopový shell a pracovní panel

```text
┌──────────────────┬───────────────────────────────────────────────────┐
│ značka           │ systémové controls  Back Forward  titulek   akce  │
│ search commands  ├───────────────────────────────────────────────────┤
│                  │                                                   │
│ skupiny stránek  │                 obsah se scrollem                 │
│                  │                                                   │
│                  ├───────────────────────────────────────────────────┤
│ preference       │ případná ukládací lišta                           │
│ vybraná instance │                         plovoucí úlohy a New       │
└──────────────────┴───────────────────────────────────────────────────┘
```

Vnější shell je klidná plocha; hlavní pracovní panel má vlastní border, radius a scroll. Aktuální vnější inset je 8 px nahoře, vpravo a dole. Sidebar má vlastní geometrii; při úplném skrytí se přidá i levý 8px inset pracovní plochy. Panel má 1px border a 8px radius.

Header je pevný uvnitř panelu, obsah pod něj zajíždí a scrollbar začíná pod ním. Tři sloupce headeru drží titulek ve středu panelu, nikoli jen v prostoru zbylém mezi různě širokými tlačítky. Dlouhý titulek se truncuje. Hlavní scroll není scroll celého dokumentu.

**Kontrola:** stejná poloha titulku při spuštěném i zastaveném runtime, sbaleném i skrytém sidebaru a dlouhém názvu stránky. Žádný horizontální scroll celého shellu.

Reference: [app.vue](../../apps/desktop/app/app.vue), [main.css](../../apps/desktop/app/assets/css/main.css), [ShellHeader](../../apps/desktop/app/components/ShellHeader.vue).

### L03 Sidebar se stabilní hierarchií

Značka je vycentrovaná v celé své header oblasti, včetně horního odsazení shellu. Má přístupný návrat na Overview, ale nezískává zbytečné hover pozadí. Dělicí hrana odpovídá headeru hlavního panelu. Při kolapsu zůstane logo uvnitř railu a text zmizí bez posunu mimo něj.

Pod značkou je oddělený Search commands. Hlavní navigace je seskupená podle práce: Workspace, Create request a Runtime. Manage/preference a selector instance tvoří spodní skupinu. Navigace je vertikálně vyvážená mezi horním a spodním blokem; v nízkém okně nesmí footer vytlačit mimo dosažitelnou oblast.

Aktuální výchozí šířka sidebaru je 15 rem, měnitelná v rozsahu 14–20 rem; rail má 4 rem. V oknech nižších než 700 px používá kompaktnější 32px řádky. Tyto rozměry jsou recept konkrétní hustoty, ne limit budoucí značky.

**Kontrola:** vysoké i nízké okno, změna šířky, dlouhé popisky, poslední položka a selector stále dostupné. V railu poskytují ikony tooltipy s popisky a platnými keycaps.

Reference: [ShellSidebar](../../apps/desktop/app/components/ShellSidebar.vue), [main.css](../../apps/desktop/app/assets/css/main.css).

### L04 Dvoustavové sbalení nebo úplné skrytí

Uživatel vybere preferenci: expanded ↔ icons, nebo expanded ↔ hidden. Jedno tlačítko necyklí třemi překvapivými stavy. Header ukazuje odpovídající ikonu a název Toggle sidebar/Show sidebar. Zkratka funguje i při psaní do inputu. Úplně skrytý sidebar nezabírá šířku, focus ani pointer události.

Na phone layoutu sidebar vůbec netvoří hlavní navigaci; stejný úmysl dostat se k cílům zprostředkuje Search commands a spodní bar. Přechod breakpointu zavře zbylou desktopovou nabídku.

**Kontrola:** obě preference, několik opakování toggle, focus v inputu, žádný neviditelný tab stop a správný levý inset obsahu.

Reference: [app.vue](../../apps/desktop/app/app.vue), [ConnectionSettings](../../apps/desktop/app/components/ConnectionSettings.vue), [ShellHeader](../../apps/desktop/app/components/ShellHeader.vue).

### L05 Mobilní spodní navigace se zvýšenou akcí

```text
┌─────────────────────────────────────────────┐
│ search             titulek           options│
│                                             │
│                  obsah                      │
│                                             │
│ případná ukládací lišta                      │
├─────────────────────◯───────────────────────┤
│ Overview Requests   +   Tools   Settings     │
│          bezpečný systémový spodní okraj    │
└─────────────────────────────────────────────┘
```

TRAWL má pět sloupců: Overview, Requests, New request, Tools a Settings. Centrální akce má kruh 64 × 64 px, ikonu 32 px, zvednutí o 12 px a oddělovací obrys vůči bar pozadí. Ostatní položky mají ikonu nad popiskem, minimální výšku 52 px a ikonu 22 px. Aktivní cíl nebo skupina je zvýrazněná akcentem.

Tools a Settings otevírají krátký bottom drawer. Vybrání položky zavře nabídku před navigací. Zavřená nabídka se nesmí vrátit přes Forward. Tools obsahuje Sessions, Browser, Resources a Logs; Settings obsahuje App settings a Server settings. Zobrazení stránky se schopnostmi konkrétní instance zůstává oddělené od nabídky.

Bar používá jemnou průsvitnou plochu přibližně s 80 % základního pozadí a 2px blur, ne silné rozmazání obsahu. Pozadí tvoří oddělená pseudo vrstva bez pointer interakce, aby nezasahovala tlačítka. Safe-area padding má jednoho vlastníka.

**Kontrola:** horní hrana CTA a jeho obrys, čitelné popisky, bez vodorovného overflow, změna aktivní skupiny a Back nad otevřeným menu.

Reference: [MobileNavigation](../../apps/desktop/app/components/MobileNavigation.vue), [main.css](../../apps/desktop/app/assets/css/main.css).

### L06 Desktopový a mobilní horní bar

Na desktopu jsou Back/Forward, toggle sidebaru, název stránky, refresh a lifecycle akce. macOS má rezervu pro skutečná systémová tlačítka. V úzkém pracovním panelu se Back/Forward mohou skrýt, ale příkazy a historie zůstávají dostupné jinou cestou.

Phone header má výšku 56 px. Vlevo je Search commands, uprostřed titulek bez doplňkové ikony, vpravo More actions. Tlačítka mají 40 × 40 px a mobilní header používá stejný jemný blur jako spodní bar. Refresh tlačítko je nahrazené pull gestem; příkaz refresh je nadále dostupný přes palette/zkratku.

Start je v mobilním menu označen primary barvou a Play ikonou, Stop error barvou a čtvercem; Restart je samostatná akce. Skutečně probíhající lifecycle operace může options uvést do busy stavu. Běžný datový refresh ho nesmí rozblikat nebo nahradit spinnerem.

**Kontrola:** titulky a jejich truncation, chování krátkého okna, rozdíl refresh versus start/stop busy a dostupnost příkazů bez dotykového gesta.

Reference: [ShellHeader](../../apps/desktop/app/components/ShellHeader.vue), [app.vue](../../apps/desktop/app/app.vue), [main.css](../../apps/desktop/app/assets/css/main.css).

### L07 Ukládací lišta a plovoucí akce

Dirty stav nastavení přidá do společného `settings-save-slot` lištu s počtem změn, vysvětlením aplikace a akcemi uložit/zahodit. Lišta se neimplementuje nezávisle v každé stránce s jiným odhadem pozice. Výšku měří ResizeObserver.

Desktopové plovoucí akce se posouvají nad skutečně změřenou lištu a zachovávají mezeru. Na telefonu leží save slot nad navigací: aktuální základ je 65 px + safe-area. Obsah a lišta nesmějí započítat spodní rezervu dvakrát. Při save baru se odstraní nadbytečný spodní padding scrollu; samotná lišta nemá velkou prázdnou spodní výplň.

Download queue tvoří vlastní plovoucí blok nad akcí New request. Na telefonu centrální New patří spodní navigaci a doplňkové plovoucí stavy respektují její prostor. Stavy se přesouvají plynule, bez layout skoků a bez animací při reduced motion.

**Kontrola:** nulový/nenulový dirty stav, dlouhý hint, dvě řádky tlačítek, klávesnice, CTA a poslední řádek formuláře. Všechny akce zůstávají dosažitelné.

Reference: [app.vue](../../apps/desktop/app/app.vue), [ServerSettings](../../apps/desktop/app/components/ServerSettings.vue), [BrowserDownloadQueue](../../apps/desktop/app/components/BrowserDownloadQueue.vue), [main.css](../../apps/desktop/app/assets/css/main.css).

### L08 Obsah vyplňuje panel bez nafouknutého footeru

Zastavený lokální runtime na Overview/Requests používá vycentrovaný empty/setup stav s konkrétní akcí, která vyplní dostupnou výšku. Logs a Sessions mají vyplňující obsah a vlastní scroll. Volný prostor nese obsah/empty state, nikoli spodní vysvětlující footer.

Mobilní Logs footer má přirozenou výšku a padding 12 × 16 px. Latest se na telefonu ukáže jen tehdy, když uživatel přestal sledovat poslední položky; nezůstává po něm velká neviditelná výplň. Desktop může rezervovat místo pro stabilitu. Tlačítko se nezalamuje.

Filtry Logs tvoří na telefonu dva stejně široké sloupce; search přes celý řádek, lichý poslední control také přes celý řádek. Stejný princip platí pro kombinace lokálních a vzdálených filtrů. Každé dítě má správné `min-width: 0`, aby dlouhý text neroztáhl shell.

Reference: [ServerLogs](../../apps/desktop/app/components/ServerLogs.vue), [InstanceOverview](../../apps/desktop/app/components/InstanceOverview.vue), [main.css](../../apps/desktop/app/assets/css/main.css).

### L09 Responzivní formuláře přehledy a hlavičky karet

Desktopová dvojice popis/vstup se na malém prostoru skládá do čitelných řádků. Mobilní metriky mají label vlevo, hodnotu vpravo a hint nebo bar přes celou šířku. Přehled se nestává několika obrovskými dekorativními kartami.

Akce Add existing instance / Connect privately sdílí jeden header: na telefonu ikonové tlačítko úplně vpravo, bez druhého řádku; na desktopu může mít i popisek. Dlouhé URL a cesty se zalomí nebo truncují podle významu. Pole origin/reset nemá být vytlačené do dvou řádků dlouhou hodnotou.

Panelové heading/body mají na telefonu základní padding 16 px, content 16 px vertikálně a 12 px horizontálně. Mezery mezi search a přepínačem kategorií vznikají jednou, ne skládáním několika zbytečných marginů.

Reference: [ConnectionSettings](../../apps/desktop/app/components/ConnectionSettings.vue), [MetricBar](../../apps/desktop/app/components/MetricBar.vue), [ServerSettings](../../apps/desktop/app/components/ServerSettings.vue), [main.css](../../apps/desktop/app/assets/css/main.css).

### L10 Geometrie a animace akcí vpravo dole

Prvky, které uživatel vnímá jako fixed vpravo dole, jsou implementované jako `position: absolute` uvnitř hlavního panelu. Při scrollování obsahu zůstávají kotvené k panelu, při změně okna se drží jeho nové geometrie. Jeden společný `TransitionGroup` vlastní pořadí, vstup, odchod i přesun sousedních prvků.

| Situace | Skutečné chování TRAWLu |
| --- | --- |
| Pravý okraj desktopu | `16 px + změřená šířka scrollbar gutteru`, takže akce nezasahuje do thumbu. |
| Spodní okraj desktopu | `16 px + změřená výška settings-save-slot`; změna save baru posune celý blok. |
| Vnitřní rozvržení | Sloupec zarovnaný doprava s mezerou 12 px; queue leží nad New request. |
| New request | Je vidět mimo workbench pouze v desktopovém layoutu; vlastní kruh 44 × 44 px. |
| Download queue | Je vidět, když jsou pending joby a uživatel není na Browser stránce. |
| Vstup/odchod dítěte | Opacity 0 ↔ 1 za 180 ms; transform z/do `translateY(12px) scale(0.92)` za 220 ms, obojí ease. |
| Přesun zbývajícího dítěte | Vue TransitionGroup zachová klíč `downloads`/`request` a animuje změnu pozice. |
| Odcházející dítě | Dočasně absolutní vpravo dole, aby nezabíralo místo v novém rozvržení a soused mohl přejít na novou pozici. |
| Změna ukotvení bloku | `right` a `bottom` mají 200ms ease přechod. |
| Press na New request | Scale 0.94 a transform/background feedback 150 ms; neupravuje se samotná navigační logika. |
| Phone layout | New request je ve spodním baru; plovoucí queue respektuje `80px + safe-area-inset-bottom`. |
| Reduced motion | Přechody skupiny a její přesun se vypnou; logické objevení/zmizení a dostupnost akce zůstávají. |

Queue trigger má 44px kruh a číselný badge minimálně 18 px. Kliknutím otevře popover nahoru, zarovnaný doprava s 12px offsetem. Panel má šířku `min(380px, 100vw - 40px)` a seznam výšku nejvýše `min(60vh, 440px)`. Poslední dokončený/cancelled job zavře prázdný popover. Akce Browser installations nejprve zavře popover a pak navštíví stránku.

**Proč:** umístění netančí podle různých stránek, tlačítka se nesrazí se save barem nebo scrollbarem a změna počtu úloh má čitelnou kontinuitu. Při extrakci přenes celý tento kontrakt, ne jen samostatnou kruhovou ikonu.

**Kontrola:** queue se objeví nad existujícím New; queue zmizí; přejde se na Browser/workbench; save bar změní výšku; scrollbar vznikne/zmizí; stejné situace s reduced motion a phone navigací.

Reference: [floating-actions v app.vue](../../apps/desktop/app/app.vue), [BrowserDownloadQueue](../../apps/desktop/app/components/BrowserDownloadQueue.vue), [main.css](../../apps/desktop/app/assets/css/main.css).

## Historie a vrstvy

### N01 Sjednocené Back a Forward

Header, mouse buttons 3/4, podporované trackpad gesto a systémová/browser historie ovládají stejné kroky. Myš se obslouží jednou při mouseup; mousedown/auxclick nesmějí přidat další navigaci. Historie zahrnuje stránky, vybrané kategorie, request taby, inspector taby a dialogy.

Do kroku patří identifikátory, ne kopie dat. Aktuální limit je 128 kroků. Změna instance resetuje navigační kontext. Nová návštěva ze staršího kroku zahodí větev Forward. Smazaný tab nebo neexistující kategorie se odstraní/opraví také ve starších krocích.

**Kontrola:** tab → modal → další modal → Back po jedné vrstvě; Forward obnoví jen platné stavy. Zavřený request se nikdy nevzkřísí jako nový draft.

Reference: [useNavigationSteps](../../apps/desktop/app/composables/useNavigationSteps.ts), [navigation tests](../../apps/desktop/tests/navigation-steps.test.ts), [app.vue](../../apps/desktop/app/app.vue).

### N02 Přechodné nabídky mají pouze dismiss

Popover, dropdown a select se registrují jako nejvyšší přechodná vrstva. Back zavře nejprve tuto vrstvu, včetně nabídky otevřené uvnitř dialogu; stránka pod ní zůstane. Zavržené menu se přes Forward neotevře. Mobilní Tools/Settings používají stejný dismiss-only princip.

Portály sdílejí identifikaci otevřených popupů. Při animovaném zavírání vnořeného selectu se respektuje jeho dočasné vlastnictví Escape, aby jedna událost nesmetla i rodičovský dialog. Všechny watchery a registrační kroky se uklidí při zavření/unmountu.

Reference: [usePopupNavigation](../../apps/desktop/app/composables/usePopupNavigation.ts), [MobileNavigation](../../apps/desktop/app/components/MobileNavigation.vue), [navigation tests](../../apps/desktop/tests/navigation-steps.test.ts).

### N03 Neuložené změny zachovají zamýšlenou akci

Navigační guard nejdříve uloží zamýšlený cíl, pak otevře potvrzení. Keep editing ho zahodí a vrátí práci; Discard potvrdí původní přechod. Platí to i pro Forward, výběr v command palette, změnu instance nebo zavírání. Otevření potvrzení nesmí samo zničit budoucí cíl v historii.

TRAWL sleduje dirty nastavení, upravované connection a klávesové preference. Request drafty mají zvlášť potvrzení Reset/Close/replacement. Jejich in-memory životnost není slibem trvalého uchování přes zničení okna; další produkt musí persistence rozhodnout explicitně.

**Kontrola:** editace → Back/Forward → Keep editing; potom totéž s Discard. Změna dat zůstane přesná a provede se pouze jedna původní akce.

Reference: [app.vue](../../apps/desktop/app/app.vue), [ConnectionEditor](../../apps/desktop/app/components/ConnectionEditor.vue), [KeyboardSettings](../../apps/desktop/app/components/KeyboardSettings.vue), [navigation tests](../../apps/desktop/tests/navigation-steps.test.ts).

### N04 Jedna logika dialogu pro modal i drawer

`AppDialog` na desktopu renderuje modal, v phone layoutu bottom drawer. Sdílí open stav, title/body/footer, validaci a akce. Mobilní převod předává příslušné props a má vlastní obsluhu gest; nejde o druhou kopii formuláře.

Potvrzení explicitně označuje výchozí tlačítko. Focus se nastaví bez scroll skoku; šipky cyklí mezi dostupnými footer akcemi a Enter aktivuje zaměřenou akci. Konkrétní volba defaultu je produktové rozhodnutí a nesmí vzniknout jen pořadím DOM.

Reference: [AppDialog](../../apps/desktop/app/components/AppDialog.vue), [confirmationContent](../../apps/desktop/app/composables/useNavigationSteps.ts), [app.config](../../apps/desktop/app/app.config.ts).

### N05 Nabídky patří pracovnímu panelu

Menu, tooltipy, popovery a selecty v pracovním panelu sdílejí collision boundary panelu. Aktuální collision padding je 12 px a side offset 8 px. Obsah má dostupnou max-width/max-height a scroll, namísto přetečení mimo aplikační okno.

Selector instance používá stejný vnitřní gutter jako horní menu. Změna velikosti nebo fullscreen nesmí nechat překryv na starých souřadnicích. Tooltip ani indikátor nesmí zablokovat pointer akce pod sebou.

Reference: [app.vue](../../apps/desktop/app/app.vue), [ShellSidebar](../../apps/desktop/app/components/ShellSidebar.vue), [app.config](../../apps/desktop/app/app.config.ts).

## Gesta

### G01 Reverzibilní trackpad Back a Forward

**Spouštěč:** horizontální pixelový wheel v nativním desktopovém prostředí, mimo dialog a recorder zkratek. Phone layout ho nepoužívá. macOS navíc předává skutečné fáze pohybu prstů z `NSEvent`.

**Průběh:** podepsaný posun `x` se sčítá a omezuje na −118 až +118. Záporný posun znamená Back, kladný Forward. Prvních 28 px tvoří neutrální zónu. Dalších 90 px dává progress 0–1: `clamp((abs(x) - 28) / 90, 0, 1)`. Otočení směru progress snižuje; stav není založený na historickém maximu.

Navigace se potvrdí až při konci gesta a dosažení 118 px, pokud stále existuje cíl. Nedosažený práh a cancel nic nenavigují. Změna směru může gesto vrátit pod práh nebo přes neutrální zónu. Momentum po uvolnění nesmí přidat druhou navigaci.

**Proč:** uživatel ovládá náhled až do release a může si pohyb rozmyslet. Indikátor není jednosměrné načítání, které se už nedá vrátit.

Reference: [native-history-gesture](../../apps/desktop/app/utils/native-history-gesture.ts), [native-history-gesture tests](../../apps/desktop/tests/native-history-gesture.test.ts).

### G02 Zámek osy a ochrana vnořeného ovládání

Horizontální gesto se nezahájí při převládajícím vertikálním pohybu. Před převzetím musí horizontální složka převážit přibližně poměrem 1.5×. Jakmile gesto vlastní navigace, mírná vertikální příměs ho nepředá běžnému page scrollu. Capture listener předbíhá vnořený Lenis, používá nepasivní wheel a zastaví konkurenční zpracování pouze vlastněného gesta.

Gesto se nezahajuje nad input/textarea/select/contenteditable, iframe, sliderem, menu/listboxem, carouselem, explicitní výjimkou nebo horizontálně scrollovatelným předkem. Modifiery, ne-pixelové wheel režimy a již spotřebované události se nezaměňují za trackpad historii.

**Kontrola:** šikmé gesto nesmí přerušit řízení indikátoru. Horizontální scroll tabů/tabulky zůstane scrollováním. Obyčejné kolečko nesmí začít navigovat.

Reference: [native-history-gesture](../../apps/desktop/app/utils/native-history-gesture.ts), [useWorkspaceScroll](../../apps/desktop/app/composables/useWorkspaceScroll.ts), [tests](../../apps/desktop/tests/native-history-gesture.test.ts).

### G03 Skutečný release momentum a úklid

DOM wheel sám nerozlišuje prsty na trackpadu a následnou setrvačnost. macOS adapter proto posílá begin/end/cancel/momentum/momentum-end pro příslušné okno. Nativní monitor ponechává WebKitu běžné doručení wheel; o cílovém scroll povrchu rozhoduje renderer. Jiný desktop používá časový fallback s idle 180 ms, nikoli tvrzení o přesném fyzickém release.

Ošetři možné pořadí prvního DOM wheel před native begin. Po end se výsledek rozhodne jednou; momentum si ponechá předchozí vlastnictví scroll blokace, ale nevytvoří další navigaci. Blur/dispose resetují gesture, timer, observer, animaci i element indikátoru. Registrace nativního monitoru se odstraňuje.

**Kontrola:** finger release s momentum, cancel, dvě rychlá gesta po sobě, focus mimo okno a konec gesta bez navigačního cíle. Žádný visící indikátor.

Reference: [history_gesture.rs](../../apps/desktop/src-tauri/src/history_gesture.rs), [native-history-gesture](../../apps/desktop/app/utils/native-history-gesture.ts), [app.vue](../../apps/desktop/app/app.vue).

### G04 Boční indikátor navigačního gesta

Kruh 40 × 40 px s chevronem 24 px leží 12 px od příslušné hrany pracovního panelu a svisle uprostřed jeho výšky. Souřadnice vycházejí z aktuálního panelu/fullscreen, ne ze staré šířky celého monitoru. ResizeObserver přepočítává geometrii.

Opacity odpovídá progressu; scale běžně roste z 0.85 na 1. Forward otočí chevron a zachová optické vycentrování. Po skončení fade trvá 180 ms a pak element zmizí. Reduced motion vypíná škálování a zkracuje odstranění na okamžitý stav. Indikátor má `pointer-events: none` a je dekorativní vůči asistivnímu ovládání.

**Kontrola:** vratný pohyb opravdu zeslabuje indikátor, přepnutí strany je správné, kompaktní panel a fullscreen mají správné hrany, cancel uklidí všechny zdroje.

Reference: [native-history-gesture](../../apps/desktop/app/utils/native-history-gesture.ts), [main.css](../../apps/desktop/app/assets/css/main.css).

### G05 Mobilní pull to refresh vlastní celé gesto

**Spouštěč:** jeden dotyk začne v hlavním viewportu stránky na horním okraji; aplikace není lifecycle busy, neprobíhá jiný page refresh ani dialog. Uvnitř polí, editorů, sliderů a explicitní výjimky se nespouští. Posunutý vnořený scroller také zabrání převzetí.

Po 8 px rozpoznávacího pohybu musí gesto směřovat dolů s dostatečnou vertikální převahou. Pohyb vzhůru nebo do strany kandidáta zruší. Jakmile převzetí nastalo, distance je `min(120, max(0, dy × 0.45))`; refresh práh je 80 px tohoto indikátorového posunu. Při běžném tahu to odpovídá přibližně 178 px pohybu prstu. Vrácení pod práh před puštěním refresh zruší.

Uvolnění nad prahem spustí jeden refresh, touchcancel nikoli. Gesto, které začalo scrollováním z níže položeného obsahu, se po dosažení vrcholu v témže swipu nezmění na refresh. Změna stránky a unmount resetují rozpracovaný tah.

Reference: [usePullRefresh](../../apps/desktop/app/composables/usePullRefresh.ts), [pull-refresh utility](../../apps/desktop/app/utils/pull-refresh.ts), [pull-refresh tests](../../apps/desktop/tests/pull-refresh.test.ts).

### G06 Kreslený refresh indikátor a jeho přesná geometrie

```text
idle → kandidát tahu → tah pod prahem ⇄ připraveno k uvolnění
                         │                         │
                     release/cancel             release
                         ↓                         ↓
                       idle              refreshing → zatažení → idle
```

Kruh má solidní elevated background a border, rozměr 36 × 36 px a SVG 20 × 20 px. Dvě části refresh ikony mají normalizované `pathLength=1`; `stroke-dashoffset` postupně odkrývá linku. Podklad zůstává solidní a nemění se na rozkreslovaný obrys.

Průběh kreslení je `(min(1, distance / 80))^1.3`, při refreshing rovnou 1. Kruh je horizontálně vycentrovaný. Jeho základní top je 58 px při 56px phone headeru; dolů se posouvá o `min(distance, 80) / 2`. Zůstává tak celý pod hranou headeru. Tato varianta je aktuálně přijatá; starší varianta před experimentem se uchovává odděleně pro možnost návratu.

Při tažení se kresba mění přímo podle prstu. Po release se ikona plynule otáčí během skutečného refresh Promise a nejméně 500 ms, aby rychlý výsledek neblikl; dostupná data se zobrazí bez čekání na konec této prezentační lhůty. Zatažení používá opacity 180 ms a translate 240 ms. Reduced motion odstraní přechody i otáčení, stav zůstane čitelný přes `role=status` a popisek.

**Kontrola:** první malý tah kreslí jen malou část, header neodřízne kruh, návrat snižuje kresbu, spuštěný refresh nebliká v options, error i success indikátor uklidí.

Reference: [PullRefreshIndicator](../../apps/desktop/app/components/PullRefreshIndicator.vue), [usePullRefresh](../../apps/desktop/app/composables/usePullRefresh.ts), [main.css](../../apps/desktop/app/assets/css/main.css).

### G07 Jeden refresh napříč shellem a stránkou

Header, palette, zkratka a touch gesto vstupují do stejného page refresh koordinátoru. Souběžný požadavek vrátí existující Promise. Nejprve se obnoví potřebný společný stav, pak zaregistrované části stránky; registrace se při unmountu odpojí.

Refresh načítá data bez remountu stránky. Zachovává dosavadní obsah, filtry, settings draft, request taby a scroll; není to obnovení celého WebView ani nová návštěva stránky. Nikdy znovu neodesílá request body nebo jinou mutaci jen proto, že uživatel obnovil přehled.

Refetch revision dokončí čekání až po zpracování odpovídajícího snapshotu. Cleanup a zrušení starého watcheru nesmějí nechat nekonečně čekající spinner. Hromadné čtení sbírá chyby bez toho, aby ostatní úspěšné části zahodilo. Uživatelská chyba se objeví jako srozumitelný toast, další pokus zůstává možný.

Reference: [usePageRefresh](../../apps/desktop/app/composables/usePageRefresh.ts), [useRefreshRevision](../../apps/desktop/app/composables/useRefreshRevision.ts), [page-refresh tests](../../apps/desktop/tests/page-refresh.test.ts), [app.vue](../../apps/desktop/app/app.vue).

### G08 Drawer nejprve scroll a dalším swipem drag

Vlastník swipu se vybere podle počátečního směru a možnosti scrollovat. Začne-li pohyb scrollováním obsahu, toto vlastnictví zůstává do puštění i po dosažení horního/dolního okraje. Zbylá vzdálenost ze stejného swipu se nepředá draweru. Nový swipe zahájený na příslušném okraji může začít drag.

Kontrola pracuje i s vnořenými scroll kontejnery a zlomkovým `scrollTop`. Pixelové zaokrouhlení browseru nesmí vytvořit falešný zbytek pro drag. Inputy, selecty, editovatelný obsah, slider, handle a `data-vaul-no-drag` mají své zacházení. Existující výběr textu má přednost před přesouváním panelu.

**Kontrola:** dlouhý obsah, malý zbytek k hornímu okraji, tentýž swipe panel neposune; až nový swipe na vrcholu panel chytí.

Reference: [useDrawerGesture](../../apps/desktop/app/composables/useDrawerGesture.ts), [drawer-scroll tests](../../apps/desktop/tests/drawer-scroll.test.ts), [AppDialog](../../apps/desktop/app/components/AppDialog.vue).

### G09 Fyzika draweru a potlačení falešného click

Po převzetí se panel přesouvá podle prstu, opačný pohyb nejprve spotřebuje dosavadní přesun. Pohyb nahoru má omezený odpor; aktuální záporná vzdálenost nejde pod −12 px. Dismiss nastane po překročení `min(120 px, 25 % výšky panelu)` při nezrušeném release, jinak se panel vrátí.

Krátce po přesunu se potlačí následný pointerup/click, aby se po swipu neaktivovalo tlačítko, nad kterým prst skončil. Po scrolling swipu může obsah pokračovat setrvačností; reduced motion tuto dodatečnou animaci vypne. Touchcancel, zavření nebo unmount zastaví momentum a vrátí inline styly.

Maximální výška draweru je `100dvh - 16px`, horní rohy 16 px a šířka celého phone prostoru. Obsah má vlastní scroll a footer akce zůstávají dosažitelné.

Reference: [useDrawerGesture](../../apps/desktop/app/composables/useDrawerGesture.ts), [AppDialog](../../apps/desktop/app/components/AppDialog.vue), [main.css](../../apps/desktop/app/assets/css/main.css).

### G10 Dlouhý stisk a live přesouvání request tabů

Drag se vyzbrojí po 300 ms podržení hlavního pointeru. Pohyb přes 8 px před aktivací ho zruší, aby běžný swipe řádku tabů zůstal scrollem. Aktivní drag drží pointer capture, stabilní ID a místo uchopení uvnitř tabu.

Index se vybírá podle nejbližšího středu skutečně vykreslených tabů. Průběžná změna pořadí zachová dragging highlight a znovu přepočítá offset po renderu. Omezení dovoluje skutečný první i poslední slot. U hrany 24 px se vodorovný seznam automaticky posouvá po 8 px v animačním kroku, dokud to dává smysl.

Tažený tab má solidní background, vyšší vrstvu, grabbing cursor a žádnou konkurenční transform transition. Ostatní taby mohou animovat změnu pozice 180 ms. Po drag se potlačí click. Klávesnicová alternativa `Alt+ArrowLeft/Right` přesune zaměřený tab bez pointeru.

**Kontrola:** přesun prvního a posledního, scrollovaný tab strip, dlouhý label, pořadí po release, focus, pointercancel a žádný omylem aktivovaný close.

Reference: [useRequestTabDrag](../../apps/desktop/app/composables/useRequestTabDrag.ts), [RequestWorkbench](../../apps/desktop/app/components/RequestWorkbench.vue), [request-tab-drag tests](../../apps/desktop/tests/request-tab-drag.test.ts).

### G11 Přesouvání nativního okna ze skutečného pozadí

Primary mousedown může zahájit drag pouze v povolené prázdné části shellu/sidebaru. Ne na textu, tlačítku, inputu, odkazu, tab handle, slideru, resize oddělovači nebo scrollbar gutteru. Hit test pro text používá skutečné textové rects, ne předpoklad, že celý blok je prázdné pozadí.

macOS musí použít původní nativní mouse-down událost správného aktivního okna, korelovanou s DOM událostí přes monotónní čas. Zastaralá, již puštěná, aktivační nebo nejednoznačná událost se nepoužije k novému dragu. Nativní window document ID chrání před opožděným voláním ze zničeného WebView.

**Kontrola:** první click neaktivního okna, rychlé puštění, tažení prázdné plochy versus kopírování textu, nový WebView po tray a kraj scrollbarů.

Reference: [native-window-drag](../../apps/desktop/app/utils/native-window-drag.ts), [useNativeShell](../../apps/desktop/app/composables/useNativeShell.ts), [window_chrome](../../apps/desktop/src-tauri/src/window_chrome.rs), [desktop-polish tests](../../apps/desktop/tests/desktop-polish.test.ts).

### G12 Android Predictive Back

Při tahu ze systémové hrany se aktuální obsah odsunuje a odkrývá předchozí stránku. Dokud Android návrat nepotvrdí, historie se nemění. Zrušení vrátí stejnou stránku na místo a zachová rozepsaný požadavek i scroll. Na kořeni gesto přebírá systém.

TRAWL pro náhled drží v paměti nejvýše čtyři nedávné stránky. Zobrazuje neinteraktivní kopii hlavičky a obsahu. Přesun na stejnou stránku, otevřená vrstva, neuložené nastavení, omezený pohyb nebo nedostupný náhled použijí standardní navigaci. Nativní callback má přednost před historií WebView pouze tehdy, když v historii aplikace existuje krok Zpět. Na starším Androidu funguje potvrzené Zpět bez průběhu tahu.

Ověř tah zleva i zprava, náhled před potvrzením, zrušení, potvrzený návrat o jeden krok, klávesnici a návrat na domovskou obrazovku. Na Androidu 15 v emulátoru TRAWL ověřil náhled, zrušení, potvrzení a návrat na plochu. Viz [nativní callback](../../apps/desktop/src-tauri/gen/android/app/src/main/java/com/germondai/trawl/desktop/MainActivity.kt) a [napojení na historii](../../apps/desktop/app/composables/useAndroidPredictiveBack.ts).

## Text hledání a tooltipy

### T01 Psaní aktivuje hledání nebo hlavní vstup

Stránka označuje právě vhodné pole `data-type-focus`: search nebo v New request URL. Není to okamžitý autofocus po příchodu. První běžný znak při focusu na body/documentElement zaměří pole a současně ho vloží přes input událost; nevynechá první písmeno a neotevře mobilní klávesnici jen návštěvou stránky.

Ignorují se Ctrl/Meta/Alt kombinace, IME composition, whitespace-only klávesy, již spotřebovaná událost a aktivní výběr textu. Pole musí být viditelné, povolené a editovatelné. Dialog, menu a shortcut recorder brání přesměrování psaní. Obyčejný focus na tlačítku se svévolně nekrade.

Reference: [useTypeToFocus](../../apps/desktop/app/composables/useTypeToFocus.ts), [type-to-focus utility](../../apps/desktop/app/utils/type-to-focus.ts), [type-to-focus tests](../../apps/desktop/tests/type-to-focus.test.ts).

### T02 Workspace Find zvýrazňuje skutečné shody

Desktopový Cmd/Ctrl+F otevře hledání uvnitř workspace, nikoli druhý obecný browser toolbar. Enter/Shift+Enter a odpovídající ovládání posouvají aktivní shodu. Změna stránky Find zavře. DOM se kvůli značkám nepřepisuje: Range vymezuje shodu a overlay kreslí její přesné rects.

Značky se ořezávají podle hlavního viewportu i vnořených overflow oblastí. Při scrollu a resize se překreslí; skrytý text se neprohledává. Dotaz je escapovaný a omezení je 500 shod. Aktuální shoda má odlišný vizuální stav. Reveal posune jen potřebné předky; neničí horizontální a vertikální scroll ostatního obsahu.

**Kontrola:** vícerádková shoda, vnořená tabulka s horizontálním scrollem, resize, výměna dat a žádné shody mimo viditelné rects.

Reference: [PageFind](../../apps/desktop/app/components/PageFind.vue), [app.vue](../../apps/desktop/app/app.vue).

### T03 Command palette a cílené hledání nastavení

Palette obsahuje stránky, akce runtime, uložené instance a konkrétní položky nastavení. Klávesové popisky bere ze stejné konfigurace jako menu. Otevření zahájí nový query kontext; vybrání zavře palette a zavolá stejnou guardovanou akci jako sidebar.

Obyčejné šipky procházejí položky; Cmd/Ctrl+Up/Down přeskakuje mezi viditelnými skupinami. Pollování runtime nesmí resetovat aktivní příkaz, pokud se viditelný stav ve skutečnosti nezměnil. Výběr settingu vyčistí nepříslušný filtr, otevře kategorii, doscrolluje a dočasně označí konkrétní řádek. Opakovaný výběr používá novou revizi.

Reference: [ShellCommands](../../apps/desktop/app/components/ShellCommands.vue), [useSettingFocus](../../apps/desktop/app/composables/useSettingFocus.ts), [SettingLink](../../apps/desktop/app/components/SettingLink.vue).

### T04 Jeden tooltip systém včetně mobilních hintů

Desktop používá komponentové tooltipy pro hover a skutečný keyboard focus, nikoli zároveň nativní `title` popup. K názvu se mohou přidat keycaps. Sbalený sidebar je potřebuje, rozbalený label sám poskytuje kontext.

Touch long press se rozpozná po 500 ms, pohyb přes 10 px ho zruší. Hint po zobrazení vyprší za 2500 ms. Release po rozpoznaném long press nesmí spustit akci tlačítka; následující click se spotřebuje. Pointercancel/unmount zruší timery.

Globální lifecycle zavírá otevřené hinty při akci, klávesové navigaci, relevantním scrollu, změně stránky, blur, skrytém dokumentu a Android `trawl-background`. Touch a hover nejsou záminkou ke ztrátě přístupného názvu.

**Kontrola:** tap aktivuje, hold jen vysvětlí, hold+release neaktivuje, scroll nenechá tooltip na starém místě, po návratu z pozadí nic nevisí.

Reference: [AppTooltip](../../apps/desktop/app/components/AppTooltip.vue), [useTooltipLifecycle](../../apps/desktop/app/composables/useTooltipLifecycle.ts).

### T05 Selektivní kopírovatelnost

Chrome, navigace, tlačítka a taby nevyvolávají při swipu textové označení ani touch callout. Pole, response, kód, URL, chybové zprávy a užitečná data zůstávají označitelná. Akcent se používá také pro výběr textu.

Tap/click mimo aktuální textový výběr ho vyčistí, ale click dovnitř výběru nebo editoru ho neničí. Rozhodnutí se dělá podle skutečných výběrových rects. Drawer a refresh mají také explicitní ochranu aktivního uživatelského výběru; history gesta používají výjimky podle prvků a scroll oblastí uvedené v G02.

Reference: [app.vue](../../apps/desktop/app/app.vue), [main.css](../../apps/desktop/app/assets/css/main.css).

### T06 Smooth wheel bez dvojího řízení scrollu

Volitelný Lenis vzniká až pro nejbližší skutečný scrollovatelný kontejner v cestě události, včetně dialogů, menu, editorů a horizontálních tabulek. Jedna wheel událost patří jednomu wrapperu; na hraně se podle overscroll pravidel může najít předek. Ctrl-wheel a již spotřebované události se ignorují.

Touch má `syncTouch: false` a zůstává nativní. Reduced motion nebo vypnutá preference zničí smooth enginy a jejich listenery. RequestAnimationFrame běží jen pro aktivní pohyb; background ho zastaví. Odstraněné DOM kontejnery nezanechávají enginy v mapě. Návrat na vrch stránky respektuje preferenci a vybraný smooth/instant přechod.

Reference: [useWorkspaceScroll](../../apps/desktop/app/composables/useWorkspaceScroll.ts), [ConnectionSettings](../../apps/desktop/app/components/ConnectionSettings.vue).

### T07 Scrollbar jako součást stejného rozhraní

Scrollbary mají společný vzhled v hlavním panelu, dialogu, palette, seznamu a editoru. Aktuální gutter má 10 px; thumb inset se při přiblížení myši mění ze 3 na 1 px uvnitř stejného gutteru, takže layout neskáče. Tvar a průsvitnost mají krátký 160ms přechod.

Systémová overlay preference se zjišťuje měřením nativního probe elementu, nikoli odhadem „uživatel má trackpad“. V overlay režimu se thumb po 1200 ms neaktivity schová a znovu ukáže při scrollu nebo přiblížení k hraně; při hover je výraznější. Reduced motion a forced colors mají fallback. Nepodporovaný WebKit scrollbar selector má jednodušší standardní variantu.

Reference: [useCustomScrollbars](../../apps/desktop/app/composables/useCustomScrollbars.ts), [main.css](../../apps/desktop/app/assets/css/main.css).

## Zkratky a Quit

### K01 Konkrétní výchozí mapování

`CmdOrCtrl` se zobrazuje podle platformy. Toto je mapování TRAWLu, které další aplikace může přizpůsobit významu svých stránek.

| Kontext aplikace | Výchozí kombinace |
| --- | --- |
| Overview / Requests / Sessions | Cmd/Ctrl+1 / 2 / 3 |
| Browser / Resources / Logs | Cmd/Ctrl+4 / 5 / 6 |
| Nový request | Cmd/Ctrl+N |
| App settings / Server settings | Cmd/Ctrl+, / Cmd/Ctrl+. |
| Start/Stop / Restart | Cmd/Ctrl+S / Cmd/Ctrl+Shift+R |
| Refresh / Sidebar / Command palette | Cmd/Ctrl+R / B / K |
| Zavřít okno / Quit | Cmd/Ctrl+W / Q |
| Find uvnitř workspace | Cmd/Ctrl+F |
| Předchozí/další hlavní stránka | Ctrl+Shift+Tab / Ctrl+Tab |
| Přesun zaměřeného request tabu | Alt+Left / Alt+Right |
| Tray Open / Start-Stop / Restart | Cmd/Ctrl+O / S / R, pouze v tray kontextu |
| Tray vybrat instanci 1–9 | Cmd/Ctrl+1 až 9, pouze v tray submenu |

Textové Undo/Redo, copy/paste/select-all, běžné systémové kombinace a lokální chování editorů se zachovávají. Stejná kombinace může mít odlišný význam v odděleném tray a app rozsahu; společné Quit/settings akce se validují v obou.

Reference: [keybindings.json](../../packages/config/src/keybindings.json), [validace bindingů](../../packages/config/src/keybindings.ts), [app.vue](../../apps/desktop/app/app.vue), [tray](../../apps/desktop/src-tauri/src/tray.rs).

### K02 Recorder migrace a keycaps

Kliknutí na binding zahájí recorder; během něj jsou nativní akce pozastavené. Zachycení Quit kombinace tedy nesmí aplikaci ukončit. Escape recording zruší. Clear binding deaktivuje. Restore defaults nejprve připraví draft, který uživatel uvidí a uloží; nezapíše se bez kontroly.

Konflikt nebo rezervovaná systémová/editovací kombinace je srozumitelná validační chyba. Nový default nezabere kombinaci, kterou už má uživatel přiřazenou jiné akci. Konkrétní migrace starého sidebar defaultu Cmd/Ctrl+S na B zachovává vlastní mapování a explicitní vypnutí.

Keycaps, tooltipy, command palette, tray i nativní menu používají stejný stav. Pole recorderu se přizpůsobí šířce keycaps; layout nerozbije delší kombinace. Chyba uložení zachová draft.

Reference: [KeyboardSettings](../../apps/desktop/app/components/KeyboardSettings.vue), [keybindings.ts](../../packages/config/src/keybindings.ts), [native keybindings](../../apps/desktop/src-tauri/src/keybindings.rs), [keybindings tests](../../packages/config/tests/keybindings.test.ts).

### K03 macOS Quit s volbou instant double press nebo hold

macOS adapter umí okamžité ukončení, druhý stisk do 750 ms nebo podržení alespoň 1 s. Hold se potvrzuje podle skutečného release, ne pouhého dosažení animace. Po úspěšném release existuje 250ms odložené dokončení s generačním ticketem, aby se dalo správně zrušit a neprovedl se starý callback.

Tato preference mění klávesnicové Quit gesto. Explicitní Quit v menu zůstává přímou akcí se stejnou ochranou neuloženého nastavení; uživatel kvůli kliknutí na menu nemusí nic držet ani opakovat.

Spodní plovoucí indikátor ukazuje skutečně nakonfigurované keycaps. Hold progress je 3px akcentová linka s 1s průběhem; double press má vlastní zprávu a časové okno. Obrázek pevně napsaného Cmd+Q by byl chybný, pokud si uživatel zkratku přemapuje.

Tento rozšířený režim je implementace macOS, ne slib pro ostatní OS. Pro jinou platformu musí vzniknout odpovídající nativní obsluha, nebo se zachová standardní Quit. Preference dlouhého stisku je produktová volba.

Reference: [shortcuts.rs](../../apps/desktop/src-tauri/src/shortcuts.rs), [keybindings.rs](../../apps/desktop/src-tauri/src/keybindings.rs), [app.vue](../../apps/desktop/app/app.vue), [main.css](../../apps/desktop/app/assets/css/main.css).

### K04 Escape skutečně zruší celý Quit chord

Escape má při aktivním Quit gestu přednost před recorderem, Find nebo vnořeným overlayem. Po zrušení nezůstává „cancelled“ hint. Další keyDown události stejného fyzického držení se potlačí až do uvolnění klávesy nebo potřebného modifieru, takže auto-repeat zrušenou akci znovu nevyzbrojí.

Zrušení platí i v odloženém 250ms okně. Generace chrání před souběhem starého timeru a nové akce. macOS řeší také Escape spotřebovaný systémovou kombinací: omezeně kontroluje jeho fyzický stav jen při aktivním vlastním Quit chordu, nikoli globálním keyloggingem. Ztráta focusu a recording režim resetují rozpracovaný stav.

**Kontrola:** Escape během hold, po release, při puštěném modifieru a při auto-repeat; přemapovaný Quit včetně zvláštní klávesy. Nikdy neproběhne pozdní ukončení po zrušení.

Reference: [shortcuts.rs včetně testů](../../apps/desktop/src-tauri/src/shortcuts.rs), [app.vue](../../apps/desktop/app/app.vue).

### K05 Keycaps jsou prezentace skutečného bindingu

Keycaps vznikají z nakonfigurovaného shortcutu, ne z dalšího ručně napsaného stringu v tooltipu nebo indikátoru. Stejný zdroj používají app/tray menu, command palette, recorder, hinty i Hold/Release Quit zpráva. Přemapování nebo vypnutí se promítne do všech příslušných ploch a nesmí ukazovat staré Cmd+Q nebo Cmd+K.

Odlišuj stabilní identitu akce, normalizovaný binding, platformní symbol/jméno klávesy a lokalizovaný popisek akce. Lokalizace nepřekládá binding protokolu do neplatné hodnoty. Nový jazyk nesmí změnit konfliktové rozsahy ani zrušit uživatelské přemapování. Keycaps se mohou zalomit jako skupina, nesmějí oříznout význam modifieru nebo překrýt tlačítko recorderu.

Současná implementace má konkrétní podporovanou množinu kláves a používá platformní formátování; plná lokalizace key names je následný úkol, ne již hotová vlastnost. Keyboard layout, jazyk UI a operační systém jsou tři oddělená rozhodnutí.

Reference: [useShortcutKeys](../../apps/desktop/app/composables/useShortcutKeys.ts), [keybindings.ts](../../packages/config/src/keybindings.ts), [KeyboardSettings](../../apps/desktop/app/components/KeyboardSettings.vue), [app.vue](../../apps/desktop/app/app.vue), [plán lokalizace](production-app-localization-plan.md).

## macOS a desktopový lifecycle

### M01 Traffic lights skutečná geometrie a první vykreslení

Systémová tlačítka jsou skutečné nativní controls, ne HTML kopie. WebView vyznačí 64 × 32px rezervu a po načtení fontů, loga a layoutu pošle její geometrii nativnímu adapteru. Okno se odkryje až po připraveném chrome; jinak by při startu probliklo špatné rozmístění.

Každý nový WebView má vlastní dokument/session identitu. Opožděná geometrie starého okna se odmítne. ResizeObserver změny posílá serializovaně, ne neomezeným paralelním IPC. AppKit controls se dorovnávají v odpovídajícím nativním lifecycle, nikoli v konfliktu s jeho vlastním resize/fullscreen layoutem.

Pokud se okno nedokáže připravit, existuje omezený recovery postup namísto trvale neviditelné aplikace; aktuální timeout pro tuto situaci je 8 s. Přepínání nativních detailů patří za jeden adapter, ne do všech komponent.

**Kontrola:** cold/warm start na Retina, vytvoření UI po tray, rychlý resize, fullscreen a odmítnutí starého document ID. Samotný DOM screenshot nepotvrzuje nativní tlačítka.

Reference: [useNativeShell](../../apps/desktop/app/composables/useNativeShell.ts), [window_chrome](../../apps/desktop/src-tauri/src/window_chrome.rs), [window_state](../../apps/desktop/src-tauri/src/window_state.rs).

### M02 Přesun mezi monitory respektuje pracovní plochu

TRAWL u macOS umí přizpůsobit geometrii poměrem mezi použitelnými plochami displejů. Počítá s relativní polohou, minimální velikostí, skutečnou pracovní oblastí a dostupnými monitory. Okno se nesmí ztratit mimo obrazovku po jejím odpojení.

Fullscreen je samostatný stav; automatické dorovnání ho nesmí rozbíjet. Logické rozměry a backing scale se nezaměňují. Nativní změny displejů a dokončení layoutu jsou důležitější než „resize CSS už doběhl“.

**Kontrola:** dvě různé použitelné plochy/DPI, odpojení monitoru, přesun přibližně 80% okna oběma směry, fullscreen enter/exit. Pro jiný OS přenášej záměr, ne AppKit kód.

Reference: [window_state.rs](../../apps/desktop/src-tauri/src/window_state.rs).

### M03 Close policy tray a skutečný Quit

Close má preference Ask, Tray nebo Quit. Nová konfigurace TRAWLu preferuje pokračování v tray; existující explicitní volby se zachovávají. Zavření okna není samo o sobě příkaz k ukončení serveru. Explicitní Quit zastaví pouze vlastní server, nikoli cizí CLI či vzdálenou instanci.

Tray varianta zničí WebView a Open ho znovu vytvoří. Runtime, uložená konfigurace a runtime vlastněné operace mají odlišný lifecycle od UI subscriberů. Nelze z toho odvozovat, že všechny in-memory request drafty přežijí zánik okna; viz N03.

Start aplikace při loginu je oddělený od spuštění lokálního serveru při startu aplikace. Background startup nemusí vůbec ukázat hlavní okno. Chyba startu musí mít dostupnou cestu k vysvětlení a opravě.

Reference: [desktop.rs](../../apps/desktop/src-tauri/src/desktop.rs), [runtime.rs](../../apps/desktop/src-tauri/src/runtime.rs), [ConnectionSettings](../../apps/desktop/app/components/ConnectionSettings.vue).

### M04 Dock menu bar a aktivace nesmí krást focus

Preference viditelnosti rozlišuje Dock/menu bar režimy. Menu-bar-only režim ponechává otevřené hlavní okno dostupné v Dock/switcheru; po zničení okna ho může skrýt. Zpožděný nativní retry před změnou znovu ověřuje aktuální preferenci i stav okna, aby stará akce nepřepsala novou volbu.

Second launch, explicitní Open a aktivace aplikace obnoví nebo aktivují správné hlavní okno. Výběr uložené instance v tray naopak zavřené okno neotevírá ani nefokusuje: zapamatuje výběr pro další explicitní Open. V otevřeném okně projde přes stejný guard neuložených změn.

Tray logo je neutrální při zastaveném lokálním serveru a barevné při běhu. Start/Stop a Restart odpovídají pozorovanému stavu; remote instance nemá lokální lifecycle akce. App settings přes nativní menu nebo Cmd+, funguje i po zavření UI.

Reference: [tray.rs](../../apps/desktop/src-tauri/src/tray.rs), [desktop.rs](../../apps/desktop/src-tauri/src/desktop.rs), [runtime.rs](../../apps/desktop/src-tauri/src/runtime.rs).

## Android telefon a TV

### A01 Edge to edge s jedním vlastníkem insetů

Activity používá systémový edge-to-edge režim, ale obsah dostane bezpečné paddingy pro system bars, cutout a IME. Insets jsou poté označené jako spotřebované. Webová spodní navigace může používat safe-area fallback, nesmí ale k již spotřebovanému nativnímu insetu připočíst stejnou výšku znovu.

Systémové Back nejprve skryje viditelnou klávesnici. Pak projde propojenou WebView historií aplikace, případně přesune task do pozadí. UI pause odešle `trawl-background` pro úklid tooltipů a přechodných stavů. Resume znovu připojí UI k aktuálnímu runtime a obnoví potřebný stav.

**Kontrola:** IME, system gesture bar i tlačítková navigace, cutout, portrait/landscape, drawer a ukládací bar současně. Jedním Back se nemá zároveň schovat klávesnice a ztratit stránka.

Reference: [MainActivity](../../apps/desktop/src-tauri/gen/android/app/src/main/java/com/germondai/trawl/desktop/MainActivity.kt), [useBrowserNavigation](../../apps/desktop/app/composables/useNavigationSteps.ts), [main.css](../../apps/desktop/app/assets/css/main.css).

### A02 TV je jiný vstupní profil

Android TV zjišťuje nativní UI mode. Používá sidebar a viditelné desktopové history controls; phone spodní bar se nezobrazí. Focus-visible je výrazný: aktuálně 3px akcentový outline s 3px offsetem. D-pad musí dojít k seznamům, formulářům i zavření overlaye.

Neodvozuj TV z rozlišení, protože velká televize může mít méně CSS prostoru než tablet. Zachovej možnosti klávesnice a připojené myši. Podpora rozvržení v kódu se zvlášť odlišuje od kompletního ověření fyzického ovladače.

Reference: [MainActivity](../../apps/desktop/src-tauri/gen/android/app/src/main/java/com/germondai/trawl/desktop/MainActivity.kt), [useAppLayout](../../apps/desktop/app/composables/useAppLayout.ts), [main.css](../../apps/desktop/app/assets/css/main.css).

### A03 Runtime vlastní foreground service v odděleném procesu

Lokální server nepatří lifecycle Activity/WebView. `:runtime` proces a foreground service drží práci nezávisle; UI se připojuje soukromým same-UID Binder rozhraním. Od API 28 runtime renderer používá vlastní WebView data-directory suffix; na starších podporovaných verzích se toto konkrétní oddělení profilu neslibuje. Odstranění UI nebo jeho zánik nemá samo zrušit aktivní listener.

Persistovaný záměr „uživatel chtěl server spuštěný“ dovolí službě při podporované obnově pokračovat bez otevření Activity. Explicitní Stop tento záměr vymaže. Obnova služby není automatický replay rozpracovaných requestů. Force stop a systémová/OEM omezení zůstávají v pravomoci Androidu.

**Kontrola:** aplikace není vidět, její UI proces zanikne, server stále odpovídá; opětovné UI se připojí k téže práci. Explicitní Stop listener skutečně ukončí. U dalších systémů použij jejich podporovaný background model, nikoli slib ekvivalentu této služby.

Reference: [RuntimeService](../../apps/desktop/src-tauri/gen/android/app/src/main/java/com/germondai/trawl/mobile/RuntimeService.kt), [RuntimeConnection](../../apps/desktop/src-tauri/gen/android/app/src/main/java/com/germondai/trawl/mobile/RuntimeConnection.kt), [AndroidManifest](../../apps/desktop/src-tauri/gen/android/app/src/main/AndroidManifest.xml), [mobile runtime](../../native/mobile-runtime/src/lib.rs).

### A04 Běžná notifikace a Live activities jsou dvě prezentace

App settings má Notifications a přepínač Live activities; v TRAWLu je default zapnutý. Běžný fallback je standardní notifikace, kterou uživatel může sbalit a rozbalit. Promoted/live režim je výraznější a může být systémově trvale rozbalený. Rozdíl není automaticky chyba tmavého theme aplikace.

V headeru oznámení je TRAWL a URL. Obsah už stejnou URL zbytečně neopakuje; ukazuje relevantní stav a počty. Stop/Restart zůstávají dostupné v příslušném rozbaleném/system presentation režimu. Malá informační akce pro support patří k preferenci, nikoli jako dominantní debug tlačítko v běžné sekci.

Xiaomi Focus/HyperIsland je adapter s ověřením podpory a běžným fallbackem. Neodvozuj jeho přesnou podobu z emulator screenshotu. Uživatelská volba vypnout live aktivity nesmí zastavit samotný server.

Reference: [RuntimeService](../../apps/desktop/src-tauri/gen/android/app/src/main/java/com/germondai/trawl/mobile/RuntimeService.kt), [FocusNotifications](../../apps/desktop/src-tauri/gen/android/app/src/main/java/com/germondai/trawl/mobile/FocusNotifications.kt), [ConnectionSettings](../../apps/desktop/app/components/ConnectionSettings.vue), [platformní pravidla v průvodci](production-app-blueprint.md#notifikace-a-živé-aktivity).

### A05 Restart notifikace bez zbytečného Restarting UI

Při restartu se původní notice dočasně zachová a po úspěchu se obnoví s novou identitou/stavem. Nezobrazuje se přechodné velké Restarting rozhraní. Přepnutí identit může sbalit/resetovat HyperIsland; explicitně přijaté chování se nesmí omylem zaměnit za requirement nepřerušeně otevřené karty.

Foreground služba nesmí během resetu přijít o svůj potřebný foreground stav. Restart, Stop a preference prezentace se koordinují se skutečnou akcí, nikoli s renderer animací. Dokončení/error background requestu může mít vlastní oznámení, běžné čtení dat ho nevytváří.

Dočasný Check last process exit po vyřešení incidentu z běžného UI zmizel. Diagnostika nemá trvale zatěžovat nastavení, pokud už uživatelské rozhodnutí nevyžaduje.

Reference: [RuntimeService](../../apps/desktop/src-tauri/gen/android/app/src/main/java/com/germondai/trawl/mobile/RuntimeService.kt), [ConnectionSettings](../../apps/desktop/app/components/ConnectionSettings.vue).

### A06 Otevřeně omezený lokální runtime

Android používá native HTTP a System WebView rendering. Nevydává se za kompletní desktopový Camoufox runtime. Kategorie API & requests obsahuje listen adresu/port, API key, timeout a rozsah tierů; Network & proxies na lokálním Androidu nabízí DNS. Ostatní skutečně nepodporované kategorie se vůbec nenabízejí.

Remote instance zobrazuje vlastní capability a nastavení. Unsupported, offline, pending a prázdný search nejsou jeden stav. Obyčejné přepnutí kategorie nesmí skončit hláškou `No settings match ""` jen proto, že server danou kategorii nemá.

Reference: [mobile catalog](../../native/mobile-runtime/assets/catalog.json), [settings utilities](../../apps/desktop/app/utils/settings.ts), [ServerSettings](../../apps/desktop/app/components/ServerSettings.vue), [RemoteSettings](../../apps/desktop/app/components/RemoteSettings.vue), [settings tests](../../apps/desktop/tests/settings.test.ts).

### A07 Ikona a systémová nastavení

Adaptive launcher icon používá transparentní značku s rezervou na tmavém podkladu. Launcher smí změnit vnější masku a systémový plate; transparentní zdroj neznamená transparentní výslednou dlaždici. Neřeš launcher masku deformací původního loga.

Background preference odkazuje do Android nastavení pro oprávnění/battery omezení. Aplikace vysvětlí potřebnou akci, ale nepředstírá, že programově obejde systémový force stop. Oprávnění a nastavení jsou součást nativního adapteru.

Reference: [adaptive icon](../../apps/desktop/src-tauri/gen/android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml), [MainActivity](../../apps/desktop/src-tauri/gen/android/app/src/main/java/com/germondai/trawl/desktop/MainActivity.kt), [ConnectionSettings](../../apps/desktop/app/components/ConnectionSettings.vue).

### A08 Notifikace a live akce podle účelu a viditelnosti

| Událost | Aktuální mechanismus a účel |
| --- | --- |
| Probíhající Android server/práce | Ongoing foreground-service notice; volitelná promoted/HyperIsland prezentace podle A04. |
| Dokončený nebo chybný background request | Samostatné completion oznámení, pokud operace splňuje notify pravidlo; běžné GET čtení přehledu jej nevytváří. |
| Dokončená/neúspěšná desktopová instalace browseru | Nativní completion oznámení při práci mimo zaměřené hlavní okno. |
| Běžný UI výsledek | Toast nebo inline stav v kontextu, nikoli nová systémová notifikace při každém pollu. |
| Nalezená aktualizace aplikace | UI informace s navazující akcí; instalace zůstává vědomá akce uživatele. |

Desktopová helper funkce kontroluje focus hlavního okna před oznámením. Android má vlastní přenos do runtime/native presentation a evidenci viditelnosti Activity. Odmítnutí systémového oprávnění není důvod považovat dokončenou práci za chybnou; výsledek zůstane dostupný po návratu do aplikace.

Ongoing notice používá stabilní identitu v rámci průběhu, only-alert-once a relevantní stav. Restart nebo změna live preference ji obnoví řízeně. Nedělej z aktualizace počítadla nový zvukový alert. Texty, action labels a odpovídající deep/open cíl mají stejného vlastníka a lifecycle jako úloha. Oznámení nesmí obsahovat celé citlivé payloady nebo tajné URL parametry.

Přenos do jiného OS znamená jeho vlastní adapter; iOS Live Activities nejsou již implementované jen proto, že existuje Xiaomi/Android řešení. Lokalizace musí fungovat i při zničeném WebView a při cold startu služby.

Reference: [background notification helper](../../apps/desktop/src-tauri/src/lib.rs), [operations.rs](../../apps/desktop/src-tauri/src/operations.rs), [runtime notification routing](../../apps/desktop/src-tauri/src/runtime.rs), [RuntimeService](../../apps/desktop/src-tauri/gen/android/app/src/main/java/com/germondai/trawl/mobile/RuntimeService.kt), [plán lokalizace](production-app-localization-plan.md).

## Rozsah původ a aplikace nastavení

### S01 Rozsah hodnoty je jiná osa než její původ

| Současný rozsah v TRAWLu | Příklady a vlastník |
| --- | --- |
| Zařízení/aplikace | Close/Quit policy, viditelnost aplikace, sidebar, keybindings, smooth scroll a live activities v uložené desktop konfiguraci. |
| Spravovaná lokální instance | Serverové override v `config.env`, například port a DNS. |
| Vzdálená instance | Efektivní read-only snapshot ze serveru; lokální klient neslibuje jeho editaci. |
| Konkrétní request/draft | Metoda, target URL, headers/body/session a další volby této operace. |
| Dočasný UI stav | Search, otevřený dialog, tab, aktuální indikátor; persistence se řídí příslušným receptem. |
| Samostatně uložená klientská preference | Například automatická kontrola aktualizací nebo preference preview podle konkrétního modulu. |

Framework může později přidat účet/projekt/workspace, ale nesmí předstírat, že tyto scope už TRAWL všechny implementuje. „Global“ musí vždy říkat, pro který rozsah je hodnota společná: celé zařízení, aplikace, účet, nebo vybraný server. Preferenci jazyka nebo theme nepřenášej bez rozhodnutí do serverového prostředí každé instance.

Reference: [UserConfig a defaults](../../packages/config/src/catalog.ts), [config store](../../packages/runtime/src/store.ts), [desktop store](../../apps/desktop/app/stores/desktop.ts), [useAppUpdates](../../apps/desktop/app/composables/useAppUpdates.ts).

### S02 Precedence default baseline file environment a flag

Referenční config resolver skládá hodnoty v tomto pořadí od nejslabšího: schema default → baseline/profile → uložený file override → zděděné process environment → explicitní launch flag. Spravovaný runtime může doplnit své výchozí privátní cesty. Baseline a takto odvozené výchozí hodnoty nejsou automaticky samostatný source label.

UI odděluje uložený override, inherited hodnotu při absenci tohoto override a skutečně effective stav. Uložená vlastní hodnota může být přebitá silnějším environment/flag zdrojem; Save v takovém případě nesmí slibovat okamžitě jiný výsledek. Secret se do klientského souhrnu rediguje.

API read-only snapshot může uvést také `normalized`, když runtime hodnotu převedl; to není nový editovatelný scope. Technický config klíč, source enum a přesná protokolová hodnota zůstávají stabilní i po překladu jejich popisku.

**Kontrola:** vlastní override bez env, env nad file, flag nad env, reset file override, prázdná/citlivá hodnota a runtime normalizace. Zobrazený původ má vysvětlit skutečnou účinnost.

Reference: [resolveEnvironment](../../packages/config/src/index.ts), [resolveManagedEnvironment](../../packages/runtime/src/environment.ts), [management snapshot](../../packages/runtime/src/management.ts), [instanceSettings](../../apps/api/src/instanceSettings.ts).

### S03 Dynamic live restart a odvozená hodnota se nezaměňují

Dynamic může znamenat změnu možností podle runtime, nově načtený katalog, vypočtený default nebo live aplikaci preference. Tyto situace potřebují odlišný kontrakt. Samotný reactive input neprokazuje hot reload serveru.

App preference jako sidebar/smooth scroll/keybindings nebo live presentation se podle adapteru projeví po příslušném uložení, bez restartu scraping serveru. Serverová pole mají restart metadata a běžný workflow Save → podle potřeby Restart. Read-only remote snapshot není editor. V budoucím frameworku má schéma explicitně označit `live`, `next-operation`, `restart-required` nebo read-only podle skutečné implementace; tyto názvy nejsou tvrzením, že všechny režimy současný schema typ už má.

Vlastní versus inherited je původ hodnoty, preset versus custom je způsob jejího zadání, live versus restart je okamžik aplikace. Volba custom sama nesmí zneviditelnit skutečné adresy nebo obejít validaci. Dočasný draft a aktuálně běžící server musejí zůstat rozeznatelné.

Reference: [Setting schema](../../packages/config/src/catalog.ts), [ServerSettings](../../apps/desktop/app/components/ServerSettings.vue), [ConnectionSettings](../../apps/desktop/app/components/ConnectionSettings.vue), [RuntimeService preference sync](../../apps/desktop/src-tauri/gen/android/app/src/main/java/com/germondai/trawl/mobile/RuntimeService.kt).

### S04 Reset custom editor a souběžný zápis mají přesný rozsah

Reset pole odstraní jeho override v příslušném draftu; Discard vrátí draft k baseline; Restore defaults keybindings připraví nový draft; globální destruktivní factory reset je jiná operace a nesmí vzniknout přejmenováním těchto akcí. Návrat DNS na skutečně inherited volbu odstraňuje také nepatřičné custom servers. Tento helper není důkazem, že každý ručně zadaný input už automaticky odstraňuje všechny default-equivalent override.

Preset ukazuje odvozené hodnoty, custom editor jednotlivé položky a rodičovský formulář vlastní konečné Save. Rebase zachová lokálně změněná pole při novém config snapshotu. Serializovaný zápis brání tomu, aby starý draft přepsal novější reorder nebo preferenci. Přechod mezi instancemi použije správnou baseline a guard.

Reference: [settings helpers](../../apps/desktop/app/utils/settings.ts), [ServerSettings](../../apps/desktop/app/components/ServerSettings.vue), [desktop persistence](../../apps/desktop/app/stores/desktop.ts), [settings tests](../../apps/desktop/tests/settings.test.ts).

## Opakované UI vzory

### P01 Nastavení s draftem a původem hodnoty

Popisek, vysvětlení, technický klíč a control mají jasnou hierarchii. Effective/inherited/default/override nejsou zaměnitelné. Reset odstraní vlastní volbu, místo aby jen zapsal stejný default jako nový override. Hodnota vyžadující restart je označená v kontextu uložení.

Nezávislá změna konfigurace na pozadí se rebazuje proti baseline, aby neodstranila právě editované pole. Nastavení jen pro čtení ukazuje správně dostupnou informaci bez předstírání oprávnění k zápisu. Async katalog přepočítá kategorie i neplatný vybraný stav/historii.

Reference: [ServerSettings](../../apps/desktop/app/components/ServerSettings.vue), [RemoteSettings](../../apps/desktop/app/components/RemoteSettings.vue), [settings utilities](../../apps/desktop/app/utils/settings.ts), [settings tests](../../apps/desktop/tests/settings.test.ts).

### P02 Presety s transparentním obsahem a custom editorem

DNS preset se vybírá ve společném dialogu/draweru. Přednastavené adresy a bootstrap údaje jsou viditelné jako neaktivní/readonly hodnoty; nejde o neprůhledný název poskytovatele. Custom otevře samostatné řádky, přidání/odebrání a validaci až čtyř adres, místo jednoho úzkého comma-separated inputu.

Návrat k System DNS nebo jiné skutečně zděděné volbě odstraní redundantní override i staré custom hodnoty. Uložit v editoru upraví draft rodičovské stránky; perzistence zůstává její explicitní Save. V jiném produktu tento recept použij pro endpointy, profily, zdroje a podobné složené hodnoty.

Reference: [DnsSettingsEditor](../../apps/desktop/app/components/DnsSettingsEditor.vue), [DnsServerField](../../apps/desktop/app/components/DnsServerField.vue), [settings tests](../../apps/desktop/tests/settings.test.ts).

### P03 Seznam proxy nebo jiných adres není malý textový input

Manage proxy URLs má stejnou šířku jako ostatní controls v daném sloupci. Ukazuje počet položek a otevře rozšířený editor se samostatnými endpointy. Malý action button utopený vedle velkých inputů není ekvivalent stejně důležitého pole.

Editor podporuje více řádků, validaci a zachování formátu pro backend. Nevnáší do UI zbytečný požadavek ručně sestavit interní čárkami oddělený string. Vložení do draftu neznamená automatický restart ani vzdálenou změnu.

Reference: [ProxyListEditor](../../apps/desktop/app/components/ProxyListEditor.vue), [ServerSettings](../../apps/desktop/app/components/ServerSettings.vue).

### P04 Soubor a adresář mají specializovaný control

Desktopové path pole spojuje ruční hodnotu, trailing picker ikonu a vyčištění. File a directory volají odpovídající typ výběru. Cancel pickeru zachová původní hodnotu. Hint dlouhé cesty je truncated, původ hodnoty zůstane čitelný a plná cesta je dostupná přes vhodný text/copy kontext.

Form-data value může být text nebo připojený soubor; výběr a drag/drop vedou ke stejnému výsledku. Název připojeného souboru je readonly do jeho odebrání/nahrazení. Pomalé načtení dřívějšího výběru nesmí přepsat novější soubor ani znovu doplnit odstraněný řádek; kontroluje se generace výběru a lifecycle. Mobilní adapter musí používat skutečný model dokumentového přístupu své platformy, nikoli předstíranou desktopovou absolutní cestu.

Reference: [SettingPathInput](../../apps/desktop/app/components/SettingPathInput.vue), [setting_paths.rs](../../apps/desktop/src-tauri/src/setting_paths.rs), [RequestFields](../../apps/desktop/app/components/RequestFields.vue).

### P05 Připojení s uchováním identity a soukromých údajů

Uložená instance se přejmenuje, přesune, upraví nebo odstraní s konkrétním potvrzením. Local má rozpoznatelnou malou monitor ikonu a nelze ho smazat; remote nemá zavádějící badge stejného umístění. URL lze vybrat/kopírovat a otevřít v systémovém browseru.

Prázdný token při editaci zachová uložený secret, nový ho nahradí a explicitní Remove saved token ho odstraní. Chyba uložení ponechá draft. Změna pořadí upraví konfiguraci i tray pořadí, aniž roztočí server busy stav. Starší souběžný save nesmí novější reorder vrátit zpět.

Copy address má copying/copied/failed stav a krátký success feedback; pomalá odpověď předchozí adresy se nepřipíše nové vybrané instanci. Soukromé spojení má vlastní nenápadný guide vstup, nikoli automatické provisioning oprávnění.

Reference: [ConnectionEditor](../../apps/desktop/app/components/ConnectionEditor.vue), [ConnectionSettings](../../apps/desktop/app/components/ConnectionSettings.vue), [ShellSidebar](../../apps/desktop/app/components/ShellSidebar.vue), [connection tests](../../apps/desktop/tests/connection-editor.test.ts), [ordering tests](../../apps/desktop/tests/connection-order.test.ts).

### P06 Logy a historie respektují čtenáře

Log viewport sleduje poslední položky jen dokud je uživatel u nich. Scroll od konce follow pozastaví, Latest ho obnoví. Search, severity, scope, time range, limit a order jsou kombinovatelné. Nepřeskakuj uživateli pod rukou při čtení staršího řádku.

Live application events a lokální process output sdílejí sloupce, ale liší se zdrojem, časovým rozsahem a důvěryhodností času. Process record bez timestampu má unavailable marker; time filter není zdánlivě funkční. Stopped local ukazuje Offline, běžící process snapshot Snapshot. Footer vysvětluje rozsah bez obrovské prázdné výplně.

Historie používá podporovaný server-side search/filter/sort/pagination; starší backend může mít omezený fallback. Změna instance nebo filtrů ignoruje pozdní odpověď staršího dotazu. Nová stránka může po načtení doscrollovat na začátek, ne překreslovat starý výsledek jako nový.

Reference: [ServerLogs](../../apps/desktop/app/components/ServerLogs.vue), [RequestHistory](../../apps/desktop/app/components/RequestHistory.vue), [instance-fetch](../../apps/desktop/app/utils/instance-fetch.ts), [process-logs tests](../../apps/desktop/tests/process-logs.test.ts).

### P07 Editor s více drafty a skutečným stavem operace

Nová akce vytváří nový request draft, pokud by nahrazovala rozpracovaný obsah. Reset, zavření neprázdného tabu a replacement se potvrzují. Taby mají stabilní identitu a pořadí. Přepnutí tabu zachová jeho request fields, zastaví lokální čekání a vyčistí response view; nejde o uchování všech výsledků mezi taby ani potvrzení serverového cancel. Referenční in-memory limity jsou osm tabů na instanci a čtyři instance, nikoli neomezený persistentní workspace.

Query/headers/form-data lze editovat v tabulce nebo bulk zápisu s obousměrně zachovanou validitou. Raw JSON má rozlišovat nevalidní draft od poslední validní hodnoty; rychlý parent echo nesmí smazat právě psaný znak. Preview nebo otevření uloženého requestu samo nic neodesílá.

Při běhu se ukazuje skutečný elapsed čas. Stop waiting není automaticky potvrzení zrušení přijaté serverové operace; transport/API/target chyby se odlišují a request se po nejasném výsledku neopakuje automaticky. Povolené payloady a limity vycházejí z capability instance.

Reference: [RequestWorkbench](../../apps/desktop/app/components/RequestWorkbench.vue), [workbench store](../../apps/desktop/app/stores/workbench.ts), [useWorkbenchRun](../../apps/desktop/app/composables/useWorkbenchRun.ts), [request-editor tests](../../apps/desktop/tests/request-editor.test.ts), [elapsed tests](../../apps/desktop/tests/workbench-elapsed.test.ts).

### P08 Uložené výsledky a náhledy neprovádějí práci znovu

Detail čte existující artefakt místo nového requestu. HTML preview je izolované od privilegovaného UI, nepouští cizí skripty/formy/IPC a neprovádí skrytá síťová načtení. CSS se přenáší pouze v podporovaném bezpečném rozsahu; jinak se zachová čitelný fallback. Pokud originál schová html/body do načtení JavaScriptu, inertní preview umožní viditelnost kořene, ale neodkryje svévolně všechny skryté děti. Zdroj, screenshot a viditelný náhled jsou různé výstupy.

Náhled má byte/dimension/pixel limity a při zavření uvolní object URLs, buffery a subscribery. Aktivní browser observation je samostatný opt-in s omezeným refreshem; opuštění inspectoru zastaví preview. Uložená metadata nebo otevření detailu nepředstírají novou měřenou operaci.

Reference: [CapturedContent](../../apps/desktop/app/components/CapturedContent.vue), [CapturedRequest](../../apps/desktop/app/components/CapturedRequest.vue), [BrowserInspector](../../apps/desktop/app/components/BrowserInspector.vue), [captured-document](../../apps/desktop/app/utils/captured-document.ts), [capture tests](../../apps/desktop/tests/captured-content.test.ts).

### P09 Background fronta downloadů a bezpečné přepnutí verzí

Delší download zůstává vidět v řádku i při přechodu na jinou stránku přes společnou queue. Časový odhad se ukazuje až při měřitelném progressu a podle fáze; nevymýšlí se univerzální procenta pro extraction/validation. Cancel patří konkrétnímu jobu. Referenční limit TRAWLu jsou tři aktivní downloady a fronta dalších.

Instalace nové verze zachová aktivní funkční verzi. Repair aktivní verze připraví separátní kandidát; Apply nastane až v bezpečném zastaveném stavu. Částečný download lze znovu použít pouze s ověřenou identitou/rozsahem a finálním hashem; cancel má definovaný cleanup. Za běhu instalačního jobu nelze vyčistit jeho cache.

Pruning starých staging/cache dat má jasné stáří a respektuje zámky; aktuální referenční stáří je 24 hodin. Neodstraňuje konfiguraci ani aktivní instalaci. Unsupported/unknown verze mohou zůstat viditelné s Remove, ale nesmějí získat Activate.

Reference: [BrowserDownloadQueue](../../apps/desktop/app/components/BrowserDownloadQueue.vue), [BrowserManager](../../apps/desktop/app/components/BrowserManager.vue), [browser-downloads utility](../../apps/desktop/app/utils/browser-downloads.ts), [download tests](../../apps/desktop/tests/browser-downloads.test.ts).

### P10 Profily jako transparentní editace draftu

Preset nejprve ukáže přesné změny, zvolený rozsah a hodnoty, které ponechá. Apply upraví draft; až Save perzistuje. Undo profile vrátí předchozí profilové hodnoty a nezahodí nesouvisející pozdější editaci. Environment override je označený a respektovaný.

Konkrétní Standard/Economy nemění svévolně ručně nastavený pool, listener nebo cache. Přenositelné pravidlo je úzký a vysvětlený rozsah presetu, ne stejné názvy profilů pro každý produkt.

Reference: [ResourceProfiles](../../apps/desktop/app/components/ResourceProfiles.vue), [resource-profiles utility](../../apps/desktop/app/utils/resource-profiles.ts), [profile tests](../../apps/desktop/tests/resource-profiles.test.ts).

### P11 Managed storage má konkrétní a bezpečné akce

Řádky storage zarovnávají název, velikost a stejné action sloty. Reveal otevře přesně povolené umístění. Cleanup ukáže konkrétní rozsah a vyžaduje rozhodnutí; v runtime znovu ověří vlastnictví, zámky a podmínku zastavené práce, kde je nutná.

Application/runtime mohou tvořit jednu významovou položku; databáze a její journal se účtují a čistí společně. Download cache není uživatelská složka Downloads. Konfigurace, nainstalované verze a vlastní uživatelské soubory se nesmějí ztratit pod obecným Clear cache. Související navigační akce vedou ke správné stránce přes běžný guard.

Reference: [ResourceUsage](../../apps/desktop/app/components/ResourceUsage.vue), [resources.rs](../../apps/desktop/src-tauri/src/resources.rs).

### P12 Status bar metrika a toast mají konkrétní význam

Stavový bod nebo bar má srozumitelný label a skutečný zdroj dat. CPU měření potřebuje interval; neukazuje se fingovaná okamžitá přesnost. Kapacita rozlišuje dostupné, obsazené, spící a chybějící stavy. Neznámé maximum není automaticky 100 %.

Verzní badge mají jednotný slovník, popis a barvu: Recommended/Active zelená, Latest modrá, Repair ready teal, Needs repair/Deprecated oranžová, Unknown žlutá, unsupported červená a Nightly fialová; Installed/Not installed jsou neutrální. Latest znamená nejnovější podporovaný build příslušného katalogu, nikoli celé upstream vydávání. Deprecated/Nightly se nepovažují za Recommended/Latest a samotný beta název neznamená Nightly. Tyto stavy vycházejí z explicitních dat, ne z odhadu vzhledu version stringu.

Toast potvrzuje krátký výsledek nebo chybu a případně nabídne navazující akci. Trvalá chyba, rozpracovaný download či permission stav mají vlastní viditelné místo. Běžný polling nebo reorder připojení nespouští spinner lifecycle. Dlouhý text se zkracuje pouze s dostupným úplným obsahem.

Reference: [MetricBar](../../apps/desktop/app/components/MetricBar.vue), [BrowserCapacity](../../apps/desktop/app/components/BrowserCapacity.vue), [ResourceUsage](../../apps/desktop/app/components/ResourceUsage.vue), [OperationProgress](../../apps/desktop/app/components/OperationProgress.vue), [browser-tags](../../apps/desktop/app/utils/browser-tags.ts), [tag tests](../../apps/desktop/tests/browser-tags.test.ts).

### P13 File drop upload a directory picker mají odlišné kontrakty

| Vstup | Současné chování |
| --- | --- |
| Form-data value | Trailing upload a drop do value řádku; právě jeden soubor na řádek. Více souborů oznámí chybu místo tichého výběru prvního. |
| Binary body | Samostatný výběr/drop file control se skutečným size limitem a vysvětlením request režimu. |
| Settings file path | Ruční path + native file picker a clear; přímo v tomto controlu nyní není vlastní drag/drop handler. |
| Settings directory path | Ruční path + native directory picker a clear; directory drop zatím není implementovaný. |
| Reorder tabů | Interní pointer gesture podle G10, nikoli file drop a nikoli důvod načítat cizí soubor. |

File dragover/drop kontroluje allowFiles, disabled stav i disabled fieldset. Chyba a probíhající čtení se promítnou do validace, takže se neodesílá neúplný request. Zrušení, novější výběr a odstraněný řádek invalidují starou asynchronní odpověď. UI a runtime znovu ověří příslušné limity.

Pokud šablona přidá drop do path/directory controlu, je to explicitní rozšíření: rozhodni single/multi, file/directory, zacházení s browser handle či nativním path/URI, oprávnění, odkazy, cloud provider a nedostupnou lokalitu. Nepřeváděj libovolný File objekt na vymyšlenou absolutní cestu a nepovoluj soubor jako adresář. Zachovej picker/klávesnicovou alternativu a jasný drop-target stav.

Reference: [RequestFields](../../apps/desktop/app/components/RequestFields.vue), [RequestWorkbench](../../apps/desktop/app/components/RequestWorkbench.vue), [request-body](../../apps/desktop/app/utils/request-body.ts), [SettingPathInput](../../apps/desktop/app/components/SettingPathInput.vue), [setting_paths](../../apps/desktop/src-tauri/src/setting_paths.rs).

## Konkrétní vizuální základ

### V01 Přijatý vzhled a návrh nové šablony nejsou totéž

| Role | Aktuální reference TRAWLu |
| --- | --- |
| UI font | Lokálně dodaný Urbanist, systémový sans fallback. |
| Kód a identifikátory | Systémové mono, tabulární číslice. |
| Primary | `#48ce8a` |
| Hlavní pozadí / vnější shell | `#171719` / `#1c1c1e` |
| Elevated surface | `#222225` |
| Běžný border | `#303034` |
| Text / muted | `#e9e9ec` / `#a0a0a8` |
| Ikony | Lucide, společná geometrie podle role; bez emoji místo ovládání. |
| Desktop header / phone header | 64 px / 56 px |
| Sidebar default / rail | 15 rem / 4 rem |
| Phone panel padding / content | 16 px / 16 px × 12 px |
| Phone navigation CTA | 64 px, raised o 12 px, samostatný obrys. |
| Phone chrome blur | 2 px, oddělená podkladová vrstva. |
| Refresh kruh / ikona | 36 px / 20 px |
| History kruh / chevron | 40 px / 24 px |

To je snapshot implementace, ne záruka kontrastu pro libovolnou kombinaci ploch a stavů. [Starter tokeny](production-app-starter-tokens.css) z hlavního průvodce jsou samostatný návrh pro další projekt: přidávají například silnější control border a světlou paletu. Pokud chceš přesný výchozí TRAWL vzhled, začni referencí výše a převáděj role explicitně.

### V02 Motion vysvětluje změnu a zachovává návrat

Hover mění povrch/barvu a focus je viditelný. Sidebar má krátký width/text přechod, taby animují přesun, overlay má konkrétní fáze. Reduce motion neponechává nutnost čekat na vizuální animaci pro dokončení logické akce. Continuous spinner signalizuje skutečnou aktivitu, není dekorace.

Před experimentem s přijatým UX ulož přesné soubory nebo úzký vratný patch a poznamenej referenční screenshot/scénář. Návrat má vrátit jen tento experiment a zachovat jiné mezitím přijaté opravy. Tento postup vznikl například při kalibraci delší dráhy refresh indikátoru. Vytvoření Git commitu je samostatná akce, pokud je požadovaná; samotný experiment ho neautorizuje.

**Kontrola:** porovnání přijaté a kandidátní varianty na stejném zařízení a stejným gestem; pravidla hodnotí ovladatelnost a úplný průběh, ne jen hezký statický screenshot.

Reference: [main.css](../../apps/desktop/app/assets/css/main.css), [PullRefreshIndicator](../../apps/desktop/app/components/PullRefreshIndicator.vue), [hlavní průvodce](production-app-blueprint.md).

### V03 Inventář konkrétních animací a transitions

Toto jsou parametry současného TRAWLu, které se při převzetí motion mají zachovat nebo vědomě přeladit. Názvy transition tříd samy o sobě nedokazují konečný efekt: rozhoduje konkrétní CSS, stav komponenty a životnost prvku.

| Prvek | Spouštěč a přechod | Důležitý kontrakt |
| --- | --- | --- |
| Stránka | `.page-view` opacity 0.8 → 1 za 140 ms ease-out. | Následující stránka se zobrazí hned; není dlouhá prázdná odchozí fáze. |
| Sidebar | Width a text opacity 180 ms ease při běžném toggle. | Při ručním resize není soupeřící width transition; reduced motion bez ní. |
| Běžná tlačítka/odkazy | Color/background/border/opacity 150 ms ease. | Neovlivňuje dokončení příkazu ani jeho dostupnost. |
| Pravý dolní blok | Ukotvení 200 ms, child opacity 180 ms a transform 220 ms. | Přesný vstup, odchod a FLIP přesun popisuje L10. |
| New request press | Scale 0.94, 150ms transform/background feedback. | Nevytváří další hit-target ani dvojité spuštění. |
| Přesun ostatních tabů | Transform 180 ms ease. | Tažený tab má transition vypnutou a sleduje pointer. |
| Find bar | Opacity a translate 140 ms; start/end `translateY(-6px)`. | Umístění pod headerem; výběr/mark logika nezávisí na animaci. |
| Setting target | 2500ms pulse: neviditelný na 0/100 %, viditelný přibližně na 15–70 %. | Inset obrys a jemné primary pozadí; po doběhu se odstraní i target stav. |
| Setting běžná změna highlight stylu | Box-shadow/background 450 ms. | Je odlišná od časovaného pulse konkrétního targetu. |
| Scrollbar | Inset/alpha 160 ms s ease-out průběhem. | Gutter nemění šířku; nesmí poskakovat text. |
| History gesto | Opacity a scale podle progressu, odstranění po 180 ms. | Reversible stav, správný cancel a native momentum dle G01–G04. |
| Pull refresh | Kresba podle prstu; pak rotace a zatažení 180/240 ms. | Zdrojem stavu je refresh Promise, ne options spinner. |
| Drawer release | Návrat translate 180 ms ease-out a případná scroll setrvačnost. | Vlastník swipu podle G08; cleanup po cancel/unmountu. |
| Quit hold | Akcentový progress 1 s a Hold → Release text. | Fyzický release a cancel rozhodují o Quit, ne konec keyframe. |

Sdílený `UTheme` v shellu vypíná výchozí modal transition; mobilní drawer má vlastní mechanismus a gesture. Nepřidávej automaticky generický fade všech modalů a nevydávej ho za současné chování. U dalších knihovních animací ověř skutečnou nakonfigurovanou variantu.

Reduced motion kombinuje globální zkrácení CSS přechodů s explicitním vypnutím některých animací a JS kontrolou. Zbývá ověřit skutečný výsledný stav každé převzaté komponenty; změna jednoho duration tokenu není univerzální důkaz. Pokud se měří výkon na slabém zařízení, odděl logiku stavu od prezentačního pohybu, aby se funkce dala používat i bez animace.

Reference: [main.css](../../apps/desktop/app/assets/css/main.css), [app.vue](../../apps/desktop/app/app.vue), [AppDialog](../../apps/desktop/app/components/AppDialog.vue), [useCustomScrollbars](../../apps/desktop/app/composables/useCustomScrollbars.ts).

### V04 Highlight selection focus a stav mají odlišný význam

| Význam | Současný příklad |
| --- | --- |
| Aktivní navigační cíl | Akcentový label/ikona a odpovídající surface/sidebar state; trvá po dobu výběru. |
| Keyboard focus | Viditelný outline podle ovládání; TV používá zesílené zvýraznění. |
| Vybraný request tab | Elevated surface a border; focus/drag navíc drží 2px outline s 2px offsetem. |
| Tažený tab | Trvalý dragging stav, solidní pozadí a vyšší vrstva, nezávislá na změně indexu. |
| Otevřený konkrétní setting | Dočasný 2500ms pulse po navigaci ze setting odkazu/palette. |
| Zvýraznění sekce connections | Dočasný panel outline 2 px s 3px offsetem po cíleném otevření. |
| Find shoda | Přesné Range rects s jemnou výplní; aktuální shoda navíc výraznější výplň a 1px stroke. |
| Textová selekce | Vlastní accent selection barva a standardní kopírování dat. |
| Změna draftu | Počet změn/save bar; nemá předstírat chybu nebo trvalý keyboard focus. |

Změna query odstraní starý setting target. Opakovaný jump má novou revizi a doscrolluje/focusuje správný control. Při zmenšení katalogu se nedržej neplatné targety. Find highlight přepočítává geometrii, neobsazuje hit target a nepřepisuje obsah přes HTML.

Převzaté řešení nesmí všechny tyto stavy slít do jednoho univerzálního `selected` bool. Fokus, běžný výběr, drag, navigační target a textová shoda mohou existovat současně a mají odlišný lifecycle.

Reference: [useSettingFocus](../../apps/desktop/app/composables/useSettingFocus.ts), [ConnectionSettings](../../apps/desktop/app/components/ConnectionSettings.vue), [PageFind](../../apps/desktop/app/components/PageFind.vue), [RequestWorkbench](../../apps/desktop/app/components/RequestWorkbench.vue), [main.css](../../apps/desktop/app/assets/css/main.css).

### V05 Color modes a themes mají explicitní stav implementace

Současný TRAWL má výchozí i fallback color mode dark, dark `color-scheme` a řadu konkrétních tmavých ploch. Přítomnost sun/moon ikon v bundle neznamená hotový uživatelský přepínač. Světlá paleta starter tokenů je návrh pro šablonu; plný light/dark/system režim současné aplikace se tím neprohlašuje za implementovaný.

Budoucí plná podpora oddělí mode (`system`, `light`, `dark`), efektivně rozlišený vzhled, značkový theme preset a hustotu. Uložená preference není totéž co právě platný systémový vzhled. Při system změně je potřeba konzistentně přepnout také overlaye/portály, nativní system bars, formulářové controls, scrollbar a související preview nebo jasně oddělit obsahový theme.

Semantické role se mapují na jednu paletu v jednom místě. Ověř text, disabled/readonly, control border, focus, chybu, selected/drag a backdrop v každé deklarované kombinaci. Přechod theme nemá vyvolat flash nečitelného startu ani přebarvit cizí screenshot nebo změnit data. Případnou animaci změny vzhledu zvol explicitně s reduced-motion variantou; současný kód žádný kompletní theme transition neimplikuje.

Reference: [nuxt.config](../../apps/desktop/nuxt.config.ts), [app.config](../../apps/desktop/app/app.config.ts), [main.css](../../apps/desktop/app/assets/css/main.css), [starter tokeny](production-app-starter-tokens.css).

## Build vydání a přenos do šablony

### D01 Instalátor a artefakt jsou součást UX

macOS DMG má připravené pozice app/Applications a artwork pro různé hustoty. Labely Finderu zůstávají čitelné; transparentní zdrojová značka se nezaměňuje s tím, jak systém vykreslí výslednou ikonu. Artwork se generuje jako build asset, ne jako další runtime závislost.

Android build vybírá skutečné ABI, používá konzistentní package/signing identitu a kontroluje nativní knihovny pro cílová zařízení. Desktopová matice uvádí pouze kombinace, pro které existují odpovídající dependencies a evidence. Balíček má verzi, hash a jasný původ.

Reference: [tauri config](../../apps/desktop/src-tauri/tauri.conf.json), [dmg artwork script](../../apps/desktop/scripts/dmg-background.swift), [mobile assets](../../apps/desktop/scripts/mobile-assets.ts), [native CI](../../.github/workflows/native.yml).

### D02 Aktualizace sdílejí stavový model a liší se instalací

App settings ukazuje nainstalovanou verzi nezávisle na posledním update checku. První dosud nezveřejněný feed není zaměněný za „máte nejnovější verzi“. Checking je oddělené od výsledku available/current/unpublished a od progress stavů idle/downloading/installing/ready/permission/failed. Ověření payloadu provádí nativní část uvnitř příslušné operace; současné UI nevystavuje samostatný verifying stav. Limity a chyba kontroly nejsou zaměněné s verzí aplikace a uživatel vidí skutečný progress.

Desktop ověřuje update payload příslušným podpisem a před instalací řeší vlastněnou práci a restart. Android otevře ověřený odkaz na APK v prohlížeči. Uživatel otevře stažený soubor v systémovém instalátoru, který při aktualizaci ověří podpisovou identitu. Ruční aktualizace Debian balíčku probíhá správcem balíčků. Feed rozlišuje podepsané aktualizace pro Debian a AppImage podle formátu instalace.

Klíče, endpoint konkrétního repozitáře a product ID se do obecné šablony nekopírují jako produkční výchozí hodnoty. Store/iOS adaptery se navrhnou podle jejich kanálu. Přesný staged release, veřejná distribuce, signing a upgrade gate jsou v [hlavním release plánu](production-app-blueprint.md#build-aktualizace-a-vydání).

Reference: [ApplicationUpdates](../../apps/desktop/app/components/ApplicationUpdates.vue), [useAppUpdates](../../apps/desktop/app/composables/useAppUpdates.ts), [updates.rs](../../apps/desktop/src-tauri/src/updates.rs), [AppUpdates.kt](../../apps/desktop/src-tauri/gen/android/app/src/main/java/com/germondai/trawl/mobile/AppUpdates.kt), [update feed](../../apps/desktop/scripts/update-feed.ts).

### D03 Jeden recept znamená i lifecycle a regresi

Převzít pouze SVG nebo CSS indikátoru nestačí. S gestem se přenáší state machine, vlastnictví událostí, native phase adapter, výjimky, reduced motion, cleanup a kontrolní scénář. Se spodním barem se přenáší inset/scroll/save-slot kontrakt. Se settings inputem původ hodnoty, draft a validace.

Při extrakci vytvoř u každého použitého ID záznam: převzato/přizpůsobeno/nepoužito, důvod, nový zdrojový modul, závislosti a odpovídající kontrola. Zdroj TRAWLu slouží k přesné inspekci; obecný framework se podle [hlavního plánu](production-app-blueprint.md#plán-vytvoření-šablony-a-frameworku) vyčleňuje až po skutečném opakovaném použití.

Při verzování připni katalog a odpovídající implementace ke stejnému zdrojovému commitu. U necommitovaného pracovního stromu lze zaznamenat hashe referenčních souborů; samotný HEAD neoznačuje přesný snapshot místních změn. Čísla v receptech aktualizuj společně se zdrojovým chováním, aby pozdější čtenář nepřevzal starou kalibraci jako současnou.

### D04 Průřezové invarianty pro všechny recepty

1. Jedna uživatelská akce nesmí vyvolat dvě navigace, requesty nebo instalace.
2. Gesto drží svého vlastníka až do konce a má cestu cancel/reset.
3. DOM identita a revize kontextu chrání proti opožděným callbackům.
4. Stránka, menu, zkratka a systémová akce používají stejné rozhodnutí a dostupnost.
5. UI state, perzistence, runtime práce a systémová prezentace mají explicitní vlastníky.
6. Uvolní se timery, frames, observers, nativní monitory, listenery, promises a dočasné objekty podle lifecycle.
7. Nedostupnost, prázdná data, pending a chyba oprávnění nejsou jedna hláška.
8. Podpora se potvrzuje správným typem evidence: čistý výpočet, skutečná komponenta, nativní integrace, fyzické ovládání nebo instalátor.

### D05 Mapa ověřování

| Recepty | Základní ověření |
| --- | --- |
| L01–L10 | Responzivní screenshoty/geometrie, různé výšky, dirty bar, otevřená klávesnice a souběh plovoucích akcí při enter/leave/move. |
| N01–N05 | [navigation-steps](../../apps/desktop/tests/navigation-steps.test.ts), [history-navigation](../../apps/desktop/tests/history-navigation.test.ts), skutečný overlay scénář. |
| G01–G04 | [native-history-gesture](../../apps/desktop/tests/native-history-gesture.test.ts), nativní trackpad fáze a fyzický trackpad. |
| G05–G07 | [pull-refresh](../../apps/desktop/tests/pull-refresh.test.ts), [page-refresh](../../apps/desktop/tests/page-refresh.test.ts), dotyk a viditelnost indikátoru. |
| G08–G09 | [drawer-scroll](../../apps/desktop/tests/drawer-scroll.test.ts), touch scroll/drag v dlouhém obsahu. |
| G10–G11 | [request-tab-drag](../../apps/desktop/tests/request-tab-drag.test.ts), [desktop-polish](../../apps/desktop/tests/desktop-polish.test.ts), nativní tažení. |
| T01–T07 | [type-to-focus](../../apps/desktop/tests/type-to-focus.test.ts), browser komponenty s reálným focus/scroll/range, keyboard a touch. |
| K01–K05 | [keybindings](../../packages/config/tests/keybindings.test.ts), testy v [shortcuts.rs](../../apps/desktop/src-tauri/src/shortcuts.rs), nativní klávesnice, vlastní binding a jeho keycap/tooltip. |
| M01–M04 | Testy window/tray adapterů, skutečné vytvoření/zničení okna, monitor a Dock interakce. |
| A01–A08 | Nativní Android build/instalace, nezávislý runtime a listener, IME/Back, phone/TV/OEM podle podpory; běžná/live prezentace, akce a dokončení mimo UI. |
| S01–S04 | Resolver konfigurace, [settings](../../apps/desktop/tests/settings.test.ts), změna scope/zdroje, reset, souběžné uložení a skutečná aplikace restart/live hodnoty. |
| P01–P13 | Příslušné settings/editor/feed/queue testy a konkrétní uživatelská cesta; picker cancel, file drop, odstranění řádku během čtení a nepodporovaný typ. |
| V01–V05 | Skutečné stavy komponent, přerušení animace, reduced motion, význam highlightů, kontrast a srovnání variant; nově přidaná témata ověřit jednotlivě. |
| D01–D04 | Ověřený balíček, podpis, staging upgrade, post-publication check a evidence cílového kanálu. |

Lokalizace má vlastní [přijímací scénáře](production-app-localization-plan.md#přijímací-scénáře). Změna jazyka musí projít i nativní vrstvou a delšími texty, ne pouze snapshotem jedné přeložené stránky.

Tato tabulka říká, jak jednotlivé vzory ověřovat; neprohlašuje všechny scénáře za nově provedené při sepsání katalogu. Každý další projekt eviduje svůj vlastní commit, balíček, systém, vstup a výsledek. Katalog doplň při každé přijaté UX změně současně se změnou jejího receptu a regrese.
