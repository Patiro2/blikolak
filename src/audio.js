// Menedzer dzwieku gry - czysty Web Audio API (AudioContext + decodeAudioData +
// AudioBufferSourceNode). CELOWO bez elementow <audio> - przy serii stu "klik"
// z czatu Kicka element <audio> zaciolby sie / nie zdazylby zresetowac currentTime,
// a AudioBufferSourceNode mozna odpalac dowolnie czesto z jednego zdekodowanego bufora.

const STORAGE_KEY = 'bankomat-clicker-audio-v1';
const AUDIO_BASE = 'assets/audio/';

// Globalny limit rownoleglych zrodel dzwieku - bez tego spam "klik" + krok +
// boss naraz potrafilby odpalic dziesiatki jednoczesnych AudioBufferSourceNode
// i zdusic przegladarke / zniekszalcic miks.
const GLOBAL_MAX_VOICES = 12;

/**
 * Mapa zdarzen dzwiekowych - JEDYNE miejsce, ktore trzeba zmienic, zeby
 * podmienic plik dla danego zdarzenia (np. gdy streamerowi sie nie spodoba).
 * Pola:
 *   pliki          - lista plikow wzgledem assets/audio/ (sciezki z podkatalogow
 *                     ze spacjami sa tu podane "na zwykle", encodeURI dzieje sie przy fetch)
 *   tryb           - 'losowy' (domyslnie, gra jeden losowy plik z listy) albo
 *                     'wszystkie' (gra WSZYSTKIE pliki z listy naraz - np. boss-wejscie)
 *   glosnosc       - mnoznik glosnosci tego zdarzenia (0..1), mnozony przez glosnosc globalna
 *   cooldownMs     - minimalny odstep miedzy kolejnymi odtworzeniami TEGO zdarzenia
 *   maxJednoczesnie- ile glosow TEGO zdarzenia moze grac naraz
 *   wysokoscVar    - losowa odchylka playbackRate w ulamku (np. 0.08 = ±8%)
 */
