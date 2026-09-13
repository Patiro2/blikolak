import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { loadArcade, loadDungeon } from './assets.js';
import { fmtShort } from './format.js';
import { normalizePolish } from './vanessa.js';
import { showBossNotification } from './ui.js';
import { BossAttackFx } from './bossattack.js';
import { normalizeNick, usunTagiEmotek } from './kick.js';
import { audio } from './audio.js';
import { strumien, losujInt, losujZ } from './rng.js';
import { BossKowal } from './boss-kowal.js';
import { BossBlackjack } from './boss-blackjack.js';

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
    mechanika: 'rownania',
  },
  {
    tier: 2,
    name: 'Kowal_88',
    subtitle: 'PRZECIĄŻONY KOWAL Z HUTY',
    hp: 100,
    mechanika: 'kowal',
  },
  {
    tier: 3,
    name: 'Dżordżo',
    subtitle: 'KRÓL BLACKJACKA',
    hp: 100,
    mechanika: 'blackjack',
  },
  null, // tier 4 - TODO kolejny boss
  null, // tier 5 - TODO kolejny boss
];

const HP_PER_HIT = 5;
// Nagroda za zadanie obrazen bossowi (poprawna odpowiedz na dzialanie) - trafia
// do widza, ktory odpowiedzial, TYLKO do rankingu (recordEarned z countsAsClick
// =false, patrz _onCorrectAnswer), nigdy jako "klik". Wczesniej odpowiadajacy
// nie dostawal nic (README: "Odpowiadajacy NIE dostaje zlotowek ani klikow") -
// wlasciciel zdecydowal, ze ma dostawac 10 zl za trafienie.
const REWARD_PER_HIT = 10;
const ANSWER_WINDOW = 8.0; // sekund na odpowiedz
const HIT_TO_NEXT_EQ_DELAY = 1.2; // sekund pauzy po trafieniu, zanim wyskoczy nowe dzialanie
// Atak obszarowy "wymioty": boss celuje w JEDNO pole siatki areny. Pole jest
// najpierw oznaczane (gracz ma czas uciec), potem leci pocisk, a omdlenie
// dostaje ten, kto stoi na polu w chwili uderzenia.
const VOMIT_OSTRZEZENIE = 1.9; // sekundy telegrafowania pola
const VOMIT_LOT = 0.85; // czas lotu pocisku
// Ostrzal rakietowy przy braku odpowiedzi: 10 pol, tez z wyprzedzeniem.
const RAKIETY_OSTRZEZENIE = 2.6;
const RAKIETY_LOT = 0.75;
const RAKIET_NA_SALWE = 10;

// Wzory pol dla ostrzalu rakietowego. Kolejnosc jest STALA i cyklicznie
// powtarzana - nie ma tu zadnego losowania, wiec widzowie moga nauczyc sie
// wzorow i swiadomie uciekac. Kazdy wzor ma dokladnie 10 pol i omija (0,0),
// czyli pole bankomatu.
const WZORY_RAKIET = [
  // krzyz
  [[0,-3],[0,-2],[0,-1],[0,1],[0,2],[0,3],[-3,0],[-1,0],[1,0],[3,0]],
  // przekatne
  [[-3,-3],[-2,-2],[-1,-1],[1,1],[2,2],[3,3],[-3,3],[-2,2],[2,-2],[3,-3]],
  // pierscien wokol bankomatu
  [[-2,-2],[-1,-2],[1,-2],[2,-2],[2,-1],[2,1],[2,2],[1,2],[-1,2],[-2,2]],
  // brzegi areny
  [[-3,-3],[0,-3],[3,-3],[-3,0],[3,0],[-3,3],[0,3],[3,3],[-3,-1],[3,1]],
];

const FAINT_MIN = 12;
const FAINT_MAX = 22;
const CUTSCENE_DURATION = 5.0;

// Zabezpieczenie przed zakleszczeniem ratunku (patrz _checkAutoWake): omdlenie
// ma byc kara zdejmowana normalnie przez INNEGO widza piszacego "pomoc"
// (_tryHelp) - ale gdy akurat nie ma nikogo nieomdlonego w czacie (np. bitwa o
// flagi stawia dwoch jedynych aktywnych graczy na TYM SAMYM polu, atak
// "wymioty" trafia cale pole i omdlewaja OBAJ naraz), nikt nie moze napisac
// "pomoc" i ofiary zostalyby unieruchomione az do konca walki z bossem. Zamiast
// wykrywac ten konkretny przypadek (kruche - zalezaloby od tego, kto akurat
// jest w Top 10/na czacie w danej chwili), kazde omdlenie dostaje twardy limit
// czasu: po FAINT_AUTO_WAKE_SEC bez ratunku ofiara budzi sie sama. Wartosc jest
// SWIADOMIE dluzsza niz najkrotszy odstep miedzy atakami bossa (FAINT_MIN=12s),
// zeby zwykly ratunek przez czat (ktory zazwyczaj reaguje w kilka-kilkanascie
// sekund) zdazyl zadzialac pierwszy - auto-ocucenie jest WYLACZNIE siatka
// bezpieczenstwa na sytuacje bez nikogo do pomocy, nie skroceniem kary.
const FAINT_AUTO_WAKE_SEC = 25;


const SPAWN_POS = new THREE.Vector3(0, 0, -3.0); // korytarz z tylu sceny
const IMPACT_POS = new THREE.Vector3(0.3, 0, 0.2); // punkt uderzenia w bankomat (tuz przed nim)
// Miejsce postoju bossa: idealnie pośrodku wszystkich graczy (X = 0, Z = -0.45),
// w centrum areny za przechylonym bankomatem, twarzą prosto do kamery i widzów.
const FINAL_POS = new THREE.Vector3(0, 0, -0.85);
const APPROACH_CTRL = new THREE.Vector3(1.8, 0, -1.6); // punkt kontrolny "driftu" podjazdu (z prawej)
const SETTLE_CTRL = new THREE.Vector3(-1.4, 0, 0.1); // punkt kontrolny driftu po uderzeniu (okrążenie z lewej do środka)

// Lokalny offset postaci wzgledem wozka (przed skalowaniem grupy x2.2) - wyliczony
// empirycznie z world-space Box3 obu czesci w pozie "wheelchair-sit": bez niego
// postac zjezdza pod podloge i siedzi przed siedziskiem.
const CHAR_LOCAL_OFFSET = new THREE.Vector3(0, 0.113, -0.11);

const CAM_KINO_POS = new THREE.Vector3(0.6, 2.0, 3.6);
const CAM_KINO_TARGET = new THREE.Vector3(0, 0.65, 0.1);

const LOG_LIMIT = 300;

// Pomocnicze obiekty do wymuszania orientacji wyrzutnika - liczone co klatke,
// wiec nie alokujemy ich w petli.
const _osX = new THREE.Vector3(1, 0, 0);
const _qRodzica = new THREE.Quaternion();
const _qCel = new THREE.Quaternion();

