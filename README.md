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
  model, gdy łączna liczba klików z czatu przekroczy próg (0 / 100 / 500 /
  2000 / 8000 / 25000 — patrz `MACHINE_TIER_CLICK_THRESHOLDS` w
  `src/economy.js`). Awans podmienia model 3D i pokazuje baner na górze ekranu.
  Klikniecia gracza (streamera) bezpośrednio w model NIE liczą się do progu —
  tylko klikniecia z czatu.
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
- **Złota moneta** — pojawia się losowo w scenie, klikalna przez streamera,
  bonus wpada do wspólnej puli.

Stan zapisuje się sam do `localStorage` co 5 s i przy zamykaniu karty.

## Struktura

| Plik | Rola |
|---|---|
| `src/main.js` | bootstrap, pętla klatek, spięcie modułów |
| `src/scene.js` | renderer, kamera, światła, pokój z kafli 1×1 |
| `src/assets.js` | ładowanie GLB z cache, retry i limitem współbieżności |
| `src/machine.js` | model automatu, podmiana tieru, raycast i animacja kliknięcia |
| `src/workers.js` | awatary Top 10, klony szkieletów, animacje `idle`/`interact-right` |
| `src/coins.js` | pula 120 monet z lotem po łuku |
| `src/economy.js` | stan wspólnej puli czatu, wartość kliknięcia, progi awansu tieru, zapis/odczyt |
| `src/ui.js` | HUD (pula, postęp do awansu, kombo, reset), widget czatu Kick, ranking |
| `src/kick.js` | integracja z czatem Kick.com (Pusher WebSocket), detekcja komendy "klik" |
| `src/format.js` | skrócona notacja liczb (1.5K, 2.3M) |

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
  - **Przegonienie**: kliknięcie na jej model/plakietkę (przez gracza) albo wpisanie jej sekretnego hasła na czacie (przez widza) każe jej uciekać w panice sprintem. W obu przypadkach do gry wraca dokładnie **50% kwoty, którą zdążyła ukraść** w tym wystąpieniu - reszta przepada bezpowrotnie razem z nią, więc nic nie jest dodrukowywane. Gdy przegania ją gracz (streamer), odzyskana kwota trafia do WSPÓLNEJ PULI CZATU; gdy przegania ją widz hasłem, odzyskana kwota trafia na jego konto w rankingu (jako odzyskana kwota, nie świeży zarobek).
  - Jeśli Vanessa nie zostanie przepędzona w porę, ucieka z całym łupem - ofiara traci go bezpowrotnie.

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

## Reset gry

Przycisk **Reset gry** (obok przycisku respienia Vanessy, w lewym górnym
rogu) zeruje wspólną pulę, ranking, przypisania pracowników i tier automatu
(po potwierdzeniu w oknie dialogowym). Postępu nie da się cofnąć.

## Debugowanie

W konsoli przeglądarki dostępne jest `window.__game` z polami `economy`,
`machine`, `workerManager`, `coinPool`, `goldCoin`, `vanessa`, `ui`, `kickChat`, `kickUI`, `leaderboardUI`, `workerOverlays` i `save()`.

```js
window.__game.economy.state.money += 1e6;                  // dosypanie do wspolnej puli, do testow
window.__game.vanessa.spawn();                              // natychmiastowe przywołanie Vanessy
window.__game.kickChat.simulate('Widz1', 'klik');            // symulacja kliknięcia z czatu
window.__game.kickChat.simulate('Widz1', 'Pozdro dla czatu!'); // dymek wypowiedzi nad postacią widza w 3D
```
