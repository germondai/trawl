# Specifikace nové aplikace pro více platforem

Zkopíruj tento formulář do dalšího projektu a vyplň ho před tvorbou shellu. Rozhodnutí, která se produktu netýkají, označ „netýká se“ a krátce vysvětli proč. Nevydávej nevyplněnou matici za podporu platformy.

Pravidla a příklady jsou v [hlavním průvodci](production-app-blueprint.md). Vizuální návrh začíná u [tokenů](production-app-starter-tokens.css).

Konkrétní zavedené chování projdi podle [referenčního katalogu TRAWLu](trawl-interaction-catalog.md). Je součást specifikace, ne nepovinná četba po implementaci.

## Produkt a první vydání

| Rozhodnutí | Hodnota |
| --- | --- |
| Název, package ID a vlastník vydání | DOPLNIT |
| Komu produkt slouží a jaký problém řeší | DOPLNIT jednou větou |
| Hlavní cesta od vstupu k výsledku | DOPLNIT konkrétní scénář |
| Co patří do prvního vydání | DOPLNIT |
| Vědomě odložené funkce | DOPLNIT |
| Lokální, vzdálená nebo kombinovaná data | DOPLNIT |
| Citlivá data, oprávnění a pravidla retence | DOPLNIT |
| Licence projektu a přebíraných částí | DOPLNIT |

## Deklarovaná podpora

Přidej řádek pro každou skutečně vydávanou kombinaci. Například macOS ARM64 DMG a Android ARM64 APK jsou dva konkrétní cíle. Desktop x64 a ARM64 nemají automaticky shodné nativní závislosti.

| OS a minimální verze | Architektura a zařízení | WebView nebo browser | Hlavní vstupy | Kanál | Stav ověření a evidence |
| --- | --- | --- | --- | --- | --- |
| DOPLNIT | DOPLNIT | DOPLNIT | DOPLNIT | DOPLNIT | Plánováno |

Podporované změny prostředí: DOPLNIT rotaci, multiwindow, DPI, více monitorů, změnu vstupu, velký text, RTL a reduced motion podle zvolených profilů.

## UX rozhodnutí

| Oblast | Produktové pravidlo |
| --- | --- |
| Hlavní cíle a primární akce | DOPLNIT |
| Široké, střední a kompaktní rozvržení | DOPLNIT |
| Co určuje skutečný runtime capability | DOPLNIT |
| Back/Forward a kořenová obrazovka | DOPLNIT |
| Focus při příchodu a po zavření dialogu | DOPLNIT |
| Výchozí zkratky a editovatelná mapování | DOPLNIT |
| Menu, dialog, drawer a plná stránka | DOPLNIT kdy co použít |
| Scroll, drag, refresh a alternativy gest | DOPLNIT |
| Neuložené změny a ukládací lišta | DOPLNIT |
| Výběr a kopírování uživatelských dat | DOPLNIT |
| Téma, hustota a identita produktu | DOPLNIT |
| System/light/dark preference a efektivní téma | DOPLNIT skutečně podporované režimy, první paint, nativní chrome a chování při změně OS |
| Plovoucí akce a motion | DOPLNIT geometrii, kolize se save barem/IME, enter/leave/move, přerušení a reduced motion |
| Počet instancí a nezávisle počet oken | DOPLNIT včetně aktivace existující instance a otevření souboru/deep link |

Napiš přesný výsledek pro tyto situace:

- Uživatel odchází z rozpracovaného formuláře: DOPLNIT.
- Jiný katalog přijde až po obnovení staré kategorie: DOPLNIT.
- Uživatel začne psát, zatímco nic editačního není aktivní: DOPLNIT.
- Gesto začne v oblasti s vlastním scrollem: DOPLNIT.
- Klávesnice nebo velký text zmenší dostupnou výšku: DOPLNIT.

## Převzetí konkrétních receptů

U každé skupiny zkontroluj všechny uvedené recepty. Stav vyplň jako převzato/přizpůsobeno/nepoužito a doplň důvod, cílový modul a kontrolu. Přizpůsobení vzhledu nesmí bez rozhodnutí odstranit vlastnictví gesta, cancel, focus, inset nebo jinou součást chování.

Pokud se volby uvnitř skupiny liší, rozepiš konkrétní ID samostatně. Skupinový řádek není oprávnění část receptů přeskočit.

