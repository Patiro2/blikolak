import * as THREE from 'three';
import {
  SLOWKA,
  ENGLISH_WORDS,
  getAkceptowaneWarianty,
  tokenizujOdpowiedzSlowka,
  INDEKS_WARIANTOW_SLOWEK,
} from './slowka.js';
import { usunTagiEmotek } from './kick.js';
import { loadForest } from './assets.js';
import { strumien, losujInt, pozycjaBezPowtorek } from './rng.js';
import { Bojka } from './bojka.js';

// Minigra "Tlumaczenia" - DRUGA (a chronologicznie trzecia w projekcie) minigra
// na siatce areny, obok "Bitwy o flagi". Mechanika jest CELOWO skopiowana z
// src/flagbattle.js (stany IDLE -> WAITING -> BATTLE -> REWARD, wejscie
// dwoch graczy na kafelek, pierwszy do PUNKTY_DO_WYGRANEJ pkt wygrywa, nagroda 2 zl/s przez
// 30 s, wysuwane plotki, isPlayerLocked/isTileLocked ze straza boss.isActive(),
// getSyncState/applySync, setHost, przerwanie przez bossa) - a NIE wyciagnieta
// z niej jako wspolna klasa bazowa. To swiadoma decyzja: minigra o flagi dwa
// razy w historii tego projektu polozyla cala produkcje (patrz komentarze w
// main.js przy flagBattleZepsuta/flagBattleBledy) i dopiero teraz jest
// stabilna - dorzucanie do niej abstrakcji na potrzeby DRUGIEJ minigry
// zwiekszaloby ryzyko regresji w JUZ DZIALAJACYM kodzie. Duplikacja wzorca
// jest tu bezpieczniejsza. NIE modyfikujemy flagbattle.js poza (ewentualnym,
// osobno opisanym) minimalnym dopiskiem do kolizji kafelkow.
//
// Roznica wzgledem flag: zamiast rozpoznawania flagi kraju, widzowie
// tlumacza WYSWIETLONE angielskie slowo na polski (patrz src/slowka.js -
// kazde slowo ma liste akceptowanych polskich odpowiedzi).

// Wysokosc znacznika kontestowanego pola. Zajete poziomy w projekcie: 0.025
// wierzch kafla podlogi (scene.js), 0.035 neonowa siatka areny (scene.js),
// 0.042 znaczniki atakow bossa (bossattack.js), 0.048 wskaznik zlotej monety
// (goldcoin.js), 0.052 znacznik bitwy o flagi (flagbattle.js). 0.056 jest
// KOLEJNYM wolnym poziomem ponad wszystkimi - wejscie w cudzy poziom
// odtworzyloby migotanie podlogi (z-fighting), ktore w tym projekcie juz raz
// naprawiono.
const MARKER_Y = 0.056;

// Kolor minigry: NIEBIESKI/FIOLETOWY - wyraznie inny niz czerwien+zloto
// bitwy o flagi, i inny niz reszta zajetych kolorow w projekcie (neonowa
// zielen siatki areny 0x53fc18, zielone znaczniki wymiotow bossa 0x86c232,
// czerwone znaczniki rakiet 0xff3b30, zloto monety, czerwien flag).
const KOLOR_BAZOWY = 0x3d5cff; // niebiesko-fioletowy

// Prog zwyciestwa bitwy tlumaczen - "best of 9": pierwszy gracz, ktory
// zdobedzie PUNKTY_DO_WYGRANEJ punktow, wygrywa; przy max. rownej grze
// (PUNKTY_DO_WYGRANEJ - 1 : PUNKTY_DO_WYGRANEJ - 1) bitwa rozstrzyga sie w
// najwyzej 2 * PUNKTY_DO_WYGRANEJ - 1 = 9 rundach. Wszystkie miejsca w tym
// pliku (tekst ogloszenia na czacie, warunek konca bitwy) MUSZA czytac ta
// stala, a nie miec wpisanej liczby na sztywno - inaczej przy kolejnej
// zmianie progu znowu by sie rozjechaly.
const PUNKTY_DO_WYGRANEJ = 5;

