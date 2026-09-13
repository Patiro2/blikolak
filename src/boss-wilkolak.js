import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { strumien, losujInt, losujZ, tasuj } from './rng.js';
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

// --- PRZEJSCIE (HP <= 50, jednorazowo) ---
const PRZEJSCIE_CZAS = 15.0; // sekund na przejscie sciezek
const PRZEJSCIE_NAGRODA = 20; // zl za zaliczenie calej sciezki (3 pola po kolei)
const PRZEJSCIE_DMG = 2.5; // obrazenia bossa za kazda zaliczona sciezke
// Paleta 10 kolorow (CSS hex) - jeden unikalny kolor na gracza, tyle ilu
// maksymalnie moze byc "graczy w grze" (Top 10, patrz _zywiGracze).
const KOLOR_SCIEZKI = ['#ff6b6b', '#4dd0e1', '#ffd54f', '#81c784', '#ba68c8', '#f06292', '#7986cb', '#a1887f', '#4fc3f7', '#dce775'];

// --- FAZA 2 (50 -> 0 HP) - Rzut piwem ---
const KOLOR_PIWO = 0xd9a441; // bursztynowy - pocisk piwa (patrz bossattack.js wystrzelPocisk)
const PIWO_LOT_CZAS = 2.0; // sekund lotu/ostrzezenia, zanim piwo uderzy w pole
const PIWO_DMG = 12.5; // obrazenia bossa, gdy gracz odrzuci piwo pisac "rzut"
const PIWO_NAGRODA = 50; // zl dla gracza za trafienie wilkolaka piwem
const PIWO_NA_ZIEMI_CZAS = 5.0; // sekund, zanim niepodniete piwo zniknie z ziemi
const PIWO_GAME_OVER_LICZBA = 4; // trafien bossa piwem w graczy w calej Fazie 2 -> game over

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

    // --- Przejscie (HP<=50, jednorazowo) - sciezki 1-2-3 (patrz _generujSciezki) ---
    this._sciezkiSprite = []; // etykiety liczbowe (Sprite) do posprzatania - patrz _pokazZnacznikiSciezek

    // --- Faza 2 - Rzut piwem: stan trwaly MIEDZY atakami (przetrwa cala Faze 2, nie tylko jeden atak) ---
    this._piwoTrafien = 0; // ile razy piwo RZUCONE PRZEZ BOSSA trafilo gracza - game over przy PIWO_GAME_OVER_LICZBA
    this._gameOverWywolany = false;
    this._piwaNaZiemi = []; // {x,z,zostalo} - niepodniete piwo lezace na ziemi (host - zrodlo prawdy, patrz sync)
    this._piwoNoszone = new Set(); // normalizeNick - kto aktualnie niesie piwo (max 1 naraz)
    this._piwoWizualizacje = new Map(); // "x,z" -> {mesh} - modele lezacego piwa na scenie (patrz _renderujPiwaNaZiemi)
    this._piwoWizT = 0;
    this._lastPiwoKeys = new Set(); // patrz _renderPiwoIkony (ten sam wzorzec co _lastBanKeys)

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
    this.pulaAtakow = ['alkohol', 'nur', 'placz'];

    // Reset stanu Fazy 2/Przejscia - istotne dla przycisku testowy "Zresp
    // wilkolaka" (boss.start(5,{force:true})), ktory moze odpalic walke od
    // nowa, gdy poprzednia dotarla do Fazy 2 (patrz spec-wilkolak.md).
    this._usunWizualizacjeSciezek();
    this._piwoTrafien = 0;
    this._gameOverWywolany = false;
    this._piwaNaZiemi = [];
    this._piwoNoszone.clear();
    this._renderujPiwaNaZiemi(0); // usuwa ewentualne modele piwa z poprzedniej walki

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

  /**
   * Sprzatanie WSZYSTKICH wizualnych skutkow biezacego ataku (znaczniki pol,
   * trasa Nura, nakladka Placzu) - uzywane zarowno przez teardown() (koniec
   * walki), jak i _wejdzWFaze2() (Przejscie przerywa atak w toku, patrz
   * spec-wilkolak.md "PRZEJSCIE").
   */
  _wyczyscEfektyAtaku() {
    this._wyczyscZnaczniki();
    for (const wpis of this._nurZnacznikiPol.values()) this.boss.fx.usunZnacznik(wpis);
    this._nurZnacznikiPol.clear();
    this._ukryjPlaczOverlay();
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
    else if (typ === 'piwo') this._rozpocznijPiwo();
    else this._ustawNastepnyAtak(); // pula podmieniona na nieznany typ - bezpieczny fallback
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

  // ================= PRZEJSCIE (HP <= 50, jednorazowo) =================

  /**
   * Wywolywane RAZ (patrz _faza2Wywolana w update()) na KAZDEJ karcie gry -
   * bezpiecznie ungated, bo caly telegraf (przerwanie ataku, wycie, sciezki)
   * jest deterministyczny (patrz _generujSciezki - ten sam _rng na kazdej
   * karcie daje TE SAME sciezki). Jedyna faktyczna decyzja tutaj - teleport
   * graczy - jest bramkowana hostem w _teleportujGraczy nizej.
   */
  _wejdzWFaze2() {
    this._wyczyscEfektyAtaku();
    this.faza = 'PRZEJSCIE';
    this.fazaT = 0;
    const zywi = this._zywiGracze();
    const sciezki = this._generujSciezki(zywi);
    this._dane = { sciezki };
    this._teleportujGraczy(sciezki);
    this._pokazZnacznikiSciezek(sciezki);
    this.playAction('emote-yes', { hard: true, once: true }) || this.playAction('idle', { hard: true });
    audio.wilkolakWycie();
    showBossNotification(
      'boss',
      '🐺 WILKOŁAK WYJE Z WŚCIEKŁOŚCI!',
      `Traci połowę sił! Wskoczcie na swoje kolorowe ścieżki 1-2-3 i przejdźcie je po kolei w ${PRZEJSCIE_CZAS}s!`,
    );
    this.boss._log('bad', 'Wilkolak wchodzi w Faze 2 (Przejscie) - HP <= 50', { hp: this.boss.hp });
  }

  /**
   * Kandydaci na sciezki - 4 kierunki (kazdy z krawedzi areny do srodka),
   * kazdy z odsuniecim (offsetem) prostopadlym od -half+1 do half-1. Kazda
   * sciezka to 4 pola: pole startowe (na krawedzi) + 3 pola w glab areny.
   * Losowa kolejnosc (tasuj, deterministyczna) + zachlanny wybor pierwszego
   * kandydata, ktorego WSZYSTKIE 4 pola sa jeszcze wolne i w arenie -
   * gwarantuje sciezki, ktore nigdy sie nie przecinaja i nigdy nie wchodza
   * na bankomat (0,0), bez zadnej analitycznej geometrii do udowodnienia.
   */
  _generujSciezki(zywi) {
    const half = arenaHalf(this.boss.economy);
    const kierunki = [
      { dx: -1, dz: 0, start: (o) => ({ x: half, z: o }) }, // od wschodu
      { dx: 1, dz: 0, start: (o) => ({ x: -half, z: o }) }, // od zachodu
      { dx: 0, dz: -1, start: (o) => ({ x: o, z: half }) }, // od polnocy
      { dx: 0, dz: 1, start: (o) => ({ x: o, z: -half }) }, // od poludnia
    ];
    const kandydaci = [];
    for (const k of kierunki) {
      for (let o = -half + 1; o <= half - 1; o++) {
        const start = k.start(o);
        const tiles = [start];
        for (let i = 1; i <= 3; i++) tiles.push({ x: start.x + k.dx * i, z: start.z + k.dz * i });
        kandydaci.push(tiles);
      }
    }
    const rng = strumien(`${this.boss.economy.state.seedGry}:wilkolak-sciezki:${this.boss.pendingTier}`);
    const potasowani = tasuj(rng, kandydaci);

    const uzyte = new Set();
    const sciezki = [];
    let kolorIdx = 0;
    for (const g of zywi) {
      const wolna = potasowani.find((tiles) =>
        tiles.every((t) => this._wSiatce(t.x, t.z) && !(t.x === 0 && t.z === 0) && !uzyte.has(`${t.x},${t.z}`)),
      );
      if (!wolna) continue; // arena zapchana sciezkami - gracz zostaje bez wlasnej (bardzo skrajny przypadek, >10 graczy)
      for (const t of wolna) uzyte.add(`${t.x},${t.z}`);
      sciezki.push({
        username: g.username,
        kolor: KOLOR_SCIEZKI[kolorIdx % KOLOR_SCIEZKI.length],
        tiles: wolna,
        idx: 0, // ile poczatkowych pol "w glab" (tiles[1..3]) juz zaliczone, po kolei
        zaliczony: false,
      });
      kolorIdx++;
    }
    return sciezki;
  }

  /** Teleport graczy na pole startowe ich sciezki - decyzja hosta (patrz _trafNura, ten sam wzorzec pozycjonowania). */
  _teleportujGraczy(sciezki) {
    if (!this._jestemHostem() || !this.boss.kickChat || !this.boss.workerManager) return;
    for (const sc of sciezki) {
      const slot = this.boss.kickChat.getWorkerForUser(sc.username);
      if (slot === null) continue;
      const entry = this.boss.workerManager.getWorkerType(slot);
      if (!entry) continue;
      const start = sc.tiles[0];
      entry.gridX = start.x; entry.gridZ = start.z;
      entry.targetGridX = start.x; entry.targetGridZ = start.z;
      entry.isMoving = false;
      if (entry.moveQueue) entry.moveQueue.length = 0;
      if (entry.obj) entry.obj.position.set(start.x, 0, start.z);
    }
  }

  /** Znaczniki kolorowych pol + etykiety liczbowe 1-2-3 na polach "w glab" kazdej sciezki. */
  _pokazZnacznikiSciezek(sciezki) {
    this._usunWizualizacjeSciezek();
    for (const sc of sciezki) {
      const kolorHex = new THREE.Color(sc.kolor).getHex();
      for (let i = 0; i < sc.tiles.length; i++) {
        const t = sc.tiles[i];
        this._znaczniki.push(this.boss.fx.oznaczPole(t.x, t.z, kolorHex, PRZEJSCIE_CZAS));
        if (i > 0) this._sciezkiSprite.push(this._stworzEtykieteSciezki(t.x, t.z, i, sc.kolor));
      }
    }
  }

  /** Maly Sprite z cyfra (1/2/3) w kolorze sciezki - canvas 2D, ten sam wzorzec co kartki bossow minigier. */
  _stworzEtykieteSciezki(x, z, numer, kolorCss) {
    const canvas = document.createElement('canvas');
    canvas.width = 64; canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = kolorCss;
    ctx.beginPath();
    ctx.arc(32, 32, 27, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#161616';
    ctx.font = 'bold 34px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(numer), 32, 35);
    const texture = new THREE.CanvasTexture(canvas);
    const material = new THREE.SpriteMaterial({ map: texture, depthWrite: false, transparent: true });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(0.36, 0.36, 1);
    sprite.position.set(x, 0.4, z);
    this.boss.scene.add(sprite);
    return sprite;
  }

  _usunWizualizacjeSciezek() {
    for (const s of this._sciezkiSprite) {
      this.boss.scene.remove(s);
      if (s.material) {
        if (s.material.map) s.material.map.dispose();
        s.material.dispose();
      }
    }
    this._sciezkiSprite = [];
  }

  /**
   * Zaliczanie pol PO KOLEI (idx rosnie tylko na tiles[idx+1]) i wyplata
   * nagrody/obrazen przy zaliczeniu calej sciezki - bramkowane hostem
   * (decyzja ekonomiczna, patrz naglowek pliku). Widz dostaje postep przez
   * zwykly sync `_dane` (dokladnie tak samo jak reszta atakow w tym pliku).
   */
  _updatePrzejscie(delta) {
    this.fazaT += delta;
    if (this._jestemHostem()) {
      const sciezki = this._dane.sciezki || [];
      for (const sc of sciezki) {
        if (sc.zaliczony) continue;
        const nastepne = sc.tiles[sc.idx + 1];
        if (!nastepne) continue;
        const naPolu = this._workersOnTile(nastepne.x, nastepne.z).some(
          (e) => normalizeNick(this._userForWorker(e) || '') === normalizeNick(sc.username),
        );
        if (!naPolu) continue;
        sc.idx += 1;
        if (sc.idx >= 3) {
          sc.zaliczony = true;
          if (this.boss.kickChat) this.boss.kickChat.recordEarned(sc.username, PRZEJSCIE_NAGRODA, undefined, false);
          if (this.boss.economy) this.boss.economy.addMoney(PRZEJSCIE_NAGRODA);
          this.boss.damage(PRZEJSCIE_DMG);
          audio.wilkolakUderzenie();
          showBossNotification(
            'hit',
            `✅ @${sc.username} PRZESZEDŁ ŚCIEŻKĘ!`,
            `+${PRZEJSCIE_NAGRODA} zł, wilkołak traci ${PRZEJSCIE_DMG} HP.`,
          );
          this.boss._log('good', `@${sc.username} zaliczyl sciezke Przejscia`, { gracz: sc.username });
        }
      }
    }
    if (this.fazaT >= PRZEJSCIE_CZAS) this._zakonczPrzejscie();
  }

  _zakonczPrzejscie() {
    this._wyczyscZnaczniki();
    this._usunWizualizacjeSciezek();
    this.pulaAtakow = ['piwo'];
    this._ustawNastepnyAtak();
  }

  // ================= FAZA 2 - RZUT PIWEM =================

  /**
   * 2 piwa jednoczesnie w 2 roznych zywych graczy (1 przy jednym graczu).
   * Deterministyczne na kazdej karcie (jak Alkohol/Nur) - tylko SKUTEK
   * uderzenia (_uderzeniePiwem) jest bramkowany hostem.
   */
  _rozpocznijPiwo() {
    const zywi = this._zywiGracze();
    if (zywi.length === 0) { this._ustawNastepnyAtak(); return; }
    const iloscCeli = zywi.length >= 2 ? 2 : 1;
    const potasowani = tasuj(this._rng('piwo-cele'), zywi);
    const cele = potasowani.slice(0, iloscCeli).map((c) => ({ x: c.x, z: c.z, username: c.username }));

    this.faza = 'PIWO';
    this.fazaT = 0;
    this._dane = { cele };
    this._wyczyscZnaczniki();
    for (const c of cele) this._znaczniki.push(this.boss.fx.oznaczPole(c.x, c.z, KOLOR_ZAMACH, PIWO_LOT_CZAS));

    const startPoz = new THREE.Vector3(this.x, 1.4 * WILK_SCALE, this.z);
    for (const cel of cele) {
      this.boss.fx.wystrzelPocisk(startPoz, cel.x, cel.z, PIWO_LOT_CZAS, () => {
        if (this._jestemHostem()) this._uderzeniePiwem(cel.x, cel.z);
      }, KOLOR_PIWO);
    }
    audio.wilkolakSwist();
    this.playAction('attack-melee-left', { once: true }) || this.playAction('idle');
    showBossNotification(
      'boss',
      '🍺 RZUT PIWEM!',
      'Wilkołak rzuca butelkami! Uciekaj z czerwonych pól - a jeśli piwo spadnie obok, podnieś je i odrzuć pisząc "rzut"!',
    );
    this.boss._log('bad', 'Wilkolak rzuca piwem (Faza 2)', { cele: cele.map((c) => c.username) });
  }

  _updatePiwo(delta) {
    this.fazaT += delta;
    if (this.fazaT >= PIWO_LOT_CZAS + 0.15) {
      this._wyczyscZnaczniki();
      this._ustawNastepnyAtak();
    }
  }

  /** Skutek uderzenia piwa RZUCONEGO PRZEZ BOSSA - wolane WYLACZNIE przez hosta (patrz _rozpocznijPiwo). */
  _uderzeniePiwem(x, z) {
    const obecni = this._workersOnTile(x, z);
    if (obecni.length > 0) {
      for (const entry of obecni) {
        const nick = this._userForWorker(entry);
        if (!nick) continue;
        this.boss._killUser(nick, { source: 'wilkolak-piwo' });
        this._piwoTrafien += 1; // licza sie trafione OSOBY, nie pola
      }
      audio.wilkolakUderzenie();
      if (this._piwoTrafien >= PIWO_GAME_OVER_LICZBA && !this._gameOverWywolany) {
        this._gameOverWywolany = true;
        this.boss._log('bad', `Wilkolak trafil piwem ${this._piwoTrafien} razy w Fazie 2 - GAME OVER`);
        if (this.boss.onGameOver) {
          try {
            const wynik = this.boss.onGameOver('GAME OVER, WRACASZ DO MYŚLIBORZA');
            if (wynik && typeof wynik.catch === 'function') {
              wynik.catch((err) => console.error('[boss-wilkolak] Blad w onGameOver:', err));
            }
          } catch (err) {
            console.error('[boss-wilkolak] Blad w onGameOver:', err);
          }
        }
      }
    } else {
      this._piwaNaZiemi.push({ x, z, zostalo: PIWO_NA_ZIEMI_CZAS });
      showBossNotification('kill', '🍺 PIWO SPADŁO NA ZIEMIĘ!', 'Podnieś je i odrzuć w wilkołaka - napisz "rzut" po podniesieniu!');
    }
  }

  /**
   * Lezace, niepodniete piwo - wygasanie po czasie i podnoszenie przez
   * gracza, ktory wejdzie na jego pole (max 1 piwo na gracza naraz).
   * Mutacje listy bramkowane hostem (patrz naglowek pliku); widz dostaje
   * wynik przez getSyncState/applySync (piwaNaZiemi/piwoNoszone).
   */
  _updatePiwaNaZiemi(delta) {
    if (this._jestemHostem()) {
      // Martwy gracz traci niesione piwo.
      for (const key of [...this._piwoNoszone]) {
        if (this.boss.kickChat && this.boss.kickChat.isEliminated(key)) this._piwoNoszone.delete(key);
      }
      for (let i = this._piwaNaZiemi.length - 1; i >= 0; i--) {
        const b = this._piwaNaZiemi[i];
        b.zostalo -= delta;
        let zebrane = false;
        for (const entry of this._workersOnTile(b.x, b.z)) {
          const nick = this._userForWorker(entry);
          if (!nick) continue;
          const key = normalizeNick(nick);
          if (this._piwoNoszone.has(key)) continue;
          this._piwoNoszone.add(key);
          zebrane = true;
          showBossNotification('hit', `🍺 @${nick} PODNIÓSŁ PIWO!`, 'Napisz "rzut", żeby odrzucić je w wilkołaka!');
          this.boss._log('good', `@${nick} podnosi piwo z ziemi (Faza 2)`, { gracz: nick });
          break;
        }
        if (zebrane || b.zostalo <= 0) this._piwaNaZiemi.splice(i, 1);
      }
    }
    this._renderujPiwaNaZiemi(delta);
  }

  /** Model butelki (bottle.glb, pirate-kit - juz zaladowany przez boss.js) unoszacy sie nad kazdym lezacym piwem. */
  _renderujPiwaNaZiemi(delta) {
    this._piwoWizT += delta;
    const aktywne = new Set(this._piwaNaZiemi.map((b) => `${b.x},${b.z}`));
    for (const [key, wiz] of [...this._piwoWizualizacje]) {
      if (aktywne.has(key)) continue;
      this.boss.scene.remove(wiz.mesh);
      this._piwoWizualizacje.delete(key);
    }
    if (!this.boss.bottleTemplate) return;
    for (const b of this._piwaNaZiemi) {
      const key = `${b.x},${b.z}`;
      let wiz = this._piwoWizualizacje.get(key);
      if (!wiz) {
        const mesh = this.boss.bottleTemplate.clone(true);
        mesh.traverse((n) => { if (n.isMesh) n.castShadow = true; });
        mesh.scale.setScalar(0.7);
        this.boss.scene.add(mesh);
        wiz = { mesh };
        this._piwoWizualizacje.set(key, wiz);
      }
      wiz.mesh.position.set(b.x, 0.32 + Math.sin(this._piwoWizT * 3) * 0.05, b.z);
      wiz.mesh.rotation.y += delta * 1.6;
    }
  }

  /** Czy dany widz aktualnie niesie piwo - patrz boss.hasPiwo (main.js/ui.js ikona 🍺). */
  maPiwo(username) {
    if (!username) return false;
    return this._piwoNoszone.has(normalizeNick(username));
  }

  /**
   * Zapisuje ikone 🍺 WPROST na wpisie rankingu - dokladnie ten sam wzorzec
   * co _renderBanIkony nizej/wyzej.
   */
  _renderPiwoIkony() {
    const kickChat = this.boss.kickChat;
    if (!kickChat) return;
    const aktualne = this._piwoNoszone;
    for (const key of this._lastPiwoKeys || []) {
      if (aktualne.has(key)) continue;
      const wpis = kickChat.leaderboard[key];
      if (wpis) wpis.wilkolakPiwo = false;
    }
    for (const key of aktualne) {
      const wpis = kickChat.leaderboard[key];
      if (wpis) wpis.wilkolakPiwo = true;
    }
    this._lastPiwoKeys = new Set(aktualne);
  }

  /**
   * Gracz z podnietym piwem odrzuca je w wilkolaka pisac "rzut" - flaga
   * "niesie piwo" znika NA KAZDEJ karcie (ungated, kosmetyka/stan lokalny
   * odtwarzany tez z sync), ale obrazenia/nagroda sa decyzja hosta.
   */
  _sprobujRzutPiwem(username) {
    const key = normalizeNick(username);
    if (!this._piwoNoszone.has(key)) return;
    this._piwoNoszone.delete(key);
    if (!this._jestemHostem()) return;
    this.boss.damage(PIWO_DMG);
    if (this.boss.kickChat) this.boss.kickChat.recordEarned(username, PIWO_NAGRODA, undefined, false);
    if (this.boss.economy) this.boss.economy.addMoney(PIWO_NAGRODA);
    audio.wilkolakUderzenie();
    if (this.boss.projectAndFloat && this.model) {
      this.boss.projectAndFloat(
        this.model.position.clone().add(new THREE.Vector3(0, 2.4 * WILK_SCALE, 0)),
        `🍺 -${PIWO_DMG} HP`,
        { crit: true },
      );
    }
    showBossNotification(
      'hit',
      `🍺 @${username} TRAFIŁ WILKOŁAKA PIWEM!`,
      `+${PIWO_NAGRODA} zł, wilkołak traci ${PIWO_DMG} HP.`,
    );
    this.boss._log('good', `@${username} trafil wilkolaka odrzuconym piwem (Faza 2)`, { gracz: username });
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
    // "rzut" - odrzucenie podnietego piwa FAZY 2 (patrz _sprobujRzutPiwem;
    // bez efektu, jesli gracz akurat nie niesie piwa).
    if (/\brzut\b/.test(norm)) {
      this._sprobujRzutPiwem(username);
    }
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
    // Lezace piwo (podnoszenie/wygasanie) dziala NIEZALEZNIE od biezacej fazy
    // ataku - moze lezec na ziemi w trakcie kolejnego Rzutu piwem albo Szalu
    // banowego (patrz spec-wilkolak.md "Faza 2"). MUSI isc PRZED
    // _renderPiwoIkony - inaczej ikona 🍺 spoznialaby sie o jedna klatke za
    // podniesieniem piwa (odswiezalaby stan sprzed tego update()).
    this._updatePiwaNaZiemi(delta);
    this._renderPiwoIkony();

    // Przejscie (HP<=50, jednorazowo) - wolane co klatke, jednorazowo (patrz
    // pole _faza2Wywolana). Nie ma bezposredniego skutku ekonomicznego, wiec
    // bezpiecznie na KAZDEJ karcie gry (host i widz), bez bramki hosta -
    // patrz komentarz przy _wejdzWFaze2.
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
    else if (this.faza === 'PRZEJSCIE') this._updatePrzejscie(delta);
    else if (this.faza === 'PIWO') this._updatePiwo(delta);

    if (this.faza === 'CZEKANIE' && this.model) {
      this.model.position.set(this.x, 0, this.z);
      this.playAction('idle');
    }
  }

  // ================= SPRZATANIE =================

  teardown() {
    this._wyczyscEfektyAtaku();
    if (this._placzOverlay) {
      this._placzOverlay.remove();
      this._placzOverlay = null;
    }
    this._usunWizualizacjeSciezek();
    this._piwaNaZiemi = [];
    this._renderujPiwaNaZiemi(0);
    this._piwoNoszone.clear();
    const kickChat = this.boss.kickChat;
    if (kickChat) {
      for (const key of this._lastBanKeys || []) {
        const wpis = kickChat.leaderboard[key];
        if (wpis) wpis.wilkolakBan = false;
      }
      for (const key of this._lastPiwoKeys || []) {
        const wpis = kickChat.leaderboard[key];
        if (wpis) wpis.wilkolakPiwo = false;
      }
    }
    this.bany.clear();
    this._lastBanKeys = new Set();
    this._lastPiwoKeys = new Set();
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
      // Faza 2 - stan lezacego/noszonego piwa, TRWALY miedzy atakami (nie
      // czesc _dane, bo nie jest przypisany do jednej fazy - patrz
      // spec-wilkolak.md "Rzut piwem").
      piwaNaZiemi: this._piwaNaZiemi.map((b) => ({ x: b.x, z: b.z, zostalo: b.zostalo })),
      piwoNoszone: Array.from(this._piwoNoszone),
      piwoTrafien: this._piwoTrafien,
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
    if (Array.isArray(state.piwaNaZiemi)) {
      this._piwaNaZiemi = state.piwaNaZiemi.map((b) => ({ x: b.x, z: b.z, zostalo: b.zostalo }));
    }
    if (Array.isArray(state.piwoNoszone)) this._piwoNoszone = new Set(state.piwoNoszone);
    if (typeof state.piwoTrafien === 'number') this._piwoTrafien = state.piwoTrafien;
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
    this._usunWizualizacjeSciezek();

    if (this.faza === 'PRZEJSCIE' && this._dane.sciezki) {
      this._pokazZnacznikiSciezek(this._dane.sciezki);
    } else if (this.faza === 'PIWO' && this._dane.cele) {
      for (const c of this._dane.cele) {
        this._znaczniki.push(this.boss.fx.oznaczPole(c.x, c.z, KOLOR_ZAMACH, Math.max(0.1, PIWO_LOT_CZAS - this.fazaT)));
      }
    } else if (this.faza === 'ALKOHOL_ZAMACH' && this._dane.front) {
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
