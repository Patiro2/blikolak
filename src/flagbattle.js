import * as THREE from 'three';
import { COUNTRIES, COUNTRY_CODES, tokenizujOdpowiedz, INDEKS_WARIANTOW, FLAGI_BLIZNIACZE } from './countries.js';
import { usunTagiEmotek } from './kick.js';
import { loadForest } from './assets.js';
import { strumien, losujInt, pozycjaBezPowtorek } from './rng.js';
import { Bojka } from './bojka.js';
import { arenaHalf } from './arena.js';


// Minimalny odstep miedzy polami minigier areny (odleglosc "krolem": max z |dx|,|dz|).
// 3 = miedzy dwoma polami minigier zostaja co najmniej 2 wolne pola, takze po skosie.
const MIN_ODSTEP_MINIGIER = 3;
function zaBliskoMinigry(x, z, tile) {
  return !!tile && Math.max(Math.abs(x - tile.x), Math.abs(z - tile.z)) < MIN_ODSTEP_MINIGIER;
}

// Nagroda za wygrana minigre: jednorazowa wyplata w momencie zakonczenia
// bitwy (endBattle), zamiast dawnych 2 zl/s przez 30 s w stanie REWARD.
const NAGRODA_WYGRANEJ = 100;

// Zrodlo flag: assets/flags-vector/<KOD>.svg pochodzi z pakietu flag-icons
// (github.com/lipis/flag-icons, MIT - patrz assets/flags-vector/LICENSE-flag-icons.txt),
// proporcja 4:3 (viewBox="0 0 640 480" w kazdym pliku), pelny kolor i
// szczegolowe herby (nie plaska stylizowana paleta jak w dawnym zestawie
// Kenney) - stad NIE MA juz tu podmiany kolorow na "nasycona palete": kolory
// zrodlowe sa juz wlasciwe, jedyna naprawa potrzebna do koloru pozostaje (1)
// nizej.
//
// 1) Zarzadzanie kolorem: renderer ma outputColorSpace = SRGBColorSpace i
//    ACESFilmicToneMapping (patrz src/scene.js) - tekstura bez
//    texture.colorSpace = SRGBColorSpace jest traktowana jako dane LINIOWE,
//    wiec kolory wychodza wyplowiale/przesuniete, a plaska grafika bez
//    material.toneMapped = false dodatkowo traci nasycenie przez tone
//    mapping pomyslany do oswietlonych scen 3D, nie plaskich ikon.
//
// Rozwiazanie: SVG (wektor, wiec dowolna rozdzielczosc) ladowany jako tekst;
// wiele plikow flag-icons NIE MA atrybutow width/height na <svg> (tylko
// viewBox) - Image zaladowany z takiego Bloba moze zrasteryzowac sie z
// zerowym/domyslnym rozmiarem w niektorych przegladarkach, wiec PRZED
// zbudowaniem Bloba wstrzykujemy jawne width/height dopasowane do viewBox
// (patrz zapewnijWymiarySvg nizej). Rasteryzacja przez Image+canvas w
// rozdzielczosci 4:3 (ROZMIAR_TEKSTURY_FLAGI_W x _H), z canvasu CanvasTexture
// z poprawnym colorSpace i anizotropia. Wynik cache'owany po kodzie kraju -
// flaga rasteryzuje sie raz na sesje, kazda kolejna runda z tym samym krajem
// dostaje ta sama tekstura z cache (zero nowych obiektow, zero wycieku).
const ROZMIAR_TEKSTURY_FLAGI_W = 512;
const ROZMIAR_TEKSTURY_FLAGI_H = 384; // 512x384 = 4:3, dopasowane do viewBox 640x480 kazdego pliku flag-icons

// Limit czasu na zgadniecie POJEDYNCZEJ flagi (nie calej bitwy - patrz
// zaktualizowany komentarz przy _sprawdzWyjscieAwaryjne nizej): 15 sekund,
// zeby flaga, ktorej nikt nie zna, nie zatrzymywala bitwy na dluzej. Liczony
// WYLACZNIE przez hosta w tick() (this.flagRoundTimer, zerowany w kazdym
// nextRound()). Po uplywie: host odslania nazwe kraju (_czasFlagiUplynal),
// po ODSLONIECIE_CZAS_S losuje kolejna flage. Stala latwa do zmiany na
// potrzeby recznych testow.
const LIMIT_CZASU_FLAGI_S = 15;
const ODSLONIECIE_CZAS_S = 3;

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

