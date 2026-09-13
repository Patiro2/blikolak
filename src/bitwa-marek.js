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
import { pozycjaBezPowtorek } from './rng.js';
import { MinigraBazowa, klipAtakuDlaRundy, NAGRODA_WYGRANEJ } from './minigra-bazowa.js';

// Minigra "Zgadnij marke" - patrz MinigraBazowa (src/minigra-bazowa.js) po
// wspolny cykl zycia pola/rund/nagrody/plotek/synchronizacji. Ten plik
// zawiera WYLACZNIE to, czym ta minigra realnie sie rozni: pule marek,
// sposob sprawdzania odpowiedzi (dopasowanie najdluzszym ciagiem slow - ten
// sam wzorzec co flagbattle.js, na INDEKS_WARIANTOW_MAREK) i teksture/wyglad
// kartki (rasteryzacja logo SVG z dobranym tlem wg kontrastu WCAG), plus
// dodatkowy baner na ekranie (_pokazBanerZwyciezcy przez vanessa.js).

// Prog zwyciestwa: pierwszy gracz, ktory zgadnie PUNKTY_DO_WYGRANEJ marek,
// wygrywa cala bitwe.
const PUNKTY_DO_WYGRANEJ = 5;

// Limit czasu na zgadniecie POJEDYNCZEJ marki (nie calej bitwy) - liczony
// WYLACZNIE przez hosta w _tickBitwy (this.markaRoundTimer, zerowany w
// kazdym nextRound()). Po uplywie: host odslania nazwe marki
// (_czasMarkiUplynal), po ODSLONIECIE_CZAS_S losuje kolejna.
const LIMIT_CZASU_MARKI_S = 15;
const ODSLONIECIE_CZAS_S = 3;

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
 * dopasowaniem w tokenach odpowiedzi, albo null. Dokladny odpowiednik
 * najlepszyKodDlaOdpowiedzi z flagbattle.js.
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
// SVG marek maja viewBox="0 0 24 24" (kwadrat).
const ROZMIAR_KARTY_LOGO = 512;
// Margines wokol logo na kartce.
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
 * anizotropia. SVG juz ma jawne width/height i viewBox="0 0 24 24", wiec - w
 * odroznieniu od zapewnijWymiarySvg we flagbattle.js - nie trzeba nic do
 * niego dopisywac przed zbudowaniem Bloba. Wynik cache'owany po slugu.
 */
