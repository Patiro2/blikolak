import * as THREE from 'three';
import { createScene, buildRoom, setCameraArenaHalf } from './scene.js';
import { preloadAll, setTextureQuality } from './assets.js';
import { Machine } from './machine.js';
import { WorkerManager, parseMovementCombo } from './workers.js';
import { CoinPool } from './coins.js';
import { GoldenCoinManager } from './goldcoin.js';
import { FlagBattleManager } from './flagbattle.js';
import { TlumaczeniaManager } from './tlumaczenia.js';
import { PanstwaMiastaManager } from './panstwa-miasta.js';
import { BitwaMarekManager } from './bitwa-marek.js';
import { JetpackManager } from './jetpack.js';
import { WarstwaMinigier } from './warstwa-minigier.js';
import { Economy, WORKER_TYPE_DEFS, MACHINE_TIERS, SAVE_KEY } from './economy.js';
import { remote, czyLokalnie } from './remote.js';
import { Realtime, URL_RELAYA } from './realtime.js';
import { LEADERBOARD_KEY, ASSIGNMENTS_KEY } from './kick.js';
import { UI, KickUI, KickEmbedUI, LeaderboardUI, WorkerOverlayManager, LegendUI } from './ui.js';
import { KickChatClient } from './kick.js';
import { VanessaManager, showTopAnnouncement } from './vanessa.js';
import { BossManager, BOSS_DEFS } from './boss.js';
import { fmtShort } from './format.js';
import { CityBackground } from './city.js';
import { audio } from './audio.js';
import { pokazGameOver } from './gameover.js';
import * as arena from './arena.js';

