import * as THREE from 'three';
import {
  MARKI,
  MARKA_SLUGI,
  KOLORY_MAREK,
  INDEKS_WARIANTOW_MAREK,
  tokenizujOdpowiedzMarki,
} from './marki.js';
import { usunTagiEmotek } from './kick.js';
import { showTopAnnouncement } from './vanessa.js';
import { loadForest } from './assets.js';
import { strumien, losujInt, pozycjaBezPowtorek } from './rng.js';
import { Bojka } from './bojka.js';


// Minimalny odstep miedzy polami minigier areny (odleglosc "krolem": max z |dx|,|dz|).
// 3 = miedzy dwoma polami minigier zostaja co najmniej 2 wolne pola, takze po skosie.
const MIN_ODSTEP_MINIGIER = 3;
function zaBliskoMinigry(x, z, tile) {
  return !!tile && Math.max(Math.abs(x - tile.x), Math.abs(z - tile.z)) < MIN_ODSTEP_MINIGIER;
}

// Minigra "Zgadnij marke" - PIATA minigra na siatce areny, obok bitwy o flagi,
// bitwy tlumaczen i panstw-miast. Mechanika jest CELOWO skopiowana z
// src/flagbattle.js (stany IDLE -> WAITING -> BATTLE -> REWARD, wejscie dwoch
// graczy na kafelek, getSyncState/applySync, setHost, przerwanie przez bossa,
// wysuwane plotki...) - a NIE wyciagnieta jako wspolna klasa bazowa. Patrz
// obszerny komentarz na gorze tlumaczenia.js po pelne uzasadnienie tej
// decyzji (bitwa o flagi dwa razy w historii projektu polozyla cala
// produkcje - dorzucanie abstrakcji na potrzeby CZWARTEJ kopii zwiekszaloby
// ryzyko regresji w JUZ DZIALAJACYM kodzie). NIE modyfikujemy
// flagbattle.js/tlumaczenia.js/panstwa-miasta.js poza (opisanym w ich
// naglowkach) minimalnym dopiskiem do kolizji kafelkow.
//
// Roznica wzgledem flag: zamiast flagi panstwa pokazujemy logotyp marki
// (assets/brands-vector/<slug>.svg) - patrz obszerny komentarz przy
// zaladujTeksturaLogo nizej o tym, dlaczego logo NIE moze byc rysowane jak
// flaga (plaska grafika na pelnym tle), tylko na kartce z dobranym tlem.

// Prog zwyciestwa: pierwszy gracz, ktory zgadnie PUNKTY_DO_WYGRANEJ marek,
// wygrywa cala bitwe. WSZYSTKIE miejsca w tym pliku (tekst ogloszenia na
// czacie, warunek konca bitwy) MUSZA czytac ta stala, a nie miec wpisanej
// liczby na sztywno (patrz identyczny komentarz w panstwa-miasta.js).
const PUNKTY_DO_WYGRANEJ = 5;

// Limit czasu na zgadniecie POJEDYNCZEJ marki (nie calej bitwy) - liczony
// WYLACZNIE przez hosta w tick() (this.markaRoundTimer, zerowany w kazdym
// nextRound()). Po uplywie: host odslania nazwe marki (_czasMarkiUplynal),
// po ODSLONIECIE_CZAS_S losuje kolejna. Identyczny wzorzec co
// LIMIT_CZASU_FLAGI_S w flagbattle.js.
const LIMIT_CZASU_MARKI_S = 60;
const ODSLONIECIE_CZAS_S = 3;

// Wysokosc znacznika kontestowanego pola. Zajete poziomy w projekcie: 0.025
// wierzch kafla podlogi (scene.js), 0.035 neonowa siatka areny (scene.js),
// 0.042 znaczniki atakow bossa (bossattack.js), 0.048 wskaznik zlotej monety
// (goldcoin.js), 0.052 znacznik bitwy o flagi (flagbattle.js), 0.056 znacznik
// bitwy tlumaczen (tlumaczenia.js), 0.060 znacznik panstw-miast
// (panstwa-miasta.js). 0.064 jest KOLEJNYM wolnym poziomem ponad wszystkimi -
// wejscie w cudzy poziom odtworzyloby migotanie podlogi (z-fighting), ktore w
// tym projekcie juz raz naprawiono.
const MARKER_Y = 0.064;

// Kolor minigry: MAGENTA - wyraznie inny niz zajete kolory w projekcie
// (neonowa zielen siatki areny 0x53fc18, czerwien rakiet bossa 0xff3b30,
// niebiesko-fioletowe tlumaczenia 0x3d5cff, pomaranczowe panstwa-miasta
// 0xff9f1c, zloto monety, czerwien flag).
const KOLOR_BAZOWY = 0xff2bd6;

// Klipy walki - identyczne jak w pozostalych minigrach (kazda postac w
// projekcie ma je w swoim wspolnym slowniku animacji). Deterministyczny
// wybor wzgledem liczby rozegranych rund z wygrana.
const KLIPY_ATAKU = ['attack-melee-right', 'attack-melee-left', 'attack-kick-right', 'attack-kick-left'];
function klipAtakuDlaRundy(numerRundy) {
  const i = ((numerRundy % KLIPY_ATAKU.length) + KLIPY_ATAKU.length) % KLIPY_ATAKU.length;
  return KLIPY_ATAKU[i];
}

