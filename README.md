# Bankomat Clicker

Widowisko 3D w Three.js dla widzów streama na **Kick.com**, zbudowane na
modelach Kenney (CC0). To **nie jest** kliker dla jednego gracza — streamer
tylko patrzy i czasem klika, a cała progresja napędzana jest aktywnością
czatu. Widzowie piszą `klik` na czacie, żeby uderzyć w bankomat, zdobyć
miejsce w rankingu Top 10 i pchnąć bankomat na kolejny, lepszy tier.

## Uruchomienie

```bash
cd "G:/Nowy folder (2)/bankomat-clicker" && python serve.py
```

Potem otwórz http://localhost:8000

Gra **musi** iść przez serwer HTTP — otwarta z `file://` nie wczyta modeli GLB
(blokada CORS). `serve.py` wyłącza cache dla plików `.js`/`.html`/`.css`, więc po
edycji kodu wystarczy F5; assety zostają cache'owane, żeby nie zasypywać serwera.

Port można podać jako argument: `python serve.py 8080`.

## Jak to działa

- **Wspólna pula czatu** — licznik w lewym górnym rogu to NIE portfel gracza,
  tylko łączny dorobek całego czatu. Każdy `klik` widza dokłada do tej puli
  ORAZ do indywidualnego dorobku tego widza w rankingu Top 10.
- **Automatyczny awans tieru bankomatu** — bankomat sam awansuje na kolejny
  model, gdy łączna liczba klików przekroczy próg (0 / 100 / 500 / 2000 /
  8000 / 25000 — patrz `MACHINE_TIER_CLICK_THRESHOLDS` w `src/economy.js`).
  Awans podmienia model 3D i pokazuje baner na górze ekranu. Do progu liczą się
  kliki z czatu **oraz** kliknięcia streamera myszką w model — obie drogi idą
  przez tę samą funkcję `obsluzAwansTieru()` w `main.js`, więc tak samo odpalają
  banery i walki z bossem. Uwaga: streamer może więc sam wyklikać awans i
  wywołać bossa bez udziału czatu.
- **Złotówki wyłącznie z kliknięć** — w grze NIE MA żadnego dochodu
  pasywnego. Bankomat sam z siebie nie produkuje nic; pula rośnie tylko
  wtedy, gdy ktoś naprawdę kliknie (komenda `klik` na czacie albo kliknięcie
  streamera w model).
- **Pracownicy = awatary Top 10** — każdemu z 10 widzów w rankingu Top 10
  przypisany jest jeden z 10 modeli postaci w scenie. Awatar odgrywa animację
  uderzenia w bankomat dokładnie wtedy, gdy jego widz napisze `klik` — nigdy
  sam z siebie.
- **Krytyczne kliknięcia** — stała szansa 5% na trafienie krytyczne, stały
  mnożnik ×3. Nic się tu nie kupuje.
- **Kombo czatu** — szybkie klikniecia od widzów (dowolnych, pod rząd, w
  krótkim oknie czasu) podbijają wspólny mnożnik zarobku. Wygasa po przerwie
  w klikaniu.