| Recepty z katalogu | Stav a rozdíly pro tento produkt | Cílový modul a ověření |
| --- | --- | --- |
| L01–L10 rozvržení, sidebar, spodní/horní/ukládací bar a animace plovoucích akcí | DOPLNIT | DOPLNIT |
| N01–N05 historie, popupy, guardy, modaly/drawery a geometrie overlayů | DOPLNIT | DOPLNIT |
| G01–G04 vratný trackpad, axis lock, release/momentum a indikátor | DOPLNIT | DOPLNIT |
| G05–G07 mobilní refresh gesto, kresba/rotace/zatažení a single-flight načítání | DOPLNIT | DOPLNIT |
| G08–G11 drawer scroll/drag, request taby a nativní tažení okna | DOPLNIT | DOPLNIT |
| T01–T07 type-to-focus, Find, palette, tooltipy, kopírování a scrollbary | DOPLNIT | DOPLNIT |
| K01–K05 zkratky, recorder, migrace, Quit, Escape a keycaps | DOPLNIT | DOPLNIT |
| M01–M04 macOS controls, monitory, tray, Dock a aktivace | DOPLNIT | DOPLNIT |
| A01–A08 Android insets/Back/TV, runtime, schopnosti, notifikace/live akce a jejich preference | DOPLNIT | DOPLNIT |
| S01–S04 app/instance/request scope, precedence, inherited/custom, live/restart a reset | DOPLNIT | DOPLNIT |
| P01–P13 nastavení, editory, instance, logy, drafty, preview, queue, storage a file/directory/drop | DOPLNIT | DOPLNIT |
| V01–V05 vizuální snapshot, animace, highlighty, themes a vratné UX experimenty | DOPLNIT | DOPLNIT |
| D01–D05 balíčky, aktualizace, přenos, invarianty a evidence | DOPLNIT | DOPLNIT |

## Nastavení a lokalizace

Pro každý typ nastavení uveď: scope, zdroj/precedenci, efektivní hodnotu, draft, persistenci, způsob aplikace a význam resetu. Slovo global nesmí nepozorovaně znamenat zároveň celé zařízení, jednu aplikaci a všechny vzdálené instance.

- App/device preference a přenášení mezi zařízeními: DOPLNIT.
- Instance/project/request overrides a podporovaná precedence: DOPLNIT.
- Dynamic options, hodnoty aplikované live a změny vyžadující restart: DOPLNIT.
- Reset jednoho pole, kategorie a celé konfigurace: DOPLNIT včetně ochrany nesouvisejících změn.
- Picker/upload/drop pro soubory a složky: DOPLNIT skutečné schopnosti každé platformy, path/URI/handle, limity a oprávnění.
- Notifications/live preference, kdy je práce systémově viditelná a dostupné Stop/Restart/Cancel: DOPLNIT.

Podrobný [plán lokalizace](production-app-localization-plan.md) je součást této specifikace. Vyplň rozhodnutí před tím, než se UI a nativní texty začnou rozcházet:

| Rozhodnutí | Hodnota |
| --- | --- |
| Zdrojový jazyk, fallback a podporované locale | DOPLNIT |
| System preference a synchronizace s OS per-app language | DOPLNIT podle platformy |
| Rozsah textů ve frontend/native menu/notifikacích/live aktivitách | DOPLNIT |
| Message keys, plurály, placeholders a formátování | DOPLNIT |
| Preference jazyka, časové zóny a formátovacího locale | DOPLNIT odděleně |
| Offline katalogy a jejich verzování s aplikací | DOPLNIT |
| Pseudolocale, dlouhé texty a RTL/mirroring | DOPLNIT deklarovaný rozsah a scénáře |
| Změna jazyka během práce a cold start bez WebView | DOPLNIT zachování draftů, bindingů a úloh |

## Lifecycle a data

| Událost | Chování UI | Chování práce a dat |
| --- | --- | --- |
| Zavření okna | DOPLNIT | DOPLNIT |
| Minimalizace nebo background | DOPLNIT | DOPLNIT |
| Zánik UI procesu | DOPLNIT | DOPLNIT |
| Zánik runtime procesu | DOPLNIT | DOPLNIT |
| Explicitní Quit/Stop | DOPLNIT | DOPLNIT |
| Změna účtu, projektu či instance | DOPLNIT | DOPLNIT |
| Instalace aktualizace | DOPLNIT | DOPLNIT |

- Význam automatického startu: DOPLNIT zvlášť aplikaci a případný runtime.
- Podporovaný mechanismus pozadí pro každý mobilní OS: DOPLNIT.
- Vlastnictví, limity a cancel dlouhých operací: DOPLNIT.
- Verze datového formátu, migrace a obnova: DOPLNIT.
- Co smí smazat cleanup/reset a co musí zachovat: DOPLNIT.
- Co se po přerušení bezpečně opakuje a co vyžaduje rozhodnutí: DOPLNIT.
- Potřebné notifikace, preference a běžný fallback: DOPLNIT.
- První užitečná akce, nutný setup a kontextové žádosti o oprávnění: DOPLNIT.

## Rozpočty a ověřování

U každé metriky zapiš podmínky měření, limit a naměřenou hodnotu. Například idle paměť musí uvádět, zda zahrnuje runtime, UI a pomocné procesy.

| Metrika | Referenční zařízení a scénář | Cíl nebo limit | Naměřeno a evidence |
| --- | --- | --- | --- |
| Cold a warm start | DOPLNIT | DOPLNIT | Nezměřeno |
| Idle CPU a paměť | DOPLNIT | DOPLNIT | Nezměřeno |
| Opakovaná práce a uvolnění zdrojů | DOPLNIT | DOPLNIT | Nezměřeno |
| Velký dokument nebo seznam | DOPLNIT | DOPLNIT | Nezměřeno |
| Souběžnost, fronta a timeout | DOPLNIT | DOPLNIT | Nezměřeno |
| Velikost balíčku a diskové místo | DOPLNIT | DOPLNIT | Nezměřeno |
| Background a spotřeba při nečinnosti | DOPLNIT | DOPLNIT | Nezměřeno |

