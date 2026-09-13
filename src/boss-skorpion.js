import * as THREE from 'three';
import { strumien, losujInt } from './rng.js';
import { showBossNotification } from './ui.js';
import { normalizeNick } from './kick.js';
import { audio } from './audio.js';

// Mechanika czwartego bossa (tier 4 bankomatu) - Skorpion. Trzymana w OSOBNYM
// pliku (wzorzec src/boss-kowal.js, src/boss-blackjack.js), zeby nie dotykac
// zweryfikowanej logiki bossow 1-3. BossManager tworzy instancje tej klasy w
// start() (gdy def.mechanika === 'skorpion') i deleguje do niej: start walki,
// update() w CUTSCENE/FIGHT, HP/FSM/nakladki DOM/kamera zostaja w BossManager.
//
// RUCH (ucieczka po siatce + zapadanie pol) jest liczony DETERMINISTYCZNIE i
// BEZ bramki hosta - kazda karta gry dochodzi do tego samego wyniku z tego
// samego strumienia (wzorzec _updateRuch w boss-kowal.js), wiec animacja jest
// plynna u kazdego widza bez czekania na snapshot co 2s. Decyzje z ekonomicznym
// skutkiem (zbieranie/laczenie/trucizna/smierc/kradziez) sa bramkowane
// `boss.czyNaliczanieDozwolone()` (wzorzec _updateHost w boss-blackjack.js) -
// widz odtwarza ich WYNIK dopiero z sync (getSyncState/applySync), tak jak
// dzieje sie to z kara pieniezna w blackjacku.

const CYKL_RUCHU = 5.0; // sekund na caly krok (postoj + marsz)
const CZAS_MARSZU = 1.4; // ostatnia czesc cyklu to faktyczny marsz na sasiednie pole
const MAX_ZAPADNIETYCH = 5; // maks. zapadnietych pol na raz (ostatnie 5 za bossem)
const CZAS_WEJSCIA = 2.6; // sekund (timing karty tytulowej/letterboxu, jak Dzordzo)

const KRADZIEZ_PROCENT = 0.005; // 0.5% puli w chwili aktywacji, dalej STALA kwota
const TRUCIZNA_DMG = 17;
const RESPAWN_OPOZNIENIE = 6; // sekund od zuzycia do ponownego spawnu danego typu
const BUTELKA_START = 4; // sekunda walki, w ktorej moze pojawic sie pierwsza butelka
const SRODEK_START = 9; // sekunda walki, w ktorej moze pojawic sie pierwszy srodek

// Skala kraba (animal-crab.glb, kenney_cube-pets) - cel: wysokosc samego
// kraba (bez ogona) = 1.5x wysokosci awatara gracza. Zmierzone w dzialajacej
// grze (Box3.setFromObject): awatar gracza = 0.726 wys.; krab przy
// CRAB_SCALE=0.36 = 0.841 x 0.515 x 0.485 (szer x wys x glab), wiec wysokosc
// natywna (nieskalowana) = 0.515/0.36 = 1.4306. Docelowa wysokosc kraba =
// 1.5*0.726 = 1.089 -> CRAB_SCALE = 1.089/1.4306 = 0.76. Szerokosc wyjdzie
// ~1.8 (wieksza niz pole 1x1) - zaakceptowane w zadaniu. Ogon jest dzieckiem
// wezla 'body' kraba (patrz _zbudujOgon), wiec skaluje sie automatycznie
// razem z crab.scale - nie trzeba go przeliczac osobno.
const CRAB_SCALE = 0.76;
// Stosunek nowej do starej skali - do proporcjonalnego przeliczenia stalych
// zaleznych od rozmiaru bossa (wysokosci tekstu/plakietek nad modelem).
const CRAB_SCALE_FACTOR = CRAB_SCALE / 0.36; // ~2.111

const NEON_BUTELKA = 0x00f0ff;
const NEON_SRODEK = 0xff2bd6;

// Przyblizony kolor skorupy kraba/skorpiona dla proceduralnego ogona - ogon
// jest czysto kosmetycznym dodatkiem (w zadnej paczce Kenneya nie ma modelu
// skorpiona ani ogona), wiec kolor NIE jest probkowany z atlasu (w
// odroznieniu od podmiany bluzy Dzordzo w boss-blackjack.js) - to
// nieproporcjonalny wysilek dla dekoracyjnego dodatku.
const KOLOR_OGONA = 0xc75a2e;
const KOLOR_ZADLA = 0x1c1c1c;

const IKONY = { butelka: '🍾', srodek: '💊', trucizna: '☠️' };

