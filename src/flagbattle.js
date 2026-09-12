import * as THREE from 'three';
import { COUNTRIES, COUNTRY_CODES, normalizeCountryName } from './countries.js';
import { loadForest } from './assets.js';
import { strumien, losujZ } from './rng.js';

// Naprawa koloru/rozdzielczosci flag (dwie NIEZALEZNE przyczyny):
//
// 1) Zarzadzanie kolorem: renderer ma outputColorSpace = SRGBColorSpace i
//    ACESFilmicToneMapping (patrz src/scene.js) - tekstura bez
//    texture.colorSpace = SRGBColorSpace jest traktowana jako dane LINIOWE,
//    wiec kolory wychodza wyplowiale/przesuniete, a plaska grafika bez
//    material.toneMapped = false dodatkowo traci nasycenie przez tone
//    mapping pomyslany do oswietlonych scen 3D, nie plaskich ikon.
// 2) Paleta zrodlowa: caly pakiet flag uzywa jednej przygaszonej,
//    zestylizowanej palety (9 kolorow odpowiada za wiekszosc powierzchni
//    wszystkich 232 flag) - np. biel to #EEEEF7 (lekko niebieskawa), a nie
//    prawdziwa biel. To NIE jest blad renderu, tak wygladaja same pliki
//    zrodlowe (PNG i SVG identycznie) - poprawka wymaga podmiany kolorow.
//
// Rozwiazanie: SVG (wektor, wiec dowolna rozdzielczosc) ladowany jako tekst,
// kolory z palety podmieniane na nasycone, rasteryzacja przez Image+canvas
// w 256x256 (dawne PNG mialy 64x64), i z canvasu CanvasTexture z poprawnym
// colorSpace i anizotropia. Wynik cache'owany po kodzie kraju - flaga
// rasteryzuje sie raz na sesje, kazda kolejna runda z tym samym krajem
// dostaje ta sama tekstura z cache (zero nowych obiektow, zero wycieku).
const PALETA_KOLOROW = {
  '#EEEEF7': '#FFFFFF',
  '#EC2037': '#D7141A',
  '#25252A': '#111111',
  '#FCC920': '#FFCE00',
  '#259F6C': '#009B3A',
  '#3439CB': '#0038A8',
  '#392D8C': '#24246E',
  '#5193EE': '#5B9BD5',
  '#C4863B': '#B8762E',
};

const ROZMIAR_TEKSTURY_FLAGI = 256; // bylo 64 (PNG "Default")

// Wysokosc znacznika kontestowanego pola. NIE wolno kolidowac z innymi
// warstwami podlogi areny: 0.025 wierzch kafla podlogi (scene.js), 0.035
// neonowa siatka areny (scene.js), 0.042 znaczniki atakow bossa
// (bossattack.js), 0.048 wskaznik zlotej monety (goldcoin.js). 0.052 jest
// ponad wszystkimi - znacznik bitwy o flagi zawsze wygrywa z-fighting.
const MARKER_Y = 0.052;

// Klipy walki dwoch uczestnikow bitwy - kazda postac w projekcie ma je w
// swoim wspolnym slowniku animacji (patrz README, sekcja o rigu). Wybor
// klipu jest DETERMINISTYCZNY wzgledem numeru rundy (flagsGuessed po
// inkrementacji) - i host (ktory faktycznie ocenia odpowiedz), i widz
// (ktory dostaje flagsGuessed synchronizacją) licza TEN SAM klip z tej
// samej liczby, wiec nie trzeba dodawac osobnego zdarzenia realtime tylko
// po to, zeby przeslac "jaki to byl cios".
const KLIPY_ATAKU = ['attack-melee-right', 'attack-melee-left', 'attack-kick-right', 'attack-kick-left'];
function klipAtakuDlaRundy(numerRundy) {
  const i = ((numerRundy % KLIPY_ATAKU.length) + KLIPY_ATAKU.length) % KLIPY_ATAKU.length;
  return KLIPY_ATAKU[i];
}

// Szablon plotek (assets/forest/fence.glb) wokol kontestowanego pola.
// loadForest() sam cache'uje wynik (patrz assets.js) - to tylko zeby nie
// odpalac ladowania, dopoki pierwsza bitwa faktycznie sie nie zacznie.
let szablonPlotkiPromise = null;
function pobierzSzablonPlotki() {
  if (!szablonPlotkiPromise) szablonPlotkiPromise = loadForest('fence');
  return szablonPlotkiPromise;
}

// kod kraju -> Promise<THREE.CanvasTexture>. Modul jest singletonem na karte
// (ES modules), wiec ten cache dziala "raz na sesje" nawet gdyby kiedys
// powstala wiecej niz jedna instancja FlagBattleManager na tej samej karcie.
const cacheTeksturFlag = new Map();

function podmienKoloryNaNasycone(svgText) {
  let out = svgText;
  for (const [stary, nowy] of Object.entries(PALETA_KOLOROW)) {
    out = out.split(stary).join(nowy);
  }
  return out;
}

// Awaryjna sciezka dla flag, ktorych zrodlowy SVG jest nie do naprawy
// (zdegenerowana/niepelna geometria - zobacz komentarz przy AS ponizej).
// Dla tych kodow rasteryzujemy PNG z paczki (assets/flags-png/) zamiast
// SVG, i podmieniamy paleta NA PIKSELACH canvasu (PNG uzywa tej samej
// zestylizowanej palety co SVG, wiec bez podmiany flaga wygladalaby blado
// na tle reszty). Dopasowanie koloru jest "najblizszy sasiad" z progiem
// odleglosci w przestrzeni RGB - lapie piksele antyaliasingu blisko
// jednego z 9 kolorow palety, zostawia bez zmian piksele dalekie od
// wszystkich (np. gdyby PNG mial kolor spoza znanej palety).
//
// AS (Samoa Amerykanskie): assets/flags-vector/AS.svg ma geometrie
// przycieta/zdegenerowana - wspolrzedne ujemne w okolicy -14..+14 przy
// viewBox 64x64, wiec rysunek renderuje sie jako niewidoczny/przyciety
// skrawek w rogu, nie flage. Rekonstrukcja wektorowa orla z symbolami
// wladzy "na oko" bylaby zgadywanka - zamiast tego PNG z paczki (ten sam
// zasob, ktory Kenney faktycznie wyeksportowal jako obrazek flagi).
const KODY_PNG_FALLBACK = new Set(['AS']);

function hexNaRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const PALETA_RGB = Object.entries(PALETA_KOLOROW).map(([stary, nowy]) => [hexNaRgb(stary), hexNaRgb(nowy)]);
// Prog dopasowania "najblizszy sasiad" - suma kwadratow roznic na R,G,B.
// 40 na kanal (40*40*3) lapie piksele antyaliasingu przy krawedziach
// ksztaltow, nie zmienia kolorow spoza palety.
const PROG_DOPASOWANIA_RGB = 40 * 40 * 3;

function podmienKoloryNaNasyconeNaPikselach(ctx, szerokosc, wysokosc) {
  const imgData = ctx.getImageData(0, 0, szerokosc, wysokosc);
  const d = imgData.data;
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    let najlepszy = null;
    let najlepszaOdleglosc = Infinity;
    for (const [zrodlo, cel] of PALETA_RGB) {
      const odleglosc = (r - zrodlo[0]) ** 2 + (g - zrodlo[1]) ** 2 + (b - zrodlo[2]) ** 2;
      if (odleglosc < najlepszaOdleglosc) {
        najlepszaOdleglosc = odleglosc;
        najlepszy = cel;
      }
    }
    if (najlepszy && najlepszaOdleglosc < PROG_DOPASOWANIA_RGB) {
      d[i] = najlepszy[0];
      d[i + 1] = najlepszy[1];
      d[i + 2] = najlepszy[2];
    }
  }
  ctx.putImageData(imgData, 0, 0);
}

/**
 * Pobiera SVG flagi, podmienia paleta, rasteryzuje do canvasu 256x256 i
 * zwraca CanvasTexture z poprawnym colorSpace/anizotropia. Wynik cache'owany
 * po kodzie kraju - druga i kolejne prosby o te sama flage dostaja gotowa
 * tekstura z cache, bez ponownego pobierania/rasteryzacji.
 */
