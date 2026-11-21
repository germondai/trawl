# Plán lokalizace šablony a aplikace TRAWL

Stav: implementace pro desktop a Android, čeká na finální ověření na fyzických zařízeních · 21. listopadu 2026

Lokalizace je součást návrhu produkční aplikace napříč platformami. Překládá její uživatelské rozhraní, nikoli identitu dat, hodnoty protokolu nebo uživatelem vytvořený obsah. Musí pokrýt také plochy, které existují bez otevřeného WebView: tray a app menu, notifikace, live aktivity, dialogy systému a chyby nativních operací.

Implementace nyní zahrnuje English, češtinu, slovenštinu, polštinu, němčinu a francouzštinu (`en`, `cs`, `sk`, `pl`, `de`, `fr`). Výchozí volba je System; jazyk se rozpozná podle zařízení a při nepodporovaném jazyce se použije English. Uložená ruční volba zůstává zachovaná. Přepínač v App settings ukládá preference na úrovni zařízení. Offline katalogy sdílejí Vue, Rust a Kotlin. Rozhraní se překládá reaktivně bez změny ID stránek, tabů, bindingů, dat požadavků nebo restartu serveru. Tento dokument dál slouží také jako obecný postup pro další aplikace a jazyky.

Konkrétní řešení: [katalogy](../../packages/config/locales/en.json), [sdílený formatter](../../packages/config/src/i18n.ts), [reaktivní UI adapter](../../apps/desktop/app/utils/localization.ts), [nativní menu](../../apps/desktop/src-tauri/src/i18n.rs) a [Android adapter](../../apps/desktop/src-tauri/gen/android/app/src/main/java/com/germondai/trawl/mobile/Localizations.kt). Formatter používá pojmenované parametry a `Intl.PluralRules`; rich text skládá bezpečný Vue komponent bez `v-html`. NuxtUI dostává odpovídající locale. Časy v detailu uvádějí místní zónu.

Nativní systémové dialogy a instalátor zůstávají v jazyce OS. Titulek již zadaného Android DownloadManager stahování se do jeho dokončení nemění; změna jazyka úlohu nerestartuje. In-app volba nezavádí samostatný systémový per-app language selector. Původní serverové a technické diagnostické zprávy se nepřepisují. RTL a jiné platformy nad rámec současného desktop/Android portu zůstávají samostatnou budoucí etapou.

## Co musí být rozhodnuté

| Rozhodnutí | Návrh pro první implementaci |
| --- | --- |
| Referenční jazyk | Zachovat angličtinu jako fallback a stabilní zdrojový katalog. |
| Další implementované jazyky | Čeština, slovenština, polština, němčina a francouzština. |
| Preference jazyka | Výchozí System nebo konkrétní podporovaný locale; ukládá se na úrovni aplikace/zařízení. |
| Platnost preference | UI, nativní menu, notifikace a živé aktivity používají tentýž efektivní jazyk. |
| Změna jazyka | Zachová drafty, aktivní instanci, taby, historii a probíhající práci; nepotřebuje restart scraping serveru. |
| Nedostupný překlad | Funkční fallback a kontrolovatelný missing-key stav ve vývoji; žádný prázdný button. |
| Distribuce textů | Jazyk potřebný pro start je dostupný offline v balíčku. |
| Další jazyky a RTL | Přidávají se jako zvlášť ověřené locale, ne jako nezkontrolovaný strojový dump. |

Jazyk UI, formátovací locale, časová zóna a fyzický keyboard layout jsou odlišné hodnoty. Čeština v UI nemění význam Cmd/Ctrl, API enumy ani serverový timestamp. Nepoužívej IP geolokaci nebo vybranou vzdálenou instanci jako tichý přepis osobní jazykové preference.

Rozlišení System preference má definované pořadí podporovaných jazyků a regionální fallback, například `cs-CZ → cs → en`, pokud právě tyto katalogy produkt dodává. Ukládej uživatelovu volbu odděleně od výsledného locale. Chybějící regionální varianta nemá změnit System na náhodně trvalou ruční volbu.

## Inventář všech uživatelských textů

