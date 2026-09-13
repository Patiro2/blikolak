import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { loadArcade } from './assets.js';
import { audio } from './audio.js';
import { getSkinDef } from './skiny.js';
import { arenaHalf } from './arena.js';

/**
 * Rozstrzyga, jaki model/loader/skala nalezy uzyc dla danego slotu: skin z
 * czatu (patrz skiny.js, komenda "!skin"), jesli podany i istnieje w
 * tabeli, w przeciwnym razie domyslny model roli (WORKER_TYPE_DEFS w
 * economy.js) z paczki arcade w skali 1. cacheKey rozroznia szablony w
 * WorkerManager.templates (skin moze miec ta sama nazwe pliku co inny model
 * z innej paczki, stad prefiks).
 */
function resolveSpec(defaultModelKey, skinName) {
  if (skinName) {
    const def = getSkinDef(skinName);
    if (def) {
      return { model: def.model, loader: def.loader, scale: def.scale || 1, cacheKey: `skin:${skinName}`, skin: skinName };
    }
  }
  return { model: defaultModelKey, loader: loadArcade, scale: 1, cacheKey: `rola:${defaultModelKey}`, skin: null };
}

/**
 * Zaokrągla kąt obrotu do najbliższego z 4 kardynalnych kierunków świata:
 * 0 (Południe +Z), π/2 (Wschód +X), π (Północ -Z), -π/2 (Zachód -X).
 */
export function snapToCardinal(angle) {
  const norm = ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const step = Math.PI / 2;
  const idx = Math.round(norm / step) % 4;
  const cardinals = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
  return cardinals[idx];
}

/** Interpoluje kąt obrotu najkrótszą drogą na okręgu. */
export function lerpShortestAngle(start, target, t) {
  let diff = (target - start) % (2 * Math.PI);
  if (diff < -Math.PI) diff += 2 * Math.PI;
  if (diff > Math.PI) diff -= 2 * Math.PI;
  return start + diff * t;
}

/**
 * Rozpoznaje kierunek poruszania się z treści wiadomości czatu.
 * Obsługuje up, down, left, right oraz polskie odpowiedniki góra, dół, lewo, prawo i skróty.
 */
export function parseMovementDirection(text) {
  if (!text || typeof text !== 'string') return null;
  // Usuń ewentualne "klik" / "click" ze słów ruchu
  const clean = text
    .replace(/(?:^|\s)[!/]*klik+[!.,?*~]*(?=\s|$)/gi, ' ')
    .replace(/(?:^|\s)[!/]*click+[!.,?*~]*(?=\s|$)/gi, ' ')
    .trim();

  let t = clean.toLowerCase().replace(/^[!/]+/, '').replace(/[!.,?*~]+$/, '').trim();
  // Znormalizuj polskie znaki do prostego alfabetu
  const norm = t
    .replace(/ą/g, 'a')
    .replace(/ć/g, 'c')
    .replace(/ę/g, 'e')
    .replace(/ł/g, 'l')
    .replace(/ń/g, 'n')
    .replace(/ó/g, 'o')
    .replace(/ś/g, 's')
    .replace(/ź/g, 'z')
    .replace(/ż/g, 'z');

  // W przód (przed siebie / up)
  if (
    norm === 'up' || norm === 'w' || norm === 'gora' || norm === 'gore' ||
    norm === 'w gore' || norm === 'do gory' || norm === 'na gore' ||
    norm === 'idz w gore' || norm === 'krok w gore' || norm === 'ruch w gore' ||
    norm === 'przod' || norm === 'w przod' || norm === 'do przodu' ||
    norm === 'idz w przod' || norm === 'krok w przod' || norm === 'forward' || norm === 'prosto'
  ) {
    return 'up';
  }

  // W tył (za siebie / down)
  if (
    norm === 'down' || norm === 's' || norm === 'dol' ||
    norm === 'w dol' || norm === 'do dolu' || norm === 'na dol' ||
    norm === 'idz w dol' || norm === 'krok w dol' || norm === 'ruch w dol' ||
    norm === 'tyl' || norm === 'w tyl' || norm === 'do tylu' ||
    norm === 'idz w tyl' || norm === 'krok w tyl' || norm === 'back' || norm === 'cofnij'
  ) {
    return 'down';
  }

  // W lewo (względem gracza / left)
  if (
    norm === 'left' || norm === 'lewo' || norm === 'lewa' || norm === 'a' ||
    norm === 'w lewo' || norm === 'w lewa' || norm === 'do lewej' || norm === 'na lewo' ||
    norm === 'idz w lewo' || norm === 'krok w lewo' || norm === 'ruch w lewo' ||
    norm === 'skrec w lewo'
  ) {
    return 'left';
  }

  // W prawo (względem gracza / right)
  if (
    norm === 'right' || norm === 'prawo' || norm === 'prawa' || norm === 'd' ||
    norm === 'w prawo' || norm === 'w prawa' || norm === 'do prawej' || norm === 'na prawo' ||
    norm === 'idz w prawo' || norm === 'krok w prawo' || norm === 'ruch w prawo' ||
    norm === 'skrec w prawo'
  ) {
    return 'right';
  }

  // Skos do przodu w lewo / w prawo (względem aktualnego zwrotu postaci)
  if (norm === 'q') return 'diag-left';
  if (norm === 'e') return 'diag-right';

  // Skos do tyłu w lewo / w prawo (względem aktualnego zwrotu postaci)
  if (norm === 'z') return 'diag-back-left';
  if (norm === 'c') return 'diag-back-right';

  return null;
}

