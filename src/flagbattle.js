import * as THREE from 'three';
import { COUNTRIES, COUNTRY_CODES, tokenizujOdpowiedz, INDEKS_WARIANTOW, FLAGI_BLIZNIACZE } from './countries.js';
import { usunTagiEmotek } from './kick.js';
import { pozycjaBezPowtorek } from './rng.js';
import { MinigraBazowa, klipAtakuDlaRundy } from './minigra-bazowa.js';

// Minigra "Bitwa o flagi" - patrz MinigraBazowa (src/minigra-bazowa.js) po
// wspolny cykl zycia pola/rund/nagrody/plotek/synchronizacji. Ten plik
// zawiera WYLACZNIE to, czym ta minigra realnie sie rozni: pule flag,
// sposob sprawdzania odpowiedzi (dopasowanie najdluzszym ciagiem slow +
// flagi-blizniaki) i teksture/wyglad kartki (rasteryzacja SVG z flag-icons).

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

// Limit czasu na zgadniecie POJEDYNCZEJ flagi (nie calej bitwy): 15 sekund,
// zeby flaga, ktorej nikt nie zna, nie zatrzymywala bitwy na dluzej. Liczony
// WYLACZNIE przez hosta w _tickBitwy (this.flagRoundTimer, zerowany w
// kazdym nextRound()). Po uplywie: host odslania nazwe kraju
// (_czasFlagiUplynal), po ODSLONIECIE_CZAS_S losuje kolejna flage.
const LIMIT_CZASU_FLAGI_S = 15;
const ODSLONIECIE_CZAS_S = 3;

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
 * komunikatu "czas minal" w miejscu flagi oraz do kartki ze zwyciezca bitwy.
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

export class FlagBattleManager extends MinigraBazowa {
  constructor(scene, renderer) {
    super(scene, renderer, {
      logTag: 'flagi',
      nazwaAnnounce: 'Bitwa o flagi',
      kolorAnnounce: 'gold',
      nazwaBitwy: 'bitwa o flagi',
      // Wysokosc znacznika kontestowanego pola. NIE wolno kolidowac z innymi
      // warstwami podlogi areny: 0.025 wierzch kafla podlogi (scene.js),
      // 0.035 neonowa siatka areny (scene.js), 0.042 znaczniki atakow bossa
      // (bossattack.js), 0.048 wskaznik zlotej monety (goldcoin.js). 0.052
      // jest ponad wszystkimi - znacznik bitwy o flagi zawsze wygrywa
      // z-fighting.
      markerY: 0.052,
      kolorBazowy: 0x00ff00,
      spriteScale: [1.4, 1.05, 1.0], // proporcja 4:3 (flagi flag-icons, viewBox 640x480)
      spriteY: 3.0,
      kluczPola: 'flaga-pole',
      kluczBojki: 'flaga-bojka',
    });

    // Aliasy na sprite/material bazowej klasy - src/warstwa-minigier.js (POZA
    // zakresem tego refaktoru, nie wolno go edytowac) czyta je PO NAZWIE
    // ('flagSprite') przez manager[pole], wiec nazwa musi zostac zachowana
    // mimo ze reszta tego pliku odwoluje sie juz do mainSprite/mainMaterial
    // z klasy bazowej. Ten sam obiekt pod dwiema nazwami - zadnej kopii.
    this.flagSprite = this.mainSprite;
    this.flagMaterial = this.mainMaterial;

    this.currentFlag = null; // np. 'PL'
    this._loadedFlag = null; // ostatnia flaga, ktorej tekstura zostala zaladowana (uzywane w applySync u widza)
    this.flagsGuessed = 0; // Ile flag zgadnięto w obecnej bitwie

    // Limit czasu pojedynczej flagi (patrz LIMIT_CZASU_FLAGI_S) - liczony
    // WYLACZNIE przez hosta w _tickBitwy, zerowany w kazdym nextRound().
    this.flagRoundTimer = 0;
    // Kod kraju pokazywany w miejscu flagi po uplywie limitu czasu, albo
    // null gdy pokazujemy normalnie flage/nic. Synchronizowany.
    this.odslonietaFlaga = null;
    this._loadedOdsloniecie = null; // ostatni odslonietaFlaga narysowany na revealSprite (widz)

    this._flagReqId = 0; // chroni przed wyscigiem, gdy runda zmieni sie zanim async rasteryzacja skonczy
  }

  _kolorPulsBitwy(s) {
    return [1, s * 0.5, s * 0.5];
  }

  _kolorPulsReward(s) {
    return [1, 0.8 + s * 0.2, 0];
  }

  _licznikPola() {
    return this.economy.state.licznikFlag;
  }

  _tickBitwy(dt) {
    if (this.currentFlag) {
      this.flagRoundTimer += dt;
      if (this.flagRoundTimer >= LIMIT_CZASU_FLAGI_S) {
        this._czasFlagiUplynal();
      }
    }
  }

  _komunikatStartBitwy(p1User, p2User) {
    return `Bitwa o flagi! ${p1User} vs ${p2User}! Wpisuj nazwę państwa na czacie! Kto pierwszy zdobędzie 5 pkt wygrywa!`;
  }

