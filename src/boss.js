import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { loadArcade } from './assets.js';
import { fmtShort } from './format.js';
import { normalizePolish, showTopAnnouncement } from './vanessa.js';

// Architektura gotowa na kolejnych bossow (jeden na kazdy tier bankomatu) -
// tablica indeksowana numerem tieru, wypelniony na razie tylko indeks 1.
// Brak definicji (null) = brak bossa, awans przebiega po staremu (main.js).
export const BOSS_DEFS = [
  null, // tier 0 - poczatkowy tier, bez awansu, bez bossa
  {
    tier: 1,
    name: 'Kamil Kovalenko',
    subtitle: 'SZEF WSZYSTKICH BANKOMATÓW',
    hp: 100,
  },
  null, // tier 2 - TODO kolejny boss
  null, // tier 3 - TODO kolejny boss
  null, // tier 4 - TODO kolejny boss
  null, // tier 5 - TODO kolejny boss
];

const HP_PER_HIT = 5;
const ANSWER_WINDOW = 8.0; // sekund na odpowiedz
const HIT_TO_NEXT_EQ_DELAY = 1.2; // sekund pauzy po trafieniu, zanim wyskoczy nowe dzialanie
const FAINT_MIN = 12;
const FAINT_MAX = 22;
const CUTSCENE_DURATION = 5.0;

const SPAWN_POS = new THREE.Vector3(0, 0, -3.0); // korytarz z tylu sceny
const IMPACT_POS = new THREE.Vector3(0.3, 0, 0.2); // punkt uderzenia w bankomat (tuz przed nim)
// Miejsce postoju jest CELOWO przesuniete W BOK od bankomatu (nadal w srodku
// okregu pracownikow r=1.75 wokol (0,0,0), dystans od centrum ~1.5) - przy
// skali x3 postoj wprost przed bankomatem (stare FINAL_POS (0,0,1.15)) zaslanial
// cala scene, a postoj daleko z tylu (proba (0,0,-1.3)) wypadal zbyt malo i
// zbyt wysoko w kadrze, w calosci pod wlasnym plakietka+dymkiem. Pozycja z boku,
// nieco blizej kamery, zostawia widoczny bankomat ORAZ cale cialo bossa ponizej
// plakietki (zmierzone empirycznie - patrz raport).
const FINAL_POS = new THREE.Vector3(1.1, 0, 1.0); // miejsce postoju, z boku bankomatu, w srodku kregu graczy
const APPROACH_CTRL = new THREE.Vector3(1.8, 0, -1.6); // punkt kontrolny "driftu" podjazdu
const SETTLE_CTRL = new THREE.Vector3(1.9, 0, -0.2); // punkt kontrolny okrazania po uderzeniu, do pozycji z boku

// Lokalny offset postaci wzgledem wozka (przed skalowaniem grupy x3) - wyliczony
// empirycznie z world-space Box3 obu czesci w pozie "wheelchair-sit": bez niego
// postac zjezdza ok. 0.34 j. (w swiecie) PONIZEJ podlogi i siedzi zauwazalnie
// przed siedziskiem. Patrz komentarz przy _buildModel().
const CHAR_LOCAL_OFFSET = new THREE.Vector3(0, 0.113, -0.11);

const CAM_KINO_POS = new THREE.Vector3(0.4, 1.15, 2.5);
const CAM_KINO_TARGET = new THREE.Vector3(0, 0.55, 0.2);

const LOG_LIMIT = 300;

function randInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Losuje dzialanie matematyczne z calkowitym, nieujemnym wynikiem. */
function genEquation() {
  const op = pick(['+', '-', '×', '÷']);
  let a, b, result, text;
  if (op === '+') {
    a = randInt(11, 89);
    b = randInt(11, 89);
    result = a + b;
    text = `${a} + ${b} = ?`;
  } else if (op === '-') {
    a = randInt(11, 89);
    b = randInt(1, a);
    result = a - b;
    text = `${a} - ${b} = ?`;
  } else if (op === '×') {
    a = randInt(2, 12);
    b = randInt(2, 12);
    result = a * b;
    text = `${a} × ${b} = ?`;
  } else {
    b = randInt(2, 12);
    result = randInt(2, 12);
    a = b * result;
    text = `${a} ÷ ${b} = ?`;
  }
  return { text, result };
}

/** Punkt na kwadratowej krzywej Beziera A-B-C dla t w [0,1]. */
function quadBezier(out, A, B, C, t) {
  const it = 1 - t;
  out.x = it * it * A.x + 2 * it * t * B.x + t * t * C.x;
  out.y = it * it * A.y + 2 * it * t * B.y + t * t * C.y;
  out.z = it * it * A.z + 2 * it * t * B.z + t * t * C.z;
  return out;
}

