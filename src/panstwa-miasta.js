import * as THREE from 'three';
import { KATEGORIE, LITERY_DOZWOLONE, dopasujOdpowiedzi } from './panstwa-miasta-dane.js';
import { usunTagiEmotek } from './kick.js';
import { pozycjaBezPowtorek } from './rng.js';
import { MinigraBazowa, klipAtakuDlaRundy, NAGRODA_WYGRANEJ } from './minigra-bazowa.js';

// Minigra "Panstwa-Miasta" - patrz MinigraBazowa (src/minigra-bazowa.js) po
// wspolny cykl zycia pola/rund/nagrody/plotek/synchronizacji. Ten plik
// zawiera WYLACZNIE to, czym ta minigra realnie sie rozni: losowana jest
// litera, a kazdy z dwoch graczy ma wlasna rubryke trzech kategorii
// (Panstwo/Imie/Owoc - patrz src/panstwa-miasta-dane.js), ktora wypelnia
// odpowiedziami z czatu, plus wlasny wyswietlacz rubryk nad glowami graczy
// (_aktualizujRubryki/_zapewnijRubryki/_usunRubryki/_rysujRubrykeTekstura),
// ktorego pozostale minigry nie maja.

// Prog zwyciestwa bitwy panstw-miast: pierwszy gracz, ktory wygra
// PUNKTY_DO_WYGRANEJ RUND (nie pojedynczych odpowiedzi - runda = jedna
// litera), wygrywa cala bitwe.
const PUNKTY_DO_WYGRANEJ = 3;

// Limit czasu POJEDYNCZEJ RUNDY (jednej litery) - zabezpieczenie przed
// zwisem rundy, gdy zaden gracz nie zdola wypelnic rubryki. Liczony
// WYLACZNIE przez hosta w _tickBitwy (this.rundaTimer, zerowany w kazdym
// nextRound()).
const LIMIT_CZASU_RUNDY_S = 90;

// Rozmiar canvasu karty z litera.
const SZEROKOSC_KARTY = 384;
const WYSOKOSC_KARTY = 384;

// Wszystkie trzy karty (litera + 2 rubryki) w JEDNYM poziomym pasie nad
// kafelkiem bitwy. Rzut na ekran (1280x720) pokazal, ze nad kafelkiem jest
// tylko waski pas widoczny w kadrze - poziom y=2.5 uzywany przez flagbattle/
// tlumaczenia lezy juz przy samej gornej krawedzi ekranu na dalekich polach,
// wiec pietrowy uklad (karta wyzej niz rubryki) nie miesci sie. Dlatego karty
// ida OBOK SIEBIE w osi X wzgledem srodka kafelka (this.tile), a nie jedna
// nad druga.
// KARTY_WYSOKOSC = 2.05: karta o wysokosci 1.1 zajmuje wtedy Y 1.50-2.60, co
// miesci sie w kadrze nawet na najgorszym polu.
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
 * THREE.CanvasTexture. Czysto lokalne rysowanie tekstu - SYNCHRONICZNA, tak
 * samo jak zaladujTeksturaSlowa w tlumaczenia.js. Wynik cache'owany po
 * literze.
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
 * Rysuje kilka wierszy tekstu na canvasie karty litery i zwraca
 * CanvasTexture - uzywane do kartki ze zwyciezca bitwy. NIE cache'owane po
 * kluczu - nick zwyciezcy jest jednorazowy.
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

/** Pusta rubryka: jeden klucz per kategoria z panstwa-miasta-dane.js, wartosc null = jeszcze nie wypelnione. */
function pustaRubryka() {
  return Object.fromEntries(KATEGORIE.map((k) => [k.id, null]));
}