export const SOUND_MAP = {
  'klik': {
    pliki: ['chip-lay-1.ogg', 'chip-lay-2.ogg', 'chip-lay-3.ogg'],
    glosnosc: 0.35,
    cooldownMs: 40,
    maxJednoczesnie: 3,
    wysokoscVar: 0.08,
  },
  'klik-gracz': {
    pliki: ['click_001.ogg'],
    glosnosc: 0.55,
    cooldownMs: 60,
    maxJednoczesnie: 2,
    wysokoscVar: 0.05,
  },
  'kryt': {
    pliki: ['powerUp7.ogg'],
    glosnosc: 0.55,
    cooldownMs: 120,
    maxJednoczesnie: 2,
    wysokoscVar: 0.05,
  },
  'kombo': {
    // Tylko na progach kombo (co 5 stopni) - wywolujace main.js pilnuje progu,
    // nie ten modul (patrz komentarz w main.js przy onKlik).
    pliki: ['highUp.ogg'],
    glosnosc: 0.5,
    cooldownMs: 250,
    maxJednoczesnie: 1,
    wysokoscVar: 0.04,
  },
  'moneta-spawn': {
    pliki: ['maximize_006.ogg'],
    glosnosc: 0.45,
    cooldownMs: 200,
    maxJednoczesnie: 1,
    wysokoscVar: 0.03,
  },
  'moneta-zebrana': {
    // Krotki, jasny dzwiek nagrody zamiast poprzedniego jingla stalowego
    // (jingles_STEEL01) - ten byl dluzszy i bardziej muzyczny niz trzeba przy
    // zdarzeniu, ktore moze sie powtarzac co kilkanascie sekund. Do podmiany
    // wystarczy zmienic nazwe pliku ponizej.
    pliki: ['powerUp2.ogg'],
    glosnosc: 0.6,
    cooldownMs: 200,
    maxJednoczesnie: 1,
    wysokoscVar: 0.04,
  },
  'awans-bankomatu': {
    pliki: ['Sax jingles/jingles_SAX00.ogg'],
    glosnosc: 0.65,
    cooldownMs: 500,
    maxJednoczesnie: 1,
    wysokoscVar: 0.0,
  },
  'krok': {
    pliki: [
      'footstep_concrete_000.ogg',
      'footstep_concrete_001.ogg',
      'footstep_concrete_002.ogg',
      'footstep_concrete_003.ogg',
      'footstep_concrete_004.ogg',
    ],
    glosnosc: 0.2,
    cooldownMs: 60,
    maxJednoczesnie: 4,
    wysokoscVar: 0.08,
  },
  'boss-wejscie': {
    pliki: ['lowFrequency_explosion_000.ogg', 'spaceEngineLow_000.ogg'],
    tryb: 'wszystkie',
    glosnosc: 0.6,
    cooldownMs: 1000,
    maxJednoczesnie: 2,
    wysokoscVar: 0.03,
  },
  'boss-uderzenie': {
    pliki: ['explosionCrunch_002.ogg', 'impactMetal_heavy_001.ogg'],
    tryb: 'wszystkie',
    glosnosc: 0.65,
    cooldownMs: 500,
    maxJednoczesnie: 2,
    wysokoscVar: 0.03,
  },
  'boss-dzialanie': {
    pliki: ['question_001.ogg'],
    glosnosc: 0.45,
    cooldownMs: 300,
    maxJednoczesnie: 1,
    wysokoscVar: 0.03,
  },
  'boss-tik': {
    pliki: ['tick_002.ogg'],
    glosnosc: 0.4,
    cooldownMs: 800,
    maxJednoczesnie: 1,
    wysokoscVar: 0.0,
  },
  'boss-trafienie': {
    pliki: ['impactPunch_heavy_001.ogg', 'confirmation_002.ogg'],
    tryb: 'wszystkie',
    glosnosc: 0.55,
    cooldownMs: 150,
    maxJednoczesnie: 2,
    wysokoscVar: 0.04,
  },
  'boss-zabija': {
    pliki: ['error_006.ogg', 'lowDown.ogg'],
    tryb: 'wszystkie',
    glosnosc: 0.55,
    cooldownMs: 300,
    maxJednoczesnie: 2,
    wysokoscVar: 0.03,
  },
  'omdlenie': {
    pliki: ['phaserDown2.ogg'],
    glosnosc: 0.5,
    cooldownMs: 200,
    maxJednoczesnie: 1,
    wysokoscVar: 0.03,
  },
  'ratunek': {
    pliki: ['powerUp3.ogg'],
    glosnosc: 0.5,
    cooldownMs: 200,
    maxJednoczesnie: 1,
    wysokoscVar: 0.03,
  },
  'boss-pokonany': {
    pliki: ['Sax jingles/jingles_SAX07.ogg'],
    glosnosc: 0.7,
    cooldownMs: 500,
    maxJednoczesnie: 1,
    wysokoscVar: 0.0,
  },
  'vanessa-spawn': {
    // Jingiel pizzicato - krotki, "skradajacy sie na paluszkach" motyw smyczkowy,
    // lepiej pasujacy do zlodziejki niz poprzedni doorOpen+glitch (odglos
    // otwieranych drzwi + cyfrowy usterkowy szum). Wybrany z 17 plikow w
    // assets/audio/Pizzicato jingles/ - zdekodowane dlugosci (AudioBuffer.duration,
    // Web Audio API) wahaly sie od 0.46 do 1.32 s; PIZZI07 (1.324 s) jest
    // najdluzszy z calej paczki, co przy tym stylu (pizzicato) odpowiada pelnej
    // wstepujaco-zstepujacej frazie "na paluszkach", a nie tylko 2-3 nutom.
    pliki: ['Pizzicato jingles/jingles_PIZZI07.ogg'],
    glosnosc: 0.5,
    cooldownMs: 500,
    maxJednoczesnie: 1,
    wysokoscVar: 0.03,
  },
  'vanessa-kradnie': {
    pliki: ['chips-handle-2.ogg'],
    glosnosc: 0.25,
    cooldownMs: 200,
    maxJednoczesnie: 1,
    wysokoscVar: 0.06,
  },
  'vanessa-przegoniona': {
    pliki: ['zapThreeToneUp.ogg'],
    glosnosc: 0.55,
    cooldownMs: 200,
    maxJednoczesnie: 1,
    wysokoscVar: 0.0,
  },
  'vanessa-ucieka': {
    pliki: ['zapThreeToneDown.ogg'],
    glosnosc: 0.55,
    cooldownMs: 200,
    maxJednoczesnie: 1,
    wysokoscVar: 0.0,
  },
  'ui-klik': {
    pliki: ['switch_002.ogg'],
    glosnosc: 0.4,
    cooldownMs: 60,
    maxJednoczesnie: 2,
    wysokoscVar: 0.02,
  },
  // Boss 3 (Dzordzo, blackjack) - patrz src/boss-blackjack.js
  'bj-rozdanie': {
    pliki: ['card-shuffle.ogg', 'cards-pack-open-1.ogg'],
    tryb: 'wszystkie',
    glosnosc: 0.5,
    cooldownMs: 400,
    maxJednoczesnie: 1,
    wysokoscVar: 0.02,
  },
  'bj-karta': {
    pliki: ['card-slide-1.ogg', 'card-slide-2.ogg', 'card-slide-3.ogg', 'card-slide-4.ogg', 'card-place-1.ogg', 'card-place-2.ogg'],
    glosnosc: 0.45,
    cooldownMs: 80,
    maxJednoczesnie: 3,
    wysokoscVar: 0.06,
  },
  'bj-wygrana': {
    pliki: ['Hit jingles/jingles_HIT05.ogg'],
    glosnosc: 0.6,
    cooldownMs: 400,
    maxJednoczesnie: 1,
    wysokoscVar: 0.0,
  },
  'bj-przegrana': {
    pliki: ['error_004.ogg', 'lowDown.ogg'],
    tryb: 'wszystkie',
    glosnosc: 0.55,
    cooldownMs: 400,
    maxJednoczesnie: 2,
    wysokoscVar: 0.02,
  },
  'game-over': {
    pliki: ['phaserDown3.ogg', 'impactBell_heavy_004.ogg'],
    tryb: 'wszystkie',
    glosnosc: 0.7,
    cooldownMs: 1000,
    maxJednoczesnie: 2,
    wysokoscVar: 0.0,
  },
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { glosnosc: 0.8, wyciszony: false };
    const parsed = JSON.parse(raw);
    const glosnosc = typeof parsed.glosnosc === 'number' && isFinite(parsed.glosnosc)
      ? Math.min(1, Math.max(0, parsed.glosnosc))
      : 0.8;
    const wyciszony = !!parsed.wyciszony;
    return { glosnosc, wyciszony };
  } catch (e) {
    console.warn('[audio] Nie udalo sie wczytac ustawien dzwieku', e);
    return { glosnosc: 0.8, wyciszony: false };
  }
}

