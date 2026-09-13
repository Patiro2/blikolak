import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { strumien, losujInt, losujZ } from './rng.js';
import { showBossNotification } from './ui.js';
import { normalizeNick } from './kick.js';
import { normalizePolish } from './vanessa.js';
import { audio } from './audio.js';
import { arenaHalf } from './arena.js';

// Mechanika piatego bossa (tier 5 bankomatu) - Wilkolak. Trzymana w OSOBNYM
// pliku (wzorzec src/boss-skorpion.js), zeby nie dotykac zweryfikowanej logiki
// bossow 1-4. BossManager tworzy instancje tej klasy w start() (gdy
// def.mechanika === 'wilkolak') i deleguje do niej start walki, update() w
// CUTSCENE/FIGHT, HP/FSM/nakladki DOM/kamera zostaja w BossManager (patrz
// boss.js, grep "wilkolak").
//
// ETAP 1 (ten plik): Integracja, Model, Dzwieki, Sterowanie z czatu, FAZA 1
// (100 -> 50 HP: Szal alkoholowy z kontra+stunem, Nur, Placz, Szal banowy).
// ETAP 2 (kolejny agent): Przejscie (HP<=50), FAZA 2 (rzut piwem), Zwyciestwo.
// Punkt zaczepienia zostawiony w _wejdzWFaze2() ponizej (TODO) i w
// _wybierzKolejnyAtak() (pula atakow FAZY 1 w jednej stalej, latwa do podmiany).
//
// WZORZEC SYNCHRONIZACJI (identyczny co Skorpion, patrz naglowek tamtego
// pliku): telegraf ataku (kto/gdzie/kiedy, znaczniki pol, ruch modelu) jest
// liczony DETERMINISTYCZNIE ze wspolnego strumienia (src/rng.js) - kazda
// otwarta karta gry dochodzi do tego samego wyniku bez czekania na sync, wiec
// animacja jest plynna u kazdego widza. Decyzje z ekonomicznym skutkiem
// (obrazenia bossa, smierc/kradziez gracza, nagrody, bany) sa bramkowane
// `boss.czyNaliczanieDozwolone()` - tylko host je wykonuje, widz dostaje ich
// WYNIK (hp, ranking, pozycje graczy) przez juz istniejace mechanizmy sync
// (generyczny boss.applySync dla hp, kickChat/workerManager dla reszty).
// Do tego dochodzi WLASNY sync FSM (faza/fazaT/dane) - patrz getSyncState -
// zeby widz DOLACZAJACY W TRAKCIE walki (startFromSync) mogl od razu pokazac
// biezacy telegraf, zamiast czekac do konca fazy.

const WILK_SCALE = 2; // "skala 2x wzgledem zwyklych postaci graczy" (patrz zadanie)
const CZAS_WEJSCIA = 2.6; // sekund - timing karty tytulowej/letterboxu (jak Skorpion)

const KOLOR_ZAMACH = 0xff3b30; // czerwone pola - zamach Szalu alkoholowego / trasa Nura / rzut piwem (faza 2)
const KOLOR_STUN = 0x2fb4ff; // niebieskie pola - stun Szalu alkoholowego / kwadrat Placzu

const CZAS_MIEDZY_ATAKAMI = [8, 12]; // sekund [min,max] do kolejnego ataku
const SZANSA_BANOWY = 0.10; // ~10% szans na Szal banowy zamiast zwyklego ataku

const ALKOHOL_BIEG_CZAS = 1.1; // sekund biegu (sprint) na pole obok gracza
const ALKOHOL_ZAMACH_CZAS = 2.0; // sekund telegrafu przed sweepem/kontra
const ALKOHOL_STUN_CZAS = 10.0; // sekund stuna po udanej kontrze
const ALKOHOL_STUN_DMG = 25;
const ALKOHOL_KONTRA_NAGRODA = 100; // zl dla kontrujacego

const NUR_KROK_CZAS = 0.2; // sekund na pole
const NUR_OSTRZEZENIE_CZAS = 3.0; // sekund telegrafu calej trasy przed startem
const NUR_KRADZIEZ_PROCENT = 0.5; // 50% WLASNEGO dorobku ofiary

const PLACZ_CZAS_OKNA = 15.0; // sekund na dojscie na kwadrat
const PLACZ_NAGRODA = 25; // zl dla kazdego na kwadracie przy sukcesie
const PLACZ_KARA_PROCENT = 0.34; // 34% wspolnej puli przy porazce
const PLACZ_MAX_POWTOREK = 3;

const BAN_CZAS = 10.0; // sekund bana (ignorowane komendy poza ruchem)

const KOLOR_SIERSC = 0x5a4636; // brazowo-szara siersc (uszy/pysk/ogon)
const KOLOR_NOS = 0x1c1c1c;

export class BossWilkolak {
  constructor(boss) {
    // Referencja do BossManager - scena, workerManager, kickChat, economy,
    // czyNaliczanieDozwolone, projectAndFloat, damage, _killUser, _log,
    // _userForWorker, _workersOnTile - patrz boss.js.
    this.boss = boss;

    this.model = null;
    this.mixer = null;
    this.currentAction = null;
    this.animations = [];

    this.fazaWejscia = false;
    this._wejscieT = 0;
    this._startWalki = null;

    this.x = 0;
    this.z = -2;
    this.facing = { x: 0, z: 1 }; // kierunek patrzenia (jednostkowy wektor siatki)

    // --- FSM ataku (patrz naglowek pliku - deterministyczny telegraf) ---
    this.faza = 'CZEKANIE'; // CZEKANIE | ALKOHOL_BIEG | ALKOHOL_ZAMACH | ALKOHOL_STUN | NUR | PLACZ | BANOWY
    this.fazaT = 0; // czas W BIEZACEJ fazie (rosnie) - uzywany do interpolacji/odliczania
    this._nextAtakAt = 0; // fightSec, w ktorej odpala sie kolejny atak
    this._licznikAtakow = 0;
    this._dane = {}; // dane biezacego ataku (patrz kazda faza nizej) - serializowane w sync

    this._faza2Wywolana = false; // patrz _wejdzWFaze2 - jednorazowy TODO-hak dla ETAPU 2

    // Pula atakow FAZY 1 - LATWA DO PODMIANY przez ETAP 2 (np. po Przejsciu
    // podmienic na ['piwo'] dla FAZY 2). Trzymana jako pole instancji, nie
    // stala modulu, wlasnie po to, zeby kolejny agent mogl ja nadpisac.
    this.pulaAtakow = ['alkohol', 'nur', 'placz'];

    // --- Znaczniki pol (BossAttackFx) - liczone przez KAZDA karte gry z danych w this._dane ---
    this._znaczniki = []; // lista wpisow fx.oznaczPole aktywnych w biezacej fazie
    this._nurZnacznikiPol = new Map(); // "x,z" -> wpis fx - gasza pojedynczo, w miare jak wilkolak wchodzi na kolejne pola

    // --- Ekonomiczne skutki (bramkowane hostem) ---
    this._kontraZlapana = false; // pierwszy "lo tego" wygrywa - dalsze sa ignorowane
    this._stunNagrodaWyplacona = false;
    this._nurTrafieni = new Set(); // normalizeNick ofiar juz trafionych w TYM przebiegu Nura
    this._placzNagrodzeni = new Set();

    // --- Szal banowy (patrz isBanned - uzywane przez main.js do bramkowania komend) ---
    this.bany = new Map(); // normalizeNick -> { username, doFightSec }

    // --- Wizualizacja placzu (nakladka DOM + krople) ---
    this._placzOverlay = null;
    this._placzKrople = [];

    this._ogonT = 0;
    this._ogonBaza = null;
  }