export class PanstwaMiastaManager extends MinigraBazowa {
  constructor(scene, renderer) {
    super(scene, renderer, {
      logTag: 'panstwa-miasta',
      nazwaAnnounce: 'Panstwa-Miasta',
      kolorAnnounce: '#ff9f1c',
      nazwaBitwy: 'bitwa panstw-miast',
      // Wysokosc znacznika: 0.060 - kolejny wolny poziom ponad flagbattle.js
      // (0.052) i tlumaczenia.js (0.056).
      markerY: 0.060,
      // Kolor minigry: POMARANCZOWY.
      kolorBazowy: 0xff9f1c,
      spriteScale: [1.1, 1.1, 1.0],
      spriteY: KARTY_WYSOKOSC,
      kluczPola: 'panstwa-miasta-pole',
      kluczBojki: 'panstwa-miasta-bojka',
    });

    // Alias na sprite bazowej klasy - src/warstwa-minigier.js (POZA zakresem
    // tego refaktoru, nie wolno go edytowac) czyta go PO NAZWIE
    // ('letterSprite') przez manager[pole]. Ten sam obiekt pod dwiema
    // nazwami, zadnej kopii. rubrykaSprites zostaje bez zmian (patrz nizej).
    this.letterSprite = this.mainSprite;

    this.litera = null;
    this._loadedLitera = null; // ostatnia litera zaladowana na sprite (applySync u widza)

    // uzyteId - zbior identyfikatorow odpowiedzi juz wykorzystanych W TEJ
    // RUNDZIE (przez KTOREGOKOLWIEK z dwoch graczy) - patrz onChatMessage.
    // Zerowany w kazdym nextRound(). NIE synchronizowany osobno - widz
    // odtwarza go posrednio z players[].rubryka w applySync.
    this.uzyteId = new Set();

    // rundWygranych - ile rund w TEJ BITWIE zostalo juz rozstrzygnietych
    // wygrana. Sluzy WYLACZNIE do deterministycznego wyboru klipu ataku.
    this.rundWygranych = 0;

    // Limit czasu pojedynczej rundy - liczony WYLACZNIE przez hosta,
    // zerowany w kazdym nextRound(). NIE synchronizowany (host-only decyzja).
    this.rundaTimer = 0;

    // Rubryki nad glowami graczy - 2 sprite'y (jeden na gracza), tworzone
    // leniwie dopiero gdy bitwa faktycznie startuje i sprzatane natychmiast
    // po jej koncu - identyczny wzorzec cyklu zycia co plotki.
    this.rubrykaSprites = [];
  }

  _kolorPulsBitwy(s) {
    // Puls pomaranczowy (miejsce zielonego pulsu flag/niebiesko-fioletowego
    // tlumaczen).
    return [1, 0.5 + s * 0.3, 0.05 + s * 0.2];
  }

  _kolorPulsReward(s) {
    return [1, 0.7 + s * 0.3, 0.2];
  }

  /**
   * Minigra jest odblokowana dopiero po pokonaniu bossa tieru 3 (Dzordzo).
   * Sprawdzane NA BIEZACO w kazdym ticku.
   */
  _czyOdblokowana() {
    return !!(this.economy && Array.isArray(this.economy.state.bossesDefeated) && this.economy.state.bossesDefeated.includes(3));
  }

  _licznikPola() {
    return this.economy.state.licznikLiter;
  }

  _tickBitwy(dt) {
    if (this.litera) {
      this.rundaTimer += dt;
      if (this.rundaTimer >= LIMIT_CZASU_RUNDY_S) {
        this._czasRundyUplynal();
      }
    }
  }

  _aktualizujDodatkoweWizualia(_dt) {
    this._aktualizujRubryki();
  }

  _usunDodatkoweWizualia() {
    this._usunRubryki();
  }

  _stworzGraczy(p1, p1User, p2, p2User) {
    return [
      { typeIndex: p1.typeIndex, username: p1User, score: 0, rubryka: pustaRubryka() },
      { typeIndex: p2.typeIndex, username: p2User, score: 0, rubryka: pustaRubryka() },
    ];
  }

  _resetLicznikRund() {
    this.rundWygranych = 0;
  }

  _komunikatStartBitwy(p1User, p2User) {
    return `Panstwa-Miasta! ${p1User} vs ${p2User}! Wpisujcie na czacie Panstwo/Imie/Owoc na litere. Kto pierwszy zdobedzie ${PUNKTY_DO_WYGRANEJ} rundy wygrywa!`;
  }