export class AudioManager {
  constructor() {
    this.ctx = null;
    this.masterGain = null;

    const settings = loadSettings();
    this._volume = settings.glosnosc; // 0..1
    this._muted = settings.wyciszony;

    this.buffers = new Map(); // plik(sciezka wzgledna) -> AudioBuffer
    this.disabledEvents = new Set(); // nazwy zdarzen wylaczone po nieudanym zaladowaniu
    this._warnedEvents = new Set();

    this._lastPlayMs = new Map(); // nazwa zdarzenia -> ostatni czas odtworzenia
    this._activeVoicesByEvent = new Map(); // nazwa zdarzenia -> licznik aktywnych glosow
    this._activeVoicesTotal = 0;

    this._unlocked = false;
    this._preloadStarted = false;

    this._bindUnlock();
  }

  // --- Odblokowanie AudioContext (autoplay policy) ---
  _bindUnlock() {
    const unlock = () => {
      if (this._unlocked) return;
      this._ensureContext();
      if (this.ctx && this.ctx.state === 'suspended') {
        this.ctx.resume().catch(() => {});
      }
      this._unlocked = true;
      document.removeEventListener('pointerdown', unlock);
      document.removeEventListener('keydown', unlock);
    };
    document.addEventListener('pointerdown', unlock);
    document.addEventListener('keydown', unlock);
  }