// Szablon plotki (assets/forest/fence.glb) wokol kontestowanego pola.
// loadForest() sam cache'uje wynik (patrz assets.js) - ten sam plik jest juz
// ladowany przez flagbattle.js/tlumaczenia.js/panstwa-miasta.js/city.js pod
// tym samym kluczem, wiec to nie jest dodatkowe pobieranie ani osobna kopia
// geometrii/materialu.
let szablonPlotkiPromise = null;
function pobierzSzablonPlotki() {
  if (!szablonPlotkiPromise) szablonPlotkiPromise = loadForest('fence');
  return szablonPlotkiPromise;
}

/**
 * Dopasowanie odpowiedzi z czatu do marki: PO CALYCH SLOWACH, z
 * rozstrzyganiem konfliktow najdluzszym dopasowaniem. DOKLADNA kopia
 * zawieraSekwencje/najlepszyKodDlaOdpowiedzi z flagbattle.js (patrz tam
 * obszerny komentarz-historia o tym, dlaczego ta technika, a nie prostsze
 * podejscia typu "includes") - tu operujemy na INDEKS_WARIANTOW_MAREK
 * (pole `slug` zamiast `kod`) zamiast INDEKS_WARIANTOW.
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
 * Zwraca slug marki, ktorej wariant jest NAJDLUZSZYM jednoznacznym
 * dopasowaniem w tokenach odpowiedzi, albo null (brak dopasowania lub remis
 * miedzy dwiema roznymi markami tej samej dlugosci). Przechodzi caly
 * INDEKS_WARIANTOW_MAREK (zbudowany RAZ przy ladowaniu modulu marki.js, nie
 * tutaj) - dokladny odpowiednik najlepszyKodDlaOdpowiedzi z flagbattle.js.
 */
function najlepszySlugDlaOdpowiedzi(tokeny) {
  let najlepszaDlugosc = 0;
  let slugiNajlepsze = null;
  for (const { slug, slowa } of INDEKS_WARIANTOW_MAREK) {
    if (slowa.length < najlepszaDlugosc) continue;
    if (!zawieraSekwencje(tokeny, slowa)) continue;
    if (slowa.length > najlepszaDlugosc) {
      najlepszaDlugosc = slowa.length;
      slugiNajlepsze = new Set([slug]);
    } else {
      slugiNajlepsze.add(slug);
    }
  }
  if (!slugiNajlepsze || slugiNajlepsze.size !== 1) return null;
  return [...slugiNajlepsze][0];
}

// Rozmiar canvasu kartki z logo - KWADRATOWY (w odroznieniu od 4:3 flag), bo
// SVG marek maja viewBox="0 0 24 24" (kwadrat) - patrz zaladujTeksturaLogo.
const ROZMIAR_KARTY_LOGO = 512;
// Margines wokol logo na kartce (patrz zadanie: "logo wysrodkowane, wpisane
// w kartke z marginesem ok. 12% z kazdej strony, z zachowaniem proporcji").
const MARGINES_KARTY_LOGO = 0.12;

// Wybor tla kartki z logo. Logo NIE jest prostokatna grafika na pelnym tle
// jak flaga, tylko JEDNOKOLOROWA SYLWETKA (fill na <svg>) - na
// przezroczystym/niedopasowanym tle czesc logo staje sie niewidoczna.
//
// UWAGA: to NIE jest prog samej luminancji koloru marki - prog czystej
// luminancji (np. "lum > 215 -> tlo ciemne") NIE lapie jasnych ZOLTYCH marek:
// McDonald's #FBC817 ma luminancje ~198 (ponizej takiego progu), wiec
// trafilby na biala kartke, a zolte na bialym jest praktycznie nieczytelne
// (niski kontrast mimo wysokiej luminancji obu kolorow). Dlatego liczymy
// KONTRAST WCAG 2.x (ten sam wzor co w standardach dostepnosci stron) miedzy
// kolorem marki a JASNYM tlem - to poprawnie lapie i "niemal biale" (Sony
// #FFFFFF), i "jasne, ale slabo kontrastowe" (zolte/pastelowe) marki naraz.
//
// Prog PROG_KONTRASTU = 2.5 wyznaczony pomiarem na wszystkich 222 markach: przy
// tym progu na ciemne tlo trafia 36 marek i KAZDA z nich ma na ciemnym tle
// dobry kontrast (zero marek slabych na obu tlach jednoczesnie). Przy progu
// 1.5 bylyby to 4 marki, przy 3.0 az 50 - obie granice tego bezpiecznego
// przedzialu tez daja zero slabych przypadkow, 2.5 to jego srodek.
// Kontrole: McDonald's #FBC817 - 1.57 na bialym -> 10.97 na ciemnym (idzie na
// ciemne). Sony #FFFFFF - 1.00 na bialym -> 17.22 na ciemnym (idzie na
// ciemne). Nike #111111 - 18.88 na bialym (zostaje na jasnym).
const TLO_DLA_JASNEJ_MARKI = '#1b1b1b'; // marka slabo widoczna na bialym (np. Sony, McDonald's) -> ciemna kartka
const TLO_DLA_CIEMNEJ_MARKI = '#ffffff'; // marka dobrze widoczna na bialym (w tym niemal czarne) -> jasna kartka
const PROG_KONTRASTU = 2.5;

