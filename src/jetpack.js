import * as THREE from 'three';

/**
 * Kod czatu "rocketman" (patrz KODY w kick.js) - wylacznie wizualny jetpack
 * na planszy. Zaden wplyw na ekonomie/ranking/kolizje/blokady minigier -
 * jedyne co ten modul rusza to entry.model.position.y/rotation.z (offset
 * lotu) i wagi akcji animacji tej samej postaci, plus wlasny obiekt 3D.
 *
 * Ten sam wzorzec co inne minigry na siatce (flagbattle.js/tlumaczenia.js):
 * decyzje (spawn/kto podniosl/koniec lotu) podejmuje WYLACZNIE host
 * (isHost, patrz setHost/_hostDecide), widz odgrywa lokalnie to, co przyszlo
 * przez getSyncState/applySync - patrz main.js zbierzStan/zastosujStanZSerwera.
 */

const FLIGHT_MS = 15000;
const GRID_MIN = -3;
const GRID_MAX = 3;
// Klipy proboawane w tej kolejnosci jako animacja lotu - kazda postac w
// projekcie dzieli ten sam slownik klipow (patrz CLAUDE.md), ale nie kazdy
// model ma akurat te trzy - stad proba po kolei z cichym fallbackiem.
const FLY_CLIP_CANDIDATES = ['fall', 'jump', 'holding-both'];

// Dym z dysz - pula obiektow (patrz _ensureSmokePool), zaden alokowany co
// klatke. Limit "rozsadny" wg zadania (<=60 naraz).
const SMOKE_POOL_SIZE = 60;
const SMOKE_EMIT_INTERVAL = 0.035; // s miedzy czasteczkami, per dysza

/**
 * Buduje model jetpacka z samych prymitywow three.js w stylu Kenney (low-poly,
 * plaskie kolory, flatShading) - w paczkach nie ma gotowego jetpacka. Dwa
 * zbiorniki-cylindry, stelaz-belka, dwie dysze i dwa plomienie (widoczne
 * tylko w locie, patrz userData.flames w JetpackManager).
 */
function buildJetpackModel() {
  const g = new THREE.Group();
  g.name = 'jetpack';

  const matTank = new THREE.MeshStandardMaterial({ color: 0xd9484f, flatShading: true });
  const matFrame = new THREE.MeshStandardMaterial({ color: 0x5a5a5a, flatShading: true });
  const matNozzle = new THREE.MeshStandardMaterial({ color: 0x2b2b2b, flatShading: true });
  const matFlame = new THREE.MeshBasicMaterial({ color: 0xffa634, transparent: true, opacity: 0.85 });

  const tankGeo = new THREE.CylinderGeometry(0.075, 0.075, 0.34, 8);
  const tankL = new THREE.Mesh(tankGeo, matTank);
  tankL.position.set(-0.095, 0, 0);
  const tankR = new THREE.Mesh(tankGeo, matTank);
  tankR.position.set(0.095, 0, 0);
  g.add(tankL, tankR);

  const frameGeo = new THREE.BoxGeometry(0.27, 0.07, 0.05);
  const frameTop = new THREE.Mesh(frameGeo, matFrame);
  frameTop.position.set(0, 0.15, 0.01);
  const frameBottom = new THREE.Mesh(frameGeo, matFrame);
  frameBottom.position.set(0, -0.15, 0.01);
  g.add(frameTop, frameBottom);

  const nozzleGeo = new THREE.ConeGeometry(0.05, 0.09, 6);
  const nozzleL = new THREE.Mesh(nozzleGeo, matNozzle);
  nozzleL.position.set(-0.095, -0.22, 0);
  const nozzleR = new THREE.Mesh(nozzleGeo, matNozzle);
  nozzleR.position.set(0.095, -0.22, 0);
  g.add(nozzleL, nozzleR);

  const flameGeo = new THREE.ConeGeometry(0.032, 0.1, 6);
  const flameL = new THREE.Mesh(flameGeo, matFlame.clone());
  flameL.position.set(-0.095, -0.32, 0);
  flameL.rotation.x = Math.PI;
  const flameR = new THREE.Mesh(flameGeo, matFlame.clone());
  flameR.position.set(0.095, -0.32, 0);
  flameR.rotation.x = Math.PI;
  flameL.visible = false;
  flameR.visible = false;
  g.add(flameL, flameR);

  g.traverse((c) => {
    if (c.isMesh) c.castShadow = true;
  });
  g.userData.flames = [flameL, flameR];
  g.userData.nozzles = [nozzleL, nozzleR]; // punkty emisji dymu, patrz _spawnSmoke
  return g;
}