  _ensureContext() {
    if (this.ctx) return this.ctx;
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      this.ctx = new Ctx();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this._effectiveVolume();
      this.masterGain.connect(this.ctx.destination);
    } catch (e) {
      console.warn('[audio] Nie udalo sie utworzyc AudioContext', e);
      this.ctx = null;
    }
    return this.ctx;
  }

  _effectiveVolume() {
    return this._muted ? 0 : this._volume;
  }

  _saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ glosnosc: this._volume, wyciszony: this._muted }));
    } catch (e) {
      console.warn('[audio] Nie udalo sie zapisac ustawien dzwieku', e);
    }
  }

  // --- Ustawienia glosnosci / wyciszenia ---
  setVolume(v) {
    this._volume = Math.min(1, Math.max(0, v));
    if (this.masterGain) this.masterGain.gain.value = this._effectiveVolume();
    this._saveSettings();
  }

  getVolume() {
    return this._volume;
  }

  setMuted(muted) {
    this._muted = !!muted;
    if (this.masterGain) this.masterGain.gain.value = this._effectiveVolume();
    this._saveSettings();
  }

  toggleMuted() {
    this.setMuted(!this._muted);
    return this._muted;
  }

  isMuted() {
    return this._muted;
  }

  // --- Ladowanie / dekodowanie plikow ---
  async _fetchAndDecode(relPath) {
    if (this.buffers.has(relPath)) return this.buffers.get(relPath);
    const ctx = this._ensureContext();
    if (!ctx) throw new Error('Brak AudioContext');

    const url = AUDIO_BASE + encodeURI(relPath);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} przy ${url}`);
    const arrayBuf = await res.arrayBuffer();
    const audioBuf = await new Promise((resolve, reject) => {
      // decodeAudioData ma dwa API (Promise i callback) - callback dziala wszedzie.
      const maybePromise = ctx.decodeAudioData(arrayBuf, resolve, reject);
      if (maybePromise && typeof maybePromise.then === 'function') {
        maybePromise.then(resolve, reject);
      }
    });
    this.buffers.set(relPath, audioBuf);
    return audioBuf;
  }

  /**
   * Preload TYLKO plikow z SOUND_MAP, rownolegle z limitem wspolbieznosci
   * (ten sam problem prostego serwera dev co w assets.js: enqueue/MAX_CONCURRENT_LOADS).
   * NIE blokuje startu gry - main.js nie czeka na ten Promise.
   */
  async preload() {
    if (this._preloadStarted) return;
    this._preloadStarted = true;
    this._ensureContext();

    const allFiles = new Set();
    for (const def of Object.values(SOUND_MAP)) {
      for (const f of def.pliki) allFiles.add(f);
    }
    const files = Array.from(allFiles);

    const MAX_CONCURRENT_LOADS = 4;
    let idx = 0;
    const worker = async () => {
      while (idx < files.length) {
        const my = files[idx++];
        try {
          await this._fetchAndDecode(my);
        } catch (err) {
          console.warn(`[audio] Nie udalo sie zaladowac/zdekodowac "${my}":`, err);
        }
      }
    };
    const workers = [];
    for (let i = 0; i < MAX_CONCURRENT_LOADS; i++) workers.push(worker());
    await Promise.all(workers);
  }

  /** Zapewnia, ze WSZYSTKIE pliki danego zdarzenia sa zaladowane (uzywane leniwie w play()). */
  async _ensureEventLoaded(name, def) {
    await Promise.all(def.pliki.map((f) => this._fetchAndDecode(f)));
  }

  /**
   * Odtwarza zdarzenie dzwiekowe po nazwie. Nigdy nie rzuca wyjatku:
   * - nieznane zdarzenie: cicho ignoruje (return false)
   * - kontekst jeszcze nieodblokowany: cichy no-op (return false)
   * - brakujacy/niedekodowalny plik: ostrzezenie RAZ, zdarzenie wylaczone na przyszlosc
   */
  play(name) {
    try {
      return this._playInner(name);
    } catch (err) {
      console.warn(`[audio] Nieoczekiwany blad przy play("${name}")`, err);
      return false;
    }
  }

  _playInner(name) {
    const def = SOUND_MAP[name];
    if (!def) return false; // nieznane zdarzenie - cicho ignorujemy
    if (this.disabledEvents.has(name)) return false;
    if (!this._unlocked) return false; // przed pierwsza interakcja uzytkownika - cichy no-op

    const ctx = this._ensureContext();
    if (!ctx) return false;

    const now = performance.now();
    const last = this._lastPlayMs.get(name) || 0;
    if (now - last < (def.cooldownMs || 0)) return false;

    const activeForEvent = this._activeVoicesByEvent.get(name) || 0;
    if (activeForEvent >= (def.maxJednoczesnie || 1)) return false;
    if (this._activeVoicesTotal >= GLOBAL_MAX_VOICES) return false;

    const filesToPlay = def.tryb === 'wszystkie' ? def.pliki : [def.pliki[Math.floor(Math.random() * def.pliki.length)]];

    let startedAny = false;
    for (const file of filesToPlay) {
      if (this._playOneFile(name, def, file)) startedAny = true;
    }
    if (startedAny) this._lastPlayMs.set(name, now);
    return startedAny;
  }

  _playOneFile(name, def, file) {
    const ctx = this.ctx;
    const buffer = this.buffers.get(file);

    if (!buffer) {
      // Plik jeszcze niezaladowany (preload w toku albo sie nie powiodl).
      // Probujemy doladowac w tle na przyszlosc, ale TERAZ nic nie gramy -
      // gra ma dzialac dalej normalnie, bez czekania.
      this._fetchAndDecode(file).catch((err) => {
        if (!this._warnedEvents.has(name)) {
          this._warnedEvents.add(name);
          this.disabledEvents.add(name);
          console.warn(`[audio] Zdarzenie "${name}" wylaczone - nie udalo sie zaladowac "${file}":`, err);
        }
      });
      return false;
    }

    try {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const varAmt = def.wysokoscVar || 0;
      source.playbackRate.value = varAmt > 0 ? 1 + (Math.random() * 2 - 1) * varAmt : 1;

      const gain = ctx.createGain();
      gain.gain.value = def.glosnosc != null ? def.glosnosc : 1;

      source.connect(gain);
      gain.connect(this.masterGain);

      this._activeVoicesTotal += 1;
      this._activeVoicesByEvent.set(name, (this._activeVoicesByEvent.get(name) || 0) + 1);

      const onEnded = () => {
        this._activeVoicesTotal = Math.max(0, this._activeVoicesTotal - 1);
        this._activeVoicesByEvent.set(name, Math.max(0, (this._activeVoicesByEvent.get(name) || 1) - 1));
        source.disconnect();
        gain.disconnect();
      };
      source.addEventListener('ended', onEnded);

      source.start(0);
      return true;
    } catch (err) {
      console.warn(`[audio] Blad przy odtwarzaniu "${file}" dla zdarzenia "${name}":`, err);
      return false;
    }
  }

  /** Liczba aktualnie grajacych zrodel - do debugowania/weryfikacji z konsoli. */
  activeVoiceCount() {
    return this._activeVoicesTotal;
  }
}

// Singleton - importowany bezposrednio zamiast przekazywania przez konstruktory
// dziesiatek klas (workers/boss/vanessa/goldcoin). main.js wystawia go dodatkowo
// jako window.__game.audio do debugowania z konsoli.
export const audio = new AudioManager();