export class BossSkorpion {
  constructor(boss) {
    // Referencja do BossManager - scena, workerManager, kickChat, economy
    // (seedGry, money), czyNaliczanieDozwolone, projectAndFloat, save,
    // onGameOver, _workersOnTile/_userForWorker/_killUser/damage/_log - patrz boss.js.
    this.boss = boss;

    this.model = null;
    this.mixer = null;
    this.currentAction = null;
    this.animations = [];
    this._ogonBaza = null;
    this._ogonT = 0;

    this.fazaWejscia = false;
    this._wejscieT = 0;
    this._startWalki = null; // ustawiane w _updateEntrance, w chwili konca cutscenki

    // --- Pozycja i ruch na siatce (patrz naglowek pliku - liczone bez bramki hosta) ---
    this.x = 0;
    this.z = -2;
    this.startX = 0;
    this.startZ = -2;
    this.celX = 0;
    this.celZ = -2;
    this.cykl = 0;
    this.krok = 0;
    this.zapadniete = []; // [{x,z}, ...] FIFO, najstarsze na indeksie 0
    this._ostatnieZapadniecie = null; // {x,z} ustawiane na 1 klatke po swiezym zapadnieciu (patrz _updateRuch)

    // --- Przedmioty na mapie i w ekwipunkach (bramkowane hostem) ---
    this.itemButelka = null; // {x,z} | null
    this.itemSrodek = null; // {x,z} | null
    this.ekwipunki = new Map(); // usernameNorm -> { typ: 'butelka'|'srodek'|'trucizna', username }
    this._nextButelkaAt = BUTELKA_START;
    this._nextSrodekAt = SRODEK_START;
    this._licznikPol = 0;
    this._lastEkwipunekKeys = new Set();

    // --- Kradziez (bramkowana hostem) ---
    this.kwotaKradzieznaSek = 0;
    this.kradziezAktywna = false;
    this._tikiZrobione = 0;
    this._gameOverWywolany = false;

    // --- Wizualizacja (dziury po zapadnietych polach, przedmioty na mapie) ---
    this._openHoles = new Map(); // "x,z" -> THREE.Group
    this._itemMeshButelka = null;
    this._itemMeshSrodek = null;
    this._itemRingButelka = null; // pierscien neonowy na podlodze pod przedmiotem
    this._itemRingSrodek = null;
    this._itemOutlineButelka = null; // "inverted hull" obrys - dziecko itemMesh*
    this._itemOutlineSrodek = null;
  }

  // ================= BUDOWA MODELU =================

  /** Buduje kraba (animal-crab, kenney_cube-pets) z doklejonym proceduralnym ogonem skorpiona. */
  build() {
    const boss = this.boss;
    const crab = boss.crabTemplate.clone(true);
    this.animations = boss.crabAnimations || [];
    crab.scale.setScalar(CRAB_SCALE);

    crab.traverse((n) => {
      if (n.isMesh) {
        n.castShadow = true;
        n.receiveShadow = true;
      }
    });

    this.model = crab;
    this.mixer = new THREE.AnimationMixer(crab);
    this.currentAction = null;

    this._zbudujOgon(crab);

    boss.scene.add(crab);
    return crab;
  }

  /**
   * Ogon skorpiona - lancuch 4 segmentow (kapsuly) wygietych lukiem nad
   * grzbiet, zakonczony zadlem (stozek). Zaden pakiet Kenneya nie ma
   * skorpiona ani ogona (patrz CLAUDE.md - lista 294 modeli), stad prymitywy
   * Three.js zamiast modelu. Doczepiony do wezla 'body' kraba, wiec porusza
   * sie razem z nim (idle/walk animuja glownie nogi, ale to i tak jedyny
   * sensowny punkt zaczepienia).
   */
  _zbudujOgon(crab) {
    const attach = crab.getObjectByName('body') || crab;
    const material = new THREE.MeshStandardMaterial({ color: KOLOR_OGONA, roughness: 0.75 });

    const grupa = new THREE.Group();
    // Nasada ogona - z tylu grzbietu kraba, w jednostkach natywnych modelu
    // (ta sama przestrzen co legi/body - patrz CLAUDE.md o skali kraba).
    grupa.position.set(0, 0.95, 0.5);
    attach.add(grupa);
    this._ogonBaza = grupa;

    const dlugosci = [0.5, 0.42, 0.34, 0.26];
    const promienie = [0.11, 0.095, 0.08, 0.06];
    // Narastajace wygiecie ku gorze i do przodu, tak zeby zadlo wyladowalo
    // nad grzbietem, celujac w dol - klasyczny sylwetka skorpiona.
    const katy = [-0.55, -0.75, -0.85, -0.6];

    let parent = grupa;
    for (let i = 0; i < dlugosci.length; i++) {
      const joint = new THREE.Group();
      joint.rotation.x = katy[i];
      parent.add(joint);

      const seg = new THREE.Mesh(
        new THREE.CapsuleGeometry(promienie[i], dlugosci[i], 4, 8),
        material,
      );
      seg.position.y = dlugosci[i] / 2 + promienie[i];
      seg.castShadow = true;
      joint.add(seg);

      const nastepny = new THREE.Group();
      nastepny.position.y = dlugosci[i] + promienie[i] * 2;
      joint.add(nastepny);
      parent = nastepny;
    }

    const zadlo = new THREE.Mesh(
      new THREE.ConeGeometry(0.07, 0.22, 8),
      new THREE.MeshStandardMaterial({ color: KOLOR_ZADLA, roughness: 0.5 }),
    );
    zadlo.position.y = 0.11;
    zadlo.rotation.x = -0.4;
    zadlo.castShadow = true;
    parent.add(zadlo);
  }

  playAction(name, opts = {}) {
    const clip = THREE.AnimationClip.findByName(this.animations, name);
    if (!clip || !this.mixer) return null;
    const next = this.mixer.clipAction(clip);
    if (opts.once) {
      next.setLoop(THREE.LoopOnce);
      next.clampWhenFinished = true;
    }
    if (this.currentAction === next) {
      if (opts.forceRestart) next.reset().play();
      return next;
    }
    if (this.currentAction) {
      if (opts.hard) this.currentAction.stop();
      else this.currentAction.crossFadeTo(next, 0.2, false);
    }
    next.reset().play();
    this.currentAction = next;
    return next;
  }

  // ================= WEJSCIE NA ARENE =================