function randInt(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/**
 * Losuje dzialanie matematyczne z calkowitym, nieujemnym wynikiem. Bierze
 * gotowy strumien `rng` (patrz src/rng.js) zamiast Math.random(), zeby
 * rownanie numer N w danej walce wyszlo IDENTYCZNE na kazdej otwartej karcie
 * gry (patrz _nextEquation - klucz strumienia zawiera seedGry, numer tieru
 * walki i licznik rownan).
 */
function genEquation(rng) {
  const op = losujZ(rng, ['+', '-', '×', '÷']);
  let a, b, result, text;
  if (op === '+') {
    a = losujInt(rng, 11, 89);
    b = losujInt(rng, 11, 89);
    result = a + b;
    text = `${a} + ${b} = ?`;
  } else if (op === '-') {
    a = losujInt(rng, 11, 89);
    b = losujInt(rng, 1, a);
    result = a - b;
    text = `${a} - ${b} = ?`;
  } else if (op === '×') {
    a = losujInt(rng, 2, 12);
    b = losujInt(rng, 2, 12);
    result = a * b;
    text = `${a} × ${b} = ?`;
  } else {
    b = losujInt(rng, 2, 12);
    result = losujInt(rng, 2, 12);
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
    // Wolane WYLACZNIE przez BossBlackjack (tier 3), gdy pula gracza spadnie
    // do zera po przegranej rundzie - patrz src/boss-blackjack.js/_zastosujWynik
    // i src/gameover.js. Ustawiane z main.js przez setContext.
    this.onGameOver = null;
    // Zapis stanu (economy.save + zapiszNaSerwer) - przekazany przez main.js,
    // zeby BossBlackjack mogl natychmiast zapisac odjecie kary (patrz zadanie).
    this.save = null;

    // Wzorzec i uzasadnienie identyczne jak machine.czyKlikaniaDozwolone
    // (machine.js) i vanessa.czyKlikaniaDozwolone (vanessa.js): naliczanie
    // nagrody 10 zl za poprawna odpowiedz to DECYZJA (dopisuje kase do
    // rankingu), a boss.onChatMessage dziala dzis identycznie na kazdej
    // otwartej karcie (host i kazdy widz licza HP i floatery lokalnie,
    // niezaleznie - patrz applySync/getSyncState, ktore synchronizuja tylko
    // hp/liczniki, nie decyzje). Bez tej strazy KAZDA karta doliczylaby 10 zl
    // temu widzowi u siebie i ranking rozjechalby sie miedzy kartami. main.js
    // ustawia to na () => remote.czyAdmin() - patrz tam.
    this.czyNaliczanieDozwolone = null;

    this.chairTemplate = null;
    this.charTemplate = null;
    this.animations = [];
    this.orcTemplate = null; // character-orc.glb (kenney_mini-dungeon) - cialo Kowala_88
    this.orcAnimations = [];
    this.kowal = null; // instancja BossKowal - tylko gdy def.mechanika === 'kowal' (patrz src/boss-kowal.js)
    this.blackjackTemplate = null; // character-male-b.glb (kenney_mini-arcade) - cialo Dzordzo
    this.blackjackAnimations = [];
    this.blackjack = null; // instancja BossBlackjack - tylko gdy def.mechanika === 'blackjack' (patrz src/boss-blackjack.js)

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
    this._lastTickSecond = null;

    // Liczniki losowan zakotwiczonych we wspolnym ziarnie gry (patrz src/rng.js) -
    // licznikRownan rosnie przy kazdym nowym dzialaniu, licznikAtakow przy
    // kazdym ataku "wymiotow" na pole. Oba sa czescia stanu synchronizowanego
    // do widzow (patrz getSyncState/applySync) - wyrownanie ich u widza od razu
    // przelicza biezace rownanie ze wspolnego strumienia.
    this.licznikRownan = 0;
    this.licznikAtakow = 0;
    this._licznikIdle = 0; // pomocniczy licznik dla harmonogramu bezczynnego rozgladania sie (nie synchronizowany - czysto kosmetyczny)
    this.startWalki = null; // Date.now() z chwili startu walki - czesc stanu synchronizowanego

    this.faintTimer = this._randomFaintDelay();

    // Tryb awaryjny (patrz _hasEligibleSolvers): gdy nikt z Top 10 nie moze
    // juz odpowiadac (ranking pusty albo wszyscy uprawnieni omdleni), boss
    // przyjmuje odpowiedzi od KAZDEGO widza czatu, zeby walka nigdy nie
    // zaklinowala sie na amen. Flaga pilnuje, zeby komunikat w feedzie
    // pokazal sie raz na dzialanie, nie przy kazdej wiadomosci na czacie.
    this._emergencyAnnounced = false;

    this.faintedMap = new Map(); // username(lower) -> { username, slot, ts }

    // Efekty atakow obszarowych (znaczniki pol, pociski, rakiety, dym)
    this.fx = new BossAttackFx(scene);
    this.bronObj = null; // wyrzutnik doczepiony do reki bossa na czas salwy
    this._wzorRakiet = 0; // indeks kolejnego wzoru - rosnie o 1, bez losowania
    this._timeryAtakow = []; // aktywne timery atakow - anulowane przy koncu walki
    this.kosci = null;
    this._poza = null; // { typ, t, czas } - reczna poza nakladana na wheelchair-sit
    this._idleTimer = 6 + Math.random() * 4; // pierwszy odstep (przed startem walki) - kosmetyczny, bez znaczenia dla synchronizacji

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

  /**
   * Odstep do kolejnego ataku "wymiotow" na pole - zakotwiczony w liczniku
   * atakow (nie w Math.random()), zeby kazda karta gry wylosowala ten sam
   * odstep. Przy konstrukcji (poza walka) idWalki jest jeszcze null - to nie
   * szkodzi, bo ta wartosc i tak zostanie nadpisana w start()/startFromSync().
   */
  _randomFaintDelay() {
    const seed = this.economy.state.seedGry;
    const idWalki = this.pendingTier;
    const rng = strumien(`${seed}:faintDelay:${idWalki}:${this.licznikAtakow}`);
    return FAINT_MIN + rng() * (FAINT_MAX - FAINT_MIN);
  }

  setContext({ workerManager, workerOverlays, kickChat, vanessa, onDefeated, onGameOver, save }) {
    this.workerManager = workerManager || this.workerManager;
    this.workerOverlays = workerOverlays || this.workerOverlays;
    this.kickChat = kickChat || this.kickChat;
    this.vanessaRef = vanessa || this.vanessaRef;
    this.onDefeated = onDefeated || this.onDefeated;
    this.onGameOver = onGameOver || this.onGameOver;
    this.save = save || this.save;
  }

  async init() {
    const [chairGltf, charGltf, orcGltf, blackjackGltf] = await Promise.all([
      loadArcade('wheelchair-deluxe'),
      loadArcade('character-male-f'),
      loadDungeon('character-orc'),
      loadArcade('character-male-b'),
    ]);
    await this.fx.init();
    this.chairTemplate = chairGltf.scene;
    this.charTemplate = charGltf.scene;
    this.animations = charGltf.animations || [];
    this.orcTemplate = orcGltf.scene;
    this.orcAnimations = orcGltf.animations || [];
    this.blackjackTemplate = blackjackGltf.scene;
    this.blackjackAnimations = blackjackGltf.animations || [];
  }

  isActive() {
    return this.state !== 'IDLE';
  }

  /** Czy dany widz jest aktualnie omdlony - jego "klik" ma byc ignorowany (patrz main.js onKlik). */
  isFainted(username) {
    if (!username) return false;
    return this.faintedMap.has(normalizeNick(username));
  }

  // --- DOM overlaye: plakietka z HP, dymek z dzialaniem, letterbox, karta tytulowa ---
  _createDOMOverlays() {
    const np = document.createElement('div');
    np.className = 'boss-nameplate';
    np.style.display = 'none';

    // Górny wiersz: Nazwa bossa po lewej, tekst HP po prawej
    const headerRow = document.createElement('div');
    headerRow.className = 'boss-header-row';

    const nameRow = document.createElement('div');
    nameRow.className = 'boss-name-row';
    nameRow.textContent = '👹 Kamil Kovalenko';
    headerRow.appendChild(nameRow);
    this.nameRowEl = nameRow;

    const hpText = document.createElement('div');
    hpText.className = 'boss-hp-text';
    hpText.textContent = '100 / 100';
    headerRow.appendChild(hpText);
    np.appendChild(headerRow);

    // Pasek HP
    const hpWrap = document.createElement('div');
    hpWrap.className = 'boss-hp-bar';
    const hpFill = document.createElement('div');
    hpFill.className = 'boss-hp-fill';
    hpWrap.appendChild(hpFill);
    np.appendChild(hpWrap);

    // Pasek przeciazenia (WYLACZNIE Kowal_88, tier 2) - analogiczny do paska
    // HP powyzej, w innym kolorze. Ukryty domyslnie - pokazywany tylko na
    // czas walki z bossem, ktorego def.mechanika === 'kowal' (patrz
    // _beginCutsceneKowal/_teardown).
    const overloadWrap = document.createElement('div');
    overloadWrap.className = 'boss-overload-bar';
    overloadWrap.style.display = 'none';
    const overloadFill = document.createElement('div');
    overloadFill.className = 'boss-overload-fill';
    overloadWrap.appendChild(overloadFill);
    np.appendChild(overloadWrap);
    this.overloadWrapEl = overloadWrap;
    this.overloadFillEl = overloadFill;

    // Zintegrowana sekcja działania matematycznego z paskiem odliczania
    const eqSection = document.createElement('div');
    eqSection.className = 'boss-equation-section';
    eqSection.style.display = 'none';

    const eqText = document.createElement('div');
    eqText.className = 'boss-equation';
    eqText.textContent = '';
    eqSection.appendChild(eqText);

    const timerWrap = document.createElement('div');
    timerWrap.className = 'boss-timer-bar';
    const timerFill = document.createElement('div');
    timerFill.className = 'boss-timer-fill';
    timerWrap.appendChild(timerFill);
    eqSection.appendChild(timerWrap);

    np.appendChild(eqSection);

    this.container.appendChild(np);
    this.nameplateEl = np;
    this.hpFillEl = hpFill;
    this.hpTextEl = hpText;
    this.equationSectionEl = eqSection;
    this.bubbleEl = eqSection;
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

    // Dymek Kowala_88 - cykliczne teksty nad glowa (patrz BossKowal._updateDymek).
    // Osobny element, bo eqSection powyzej jest specyficzna dla dzialan bossa 1.
    const dymek = document.createElement('div');
    dymek.className = 'boss-dymek';
    dymek.style.display = 'none';
    document.body.appendChild(dymek);
    this.dymekEl = dymek;

    // Panel HUD Dzordzo (tier 3, blackjack) - pozycja STALA (nie
    // rzutowana z 3D, patrz style.css .boss-bj-panel), bo dotyczy calej
    // planszy (obie polfoki DOBIERZ/PASUJ), nie tylko samego bossa.
    const bjPanel = document.createElement('div');
    bjPanel.className = 'boss-bj-panel';
    const bjSums = document.createElement('div');
    bjSums.className = 'boss-bj-sums';
    const bjSumBoss = document.createElement('span');
    bjSumBoss.className = 'bj-bank';
    const bjSumPlayers = document.createElement('span');
    bjSumPlayers.className = 'bj-gracze';
    bjSums.appendChild(bjSumBoss);
    bjSums.appendChild(bjSumPlayers);
    const bjFaza = document.createElement('div');
    bjFaza.className = 'boss-bj-faza';
    const bjTimerWrap = document.createElement('div');
    bjTimerWrap.className = 'boss-bj-timer-bar';
    const bjTimerFill = document.createElement('div');
    bjTimerFill.className = 'boss-bj-timer-fill';
    bjTimerWrap.appendChild(bjTimerFill);
    const bjRemis = document.createElement('div');
    bjRemis.className = 'boss-bj-remis';
    bjPanel.appendChild(bjSums);
    bjPanel.appendChild(bjFaza);
    bjPanel.appendChild(bjTimerWrap);
    bjPanel.appendChild(bjRemis);
    document.body.appendChild(bjPanel);
    this.bjPanelEl = bjPanel;
    this.bjSumBossEl = bjSumBoss;
    this.bjSumPlayersEl = bjSumPlayers;
    this.bjFazaEl = bjFaza;
    this.bjTimerWrapEl = bjTimerWrap;
    this.bjTimerFillEl = bjTimerFill;
    this.bjRemisEl = bjRemis;
  }

  /**
   * Postacie graczy podzielone na dwie polowy planszy wzgledem x=0 - patrz
   * BossBlackjack (faza WYBOR: x<0 = "DOBIERZ", x>0 = "PASUJ", x=0 neutralne).
   * Idaca postac liczy sie po polu DOCELOWYM (ten sam wzorzec co _workersOnTile).
   */
  _countBySide() {
    let lewo = 0;
    let prawo = 0;
    if (this.workerManager) {
      for (const e of this.workerManager.entries) {
        if (!e || !e.obj) continue;
        const gx = e.isMoving ? e.targetGridX : e.gridX;
        if (gx < 0) lewo += 1;
        else if (gx > 0) prawo += 1;
      }
    }
    return { lewo, prawo };
  }

  /**
   * Wlacza reczna poze nakladana na klip wheelchair-sit. Pozy sa liczone
   * po kosciach ZA kazdym update() miksera, wiec nie walcza z animacja bazowa.
   */
  _ustawPoze(typ, czas) {
    this._poza = { typ, t: 0, czas };
  }

  /** Nakladanie recznej pozy na kosci - wolane PO mixer.update(). */
  _aktualizujPoze(delta) {
    if (!this.kosci) return;
    const { torso, head, armRight, armLeft } = this.kosci;
    if (!this._poza) return;

    this._poza.t += delta;
    const p = this._poza;
    const u = p.czas > 0 ? Math.min(1, p.t / p.czas) : 1;

    if (p.typ === 'trafienie') {
      // Szarpniecie do tylu po trafieniu poprawna odpowiedzia
      const a = Math.sin(Math.PI * u) * 0.42;
      if (torso) torso.rotation.x -= a;
      if (head) head.rotation.x -= a * 0.7;
      if (armLeft) armLeft.rotation.x -= a * 0.5;
      if (armRight) armRight.rotation.x -= a * 0.5;
    } else if (p.typ === 'wymioty') {
      // Zamach do tylu, gwaltowne zgiecie do przodu, powolny powrot
      let a;
      if (u < 0.25) a = -0.35 * (u / 0.25);
      else if (u < 0.45) a = -0.35 + 1.45 * ((u - 0.25) / 0.2);
      else if (u < 0.75) a = 1.1;
      else a = 1.1 * (1 - (u - 0.75) / 0.25);
      if (torso) torso.rotation.x += a;
      if (head) head.rotation.x += a * 0.55;
      if (armLeft) armLeft.rotation.x += a * 0.3;
      if (armRight) armRight.rotation.x += a * 0.3;
    } else if (p.typ === 'strzal') {
      // Reka z wyrzutnikiem idzie w gore, potem odrzut
      const podniesienie = u < 0.3 ? u / 0.3 : 1;
      const odrzut = u > 0.45 && u < 0.65 ? Math.sin(Math.PI * ((u - 0.45) / 0.2)) : 0;
      if (armRight) armRight.rotation.x -= podniesienie * 2.0 + odrzut * 0.35;
      if (torso) torso.rotation.x -= odrzut * 0.25;
      if (head) head.rotation.x -= podniesienie * 0.45;
      // Sam obrot kosci reki nie ustawia lufy w niebo - model wyrzutnika ma
      // wlasna orientacje, a kosc dodatkowo obraca sie w trakcie odrzutu.
      // Dlatego orientacje broni wymuszamy wprost w ukladzie SWIATA: os +Z
      // modelu (lufa) ma pokrywac sie z pionem, z niewielkim odchyleniem
      // w czasie odrzutu.
      if (this.bronObj && this.bronObj.parent) {
        const rodzic = this.bronObj.parent;
        rodzic.updateWorldMatrix(true, false);
        rodzic.getWorldQuaternion(_qRodzica);
        _qCel.setFromAxisAngle(_osX, -Math.PI / 2 + odrzut * 0.3);
        this.bronObj.quaternion.copy(_qRodzica.invert().multiply(_qCel));
      }
    } else if (p.typ === 'smierc') {
      // Bezwladne osuniecie sie w fotelu - trwa do konca
      const a = Math.min(1, p.t / 1.2);
      if (torso) {
        torso.rotation.x += a * 0.75;
        torso.rotation.z += a * 0.3;
      }
      if (head) head.rotation.x += a * 0.6;
      if (armLeft) armLeft.rotation.x += a * 0.9;
      if (armRight) armRight.rotation.x += a * 0.9;
    }

    if (p.typ !== 'smierc' && u >= 1) {
      this._poza = null;
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

    if (def.mechanika === 'kowal') {
      if (!this.orcTemplate) {
        this._log('bad', 'Nie moge wystartowac - model Kowala_88 jeszcze sie nie zaladowal');
        return false;
      }
    } else if (def.mechanika === 'blackjack') {
      if (!this.blackjackTemplate) {
        this._log('bad', 'Nie moge wystartowac - model Dzordzo jeszcze sie nie zaladowal');
        return false;
      }
    } else if (!this.chairTemplate || !this.charTemplate) {
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
    this.licznikRownan = 0;
    this.licznikAtakow = 0;
    this.startWalki = Date.now();
    this.faintTimer = this._randomFaintDelay();

    this._log('spawn', `Startuje walka z bossem "${def.name}" (awans na tier ${tier})`, { tier, hp: this.hp });

    if (def.mechanika === 'kowal') {
      // Kowal gra wlasny dzwiek wejscia w chwili zjazdu na linie (patrz
      // BossKowal.beginEntrance) - nie ma tu cutscenki z podjazdem jak boss 1.
      this.kowal = new BossKowal(this);
      this.blackjack = null;
      this.model = this.kowal.build();
      this.mixer = null;
      this._beginCutsceneKowal();
    } else if (def.mechanika === 'blackjack') {
      this.kowal = null;
      this.blackjack = new BossBlackjack(this);
      this.model = this.blackjack.build();
      this.mixer = null;
      this._beginCutsceneBlackjack();
    } else {
      this.kowal = null;
      this.blackjack = null;
      audio.play('boss-wejscie');
      this._buildModel();
      this._beginCutscene();
    }
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
    group.scale.setScalar(2.2);

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
    // Kosci rigu Kenneya - poza bossa jest sterowana recznie NA WIERZCHU klipu
    // wheelchair-sit (patrz _aktualizujPoze). Klipy dla postaci stojacej
    // (emote-no, pick-up, holding-right-shoot, die) wygladaly zle na kims, kto
    // siedzi w wozku - nogi wymachiwaly, a tulow wychodzil z fotela.
    this.kosci = {
      torso: char.getObjectByName('torso'),
      head: char.getObjectByName('head'),
      armRight: char.getObjectByName('arm-right'),
      armLeft: char.getObjectByName('arm-left'),
    };
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
    if (this.nameRowEl) this.nameRowEl.textContent = `👹 ${this.def.name}`;

    // reflow, zeby animacje CSS zawsze wystartowaly od nowa
    void this.letterboxTop.offsetWidth;
    this.letterboxTop.classList.add('show');
    this.letterboxBottom.classList.add('show');
    this.titleCardEl.classList.remove('show');
    void this.titleCardEl.offsetWidth;
    this.titleCardEl.classList.add('show');

    this.nameplateEl.style.display = 'flex';
    if (this.overloadWrapEl) this.overloadWrapEl.style.display = 'none';
    this.hpFillEl.style.width = '100%';
    this.hpTextEl.textContent = `${this.hp} / ${this.maxHp}`;
  }

  /**
   * Wejscie Kowala_88 - zamiast cutscenki z podjazdem (boss 1), pokazujemy
   * te sama karte tytulowa/letterbox, ale bez blokady kamery (wlasciciel
   * zaakceptowal pominiecie kamery kinowej dla tego bossa - wyglada lepiej,
   * bo widac cala zjazd na linie). Faktyczny zjazd prowadzi BossKowal.update().
   */
  _beginCutsceneKowal() {
    this.state = 'CUTSCENE';
    this.cutsceneT = 0;

    this.titleNameEl.textContent = `👹 ${this.def.name.toUpperCase()}`;
    this.titleSubEl.textContent = this.def.subtitle || '';
    if (this.nameRowEl) this.nameRowEl.textContent = `👹 ${this.def.name}`;

    void this.letterboxTop.offsetWidth;
    this.letterboxTop.classList.add('show');
    this.letterboxBottom.classList.add('show');
    this.titleCardEl.classList.remove('show');
    void this.titleCardEl.offsetWidth;
    this.titleCardEl.classList.add('show');

    this.nameplateEl.style.display = 'flex';
    if (this.overloadWrapEl) {
      this.overloadWrapEl.style.display = 'block';
      this.overloadFillEl.style.width = '0%';
    }
    this.hpFillEl.style.width = '100%';
    this.hpTextEl.textContent = `${this.hp} / ${this.maxHp}`;

    this.kowal.beginEntrance();
  }

  _endCutsceneKowal() {
    this.letterboxTop.classList.remove('show');
    this.letterboxBottom.classList.remove('show');
    this.titleCardEl.classList.remove('show');

    this.state = 'FIGHT';
    this._log('info', 'Kowal_88 wyladowal na arenie - start walki');
  }

  /**
   * Wejscie Dzordzo (tier 3, blackjack) - ta sama karta tytulowa/letterbox
   * co Kowal, BEZ blokady kamery (patrz zadanie wlasciciela: "Pokaż tę samą
   * kartę tytułową/letterbox co przy Kowalu, bez blokady kamery"). Faktyczny
   * marsz z tylu sceny prowadzi BossBlackjack.update() (patrz beginEntrance).
   */
  _beginCutsceneBlackjack() {
    this.state = 'CUTSCENE';
    this.cutsceneT = 0;

    this.titleNameEl.textContent = `👹 ${this.def.name.toUpperCase()}`;
    this.titleSubEl.textContent = this.def.subtitle || '';
    if (this.nameRowEl) this.nameRowEl.textContent = `👹 ${this.def.name}`;

    void this.letterboxTop.offsetWidth;
    this.letterboxTop.classList.add('show');
    this.letterboxBottom.classList.add('show');
    this.titleCardEl.classList.remove('show');
    void this.titleCardEl.offsetWidth;
    this.titleCardEl.classList.add('show');

    this.nameplateEl.style.display = 'flex';
    if (this.overloadWrapEl) this.overloadWrapEl.style.display = 'none';
    this.hpFillEl.style.width = '100%';
    this.hpTextEl.textContent = `${this.hp} / ${this.maxHp}`;

    this.blackjack.beginEntrance();
  }

  _endCutsceneBlackjack() {
    this.letterboxTop.classList.remove('show');
    this.letterboxBottom.classList.remove('show');
    this.titleCardEl.classList.remove('show');

    this.state = 'FIGHT';
    this._log('info', 'Dzordzo dotarl na arene - start walki blackjacka');
  }

  /** Czy boss aktualnie ma pelna kontrole nad kamera (main.js pomija wtedy controls.update()). */
  isCameraLocked() {
    return this._camLockActive;
  }

  // ================= UPDATE GLOWNY =================

  update(delta, camera, canvasRect) {
    if (this.state === 'IDLE') return;

    if (this.mixer) this.mixer.update(delta);
    // Reczna poza MUSI byc nakladana po mikserze - inaczej nastepna klatka
    // animacji bazowej nadpisalaby ja w calosci.
    this._aktualizujPoze(delta);
    this.fx.update(delta);

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
    if (this.def && this.def.mechanika === 'kowal') {
      this.kowal.update(delta);
      if (!this.kowal.fazaWejscia) this._endCutsceneKowal();
      return;
    }
    if (this.def && this.def.mechanika === 'blackjack') {
      this.blackjack.update(delta);
      if (!this.blackjack.fazaWejscia) this._endCutsceneBlackjack();
      return;
    }

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
      if (driveU < 0.90) {
        const aheadU = Math.min(1, driveU + 0.03);
        let ahead;
        if (aheadU < 0.55) ahead = quadBezier(this._bezierTmp2, SPAWN_POS, APPROACH_CTRL, IMPACT_POS, aheadU / 0.55);
        else ahead = quadBezier(this._bezierTmp2, IMPACT_POS, SETTLE_CTRL, FINAL_POS, Math.min(1, (aheadU - 0.55) / 0.45));
        this.model.lookAt(ahead.x, this.model.position.y, ahead.z);
      } else {
        // Ostatni odcinek driftu - boss obraca się twarzą prosto do kamery (graczy)
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
    audio.play('boss-uderzenie');
    this._log('bad', 'Boss uderza w bankomat! Bankomat zostaje rozwalony na czas walki');
    if (this.machine.model) {
      this.machine.model.rotation.z = 0.35;
      this.machine.model.position.x = -0.12;
      this.machine.model.position.y = -0.04;
      this.machine.model.position.z = 0.28;
    }
    this.coinPool.burst(new THREE.Vector3(0, 0.6, 0.3), 40);

    showBossNotification(
      'boss',
      '💥 UDERZENIE W BANKOMAT!',
      'Kamil Kovalenko rozwalił bankomat i przejmuje arenę!',
    );

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
    if (this.def && this.def.mechanika === 'kowal') {
      this.kowal.update(delta);
      if (this.overloadFillEl) this.overloadFillEl.style.width = `${this.kowal.przeciazenie}%`;
      return;
    }
    if (this.def && this.def.mechanika === 'blackjack') {
      this.blackjack.update(delta);
      return;
    }

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
      // Tik odliczania - dokladnie raz na sekunde w ostatnich 3 sekundach
      // (NIE co klatke - eqTimer plynie po delta, wiec pilnujemy zmiany
      // zaokraglonej sekundy zamiast odtwarzac dzwiek na kazdym update()).
      if (this.eqTimer > 0 && this.eqTimer <= 3) {
        const sec = Math.ceil(this.eqTimer);
        if (sec !== this._lastTickSecond) {
          this._lastTickSecond = sec;
          audio.play('boss-tik');
        }
      }
      if (this.eqTimer <= 0) {
        this._onTimeout();
      }
    }

    // Bezczynnosc: co kilka sekund boss rozglada sie na boki. Uzywamy WYLACZNIE
    // klipow z rodziny wheelchair-*, bo tylko one sa animowane dla postaci
    // siedzacej w wozku.
    this._idleTimer -= delta;
    if (this._idleTimer <= 0) {
      // Odstep do kolejnego rozgladania sie jest zakotwiczony w liczniku (jak
      // _randomFaintDelay), zeby harmonogram bezczynnosci tez byl wspolny -
      // kierunek (lewo/prawo) jest czysto kosmetyczny, wiec zostaje losowy.
      this._licznikIdle += 1;
      const rng = strumien(`${this.economy.state.seedGry}:idle:${this.pendingTier}:${this._licznikIdle}`);
      this._idleTimer = 6 + rng() * 5;
      if (!this._poza) {
        this.playAction(Math.random() < 0.5 ? 'wheelchair-look-left' : 'wheelchair-look-right', { once: true });
      }
    }

    // Atak obszarowy na pole - boss co jakis czas plunie na wybrane pole areny
    this.faintTimer -= delta;
    if (this.faintTimer <= 0) {
      this.faintTimer = this._randomFaintDelay();
      this._startVomitAttack();
    }

    // Zabezpieczenie przed zakleszczeniem ratunku - patrz FAINT_AUTO_WAKE_SEC.
    this._checkAutoWake();
  }

  /** Klucz strumienia dla N-tego rownania biezacej walki - patrz src/rng.js. */
  _rownanieRng(numerRownania) {
    const seed = this.economy.state.seedGry;
    const idWalki = this.pendingTier;
    return strumien(`${seed}:rownanie:${idWalki}:${numerRownania}`);
  }

  _nextEquation() {
    this.licznikRownan += 1;
    this.currentEq = genEquation(this._rownanieRng(this.licznikRownan));
    this.eqTimer = ANSWER_WINDOW;
    this.interDelay = 0;
    this._emergencyAnnounced = false;
    this._lastTickSecond = null;
    audio.play('boss-dzialanie');
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

    // Tagi emotek [emote:ID:NAZWA] usuwamy PRZED jakimkolwiek porownaniem -
    // inaczej cyfry z ID emotki (np. "39262") mogłyby przypadkiem trafic w
    // wynik dzialania po wyciecu nie-cyfrowych znakow ponizej.
    content = usunTagiEmotek(content);
    if (!content) return;

    // Kowal_88 (tier 2): KAZDA wiadomosc na czacie (od dowolnego widza, takze
    // spoza rankingu) podbija pasek przeciazenia - brak tu rownan/ratunku
    // bossa 1, wiec dalsza czesc tej metody go nie dotyczy.
    if (this.def && this.def.mechanika === 'kowal') {
      if (this.kowal) this.kowal.onChatMessage(username, content);
      return;
    }

    // Dzordzo (tier 3, blackjack): decyzje graczy ida przez POZYCJE
    // awatarow na siatce (patrz BossBlackjack._countBySide), nie przez czat -
    // czat nie ma tu zadnej roli, wiec po prostu nic nie robimy.
    if (this.def && this.def.mechanika === 'blackjack') {
      return;
    }

    // Ratunek dla omdlonego
    const norm = normalizePolish(content);
    const tokensNorm = norm.split(/\s+/).filter(Boolean);
    if (tokensNorm.includes('pomoc')) {
      this._tryHelp(username, color);
      return;
    }

    if (!this.currentEq || this.interDelay > 0) return;

    // Failsafe: gdy nikt z Top 10 nie jest juz w stanie odpowiedziec (ranking
    // pusty albo wszyscy uprawnieni omdleli), walka NIE moze zostac na zawsze
    // zaklinowana - boss zaczyna przyjmowac odpowiedzi od KAZDEGO widza czatu.
    const emergency = !this._hasEligibleSolvers();
    if (emergency) {
      if (!this._emergencyAnnounced) {
        this._emergencyAnnounced = true;
        this._log('bad', 'Brak uprawnionych do odpowiedzi (ranking pusty/wszyscy omdleli) - TRYB AWARYJNY: boss przyjmuje odpowiedzi od calego czatu');
        showBossNotification(
          'boss',
          '⚠️ TRYB AWARYJNY!',
          'Nikt z Top 10 nie może już odpowiadać - <strong>boss przyjmuje odpowiedzi od całego czatu!</strong>',
        );
      }
    } else {
      // Normalna zasada: tylko osoby bedace aktualnie w grze (w Top 10 z
      // przypisana postacia) moga odgadywac wyniki, i tylko jesli nie omdlaly.
      const inGame = this.kickChat && this.kickChat.getWorkerForUser(username) !== null;
      if (!inGame) return;

      const key = normalizeNick(username);
      if (this.faintedMap.has(key)) return; // omdlali nie moga odpowiadac
    }

    const tokens = content.split(/\s+/).map((t) => t.replace(/[^\d-]/g, '')).filter((t) => t.length > 0);
    const hit = tokens.some((t) => Number(t) === this.currentEq.result);
    if (hit) {
      this._onCorrectAnswer(username, color);
    }
  }

  /**
   * Czy w tym momencie istnieje choc jedna osoba UPRAWNIONA do normalnego
   * odpowiadania na dzialania bossa - czyli widz z Top 10 z przypisanym
   * pracownikiem, ktory NIE jest omdlaly. Gdy zwraca false, onChatMessage
   * przechodzi w tryb awaryjny (patrz wyzej) - inaczej walka moglaby utknac
   * na zawsze (pusty ranking albo ostatnia osoba w nim akurat omdlala).
   */
  _hasEligibleSolvers() {
    if (!this.kickChat) return false;
    const top10 = this.kickChat.getTopEarners(10);
    return top10.some((u) => {
      const slot = this.kickChat.getWorkerForUser(u.username);
      if (slot === null) return false;
      const key = normalizeNick(u.username || '');
      return !this.faintedMap.has(key);
    });
  }

  _onCorrectAnswer(username, color) {
    const dmg = HP_PER_HIT;
    const eqText = this.currentEq ? this.currentEq.text.replace(' = ?', ` = ${this.currentEq.result}`) : '';
    this.hp = Math.max(0, this.hp - dmg);
    this._log('good', `@${username} trafil poprawna odpowiedz (${this.currentEq?.result}) - boss traci ${dmg} HP`, {
      hpPo: this.hp,
    });

    audio.play('boss-trafienie');
    if (this.model) {
      this.projectAndFloat(this._bossFloaterOrigin(), `✔ @${username}`, { crit: true, kick: true });
      // Przesuniety w bok o 0.6 jednostki swiata (nie dokladnie ten sam punkt
      // co floater ✔ powyzej) - inaczej oba floatery leca w gore idealnie na
      // sobie i "+10 zl" byloby nieczytelne/niewidoczne na streamie.
      this.projectAndFloat(
        this._bossFloaterOrigin().add(new THREE.Vector3(0.6, -0.25, 0)),
        `+${REWARD_PER_HIT} zł`,
        { gold: true },
      );
    }

    // Nagroda 10 zl dla odpowiadajacego - dziala rowniez w trybie awaryjnym
    // (emergency, patrz onChatMessage), bo to nadal poprawna odpowiedz, tylko
    // od widza spoza normalnie uprawnionych. Naliczanie to DECYZJA (patrz
    // komentarz przy czyNaliczanieDozwolone w konstruktorze) - tylko host ja
    // podejmuje, inaczej kazda otwarta karta dopisze 10 zl temu widzowi u
    // siebie i ranking rozjedzie sie miedzy kartami. countsAsClick=false -
    // to nie jest komenda "klik" z czatu (dokladnie jak zlota moneta w
    // goldcoin.js/_collectByWorker), wiec licznik "clicks" widza NIE rosnie.
    if (!this.czyNaliczanieDozwolone || this.czyNaliczanieDozwolone()) {
      if (this.kickChat) this.kickChat.recordEarned(username, REWARD_PER_HIT, color, false);
      if (this.economy) this.economy.addMoney(REWARD_PER_HIT);
    }

    this._ustawPoze('trafienie', 0.45);
    this._shakeBossOnce();

    showBossNotification(
      'hit',
      `✔ @${username} ROZWIĄZAŁ DZIAŁANIE!`,
      `Odpowiedział <strong>${eqText}</strong> — boss traci ${dmg} HP! (${this.hp}/${this.maxHp})`,
    );

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
    this._startRocketStrike();
    this._nextEquation();
  }


  /**
   * Usmierca KONKRETNEGO widza - wolane wtedy, gdy rakieta trafi w pole, na
   * ktorym stoi jego postac. Nie ma tu juz zadnego losowania ofiary: o tym,
   * kto ginie, decyduje wylacznie to, gdzie kto stoi w chwili uderzenia.
   *
   * `opts.source` rozroznia tylko TEKST powiadomienia/logu - reszta skutku
   * (utrata dorobku, zniknięcie z rankingu, animacja smierci, usuniecie
   * modelu po 2.5 s) jest identyczna niezaleznie od zrodla. Domyslne
   * 'rocket' to trafienie rakieta bossa; 'admin' to reczna eliminacja z
   * panelu wlasciciela w HUD (patrz killUserManual nizej) i dziala tak samo
   * poza walka, jak i w jej trakcie.
   */
  _killUser(username, opts = {}) {
    if (!username || !this.kickChat) return;
    const source = opts.source || 'rocket';
    const wpis = this.kickChat.leaderboard[normalizeNick(username)];
    const workerIndex = this.kickChat.getWorkerForUser(username);
    const lostAmount = Math.round(wpis ? wpis.totalEarned || 0 : 0);

    if (this.kickChat) this.kickChat.eliminateUser(username);

    if (workerIndex !== null && this.workerManager) {
      const entry = this.workerManager.getWorkerType(workerIndex);
      if (entry && entry.obj) {
        const origin = entry.obj.position.clone().add(new THREE.Vector3(0, 1.6, 0));
        this.projectAndFloat(origin, `💀 @${username}`, { crit: true, steal: true });
        this.workerManager.playDeath(workerIndex);
        setTimeout(() => {
          // Usunięcie modelu tylko wtedy, gdy slot nie został w międzyczasie
          // ponownie zajęty przez powracającego widza lub nowego gracza
          if (this.workerManager) {
            const currentSlotUser = this.kickChat ? this.kickChat.getUserForWorker(workerIndex) : null;
            if (!currentSlotUser) {
              this.workerManager.removeWorkerType(workerIndex);
            }
          }
        }, 2500);
      }
    }

    if (source === 'admin') {
      showBossNotification(
        'kill',
        `💀 @${username} ZOSTAŁ USUNIĘTY PRZEZ STREAMERA`,
        `Stracił cały dorobek (<strong>${fmtShort(lostAmount)} zł</strong>) i wypadł z rankingu.`,
      );
      this._log('bad', `Streamer usunal @${username} z panelu eliminacji - stracil ${lostAmount} zl i wypadl z rankingu`, {
        ofiara: username,
        utraconeZl: lostAmount,
      });
    } else if (source === 'kowal') {
      showBossNotification(
        'kill',
        `💀 KOWAL_88 ZMIAŻDŻYŁ @${username}!`,
        `Stał na polu, na które wszedł Kowal. Stracił cały dorobek (<strong>${fmtShort(lostAmount)} zł</strong>) i wypadł z rankingu.`,
      );
      this._log('bad', `Kowal_88 "zabil" @${username} wchodzac na jego pole - stracil ${lostAmount} zl i wypadl z rankingu`, {
        ofiara: username,
        utraconeZl: lostAmount,
      });
    } else {
      showBossNotification(
        'kill',
        `💀 RAKIETA TRAFIŁA @${username}!`,
        `Stał na oznaczonym polu. Stracił cały dorobek (<strong>${fmtShort(lostAmount)} zł</strong>) i wypadł z rankingu.`,
      );
      this._log('bad', `Boss "zabil" @${username} - stracil ${lostAmount} zl i wypadl z rankingu`, {
        ofiara: username,
        utraconeZl: lostAmount,
      });
    }
  }

  /**
   * Reczna eliminacja widza z panelu wlasciciela w HUD (poza walka z bossem,
   * patrz btn-eliminacja w main.js). Uzywa dokladnie tej samej logiki
   * wykonawczej co trafienie rakieta (_killUser) - rozni sie wylacznie
   * tekstem powiadomienia. Bezpieczna do wywolania niezaleznie od tego, czy
   * boss aktualnie walczy: nie dotyka hp/cutscenki, korzysta tylko z
   * this.kickChat/this.workerManager/this.projectAndFloat, ktore sa ustawione
   * raz w boss.setContext() przy starcie gry (patrz main.js).
   */
  killUserManual(username) {
    this._killUser(username, { source: 'admin' });
  }


  // ================= ATAKI OBSZAROWE NA POLA =================

  /** Postacie stojace na danym polu. Idaca postac liczy sie po polu DOCELOWYM. */
  _workersOnTile(x, z) {
    const out = [];
    if (!this.workerManager) return out;
    for (const e of this.workerManager.entries) {
      if (!e || !e.obj) continue;
      const gx = e.isMoving ? e.targetGridX : e.gridX;
      const gz = e.isMoving ? e.targetGridZ : e.gridZ;
      if (Number(gx) === x && Number(gz) === z) out.push(e);
    }
    return out;
  }

  /** Nick przypisany do postaci danego slotu (albo null). */
  _userForWorker(entry) {
    if (!entry || !this.kickChat) return null;
    const u = this.kickChat.getUserForWorker(entry.typeIndex);
    return u ? u.username : null;
  }

  /**
   * Wybor pola pod atak "wymiotow" - LOSOWE pole areny za kazdym razem, ale
   * zakotwiczone w licznikAtakow (strumien `${seed}:pole:${idWalki}:${N}`),
   * wiec kazda otwarta karta gry wybiera DOKLADNIE to samo pole. Pomijamy
   * tylko srodek (0,0), bo tam stoi bankomat i nikt tam nie wejdzie.
   * Losowosc nie czyni ataku niesprawiedliwym: pole jest oznaczane znacznikiem
   * na VOMIT_OSTRZEZENIE sekund przed uderzeniem, wiec kazdy ma czas odejsc.
   */
  _wybierzPoleAtaku() {
    this.licznikAtakow += 1;
    const seed = this.economy.state.seedGry;
    const idWalki = this.pendingTier;
    const rng = strumien(`${seed}:pole:${idWalki}:${this.licznikAtakow}`);
    let x = 0;
    let z = 0;
    do {
      x = losujInt(rng, -3, 3);
      z = losujInt(rng, -3, 3);
    } while (x === 0 && z === 0);
    return { x, z };
  }

  /** Rejestruje timer ataku, zeby dalo sie go anulowac przy koncu walki. */
  _timerAtaku(fn, ms) {
    const id = setTimeout(() => {
      this._timeryAtakow = this._timeryAtakow.filter((t) => t !== id);
      if (this.state !== 'FIGHT') return;
      fn();
    }, ms);
    this._timeryAtakow.push(id);
  }

  /**
   * Atak obszarowy: boss oznacza JEDNO pole, po chwili pluje na nie pociskiem,
   * a w momencie uderzenia omdlewa kazdego, kto na tym polu stoi.
   */
  _startVomitAttack() {
    if (this.state !== 'FIGHT' || !this.model) return;
    const cel = this._wybierzPoleAtaku();

    this.fx.oznaczPole(cel.x, cel.z, 0x86c232, VOMIT_OSTRZEZENIE + VOMIT_LOT);
    this._log('bad', `Boss bierze na cel pole [${cel.x}, ${cel.z}]`, { pole: [cel.x, cel.z] });
    showBossNotification(
      'faint',
      '🤢 BOSS CELUJE W POLE!',
      `Pole <strong>[${cel.x}, ${cel.z}]</strong> - kto na nim stoi, zaraz zemdleje! Uciekaj komendą ruchu!`,
    );

    this._timerAtaku(() => {
      // Pochylenie do przodu - najblizszy "wymiotom" klip w rigu Kenneya.
      this._ustawPoze('wymioty', 1.25);
      const start = this.model.position.clone();
      start.y += 1.7;
      this.fx.wystrzelPocisk(start, cel.x, cel.z, VOMIT_LOT, () => this._onVomitImpact(cel.x, cel.z));
    }, VOMIT_OSTRZEZENIE * 1000);
  }

  _onVomitImpact(x, z) {
    this.fx.rozlejKaluze(x, z, 0x86c232, 7);
    const trafieni = this._workersOnTile(x, z);
    if (trafieni.length === 0) {
      this._log('good', `Pocisk spadl na puste pole [${x}, ${z}] - nikt nie ucierpial`);
      showBossNotification('help', '💨 PUDŁO!', `Pole <strong>[${x}, ${z}]</strong> było puste - nikt nie zemdlał.`);
      return;
    }
    audio.play('omdlenie');
    for (const entry of trafieni) {
      const nick = this._userForWorker(entry);
      if (nick) this._faintUser(nick);
    }
  }

  /**
   * Kara za brak odpowiedzi: boss wyciaga wyrzutnik, strzela w gore, a po
   * chwili na 10 oznaczonych pol spadaja rakiety. Ginie ten, kto na nich stoi.
   * Wzory pol sa STALE i cyklicznie powtarzane - zadnego losowania.
   */
  _startRocketStrike() {
    if (this.state !== 'FIGHT') return;
    const wzor = WZORY_RAKIET[this._wzorRakiet % WZORY_RAKIET.length];
    this._wzorRakiet += 1;

    this._zalozBron();
    this._ustawPoze('strzal', 1.5);
    audio.play('boss-zabija');

    for (const [x, z] of wzor) {
      this.fx.oznaczPole(x, z, 0xff3b30, RAKIETY_OSTRZEZENIE + RAKIETY_LOT);
    }
    this._log('bad', `Ostrzal rakietowy - wzor ${(this._wzorRakiet - 1) % WZORY_RAKIET.length}`, { pola: wzor });
    showBossNotification(
      'kill',
      '🚀 OSTRZAŁ RAKIETOWY!',
      `Brak odpowiedzi! Za chwilę na <strong>${RAKIET_NA_SALWE}</strong> oznaczonych pól spadną rakiety - UCIEKAJCIE!`,
    );

    this._timerAtaku(() => {
      wzor.forEach(([x, z], i) => {
        this.fx.zrzucRakiete(x, z, RAKIETY_LOT + i * 0.03, () => this._onRocketImpact(x, z));
      });
      this._zdejmijBron();
    }, RAKIETY_OSTRZEZENIE * 1000);
  }

  _onRocketImpact(x, z) {
    this.fx.wybuch(x, z);
    this._camShakeT = Math.max(this._camShakeT || 0, 0.22);
    const trafieni = this._workersOnTile(x, z);
    for (const entry of trafieni) {
      const nick = this._userForWorker(entry);
      if (nick) this._killUser(nick);
    }
  }

  /** Doczepia wyrzutnik do kosci prawej reki bossa (rig Kenneya: 'arm-right'). */
  _zalozBron() {
    if (this.bronObj || !this.charObj) return;
    const bron = this.fx.stworzBron();
    if (!bron) return;
    const reka = this.charObj.getObjectByName('arm-right');
    if (!reka) {
      this._log('info', 'Nie znaleziono kosci arm-right - salwa bez modelu broni');
      return;
    }
    // blaster-e ma 1.64 j. dlugosci przy postaci wysokiej 0.77 - bez zmniejszenia
    // wyrzutnik bylby dwa razy wyzszy od samego bossa.
    bron.scale.setScalar(0.45);
    bron.position.set(0.05, -0.2, 0.05);
    bron.rotation.set(-Math.PI / 2.4, 0, 0);
    reka.add(bron);
    this.bronObj = bron;
  }

  _zdejmijBron() {
    if (!this.bronObj) return;
    if (this.bronObj.parent) this.bronObj.parent.remove(this.bronObj);
    this.bronObj = null;
  }

  // ================= OMDLENIA =================

  /** Omdlewa KONKRETNEGO widza - wolane, gdy pocisk trafi w pole, na ktorym stoi. */
  _faintUser(username) {
    if (!username) return;
    const key = normalizeNick(username);
    if (this.faintedMap.has(key)) return;
    const workerIndex = this.kickChat ? this.kickChat.getWorkerForUser(username) : null;

    this.faintedMap.set(key, { username, slot: workerIndex, ts: Date.now() });

    audio.play('omdlenie');
    if (workerIndex !== null && this.workerManager) {
      this.workerManager.setFainted(workerIndex, true);
    }

    showBossNotification(
      'faint',
      `💤 @${username} OMDLAŁ!`,
      `Boss go powalił! Ktoś inny musi napisać <strong>pomoc</strong> na czacie, żeby go podnieść!`,
    );
    this._log('info', `@${username} omdlal - napisz "pomoc" na czacie, zeby go podniesc`, { ofiara: username });

    this._refreshFaintedNameplate(workerIndex, true);
  }

  /** Publiczna metoda testowa - natychmiastowy atak na pole (patrz README/debug). */
  faintRandom() {
    if (this.state !== 'FIGHT') return false;
    this._startVomitAttack();
    return true;
  }

  /** Publiczna metoda testowa - natychmiastowa salwa rakiet (patrz README/debug). */
  rocketStrike() {
    if (this.state !== 'FIGHT') return false;
    this._startRocketStrike();
    return true;
  }

  isFainted(username) {
    if (!username || this.state !== 'FIGHT') return false;
    const key = normalizeNick(username);
    return this.faintedMap.has(key);
  }

  isFaintedForSlot(slot) {
    if (this.state !== 'FIGHT') return false;
    const target = Number(slot);
    for (const info of this.faintedMap.values()) {
      if (Number(info.slot) === target) return true;
    }
    return false;
  }

  _refreshFaintedNameplate(workerIndex, fainted) {
    if (workerIndex === null || workerIndex === undefined) return;
    if (this.workerOverlays) this.workerOverlays.setFainted(workerIndex, fainted);
  }

  _tryHelp(rescuerUsername, color) {
    if (this.faintedMap.size === 0) return;
    const rescuerKey = normalizeNick(rescuerUsername);
    // Omdlony gracz nie może nikogo ratować, dopóki sam leży
    if (this.faintedMap.has(rescuerKey)) return;

    // Nie mozna podniesc samego siebie
    let oldestKey = null;
    let oldestTs = Infinity;
    for (const [key, info] of this.faintedMap) {
      if (key === rescuerKey) continue;
      if (info.ts < oldestTs) {
        oldestTs = info.ts;
        oldestKey = key;
      }
    }
    // Brak innych graczy do podniesienia (nie można podnieść samego siebie)
    if (!oldestKey) return;

    const info = this.faintedMap.get(oldestKey);
    this.faintedMap.delete(oldestKey);

    audio.play('ratunek');
    if (info.slot !== null && info.slot !== undefined && this.workerManager) {
      this.workerManager.setFainted(info.slot, false);
      this._refreshFaintedNameplate(info.slot, false);

      const entry = this.workerManager.getWorkerType(info.slot);
      if (entry && entry.obj) {
        const origin = entry.obj.position.clone().add(new THREE.Vector3(0, 1.6, 0));
        this.projectAndFloat(origin, `🤝 @${rescuerUsername} podniósł @${info.username}!`, { gold: true });
      }
    }

    showBossNotification(
      'help',
      `🤝 RATUNEK!`,
      `<strong>@${rescuerUsername}</strong> podniósł <strong>@${info.username}</strong>!`,
    );
    this._log('good', `@${rescuerUsername} podnosi omdlalego @${info.username}`, {
      ratownik: rescuerUsername,
      ofiara: info.username,
    });
  }

  /**
   * Wywolywane co klatke walki (patrz _updateFight): budzi kazdego, kto lezy
   * omdlony >= FAINT_AUTO_WAKE_SEC bez ratunku od innego widza. To jedyna
   * siatka bezpieczenstwa na sytuacje "nikt nieomdlony nie moze napisac
   * pomoc" (patrz komentarz przy stalej) - w normalnym przebiegu walki
   * zwykly ratunek (_tryHelp) zdazy zadzialac dawno przed uplywem limitu.
   * Budzi wszystkich zaleglych na raz (nie tylko najstarszego, jak _tryHelp) -
   * jesli limit minal kilku naraz (np. dwoch trafionych tym samym pociskiem),
   * nie ma powodu budzic ich jeden po drugim klatka po klatce.
   */
  _checkAutoWake() {
    if (this.faintedMap.size === 0) return;
    const teraz = Date.now();
    for (const [key, info] of [...this.faintedMap]) {
      if (teraz - info.ts < FAINT_AUTO_WAKE_SEC * 1000) continue;
      this.faintedMap.delete(key);
      audio.play('ratunek');
      if (info.slot !== null && info.slot !== undefined && this.workerManager) {
        this.workerManager.setFainted(info.slot, false);
        this._refreshFaintedNameplate(info.slot, false);
      }
      showBossNotification(
        'help',
        '⏱️ OCKNĄŁ SIĘ SAM!',
        `<strong>@${info.username}</strong> leżał zbyt długo bez pomocy (${FAINT_AUTO_WAKE_SEC}s) i ocknął się sam.`,
      );
      this._log('good', `@${info.username} ocknal sie sam po ${FAINT_AUTO_WAKE_SEC}s bez ratunku (zabezpieczenie przed zakleszczeniem)`, {
        ofiara: info.username,
      });
    }
  }

  _wakeAllFainted() {
    for (const [key, info] of this.faintedMap) {
      if (info.slot !== null && info.slot !== undefined && this.workerManager) {
        this.workerManager.setFainted(info.slot, false);
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
    audio.play('boss-pokonany');
    this._log('spawn', `Boss "${this.def.name}" pokonany!`);
    this.state = 'VICTORY';
    this.currentEq = null;
    this.interDelay = 0;
    if (this.bubbleEl) this.bubbleEl.style.display = 'none';
    if (this.overloadWrapEl) this.overloadWrapEl.style.display = 'none';
    if (this.dymekEl) this.dymekEl.style.display = 'none';

    if (this.def && this.def.mechanika === 'kowal') {
      // Kowal stoi (nie siedzi w wozku) - standardowy klip "die" z rigu
      // Kenneya pasuje tu wprost, bez recznej pozy na kosciach.
      if (this.kowal) this.kowal.playAction('die', { hard: true, once: true });
      this._victoryT = 0;
      showBossNotification(
        'boss',
        '🏆 KOWAL_88 POKONANY!',
        'Czat okrążył i powalił Kowala! Bankomat wraca na nowym tierze.',
      );
      return;
    }

    if (this.def && this.def.mechanika === 'blackjack') {
      // Dzordzo stoi (nie siedzi w wozku) - standardowy klip "die" pasuje
      // tu wprost, tak samo jak u Kowala.
      if (this.blackjack) this.blackjack.playAction('die', { hard: true, once: true });
      this._victoryT = 0;
      if (this.bjPanelEl) this.bjPanelEl.classList.remove('show');
      showBossNotification(
        'boss',
        '🏆 DŻORDŻO POKONANY!',
        'Czat wygrał 3 rozdania blackjacka! Bankomat wraca na nowym tierze.',
      );
      return;
    }

    // Boss siedzi w wozku - klip "die" (dla postaci stojacej) wygladal tu zle.
    // Zamiast niego bezwladne osuniecie sie w fotelu na kosciach.
    this.playAction('wheelchair-sit', { hard: true });
    this._ustawPoze('smierc', 0);
    this._victoryT = 0;

    this._wakeAllFainted();

    showBossNotification(
      'boss',
      '🏆 KAMIL KOVALENKO POKONANY!',
      'Czat powalił bossa! Bankomat wraca na nowym tierze.',
    );
  }

  _updateVictory(delta) {
    // Kowal_88 trzyma wlasny mixer w BossKowal (this.mixer tutaj zostaje null,
    // patrz start()) - bez tego klip "die" odegralby sie tylko na pierwszej
    // klatce i zamarl, bo nic wiecej nie wolaloby mixer.update() w tym stanie.
    if (this.def && this.def.mechanika === 'kowal' && this.kowal && this.kowal.mixer) {
      this.kowal.mixer.update(delta);
    }
    if (this.def && this.def.mechanika === 'blackjack' && this.blackjack && this.blackjack.mixer) {
      this.blackjack.mixer.update(delta);
    }
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
      this.machine.model.position.z = 0;
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
    for (const id of this._timeryAtakow) clearTimeout(id);
    this._timeryAtakow = [];
    this._zdejmijBron();
    this.fx.clear();
    if (this.kowal) {
      this.kowal.teardown();
      this.kowal = null;
    }
    if (this.blackjack) {
      this.blackjack.teardown();
      this.blackjack = null;
    }
    if (this.bjPanelEl) this.bjPanelEl.classList.remove('show');
    if (this.model) {
      this.scene.remove(this.model);
      this.model = null;
    }
    this.mixer = null;
    this.currentAction = null;
    this.charObj = null;

    if (this.machine && this.machine.model) {
      this.machine.model.rotation.z = 0;
      this.machine.model.position.x = 0;
      this.machine.model.position.y = 0;
      this.machine.model.position.z = 0;
    }

    this.state = 'IDLE';
    this.currentEq = null;
    this.interDelay = 0;
    this.hp = 0;
    this.startWalki = null;

    if (this.nameplateEl) this.nameplateEl.style.display = 'none';
    if (this.bubbleEl) this.bubbleEl.style.display = 'none';
    if (this.overloadWrapEl) this.overloadWrapEl.style.display = 'none';
    if (this.dymekEl) this.dymekEl.style.display = 'none';
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

    this.model.getWorldPosition(this._headWorld);
    // Offset punktu rzutowania - trzyma zintegrowany pasek idealnie nad głową bossa
    this._headWorld.y += 1.85;

    this._projected.copy(this._headWorld).project(camera);

    if (this._projected.z >= 1.0) {
      this.nameplateEl.style.display = 'none';
      if (this.dymekEl) this.dymekEl.style.display = 'none';
      return;
    }

    let sx = canvasRect.left + (this._projected.x * 0.5 + 0.5) * canvasRect.width;
    let sy = canvasRect.top + (-this._projected.y * 0.5 + 0.5) * canvasRect.height;

    // Klamrowanie do wnętrza canvasa z marginesem - zintegrowany pasek ma ~110px wysokości,
    // więc TOP_MARGIN = 125 gwarantuje, że pasek z nazwą i HP nigdy nie zostanie ucięty u góry ekranu.
    const H_MARGIN = 130;
    const TOP_MARGIN = 125;
    const BOTTOM_MARGIN = 20;
    const minX = canvasRect.left + H_MARGIN;
    const maxX = canvasRect.left + Math.max(H_MARGIN, canvasRect.width - H_MARGIN);
    const minY = canvasRect.top + TOP_MARGIN;
    const maxY = canvasRect.top + Math.max(TOP_MARGIN, canvasRect.height - BOTTOM_MARGIN);
    sx = Math.min(maxX, Math.max(minX, sx));
    sy = Math.min(maxY, Math.max(minY, sy));

    this.nameplateEl.style.display = 'flex';
    this.nameplateEl.style.left = `${sx}px`;
    this.nameplateEl.style.top = `${sy}px`;

    // Zintegrowana sekcja działania wewnątrz paska bossa
    if (this.equationSectionEl) {
      const showEq = this.state === 'FIGHT' && this.currentEq && this.interDelay <= 0;
      this.equationSectionEl.style.display = showEq ? 'flex' : 'none';
    }

    // Dymek Kowala_88 - nad plakietka (ten sam ekranowy punkt sx/sy, tylko
    // wyzej o stala wartosc - prostsze i rownie stabilne niz osobne
    // rzutowanie 3D->2D drugiego punktu swiata).
    if (this.dymekEl) {
      const pokazDymek = this.def && this.def.mechanika === 'kowal'
        && this.state === 'FIGHT' && this.kowal && this.kowal.dymekTekst;
      if (pokazDymek) {
        this.dymekEl.textContent = this.kowal.dymekTekst;
        this.dymekEl.style.left = `${sx}px`;
        this.dymekEl.style.top = `${sy - 92}px`;
        this.dymekEl.style.display = 'block';
      } else {
        this.dymekEl.style.display = 'none';
      }
    }
  }

  // ================= SYNCHRONIZACJA STANU (widz dolaczajacy w trakcie walki) =================

  /** Wyliczenie biezacego rownania ze wspolnego strumienia - patrz applySync. */
  _recalcCurrentEquation() {
    this.currentEq = genEquation(this._rownanieRng(this.licznikRownan));
    if (this.eqTextEl) this.eqTextEl.textContent = this.currentEq.text;
  }

  /** Wycinek stanu wysylany na serwer (patrz zbierzStan w main.js). */
  getSyncState() {
    const stan = {
      aktywny: this.state === 'CUTSCENE' || this.state === 'FIGHT' || this.state === 'VICTORY',
      tier: this.pendingTier,
      hp: this.hp,
      licznikRownan: this.licznikRownan,
      licznikAtakow: this.licznikAtakow,
      startWalki: this.startWalki,
    };
    if (this.def && this.def.mechanika === 'kowal' && this.kowal) {
      stan.kowal = this.kowal.getSyncState();
    }
    if (this.def && this.def.mechanika === 'blackjack' && this.blackjack) {
      stan.blackjack = this.blackjack.getSyncState();
    }
    return stan;
  }

  /**
   * Wyrownuje lokalny stan walki do tego, co przyszlo z serwera (widz, patrz
   * synchronizujZSerwera w main.js) - admin NIGDY tego nie woluje, bo to on
   * prowadzi walke naprawde, a to by ja nadpisalo jego wlasnym echem.
   */
  applySync(bossState) {
    if (!bossState) return;
    const localActive = this.isActive();

    if (bossState.aktywny && !localActive) {
      this.startFromSync(bossState);
      return;
    }
    if (!bossState.aktywny && localActive) {
      this._teardown();
      return;
    }
    if (bossState.aktywny && localActive) {
      if (typeof bossState.hp === 'number') {
        this.hp = bossState.hp;
        if (this.hpFillEl) this.hpFillEl.style.width = `${(this.hp / this.maxHp) * 100}%`;
        if (this.hpTextEl) this.hpTextEl.textContent = `${this.hp} / ${this.maxHp}`;
      }
      if (this.def && this.def.mechanika === 'kowal') {
        if (this.kowal && bossState.kowal) this.kowal.applySync(bossState.kowal);
        return;
      }
      if (this.def && this.def.mechanika === 'blackjack') {
        if (this.blackjack && bossState.blackjack) this.blackjack.applySync(bossState.blackjack);
        return;
      }

      const rownanieZmienione = bossState.licznikRownan !== undefined && bossState.licznikRownan !== this.licznikRownan;
      if (bossState.licznikRownan !== undefined) this.licznikRownan = bossState.licznikRownan;
      if (bossState.licznikAtakow !== undefined) this.licznikAtakow = bossState.licznikAtakow;
      // Wyrownanie licznika rownan samo w sobie NIE zmienia this.currentEq -
      // trzeba je jawnie przeliczyc ze wspolnego strumienia, inaczej widz
      // dalej widzialby swoje wlasne, lokalnie wygenerowane dzialanie.
      if (rownanieZmienione && this.state === 'FIGHT' && this.interDelay <= 0) {
        this._recalcCurrentEquation();
      }
    }
  }

  /**
   * Widz dolaczajacy do gry w trakcie walki dostaje ja od razu, BEZ cutscenki -
   * boss staje w finalnej pozycji z bankomatem juz przechylonym, hp i licznikami
   * wziete wprost ze stanu serwera, a biezace rownanie przeliczone ze wspolnego
   * strumienia (patrz _recalcCurrentEquation), wiec od pierwszej klatki widz
   * widzi TO SAMO dzialanie co reszta.
   */
  startFromSync(bossState) {
    const tier = bossState.tier;
    const def = BOSS_DEFS[tier];
    if (!def) return false;
    if (this.state !== 'IDLE') this._teardown();

    if (def.mechanika === 'kowal') {
      if (!this.orcTemplate) {
        this._log('bad', 'Nie moge dolaczyc do walki (sync) - model Kowala_88 jeszcze sie nie zaladowal');
        return false;
      }
    } else if (def.mechanika === 'blackjack') {
      if (!this.blackjackTemplate) {
        this._log('bad', 'Nie moge dolaczyc do walki (sync) - model Dzordzo jeszcze sie nie zaladowal');
        return false;
      }
    } else if (!this.chairTemplate || !this.charTemplate) {
      this._log('bad', 'Nie moge dolaczyc do walki (sync) - model bossa jeszcze sie nie zaladowal');
      return false;
    }
    if (this.vanessaRef && this.vanessaRef.model) this.vanessaRef.despawn();

    this._runId += 1;
    this.pendingTier = tier;
    this.def = def;
    this.maxHp = def.hp || 100;
    this.hp = typeof bossState.hp === 'number' ? bossState.hp : this.maxHp;
    this.licznikRownan = bossState.licznikRownan || 0;
    this.licznikAtakow = bossState.licznikAtakow || 0;
    this.startWalki = bossState.startWalki || Date.now();
    this.faintedMap.clear();
    this.faintTimer = this._randomFaintDelay();

    this._log('info', `Dolaczam do trwajacej walki z bossem "${def.name}" (sync, bez cutscenki)`, bossState);

    if (this.nameRowEl) this.nameRowEl.textContent = `👹 ${def.name}`;

    if (def.mechanika === 'kowal') {
      this.kowal = new BossKowal(this);
      this.blackjack = null;
      this.model = this.kowal.build();
      this.mixer = null;
      this.kowal.startFromSync(bossState.kowal);

      this.state = 'FIGHT';
      if (this.nameplateEl) this.nameplateEl.style.display = 'flex';
      if (this.overloadWrapEl) {
        this.overloadWrapEl.style.display = 'block';
        this.overloadFillEl.style.width = `${this.kowal.przeciazenie}%`;
      }
      if (this.hpFillEl) this.hpFillEl.style.width = `${(this.hp / this.maxHp) * 100}%`;
      if (this.hpTextEl) this.hpTextEl.textContent = `${this.hp} / ${this.maxHp}`;
      return true;
    }

    if (def.mechanika === 'blackjack') {
      this.kowal = null;
      this.blackjack = new BossBlackjack(this);
      this.model = this.blackjack.build();
      this.mixer = null;
      this.blackjack.startFromSync(bossState.blackjack);

      this.state = 'FIGHT';
      if (this.nameplateEl) this.nameplateEl.style.display = 'flex';
      if (this.overloadWrapEl) this.overloadWrapEl.style.display = 'none';
      if (this.hpFillEl) this.hpFillEl.style.width = `${(this.hp / this.maxHp) * 100}%`;
      if (this.hpTextEl) this.hpTextEl.textContent = `${this.hp} / ${this.maxHp}`;
      return true;
    }

    this.kowal = null;
    this.blackjack = null;
    this._buildModel();
    if (this.machine.model) {
      this.machine.model.rotation.z = 0.35;
      this.machine.model.position.x = -0.12;
      this.machine.model.position.y = -0.04;
      this.machine.model.position.z = 0.28;
    }
    this.model.position.copy(FINAL_POS);
    this.model.lookAt(this.model.position.x, this.model.position.y, this.model.position.z + 10);
    this.playAction('wheelchair-sit', { hard: true });

    this.state = 'FIGHT';
    if (this.nameplateEl) this.nameplateEl.style.display = 'flex';
    if (this.overloadWrapEl) this.overloadWrapEl.style.display = 'none';
    if (this.hpFillEl) this.hpFillEl.style.width = `${(this.hp / this.maxHp) * 100}%`;
    if (this.hpTextEl) this.hpTextEl.textContent = `${this.hp} / ${this.maxHp}`;

    this._recalcCurrentEquation();
    this.eqTimer = ANSWER_WINDOW;
    this.interDelay = 0;
    this._emergencyAnnounced = false;
    this._lastTickSecond = null;
    if (this.bubbleEl) this.bubbleEl.style.display = 'flex';
    if (this.timerFillEl) {
      this.timerFillEl.style.width = '100%';
      this.timerFillEl.classList.remove('danger');
    }

    return true;
  }

  // ================= RESET GRY =================

  reset() {
    this._teardown();
    this.faintedMap.clear();
  }
}