/**
 * Dopasowanie odpowiedzi z czatu do kraju: PO CALYCH SLOWACH, z rozstrzyganiem
 * konfliktow najdluzszym dopasowaniem - patrz zawieraSekwencje/najlepszyKodDlaOdpowiedzi.
 *
 * Historia tego kodu (dla przyszlych zmian): pierwsza wersja porownywala
 * "ans === expected || ans.includes(expected)" - zle lapala podciagi bez
 * spacji ("somalia" zawiera "mali", "nigeria" zawiera "niger"). Druga wersja
 * scinala "wypelniacze" ("to jest", "chyba") i porownywala CALY rdzen
 * odpowiedzi z CALYM wariantem - to naprawilo podciagi, ALE bylo zbyt kruche
 * na prawdziwym czacie: "polska xd", "Polska 🇵🇱", "polska!!! xD" nie mialy
 * szans trafic, bo nigdy nie da sie przewidziec kazdego dopisku widza.
 *
 * Ta wersja NIE wymaga, zeby caly rdzen byl rowny wariantowi - wystarczy, ze
 * WARIANT wystepuje w odpowiedzi jako CIAGLA sekwencja PELNYCH SLOW (stad
 * najpierw tokenizacja - patrz tokenizujOdpowiedz w countries.js, ktora
 * zamienia kazdy znak spoza [a-z0-9] na spacje, wiec emotki/interpunkcja
 * znikaja same, bez osobnej listy wypelniaczy). To samo zalatwia "somalia"
 * nie zawiera slowa "mali" (nie ma tam takiego tokenu), a przy dopisku "polska
 * xd" slowo "polska" nadal jest osobnym, pelnym tokenem.
 *
 * Pozostaje jednak przypadek, ktorego samo dopasowanie PELNYCH SLOW nie
 * rozwiazuje: "sudan poludniowy" zawiera slowo "sudan" w calosci - to
 * legalne dopasowanie do kraju Sudan, ale odpowiedz w rzeczywistosci opisuje
 * INNY kraj (Sudan Poludniowy), ktorego WLASNA nazwa tez tu pasuje i jest
 * DLUZSZA. Rozstrzygamy to bioracc pod uwage WSZYSTKIE dopasowania (wszystkich
 * krajow) w odpowiedzi i wybierajac NAJDLUZSZE (w slowach) - "sudan poludniowy"
 * (2 slowa, kraj Sudan Poludniowy) wygrywa z "sudan" (1 slowo, kraj Sudan).
 * Odpowiedz liczy sie tylko, gdy TEN dluzszy wynik nalezy do biezacej flagi,
 * i tylko gdy jest jednoznaczny (dwa rozne kraje z tą sama najwieksza
 * dlugoscia = remis = pudlo, np. "niemcy albo polska" - inaczej dalby sie
 * "strzelac" cala lista panstw na raz).
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

/**
 * Zwraca kod kraju, ktorego wariant jest NAJDLUZSZYM jednoznacznym
 * dopasowaniem w tokenach odpowiedzi, albo null (brak dopasowania lub remis
 * miedzy dwoma roznymi krajami tej samej dlugosci). Przechodzi caly
 * INDEKS_WARIANTOW (zbudowany RAZ przy ladowaniu modulu countries.js, nie
 * tutaj) - przy ~150 krajach i garstce slow na wiadomosc to tania petla,
 * wywolywana tylko dla wiadomosci graczy aktualnie w bitwie.
 */
function najlepszyKodDlaOdpowiedzi(tokeny) {
  let najlepszaDlugosc = 0;
  let kodyNajlepsze = null;
  for (const { kod, slowa } of INDEKS_WARIANTOW) {
    if (slowa.length < najlepszaDlugosc) continue;
    if (!zawieraSekwencje(tokeny, slowa)) continue;
    if (slowa.length > najlepszaDlugosc) {
      najlepszaDlugosc = slowa.length;
      kodyNajlepsze = new Set([kod]);
    } else {
      kodyNajlepsze.add(kod);
    }
  }
  if (!kodyNajlepsze || kodyNajlepsze.size !== 1) return null;
  return [...kodyNajlepsze][0];
}

// kod kraju -> Promise<THREE.CanvasTexture>. Modul jest singletonem na karte
// (ES modules), wiec ten cache dziala "raz na sesje" nawet gdyby kiedys
// powstala wiecej niz jedna instancja FlagBattleManager na tej samej karcie.
const cacheTeksturFlag = new Map();

// Wiele plikow flag-icons ma na <svg> WYLACZNIE viewBox (bez width/height) -
// Image zaladowany z takiego pliku (przez Blob URL) moze w niektorych
// przegladarkach zrasteryzowac sie z domyslnym/zerowym rozmiarem zamiast
// odziedziczyc proporcje z viewBox. Zeby tego uniknac, wstrzykujemy jawne
// width/height w atrybuty <svg> PRZED zbudowaniem Bloba - jesli juz sa,
// zostawiamy je bez zmian.
function zapewnijWymiarySvg(svgText) {
  const ma = /<svg\b[^>]*\bwidth\s*=/i.test(svgText);
  if (ma) return svgText;
  return svgText.replace(
    /<svg\b/i,
    `<svg width="${ROZMIAR_TEKSTURY_FLAGI_W}" height="${ROZMIAR_TEKSTURY_FLAGI_H}"`,
  );
}

/**
 * Pobiera SVG flagi (assets/flags-vector/<KOD>.svg, pakiet flag-icons),
 * rasteryzuje do canvasu w proporcji 4:3 i zwraca CanvasTexture z poprawnym
 * colorSpace/anizotropia. Wynik cache'owany po kodzie kraju - druga i kolejne
 * prosby o te sama flage dostaja gotowa tekstura z cache, bez ponownego
 * pobierania/rasteryzacji.
 */
