import * as THREE from 'three';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { loadArcade } from './assets.js';

export class WorkerManager {
  constructor(scene) {
    this.scene = scene;
    this.entries = [];
    this.templates = new Map();
    this.pending = new Map(); // typeIndex -> Promise<Entry>
  }

  async _getTemplate(modelKey) {
    if (this.templates.has(modelKey)) return this.templates.get(modelKey);
    const gltf = await loadArcade(modelKey);
    this.templates.set(modelKey, gltf);
    return gltf;
  }

  _circlePosition(typeIndex) {
    // Dyrektor oddziału (typ 9) stoi najbliżej bankomatu (promień ~0.85, z przodu po prawej)
    if (typeIndex === 9) {
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
    const theta = (typeIndex % count) * (2 * Math.PI / count) + offset;

    const x = Math.sin(theta) * radius;
    const z = Math.cos(theta) * radius;
    // Każdy pracownik obraca się twarzą prosto w stronę bankomatu w centrum (0, 0, 0)
    const rotY = Math.atan2(-x, -z);
    return { x, z, rotY };
  }

  hasWorkerType(typeIndex) {
    return this.entries.some((e) => e.typeIndex === typeIndex) || this.pending.has(typeIndex);
  }

  getWorkerType(typeIndex) {
    return this.entries.find((e) => e.typeIndex === typeIndex) || null;
  }

  /**
   * Dodaje reprezentanta danego typu pracownika do sceny (dokładnie raz na typ).
   * Zabezpieczone blokadą asynchroniczną (pending Map) przed wielokrotnym tworzeniem
   * modeli przy równoległych zapytaniach oraz automatycznym usuwaniem duplikatów.
   */
  async addWorkerType(typeIndex, modelKey) {
    // 1. Jeśli model tego typu już istnieje w entries, zwróć go natychmiast
    const existing = this.getWorkerType(typeIndex);
    if (existing) return existing;

    // 2. Jeśli inne wywołanie asynchroniczne właśnie tworzy ten model, poczekaj na ten sam Promise
    if (this.pending.has(typeIndex)) {
      return await this.pending.get(typeIndex);
    }

    const task = (async () => {
      // Ponowne sprawdzenie po wejściu w asynchroniczny task
      const check1 = this.getWorkerType(typeIndex);
      if (check1) return check1;

      const gltf = await this._getTemplate(modelKey);

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

      const obj = SkeletonUtils.clone(gltf.scene);
      obj.userData = { isWorker: true, workerTypeIndex: typeIndex };

      const pos = this._circlePosition(typeIndex);
      obj.position.set(pos.x, 0, pos.z);
      obj.rotation.y = pos.rotY;

      obj.traverse((child) => {
        if (child.isMesh) {
          child.castShadow = true;
          child.receiveShadow = true;
        }
      });

      this.scene.add(obj);

      const mixer = new THREE.AnimationMixer(obj);
      const idleClip = THREE.AnimationClip.findByName(gltf.animations, 'idle');
      const interactClip = THREE.AnimationClip.findByName(gltf.animations, 'interact-right');

      const entry = {
        typeIndex,
        modelKey,
        obj,
        mixer,
        idleAction: null,
        interactAction: null,
        playingInteract: false,
        animAcc: 0,
      };

      if (idleClip) {
        entry.idleAction = mixer.clipAction(idleClip);
        entry.idleAction.play();
      }
      if (interactClip) {
        entry.interactAction = mixer.clipAction(interactClip);
        entry.interactAction.setLoop(THREE.LoopOnce);
        entry.interactAction.clampWhenFinished = true;
      }

      mixer.addEventListener('finished', (e) => {
        if (entry.interactAction && e.action === entry.interactAction) {
          entry.playingInteract = false;
          if (entry.idleAction) {
            entry.interactAction.crossFadeTo(entry.idleAction, 0.3, false);
          }
        }
      });

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
    if (!entry.interactAction || entry.playingInteract) return;
    entry.playingInteract = true;
    entry.interactAction.reset();
    entry.interactAction.setEffectiveWeight(1);
    entry.interactAction.play();
    if (entry.idleAction) {
      entry.idleAction.crossFadeTo(entry.interactAction, 0.15, false);
    }
  }

  /**
   * Odgrywa klip "die" pracownika (np. gdy boss go "zabija" po timeoucie
   * dzialania matematycznego). LoopOnce + clampWhenFinished - awatar zostaje
   * lezacy na ostatniej klatce, dopoki nie zostanie usuniety (patrz removeWorkerType).
   */
  playDeath(typeIndex) {
    const entry = this.getWorkerType(typeIndex);
    if (!entry || !entry.mixer) return;
    // Klip "die" nie byl dotad cache'owany w entry - pobieramy go z szablonu.
    const template = this.templates.get(entry.modelKey);
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
    const idx = this.entries.findIndex((e) => e.typeIndex === typeIndex);
    if (idx === -1) return;
    const entry = this.entries[idx];
    if (entry.obj) this.scene.remove(entry.obj);
    this.entries.splice(idx, 1);
  }

  update(delta) {
    for (const entry of this.entries) {
      if (entry.mixer) entry.mixer.update(delta);
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