/**
 * Rozpoznaje kombinację ruchów z treści wiadomości czatu: pojedynczą komendę
 * (jak parseMovementDirection, zwrócona jako tablica 1-elementowa) albo krótki
 * ciąg liter w/a/s/d (2-5 znaków, po tej samej normalizacji - trim, lowercase,
 * prefiks !//, końcowa interpunkcja), np. "wd" -> ['up','right']. Dłuższe
 * ciągi (>5) to zwykła wiadomość, nic się nie dzieje - zwraca null.
 */
export function parseMovementCombo(text) {
  const single = parseMovementDirection(text);
  if (single) return [single];

  if (!text || typeof text !== 'string') return null;
  const clean = text
    .replace(/(?:^|\s)[!/]*klik+[!.,?*~]*(?=\s|$)/gi, ' ')
    .replace(/(?:^|\s)[!/]*click+[!.,?*~]*(?=\s|$)/gi, ' ')
    .trim();
  const t = clean.toLowerCase().replace(/^[!/]+/, '').replace(/[!.,?*~]+$/, '').trim();

  if (!/^[wasdqezc]{2,5}$/.test(t)) return null;

  const map = {
    w: 'up', s: 'down', a: 'left', d: 'right',
    q: 'diag-left', e: 'diag-right',
    z: 'diag-back-left', c: 'diag-back-right',
  };
  return t.split('').map((c) => map[c]);
}

/**
 * Bezpieczny powrot dowolnej akcji do animacji spoczynku.
 *
 * crossFadeTo() TYLKO rozpisuje rampy wag - NIE uruchamia akcji docelowej.
 * Gdy idle bylo wczesniej wygaszone do zera i zatrzymane (a tak robi kazde
 * przejscie do chodu czy do uderzenia w bankomat), przejscie z powrotem
 * prowadzilo donikad: obie akcje konczyly z waga 0 i zatrzymane, mikser nie
 * mial czego nakladac, a szkielet wracal do pozy spoczynkowej rigu - czyli
 * postac stawala w T-pozie. Dlatego idle jest tu jawnie wznawiane i dostaje
 * pelna wage PRZED rozpoczeciem przejscia.
 */
function wrocDoIdle(entry, zAkcji, czas = 0.2) {
  if (!entry || !entry.idleAction) return;
  entry.idleAction.enabled = true;
  entry.idleAction.setEffectiveTimeScale(1);
  entry.idleAction.setEffectiveWeight(1);
  entry.idleAction.play();
  if (zAkcji && zAkcji !== entry.idleAction) {
    zAkcji.crossFadeTo(entry.idleAction, czas, false);
  }
}

export class WorkerManager {
  constructor(scene) {
    this.scene = scene;
    this.entries = [];
    this.templates = new Map();
    this.pending = new Map(); // typeIndex -> Promise<Entry>
    this.bossRef = null;
    this.vanessaRef = null;
    this.flagBattleRef = null;
    this.tlumaczeniaRef = null;
    this.panstwaMiastaRef = null;
    this.bitwaMarekRef = null;
    this.economyRef = null;
  }

  setContext({ boss, vanessa, flagBattle, tlumaczenia, panstwaMiasta, bitwaMarek, economy }) {
    this.bossRef = boss;
    this.vanessaRef = vanessa;
    this.flagBattleRef = flagBattle;
    this.tlumaczeniaRef = tlumaczenia;
    this.panstwaMiastaRef = panstwaMiasta;
    this.bitwaMarekRef = bitwaMarek;
    this.economyRef = economy || this.economyRef;
  }

  async _getTemplate(spec) {
    if (this.templates.has(spec.cacheKey)) return this.templates.get(spec.cacheKey);
    const gltf = await spec.loader(spec.model);
    this.templates.set(spec.cacheKey, gltf);
    return gltf;
  }

  /**
   * (Zbudowuje na nowo albo podmienia) reprezentacje wizualna wpisu: model
   * (SkeletonUtils.clone opakowany w entry.obj - Group-wrapper, ktory niesie
   * pozycje/rotacje/siatke i NIE jest ruszany przy podmianie skina), mixer i
   * akcje idle/walk/interact-right. Uzywane zarowno przy pierwszym tworzeniu
   * pracownika, jak i przy zmianie skina komenda "!skin" (patrz addWorkerType) -
   * DRY, zeby obie sciezki mialy dokladnie te sama logike wiazania animacji.
   *
   * Skala idzie na SAM MODEL (dziecko wrappera), nie na entry.obj - dzieki
   * temu skalowanie (np. blocky-characters, patrz skiny.js) nie wplywa na
   * pozycje/ruch liczony na entry.obj gdzie indziej w tym pliku.
   */
  async _applyVisual(entry, spec) {
    const gltf = await this._getTemplate(spec);

    const model = SkeletonUtils.clone(gltf.scene);
    model.scale.setScalar(spec.scale || 1);
    model.traverse((child) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });

    if (entry.model) entry.obj.remove(entry.model);
    entry.obj.add(model);
    entry.model = model;
    entry.cacheKey = spec.cacheKey;
    entry.skin = spec.skin;
    entry.gltfAnimations = gltf.animations;
    entry.attackActions = {};
    entry._aktywnaAkcjaAtaku = null;
    entry.playingInteract = false;
    entry.dieAction = null;

    const mixer = new THREE.AnimationMixer(model);
    entry.mixer = mixer;

    const idleClip = THREE.AnimationClip.findByName(gltf.animations, 'idle');
    const walkClip = THREE.AnimationClip.findByName(gltf.animations, 'walk');
    const interactClip = THREE.AnimationClip.findByName(gltf.animations, 'interact-right');