- **Złota moneta** — pojawia się co 10 s na losowym, wolnym polu siatki areny
  (znika po 25 s, jeśli nikt jej nie zbierze). NIE jest klikalna myszką -
  zbiera ją pierwszy awatar Top 10, który do niej dobiegnie (patrz "Chodzenie
  po siatce" niżej), i zgarnia 25 zł do wspólnej puli oraz do swojego dorobku
  w rankingu. Zebranie monety NIE liczy się jako komenda "klik" - licznik
  klików widza w rankingu rośnie wyłącznie od realnego "klik" na czacie.
- **Chodzenie po siatce 2D** — każdy widz z przypisanym awatarem (Top 10) może
  ruszać swoją postacią komendami na czacie: `up`/`w`/`góra`, `down`/`s`/`dół`,
  `left`/`a`/`lewo`, `right`/`d`/`prawo` (i kilka polskich wariantów, np.
  "w lewo", "do przodu"). Kierunki są WZGLĘDEM tego, gdzie postać aktualnie
  patrzy (jak sterowanie "zza pleców postaci"), nie względem osi świata -
  `left`/`right` obracają postać o 90° i robią krok, `up`/`down` to krok do
  przodu/tyłu względem aktualnego zwrotu. Postać nie wychodzi poza arenę 7×7
  ani nie wchodzi na pole bankomatu (0,0) - w takich przypadkach tylko się
  obraca w tę stronę. **Kolizje między postaciami są wyłączone**: kilku widzów
  może stać na tym samym polu i przechodzić przez siebie, więc nikt nikomu nie
  blokuje drogi i cała siatka jest dostępna dla każdego. Konsekwencja: postacie
  na wspólnym polu nachodzą na siebie wizualnie, a atak obszarowy bossa trafia
  całym polem, więc jedna rakieta może zabić kilka osób naraz.
- **Feed powiadomień bossa** — w trakcie walki z bossem Kamilem Kovalenko
  (patrz niżej) w prawym dolnym rogu ekranu pojawiają się kolejno karty z
  najważniejszymi zdarzeniami walki (trafienie, "zabicie" widza, omdlenie,
  ratunek, tryb awaryjny) - maksymalnie 4 naraz, najstarsze znikają.

Stan zapisuje się sam do `localStorage` co 5 s i przy zamykaniu karty.

## Struktura

| Plik | Rola |
|---|---|
| `src/main.js` | bootstrap, pętla klatek, spięcie modułów |
| `src/scene.js` | renderer, kamera, światła, pokój z kafli 1×1 |
| `src/assets.js` | ładowanie GLB z cache, retry i limitem współbieżności |
| `src/machine.js` | model automatu, podmiana tieru, raycast i animacja kliknięcia |
| `src/workers.js` | awatary Top 10, klony szkieletów, animacje `idle`/`interact-right`, ruch po siatce 2D (`moveWorker` - bez kolizji między postaciami), synchronizacja pozycji (`getSyncState`/`applySync`) |
| `src/coins.js` | pula 120 monet z lotem po łuku |
| `src/goldcoin.js` | złota moneta na siatce areny - spawn, znacznik czasu na podłodze, zbieranie przez dobiegnięcie awatara |
| `src/economy.js` | stan wspólnej puli czatu, wartość kliknięcia, progi awansu tieru, zapis/odczyt |
| `src/ui.js` | HUD (pula, postęp do awansu, kombo, reset), widget czatu Kick, ranking, feed powiadomień bossa (`showBossNotification`) |
| `src/kick.js` | integracja z czatem Kick.com (Pusher WebSocket), detekcja komendy "klik", eliminacje bossa, `normalizeNick`/`stripNickPrefix` (współdzielone przez cały kod) |
| `src/vanessa.js` | złodziejka Vanessa - FSM, kradzież zł, przepędzanie, `normalizePolish`/`showTopAnnouncement` (współdzielone też przez bossa) |
| `src/boss.js` | boss "Kamil Kovalenko" - cutscenka, walka matematyczna, ataki na pola, tryb awaryjny odpowiedzi, `BOSS_DEFS` |
| `src/bossattack.js` | efekty ataków obszarowych bossa - znaczniki pól, pociski po łuku, spadające rakiety, kałuże i dym |
| `src/format.js` | skrócona notacja liczb (1.5K, 2.3M) |
| `src/city.js` | proceduralne miasto w tle areny (budynki, ulice, jeżdżące samochody) |
| `src/audio.js` | dźwięki gry - `AudioManager` na Web Audio API, mapa zdarzeń `SOUND_MAP`, limitowanie głosów, wyciszenie/głośność (patrz sekcja "Dźwięki" niżej) |
| `src/realtime.js` | klient WebSocket przekaźnika - stała `URL_RELAYA`, auto-reconnect, cichy fallback (patrz "Synchronizacja w czasie rzeczywistym") |
| `server/server.js` | samodzielny serwer-przekaźnik (Node + `ws`) - NIE symuluje gry, tylko rozgłasza stan hosta widzom; własne `server/README.md` |

Assety są skopiowane do `assets/arcade/` i `assets/dungeon/` — **osobno**, bo
oba pakiety mają plik `Textures/colormap.png` o tej samej nazwie i różnej treści,
a każdy `.glb` ładuje teksturę względnym URI. Nie spłaszczaj tych folderów.

## Integracja z Kick.com & Ranking Top 10

Gra łączy się na żywo z czatem kanału **patiro** na Kick.com przez WebSocket Pusher (`ws-us2.pusher.com`, chatroom `37663`):
- **Czat na żywo**: Widzowie widzą swoje wiadomości w dedykowanym widżecie w prawym dolnym rogu.
- **Komenda `klik`**: Każda wiadomość o treści `klik` (lub `!klik`) wywołuje kliknięcie w automat, nalicza zarobek do wspólnej puli czatu, dodaje punkty widzowi w rankingu i liczy się do progu awansu tieru automatu.
- **Stały Leaderboard**: Zawsze widoczna lista Top 10 widzów, którzy wygenerowali najwięcej zysku (z medalami 🥇🥈🥉, kolorami nicków z Kicka i przypisanymi rolami).
- **Awatar pracownika dla każdego z Top 10**:
  - Każdej osobie z Top 10 przypisywany jest jeden z 10 modeli pracowników w świecie 3D.
  - Awatar odgrywa animację uderzenia w bankomat tylko wtedy, gdy jego widz napisze `klik` na czacie.
  - Nad głową postaci unosi się plakietka z pozycją w rankingu oraz nickiem.
  - Każda kolejna wiadomość napisana przez tego widza na czacie pojawia się w animowanym dymku komiksowym nad głową jego postaci w 3D!
- **Złodziejka Vanessa (Losowy event)**:
  - W losowych odstępach czasu z jednego z narożników areny zakrada się Vanessa (`🦹‍♀️ Vanessa`), pod warunkiem że w Top 10 rankingu widzów jest ktoś z dodatnim dorobkiem w zł - w przeciwnym razie nie ma kogo okraść i Vanessa się nie pojawia.
  - Jej ofiarą jest losowo wybrany widz z Top 10 rankingu. Vanessa podchodzi pod jego postać (pracownika) i co 0,8 s zabiera mu porcję (ok. 5%) jego dorobku w zł - nie kliknięć! Statystyka liczby komend "klik" w rankingu pozostaje nietknięta.
  - **Przegonienie**: kliknięcie na jej model/plakietkę (przez gracza) albo wpisanie jej sekretnego hasła na czacie (przez widza) każe jej uciekać w panice sprintem. W obu przypadkach do gry wraca **`max(10, połowa ukradzionej kwoty)` zł** - czyli zawsze co najmniej 10 zł, a jeśli połowa łupu przekracza 10 zł, wraca dokładnie połowa; reszta przepada bezpowrotnie razem z nią, więc nic nie jest dodrukowywane. Gdy przegania ją gracz (streamer), odzyskana kwota trafia do WSPÓLNEJ PULI CZATU; gdy przegania ją widz hasłem, odzyskana kwota trafia na jego konto w rankingu (jako odzyskana kwota, nie świeży zarobek).
  - Jeśli Vanessa nie zostanie przepędzona w porę, ucieka z całym łupem - ofiara traci go bezpowrotnie.

## Boss: Kamil Kovalenko

Przy KAŻDYM awansie tieru bankomatu wyskakuje boss - na razie zaimplementowany
tylko pierwszy (`src/boss.js`, tablica `BOSS_DEFS` indeksowana numerem tieru,
wypełniony tylko indeks 1 - kolejni bossowie to `null`, czyli awans na te
tiery przebiega po staremu, bez walki). Boss to `wheelchair-deluxe` (Kenney
mini-characters) + `character-male-f`, złożone w jedną grupę i wyskalowane
×3 względem zwykłych postaci.

- **Trigger**: gdy czat wbije próg klików na kolejny tier i ten boss nie był
  jeszcze pokonany, zamiast natychmiastowego awansu odpala się `boss.start(tier)`.
  Awans bankomatu (podmiana modelu + baner) jest odłożony do momentu pokonania
  bossa - `economy.state.machineTier` jest już podniesiony (liczy się do progów),
  ale model 3D i baner czekają.
- **Cutscenka (~5 s)**: czarne pasy (letterbox) wjeżdżają z góry i dołu, karta
  tytułowa "KAMIL KOVALENKO / SZEF WSZYSTKICH BANKOMATÓW", kamera na ten czas
  przechodzi pod pełną kontrolę bossa (kinowy najazd, `controls.enabled = false`)
  i wraca do pozycji wyjściowej na koniec. Boss wjeżdża z korytarza z tyłu sceny,
  okrąża bankomat driftem i w nim uderza - bankomat zostaje przechylony
  (`rotation.z ≈ 0.35`) na cały czas walki, komenda `klik` z czatu działa dalej
  normalnie. Boss zatrzymuje się w środku kręgu graczy, ZA bankomatem (patrząc
  od kamery), twarzą do kamery - przy skali ×3 postój przed bankomatem zasłaniał
  całą scenę, więc bankomat i pracownicy zostają widoczni przez całą walkę.
- **Walka**: 100 HP. Nad głową bossa plakietka z nazwą, paskiem HP i dymkiem z
  działaniem matematycznym (`+ - × ÷`, wynik zawsze całkowity i nieujemny) oraz
  paskiem odliczania 8 s. Każda wiadomość z czatu, w której którykolwiek token
  po oczyszczeniu (`replace(/[^\d-]/g,'')`) zgadza się z wynikiem, to trafienie -
  liczy się pierwsza poprawna odpowiedź. Trafienie zabiera 5 HP (20 trafień =
  pokonanie), po ~1,2 s pojawia się nowe działanie. Odpowiadający NIE dostaje
  złotówek ani klików - to czysta minigra, ranking się nie zmienia.
  Normalnie odpowiadać mogą tylko osoby z Top 10 z przypisanym pracownikiem
  (i tylko jeśli nie są aktualnie omdlone) - ale jeśli w danym momencie nie ma
  ANI JEDNEJ takiej osoby (ranking pusty albo wszyscy uprawnieni omdleli),
  boss przełącza się w **tryb awaryjny** i przyjmuje odpowiedź od KAŻDEGO
  widza czatu, żeby walka nigdy nie zaklinowała się na amen - w feedzie
  bossa pojawia się wtedy widoczny komunikat "⚠️ TRYB AWARYJNY!".
- **Kara za brak odpowiedzi - ostrzał rakietowy**: po 8 s boss wyciąga wyrzutnik
  (`blaster-e` doczepiony do kości `arm-right`, klip `holding-right-shoot`),
  strzela w górę i **10 pól planszy zostaje oznaczonych na czerwono**. Po 2,6 s
  spadają na nie rakiety - ginie każdy, kto w chwili uderzenia stoi na
  oznaczonym polu: traci CAŁY dorobek i znika z rankingu
  (`kickChat.eliminateUser`), awatar gra `die` i po ~2,5 s znika ze sceny.
  To NIE jest ban - eliminacja nie blokuje powrotu, nawet w trakcie trwającej
  walki: widz wraca do Top 10 od zera, gdy tylko napisze kolejne "klik".
  **Nie ma tu losowania ofiary** - o śmierci decyduje wyłącznie pozycja.
  Wzory pól też nie są losowe: cztery stałe układy (krzyż, przekątne, pierścień,
  brzegi - `WZORY_RAKIET` w `src/boss.js`) idą cyklicznie po kolei, więc widzowie
  mogą się ich nauczyć i świadomie uciekać.
- **Omdlenia - atak na pole**: co 12-22 s boss bierze na cel **losowe pole**
  areny (pomijany jest tylko środek, gdzie stoi bankomat), oznacza je na
  zielono na 1,9 s, po czym pluje na nie pociskiem. W chwili uderzenia omdlewa
  każdy, kto na tym polu stoi; kto zdążył odejść komendą ruchu, jest bezpieczny
  (w feedzie pojawia się wtedy "PUDŁO!"). Omdlały leży, plakietka dostaje 💤,
  jego `klik` i odpowiedzi są ignorowane - bez utraty pieniędzy.
  Ratunek: inny widz pisze `pomoc` (lub `!pomoc`, wielkość liter/polskie znaki
  bez znaczenia) - podnosi najdłużej leżącą osobę. Po pokonaniu bossa wszyscy
  omdleni są automatycznie ocucani.
- **Animacje bossa**: boss siedzi w wózku, więc klipy dla postaci stojącej
  (`emote-no`, `pick-up`, `holding-right-shoot`, `die`) wyglądały źle - nogi
  wymachiwały, a tułów wychodził z fotela. Bazą jest teraz zawsze
  `wheelchair-sit`, a reakcje (szarpnięcie po trafieniu, zgięcie przy
  wymiotach, podniesienie ręki z wyrzutnikiem, osunięcie się po śmierci) są
  liczone po kościach i nakładane PO `mixer.update()`. Orientacja lufy jest
  wymuszana w układzie świata, więc przy strzale zawsze celuje pionowo w górę.
  W bezczynności boss co kilka sekund rozgląda się klipami `wheelchair-look-*`.
- Efekty obu ataków (znaczniki pól, pociski, rakiety, kałuże, dym) żyją w
  `src/bossattack.js`; modele wyrzutnika, rakiety i dymu pochodzą z
  `kenney_blaster-kit` i leżą w `assets/blaster/` (własny `colormap.png`).
- **Pokonanie**: boss gra `die`, przechyla się i znika po ~3 s, bankomat wraca
  do pionu, DOPIERO WTEDY następuje właściwy awans tieru (ten sam baner
  "🎰 AWANS BANKOMATU!" co przy zwykłym awansie - tekst żyje w jednym miejscu,
  `announceTierAdvance()` w `main.js`) plus dodatkowy baner
  "🏆 KAMIL KOVALENKO POKONANY!". Numer tieru trafia do `economy.state.bossesDefeated`
  (anty-powtórka - ten boss już się więcej nie odpali).
- **Vanessa** nie pojawia się w trakcie walki z bossem (`vanessa.paused`,
  ustawiane z `main.js` na `boss.isActive()`); jeśli była w scenie w chwili
  startu bossa, zostaje odpędzona (`despawn()`).

Panel testowy: przycisk **👹 Zresp bossa** obok "Zresp Vanessę" wywołuje
`boss.start(1, { force: true })` niezależnie od `bossesDefeated`.

## Panel eliminacji (właściciel)

Przycisk **💀 Eliminacja** w HUD (obok "Zresp Vanessę"/"Zresp bossa"/"Reset gry",
widoczny tylko po zalogowaniu jako właściciel - dokładnie ten sam mechanizm
ukrywania co reszta przycisków admina, patrz `body.tryb-widza` w `style.css`)
otwiera listę aktualnego Top 10 (nick, dorobek w zł, numer slotu jeśli widz ma
akurat awatara w grze). Wybranie nicku pyta o potwierdzenie (`confirm()`) i
dopiero po nim zabija widza - skutek jest identyczny jak przy trafieniu rakietą
bossa (`BossManager._killUser`): traci cały dorobek, znika z rankingu, jego
awatar gra `die` i po ~2,5 s znika ze sceny, a wraca do gry od zera przy
kolejnym "klik". Różni się tylko treść powiadomienia w feedzie bossa - zamiast
"RAKIETA TRAFIŁA" widać "ZOSTAŁ USUNIĘTY PRZEZ STREAMERA". Działa niezależnie od
tego, czy akurat trwa walka z bossem (`BossManager.killUserManual()` woła tę
samą logikę wykonawczą co rakieta, poza kontekstem walki).

Wybór z panelu rozgłasza się widzom zdarzeniem realtime `eliminacja` (`{ nick }`,
patrz `zastosujZdarzenieZdalne()` w `main.js`), żeby animacja śmierci i
zniknięcie z rankingu były widoczne natychmiast, a nie dopiero po najbliższym
snapshocie co 2 s. Gdy ranking jest pusty, panel informuje, że nie ma kogo
eliminować.

## Log zdarzeń Vanessy

Panel **🦹‍♀️ LOG VANESSY** na dole ekranu pokazuje na żywo wszystko, co robi złodziejka.
Domyślnie jest zwinięty — rozwijasz go przyciskiem `+`, a `🗑` czyści historię.
Okno da się przeciągać, a jego pozycja zapamiętuje się między sesjami.

Każdy napad ma swój numer (`#1`, `#2`, …), a wpisy są kolorowane według typu:

| Kolor | Typ | Kiedy |
|---|---|---|
| różowy | `spawn` | pojawienie się — kogo wybrała, jej dorobek, hasło, skąd i dokąd idzie |
| czerwony | `steal` | każdy tyk kradzieży — ile zabrała, dorobek ofiary przed i po, suma łupu |
| zielony | `good` | trafienie hasła na czacie, przepędzenie — ile odzyskano, ile przepadło, komu trafiło |
| żółty | `bad` | ucieczka z łupem, gdy nikt nie zdążył zareagować |
| szary | `info` | zmiany stanu (`SNEAKING → STEALING → FLEEING`), brak ofiary, zniknięcie ze sceny |

Te same wpisy lecą do konsoli przeglądarki z prefiksem `[Vanessa #numer godzina]`. Z konsoli:

```js
window.__game.vanessa.printLog();     // ostatnie 50 zdarzeń jako tabela
window.__game.vanessa.getLog(20);     // surowe obiekty zdarzeń
window.__game.vanessa.clearLog();     // wyczyszczenie
window.__game.vanessa.logToConsole = false;  // tylko panel, bez konsoli
```

## Synchronizacja w czasie rzeczywistym (relay)

Karta właściciela jest **autorytetem**: pcha stan przez WebSocket do własnego
serwera-przekaźnika (`server/`), a ten rozgłasza go wszystkim widzom. Zdarzenia
(`klik`, `awans-tieru`, `reset`, `eliminacja`) lecą natychmiast, pełny snapshot idzie co 2 s
i prostuje ewentualny dryf. Nowy widz dostaje ostatni snapshot od razu po
podłączeniu, więc wchodzący w trakcie streamu nie ogląda pustej planszy.

Snapshot (`zbierzStan()` w `main.js`) niesie: `economy` (pula, licznik klików,
tier, ziarno, epoka), `leaderboard`, `assignments`, stan walki z bossem oraz
**pozycje pracowników na siatce** (`workers`). Te ostatnie są istotne, bo
ostrzał rakietowy bossa zabija WEDŁUG POZYCJI - bez nich widz wchodzący w
trakcie streamu miałby wszystkich na polach startowych i widziałby, jak giną
zupełnie inne osoby niż reszta czatu. Korekta pozycji pomija pracownika
będącego w trakcie animacji kroku (`entry.isMoving`), żeby snapshot nie szarpał
postacią w połowie ruchu.

**Zdarzenie `klik` dotyczy WYŁĄCZNIE kliknięć streamera myszką w model**
(`zrodlo: 'gracz'`). Kliki z czatu nie są rozgłaszane celowo: każda karta ma
własne połączenie z czatem Kicka i widzi tę samą wiadomość sama, więc broadcast
odtwarzałby efekt drugi raz - podwójny dźwięk i podwójny wysyp monet u każdego
widza. Kliknięcia streamera nie mają za sobą żadnej wiadomości czatu i tylko one
naprawdę wymagają rozesłania.

Serwer **nie symuluje gry** - tylko przekazuje ramki i trzyma ostatni snapshot.
Dzięki temu jest mały (~270 linii), nie duplikuje logiki i nie wymaga
przepisywania gry. Szczegóły uruchomienia i wdrożenia: `server/README.md`.

- Rola `host` wymaga `HOST_TOKEN`; przy pustym tokenie rola jest **całkowicie
  zablokowana** (fail-closed), a porównanie jest stało-czasowe.
- Widz nie może niczego wstrzyknąć - ramki od widzów są ignorowane na wejściu.
- Ostatni snapshot ląduje na dysku (`ostatni-stan.json`) i wraca po restarcie
  serwera, także po twardym ubiciu procesu.
- Adres serwera to jedna stała `URL_RELAYA` na górze `src/realtime.js`.
  **Pusty string całkowicie wyłącza tę warstwę** - gra działa wtedy dokładnie
  jak wcześniej, bez żadnych błędów w konsoli (tak jest domyślnie i tak działa
  lokalny `python serve.py`).
- Gdy relay działa, karty widzów **przestają odpytywać `/api/state`**; gdy
  padnie, odpytywanie wraca samo jako zapasowe. Zapis do KV co 5 s zostaje -
  to trwała pamięć i bootstrap, gdy przekaźnik jest pusty po restarcie.
- `GET /zdrowie` zwraca status (czy jest host, ilu widzów, wiek snapshotu).

Odczyt `GET /api/state` ma `Cache-Control: s-maxage=5`, więc CDN Vercela scala
identyczne zapytania widzów. Bez tego koszt rósł liniowo z widownią (200 widzów
przez 4 h to ~288 tys. odczytów Redisa - darmowy limit Upstash kończył się w
trakcie streamu). Z cache do funkcji dociera najwyżej 12 zapytań na minutę,
niezależnie od liczby widzów.

## Determinizm ze wspólnego ziarna (warstwa zapasowa)

Poniższy mechanizm powstał przed relayem i **nadal działa** - to on utrzymuje
zgodność bossa, Vanessy i złotej monety, których stan nie jest jeszcze
rozgłaszany zdarzeniami, oraz ratuje sytuację, gdy przekaźnik jest wyłączony
albo niedostępny.

Każda otwarta karta gry prowadzi własną symulację - sama łączy się z czatem
Kicka i sama liczy rozgrywkę. Gdyby losowała niezależnie, każdy widz miałby
inne równania nad bossem, inne pola ataków i inne hasło Vanessy. Tak właśnie
było na początku.

Zamiast transmitować stan z karty właściciela (co wymagałoby zapisu kilka razy
na sekundę i wyczerpałoby darmowy limit Upstash w kilka godzin streamu), gra
jest **deterministyczna ze wspólnego ziarna**:

- w stanie gry żyją `seedGry` i `epokaStartu`, losowane raz i trafiające do KV
  razem z resztą save'a, więc każda karta dostaje te same wartości,
- każde losowanie mające wpływ na rozgrywkę jest zakotwiczone w zdarzeniu,
  które **widzą wszyscy**: klucz strumienia to np. `ziarno:kryt:id-wiadomości`,
  `ziarno:równanie:tier:numer` albo `ziarno:pole:tier:numer`. Wiadomości z
  czatu Kicka mają własne `id` i docierają identycznie do każdej karty,
- zdarzenia czasowe (Vanessa, złota moneta, kadencja ataków) liczą się od
  `epokaStartu`, a nie od momentu wczytania karty, więc harmonogram jest wspólny,
- stan synchronizowany zawiera sekcję bossa (czy walka trwa, HP, liczniki),
  więc widz wchodzący w trakcie walki podejmuje ją w miejscu, w którym jest.

Generator (`src/rng.js`) to `mulberry32` zasiany hashem klucza. Zero dodatkowego
ruchu sieciowego, działa przy dowolnej liczbie widzów.

**Czego to nie daje:** zgodność jest na poziomie zdarzeń, nie klatek - animacja
może u kogoś ruszyć o ułamek sekundy później. Trafienia krytyczne z kliknięć
myszą właściciela w model zostają losowe lokalnie, bo nie ma ich w czacie i nie
da się ich zakotwiczyć w zdarzeniu widocznym dla innych; cała progresja z czatu
jest zgodna. Losowe pozostają też teksty dymków - nie wpływają na stan gry.

## Wdrożenie na Vercel (save po stronie serwera)

Gra może stać na Vercelu ze **wspólnym zapisem w Vercel KV**, tak że postęp
żyje na serwerze, a nie w przeglądarce. Sterować grą może wyłącznie właściciel.

### Jak to działa

| | właściciel (po zalogowaniu) | widz (publiczny adres) |
|---|---|---|
| widzi aktualny stan | tak | tak |
| zapisuje stan na serwer | tak, co 5 s | **nie** |
| reset gry, respienie Vanessy i bossa, eliminacja widza | tak | przyciski ukryte |

Odczyt (`GET /api/state`) jest publiczny, a każdy zapis (`POST`) i kasowanie
(`DELETE`) wymaga hasła w nagłówku `Authorization`. Ukrycie przycisków to
wygoda - **właściwym zabezpieczeniem jest sprawdzenie hasła po stronie
serwera**, więc podrobienie żądania z konsoli przeglądarki nic nie da.

Karta widza dociąga stan z serwera co 10 s i nadpisuje to, co sama sobie
lokalnie nasymulowała między odświeżeniami. Postęp z czatu liczy więc tylko
karta właściciela - i musi być otwarta, żeby cokolwiek się zapisywało.

### Konfiguracja (jednorazowo)

1. **Import projektu** - na [vercel.com](https://vercel.com) *Add New → Project*,
   wybierz repozytorium `Patiro2/blikolak`. Framework: *Other*, bez komendy
   budowania (to statyczne pliki plus dwie funkcje w `api/`).
2. **Magazyn** - w projekcie zakładka *Storage* → *Create Database* → **KV
   (Upstash Redis)** → *Connect*. Zmienne `KV_REST_API_URL` i
   `KV_REST_API_TOKEN` wpinają się same, nic nie trzeba przepisywać.
3. **Hasło właściciela** - *Settings → Environment Variables*, dodaj
   `ADMIN_TOKEN` z własnym, długim hasłem (wszystkie środowiska).
4. **Redeploy** - *Deployments* → ostatni wpis → *Redeploy*, żeby funkcje
   zobaczyły nowe zmienne.
5. Wejdź na adres gry, kliknij **🔑 Zaloguj**, podaj hasło. Pojawią się
   przyciski resetu i respienia; hasło zapamiętuje się w tej przeglądarce.

### Uruchomienie lokalne

Bez zmian: `python serve.py`. Lokalny serwer odpowiada na `/api/state` i
`/api/login` kodem 503 („magazyn niedostępny"), więc gra schodzi na
`localStorage` i działa z pełnymi uprawnieniami - logowanie nie jest do niczego
potrzebne, a przycisk 🔑 jest wtedy ukryty. W konsoli widać jeden wpis 503 od
tego sprawdzenia; to normalne i znika po wdrożeniu na Vercela.

### Pliki

| Plik | Rola |
|---|---|
| `api/state.js` | `GET` stan (publicznie), `POST`/`DELETE` stan (tylko z hasłem) |
| `api/login.js` | sprawdzenie hasła właściciela |
| `api/_kv.js` | dostęp do Vercel KV po REST (bez zależności npm) i stało-czasowe porównanie hasła |
| `src/remote.js` | klient stanu zdalnego, logowanie, tryb offline |
| `package.json` | wyłącznie `"type": "module"` - żadnych zależności do instalowania |

## Reset gry

Przycisk **Reset gry** (obok przycisku respienia Vanessy, w lewym górnym
rogu) zeruje wspólną pulę, ranking, przypisania pracowników i tier automatu
(po potwierdzeniu w oknie dialogowym). Postępu nie da się cofnąć.

## Dźwięki

Wszystkie dźwięki gry leżą w `assets/audio/` - to paczki **Kenney** (Interface,
Casino, Impact, Sci-Fi + podkatalogi z jinglami "Sax jingles", "Steel jingles"
itd.), **CC0 1.0** (domena publiczna, użycie bez ograniczeń; podanie "Kenney" /
"www.kenney.nl" jest mile widziane, ale nieobowiązkowe - patrz `License.txt`
w każdej paczce). Odtwarzanie jest zbudowane na czystym Web Audio API
(`src/audio.js`, klasa `AudioManager`) - celowo BEZ elementów `<audio>`, bo
przy serii kliknięć z czatu Kicka jeden element `<audio>` by się zaciął.

**Podmiana pliku dla danego zdarzenia** - jedyne miejsce do edycji to stała
`SOUND_MAP` na górze `src/audio.js`. Każde zdarzenie ma wpis:

```js
'klik': {
  pliki: ['chip-lay-1.ogg', 'chip-lay-2.ogg', 'chip-lay-3.ogg'], // losuje jeden z listy
  glosnosc: 0.35,      // mnoznik glosnosci tego zdarzenia (0..1)
  cooldownMs: 40,       // minimalny odstep miedzy kolejnymi odtworzeniami
  maxJednoczesnie: 3,    // ile glosow tego zdarzenia moze grac naraz
  wysokoscVar: 0.08,     // losowa odchylka wysokosci dzwieku (playbackRate, ±8%)
},
```

Żeby podmienić dźwięk - wystarczy zmienić nazwę(y) pliku w `pliki` (ścieżka
względem `assets/audio/`; podkatalogi ze spacjami, np. `"Sax jingles/jingles_SAX00.ogg"`,
działają bez zmian - `encodeURI` jest już obsłużony w `audio.js`). Wpisy z
dwoma plikami i `tryb: 'wszystkie'` (np. `boss-wejscie`, `vanessa-spawn`) grają
OBA pliki naraz zamiast losować jeden - to celowe (dwa nałożone efekty dźwiękowe).

Pełna lista zdarzeń: `klik`, `klik-gracz`, `kryt`, `kombo`, `moneta-spawn`,
`moneta-zebrana`, `awans-bankomatu`, `krok`, `boss-wejscie`, `boss-uderzenie`,
`boss-dzialanie`, `boss-tik`, `boss-trafienie`, `boss-zabija`, `omdlenie`,
`ratunek`, `boss-pokonany`, `vanessa-spawn`, `vanessa-kradnie`,
`vanessa-przegoniona`, `vanessa-ucieka`, `ui-klik`.

**Głośność i wyciszenie** - przycisk 🔊/🔇 i suwak obok przycisków HUD
(`#audio-controls` w `index.html`) sterują `AudioManager`; stan zapisuje się
sam do `localStorage` (klucz `bankomat-clicker-audio-v1`) i wczytuje przy
starcie gry, niezależnie od zapisu stanu rozgrywki (`economy.js`).

**Ograniczenia dbające o to, żeby spam "klik" nie brzmiał jak karabin
maszynowy**: globalny limit 12 jednoczesnych źródeł dźwięku, cooldown i limit
równoległych odtworzeń per zdarzenie, losowa wysokość dźwięku w zadanym
zakresie. `AudioContext` startuje zawieszony (polityka autoplay) i odblokowuje
się przy pierwszym kliknięciu/klawiszu na stronie - do tego czasu `play()` jest
cichym no-opem. Preload leci w tle i NIE blokuje startu gry; brakujący lub
niedekodowalny plik loguje jedno ostrzeżenie w konsoli i trwale wyłącza to
jedno zdarzenie - reszta gry działa dalej normalnie.

Debug z konsoli przeglądarki:

```js
window.__game.audio.play('klik');            // ręczne odtworzenie zdarzenia
window.__game.audio.activeVoiceCount();       // ile zrodel dzwieku gra teraz
window.__game.audio.setVolume(0.5);            // 0..1
window.__game.audio.toggleMuted();
```

## Debugowanie

W konsoli przeglądarki dostępne jest `window.__game` z polami `audio`, `economy`,
`machine`, `workerManager`, `coinPool`, `goldCoin`, `vanessa`, `ui`, `kickChat`, `kickUI`, `leaderboardUI`, `workerOverlays` i `save()`.

```js
window.__game.economy.state.money += 1e6;                  // dosypanie do wspolnej puli, do testow
window.__game.vanessa.spawn();                              // natychmiastowe przywołanie Vanessy
window.__game.kickChat.simulate('Widz1', 'klik');            // symulacja kliknięcia z czatu
window.__game.kickChat.simulate('Widz1', 'Pozdro dla czatu!'); // dymek wypowiedzi nad postacią widza w 3D

window.__game.boss.start(1, { force: true });               // natychmiastowe odpalenie bossa (test)
window.__game.boss.damage(5);                                // zadanie obrażeń bossowi z pominięciem czatu
window.__game.boss.faintRandom();                             // natychmiastowy atak na pole (omdlenie stojącego)
window.__game.boss.rocketStrike();                            // natychmiastowa salwa 10 rakiet
window.__game.boss.printLog();                                // log zdarzeń bossa jako tabela w konsoli
window.__game.kickChat.simulate('Widz1', 'pomoc');            // ratunek omdlonego widza
```