  _resetLicznikRund() {
    this.flagsGuessed = 0;
  }

  nextRound() {
    if (this.state !== 'BATTLE') return;
    this.flagRoundTimer = 0; // nowa flaga = nowy limit czasu (patrz LIMIT_CZASU_FLAGI_S)

    // Bez powtorek, dopoki nie zostanie wylosowana CALA pula flag w tej
    // ROZGRYWCE (nie tylko w tej bitwie) - patrz pozycjaBezPowtorek w rng.js
    // i licznikFlag w economy.js (trwaly, zapisywany licznik). Wolane
    // WYLACZNIE przez hosta.
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
   * cache'u modulowego zaladujTeksturaFlagi. Uzywane zarowno przez hosta
   * (nextRound, decyzja) jak i widza (applySync, echo decyzji hosta).
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
        this.mainMaterial.map = texture;
        this.mainMaterial.needsUpdate = true;
        this.mainSprite.visible = true;
      })
      .catch((err) => {
        console.error(`[flagi] Blad ladowania tekstury flagi ${kod}:`, err);
      });
  }

  _pokazOdslonietaFlage(kod) {
    const nazwa = COUNTRIES[kod] || kod;
    const grupaBliznieakow = FLAGI_BLIZNIACZE.find((grupa) => grupa.includes(kod));
    const dopisekBliznika = grupaBliznieakow
      ? ` (${grupaBliznieakow.filter((k) => k !== kod).map((k) => COUNTRIES[k]).join(', ')})`
      : '';
    this._pokazOdsloniete(renderujTekstNaCanvasie(['⏰ Czas minął! To była:', `${nazwa}${dopisekBliznika}`]));
  }

  _invalidujAsynchTeksture() {
    this._flagReqId += 1; // spozniona tekstura flagi nie nadpisze kartki zwyciezcy
  }

  _renderujTekstNaCanvasie(linie) {
    return renderujTekstNaCanvasie(linie);
  }

  /**
   * Wolane WYLACZNIE przez hosta z _tickBitwy (patrz LIMIT_CZASU_FLAGI_S),
   * gdy biezaca flaga nie zostala odgadnieta w limicie czasu. Blokuje
   * spoznione trafienie (currentFlag = null - onChatMessage juz nic z tym
   * nie zrobi), pokazuje nazwe kraju w miejscu flagi i po
   * ODSLONIECIE_CZAS_S losuje kolejna runde. mojeBattleId chroni przed
   * wyscigiem: jesli bitwa sie w miedzyczasie skonczy/zmieni, setTimeout nie
   * odpali juz nextRound() po fakcie.
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
      this._ukryjOdsloniete();
      this.nextRound();
    }, ODSLONIECIE_CZAS_S * 1000);
  }

  onChatMessage(username, content) {
    // Ocena odpowiedzi to decyzja - tylko host jej dokonuje.
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
      // z flagsGuessed, zeby widz policzyl DOKLADNIE to samo z
      // zsynchronizowanego flagsGuessed w applySync.
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

  _resetOdsloniecieNaKoniec() {
    this.odslonietaFlaga = null;
    this._loadedOdsloniecie = null;
  }

  _resetPolaWlasne() {
    this.currentFlag = null;
    this._loadedFlag = null;
    this.flagRoundTimer = 0;
    this.odslonietaFlaga = null;
    this._loadedOdsloniecie = null;
  }

  _syncPolaWlasne() {
    return {
      currentFlag: this.currentFlag,
      odslonietaFlaga: this.odslonietaFlaga,
      flagsGuessed: this.flagsGuessed,
    };
  }

  _zastosujPolaWlasne(s) {
    this.currentFlag = s.currentFlag || null;
    this.odslonietaFlaga = s.odslonietaFlaga || null;
    this.flagsGuessed = s.flagsGuessed || 0;
  }

  _licznikRundy() {
    return this.flagsGuessed;
  }

  _zastosujWizualiaRundy(prevState) {
    if (this.state === 'REWARD') {
      if (prevState !== 'REWARD' && this.winner) {
        this._pokazZwyciezce(this.winner);
      }
    } else if (this.state === 'BATTLE' && this.odslonietaFlaga) {
      // Timeout pojedynczej flagi - host juz policzyl to sam, widz tylko
      // odtwarza gotowa decyzje z tego snapshotu.
      this.mainSprite.visible = false;
      if (this.odslonietaFlaga !== this._loadedOdsloniecie) {
        this._loadedOdsloniecie = this.odslonietaFlaga;
        this._pokazOdslonietaFlage(this.odslonietaFlaga);
      }
    } else if (this.state === 'BATTLE' && this.currentFlag) {
      this._loadedOdsloniecie = null;
      this._ukryjOdsloniete();
      if (this.currentFlag !== this._loadedFlag) {
        this._loadedFlag = this.currentFlag;
        this._stosujTeksturaFlagi(this.currentFlag);
      }
    } else {
      // WAITING (jeszcze bez flagi) albo krotka przerwa miedzy odslonieciem
      // a kolejna flaga.
      this.mainSprite.visible = false;
      this._loadedOdsloniecie = null;
      this._ukryjOdsloniete();
    }
  }
}