    entry.idleAction = idleClip ? mixer.clipAction(idleClip) : null;
    entry.walkAction = walkClip ? mixer.clipAction(walkClip) : null;
    entry.interactAction = interactClip ? mixer.clipAction(interactClip) : null;

    if (entry.walkAction) entry.walkAction.setLoop(THREE.LoopRepeat);
    if (entry.interactAction) {
      entry.interactAction.setLoop(THREE.LoopOnce);
      entry.interactAction.clampWhenFinished = true;
    }

    this._wireMixerFinished(entry);

    if (entry.isFainted) {
      // ponytail: przy zmianie skina w trakcie omdlenia nowy model odgrywa
      // animacje upadku od nowa (nie da sie "wskoczyc" w polowe cudzego
      // klipu die) - kosmetyczny szczegol, do poprawy jesli razi na streamie.
      this.playDeath(entry.typeIndex);
    } else if (entry.idleAction) {
      entry.idleAction.play();
    }
  }

  /** Podpina wspolny listener 'finished' pod mixer wpisu - patrz _applyVisual. */
  _wireMixerFinished(entry) {
    entry.mixer.addEventListener('finished', (e) => {
      if (entry.interactAction && e.action === entry.interactAction) {
        entry.playingInteract = false;
        if (entry.idleAction && !entry.isFainted && !entry.isMoving) {
          // idle MUSI byc wznowione przed przejsciem - patrz wrocDoIdle.
          wrocDoIdle(entry, entry.interactAction, 0.3);
        }
      } else if (entry._aktywnaAkcjaAtaku && e.action === entry._aktywnaAkcjaAtaku) {
        const akcja = entry._aktywnaAkcjaAtaku;
        entry._aktywnaAkcjaAtaku = null;
        entry.playingInteract = false;
        if (entry.idleAction && !entry.isFainted && !entry.isMoving) {
          wrocDoIdle(entry, akcja, 0.25);
        }
      }
    });
  }

  _circlePosition(typeIndex) {
    // Dyrektor oddziału (typ 9) stoi najbliżej bankomatu (promień ~0.85, z przodu po prawej)
    if (Number(typeIndex) === 9) {
      const x = 0.58;
      const z = 0.64;
      const rotY = Math.atan2(-x, -z);
      return { x, z, rotY };
    }

    // Wszyscy pozostali pracownicy (0..8) ustawieni są w pełnym kółku wokół bankomatu
    const count = 9;
    const radius = 1.75;
    // Przesunięcie o 20 stopni (Math.PI / count), aby zostawić otwarty widok na bankomat od strony kamery
    const offset = Math.PI / count;
    const theta = (Number(typeIndex) % count) * (2 * Math.PI / count) + offset;

    const x = Math.sin(theta) * radius;
    const z = Math.cos(theta) * radius;
    // Każdy pracownik obraca się twarzą prosto w stronę bankomatu w centrum (0, 0, 0)
    const rotY = Math.atan2(-x, -z);
    return { x, z, rotY };
  }

  hasWorkerType(typeIndex) {
    if (typeIndex === null || typeIndex === undefined) return false;
    const num = Number(typeIndex);
    return this.entries.some((e) => Number(e.typeIndex) === num) || this.pending.has(num);
  }

  getWorkerType(typeIndex) {
    if (typeIndex === null || typeIndex === undefined) return null;
    const num = Number(typeIndex);
    return this.entries.find((e) => Number(e.typeIndex) === num) || null;
  }

  /**
   * Dodaje reprezentanta danego typu pracownika do sceny (dokładnie raz na typ).
   * Zabezpieczone blokadą asynchroniczną (pending Map) przed wielokrotnym tworzeniem
   * modeli przy równoległych zapytaniach oraz automatycznym usuwaniem duplikatów.
   *
   * `skinName` (opcjonalny, z entry.skin rankingu - patrz kick.js komenda
   * "!skin") nadpisuje domyslny model roli (defaultModelKey z WORKER_TYPE_DEFS)
   * - patrz resolveSpec. Gdy juz istniejacy awatar ma inny model niz wynika
   * ze spec (skin sie zmienil), PODMIENIAMY wizualia w miejscu (_applyVisual)
   * zachowujac entry.obj (pozycja/rotacja/siatka) i wszystkie inne pola stanu
   * (isFainted/isMoving/isRobbed/moveQueue) - zaden kod poza workers.js nie
   * musi wiedziec, ze doszlo do podmiany.
   */
  async addWorkerType(typeIndex, defaultModelKey, skinName) {
    typeIndex = Number(typeIndex);
    const spec = resolveSpec(defaultModelKey, skinName);

    // 1. Jeśli model tego typu już istnieje w entries, zwróć go natychmiast
    // (po ewentualnej podmianie wizualiów, jesli skin sie zmienil).
    const existing = this.getWorkerType(typeIndex);
    if (existing) {
      // Jeśli pracownik jest omdlały (np. powalony przez bossa), sprawdzamy czy boss to potwierdza
      if (existing.isFainted) {
        if (this.bossRef && typeof this.bossRef.isFaintedForSlot === 'function' && this.bossRef.isFaintedForSlot(typeIndex)) {
          if (existing.cacheKey !== spec.cacheKey) await this._applyVisual(existing, spec);
          return existing;
        }
        existing.isFainted = false;
      }
      if (existing.cacheKey !== spec.cacheKey) {
        await this._applyVisual(existing, spec);
      } else if (existing.dieAction) {
        existing.dieAction.stop();
        if (existing.idleAction) {
          existing.idleAction.reset().play();
        }
      }
      return existing;
    }

    // 2. Jeśli inne wywołanie asynchroniczne właśnie tworzy ten model, poczekaj na ten sam Promise
    if (this.pending.has(typeIndex)) {
      return await this.pending.get(typeIndex);
    }

    const task = (async () => {
      // Ponowne sprawdzenie po wejściu w asynchroniczny task
      const check1 = this.getWorkerType(typeIndex);
      if (check1) return check1;

      await this._getTemplate(spec);

      // Sprawdzenie po zakończeniu pobierania szablonu
      const check2 = this.getWorkerType(typeIndex);
      if (check2) return check2;

      // Usunięcie ze sceny wszelkich ewentualnych starych/osieroconych modeli o tym typie
      for (let i = this.scene.children.length - 1; i >= 0; i--) {
        const child = this.scene.children[i];
        if (child.userData && child.userData.workerTypeIndex === typeIndex) {
          this.scene.remove(child);
        }
      }

      // Group-wrapper: niesie pozycje/rotacje/siatke, NIE skale (patrz
      // _applyVisual - skala idzie na model, dziecko wrappera). Dzieki temu
      // podmiana skina moze przeskalowac/podmienic model bez ruszania tego,
      // co trzyma stan na siatce areny.
      const obj = new THREE.Group();
      obj.userData = { isWorker: true, workerTypeIndex: typeIndex };

      const pos = this._circlePosition(typeIndex);
      // Promien kolka pracownikow (1.75) nigdy nie siega granicy areny (min. 3)
      // - clamp tu jest czystym zabezpieczeniem, ale i tak czyta aktualny rozmiar.
      const initHalf = this.economyRef ? arenaHalf(this.economyRef) : 3;
      const initGridX = Math.max(-initHalf, Math.min(initHalf, Math.round(pos.x)));
      const initGridZ = Math.max(-initHalf, Math.min(initHalf, Math.round(pos.z)));
      const initFacing = snapToCardinal(pos.rotY);

      obj.position.set(initGridX, 0, initGridZ);
      obj.rotation.y = initFacing;

      this.scene.add(obj);

      const entry = {
        typeIndex,
        cacheKey: null,
        skin: null,
        obj,
        model: null,
        mixer: null,
        idleAction: null,
        walkAction: null,
        interactAction: null,
        dieAction: null,
        // Pelna lista klipow z GLTF (nie tylko idle/walk/interact/die zaladowane
        // nizej) - potrzebna do leniwego wyszukania klipow ataku na zadanie
        // (attack-melee-*/attack-kick-*, patrz triggerAttack nizej). GLTFLoader
        // NIE dopina animacji do obiektu sceny - trzeba ich szukac w gltf.animations
        // po nazwie (tak samo jak idle/walk/interact/die, patrz _applyVisual).
        gltfAnimations: [],
        attackActions: {}, // nazwa klipu -> AnimationAction, budowane na zadanie w triggerAttack
        _aktywnaAkcjaAtaku: null,
        playingInteract: false,
        isFainted: false,
        isRobbed: false,
        animAcc: 0,
        // Siatka 2D i poruszanie się
        gridX: initGridX,
        gridZ: initGridZ,
        facingAngle: initFacing,
        isMoving: false,
        moveQueue: [], // pozostałe kierunki kombinacji czatu (np. "wwd") - patrz queueMoves/_advanceQueue
        moveProgress: 0,
        moveDuration: 0.32,
        startPos: new THREE.Vector3(initGridX, 0, initGridZ),
        targetPos: new THREE.Vector3(initGridX, 0, initGridZ),
        startRotY: initFacing,
        targetRotY: initFacing,
        targetGridX: initGridX,
        targetGridZ: initGridZ,
      };

      await this._applyVisual(entry, spec);

      // Zastąpienie lub dodanie wpisu, usuwając stary obiekt 3D jeśli był inny
      const existingIdx = this.entries.findIndex((e) => e.typeIndex === typeIndex);
      if (existingIdx !== -1) {
        const oldEntry = this.entries[existingIdx];
        if (oldEntry.obj && oldEntry.obj !== obj) {
          this.scene.remove(oldEntry.obj);
        }
        this.entries[existingIdx] = entry;
      } else {
        this.entries.push(entry);
      }

      return entry;
    })();

    this.pending.set(typeIndex, task);
    try {
      return await task;
    } finally {
      this.pending.delete(typeIndex);
    }
  }

  triggerInteract(entry) {
    if (!entry || !entry.interactAction || entry.playingInteract || entry.isFainted || entry.isMoving) return;
    entry.playingInteract = true;
    entry.interactAction.reset();
    entry.interactAction.setEffectiveWeight(1);
    entry.interactAction.play();
    if (entry.idleAction) {
      entry.idleAction.crossFadeTo(entry.interactAction, 0.15, false);
    }
  }

  /**
   * Odtwarza jeden z klipow walki (attack-melee-right/left, attack-kick-right/left
   * - kazda postac w projekcie ma je w swoim wspolnym slowniku klipow, patrz
   * README) na zadanie minigry "Bitwa o flagi" (patrz flagbattle.js). Klip
   * jest szukany leniwie w entry.gltfAnimations i cache'owany w entry.attackActions,
   * dokladnie jak interactAction, ale bez ograniczania sie do jednej z gory
   * ustalonej animacji - stad osobna metoda zamiast rozszerzania triggerInteract.
   *
   * Powrot do idle idzie PRZEZ wrocDoIdle (patrz listener 'finished' w
   * addWorkerType) - crossFadeTo() samo NIE uruchamia akcji docelowej, wiec
   * pominiecie tego zostawia postac w T-pozie po zakonczeniu ciosu.
   *
   * Zwraca true, jesli animacja faktycznie ruszyla (model tego pakietu ma
   * dany klip i postac nie jest akurat zajeta czyms innym), false w
   * przeciwnym razie - wywolujacy moze to bezpiecznie zignorowac (minigra
   * dziala dalej nawet bez animacji, to czysto kosmetyczny dodatek).
   */
  triggerAttack(entry, nazwaKlipu) {
    if (!entry || !entry.mixer || entry.isFainted || entry.isMoving || entry.playingInteract) return false;

    let action = entry.attackActions[nazwaKlipu];
    if (!action) {
      const clip = entry.gltfAnimations && THREE.AnimationClip.findByName(entry.gltfAnimations, nazwaKlipu);
      if (!clip) return false; // ten model akurat nie ma tego klipu - nic sie nie dzieje
      action = entry.mixer.clipAction(clip);
      action.setLoop(THREE.LoopOnce);
      action.clampWhenFinished = true;
      entry.attackActions[nazwaKlipu] = action;
    }

    entry.playingInteract = true; // ta sama flaga co triggerInteract - blokuje nakladajace sie animacje
    entry._aktywnaAkcjaAtaku = action;
    action.reset();
    action.setEffectiveWeight(1);
    action.play();
    if (entry.idleAction) {
      entry.idleAction.crossFadeTo(action, 0.12, false);
    }
    return true;
  }

  /**
   * Zarządza stanem omdlenia pracownika. Omdlały pracownik leży na ziemi
   * i nie wstaje przy klikach czatu ani synchronizacji rankingu.
   */
  setFainted(typeIndex, fainted) {
    typeIndex = Number(typeIndex);
    const entry = this.getWorkerType(typeIndex);
    if (!entry) return;
    entry.isFainted = !!fainted;
    if (fainted) {
      entry.isMoving = false;
      entry.moveQueue.length = 0;
      if (entry.walkAction) entry.walkAction.stop();
      if (entry.obj) entry.obj.position.y = 0;
      this.playDeath(typeIndex);
    } else {
      entry.isFainted = false;
      if (entry.dieAction) entry.dieAction.stop();
      if (entry.idleAction) entry.idleAction.reset().play();
    }
  }

  /**
   * Wykonuje ruch o 1 pole na siatce 2D areny WZGLĘDEM kierunku, w który postać
   * aktualnie patrzy (NIE względem osi świata):
   * - up / forward: krok do przodu, w stronę, w którą postać jest aktualnie zwrócona
   * - down / back: krok do tyłu (obrót o 180° względem aktualnego kierunku i krok)
   * - left: obrót o 90° w lewo względem aktualnego kierunku i krok w tę stronę
   * - right: obrót o 90° w prawo względem aktualnego kierunku i krok w tę stronę
   * Innymi słowy, sterowanie działa jak w grze z widokiem "za plecami postaci" -
   * te same komendy prowadzą w różne strony świata w zależności od tego, gdzie
   * postać akurat jest zwrócona.
   */
  moveWorker(typeIndex, direction) {
    typeIndex = Number(typeIndex);
    const entry = this.getWorkerType(typeIndex);
    if (!entry || !entry.obj) return false;

    // Auto-recovery: jeśli flaga omdlenia wisi na pracowniku, a boss nie potwierdza omdlenia tego slotu, zdejmijmy ją
    if (entry.isFainted) {
      if (this.bossRef && typeof this.bossRef.isFaintedForSlot === 'function' && this.bossRef.isFaintedForSlot(typeIndex)) {
        return false;
      }
      entry.isFainted = false;
    }

    // Auto-recovery: jeśli flaga kradzieży wisi, a Vanessa nie kradnie z tego slotu, zdejmijmy ją
    if (entry.isRobbed) {
      if (this.vanessaRef && typeof this.vanessaRef.isWorkerRobbed === 'function' && this.vanessaRef.isWorkerRobbed(typeIndex)) {
        return false;
      }
      entry.isRobbed = false;
    }

    if (entry.isFainted || entry.isMoving || entry.isRobbed) return false;

    // Bitwa o flagi: dwaj walczacy nie moga sie ruszyc W OGOLE (nawet obrot w
    // miejscu), dopoki ktorys nie wygra - patrz isPlayerLocked() w
    // flagbattle.js po uzasadnienie. To ODREBNA blokada od isTileLocked()
    // nizej (ta chroni pole PRZED WEJSCIEM obcych, nie trzyma samych
    // walczacych) i musi byc sprawdzona PRZED policzeniem docelowego pola,
    // zeby zwrocic false zamiast (jak isTileLocked) "true ale z obrotem".
    if (this.flagBattleRef && typeof this.flagBattleRef.isPlayerLocked === 'function' && this.flagBattleRef.isPlayerLocked(typeIndex)) {
      return false;
    }

    // Bitwa tlumaczen: identyczna blokada i identyczne uzasadnienie co
    // powyzej dla bitwy o flagi (patrz isPlayerLocked() w tlumaczenia.js) -
    // druga minigra na siatce ma dokladnie ten sam wzorzec (dwaj walczacy nie
    // moga sie ruszyc W OGOLE, dopoki ktorys nie wygra), wiec musi byc
    // sprawdzona tym samym sposobem, PRZED policzeniem docelowego pola.
    if (this.tlumaczeniaRef && typeof this.tlumaczeniaRef.isPlayerLocked === 'function' && this.tlumaczeniaRef.isPlayerLocked(typeIndex)) {
      return false;
    }

    // Bitwa panstw-miast: identyczna blokada i identyczne uzasadnienie co
    // powyzej dla flag/tlumaczen - trzecia minigra na siatce ma dokladnie ten
    // sam wzorzec (dwaj walczacy nie moga sie ruszyc, dopoki ktorys nie
    // wygra), wiec musi byc sprawdzona tym samym sposobem.
    if (this.panstwaMiastaRef && typeof this.panstwaMiastaRef.isPlayerLocked === 'function' && this.panstwaMiastaRef.isPlayerLocked(typeIndex)) {
      return false;
    }

    // Bitwa o marki: identyczna blokada i identyczne uzasadnienie co
    // powyzej dla flag/tlumaczen/panstw-miast - czwarta minigra na siatce ma
    // dokladnie ten sam wzorzec (dwaj walczacy nie moga sie ruszyc, dopoki
    // ktorys nie wygra), wiec musi byc sprawdzona tym samym sposobem.
    if (this.bitwaMarekRef && typeof this.bitwaMarekRef.isPlayerLocked === 'function' && this.bitwaMarekRef.isPlayerLocked(typeIndex)) {
      return false;
    }

    // Jeśli była odgrywana animacja uderzenia w bankomat, przerywamy ją natychmiast na rzecz chodu
    if (entry.interactAction && entry.playingInteract) {
      entry.interactAction.stop();
      entry.playingInteract = false;
    }

    // Ruch po skosie (q/e/z/c) NIE zmienia zwrotu postaci - w przeciwienstwie do
    // zwyklych kierunkow ponizej, targetRotY/facingAngle zostaja rowne
    // aktualnemu kierunkowi patrzenia, a przesuniecie to suma wektora "przod"/"tyl"
    // i wektora "lewo"/"prawo" liczonych z tego samego facingAngle (jak w/a/s/d).
    // q/e = skos do przodu (lewo/prawo), z/c = skos do tylu (lewo/prawo) -
    // ta sama zasada, wektor "przod" zamieniony na "tyl" (facingAngle + PI) dla z/c.
    const diagLateralSign = { 'diag-left': 1, 'diag-right': -1, 'diag-back-left': 1, 'diag-back-right': -1 }[direction];
    const diagIsBack = direction === 'diag-back-left' || direction === 'diag-back-right';
    const isDiagonal = diagLateralSign !== undefined;

    let targetHeading;
    let dx, dz;
    if (isDiagonal) {
      const forward = snapToCardinal(entry.facingAngle + (diagIsBack ? Math.PI : 0));
      const lateral = snapToCardinal(entry.facingAngle + diagLateralSign * (Math.PI / 2));
      dx = Math.round(Math.sin(forward)) + Math.round(Math.sin(lateral));
      dz = Math.round(Math.cos(forward)) + Math.round(Math.cos(lateral));
      targetHeading = snapToCardinal(entry.facingAngle); // bez zmiany zwrotu
    } else if (direction === 'up' || direction === 'forward') {
      targetHeading = snapToCardinal(entry.facingAngle); // Krok w przód (w stronę, w którą gracz patrzy)
      dx = Math.round(Math.sin(targetHeading));
      dz = Math.round(Math.cos(targetHeading));
    } else if (direction === 'down' || direction === 'back') {
      targetHeading = snapToCardinal(entry.facingAngle + Math.PI); // Krok w tył (odwrócenie o 180° i krok)
      dx = Math.round(Math.sin(targetHeading));
      dz = Math.round(Math.cos(targetHeading));
    } else if (direction === 'left') {
      targetHeading = snapToCardinal(entry.facingAngle + Math.PI / 2); // Krok w lewo względem gracza (skręt o 90° w lewo i krok)
      dx = Math.round(Math.sin(targetHeading));
      dz = Math.round(Math.cos(targetHeading));
    } else if (direction === 'right') {
      targetHeading = snapToCardinal(entry.facingAngle - Math.PI / 2); // Krok w prawo względem gracza (skręt o 90° w prawo i krok)
      dx = Math.round(Math.sin(targetHeading));
      dz = Math.round(Math.cos(targetHeading));
    } else {
      return false;
    }

    const nextX = entry.gridX + dx;
    const nextZ = entry.gridZ + dz;

    // Granice areny (7x7 albo 9x9 po pokonaniu Skorpiona) - rozmiar CZYTANY
    // W MOMENCIE UZYCIA, patrz arena.js.
    const half = this.economyRef ? arenaHalf(this.economyRef) : 3;
    const inBounds = Math.abs(nextX) <= half && Math.abs(nextZ) <= half;
    // Bankomat w centrum (0, 0) blokuje wejście
    const isATM = nextX === 0 && nextZ === 0;

    let isLockedByFlagBattle = false;
    if (this.flagBattleRef && typeof this.flagBattleRef.isTileLocked === 'function') {
      isLockedByFlagBattle = this.flagBattleRef.isTileLocked(nextX, nextZ, typeIndex);
    }
    // Suma logiczna z blokada pola bitwy tlumaczen - to samo pole nigdy nie
    // moze byc zablokowane przez obie minigry naraz (spawnBattleSquare w
    // flagbattle.js wyklucza kafelek tlumaczen i vice versa), ale sprawdzamy
    // niezaleznie, zeby kazda z minigier chronila wlasny kafelek niezaleznie
    // od drugiej.
    let isLockedByTlumaczenia = false;
    if (this.tlumaczeniaRef && typeof this.tlumaczeniaRef.isTileLocked === 'function') {
      isLockedByTlumaczenia = this.tlumaczeniaRef.isTileLocked(nextX, nextZ, typeIndex);
    }
    // Suma logiczna z blokada pola bitwy panstw-miast - ten sam wzorzec co
    // isLockedByFlagBattle/isLockedByTlumaczenia powyzej.
    let isLockedByPanstwaMiasta = false;
    if (this.panstwaMiastaRef && typeof this.panstwaMiastaRef.isTileLocked === 'function') {
      isLockedByPanstwaMiasta = this.panstwaMiastaRef.isTileLocked(nextX, nextZ, typeIndex);
    }
    // Suma logiczna z blokada pola bitwy o marki - ten sam wzorzec co
    // isLockedByFlagBattle/isLockedByTlumaczenia/isLockedByPanstwaMiasta powyzej.
    let isLockedByBitwaMarek = false;
    if (this.bitwaMarekRef && typeof this.bitwaMarekRef.isTileLocked === 'function') {
      isLockedByBitwaMarek = this.bitwaMarekRef.isTileLocked(nextX, nextZ, typeIndex);
    }

    // Kolizje MIEDZY POSTACIAMI sa celowo WYLACZONE - kilku widzow moze stac
    // na tym samym polu i przechodzic przez siebie, zeby nikt nie blokowal
    // nikomu drogi i cala siatka byla dostepna dla kazdego. Blokuja wylacznie
    // granice areny i pole bankomatu.
    //
    // Konsekwencja do swiadomej akceptacji: postacie na wspolnym polu nachodza
    // na siebie wizualnie, a atak obszarowy bossa (rakiety, omdlenia - patrz
    // _workersOnTile w boss.js) trafia JEDNYM polem we wszystkich, ktorzy na
    // nim stoja, wiec jedna rakieta moze zabic kilka osob naraz.

    entry.startRotY = entry.obj.rotation.y;
    entry.targetRotY = isDiagonal ? entry.startRotY : targetHeading; // skos nie zmienia zwrotu
    entry.facingAngle = isDiagonal ? entry.facingAngle : targetHeading;

    if (!inBounds || isATM || isLockedByFlagBattle || isLockedByTlumaczenia || isLockedByPanstwaMiasta || isLockedByBitwaMarek) {
      // Gracz nie może wyjść poza obszar gry lub wejść w bankomat - przy zwyklym
      // kroku obraca się w wybraną stronę, przy skosie zostaje w miejscu bez obrotu
      entry.isMoving = true;
      entry.moveProgress = 0;
      entry.moveDuration = 0.16; // krótki obrót w miejscu (lub "drgnięcie" bez obrotu dla skosu)
      entry.startPos.copy(entry.obj.position);
      entry.targetPos.copy(entry.obj.position);
      entry.targetGridX = entry.gridX;
      entry.targetGridZ = entry.gridZ;
      return true;
    }

    // Prawidłowy krok na sąsiednie pole siatki
    entry.isMoving = true;
    entry.moveProgress = 0;
    entry.moveDuration = isDiagonal ? 0.32 * Math.SQRT2 : 0.32; // dłuższa droga po przekątnej, ta sama prędkość
    entry.startPos.copy(entry.obj.position);
    entry.targetPos.set(nextX, 0, nextZ);
    entry.targetGridX = nextX;
    entry.targetGridZ = nextZ;

    audio.play('krok');

    if (entry.walkAction) {
      entry.walkAction.reset().play();
      if (entry.idleAction) {
        entry.idleAction.crossFadeTo(entry.walkAction, 0.08, false);
      }
    }
    return true;
  }

  /**
   * Kolejkuje ciąg kroków (kombinacja z czatu, np. "wwd" -> ['up','up','right'])
   * dla jednej postaci. Nowa wiadomość ruchu od tego samego widza ZASTĘPUJE
   * resztę jego poprzedniej kolejki (widz "poprawia się" na czacie). Pierwszy
   * krok startuje od razu (jeśli postać stoi), reszta rusza z update() krok po
   * kroku, w miarę jak isMoving wraca na false - patrz _advanceQueue.
   */
  queueMoves(typeIndex, dirs) {
    typeIndex = Number(typeIndex);
    const entry = this.getWorkerType(typeIndex);
    if (!entry || !Array.isArray(dirs) || dirs.length === 0) return;
    entry.moveQueue = dirs.slice();
    this._advanceQueue(entry);
  }

  /** Startuje kolejny krok z entry.moveQueue, jeśli postać aktualnie stoi. */
  _advanceQueue(entry) {
    if (!entry || entry.isMoving) return;
    if (!entry.moveQueue || entry.moveQueue.length === 0) return;
    const dir = entry.moveQueue.shift();
    const ok = this.moveWorker(entry.typeIndex, dir);
    if (!ok) {
      // Krok odrzucony (omdlenie/blokada minigry/kradzież) - reszta kombinacji
      // i tak nie ma szans przejść, więc czyścimy kolejkę zamiast dobijać się
      // do kolejnych kroków co klatkę.
      entry.moveQueue.length = 0;
    }
  }

  /**
   * Odgrywa klip "die" pracownika (np. gdy boss go powala lub zabija).
   * LoopOnce + clampWhenFinished - awatar zostaje leżący na ostatniej klatce,
   * dopóki nie zostanie odratowany lub usunięty.
   */
  playDeath(typeIndex) {
    typeIndex = Number(typeIndex);
    const entry = this.getWorkerType(typeIndex);
    if (!entry || !entry.mixer) return;
    entry.isFainted = true;
    entry.playingInteract = false;

    const template = this.templates.get(entry.cacheKey);
    const dieClip = THREE.AnimationClip.findByName(template ? template.animations : [], 'die');
    if (!dieClip) return;

    if (entry.idleAction) entry.idleAction.stop();
    if (entry.interactAction) entry.interactAction.stop();

    const dieAction = entry.mixer.clipAction(dieClip);
    dieAction.setLoop(THREE.LoopOnce);
    dieAction.clampWhenFinished = true;
    dieAction.reset();
    dieAction.play();
    entry.dieAction = dieAction;
  }

  /** Usuwa awatar danego typu ze sceny i wpis z entries (np. po smierci zadanej przez bossa). */
  removeWorkerType(typeIndex) {
    typeIndex = Number(typeIndex);
    const idx = this.entries.findIndex((e) => Number(e.typeIndex) === typeIndex);
    if (idx === -1) return;
    const entry = this.entries[idx];
    if (entry.obj) this.scene.remove(entry.obj);
    this.entries.splice(idx, 1);
  }

  update(delta) {
    for (const entry of this.entries) {
      if (entry.mixer) entry.mixer.update(delta);

      if (entry.isMoving && entry.obj) {
        entry.moveProgress += delta / entry.moveDuration;
        const t = Math.min(1.0, entry.moveProgress);

        // Płynny krok z funkcją ease-in-out
        const ease = 0.5 - 0.5 * Math.cos(Math.PI * t);
        entry.obj.position.lerpVectors(entry.startPos, entry.targetPos, ease);

        // Subtelny podskok/chód w osi Y podczas przemieszczania
        if (entry.startPos.distanceTo(entry.targetPos) > 0.01) {
          entry.obj.position.y = Math.sin(Math.PI * t) * 0.07;
        }

        // Płynny obrót najkrótszą drogą kątową
        entry.obj.rotation.y = lerpShortestAngle(entry.startRotY, entry.targetRotY, ease);

        if (t >= 1.0) {
          entry.isMoving = false;
          entry.obj.position.copy(entry.targetPos);
          entry.obj.position.y = 0;
          entry.obj.rotation.y = entry.targetRotY;
          entry.gridX = entry.targetGridX;
          entry.gridZ = entry.targetGridZ;

          if (entry.walkAction && entry.idleAction && !entry.isFainted) {
            wrocDoIdle(entry, entry.walkAction, 0.16);
          }

          this._advanceQueue(entry);
        }
      }
    }
  }

  // ================= SYNCHRONIZACJA POZYCJI (widz dolaczajacy w trakcie streamu) =================

  /**
   * Wycinek stanu pozycji na siatce wysylany na serwer/kanalem realtime (patrz
   * zbierzStan w main.js). Tylko zajete sloty - nieobecny pracownik nie ma
   * czego synchronizowac.
   */
  getSyncState() {
    return this.entries.map((entry) => ({
      slot: entry.typeIndex,
      gridX: entry.gridX,
      gridZ: entry.gridZ,
      facingAngle: entry.facingAngle,
    }));
  }

  /**
   * Wyrownuje lokalne pozycje na siatce do tego, co przyszlo z serwera/hosta
   * (widz, patrz zastosujStanZSerwera w main.js) - host NIGDY tego nie woluje,
   * bo to on jest zrodlem prawdy dla pozycji.
   *
   * Pracownika w trakcie animacji kroku (entry.isMoving) NIE szarpiemy -
   * dokanczamy jego biezacy krok i korekte odkladamy do nastepnego wywolania,
   * kiedy juz stoi. Gdy pozycja juz sie zgadza, nie robimy nic (unikniecie
   * zbednego "cichego" teleportu w miejscu przy kazdym snapshocie).
   */
  applySync(stan) {
    if (!Array.isArray(stan)) return;
    for (const wpis of stan) {
      if (!wpis) continue;
      const slot = Number(wpis.slot);
      const entry = this.getWorkerType(slot);
      if (!entry || !entry.obj) continue;
      // dokoncz biezacy krok (lub kombinacje w toku - kolejka niepusta miedzy
      // krokami liczy sie jak ruch), korekta przy kolejnym snapshocie
      if (entry.isMoving || (entry.moveQueue && entry.moveQueue.length > 0)) continue;

      const gridX = Number(wpis.gridX);
      const gridZ = Number(wpis.gridZ);
      const facingAngle = Number(wpis.facingAngle);
      if (!Number.isFinite(gridX) || !Number.isFinite(gridZ) || !Number.isFinite(facingAngle)) continue;

      const zgodna = entry.gridX === gridX && entry.gridZ === gridZ && entry.facingAngle === facingAngle;
      if (zgodna) continue;

      entry.gridX = gridX;
      entry.gridZ = gridZ;
      entry.facingAngle = facingAngle;
      entry.targetGridX = gridX;
      entry.targetGridZ = gridZ;
      entry.startRotY = facingAngle;
      entry.targetRotY = facingAngle;
      entry.obj.position.set(gridX, 0, gridZ);
      entry.obj.rotation.y = facingAngle;
      entry.startPos.set(gridX, 0, gridZ);
      entry.targetPos.set(gridX, 0, gridZ);
    }
  }

  clear() {
    for (const entry of this.entries) {
      if (entry.obj) this.scene.remove(entry.obj);
    }
    // Usunięcie ze sceny wszelkich pozostałych obiektów oznaczonych jako pracownicy
    for (let i = this.scene.children.length - 1; i >= 0; i--) {
      const child = this.scene.children[i];
      if (child.userData && child.userData.isWorker) {
        this.scene.remove(child);
      }
    }
    this.entries = [];
    this.pending.clear();
  }
}