Relevantní testovací příkazy a runner: DOPLNIT.

Povinná nativní/ruční ověření, která nenahrazuje browser mock: DOPLNIT.

## Build a vydání

- Toolchainy, lockfiles a podporované nativní závislosti: DOPLNIT.
- Jeden zdroj produktové verze a platformní převody: DOPLNIT.
- Identita balíčků, podpisové identity a bezpečná správa klíčů: DOPLNIT bez tajných hodnot.
- Formát distribuovaných a updater artefaktů pro každý cíl: DOPLNIT.
- Kanály stable/beta a pravidla jejich změny, pokud jsou potřebné: DOPLNIT.
- Model aktualizací podle platformy/store: DOPLNIT.
- Předchozí podporovaná verze pro upgrade test: DOPLNIT.
- Postup při neúspěšné migraci, poškozeném downloadu nebo ztrátě podpisového klíče: DOPLNIT.
- Kdo rozhoduje o publikaci a zastavení rollout: DOPLNIT.
- Místo pro release manifest, hash, podpisy a výsledek testů: DOPLNIT.

## Podmínky dokončení prvního vydání

- [ ] Hlavní workflow funguje od instalace po uložený výsledek.
- [ ] Všechny recepty katalogu mají vědomé rozhodnutí a převzaté chování má ověření.
- [ ] Pro každý deklarovaný cíl existuje evidence konkrétního balíčku.
- [ ] Klávesnice, dotyk nebo D-pad podle podpory dosáhnou všech hlavních akcí.
- [ ] Focus, screen reader, kontrast, textová velikost a relevantní reduced motion byly ověřeny.
- [ ] Dialogy, Back/Forward a neuložené změny zachovávají správný cíl a data.
- [ ] Mobilní navigace, klávesnice a ukládací lišta nezakrývají ovládání.
- [ ] Plovoucí akce, drag/drop, animace a highlighty zachovávají význam i při přerušení a reduced motion.
- [ ] Původ, scope, reset a skutečná aplikace nastavení odpovídají zobrazenému stavu.
- [ ] Deklarované theme a locale fungují offline i v nativních menu/notifikacích; dlouhé texty, plurály a fallback prošly relevantními cestami.
- [ ] Nedostupná schopnost, offline a chyba oprávnění mají správný stav a cestu pokračování.
- [ ] Zánik UI/procesu a explicitní Stop se chovají podle kontraktu.
- [ ] Opakovaný start, aktivace z launcheru a otevření souboru při tray režimu respektují vlastnictví a drafty.
- [ ] Perzistence, migrace a obnova byly ověřeny bez ztráty dat.
- [ ] UI a runtime validují privilegované operace v odpovídajících vrstvách.
- [ ] Diagnostika nevyzrazuje secrets a cleanup neodstraňuje nesouvisející data.
- [ ] Rozpočty mají reálná měření a vysvětlené výjimky.
- [ ] Čistá instalace, upgrade a neúspěšná aktualizace prošly relevantním kanálem.
- [ ] Produkční podpis, důvěra distribuce a licence odpovídají zvolenému kanálu.
- [ ] Release notes a známá omezení odpovídají skutečně ověřené podpoře.
- [ ] Vlastník vydání samostatně schválil publikaci konkrétního kandidáta.

Nevyplněný bod není automaticky „netýká se“. Před vydáním ho buď splň, nebo rozhodnutím změň deklarovaný rozsah produktu.

## Pravidla pro implementaci a další spolupracovníky

1. Produktové rozhodnutí ber z tohoto briefu; přenositelné chování z průvodce. Neodhaduj capability podle velikosti displeje.
2. Nejdříve najdi existující implementaci, potom měň nejmenší úplný rozsah.
3. Změna chování má konkrétní scénář a vhodné ověření. U bugfixu nejprve reprodukuj původní symptom.
4. UI, menu, notifikace a zkratky používají stejný validovaný příkaz.
5. Nový platformní adapter nepředstírá podporu. Neznámé nebo chybějící schopnosti mají explicitní stav.
6. Gesto má jednoho vlastníka a cleanup při všech způsobech ukončení.
7. Navigace, asynchronní odpovědi a úlohy respektují vlastníka a revizi kontextu.
8. Neuloženou práci, konfiguraci, uživatelské soubory a tajné údaje chraň také v chybových cestách.
9. Vizuální experiment má uloženou přijatou variantu a kontrolovatelný návrat. Nemíchej do něj nesouvisející refaktoring.
10. Framework rozšiřuj pro reálnou potřebu více spotřebitelů; doménu drž v aplikaci.
11. Build, test, skutečný běh a důvěryhodná distribuce jsou odlišné výsledky. Reportuj jejich přesný rozsah.
12. Publikaci, push, release nebo změnu uživatelské instalace prováděj pouze v rozsahu samostatného oprávnění.