// Klipy walki - identyczne jak w flagbattle.js (patrz tamten komentarz przy
// KLIPY_ATAKU po uzasadnienie: kazda postac w projekcie ma je w swoim
// wspolnym slowniku animacji). Deterministyczny wybor wzgledem numeru rundy.
const KLIPY_ATAKU = ['attack-melee-right', 'attack-melee-left', 'attack-kick-right', 'attack-kick-left'];
function klipAtakuDlaRundy(numerRundy) {
  const i = ((numerRundy % KLIPY_ATAKU.length) + KLIPY_ATAKU.length) % KLIPY_ATAKU.length;
  return KLIPY_ATAKU[i];
}

// Szablon plotki (assets/forest/fence.glb) - loadForest() sam cache'uje
// wynik (patrz assets.js), a ten sam plik jest juz ladowany przez
// flagbattle.js i city.js pod tym samym kluczem, wiec to nie jest dodatkowe
// pobieranie ani osobna kopia geometrii/materialu.
let szablonPlotkiPromise = null;
function pobierzSzablonPlotki() {
  if (!szablonPlotkiPromise) szablonPlotkiPromise = loadForest('fence');
  return szablonPlotkiPromise;
}

/**
 * Dopasowanie odpowiedzi z czatu do angielskiego slowa: PO CALYCH SLOWACH
 * (ta sama technika co zawieraSekwencje w flagbattle.js - patrz tamten
 * obszerny komentarz po pelne uzasadnienie). W odroznieniu od flag NIE
 * potrzebujemy globalnego "najdluzsze dopasowanie ze wszystkich 232 krajow"
 * rozstrzygania remisow - tu sprawdzamy WYLACZNIE, czy odpowiedz zawiera
 * jeden z akceptowanych wariantow AKTUALNIE wyswietlonego slowa (currentWord),
 * bo to jest jedyne slowo, na ktore odpowiedz moze sie aktualnie liczyc.
 */
function zawieraSekwencje(tokeny, wzorzec) {
  if (wzorzec.length === 0 || wzorzec.length > tokeny.length) return false;
  szukanie: for (let i = 0; i + wzorzec.length <= tokeny.length; i++) {
    for (let j = 0; j < wzorzec.length; j++) {
      if (tokeny[i + j] !== wzorzec[j]) continue szukanie;
    }
    return true;
  }
  return false;
}

function odpowiedzPasujeDoSlowa(tokeny, word) {
  for (const { word: w, slowa } of INDEKS_WARIANTOW_SLOWEK) {
    if (w !== word) continue;
    if (zawieraSekwencje(tokeny, slowa)) return true;
  }
  return false;
}

// Rozmiar canvasu karty ze slowem (analogicznie do ROZMIAR_TEKSTURY_FLAGI w
// flagbattle.js).
const SZEROKOSC_KARTY = 512;
const WYSOKOSC_KARTY = 256;

/**
 * Rysuje kafelek-flashcard z angielskim slowem na canvasie i zwraca
 * THREE.CanvasTexture. W odroznieniu od flag (pobieranie SVG z sieci) to
 * czysto lokalne rysowanie tekstu - bez fetch, bez asynchronicznego wyscigu,
 * wiec funkcja jest SYNCHRONICZNA. Wynik cache'owany po slowie (Map w module,
 * podobnie jak cacheTeksturFlag w flagbattle.js) - to samo slowo nigdy nie
 * rysuje canvasu drugi raz w tej samej sesji karty.
 */
