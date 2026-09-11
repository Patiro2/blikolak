import * as THREE from 'three';
import { loadArcade, MACHINE_KEYS } from './assets.js';

const DRAG_THRESHOLD_PX = 6; // powyzej tego pointerdown->pointerup to obrot kamery (OrbitControls), nie klik

export class Machine {
  constructor(scene, camera, domElement) {
    this.scene = scene;
    this.camera = camera;
    this.domElement = domElement;
    this.root = new THREE.Group();
    this.root.position.set(0, 0, 0);
    scene.add(this.root);

    this.currentTier = -1;
    this.model = null;

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();

    // Dodatkowe klikalne obiekty w scenie (np. zlota moneta), rejestrowane z zewnatrz.
    this.extraClickables = []; // [{object, onClick}]

    this._squashT = null; // czas trwania animacji kliknięcia, null gdy nieaktywna
    this._squashDuration = 0.15;
    this._downPos = null;

    this.onClickHit = null; // callback(point: Vector3)

    domElement.addEventListener('pointerdown', (e) => this._handlePointerDown(e));
    domElement.addEventListener('pointerup', (e) => this._handlePointerUp(e));
  }

  async setTier(tier) {
    if (tier === this.currentTier) return;
    const key = MACHINE_KEYS[tier];
    const gltf = await loadArcade(key);
    if (this.model) {
      this.root.remove(this.model);
    }
    this.model = gltf.scene.clone(true);
    this.root.add(this.model);
    this.currentTier = tier;
  }

  registerClickable(object, onClick) {
    this.extraClickables.push({ object, onClick });
  }

  unregisterClickable(object) {
    this.extraClickables = this.extraClickables.filter((c) => c.object !== object);
  }

  _handlePointerDown(e) {
    this._downPos = { x: e.clientX, y: e.clientY };
  }

  _handlePointerUp(e) {
    if (!this._downPos) return;
    const dx = e.clientX - this._downPos.x;
    const dy = e.clientY - this._downPos.y;
    this._downPos = null;
    const dist = Math.sqrt(dx * dx + dy * dy);
    // Przeciagniecie kursora = obrot kamery przez OrbitControls, nie liczy sie jako klik.
    if (dist > DRAG_THRESHOLD_PX) return;

    const rect = this.domElement.getBoundingClientRect();
    this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);

    const hits = [];
    if (this.model) {
      for (const h of this.raycaster.intersectObject(this.model, true)) {
        hits.push({ distance: h.distance, point: h.point, extra: null });
      }
    }
    for (const c of this.extraClickables) {
      if (!c.object) continue;
      for (const h of this.raycaster.intersectObject(c.object, true)) {
        hits.push({ distance: h.distance, point: h.point, extra: c });
      }
    }
    if (hits.length === 0) return;
    hits.sort((a, b) => a.distance - b.distance);
    const best = hits[0];
    if (best.extra) {
      best.extra.onClick(best.point);
    } else {
      this._playClickAnim();
      if (this.onClickHit) this.onClickHit(best.point);
    }
  }

  /** Wywoluje animacje klikniecia bez klikania - uzywane przez auto-klikacz. */
  triggerClickAnim() {
    this._playClickAnim();
  }

  _playClickAnim() {
    this._squashT = 0;
  }

  update(delta) {
    if (this._squashT === null || !this.model) return;
    this._squashT += delta;
    const t = Math.min(1, this._squashT / this._squashDuration);
    // squash scale.y 1 -> 0.92 -> 1, i lekki obrót
    const s = 1 - Math.sin(t * Math.PI) * 0.08;
    this.model.scale.set(1, s, 1);
    this.model.rotation.y = Math.sin(t * Math.PI) * 0.12;
    if (t >= 1) {
      this._squashT = null;
      this.model.scale.set(1, 1, 1);
      this.model.rotation.y = 0;
    }
  }
}