export class JetpackManager {
  constructor(scene) {
    this.scene = scene;
    this.workerManager = null;
    this.flagBattleRef = null;
    this.tlumaczeniaRef = null;
    this.panstwaMiastaRef = null;
    this.bitwaMarekRef = null;
    this.isHost = false;

    // Stan synchronizowany (getSyncState/applySync) - patrz komentarz przy klasie.
    this.state = 'idle'; // 'idle' | 'onGround' | 'flying'
    this.tile = null; // {x, z} - tylko przy 'onGround'
    this.flySlot = null; // typeIndex pracownika w locie
    this.flyStartedAt = null; // Date.now() (wspolny zegar sciany, nie performance.now())

    // Lokalny stan wizualny - NIE synchronizowany, kazda karta buduje/sprzata
    // wlasne obiekty 3D na podstawie stanu powyzej (patrz _applyVisualState).
    this._visualState = 'idle';
    this.groundObj = null;
    this.jetpackNode = null;
    this._flightModelRef = null; // entry.model, do wykrycia podmiany skina w trakcie lotu
    this._flightEntryRef = null;
    this._groundT = 0;

    // Dym z dysz - lokalny efekt (nie synchronizowany), patrz _spawnSmoke/_tickSmoke.
    this._smokePool = null; // Array<{mesh, active, age, life, vel}> - budowana leniwie
    this._smokeGeo = null;
    this._smokeEmitAccum = 0;
    this._smokeDisposePending = false;
  }

  setContext({ workerManager, flagBattle, tlumaczenia, panstwaMiasta, bitwaMarek }) {
    this.workerManager = workerManager;
    this.flagBattleRef = flagBattle || null;
    this.tlumaczeniaRef = tlumaczenia || null;
    this.panstwaMiastaRef = panstwaMiasta || null;
    this.bitwaMarekRef = bitwaMarek || null;
  }

  /** Ten sam wzorzec co flagBattle.setHost - patrz komentarz tam. */
  setHost(isHost) {
    this.isHost = !!isHost;
  }

  /**
   * Wywolywane z kick.js po dopasowaniu sekretnego kodu czatu "rocketman".
   * Widz (isHost=false) nic nie robi - dostanie spawn przez applySync.
   * Jesli jetpack juz jest na planszy (lezy albo ktos nim leci), kolejne
   * wpisanie kodu nic nie zmienia.
   */
  triggerRocketman() {
    if (!this.isHost || !this.workerManager) return;
    if (this.state !== 'idle') return;
    const tile = this._pickFreeTile();
    if (!tile) return; // brak wolnego pola - cicho nic sie nie dzieje
    this.tile = tile;
    this.state = 'onGround';
  }