const cacheTeksturSlowek = new Map();
function zaladujTeksturaSlowa(word, renderer) {
  if (cacheTeksturSlowek.has(word)) return cacheTeksturSlowek.get(word);

  const canvas = document.createElement('canvas');
  canvas.width = SZEROKOSC_KARTY;
  canvas.height = WYSOKOSC_KARTY;
  const ctx = canvas.getContext('2d');

  // Tlo karty - ciemnogranatowe z niebiesko-fioletowa ramka (kolor minigry).
  ctx.fillStyle = '#10142e';
  ctx.fillRect(0, 0, SZEROKOSC_KARTY, WYSOKOSC_KARTY);
  ctx.strokeStyle = '#8f6bff';
  ctx.lineWidth = 14;
  ctx.strokeRect(7, 7, SZEROKOSC_KARTY - 14, WYSOKOSC_KARTY - 14);
  ctx.fillStyle = '#4d6dff';
  ctx.fillRect(0, 0, SZEROKOSC_KARTY, 46);

  ctx.fillStyle = '#cfd6ff';
  ctx.font = 'bold 28px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('PRZETLUMACZ', SZEROKOSC_KARTY / 2, 23);

  // Dopasowanie rozmiaru czcionki do dlugosci slowa, zeby dlugie angielskie
  // slowa (np. "refrigerator" - choc takich unikamy w slowka.js) nie
  // wychodzily poza karte.
  let fontSize = 92;
  ctx.font = `bold ${fontSize}px sans-serif`;
  while (ctx.measureText(word).width > SZEROKOSC_KARTY - 60 && fontSize > 32) {
    fontSize -= 4;
    ctx.font = `bold ${fontSize}px sans-serif`;
  }
  ctx.fillStyle = '#ffffff';
  ctx.fillText(word, SZEROKOSC_KARTY / 2, WYSOKOSC_KARTY / 2 + 20);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  if (renderer && renderer.capabilities && typeof renderer.capabilities.getMaxAnisotropy === 'function') {
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  }
  texture.needsUpdate = true;

  cacheTeksturSlowek.set(word, texture);
  return texture;
}