function zaladujTeksturaFlagi(kod, renderer) {
  if (cacheTeksturFlag.has(kod)) return cacheTeksturFlag.get(kod);

  const promise = (async () => {
    const canvas = document.createElement('canvas');
    canvas.width = ROZMIAR_TEKSTURY_FLAGI_W;
    canvas.height = ROZMIAR_TEKSTURY_FLAGI_H;
    const ctx = canvas.getContext('2d');

    const resp = await fetch(`assets/flags-vector/${kod}.svg`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} przy pobieraniu assets/flags-vector/${kod}.svg`);
    const svgTextOryginalny = await resp.text();
    const svgText = zapewnijWymiarySvg(svgTextOryginalny);

    const blob = new Blob([svgText], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error(`Blad rasteryzacji SVG flagi ${kod}`));
        im.src = url;
      });
      ctx.drawImage(img, 0, 0, ROZMIAR_TEKSTURY_FLAGI_W, ROZMIAR_TEKSTURY_FLAGI_H);
    } finally {
      URL.revokeObjectURL(url);
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

/**
 * Rysuje kilka wierszy tekstu na canvasie i zwraca CanvasTexture - uzywane do
 * komunikatu "czas minal" w miejscu flagi (patrz _pokazOdslonietaFlage) oraz
 * do kartki ze zwyciezca bitwy (patrz _pokazZwyciezce). W odroznieniu od
 * zaladujTeksturaFlagi NIE cache'ujemy wyniku po kluczu - to rzadkie
 * zdarzenie, rysowanie canvasu tej wielkosci jest tanie.
 *
 * Dopasowanie fontu: nick zwyciezcy w drugiej linii bywa dlugi i moglby
 * wyjsc poza kartke - kazda linia dostaje WLASNY rozmiar fontu, zmierzony
 * przez ctx.measureText i zmniejszany o 2px, dopoki tekst nie zmiesci sie w
 * szerokosci kartki (z marginesem 20px z kazdej strony) albo nie osiagnie
 * minimalnego czytelnego rozmiaru (18px) - ponizej tego progu wolimy tekst
 * i tak lekko przycięty przez przegladarke niz nieczytelna miniature.
 */
function renderujTekstNaCanvasie(linie) {
  const canvas = document.createElement('canvas');
  canvas.width = ROZMIAR_TEKSTURY_FLAGI_W;
  canvas.height = ROZMIAR_TEKSTURY_FLAGI_H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(20, 20, 20, 0.85)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#ffd700';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const odstep = 52;
  const maxSzerokosc = canvas.width - 40;
  const minRozmiarFontu = 18;
  const startY = canvas.height / 2 - ((linie.length - 1) * odstep) / 2;
  linie.forEach((linia, i) => {
    let rozmiarFontu = 40;
    ctx.font = `bold ${rozmiarFontu}px sans-serif`;
    while (rozmiarFontu > minRozmiarFontu && ctx.measureText(linia).width > maxSzerokosc) {
      rozmiarFontu -= 2;
      ctx.font = `bold ${rozmiarFontu}px sans-serif`;
    }
    ctx.fillText(linia, canvas.width / 2, startY + i * odstep);
  });

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
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

    // Limit czasu pojedynczej flagi (patrz LIMIT_CZASU_FLAGI_S) - liczony
    // WYLACZNIE przez hosta w tick(), zerowany w kazdym nextRound(). Widz go
    // nie liczy sam (patrz applySync) - dostaje juz gotowy wynik.
    this.flagRoundTimer = 0;
    // Kod kraju pokazywany w miejscu flagi po uplywie limitu czasu, albo null
    // gdy pokazujemy normalnie flage/nic. Synchronizowany (getSyncState/applySync).
    this.odslonietaFlaga = null;
    this._loadedOdsloniecie = null; // ostatni odslonietaFlaga narysowany na revealSprite (widz) - jak _loadedFlag wyzej

    // idBitwy - patrz nextRound(). Synchronizowany (getSyncState/applySync),
    // NIE lokalny licznik karty - inkrementowany WYLACZNIE przez hosta w
    // spawnBattleSquare(), wiec kazda karta (i ewentualny nowy host po
    // przejeciu roli w locie) widzi ta sama wartosc dla tej samej bitwy.
    this.battleId = 0;

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
    // powinien jej przygaszac/przesuwac kolorow (patrz komentarz nad ROZMIAR_TEKSTURY_FLAGI_W).
    this.flagMaterial = new THREE.SpriteMaterial({ color: 0xffffff, toneMapped: false });
    this.flagSprite = new THREE.Sprite(this.flagMaterial);
    this.flagSprite.scale.set(1.4, 1.05, 1.0); // proporcja 4:3 (flagi flag-icons, viewBox 640x480)
    this.flagSprite.position.y = 3.0; // Nad polem
    this.flagSprite.visible = false;
    this.scene.add(this.flagSprite);

    // Sprite tekstowy pokazujacy odslonieta nazwe kraju po uplywie
    // LIMIT_CZASU_FLAGI_S, w tym samym miejscu co flagSprite (pozycja
    // aktualizowana razem z nim w spawnBattleSquare/applySync). Nigdy nie sa
    // widoczne oba naraz (patrz _pokazOdslonietaFlage/_ukryjOdslonietaFlage).
    this.revealMaterial = new THREE.SpriteMaterial({ color: 0xffffff, toneMapped: false });
    this.revealSprite = new THREE.Sprite(this.revealMaterial);
    this.revealSprite.scale.set(1.4, 1.05, 1.0);
    this.revealSprite.position.y = 3.0;
    this.revealSprite.visible = false;
    this.scene.add(this.revealSprite);

    // Tekstura kartki ze zwyciezca (patrz _pokazZwyciezce) - jednorazowa,
    // NIE cache'owana po kluczu (nick jest unikalny per bitwa), wiec trzeba
    // ja jawnie dispose'owac przy kazdej podmianie/sprzataniu (patrz reset()).
    this._winnerTexture = null;

    this._flagReqId = 0; // chroni przed wyscigiem, gdy runda zmieni sie zanim async rasteryzacja skonczy
    this.isHost = false; // wlasciwa wartosc przychodzi z setContext/setHost - patrz nizej

    // Bijatyka + chmura kurzu (patrz src/bojka.js) - jedna wspoldzielona
    // instancja na cale zycie tej minigry, wlaczana/wylaczana per bitwa.
    this.bojka = new Bojka(this.scene);
  }

  setContext({ workerManager, kickChat, economy, isHost, boss, tlumaczenia, panstwaMiasta, bitwaMarek }) {
    this.workerManager = workerManager;
    this.kickChat = kickChat;
    this.economy = economy;
    this.boss = boss || null; // patrz _przerwijPrzezBossa i isTileLocked nizej
    // Referencja do minigry "Tlumaczenia" - WYLACZNIE do odczytu jej biezacego
    // kafelka (tlumaczenia.tile), zeby losowanie pola bitwy o flagi nigdy nie
    // trafilo w kafelek zajety przez tamta minigre (patrz spawnBattleSquare
    // nizej). Ten sam kontrakt co flagBattleRef w tlumaczenia.js/setContext,
    // tylko w odwrotna strone.
    this.tlumaczeniaRef = tlumaczenia || null;
    // Ten sam kontrakt (WYLACZNIE odczyt .tile), dla minigry "Panstwa-Miasta" -
    // patrz analogiczny komentarz w panstwa-miasta.js/setContext.
    this.panstwaMiastaRef = panstwaMiasta || null;
    // Ten sam kontrakt (WYLACZNIE odczyt .tile), dla minigry "Zgadnij marke" -
    // patrz analogiczny komentarz w bitwa-marek.js/setContext.
    this.bitwaMarekRef = bitwaMarek || null;
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
    
    // REWARD: pole nie jest juz oznaczone (patrz endBattle/reset - znaczniki
    // gasna natychmiast po wygranej), wiec blokowanie go dla postronnych
    // bylby niezrozumiale dla widzow (niewidoczna sciana). Ruch jest juz i tak
    // swobodny - zwyciezca stoi tam z wlasnej woli, nikt inny nie ma powodu
    // tam wchodzic.

    return false;
  }

  /**
   * Blokada RUCHU DLA DWOJGA WALCZACYCH w trakcie BATTLE (zadanie: "gdy
   * bitwa trwa, obaj nie moga sie ruszyc, dopoki ktorys nie wygra") - w
   * odroznieniu od isTileLocked() powyzej, ktora chroni pole PRZED WEJSCIEM
   * OBCYCH, ale nie trzyma samych walczacych. Woluje ja moveWorker() w
   * workers.js PRZED policzeniem docelowego pola, wiec blokuje KAZDY krok
   * (w tym obrot w miejscu) - decyzja projektowa: dwaj gracze stoja juz
   * naprzeciw siebie (patrz checkPlayersEntry) i sa w trakcie walki, wiec
   * kreca sie w miejscu na komende ruchu wygladaloby dziwniej niz calkowity
   * bezruch do konca starcia.
   *
   * Zwraca false (odblokowane), gdy boss jest aktywny - dokladnie ta sama
   * gwarancja co w isTileLocked, tym samym mechanizmem: gracz nigdy nie moze
   * utknac zablokowany, gdy plansza jest pod ostrzalem bossa (_przerwijPrzezBossa
   * i tak zaraz przerwie bitwe, ale ruch ma wrocic natychmiast, nie dopiero
   * po nastepnym ticku hosta).
   */
  isPlayerLocked(typeIndex) {
    if (this.boss && this.boss.isActive()) return false;
    if (this.state !== 'BATTLE') return false;
    return this.players.some((p) => p.typeIndex === typeIndex);
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

      // Dymek "+100 zl" nad zwyciezca - TYLKO RAZ, przy wejsciu w REWARD (nie
      // co sekunde jak dawniej przy pasywnym dochodzie 2 zl/s - kasa jest juz
      // wyplacona jednorazowo w endBattle, wiec dymek jest jej jedynym,
      // jednorazowym potwierdzeniem). _ostatniaSekundaDymka === null pilnuje
      // jednorazowosci - ustawiany na cokolwiek innego nizej i zerowany w reset().
      if (this.winner && this._ostatniaSekundaDymka === null) {
        this._ostatniaSekundaDymka = Math.floor(Date.now() / 1000);
        try {
          this.onRewardTick(this.winner);
        } catch (err) {
          console.warn('[flagi] Blad w onRewardTick:', err);
        }
      }
    }

    this._aktualizujPlotki(dt);

    // Bijatyka + chmura kurzu: czysto kosmetyczna animacja lokalna (jak
    // pulsowanie koloru markera wyzej) - dziala tak samo u hosta i u
    // widza, bo oba wywoluja ja co klatke niezaleznie od isHost, a jedyny
    // "przelacznik" (bojka.active) jest ustawiany w checkPlayersEntry/
    // endBattle/_przerwijPrzezBossa/reset/applySync - wszystkie te miejsca
    // sa juz w pelni wyprowadzone ze zsynchronizowanego stanu (state/tile/
    // players), wiec nie potrzeba tu zadnego nowego zdarzenia sieciowego.
    this.bojka.update(dt, this.workerManager);

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
    else if (this.state === 'BATTLE') {
      if (this.currentFlag) {
        this.flagRoundTimer += dt;
        if (this.flagRoundTimer >= LIMIT_CZASU_FLAGI_S) {
          this._czasFlagiUplynal();
        }
      }
      this._sprawdzWyjscieAwaryjne();
    }
    else if (this.state === 'REWARD') {
      // Kasa (NAGRODA_WYGRANEJ) jest juz wyplacona jednorazowo w endBattle -
      // ten blok REWARD trwa nadal 30 s, ale wylacznie dla wizualiow
      // (gasnace pole, plotki, kartka zwyciezcy, blokady) - patrz komentarz
      // przy NAGRODA_WYGRANEJ.
      this.rewardTimer += dt;

      if (this.rewardTimer >= 30) {
        this.reset();
      }
    }
  }

  // Ograniczenie prob przy losowaniu pola (siatka 7x7, kolizje z bankomatem/
  // minigra tlumaczen) - petla NIE MOZE zostac nieograniczona. Losowanie
  // flagi ponizej (nextRound()) juz tego wzorca nie uzywa - permutacja calej
  // puli (tasuj()) nie potrzebuje petli prob w ogole.
  static MAX_PROB_LOSOWANIA_POLA = 50;

  spawnBattleSquare() {
    this.battleId += 1;

    // NAPRAWA: pole bylo losowane golym Math.random() - poza wspolnym
    // strumieniem, na ktorym stoi cala synchronizacja tej gry (patrz rng.js).
    // Klucz zawiera licznikFlag (trwaly, rosnie z kazda runda flag - patrz
    // nextRound) ORAZ battleId, wiec kolejna bitwa dostaje inne pole rowniez
    // po przeladowaniu strony (samego battleId po przeladowaniu nie mozna
    // uznac za unikalny - patrz komentarz przy licznikFlag w economy.js).
    // Wykluczamy (0,0) (bankomat) i kafelek aktualnie zajety przez minigre
    // tlumaczen (this.tlumaczeniaRef.tile, patrz setContext) - dwie minigry
    // nigdy nie moga stanac na tym samym polu. Kolejne proby przy kolizji
    // ciagna z TEGO SAMEGO strumienia (kolejne wywolanie rng(), nie nowy
    // klucz), ograniczone do MAX_PROB_LOSOWANIA_POLA.
    const kluczPola = `${this.economy.state.seedGry}:flaga-pole:${this.economy.state.licznikFlag}:${this.battleId}`;
    const rngPola = strumien(kluczPola);
    const zajeteTlumaczenia = this.tlumaczeniaRef && this.tlumaczeniaRef.tile ? this.tlumaczeniaRef.tile : null;
    // Kolizja z minigra "Panstwa-Miasta" - ten sam wzorzec co zajeteTlumaczenia powyzej.
    const zajetePanstwaMiasta = this.panstwaMiastaRef && this.panstwaMiastaRef.tile ? this.panstwaMiastaRef.tile : null;
    // Kolizja z minigra "Zgadnij marke" - ten sam wzorzec co zajeteTlumaczenia powyzej.
    const zajeteMarki = this.bitwaMarekRef && this.bitwaMarekRef.tile ? this.bitwaMarekRef.tile : null;

    const half = arenaHalf(this.economy); // rozmiar CZYTANY W MOMENCIE UZYCIA - patrz arena.js
    let rx = null;
    let rz = null;
    for (let proba = 0; proba < FlagBattleManager.MAX_PROB_LOSOWANIA_POLA; proba++) {
      const kx = losujInt(rngPola, -half, half);
      const kz = losujInt(rngPola, -half, half);
      if (kx === 0 && kz === 0) continue; // bankomat
      if (zaBliskoMinigry(kx, kz, zajeteTlumaczenia)) continue; // pole tlumaczen
      if (zaBliskoMinigry(kx, kz, zajetePanstwaMiasta)) continue; // pole panstw-miast
      if (zaBliskoMinigry(kx, kz, zajeteMarki)) continue; // pole marek
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
          if (zaBliskoMinigry(x, z, zajeteTlumaczenia)) continue;
          if (zaBliskoMinigry(x, z, zajetePanstwaMiasta)) continue;
          if (zaBliskoMinigry(x, z, zajeteMarki)) continue;
          rx = x;
          rz = z;
          break szukanie;
        }
      }
    }
    if (rx === null) {
      // Doslownie kazde pole zajete - nie powinno sie zdarzyc. Rezygnujemy z
      // tej proby spawnu, host sprobuje ponownie przy nastepnym pelnym cyklu timera.
      console.warn('[flagi] Brak wolnego pola na siatce - pomijam spawn tej rundy.');
      this.battleId -= 1;
      return;
    }

    this.tile = { x: rx, z: rz };
    this.state = 'WAITING';
    this.timer = 0;

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

      // Obracamy ich twarzą do siebie
      const angleP1 = Math.atan2(p2.obj.position.x - p1.obj.position.x, p2.obj.position.z - p1.obj.position.z);
      p1.targetRotY = angleP1;
      p1.facingAngle = angleP1;
      p2.targetRotY = angleP1 + Math.PI;
      p2.facingAngle = angleP1 + Math.PI;
      
      // Animacja bijatyki (ciosy + chmura kurzu) - patrz src/bojka.js. Seed
      // zawiera battleId (juz zsynchronizowany), zeby rytm byl powtarzalny w
      // obrebie tej bitwy.
      this.bojka.start(this.tile, this.players, `${this.economy.state.seedGry}:flaga-bojka:${this.battleId}`);

      this.nextRound();
      this.announce(`Bitwa o flagi! ${p1User} vs ${p2User}! Wpisuj nazwę państwa na czacie! Kto pierwszy zdobędzie 5 pkt wygrywa!`);
    }
  }
  
  /**
   * Wyjscie awaryjne: jesli ktorykolwiek z dwoch walczacych straci awatar W
   * TRAKCIE bitwy (wypadnie z Top 10 -> usuniety z workerManager.entries,
   * zostanie wyeliminowany z panelu -> to samo, albo omdleje od ataku bossa
   * -> entry.isFainted), isPlayerLocked() trzymalby DRUGIEGO gracza
   * zablokowanego na polu w nieskonczonosc (przeciwnik, ktorego czeka, juz
   * nigdy nie odpowie). Wywolywane co tick hosta w stanie BATTLE (patrz
   * tick()) - host wykrywa zagniecie i orzeka walkower: ocalaly gracz
   * dostaje wygrana (te sama nagrode i sciezke co zwykle zwyciestwo w
   * endBattle - to jednak jego zasluga, ze przetrwal). Jesli obaj strace
   * awatar naraz (np. oboje trafieni tym samym atakiem bossa - choc to i tak
   * nie powinno sie zdarzyc, bo _przerwijPrzezBossa przerywa bitwe wczesniej
   * w tym samym ticku), po prostu resetujemy bez zwyciezcy zamiast
   * przyznawac wygrana nikomu.
   *
   * Celowo BEZ limitu czasu calej bitwy - to nie jest sposob na wymuszenie
   * konca starcia, tylko obsluga wyjatkowego zdarzenia (zniknal jeden z
   * uczestnikow). Limit czasu ISTNIEJE, ale per POJEDYNCZA flage, osobno
   * (patrz LIMIT_CZASU_FLAGI_S i _czasFlagiUplynal, wolane obok tej metody w tick()).
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
      // Obaj strace awatar w tym samym ticku - nikt nie wygrywa, pole wraca do IDLE.
      this.announce('Obaj walczacy tracą awatara w trakcie bitwy - bitwa o flagi anulowana.');
      this.reset();
    }
  }

  nextRound() {
    if (this.state !== 'BATTLE') return;
    this.flagRoundTimer = 0; // nowa flaga = nowy limit czasu (patrz LIMIT_CZASU_FLAGI_S w tick())

    // Bez powtorek, dopoki nie zostanie wylosowana CALA pula flag w tej
    // ROZGRYWCE (nie tylko w tej bitwie) - patrz pozycjaBezPowtorek w rng.js
    // i licznikFlag w economy.js (trwaly, zapisywany licznik). Wolane
    // WYLACZNIE przez hosta (nextRound woluja tylko checkPlayersEntry i
    // onChatMessage, oba za straza isHost), wiec tylko host inkrementuje.
    this.currentFlag = pozycjaBezPowtorek(
      this.economy.state.seedGry,
      'flagi',
      COUNTRY_CODES,
      this.economy.state.licznikFlag,
    );
    this.economy.state.licznikFlag += 1;
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

  /**
   * Pokazuje komunikat "czas minal" w miejscu flagi (revealSprite), chowajac
   * flagSprite. Wolane zarowno przez hosta (_czasFlagiUplynal) jak i widza
   * (applySync, echo decyzji hosta) - stad wspolna metoda, jak _stosujTeksturaFlagi.
   */
  _pokazOdslonietaFlage(kod) {
    const nazwa = COUNTRIES[kod] || kod;
    const grupaBliznieakow = FLAGI_BLIZNIACZE.find((grupa) => grupa.includes(kod));
    const dopisekBliznika = grupaBliznieakow
      ? ` (${grupaBliznieakow.filter((k) => k !== kod).map((k) => COUNTRIES[k]).join(', ')})`
      : '';
    const texture = renderujTekstNaCanvasie(['⏰ Czas minął! To była:', `${nazwa}${dopisekBliznika}`]);
    this.revealMaterial.map = texture;
    this.revealMaterial.needsUpdate = true;
    this.revealSprite.position.set(this.flagSprite.position.x, this.flagSprite.position.y, this.flagSprite.position.z);
    this.revealSprite.visible = true;
    this.flagSprite.visible = false;
  }

  _ukryjOdslonietaFlage() {
    this.revealSprite.visible = false;
  }

  /**
   * Podmienia teksture GLOWNEJ kartki (flagSprite/flagMaterial) na kartke ze
   * zwyciezca bitwy - kartka zostaje widoczna przez caly stan REWARD (w
   * odroznieniu od dawnego zachowania, gdzie po prostu znikala), dzieki czemu
   * zwyciezca jest widoczny dokladnie tam, gdzie w trakcie gry pokazywala sie
   * flaga (ten sam sprawdzony pas kadru kamery). Wolane zarowno przez hosta
   * (endBattle) jak i widza (applySync, strażnik wejscia w REWARD) - stad
   * wspolna metoda, jak _stosujTeksturaFlagi/_pokazOdslonietaFlage.
   *
   * revealSprite chowamy jawnie - w BATTLE moze byc akurat widoczny
   * ("czas minal" po ostatniej fladze przed zwycieska odpowiedzia), a obie
   * kartki nie moga nachodzic sie na siebie.
   */
  _pokazZwyciezce(winnerPlayer) {
    this._flagReqId += 1; // spozniona tekstura flagi nie nadpisze kartki zwyciezcy
    if (this._winnerTexture) this._winnerTexture.dispose();
    this._winnerTexture = renderujTekstNaCanvasie(['🎉 WYGRYWA', winnerPlayer.username]);
    this.flagMaterial.map = this._winnerTexture;
    this.flagMaterial.needsUpdate = true;
    this.flagSprite.visible = true;
    // Kartka zwyciezcy tylko przez 2 s (nagroda 30 s trwa dalej bez niej).
    const idBitwy = this.battleId;
    setTimeout(() => {
      if (this.battleId === idBitwy && this.state === 'REWARD') this.flagSprite.visible = false;
    }, 2000);
    this._ukryjOdslonietaFlage();
  }

  /**
   * Wolane WYLACZNIE przez hosta z tick() (patrz LIMIT_CZASU_FLAGI_S), gdy
   * biezaca flaga nie zostala odgadnieta w limicie czasu. Blokuje spoznione
   * trafienie (currentFlag = null - onChatMessage juz nic z tym nie zrobi),
   * pokazuje nazwe kraju w miejscu flagi i po ODSLONIECIE_CZAS_S losuje
   * kolejna runde. mojeBattleId chroni przed wyscigiem: jesli bitwa sie w
   * miedzyczasie skonczy/zmieni (koniec BATTLE, reset, przerwanie przez
   * bossa, walkower), setTimeout nie odpali juz nextRound() po fakcie -
   * ten sam wzorzec co battleId w spawnBattleSquare/reszcie pliku.
   */
  _czasFlagiUplynal() {
    const kod = this.currentFlag;
    this.currentFlag = null;
    this.odslonietaFlaga = kod;
    this.flagRoundTimer = 0;
    this._pokazOdslonietaFlage(kod);

    const nazwa = COUNTRIES[kod] || kod;
    this.announce(`⏰ Czas minął! To była: ${nazwa}`);

    const mojeBattleId = this.battleId;
    setTimeout(() => {
      if (this.state !== 'BATTLE' || this.battleId !== mojeBattleId) return;
      this.odslonietaFlaga = null;
      this._ukryjOdslonietaFlage();
      this.nextRound();
    }, ODSLONIECIE_CZAS_S * 1000);
  }

  onChatMessage(username, content) {
    // Ocena odpowiedzi to decyzja - tylko host jej dokonuje (patrz komentarz
    // przy isHost w setContext). Widz i tak dostanie wynik przez applySync.
    if (!this.isHost) return;
    if (this.state !== 'BATTLE' || !this.currentFlag) return;
    
    const player = this.players.find(p => p.username.toLowerCase() === username.toLowerCase());
    if (!player) return; // Tylko gracze na polu mogą odpowiadać
    
    const tokeny = tokenizujOdpowiedz(usunTagiEmotek(content));
    const dopasowanyKod = najlepszyKodDlaOdpowiedzi(tokeny);

    // Flagi z FLAGI_BLIZNIACZE (patrz countries.js) sa nie do odroznienia na
    // rasteryzowanym sprite - odpowiedz na "bliznika" tez sie liczy.
    const grupaBliznieakow = FLAGI_BLIZNIACZE.find((grupa) => grupa.includes(this.currentFlag));
    const trafienie = dopasowanyKod === this.currentFlag
      || (dopasowanyKod && grupaBliznieakow && grupaBliznieakow.includes(dopasowanyKod));

    if (trafienie) {
      player.score += 1;
      this.flagsGuessed += 1;
      const properName = COUNTRIES[this.currentFlag];
      const dopisekBliznika = dopasowanyKod !== this.currentFlag
        ? ` (albo ${COUNTRIES[dopasowanyKod]} - flagi wygladaja identycznie)`
        : '';
      this.currentFlag = null; // blokada by nie nabić 2x na 1 wiadomości

      // Animacja ciosu za poprawna odpowiedz - klip wybrany deterministycznie
      // z flagsGuessed (patrz klipAtakuDlaRundy), zeby widz policzyl DOKLADNIE
      // to samo z synchronizowanego flagsGuessed w applySync, bez potrzeby
      // osobnego zdarzenia realtime.
      const workerEntry = this.workerManager && this.workerManager.getWorkerType(player.typeIndex);
      if (workerEntry) {
        this.workerManager.triggerAttack(workerEntry, klipAtakuDlaRundy(this.flagsGuessed));
      }

      this.announce(`${username} zgaduje poprawnie: ${properName}!${dopisekBliznika} (Punkty: ${player.score})`);

      if (player.score >= 5) { // bo9 - pierwszy do 5 flag
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
    this.odslonietaFlaga = null;
    this._loadedOdsloniecie = null;

    // Nagroda: jednorazowa wyplata NAGRODA_WYGRANEJ w momencie zakonczenia
    // bitwy (host - endBattle jest wolane wylacznie z kodu za straza isHost,
    // patrz checkPlayersEntry/onChatMessage/_sprawdzWyjscieAwaryjne, wiec ta
    // sama bramka co dawne naliczanie 2 zl/s pilnuje jednorazowosci u widza).
    this.economy.addMoney(NAGRODA_WYGRANEJ);
    if (winnerPlayer.username) {
      this.kickChat.recordEarned(winnerPlayer.username, NAGRODA_WYGRANEJ);
    }

    // Kartka flagi zostaje na scenie, ale z podmieniona tekstura zwyciezcy
    // (patrz _pokazZwyciezce) - zadanie: zwyciezca ma byc widoczny w tym
    // samym miejscu co flaga w trakcie gry, nie chowany.
    this._pokazZwyciezce(winnerPlayer);
    // Gwiazdka za wygrana minigre (ranking + plakietka) - patrz kick.js.
    if (this.kickChat) this.kickChat.zapiszWygranaMinigry(winnerPlayer.username);

    // Zadanie: oznaczenie pola (pierscien, wypelnienie, podswiecenie i
    // plotki) ma zniknac CALKOWICIE w chwili wygranej, nie dopiero po 30 s
    // REWARD - nagroda (2 zl/s) i tak nie zalezy od pozycji (patrz tick()
    // galaz REWARD), wiec nic wizualnego nie musi juz oznaczac pola.
    // _usunPlotki() usuwa je od razu (bez animowanego chowania - to samo
    // wzorzec co reset()/_przerwijPrzezBossa), highlightMesh.visible=false
    // gasi pierscien+wypelnienie w jednym kroku (to Group, patrz konstruktor).
    this.highlightMesh.visible = false;
    this._usunPlotki();

    // Zatrzymujemy bijatyke (chowa chmure, odstawia obu na srodek kafla)
    this.bojka.stop(this.workerManager);

    // Przegranego wyrzucamy na losowe wolne pole (lub sąsiednie)
    const loser = this.players.find(p => p.typeIndex !== winnerPlayer.typeIndex);
    if (loser) {
      const lw = this.workerManager.getWorkerType(loser.typeIndex);
      if (lw) {
         // Teleportujemy obok by go "wyrzucić" z pola chwały
         const kickHalf = arenaHalf(this.economy);
         let kickX = this.tile.x + (Math.random() > 0.5 ? 1 : -1);
         let kickZ = this.tile.z + (Math.random() > 0.5 ? 1 : -1);
         if (kickX < -kickHalf) kickX = -kickHalf + 1; if (kickX > kickHalf) kickX = kickHalf - 1;
         if (kickZ < -kickHalf) kickZ = -kickHalf + 1; if (kickZ > kickHalf) kickZ = kickHalf - 1;
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

    this.announce(`🎉 ${winnerPlayer.username} WYGRYWA! Dostaje ${NAGRODA_WYGRANEJ} zł!`);
  }

  /**
   * Twarde przerwanie minigry, bo boss wlasnie stal sie aktywny (patrz
   * wywolanie w tick()). Boss atakuje TA SAMA siatke 7x7 - kafelek bitwy i
   * plotki kolidowalyby z tym wizualnie, a plotki mogłyby fizycznie
   * zablokowac graczom ucieczke z pola razenia (isTileLocked wplywa na ruch
   * po siatce) - dlatego to przerwanie, nie tylko wstrzymanie.
   *
   * Nagroda (NAGRODA_WYGRANEJ) jest juz wyplacona w calosci w endBattle -
   * przerwanie w trakcie REWARD nie musi juz nic doplacac, sprzata tylko
   * wizualia (kafelek, plotki, bijatyke).
   */
  _przerwijPrzezBossa() {
    if (this.state === 'REWARD' && this.winner) {
      this.announce(`⚔️ Boss atakuje! Bitwa o flagi przerwana - koniec swietowania dla ${this.winner.username}.`);
    } else if (this.state === 'BATTLE' || this.state === 'WAITING') {
      this.announce('⚔️ Boss atakuje! Bitwa o flagi przerwana - pole zwolnione.');
    }

    // Zatrzymujemy bijatyke (ten sam wzorzec co w endBattle) - inaczej
    // walczacy zostaliby zamrozeni odsunieci od srodka pola / w trakcie ciosu.
    this.bojka.stop(this.workerManager);

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
    // Zabezpieczenie: reset() bywa wolany z kilku miejsc (setHost, koniec
    // REWARD, _sprawdzWyjscieAwaryjne gdy OBAJ walczacy znikna naraz) - nie
    // wszystkie z nich przechodza przez endBattle/_przerwijPrzezBossa, ktore
    // juz jawnie zatrzymuja bojke, wiec robimy to tez tutaj (no-op, gdy bojka
    // juz nieaktywna).
    if (this.bojka) this.bojka.stop(this.workerManager);
    this.state = 'IDLE';
    this.timer = 0;
    this.tile = null;
    this.players = [];
    this.currentFlag = null;
    this._loadedFlag = null;
    this.flagRoundTimer = 0;
    this.odslonietaFlaga = null;
    this._loadedOdsloniecie = null;
    this._ukryjOdslonietaFlage();
    this.winner = null;
    this.rewardTimer = 0;
    this._lastRewardTime = 0;
    // battleId celowo NIE jest zerowany - rosnie monotonicznie przez cala
    // sesje, zeby zaden klucz strumienia (pole bitwy, bojka) nigdy nie
    // powtorzyl sie miedzy dwiema roznymi bitwami.
    this.highlightMesh.visible = false;
    this.flagSprite.visible = false;
    // Kartka ze zwyciezca (patrz _pokazZwyciezce) znika razem z reszta
    // planszy - tekstura jest jednorazowa (NIE z cacheTeksturFlag), wiec
    // dispose'ujemy ja tutaj; sam flagMaterial zostaje (wspoldzielony,
    // kolejna bitwa nadpisze jego .map nowa flaga/kartka).
    if (this._winnerTexture) {
      this._winnerTexture.dispose();
      this._winnerTexture = null;
    }
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
      odslonietaFlaga: this.odslonietaFlaga,
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
    this.odslonietaFlaga = s.odslonietaFlaga || null;

    // Animacja walki - host ja odpala/zatrzymuje w checkPlayersEntry/endBattle,
    // tu odtwarzamy to samo po zmianie stanu (opoznienie jak przy kazdym innym
    // snapshocie, max ok. 2 s - patrz interwal wyslijSnapshot w main.js).
    if (this.state === 'BATTLE' && prevState !== 'BATTLE') {
      // Widz wchodzi w BATTLE dopiero po snapshocie hosta (opoznienie jak
      // przy kazdym innym stanie, patrz komentarz nizej przy triggerAttack) -
      // startujemy bojke tu, dokladnie tak jak host w checkPlayersEntry.
      this.bojka.start(this.tile, this.players, `${this.economy.state.seedGry}:flaga-bojka:${this.battleId}`);
    } else if (prevState === 'BATTLE' && this.state !== 'BATTLE') {
      this.bojka.stop(this.workerManager);
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
    this.flagSprite.position.set(this.tile.x, 2.5, this.tile.z);

    if (this.state === 'REWARD') {
      // Zadanie: oznaczenie pola znika CALKOWICIE w chwili wygranej, tez u
      // widza - w tym u widza, ktory dopiero wszedl w trakcie REWARD (ta
      // galaz jest bezwarunkowa wzgledem prevState, nie tylko "przy zmianie
      // na REWARD"). _usunPlotki() jest no-op, jesli plotek juz nie ma (np.
      // host je usunal wczesniej niz przyszedl ten snapshot).
      this.highlightMesh.visible = false;
      this._usunPlotki();
    } else {
      this.highlightMesh.visible = true;
    }

    // Kartka ze zwyciezca (patrz _pokazZwyciezce) - pokazujemy ja WYLACZNIE w
    // momencie WEJSCIA w REWARD (prevState !== 'REWARD'), nie przy kazdym
    // snapshocie (applySync leci co ok. 2s przez cala nagrode - powtorne
    // wywolanie zdejmowaloby stara teksture i rysowalo identyczna nowa, bez
    // sensu). U widza, ktory dolaczyl juz W TRAKCIE REWARD, ten strażnik i
    // tak zadziala raz - przy pierwszym snapshocie, ktory go zastaje w REWARD.
    if (this.state === 'REWARD') {
      if (prevState !== 'REWARD' && this.winner) {
        this._pokazZwyciezce(this.winner);
      }
    } else if (this.state === 'BATTLE' && this.odslonietaFlaga) {
      // Timeout pojedynczej flagi (patrz LIMIT_CZASU_FLAGI_S) - host juz
      // policzyl to sam, widz tylko odtwarza gotowa decyzje z tego snapshotu.
      this.flagSprite.visible = false;
      if (this.odslonietaFlaga !== this._loadedOdsloniecie) {
        this._loadedOdsloniecie = this.odslonietaFlaga;
        this._pokazOdslonietaFlage(this.odslonietaFlaga);
      }
    } else if (this.state === 'BATTLE' && this.currentFlag) {
      this._loadedOdsloniecie = null;
      this._ukryjOdslonietaFlage();
      if (this.currentFlag !== this._loadedFlag) {
        this._loadedFlag = this.currentFlag;
        this._stosujTeksturaFlagi(this.currentFlag);
      }
    } else {
      // WAITING (jeszcze bez flagi) albo krotka przerwa miedzy odslonieciem a
      // kolejna flaga. REWARD jest juz obsluzony osobno wyzej (kartka
      // zwyciezcy zostaje widoczna, nie chowana tutaj).
      this.flagSprite.visible = false;
      this._loadedOdsloniecie = null;
      this._ukryjOdslonietaFlage();
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