| Plocha | Co převést | Referenční místo v TRAWLu |
| --- | --- | --- |
| Shell a navigace | Názvy stránek, tooltipy, overflow menu, aria-label a empty states. | [app.vue](../../apps/desktop/app/app.vue), [ShellHeader](../../apps/desktop/app/components/ShellHeader.vue), [MobileNavigation](../../apps/desktop/app/components/MobileNavigation.vue). |
| Command palette a Find | Skupiny, akce, placeholdery, počty shod, přístupné názvy. | [ShellCommands](../../apps/desktop/app/components/ShellCommands.vue), [PageFind](../../apps/desktop/app/components/PageFind.vue). |
| Nastavení | Labely, popisy, původ hodnot, validační chyby, preset metadata a restart hinty. | [settings utilities](../../apps/desktop/app/utils/settings.ts), [catalog](../../packages/config/src/catalog.ts), [ServerSettings](../../apps/desktop/app/components/ServerSettings.vue). |
| Request editor a historie | Popisky, tab default names, statusy, chyby, informační dialog a validace. | [RequestWorkbench](../../apps/desktop/app/components/RequestWorkbench.vue), [RequestHistory](../../apps/desktop/app/components/RequestHistory.vue). |
| Zkratky a Quit | Labely akcí a Hold/Release/Press again věty, nikoli překlad hodnoty bindingu. | [keybindings definitions](../../packages/config/src/keybindings.json), [app.vue](../../apps/desktop/app/app.vue). |
| macOS/desktop menu a tray | Příkazy, položky instancí, dostupnost, dynamické Start/Stop a kontextové texty. | [tray.rs](../../apps/desktop/src-tauri/src/tray.rs), [desktop.rs](../../apps/desktop/src-tauri/src/desktop.rs), [keybindings.rs](../../apps/desktop/src-tauri/src/keybindings.rs). |
| Android notifikace a live prezentace | Title/body/action labels, počty, krátký stav, channel name a OEM texty podle adapteru. | [RuntimeService](../../apps/desktop/src-tauri/gen/android/app/src/main/java/com/germondai/trawl/mobile/RuntimeService.kt), [FocusNotifications](../../apps/desktop/src-tauri/gen/android/app/src/main/java/com/germondai/trawl/mobile/FocusNotifications.kt). |
| Desktop completion oznámení | Request/download success a failure, návrat do aplikace. | [lib.rs](../../apps/desktop/src-tauri/src/lib.rs), [runtime.rs](../../apps/desktop/src-tauri/src/runtime.rs). |
| Aktualizace a instalace | Stav feedu, progress, restart/permission potvrzení a chyby. | [ApplicationUpdates](../../apps/desktop/app/components/ApplicationUpdates.vue), [updates.rs](../../apps/desktop/src-tauri/src/updates.rs), [AppUpdates.kt](../../apps/desktop/src-tauri/gen/android/app/src/main/java/com/germondai/trawl/mobile/AppUpdates.kt). |
| Native pickery a recovery | Vlastní title/description, první start, nepřipravené okno a bezpečný fallback. | [setting_paths](../../apps/desktop/src-tauri/src/setting_paths.rs), [window_chrome](../../apps/desktop/src-tauri/src/window_chrome.rs). |

Součást inventáře jsou také méně viditelné stavy: disabled reason, screen-reader-only label, konec fronty, chyba clipboardu, souběžné ukládání a odmítnuté oprávnění. Dokumentace, release notes a store listing jsou samostatné textové produkty; nepředstírají překlad každého vydání automaticky.

## Stabilní zprávy a zdroj dat

Definuj sémantické klíče například `navigation.overview`, `actions.restart`, `updates.feedUnavailable`, `notifications.requestCompleted` a `settings.unsavedCount`. Klíč nemá být celá anglická věta ani název souboru, který se při refaktoringu změní.

Odděl message key, překlad, interpolované argumenty a technické ID. `DNS_RESOLVER`, `cloudflare`, action ID, connection ID, názvy souborů, URL, HTTP metody, API field a uložená hodnota zůstávají stejné. Překládá se jejich label, nikoli identita. Rename automaticky vygenerovaného názvu tabu nesmí změnit ID nebo svévolně přejmenovat uživatelův vlastní tab.

