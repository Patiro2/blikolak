import * as THREE from 'three';
import { loadForest } from './assets.js';
import { strumien, losujInt } from './rng.js';
import { Bojka } from './bojka.js';
import { arenaHalf } from './arena.js';

// Klasa bazowa dla czterech minigier na siatce areny (bitwa o flagi,
// tlumaczenia, panstwa-miasta, zgadnij marke) - patrz zadanie refaktoru.
// Przenosi WYLACZNIE to, co bylo dolownie identyczne (albo identyczne co do
// struktury, roznie sie tylko nazwami pol/tekstem) w tych czterech plikach:
// cykl zycia pola na siatce (spawn/wejscie graczy/wyjscie awaryjne/przerwanie
// przez bossa), odliczanie rund, wyplata nagrody, plotki, narracja announce(),
// getSyncState/applySync (wspolny szkielet + haki na pola wlasne kazdej
// minigry), isTileLocked/isPlayerLocked, setContext/setHost, reset().
//
// KAZDA metoda-hak nizej (nazwy zaczynajace sie od podkreslnika, opisane w
// komentarzu przy definicji) MUSI byc nadpisana przez klase pochodna, chyba
// ze wartosc domyslna juz pasuje (np. _czyOdblokowana() = zawsze true pasuje
// bitwie o flagi, ktora nie ma warunku odblokowania).
//
// Protokol sieciowy (getSyncState/applySync) MUSI zwracac/przyjmowac
// DOKLADNIE ten sam ksztalt co przed refaktorem w kazdej z czterech klas
// pochodnych - patrz komentarze przy getSyncState/applySync nizej i raport
// z refaktoru (ksztalty spisane pole po polu przed/po).

// Minimalny odstep miedzy polami minigier areny (odleglosc "krolem": max z
// |dx|,|dz|). 3 = miedzy dwoma polami minigier zostaja co najmniej 2 wolne
// pola, takze po skosie.
const MIN_ODSTEP_MINIGIER = 3;
function zaBliskoMinigry(x, z, tile) {
  return !!tile && Math.max(Math.abs(x - tile.x), Math.abs(z - tile.z)) < MIN_ODSTEP_MINIGIER;
}

// Nagroda za wygrana minigre: jednorazowa wyplata w momencie zakonczenia
// bitwy (endBattle).
export const NAGRODA_WYGRANEJ = 100;

// Klipy walki dwoch uczestnikow bitwy - kazda postac w projekcie ma je w
// swoim wspolnym slowniku animacji (patrz README, sekcja o rigu). Wybor
// klipu jest DETERMINISTYCZNY wzgledem numeru rundy, wiec host i widz licza
// ten sam klip z tej samej, juz zsynchronizowanej liczby (bez osobnego
// zdarzenia realtime tylko po to, zeby przeslac "jaki to byl cios").
const KLIPY_ATAKU = ['attack-melee-right', 'attack-melee-left', 'attack-kick-right', 'attack-kick-left'];
export function klipAtakuDlaRundy(numerRundy) {
  const i = ((numerRundy % KLIPY_ATAKU.length) + KLIPY_ATAKU.length) % KLIPY_ATAKU.length;
  return KLIPY_ATAKU[i];
}