/** Liniowa skladowa sRGB (0-1) dla jednej skladowej koloru 0-255 - patrz relatywnaLuminancja. */
function srgbDoLiniowej(v) {
  const n = v / 255;
  return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
}

/** Relatywna luminancja WCAG dla koloru `#RRGGBB`. */
function relatywnaLuminancja(hex) {
  const czysty = (hex || '#000000').replace('#', '');
  const r = parseInt(czysty.slice(0, 2), 16) || 0;
  const g = parseInt(czysty.slice(2, 4), 16) || 0;
  const b = parseInt(czysty.slice(4, 6), 16) || 0;
  return 0.2126 * srgbDoLiniowej(r) + 0.7152 * srgbDoLiniowej(g) + 0.0722 * srgbDoLiniowej(b);
}

/** Wspolczynnik kontrastu WCAG (1..21) miedzy dwoma kolorami `#RRGGBB`. */
function kontrastWcag(hexA, hexB) {
  const l1 = Math.max(relatywnaLuminancja(hexA), relatywnaLuminancja(hexB));
  const l2 = Math.min(relatywnaLuminancja(hexA), relatywnaLuminancja(hexB));
  return (l1 + 0.05) / (l2 + 0.05);
}

/** Zwraca kolor tla kartki (patrz stale wyzej) dla danego koloru marki `#RRGGBB`. */
function tloKartkiDlaKoloru(hex) {
  const kolorMarki = hex || '#000000';
  return kontrastWcag(kolorMarki, TLO_DLA_CIEMNEJ_MARKI) < PROG_KONTRASTU ? TLO_DLA_JASNEJ_MARKI : TLO_DLA_CIEMNEJ_MARKI;
}

// slug -> Promise<THREE.CanvasTexture>. Modul jest singletonem na karte (ES
// modules), wiec ten cache dziala "raz na sesje" - ten sam wzorzec co
// cacheTeksturFlag w flagbattle.js.
const cacheTeksturLogo = new Map();

/**
 * Pobiera SVG logo marki (assets/brands-vector/<slug>.svg, pakiet
 * simple-icons), rasteryzuje na KWADRATOWA kartke z dobranym tlem (patrz
 * tloKartkiDlaKoloru) i zwraca CanvasTexture z poprawnym colorSpace/
 * anizotropia. SVG juz ma jawne width/height i viewBox="0 0 24 24" (patrz
 * zadanie), wiec - w odroznieniu od zapewnijWymiarySvg we flagbattle.js - nie
 * trzeba nic do niego dopisywac przed zbudowaniem Bloba. Wynik cache'owany
 * po slugu.
 */
