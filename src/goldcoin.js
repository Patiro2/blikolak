import * as THREE from 'three';
import { loadDungeon } from './assets.js';

const SPAWN_MIN = 25; // sekundy
const SPAWN_MAX = 50;
const LIFETIME = 9; // znika po tylu sekundach, jesli nieklikniety

/** Co jakis czas pojawia sie w scenie klikalna zlota moneta z jednorazowym bonusem. */
export class GoldenCoinManager {
  constructor(scene, machine, onCollect) {
    this.scene = scene;
    this.machine = machine;
    this.onCollect = onCollect;
    this.template = null;
    this.mesh = null;
    this.timeToSpawn = this._randomDelay();
    this.life = 0;
    this.bobT = 0;
  }

  async init() {
    const gltf = await loadDungeon('coin');
    this.template = gltf.scene;
  }

  _randomDelay() {
    return SPAWN_MIN + Math.random() * (SPAWN_MAX - SPAWN_MIN);
  }

  _spawn() {
    if (!this.template || this.mesh) return;
    const mesh = this.template.clone(true);
    mesh.scale.setScalar(0.55);
    mesh.traverse((node) => {
      if (node.isMesh && node.material) {
        const wasArray = Array.isArray(node.material);
        const mats = wasArray ? node.material : [node.material];
        const gold = mats.map((m) => {
          const clone = m.clone();
          clone.color = new THREE.Color(0xffd23f);
          clone.emissive = new THREE.Color(0x6b4e00);
          return clone;
        });
        node.material = wasArray ? gold : gold[0];
      }
    });
    const angle = Math.random() * Math.PI * 2;
    const radius = 1.0 + Math.random() * 1.6;
    mesh.position.set(Math.cos(angle) * radius, 1.1, Math.sin(angle) * radius * 0.6);
    this.scene.add(mesh);
    this.mesh = mesh;
    this.life = LIFETIME;
    this.machine.registerClickable(mesh, (point) => this._collect(point));
  }

  _despawn() {
    if (!this.mesh) return;
    this.machine.unregisterClickable(this.mesh);
    this.scene.remove(this.mesh);
    this.mesh = null;
    this.timeToSpawn = this._randomDelay();
  }

  _collect(point) {
    if (!this.mesh) return;
    this._despawn();
    this.onCollect(point);
  }

  update(delta) {
    if (this.mesh) {
      this.bobT += delta;
      this.mesh.position.y = 1.1 + Math.sin(this.bobT * 3) * 0.12;
      this.mesh.rotation.y += delta * 2;
      this.life -= delta;
      if (this.life <= 0) this._despawn();
      return;
    }
    this.timeToSpawn -= delta;
    if (this.timeToSpawn <= 0) this._spawn();
  }
}
