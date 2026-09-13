import * as THREE from 'three';
import { KATEGORIE, LITERY_DOZWOLONE, dopasujOdpowiedzi } from './panstwa-miasta-dane.js';
import { usunTagiEmotek } from './kick.js';
import { loadForest } from './assets.js';
import { strumien, losujInt, pozycjaBezPowtorek } from './rng.js';
import { Bojka } from './bojka.js';

// Minigra "Panstwa-Miasta" - CZWARTA minigra na siatce areny, obok bitwy o
// flagi i bitwy tlumaczen. Mechanika jest CELOWO skopiowana z
// src/tlumaczenia.js/src/flagbattle.js (stany IDLE -> WAITING -> BATTLE ->
// REWARD, wejscie dwoch graczy na kafelek, getSyncState/applySync, setHost,
// przerwanie przez bossa, wysuwane plotki...) - a NIE wyciagnieta z nich jako
// wspolna klasa bazowa. Patrz obszerny komentarz na gorze tlumaczenia.js po
// pelne uzasadnienie tej decyzji (bitwa o flagi dwa razy w historii projektu
// polozyla cala produkcje - dorzucanie abstrakcji na potrzeby TRZECIEJ kopii
// zwiekszaloby ryzyko regresji w JUZ DZIALAJACYM kodzie). NIE modyfikujemy
// flagbattle.js/tlumaczenia.js poza (opisanym w ich naglowkach) minimalnym
// dopiskiem do kolizji kafelkow.
//
// Roznica wzgledem flag/tlumaczen: losowana jest litera, a kazdy z dwoch
// graczy ma wlasna rubryke trzech kategorii (Panstwo/Imie/Owoc - patrz
// src/panstwa-miasta-dane.js), ktora wypelnia odpowiedziami z czatu. Ta sama
// odpowiedz (to samo `id`) nie moze wystapic dwa razy w jednej rundzie -
// ani u tego samego gracza, ani u przeciwnika (patrz onChatMessage nizej).

// Wysokosc znacznika kontestowanego pola. Zajete poziomy w projekcie: 0.025
// wierzch kafla podlogi (scene.js), 0.035 neonowa siatka areny (scene.js),
// 0.042 znaczniki atakow bossa (bossattack.js), 0.048 wskaznik zlotej monety
// (goldcoin.js), 0.052 znacznik bitwy o flagi (flagbattle.js), 0.056 znacznik
// bitwy tlumaczen (tlumaczenia.js). 0.060 jest KOLEJNYM wolnym poziomem ponad
// wszystkimi - wejscie w cudzy poziom odtworzyloby migotanie podlogi
// (z-fighting), ktore w tym projekcie juz raz naprawiono.
const MARKER_Y = 0.060;

// Kolor minigry: POMARANCZOWY - wyraznie inny niz zajete kolory w projekcie
// (neonowa zielen siatki areny 0x53fc18, czerwien rakiet bossa 0xff3b30,
// niebiesko-fioletowe tlumaczenia 0x3d5cff, zloto monety, czerwien flag).
const KOLOR_BAZOWY = 0xff9f1c;

// Prog zwyciestwa bitwy panstw-miast: pierwszy gracz, ktory wygra
// PUNKTY_DO_WYGRANEJ RUND (nie pojedynczych odpowiedzi - runda = jedna
// litera), wygrywa cala bitwe. WSZYSTKIE miejsca w tym pliku (tekst
// ogloszenia na czacie, warunek konca bitwy) MUSZA czytac ta stala, a nie
// miec wpisanej liczby na sztywno - inaczej przy kolejnej zmianie progu
// znowu by sie rozjechaly (patrz analogiczny komentarz w tlumaczenia.js).
const PUNKTY_DO_WYGRANEJ = 3;

// Limit czasu POJEDYNCZEJ RUNDY (jednej litery) - zabezpieczenie przed
// zwisem rundy, gdy zaden gracz nie zdola wypelnic rubryki. Liczony
// WYLACZNIE przez hosta w tick() (this.rundaTimer, zerowany w kazdym
// nextRound()), tak samo jak LIMIT_CZASU_FLAGI_S/flagRoundTimer we
// flagbattle.js.
const LIMIT_CZASU_RUNDY_S = 90;

// Klipy walki - identyczne jak w tlumaczenia.js/flagbattle.js (kazda postac w
// projekcie ma je w swoim wspolnym slowniku animacji). Deterministyczny
// wybor wzgledem liczby rozegranych rund z wygrana - patrz uzycie w
// onChatMessage/applySync.
const KLIPY_ATAKU = ['attack-melee-right', 'attack-melee-left', 'attack-kick-right', 'attack-kick-left'];
function klipAtakuDlaRundy(numerRundy) {
  const i = ((numerRundy % KLIPY_ATAKU.length) + KLIPY_ATAKU.length) % KLIPY_ATAKU.length;
  return KLIPY_ATAKU[i];
}

// Szablon plotki (assets/forest/fence.glb) - loadForest() sam cache'uje
// wynik (patrz assets.js), a ten sam plik jest juz ladowany przez
// flagbattle.js/tlumaczenia.js/city.js pod tym samym kluczem, wiec to nie
// jest dodatkowe pobieranie ani osobna kopia geometrii/materialu.
let szablonPlotkiPromise = null;
function pobierzSzablonPlotki() {
  if (!szablonPlotkiPromise) szablonPlotkiPromise = loadForest('fence');
  return szablonPlotkiPromise;
}

// Rozmiar canvasu karty z litera (analogicznie do SZEROKOSC_KARTY/WYSOKOSC_KARTY
// w tlumaczenia.js).
const SZEROKOSC_KARTY = 384;
const WYSOKOSC_KARTY = 384;