function zaladujTeksturaLogo(slug, renderer) {
  if (cacheTeksturLogo.has(slug)) return cacheTeksturLogo.get(slug);

  const promise = (async () => {
    const canvas = document.createElement('canvas');
    canvas.width = ROZMIAR_KARTY_LOGO;
    canvas.height = ROZMIAR_KARTY_LOGO;
    const ctx = canvas.getContext('2d');

    // Kartka: tlo pelne (patrz komentarz przy stalych PROG_LUMINANCJI_TLA
    // wyzej) - bez tego jasne/ciemne logo znikaloby na przezroczystym tle.
    ctx.fillStyle = tloKartkiDlaKoloru(KOLORY_MAREK[slug]);
    ctx.fillRect(0, 0, ROZMIAR_KARTY_LOGO, ROZMIAR_KARTY_LOGO);

    const resp = await fetch(`assets/brands-vector/${slug}.svg`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} przy pobieraniu assets/brands-vector/${slug}.svg`);
    const svgText = await resp.text();

    const blob = new Blob([svgText], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    try {
      const img = await new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error(`Blad rasteryzacji SVG logo ${slug}`));
        im.src = url;
      });
      // Logo wysrodkowane, wpisane w kartke z marginesem MARGINES_KARTY_LOGO
      // z kazdej strony, jednolite skalowanie (SVG jest kwadratowy 24x24).
      const dostepny = ROZMIAR_KARTY_LOGO * (1 - 2 * MARGINES_KARTY_LOGO);
      const offset = ROZMIAR_KARTY_LOGO * MARGINES_KARTY_LOGO;
      ctx.drawImage(img, offset, offset, dostepny, dostepny);
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

  cacheTeksturLogo.set(slug, promise);
  // Nieudana probka NIE zostaje w cache na zawsze - jeden chwilowy blad sieci
  // nie blokuje tej marki do konca sesji.
  promise.catch(() => cacheTeksturLogo.delete(slug));
  return promise;
}

/**
 * Rysuje kilka wierszy tekstu na KWADRATOWYM canvasie i zwraca CanvasTexture -
 * uzywane do komunikatu "czas minal" w miejscu logo (patrz
 * _pokazOdslonietaMarke) oraz do kartki ze zwyciezca bitwy (patrz
 * _pokazZwyciezce). Odpowiednik renderujTekstNaCanvasie z flagbattle.js,
 * wymiary dopasowane do kwadratowej kartki logo.
 *
 * Dopasowanie fontu: kazda linia dostaje WLASNY rozmiar, zmierzony przez
 * ctx.measureText i zmniejszany o 2px, dopoki nie zmiesci sie w szerokosci
 * kartki (margines 20px z kazdej strony) albo nie osiagnie minimalnego
 * czytelnego rozmiaru (18px) - identyczny wzorzec co w flagbattle.js (nick
 * zwyciezcy w drugiej linii bywa dlugi).
 */
function renderujTekstNaCanvasie(linie) {
  const canvas = document.createElement('canvas');
  canvas.width = ROZMIAR_KARTY_LOGO;
  canvas.height = ROZMIAR_KARTY_LOGO;
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

export class BitwaMarekManager {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;

    this.state = 'IDLE'; // IDLE, WAITING, BATTLE, REWARD
    this.timer = 0;
    this.tile = null; // {x, z}
    this.players = []; // [{ typeIndex, username, score }]

    this.currentMarka = null; // slug, np. 'nike'
    this._loadedMarka = null; // ostatnia marka, ktorej tekstura zostala zaladowana (applySync u widza)
    this.markiZgadniete = 0; // Ile marek zgadnieto w obecnej bitwie

    // Limit czasu pojedynczej marki (patrz LIMIT_CZASU_MARKI_S) - liczony
    // WYLACZNIE przez hosta w tick(), zerowany w kazdym nextRound(). Widz go
    // nie liczy sam (patrz applySync) - dostaje juz gotowy wynik.
    this.markaRoundTimer = 0;
    // Slug marki pokazywany w miejscu logo po uplywie limitu czasu, albo null
    // gdy pokazujemy normalnie logo/nic. Synchronizowany (getSyncState/applySync).
    this.odslonietaMarka = null;
    this._loadedOdsloniecie = null; // ostatnia odslonietaMarka narysowana na revealSprite (widz)

    // battleId - patrz nextRound(). Synchronizowany (getSyncState/applySync),
    // inkrementowany WYLACZNIE przez hosta w spawnBattleSquare().
    this.battleId = 0;

    this.rewardTimer = 0;
    this.winner = null;

    this.onAnnounce = () => {};
    this.onRewardTick = () => {};

    // Znacznik kontestowanego pola - pierscien + wypelnienie, kolor magenta
    // (KOLOR_BAZOWY), MARKER_Y = 0.064 (patrz komentarz przy stalej).
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

    // Sprite z logo. toneMapped = false - plaska 2D grafika (ikona), nie
    // oswietlona powierzchnia 3D (patrz identyczny komentarz w flagbattle.js
    // przy ROZMIAR_TEKSTURY_FLAGI_W). y = 2.05, skala 1.1x1.1 - zmierzone i
    // skopiowane z KARTY_WYSOKOSC w panstwa-miasta.js: rzut na ekran pokazal,
    // ze nad kafelkiem bitwy jest tylko WASKI pas widoczny w kadrze - y=2.5
    // (flagbattle.js/tlumaczenia.js) lezy juz przy samej gornej krawedzi
    // ekranu na dalekich polach (13 px i 1 px od gory), a y=3.95 wypada 214 px
    // POZA ekranem. Kartka o wysokosci 1.1 na y=2.05 zajmuje Y 1.50-2.60, co
    // miesci sie w kadrze na kazdym polu.
    this.brandMaterial = new THREE.SpriteMaterial({ color: 0xffffff, toneMapped: false });
    this.brandSprite = new THREE.Sprite(this.brandMaterial);
    this.brandSprite.scale.set(1.1, 1.1, 1.0);
    this.brandSprite.position.y = 2.05;
    this.brandSprite.visible = false;
    this.scene.add(this.brandSprite);

    // Sprite tekstowy pokazujacy odslonieta nazwe marki po uplywie
    // LIMIT_CZASU_MARKI_S, w tym samym miejscu co brandSprite. Nigdy nie sa
    // widoczne oba naraz (patrz _pokazOdslonietaMarke/_ukryjOdslonietaMarke).
    this.revealMaterial = new THREE.SpriteMaterial({ color: 0xffffff, toneMapped: false });
    this.revealSprite = new THREE.Sprite(this.revealMaterial);
    this.revealSprite.scale.set(1.1, 1.1, 1.0);
    this.revealSprite.position.y = 2.05;
    this.revealSprite.visible = false;
    this.scene.add(this.revealSprite);

    // Tekstura kartki ze zwyciezca (patrz _pokazZwyciezce) - jednorazowa, NIE
    // cache'owana (nick jest unikalny per bitwa) - patrz identyczny
    // komentarz w flagbattle.js przy tym samym polu.
    this._winnerTexture = null;

    this._brandReqId = 0; // chroni przed wyscigiem, gdy runda zmieni sie zanim async rasteryzacja skonczy
    this.isHost = false;

    // Bijatyka + chmura kurzu (patrz src/bojka.js) - jedna wspoldzielona
    // instancja na cale zycie tej minigry, wlaczana/wylaczana per bitwa.
    this.bojka = new Bojka(this.scene);
  }

  setContext({ workerManager, kickChat, economy, isHost, boss, flagBattle, tlumaczenia, panstwaMiasta }) {
    this.workerManager = workerManager;
    this.kickChat = kickChat;
    this.economy = economy;
    this.boss = boss || null;
    // Referencje do pozostalych trzech minigier - WYLACZNIE do odczytu ich
    // biezacego kafelka (.tile), zeby losowanie pola bitwy o marki nigdy nie
    // trafilo w kafelek zajety przez ktorakolwiek z nich (patrz
    // spawnBattleSquare nizej). Ten sam czworostronny kontrakt "tylko do
    // odczytu cudzego .tile", jaki juz laczy flagBattle/tlumaczenia/
    // panstwaMiasta nawzajem (patrz ich setContext).
    this.flagBattleRef = flagBattle || null;
    this.tlumaczeniaRef = tlumaczenia || null;
    this.panstwaMiastaRef = panstwaMiasta || null;
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
   * Minigra jest odblokowana dopiero po pokonaniu bossa tieru 4 (Skorpion).
   * Sprawdzane NA BIEZACO (economy.state.bossesDefeated.includes(4)) w
   * KAZDYM ticku, a NIE zamrazane przy starcie - dokladnie ten sam blad
   * ("warunek zamrozony przy starcie") juz raz wystapil w tym projekcie z
   * isHost (patrz komentarz w flagbattle.js/setHost) i zostal juz raz
   * swiadomie unikniety dla tej samej klasy warunku w panstwa-miasta.js -
   * nie powielamy go tu trzeci raz.
   */
  _czyOdblokowana() {
    return !!(this.economy && Array.isArray(this.economy.state.bossesDefeated) && this.economy.state.bossesDefeated.includes(4));
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
      // Puls magenta (miejsce zielonego pulsu flag/pomaranczowego pulsu
      // panstw-miast) - funkcja Date.now(), nie losowania, wiec host i widz
      // pulsuja identycznie.
      const s = Math.sin(Date.now() * 0.005) * 0.5 + 0.5;
      this.markerPierscien.material.color.setRGB(1, s * 0.15, 0.65 + s * 0.25);
      this.markerPierscien.material.opacity = 0.95;
      this.markerWypelnienie.material.opacity = 0.18;
    } else if (this.state === 'REWARD') {
      const s = Math.sin(Date.now() * 0.003) * 0.5 + 0.5;
      this.markerPierscien.material.color.setRGB(1, 0.8 + s * 0.2, 0);
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
            console.warn('[marki] Blad w onRewardTick:', err);
          }
        }
      }
    }

    this._aktualizujPlotki(dt);
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
      if (this.currentMarka) {
        this.markaRoundTimer += dt;
        if (this.markaRoundTimer >= LIMIT_CZASU_MARKI_S) {
          this._czasMarkiUplynal();
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

  // Ograniczenie prob przy losowaniu pola (siatka 7x7, kolizje z bankomatem/
  // pozostalymi minigrami) - petla NIE MOZE zostac nieograniczona. Identyczny
  // wzorzec co MAX_PROB_LOSOWANIA_POLA w flagbattle.js/tlumaczenia.js/
  // panstwa-miasta.js.
  static MAX_PROB_LOSOWANIA_POLA = 50;

  spawnBattleSquare() {
    this.battleId += 1;

    // Losowanie DETERMINISTYCZNE z tego samego wspolnego strumienia co reszta
    // gry (patrz rng.js). Klucz zawiera licznikMarek (trwaly, rosnie z kazda
    // runda marek - patrz nextRound) ORAZ battleId. Wykluczamy (0,0)
    // (bankomat) i kafelki zajete przez pozostale trzy minigry (patrz
    // setContext) - zadne dwie minigry nie moga stanac na tym samym polu.
    const kluczPola = `${this.economy.state.seedGry}:marki-pole:${this.economy.state.licznikMarek}:${this.battleId}`;
    const rngPola = strumien(kluczPola);
    const zajeteFlag = this.flagBattleRef && this.flagBattleRef.tile ? this.flagBattleRef.tile : null;
    const zajeteTlumaczenia = this.tlumaczeniaRef && this.tlumaczeniaRef.tile ? this.tlumaczeniaRef.tile : null;
    const zajetePanstwaMiasta = this.panstwaMiastaRef && this.panstwaMiastaRef.tile ? this.panstwaMiastaRef.tile : null;

    const zajete = (kx, kz) =>
      (zaBliskoMinigry(kx, kz, zajeteFlag)) ||
      (zaBliskoMinigry(kx, kz, zajeteTlumaczenia)) ||
      (zaBliskoMinigry(kx, kz, zajetePanstwaMiasta));

    let rx = null;
    let rz = null;
    for (let proba = 0; proba < BitwaMarekManager.MAX_PROB_LOSOWANIA_POLA; proba++) {
      const kx = losujInt(rngPola, -3, 3);
      const kz = losujInt(rngPola, -3, 3);
      if (kx === 0 && kz === 0) continue; // bankomat
      if (zajete(kx, kz)) continue;
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
          if (zajete(x, z)) continue;
          rx = x;
          rz = z;
          break szukanie;
        }
      }
    }
    if (rx === null) {
      console.warn('[marki] Brak wolnego pola na siatce - pomijam spawn tej rundy.');
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

    this.brandSprite.position.set(rx, 2.05, rz);
    this.brandSprite.visible = false;
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
      this.markiZgadniete = 0;

      const angleP1 = Math.atan2(p2.obj.position.x - p1.obj.position.x, p2.obj.position.z - p1.obj.position.z);
      p1.targetRotY = angleP1;
      p1.facingAngle = angleP1;
      p2.targetRotY = angleP1 + Math.PI;
      p2.facingAngle = angleP1 + Math.PI;

      this.bojka.start(this.tile, this.players, `${this.economy.state.seedGry}:marki-bojka:${this.battleId}`);

      this.nextRound();
      this.announce(
        `Zgadnij marke! ${p1User} vs ${p2User}! Wpisuj nazwe marki na czacie! Kto pierwszy zdobedzie ${PUNKTY_DO_WYGRANEJ} pkt wygrywa!`,
      );
    }
  }

  /** Identyczne uzasadnienie co _sprawdzWyjscieAwaryjne w flagbattle.js/tlumaczenia.js/panstwa-miasta.js. */
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
      this.announce('Obaj walczacy tracą awatara w trakcie bitwy - bitwa o marki anulowana.');
      this.reset();
    }
  }

  nextRound() {
    if (this.state !== 'BATTLE') return;
    this.markaRoundTimer = 0; // nowa marka = nowy limit czasu (patrz LIMIT_CZASU_MARKI_S w tick())

    // Bez powtorek, dopoki nie zostanie wylosowana CALA pula marek w tej
    // ROZGRYWCE (nie tylko w tej bitwie) - patrz pozycjaBezPowtorek w rng.js
    // i licznikMarek w economy.js (trwaly, zapisywany licznik). Wolane
    // WYLACZNIE przez hosta.
    this.currentMarka = pozycjaBezPowtorek(
      this.economy.state.seedGry,
      'marki',
      MARKA_SLUGI,
      this.economy.state.licznikMarek,
    );
    this.economy.state.licznikMarek += 1;
    this._stosujTeksturaLogo(this.currentMarka);
  }

  /**
   * Ustawia teksture sprite'a logo na podany slug marki, korzystajac z
   * cache'u modulowego zaladujTeksturaLogo. Uzywane zarowno przez hosta
   * (nextRound, decyzja) jak i widza (applySync, echo decyzji hosta).
   *
   * Chroni przed wyscigiem: jesli w trakcie asynchronicznej rasteryzacji
   * runda zdazy sie zmienic, starszy wynik jest ignorowany i NIE nadpisuje
   * nowszej marki (identyczny wzorzec co _flagReqId w flagbattle.js).
   */
  _stosujTeksturaLogo(slug) {
    this._brandReqId += 1;
    const mojeId = this._brandReqId;
    zaladujTeksturaLogo(slug, this.renderer)
      .then((texture) => {
        if (mojeId !== this._brandReqId) return; // starsze zadanie, zdazylo sie juz zdezaktualizowac
        this.brandMaterial.map = texture;
        this.brandMaterial.needsUpdate = true;
        this.brandSprite.visible = true;
      })
      .catch((err) => {
        console.error(`[marki] Blad ladowania tekstury logo ${slug}:`, err);
      });
  }

  _pokazOdslonietaMarke(slug) {
    const nazwa = MARKI[slug] || slug;
    const texture = renderujTekstNaCanvasie(['⏰ Czas minął! To była:', nazwa]);
    this.revealMaterial.map = texture;
    this.revealMaterial.needsUpdate = true;
    this.revealSprite.position.set(this.brandSprite.position.x, this.brandSprite.position.y, this.brandSprite.position.z);
    this.revealSprite.visible = true;
    this.brandSprite.visible = false;
  }

  _ukryjOdslonietaMarke() {
    this.revealSprite.visible = false;
  }

  /**
   * Podmienia teksture GLOWNEJ kartki (brandSprite/brandMaterial) na kartke
   * ze zwyciezca bitwy - kartka zostaje widoczna przez caly stan REWARD, w
   * tym samym miejscu co logo marki w trakcie gry (patrz identyczne
   * uzasadnienie w flagbattle.js/_pokazZwyciezce). Wolane zarowno przez
   * hosta (endBattle) jak i widza (applySync, strażnik wejscia w REWARD).
   *
   * revealSprite chowamy jawnie - w BATTLE moze byc akurat widoczny ("czas
   * minal" po ostatniej marce przed zwycieska odpowiedzia), a obie kartki nie
   * moga nachodzic sie na siebie.
   */
  _pokazZwyciezce(winnerPlayer) {
    this._brandReqId += 1; // spozniona tekstura logo nie nadpisze kartki zwyciezcy
    if (this._winnerTexture) this._winnerTexture.dispose();
    this._winnerTexture = renderujTekstNaCanvasie(['🎉 WYGRYWA', winnerPlayer.username]);
    this.brandMaterial.map = this._winnerTexture;
    this.brandMaterial.needsUpdate = true;
    this.brandSprite.visible = true;
    // Kartka zwyciezcy tylko przez 2 s (nagroda 30 s trwa dalej bez niej).
    const idBitwy = this.battleId;
    setTimeout(() => {
      if (this.battleId === idBitwy && this.state === 'REWARD') this.brandSprite.visible = false;
    }, 2000);
    this._ukryjOdslonietaMarke();
  }

  /**
   * Wolane WYLACZNIE przez hosta z tick() (patrz LIMIT_CZASU_MARKI_S), gdy
   * biezaca marka nie zostala odgadnieta w limicie czasu. Identyczny wzorzec
   * co _czasFlagiUplynal w flagbattle.js.
   */
  _czasMarkiUplynal() {
    const slug = this.currentMarka;
    this.currentMarka = null;
    this.odslonietaMarka = slug;
    this.markaRoundTimer = 0;
    this._pokazOdslonietaMarke(slug);

    const nazwa = MARKI[slug] || slug;
    this.announce(`⏰ Czas minął! To była: ${nazwa}`);

    const mojeBattleId = this.battleId;
    setTimeout(() => {
      if (this.state !== 'BATTLE' || this.battleId !== mojeBattleId) return;
      this.odslonietaMarka = null;
      this._ukryjOdslonietaMarke();
      this.nextRound();
    }, ODSLONIECIE_CZAS_S * 1000);
  }

  onChatMessage(username, content) {
    if (!this.isHost) return;
    if (this.state !== 'BATTLE' || !this.currentMarka) return;

    const player = this.players.find((p) => p.username.toLowerCase() === username.toLowerCase());
    if (!player) return; // Tylko gracze na polu moga odpowiadac

    const tokeny = tokenizujOdpowiedzMarki(usunTagiEmotek(content));
    const dopasowanySlug = najlepszySlugDlaOdpowiedzi(tokeny);

    if (dopasowanySlug === this.currentMarka) {
      player.score += 1;
      this.markiZgadniete += 1;
      const properName = MARKI[this.currentMarka];
      this.currentMarka = null; // blokada by nie nabic 2x na 1 wiadomosci

      const workerEntry = this.workerManager && this.workerManager.getWorkerType(player.typeIndex);
      if (workerEntry) {
        this.workerManager.triggerAttack(workerEntry, klipAtakuDlaRundy(this.markiZgadniete));
      }

      this.announce(`${username} zgaduje poprawnie: ${properName}! (Punkty: ${player.score})`);

      if (player.score >= PUNKTY_DO_WYGRANEJ) {
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
    this.odslonietaMarka = null;
    this._loadedOdsloniecie = null;
    // Kartka logo zostaje na scenie, ale z podmieniona tekstura zwyciezcy
    // (patrz _pokazZwyciezce) - zadanie: zwyciezca ma byc widoczny w tym
    // samym miejscu co logo marki w trakcie gry, nie chowany.
    this._pokazZwyciezce(winnerPlayer);
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

    this.announce(`🎉 ${winnerPlayer.username} WYGRYWA! Przez 30 sekund dostaje 2 zł/s pasywnie!`);
    this._pokazBanerZwyciezcy(winnerPlayer);
  }

  /**
   * Widoczny na ekranie baner zwyciezcy (obok istniejacego announce() na
   * czacie) - uzywa wspolnego mechanizmu projektu showTopAnnouncement
   * (./vanessa.js, patrz goldcoin.js/kick.js/main.js po identyczny wzorzec
   * wywolania). Wolane z DWOCH miejsc, zeby baner pokazal sie u KAZDEGO:
   * tutaj (endBattle, host) i w applySync (widz, w momencie WEJSCIA w stan
   * REWARD - patrz strażnik prevState tam, zeby nie migac co snapshot).
   * Opakowane w try/catch jak w kick.js - baner nigdy nie moze wywalic
   * logiki konca bitwy.
   */
  _pokazBanerZwyciezcy(winnerPlayer) {
    try {
      showTopAnnouncement(
        `🎉 ${winnerPlayer.username} WYGRYWA!`,
        'Zgadnij markę! Przez 30 sekund dostaje <strong>2 zł/s</strong> pasywnie!',
        2000,
      );
    } catch (err) {
      console.warn('[marki] Blad w showTopAnnouncement:', err);
    }
  }

  /** Identyczne uzasadnienie co _przerwijPrzezBossa w flagbattle.js/tlumaczenia.js/panstwa-miasta.js. */
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
        `⚔️ Boss atakuje! Bitwa o marki przerwana - ${this.winner.username} dostaje od razu resztę nagrody (+${wyplata} zł).`,
      );
    } else if (this.state === 'BATTLE' || this.state === 'WAITING') {
      this.announce('⚔️ Boss atakuje! Bitwa o marki przerwana - pole zwolnione.');
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
      console.error('[marki] Blad ladowania plotek pola bitwy:', err);
    } finally {
      this._plotkiWTrakcieBudowy = false;
    }
  }

  /** Identyczne uzasadnienie co _usunPlotki w flagbattle.js - nie zwalnia zasobu SZABLONU, tylko wlasne klony. */
  _usunPlotki() {
    for (const obj of this.plotki) {
      this.scene.remove(obj);
    }
    this.plotki = [];
  }

  reset() {
    if (this.bojka) this.bojka.stop(this.workerManager);
    this.state = 'IDLE';
    this.timer = 0;
    this.tile = null;
    this.players = [];
    this.currentMarka = null;
    this._loadedMarka = null;
    this.markaRoundTimer = 0;
    this.odslonietaMarka = null;
    this._loadedOdsloniecie = null;
    this._ukryjOdslonietaMarke();
    this.winner = null;
    this.rewardTimer = 0;
    this._lastRewardTime = 0;
    // battleId celowo NIE jest zerowany - patrz identyczny komentarz w reset()
    // we flagbattle.js.
    this.highlightMesh.visible = false;
    this.brandSprite.visible = false;
    // Kartka ze zwyciezca znika razem z reszta planszy - tekstura jest
    // jednorazowa (NIE z cacheTeksturLogo), wiec dispose'ujemy ja tutaj; sam
    // brandMaterial zostaje (wspoldzielony, kolejna bitwa nadpisze .map).
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
      currentMarka: this.currentMarka,
      odslonietaMarka: this.odslonietaMarka,
      markiZgadniete: this.markiZgadniete,
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
    const prevMarkiZgadniete = this.markiZgadniete;
    this.state = s.state;
    this.tile = s.tile;
    this.players = Array.isArray(s.players) ? s.players : [];
    this.markiZgadniete = s.markiZgadniete || 0;
    this.winner = s.winner || null;
    this.rewardTimer = s.rewardTimer || 0;
    this.battleId = s.battleId || 0;
    this.currentMarka = s.currentMarka || null;
    this.odslonietaMarka = s.odslonietaMarka || null;

    if (this.state === 'BATTLE' && prevState !== 'BATTLE') {
      this.bojka.start(this.tile, this.players, `${this.economy.state.seedGry}:marki-bojka:${this.battleId}`);
    } else if (prevState === 'BATTLE' && this.state !== 'BATTLE') {
      this.bojka.stop(this.workerManager);
    }

    // Baner zwyciezcy u widza: host go juz pokazal w endBattle() u siebie -
    // tutaj wykrywamy WEJSCIE widza w stan REWARD (prevState !== 'REWARD'),
    // nie sam fakt bycia w REWARD, bo applySync leci co snapshot (~co 2s) i
    // baner migalby przy kazdym z nich. Ten strażnik odpala go dokladnie raz
    // na bitwe po stronie widza.
    if (this.state === 'REWARD' && prevState !== 'REWARD' && this.winner) {
      this._pokazBanerZwyciezcy(this.winner);
      // Kartka ze zwyciezca (patrz _pokazZwyciezce) - ten sam strażnik
      // wejscia w REWARD co baner nad tym, zeby nie migac co snapshot.
      this._pokazZwyciezce(this.winner);
    }

    if (this.state === 'BATTLE' && this.markiZgadniete > prevMarkiZgadniete) {
      const zwyciezcaRundy = this.players.find((p) => {
        const stary = prevPlayers.find((op) => op.typeIndex === p.typeIndex);
        return stary ? p.score > stary.score : p.score > 0;
      });
      if (zwyciezcaRundy) {
        const w = this.workerManager && this.workerManager.getWorkerType(zwyciezcaRundy.typeIndex);
        if (w) this.workerManager.triggerAttack(w, klipAtakuDlaRundy(this.markiZgadniete));
      }
    }

    this.highlightMesh.position.x = this.tile.x;
    this.highlightMesh.position.z = this.tile.z;
    this.brandSprite.position.set(this.tile.x, 2.05, this.tile.z);

    if (this.state === 'REWARD') {
      this.highlightMesh.visible = false;
      this._usunPlotki();
    } else {
      this.highlightMesh.visible = true;
    }

    if (this.state === 'REWARD') {
      // Kartka ze zwyciezca juz pokazana wyzej (strażnik wejscia w REWARD) -
      // zostaje widoczna, wiec tutaj nic nie chowamy.
    } else if (this.state === 'BATTLE' && this.odslonietaMarka) {
      this.brandSprite.visible = false;
      if (this.odslonietaMarka !== this._loadedOdsloniecie) {
        this._loadedOdsloniecie = this.odslonietaMarka;
        this._pokazOdslonietaMarke(this.odslonietaMarka);
      }
    } else if (this.state === 'BATTLE' && this.currentMarka) {
      this._loadedOdsloniecie = null;
      this._ukryjOdslonietaMarke();
      if (this.currentMarka !== this._loadedMarka) {
        this._loadedMarka = this.currentMarka;
        this._stosujTeksturaLogo(this.currentMarka);
      }
    } else {
      // WAITING (jeszcze bez marki) albo krotka przerwa miedzy odslonieciem
      // a kolejna marka.
      this.brandSprite.visible = false;
      this._loadedOdsloniecie = null;
      this._ukryjOdslonietaMarke();
    }
  }

  announce(text) {
    const messagesEl = document.getElementById('kick-messages');
    if (messagesEl) {
      const div = document.createElement('div');
      div.className = 'chat-message';
      div.innerHTML = `<strong style="color: #ff2bd6">[Zgadnij markę]</strong> <span>${text}</span>`;
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    try {
      this.onAnnounce(text);
    } catch (err) {
      console.warn('[marki] Blad w onAnnounce:', err);
    }
  }
}