  /** Skorpion pojawia sie juz stojacy na polu startowym [0,-2], animacja idle - jak Dzordzo. */
  beginEntrance() {
    this.x = 0; this.z = -2;
    this.startX = 0; this.startZ = -2;
    this.celX = 0; this.celZ = -2;
    this.cykl = 0;
    this.krok = 0;
    this.zapadniete = [];
    this._ostatnieZapadniecie = null;
    this.itemButelka = null;
    this.itemSrodek = null;
    this.ekwipunki.clear();
    this._nextButelkaAt = BUTELKA_START;
    this._nextSrodekAt = SRODEK_START;
    this.kwotaKradzieznaSek = 0;
    this.kradziezAktywna = false;
    this._tikiZrobione = 0;
    this._gameOverWywolany = false;

    if (this.model) {
      this.model.position.set(this.x, 0, this.z);
      this.model.lookAt(0, 0, 0);
    }
    this.fazaWejscia = true;
    this._wejscieT = 0;
    this._startWalki = null;
    audio.play('boss-wejscie');
    this.playAction('idle', { hard: true });
    if (this.boss.stealRowEl) this.boss.stealRowEl.style.display = 'none';
    showBossNotification(
      'boss',
      '🦂 SKORPION WCHODZI NA ARENĘ!',
      'Ucieka po siatce i zapada pola za sobą - nie wchodźcie w dziury! Zbierajcie 🍾/💊, łączcie w ☠️ i truj go z bliska!',
    );
    this.boss._log('spawn', `Skorpion pojawia sie na arenie na polu [${this.x}, ${this.z}]`);
  }

  _updateEntrance(delta) {
    this._wejscieT += delta;
    if (this._wejscieT >= CZAS_WEJSCIA) {
      this.fazaWejscia = false;
      // Zegar walki startuje TU, nie w boss.startWalki (ktory obejmuje cutscene
      // wejscia - patrz naglowek sekcji ZEGAR WALKI). Date.now() jest wspolny
      // dla hosta i widzow, wiec obaj licza od tej samej chwili po sync.
      this._startWalki = Date.now();
      this._wybierzKrok();
    }
  }

  // ================= ZEGAR WALKI (wlasny znacznik - NIE boss.startWalki, ktory obejmuje cutscene) =================

  _fightSec() {
    if (!this._startWalki) return 0;
    return Math.max(0, (Date.now() - this._startWalki) / 1000);
  }

  // ================= RUCH / UCIECZKA (bez bramki hosta - patrz naglowek) =================

  _jestZapadniete(x, z) {
    return this.zapadniete.some((t) => t.x === x && t.z === z);
  }

  /** Pozycje wszystkich aktywnych awatarow (docelowe, jesli w trakcie kroku). */
  _pozycjeGraczy() {
    const out = [];
    if (!this.boss.workerManager) return out;
    for (const e of this.boss.workerManager.entries) {
      if (!e || !e.obj) continue;
      const x = e.isMoving ? e.targetGridX : e.gridX;
      const z = e.isMoving ? e.targetGridZ : e.gridZ;
      out.push({ x: Number(x), z: Number(z) });
    }
    return out;
  }