// Wszystkie trzy karty (litera + 2 rubryki) w JEDNYM poziomym pasie nad
// kafelkiem bitwy. Rzut na ekran (1280x720) pokazal, ze nad kafelkiem jest
// tylko waski pas widoczny w kadrze - poziom y=2.5 uzywany przez istniejace
// minigry (flagbattle.js, tlumaczenia.js) lezy juz przy samej gornej
// krawedzi ekranu na dalekich polach, wiec pietrowy uklad (karta wyzej niz
// rubryki) nie miesci sie. Dlatego karty ida OBOK SIEBIE w osi X wzgledem
// srodka kafelka (this.tile), a nie jedna nad druga.
// KARTY_WYSOKOSC = 2.05: karta o wysokosci 1.1 zajmuje wtedy Y 1.50-2.60,
// co miesci sie w kadrze nawet na najgorszym polu.
// KARTY_ODSTEP_X = 1.5: rubryka ma szerokosc 1.7 (patrz scale w
// _zapewnijRubryki), wiec przy tym odstepie zajmuje X od -2.35 do -0.65
// (gracz 0) oraz 0.65 do 2.35 (gracz 1) - 0.1 przeswitu z kazdej strony
// karty z litera (szerokosc 1.1, X ∓0.55) na srodku.
// ponytail: przy mocnym obrocie kamery (OrbitControls) karty ustawia sie
// jedna za druga w glebi - upgrade path to jedna wspolna karta z litera i
// obiema rubrykami, gdyby to kiedys przeszkadzalo.
const KARTY_WYSOKOSC = 2.05;
const KARTY_ODSTEP_X = 1.5;

/**
 * Rysuje kafelek-karte z duza, czytelna litera na canvasie i zwraca
 * THREE.CanvasTexture. Czysto lokalne rysowanie tekstu (bez fetch, bez
 * asynchronicznego wyscigu) - wiec funkcja jest SYNCHRONICZNA, tak samo jak
 * zaladujTeksturaSlowa w tlumaczenia.js. Wynik cache'owany po literze (Map w
 * module) - ta sama litera nigdy nie rysuje canvasu drugi raz w tej samej
 * sesji karty.
 */
const cacheTeksturLiter = new Map();
function zaladujTeksturaLitery(litera, renderer) {
  if (cacheTeksturLiter.has(litera)) return cacheTeksturLiter.get(litera);

  const canvas = document.createElement('canvas');
  canvas.width = SZEROKOSC_KARTY;
  canvas.height = WYSOKOSC_KARTY;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#2b1500';
  ctx.fillRect(0, 0, SZEROKOSC_KARTY, WYSOKOSC_KARTY);
  ctx.strokeStyle = '#ffbf5c';
  ctx.lineWidth = 14;
  ctx.strokeRect(7, 7, SZEROKOSC_KARTY - 14, WYSOKOSC_KARTY - 14);
  ctx.fillStyle = '#ff9f1c';
  ctx.fillRect(0, 0, SZEROKOSC_KARTY, 46);

  ctx.fillStyle = '#2b1500';
  ctx.font = 'bold 26px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('LITERA', SZEROKOSC_KARTY / 2, 23);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 220px sans-serif';
  ctx.fillText(litera.toUpperCase(), SZEROKOSC_KARTY / 2, WYSOKOSC_KARTY / 2 + 30);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  if (renderer && renderer.capabilities && typeof renderer.capabilities.getMaxAnisotropy === 'function') {
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  }
  texture.needsUpdate = true;

  cacheTeksturLiter.set(litera, texture);
  return texture;
}

/**
 * Rysuje kilka wierszy tekstu na canvasie karty litery (SZEROKOSC_KARTY x
 * WYSOKOSC_KARTY) i zwraca CanvasTexture - uzywane do kartki ze zwyciezca
 * bitwy (patrz _pokazZwyciezce nizej). Lokalny odpowiednik
 * renderujTekstNaCanvasie z flagbattle.js - zgodnie z konwencja tego
 * projektu duplikujemy wzorzec zamiast wyciagac go do wspolnego modulu
 * (patrz obszerny komentarz na gorze tlumaczenia.js). NIE cache'owane po
 * kluczu - nick zwyciezcy jest jednorazowy.
 *
 * Dopasowanie fontu: kazda linia dostaje WLASNY rozmiar, zmierzony przez
 * ctx.measureText i zmniejszany o 2px, dopoki nie zmiesci sie w szerokosci
 * karty (margines 20px z kazdej strony) albo nie osiagnie minimalnego
 * czytelnego rozmiaru (16px) - identyczny wzorzec co w flagbattle.js.
 */