  nextRound() {
    if (this.state !== 'BATTLE') return;
    this.rundaTimer = 0; // nowa litera = nowy limit czasu (patrz LIMIT_CZASU_RUNDY_S)

    for (const p of this.players) p.rubryka = pustaRubryka();
    this.uzyteId = new Set();

    // Bez powtorek, dopoki nie zostanie wylosowana CALA pula liter w tej
    // ROZGRYWCE (nie tylko w tej bitwie) - patrz pozycjaBezPowtorek w rng.js
    // i licznikLiter w economy.js (trwaly, zapisywany licznik).
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
   * Ustawia teksture sprite'a litery - synchroniczne rysowanie canvasu, tak
   * samo jak _stosujTeksturaSlowa w tlumaczenia.js - bez ochrony przed
   * wyscigiem, bo nie ma tu nic asynchronicznego.
   */
  _stosujTeksturaLitery(litera) {
    const texture = zaladujTeksturaLitery(litera, this.renderer);
    this.mainMaterial.map = texture;
    this.mainMaterial.needsUpdate = true;
    this.mainSprite.visible = true;
  }

  _renderujTekstNaCanvasie(linie) {
    return renderujTekstNaCanvasie(linie);
  }

  /**
   * Wolane WYLACZNIE przez hosta z _tickBitwy (patrz LIMIT_CZASU_RUNDY_S),
   * gdy zaden z dwoch graczy nie wypelnil rubryki w limicie czasu. Bez
   * punktu dla kogokolwiek - od razu nowa litera (w odroznieniu od
   * _czasFlagiUplynal we flagbattle.js nie ma tu opoznionego "odsloniecia" -
   * spec tej minigry nie przewiduje pokazywania poprawnych odpowiedzi, bo
   * kategorie maja wiele poprawnych odpowiedzi na litere, nie jedna).
   */
  _czasRundyUplynal() {
    this.announce('⏰ Czas minął! Nikt nie zdążył wypełnić rubryki - nowa litera!');
    this.nextRound();
  }

  onChatMessage(username, content) {
    if (!this.isHost) return;
    if (this.state !== 'BATTLE' || !this.litera) return;

    const player = this.players.find((p) => p.username.toLowerCase() === username.toLowerCase());
    if (!player) return; // widzowie spoza bitwy sa ignorowani

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

  _komunikatWygranej(winnerPlayer) {
    return `🎉 ${winnerPlayer.username} WYGRYWA BITWĘ PAŃSTWA-MIASTA! Dostaje ${NAGRODA_WYGRANEJ} zł!`;
  }

  /**
   * Rubryka nad glowa kazdego gracza (2 sprite'y, jeden na gracza) - tworzone
   * leniwie, gdy bitwa jest aktywna i sprzatane, gdy nie jest. Wolane co
   * klatke z tick() (u hosta i u widza - kosmetyka wyprowadzona ze
   * zsynchronizowanego stanu this.state/this.players, dokladnie jak
   * _aktualizujPlotki). Tekstura przerysowywana TYLKO gdy zawartosc rubryki
   * FAKTYCZNIE sie zmienila (porownanie z ostatnio narysowanym podpisem) -
   * nie co klatke.
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

  /** Usuwa sprite'y rubryk ze sceny i zwalnia ich tekstury/materialy. */
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

  _resetPolaWlasne() {
    this.litera = null;
    this._loadedLitera = null;
    this.uzyteId = new Set();
    this.rundWygranych = 0;
    this.rundaTimer = 0;
  }

  _syncPolaWlasne() {
    return {
      litera: this.litera,
      rundWygranych: this.rundWygranych,
    };
  }

  _zastosujPolaWlasne(s) {
    this.litera = s.litera || null;
    this.rundWygranych = s.rundWygranych || 0;
  }

  _licznikRundy() {
    return this.rundWygranych;
  }

  _zastosujWizualiaRundy(prevState) {
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
      // WAITING (jeszcze bez litery). REWARD jest juz obsluzony osobno wyzej.
      this.mainSprite.visible = false;
    }
    // Rubryki: tworzone/sprzatane/przerysowywane w tick() -> _aktualizujRubryki(),
    // ktora czyta this.state/this.players juz zaktualizowane wczesniej w
    // applySync - nie trzeba tu nic dodatkowo robic (ten sam wzorzec co plotki).
  }
}