  /**
   * Wybor kolejnego pola docelowego - 8-sasiedztwo biezacego pola, z
   * wykluczeniem bankomatu, granic areny i pol zapadnietych, maksymalizujace
   * odleglosc od najblizszego gracza (ucieczka). Remisy rozstrzyga strumien
   * zakotwiczony w numerze kroku (`this.krok`), wiec kazda karta gry wybiera
   * DOKLADNIE to samo pole - wzorzec _wybierzPole w boss-kowal.js.
   */
  _wybierzKrok() {
    this.krok += 1;
    const kandydaci = [];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (dx === 0 && dz === 0) continue;
        const x = this.x + dx;
        const z = this.z + dz;
        if (Math.abs(x) > 3 || Math.abs(z) > 3) continue;
        if (x === 0 && z === 0) continue;
        if (this._jestZapadniete(x, z)) continue;
        kandydaci.push({ x, z });
      }
    }
    if (kandydaci.length === 0) {
      // Brak legalnego pola - stoi w miejscu (patrz zadanie).
      this.celX = this.x;
      this.celZ = this.z;
      return;
    }

    const gracze = this._pozycjeGraczy();
    let najlepszy = -Infinity;
    let wynikowe = [];
    for (const k of kandydaci) {
      let dist;
      if (gracze.length === 0) {
        dist = 0;
      } else {
        dist = Infinity;
        for (const g of gracze) {
          const d = Math.hypot(k.x - g.x, k.z - g.z);
          if (d < dist) dist = d;
        }
      }
      if (dist > najlepszy + 1e-9) {
        najlepszy = dist;
        wynikowe = [k];
      } else if (Math.abs(dist - najlepszy) <= 1e-9) {
        wynikowe.push(k);
      }
    }

    let wybrany;
    if (wynikowe.length === 1) {
      wybrany = wynikowe[0];
    } else {
      const seed = this.boss.economy.state.seedGry;
      const idWalki = this.boss.pendingTier;
      const rng = strumien(`${seed}:skorpion-ruch:${idWalki}:${this.krok}`);
      wybrany = wynikowe[losujInt(rng, 0, wynikowe.length - 1)];
    }
    this.celX = wybrany.x;
    this.celZ = wybrany.z;
  }

  /** Marsz i dokonczenie kroku - liczone identycznie na kazdej otwartej karcie gry. */
  _updateRuch(delta) {
    this.cykl += delta;
    const startMarszu = CYKL_RUCHU - CZAS_MARSZU;

    if (this.model) {
      if (this.cykl < startMarszu) {
        this.model.position.set(this.startX, 0, this.startZ);
        if (this.celX !== this.startX || this.celZ !== this.startZ) {
          this.model.lookAt(this.celX, 0, this.celZ);
        }
        this.playAction('idle');
      } else {
        const u = Math.min(1, (this.cykl - startMarszu) / CZAS_MARSZU);
        this.model.position.set(
          this.startX + (this.celX - this.startX) * u,
          0,
          this.startZ + (this.celZ - this.startZ) * u,
        );
        if (this.celX !== this.startX || this.celZ !== this.startZ) {
          this.model.lookAt(this.celX, 0, this.celZ);
          this.playAction('walk');
        } else {
          this.playAction('idle');
        }
      }
    }

    if (this.cykl >= CYKL_RUCHU) {
      this._dokonczKrok();
    }
  }

  _dokonczKrok() {
    const staraX = this.startX;
    const staraZ = this.startZ;
    const ruszyl = this.celX !== staraX || this.celZ !== staraZ;
    this.x = this.celX;
    this.z = this.celZ;
    if (ruszyl) {
      audio.play('krok');
      this.zapadniete.push({ x: staraX, z: staraZ });
      if (this.zapadniete.length > MAX_ZAPADNIETYCH) {
        this.zapadniete.shift(); // najstarsze zapadniete pole sie odnawia
      }
      this._ostatnieZapadniecie = { x: staraX, z: staraZ };
      this.boss._log('info', `Skorpion opuszcza pole [${staraX}, ${staraZ}] - ono się zapada`, { pole: [staraX, staraZ] });
    }
    this.startX = this.x;
    this.startZ = this.z;
    this.cykl = 0;
    this._wybierzKrok();
  }

  // ================= PRZEDMIOTY NA MAPIE (bramkowane hostem) =================

  _zajetePola() {
    const zajete = new Set(['0,0', `${this.x},${this.z}`, `${this.celX},${this.celZ}`]);
    for (const t of this.zapadniete) zajete.add(`${t.x},${t.z}`);
    if (this.itemButelka) zajete.add(`${this.itemButelka.x},${this.itemButelka.z}`);
    if (this.itemSrodek) zajete.add(`${this.itemSrodek.x},${this.itemSrodek.z}`);
    return zajete;
  }

  _wybierzWolnePole() {
    const zajete = this._zajetePola();
    const wolne = [];
    for (let x = -3; x <= 3; x++) {
      for (let z = -3; z <= 3; z++) {
        const k = `${x},${z}`;
        if (!zajete.has(k)) wolne.push({ x, z });
      }
    }
    if (wolne.length === 0) return null;
    this._licznikPol += 1;
    const seed = this.boss.economy.state.seedGry;
    const idWalki = this.boss.pendingTier;
    const rng = strumien(`${seed}:skorpion-pole:${idWalki}:${this._licznikPol}`);
    return wolne[losujInt(rng, 0, wolne.length - 1)];
  }

  _zespawnujPrzedmiot(typ) {
    const pole = this._wybierzWolnePole();
    if (!pole) return; // brak wolnego miejsca - sprobuje ponownie w kolejnej klatce
    if (typ === 'butelka') this.itemButelka = { x: pole.x, z: pole.z };
    else this.itemSrodek = { x: pole.x, z: pole.z };
    audio.play('skorpion-przedmiot');
    showBossNotification(
      'boss',
      typ === 'butelka' ? '🍾 BUTELKA NA ARENIE!' : '💊 ŚRODEK PRZECZYSZCZAJĄCY!',
      `Pojawił się na polu <strong>[${pole.x}, ${pole.z}]</strong> - zbierz go pierwszy!`,
    );
    this.boss._log('info', `Skorpion: spawn przedmiotu "${typ}" na polu [${pole.x}, ${pole.z}]`);
  }

  /** Czy ktos aktualnie trzyma dany typ w ekwipunku (trucizna sie nie liczy - patrz zadanie). */
  _ktosTrzyma(typ) {
    for (const v of this.ekwipunki.values()) {
      if (v.typ === typ) return true;
    }
    return false;
  }

  _aktualizujSpawnPrzedmiotow() {
    const fightSec = this._fightSec();
    if (!this.itemButelka && !this._ktosTrzyma('butelka') && fightSec >= this._nextButelkaAt) this._zespawnujPrzedmiot('butelka');
    if (!this.itemSrodek && !this._ktosTrzyma('srodek') && fightSec >= this._nextSrodekAt) this._zespawnujPrzedmiot('srodek');
  }

  /**
   * Sprzatanie ekwipunkow graczy, ktorzy wypadli z Top 10 w inny sposob niz
   * smierc na zapadnietym polu (to obsluguje juz _sprawdzSmierciNaZapadnietych) -
   * np. zostali wyeliminowani/zastapieni w rankingu. Bez tego przedmiot
   * zostalby zablokowany na zawsze (patrz zadanie, blad 1).
   */
  _wyczyscEkwipunkiWypadnietych() {
    if (!this.boss.kickChat) return;
    for (const [key, v] of [...this.ekwipunki]) {
      if (this.boss.kickChat.getWorkerForUser(v.username) !== null) continue;
      this.ekwipunki.delete(key);
      const fightSec = this._fightSec();
      if (v.typ === 'butelka') this._nextButelkaAt = fightSec + RESPAWN_OPOZNIENIE;
      else if (v.typ === 'srodek') this._nextSrodekAt = fightSec + RESPAWN_OPOZNIENIE;
    }
  }

  /** Przedmiot lezacy na polu, ktore wlasnie sie zapadlo - przenosimy go gdzie indziej. */
  _przeniesPrzedmiotyZeZapadnietegoPola() {
    const p = this._ostatnieZapadniecie;
    if (!p) return;
    if (this.itemButelka && this.itemButelka.x === p.x && this.itemButelka.z === p.z) {
      this.itemButelka = this._wybierzWolnePole();
    }
    if (this.itemSrodek && this.itemSrodek.x === p.x && this.itemSrodek.z === p.z) {
      this.itemSrodek = this._wybierzWolnePole();
    }
  }

  // ================= EKWIPUNEK - ZBIERANIE / LACZENIE / TRUCIZNA (bramkowane hostem) =================

  _pozycjaGracza(username) {
    if (!this.boss.kickChat || !this.boss.workerManager) return null;
    const slot = this.boss.kickChat.getWorkerForUser(username);
    if (slot === null) return null;
    const entry = this.boss.workerManager.getWorkerType(slot);
    if (!entry || !entry.obj) return null;
    return { x: Number(entry.gridX), z: Number(entry.gridZ) };
  }

  _przyznajIkoneEkwipunku(username, typ) {
    const key = normalizeNick(username);
    this.ekwipunki.set(key, { typ, username });
  }

  _sprawdzZbieranie() {
    if (!this.itemButelka && !this.itemSrodek) return;
    for (const entry of this.boss.workerManager.entries) {
      if (!entry || !entry.obj || entry.isFainted || entry.isMoving) continue;
      const nick = this.boss._userForWorker(entry);
      if (!nick) continue;
      const key = normalizeNick(nick);
      if (this.ekwipunki.has(key)) continue; // ekwipunek zajety - max 1 rzecz naraz

      let typ = null;
      if (this.itemButelka && entry.gridX === this.itemButelka.x && entry.gridZ === this.itemButelka.z) {
        typ = 'butelka';
        this.itemButelka = null;
      } else if (this.itemSrodek && entry.gridX === this.itemSrodek.x && entry.gridZ === this.itemSrodek.z) {
        typ = 'srodek';
        this.itemSrodek = null;
      }
      if (!typ) continue;

      this._przyznajIkoneEkwipunku(nick, typ);
      audio.play('skorpion-zebranie');
      if (entry.obj && this.boss.projectAndFloat) {
        const origin = entry.obj.position.clone().add(new THREE.Vector3(0, 1.4, 0));
        this.boss.projectAndFloat(origin, `${IKONY[typ]} @${nick}`, { gold: true });
      }
      showBossNotification('help', `${IKONY[typ]} @${nick} ZEBRAŁ PRZEDMIOT!`, `<strong>@${nick}</strong> ma teraz pusty ekwipunek zapełniony - ${typ === 'butelka' ? 'butelkę' : 'środek przeczyszczający'}.`);
      this.boss._log('good', `@${nick} zbiera przedmiot "${typ}"`, { gracz: nick, typ });
    }
  }

  _sprawdzLaczenie() {
    let butelka = null;
    let srodek = null;
    for (const [key, v] of this.ekwipunki) {
      if (v.typ === 'butelka') butelka = { key, ...v };
      else if (v.typ === 'srodek') srodek = { key, ...v };
    }
    if (!butelka || !srodek) return;
    const posB = this._pozycjaGracza(butelka.username);
    const posS = this._pozycjaGracza(srodek.username);
    if (!posB || !posS || posB.x !== posS.x || posB.z !== posS.z) return;

    this.ekwipunki.set(butelka.key, { typ: 'trucizna', username: butelka.username });
    this.ekwipunki.set(srodek.key, { typ: 'trucizna', username: srodek.username });
    const fightSec = this._fightSec();
    this._nextButelkaAt = fightSec + RESPAWN_OPOZNIENIE;
    this._nextSrodekAt = fightSec + RESPAWN_OPOZNIENIE;

    audio.play('skorpion-polaczenie');
    showBossNotification(
      'hit',
      '☠️ TRUCIZNA GOTOWA!',
      `<strong>@${butelka.username}</strong> i <strong>@${srodek.username}</strong> połączyli butelkę ze środkiem - obaj dostają truciznę!`,
    );
    this.boss._log('good', `@${butelka.username} i @${srodek.username} laczą przedmioty w trucizne`, {
      gracze: [butelka.username, srodek.username],
    });
  }

  _sprawdzTrucizne() {
    for (const [key, v] of [...this.ekwipunki]) {
      if (v.typ !== 'trucizna') continue;
      const pos = this._pozycjaGracza(v.username);
      if (!pos) continue;
      const dx = Math.abs(pos.x - this.x);
      const dz = Math.abs(pos.z - this.z);
      if (Math.max(dx, dz) > 1) continue;

      this.ekwipunki.delete(key);
      audio.play('skorpion-trucizna');
      if (this.boss.projectAndFloat) {
        // Wysokosc tekstu nad modelem - przeliczona proporcjonalnie do
        // wiekszej skali bossa (patrz CRAB_SCALE_FACTOR), zeby nie wchodzic
        // w powiekszony model/ogon (dawna wartosc 1.4 przy CRAB_SCALE=0.36).
        this.boss.projectAndFloat(new THREE.Vector3(this.x, 1.4 * CRAB_SCALE_FACTOR, this.z), `☠️ -${TRUCIZNA_DMG} HP`, { crit: true });
      }
      showBossNotification(
        'hit',
        '☠️ SKORPION ZATRUTY!',
        `<strong>@${v.username}</strong> użył trucizny z bliska - Skorpion traci <strong>${TRUCIZNA_DMG} HP</strong>!`,
      );
      this.boss._log('good', `@${v.username} truje Skorpiona z bliska (-${TRUCIZNA_DMG} HP)`, { gracz: v.username });
      this.boss.damage(TRUCIZNA_DMG);
    }
  }

  // ================= SMIERC NA ZAPADNIETYCH POLACH (bramkowane hostem) =================

  _sprawdzSmierciNaZapadnietych() {
    if (this.zapadniete.length === 0) return;
    const zbior = new Set(this.zapadniete.map((t) => `${t.x},${t.z}`));
    for (const entry of this.boss.workerManager.entries) {
      if (!entry || !entry.obj || entry.isFainted) continue;
      const gx = entry.isMoving ? entry.targetGridX : entry.gridX;
      const gz = entry.isMoving ? entry.targetGridZ : entry.gridZ;
      if (!zbior.has(`${gx},${gz}`)) continue;
      const nick = this.boss._userForWorker(entry);
      if (!nick) continue;
      // Przedmiot ofiary przepada (patrz zadanie) - respawn dopiero po REPAWN_OPOZNIENIE.
      const key = normalizeNick(nick);
      const mial = this.ekwipunki.get(key);
      if (mial) {
        this.ekwipunki.delete(key);
        const fightSec = this._fightSec();
        if (mial.typ === 'butelka') this._nextButelkaAt = fightSec + RESPAWN_OPOZNIENIE;
        else if (mial.typ === 'srodek') this._nextSrodekAt = fightSec + RESPAWN_OPOZNIENIE;
      }
      this.boss._killUser(nick, { source: 'skorpion' });
    }
  }

  // ================= KRADZIEZ (bramkowana hostem) =================

  _aktualizujKradziez() {
    const fightSec = this._fightSec();
    if (!this.kradziezAktywna) {
      if (fightSec >= 1) {
        const economy = this.boss.economy;
        const pula = economy ? economy.state.money : 0;
        this.kwotaKradzieznaSek = Math.max(1, Math.round(KRADZIEZ_PROCENT * pula));
        this.kradziezAktywna = true;
        this._tikiZrobione = 0;
        this.boss._log('bad', `Skorpion zaczyna okradać pulę - ${this.kwotaKradzieznaSek} zł/s`, { kwota: this.kwotaKradzieznaSek });
      }
      return;
    }
    const tikiObecne = Math.floor(fightSec - 1);
    while (tikiObecne > this._tikiZrobione) {
      this._tikiZrobione += 1;
      const economy = this.boss.economy;
      if (!economy) break;
      economy.state.money = Math.max(0, economy.state.money - this.kwotaKradzieznaSek);
      audio.play('skorpion-kradziez');
      if (this.boss.save) {
        try { this.boss.save(); } catch (err) { console.error('[boss-skorpion] Blad zapisu po kradziezy:', err); }
      }
      if (economy.state.money <= 0) {
        this._wywolajGameOver();
        break;
      }
    }
  }

  _wywolajGameOver() {
    if (this._gameOverWywolany) return;
    this._gameOverWywolany = true;
    this.boss._log('bad', 'Skorpion okradl cala pule do zera - GAME OVER');
    if (this.boss.onGameOver) {
      try {
        const wynikPromise = this.boss.onGameOver('game over, skorpion was okradł');
        if (wynikPromise && typeof wynikPromise.catch === 'function') {
          wynikPromise.catch((err) => console.error('[boss-skorpion] Blad w onGameOver:', err));
        }
      } catch (err) {
        console.error('[boss-skorpion] Blad w onGameOver:', err);
      }
    }
  }

  // ================= WIZUALIZACJA (dziury, przedmioty, ikony - liczone przez KAZDA karte) =================

  _makeHole() {
    const grupa = new THREE.Group();
    grupa.rotation.x = -Math.PI / 2;
    const dziura = new THREE.Mesh(
      new THREE.CircleGeometry(0.42, 28),
      new THREE.MeshBasicMaterial({ color: 0x0a0603, transparent: true, opacity: 0.92, depthWrite: false }),
    );
    grupa.add(dziura);
    const obrys = new THREE.Mesh(
      new THREE.RingGeometry(0.4, 0.47, 28),
      new THREE.MeshBasicMaterial({ color: 0x3a1c10, transparent: true, opacity: 0.85, depthWrite: false }),
    );
    grupa.add(obrys);
    return grupa;
  }

  _renderDziury() {
    const aktualne = new Set(this.zapadniete.map((t) => `${t.x},${t.z}`));
    for (const [key, grupa] of [...this._openHoles]) {
      if (aktualne.has(key)) continue;
      this.boss.scene.remove(grupa);
      grupa.traverse((n) => {
        if (n.isMesh) { n.geometry.dispose(); n.material.dispose(); }
      });
      this._openHoles.delete(key);
    }
    for (const t of this.zapadniete) {
      const key = `${t.x},${t.z}`;
      if (this._openHoles.has(key)) continue;
      const grupa = this._makeHole();
      grupa.position.set(t.x, 0.03, t.z);
      this.boss.scene.add(grupa);
      this._openHoles.set(key, grupa);
    }
  }

  _makeItemMesh(template) {
    if (!template) return null;
    const mesh = template.clone(true);
    mesh.traverse((n) => { if (n.isMesh) n.castShadow = true; });
    mesh.scale.setScalar(0.8);
    return mesh;
  }

  /**
   * "Inverted hull" obrys - kopia geometrii przedmiotu (dziecko meshu, wiec
   * dziedziczy obrot/unoszenie), lekko powiekszona, wnetrze BackSide zeby
   * widac bylo tylko rabek na krawedziach. Geometrie sa WSPOLDZIELONE z
   * template (mesh.clone(true) nie klonuje geometrii/materialow) - NIE
   * dispose'owac ich, tylko nowo utworzone materialy ponizej.
   */
  _makeOutline(mesh, color) {
    const outline = mesh.clone(true);
    outline.traverse((n) => {
      if (n.isMesh) {
        n.castShadow = false;
        n.material = new THREE.MeshBasicMaterial({
          color,
          side: THREE.BackSide,
          transparent: true,
          depthWrite: false,
          opacity: 0.85,
        });
      }
    });
    outline.scale.setScalar(1.15);
    mesh.add(outline);
    return outline;
  }

  _disposeOutline(outline) {
    if (!outline) return;
    outline.traverse((n) => { if (n.isMesh && n.material) n.material.dispose(); });
  }

  _makeItemRing(color) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.32, 0.42, 32),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.7,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.02;
    return ring;
  }

  _disposeItemRing(ring) {
    if (!ring) return;
    ring.geometry.dispose();
    ring.material.dispose();
  }

  _renderPrzedmiotyNaMapie(delta) {
    this._ogonT += delta;
    if (this._ogonBaza) this._ogonBaza.rotation.z = Math.sin(this._ogonT * 1.6) * 0.12;

    // Butelka
    if (this.itemButelka) {
      if (!this._itemMeshButelka) {
        this._itemMeshButelka = this._makeItemMesh(this.boss.bottleTemplate);
        if (this._itemMeshButelka) {
          this.boss.scene.add(this._itemMeshButelka);
          this._itemOutlineButelka = this._makeOutline(this._itemMeshButelka, NEON_BUTELKA);
          this._itemRingButelka = this._makeItemRing(NEON_BUTELKA);
          this.boss.scene.add(this._itemRingButelka);
        }
      }
      if (this._itemMeshButelka) {
        this._itemMeshButelka.position.set(
          this.itemButelka.x,
          0.35 + Math.sin(this._ogonT * 3) * 0.06,
          this.itemButelka.z,
        );
        this._itemMeshButelka.rotation.y += delta * 1.4;
        const puls = 0.5 + Math.sin(this._ogonT * 2.4) * 0.25;
        if (this._itemOutlineButelka) {
          this._itemOutlineButelka.traverse((n) => { if (n.isMesh) n.material.opacity = 0.6 + puls * 0.3; });
        }
        if (this._itemRingButelka) {
          this._itemRingButelka.position.set(this.itemButelka.x, 0.02, this.itemButelka.z);
          this._itemRingButelka.material.opacity = puls;
        }
      }
    } else if (this._itemMeshButelka) {
      this.boss.scene.remove(this._itemMeshButelka);
      this._disposeOutline(this._itemOutlineButelka);
      this._itemOutlineButelka = null;
      this._itemMeshButelka = null;
      if (this._itemRingButelka) {
        this.boss.scene.remove(this._itemRingButelka);
        this._disposeItemRing(this._itemRingButelka);
        this._itemRingButelka = null;
      }
    }

    // Srodek
    if (this.itemSrodek) {
      if (!this._itemMeshSrodek) {
        this._itemMeshSrodek = this._makeItemMesh(this.boss.potionTemplate);
        if (this._itemMeshSrodek) {
          this.boss.scene.add(this._itemMeshSrodek);
          this._itemOutlineSrodek = this._makeOutline(this._itemMeshSrodek, NEON_SRODEK);
          this._itemRingSrodek = this._makeItemRing(NEON_SRODEK);
          this.boss.scene.add(this._itemRingSrodek);
        }
      }
      if (this._itemMeshSrodek) {
        this._itemMeshSrodek.position.set(
          this.itemSrodek.x,
          0.35 + Math.sin(this._ogonT * 3 + 1.6) * 0.06,
          this.itemSrodek.z,
        );
        this._itemMeshSrodek.rotation.y += delta * 1.4;
        const puls = 0.5 + Math.sin(this._ogonT * 2.4 + 1.6) * 0.25;
        if (this._itemOutlineSrodek) {
          this._itemOutlineSrodek.traverse((n) => { if (n.isMesh) n.material.opacity = 0.6 + puls * 0.3; });
        }
        if (this._itemRingSrodek) {
          this._itemRingSrodek.position.set(this.itemSrodek.x, 0.02, this.itemSrodek.z);
          this._itemRingSrodek.material.opacity = puls;
        }
      }
    } else if (this._itemMeshSrodek) {
      this.boss.scene.remove(this._itemMeshSrodek);
      this._disposeOutline(this._itemOutlineSrodek);
      this._itemOutlineSrodek = null;
      this._itemMeshSrodek = null;
      if (this._itemRingSrodek) {
        this.boss.scene.remove(this._itemRingSrodek);
        this._disposeItemRing(this._itemRingSrodek);
        this._itemRingSrodek = null;
      }
    }
  }

  /** Zapisuje ikone przedmiotu WPROST na wpisie rankingu (patrz LeaderboardUI.render w ui.js). */
  _renderIkonyEkwipunku() {
    const kickChat = this.boss.kickChat;
    if (!kickChat) return;
    const aktualne = new Set(this.ekwipunki.keys());
    for (const key of this._lastEkwipunekKeys) {
      if (aktualne.has(key)) continue;
      const wpis = kickChat.leaderboard[key];
      if (wpis) wpis.przedmiotSkorpion = null;
    }
    for (const [key, v] of this.ekwipunki) {
      const wpis = kickChat.leaderboard[key];
      if (wpis) wpis.przedmiotSkorpion = IKONY[v.typ] || null;
    }
    this._lastEkwipunekKeys = aktualne;
  }

  /** Ikona ekwipunku dla podanego nicku (uzywane przez main.js dla plakietki nad postacia). */
  getItemForUsername(username) {
    if (!username) return null;
    const wpis = this.ekwipunki.get(normalizeNick(username));
    return wpis ? IKONY[wpis.typ] || null : null;
  }

  _renderHud() {
    const el = this.boss.stealRowEl;
    if (!el) return;
    if (this.kradziezAktywna && this.kwotaKradzieznaSek > 0) {
      el.textContent = `💸 -${this.kwotaKradzieznaSek} zł/s`;
      el.style.display = 'block';
    } else {
      el.style.display = 'none';
    }
  }

  // ================= UPDATE GLOWNY =================

  update(delta) {
    if (this.mixer) this.mixer.update(delta);

    if (this.fazaWejscia) {
      this._updateEntrance(delta);
      return;
    }

    // Ruch bossa i wykrywanie zapadania pol - identyczne na kazdej karcie gry
    // (patrz naglowek pliku), zeby animacja byla plynna bez czekania na sync.
    this._updateRuch(delta);

    const jestemHostem = !this.boss.czyNaliczanieDozwolone || this.boss.czyNaliczanieDozwolone();
    if (jestemHostem) {
      this._przeniesPrzedmiotyZeZapadnietegoPola();
      this._wyczyscEkwipunkiWypadnietych();
      this._aktualizujSpawnPrzedmiotow();
      this._sprawdzSmierciNaZapadnietych();
      this._sprawdzZbieranie();
      this._sprawdzLaczenie();
      this._sprawdzTrucizne();
      this._aktualizujKradziez();
    }
    this._ostatnieZapadniecie = null;

    this._renderDziury();
    this._renderPrzedmiotyNaMapie(delta);
    this._renderIkonyEkwipunku();
    this._renderHud();
  }

  // ================= SPRZATANIE =================

  teardown() {
    for (const grupa of this._openHoles.values()) {
      this.boss.scene.remove(grupa);
      grupa.traverse((n) => { if (n.isMesh) { n.geometry.dispose(); n.material.dispose(); } });
    }
    this._openHoles.clear();
    if (this._itemMeshButelka) {
      this.boss.scene.remove(this._itemMeshButelka);
      this._disposeOutline(this._itemOutlineButelka);
      this._itemOutlineButelka = null;
      this._itemMeshButelka = null;
    }
    if (this._itemMeshSrodek) {
      this.boss.scene.remove(this._itemMeshSrodek);
      this._disposeOutline(this._itemOutlineSrodek);
      this._itemOutlineSrodek = null;
      this._itemMeshSrodek = null;
    }
    if (this._itemRingButelka) {
      this.boss.scene.remove(this._itemRingButelka);
      this._disposeItemRing(this._itemRingButelka);
      this._itemRingButelka = null;
    }
    if (this._itemRingSrodek) {
      this.boss.scene.remove(this._itemRingSrodek);
      this._disposeItemRing(this._itemRingSrodek);
      this._itemRingSrodek = null;
    }

    // Wyczysc ikony ekwipunku z rankingu.
    const kickChat = this.boss.kickChat;
    if (kickChat) {
      for (const key of this._lastEkwipunekKeys) {
        const wpis = kickChat.leaderboard[key];
        if (wpis) wpis.przedmiotSkorpion = null;
      }
    }
    this.ekwipunki.clear();
    this._lastEkwipunekKeys = new Set();

    if (this.boss.stealRowEl) this.boss.stealRowEl.style.display = 'none';

    this.mixer = null;
    this.currentAction = null;
  }

  // ================= SYNCHRONIZACJA =================

  getSyncState() {
    return {
      startWalki: this._startWalki,
      x: this.x,
      z: this.z,
      startX: this.startX,
      startZ: this.startZ,
      celX: this.celX,
      celZ: this.celZ,
      cykl: this.cykl,
      krok: this.krok,
      zapadniete: this.zapadniete.slice(),
      itemButelka: this.itemButelka ? { ...this.itemButelka } : null,
      itemSrodek: this.itemSrodek ? { ...this.itemSrodek } : null,
      ekwipunki: Array.from(this.ekwipunki.entries()).map(([key, v]) => ({ key, typ: v.typ, username: v.username })),
      kwotaKradzieznaSek: this.kwotaKradzieznaSek,
      kradziezAktywna: this.kradziezAktywna,
    };
  }

  /** Widz WYLACZNIE wyswietla zsynchronizowany stan - host jest zrodlem prawdy dla decyzji. */
  applySync(state) {
    if (!state) return;
    if (typeof state.startWalki === 'number' || state.startWalki === null) this._startWalki = state.startWalki;
    if (typeof state.x === 'number') this.x = state.x;
    if (typeof state.z === 'number') this.z = state.z;
    if (typeof state.startX === 'number') this.startX = state.startX;
    if (typeof state.startZ === 'number') this.startZ = state.startZ;
    if (typeof state.celX === 'number') this.celX = state.celX;
    if (typeof state.celZ === 'number') this.celZ = state.celZ;
    if (typeof state.cykl === 'number') this.cykl = state.cykl;
    if (typeof state.krok === 'number') this.krok = state.krok;
    if (Array.isArray(state.zapadniete)) this.zapadniete = state.zapadniete.map((t) => ({ x: t.x, z: t.z }));
    if ('itemButelka' in state) this.itemButelka = state.itemButelka ? { ...state.itemButelka } : null;
    if ('itemSrodek' in state) this.itemSrodek = state.itemSrodek ? { ...state.itemSrodek } : null;
    if (Array.isArray(state.ekwipunki)) {
      this.ekwipunki = new Map(state.ekwipunki.map((e) => [e.key, { typ: e.typ, username: e.username }]));
    }
    if (typeof state.kwotaKradzieznaSek === 'number') this.kwotaKradzieznaSek = state.kwotaKradzieznaSek;
    if (typeof state.kradziezAktywna === 'boolean') this.kradziezAktywna = state.kradziezAktywna;
  }

  /** Widz dolaczajacy w trakcie walki - ustawienie od razu w synchronizowanej pozycji. */
  startFromSync(state) {
    this.applySync(state);
    if (this.model) {
      this.model.position.set(this.startX, 0, this.startZ);
      if (this.celX !== this.startX || this.celZ !== this.startZ) this.model.lookAt(this.celX, 0, this.celZ);
    }
    this.playAction('idle', { hard: true });
  }
}