function renderujTekstNaCanvasie(linie) {
  const canvas = document.createElement('canvas');
  canvas.width = SZEROKOSC_KARTY;
  canvas.height = WYSOKOSC_KARTY;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#2b1500';
  ctx.fillRect(0, 0, SZEROKOSC_KARTY, WYSOKOSC_KARTY);
  ctx.strokeStyle = '#ffbf5c';
  ctx.lineWidth = 14;
  ctx.strokeRect(7, 7, SZEROKOSC_KARTY - 14, WYSOKOSC_KARTY - 14);

  ctx.fillStyle = '#ffd700';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const odstep = 40;
  const maxSzerokosc = SZEROKOSC_KARTY - 40;
  const minRozmiarFontu = 16;
  const startY = WYSOKOSC_KARTY / 2 - ((linie.length - 1) * odstep) / 2;
  linie.forEach((linia, i) => {
    let rozmiarFontu = 32;
    ctx.font = `bold ${rozmiarFontu}px sans-serif`;
    while (rozmiarFontu > minRozmiarFontu && ctx.measureText(linia).width > maxSzerokosc) {
      rozmiarFontu -= 2;
      ctx.font = `bold ${rozmiarFontu}px sans-serif`;
    }
    ctx.fillText(linia, SZEROKOSC_KARTY / 2, startY + i * odstep);
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

export class PanstwaMiastaManager {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;

    this.state = 'IDLE'; // IDLE, WAITING, BATTLE, REWARD
    this.timer = 0;
    this.tile = null; // {x, z}
    this.players = []; // [{ typeIndex, username, score, rubryka: {panstwo, imie, owoc} }]

    this.litera = null;
    this._loadedLitera = null; // ostatnia litera zaladowana na sprite (applySync u widza)

    // uzyteId - zbior identyfikatorow odpowiedzi juz wykorzystanych W TEJ
    // RUNDZIE (przez KTOREGOKOLWIEK z dwoch graczy) - patrz onChatMessage.
    // Zerowany w kazdym nextRound(). NIE synchronizowany osobno - widz
    // odtwarza go posrednio z players[].rubryka w applySync (patrz tam).
    this.uzyteId = new Set();

    // rundWygranych - ile rund w TEJ BITWIE zostalo juz rozstrzygnietych
    // wygrana (nie licza sie rundy zakonczone bez zwyciezcy po uplywie
    // limitu czasu). Sluzy WYLACZNIE do deterministycznego wyboru klipu ataku
    // (klipAtakuDlaRundy) - ten sam wzorzec co wordsGuessed/flagsGuessed w
    // tlumaczenia.js/flagbattle.js.
    this.rundWygranych = 0;

    // Limit czasu pojedynczej rundy (patrz LIMIT_CZASU_RUNDY_S) - liczony
    // WYLACZNIE przez hosta w tick(), zerowany w kazdym nextRound(). NIE
    // synchronizowany (host-only decyzja, jak flagRoundTimer we flagbattle.js).
    this.rundaTimer = 0;

    // battleId - patrz spawnBattleSquare()/nextRound(). Synchronizowany
    // (getSyncState/applySync), inkrementowany WYLACZNIE przez hosta.
    this.battleId = 0;

    this.rewardTimer = 0;
    this.winner = null;

    this.onAnnounce = () => {};
    this.onRewardTick = () => {};

    // Znacznik kontestowanego pola - pierscien + wypelnienie, kolor
    // pomaranczowy (KOLOR_BAZOWY), MARKER_Y = 0.060 (patrz komentarz przy stalej).
    const wspolneMat = {
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -5,
      polygonOffsetUnits: -5,
    };
    this.highlightMesh = new THREE.Group();
    this.highlightMesh.rotation.x = -Math.PI / 2;
    this.highlightMesh.position.y = MARKER_Y;
    this.highlightMesh.visible = false;

    this.markerPierscien = new THREE.Mesh(
      new THREE.RingGeometry(0.36, 0.49, 40),
      new THREE.MeshBasicMaterial({ color: KOLOR_BAZOWY, opacity: 0.95, ...wspolneMat }),
    );
    this.highlightMesh.add(this.markerPierscien);

    this.markerWypelnienie = new THREE.Mesh(
      new THREE.CircleGeometry(0.36, 32),
      new THREE.MeshBasicMaterial({ color: KOLOR_BAZOWY, opacity: 0.18, ...wspolneMat }),
    );
    this.highlightMesh.add(this.markerWypelnienie);

    this.scene.add(this.highlightMesh);

    this.plotki = [];
    this._plotkiWTrakcieBudowy = false;
    this._ostatniaSekundaDymka = null;

    // Sprite z wylosowana litera - analogicznie do wordSprite w tlumaczenia.js.
    this.letterMaterial = new THREE.SpriteMaterial({ color: 0xffffff, toneMapped: false });
    this.letterSprite = new THREE.Sprite(this.letterMaterial);
    this.letterSprite.scale.set(1.1, 1.1, 1.0);
    this.letterSprite.position.y = KARTY_WYSOKOSC;
    this.letterSprite.visible = false;
    this.scene.add(this.letterSprite);

    // Rubryki nad glowami graczy - 2 sprite'y (jeden na gracza), tworzone
    // leniwie dopiero gdy bitwa faktycznie startuje i sprzatane natychmiast
    // po jej koncu (patrz _zapewnijRubryki/_usunRubryki/_aktualizujRubryki
    // nizej) - identyczny wzorzec cyklu zycia co plotki (this.plotki wyzej).
    this.rubrykaSprites = [];

    // Tekstura kartki ze zwyciezca (patrz _pokazZwyciezce) - jednorazowa, NIE
    // cache'owana (nick jest unikalny per bitwa) - patrz identyczny
    // komentarz w flagbattle.js przy tym samym polu.
    this._winnerTexture = null;

    this.isHost = false;

    // Bijatyka + chmura kurzu (patrz src/bojka.js) - identyczny wzorzec co w
    // tlumaczenia.js/flagbattle.js: jedna wspoldzielona instancja na cale
    // zycie tej minigry.
    this.bojka = new Bojka(this.scene);
  }

  setContext({ workerManager, kickChat, economy, isHost, boss, flagBattle, tlumaczenia, bitwaMarek }) {
    this.workerManager = workerManager;
    this.kickChat = kickChat;
    this.economy = economy;
    this.boss = boss || null;
    // Referencje do minigier "Bitwa o flagi", "Tlumaczenia" i "Zgadnij marke" -
    // WYLACZNIE do odczytu ich biezacych kafelkow (.tile), zeby losowanie
    // pola panstw-miast nigdy nie trafilo w kafelek zajety przez
    // ktorakolwiek z nich (patrz spawnBattleSquare nizej). Ten sam
    // czworostronny kontrakt "tylko do odczytu cudzego .tile", jaki juz
    // laczy flagBattle/tlumaczenia/bitwaMarek nawzajem (patrz ich setContext).
    this.flagBattleRef = flagBattle || null;
    this.tlumaczeniaRef = tlumaczenia || null;
    this.bitwaMarekRef = bitwaMarek || null;
    this.setHost(isHost);
  }

  /**
   * Patrz obszerny komentarz przy tej samej metodzie w flagbattle.js -
   * identyczne uzasadnienie: isHost moze sie zmienic PO starcie (logowanie/
   * wylogowanie admina w locie), wiec main.js musi wolac to przy KAZDEJ
   * zmianie trybu admina, nie tylko raz w setContext. Kazda faktyczna zmiana
   * roli czysci lokalnie minigre do IDLE.
   */
  setHost(isHost) {
    const nowy = !!isHost;
    if (nowy === this.isHost) return;
    this.isHost = nowy;
    this.reset();
  }

  /**
   * Minigra jest odblokowana dopiero po pokonaniu bossa tieru 3 (Dzordzo).
   * Sprawdzane NA BIEZACO (economy.state.bossesDefeated.includes(3)) w
   * KAZDYM ticku, a NIE zamrazane przy starcie - dokladnie ten sam blad
   * ("warunek zamrozony przy starcie") juz raz wystapil w tym projekcie z
   * isHost (patrz komentarz w flagbattle.js/setHost), wiec go tu nie powielamy.
   */
  _czyOdblokowana() {
    return !!(this.economy && Array.isArray(this.economy.state.bossesDefeated) && this.economy.state.bossesDefeated.includes(3));
  }

  isTileLocked(x, z, typeIndex) {
    if (this.boss && this.boss.isActive()) return false;
    if (!this.tile) return false;
    if (this.tile.x !== x || this.tile.z !== z) return false;

    if (this.state === 'WAITING') return false;

    if (this.state === 'BATTLE') {
      return !this.players.some((p) => p.typeIndex === typeIndex);
    }

    return false;
  }

  isPlayerLocked(typeIndex) {
    if (this.boss && this.boss.isActive()) return false;
    if (this.state !== 'BATTLE') return false;
    return this.players.some((p) => p.typeIndex === typeIndex);
  }

  tick(dt) {
    if (this.state === 'BATTLE') {
      // Puls pomaranczowy (miejsce zielonego pulsu flag/niebiesko-fioletowego
      // tlumaczen) - funkcja Date.now(), nie losowania, wiec host i widz
      // pulsuja identycznie.
      const s = Math.sin(Date.now() * 0.005) * 0.5 + 0.5;
      this.markerPierscien.material.color.setRGB(1, 0.5 + s * 0.3, 0.05 + s * 0.2);
      this.markerPierscien.material.opacity = 0.95;
      this.markerWypelnienie.material.opacity = 0.18;
    } else if (this.state === 'REWARD') {
      const s = Math.sin(Date.now() * 0.003) * 0.5 + 0.5;
      this.markerPierscien.material.color.setRGB(1, 0.7 + s * 0.3, 0.2);
      const frac = Math.max(0, Math.min(1, 1 - this.rewardTimer / 30));
      this.markerPierscien.material.opacity = 0.95 * frac;
      this.markerWypelnienie.material.opacity = 0.18 * frac;

      if (this.winner) {
        const sekunda = Math.floor(Date.now() / 1000);
        if (this._ostatniaSekundaDymka !== sekunda) {
          this._ostatniaSekundaDymka = sekunda;
          try {
            this.onRewardTick(this.winner);
          } catch (err) {
            console.warn('[panstwa-miasta] Blad w onRewardTick:', err);
          }
        }
      }
    }

    this._aktualizujPlotki(dt);
    // Rubryki graczy - pozycja + tresc, patrz komentarz przy metodzie. Kosmetyka
    // wyprowadzona ze zsynchronizowanego stanu (this.state/this.players),
    // dziala tak samo u hosta i widza - dokladnie jak _aktualizujPlotki wyzej.
    this._aktualizujRubryki();

    // Bijatyka + chmura kurzu - identyczny wzorzec co w tlumaczenia.js/flagbattle.js.
    this.bojka.update(dt, this.workerManager);

    if (!this.isHost) return;

    const bossAktywny = !!(this.boss && this.boss.isActive());
    if (bossAktywny && this.state !== 'IDLE') {
      this._przerwijPrzezBossa();
      return;
    }

    const odblokowana = this._czyOdblokowana();

    if (this.state === 'IDLE') {
      if (bossAktywny || !odblokowana) {
        this.timer = 0;
      } else {
        this.timer += dt;
        if (this.timer >= 30) {
          this.spawnBattleSquare();
        }
      }
    } else if (this.state === 'WAITING') {
      this.checkPlayersEntry();
    } else if (this.state === 'BATTLE') {
      if (this.litera) {
        this.rundaTimer += dt;
        if (this.rundaTimer >= LIMIT_CZASU_RUNDY_S) {
          this._czasRundyUplynal();
        }
      }
      this._sprawdzWyjscieAwaryjne();
    } else if (this.state === 'REWARD') {
      this.rewardTimer += dt;

      if (!this._lastRewardTime) this._lastRewardTime = 0;
      this._lastRewardTime += dt;
      if (this._lastRewardTime >= 1.0) {
        this._lastRewardTime -= 1.0;
        this.economy.addMoney(2);
        if (this.winner && this.winner.username) {
          this.kickChat.recordEarned(this.winner.username, 2);
        }
      }

      if (this.rewardTimer >= 30) {
        this.reset();
      }
    }
  }

  /**
   * Losuje wolne pole na siatce -3..3, z wykluczeniem: bankomatu (0,0) i pol
   * zajetych PRZEZ POZOSTALE DWIE MINIGRY (flagBattleRef.tile,
   * tlumaczeniaRef.tile) - wszystkie trzy minigry moga dzialac rownolegle,
   * ale zadne dwie nie moga stanac na tym samym kafelku (patrz komentarz przy
   * refs w setContext). Losowanie jest DETERMINISTYCZNE - z tego samego
   * wspolnego strumienia co reszta gry (src/rng.js), kluczem
   * `${seedGry}:panstwa-miasta-pole:${licznikLiter}:${battleId}`, wiec host i
   * kazdy widz wyliczaja DOKLADNIE to samo pole z tych samych danych.
   *
   * Kolejne proby przy kolizji ciagna z TEGO SAMEGO strumienia, ograniczone
   * do MAX_PROB_LOSOWANIA_POLA, z deterministycznym skanem siatki jako
   * awaryjnym fallbackiem - identycznie jak w tlumaczenia.js/flagbattle.js.
   */
  static MAX_PROB_LOSOWANIA_POLA = 50;

  spawnBattleSquare() {
    this.battleId += 1;

    const zajeteFlag = this.flagBattleRef && this.flagBattleRef.tile ? this.flagBattleRef.tile : null;
    const zajeteTlumaczenia = this.tlumaczeniaRef && this.tlumaczeniaRef.tile ? this.tlumaczeniaRef.tile : null;
    // Kolizja z minigra "Zgadnij marke" - ten sam wzorzec co zajeteFlag/zajeteTlumaczenia powyzej.
    const zajeteMarki = this.bitwaMarekRef && this.bitwaMarekRef.tile ? this.bitwaMarekRef.tile : null;
    const klucz = `${this.economy.state.seedGry}:panstwa-miasta-pole:${this.economy.state.licznikLiter}:${this.battleId}`;
    const rng = strumien(klucz);

    let rx = null;
    let rz = null;
    for (let proba = 0; proba < PanstwaMiastaManager.MAX_PROB_LOSOWANIA_POLA; proba++) {
      const kx = losujInt(rng, -3, 3);
      const kz = losujInt(rng, -3, 3);
      if (kx === 0 && kz === 0) continue; // bankomat
      if (zajeteFlag && kx === zajeteFlag.x && kz === zajeteFlag.z) continue; // pole flag
      if (zajeteTlumaczenia && kx === zajeteTlumaczenia.x && kz === zajeteTlumaczenia.z) continue; // pole tlumaczen
      if (zajeteMarki && kx === zajeteMarki.x && kz === zajeteMarki.z) continue; // pole marek
      rx = kx;
      rz = kz;
      break;
    }
    if (rx === null) {
      // Awaryjny deterministyczny skan siatki (praktycznie nieosiagalne) -
      // ale petla wyzej MUSI miec koniec.
      szukanie: for (let x = -3; x <= 3; x++) {
        for (let z = -3; z <= 3; z++) {
          if (x === 0 && z === 0) continue;
          if (zajeteFlag && x === zajeteFlag.x && z === zajeteFlag.z) continue;
          if (zajeteTlumaczenia && x === zajeteTlumaczenia.x && z === zajeteTlumaczenia.z) continue;
          if (zajeteMarki && x === zajeteMarki.x && z === zajeteMarki.z) continue;
          rx = x;
          rz = z;
          break szukanie;
        }
      }
    }
    if (rx === null) {
      console.warn('[panstwa-miasta] Brak wolnego pola na siatce - pomijam spawn tej rundy.');
      this.battleId -= 1;
      return;
    }

    this.tile = { x: rx, z: rz };
    this.state = 'WAITING';
    this.timer = 0;

    this.highlightMesh.position.x = rx;
    this.highlightMesh.position.z = rz;
    this.markerPierscien.material.color.setHex(KOLOR_BAZOWY);
    this.markerWypelnienie.material.color.setHex(KOLOR_BAZOWY);
    this.markerPierscien.material.opacity = 0.95;
    this.markerWypelnienie.material.opacity = 0.18;
    this.highlightMesh.visible = true;

    this.letterSprite.position.set(rx, KARTY_WYSOKOSC, rz);
    this.letterSprite.visible = false;
  }

  checkPlayersEntry() {
    if (!this.tile) return;

    const workersOnTile = this.workerManager.entries.filter((e) => {
      const tx = e.targetGridX !== undefined ? e.targetGridX : e.gridX;
      const tz = e.targetGridZ !== undefined ? e.targetGridZ : e.gridZ;
      return tx === this.tile.x && tz === this.tile.z && !e.isFainted;
    });

    if (workersOnTile.length >= 2) {
      const p1 = workersOnTile[0];
      const p2 = workersOnTile[1];

      const p1User = this.kickChat.assignments.workerToUser[p1.typeIndex]?.username || 'Gracz 1';
      const p2User = this.kickChat.assignments.workerToUser[p2.typeIndex]?.username || 'Gracz 2';

      this.players = [
        { typeIndex: p1.typeIndex, username: p1User, score: 0, rubryka: pustaRubryka() },
        { typeIndex: p2.typeIndex, username: p2User, score: 0, rubryka: pustaRubryka() },
      ];

      this.state = 'BATTLE';
      this.rundWygranych = 0;

      const angleP1 = Math.atan2(p2.obj.position.x - p1.obj.position.x, p2.obj.position.z - p1.obj.position.z);
      p1.targetRotY = angleP1;
      p1.facingAngle = angleP1;
      p2.targetRotY = angleP1 + Math.PI;
      p2.facingAngle = angleP1 + Math.PI;

      // Animacja bijatyki (ciosy + chmura kurzu) - patrz src/bojka.js.
      this.bojka.start(this.tile, this.players, `${this.economy.state.seedGry}:panstwa-miasta-bojka:${this.battleId}`);

      this.nextRound();
      this.announce(
        `Panstwa-Miasta! ${p1User} vs ${p2User}! Wpisujcie na czacie Panstwo/Imie/Owoc na litere. Kto pierwszy zdobedzie ${PUNKTY_DO_WYGRANEJ} rundy wygrywa!`,
      );
    }
  }

  /** Identyczne uzasadnienie co _sprawdzWyjscieAwaryjne w tlumaczenia.js/flagbattle.js. */
  _sprawdzWyjscieAwaryjne() {
    const zaginieni = this.players.filter((p) => {
      const w = this.workerManager && this.workerManager.getWorkerType(p.typeIndex);
      return !w || w.isFainted;
    });
    if (zaginieni.length === 0) return;

    const ocalali = this.players.filter((p) => !zaginieni.includes(p));
    if (ocalali.length === 1) {
      this.announce(`${zaginieni[0].username} traci awatara w trakcie bitwy - walkower dla ${ocalali[0].username}!`);
      this.endBattle(ocalali[0]);
    } else {
      this.announce('Obaj walczacy tracą awatara w trakcie bitwy - bitwa panstw-miast anulowana.');
      this.reset();
    }
  }

  nextRound() {
    if (this.state !== 'BATTLE') return;
    this.rundaTimer = 0; // nowa litera = nowy limit czasu (patrz LIMIT_CZASU_RUNDY_S w tick())

    for (const p of this.players) p.rubryka = pustaRubryka();
    this.uzyteId = new Set();

    // Bez powtorek, dopoki nie zostanie wylosowana CALA pula liter w tej
    // ROZGRYWCE (nie tylko w tej bitwie) - patrz pozycjaBezPowtorek w rng.js
    // i licznikLiter w economy.js (trwaly, zapisywany licznik). Wolane
    // WYLACZNIE przez hosta (nextRound woluja tylko checkPlayersEntry i
        // _czasRundyUplynal/onChatMessage, wszystkie za straza isHost), wiec
    // tylko host inkrementuje.
    this.litera = pozycjaBezPowtorek(
      this.economy.state.seedGry,
      'panstwa-miasta-litery',
      LITERY_DOZWOLONE,
      this.economy.state.licznikLiter,
    );
    this.economy.state.licznikLiter += 1;
    this._stosujTeksturaLitery(this.litera);
  }

  /**
   * Ustawia teksture sprite'a litery - synchroniczne rysowanie canvasu
   * (patrz zaladujTeksturaLitery), tak samo jak _stosujTeksturaSlowa w
   * tlumaczenia.js - bez ochrony przed wyscigiem, bo nie ma tu nic asynchronicznego.
   */
  _stosujTeksturaLitery(litera) {
    const texture = zaladujTeksturaLitery(litera, this.renderer);
    this.letterMaterial.map = texture;
    this.letterMaterial.needsUpdate = true;
    this.letterSprite.visible = true;
  }

  /**
   * Wolane WYLACZNIE przez hosta z tick() (patrz LIMIT_CZASU_RUNDY_S), gdy
   * zaden z dwoch graczy nie wypelnil rubryki w limicie czasu. Bez punktu dla
   * kogokolwiek - od razu nowa litera (w odroznieniu od _czasFlagiUplynal we
   * flagbattle.js nie ma tu opoznionego "odsloniecia" - spec tej minigry nie
   * przewiduje pokazywania poprawnych odpowiedzi, bo kategorie maja wiele
   * poprawnych odpowiedzi na litere, nie jedna).
   */
  _czasRundyUplynal() {
    this.announce('⏰ Czas minął! Nikt nie zdążył wypełnić rubryki - nowa litera!');
    this.nextRound();
  }

  /**
   * Podmienia teksture GLOWNEJ kartki (letterSprite/letterMaterial) na kartke
   * ze zwyciezca bitwy - kartka zostaje widoczna przez caly stan REWARD, w
   * tym samym miejscu co karta litery w trakcie gry (patrz identyczne
   * uzasadnienie w flagbattle.js/_pokazZwyciezce). Wolane zarowno przez
   * hosta (endBattle) jak i widza (applySync, strażnik wejscia w REWARD).
   */
  _pokazZwyciezce(winnerPlayer) {
    if (this._winnerTexture) this._winnerTexture.dispose();
    this._winnerTexture = renderujTekstNaCanvasie(['🎉 WYGRYWA', winnerPlayer.username]);
    this.letterMaterial.map = this._winnerTexture;
    this.letterMaterial.needsUpdate = true;
    this.letterSprite.visible = true;
  }

  onChatMessage(username, content) {
    if (!this.isHost) return;
    if (this.state !== 'BATTLE' || !this.litera) return;

    const player = this.players.find((p) => p.username.toLowerCase() === username.toLowerCase());
    if (!player) return; // widzowie spoza bitwy sa ignorowani

    // usunTagiEmotek - ten sam wstepny krok co w tlumaczenia.js/flagbattle.js
    // przed przekazaniem tekstu do logiki dopasowania z panstwa-miasta-dane.js.
    const dopasowania = dopasujOdpowiedzi(this.litera, usunTagiEmotek(content));
    if (!Array.isArray(dopasowania) || dopasowania.length === 0) return;

    // Pierwsze trafienie, ktore jednoczesnie: (a) trafia w kategorie jeszcze
    // PUSTA u TEGO gracza, (b) ma id nieuzyte JESZCZE PRZEZ NIKOGO w tej rundzie.
    const trafienie = dopasowania.find((d) => !player.rubryka[d.kategoria] && !this.uzyteId.has(d.id));
    if (!trafienie) return;

    player.rubryka[trafienie.kategoria] = trafienie.nazwa;
    this.uzyteId.add(trafienie.id);

    const etykieta = KATEGORIE.find((k) => k.id === trafienie.kategoria)?.etykieta || trafienie.kategoria;
    this.announce(`${username} wpisuje ${etykieta}: ${trafienie.nazwa}!`);

    const rubrykaPelna = KATEGORIE.every((k) => !!player.rubryka[k.id]);
    if (!rubrykaPelna) return;

    player.score += 1;
    this.rundWygranych += 1;

    const workerEntry = this.workerManager && this.workerManager.getWorkerType(player.typeIndex);
    if (workerEntry) {
      this.workerManager.triggerAttack(workerEntry, klipAtakuDlaRundy(this.rundWygranych));
    }

    this.announce(`🎯 ${username} wypełnia rubrykę i wygrywa rundę! (Rundy: ${player.score}/${PUNKTY_DO_WYGRANEJ})`);

    if (player.score >= PUNKTY_DO_WYGRANEJ) {
      this.endBattle(player);
    } else {
      setTimeout(() => this.nextRound(), 1000);
    }
  }

  endBattle(winnerPlayer) {
    this.state = 'REWARD';
    this.rewardTimer = 0;
    this._lastRewardTime = 0;
    this.winner = winnerPlayer;
    // Kartka litery zostaje na scenie, ale z podmieniona tekstura zwyciezcy
    // (patrz _pokazZwyciezce) - zadanie: zwyciezca ma byc widoczny w tym
    // samym miejscu co karta litery w trakcie gry, nie chowany.
    this._pokazZwyciezce(winnerPlayer);
    // Gwiazdka za wygrana minigre (ranking + plakietka) - patrz kick.js.
    if (this.kickChat) this.kickChat.zapiszWygranaMinigry(winnerPlayer.username);

    this.highlightMesh.visible = false;
    this._usunPlotki();
    this._usunRubryki();

    this.bojka.stop(this.workerManager);

    const loser = this.players.find((p) => p.typeIndex !== winnerPlayer.typeIndex);
    if (loser) {
      const lw = this.workerManager.getWorkerType(loser.typeIndex);
      if (lw) {
        let kickX = this.tile.x + (Math.random() > 0.5 ? 1 : -1);
        let kickZ = this.tile.z + (Math.random() > 0.5 ? 1 : -1);
        if (kickX < -3) kickX = -2;
        if (kickX > 3) kickX = 2;
        if (kickZ < -3) kickZ = -2;
        if (kickZ > 3) kickZ = 2;
        if (kickX === 0 && kickZ === 0) kickX = 1;

        lw.gridX = kickX;
        lw.gridZ = kickZ;
        lw.targetGridX = kickX;
        lw.targetGridZ = kickZ;
        lw.obj.position.set(kickX, 0, kickZ);
        lw.startPos.set(kickX, 0, kickZ);
        lw.targetPos.set(kickX, 0, kickZ);
      }
    }

    this.announce(`🎉 ${winnerPlayer.username} WYGRYWA BITWĘ PAŃSTWA-MIASTA! Przez 30 sekund dostaje 2 zł/s pasywnie!`);
  }

  /** Identyczne uzasadnienie co _przerwijPrzezBossa w tlumaczenia.js/flagbattle.js. */
  _przerwijPrzezBossa() {
    if (this.state === 'REWARD' && this.winner) {
      const pozostaleSekund = Math.max(0, Math.floor(30 - this.rewardTimer));
      const wyplata = pozostaleSekund * 2;
      if (wyplata > 0) {
        this.economy.addMoney(wyplata);
        if (this.winner.username) {
          this.kickChat.recordEarned(this.winner.username, wyplata);
        }
      }
      this.announce(
        `⚔️ Boss atakuje! Bitwa panstw-miast przerwana - ${this.winner.username} dostaje od razu resztę nagrody (+${wyplata} zł).`,
      );
    } else if (this.state === 'BATTLE' || this.state === 'WAITING') {
      this.announce('⚔️ Boss atakuje! Bitwa panstw-miast przerwana - pole zwolnione.');
    }

    this.bojka.stop(this.workerManager);

    this.reset();
  }

  /** Identyczne uzasadnienie co _aktualizujPlotki w tlumaczenia.js/flagbattle.js. */
  _aktualizujPlotki(dt) {
    const chceWidoczne = (this.state === 'WAITING' || this.state === 'BATTLE') && !!this.tile;

    if (chceWidoczne && !this.plotki.length && !this._plotkiWTrakcieBudowy) {
      this._zapewnijPlotki();
    }
    if (!this.plotki.length) return;

    const cel = chceWidoczne ? 0.55 : 0.001;
    let wszystkieDoszly = true;
    for (const obj of this.plotki) {
      const nowa = obj.scale.y + (cel - obj.scale.y) * Math.min(1, dt * 6);
      obj.scale.y = nowa;
      if (Math.abs(nowa - cel) > 0.01) wszystkieDoszly = false;
    }
    if (!chceWidoczne && wszystkieDoszly) {
      this._usunPlotki();
    }
  }

  async _zapewnijPlotki() {
    this._plotkiWTrakcieBudowy = true;
    try {
      const gltf = await pobierzSzablonPlotki();
      if (!this.tile || (this.state !== 'WAITING' && this.state !== 'BATTLE')) return;

      const boki = [
        { dx: 0, dz: 0.5, rot: 0 },
        { dx: 0, dz: -0.5, rot: Math.PI },
        { dx: 0.5, dz: 0, rot: Math.PI / 2 },
        { dx: -0.5, dz: 0, rot: -Math.PI / 2 },
      ];
      const nowePlotki = [];
      for (const bok of boki) {
        const obj = gltf.scene.clone(true);
        obj.scale.set(0.95, 0.001, 0.95);
        obj.rotation.y = bok.rot;
        obj.userData.dx = bok.dx;
        obj.userData.dz = bok.dz;
        obj.position.set(this.tile.x + bok.dx, 0, this.tile.z + bok.dz);
        obj.traverse((n) => {
          if (n.isMesh) {
            n.castShadow = true;
            n.receiveShadow = true;
          }
        });
        this.scene.add(obj);
        nowePlotki.push(obj);
      }
      this.plotki = nowePlotki;
    } catch (err) {
      console.error('[panstwa-miasta] Blad ladowania plotek pola bitwy:', err);
    } finally {
      this._plotkiWTrakcieBudowy = false;
    }
  }

  _usunPlotki() {
    for (const obj of this.plotki) {
      this.scene.remove(obj);
    }
    this.plotki = [];
  }

  /**
   * Rubryka nad glowa kazdego gracza (2 sprite'y, jeden na gracza) - tworzone
   * leniwie, gdy bitwa jest aktywna i sprzatane, gdy nie jest. Wolane co
   * klatke z tick() (u hosta i u widza - kosmetyka wyprowadzona ze
   * zsynchronizowanego stanu this.state/this.players, dokladnie jak
   * _aktualizujPlotki). Tekstura przerysowywana TYLKO gdy zawartosc rubryki
   * FAKTYCZNIE sie zmienila (porownanie z ostatnio narysowanym podpisem) - nie
   * co klatke.
   */
  _aktualizujRubryki() {
    const chce = this.state === 'BATTLE' && this.players.length === 2;

    if (!chce) {
      if (this.rubrykaSprites.length) this._usunRubryki();
      return;
    }
    if (!this.rubrykaSprites.length) this._zapewnijRubryki();

    for (let i = 0; i < 2; i++) {
      const p = this.players[i];
      const info = this.rubrykaSprites[i];
      if (!p || !info) continue;

      if (this.tile) {
        info.sprite.position.set(
          this.tile.x + (i === 0 ? -KARTY_ODSTEP_X : KARTY_ODSTEP_X),
          KARTY_WYSOKOSC,
          this.tile.z,
        );
      }

      const podpis = `${p.username}|${KATEGORIE.map((k) => p.rubryka[k.id] || '').join('|')}`;
      if (podpis !== info.ostatniPodpis) {
        info.ostatniPodpis = podpis;
        const nowaTekstura = this._rysujRubrykeTekstura(p.username, p.rubryka);
        if (info.material.map) info.material.map.dispose();
        info.material.map = nowaTekstura;
        info.material.needsUpdate = true;
      }
      info.sprite.visible = true;
    }
  }

  _zapewnijRubryki() {
    for (let i = 0; i < 2; i++) {
      const material = new THREE.SpriteMaterial({ color: 0xffffff, toneMapped: false });
      const sprite = new THREE.Sprite(material);
      sprite.scale.set(1.7, 1.1, 1.0);
      sprite.visible = false;
      this.scene.add(sprite);
      this.rubrykaSprites.push({ sprite, material, ostatniPodpis: null });
    }
  }

  /** Usuwa sprite'y rubryk ze sceny i zwalnia ich tekstury/materialy (patrz zadanie: "chowasz i sprzątasz"). */
  _usunRubryki() {
    for (const info of this.rubrykaSprites) {
      this.scene.remove(info.sprite);
      if (info.material.map) info.material.map.dispose();
      info.material.dispose();
    }
    this.rubrykaSprites = [];
  }

  /** Rysuje canvas rubryki (nazwa gracza + 3 wiersze kategorii) i zwraca CanvasTexture. NIE cache'owane - tresc jest unikalna per gracz/runda. */
  _rysujRubrykeTekstura(username, rubryka) {
    const W = 440;
    const H = 240;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');

    ctx.fillStyle = 'rgba(30, 16, 0, 0.88)';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#ffbf5c';
    ctx.lineWidth = 8;
    ctx.strokeRect(4, 4, W - 8, H - 8);

    ctx.fillStyle = '#ffd699';
    ctx.font = 'bold 30px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(username, W / 2, 36);

    ctx.font = '26px sans-serif';
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    KATEGORIE.forEach((k, i) => {
      const wartosc = rubryka[k.id] || '—';
      ctx.fillText(`${k.etykieta}: ${wartosc}`, 24, 88 + i * 48);
    });

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    if (this.renderer && this.renderer.capabilities && typeof this.renderer.capabilities.getMaxAnisotropy === 'function') {
      texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    }
    texture.needsUpdate = true;
    return texture;
  }

  reset() {
    if (this.bojka) this.bojka.stop(this.workerManager);
    this.state = 'IDLE';
    this.timer = 0;
    this.tile = null;
    this.players = [];
    this.litera = null;
    this._loadedLitera = null;
    this.uzyteId = new Set();
    this.rundWygranych = 0;
    this.rundaTimer = 0;
    this.winner = null;
    this.rewardTimer = 0;
    this._lastRewardTime = 0;
    this.highlightMesh.visible = false;
    this.letterSprite.visible = false;
    // Kartka ze zwyciezca znika razem z reszta planszy - tekstura jest
    // jednorazowa (NIE z cacheTeksturLiter), wiec dispose'ujemy ja tutaj;
    // sam letterMaterial zostaje (wspoldzielony, kolejna bitwa nadpisze .map).
    if (this._winnerTexture) {
      this._winnerTexture.dispose();
      this._winnerTexture = null;
    }
    this.markerPierscien.material.opacity = 0.95;
    this.markerWypelnienie.material.opacity = 0.18;
    this._ostatniaSekundaDymka = null;
    this._usunPlotki();
    this._usunRubryki();
  }

  getSyncState() {
    return {
      state: this.state,
      tile: this.tile,
      players: this.players,
      litera: this.litera,
      rundWygranych: this.rundWygranych,
      winner: this.winner,
      rewardTimer: this.rewardTimer,
      battleId: this.battleId,
    };
  }

  applySync(s) {
    if (this.isHost) return;
    if (!s || s.state === 'IDLE' || !s.tile) {
      if (this.state !== 'IDLE') this.reset();
      return;
    }

    const prevState = this.state;
    const prevPlayers = this.players;
    const prevRundWygranych = this.rundWygranych;
    this.state = s.state;
    this.tile = s.tile;
    this.players = Array.isArray(s.players) ? s.players : [];
    this.rundWygranych = s.rundWygranych || 0;
    this.winner = s.winner || null;
    this.rewardTimer = s.rewardTimer || 0;
    this.battleId = s.battleId || 0;
    this.litera = s.litera || null;

    if (this.state === 'BATTLE' && prevState !== 'BATTLE') {
      this.bojka.start(this.tile, this.players, `${this.economy.state.seedGry}:panstwa-miasta-bojka:${this.battleId}`);
    } else if (prevState === 'BATTLE' && this.state !== 'BATTLE') {
      this.bojka.stop(this.workerManager);
    }

    if (this.state === 'BATTLE' && this.rundWygranych > prevRundWygranych) {
      const zwyciezcaRundy = this.players.find((p) => {
        const stary = prevPlayers.find((op) => op.typeIndex === p.typeIndex);
        return stary ? p.score > stary.score : p.score > 0;
      });
      if (zwyciezcaRundy) {
        const w = this.workerManager && this.workerManager.getWorkerType(zwyciezcaRundy.typeIndex);
        if (w) this.workerManager.triggerAttack(w, klipAtakuDlaRundy(this.rundWygranych));
      }
    }

    this.highlightMesh.position.x = this.tile.x;
    this.highlightMesh.position.z = this.tile.z;
    this.letterSprite.position.set(this.tile.x, KARTY_WYSOKOSC, this.tile.z);

    if (this.state === 'REWARD') {
      this.highlightMesh.visible = false;
      this._usunPlotki();
    } else {
      this.highlightMesh.visible = true;
    }

    // Kartka ze zwyciezca (patrz _pokazZwyciezce) - pokazujemy ja WYLACZNIE w
    // momencie WEJSCIA w REWARD (prevState !== 'REWARD'), nie przy kazdym
    // snapshocie - identyczny strażnik co w flagbattle.js/applySync.
    if (this.state === 'REWARD') {
      if (prevState !== 'REWARD' && this.winner) {
        this._pokazZwyciezce(this.winner);
      }
    } else if (this.state === 'BATTLE' && this.litera) {
      if (this.litera !== this._loadedLitera) {
        this._loadedLitera = this.litera;
        this._stosujTeksturaLitery(this.litera);
      }
    } else {
      // WAITING (jeszcze bez litery). REWARD jest juz obsluzony osobno wyzej
      // (kartka zwyciezcy zostaje widoczna, nie chowana tutaj).
      this.letterSprite.visible = false;
    }
    // Rubryki: tworzone/sprzatane/przerysowywane w tick() -> _aktualizujRubryki(),
    // ktora czyta this.state/this.players juz zaktualizowane wyzej - nie trzeba
    // tu nic dodatkowo robic (ten sam wzorzec co plotki, patrz _aktualizujPlotki).
  }

  announce(text) {
    const messagesEl = document.getElementById('kick-messages');
    if (messagesEl) {
      const div = document.createElement('div');
      div.className = 'chat-message';
      div.innerHTML = `<strong style="color: #ff9f1c">[Panstwa-Miasta]</strong> <span>${text}</span>`;
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    try {
      this.onAnnounce(text);
    } catch (err) {
      console.warn('[panstwa-miasta] Blad w onAnnounce:', err);
    }
  }
}

/** Pusta rubryka: jeden klucz per kategoria z panstwa-miasta-dane.js, wartosc null = jeszcze nie wypelnione. */
function pustaRubryka() {
  return Object.fromEntries(KATEGORIE.map((k) => [k.id, null]));
}
