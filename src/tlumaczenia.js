import * as THREE from 'three';
import {
  SLOWKA,
  ENGLISH_WORDS,
  tokenizujOdpowiedzSlowka,
  INDEKS_WARIANTOW_SLOWEK,
} from './slowka.js';
import { usunTagiEmotek } from './kick.js';
import { pozycjaBezPowtorek } from './rng.js';
import { MinigraBazowa, klipAtakuDlaRundy, NAGRODA_WYGRANEJ } from './minigra-bazowa.js';

// Minigra "Tlumaczenia" - patrz MinigraBazowa (src/minigra-bazowa.js) po
// wspolny cykl zycia pola/rund/nagrody/plotek/synchronizacji. Ten plik
// zawiera WYLACZNIE to, czym ta minigra realnie sie rozni: pule angielskich
// slowek, sposob sprawdzania odpowiedzi (dopasowanie akceptowanych polskich
// wariantow z slowka.js) i teksture/wyglad flashcardy.

// Prog zwyciestwa bitwy tlumaczen - "best of 9": pierwszy gracz, ktory
// zdobedzie PUNKTY_DO_WYGRANEJ punktow, wygrywa; przy max. rownej grze
// (PUNKTY_DO_WYGRANEJ - 1 : PUNKTY_DO_WYGRANEJ - 1) bitwa rozstrzyga sie w
// najwyzej 2 * PUNKTY_DO_WYGRANEJ - 1 = 9 rundach. Wszystkie miejsca w tym
// pliku MUSZA czytac ta stala, a nie miec wpisanej liczby na sztywno.
const PUNKTY_DO_WYGRANEJ = 5;

// Rozmiar canvasu karty ze slowem.
const SZEROKOSC_KARTY = 512;
const WYSOKOSC_KARTY = 256;

/**
 * Rysuje kafelek-flashcard z angielskim slowem na canvasie i zwraca
 * THREE.CanvasTexture. W odroznieniu od flag (pobieranie SVG z sieci) to
 * czysto lokalne rysowanie tekstu - bez fetch, bez asynchronicznego wyscigu,
 * wiec funkcja jest SYNCHRONICZNA. Wynik cache'owany po slowie (Map w
 * module) - to samo slowo nigdy nie rysuje canvasu drugi raz w tej samej
 * sesji karty.
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
 * Rysuje kilka wierszy tekstu na canvasie karty slowa i zwraca
 * CanvasTexture - uzywane do kartki ze zwyciezca bitwy. NIE cache'owane po
 * kluczu - nick zwyciezcy jest jednorazowy.
 *
 * Dopasowanie fontu: kazda linia dostaje WLASNY rozmiar, zmierzony przez
 * ctx.measureText i zmniejszany o 2px, dopoki nie zmiesci sie w szerokosci
 * karty (margines 20px z kazdej strony) albo nie osiagnie minimalnego
 * czytelnego rozmiaru (16px).
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

export class TlumaczeniaManager extends MinigraBazowa {
  constructor(scene, renderer) {
    super(scene, renderer, {
      logTag: 'tlumaczenia',
      nazwaAnnounce: 'Tlumaczenia',
      kolorAnnounce: '#8f6bff',
      nazwaBitwy: 'bitwa tlumaczen',
      // Wysokosc znacznika: 0.056 - kolejny wolny poziom ponad flagbattle.js
      // (0.052) i resztą warstw podlogi areny (patrz tamten komentarz).
      markerY: 0.056,
      // Kolor minigry: NIEBIESKI/FIOLETOWY - wyraznie inny niz reszta
      // zajetych kolorow w projekcie.
      kolorBazowy: 0x3d5cff,
      spriteScale: [1.8, 0.9, 1.0],
      spriteY: 3.0,
      kluczPola: 'tlumaczenia-pole',
      kluczBojki: 'tlumaczenia-bojka',
    });

    // Alias na sprite bazowej klasy - src/warstwa-minigier.js (POZA zakresem
    // tego refaktoru, nie wolno go edytowac) czyta go PO NAZWIE ('wordSprite')
    // przez manager[pole]. Ten sam obiekt pod dwiema nazwami, zadnej kopii.
    this.wordSprite = this.mainSprite;

    this.currentWord = null; // np. 'car'
    this._loadedWord = null; // ostatnie zaladowane slowo (applySync u widza)
    this.wordsGuessed = 0;
  }

  _kolorPulsBitwy(s) {
    // Puls niebiesko-fioletowy (miejsce czerwonego pulsu flag).
    return [0.24 + s * 0.2, 0.36 + s * 0.15, 1];
  }

  _kolorPulsReward(s) {
    // Poswiata cyjanowo-fioletowa (miejsce zlota flag) - nadal w rodzinie
    // niebiesko-fioletowej calej minigry.
    return [0.5 + s * 0.1, 0.3 + s * 0.2, 1];
  }

  /**
   * Minigra jest odblokowana dopiero po pokonaniu bossa tieru 2 (Kowal_88).
   * Sprawdzane NA BIEZACO w kazdym ticku (patrz MinigraBazowa.tick), a nie
   * raz przy starcie.
   */
  _czyOdblokowana() {
    return !!(this.economy && Array.isArray(this.economy.state.bossesDefeated) && this.economy.state.bossesDefeated.includes(2));
  }

  _licznikPola() {
    return this.economy.state.licznikSlowek;
  }

  _komunikatStartBitwy(p1User, p2User) {
    return `Bitwa tlumaczen! ${p1User} vs ${p2User}! Tlumacz slowo na polski na czacie! Kto pierwszy zdobedzie ${PUNKTY_DO_WYGRANEJ} pkt wygrywa!`;
  }

  _resetLicznikRund() {
    this.wordsGuessed = 0;
  }

  nextRound() {
    if (this.state !== 'BATTLE') return;

    // Bez powtorek, dopoki nie zostanie wylosowana CALA pula slowek w tej
    // ROZGRYWCE (nie tylko w tej bitwie) - patrz pozycjaBezPowtorek w rng.js
    // i licznikSlowek w economy.js (trwaly, zapisywany licznik).
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
   * generowanie karty jest synchroniczne, wiec nie potrzeba ochrony przed
   * wyscigiem.
   */
  _stosujTeksturaSlowa(word) {
    const texture = zaladujTeksturaSlowa(word, this.renderer);
    this.mainMaterial.map = texture;
    this.mainMaterial.needsUpdate = true;
    this.mainSprite.visible = true;
  }

  _renderujTekstNaCanvasie(linie) {
    return renderujTekstNaCanvasie(linie);
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

  _komunikatWygranej(winnerPlayer) {
    return `🎉 ${winnerPlayer.username} WYGRYWA BITWE TLUMACZEN! Dostaje ${NAGRODA_WYGRANEJ} zł!`;
  }

  _resetPolaWlasne() {
    this.currentWord = null;
    this._loadedWord = null;
  }

  _syncPolaWlasne() {
    return {
      currentWord: this.currentWord,
      wordsGuessed: this.wordsGuessed,
    };
  }

  _zastosujPolaWlasne(s) {
    this.currentWord = s.currentWord || null;
    this.wordsGuessed = s.wordsGuessed || 0;
  }

  _licznikRundy() {
    return this.wordsGuessed;
  }

  _zastosujWizualiaRundy(prevState) {
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
      // WAITING (jeszcze bez slowa). REWARD jest juz obsluzony osobno wyzej.
      this.mainSprite.visible = false;
    }
  }
}