function zaladujTeksturaFlagi(kod, renderer) {
  if (cacheTeksturFlag.has(kod)) return cacheTeksturFlag.get(kod);

  const promise = (async () => {
    const canvas = document.createElement('canvas');
    canvas.width = ROZMIAR_TEKSTURY_FLAGI;
    canvas.height = ROZMIAR_TEKSTURY_FLAGI;
    const ctx = canvas.getContext('2d');

    if (KODY_PNG_FALLBACK.has(kod)) {
      // Sciezka awaryjna PNG (patrz komentarz przy KODY_PNG_FALLBACK) -
      // brak URL.createObjectURL/revokeObjectURL, bo Image laduje plik
      // bezposrednio z assets/flags-png/, bez posredniego Bloba.
      const img = await new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error(`Blad rasteryzacji PNG flagi ${kod}`));
        im.src = `assets/flags-png/${kod}.png`;
      });
      ctx.drawImage(img, 0, 0, ROZMIAR_TEKSTURY_FLAGI, ROZMIAR_TEKSTURY_FLAGI);
      podmienKoloryNaNasyconeNaPikselach(ctx, ROZMIAR_TEKSTURY_FLAGI, ROZMIAR_TEKSTURY_FLAGI);
    } else {
      const resp = await fetch(`assets/flags-vector/${kod}.svg`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status} przy pobieraniu assets/flags-vector/${kod}.svg`);
      const svgTextOryginalny = await resp.text();
      const svgText = podmienKoloryNaNasycone(svgTextOryginalny);

      const blob = new Blob([svgText], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      try {
        const img = await new Promise((resolve, reject) => {
          const im = new Image();
          im.onload = () => resolve(im);
          im.onerror = () => reject(new Error(`Blad rasteryzacji SVG flagi ${kod}`));
          im.src = url;
        });
        ctx.drawImage(img, 0, 0, ROZMIAR_TEKSTURY_FLAGI, ROZMIAR_TEKSTURY_FLAGI);
      } finally {
        URL.revokeObjectURL(url);
      }
    }

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    if (renderer && renderer.capabilities && typeof renderer.capabilities.getMaxAnisotropy === 'function') {
      texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
    }
    texture.needsUpdate = true;
    return texture;
  })();

  cacheTeksturFlag.set(kod, promise);
  // Nieudana probka NIE zostaje w cache na zawsze - inaczej jeden chwilowy
  // blad sieci blokowalby te flage do konca sesji. Kolejne zadanie tego
  // samego kodu sprobuje ponownie.
  promise.catch(() => cacheTeksturFlag.delete(kod));
  return promise;
}

export class FlagBattleManager {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    
    this.state = 'IDLE'; // IDLE, WAITING, BATTLE, REWARD
    this.timer = 0;
    this.tile = null; // {x, z}
    this.players = []; // [{ typeIndex, username, score }]
    
    this.currentFlag = null; // np. 'PL'
    this._loadedFlag = null; // ostatnia flaga, ktorej tekstura zostala zaladowana (uzywane w applySync u widza)
    this.flagsGuessed = 0; // Ile flag zgadnięto w obecnej bitwie

    // idBitwy - patrz nextRound(). Synchronizowany (getSyncState/applySync),
    // NIE lokalny licznik karty - inkrementowany WYLACZNIE przez hosta w
    // spawnBattleSquare(), wiec kazda karta (i ewentualny nowy host po
    // przejeciu roli w locie) widzi ta sama wartosc dla tej samej bitwy.
    this.battleId = 0;
    // Flagi juz wylosowane W TEJ bitwie - zyje tylko miedzy spawnBattleSquare/
    // wejsciem w BATTLE a reset() (patrz komentarze przy obu), nie przecieka
    // do kolejnych bitew.
    this._uzyteFlagi = new Set();
    this._probLosowaniaFlagi = 0; // diagnostyka: ile prob potrzebowala OSTATNIA runda

    this.rewardTimer = 0;
    this.winner = null;

    // Wolane po kazdym announce() z tekstem - main.js podpina tu rozgloszenie
    // przez kanal realtime (zdarzenie 'flaga-info'), zeby widzowie widzieli
    // narracje bitwy natychmiast, a nie dopiero przy nastepnym snapshocie co 2 s.
    // Domyslnie no-op, gdyby main.js tego nie podpial.
    this.onAnnounce = () => {};

    // Wolane raz na sekunde w trakcie REWARD z aktualnym zwyciezca - main.js
    // podpina tu dymek "+2 zl" przez projectAndFloat (patrz main.js). Samo
    // naliczanie kasy (economy.addMoney) dzieje sie osobno w tick() nizej i
    // NIE zalezy od tego callbacku - to czysto kosmetyczne potwierdzenie.
    // Domyslnie no-op.
    this.onRewardTick = () => {};

    // Znacznik kontestowanego pola: pierscien + wypelnienie (wzorem oznaczPole
    // w bossattack.js i wskaznika w goldcoin.js) zamiast plaskiego kwadratu.
    // Trzymany jako Group pod nazwa "highlightMesh" (reszta pliku odwoluje
    // sie do position/visible tej wlasnosci) - kolor/opacity ida przez
    // markerPierscien/markerWypelnienie.
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
      new THREE.MeshBasicMaterial({ color: 0x00ff00, opacity: 0.95, ...wspolneMat }),
    );
    this.highlightMesh.add(this.markerPierscien);

    this.markerWypelnienie = new THREE.Mesh(
      new THREE.CircleGeometry(0.36, 32),
      new THREE.MeshBasicMaterial({ color: 0x00ff00, opacity: 0.18, ...wspolneMat }),
    );
    this.highlightMesh.add(this.markerWypelnienie);

    this.scene.add(this.highlightMesh);

    // Wysuwane plotki (fence.glb) wokol kontestowanego pola - patrz
    // _aktualizujPlotki/_zapewnijPlotki/_usunPlotki nizej.
    this.plotki = [];
    this._plotkiWTrakcieBudowy = false;
    this._ostatniaSekundaDymka = null; // patrz onRewardTick

    // Sprite z flagą. toneMapped = false - to plaska 2D grafika (ikona), nie
    // oswietlona powierzchnia 3D, wiec ACESFilmicToneMapping z renderera nie
    // powinien jej przygaszac/przesuwac kolorow (patrz komentarz nad PALETA_KOLOROW).
    this.flagMaterial = new THREE.SpriteMaterial({ color: 0xffffff, toneMapped: false });
    this.flagSprite = new THREE.Sprite(this.flagMaterial);
    this.flagSprite.scale.set(1.5, 1.0, 1.0); // proporcja flagi
    this.flagSprite.position.y = 3.0; // Nad polem
    this.flagSprite.visible = false;
    this.scene.add(this.flagSprite);

    this._flagReqId = 0; // chroni przed wyscigiem, gdy runda zmieni sie zanim async rasteryzacja skonczy
    this.isHost = false; // wlasciwa wartosc przychodzi z setContext/setHost - patrz nizej
  }

  setContext({ workerManager, kickChat, economy, isHost, boss }) {
    this.workerManager = workerManager;
    this.kickChat = kickChat;
    this.economy = economy;
    this.boss = boss || null; // patrz _przerwijPrzezBossa i isTileLocked nizej
    // NAPRAWA: przed ta zmiana kazda otwarta karta (host i kazdy widz) miala
    // wlasna, niezalezna instancje FlagBattleManager i tick() na kazdej z nich
    // losowal Math.random() SAM - inny kafelek, inna flaga, w innym momencie.
    // To dokladnie ta klasa bledu, ktora rng.js opisuje jako niedozwolona w
    // tej grze (kazda karta ma wlasna symulacje, wiec goly Math.random() daje
    // rozjazd) i ktora a3773a3 juz raz naprawial dla klikow/pozycji - tu
    // wrocila swiezo w nowym module. Teraz decyzje (kafelek, flaga, wygrana,
    // kasa) podejmuje WYLACZNIE host; widz dostaje gotowy stan przez
    // getSyncState/applySync (patrz main.js: zbierzStan/zastosujStanZSerwera),
    // dokladnie jak boss.js.
    this.setHost(isHost);
  }

  /**
   * NAPRAWA: setContext() jest wolane RAZ, przy starcie main() - ale
   * remote.czyAdmin() moze sie zmienic PO starcie (zalogowanie/wylogowanie
   * przyciskiem admina, patrz main.js zastosujTrybAdmina), a poprzednia
   * wersja tego nigdy nie odswiezala. Skutek na produkcji: karta wlasciciela
   * startuje niezalogowana -> isHost=false na stale -> wszystkie straze w
   * tick()/onChatMessage() blokuja decyzje -> minigra NIGDY nie startuje,
   * mimo ze po zalogowaniu remote.czyAdmin() juz zwraca true. main.js wola
   * TERAZ te metode przy kazdej zmianie trybu admina (poczatek, logowanie,
   * wylogowanie) - nie tylko raz w setContext.
   *
   * Zmiana roli W TRAKCIE trwajacej bitwy zostawilaby niespojny stan (np.
   * nowy host bez lokalnie odpalonych animacji walki/rotacji graczy, ktore
   * normalnie ustawia checkPlayersEntry(); nowy widz bez zadnego zrodla
   * kolejnych snapshotow, jesli to byl jedyny host) - dlatego KAZDA faktyczna
   * zmiana roli czysci lokalnie minigre do IDLE. Nowy host zaczyna odliczac
   * 30 s od zera (czysty start, bez polowicznego stanu), nowy widz dostaje
   * pusty ekran do czasu najblizszego snapshotu/zdarzenia od prawdziwego hosta.
   */
  setHost(isHost) {
    const nowy = !!isHost;
    if (nowy === this.isHost) return;
    this.isHost = nowy;
    this.reset();
  }

  isTileLocked(x, z, typeIndex) {
    // Zabezpieczenie NIEZALEZNE od sprzatania w _przerwijPrzezBossa: gracz
    // NIGDY nie moze zostac uwieziony blokada minigry w polu ostrzalu bossa
    // (ten sam kwadrat 7x7 - wymioty/rakiety). Nawet gdyby gdzies zostal
    // resztkowy stan (this.tile/this.state) z minigry, ta funkcja i tak
    // zwraca false, gdy boss jest aktywny - niezaleznie od tego, czy to
    // host, czy widz (kazdy czyta wlasny, juz zsynchronizowany boss.state).
    if (this.boss && this.boss.isActive()) return false;
    if (!this.tile) return false;
    if (this.tile.x !== x || this.tile.z !== z) return false;
    
    if (this.state === 'WAITING') {
      // Można wejść, dopóki nie ma 2 graczy
      return false;
    }
    
    if (this.state === 'BATTLE') {
      // W bitwie na to pole mogą wejść/zostać tylko ci dwaj gracze (chociaż w sumie są tam zamknięci)
      return !this.players.some(p => p.typeIndex === typeIndex);
    }
    
    if (this.state === 'REWARD') {
      // Tylko zwycięzca ma prawo być na tym polu
      return !this.winner || this.winner.typeIndex !== typeIndex;
    }
    
    return false;
  }

  tick(dt) {
    // Pulsowanie koloru jest funkcja Date.now(), nie losowania - moze bez
    // ryzyka leciec na kazdej karcie, host i widz pulsuja identycznie. Tak
    // samo gasniecie pola w REWARD i wysuwanie/chowanie plotek - wszystko
    // to jest wyprowadzone z synchronizowanego stanu (this.state/this.tile/
    // this.rewardTimer), animacja miedzy klatkami jest juz lokalnym
    // wygladzeniem (jak lerp pozycji pracownikow w workers.js), a nie
    // niezalezna decyzja.
    if (this.state === 'BATTLE') {
      const s = Math.sin(Date.now() * 0.005) * 0.5 + 0.5;
      this.markerPierscien.material.color.setRGB(1, s * 0.5, s * 0.5);
      this.markerPierscien.material.opacity = 0.95;
      this.markerWypelnienie.material.opacity = 0.18;
    } else if (this.state === 'REWARD') {
      const s = Math.sin(Date.now() * 0.003) * 0.5 + 0.5;
      this.markerPierscien.material.color.setRGB(1, 0.8 + s * 0.2, 0);
      // Gasniecie pola proporcjonalnie do pozostalego czasu nagrody (30 s) -
      // pelna jaskrawosc na starcie, 0 tuz przed koncem. Przywracane w reset().
      const frac = Math.max(0, Math.min(1, 1 - this.rewardTimer / 30));
      this.markerPierscien.material.opacity = 0.95 * frac;
      this.markerWypelnienie.material.opacity = 0.18 * frac;

      // Dymek "+2 zl" nad zwyciezca - raz na sekunde zegara (nie lokalny
      // niezalezny timer per karta - kazda karta liczy Date.now() tak samo,
      // a WARUNEK wejscia (state===REWARD, kto jest winner) jest w pelni
      // zsynchronizowany). Samo naliczanie kasy jest ponizej, niezalezne od
      // tego callbacku - main.js tylko pokazuje potwierdzenie.
      if (this.winner) {
        const sekunda = Math.floor(Date.now() / 1000);
        if (this._ostatniaSekundaDymka !== sekunda) {
          this._ostatniaSekundaDymka = sekunda;
          try {
            this.onRewardTick(this.winner);
          } catch (err) {
            console.warn('[flagi] Blad w onRewardTick:', err);
          }
        }
      }
    }

    this._aktualizujPlotki(dt);

    // Reszta (losowanie kafelka/flagi, przejscia stanow, przyznawanie kasy)
    // to decyzje - te podejmuje WYLACZNIE host. Widz dostaje gotowy wynik
    // przez applySync() wolane z main.js po kazdym snapshocie. Zaden z
    // krokow ponizej NIE sprawdza boss.isActive() niezaleznie na widzu -
    // to by bylo dokladnie to samo "kazda karta sama sobie liczy" co
    // naprawiono dla reszty minigry. Decyzje o przerwaniu/wstrzymaniu przez
    // bossa podejmuje WYLACZNIE host, tutaj, i dociera do widza tym samym
    // getSyncState/applySync co reszta stanu.
    if (!this.isHost) return;

    // Boss atakuje TA SAMA siatke 7x7 (wymioty/rakiety) - kafelek bitwy i
    // wysuwajace sie plotki kolidowalyby z tym wizualnie, a plotki mogłyby
    // fizycznie zablokowac graczom ucieczke z pola razenia (isTileLocked
    // wplywa na ruch po siatce). Dlatego bitwa jest PRZERYWANA na twardo
    // (nie tylko wstrzymywana), gdy tylko boss staje sie aktywny.
    const bossAktywny = !!(this.boss && this.boss.isActive());
    if (bossAktywny && this.state !== 'IDLE') {
      this._przerwijPrzezBossa();
      return;
    }

    if (this.state === 'IDLE') {
      // Timer NIE nalicza "dlugu" w trakcie walki z bossem - inaczej minigra
      // odpalalaby sie natychmiast po pokonaniu bossa zamiast odczekac pelny
      // cykl od zera. Zerujemy go co klatke, dopoki boss jest aktywny.
      if (bossAktywny) {
        this.timer = 0;
      } else {
        this.timer += dt;
        if (this.timer >= 30) {
          this.spawnBattleSquare();
        }
      }
    }
    else if (this.state === 'WAITING') {
      this.checkPlayersEntry();
    }
    else if (this.state === 'REWARD') {
      this.rewardTimer += dt;

      // Pasywny dochód (np. tick co 1 sekundę by dawał +2zł)
      // Żeby zrealizować 2 zł / sek, możemy sumować czas ułamkowy, albo dawać co 1 sek:
      if (!this._lastRewardTime) this._lastRewardTime = 0;
      this._lastRewardTime += dt;
      if (this._lastRewardTime >= 1.0) {
        this._lastRewardTime -= 1.0;
        this.economy.addMoney(2);
        if (this.winner && this.winner.username) {
           this.kickChat.recordEarned(this.winner.username, 2);
           // Uwaga: byl tu kiedys zalazek dymka "+2 zl" doklejanego do
           // nieistniejacego #ui-layer (patrz historia tego pliku) - to byl
           // niedokonczony blok, ktory rzucal wyjatkiem co sekunde i kladl
           // cala gre. Prawdziwy dymek jest TERAZ wyzej w tym samym tick(),
           // w bloku REWARD kosmetyki (onRewardTick), i idzie przez
           // sprawdzona sciezke main.js -> projectAndFloat -> ui.spawnFloater
           // (#floaters, nie #ui-layer) - dokladnie ta sama, ktorej uzywaja
           // wszystkie inne dymki w grze.
        }
      }

      if (this.rewardTimer >= 30) {
        this.reset();
      }
    }
  }

  spawnBattleSquare() {
    // Losujemy pole na siatce -3 do 3, bez (0,0) (bankomat)
    let rx, rz;
    do {
      rx = Math.floor(Math.random() * 7) - 3;
      rz = Math.floor(Math.random() * 7) - 3;
    } while (rx === 0 && rz === 0);
    
    this.tile = { x: rx, z: rz };
    this.state = 'WAITING';
    this.timer = 0;

    // Nowa bitwa (a przynajmniej nowa proba - jeszcze bez graczy) - patrz
    // komentarz przy battleId/_uzyteFlagi w konstruktorze. Zerujemy zbior
    // uzytych flag TUTAJ (a nie dopiero w checkPlayersEntry/BATTLE), zeby na
    // pewno nie zostal ani jeden wpis z poprzedniej bitwy - dokladnie tak,
    // jak wymaga specyfikacja (spawnBattleSquare ORAZ wejscie w BATTLE ORAZ reset()).
    this.battleId += 1;
    this._uzyteFlagi.clear();

    this.highlightMesh.position.x = rx;
    this.highlightMesh.position.z = rz;
    this.markerPierscien.material.color.setHex(0x00ff00);
    this.markerWypelnienie.material.color.setHex(0x00ff00);
    // Pelna jaskrawosc na starcie nowego pola - poprzednia bitwa mogla
    // zgasic ja do 0 w koncowce REWARD (patrz tick), reset() tez to
    // przywraca, ale ustawiamy jawnie tutaj tak samo, na wszelki wypadek.
    this.markerPierscien.material.opacity = 0.95;
    this.markerWypelnienie.material.opacity = 0.18;
    this.highlightMesh.visible = true;

    this.flagSprite.position.set(rx, 2.5, rz);
    this.flagSprite.visible = false;
  }

  checkPlayersEntry() {
    if (!this.tile) return;
    
    // Sprawdzamy, ilu aktywnych workerów (Top 10) stoi DOKŁADNIE na tym polu
    const workersOnTile = this.workerManager.entries.filter(e => {
      // Sprawdzamy targetGridX / targetGridZ, żeby łapać w trakcie chodu
      const tx = e.targetGridX !== undefined ? e.targetGridX : e.gridX;
      const tz = e.targetGridZ !== undefined ? e.targetGridZ : e.gridZ;
      return tx === this.tile.x && tz === this.tile.z && !e.isFainted;
    });

    if (workersOnTile.length >= 2) {
      // Start bitwy!
      const p1 = workersOnTile[0];
      const p2 = workersOnTile[1];
      
      const p1User = this.kickChat.assignments.workerToUser[p1.typeIndex]?.username || 'Gracz 1';
      const p2User = this.kickChat.assignments.workerToUser[p2.typeIndex]?.username || 'Gracz 2';

      this.players = [
        { typeIndex: p1.typeIndex, username: p1User, score: 0 },
        { typeIndex: p2.typeIndex, username: p2User, score: 0 }
      ];
      
      this.state = 'BATTLE';
      this.flagsGuessed = 0;
      // Zerujemy jeszcze raz na wejsciu do BATTLE (spawnBattleSquare juz to
      // zrobil, ale specyfikacja explicite wymaga tego rowniez tutaj - tania
      // gwarancja, ze zaden wpis z poprzedniej bitwy nie przecieknie).
      this._uzyteFlagi.clear();

      // Obracamy ich twarzą do siebie
      const angleP1 = Math.atan2(p2.obj.position.x - p1.obj.position.x, p2.obj.position.z - p1.obj.position.z);
      p1.targetRotY = angleP1;
      p1.facingAngle = angleP1;
      p2.targetRotY = angleP1 + Math.PI;
      p2.facingAngle = angleP1 + Math.PI;
      
      // Animacja walki
      if (p1.interactAction) p1.interactAction.play();
      if (p2.interactAction) p2.interactAction.play();
      
      this.nextRound();
      this.announce(`Bitwa o flagi! ${p1User} vs ${p2User}! Wpisuj nazwę państwa na czacie! Kto pierwszy zdobędzie 3 pkt wygrywa!`);
    }
  }
  
  // Ograniczenie prob przy unikaniu powtorki - przy 232 flagach i realistycznie
  // max kilkunastu rundach na bitwe to praktycznie nigdy nie powinno wystrzelic,
  // ale petla NIE MOZE zostac nieograniczona (zawiesilaby klatke).
  static MAX_PROB_LOSOWANIA_FLAGI = 50;

  nextRound() {
    if (this.state !== 'BATTLE') return;

    // NAPRAWA: flaga byla losowana golym Math.random() - poza wspolnym
    // strumieniem, na ktorym stoi cala synchronizacja tej gry (patrz rng.js,
    // boss.js _rownanieRng). Dzis sie to nie ujawnia (widz dostaje flage
    // GOTOWA w snapshocie, nie losuje sam), ale: (1) po naprawie isHost widz
    // MOZE zostac nowym hostem w trakcie zycia strony (choc nie W TRAKCIE tej
    // samej bitwy - setHost() resetuje minigre przy zmianie roli), (2) bez
    // wspolnego strumienia przebiegu bitwy nie da sie odtworzyc ani
    // zweryfikowac. Klucz `${seedGry}:flaga:${battleId}:${numerRundy}` -
    // battleId jest SYNCHRONIZOWANY (getSyncState/applySync, patrz konstruktor),
    // nie lokalnym licznikiem karty, wiec kazda karta liczaca ten sam klucz
    // dostanie ten sam wynik.
    const numerRundy = this.flagsGuessed + 1;
    const klucz = `${this.economy.state.seedGry}:flaga:${this.battleId}:${numerRundy}`;
    const rng = strumien(klucz);

    // Bez powtorek W OBREBIE JEDNEJ BITWY: losujemy z TEGO SAMEGO strumienia
    // (kolejne wywolanie rng(), NIE nowy klucz) az trafimy flage spoza
    // this._uzyteFlagi. To zostaje deterministyczne, bo strumien jest
    // deterministyczny - kazda karta powtarzajaca te sama petle dojdzie do
    // tego samego wyniku po tej samej liczbie prob.
    let wybrana = null;
    let proby = 0;
    while (proby < FlagBattleManager.MAX_PROB_LOSOWANIA_FLAGI) {
      proby += 1;
      const kandydat = losujZ(rng, COUNTRY_CODES);
      if (!this._uzyteFlagi.has(kandydat)) {
        wybrana = kandydat;
        break;
      }
    }
    if (!wybrana) {
      // Praktycznie nieosiagalne (232 flagi, garstka rund/bitwe) - ale petla
      // MUSI miec koniec, wiec bierzemy ostatniego kandydata zamiast zawiesic
      // klatke. Nadal deterministyczne (ten sam strumien na kazdej karcie).
      wybrana = losujZ(rng, COUNTRY_CODES);
    }
    this._probLosowaniaFlagi = proby;
    this._uzyteFlagi.add(wybrana);

    this.currentFlag = wybrana;
    this._stosujTeksturaFlagi(this.currentFlag);
  }

  /**
   * Ustawia teksture sprite'a flagi na podana flage (kod ISO), korzystajac z
   * cache'u modulowego zaladujTeksturaFlagi (patrz gora pliku). Uzywane
   * zarowno przez hosta (nextRound, decyzja) jak i widza (applySync, echo
   * decyzji hosta) - stad wspolna metoda.
   *
   * Chroni przed wyscigiem: jesli w trakcie asynchronicznej rasteryzacji
   * runda zdazy sie zmienic (kolejne wywolanie tej metody), starszy wynik
   * jest ignorowany i NIE nadpisuje nowszej flagi.
   */
  _stosujTeksturaFlagi(kod) {
    this._flagReqId += 1;
    const mojeId = this._flagReqId;
    zaladujTeksturaFlagi(kod, this.renderer)
      .then((texture) => {
        if (mojeId !== this._flagReqId) return; // starsze zadanie, zdazylo sie juz zdezaktualizowac
        this.flagMaterial.map = texture;
        this.flagMaterial.needsUpdate = true;
        this.flagSprite.visible = true;
      })
      .catch((err) => {
        console.error(`[flagi] Blad ladowania tekstury flagi ${kod}:`, err);
      });
  }

  onChatMessage(username, content) {
    // Ocena odpowiedzi to decyzja - tylko host jej dokonuje (patrz komentarz
    // przy isHost w setContext). Widz i tak dostanie wynik przez applySync.
    if (!this.isHost) return;
    if (this.state !== 'BATTLE' || !this.currentFlag) return;
    
    const player = this.players.find(p => p.username.toLowerCase() === username.toLowerCase());
    if (!player) return; // Tylko gracze na polu mogą odpowiadać
    
    const ans = normalizeCountryName(content);
    const expected = normalizeCountryName(COUNTRIES[this.currentFlag]);
    
    if (ans === expected || ans.includes(expected)) {
      player.score += 1;
      this.flagsGuessed += 1;
      const properName = COUNTRIES[this.currentFlag];
      this.currentFlag = null; // blokada by nie nabić 2x na 1 wiadomości

      // Animacja ciosu za poprawna odpowiedz - klip wybrany deterministycznie
      // z flagsGuessed (patrz klipAtakuDlaRundy), zeby widz policzyl DOKLADNIE
      // to samo z synchronizowanego flagsGuessed w applySync, bez potrzeby
      // osobnego zdarzenia realtime.
      const workerEntry = this.workerManager && this.workerManager.getWorkerType(player.typeIndex);
      if (workerEntry) {
        this.workerManager.triggerAttack(workerEntry, klipAtakuDlaRundy(this.flagsGuessed));
      }

      this.announce(`${username} zgaduje poprawnie: ${properName}! (Punkty: ${player.score})`);

      if (player.score >= 3) {
        this.endBattle(player);
      } else {
        setTimeout(() => this.nextRound(), 1000);
      }
    }
  }
  
  endBattle(winnerPlayer) {
    this.state = 'REWARD';
    this.rewardTimer = 0;
    this._lastRewardTime = 0;
    this.winner = winnerPlayer;
    this.flagSprite.visible = false;
    
    // Zatrzymujemy animacje walki
    this.players.forEach(p => {
      const w = this.workerManager.getWorkerType(p.typeIndex);
      if (w && w.interactAction) w.interactAction.stop();
    });
    
    // Przegranego wyrzucamy na losowe wolne pole (lub sąsiednie)
    const loser = this.players.find(p => p.typeIndex !== winnerPlayer.typeIndex);
    if (loser) {
      const lw = this.workerManager.getWorkerType(loser.typeIndex);
      if (lw) {
         // Teleportujemy obok by go "wyrzucić" z pola chwały
         let kickX = this.tile.x + (Math.random() > 0.5 ? 1 : -1);
         let kickZ = this.tile.z + (Math.random() > 0.5 ? 1 : -1);
         if (kickX < -3) kickX = -2; if (kickX > 3) kickX = 2;
         if (kickZ < -3) kickZ = -2; if (kickZ > 3) kickZ = 2;
         if (kickX === 0 && kickZ === 0) kickX = 1; // Zabezpieczenie przed bankomatem
         
         lw.gridX = kickX;
         lw.gridZ = kickZ;
         lw.targetGridX = kickX;
         lw.targetGridZ = kickZ;
         lw.obj.position.set(kickX, 0, kickZ);
         lw.startPos.set(kickX, 0, kickZ);
         lw.targetPos.set(kickX, 0, kickZ);
      }
    }

    this.announce(`🎉 ${winnerPlayer.username} WYGRYWA! Przez 30 sekund dostaje 2 zł/s pasywnie, stojąc na polu chwały!`);
  }

  /**
   * Twarde przerwanie minigry, bo boss wlasnie stal sie aktywny (patrz
   * wywolanie w tick()). Boss atakuje TA SAMA siatke 7x7 - kafelek bitwy i
   * plotki kolidowalyby z tym wizualnie, a plotki mogłyby fizycznie
   * zablokowac graczom ucieczke z pola razenia (isTileLocked wplywa na ruch
   * po siatce) - dlatego to przerwanie, nie tylko wstrzymanie.
   *
   * W stanie REWARD zwyciezca ma juz OBIECANE 2 zl/s przez 30 s - zabranie
   * mu reszty byloby niesprawiedliwe, a zostawienie swiecacego kafelka na
   * cala walke z bossem przeczy "wylacz minigre". Rozwiazanie: wyplacamy
   * pozostale sekundy JEDNORAZOWO (zaokraglone w dol do pelnej sekundy - tyle,
   * ile faktycznie naliczylby tick() co sekunde) i sprzatamy wizualia.
   */
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
        `⚔️ Boss atakuje! Bitwa o flagi przerwana - ${this.winner.username} dostaje od razu resztę nagrody (+${wyplata} zł).`,
      );
    } else if (this.state === 'BATTLE' || this.state === 'WAITING') {
      this.announce('⚔️ Boss atakuje! Bitwa o flagi przerwana - pole zwolnione.');
    }

    // Zatrzymujemy ewentualne animacje walki uczestnikow (ten sam wzorzec co
    // w endBattle) - inaczej zostaliby zamrozeni w pozie ataku/gotowosci.
    this.players.forEach((p) => {
      const w = this.workerManager && this.workerManager.getWorkerType(p.typeIndex);
      if (w && w.interactAction) w.interactAction.stop();
    });

    // reset() sam sprzata kafelek, flage, plotki (natychmiast, bez animacji
    // chowania - polu ma zniknac od razu, nie za pol sekundy animacji) i
    // zeruje timer - kolejny cykl minigry zaczyna sie od zera dopiero, gdy
    // boss przestanie byc aktywny (patrz galaz IDLE w tick()).
    this.reset();
  }

  /**
   * Wysuwa/chowa 4 plotki (fence.glb) wokol kontestowanego pola. Cel
   * animacji (wysuniete/schowane) jest w pelni okreslony przez zsynchronizowany
   * stan (this.state/this.tile) - host i widz licza ten sam cel niezaleznie,
   * ta funkcja tylko plynnie do niego dochodzi klatka po klatce (jak lerp
   * pozycji pracownikow w workers.js), wiec obie karty pokazuja to samo bez
   * potrzeby przesylania animacji przez siec. Wolane co klatke z tick().
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
      // Minigra mogla zdazyc sie zresetowac (host/widz zmiana roli, koniec
      // bitwy) zanim model sie zaladowal - wtedy nie budujemy plotek w prozni.
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
      console.error('[flagi] Blad ladowania plotek pola bitwy:', err);
    } finally {
      this._plotkiWTrakcieBudowy = false;
    }
  }

  /**
   * Usuwa plotki ze sceny. NIE zwalnia (dispose) geometrii/materialu - to
   * zasob SZABLONU wspoldzielony przez wszystkie 4 klony i kazda kolejna
   * bitwa (loadForest('fence') cache'uje go raz na cala sesje, patrz
   * pobierzSzablonPlotki), a takze przez tlo miasta w city.js, ktore laduje
   * ten sam plik. Dispose tutaj skasowalby bufory GPU pod wszystkimi innymi
   * uzyciami tego samego modelu. "Sprzatanie" minigry oznacza wiec: usunac
   * WLASNE klony ze sceny i wyczyscic wlasna tablice (this.plotki) - to
   * wystarczy, zeby liczba obiektow w scenie/draw calls wracala do poziomu
   * wyjsciowego po kazdym cyklu bitwy, bez ryzyka zepsucia cudzych klonow.
   */
  _usunPlotki() {
    for (const obj of this.plotki) {
      this.scene.remove(obj);
    }
    this.plotki = [];
  }

  reset() {
    this.state = 'IDLE';
    this.timer = 0;
    this.tile = null;
    this.players = [];
    this.currentFlag = null;
    this._loadedFlag = null;
    this.winner = null;
    this.rewardTimer = 0;
    this._lastRewardTime = 0;
    // Zbior uzytych flag NIE moze przeciekac miedzy bitwami (patrz komentarz
    // w konstruktorze) - czyszczony tutaj tak samo jak przy starcie nowej
    // bitwy. battleId celowo NIE jest zerowany - rosnie monotonicznie przez
    // cala sesje, zeby zaden klucz strumienia nigdy nie powtorzyl sie miedzy
    // dwiema roznymi bitwami.
    this._uzyteFlagi.clear();
    this.highlightMesh.visible = false;
    this.flagSprite.visible = false;
    // Przywracamy pelna jaskrawosc znacznika - koncowka REWARD moglo ja
    // zgasic do 0 (patrz tick), inaczej NASTEPNA bitwa zaczelaby sie od
    // niewidocznego/przygaszonego pola.
    this.markerPierscien.material.opacity = 0.95;
    this.markerWypelnienie.material.opacity = 0.18;
    this._ostatniaSekundaDymka = null;
    // Plotki sprzatane od razu (bez animowanego chowania) - reset() bywa
    // wolany tez przy zmianie roli hosta (setHost), gdzie animowane
    // wygaszanie w kolejnych klatkach nie mialoby juz czego dokonczyc.
    this._usunPlotki();
  }

  /** Wycinek stanu wysylany widzom (patrz zbierzStan w main.js). Tylko host go czyta z realnego stanu - widz go dostaje. */
  getSyncState() {
    return {
      state: this.state,
      tile: this.tile,
      players: this.players,
      currentFlag: this.currentFlag,
      flagsGuessed: this.flagsGuessed,
      winner: this.winner,
      rewardTimer: this.rewardTimer,
      battleId: this.battleId, // patrz komentarz w konstruktorze i nextRound()
    };
  }

  /**
   * Wyrownuje lokalny (wizualny) stan minigry u widza do tego, co przyslal
   * host. Host tego nie woluje - sam prowadzi minigre naprawde (patrz tick/
   * onChatMessage powyzej), a to by ja nadpisalo wlasnym echem.
   */
  applySync(s) {
    if (this.isHost) return;
    if (!s || s.state === 'IDLE' || !s.tile) {
      if (this.state !== 'IDLE') this.reset();
      return;
    }

    const prevState = this.state;
    const prevPlayers = this.players;
    const prevFlagsGuessed = this.flagsGuessed;
    this.state = s.state;
    this.tile = s.tile;
    this.players = Array.isArray(s.players) ? s.players : [];
    this.flagsGuessed = s.flagsGuessed || 0;
    this.winner = s.winner || null;
    this.rewardTimer = s.rewardTimer || 0;
    this.battleId = s.battleId || 0;
    this.currentFlag = s.currentFlag || null;

    // Animacja walki - host ja odpala/zatrzymuje w checkPlayersEntry/endBattle,
    // tu odtwarzamy to samo po zmianie stanu (opoznienie jak przy kazdym innym
    // snapshocie, max ok. 2 s - patrz interwal wyslijSnapshot w main.js).
    if (this.state === 'BATTLE' && prevState !== 'BATTLE') {
      this.players.forEach((p) => {
        const w = this.workerManager && this.workerManager.getWorkerType(p.typeIndex);
        if (w && w.interactAction) w.interactAction.play();
      });
    } else if (prevState === 'BATTLE' && this.state !== 'BATTLE') {
      this.players.forEach((p) => {
        const w = this.workerManager && this.workerManager.getWorkerType(p.typeIndex);
        if (w && w.interactAction) w.interactAction.stop();
      });
    }

    // Cios za poprawna odpowiedz - u widza wykrywamy to po wzroscie
    // flagsGuessed (zsynchronizowana liczba) wzgledem poprzedniej wartosci, a
    // ktory gracz uderzyl wyliczamy porownujac wyniki graczy przed/po. Klip
    // wychodzi z TEJ SAMEJ deterministycznej funkcji co u hosta
    // (klipAtakuDlaRundy(flagsGuessed)) - bez tego widz nie mialby jak sie
    // dowiedziec, ktory dokladnie klip host odtworzyl, a przesylanie tego
    // osobnym zdarzeniem byloby zbedne, skoro flagsGuessed juz to jednoznacznie wyznacza.
    if (this.state === 'BATTLE' && this.flagsGuessed > prevFlagsGuessed) {
      const zwyciezcaRundy = this.players.find((p) => {
        const stary = prevPlayers.find((op) => op.typeIndex === p.typeIndex);
        return stary ? p.score > stary.score : p.score > 0;
      });
      if (zwyciezcaRundy) {
        const w = this.workerManager && this.workerManager.getWorkerType(zwyciezcaRundy.typeIndex);
        if (w) this.workerManager.triggerAttack(w, klipAtakuDlaRundy(this.flagsGuessed));
      }
    }

    this.highlightMesh.position.x = this.tile.x;
    this.highlightMesh.position.z = this.tile.z;
    this.highlightMesh.visible = true;
    this.flagSprite.position.set(this.tile.x, 2.5, this.tile.z);

    if (this.state === 'BATTLE' && this.currentFlag) {
      if (this.currentFlag !== this._loadedFlag) {
        this._loadedFlag = this.currentFlag;
        this._stosujTeksturaFlagi(this.currentFlag);
      }
    } else {
      // WAITING (jeszcze bez flagi) albo REWARD (flaga juz schowana u hosta).
      this.flagSprite.visible = false;
    }
  }

  announce(text) {
    // Proste użycie istniejącego UI
    const messagesEl = document.getElementById('kick-messages');
    if (messagesEl) {
      const div = document.createElement('div');
      div.className = 'chat-message';
      div.innerHTML = `<strong style="color: gold">[Bitwa o flagi]</strong> <span>${text}</span>`;
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    try {
      this.onAnnounce(text);
    } catch (err) {
      console.warn('[flagi] Blad w onAnnounce:', err);
    }
  }
}