function capitalizuj(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Szablon plotki (assets/forest/fence.glb) wokol kontestowanego pola.
// loadForest() sam cache'uje wynik (patrz assets.js) - to tylko zeby nie
// odpalac ladowania, dopoki pierwsza bitwa faktycznie sie nie zacznie.
// WSPOLNY dla wszystkich minigier (i dla tla miasta w city.js) - to nie jest
// dodatkowe pobieranie ani osobna kopia geometrii/materialu.
let szablonPlotkiPromise = null;
function pobierzSzablonPlotki() {
  if (!szablonPlotkiPromise) szablonPlotkiPromise = loadForest('fence');
  return szablonPlotkiPromise;
}

export class MinigraBazowa {
  /**
   * @param {THREE.Scene} scene
   * @param {THREE.WebGLRenderer} renderer
   * @param {object} opts
   * @param {string} opts.logTag - tag w logach konsoli, np. 'flagi'.
   * @param {string} opts.nazwaAnnounce - prefiks w komunikacie na czacie, np. 'Bitwa o flagi'.
   * @param {string} opts.kolorAnnounce - kolor CSS prefiksu w komunikacie na czacie.
   * @param {string} opts.nazwaBitwy - nazwa bitwy MALA LITERA na poczatku, uzywana w komunikatach "X anulowana"/"X przerwana", np. 'bitwa o flagi'.
   * @param {number} opts.markerY - wysokosc znacznika pola (patrz komentarze w oryginalnych plikach o z-fighting).
   * @param {number} opts.kolorBazowy - kolor (hex) znacznika pola i sprite'ow.
   * @param {[number, number, number]} opts.spriteScale - skala glownej kartki (i kartki odsloniecia).
   * @param {number} opts.spriteY - wysokosc (Y) glownej kartki (i kartki odsloniecia).
   * @param {string} opts.kluczPola - segment klucza strumienia RNG przy losowaniu pola, np. 'flaga-pole'.
   * @param {string} opts.kluczBojki - segment klucza strumienia RNG dla bijatyki, np. 'flaga-bojka'.
   */
  constructor(scene, renderer, opts) {
    this.scene = scene;
    this.renderer = renderer;

    this.state = 'IDLE'; // IDLE, WAITING, BATTLE, REWARD
    this.timer = 0;
    this.tile = null; // {x, z}
    this.players = []; // [{ typeIndex, username, score, ... }]
    this.battleId = 0; // patrz spawnBattleSquare/nextRound - synchronizowany, inkrementowany WYLACZNIE przez hosta
    this.rewardTimer = 0;
    this.winner = null;

    this.onAnnounce = () => {};
    this.onRewardTick = () => {};

    this._logTag = opts.logTag;
    this._nazwaAnnounce = opts.nazwaAnnounce;
    this._kolorAnnounce = opts.kolorAnnounce;
    this._nazwaBitwy = opts.nazwaBitwy;
    this._kolorBazowy = opts.kolorBazowy;
    this._spriteY = opts.spriteY;
    this._kluczPola = opts.kluczPola;
    this._kluczBojki = opts.kluczBojki;

    // Znacznik kontestowanego pola: pierscien + wypelnienie (Group pod nazwa
    // "highlightMesh" - reszta klasy odwoluje sie do position/visible tej
    // wlasnosci).
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
    this.highlightMesh.position.y = opts.markerY;
    this.highlightMesh.visible = false;

    this.markerPierscien = new THREE.Mesh(
      new THREE.RingGeometry(0.36, 0.49, 40),
      new THREE.MeshBasicMaterial({ color: opts.kolorBazowy, opacity: 0.95, ...wspolneMat }),
    );
    this.highlightMesh.add(this.markerPierscien);

    this.markerWypelnienie = new THREE.Mesh(
      new THREE.CircleGeometry(0.36, 32),
      new THREE.MeshBasicMaterial({ color: opts.kolorBazowy, opacity: 0.18, ...wspolneMat }),
    );
    this.highlightMesh.add(this.markerWypelnienie);

    this.scene.add(this.highlightMesh);

    // Wysuwane plotki (fence.glb) wokol kontestowanego pola.
    this.plotki = [];
    this._plotkiWTrakcieBudowy = false;
    this._ostatniaSekundaDymka = null; // patrz onRewardTick w tick()

    // Glowna kartka (flaga/slowo/litera/logo) - toneMapped = false, bo to
    // plaska 2D grafika (ikona), nie oswietlona powierzchnia 3D.
    this.mainMaterial = new THREE.SpriteMaterial({ color: 0xffffff, toneMapped: false });
    this.mainSprite = new THREE.Sprite(this.mainMaterial);
    this.mainSprite.scale.set(...opts.spriteScale);
    this.mainSprite.position.y = opts.spriteY;
    this.mainSprite.visible = false;
    this.scene.add(this.mainSprite);

    // Kartka odsloniecia po uplywie limitu czasu rundy (tylko flag/marki
    // faktycznie jej uzywaja - dla pozostalych minigier zostaje zawsze
    // niewidoczna, co jest zerowym kosztem behawioralnym).
    this.revealMaterial = new THREE.SpriteMaterial({ color: 0xffffff, toneMapped: false });
    this.revealSprite = new THREE.Sprite(this.revealMaterial);
    this.revealSprite.scale.set(...opts.spriteScale);
    this.revealSprite.position.y = opts.spriteY;
    this.revealSprite.visible = false;
    this.scene.add(this.revealSprite);

    // Tekstura kartki ze zwyciezca - jednorazowa, NIE cache'owana (nick jest
    // unikalny per bitwa), wiec trzeba ja jawnie dispose'owac (patrz reset()).
    this._winnerTexture = null;

    this.isHost = false; // wlasciwa wartosc przychodzi z setContext/setHost
    this.inneMinigry = []; // referencje do pozostalych minigier areny (WYLACZNIE odczyt .tile) - patrz setContext

    // Bijatyka + chmura kurzu (patrz src/bojka.js) - jedna wspoldzielona
    // instancja na cale zycie minigry, wlaczana/wylaczana per bitwa.
    this.bojka = new Bojka(this.scene);
  }

  setContext({ workerManager, kickChat, economy, isHost, boss, inne }) {
    this.workerManager = workerManager;
    this.kickChat = kickChat;
    this.economy = economy;
    this.boss = boss || null; // patrz _przerwijPrzezBossa i isTileLocked
    // Referencje do POZOSTALYCH minigier areny - WYLACZNIE do odczytu ich
    // biezacego kafelka (.tile), zeby losowanie wlasnego pola nigdy nie
    // trafilo w kafelek zajety przez ktorakolwiek z nich (patrz
    // spawnBattleSquare). Zadnej innej ich wlasnosci nie czytamy/zmieniamy.
    this.inneMinigry = Array.isArray(inne) ? inne : [];
    this.setHost(isHost);
  }

  /**
   * isHost moze sie zmienic PO starcie (logowanie/wylogowanie admina w
   * locie) - main.js wola te metode przy KAZDEJ zmianie trybu admina, nie
   * tylko raz w setContext. Kazda faktyczna zmiana roli czysci lokalnie
   * minigre do IDLE (nowy host zaczyna czysto od zera, nowy widz czeka na
   * najblizszy snapshot/zdarzenie od prawdziwego hosta).
   */
  setHost(isHost) {
    const nowy = !!isHost;
    if (nowy === this.isHost) return;
    this.isHost = nowy;
    this.reset();
  }

  /**
   * Czy minigra jest w ogole odblokowana (niektore czekaja na pokonanie
   * konkretnego bossa) - sprawdzane NA BIEZACO w kazdym ticku. Domyslnie
   * zawsze odblokowana (bitwa o flagi nie ma takiego warunku); pozostale
   * trzy minigry nadpisuja.
   */
  _czyOdblokowana() {
    return true;
  }

  isTileLocked(x, z, typeIndex) {
    // Gracz NIGDY nie moze zostac uwieziony blokada minigry w polu ostrzalu
    // bossa - niezaleznie od tego, czy to host, czy widz.
    if (this.boss && this.boss.isActive()) return false;
    if (!this.tile) return false;
    if (this.tile.x !== x || this.tile.z !== z) return false;

    if (this.state === 'WAITING') return false; // mozna wejsc, dopoki nie ma 2 graczy

    if (this.state === 'BATTLE') {
      // W bitwie moga na to pole wejsc/zostac tylko dwaj walczacy.
      return !this.players.some((p) => p.typeIndex === typeIndex);
    }

    return false; // REWARD: pole nie jest juz oznaczone, ruch jest swobodny
  }

  /** Blokada ruchu DLA DWOJGA WALCZACYCH w trakcie BATTLE - patrz moveWorker() w workers.js. */
  isPlayerLocked(typeIndex) {
    if (this.boss && this.boss.isActive()) return false;
    if (this.state !== 'BATTLE') return false;
    return this.players.some((p) => p.typeIndex === typeIndex);
  }

  tick(dt) {
    // Pulsowanie koloru/gasniecie w REWARD sa funkcja Date.now()/rewardTimer
    // (juz zsynchronizowanych), nie losowania - moga bez ryzyka leciec na
    // kazdej karcie identycznie.
    if (this.state === 'BATTLE') {
      const s = Math.sin(Date.now() * 0.005) * 0.5 + 0.5;
      const [r, g, b] = this._kolorPulsBitwy(s);
      this.markerPierscien.material.color.setRGB(r, g, b);
      this.markerPierscien.material.opacity = 0.95;
      this.markerWypelnienie.material.opacity = 0.18;
    } else if (this.state === 'REWARD') {
      const s = Math.sin(Date.now() * 0.003) * 0.5 + 0.5;
      const [r, g, b] = this._kolorPulsReward(s);
      this.markerPierscien.material.color.setRGB(r, g, b);
      const frac = Math.max(0, Math.min(1, 1 - this.rewardTimer / 30));
      this.markerPierscien.material.opacity = 0.95 * frac;
      this.markerWypelnienie.material.opacity = 0.18 * frac;

      // Dymek "+100 zl" TYLKO RAZ przy wejsciu w REWARD - kasa jest juz
      // wyplacona jednorazowo w endBattle, dymek to jej jedyne potwierdzenie.
      if (this.winner && this._ostatniaSekundaDymka === null) {
        this._ostatniaSekundaDymka = Math.floor(Date.now() / 1000);
        try {
          this.onRewardTick(this.winner);
        } catch (err) {
          console.warn(`[${this._logTag}] Blad w onRewardTick:`, err);
        }
      }
    }

    this._aktualizujPlotki(dt);
    this._aktualizujDodatkoweWizualia(dt); // hak: panstwa-miasta rysuje tu rubryki graczy

    // Bijatyka + chmura kurzu: kosmetyczna animacja lokalna, dziala tak samo
    // u hosta i u widza (zrodlem prawdy jest juz zsynchronizowany stan).
    this.bojka.update(dt, this.workerManager);

    // Reszta (losowanie kafelka/pytania, przejscia stanow, przyznawanie
    // kasy) to decyzje - podejmuje je WYLACZNIE host. Widz dostaje gotowy
    // wynik przez applySync() z main.js.
    if (!this.isHost) return;

    const bossAktywny = !!(this.boss && this.boss.isActive());
    if (bossAktywny && this.state !== 'IDLE') {
      this._przerwijPrzezBossa();
      return;
    }

    const odblokowana = this._czyOdblokowana();

    if (this.state === 'IDLE') {
      // Timer NIE nalicza "dlugu" w trakcie walki z bossem / gdy minigra nie
      // jest jeszcze odblokowana.
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
      this._tickBitwy(dt); // hak: limit czasu pojedynczej rundy (flag/panstwa/marki)
      this._sprawdzWyjscieAwaryjne();
    } else if (this.state === 'REWARD') {
      // Kasa jest juz wyplacona jednorazowo w endBattle - ten blok trwa 30 s
      // wylacznie dla wizualiow (gasnace pole, plotki, kartka zwyciezcy).
      this.rewardTimer += dt;
      if (this.rewardTimer >= 30) {
        this.reset();
      }
    }
  }

  /** Hak: limit czasu pojedynczej rundy w trakcie BATTLE. Domyslnie brak (tlumaczenia). */
  _tickBitwy(_dt) {}

  /** Hak: dodatkowe wizualia kosmetyczne co klatke (panstwa-miasta: rubryki graczy). Domyslnie brak. */
  _aktualizujDodatkoweWizualia(_dt) {}

  /** Hak: sprzatanie dodatkowych wizualiow (panstwa-miasta: rubryki graczy). Domyslnie brak. */
  _usunDodatkoweWizualia() {}

  // Ograniczenie prob przy losowaniu pola (siatka NxN, kolizje z bankomatem/
  // pozostalymi minigrami) - petla NIE MOZE zostac nieograniczona.
  static MAX_PROB_LOSOWANIA_POLA = 50;

  spawnBattleSquare() {
    this.battleId += 1;

    // Losowanie DETERMINISTYCZNE z tego samego wspolnego strumienia co
    // reszta gry (patrz rng.js). Klucz zawiera licznik wlasny minigry
    // (trwaly, rosnie z kazda runda - patrz _licznikPola) ORAZ battleId, wiec
    // kolejna bitwa dostaje inne pole rowniez po przeladowaniu strony.
    const klucz = `${this.economy.state.seedGry}:${this._kluczPola}:${this._licznikPola()}:${this.battleId}`;
    const rng = strumien(klucz);
    const zajete = (kx, kz) => this.inneMinigry.some((ref) => zaBliskoMinigry(kx, kz, ref && ref.tile));

    const half = arenaHalf(this.economy); // rozmiar CZYTANY W MOMENCIE UZYCIA
    let rx = null;
    let rz = null;
    for (let proba = 0; proba < this.constructor.MAX_PROB_LOSOWANIA_POLA; proba++) {
      const kx = losujInt(rng, -half, half);
      const kz = losujInt(rng, -half, half);
      if (kx === 0 && kz === 0) continue; // bankomat
      if (zajete(kx, kz)) continue;
      rx = kx;
      rz = kz;
      break;
    }
    if (rx === null) {
      // Awaryjny deterministyczny skan siatki (praktycznie nieosiagalne) -
      // ale petla wyzej MUSI miec koniec.
      szukanie: for (let x = -half; x <= half; x++) {
        for (let z = -half; z <= half; z++) {
          if (x === 0 && z === 0) continue;
          if (zajete(x, z)) continue;
          rx = x;
          rz = z;
          break szukanie;
        }
      }
    }
    if (rx === null) {
      console.warn(`[${this._logTag}] Brak wolnego pola na siatce - pomijam spawn tej rundy.`);
      this.battleId -= 1;
      return;
    }

    this.tile = { x: rx, z: rz };
    this.state = 'WAITING';
    this.timer = 0;

    this.highlightMesh.position.x = rx;
    this.highlightMesh.position.z = rz;
    this.markerPierscien.material.color.setHex(this._kolorBazowy);
    this.markerWypelnienie.material.color.setHex(this._kolorBazowy);
    this.markerPierscien.material.opacity = 0.95;
    this.markerWypelnienie.material.opacity = 0.18;
    this.highlightMesh.visible = true;

    this.mainSprite.position.set(rx, this._spriteY, rz);
    this.mainSprite.visible = false;
  }

  checkPlayersEntry() {
    if (!this.tile) return;

    // Sprawdzamy, ilu aktywnych workerow (Top 10) stoi DOKLADNIE na tym polu.
    const workersOnTile = this.workerManager.entries.filter((e) => {
      const tx = e.targetGridX !== undefined ? e.targetGridX : e.gridX;
      const tz = e.targetGridZ !== undefined ? e.targetGridZ : e.gridZ;
      return tx === this.tile.x && tz === this.tile.z && !e.isFainted;
    });

    if (workersOnTile.length < 2) return;

    const p1 = workersOnTile[0];
    const p2 = workersOnTile[1];
    const p1User = this.kickChat.assignments.workerToUser[p1.typeIndex]?.username || 'Gracz 1';
    const p2User = this.kickChat.assignments.workerToUser[p2.typeIndex]?.username || 'Gracz 2';

    this.players = this._stworzGraczy(p1, p1User, p2, p2User);
    this.state = 'BATTLE';
    this._resetLicznikRund();

    // Obracamy ich twarza do siebie.
    const angleP1 = Math.atan2(p2.obj.position.x - p1.obj.position.x, p2.obj.position.z - p1.obj.position.z);
    p1.targetRotY = angleP1;
    p1.facingAngle = angleP1;
    p2.targetRotY = angleP1 + Math.PI;
    p2.facingAngle = angleP1 + Math.PI;

    // Animacja bijatyki (ciosy + chmura kurzu) - seed zawiera battleId (juz
    // zsynchronizowany), zeby rytm byl powtarzalny w obrebie tej bitwy.
    this.bojka.start(this.tile, this.players, `${this.economy.state.seedGry}:${this._kluczBojki}:${this.battleId}`);

    this.nextRound();
    this.announce(this._komunikatStartBitwy(p1User, p2User));
  }

  /** Hak: obiekty graczy na start bitwy (panstwa-miasta dorzuca pusta rubryke). */
  _stworzGraczy(p1, p1User, p2, p2User) {
    return [
      { typeIndex: p1.typeIndex, username: p1User, score: 0 },
      { typeIndex: p2.typeIndex, username: p2User, score: 0 },
    ];
  }

  /** Hak: zerowanie wlasnego licznika rund minigry (flagsGuessed/wordsGuessed/...) na start bitwy. */
  _resetLicznikRund() {}

  /** Hak: tekst ogloszenia startu bitwy. */
  _komunikatStartBitwy(_p1User, _p2User) {
    return '';
  }

  /**
   * Wyjscie awaryjne: jesli ktorykolwiek z dwoch walczacych straci awatar w
   * trakcie bitwy, isPlayerLocked() trzymalby drugiego gracza zablokowanego
   * w nieskonczonosc. Wywolywane co tick hosta w stanie BATTLE - host
   * wykrywa zniknieccie i orzeka walkower; jesli obaj strace awatar naraz,
   * resetujemy bez zwyciezcy.
   */
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
      this.announce(`Obaj walczacy tracą awatara w trakcie bitwy - ${this._nazwaBitwy} anulowana.`);
      this.reset();
    }
  }

  /**
   * Podmienia teksture GLOWNEJ kartki na kartke ze zwyciezca bitwy - zostaje
   * widoczna przez caly stan REWARD, w tym samym miejscu co pytanie w
   * trakcie gry. Wolane zarowno przez hosta (endBattle) jak i widza
   * (applySync, strażnik wejscia w REWARD).
   */
  _pokazZwyciezce(winnerPlayer) {
    this._invalidujAsynchTeksture(); // hak: flag/marki bronia sie przed spozniona async tekstura
    if (this._winnerTexture) this._winnerTexture.dispose();
    this._winnerTexture = this._renderujTekstNaCanvasie(['🎉 WYGRYWA', winnerPlayer.username]);
    this.mainMaterial.map = this._winnerTexture;
    this.mainMaterial.needsUpdate = true;
    this.mainSprite.visible = true;
    // Kartka zwyciezcy tylko przez 2 s (nagroda 30 s trwa dalej bez niej).
    const idBitwy = this.battleId;
    setTimeout(() => {
      if (this.battleId === idBitwy && this.state === 'REWARD') this.mainSprite.visible = false;
    }, 2000);
    this._ukryjOdsloniete();
  }

  /** Hak: blokuje spoznione async tekstury (flag/marki) przed nadpisaniem kartki zwyciezcy. Domyslnie no-op. */
  _invalidujAsynchTeksture() {}

  /** Hak: rysuje canvas z podanymi liniami tekstu (rozmiar/styl wlasny kazdej minigry). MUSI byc nadpisany. */
  _renderujTekstNaCanvasie(_linie) {
    return null;
  }

  /** Pokazuje kartke odsloniecia (np. "czas minal") w miejscu glownej kartki, chowajac ja. */
  _pokazOdsloniete(texture) {
    this.revealMaterial.map = texture;
    this.revealMaterial.needsUpdate = true;
    this.revealSprite.position.copy(this.mainSprite.position);
    this.revealSprite.visible = true;
    this.mainSprite.visible = false;
  }

  _ukryjOdsloniete() {
    this.revealSprite.visible = false;
  }

  endBattle(winnerPlayer) {
    this.state = 'REWARD';
    this.rewardTimer = 0;
    this._lastRewardTime = 0;
    this.winner = winnerPlayer;
    this._resetOdsloniecieNaKoniec(); // hak: flag/marki czyszcza odslonietaX/_loadedOdsloniecie

    // Nagroda: jednorazowa wyplata NAGRODA_WYGRANEJ w momencie zakonczenia
    // bitwy (host - endBattle jest wolane wylacznie z kodu za straza isHost).
    this.economy.addMoney(NAGRODA_WYGRANEJ);
    if (winnerPlayer.username) {
      this.kickChat.recordEarned(winnerPlayer.username, NAGRODA_WYGRANEJ);
    }

    this._pokazZwyciezce(winnerPlayer);
    // Gwiazdka za wygrana minigre (ranking + plakietka) - patrz kick.js.
    if (this.kickChat) this.kickChat.zapiszWygranaMinigry(winnerPlayer.username);

    // Oznaczenie pola znika CALKOWICIE w chwili wygranej, nie dopiero po
    // 30 s REWARD.
    this.highlightMesh.visible = false;
    this._usunPlotki();
    this._usunDodatkoweWizualia();

    // Zatrzymujemy bijatyke (chowa chmure, odstawia obu na srodek kafla).
    this.bojka.stop(this.workerManager);

    // Przegranego wyrzucamy na losowe wolne pole (lub sasiednie).
    const loser = this.players.find((p) => p.typeIndex !== winnerPlayer.typeIndex);
    if (loser) {
      const lw = this.workerManager.getWorkerType(loser.typeIndex);
      if (lw) {
        const kickHalf = arenaHalf(this.economy);
        let kickX = this.tile.x + (Math.random() > 0.5 ? 1 : -1);
        let kickZ = this.tile.z + (Math.random() > 0.5 ? 1 : -1);
        if (kickX < -kickHalf) kickX = -kickHalf + 1;
        if (kickX > kickHalf) kickX = kickHalf - 1;
        if (kickZ < -kickHalf) kickZ = -kickHalf + 1;
        if (kickZ > kickHalf) kickZ = kickHalf - 1;
        if (kickX === 0 && kickZ === 0) kickX = 1; // zabezpieczenie przed bankomatem

        lw.gridX = kickX;
        lw.gridZ = kickZ;
        lw.targetGridX = kickX;
        lw.targetGridZ = kickZ;
        lw.obj.position.set(kickX, 0, kickZ);
        lw.startPos.set(kickX, 0, kickZ);
        lw.targetPos.set(kickX, 0, kickZ);
      }
    }

    this.announce(this._komunikatWygranej(winnerPlayer));
    this._poEndBattle(winnerPlayer); // hak: marki pokazuje tu dodatkowy baner na ekranie
  }

  /** Hak: czyszczenie odslonietaX/_loadedOdsloniecie na koniec bitwy (flag/marki). Domyslnie no-op. */
  _resetOdsloniecieNaKoniec() {}

  /** Hak: tekst ogloszenia wygranej. Domyslny pasuje flag/marki. */
  _komunikatWygranej(winnerPlayer) {
    return `🎉 ${winnerPlayer.username} WYGRYWA! Dostaje ${NAGRODA_WYGRANEJ} zł!`;
  }

  /** Hak: dodatkowe kroki po endBattle (marki: baner na ekranie). Domyslnie no-op. */
  _poEndBattle(_winnerPlayer) {}

  /**
   * Twarde przerwanie minigry, bo boss wlasnie stal sie aktywny. Boss
   * atakuje TA SAMA siatke - kafelek bitwy i plotki kolidowalyby z tym
   * wizualnie, a plotki mogłyby fizycznie zablokowac graczom ucieczke z pola
   * razenia - dlatego to przerwanie, nie tylko wstrzymanie. Nagroda jest juz
   * wyplacona w calosci w endBattle - przerwanie w trakcie REWARD sprzata
   * tylko wizualia.
   */
  _przerwijPrzezBossa() {
    if (this.state === 'REWARD' && this.winner) {
      this.announce(`⚔️ Boss atakuje! ${capitalizuj(this._nazwaBitwy)} przerwana - koniec swietowania dla ${this.winner.username}.`);
    } else if (this.state === 'BATTLE' || this.state === 'WAITING') {
      this.announce(`⚔️ Boss atakuje! ${capitalizuj(this._nazwaBitwy)} przerwana - pole zwolnione.`);
    }

    this.bojka.stop(this.workerManager);
    this.reset();
  }

  /**
   * Wysuwa/chowa 4 plotki (fence.glb) wokol kontestowanego pola. Cel
   * animacji jest w pelni okreslony przez zsynchronizowany stan
   * (this.state/this.tile) - host i widz licza ten sam cel niezaleznie, ta
   * funkcja tylko plynnie do niego dochodzi klatka po klatce.
   */
  _aktualizujPlotki(dt) {
    const chceWidoczne = (this.state === 'WAITING' || this.state === 'BATTLE') && !!this.tile;

    if (chceWidoczne && !this.plotki.length && !this._plotkiWTrakcieBudowy) {
      this._zapewnijPlotki();
    }
    if (!this.plotki.length) return;

    // Niska docelowa wysokosc (0.55) celowo - plotki maja OZNACZAC pole, nie
    // zaslaniac widzowi walki toczacej sie na nim.
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

  /** Buduje 4 klony plotki wokol this.tile (leniwie, raz na bitwe). */
  async _zapewnijPlotki() {
    this._plotkiWTrakcieBudowy = true;
    try {
      const gltf = await pobierzSzablonPlotki();
      // Minigra mogla zdazyc sie zresetowac zanim model sie zaladowal.
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
        obj.scale.set(0.95, 0.001, 0.95); // startuje schowana - _aktualizujPlotki ja wysunie
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
      console.error(`[${this._logTag}] Blad ladowania plotek pola bitwy:`, err);
    } finally {
      this._plotkiWTrakcieBudowy = false;
    }
  }

  /**
   * Usuwa plotki ze sceny. NIE zwalnia (dispose) geometrii/materialu - to
   * zasob SZABLONU wspoldzielony przez wszystkie klony (kazda minigra,
   * kazda bitwa) i przez tlo miasta w city.js. "Sprzatanie" oznacza wiec:
   * usunac WLASNE klony ze sceny i wyczyscic wlasna tablice.
   */
  _usunPlotki() {
    for (const obj of this.plotki) {
      this.scene.remove(obj);
    }
    this.plotki = [];
  }

  reset() {
    // reset() bywa wolany z kilku miejsc (setHost, koniec REWARD,
    // _sprawdzWyjscieAwaryjne gdy OBAJ walczacy znikna naraz) - nie
    // wszystkie z nich zatrzymuja bojke jawnie, wiec robimy to tez tutaj
    // (no-op, gdy bojka juz nieaktywna).
    if (this.bojka) this.bojka.stop(this.workerManager);
    this.state = 'IDLE';
    this.timer = 0;
    this.tile = null;
    this.players = [];
    this._resetPolaWlasne(); // hak: zerowanie currentX/_loadedX/timerX/... wlasnych kazdej minigry
    this.winner = null;
    this.rewardTimer = 0;
    this._lastRewardTime = 0;
    // battleId celowo NIE jest zerowany - rosnie monotonicznie przez cala
    // sesje, zeby zaden klucz strumienia nigdy nie powtorzyl sie miedzy
    // dwiema roznymi bitwami.
    this.highlightMesh.visible = false;
    this.mainSprite.visible = false;
    this._ukryjOdsloniete();
    // Kartka ze zwyciezca znika razem z reszta planszy - tekstura jest
    // jednorazowa, wiec dispose'ujemy ja tutaj; sam mainMaterial zostaje
    // (wspoldzielony, kolejna bitwa nadpisze jego .map).
    if (this._winnerTexture) {
      this._winnerTexture.dispose();
      this._winnerTexture = null;
    }
    // Przywracamy pelna jaskrawosc znacznika - koncowka REWARD moglo ja
    // zgasic do 0, inaczej NASTEPNA bitwa zaczelaby sie od przygaszonego pola.
    this.markerPierscien.material.opacity = 0.95;
    this.markerWypelnienie.material.opacity = 0.18;
    this._ostatniaSekundaDymka = null;
    // Plotki/rubryki sprzatane od razu (bez animowanego chowania) - reset()
    // bywa wolany tez przy zmianie roli hosta, gdzie animowane wygaszanie w
    // kolejnych klatkach nie mialoby juz czego dokonczyc.
    this._usunPlotki();
    this._usunDodatkoweWizualia();
  }

  /** Hak: zerowanie pol wlasnych minigry (currentFlag/currentWord/litera/currentMarka, liczniki, timery rund...). MUSI byc nadpisany. */
  _resetPolaWlasne() {}

  /**
   * Wycinek stanu wysylany widzom (patrz zbierzStan w main.js). Ksztalt
   * MUSI zostac identyczny jak przed refaktorem w kazdej klasie pochodnej -
   * dopisujemy pola wlasne przez _syncPolaWlasne() dokladnie w tym samym
   * miejscu (miedzy players i winner), gdzie byly w oryginalnym kodzie.
   */
  getSyncState() {
    return {
      state: this.state,
      tile: this.tile,
      players: this.players,
      ...this._syncPolaWlasne(),
      winner: this.winner,
      rewardTimer: this.rewardTimer,
      battleId: this.battleId,
    };
  }

  /** Hak: pola wlasne do getSyncState (np. { currentFlag, odslonietaFlaga, flagsGuessed }). MUSI byc nadpisany. */
  _syncPolaWlasne() {
    return {};
  }

  /**
   * Wyrownuje lokalny (wizualny) stan minigry u widza do tego, co przyslal
   * host. Host tego nie woluje (patrz this.isHost straz nizej).
   */
  applySync(s) {
    if (this.isHost) return;
    if (!s || s.state === 'IDLE' || !s.tile) {
      if (this.state !== 'IDLE') this.reset();
      return;
    }

    const prevState = this.state;
    const prevPlayers = this.players;
    const prevLicznik = this._licznikRundy();
    this.state = s.state;
    this.tile = s.tile;
    this.players = Array.isArray(s.players) ? s.players : [];
    this.winner = s.winner || null;
    this.rewardTimer = s.rewardTimer || 0;
    this.battleId = s.battleId || 0;
    this._zastosujPolaWlasne(s); // hak: currentFlag/currentWord/litera/currentMarka + liczniki wlasne

    // Animacja walki - host ja odpala/zatrzymuje w checkPlayersEntry/
    // endBattle, tu odtwarzamy to samo po zmianie stanu.
    if (this.state === 'BATTLE' && prevState !== 'BATTLE') {
      this.bojka.start(this.tile, this.players, `${this.economy.state.seedGry}:${this._kluczBojki}:${this.battleId}`);
    } else if (prevState === 'BATTLE' && this.state !== 'BATTLE') {
      this.bojka.stop(this.workerManager);
    }

    // Cios za poprawna odpowiedz - u widza wykrywamy to po wzroscie licznika
    // rund (zsynchronizowana liczba) wzgledem poprzedniej wartosci, a ktory
    // gracz uderzyl wyliczamy porownujac wyniki graczy przed/po. Klip
    // wychodzi z tej samej deterministycznej funkcji co u hosta.
    const nowyLicznik = this._licznikRundy();
    if (this.state === 'BATTLE' && nowyLicznik > prevLicznik) {
      const zwyciezcaRundy = this.players.find((p) => {
        const stary = prevPlayers.find((op) => op.typeIndex === p.typeIndex);
        return stary ? p.score > stary.score : p.score > 0;
      });
      if (zwyciezcaRundy) {
        const w = this.workerManager && this.workerManager.getWorkerType(zwyciezcaRundy.typeIndex);
        if (w) this.workerManager.triggerAttack(w, klipAtakuDlaRundy(nowyLicznik));
      }
    }

    this.highlightMesh.position.x = this.tile.x;
    this.highlightMesh.position.z = this.tile.z;
    this.mainSprite.position.set(this.tile.x, this._spriteY, this.tile.z);

    if (this.state === 'REWARD') {
      // Oznaczenie pola znika CALKOWICIE w chwili wygranej, tez u widza -
      // rowniez u widza, ktory dopiero wszedl w trakcie REWARD.
      this.highlightMesh.visible = false;
      this._usunPlotki();
    } else {
      this.highlightMesh.visible = true;
    }

    this._zastosujWizualiaRundy(prevState); // hak: kartka zwyciezcy / tresc pytania / odsloniecie
  }

  /** Hak: przypisanie pol wlasnych z snapshotu hosta (s.currentFlag itd). MUSI byc nadpisany. */
  _zastosujPolaWlasne(_s) {}

  /** Hak: zwraca aktualna wartosc licznika rund wlasnego (flagsGuessed/wordsGuessed/...). MUSI byc nadpisany. */
  _licznikRundy() {
    return 0;
  }

  /** Hak: wizualia zalezne od stanu (kartka zwyciezcy/pytanie/odsloniecie) w applySync. MUSI byc nadpisany. */
  _zastosujWizualiaRundy(_prevState) {}

  /**
   * Dopisuje komunikat na czacie (element #kick-messages) i wola onAnnounce.
   * Prefiks i tresc ida jako OSOBNE wezly tekstowe (textContent), NIE przez
   * sklejanie calego wiersza w innerHTML - text pochodzi z nickow czatu.
   */
  announce(text) {
    const messagesEl = document.getElementById('kick-messages');
    if (messagesEl) {
      const div = document.createElement('div');
      div.className = 'chat-message';
      const prefix = document.createElement('strong');
      prefix.style.color = this._kolorAnnounce;
      prefix.textContent = `[${this._nazwaAnnounce}]`;
      const span = document.createElement('span');
      span.textContent = ` ${text}`;
      div.appendChild(prefix);
      div.appendChild(span);
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    try {
      this.onAnnounce(text);
    } catch (err) {
      console.warn(`[${this._logTag}] Blad w onAnnounce:`, err);
    }
  }
}