  // ================= BUDOWA MODELU =================

  /**
   * Buduje wilkolaka z postaci o wspolnym szkielecie Kenneya (character-male-a,
   * kenney_mini-arcade - ten sam rig/klipy co reszta postaci w grze, patrz
   * CLAUDE.md "Every character across every pack shares one rig"), z
   * doklejonymi proceduralnymi uszami/pyskiem (do kosci 'head') i ogonem (do
   * 'torso'). Brak modelu wilkolaka w zadnej paczce Kenneya (patrz CLAUDE.md,
   * lista 294 modeli) - stad prymitywy Three.js, dokladnie jak proceduralny
   * ogon Skorpiona w boss-skorpion.js. Skala 2x wzgledem zwyklych postaci
   * graczy (zadanie wlasciciela).
   */
  build() {
    const boss = this.boss;
    // SkeletonUtils.clone (NIE zwykle clone(true)) - postac jest SKINNED
    // (mini-pack, skins:2 wg CLAUDE.md), zwykle klonowanie rozjezdza skinning
    // (dokladnie ten sam problem co przy _buildModel() bossa 1 w boss.js).
    const char = SkeletonUtils.clone(boss.wilkolakTemplate);
    this.animations = boss.wilkolakAnimations || [];
    char.scale.setScalar(WILK_SCALE);

    char.traverse((n) => {
      if (n.isMesh) {
        n.castShadow = true;
        n.receiveShadow = true;
        if (n.material) {
          // Sciemnienie sierscia calej postaci - "ciemny" wyglad wilkolaka bez
          // podmieniania atlasu palety (patrz CLAUDE.md o wspoldzielonym
          // colormap.png - podmiana calej tekstury zepsulaby inne modele
          // korzystajace z tego samego cache'a).
          const mat = n.material.clone();
          mat.color.multiplyScalar(0.4);
          n.material = mat;
        }
      }
    });

    this.model = char;
    this.mixer = new THREE.AnimationMixer(char);
    this.currentAction = null;

    this._zbudujCzesciWilka(char);

    boss.scene.add(char);
    return char;
  }

  /** Uszy (2x stozek), pysk (kapsula) na kosci 'head', ogon (lancuch kapsul) na kosci 'torso'. */
  _zbudujCzesciWilka(char) {
    const material = new THREE.MeshStandardMaterial({ color: KOLOR_SIERSC, roughness: 0.85 });

    const head = char.getObjectByName('head');
    if (head) {
      const uszy = new THREE.Group();
      for (const side of [-1, 1]) {
        const ucho = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.22, 6), material);
        ucho.position.set(side * 0.13, 0.22, -0.02);
        ucho.rotation.z = side * -0.35;
        ucho.rotation.x = 0.15;
        ucho.castShadow = true;
        uszy.add(ucho);
      }
      head.add(uszy);

      const pysk = new THREE.Mesh(new THREE.CapsuleGeometry(0.075, 0.14, 4, 8), material);
      pysk.rotation.x = Math.PI / 2;
      pysk.position.set(0, -0.03, 0.19);
      pysk.castShadow = true;
      head.add(pysk);