function zaladujTeksturaLogo(slug, renderer) {
  if (cacheTeksturLogo.has(slug)) return cacheTeksturLogo.get(slug);

  const promise = (async () => {
    const canvas = document.createElement('canvas');
    canvas.width = ROZMIAR_KARTY_LOGO;
    canvas.height = ROZMIAR_KARTY_LOGO;
    const ctx = canvas.getContext('2d');

    // Kartka: tlo pelne - bez tego jasne/ciemne logo znikaloby na
    // przezroczystym tle.
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
 * uzywane do komunikatu "czas minal" w miejscu logo oraz do kartki ze
 * zwyciezca bitwy. Odpowiednik renderujTekstNaCanvasie z flagbattle.js,
 * wymiary dopasowane do kwadratowej kartki logo.
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

export class BitwaMarekManager extends MinigraBazowa {
  constructor(scene, renderer) {
    super(scene, renderer, {
      logTag: 'marki',
      nazwaAnnounce: 'Zgadnij markę',
      kolorAnnounce: '#ff2bd6',
      nazwaBitwy: 'bitwa o marki',
      // Wysokosc znacznika: 0.064 - kolejny wolny poziom ponad flagbattle.js
      // (0.052), tlumaczenia.js (0.056), panstwa-miasta.js (0.060).
      markerY: 0.064,
      // Kolor minigry: MAGENTA.
      kolorBazowy: 0xff2bd6,
      // y = 2.05, skala 1.1x1.1 - zmierzone i skopiowane z KARTY_WYSOKOSC w
      // panstwa-miasta.js: rzut na ekran pokazal, ze nad kafelkiem bitwy jest
      // tylko WASKI pas widoczny w kadrze - y=2.5 (flagbattle.js/
      // tlumaczenia.js) lezy juz przy samej gornej krawedzi ekranu na
      // dalekich polach, a y=3.95 wypada 214 px POZA ekranem. Kartka o
      // wysokosci 1.1 na y=2.05 zajmuje Y 1.50-2.60, co miesci sie w kadrze
      // na kazdym polu.
      spriteScale: [1.1, 1.1, 1.0],
      spriteY: 2.05,
      kluczPola: 'marki-pole',
      kluczBojki: 'marki-bojka',
    });

    // Alias na sprite bazowej klasy - src/warstwa-minigier.js (POZA zakresem
    // tego refaktoru, nie wolno go edytowac) czyta go PO NAZWIE
    // ('brandSprite') przez manager[pole]. Ten sam obiekt pod dwiema nazwami,
    // zadnej kopii. revealSprite zostaje bez zmian (nazwa juz zgodna).
    this.brandSprite = this.mainSprite;

    this.currentMarka = null; // slug, np. 'nike'
    this._loadedMarka = null; // ostatnia marka, ktorej tekstura zostala zaladowana (applySync u widza)
    this.markiZgadniete = 0; // Ile marek zgadnieto w obecnej bitwie

    // Limit czasu pojedynczej marki - liczony WYLACZNIE przez hosta w
    // _tickBitwy, zerowany w kazdym nextRound().
    this.markaRoundTimer = 0;
    // Slug marki pokazywany w miejscu logo po uplywie limitu czasu, albo
    // null gdy pokazujemy normalnie logo/nic. Synchronizowany.
    this.odslonietaMarka = null;
    this._loadedOdsloniecie = null; // ostatnia odslonietaMarka narysowana na revealSprite (widz)

    this._brandReqId = 0; // chroni przed wyscigiem, gdy runda zmieni sie zanim async rasteryzacja skonczy
  }

  _kolorPulsBitwy(s) {
    // Puls magenta (miejsce zielonego pulsu flag/pomaranczowego pulsu
    // panstw-miast).
    return [1, s * 0.15, 0.65 + s * 0.25];
  }

  _kolorPulsReward(s) {
    return [1, 0.8 + s * 0.2, 0];
  }

  /**
   * Minigra jest odblokowana dopiero po pokonaniu bossa tieru 4 (Skorpion).
   * Sprawdzane NA BIEZACO w kazdym ticku.
   */
  _czyOdblokowana() {
    return !!(this.economy && Array.isArray(this.economy.state.bossesDefeated) && this.economy.state.bossesDefeated.includes(4));
  }

  _licznikPola() {
    return this.economy.state.licznikMarek;
  }

  _tickBitwy(dt) {
    if (this.currentMarka) {
      this.markaRoundTimer += dt;
      if (this.markaRoundTimer >= LIMIT_CZASU_MARKI_S) {
        this._czasMarkiUplynal();
      }
    }
  }

  _komunikatStartBitwy(p1User, p2User) {
    return `Zgadnij marke! ${p1User} vs ${p2User}! Wpisuj nazwe marki na czacie! Kto pierwszy zdobedzie ${PUNKTY_DO_WYGRANEJ} pkt wygrywa!`;
  }

  _resetLicznikRund() {
    this.markiZgadniete = 0;
  }

  nextRound() {
    if (this.state !== 'BATTLE') return;
    this.markaRoundTimer = 0; // nowa marka = nowy limit czasu (patrz LIMIT_CZASU_MARKI_S)

    // Bez powtorek, dopoki nie zostanie wylosowana CALA pula marek w tej
    // ROZGRYWCE (nie tylko w tej bitwie) - patrz pozycjaBezPowtorek w rng.js
    // i licznikMarek w economy.js (trwaly, zapisywany licznik).
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
        this.mainMaterial.map = texture;
        this.mainMaterial.needsUpdate = true;
        this.mainSprite.visible = true;
      })
      .catch((err) => {
        console.error(`[marki] Blad ladowania tekstury logo ${slug}:`, err);
      });
  }

  _pokazOdslonietaMarke(slug) {
    const nazwa = MARKI[slug] || slug;
    this._pokazOdsloniete(renderujTekstNaCanvasie(['⏰ Czas minął! To była:', nazwa]));
  }

  _invalidujAsynchTeksture() {
    this._brandReqId += 1; // spozniona tekstura logo nie nadpisze kartki zwyciezcy
  }

  _renderujTekstNaCanvasie(linie) {
    return renderujTekstNaCanvasie(linie);
  }

  /**
   * Wolane WYLACZNIE przez hosta z _tickBitwy (patrz LIMIT_CZASU_MARKI_S),
   * gdy biezaca marka nie zostala odgadnieta w limicie czasu. Identyczny
   * wzorzec co _czasFlagiUplynal w flagbattle.js.
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
      this._ukryjOdsloniete();
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

  _resetOdsloniecieNaKoniec() {
    this.odslonietaMarka = null;
    this._loadedOdsloniecie = null;
  }

  _poEndBattle(winnerPlayer) {
    this._pokazBanerZwyciezcy(winnerPlayer);
  }

  /**
   * Widoczny na ekranie baner zwyciezcy (obok istniejacego announce() na
   * czacie) - uzywa wspolnego mechanizmu projektu showTopAnnouncement
   * (./vanessa.js, patrz goldcoin.js/kick.js/main.js po identyczny wzorzec
   * wywolania). Wolane z DWOCH miejsc, zeby baner pokazal sie u KAZDEGO:
   * _poEndBattle (host) i _zastosujWizualiaRundy (widz, w momencie WEJSCIA w
   * stan REWARD). Opakowane w try/catch jak w kick.js - baner nigdy nie moze
   * wywalic logiki konca bitwy.
   */
  _pokazBanerZwyciezcy(winnerPlayer) {
    try {
      showTopAnnouncement(
        `🎉 ${winnerPlayer.username} WYGRYWA!`,
        `Zgadnij markę! Dostaje <strong>${NAGRODA_WYGRANEJ} zł</strong>!`,
        2000,
      );
    } catch (err) {
      console.warn('[marki] Blad w showTopAnnouncement:', err);
    }
  }

  _resetPolaWlasne() {
    this.currentMarka = null;
    this._loadedMarka = null;
    this.markaRoundTimer = 0;
    this.odslonietaMarka = null;
    this._loadedOdsloniecie = null;
  }

  _syncPolaWlasne() {
    return {
      currentMarka: this.currentMarka,
      odslonietaMarka: this.odslonietaMarka,
      markiZgadniete: this.markiZgadniete,
    };
  }

  _zastosujPolaWlasne(s) {
    this.currentMarka = s.currentMarka || null;
    this.odslonietaMarka = s.odslonietaMarka || null;
    this.markiZgadniete = s.markiZgadniete || 0;
  }

  _licznikRundy() {
    return this.markiZgadniete;
  }

  _zastosujWizualiaRundy(prevState) {
    // Baner zwyciezcy u widza: host go juz pokazal w _poEndBattle() u siebie -
    // tutaj wykrywamy WEJSCIE widza w stan REWARD (prevState !== 'REWARD'),
    // nie sam fakt bycia w REWARD, bo applySync leci co snapshot (~co 2s) i
    // baner migalby przy kazdym z nich.
    if (this.state === 'REWARD' && prevState !== 'REWARD' && this.winner) {
      this._pokazBanerZwyciezcy(this.winner);
      this._pokazZwyciezce(this.winner);
    }

    if (this.state === 'REWARD') {
      // Kartka ze zwyciezca juz pokazana wyzej - zostaje widoczna.
    } else if (this.state === 'BATTLE' && this.odslonietaMarka) {
      this.mainSprite.visible = false;
      if (this.odslonietaMarka !== this._loadedOdsloniecie) {
        this._loadedOdsloniecie = this.odslonietaMarka;
        this._pokazOdslonietaMarke(this.odslonietaMarka);
      }
    } else if (this.state === 'BATTLE' && this.currentMarka) {
      this._loadedOdsloniecie = null;
      this._ukryjOdsloniete();
      if (this.currentMarka !== this._loadedMarka) {
        this._loadedMarka = this.currentMarka;
        this._stosujTeksturaLogo(this.currentMarka);
      }
    } else {
      // WAITING (jeszcze bez marki) albo krotka przerwa miedzy odslonieciem
      // a kolejna marka.
      this.mainSprite.visible = false;
      this._loadedOdsloniecie = null;
      this._ukryjOdsloniete();
    }
  }
}