async function main() {
  // Sprzatanie po usunietym panelu logu Vanessy - osierocony klucz pozycji
  // (przeciagania okna) nie jest juz nigdzie odczytywany, wiec go kasujemy.
  try {
    localStorage.removeItem('bankomat-clicker-vanessa-log-pos');
  } catch (err) {
    // localStorage moze byc niedostepny (np. tryb prywatny) - nic sie nie stanie
  }

  const canvas = document.getElementById('scene');
  const { renderer, scene, camera, controls, ustawNoc: ustawNocScena } = createScene(canvas);

  // Stan gry z serwera (Vercel KV) ma pierwszenstwo przed localStorage.
  // Economy i KickChatClient czytaja localStorage w konstruktorach, wiec
  // najpierw wsiewamy tam to, co przyszlo z serwera. Gdy API nie odpowiada
  // (np. lokalne serve.py), zostaje dotychczasowe zachowanie z localStorage.
  const stanZdalny = await remote.zainicjuj().catch(() => null);
  // Sekcja "boss" nie idzie przez localStorage (economy/leaderboard/assignments
  // wystarcza to zrobic, bo Economy/KickChatClient czytaja je w konstruktorach) -
  // walka z bossem jest aplikowana rownolegle po zbudowaniu BossManager nizej.
  const poczatkowyStanBossa = stanZdalny ? stanZdalny.boss : null;
  if (stanZdalny) {
    try {
      if (stanZdalny.economy) localStorage.setItem(SAVE_KEY, JSON.stringify(stanZdalny.economy));
      if (stanZdalny.leaderboard) localStorage.setItem(LEADERBOARD_KEY, JSON.stringify(stanZdalny.leaderboard));
      if (stanZdalny.assignments) localStorage.setItem(ASSIGNMENTS_KEY, JSON.stringify(stanZdalny.assignments));
      console.info('[stan] Wczytano stan gry z serwera');
    } catch (err) {
      console.warn('[stan] Nie udalo sie wsiac stanu z serwera do localStorage:', err);
    }
  }

  const economy = new Economy();

  // Kanal realtime (WebSocket, patrz src/realtime.js) - DODATKOWA warstwa nad
  // KV: wlasciciel rozsyla snapshoty/zdarzenia natychmiast, widzowie dostaja
  // je bez czekania na odpytywanie co 10 s. Gdy URL_RELAYA jest puste albo
  // serwer relay nie odpowiada, modul cicho nic nie robi - reszta gry (KV +
  // odpytywanie) dziala dokladnie jak dotychczas.
  const realtime = new Realtime({
    url: URL_RELAYA,
    rola: remote.czyAdmin() ? 'host' : 'widz',
    token: remote.token,
  });
  // true, gdy widz ma dzialajace polaczenie realtime Z aktywnym hostem - wtedy
  // wylaczamy zapasowe odpytywanie /api/state co 10 s (patrz interwaly nizej).
  let realtimeHostOnline = false;
  realtime.onStatus = ({ polaczony, host }) => {
    realtimeHostOnline = polaczony && host;
  };

  // Preload dzwiekow leci w tle - main() NIE czeka na niego (patrz audio.js).
  // Ewentualny blad pojedynczego pliku jest tam obslugiwany osobno i nie moze
  // przerwac reszty preloadu ani startu gry.
  audio.preload().catch((err) => console.warn('[audio] Blad preloadu dzwiekow:', err));

  // Jakosc filtrowania tekstur musi byc znana PRZED zaladowaniem modeli -
  // fixMaterials nadaje anizotropie w chwili ladowania (patrz assets.js).
  setTextureQuality(renderer);

  arena.init({ scene, camera, controls, economy });

  await preloadAll();
  await buildRoom(scene, economy);
  // Kadrowanie kamery (i controls.maxDistance) dostrojone pod AKTUALNY
  // rozmiar areny (7x7/9x9) - patrz GROWN_POS/GROWN_MAX_DISTANCE w scene.js.
  // Bez tego strona wczytana z juz pokonanym Skorpionem (arena 9x9 od razu)
  // zostalaby z kadrowaniem 7x7.
  setCameraArenaHalf(camera, controls, arena.arenaHalf(economy));

  // Miasto w tle - wokol i ponizej areny (patrz src/city.js). Zbudowane
  // WYLACZNIE z prymitywow Three.js (InstancedMesh), bo zaden z pakietow
  // Kenney w projekcie nie ma modeli budynkow/ulic/samochodow. Arena
  // pozostaje bez zmian - miasto tylko dobudowuje otoczenie wokol niej.
  const city = new CityBackground();
  city.build(scene, renderer);

  // Tryb nocy - CZYSTO LOKALNY dla tej karty/przegladarki (localStorage, klucz
  // ponizej). Celowo NIE idzie przez zbierzStan()/realtime/KV: kazdy widz i
  // wlasciciel maja wlaczac/wylaczac go u siebie, niezaleznie od reszty
  // rozgrywki. Zastosowany od razu, PRZED pierwsza klatka (przed animate()
  // nizej w tym pliku), zeby noc - gdy zapamietana - nie mignela dniem.
  const NOC_KEY = 'bankomat-clicker-noc';
  const btnNoc = document.getElementById('btn-noc');
  let tryNoc = false;
  try {
    tryNoc = localStorage.getItem(NOC_KEY) === '1';
  } catch (err) {
    // localStorage moze byc niedostepny (np. tryb prywatny) - zostaje dzien
  }
  function zastosujTrybNocy(noc) {
    const kolorMgly = ustawNocScena(noc);
    city.ustawNoc(noc, kolorMgly);
    if (btnNoc) {
      btnNoc.textContent = noc ? '☀️ Dzień' : '🌙 Noc';
      btnNoc.title = noc
        ? 'Przelacz na tryb dnia (tylko u Ciebie, w tej przegladarce)'
        : 'Przelacz tryb nocy (tylko u Ciebie, w tej przegladarce)';
    }
  }
  zastosujTrybNocy(tryNoc);
  if (btnNoc) {
    btnNoc.addEventListener('click', () => {
      tryNoc = !tryNoc;
      zastosujTrybNocy(tryNoc);
      try {
        localStorage.setItem(NOC_KEY, tryNoc ? '1' : '0');
      } catch (err) {
        // localStorage moze byc niedostepny - stan przetrwa tylko do przeladowania
      }
    });
  }

  const machine = new Machine(scene, camera, renderer.domElement);
  // Polityka uprawnien (kto smie klikac w bankomat myszka) zyje TU, nie w
  // machine.js - patrz komentarz przy czyKlikaniaDozwolone w machine.js.
  // Strzalka, nie zapamietana wartosc: remote.czyAdmin() jest wolane PRZY
  // KAZDYM kliknieciu, wiec zalogowanie/wylogowanie przyciskiem w HUD w
  // trakcie zycia strony dziala natychmiast, bez przeladowania.
  machine.czyKlikaniaDozwolone = () => remote.czyAdmin();
  await machine.setTier(economy.state.machineTier);

  const workerManager = new WorkerManager(scene);

  // Kazdy z 10 slotow rankingu Top 10 ma stala "role" (patrz WORKER_TYPE_DEFS).
  // Awatar pojawia sie w scenie dokladnie raz, gdy ktos zajmie dany slot.
  async function ensureWorkerType(slotIndex, skinName) {
    const def = WORKER_TYPE_DEFS[slotIndex];
    if (!def) return;
    await workerManager.addWorkerType(slotIndex, def.modelKey, skinName);
  }

  const coinPool = new CoinPool(scene);
  await coinPool.init();

  const goldCoin = new GoldenCoinManager(scene);
  await goldCoin.init();

  const flagBattle = new FlagBattleManager(scene, renderer);
  let flagBattleBledy = 0;
  let flagBattleZepsuta = false;

  // Jetpack z sekretnego kodu czatu "rocketman" (patrz src/jetpack.js i
  // KODY w kick.js) - wylacznie wizualny efekt, izolacja bledow tick() tym
  // samym wzorcem co flagBattle/tlumaczenia/panstwaMiasta/bitwaMarek nizej.
  const jetpack = new JetpackManager(scene);
  let jetpackBledy = 0;
  let jetpackZepsuty = false;

  // Minigra "Tlumaczenia" - druga minigra na siatce areny, obok bitwy o
  // flagi. Ta sama polityka izolacji bledow (patrz komentarz przy
  // flagBattleZepsuta nizej w animate()) - blad w tick() degraduje WYLACZNIE
  // te minigre, reszta gry dziala dalej.
  const tlumaczenia = new TlumaczeniaManager(scene, renderer);
  let tlumaczeniaBledy = 0;
  let tlumaczeniaZepsuta = false;

  // Minigra "Panstwa-Miasta" - czwarta minigra na siatce areny, obok bitwy o
  // flagi i bitwy tlumaczen. Ta sama polityka izolacji bledow (patrz komentarz
  // przy flagBattleZepsuta nizej w animate()) - blad w tick() degraduje
  // WYLACZNIE te minigre, reszta gry dziala dalej.
  const panstwaMiasta = new PanstwaMiastaManager(scene, renderer);
  let panstwaMiastaBledy = 0;
  let panstwaMiastaZepsuta = false;

  // Minigra "Zgadnij marke" - piata minigra na siatce areny, obok bitwy o
  // flagi, bitwy tlumaczen i panstw-miast. Ta sama polityka izolacji bledow
  // (patrz komentarz przy flagBattleZepsuta nizej w animate()) - blad w
  // tick() degraduje WYLACZNIE te minigre, reszta gry dziala dalej.
  const bitwaMarek = new BitwaMarekManager(scene, renderer);
  let bitwaMarekBledy = 0;
  let bitwaMarekZepsuta = false;

  // Warstwa wymuszajaca pierwszenstwo kart minigier nad modelami 3D i nad
  // HTML-owymi nickami/dymkami pracownikow (patrz src/warstwa-minigier.js -
  // canvas jest nieprzezroczysty, samo z-index w CSS by tu nie wystarczylo).
  // Kontener #worker-overlays jest juz uzywany przez WorkerOverlayManager
  // (patrz workerOverlays nizej) - ten sam element, czytany tu z zewnatrz.
  const warstwaMinigier = new WarstwaMinigier(camera, document.getElementById('worker-overlays'), {
    flagBattle,
    tlumaczenia,
    panstwaMiasta,
    bitwaMarek,
  });
  let warstwaMinigierBledy = 0;
  let warstwaMinigierZepsuta = false;

  const vanessa = new VanessaManager(
    scene,
    camera,
    machine,
    economy,
    coinPool,
    (point, text, opts) => {
      projectAndFloat(point, text, opts);
    },
    (username, reward, color) => {
      // Nagroda za przepedzenie Vanessy to odzyskana kwota, NIE swiezy
      // zarobek - inaczej dodrukowalibysmy pieniadze (patrz kickChat).
      kickChat.creditRecoveredMoney(username, reward, color);
    }
  );
  await vanessa.init();

  // Dzwiek "ui-klik" dla kazdego przycisku w pasku HUD (delegacja zdarzen -
  // obejmuje tez przyszle przyciski, np. wyciszenie/glosnosc, bez dopisywania
  // osobnego listenera do kazdego z osobna).
  const hudButtonsBar = document.getElementById('hud-top-left-buttons');
  if (hudButtonsBar) {
    hudButtonsBar.addEventListener('click', (e) => {
      if (e.target.closest('button')) audio.play('ui-klik');
    });
  }

  // Sterowanie dzwiekiem: przycisk wyciszenia + suwak glosnosci. Stan (glosnosc,
  // wyciszenie) zyje w AudioManager i zapisuje sie sam do localStorage (patrz audio.js).
  const muteBtn = document.getElementById('btn-mute');
  const volumeSlider = document.getElementById('volume-slider');
  if (volumeSlider) {
    volumeSlider.value = String(Math.round(audio.getVolume() * 100));
  }
  function refreshAudioUI() {
    if (muteBtn) muteBtn.textContent = audio.isMuted() ? '🔇' : '🔊';
  }
  refreshAudioUI();
  if (muteBtn) {
    muteBtn.addEventListener('click', () => {
      audio.toggleMuted();
      refreshAudioUI();
    });
  }
  if (volumeSlider) {
    volumeSlider.addEventListener('input', () => {
      audio.setVolume(Number(volumeSlider.value) / 100);
      // Ruszanie suwakiem przy wyciszeniu ma sens tylko jesli od razu odciszamy -
      // inaczej uzytkownik przesuwa suwak i nic nie slyszy, myslac ze suwak nie dziala.
      if (audio.isMuted()) {
        audio.setMuted(false);
        refreshAudioUI();
      }
    });
  }

  const spawnVanessaBtn = document.getElementById('btn-spawn-vanessa');
  if (spawnVanessaBtn) {
    spawnVanessaBtn.addEventListener('click', () => {
      // Straz niezalezna od ukrycia przycisku w CSS - ukrycie jest kosmetyka,
      // a to jest faktyczny warunek wykonania akcji.
      if (!remote.czyAdmin()) return;
      vanessa.spawn(true);
    });
  }

  // Zapis na serwer leci tylko z sesji admina i nie czesciej niz co
  // ZAPIS_ZDALNY_MS - lokalny zapis do localStorage zostaje bez zmian, wiec
  // nawet przy padnietym API nic sie nie gubi.
  const ZAPIS_ZDALNY_MS = 5000;
  let ostatniZapisZdalny = 0;
  let zapisZdalnyWToku = false;

  function zbierzStan() {
    return {
      economy: economy.state,
      leaderboard: kickChat.leaderboard,
      assignments: kickChat.assignments,
      boss: boss.getSyncState(),
      workers: workerManager.getSyncState(),
      flagBattle: flagBattle.getSyncState(),
      tlumaczenia: tlumaczenia.getSyncState(),
      panstwaMiasta: panstwaMiasta.getSyncState(),
      bitwaMarek: bitwaMarek.getSyncState(),
      jetpack: jetpack.getSyncState(),
    };
  }

  async function zapiszNaSerwer(wymus = false) {
    if (!remote.czyOnline() || !remote.czyAdmin()) return;
    const teraz = Date.now();
    if (!wymus && teraz - ostatniZapisZdalny < ZAPIS_ZDALNY_MS) return;
    if (zapisZdalnyWToku) return;
    zapisZdalnyWToku = true;
    ostatniZapisZdalny = teraz;
    try {
      await remote.zapisz(zbierzStan());
    } catch (err) {
      console.warn('[stan] Nie udalo sie zapisac stanu na serwerze:', err);
    } finally {
      zapisZdalnyWToku = false;
    }
  }

  function save() {
    economy.save();
    kickChat.flush();
    zapiszNaSerwer();
  }

  /**
   * Tryb widza: stan na serwerze prowadzi admin, wiec co jakis czas dociagamy
   * go i nadpisujemy to, co lokalnie nasymulowala ta karta.
   */
  /**
   * Sprzatanie calej sceny i stanu do wartosci poczatkowych. Uzywane zarowno
   * przez reset wykonany przez wlasciciela, jak i przez karte widza, ktora
   * wykryla, ze wlasciciel zresetowal gre. NIE dotyka serwera - o to dba
   * osobno strona wolajaca.
   */
  async function resetLokalny() {
    economy.reset();
    kickChat.reset();
    kickUI.updateKliksCount(0);
    workerOverlays.clear();
    workerManager.clear();
    vanessa.reset();
    boss.reset();
    goldCoin.reset();
    // Reset kasuje bossesDefeated -> arena.arenaHalf(economy) znowu zwraca 3.
    // Bez tego arena zostalaby na 9x9 (albo jakimkolwiek rozmiarze sprzed
    // resetu), bo buildRoom() sam z siebie nie jest wolany co klatke.
    await buildRoom(scene, economy);
    setCameraArenaHalf(camera, controls, arena.arenaHalf(economy));
    await machine.setTier(0);
    try {
      await syncLeaderboardAndOverlays();
    } catch (err) {
      console.error('[reset] Blad odswiezania po resecie:', err);
    }
  }

  /**
   * Pelny reset gry (plansza + serwer + widzowie) - wyciagniety z onReset
   * (przycisk wlasciciela w UI), zeby ta sama sciezka mogla wolac tez
   * onGameOver po przegranej z Dzordzo (boss 3, patrz boss.setContext
   * nizej i src/boss-blackjack.js). Zachowanie przycisku resetu bez zmian -
   * onReset dalej sam sprawdza remote.czyAdmin() PRZED wywolaniem tej funkcji.
   */
  async function pelnyResetGry() {
    await resetLokalny();
    // Reset kasuje takze stan na serwerze - inaczej po odswiezeniu strony
    // wrocilby stary zapis z KV. Natychmiastowy zapis nowego stanu sprawia,
    // ze karty widzow zobacza zmieniona epoke przy najblizszej synchronizacji
    // i tez wyczyszcza u siebie plansze (patrz synchronizujZSerwera).
    if (remote.czyOnline() && remote.czyAdmin()) {
      await remote.wyczysc();
    }
    save();
    await zapiszNaSerwer(true);
    // Natychmiastowa informacja dla widzow kanalem realtime - nie czekaja
    // na zmiane epokaStartu w kolejnym snapshocie/odpytywaniu.
    realtime.wyslijZdarzenie('reset', {});
  }

  // Ostatnia epoka zobaczona na serwerze. Sluzy do wykrycia resetu: economy.reset()
  // generuje nowe seedGry i epokaStartu, wiec zmiana epoki = wlasciciel zresetowal gre.
  let ostatniaEpokaSerwera = stanZdalny && stanZdalny.economy ? stanZdalny.economy.epokaStartu : null;

  // Widz: czy Skorpion byl juz pokonany PRZY OSTATNIM sprawdzeniu - patrz
  // krok 'economy' w zastosujStanZSerwera nizej. Inicjalizowane z TEGO, co juz
  // jest w economy.state (wczytane z localStorage/KV PRZED tym momentem) -
  // wiec strona wczytana z juz pokonanym Skorpionem startuje z true i NIGDY
  // nie odpala cutscenki (widziana jest tylko PRAWDZIWA zmiana false->true).
  let widzMialSkorpiona = economy.state.bossesDefeated.includes(arena.SKORPION_TIER);

  /**
   * Wspolna sciezka stosowania stanu prowadzonego przez wlasciciela - uzywana
   * zarowno przez odpytywanie /api/state (synchronizujZSerwera), jak i przez
   * snapshoty przychodzace natychmiast kanalem realtime (patrz realtime.onSnapshot
   * nizej). Ksztalt `stan` jest identyczny w obu przypadkach (patrz zbierzStan).
   */
  /**
   * NAPRAWA: kazdy z krokow nizej byl wolany "goly", jeden po drugim, bez
   * zadnej izolacji - wyjatek w KTORYMKOLWIEK z nich (np. boss.applySync na
   * nieoczekiwanym ksztalcie danych, gdy karta hosta i karta widza sa
   * chwilowo na roznych wersjach kodu po wdrozeniu - karta hosta nie
   * przeladowuje sie sama) ucinal WSZYSTKIE kolejne kroki w tym wywolaniu.
   * Skoro cala funkcja jest wolana jako `zastosujStanZSerwera(dane).catch(...)`
   * z realtime.onSnapshot (patrz nizej), jedyny slad w konsoli ladowal sie
   * na samym koncu, bez wskazania KTORY krok faktycznie padl - z zewnatrz
   * wygladalo to jak "synchronizacja czasem po cichu nie dziala", co 2 sekundy,
   * bez zadnego namierzalnego sladu. Kazdy krok ma wiec teraz WLASNA izolacje
   * (krokStanu nizej) - blad w bossie nie kradnie pracownikow, blad w
   * pracownikach nie kradnie minigry, zaden z nich nie blokuje odswiezenia
   * rankingu, i kazdy blad trafia do konsoli z nazwa kroku, ktory go rzucil.
   *
   * WYJATEK: krok epoki/resetu (zaraz ponizej) NIE jest izolowany w ten sam
   * sposob - celowo. Jesli resetLokalny() wysypie sie w polowie, scena moze
   * zostac w niespojnym stanie (czesc obiektow usunieta, czesc nie) i
   * nakladanie na to boss/workers/flagBattle z tego samego snapshotu i tak
   * nie mialoby sensu. Wyjatek leci wiec dalej do wywolujacego (ktory i tak
   * go lapie - patrz realtime.onSnapshot/synchronizujZSerwera), a linia
   * `ostatniaEpokaSerwera = epokaZSerwera` NIE wykonuje sie w takim wypadku -
   * dzieki temu kolejny snapshot (za 2 s) sam ponowi reset zamiast po cichu
   * zostawic widza ze starymi obiektami na zawsze.
   */
  async function zastosujStanZSerwera(stan) {
    if (!stan) return;

    // Zmiana epoki startu = reset po stronie wlasciciela. Trzeba wyczyscic
    // cala scene (pracownicy, boss, Vanessa, moneta, tier bankomatu), a nie
    // tylko nadpisac liczby - inaczej u widza zostalyby stare awatary
    // i trwajaca walka.
    const epokaZSerwera = stan.economy ? stan.economy.epokaStartu : null;
    if (epokaZSerwera && ostatniaEpokaSerwera !== null && epokaZSerwera !== ostatniaEpokaSerwera) {
      console.info('[stan] Wlasciciel zresetowal gre - czyszcze plansze');
      await resetLokalny();
    }
    if (epokaZSerwera) ostatniaEpokaSerwera = epokaZSerwera;

    await krokStanu('economy', () => {
      if (stan.economy) Object.assign(economy.state, stan.economy);
      // Widz: wykrycie PRZEJSCIA "nie mial Skorpiona pokonanego" -> "ma" (nie
      // samego faktu bycia pokonanym - inaczej kazdy kolejny snapshot po
      // zwyciestwie probowalby odpalic cutscenke od nowa). Host NIGDY tego
      // nie robi - u niego cutscenke odpala onDefeated (patrz boss.setContext
      // nizej), zaraz po dopisaniu tieru do bossesDefeated.
      if (!remote.czyAdmin()) {
        const maSkorpiona = economy.state.bossesDefeated.includes(arena.SKORPION_TIER);
        if (maSkorpiona && !widzMialSkorpiona) {
          arena.growWithCutscene(economy).catch((err) =>
            console.error('[arena] Blad cutscenki powiekszenia (widz):', err));
        }
        widzMialSkorpiona = maSkorpiona;
      }
    });
    await krokStanu('leaderboard+assignments', () => {
      if (stan.leaderboard) kickChat.leaderboard = stan.leaderboard;
      if (stan.assignments) kickChat.assignments = stan.assignments;
      kickChat.updateAssignments();
    });
    await krokStanu('machine.setTier', async () => {
      if (machine.currentTier !== economy.state.machineTier) {
        await machine.setTier(economy.state.machineTier);
      }
    });
    // Stan walki z bossem - widz, ktory wchodzi w trakcie walki, podejmuje ja
    // bez cutscenki z tym samym hp i tym samym rownaniem (patrz boss.applySync).
    await krokStanu('boss.applySync', () => {
      if (stan.boss) boss.applySync(stan.boss);
    });
    // Pozycje pracownikow na siatce - pomijamy u hosta (host jest zrodlem
    // prawdy, patrz komentarz w WorkerManager.applySync).
    await krokStanu('workerManager.applySync', () => {
      if (stan.workers && !remote.czyAdmin()) workerManager.applySync(stan.workers);
    });
    // Minigra "Bitwa o flagi" - patrz komentarz przy isHost w flagbattle.js:
    // widz nie losuje juz nic sam, tylko odgrywa to, co przyslal host.
    await krokStanu('flagBattle.applySync', () => {
      if (!remote.czyAdmin()) flagBattle.applySync(stan.flagBattle || null);
    });
    // Minigra "Tlumaczenia" - ten sam wzorzec co flagBattle.applySync wyzej.
    await krokStanu('tlumaczenia.applySync', () => {
      if (!remote.czyAdmin()) tlumaczenia.applySync(stan.tlumaczenia || null);
    });
    // Minigra "Panstwa-Miasta" - ten sam wzorzec co flagBattle.applySync/
    // tlumaczenia.applySync wyzej.
    await krokStanu('panstwaMiasta.applySync', () => {
      if (!remote.czyAdmin()) panstwaMiasta.applySync(stan.panstwaMiasta || null);
    });
    // Minigra "Zgadnij marke" - ten sam wzorzec co flagBattle.applySync/
    // tlumaczenia.applySync/panstwaMiasta.applySync wyzej.
    await krokStanu('bitwaMarek.applySync', () => {
      if (!remote.czyAdmin()) bitwaMarek.applySync(stan.bitwaMarek || null);
    });
    // Jetpack z kodu czatu "rocketman" - ten sam wzorzec co pozostale minigry
    // powyzej (patrz src/jetpack.js).
    await krokStanu('jetpack.applySync', () => {
      if (!remote.czyAdmin()) jetpack.applySync(stan.jetpack || null);
    });
    try {
      await syncLeaderboardAndOverlays();
    } catch (err) {
      console.error('[stan] Blad odswiezania po synchronizacji:', err);
    }
  }

  /** Wykonuje jeden krok zastosujStanZSerwera w izolacji - patrz komentarz powyzej. */
  async function krokStanu(nazwaKroku, fn) {
    try {
      await fn();
    } catch (err) {
      console.error(
        `[stan] Blad w kroku '${nazwaKroku}' przy stosowaniu stanu z serwera - pomijam TYLKO ten krok, reszta stanu leci dalej:`,
        err,
      );
    }
  }

  async function synchronizujZSerwera() {
    if (!remote.czyOnline() || remote.czyAdmin()) return;
    const stan = await remote.pobierz();

    // Wlasciciel skasowal stan na serwerze i nie zdazyl jeszcze zapisac nowego.
    // Jesli wczesniej jakikolwiek stan tam byl, to znaczy, ze poszedl reset.
    if (!stan) {
      if (ostatniaEpokaSerwera !== null) {
        console.info('[stan] Wlasciciel zresetowal gre - czyszcze plansze');
        ostatniaEpokaSerwera = null;
        await resetLokalny();
      }
      return;
    }

    await zastosujStanZSerwera(stan);
  }

  // Widz: zastosowanie zdarzenia natychmiastowego przyszlego kanalem realtime
  // (patrz protokol w server/server.js). Host NIGDY nie dostaje wlasnych
  // zdarzen z powrotem (serwer rozsyla je tylko widzom), ale sprawdzamy
  // remote.czyAdmin() defensywnie na wypadek przyszlych zmian protokolu.
  // Liczby (kasa, licznik klikow...) i tak nadpisze najblizszy snapshot co 2 s
  // - tu chodzi wylacznie o natychmiastowa reakcje wizualna/dzwiekowa.
  function zastosujZdarzenieZdalne(nazwa, dane) {
    if (remote.czyAdmin()) return;
    if (nazwa === 'klik') {
      // Zdarzenie 'klik' jest rozglaszane WYLACZNIE dla klikniec wlasciciela
      // myszka w model 3D (patrz machine.onClickHit nizej) - klik z czatu NIE
      // jest tu rozglaszany, bo kazda karta widza ma wlasne polaczenie z
      // czatem Kicka i widzi te sama wiadomosc sama (patrz kickChat.onKlik).
      // Rozglaszanie klikow z czatu dawalo podwojny dzwiek/animacje/wysyp
      // monet u kazdego widza - raz z wlasnego czatu, raz z tego zdarzenia.
      const wartosc = dane && typeof dane.wartosc === 'number' ? dane.wartosc : 0;
      const isCrit = !!(dane && dane.isCrit);
      const opis = dane && dane.zrodlo === 'gracz' ? 'Streamer' : null;
      machine.triggerClickAnim();
      audio.play('klik');
      if (isCrit) audio.play('kryt');
      coinPool.burst(machineBurstOrigin, wartosc);
      const suffix = opis ? ` (${opis})` : '';
      const text = isCrit ? `KRYT! +${fmtShort(wartosc)}${suffix}` : `+${fmtShort(wartosc)}${suffix}`;
      projectAndFloat(machineBurstOrigin, text, { crit: isCrit, kick: true });
    } else if (nazwa === 'awans-tieru') {
      const tier = dane && typeof dane.tier === 'number' ? dane.tier : null;
      if (tier !== null && MACHINE_TIERS[tier]) {
        machine.setTier(tier).catch((err) => console.error('[realtime] Blad ustawiania tieru:', err));
        announceTierAdvance(tier);
      }
    } else if (nazwa === 'reset') {
      resetLokalny().catch((err) => console.error('[realtime] Blad resetu zdalnego:', err));
    } else if (nazwa === 'eliminacja') {
      // Wlasciciel wyeliminowal widza recznie z panelu HUD (poza kontekstem
      // walki z bossem) - u widza odgrywamy dokladnie ta sama animacje
      // smierci i usuniecie z rankingu przez wspolna funkcje wykonawcza
      // (patrz boss.killUserManual/_killUser w boss.js). Najblizszy snapshot
      // i tak wyrówna liczby - to tylko natychmiastowa reakcja wizualna.
      const nick = dane && typeof dane.nick === 'string' ? dane.nick : null;
      if (nick) boss.killUserManual(nick);
    } else if (nazwa === 'flaga-info') {
      // Natychmiastowa narracja bitwy o flagi (patrz flagBattle.onAnnounce
      // powyzej) - stan (kafelek/flaga/wynik) i tak przyjdzie osobno snapshotem,
      // to tylko dopisuje ten sam tekst do #kick-messages bez czekania.
      const text = dane && typeof dane.text === 'string' ? dane.text : null;
      if (text) flagBattle.announce(text);
    } else if (nazwa === 'tlumaczenia-info') {
      // Natychmiastowa narracja bitwy tlumaczen - ten sam wzorzec co
      // 'flaga-info' powyzej (patrz komentarz tam).
      const text = dane && typeof dane.text === 'string' ? dane.text : null;
      if (text) tlumaczenia.announce(text);
    } else if (nazwa === 'panstwa-miasta-info') {
      // Natychmiastowa narracja bitwy panstw-miast - ten sam wzorzec co
      // 'flaga-info'/'tlumaczenia-info' powyzej (patrz komentarz tam).
      const text = dane && typeof dane.text === 'string' ? dane.text : null;
      if (text) panstwaMiasta.announce(text);
    } else if (nazwa === 'marki-info') {
      // Natychmiastowa narracja bitwy o marki - ten sam wzorzec co
      // 'flaga-info'/'tlumaczenia-info'/'panstwa-miasta-info' powyzej.
      const text = dane && typeof dane.text === 'string' ? dane.text : null;
      if (text) bitwaMarek.announce(text);
    } else if (nazwa === 'game-over') {
      // Wlasciciel przegral cala pule z Dzordzo (boss 3) albo dal sie okrasc
      // Skorpionowi (boss 4, patrz boss.onGameOver nizej) - widz WYLACZNIE
      // odgrywa ten sam ekran (z tym samym tekstem), nigdy nie odpala go sam
      // z siebie. Reset planszy przyjdzie osobnym zdarzeniem 'reset' (albo
      // zmiana epoki w kolejnym snapshocie).
      const tekst = dane && typeof dane.tekst === 'string' ? dane.tekst : undefined;
      audio.play('game-over');
      pokazGameOver(tekst).catch((err) => console.error('[game-over] Blad nakladki u widza:', err));
    }
  }

  let pierwszySnapshotZmierzony = false;
  realtime.onSnapshot = (dane) => {
    if (!pierwszySnapshotZmierzony) {
      pierwszySnapshotZmierzony = true;
      console.info(`[realtime] Pierwszy snapshot po ${Math.round(performance.now())} ms od startu strony`);
    }
    zastosujStanZSerwera(dane).catch((err) => console.error('[realtime] Blad stosowania snapshotu:', err));
  };
  realtime.onZdarzenie = (nazwa, dane) => {
    try {
      zastosujZdarzenieZdalne(nazwa, dane);
    } catch (err) {
      console.error('[realtime] Blad stosowania zdarzenia:', err);
    }
  };

  const clock = new THREE.Clock();
  const machineBurstOrigin = new THREE.Vector3(0, 0.6, 0.3);

  // Dzwiek kombo ma grac TYLKO na progach co 5 stopni ("kombo x10", "x15"...),
  // nie przy kazdym klikniecu - inaczej przy zywym czacie zlewaloby sie w szum.
  // Sledzimy ostatni osiagniety prog (podloga combo/5) i gramy tylko przy zmianie.
  let lastComboTier = 0;
  function maybePlayComboSound(combo) {
    if (combo <= 0) {
      lastComboTier = 0;
      return;
    }
    const tier = Math.floor(combo / 5);
    if (tier > 0 && tier !== lastComboTier) {
      lastComboTier = tier;
      audio.play('kombo');
    }
  }

  // Wspolny baner awansu bankomatu - uzywany zarowno przy zwyklym awansie,
  // jak i po pokonaniu bossa (patrz onDefeated ponizej), zeby tekst zyl w JEDNYM miejscu.
  function announceTierAdvance(tier) {
    const def = MACHINE_TIERS[tier];
    audio.play('awans-bankomatu');
    showTopAnnouncement(
      '🎰 AWANS BANKOMATU!',
      `Wbite już <strong>${economy.state.totalChatClicks}</strong> klików - bankomat awansuje na <strong>${def.name}</strong>!`,
      3400,
    );
  }

  /**
   * Wspolna obsluga przekroczenia progu tieru - wolana ZAROWNO ze sciezki
   * klikniecia z czatu, JAK I z klikniecia wlasciciela myszka w model (oba
   * licza sie do progu, patrz economy.performClick). Gdy na dany tier czeka
   * niepokonany boss, awans jest odlozony do jego pokonania - inaczej
   * podmieniamy model i pokazujemy baner od razu.
   */
  async function obsluzAwansTieru(tier) {
    if (tier === null || tier === undefined) return;
    const def_ = BOSS_DEFS[tier];
    const alreadyDefeated = economy.state.bossesDefeated.includes(tier);
    if (def_ && !alreadyDefeated) {
      // Boss przejmuje kontrole - awans bankomatu i baner wykonaja sie
      // dopiero po pokonaniu go (patrz onDefeated w setContext ponizej).
      boss.start(tier);
      return;
    }
    await machine.setTier(tier);
    announceTierAdvance(tier);
    if (remote.czyAdmin()) {
      realtime.wyslijZdarzenie('awans-tieru', { tier });
    }
    save();
  }

  const boss = new BossManager(
    scene,
    camera,
    controls,
    machine,
    economy,
    coinPool,
    (point, text, opts) => {
      projectAndFloat(point, text, opts);
    },
  );
  await boss.init();

  // --- Tryb admina -------------------------------------------------------
  // Offline (brak API) gra dziala jak dotad, z pelnymi uprawnieniami. Na
  // Vercelu przyciski resetu i spawnowania widzi tylko zalogowany wlasciciel,
  // a kazdy zapis i tak jest sprawdzany po stronie serwera.
  const adminBtn = document.getElementById('btn-admin');

  function zastosujTrybAdmina() {
    const admin = remote.czyAdmin();
    document.body.classList.toggle('tryb-widza', !admin);
    // NAPRAWA: flagBattle.setContext() ustawia isHost tylko RAZ, przy starcie
    // main() - karta wlasciciela startujaca niezalogowana zostawala z
    // isHost=false na stale, wiec minigra nigdy nie startowala nawet po
    // zalogowaniu (patrz komentarz w flagbattle.js przy setHost). Ta funkcja
    // jest juz wolana przy starcie, logowaniu i wylogowaniu - wiec to
    // jedyne miejsce, ktore potrzebuje odswiezac role minigry w locie.
    // Musi byc PRZED wczesniejszymi "return" nizej (brak przycisku/tryb
    // lokalny), bo rola minigry ma sie zmieniac niezaleznie od tego, czy
    // przycisk admina w ogole istnieje na stronie.
    flagBattle.setHost(admin);
    // Ta sama naprawa co dla flagBattle powyzej, dla minigry tlumaczen.
    tlumaczenia.setHost(admin);
    // Ta sama naprawa co powyzej, dla minigry panstw-miast.
    panstwaMiasta.setHost(admin);
    // Ta sama naprawa co powyzej, dla minigry "Zgadnij marke".
    bitwaMarek.setHost(admin);
    // Ta sama naprawa co powyzej, dla jetpacka (src/jetpack.js).
    jetpack.setHost(admin);
    if (!adminBtn) return;
    if (czyLokalnie()) {
      // Lokalnie nie ma sie gdzie logowac - chowamy przycisk.
      adminBtn.style.display = 'none';
      return;
    }
    adminBtn.style.display = '';
    adminBtn.classList.toggle('zalogowany', admin);
    adminBtn.textContent = admin ? '🔓 Wyloguj' : '🔑 Zaloguj';
    adminBtn.title = admin
      ? 'Jesteś zalogowany jako właściciel - kliknij, żeby się wylogować'
      : 'Zaloguj się hasłem właściciela, żeby móc resetować grę i spawnować';
  }

  if (adminBtn) {
    adminBtn.addEventListener('click', async () => {
      if (remote.czyAdmin()) {
        remote.wyloguj();
        zastosujTrybAdmina();
        realtime.ustawRole({ rola: 'widz', token: null });
        return;
      }
      const haslo = window.prompt('Hasło właściciela gry:');
      if (haslo === null) return;
      const ok = await remote.zaloguj(haslo);
      if (!ok) {
        window.alert('Błędne hasło.');
        return;
      }
      zastosujTrybAdmina();
      zapiszNaSerwer(true);
      // Login mogl przyjsc po tym, jak realtime juz sie polaczyl jako widz -
      // podnosimy role do hosta i reconnectujemy z nowym tokenem admina.
      realtime.ustawRole({ rola: 'host', token: remote.token });
    });
  }
  zastosujTrybAdmina();

  const spawnBossBtn = document.getElementById('btn-spawn-boss');
  if (spawnBossBtn) {
    spawnBossBtn.addEventListener('click', () => {
      if (!remote.czyAdmin()) return;
      boss.start(1, { force: true });
    });
  }

  // Natychmiastowe pokonanie aktualnego bossa (dowolny tier). Obrazenia rowne
  // calemu HP ida zwykla sciezka boss.damage -> _onDefeatedBoss, wiec
  // animacja smierci, awans tieru i synchronizacja do widzow dzialaja tak
  // samo jak przy normalnym zwyciestwie. Poza walka (state !== 'FIGHT')
  // damage() nic nie robi.
  const instakillBossBtn = document.getElementById('btn-instakill-boss');
  if (instakillBossBtn) {
    instakillBossBtn.addEventListener('click', () => {
      if (!remote.czyAdmin()) return;
      boss.damage(boss.hp);
    });
  }

  // --- Panel eliminacji widza (właściciel) --------------------------------
  // Skutek identyczny jak trafienie rakietą bossa (patrz boss.killUserManual
  // w boss.js) - wywoływalny NIEZALEŻNIE od tego, czy trwa walka z bossem.
  // Widoczność przycisku idzie tym samym mechanizmem co reszta panelu admina
  // (body.tryb-widza w style.css); klik dodatkowo strzeże remote.czyAdmin(),
  // dokladnie tak samo jak spawnVanessaBtn/spawnBossBtn powyzej.
  const eliminacjaBtn = document.getElementById('btn-eliminacja');
  const eliminacjaPanel = document.getElementById('eliminacja-panel');
  const eliminacjaLista = document.getElementById('eliminacja-lista');

  function zamknijPanelEliminacji() {
    if (eliminacjaPanel) eliminacjaPanel.hidden = true;
  }

  function wykonajEliminacje(nick) {
    if (!nick) return;
    // Straz niezalezna od ukrycia przycisku w CSS i od bramki na otwarciu
    // panelu - ukrycie jest kosmetyka, a TO jest faktyczny warunek wykonania
    // akcji (ta sama zasada co przy spawnVanessaBtn/spawnBossBtn wyzej).
    if (!remote.czyAdmin()) return;
    const potwierdzone = window.confirm(
      `Na pewno wyeliminować @${nick}? Straci cały dorobek i zniknie z rankingu (może wrócić od zera, pisząc cokolwiek na czacie).`,
    );
    if (!potwierdzone) return;
    boss.killUserManual(nick);
    // Rozgłoszenie do widzów - bez tego animacje smierci i zniknięcie z
    // rankingu zobaczy tylko karta wlasciciela, az do najblizszego snapshotu.
    if (remote.czyAdmin()) {
      realtime.wyslijZdarzenie('eliminacja', { nick });
    }
    zamknijPanelEliminacji();
  }

  function renderPanelEliminacji() {
    if (!eliminacjaLista) return;
    eliminacjaLista.innerHTML = '';
    const top = kickChat.getTopEarners(10);
    if (!top.length) {
      const pusto = document.createElement('div');
      pusto.className = 'eliminacja-pusto';
      pusto.textContent = 'Ranking jest pusty - nie ma kogo eliminować.';
      eliminacjaLista.appendChild(pusto);
      return;
    }
    top.forEach((wpis) => {
      const slot = kickChat.getWorkerForUser(wpis.username);
      const pozycja = document.createElement('div');
      pozycja.className = 'eliminacja-pozycja';
      const nickEl = document.createElement('span');
      nickEl.className = 'eliminacja-pozycja-nick';
      nickEl.textContent = `@${wpis.username}`;
      const infoEl = document.createElement('span');
      infoEl.className = 'eliminacja-pozycja-info';
      infoEl.textContent = slot !== null ? `${fmtShort(wpis.totalEarned)} zł · slot ${slot + 1}` : `${fmtShort(wpis.totalEarned)} zł`;
      pozycja.appendChild(nickEl);
      pozycja.appendChild(infoEl);
      pozycja.addEventListener('click', () => wykonajEliminacje(wpis.username));
      eliminacjaLista.appendChild(pozycja);
    });
  }

  if (eliminacjaBtn && eliminacjaPanel) {
    eliminacjaBtn.addEventListener('click', (ev) => {
      if (!remote.czyAdmin()) return;
      ev.stopPropagation();
      const otwarty = !eliminacjaPanel.hidden;
      if (otwarty) {
        zamknijPanelEliminacji();
        return;
      }
      renderPanelEliminacji();
      eliminacjaPanel.hidden = false;
    });
    eliminacjaPanel.addEventListener('click', (ev) => ev.stopPropagation());
    document.addEventListener('click', () => zamknijPanelEliminacji());
  }

  const kickUI = new KickUI();
  new KickEmbedUI();
  new LegendUI();
  const leaderboardUI = new LeaderboardUI();
  const workerOverlays = new WorkerOverlayManager();
  let ui;

  let isSyncingLeaderboard = false;
  let hasQueuedSync = false;

  // Uwaga (naprawa deadlocka): flaga isSyncingLeaderboard NIGDY nie moze
  // zostac zablokowana na true. Caly korpus idzie przez try/catch/finally,
  // blad pojedynczego slotu (np. chwilowy blad sieci przy ladowaniu modelu)
  // jest lapany osobno i tylko logowany, a kolejne zapytania o sync sa
  // obslugiwane petla `while`, NIE rekurencyjnym wywolaniem z `finally`
  // (rekurencja pod nieudanym promise'em uciekala jako unhandled rejection
  // i zostawiala flage zablokowana).
  async function syncLeaderboardAndOverlays() {
    if (isSyncingLeaderboard) {
      hasQueuedSync = true;
      return;
    }
    isSyncingLeaderboard = true;
    try {
      do {
        hasQueuedSync = false;
        try {
          kickChat.updateAssignments();
          for (let slot = 0; slot < 10; slot++) {
            try {
              const user = kickChat.getUserForWorker(slot);
              // Ikona ekwipunku Skorpiona (tier 4, patrz src/boss-skorpion.js)
              // na plakietce nad postacia - getUserForWorker buduje nowy
              // obiekt bez tego pola, wiec dopisujemy je tu (LeaderboardUI
              // czyta je wprost z wpisu rankingu, bez tej lokalnej latki).
              if (user && boss.skorpion) user.przedmiotSkorpion = boss.skorpion.getItemForUsername(user.username);
              workerOverlays.updateWorkerUser(slot, user);
              if (user) {
                await ensureWorkerType(slot, user.skin);
              }
            } catch (slotErr) {
              // Blad pojedynczego slotu (np. zerwane polaczenie przy ladowaniu
              // modelu postaci) nie moze przerwac przetwarzania pozostalych slotow.
              console.error(`[sync] Blad przy synchronizacji slotu ${slot}:`, slotErr);
            }
          }
          leaderboardUI.render(kickChat.getTopEarners(10), (s) => WORKER_TYPE_DEFS[s]?.name, kickChat);
        } catch (err) {
          console.error('[sync] Blad synchronizacji rankingu i awatarow:', err);
        }
      } while (hasQueuedSync);
    } finally {
      isSyncingLeaderboard = false;
    }
  }

  const kickChat = new KickChatClient({
    chatroomId: 37663,
    channelName: 'patiro',
    onStatusChange: ({ status, message, stats }) => {
      kickUI.updateStatus(status, message);
      kickUI.updateKliksCount(stats.kliksReceived);
    },
    // Sekretny kod czatu "rocketman" (patrz kick.js KODY/onRocketman) - host
    // decyduje, widz dostaje efekt przez applySync (patrz jetpack.js).
    onRocketman: () => {
      jetpack.triggerRocketman();
    },
    onMessage: (msg) => {
      kickUI.addMessage(msg);
      // Sprawdzenie czy widz na czacie napisał sekretne hasło Vanessy
      vanessa.checkChatWord(msg.content, msg.username, msg.color);
      // Odpowiedzi na dzialania matematyczne bossa oraz komenda "pomoc" (omdlenia)
      boss.onChatMessage(msg.username, msg.content, msg.color);
      // Odpowiedzi do bitwy o flagi
      flagBattle.onChatMessage(msg.username, msg.content);
      // Odpowiedzi do bitwy tlumaczen
      tlumaczenia.onChatMessage(msg.username, msg.content);
      // Odpowiedzi do bitwy panstw-miast
      panstwaMiasta.onChatMessage(msg.username, msg.content);
      // Odpowiedzi do bitwy o marki
      bitwaMarek.onChatMessage(msg.username, msg.content);
      // Chodzenie po siatce 2D areny - tylko dla aktywnych graczy w grze (Top 10)
      // Pojedyncza komenda albo kombinacja (np. "wwd", max 5 znakow) - patrz
      // parseMovementCombo w workers.js. Nowa kombinacja od tego samego widza
      // zastepuje reszte jego poprzedniej kolejki (queueMoves).
      const moveCombo = parseMovementCombo(msg.content);
      if (moveCombo) {
        const slot = kickChat.getWorkerForUser(msg.username);
        if (
          slot !== null &&
          (!boss.isFainted || !boss.isFainted(msg.username)) &&
          (!vanessa.isStealingFrom || !vanessa.isStealingFrom(msg.username))
        ) {
          workerManager.queueMoves(slot, moveCombo);
        }
      }
    },
    onTopWorkerChat: ({ workerIndex, content }) => {
      // Komendy ruchu (pojedyncze i kombinacje) nie powinny wyzwalać animacji
      // uderzenia w bankomat ani dymków
      if (parseMovementCombo(content)) return;

      const clean = (content || '').trim();
      if (!clean) return;

      workerOverlays.showSpeechBubble(workerIndex, clean);
      const entry = workerManager.getWorkerType(workerIndex);
      if (entry && !entry.isFainted && !entry.isMoving) {
        workerManager.triggerInteract(entry);
      }
    },
    onKlik: async (sender, chatItem) => {
      const nick = sender.username || 'Widz';

      // Omdlony przez bossa widz nie moze klikac - jego wiadomosc jest w calosci
      // ignorowana (bez kasy, bez licznika klikow, bez wplywu na prog tieru).
      if (boss.isFainted(nick)) {
        return;
      }

      // id wiadomosci czatu, ktora wywolala klik - zakotwicza losowanie krytyka
      // (patrz economy.performClick), zeby kazda otwarta karta gry, widzac ta
      // sama wiadomosc z tego samego kanalu Kicka, wylosowala ten sam wynik.
      const { value, isCrit, combo, tierAdvanced } = economy.performClick(
        performance.now(),
        true,
        chatItem && chatItem.id,
      );
      machine.triggerClickAnim();
      audio.play('klik');
      if (isCrit) audio.play('kryt');
      maybePlayComboSound(combo);
      coinPool.burst(machineBurstOrigin, value);
      const text = isCrit ? `KRYT! +${fmtShort(value)} (@${nick})` : `+${fmtShort(value)} (@${nick})`;
      projectAndFloat(machineBurstOrigin, text, { crit: isCrit, kick: true });
      kickUI.updateKliksCount(kickChat.stats.kliksReceived);

      // UWAGA: klik z czatu NIE jest tu rozglaszany zdarzeniem realtime.
      // Kazda karta (wlasciciela i kazdego widza) ma wlasne polaczenie z
      // czatem Kicka i widzi te sama wiadomosc sama, natychmiast -
      // wiec rozgloszenie byloby zbedne i dawaloby podwojny efekt u widzow
      // (raz z ich wlasnego czatu, raz z tego zdarzenia). Zdarzenie 'klik'
      // jest rozglaszane WYLACZNIE dla klikniec wlasciciela myszka w model
      // 3D (patrz machine.onClickHit nizej), bo tych widz nie ma jak sam
      // zobaczyc.

      // Rejestracja wygenerowanego zarobku w rankingu widzów (automatycznie wywołuje onLeaderboardUpdate)
      kickChat.recordEarned(nick, value, sender.identity?.color);

      // Jeśli klikający widz ma przypisanego pracownika, wywołujemy również jego animację uderzenia w bankomat
      const assignedSlot = kickChat.getWorkerForUser(nick);
      if (assignedSlot !== null) {
        const entry = workerManager.getWorkerType(assignedSlot);
        if (entry) {
          workerManager.triggerInteract(entry);
        }
      }

      // Automatyczny awans tieru automatu - gdy laczna liczba klikniec z czatu
      // przekroczy kolejny prog (patrz MACHINE_TIER_CLICK_THRESHOLDS w economy.js).
      await obsluzAwansTieru(tierAdvanced);
    },
    onLeaderboardUpdate: () => {
      syncLeaderboardAndOverlays().catch((err) => {
        console.error('[sync] Nieobsluzony blad w syncLeaderboardAndOverlays (onLeaderboardUpdate):', err);
      });
    },
  });
  // workerManager.setContext (src/workers.js) egzekwuje blokady ruchu
  // wszystkich minigier na siatce - isPlayerLocked/isTileLocked dla bitwy o
  // flagi, bitwy tlumaczen, panstw-miast ORAZ bitwy o marki (patrz
  // moveWorker() w workers.js).
  workerManager.setContext({ boss, vanessa, flagBattle, tlumaczenia, panstwaMiasta, bitwaMarek, economy });
  jetpack.setContext({ workerManager, flagBattle, tlumaczenia, panstwaMiasta, bitwaMarek, economy });
  vanessa.setContext({ workerManager, kickChat });
  // Ta sama polityka co machine.czyKlikaniaDozwolone powyzej - patrz komentarz
  // tam. Obejmuje wszystkie 3 sciezki klikania myszka w Vanesse (model,
  // plakietka, dymek), bo wszystkie ida przez jeden wspolny straznik w
  // vanessa.chaseAway() (patrz vanessa.js).
  vanessa.czyKlikaniaDozwolone = () => remote.czyAdmin();
  // Ta sama polityka co machine.czyKlikaniaDozwolone/vanessa.czyKlikaniaDozwolone
  // powyzej - patrz komentarz przy czyNaliczanieDozwolone w boss.js: naliczanie
  // nagrody 10 zl za poprawna odpowiedz to decyzja, wiec tylko host ja podejmuje.
  boss.czyNaliczanieDozwolone = () => remote.czyAdmin();
  boss.setContext({
    workerManager,
    workerOverlays,
    kickChat,
    vanessa,
    onDefeated: async (tier) => {
      await machine.setTier(tier);
      announceTierAdvance(tier);
      const nazwaBossa = (BOSS_DEFS[tier] && BOSS_DEFS[tier].name) || (boss.def ? boss.def.name : 'Boss');
      showTopAnnouncement(
        `🏆 ${nazwaBossa.toUpperCase()} POKONANY!`,
        `Boss <strong>${nazwaBossa}</strong> został pokonany przez czat! Bankomat wraca do gry na nowym tierze.`,
        3200,
      );
      if (!economy.state.bossesDefeated.includes(tier)) {
        economy.state.bossesDefeated.push(tier);
      }
      // Powiekszenie areny (7x7 -> 9x9) WYLACZNIE po Skorpionie (tier 4), PO
      // dopisaniu do bossesDefeated (arenaHalf juz widzi nowy rozmiar) i PO
      // banerze zwyciestwa powyzej - kolejnosc z zadania: "najpierw
      // zwyciestwo/awans bankomatu, potem powiekszenie". _finishVictory w
      // boss.js juz odblokowala kamere (patrz _teardown) zanim ten callback
      // w ogole sie odpala, wiec blokada kamery cutscenki nie koliduje z
      // blokada kamery bossa.
      if (tier === arena.SKORPION_TIER) {
        await arena.growWithCutscene(economy);
      }
      save();
    },
    save,
    onGameOver: async (tekst) => {
      // Wolane przez BossBlackjack (boss 3, tier 3, bez argumentu - domyslny
      // tekst) albo BossSkorpion (boss 4, tier 4, z wlasnym tekstem) na
      // hoscie, gdy pula gracza spadnie do zera (patrz
      // src/boss-blackjack.js/_zastosujWynik i src/boss-skorpion.js/_wywolajGameOver).
      // Widzowie dostaja to samo zdarzenie (z tym samym tekstem) natychmiast
      // kanalem realtime (patrz zastosujZdarzenieZdalne powyzej) - oni NIGDY
      // nie odpalaja game over sami z siebie.
      if (remote.czyAdmin()) {
        realtime.wyslijZdarzenie('game-over', { tekst });
      }
      audio.play('game-over');
      await pokazGameOver(tekst);
      // Reset PO tym, jak ekran jest juz w calosci ciemny - nie synchronicznie
      // w srodku boss.update() (patrz zadanie wlasciciela).
      await pelnyResetGry();
    },
  });
  goldCoin.setContext({
    workerManager,
    kickChat,
    economy,
    coinPool,
    projectAndFloat,
    save,
  });
  flagBattle.setContext({
    workerManager,
    kickChat,
    economy,
    isHost: remote.czyAdmin(),
    boss,
    tlumaczenia, // wylacznie do odczytu tlumaczenia.tile - patrz komentarz w flagbattle.js/setContext
    panstwaMiasta, // wylacznie do odczytu panstwaMiasta.tile - patrz komentarz w flagbattle.js/setContext
    bitwaMarek, // wylacznie do odczytu bitwaMarek.tile - patrz komentarz w flagbattle.js/setContext
  });
  tlumaczenia.setContext({
    workerManager,
    kickChat,
    economy,
    isHost: remote.czyAdmin(),
    boss,
    flagBattle, // wylacznie do odczytu flagBattle.tile - patrz komentarz w tlumaczenia.js/setContext
    panstwaMiasta, // wylacznie do odczytu panstwaMiasta.tile - patrz komentarz w tlumaczenia.js/setContext
    bitwaMarek, // wylacznie do odczytu bitwaMarek.tile - patrz komentarz w tlumaczenia.js/setContext
  });
  // Minigra "Panstwa-Miasta" - ten sam wzorzec co flagBattle/tlumaczenia
  // powyzej, z referencjami do OBU pozostalych minigier (wylacznie do
  // odczytu ich .tile - patrz komentarz w panstwa-miasta.js/setContext).
  panstwaMiasta.setContext({
    workerManager,
    kickChat,
    economy,
    isHost: remote.czyAdmin(),
    boss,
    flagBattle,
    tlumaczenia,
    bitwaMarek, // wylacznie do odczytu bitwaMarek.tile - patrz komentarz w panstwa-miasta.js/setContext
  });
  // Minigra "Zgadnij marke" - ten sam wzorzec co pozostale trzy minigry
  // powyzej, z referencjami do WSZYSTKICH pozostalych trzech minigier
  // (wylacznie do odczytu ich .tile - patrz komentarz w
  // bitwa-marek.js/setContext).
  bitwaMarek.setContext({
    workerManager,
    kickChat,
    economy,
    isHost: remote.czyAdmin(),
    boss,
    flagBattle,
    tlumaczenia,
    panstwaMiasta,
  });
  // Narracja bitwy ("Bitwa o flagi! X vs Y!", "X wygrywa!"...) dociera do
  // widza z hostowej karty natychmiast przez kanal realtime, zamiast czekac
  // do najblizszego snapshotu co 2 s. U widza announce() (wywolane z
  // zastosujZdarzenieZdalne nizej) i tak dopisuje ten sam tekst lokalnie -
  // onAnnounce tam jest no-op (bo isHost=false), wiec nie ma petli.
  flagBattle.onAnnounce = (text) => {
    if (remote.czyAdmin()) {
      realtime.wyslijZdarzenie('flaga-info', { text });
    }
  };
  // Dymek "+2 zl" nad zwyciezca minigry, raz na sekunde w trakcie nagrody
  // (patrz komentarz przy onRewardTick w flagbattle.js). Samo naliczanie
  // kasy juz dziala (economy.addMoney w tick()) - to WYLACZNIE wizualne
  // potwierdzenie, idzie przez ten sam sprawdzony projectAndFloat co kazdy
  // inny dymek w grze (a wiec przez #floaters, nie przez nieistniejacy
  // #ui-layer, ktory kiedys polozyl produkcje - patrz historia tego pliku).
  flagBattle.onRewardTick = (winner) => {
    const w = workerManager.getWorkerType(winner.typeIndex);
    if (!w || !w.obj) return;
    const origin = w.obj.position.clone().add(new THREE.Vector3(0, 1.8, 0));
    projectAndFloat(origin, '+2 zł', { crit: false });
  };
  // Ten sam wzorzec co flagBattle.onAnnounce/onRewardTick powyzej, dla
  // minigry tlumaczen.
  tlumaczenia.onAnnounce = (text) => {
    if (remote.czyAdmin()) {
      realtime.wyslijZdarzenie('tlumaczenia-info', { text });
    }
  };
  tlumaczenia.onRewardTick = (winner) => {
    const w = workerManager.getWorkerType(winner.typeIndex);
    if (!w || !w.obj) return;
    const origin = w.obj.position.clone().add(new THREE.Vector3(0, 1.8, 0));
    projectAndFloat(origin, '+2 zł', { crit: false });
  };
  // Ten sam wzorzec co flagBattle.onAnnounce/onRewardTick i
  // tlumaczenia.onAnnounce/onRewardTick powyzej, dla minigry panstw-miast.
  panstwaMiasta.onAnnounce = (text) => {
    if (remote.czyAdmin()) {
      realtime.wyslijZdarzenie('panstwa-miasta-info', { text });
    }
  };
  panstwaMiasta.onRewardTick = (winner) => {
    const w = workerManager.getWorkerType(winner.typeIndex);
    if (!w || !w.obj) return;
    const origin = w.obj.position.clone().add(new THREE.Vector3(0, 1.8, 0));
    projectAndFloat(origin, '+2 zł', { crit: false });
  };
  // Ten sam wzorzec co flagBattle/tlumaczenia/panstwaMiasta onAnnounce/
  // onRewardTick powyzej, dla minigry "Zgadnij marke".
  bitwaMarek.onAnnounce = (text) => {
    if (remote.czyAdmin()) {
      realtime.wyslijZdarzenie('marki-info', { text });
    }
  };
  bitwaMarek.onRewardTick = (winner) => {
    const w = workerManager.getWorkerType(winner.typeIndex);
    if (!w || !w.obj) return;
    const origin = w.obj.position.clone().add(new THREE.Vector3(0, 1.8, 0));
    projectAndFloat(origin, '+2 zł', { crit: false });
  };

  // Widz otwierajacy karte w trakcie walki z bossem podejmuje ja od razu, bez
  // cutscenki, z tym samym hp/licznikami co u admina (patrz boss.applySync).
  // Admin sam prowadzi walke lokalnie - u niego to by ja nadpisalo.
  if (!remote.czyAdmin() && poczatkowyStanBossa) {
    boss.applySync(poczatkowyStanBossa);
  }

  try {
    await syncLeaderboardAndOverlays();
  } catch (err) {
    console.error('[sync] Nieobsluzony blad w syncLeaderboardAndOverlays (start):', err);
  }
  kickChat.connect();

  // Przy uruchomieniu LOKALNYM nie tykamy produkcyjnego przekaznika.
  //
  // Powod jest powazny: lokalnie czyAdmin() zwraca true (patrz remote.js), wiec
  // karta deweloperska laczyla sie do wss://bankomat-relay.onrender.com w roli
  // HOSTA. Relay przy nowym hoscie rozlacza starego ("Nowy host przejmuje role"),
  // wiec lokalne odpalenie gry z poprawnym haslem wyrzuciloby z przekaznika
  // karte prowadzaca stream. Do tego produkcyjne snapshoty wpadalyby co 2 s do
  // karty lokalnej, nadpisujac to, co sie wlasnie testuje.
  //
  // Wlacznik na zadanie: ?relay=1 w adresie albo
  // localStorage['bankomat-clicker-relay-lokalnie'] = '1'.
  function relayDozwolonyLokalnie() {
    try {
      if (new URLSearchParams(location.search).get('relay') === '1') return true;
      return localStorage.getItem('bankomat-clicker-relay-lokalnie') === '1';
    } catch (_) {
      return false;
    }
  }

  if (czyLokalnie() && !relayDozwolonyLokalnie()) {
    console.info(
      '[realtime] Uruchomienie lokalne - przekaznik wylaczony, zeby nie przejac roli hosta ' +
      'od karty na produkcji. Wlacz swiadomie przez ?relay=1 albo ' +
      "localStorage['bankomat-clicker-relay-lokalnie']='1'."
    );
  } else {
    realtime.polacz();
  }

  ui = new UI(economy, {
    onReset: async () => {
      if (!remote.czyAdmin()) return;
      await pelnyResetGry();
    },
  });

  const projected = new THREE.Vector3();
  function projectAndFloat(point, text, opts) {
    projected.copy(point);
    projected.project(camera);
    const rect = canvas.getBoundingClientRect();
    const sx = rect.left + (projected.x * 0.5 + 0.5) * rect.width;
    const sy = rect.top + (-projected.y * 0.5 + 0.5) * rect.height;
    ui.spawnFloater(text, sx, sy, opts);
  }

  machine.onClickHit = (point) => {
    // Klik streamera bezposrednio w model 3D - dolicza kase do wspolnej puli
    // ORAZ liczy sie do progu awansu tieru, dokladnie tak samo jak klik z
    // czatu. Krytyk zostaje losowany lokalnie (brak wiadomosci czatu, wiec
    // brak msgId do zakotwiczenia) - to nieszkodliwe, bo karta wlasciciela
    // jest autorytetem i rozsyla wynik widzom kanalem realtime.
    const { value, isCrit, tierAdvanced } = economy.performClick(performance.now(), true);
    audio.play('klik-gracz');
    if (isCrit) audio.play('kryt');
    coinPool.burst(point, value);
    const text = isCrit ? `KRYT! +${fmtShort(value)}` : `+${fmtShort(value)}`;
    projectAndFloat(point, text, { crit: isCrit });

    // Widzowie dostaja klik wlasciciela natychmiast - to JEDYNE zrodlo klikow,
    // dla ktorego zdarzenie 'klik' jest rozglaszane (patrz komentarz w onKlik
    // powyzej): widz nie ma czatowej wiadomosci, z ktorej sam by sie o tym dowiedzial.
    if (remote.czyAdmin()) {
      realtime.wyslijZdarzenie('klik', { zrodlo: 'gracz', wartosc: value, isCrit });
    }
    obsluzAwansTieru(tierAdvanced).catch((err) =>
      console.error('[klik-gracz] Blad awansu tieru:', err),
    );
  };

  // Ekspozycja do debugowania/weryfikacji w konsoli przeglądarki.
  window.__game = {
    audio,
    arena,
    economy,
    machine,
    workerManager,
    coinPool,
    goldCoin,
    vanessa,
    boss,
    ui,
    kickChat,
    kickUI,
    leaderboardUI,
    workerOverlays,
    syncLeaderboardAndOverlays,
    synchronizujZSerwera,
    resetLokalny,
    remote,
    realtime,
    flagBattle,
    tlumaczenia,
    panstwaMiasta,
    bitwaMarek,
    jetpack,
    warstwaMinigier,
    save,
    scene,
    camera,
    renderer,
    city,
  };

  function animate() {
    requestAnimationFrame(animate);
    const delta = Math.min(0.1, clock.getDelta());

    // W trakcie cutscenki bossa kamera jest w pelni pod jego kontrola -
    // controls.update() nadpisalby recznie ustawiona pozycje (OrbitControls
    // zawsze przelicza kamere z wewnetrznego stanu sferycznego, ignorujac
    // reczne zmiany camera.position).
    if (!boss.isCameraLocked() && !arena.isCameraLocked()) {
      controls.update();
    }
    arena.update(delta);
    vanessa.paused = boss.isActive();
    machine.update(delta);
    workerManager.update(delta);
    coinPool.update(delta);
    goldCoin.update(delta);
    // Minigra jest najmlodszym i najmniej sprawdzonym modulem, a tick() leci
    // w petli klatek PRZED renderowaniem - wyjatek stad przerywal cala klatke
    // razem z rysowaniem sceny i kladl gre na produkcji (patrz commit
    // "Naprawa: minigra flag wywalala cala gre na produkcji"). Tamta naprawa
    // usunela przyczyne, ale nie kruchosc. Teraz blad minigry degraduje
    // WYLACZNIE minigre: po trzech bledach pod rzad przestajemy ja tykac,
    // a gra leci dalej. Rdzen gry zostaje bez oslony celowo - tam bledy maja
    // byc glosne.
    if (!flagBattleZepsuta) {
      try {
        flagBattle.tick(delta);
        flagBattleBledy = 0;
      } catch (err) {
        flagBattleBledy += 1;
        console.error(`[flagi] Blad w tick() minigry (${flagBattleBledy}/3):`, err);
        if (flagBattleBledy >= 3) {
          flagBattleZepsuta = true;
          console.error('[flagi] Minigra wylaczona po trzech bledach pod rzad - reszta gry dziala normalnie.');
        }
      }
    }
    // Ta sama izolacja bledow co flagBattle powyzej - minigra tlumaczen jest
    // rowniez mlodym modulem, blad w jej tick() nie moze polozyc calej gry.
    if (!tlumaczeniaZepsuta) {
      try {
        tlumaczenia.tick(delta);
        tlumaczeniaBledy = 0;
      } catch (err) {
        tlumaczeniaBledy += 1;
        console.error(`[tlumaczenia] Blad w tick() minigry (${tlumaczeniaBledy}/3):`, err);
        if (tlumaczeniaBledy >= 3) {
          tlumaczeniaZepsuta = true;
          console.error('[tlumaczenia] Minigra wylaczona po trzech bledach pod rzad - reszta gry dziala normalnie.');
        }
      }
    }
    // Ta sama izolacja bledow co flagBattle/tlumaczenia powyzej - minigra
    // panstw-miast jest rowniez mlodym modulem, blad w jej tick() nie moze
    // polozyc calej gry.
    if (!panstwaMiastaZepsuta) {
      try {
        panstwaMiasta.tick(delta);
        panstwaMiastaBledy = 0;
      } catch (err) {
        panstwaMiastaBledy += 1;
        console.error(`[panstwa-miasta] Blad w tick() minigry (${panstwaMiastaBledy}/3):`, err);
        if (panstwaMiastaBledy >= 3) {
          panstwaMiastaZepsuta = true;
          console.error('[panstwa-miasta] Minigra wylaczona po trzech bledach pod rzad - reszta gry dziala normalnie.');
        }
      }
    }
    // Ta sama izolacja bledow co flagBattle/tlumaczenia/panstwaMiasta powyzej -
    // minigra "Zgadnij marke" jest rowniez mlodym modulem, blad w jej tick()
    // nie moze polozyc calej gry.
    if (!bitwaMarekZepsuta) {
      try {
        bitwaMarek.tick(delta);
        bitwaMarekBledy = 0;
      } catch (err) {
        bitwaMarekBledy += 1;
        console.error(`[marki] Blad w tick() minigry (${bitwaMarekBledy}/3):`, err);
        if (bitwaMarekBledy >= 3) {
          bitwaMarekZepsuta = true;
          console.error('[marki] Minigra wylaczona po trzech bledach pod rzad - reszta gry dziala normalnie.');
        }
      }
    }
    // Ta sama izolacja bledow co flagBattle/tlumaczenia/panstwaMiasta/bitwaMarek
    // powyzej - jetpack (kod czatu "rocketman", patrz src/jetpack.js) jest
    // rowniez wylacznie kosmetycznym, mlodym modulem.
    if (!jetpackZepsuty) {
      try {
        jetpack.tick(delta);
        jetpackBledy = 0;
      } catch (err) {
        jetpackBledy += 1;
        console.error(`[jetpack] Blad w tick() (${jetpackBledy}/3):`, err);
        if (jetpackBledy >= 3) {
          jetpackZepsuty = true;
          console.error('[jetpack] Wylaczony po trzech bledach pod rzad - reszta gry dziala normalnie.');
        }
      }
    }
    city.update(delta);

    // Brak dochodu pasywnego - zl powstaja WYLACZNIE z klikniec.
    // Awatary Top 10 animuja sie tylko wtedy, gdy ich widz naprawde napisze
    // "klik" na czacie (obsluga w onKlik ponizej), wiec animacja zawsze
    // odpowiada realnemu klikniecu, a nie tyka sama z siebie.

    // Ceny i wyszarzenie przyciskow odswiezaja sie w refreshNumbers (co 100 ms)
    // bez przebudowy DOM.
    ui.refreshNumbers(performance.now());

    const canvasRect = canvas.getBoundingClientRect();

    // Aktualizacja złodziejki Vanessy (ruch, animacja, kradzież, rzutowanie dymków i plakietki)
    vanessa.update(delta, camera, canvasRect);

    // Aktualizacja bossa (cutscenka, walka matematyczna, omdlenia, rzutowanie plakietki i dymka)
    boss.update(delta, camera, canvasRect);

    // Aktualizacja pozycji plakietek z nickami i dymków czatu nad głowami pracowników w rzucie 3D -> 2D
    workerOverlays.updatePositions(workerManager.entries, camera, canvasRect);

    // Karty minigier na pierwszej warstwie (patrz src/warstwa-minigier.js) -
    // ta sama izolacja bledow co flagBattle/tlumaczenia/panstwaMiasta/
    // bitwaMarek/jetpack powyzej.
    if (!warstwaMinigierZepsuta) {
      try {
        warstwaMinigier.update(canvasRect);
        warstwaMinigierBledy = 0;
      } catch (err) {
        warstwaMinigierBledy += 1;
        console.error(`[warstwa-minigier] Blad w update() (${warstwaMinigierBledy}/3):`, err);
        if (warstwaMinigierBledy >= 3) {
          warstwaMinigierZepsuta = true;
          console.error('[warstwa-minigier] Wylaczona po trzech bledach pod rzad - reszta gry dziala normalnie.');
        }
      }
    }

    renderer.render(scene, camera);
  }
  animate();

  setInterval(save, 5000);
  // Wlasciciel: snapshot kanalem realtime co 2 s (dodatkowo do zapisu w KV co
  // 5 s - patrz zapiszNaSerwer). No-op, gdy ta karta nie jest hostem albo
  // polaczenie realtime jest akurat zerwane (patrz Realtime.wyslijSnapshot).
  setInterval(() => {
    if (remote.czyAdmin() && realtime.czyPolaczony()) {
      realtime.wyslijSnapshot(zbierzStan());
    }
  }, 2000);
  // Widzowie (bez hasla admina) co 10 s dociagaja stan prowadzony przez admina -
  // ZAPASOWO, tylko gdy kanal realtime nie dziala albo host jest offline. Gdy
  // realtime dziala, snapshoty przychodza juz co 2 s pushem - podwojne
  // odpytywanie KV byloby zbedne (i to wlasnie ono mialo generowac koszt
  // rosnacy z widownia, patrz diagnoza w opisie zadania).
  setInterval(() => {
    if (!remote.czyAdmin() && realtimeHostOnline) return;
    synchronizujZSerwera().catch((err) => console.warn('[stan] Blad synchronizacji:', err));
  }, 10000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') save();
  });
  window.addEventListener('beforeunload', save);
}

main().catch((err) => {
  console.error('Blad startu gry:', err);
});