      const nos = new THREE.Mesh(
        new THREE.SphereGeometry(0.035, 8, 8),
        new THREE.MeshStandardMaterial({ color: KOLOR_NOS, roughness: 0.4 }),
      );
      nos.position.set(0, -0.03, 0.27);
      head.add(nos);
    }

    const torso = char.getObjectByName('torso');
    if (torso) {
      const grupa = new THREE.Group();
      grupa.position.set(0, 0.05, -0.11);
      torso.add(grupa);
      this._ogonBaza = grupa;

      const dlugosci = [0.16, 0.14, 0.11];
      const promienie = [0.05, 0.042, 0.032];
      const katy = [0.5, 0.35, 0.25];
      let parent = grupa;
      for (let i = 0; i < dlugosci.length; i++) {
        const joint = new THREE.Group();
        joint.rotation.x = katy[i];
        parent.add(joint);
        const seg = new THREE.Mesh(new THREE.CapsuleGeometry(promienie[i], dlugosci[i], 4, 8), material);
        seg.position.y = -(dlugosci[i] / 2 + promienie[i]);
        seg.rotation.x = Math.PI;
        seg.castShadow = true;
        joint.add(seg);
        const nastepny = new THREE.Group();
        nastepny.position.y = -(dlugosci[i] + promienie[i] * 2);
        joint.add(nastepny);
        parent = nastepny;
      }
    }
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

  beginEntrance() {
    this.x = 0; this.z = -2;
    this.facing = { x: 0, z: 1 };
    this.faza = 'CZEKANIE';
    this.fazaT = 0;
    this._dane = {};
    this._licznikAtakow = 0;
    this.bany.clear();
    this._faza2Wywolana = false;

    if (this.model) {
      this.model.position.set(this.x, 0, this.z);
      this.model.lookAt(0, 0, 0);
    }
    this.fazaWejscia = true;
    this._wejscieT = 0;
    this._startWalki = null;
    audio.wilkolakWycie();
    this.playAction('idle', { hard: true });
    showBossNotification(
      'boss',
      '🐺 WILKOŁAK WCHODZI NA ARENĘ!',
      'Ostatni boss Myśliborza! Uważajcie na Szał alkoholowy (kontrujcie pisząc "ło tego"!), Nura i Płacz.',
    );
    this.boss._log('spawn', `Wilkolak pojawia sie na arenie na polu [${this.x}, ${this.z}]`);
  }

  _updateEntrance(delta) {
    this._wejscieT += delta;
    if (this._wejscieT >= CZAS_WEJSCIA) {
      this.fazaWejscia = false;
      this._startWalki = Date.now();
      this._ustawNastepnyAtak();
    }
  }

  _fightSec() {
    if (!this._startWalki) return 0;
    return Math.max(0, (Date.now() - this._startWalki) / 1000);
  }

  // ================= HELPERY WSPOLNE =================

  _jestemHostem() {
    return !this.boss.czyNaliczanieDozwolone || this.boss.czyNaliczanieDozwolone();
  }

  /** Deterministyczny strumien zakotwiczony w liczniku ataku - kazda karta gry liczy to samo. */
  _rng(nazwa) {
    const seed = this.boss.economy.state.seedGry;
    const idWalki = this.boss.pendingTier;
    return strumien(`${seed}:wilkolak-${nazwa}:${idWalki}:${this._licznikAtakow}`);
  }

  /** Zywi gracze w grze: nieomdleni (wilkolak nie ma omdlen), niewyeliminowani, z przypisanym awatarem. */
  _zywiGracze() {
    const out = [];
    if (!this.boss.kickChat || !this.boss.workerManager) return out;
    const top10 = this.boss.kickChat.getTopEarners(10);
    for (const u of top10) {
      if (this.boss.kickChat.isEliminated(u.username)) continue;
      const slot = this.boss.kickChat.getWorkerForUser(u.username);
      if (slot === null) continue;
      const entry = this.boss.workerManager.getWorkerType(slot);
      if (!entry || !entry.obj) continue;
      const x = entry.isMoving ? entry.targetGridX : entry.gridX;
      const z = entry.isMoving ? entry.targetGridZ : entry.gridZ;
      out.push({ username: u.username, entry, x: Number(x), z: Number(z) });
    }
    return out;
  }

  _workersOnTile(x, z) {
    return this.boss._workersOnTile(x, z);
  }

  _userForWorker(entry) {
    return this.boss._userForWorker(entry);
  }

  _wSiatce(x, z) {
    const half = arenaHalf(this.boss.economy);
    return Math.abs(x) <= half && Math.abs(z) <= half;
  }

  _wyczyscZnaczniki() {
    for (const w of this._znaczniki) this.boss.fx.usunZnacznik(w);
    this._znaczniki = [];
  }

  // ================= WYBOR KOLEJNEGO ATAKU =================

  _ustawNastepnyAtak() {
    this.faza = 'CZEKANIE';
    this.fazaT = 0;
    this._dane = {};
    const rngCzas = strumien(`${this.boss.economy.state.seedGry}:wilkolak-czas:${this.boss.pendingTier}:${this._licznikAtakow}`);
    this._nextAtakAt = this._fightSec() + CZAS_MIEDZY_ATAKAMI[0] + rngCzas() * (CZAS_MIEDZY_ATAKAMI[1] - CZAS_MIEDZY_ATAKAMI[0]);
  }

  _updateCzekanie() {
    if (this._fightSec() < this._nextAtakAt) return;
    this._licznikAtakow += 1;
    const rngWybor = this._rng('wybor');
    if (rngWybor() < SZANSA_BANOWY) {
      this._rozpocznijBanowy();
      return;
    }
    const typ = losujZ(this._rng('typ'), this.pulaAtakow);
    if (typ === 'alkohol') this._rozpocznijAlkoholBieg();
    else if (typ === 'nur') this._rozpocznijNur();
    else if (typ === 'placz') this._rozpocznijPlacz();
    else this._ustawNastepnyAtak(); // pula podmieniona na nieznany typ (ETAP 2) - bezpieczny fallback
  }

  // ================= SZAL ALKOHOLOWY =================

  _rozpocznijAlkoholBieg() {
    const zywi = this._zywiGracze();
    if (zywi.length === 0) { this._ustawNastepnyAtak(); return; }
    const ofiara = losujZ(this._rng('alkohol-ofiara'), zywi);

    // Pole obok ofiary - jeden z 4 sasiadow, preferujac te w obrebie areny
    // i rozne od pola bankomatu.
    const kandydaci = [[1, 0], [-1, 0], [0, 1], [0, -1]]
      .map(([dx, dz]) => ({ x: ofiara.x + dx, z: ofiara.z + dz }))
      .filter((p) => this._wSiatce(p.x, p.z) && !(p.x === 0 && p.z === 0));
    const cel = kandydaci.length > 0
      ? losujZ(this._rng('alkohol-pole'), kandydaci)
      : { x: ofiara.x, z: ofiara.z };

    this.faza = 'ALKOHOL_BIEG';
    this.fazaT = 0;
    this._dane = {
      startX: this.x, startZ: this.z, celX: cel.x, celZ: cel.z,
      patrzX: ofiara.x, patrzZ: ofiara.z,
    };
    audio.wilkolakSwist();
    this.boss._log('bad', `Wilkolak rusza w strone @${ofiara.username} - Szal alkoholowy`, { cel });
  }

  _updateAlkoholBieg(delta) {
    this.fazaT += delta;
    const d = this._dane;
    const u = Math.min(1, this.fazaT / ALKOHOL_BIEG_CZAS);
    if (this.model) {
      this.model.position.set(
        d.startX + (d.celX - d.startX) * u,
        0,
        d.startZ + (d.celZ - d.startZ) * u,
      );
      this.model.lookAt(d.patrzX, 0, d.patrzZ);
      this.playAction('sprint');
    }
    if (u >= 1) {
      this.x = d.celX; this.z = d.celZ;
      // Kierunek patrzenia zaokraglony do najblizszego kierunku siatki (na
      // wprost ofiary) - potrzebny do wyliczenia rzedow pol przed/za nim.
      const dx = d.patrzX - this.x;
      const dz = d.patrzZ - this.z;
      this.facing = Math.abs(dx) >= Math.abs(dz)
        ? { x: Math.sign(dx) || 1, z: 0 }
        : { x: 0, z: Math.sign(dz) || 1 };
      this._rozpocznijZamach();
    }
  }

  _frontTiles() {
    const rv = { x: -this.facing.z, z: this.facing.x }; // wektor prostopadly (w prawo)
    const mid = { x: this.x + this.facing.x, z: this.z + this.facing.z };
    return [
      { x: mid.x - rv.x, z: mid.z - rv.z },
      { x: mid.x, z: mid.z },
      { x: mid.x + rv.x, z: mid.z + rv.z },
    ];
  }

  _backTiles() {
    const rv = { x: -this.facing.z, z: this.facing.x };
    const mid = { x: this.x - this.facing.x, z: this.z - this.facing.z };
    return [
      { x: mid.x - rv.x, z: mid.z - rv.z },
      { x: mid.x, z: mid.z },
      { x: mid.x + rv.x, z: mid.z + rv.z },
    ];
  }

  _rozpocznijZamach() {
    this.faza = 'ALKOHOL_ZAMACH';
    this.fazaT = 0;
    this._kontraZlapana = false;
    const front = this._frontTiles();
    this._dane = { front };
    this._wyczyscZnaczniki();
    for (const t of front) this._znaczniki.push(this.boss.fx.oznaczPole(t.x, t.z, KOLOR_ZAMACH, ALKOHOL_ZAMACH_CZAS));
    if (this.model) this.model.lookAt(this.x + this.facing.x, 0, this.z + this.facing.z);
    this.playAction('attack-melee-right', { once: true }) || this.playAction('emote-yes', { once: true });
    audio.wilkolakUderzenie();
    showBossNotification(
      'boss',
      '🍺 SZAŁ ALKOHOLOWY!',
      'Wilkołak zamierza się na 3 pola przed sobą! Kto stoi ZA jego plecami, niech pisze "ło tego" - to kontra!',
    );
  }

  _updateZamach(delta) {
    this.fazaT += delta;
    if (this.fazaT >= ALKOHOL_ZAMACH_CZAS) {
      if (this._kontraZlapana) this._rozpocznijStun();
      else this._wykonajSweep();
    }
  }

  _wykonajSweep() {
    this._wyczyscZnaczniki();
    if (this._jestemHostem()) {
      const front = this._dane.front || this._frontTiles();
      for (const t of front) {
        for (const entry of this._workersOnTile(t.x, t.z)) {
          const nick = this._userForWorker(entry);
          if (nick) this.boss._killUser(nick, { source: 'wilkolak' });
        }
      }
    }
    audio.wilkolakUderzenie();
    this._ustawNastepnyAtak();
  }

  /** Wykrywanie kontry - patrz onChatMessage. Wolane WYLACZNIE z fazy ALKOHOL_ZAMACH. */
  _sprobujKontre(username) {
    if (this._kontraZlapana) return;
    const back = this._backTiles();
    const pozycja = this._zywiGracze().find((g) => normalizeNick(g.username) === normalizeNick(username));
    if (!pozycja) return;
    const naPolu = back.some((t) => t.x === pozycja.x && t.z === pozycja.z);
    if (!naPolu) return;

    this._kontraZlapana = true;
    this._kontraGracz = username;
    this._pokazKontre(username);
  }

  _pokazKontre(username) {
    audio.wilkolakUderzenie();
    showBossNotification(
      'hit',
      `🛡️ @${username} SKONTROWAŁ WILKOŁAKA!`,
      'Atak przerwany - wilkołak zostaje ogłuszony na 10 sekund!',
    );
    this.boss._log('good', `@${username} kontruje Szal alkoholowy - wilkolak STUN`, { gracz: username });
  }

  _rozpocznijStun() {
    this._wyczyscZnaczniki();
    this.faza = 'ALKOHOL_STUN';
    this.fazaT = 0;
    this._stunNagrodaWyplacona = false;
    const back = this._backTiles();
    this._dane = { back };
    for (const t of back) {
      if (!this._wSiatce(t.x, t.z) || (t.x === 0 && t.z === 0)) continue;
      this._znaczniki.push(this.boss.fx.oznaczPole(t.x, t.z, KOLOR_STUN, ALKOHOL_STUN_CZAS));
    }
    this.playAction('emote-no', { once: true }) || this.playAction('idle');

    if (this._jestemHostem() && this._kontraGracz) {
      if (this.boss.kickChat) {
        this.boss.kickChat.recordEarned(this._kontraGracz, ALKOHOL_KONTRA_NAGRODA, undefined, false);
      }
      if (this.boss.economy) this.boss.economy.addMoney(ALKOHOL_KONTRA_NAGRODA);
      if (this.boss.projectAndFloat && this.model) {
        this.boss.projectAndFloat(this.model.position.clone().add(new THREE.Vector3(0, 2.4 * WILK_SCALE, 0)), `+${ALKOHOL_KONTRA_NAGRODA} zł`, { gold: true });
      }
    }
    this._kontraGracz = null;
  }

  _updateStun(delta) {
    this.fazaT += delta;
    if (this._jestemHostem() && !this._stunNagrodaWyplacona) {
      const back = this._dane.back || [];
      let pominiete = 0;
      const valid = [];
      for (const t of back) {
        if (!this._wSiatce(t.x, t.z) || (t.x === 0 && t.z === 0)) { pominiete += 1; continue; }
        valid.push(t);
      }
      const wymagane = Math.max(0, Math.min(3, this._zywiGracze().length) - pominiete);
      const wlasciciele = new Set();
      for (const t of valid) {
        for (const entry of this._workersOnTile(t.x, t.z)) {
          const nick = this._userForWorker(entry);
          if (nick) wlasciciele.add(normalizeNick(nick));
        }
      }
      if (wymagane > 0 && wlasciciele.size >= wymagane) {
        this._stunNagrodaWyplacona = true;
        this._wyczyscZnaczniki();
        this.boss.damage(ALKOHOL_STUN_DMG);
        audio.wilkolakUderzenie();
        showBossNotification('hit', '💥 STUN WYKORZYSTANY!', `Wilkołak traci ${ALKOHOL_STUN_DMG} HP!`);
        this.boss._log('good', `Gracze wykorzystali stun Wilkolaka - traci ${ALKOHOL_STUN_DMG} HP`);
      }
    }
    if (this.fazaT >= ALKOHOL_STUN_CZAS) {
      this._wyczyscZnaczniki();
      this._ustawNastepnyAtak();
    }
  }

  // ================= NUR =================

  _budujTrasNura(half, pionowo, rzedyOdwrocone, kierunekStart) {
    const linie = [];
    for (let g = -half; g <= half; g += 2) linie.push(g);
    if (rzedyOdwrocone) linie.reverse();
    const trasa = [];
    let dir = kierunekStart;
    for (let i = 0; i < linie.length; i++) {
      const g = linie[i];
      const osie = [];
      for (let s = -half; s <= half; s++) osie.push(s);
      if (dir === -1) osie.reverse();
      for (const s of osie) {
        const x = pionowo ? g : s;
        const z = pionowo ? s : g;
        if (x === 0 && z === 0) continue; // bankomat - wilkolak go przeskakuje
        trasa.push({ x, z });
      }
      if (i < linie.length - 1) {
        const nastG = linie[i + 1];
        const brzegS = osie[osie.length - 1];
        const posr = (g + nastG) / 2; // przejscie miedzy rzedami przez pole krawedziowe
        trasa.push({ x: pionowo ? posr : brzegS, z: pionowo ? brzegS : posr });
      }
      dir = -dir;
    }
    return trasa;
  }

  _rozpocznijNur() {
    const half = arenaHalf(this.boss.economy);
    const rng = this._rng('nur-wariant');
    const pionowo = rng() < 0.5;
    const rzedyOdwrocone = rng() < 0.5;
    const kierunekStart = rng() < 0.5 ? 1 : -1;
    const trasa = this._budujTrasNura(half, pionowo, rzedyOdwrocone, kierunekStart);

    this.faza = 'NUR';
    this.fazaT = 0;
    this._nurTrafieni.clear();
    this._dane = { trasa, idx: -1, odpalona: false };

    this._wyczyscZnaczniki();
    for (const t of trasa) {
      const wpis = this.boss.fx.oznaczPole(t.x, t.z, KOLOR_ZAMACH, NUR_OSTRZEZENIE_CZAS + trasa.length * NUR_KROK_CZAS);
      this._nurZnacznikiPol.set(`${t.x},${t.z}`, wpis);
    }
    audio.wilkolakSwist();
    showBossNotification('boss', '🐍 NUR!', `Wilkołak przemyka wężykiem po arenie - trasa świeci na czerwono, uciekajcie z niej!`);
    this.boss._log('bad', 'Wilkolak zaczyna Nura', { dlugoscTrasy: trasa.length });
  }

  _updateNur(delta) {
    this.fazaT += delta;
    const d = this._dane;
    if (this.fazaT < NUR_OSTRZEZENIE_CZAS) return;

    const tCzas = this.fazaT - NUR_OSTRZEZENIE_CZAS;
    const nowyIdx = Math.min(d.trasa.length - 1, Math.floor(tCzas / NUR_KROK_CZAS));
    if (nowyIdx !== d.idx) {
      const poprzedni = d.idx >= 0 ? d.trasa[d.idx] : { x: this.x, z: this.z };
      d.idx = nowyIdx;
      const bieg = d.trasa[nowyIdx];
      this.x = bieg.x; this.z = bieg.z;
      // Gasniemy znacznik pola, przez ktore wilkolak wlasnie przeszedl.
      const key = `${poprzedni.x},${poprzedni.z}`;
      const wpis = this._nurZnacznikiPol.get(key);
      if (wpis) { this.boss.fx.usunZnacznik(wpis); this._nurZnacznikiPol.delete(key); }
      audio.play('krok');

      if (this._jestemHostem()) {
        for (const entry of this._workersOnTile(bieg.x, bieg.z)) {
          const nick = this._userForWorker(entry);
          if (!nick) continue;
          const key2 = normalizeNick(nick);
          if (this._nurTrafieni.has(key2)) continue;
          this._nurTrafieni.add(key2);
          this._trafNura(nick, entry, bieg);
        }
      }
    }
    if (this.model) {
      const poprzedni = d.trasa[Math.max(0, nowyIdx - 1)] || { x: this.x, z: this.z };
      const bieg = d.trasa[nowyIdx];
      const uLok = Math.min(1, (tCzas - nowyIdx * NUR_KROK_CZAS) / NUR_KROK_CZAS);
      const skok = Math.abs(bieg.x - poprzedni.x) + Math.abs(bieg.z - poprzedni.z) > 1;
      this.model.position.set(
        poprzedni.x + (bieg.x - poprzedni.x) * uLok,
        skok ? Math.sin(Math.PI * uLok) * 0.6 * WILK_SCALE : 0,
        poprzedni.z + (bieg.z - poprzedni.z) * uLok,
      );
      if (bieg.x !== poprzedni.x || bieg.z !== poprzedni.z) this.model.lookAt(bieg.x, 0, bieg.z);
      this.playAction('attack-melee-left');
    }

    if (nowyIdx >= d.trasa.length - 1 && tCzas >= (d.trasa.length - 1) * NUR_KROK_CZAS + NUR_KROK_CZAS) {
      this._zakonczNur();
    }
  }

  /** Krazenie 50% wlasnego dorobku ofiary + przesuniecie na najblizsze bezpieczne pole. */
  _trafNura(nick, entry, bieg) {
    const key = normalizeNick(nick);
    const wpis = this.boss.kickChat.leaderboard[key];
    const kwota = wpis ? Math.round((wpis.totalEarned || 0) * NUR_KRADZIEZ_PROCENT) : 0;
    if (kwota > 0) {
      this.boss.kickChat.stealMoneyFromUser(nick, kwota);
      if (this.boss.economy) this.boss.economy.state.money = Math.max(0, this.boss.economy.state.money - kwota);
    }
    const bezpieczne = this._najblizszePoleBezpieczne(bieg.x, bieg.z);
    if (bezpieczne && entry) {
      entry.gridX = bezpieczne.x; entry.gridZ = bezpieczne.z;
      entry.targetGridX = bezpieczne.x; entry.targetGridZ = bezpieczne.z;
      if (entry.obj) entry.obj.position.set(bezpieczne.x, 0, bezpieczne.z);
    }
    audio.wilkolakUderzenie();
    if (this.boss.projectAndFloat && entry && entry.obj) {
      this.boss.projectAndFloat(entry.obj.position.clone().add(new THREE.Vector3(0, 1.4, 0)), `🐍 -${kwota} zł`, { crit: true, steal: true });
    }
    showBossNotification('hit', `🐍 @${nick} WPADŁ NA NURA!`, `Traci <strong>${kwota} zł</strong> ze swojego dorobku i zostaje odsunięty z trasy.`);
    this.boss._log('bad', `Nur trafil @${nick} - stracil ${kwota} zl`, { gracz: nick, kwota });
  }

  /** Szuka najblizszego wolnego pola (nie na trasie, nie bankomat, w arenie) - spirala od (x,z). */
  _najblizszePoleBezpieczne(x, z) {
    const trasaSet = new Set((this._dane.trasa || []).map((t) => `${t.x},${t.z}`));
    for (let promien = 1; promien <= 12; promien++) {
      for (let dx = -promien; dx <= promien; dx++) {
        for (let dz = -promien; dz <= promien; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== promien) continue;
          const px = x + dx; const pz = z + dz;
          if (!this._wSiatce(px, pz)) continue;
          if (px === 0 && pz === 0) continue;
          if (trasaSet.has(`${px},${pz}`)) continue;
          return { x: px, z: pz };
        }
      }
    }
    return null;
  }

  _zakonczNur() {
    for (const wpis of this._nurZnacznikiPol.values()) this.boss.fx.usunZnacznik(wpis);
    this._nurZnacznikiPol.clear();
    this._ustawNastepnyAtak();
  }

  // ================= PLACZ =================

  _wylosujKwadrat() {
    const half = arenaHalf(this.boss.economy);
    const rng = this._rng(`placz-kwadrat-${this._dane.proba || 0}`);
    // Srodek kwadratu 3x3 w zakresie [-half+1, half-1], odrzucajac te, ktore
    // zawieraja bankomat (0,0).
    const kandydaci = [];
    for (let x = -half + 1; x <= half - 1; x++) {
      for (let z = -half + 1; z <= half - 1; z++) {
        let zawieraBank = false;
        for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
          if (x + dx === 0 && z + dz === 0) zawieraBank = true;
        }
        if (!zawieraBank) kandydaci.push({ x, z });
      }
    }
    return losujZ(rng, kandydaci) || { x: 1, z: 1 };
  }

  _rozpocznijPlacz(proba = 1) {
    this.faza = 'PLACZ';
    this.fazaT = 0;
    this._placzNagrodzeni.clear();
    this._dane = { proba, srodek: null };
    this._dane.srodek = this._wylosujKwadrat();

    this._wyczyscZnaczniki();
    const pola = this._kwadratPola(this._dane.srodek);
    for (const p of pola) this._znaczniki.push(this.boss.fx.oznaczPole(p.x, p.z, KOLOR_STUN, PLACZ_CZAS_OKNA));

    this._pokazPlaczOverlay();
    audio.wilkolakChlipanie();
    showBossNotification(
      'boss',
      '😭 PŁACZ WILKOŁAKA!',
      `Zbierzcie się na niebieskim kwadracie 3×3 - macie ${PLACZ_CZAS_OKNA}s! Wymagane: ${this._wymaganiPlacz()} graczy.`,
    );
    this.boss._log('bad', `Wilkolak zaczyna Placz (proba ${proba})`, { srodek: this._dane.srodek });
  }

  _kwadratPola(srodek) {
    const pola = [];
    for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) pola.push({ x: srodek.x + dx, z: srodek.z + dz });
    return pola;
  }

  _wymaganiPlacz() {
    return Math.max(1, Math.ceil(this._zywiGracze().length * 0.4));
  }

  _updatePlacz(delta) {
    this.fazaT += delta;
    this._aktualizujPlaczOverlay(delta);
    if (this.fazaT < PLACZ_CZAS_OKNA) return;

    const pola = this._kwadratPola(this._dane.srodek);
    const obecni = new Set();
    for (const p of pola) {
      for (const entry of this._workersOnTile(p.x, p.z)) {
        const nick = this._userForWorker(entry);
        if (nick) obecni.add(nick);
      }
    }
    const wymagani = this._wymaganiPlacz();
    const sukces = obecni.size >= wymagani;

    if (this._jestemHostem()) {
      for (const nick of obecni) {
        if (this._placzNagrodzeni.has(normalizeNick(nick))) continue;
        this._placzNagrodzeni.add(normalizeNick(nick));
        if (this.boss.kickChat) this.boss.kickChat.recordEarned(nick, PLACZ_NAGRODA, undefined, false);
        if (this.boss.economy) this.boss.economy.addMoney(PLACZ_NAGRODA);
      }
      if (!sukces && this.boss.economy) {
        const kara = Math.round(this.boss.economy.state.money * PLACZ_KARA_PROCENT);
        this.boss.economy.state.money = Math.max(0, this.boss.economy.state.money - kara);
        this.boss._log('bad', `Placz nieudany - wspolna pula traci ${kara} zl (${Math.round(PLACZ_KARA_PROCENT * 100)}%)`);
      }
    }

    this._wyczyscZnaczniki();
    this._ukryjPlaczOverlay();

    if (sukces) {
      audio.wilkolakUderzenie();
      showBossNotification('hit', '💧 PŁACZ POWSTRZYMANY!', `Nikt nie zginął, obecni na kwadracie dostają +${PLACZ_NAGRODA} zł każdy!`);
      this._ustawNastepnyAtak();
      return;
    }

    showBossNotification('kill', '😭 ZA MAŁO OSÓB!', `Wspólna pula traci ${Math.round(PLACZ_KARA_PROCENT * 100)}% - pojawia się nowy kwadrat.`);
    const proba = (this._dane.proba || 1) + 1;
    if (proba > PLACZ_MAX_POWTOREK) {
      this._ustawNastepnyAtak();
    } else {
      this._rozpocznijPlacz(proba);
    }
  }

  // --- Nakladka DOM "Placz" (ciemny ekran + krople) - proste, bez biblioteki czastek ---
  _pokazPlaczOverlay() {
    if (!this._placzOverlay) {
      const el = document.createElement('div');
      el.className = 'wilkolak-placz-overlay';
      for (let i = 0; i < 24; i++) {
        const kropla = document.createElement('div');
        kropla.className = 'wilkolak-lza';
        kropla.style.left = `${Math.random() * 100}%`;
        kropla.style.animationDelay = `${Math.random() * 2}s`;
        kropla.style.animationDuration = `${1.1 + Math.random() * 0.9}s`;
        el.appendChild(kropla);
      }
      document.body.appendChild(el);
      this._placzOverlay = el;
    }
    this._placzOverlay.style.display = 'block';
  }

  _aktualizujPlaczOverlay() {
    // Krople sa czysto CSS-owe (animacja spadania w kolko, patrz style.css) -
    // nic tu nie trzeba liczyc co klatke poza obecnoscia nakladki.
  }

  _ukryjPlaczOverlay() {
    if (this._placzOverlay) this._placzOverlay.style.display = 'none';
  }

  // ================= SZAL BANOWY =================

  _rozpocznijBanowy() {
    const zywi = this._zywiGracze();
    if (zywi.length === 0) { this._ustawNastepnyAtak(); return; }
    const ofiara = losujZ(this._rng('ban-ofiara'), zywi);

    this.faza = 'BANOWY';
    this.fazaT = 0;
    this._dane = { ofiara: ofiara.username, celX: ofiara.x, celZ: ofiara.z };
    audio.wilkolakSwist();
    showBossNotification('boss', '🚫 SZAŁ BANOWY!', `Wilkołak rzuca klątwą w @${ofiara.username}!`);
    this.boss._log('bad', `Wilkolak rzuca BAN w @${ofiara.username}`);
  }

  _updateBanowy(delta) {
    this.fazaT += delta;
    if (this.fazaT < 0.9) return;
    if (this._jestemHostem() && !this._daneBanZastosowany) {
      this._daneBanZastosowany = true;
      const nick = this._dane.ofiara;
      const key = normalizeNick(nick);
      this.bany.set(key, { username: nick, doFightSec: this._fightSec() + BAN_CZAS });
      showBossNotification('kill', `🚫 @${nick} ZBANOWANY!`, `Ignorowane są jego komendy (poza ruchem) przez ${BAN_CZAS}s.`);
      this.boss._log('bad', `@${nick} zbanowany na ${BAN_CZAS}s (Szal banowy)`, { gracz: nick });
    }
    if (this.fazaT >= 1.3) {
      this._daneBanZastosowany = false;
      this._ustawNastepnyAtak();
    }
  }

  /** Czy dany widz jest aktualnie zbanowany - patrz main.js (bramkuje komendy poza ruchem). */
  isBanned(username) {
    if (!username) return false;
    const wpis = this.bany.get(normalizeNick(username));
    if (!wpis) return false;
    if (this._fightSec() > wpis.doFightSec) {
      this.bany.delete(normalizeNick(username));
      return false;
    }
    return true;
  }

  _updateBanExpiry() {
    const teraz = this._fightSec();
    for (const [key, wpis] of [...this.bany]) {
      if (teraz > wpis.doFightSec) this.bany.delete(key);
    }
  }

  /**
   * Zapisuje ikone 🚫 WPROST na wpisie rankingu (patrz LeaderboardUI.render w
   * ui.js) - dokladnie ten sam wzorzec co BossSkorpion._renderIkonyEkwipunku.
   * Czysto kosmetyczne, wiec liczone przez KAZDA karte gry (bez bramki hosta).
   */
  _renderBanIkony() {
    const kickChat = this.boss.kickChat;
    if (!kickChat) return;
    const aktualne = new Set(this.bany.keys());
    for (const key of this._lastBanKeys || []) {
      if (aktualne.has(key)) continue;
      const wpis = kickChat.leaderboard[key];
      if (wpis) wpis.wilkolakBan = false;
    }
    for (const key of aktualne) {
      const wpis = kickChat.leaderboard[key];
      if (wpis) wpis.wilkolakBan = true;
    }
    this._lastBanKeys = aktualne;
  }

  // ================= FAZA 2 - PUNKT ZACZEPIENIA DLA ETAPU 2 =================

  /**
   * TODO(ETAP 2): tu ma wejsc mechanika "Przejscie" ze spec-wilkolak.md
   * (przerwanie ataku, wycie, teleport graczy na krawedzie, sciezki 1-2-3,
   * 15s), a po niej odpalenie FAZY 2 (rzut piwem zamiast pull atakow FAZY 1 -
   * podmienic this.pulaAtakow). NA RAZIE: nic nie robimy, walka toczy sie
   * dalej w FAZIE 1 (ta sama pula atakow) - zadanie wlasciciela wprost tego
   * wymaga na tym etapie.
   */
  _wejdzWFaze2() {
    this.boss._log('info', '[TODO ETAP 2] HP Wilkolaka <= 50 - tu wejdzie Przejscie + FAZA 2', { hp: this.boss.hp });
  }

  // ================= CZAT =================

  /**
   * Frazy sterujace (patrz zadanie): "lo tego"/"ło tego" (kontra Szalu
   * alkoholowego, tylko w fazie ALKOHOL_ZAMACH) i "rzut" (rzut piwem - FAZA 2,
   * na razie bez efektu, ETAP 2 go podepnie). Normalizacja jak reszta gry:
   * normalizePolish (usuwa polskie znaki diakrytyczne + lowercase).
   */
  onChatMessage(username, content) {
    if (this.isBanned(username)) return; // zbanowany - ignorujemy WSZYSTKIE jego komendy (poza ruchem, patrz main.js)
    const norm = normalizePolish(content);
    if (this.faza === 'ALKOHOL_ZAMACH' && /\blo tego\b/.test(norm)) {
      this._sprobujKontre(username);
    }
    // "rzut" - piwo FAZY 2 (ETAP 2 podepnie efekt, tu tylko rozpoznajemy frazę zgodnie z zadaniem).
  }

  // ================= UPDATE GLOWNY =================

  update(delta) {
    if (this.mixer) this.mixer.update(delta);
    this._ogonT += delta;
    if (this._ogonBaza) this._ogonBaza.rotation.y = Math.sin(this._ogonT * 2.2) * 0.35;

    if (this.fazaWejscia) {
      this._updateEntrance(delta);
      return;
    }

    this._updateBanExpiry();
    this._renderBanIkony();

    // Punkt zaczepienia ETAPU 2 - wolane co klatke, jednorazowo (patrz pole
    // _faza2Wywolana). Nie ma skutku ekonomicznego, wiec bezpiecznie na
    // KAZDEJ karcie gry (host i widz), bez bramki hosta.
    if (!this._faza2Wywolana && this.boss.hp <= 50) {
      this._faza2Wywolana = true;
      this._wejdzWFaze2();
    }

    if (this.faza === 'CZEKANIE') this._updateCzekanie();
    else if (this.faza === 'ALKOHOL_BIEG') this._updateAlkoholBieg(delta);
    else if (this.faza === 'ALKOHOL_ZAMACH') this._updateZamach(delta);
    else if (this.faza === 'ALKOHOL_STUN') this._updateStun(delta);
    else if (this.faza === 'NUR') this._updateNur(delta);
    else if (this.faza === 'PLACZ') this._updatePlacz(delta);
    else if (this.faza === 'BANOWY') this._updateBanowy(delta);

    if (this.faza === 'CZEKANIE' && this.model) {
      this.model.position.set(this.x, 0, this.z);
      this.playAction('idle');
    }
  }

  // ================= SPRZATANIE =================

  teardown() {
    this._wyczyscZnaczniki();
    for (const wpis of this._nurZnacznikiPol.values()) this.boss.fx.usunZnacznik(wpis);
    this._nurZnacznikiPol.clear();
    this._ukryjPlaczOverlay();
    if (this._placzOverlay) {
      this._placzOverlay.remove();
      this._placzOverlay = null;
    }
    const kickChat = this.boss.kickChat;
    if (kickChat) {
      for (const key of this._lastBanKeys || []) {
        const wpis = kickChat.leaderboard[key];
        if (wpis) wpis.wilkolakBan = false;
      }
    }
    this.bany.clear();
    this._lastBanKeys = new Set();
    this.mixer = null;
    this.currentAction = null;
  }

  // ================= SYNCHRONIZACJA =================

  /**
   * ponytail: widz nie odtwarza kazdej klatki telegrafu 1:1 (np. dokladny
   * timing skoku Nura) - dostaje faze/fazaT/dane co sync (jak reszta gry, co
   * kilka sekund) i doskakuje do wlasciwego miejsca (patrz applySync). To
   * samo uproszczenie co Kowal_88 robi z faza OKRAZENIE. Gdyby wlasciciel
   * chcial klatka-w-klatke identyczny telegraf u widza, trzeba by streamowac
   * znaczniki pol osobno - nieproporcjonalny wysilek na tym etapie.
   */
  getSyncState() {
    return {
      startWalki: this._startWalki,
      x: this.x,
      z: this.z,
      facing: this.facing,
      faza: this.faza,
      fazaT: this.fazaT,
      dane: this._dane,
      bany: Array.from(this.bany.entries()).map(([key, v]) => ({ key, username: v.username, doFightSec: v.doFightSec })),
    };
  }

  applySync(state) {
    if (!state) return;
    if (typeof state.startWalki === 'number' || state.startWalki === null) this._startWalki = state.startWalki;
    if (typeof state.x === 'number') this.x = state.x;
    if (typeof state.z === 'number') this.z = state.z;
    if (state.facing) this.facing = state.facing;
    if (Array.isArray(state.bany)) {
      this.bany = new Map(state.bany.map((b) => [b.key, { username: b.username, doFightSec: b.doFightSec }]));
    }
    if (typeof state.faza === 'string' && state.faza !== this.faza) {
      this.faza = state.faza;
      this.fazaT = typeof state.fazaT === 'number' ? state.fazaT : 0;
      this._dane = state.dane || {};
      this._odtworzZnacznikiFazy();
    } else if (typeof state.fazaT === 'number') {
      this.fazaT = state.fazaT;
      this._dane = state.dane || this._dane;
    }
    if (this.model) this.model.position.set(this.x, 0, this.z);
  }

  /** Widz - odtwarza znaczniki biezacej fazy z this._dane (bez logow/ekonomii, patrz naglowek pliku). */
  _odtworzZnacznikiFazy() {
    this._wyczyscZnaczniki();
    for (const wpis of this._nurZnacznikiPol.values()) this.boss.fx.usunZnacznik(wpis);
    this._nurZnacznikiPol.clear();
    this._ukryjPlaczOverlay();

    if (this.faza === 'ALKOHOL_ZAMACH' && this._dane.front) {
      for (const t of this._dane.front) this._znaczniki.push(this.boss.fx.oznaczPole(t.x, t.z, KOLOR_ZAMACH, Math.max(0.1, ALKOHOL_ZAMACH_CZAS - this.fazaT)));
    } else if (this.faza === 'ALKOHOL_STUN' && this._dane.back) {
      for (const t of this._dane.back) {
        if (!this._wSiatce(t.x, t.z) || (t.x === 0 && t.z === 0)) continue;
        this._znaczniki.push(this.boss.fx.oznaczPole(t.x, t.z, KOLOR_STUN, Math.max(0.1, ALKOHOL_STUN_CZAS - this.fazaT)));
      }
    } else if (this.faza === 'NUR' && this._dane.trasa) {
      for (const t of this._dane.trasa) {
        this._nurZnacznikiPol.set(`${t.x},${t.z}`, this.boss.fx.oznaczPole(t.x, t.z, KOLOR_ZAMACH, 30));
      }
    } else if (this.faza === 'PLACZ' && this._dane.srodek) {
      for (const p of this._kwadratPola(this._dane.srodek)) {
        this._znaczniki.push(this.boss.fx.oznaczPole(p.x, p.z, KOLOR_STUN, Math.max(0.1, PLACZ_CZAS_OKNA - this.fazaT)));
      }
      this._pokazPlaczOverlay();
    }
  }

  /** Widz dolaczajacy w trakcie walki. */
  startFromSync(state) {
    this.applySync(state);
    if (this.model) {
      this.model.position.set(this.x, 0, this.z);
      this.model.lookAt(this.x + this.facing.x, 0, this.z + this.facing.z);
    }
    this.playAction('idle', { hard: true });
    this._odtworzZnacznikiFazy();
  }
}