/**
 * Rysuje kilka wierszy tekstu na canvasie karty slowa (SZEROKOSC_KARTY x
 * WYSOKOSC_KARTY) i zwraca CanvasTexture - uzywane do kartki ze zwyciezca
 * bitwy (patrz _pokazZwyciezce nizej). Lokalny odpowiednik
 * renderujTekstNaCanvasie z flagbattle.js - zgodnie z konwencja tego
 * projektu duplikujemy wzorzec zamiast wyciagac go do wspolnego modulu
 * (patrz obszerny komentarz na gorze pliku). NIE cache'owane po kluczu -
 * nick zwyciezcy jest jednorazowy.
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
  ctx.fillStyle = '#10142e';
  ctx.fillRect(0, 0, SZEROKOSC_KARTY, WYSOKOSC_KARTY);
  ctx.strokeStyle = '#8f6bff';
  ctx.lineWidth = 14;
  ctx.strokeRect(7, 7, SZEROKOSC_KARTY - 14, WYSOKOSC_KARTY - 14);

  ctx.fillStyle = '#ffd700';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const odstep = 46;
  const maxSzerokosc = SZEROKOSC_KARTY - 40;
  const minRozmiarFontu = 16;
  const startY = WYSOKOSC_KARTY / 2 - ((linie.length - 1) * odstep) / 2;
  linie.forEach((linia, i) => {
    let rozmiarFontu = 36;
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

export class TlumaczeniaManager {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;

    this.state = 'IDLE'; // IDLE, WAITING, BATTLE, REWARD
    this.timer = 0;
    this.tile = null; // {x, z}
    this.players = []; // [{ typeIndex, username, score }]

    this.currentWord = null; // np. 'car'
    this._loadedWord = null; // ostatnie zaladowane slowo (applySync u widza)
    this.wordsGuessed = 0;

    // battleId - patrz spawnBattleSquare()/nextRound(). Synchronizowany
    // (getSyncState/applySync), NIE lokalny licznik karty - inkrementowany
    // WYLACZNIE przez hosta, tak samo jak w flagbattle.js.
    this.battleId = 0;

    this.rewardTimer = 0;
    this.winner = null;

    this.onAnnounce = () => {};
    this.onRewardTick = () => {};

    // Znacznik kontestowanego pola - pierscien + wypelnienie, kolor
    // niebiesko-fioletowy (KOLOR_BAZOWY), MARKER_Y = 0.056 (patrz komentarz
    // przy stalej).
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

    // Sprite z kartka slowa - analogicznie do flagSprite w flagbattle.js.
    this.wordMaterial = new THREE.SpriteMaterial({ color: 0xffffff, toneMapped: false });
    this.wordSprite = new THREE.Sprite(this.wordMaterial);
    this.wordSprite.scale.set(1.8, 0.9, 1.0);
    this.wordSprite.position.y = 3.0;
    this.wordSprite.visible = false;
    this.scene.add(this.wordSprite);

    // Tekstura kartki ze zwyciezca (patrz _pokazZwyciezce) - jednorazowa, NIE
    // cache'owana (nick jest unikalny per bitwa) - patrz identyczny
    // komentarz w flagbattle.js przy tym samym polu.
    this._winnerTexture = null;

    this.isHost = false;

    // Bijatyka + chmura kurzu (patrz src/bojka.js) - identyczny wzorzec co w
    // flagbattle.js: jedna wspoldzielona instancja na cale zycie tej minigry.
    this.bojka = new Bojka(this.scene);
  }

  setContext({ workerManager, kickChat, economy, isHost, boss, flagBattle, panstwaMiasta, bitwaMarek }) {
    this.workerManager = workerManager;
    this.kickChat = kickChat;
    this.economy = economy;
    this.boss = boss || null;
    // Referencja do minigry "Bitwa o flagi" - WYLACZNIE do odczytu jej
    // biezacego kafelka (flagBattle.tile), zeby nasze losowanie pola nigdy
    // nie wylosowalo tego samego pola co flagi (patrz spawnBattleSquare
    // nizej). Zadnej innej wlasnosci flagBattle nie czytamy ani nie
    // zmieniamy - to jest jedyny "publiczny" kontrakt miedzy modulami.
    this.flagBattleRef = flagBattle || null;
    // Ten sam kontrakt (WYLACZNIE odczyt .tile), dla minigry "Panstwa-Miasta" -
    // patrz analogiczny komentarz w panstwa-miasta.js/setContext.
    this.panstwaMiastaRef = panstwaMiasta || null;
    // Ten sam kontrakt (WYLACZNIE odczyt .tile), dla minigry "Zgadnij marke" -
    // patrz analogiczny komentarz w bitwa-marek.js/setContext.
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
   * Minigra jest odblokowana dopiero po pokonaniu bossa tieru 2 (Kowal_88).
   * Sprawdzane NA BIEZACO (economy.state.bossesDefeated.includes(2)) w
   * KAZDYM ticku, a nie raz przy starcie - dokladnie ten sam blad ("warunek
   * zamrozony przy starcie") juz raz wystapil w tym projekcie z isHost (patrz
   * komentarz w flagbattle.js/setHost), wiec go tu nie powielamy.
   */
  _czyOdblokowana() {
    return !!(this.economy && Array.isArray(this.economy.state.bossesDefeated) && this.economy.state.bossesDefeated.includes(2));
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
      // Puls niebiesko-fioletowy (miejsce czerwonego pulsu flag) - funkcja
      // Date.now(), nie losowania, wiec host i widz pulsuja identycznie.
      const s = Math.sin(Date.now() * 0.005) * 0.5 + 0.5;
      this.markerPierscien.material.color.setRGB(0.24 + s * 0.2, 0.36 + s * 0.15, 1);
      this.markerPierscien.material.opacity = 0.95;
      this.markerWypelnienie.material.opacity = 0.18;
    } else if (this.state === 'REWARD') {
      // Poswiata cyjanowo-fioletowa (miejsce zlota flag) - inna barwa niz
      // flagi, ale nadal w rodzinie niebiesko-fioletowej calej minigry.
      const s = Math.sin(Date.now() * 0.003) * 0.5 + 0.5;
      this.markerPierscien.material.color.setRGB(0.5 + s * 0.1, 0.3 + s * 0.2, 1);
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
            console.warn('[tlumaczenia] Blad w onRewardTick:', err);
          }
        }
      }
    }

    this._aktualizujPlotki(dt);

    // Bijatyka + chmura kurzu - identyczny wzorzec co w flagbattle.js
    // (kosmetyczna animacja lokalna, dziala niezaleznie od isHost).
    this.bojka.update(dt, this.workerManager);

    if (!this.isHost) return;

    const bossAktywny = !!(this.boss && this.boss.isActive());
    if (bossAktywny && this.state !== 'IDLE') {
      this._przerwijPrzezBossa();
      return;
    }

    const odblokowana = this._czyOdblokowana();

    if (this.state === 'IDLE') {
      // Dopoki minigra nie jest odblokowana (boss tieru 2 jeszcze nie
      // pokonany) LUB boss jest aktywny, timer stoi w miejscu - zaden dlug
      // sie nie kumuluje, minigra po prostu nigdy nie stawia kafelka.
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
   * Losuje wolne pole na siatce -3..3, z wykluczeniem: bankomatu (0,0) i pola
   * zajetego PRZEZ MINIGRE FLAG (this.flagBattleRef.tile) - obie minigry moga
   * dzialac rownolegle, ale nigdy nie moga stanac na tym samym kafelku (patrz
   * komentarz przy flagBattleRef w setContext). Losowanie jest
   * DETERMINISTYCZNE - z tego samego wspolnego strumienia co reszta gry
   * (src/rng.js), kluczem `${seedGry}:tlumaczenia-pole:${licznikSlowek}:${battleId}`,
   * wiec host i kazdy widz (ktory kiedys moze zostac hostem, patrz komentarz przy
   * setHost) wyliczaja DOKLADNIE to samo pole z tych samych danych - zero
   * Math.random() w logice rozgrywki (patrz rng.js po uzasadnienie).
   *
   * Kolejne proby przy kolizji ciagna z TEGO SAMEGO strumienia (kolejne
   * wywolanie rng(), nie nowy klucz) - ograniczone do MAX_PROB_LOSOWANIA_POLA,
   * z deterministycznym skanem siatki jako awaryjnym fallbackiem (bez tego
   * petla musialaby byc nieograniczona, co zawiesiloby klatke).
   */
  static MAX_PROB_LOSOWANIA_POLA = 50;

  spawnBattleSquare() {
    this.battleId += 1;

    // Klucz zawiera licznikSlowek (trwaly, rosnie z kazda runda slowek -
    // patrz nextRound) ORAZ battleId, zeby kolejna bitwa dostala inne pole
    // rowniez po przeladowaniu strony (patrz analogiczny komentarz przy
    // kluczu flaga-pole w flagbattle.js).
    const zajeteFlag = this.flagBattleRef && this.flagBattleRef.tile ? this.flagBattleRef.tile : null;
    // Kolizja z minigra "Panstwa-Miasta" - ten sam wzorzec co zajeteFlag powyzej.
    const zajetePanstwaMiasta = this.panstwaMiastaRef && this.panstwaMiastaRef.tile ? this.panstwaMiastaRef.tile : null;
    // Kolizja z minigra "Zgadnij marke" - ten sam wzorzec co zajeteFlag powyzej.
    const zajeteMarki = this.bitwaMarekRef && this.bitwaMarekRef.tile ? this.bitwaMarekRef.tile : null;
    const klucz = `${this.economy.state.seedGry}:tlumaczenia-pole:${this.economy.state.licznikSlowek}:${this.battleId}`;
    const rng = strumien(klucz);

    let rx = null;
    let rz = null;
    for (let proba = 0; proba < TlumaczeniaManager.MAX_PROB_LOSOWANIA_POLA; proba++) {
      const kx = losujInt(rng, -3, 3);
      const kz = losujInt(rng, -3, 3);
      if (kx === 0 && kz === 0) continue; // bankomat
      if (zajeteFlag && kx === zajeteFlag.x && kz === zajeteFlag.z) continue; // pole flag
      if (zajetePanstwaMiasta && kx === zajetePanstwaMiasta.x && kz === zajetePanstwaMiasta.z) continue; // pole panstw-miast
      if (zajeteMarki && kx === zajeteMarki.x && kz === zajeteMarki.z) continue; // pole marek
      rx = kx;
      rz = kz;
      break;
    }
    if (rx === null) {
      // Awaryjny deterministyczny skan siatki (praktycznie nieosiagalne -
      // siatka ma 48 wolnych pol poza bankomatem, z czego najwyzej jedno-dwa
      // zajete przez pozostale minigry) - ale petla wyzej MUSI miec koniec.
      szukanie: for (let x = -3; x <= 3; x++) {
        for (let z = -3; z <= 3; z++) {
          if (x === 0 && z === 0) continue;
          if (zajeteFlag && x === zajeteFlag.x && z === zajeteFlag.z) continue;
          if (zajetePanstwaMiasta && x === zajetePanstwaMiasta.x && z === zajetePanstwaMiasta.z) continue;
          if (zajeteMarki && x === zajeteMarki.x && z === zajeteMarki.z) continue;
          rx = x;
          rz = z;
          break szukanie;
        }
      }
    }
    if (rx === null) {
      // Doslownie kazde pole zajete - nie powinno sie zdarzyc (siatka 7x7 ma
      // 48 pol poza bankomatem). Rezygnujemy z tej proby spawnu, host sprobuje
      // ponownie przy nastepnym pelnym cyklu timera.
      console.warn('[tlumaczenia] Brak wolnego pola na siatke - pomijam spawn tej rundy.');
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

    this.wordSprite.position.set(rx, 2.5, rz);
    this.wordSprite.visible = false;
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
        { typeIndex: p1.typeIndex, username: p1User, score: 0 },
        { typeIndex: p2.typeIndex, username: p2User, score: 0 },
      ];

      this.state = 'BATTLE';
      this.wordsGuessed = 0;

      const angleP1 = Math.atan2(p2.obj.position.x - p1.obj.position.x, p2.obj.position.z - p1.obj.position.z);
      p1.targetRotY = angleP1;
      p1.facingAngle = angleP1;
      p2.targetRotY = angleP1 + Math.PI;
      p2.facingAngle = angleP1 + Math.PI;

      // Animacja bijatyki (ciosy + chmura kurzu) - patrz src/bojka.js.
      this.bojka.start(this.tile, this.players, `${this.economy.state.seedGry}:tlumaczenia-bojka:${this.battleId}`);

      this.nextRound();
      this.announce(`Bitwa tlumaczen! ${p1User} vs ${p2User}! Tlumacz slowo na polski na czacie! Kto pierwszy zdobedzie ${PUNKTY_DO_WYGRANEJ} pkt wygrywa!`);
    }
  }

  /** Identyczne uzasadnienie co _sprawdzWyjscieAwaryjne w flagbattle.js. */
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
      this.announce('Obaj walczacy tracą awatara w trakcie bitwy - bitwa tlumaczen anulowana.');
      this.reset();
    }
  }

  nextRound() {
    if (this.state !== 'BATTLE') return;

    // Bez powtorek, dopoki nie zostanie wylosowana CALA pula slowek w tej
    // ROZGRYWCE (nie tylko w tej bitwie) - patrz pozycjaBezPowtorek w rng.js
    // i licznikSlowek w economy.js (trwaly, zapisywany licznik). Wolane
    // WYLACZNIE przez hosta (nextRound woluja tylko checkPlayersEntry i
    // onChatMessage, oba za straza isHost), wiec tylko host inkrementuje.
    this.currentWord = pozycjaBezPowtorek(
      this.economy.state.seedGry,
      'slowka',
      ENGLISH_WORDS,
      this.economy.state.licznikSlowek,
    );
    this.economy.state.licznikSlowek += 1;
    this._stosujTeksturaSlowa(this.currentWord);
  }

  /**
   * Ustawia teksture sprite'a slowa - w odroznieniu od flag (async fetch)
   * generowanie karty jest synchroniczne (patrz zaladujTeksturaSlowa), wiec
   * nie potrzeba ochrony przed wyscigiem (_flagReqId w flagbattle.js).
   */
  _stosujTeksturaSlowa(word) {
    const texture = zaladujTeksturaSlowa(word, this.renderer);
    this.wordMaterial.map = texture;
    this.wordMaterial.needsUpdate = true;
    this.wordSprite.visible = true;
  }

  /**
   * Podmienia teksture GLOWNEJ kartki (wordSprite/wordMaterial) na kartke ze
   * zwyciezca bitwy - kartka zostaje widoczna przez caly stan REWARD, w tym
   * samym miejscu co karta slowa w trakcie gry (patrz identyczne uzasadnienie
   * w flagbattle.js/_pokazZwyciezce). Wolane zarowno przez hosta (endBattle)
   * jak i widza (applySync, strażnik wejscia w REWARD).
   */
  _pokazZwyciezce(winnerPlayer) {
    if (this._winnerTexture) this._winnerTexture.dispose();
    this._winnerTexture = renderujTekstNaCanvasie(['🎉 WYGRYWA', winnerPlayer.username]);
    this.wordMaterial.map = this._winnerTexture;
    this.wordMaterial.needsUpdate = true;
    this.wordSprite.visible = true;
  }

  onChatMessage(username, content) {
    if (!this.isHost) return;
    if (this.state !== 'BATTLE' || !this.currentWord) return;

    const player = this.players.find((p) => p.username.toLowerCase() === username.toLowerCase());
    if (!player) return;

    const tokeny = tokenizujOdpowiedzSlowka(usunTagiEmotek(content));
    if (!odpowiedzPasujeDoSlowa(tokeny, this.currentWord)) return;

    player.score += 1;
    this.wordsGuessed += 1;
    const aktualneSlowo = this.currentWord;
    const poprawnaOdp = SLOWKA[aktualneSlowo];
    this.currentWord = null; // blokada, zeby nie nabic 2x na 1 wiadomosci

    const workerEntry = this.workerManager && this.workerManager.getWorkerType(player.typeIndex);
    if (workerEntry) {
      this.workerManager.triggerAttack(workerEntry, klipAtakuDlaRundy(this.wordsGuessed));
    }

    this.announce(`${username} zgaduje poprawnie: "${aktualneSlowo}" = ${poprawnaOdp}! (Punkty: ${player.score})`);

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
    // Kartka slowa zostaje na scenie, ale z podmieniona tekstura zwyciezcy
    // (patrz _pokazZwyciezce) - zadanie: zwyciezca ma byc widoczny w tym
    // samym miejscu co karta slowa w trakcie gry, nie chowany.
    this._pokazZwyciezce(winnerPlayer);
    // Gwiazdka za wygrana minigre (ranking + plakietka) - patrz kick.js.
    if (this.kickChat) this.kickChat.zapiszWygranaMinigry(winnerPlayer.username);

    this.highlightMesh.visible = false;
    this._usunPlotki();

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

    this.announce(`🎉 ${winnerPlayer.username} WYGRYWA BITWE TLUMACZEN! Przez 30 sekund dostaje 2 zł/s pasywnie!`);
  }

  /** Identyczne uzasadnienie co _przerwijPrzezBossa w flagbattle.js. */
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
        `⚔️ Boss atakuje! Bitwa tlumaczen przerwana - ${this.winner.username} dostaje od razu resztę nagrody (+${wyplata} zł).`,
      );
    } else if (this.state === 'BATTLE' || this.state === 'WAITING') {
      this.announce('⚔️ Boss atakuje! Bitwa tlumaczen przerwana - pole zwolnione.');
    }

    this.bojka.stop(this.workerManager);

    this.reset();
  }

  /** Identyczne uzasadnienie co _aktualizujPlotki w flagbattle.js. */
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
      console.error('[tlumaczenia] Blad ladowania plotek pola bitwy:', err);
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

  reset() {
    // Identyczne uzasadnienie co w flagbattle.js/reset() - reset() bywa
    // wolany z miejsc, ktore nie zatrzymuja bojke jawnie (setHost, koniec
    // REWARD, oboje walczacych znika naraz).
    if (this.bojka) this.bojka.stop(this.workerManager);
    this.state = 'IDLE';
    this.timer = 0;
    this.tile = null;
    this.players = [];
    this.currentWord = null;
    this._loadedWord = null;
    this.winner = null;
    this.rewardTimer = 0;
    this._lastRewardTime = 0;
    this.highlightMesh.visible = false;
    this.wordSprite.visible = false;
    // Kartka ze zwyciezca znika razem z reszta planszy - tekstura jest
    // jednorazowa (NIE z cacheTeksturSlowek), wiec dispose'ujemy ja tutaj;
    // sam wordMaterial zostaje (wspoldzielony, kolejna bitwa nadpisze .map).
    if (this._winnerTexture) {
      this._winnerTexture.dispose();
      this._winnerTexture = null;
    }
    this.markerPierscien.material.opacity = 0.95;
    this.markerWypelnienie.material.opacity = 0.18;
    this._ostatniaSekundaDymka = null;
    this._usunPlotki();
  }

  getSyncState() {
    return {
      state: this.state,
      tile: this.tile,
      players: this.players,
      currentWord: this.currentWord,
      wordsGuessed: this.wordsGuessed,
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
    const prevWordsGuessed = this.wordsGuessed;
    this.state = s.state;
    this.tile = s.tile;
    this.players = Array.isArray(s.players) ? s.players : [];
    this.wordsGuessed = s.wordsGuessed || 0;
    this.winner = s.winner || null;
    this.rewardTimer = s.rewardTimer || 0;
    this.battleId = s.battleId || 0;
    this.currentWord = s.currentWord || null;

    if (this.state === 'BATTLE' && prevState !== 'BATTLE') {
      this.bojka.start(this.tile, this.players, `${this.economy.state.seedGry}:tlumaczenia-bojka:${this.battleId}`);
    } else if (prevState === 'BATTLE' && this.state !== 'BATTLE') {
      this.bojka.stop(this.workerManager);
    }

    if (this.state === 'BATTLE' && this.wordsGuessed > prevWordsGuessed) {
      const zwyciezcaRundy = this.players.find((p) => {
        const stary = prevPlayers.find((op) => op.typeIndex === p.typeIndex);
        return stary ? p.score > stary.score : p.score > 0;
      });
      if (zwyciezcaRundy) {
        const w = this.workerManager && this.workerManager.getWorkerType(zwyciezcaRundy.typeIndex);
        if (w) this.workerManager.triggerAttack(w, klipAtakuDlaRundy(this.wordsGuessed));
      }
    }

    this.highlightMesh.position.x = this.tile.x;
    this.highlightMesh.position.z = this.tile.z;
    this.wordSprite.position.set(this.tile.x, 2.5, this.tile.z);

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
    } else if (this.state === 'BATTLE' && this.currentWord) {
      if (this.currentWord !== this._loadedWord) {
        this._loadedWord = this.currentWord;
        this._stosujTeksturaSlowa(this.currentWord);
      }
    } else {
      // WAITING (jeszcze bez slowa). REWARD jest juz obsluzony osobno wyzej
      // (kartka zwyciezcy zostaje widoczna, nie chowana tutaj).
      this.wordSprite.visible = false;
    }
  }

  announce(text) {
    const messagesEl = document.getElementById('kick-messages');
    if (messagesEl) {
      const div = document.createElement('div');
      div.className = 'chat-message';
      div.innerHTML = `<strong style="color: #8f6bff">[Tlumaczenia]</strong> <span>${text}</span>`;
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    try {
      this.onAnnounce(text);
    } catch (err) {
      console.warn('[tlumaczenia] Blad w onAnnounce:', err);
    }
  }
}