Používej celé věty s pojmenovanými argumenty. Počet změn nebo requestů má pluralizaci podle cílového jazyka; neskládej větu z anglického pořadí několika fragmentů a ručního `count === 1`. Datum, čas, čísla, jednotky a relativní čas centralizuj přes vhodné formátovací rozhraní. Standardní základ poskytuje [ECMAScript Intl](https://tc39.es/ecma402/); jednotlivé podporované funkce ověř v cílových WebView.

Server může vracet stabilní error code a argumenty, které klient bezpečně přeloží. Neznámý serverový text zůstává čitelný detail s obecným lokalizovaným vysvětlením; nepřekládej technické logy nespolehlivým hádáním stringů. Během postupné migrace označ, které chyby už mají strukturovaný model. Translator text není důvěryhodné HTML a neobchází escaping ani CSP.

Hledání a řazení mají vlastní jazykový kontrakt: rozhodni porovnávání diakritiky a velikosti písmen, zachovej dohledání technického klíče a původní text pro kopírování. Normalizace pro search nesmí změnit uložená data ani rozbít indexy Range highlightů ve viditelném textu. Identifikátory, verze a protokolové hodnoty se neřadí náhodně jinak jen kvůli přeloženému labelu.

Jeden zdroj pravdy pro sdílené zprávy může při buildu vytvářet frontend katalog a nativní resources s kontrolou klíčů a placeholderů. Nemusí sdílet jeden vykonávaný runtime nebo přinést JS engine do notifikační služby. Platformní zpráva s jiným významem může mít vlastní klíč; nezneužívej jednu obecnou větu pro všechny kontexty.

## Frontend a offline balíček

Pro Nuxt referenční implementaci zvaž Nuxt I18n/Vue I18n podle skutečných potřeb. TRAWL používá vlastní workspace historii, takže změna locale nemá vytvářet nové prefixované stránky nebo měnit význam Back/Forward. Případná routovací strategie `no_prefix` je dokumentovaná možnost; její význam a závislost na Nuxt pages ověř podle [Nuxt I18n routing](https://i18n.nuxtjs.org/docs/guide/).

První varianta může zabalit malé podporované katalogy přímo. Lazy loading přidej až při smysluplné velikosti a ověř v zabalené statické aplikaci bez Nitro serveru, veřejného CDN i sítě. Jazyk pro první paint a fallback musí být k dispozici dříve, než se odkryje okno. Relevantní bundling/runtime volby popisuje [Nuxt I18n options](https://i18n.nuxtjs.org/docs/api/options/); konkrétní verzi a konfiguraci vyber při implementaci, nikoli podle starého příkladu.

Reaktivní změna locale přeloží computed menu/palette i dlouho otevřené dialogy. Pole s uživatelskými daty a rozpracovaný JSON/body se nepřepíší. Pokud přeložený label změní geometrii, přepočítají se nativní controls, collision boundaries, highlight rects a výška save baru. Nevynucuj remount celé aplikace jako náhradu správné reaktivity.

## Nativní vrstvy a systémová preference

Preference musí mít čitelnou podobu i bez WebView. Adapter vyřeší podporovaný locale, fallback a bezpečné uložení; runtime proces ji umí načíst po cold startu. Změna jazyka předá novou preference revizi a obnoví relevantní nativní prezentace. Nespouští druhou úlohu a nesmaže vlastníka existující služby.

Tray a application menu se přestaví se zachováním ID, acceleratorů, zaškrtnutí a enabled stavů. Překlad Start/Stop nebo názvu akce není změna skutečného příkazu. Notifikace a live aktivity si zachovají důležité Stop/Restart/Cancel akce, tokeny a pending-intent identitu; opětovné přeložení nesmí znovu zvukově oznámit již běžící práci.

Android může mít také systémovou per-app language volbu. Tu je potřeba vědomě sladit s in-app preference a podporou starších cílových verzí. Samotné přidání jazyka do systémového seznamu nepřeloží resources; viz [Android per-app languages](https://developer.android.com/guide/topics/resources/app-languages). UI a foreground service nesmějí dlouhodobě ukazovat dvě rozdílné preference po restartu jedné z nich.

Na Apple platformách a dalších desktopových prostředích vyber odpovídající nativní resource mechanismus a synchronizaci preference podle konkrétního adapteru. Tato část je návrh implementace, nikoli tvrzení o již dokončeném iOS portu TRAWLu.

## Dlouhé texty RTL a přístupnost

Pseudolokalizace odhalí layout před dokončením reálných překladů: prodluž popisky, přidej diakritiku a ověř header, mobile bottom bar, keycaps, footer, queue, setting label a potvrzovací drawer. Nepřenášej dnešní krátké anglické šířky jako pevnou podmínku. Text scaling a wrap nesmějí zakrýt Save nebo způsobit trvale velký prázdný footer.

RTL se testuje odděleně. Používej logické CSS vlastnosti tam, kde popisují význam, a konkrétně rozhodni o směrových ikonách/animacích. Back/Forward, tab reorder a boční gesture indikátor musejí odpovídat zvolené navigační konvenci; neměň jen textový směr, zatímco glyph a native gesto stále znamenají něco jiného. Fyzické levé/pravé affordance lze vědomě zachovat, ale musí to být jednotné a otestované rozhodnutí.

Uživatelovy URL, paths, kód a další text mohou mít jiný směr než okolí. Používej odpovídající izolaci a `dir` podle obsahu místo ručního otáčení stringů; viz [W3C bidi markup](https://www.w3.org/International/articles/inline-bidi-markup/). Značení neznámého směru nebo technických úseků neznamená, že se mají překládat jejich hodnoty.

Synchronizuj `html lang`, případné `dir`, screen-reader-only názvy a lokalizované live-region statusy. Nečti každou změnu počítadla jako nový důležitý alert. Urbanist ani jeden fallback font automaticky nedokazují pokrytí všech písem; podporované jazyky ověř s reálnými glyphy a nativními font fallbacky.

## Etapy lokalizace TRAWLu

1. **Zahájení:** po dalším testování současného stavu potvrdit rozsah jazyků a samostatně zahájit implementaci. Zachovat přijaté chování a regresní scénáře shellu/gest.
2. **Inventář:** najít texty ve Vue/TS, Rustu, Kotlinu, sdíleném settings catalogu a generated assets. Rozlišit uživatelský text, technickou hodnotu, soukromý obsah a původní serverový log.
3. **Model:** zvolit klíče, fallback, preference rozsah, formátování, nativní resources a offline build. Migrace staré konfigurace ponechá funkční výchozí jazyk bez ztráty jiných voleb.
4. **Jedna celá cesta:** přeložit například App settings → změna jazyka → potvrzení → native menu/notice → cold restart. Ověřit, že si všechny vrstvy rozumějí a draft přežije.
5. **Zbytek rozhraní:** postupně převést ostatní plochy, přístupné labely, preset metadata, errors a dynamické počty. Nezaměnit label s ID ani změnit API chování.
6. **Kontroly:** missing/unused klíče, shoda placeholderů, plural cases, pseudolocale, RTL podle deklarace, offline launch a skutečná nativní oznámení při zavřeném UI.
7. **Release:** jazyková completeness matice, upgrade staré konfigurace, podporované locale v distribučním kanálu a stejné verze web/native katalogů. Nový jazyk se označí za podporovaný až po jeho příslušných cestách.

Etapy 1–5 jsou implementované v současném pracovním stromu. Etapa 6 má automatické kontroly úplnosti katalogů, placeholderů a plurálů, migrace konfigurace, zachování identit a stavu. Přepnutí všech šesti jazyků se ověřilo v desktopovém i Android rozložení prohlížeče se simulovaným nativním IPC, včetně názvů pro čtečku a zachování draftu. Prošlo produkční sestavení frontendu, kontrola Rustu pro macOS/Android a kompilace Kotlinu; všech šest Android asset katalogů odpovídá zdrojům. Fyzická kontrola všech nativních povrchů, zvětšeného textu a jazykových korektur zůstává součástí předrelease ověření. Etapa 7 není provedená: žádné nové vydání ani publikace nepřibývá automaticky. Španělština a brazilská portugalština jsou návrhy pro další etapu, nikoli zahrnuté jazyky.

## Přijímací scénáře

- Změna locale během editace zachová přesné hodnoty, active tab/instance a dirty stav.
- Back/Forward nepřidá navigační krok jen kvůli změně jazyka a neztratí dialog.
- Keycaps odpovídají skutečnému custom bindingu, Quit Hold/Release text je přeložený a Escape ho stále zruší.
- Native menu a běžná notifikace/live prezentace mají stejný jazyk, včetně cold startu bez WebView.
- Počty mají správné plurály, datum/čas jasnou zónu a protokolové exporty zůstávají strojově čitelné.
- Search najde lokalizovaný label i potřebný původní technický settings klíč; Find označí skutečně viditelný text.
- Dlouhé labely, zvětšený text a případné RTL nezakryjí menu, refresh indikátor, CTA, Save ani Stop/Restart.
- Chybějící nebo neznámý locale má funkční fallback, nikoli prázdné ovládání či raw message key v produkčním UI.
- Celá zvolená jazyková cesta funguje ze zabalené aplikace offline, po upgrade i po zániku UI procesu.

Při použití v jiném projektu rozhodni stejná témata znovu podle jeho dat a platforem; nepřenášej konkrétní TRAWL ID ani technický scraper slovník jako obecnou povinnost šablony.