function smoothstep(t) {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

const BOSS_TAUNTS_HIT = [
  'Auć! Ktoś tu umie liczyć! 😤',
  'Nie licz tak dobrze! 🤬',
  'Grr... to boli! 💢',
  'Czat zna tabliczkę mnożenia?! 😱',
];

const BOSS_TAUNTS_KILL = [
  'Kto następny nie policzy?! 😈',
  'Matematyka to potęga! Hahaha! 🤣',
  'Nikt mnie nie ogarnie! 👹',
];

export class BossManager {
  constructor(scene, camera, controls, machine, economy, coinPool, projectAndFloat) {
    this.scene = scene;
    this.camera = camera;
    this.controls = controls;
    this.machine = machine;
    this.economy = economy;
    this.coinPool = coinPool;
    this.projectAndFloat = projectAndFloat;

    this.workerManager = null;
    this.workerOverlays = null;
    this.kickChat = null;
    this.vanessaRef = null;
    this.onDefeated = null;

    this.chairTemplate = null;
    this.charTemplate = null;
    this.animations = [];

    this.model = null; // THREE.Group (wozek + postac)
    this.charObj = null; // dziecko-postac, na nim dziala mixer/animacje
    this.mixer = null;
    this.currentAction = null;

    // 'IDLE' | 'CUTSCENE' | 'FIGHT' | 'VICTORY'
    this.state = 'IDLE';
    this.pendingTier = null;
    this.def = null;

    this.hp = 100;
    this.maxHp = 100;

    this.cutsceneT = 0;
    this._impactDone = false;
    this._camSavedPos = new THREE.Vector3();
    this._camSavedTarget = new THREE.Vector3();
    this._camLockActive = false;

    this.currentEq = null; // { text, result }
    this.eqTimer = 0;
    this.interDelay = 0;
    this.faintTimer = this._randomFaintDelay();

    this.faintedMap = new Map(); // username(lower) -> { username, slot, ts }

    this._headWorld = new THREE.Vector3();
    this._projected = new THREE.Vector3();
    this._bezierTmp = new THREE.Vector3();
    this._bezierTmp2 = new THREE.Vector3();

    this.logEntries = [];
    this.onLog = null;
    this.logToConsole = true;
    this._runId = 0;

    this.container = document.getElementById('worker-overlays') || document.body;
    this._createDOMOverlays();
  }

  // --- Log zdarzen, wzorowane na VanessaManager ---
  _log(kind, message, data = null) {
    const entry = { t: Date.now(), run: this._runId, kind, message, data, state: this.state };
    this.logEntries.push(entry);
    if (this.logEntries.length > LOG_LIMIT) {
      this.logEntries.splice(0, this.logEntries.length - LOG_LIMIT);
    }
    if (this.logToConsole) {
      const stamp = new Date(entry.t).toLocaleTimeString('pl-PL');
      if (data) console.log(`[Boss Kamil #${entry.run} ${stamp}] ${message}`, data);
      else console.log(`[Boss Kamil #${entry.run} ${stamp}] ${message}`);
    }
    if (this.onLog) {
      try {
        this.onLog(entry);
      } catch (err) {
        console.error('[Boss] Blad w obsludze logu:', err);
      }
    }
  }

  getLog(limit = 50) {
    return this.logEntries.slice(-limit);
  }

  printLog(limit = 50) {
    console.table(this.getLog(limit).map((e) => ({
      czas: new Date(e.t).toLocaleTimeString('pl-PL'),
      walka: e.run,
      typ: e.kind,
      zdarzenie: e.message,
    })));
  }

  clearLog() {
    this.logEntries = [];
    if (this.onLog) this.onLog(null);
  }

  _randomFaintDelay() {
    return FAINT_MIN + Math.random() * (FAINT_MAX - FAINT_MIN);
  }

  setContext({ workerManager, workerOverlays, kickChat, vanessa, onDefeated }) {
    this.workerManager = workerManager || this.workerManager;
    this.workerOverlays = workerOverlays || this.workerOverlays;
    this.kickChat = kickChat || this.kickChat;
    this.vanessaRef = vanessa || this.vanessaRef;
    this.onDefeated = onDefeated || this.onDefeated;
  }

  async init() {
    const [chairGltf, charGltf] = await Promise.all([
      loadArcade('wheelchair-deluxe'),
      loadArcade('character-male-f'),
    ]);
    this.chairTemplate = chairGltf.scene;
    this.charTemplate = charGltf.scene;
    this.animations = charGltf.animations || [];
  }

  isActive() {
    return this.state !== 'IDLE';
  }

  /** Czy dany widz jest aktualnie omdlony - jego "klik" ma byc ignorowany (patrz main.js onKlik). */
  isFainted(username) {
    if (!username) return false;
    return this.faintedMap.has(username.toLowerCase());
  }

  // --- DOM overlaye: plakietka z HP, dymek z dzialaniem, letterbox, karta tytulowa ---
  _createDOMOverlays() {
    const np = document.createElement('div');
    np.className = 'boss-nameplate';
    np.style.display = 'none';

    const nameRow = document.createElement('div');
    nameRow.className = 'boss-name-row';
    nameRow.textContent = '👹 Kamil Kovalenko';
    np.appendChild(nameRow);

    const hpWrap = document.createElement('div');
    hpWrap.className = 'boss-hp-bar';
    const hpFill = document.createElement('div');
    hpFill.className = 'boss-hp-fill';
    hpWrap.appendChild(hpFill);
    np.appendChild(hpWrap);

    const hpText = document.createElement('div');
    hpText.className = 'boss-hp-text';
    hpText.textContent = '100 / 100';
    np.appendChild(hpText);

    this.container.appendChild(np);
    this.nameplateEl = np;
    this.hpFillEl = hpFill;
    this.hpTextEl = hpText;

    const bubble = document.createElement('div');
    bubble.className = 'boss-bubble';
    bubble.style.display = 'none';

    const eqText = document.createElement('div');
    eqText.className = 'boss-equation';
    eqText.textContent = '';
    bubble.appendChild(eqText);

    const timerWrap = document.createElement('div');
    timerWrap.className = 'boss-timer-bar';
    const timerFill = document.createElement('div');
    timerFill.className = 'boss-timer-fill';
    timerWrap.appendChild(timerFill);
    bubble.appendChild(timerWrap);

    this.container.appendChild(bubble);
    this.bubbleEl = bubble;
    this.eqTextEl = eqText;
    this.timerFillEl = timerFill;

    // Letterbox - dwa czarne pasy wjezdzajace z gory i dolu
    const lbTop = document.createElement('div');
    lbTop.className = 'boss-letterbox boss-letterbox-top';
    const lbBottom = document.createElement('div');
    lbBottom.className = 'boss-letterbox boss-letterbox-bottom';
    document.body.appendChild(lbTop);
    document.body.appendChild(lbBottom);
    this.letterboxTop = lbTop;
    this.letterboxBottom = lbBottom;

    // Karta tytulowa
    const title = document.createElement('div');
    title.className = 'boss-title-card';
    const titleName = document.createElement('div');
    titleName.className = 'boss-title-name';
    const titleSub = document.createElement('div');
    titleSub.className = 'boss-title-sub';
    title.appendChild(titleName);
    title.appendChild(titleSub);
    document.body.appendChild(title);
    this.titleCardEl = title;
    this.titleNameEl = titleName;
    this.titleSubEl = titleSub;
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
    if (this.currentAction && !opts.hard) {
      this.currentAction.crossFadeTo(next, 0.2, false);
    }
    next.reset().play();
    this.currentAction = next;
    return next;
  }

  // ================= START WALKI =================

  /**
   * Odpala bossa dla danego tieru. `opts.force` pomija sprawdzenie
   * bossesDefeated i aktualnego stanu - uzywane przez przycisk testowy.
   */
  start(tier, opts = {}) {
    const def = BOSS_DEFS[tier];
    if (!def) {
      this._log('info', `Brak definicji bossa dla tieru ${tier} - pomijam`);
      return false;
    }
    if (!opts.force) {
      if (this.state !== 'IDLE') return false;
      if (this.economy.state.bossesDefeated && this.economy.state.bossesDefeated.includes(tier)) {
        this._log('info', `Boss dla tieru ${tier} juz pokonany - nie odpalam ponownie`);
        return false;
      }
    } else if (this.state !== 'IDLE') {
      // Wymuszenie (przycisk testowy) - sprzatamy po ewentualnej poprzedniej walce
      this._teardown();
    }

    if (!this.chairTemplate || !this.charTemplate) {
      this._log('bad', 'Nie moge wystartowac - model bossa jeszcze sie nie zaladowal');
      return false;
    }

    if (this.vanessaRef && this.vanessaRef.model) {
      this.vanessaRef.despawn();
    }

    this._runId += 1;
    this.pendingTier = tier;
    this.def = def;
    this.hp = def.hp || 100;
    this.maxHp = this.hp;
    this.faintedMap.clear();
    this.faintTimer = this._randomFaintDelay();

    this._log('spawn', `Startuje walka z bossem "${def.name}" (awans na tier ${tier})`, { tier, hp: this.hp });

    this._buildModel();
    this._beginCutscene();
    return true;
  }

  _buildModel() {
    const group = new THREE.Group();
    const chair = this.chairTemplate.clone(true);
    const char = SkeletonUtils.clone(this.charTemplate);
    // Kenney eksportuje obie czesci do wspolnego originu, ale w pozie
    // "wheelchair-sit" to NIE wystarcza (zmierzone empirycznie world-space Box3:
    // postac zjezdza pod podloge i siedzi przed siedziskiem) - CHAR_LOCAL_OFFSET
    // podnosi ja i cofa tak, zeby faktycznie siedziala W wozku.
    chair.position.set(0, 0, 0);
    char.position.copy(CHAR_LOCAL_OFFSET);
    group.add(chair);
    group.add(char);
    group.scale.setScalar(3);

    group.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
        if (child.material) {
          const mat = child.material.clone();
          mat.emissive = new THREE.Color(0x2a0016);
          child.material = mat;
        }
      }
    });

    group.position.copy(SPAWN_POS);
    this.scene.add(group);

    this.model = group;
    this.charObj = char;
    this.mixer = new THREE.AnimationMixer(char);
    this.currentAction = null;

    // Po zakonczeniu jednorazowej animacji (np. "emote-no" po trafieniu) w trakcie
    // walki, boss wraca do siedzenia - inaczej zostalby zamrozony na ostatniej klatce.
    this.mixer.addEventListener('finished', () => {
      if (this.state === 'FIGHT') {
        this.playAction('wheelchair-sit');
      }
    });

    this.playAction('wheelchair-move-forward', { hard: true });
  }

  _beginCutscene() {
    this.state = 'CUTSCENE';
    this.cutsceneT = 0;
    this._impactDone = false;

    this._camSavedPos.copy(this.camera.position);
    this._camSavedTarget.copy(this.controls.target);
    this._camLockActive = true;
    this.controls.enabled = false;

    this.titleNameEl.textContent = `👹 ${this.def.name.toUpperCase()}`;
    this.titleSubEl.textContent = this.def.subtitle || '';

    // reflow, zeby animacje CSS zawsze wystartowaly od nowa
    void this.letterboxTop.offsetWidth;
    this.letterboxTop.classList.add('show');
    this.letterboxBottom.classList.add('show');
    this.titleCardEl.classList.remove('show');
    void this.titleCardEl.offsetWidth;
    this.titleCardEl.classList.add('show');

    this.nameplateEl.style.display = 'flex';
    this.hpFillEl.style.width = '100%';
    this.hpTextEl.textContent = `${this.hp} / ${this.maxHp}`;
  }

  /** Czy boss aktualnie ma pelna kontrole nad kamera (main.js pomija wtedy controls.update()). */
  isCameraLocked() {
    return this._camLockActive;
  }

  // ================= UPDATE GLOWNY =================

  update(delta, camera, canvasRect) {
    if (this.state === 'IDLE') return;

    if (this.mixer) this.mixer.update(delta);

    if (this.state === 'CUTSCENE') {
      this._updateCutscene(delta);
    } else if (this.state === 'FIGHT') {
      this._updateFight(delta);
    } else if (this.state === 'VICTORY') {
      this._updateVictory(delta);
    }

    this._updateOverlayPositions(camera, canvasRect);
  }

  _updateCutscene(delta) {
    this.cutsceneT += delta;
    const u = Math.min(1, this.cutsceneT / CUTSCENE_DURATION);

    // Kamera: lerp w kino pozycje w pierwszych 20%, trzymanie, lerp z powrotem w ostatnich 16%
    if (u < 0.2) {
      const k = smoothstep(u / 0.2);
      this.camera.position.lerpVectors(this._camSavedPos, CAM_KINO_POS, k);
      this.controls.target.lerpVectors(this._camSavedTarget, CAM_KINO_TARGET, k);
      this.camera.lookAt(this.controls.target);
    } else if (u >= 0.84) {
      const k = smoothstep((u - 0.84) / 0.16);
      this.camera.position.lerpVectors(CAM_KINO_POS, this._camSavedPos, k);
      this.controls.target.lerpVectors(CAM_KINO_TARGET, this._camSavedTarget, k);
      this.camera.lookAt(this.controls.target);
    } else {
      this.camera.position.copy(CAM_KINO_POS);
      this.controls.target.copy(CAM_KINO_TARGET);
      this.camera.lookAt(this.controls.target);
    }

    // Ruch bossa: dwie krzywe Beziera - podjazd+uderzenie, potem okrazenie do pozycji koncowej
    const driveU = Math.min(1, u / 0.86); // ruch konczy sie przy 86% czasu, reszta to postoj
    let pos;
    if (driveU < 0.55) {
      const t = driveU / 0.55;
      pos = quadBezier(this._bezierTmp, SPAWN_POS, APPROACH_CTRL, IMPACT_POS, t);
    } else {
      const t = (driveU - 0.55) / 0.45;
      pos = quadBezier(this._bezierTmp, IMPACT_POS, SETTLE_CTRL, FINAL_POS, Math.min(1, t));
    }
    if (this.model) {
      this.model.position.copy(pos);
      // Kierunek patrzenia - w strone kolejnego punktu na krzywej (styczna)
      if (driveU < 0.98) {
        const aheadU = Math.min(1, driveU + 0.03);
        let ahead;
        if (aheadU < 0.55) ahead = quadBezier(this._bezierTmp2, SPAWN_POS, APPROACH_CTRL, IMPACT_POS, aheadU / 0.55);
        else ahead = quadBezier(this._bezierTmp2, IMPACT_POS, SETTLE_CTRL, FINAL_POS, Math.min(1, (aheadU - 0.55) / 0.45));
        this.model.lookAt(ahead.x, this.model.position.y, ahead.z);
      } else {
        // Ostatni odcinek - obraca sie twarza do kamery (graczy). Patrzy wzdluz
        // czystej osi +Z (nie w strone (0,y,10)), zeby boczny offset FINAL_POS.x
        // nie przekrzywial kierunku patrzenia.
        this.model.lookAt(this.model.position.x, this.model.position.y, this.model.position.z + 10);
      }
    }

    // Uderzenie w bankomat - wyzwalane raz, mniej wiecej w momencie przejscia przez IMPACT_POS
    if (!this._impactDone && driveU >= 0.53) {
      this._impactDone = true;
      this._triggerImpact();
    }

    if (u >= 1) {
      this._endCutscene();
    }
  }

  _triggerImpact() {
    this._log('bad', 'Boss uderza w bankomat! Bankomat zostaje rozwalony na czas walki');
    if (this.machine.model) {
      this.machine.model.rotation.z = 0.35;
      this.machine.model.position.x = -0.08;
      this.machine.model.position.y = -0.04;
    }
    this.coinPool.burst(new THREE.Vector3(0, 0.6, 0.3), 40);

    // Wstrzas kamery - krotki losowy offset przez kilka klatek (obslugiwany prostym timerem)
    this._camShakeT = 0.35;
  }

  _endCutscene() {
    this.letterboxTop.classList.remove('show');
    this.letterboxBottom.classList.remove('show');
    this.titleCardEl.classList.remove('show');

    this.camera.position.copy(this._camSavedPos);
    this.controls.target.copy(this._camSavedTarget);
    this.camera.lookAt(this.controls.target);
    this.controls.enabled = true;
    this._camLockActive = false;

    if (this.model) {
      this.model.position.copy(FINAL_POS);
      this.model.lookAt(this.model.position.x, this.model.position.y, this.model.position.z + 10);
    }
    this.playAction('wheelchair-sit', { hard: true, once: false });

    this.state = 'FIGHT';
    this._log('info', 'Cutscenka zakonczona - start walki', { hp: this.hp });
    this._nextEquation();
  }

  // ================= WALKA =================

  _updateFight(delta) {
    // Wstrzas kamery po uderzeniu (dogasa w pierwszych ulamkach sekundy walki)
    if (this._camShakeT > 0) {
      this._camShakeT -= delta;
      const s = Math.max(0, this._camShakeT) * 0.04;
      this.camera.position.x += (Math.random() - 0.5) * s;
      this.camera.position.y += (Math.random() - 0.5) * s;
    }

    if (this.interDelay > 0) {
      this.interDelay -= delta;
      if (this.interDelay <= 0) this._nextEquation();
    } else if (this.currentEq) {
      this.eqTimer -= delta;
      const frac = Math.max(0, this.eqTimer / ANSWER_WINDOW);
      if (this.timerFillEl) {
        this.timerFillEl.style.width = `${frac * 100}%`;
        this.timerFillEl.classList.toggle('danger', frac < 0.25);
      }
      if (this.eqTimer <= 0) {
        this._onTimeout();
      }
    }

    // Losowe omdlenia
    this.faintTimer -= delta;
    if (this.faintTimer <= 0) {
      this.faintTimer = this._randomFaintDelay();
      this._faintRandomInternal();
    }
  }

  _nextEquation() {
    this.currentEq = genEquation();
    this.eqTimer = ANSWER_WINDOW;
    this.interDelay = 0;
    if (this.eqTextEl) this.eqTextEl.textContent = this.currentEq.text;
    if (this.bubbleEl) this.bubbleEl.style.display = 'flex';
    if (this.timerFillEl) {
      this.timerFillEl.style.width = '100%';
      this.timerFillEl.classList.remove('danger');
    }
    this._log('info', `Nowe dzialanie: ${this.currentEq.text} (wynik ${this.currentEq.result})`);
  }

  /** Wywolywane z main.js z kazdej wiadomosci na czacie (odpowiedzi + "pomoc"). */
  onChatMessage(username, content, color) {
    if (this.state !== 'FIGHT' || !username || !content) return;

    // Ratunek dla omdlonego
    const norm = normalizePolish(content);
    const tokensNorm = norm.split(/\s+/).filter(Boolean);
    if (tokensNorm.includes('pomoc')) {
      this._tryHelp(username, color);
      return;
    }

    if (!this.currentEq || this.interDelay > 0) return;

    const key = username.toLowerCase();
    if (this.faintedMap.has(key)) return; // omdlali nie moga odpowiadac

    const tokens = content.split(/\s+/).map((t) => t.replace(/[^\d-]/g, '')).filter((t) => t.length > 0);
    const hit = tokens.some((t) => Number(t) === this.currentEq.result);
    if (hit) {
      this._onCorrectAnswer(username, color);
    }
  }

  _onCorrectAnswer(username, color) {
    const dmg = HP_PER_HIT;
    this.hp = Math.max(0, this.hp - dmg);
    this._log('good', `@${username} trafil poprawna odpowiedz (${this.currentEq.result}) - boss traci ${dmg} HP`, {
      hpPo: this.hp,
    });

    if (this.model) {
      this.projectAndFloat(this._bossFloaterOrigin(), `✔ @${username}`, { crit: true, kick: true });
    }
    this.playAction('emote-no', { once: true });
    this._shakeBossOnce();

    if (this.hpFillEl) this.hpFillEl.style.width = `${(this.hp / this.maxHp) * 100}%`;
    if (this.hpTextEl) this.hpTextEl.textContent = `${this.hp} / ${this.maxHp}`;
    if (this.eqTextEl) this.eqTextEl.textContent = pick(BOSS_TAUNTS_HIT);

    this.currentEq = null;
    if (this.bubbleEl) this.bubbleEl.style.display = 'none';

    if (this.hp <= 0) {
      this._onDefeatedBoss();
      return;
    }

    this.interDelay = HIT_TO_NEXT_EQ_DELAY;
  }

  _shakeBossOnce() {
    if (!this.model) return;
    const base = this.model.rotation.y;
    this.model.rotation.y = base + 0.08;
    setTimeout(() => {
      if (this.model) this.model.rotation.y = base;
    }, 150);
  }

  _bossFloaterOrigin() {
    return this.model ? this.model.position.clone().add(new THREE.Vector3(0, 2.2, 0)) : new THREE.Vector3(0, 2, 1.15);
  }

  _onTimeout() {
    this._log('bad', `Nikt nie odpowiedzial na czas ("${this.currentEq.text}") - boss wybiera ofiare`, {
      dzialanie: this.currentEq.text,
    });
    this.currentEq = null;
    if (this.bubbleEl) this.bubbleEl.style.display = 'none';
    this._killRandomParticipant();
    this._nextEquation();
  }

  _pickVictimFromTop10({ requirePositive } = {}) {
    if (!this.kickChat) return null;
    const top10 = this.kickChat.getTopEarners(10);
    const eligible = top10.filter((u) => {
      const key = u.username.toLowerCase();
      if (this.faintedMap.has(key)) return false;
      if (requirePositive && !((u.totalEarned || 0) > 0)) return false;
      return true;
    });
    if (eligible.length === 0) return null;
    return eligible[Math.floor(Math.random() * eligible.length)];
  }

  _killRandomParticipant() {
    let victim = this._pickVictimFromTop10({ requirePositive: true });
    if (!victim) victim = this._pickVictimFromTop10({ requirePositive: false });

    if (!victim) {
      this._log('bad', 'Brak kogo "zabic" - ranking pusty. Tylko szyderczy dymek.');
      if (this.eqTextEl) this.eqTextEl.textContent = pick(BOSS_TAUNTS_KILL);
      return;
    }

    const username = victim.username;
    const workerIndex = this.kickChat.getWorkerForUser(username);
    const lostAmount = Math.round(victim.totalEarned || 0);

    if (this.kickChat) this.kickChat.eliminateUser(username);

    if (workerIndex !== null && this.workerManager) {
      const entry = this.workerManager.getWorkerType(workerIndex);
      if (entry && entry.obj) {
        const origin = entry.obj.position.clone().add(new THREE.Vector3(0, 1.6, 0));
        this.projectAndFloat(origin, `💀 @${username}`, { crit: true, steal: true });
        this.workerManager.playDeath(workerIndex);
        setTimeout(() => {
          if (this.workerManager) this.workerManager.removeWorkerType(workerIndex);
        }, 2500);
      }
    }

    showTopAnnouncement(
      `💀 KAMIL KOVALENKO ZABIŁ @${username}!`,
      `Stracił cały dorobek (<strong>${fmtShort(lostAmount)} zł</strong>) i wypadł z rankingu!`,
      3200,
    );

    this._log('bad', `Boss "zabil" @${username} - stracil ${lostAmount} zl i wypadl z rankingu`, {
      ofiara: username,
      utraconeZl: lostAmount,
    });
  }

  // ================= OMDLENIA =================

  _faintRandomInternal() {
    const victim = this._pickVictimFromTop10({ requirePositive: false });
    if (!victim) {
      this._log('info', 'Proba omdlenia - ranking pusty, pomijam');
      return;
    }
    const username = victim.username;
    const key = username.toLowerCase();
    const workerIndex = this.kickChat ? this.kickChat.getWorkerForUser(username) : null;

    this.faintedMap.set(key, { username, slot: workerIndex, ts: Date.now() });

    if (workerIndex !== null && this.workerManager) {
      this.workerManager.playDeath(workerIndex);
    }

    showTopAnnouncement(
      `💤 @${username} OMDLAŁ!`,
      `Boss go powalił. Napisz <strong>pomoc</strong> na czacie, żeby go podnieść!`,
      3000,
    );
    this._log('info', `@${username} omdlal - napisz "pomoc" na czacie, zeby go podniesc`, { ofiara: username });

    this._refreshFaintedNameplate(workerIndex, true);
  }

  /** Publiczna metoda testowa - wywoluje omdlenie natychmiast (patrz README/debug). */
  faintRandom() {
    if (this.state !== 'FIGHT') return false;
    this._faintRandomInternal();
    return true;
  }

  _refreshFaintedNameplate(workerIndex, fainted) {
    if (workerIndex === null || workerIndex === undefined) return;
    if (this.workerOverlays) this.workerOverlays.setFainted(workerIndex, fainted);
  }

  _tryHelp(rescuerUsername, color) {
    if (this.faintedMap.size === 0) return;
    // Nie mozna podniesc samego siebie
    let oldestKey = null;
    let oldestTs = Infinity;
    for (const [key, info] of this.faintedMap) {
      if (key === rescuerUsername.toLowerCase()) continue;
      if (info.ts < oldestTs) {
        oldestTs = info.ts;
        oldestKey = key;
      }
    }
    if (!oldestKey) return;

    const info = this.faintedMap.get(oldestKey);
    this.faintedMap.delete(oldestKey);

    if (info.slot !== null && info.slot !== undefined && this.workerManager) {
      const entry = this.workerManager.getWorkerType(info.slot);
      if (entry) {
        if (entry.idleAction) {
          entry.idleAction.reset().play();
        }
        if (entry.dieAction) entry.dieAction.stop();
      }
      this._refreshFaintedNameplate(info.slot, false);

      if (entry && entry.obj) {
        const origin = entry.obj.position.clone().add(new THREE.Vector3(0, 1.6, 0));
        this.projectAndFloat(origin, `🤝 @${rescuerUsername} podniósł @${info.username}!`, { gold: true });
      }
    }

    showTopAnnouncement(
      `🤝 RATUNEK!`,
      `<strong>@${rescuerUsername}</strong> podniósł <strong>@${info.username}</strong>!`,
      2400,
    );
    this._log('good', `@${rescuerUsername} podnosi omdlalego @${info.username}`, {
      ratownik: rescuerUsername,
      ofiara: info.username,
    });
  }

  _wakeAllFainted() {
    for (const [key, info] of this.faintedMap) {
      if (info.slot !== null && info.slot !== undefined && this.workerManager) {
        const entry = this.workerManager.getWorkerType(info.slot);
        if (entry) {
          if (entry.idleAction) entry.idleAction.reset().play();
          if (entry.dieAction) entry.dieAction.stop();
        }
        this._refreshFaintedNameplate(info.slot, false);
      }
    }
    this.faintedMap.clear();
  }

  // ================= ZWYCIESTWO =================

  /** Publiczny hak testowy - zadaje obrazenia bossowi z pominieciem czatu. */
  damage(amount = HP_PER_HIT) {
    if (this.state !== 'FIGHT') return false;
    this.hp = Math.max(0, this.hp - amount);
    if (this.hpFillEl) this.hpFillEl.style.width = `${(this.hp / this.maxHp) * 100}%`;
    if (this.hpTextEl) this.hpTextEl.textContent = `${this.hp} / ${this.maxHp}`;
    this._log('good', `[debug] Zadano ${amount} obrazen bossowi`, { hpPo: this.hp });
    if (this.hp <= 0) this._onDefeatedBoss();
    return true;
  }

  _onDefeatedBoss() {
    this._log('spawn', `Boss "${this.def.name}" pokonany!`);
    this.state = 'VICTORY';
    this.currentEq = null;
    this.interDelay = 0;
    if (this.bubbleEl) this.bubbleEl.style.display = 'none';

    this.playAction('die', { once: true, hard: true });
    this._victoryT = 0;

    this._wakeAllFainted();
  }

  _updateVictory(delta) {
    this._victoryT = (this._victoryT || 0) + delta;
    if (this.model) {
      this.model.rotation.z = Math.min(0.6, this._victoryT * 0.4);
      this.model.position.y = -Math.min(0.3, this._victoryT * 0.15);
    }
    if (this._victoryT >= 3.0) {
      this._finishVictory();
    }
  }

  async _finishVictory() {
    const tier = this.pendingTier;
    this._teardown();

    // Bankomat wraca do pionu
    if (this.machine.model) {
      this.machine.model.rotation.z = 0;
      this.machine.model.position.x = 0;
      this.machine.model.position.y = 0;
    }

    if (this.onDefeated) {
      try {
        await this.onDefeated(tier);
      } catch (err) {
        console.error('[Boss] Blad w onDefeated:', err);
      }
    }

    this.coinPool.burst(new THREE.Vector3(0, 0.6, 0.3), 300);
    this._log('good', `Awans na tier ${tier} wykonany po pokonaniu bossa`);
  }

  _teardown() {
    if (this.model) {
      this.scene.remove(this.model);
      this.model = null;
    }
    this.mixer = null;
    this.currentAction = null;
    this.charObj = null;

    this.state = 'IDLE';
    this.currentEq = null;
    this.interDelay = 0;
    this.hp = 0;

    if (this.nameplateEl) this.nameplateEl.style.display = 'none';
    if (this.bubbleEl) this.bubbleEl.style.display = 'none';
    this.letterboxTop.classList.remove('show');
    this.letterboxBottom.classList.remove('show');
    this.titleCardEl.classList.remove('show');

    if (this._camLockActive) {
      this.camera.position.copy(this._camSavedPos);
      this.controls.target.copy(this._camSavedTarget);
      this.camera.lookAt(this.controls.target);
      this.controls.enabled = true;
      this._camLockActive = false;
    }

    this._wakeAllFainted();
    if (this.kickChat) this.kickChat.clearEliminated();
  }

  // ================= RZUTOWANIE OVERLAYOW 3D -> 2D =================

  _updateOverlayPositions(camera, canvasRect) {
    if (!this.model || !camera || !canvasRect) return;
    if (this.state !== 'FIGHT' && this.state !== 'VICTORY') {
      // W cutscence plakietka jest widoczna, ale bez dymka z dzialaniem
      if (this.bubbleEl) this.bubbleEl.style.display = 'none';
    }

    this.model.getWorldPosition(this._headWorld);
    // Zmniejszony offset (bylo 2.3) - przy skali x3 dawny offset wypychal
    // punkt rzutowania nad krawedz kadru i plakietka/dymek renderowaly sie
    // poza oknem (ujemny Y). 1.9 trzyma punkt tuz nad glowa bossa.
    this._headWorld.y += 1.9;

    this._projected.copy(this._headWorld).project(camera);

    if (this._projected.z >= 1.0) {
      this.nameplateEl.style.display = 'none';
      this.bubbleEl.style.display = 'none';
      return;
    }

    let sx = canvasRect.left + (this._projected.x * 0.5 + 0.5) * canvasRect.width;
    let sy = canvasRect.top + (-this._projected.y * 0.5 + 0.5) * canvasRect.height;

    // Klamrowanie do wnetrza canvasa z marginesem - plakietka i dymek nad nia
    // (razem ok. 150px w pionie, ~180px w poziomie) musza ZAWSZE w calosci
    // miescic sie w oknie, niezaleznie od tego, gdzie akurat projektuje sie
    // glowa bossa (przy skali x3 latwo wypasc nad gorna krawedz). Dolna granica
    // gornego marginesu jest tez na tyle niska, zeby nie wchodzic pod panel HUD
    // w lewym gornym rogu.
    const H_MARGIN = 100;
    const TOP_MARGIN = 150;
    const BOTTOM_MARGIN = 20;
    const minX = canvasRect.left + H_MARGIN;
    const maxX = canvasRect.left + Math.max(H_MARGIN, canvasRect.width - H_MARGIN);
    const minY = canvasRect.top + TOP_MARGIN;
    const maxY = canvasRect.top + Math.max(TOP_MARGIN, canvasRect.height - BOTTOM_MARGIN);
    sx = Math.min(maxX, Math.max(minX, sx));
    sy = Math.min(maxY, Math.max(minY, sy));

    this.nameplateEl.style.display = 'flex';
    this.nameplateEl.style.left = `${sx}px`;
    this.nameplateEl.style.top = `${sy - 10}px`;

    if (this.state === 'FIGHT' && this.currentEq && this.interDelay <= 0) {
      this.bubbleEl.style.display = 'flex';
      this.bubbleEl.style.left = `${sx}px`;
      this.bubbleEl.style.top = `${sy - 58}px`;
    }
  }

  // ================= RESET GRY =================

  reset() {
    this._teardown();
    this.faintedMap.clear();
  }
}