  _pickFreeTile() {
    const occupied = new Set(this.workerManager.entries.map((e) => `${e.gridX},${e.gridZ}`));
    const candidates = [];
    for (let x = GRID_MIN; x <= GRID_MAX; x++) {
      for (let z = GRID_MIN; z <= GRID_MAX; z++) {
        if (x === 0 && z === 0) continue; // bankomat w centrum
        if (occupied.has(`${x},${z}`)) continue;
        if (this._isTileLockedByMinigry(x, z)) continue;
        candidates.push({ x, z });
      }
    }
    if (candidates.length === 0) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  _isTileLockedByMinigry(x, z) {
    const refs = [this.flagBattleRef, this.tlumaczeniaRef, this.panstwaMiastaRef, this.bitwaMarekRef];
    for (const ref of refs) {
      if (ref && typeof ref.isTileLocked === 'function' && ref.isTileLocked(x, z, null)) return true;
    }
    return false;
  }

  // ================= HOST: decyzje =================

  _hostDecide() {
    if (this.state === 'onGround') {
      const hit = this.workerManager.entries.find(
        (e) => !e.isFainted && !e.isRobbed && e.gridX === this.tile.x && e.gridZ === this.tile.z,
      );
      if (hit) {
        this.state = 'flying';
        this.flySlot = hit.typeIndex;
        this.flyStartedAt = Date.now();
      }
    } else if (this.state === 'flying') {
      const entry = this.workerManager.getWorkerType(this.flySlot);
      const elapsed = Date.now() - this.flyStartedAt;
      // Koniec czasu LUB postac zemdlala/zniknela w trakcie lotu (boss) -
      // ladowanie/sprzatanie wizualne robi _applyVisualState przy nastepnym
      // przejsciu stanu, tutaj tylko decyzja "koniec".
      if (!entry || entry.isFainted || elapsed >= FLIGHT_MS) {
        this.state = 'idle';
        this.flySlot = null;
        this.flyStartedAt = null;
        this.tile = null;
      }
    }
  }

  // ================= Wizualia (host i widz jednakowo, na podstawie stanu) =================

  /** Wolane co klatke z main.js animate() - patrz komentarz przy klasie. */
  tick(delta) {
    if (this.isHost) this._hostDecide();
    this._applyVisualState(delta);
    this._tickSmoke(delta); // niezaleznie od stanu - dogasza czasteczki po ladowaniu
  }

  _applyVisualState(delta) {
    if (this.state !== this._visualState) {
      this._exitVisual(this._visualState);
      this._enterVisual(this.state);
      this._visualState = this.state;
    }
    if (this.state === 'onGround') this._tickGround(delta);
    else if (this.state === 'flying') this._tickFlight(delta);
  }

  _exitVisual(prev) {
    if (prev === 'onGround') this._removeGround();
    if (prev === 'flying') this._cleanupFlightVisual();
  }

  _enterVisual(next) {
    if (next === 'onGround' && this.tile) this._spawnGround();
    // 'flying': zaczep na plecach budujemy leniwie w _tickFlight - entry.model
    // moze nie byc jeszcze zaladowany (postac dopiero sie tworzy).
  }

  _spawnGround() {
    if (this.groundObj) return;
    const wrapper = new THREE.Group();
    wrapper.position.set(this.tile.x, 0.12, this.tile.z);
    const inner = buildJetpackModel();
    inner.rotation.x = Math.PI / 2; // lezy plasko na ziemi
    wrapper.add(inner);
    this.scene.add(wrapper);
    this.groundObj = wrapper;
    this._groundT = 0;
  }

  _removeGround() {
    if (this.groundObj) {
      this.scene.remove(this.groundObj);
      this.groundObj = null;
    }
  }

  _tickGround(delta) {
    if (!this.groundObj) {
      if (this.tile) this._spawnGround(); // widz: applySync ustawil stan przed pierwszym tick()
      return;
    }
    this._groundT += delta;
    this.groundObj.rotation.y += delta * 1.2; // powoli sie obraca
    this.groundObj.position.y = 0.12 + Math.sin(this._groundT * 2) * 0.06; // unosi/opada
  }

  _tickFlight(delta) {
    if (!this.workerManager || this.flySlot === null) return;
    const entry = this.workerManager.getWorkerType(this.flySlot);
    // Model jeszcze nie zaladowany (postac w budowie) albo postac zniknela -
    // host i tak zakonczy lot za nas (_hostDecide), tu tylko czekamy.
    if (!entry || !entry.model) return;

    if (this._flightModelRef !== entry.model) {
      // Pierwsze podpiecie ALBO model sie podmienil w trakcie lotu (np. "!skin"
      // od drugiego agenta) - odepnij stary jetpack (jesli byl) i zaczep nowy.
      this._cleanupFlightVisual();
      this._attachJetpackToEntry(entry);
    }

    const startedAt = this.flyStartedAt || Date.now();
    const tSec = (Date.now() - startedAt) / 1000;
    entry.model.position.y = 1.2 + Math.sin(tSec * 1.6) * 0.15; // unoszenie 1-1.5 j + bujanie
    entry.model.rotation.z = Math.sin(tSec * 1.3) * 0.06;

    this._updateFlightAnim(entry, true);

    if (this.jetpackNode) {
      for (const fl of this.jetpackNode.userData.flames || []) {
        fl.visible = true;
        fl.scale.y = 0.8 + Math.random() * 0.5;
        fl.material.opacity = 0.55 + Math.random() * 0.35;
      }
      this._emitSmoke(delta);
    }
  }

  /**
   * Emituje szare czasteczki dymu z pozycji swiata obu dysz, w stalym tempie
   * (SMOKE_EMIT_INTERVAL na dysze) niezaleznie od fps - akumulator zamiast
   * "raz na klatke", zeby przy przycietych/wysokich fps tempo bylo takie samo.
   */
  _emitSmoke(delta) {
    const nozzles = this.jetpackNode.userData.nozzles || [];
    if (nozzles.length === 0) return;
    this._smokeEmitAccum += delta;
    const wp = new THREE.Vector3();
    while (this._smokeEmitAccum >= SMOKE_EMIT_INTERVAL) {
      this._smokeEmitAccum -= SMOKE_EMIT_INTERVAL;
      for (const nz of nozzles) {
        nz.getWorldPosition(wp);
        this._spawnSmoke(wp);
      }
    }
  }

  /**
   * Doczepia obiekt jetpacka do wezla pleców postaci (torso - patrz CLAUDE.md,
   * wspolny slownik wezlow rigu). Dwa typy rigu (patrz workers.js/skiny.js):
   *  - mini-pack: torso to Bone bez wlasnej geometrii, siatka tulowia lezy w
   *    osobnym SkinnedMesh "body-mesh" (bind pose - skinning nie zmienia
   *    geometrii samej siatki, wiec bbox jest stabilny).
   *  - blocky-characters: torso to Mesh z wlasna geometria wprost (bez
   *    skinningu) - bbox jest juz w lokalnym ukladzie torso.
   * W obu przypadkach pozycja jetpacka liczona jest z bbox tulowia (tylna
   * powierzchnia -Z = plecy, gorna czesc wysokosci), zamiast stalej liczby -
   * dziala niezaleznie od proporcji modelu z danej paczki.
   *
   * Skala swiata torso bywa != 1 (blocky-characters ~0.25x, patrz
   * BLOCKY_SCALE w skiny.js) - kompensujemy ja na wezle jetpacka, zeby jego
   * rozmiar w swiecie byl staly niezaleznie od skina.
   */
  _attachJetpackToEntry(entry) {
    const model = entry.model;
    const torso = model.getObjectByName('torso') || model.getObjectByName('body-mesh') || model;
    const node = buildJetpackModel();

    torso.updateWorldMatrix(true, false);
    const el = torso.matrixWorld.elements;
    const worldScale = Math.hypot(el[4], el[5], el[6]) || 1; // os Y macierzy swiata
    node.scale.setScalar(1 / worldScale);

    node.position.copy(this._computeBackpackLocalPos(model, torso));
    torso.add(node);
    this.jetpackNode = node;
    this._flightModelRef = model;
    this._flightEntryRef = entry;
  }

  /**
   * Liczy pozycje jetpacka w lokalnym ukladzie wezla `torso`, z bbox siatki
   * tulowia (patrz komentarz przy _attachJetpackToEntry). Fallback na stara
   * stala wartosc, gdy nie znajdziemy siatki z geometria (model spoza
   * znanych rigów) - lot nigdy nie zostaje bez jetpacka.
   */
  _computeBackpackLocalPos(model, torso) {
    const fallback = new THREE.Vector3(0, 0.04, -0.14);
    const bodyMesh = model.getObjectByName('body-mesh') || (torso.isMesh ? torso : null);
    if (!bodyMesh || !bodyMesh.geometry) return fallback;

    if (!bodyMesh.geometry.boundingBox) bodyMesh.geometry.computeBoundingBox();
    const box = bodyMesh.geometry.boundingBox;
    // Srodek na wysokosci ~75% bbox (gorna partia = okolice barkow/plecow,
    // omija nogi u dolu), najbardziej wysuniety punkt "w tyl" (-Z, przod
    // postaci = +Z lokalnie - patrz CLAUDE.md) jako powierzchnia plecow.
    const backLocal = new THREE.Vector3(
      (box.min.x + box.max.x) / 2,
      box.min.y + (box.max.y - box.min.y) * 0.75,
      box.min.z,
    );
    backLocal.z -= 0.05; // maly odstep, zeby jetpack nie przebijal do srodka

    if (bodyMesh.isSkinnedMesh && torso.isBone) {
      // backLocal jest w ukladzie bind pose siatki (== swiat bind pose, bo
      // body-mesh siedzi w korzeniu modelu) - boneInverses[i] to gotowa
      // macierz "swiat bind pose -> lokalny uklad kosci i", dokladnie to,
      // czego trzeba, zeby dziecko torso mialo poprawny staly offset.
      const boneIdx = bodyMesh.skeleton.bones.indexOf(torso);
      if (boneIdx !== -1) {
        return backLocal.applyMatrix4(bodyMesh.skeleton.boneInverses[boneIdx]);
      }
      return fallback;
    }
    // Node-hierarchy (blocky-characters) - torso JEST siatka, bbox juz w jego
    // wlasnym lokalnym ukladzie, zadnej dalszej transformacji nie trzeba.
    return backLocal;
  }

  _cleanupFlightVisual() {
    if (this._flightModelRef) {
      this._flightModelRef.position.y = 0;
      this._flightModelRef.rotation.z = 0;
    }
    if (this.jetpackNode && this.jetpackNode.parent) {
      this.jetpackNode.parent.remove(this.jetpackNode);
    }
    this.jetpackNode = null;
    if (this._flightEntryRef) this._updateFlightAnim(this._flightEntryRef, false);
    this._flightModelRef = null;
    this._flightEntryRef = null;

    // Dym: przestajemy emitowac, istniejace czasteczki dogasaja same w
    // _tickSmoke (wolane co klatke niezaleznie od stanu), pula sprzata sie
    // (dispose) jak tylko ostatnia zgasnie - patrz _tickSmoke.
    this._smokeEmitAccum = 0;
    if (this._smokePool) this._smokeDisposePending = true;
  }

  /** Nowa czasteczka z puli (bez alokacji geometrii/materialu co emisje). */
  _spawnSmoke(worldPos) {
    this._ensureSmokePool();
    const p = this._smokePool.find((x) => !x.active);
    if (!p) return; // pula pelna (limit SMOKE_POOL_SIZE) - cicho pomijamy
    p.active = true;
    p.age = 0;
    p.life = 0.6 + Math.random() * 0.4;
    p.mesh.position.copy(worldPos);
    p.mesh.visible = true;
    p.baseScale = 0.6 + Math.random() * 0.3;
    p.mesh.scale.setScalar(p.baseScale);
    p.mesh.material.opacity = 0.5;
    p.vel.set((Math.random() - 0.5) * 0.15, -(0.15 + Math.random() * 0.1), (Math.random() - 0.5) * 0.15);
  }

  /** Starzenie/opadanie/rozszerzanie/zanikanie aktywnych czasteczek dymu, plus sprzatanie puli po koncu lotu. */
  _tickSmoke(delta) {
    if (!this._smokePool) return;
    let anyActive = false;
    for (const p of this._smokePool) {
      if (!p.active) continue;
      p.age += delta;
      if (p.age >= p.life) {
        p.active = false;
        p.mesh.visible = false;
        continue;
      }
      anyActive = true;
      const t = p.age / p.life;
      p.mesh.position.addScaledVector(p.vel, delta);
      p.mesh.scale.setScalar(p.baseScale * (1 + t * 0.8)); // rozszerzanie
      p.mesh.material.opacity = 0.5 * (1 - t); // zanikanie
    }
    if (this._smokeDisposePending && !anyActive) this._disposeSmokePool();
  }

  _ensureSmokePool() {
    if (this._smokePool) return;
    this._smokeGeo = new THREE.SphereGeometry(0.045, 6, 5);
    this._smokePool = [];
    for (let i = 0; i < SMOKE_POOL_SIZE; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0x9a9a9a,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      });
      const mesh = new THREE.Mesh(this._smokeGeo, mat);
      mesh.visible = false;
      this.scene.add(mesh);
      this._smokePool.push({ mesh, active: false, age: 0, life: 0, baseScale: 1, vel: new THREE.Vector3() });
    }
  }

  _disposeSmokePool() {
    if (!this._smokePool) return;
    for (const p of this._smokePool) {
      this.scene.remove(p.mesh);
      p.mesh.material.dispose();
    }
    if (this._smokeGeo) this._smokeGeo.dispose();
    this._smokePool = null;
    this._smokeGeo = null;
    this._smokeDisposePending = false;
  }

  /**
   * Wymusza dominacje klipu lotu (fall/jump/holding-both, patrz
   * FLY_CLIP_CANDIDATES) nad idle/walk KAZDA klatke, zamiast crossFadeTo -
   * podczas lotu postac moze dostac normalna komende ruchu z czatu, ktora w
   * workers.js sama przelacza idle<->walk (patrz moveWorker/wrocDoIdle).
   * Wygaszanie ich wagi co klatke (zamiast jednorazowego przejscia) trzyma
   * animacje lotu na wierzchu bez ingerowania w ten kod. Gdy zaden z
   * kandydatow nie istnieje w danym modelu, po cichu nie robimy nic z
   * animacja - sam offset pozycji/rotacji i tak daje efekt lotu.
   */
  _updateFlightAnim(entry, flying) {
    if (!entry || !entry.mixer) return;
    if (flying) {
      if (entry._jetpackFlyAction === undefined) entry._jetpackFlyAction = this._findFlyAction(entry);
      const action = entry._jetpackFlyAction;
      if (action) {
        if (!action.isRunning()) {
          action.reset();
          action.setLoop(THREE.LoopRepeat);
          action.play();
        }
        action.setEffectiveWeight(1);
        if (entry.idleAction) entry.idleAction.setEffectiveWeight(0);
        if (entry.walkAction) entry.walkAction.setEffectiveWeight(0);
      }
    } else {
      if (entry._jetpackFlyAction) {
        entry._jetpackFlyAction.stop();
        entry._jetpackFlyAction.setEffectiveWeight(0);
      }
      entry._jetpackFlyAction = undefined;
      if (entry.idleAction && !entry.isFainted && !entry.isMoving) {
        entry.idleAction.reset().play();
        entry.idleAction.setEffectiveWeight(1);
      }
    }
  }

  _findFlyAction(entry) {
    for (const name of FLY_CLIP_CANDIDATES) {
      const clip = entry.gltfAnimations && THREE.AnimationClip.findByName(entry.gltfAnimations, name);
      if (clip) return entry.mixer.clipAction(clip);
    }
    return null; // model bez zadnego z kandydatow - lot dziala bez podmiany animacji
  }

  // ================= SYNCHRONIZACJA (patrz main.js zbierzStan/zastosujStanZSerwera) =================

  getSyncState() {
    return {
      state: this.state,
      tile: this.tile,
      slot: this.flySlot,
      startedAt: this.flyStartedAt,
    };
  }

  /** Widz nigdy nie decyduje sam (patrz komentarz przy klasie) - host to ignoruje. */
  applySync(s) {
    if (this.isHost) return;
    if (!s) return;
    this.state = s.state === 'onGround' || s.state === 'flying' ? s.state : 'idle';
    this.tile = s.tile && Number.isFinite(s.tile.x) && Number.isFinite(s.tile.z) ? { x: s.tile.x, z: s.tile.z } : null;
    this.flySlot = Number.isFinite(s.slot) ? s.slot : null;
    this.flyStartedAt = Number.isFinite(s.startedAt) ? s.startedAt : null;
  }
}
