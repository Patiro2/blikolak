import * as THREE from 'three';
import { loadDungeon } from './assets.js';

const POOL_SIZE = 120;
const BOUNCE_DURATION = 1.0; // czas lotu i odbijania sie
const FADE_DURATION = 1.0;   // dokladnie 1 sekunda wygaszania opacity do 0
const TOTAL_LIFETIME = BOUNCE_DURATION + FADE_DURATION;

export class CoinPool {
  constructor(scene) {
    this.scene = scene;
    this.pool = [];
    this.active = [];
    this.ready = false;
  }

  async init() {
    const gltf = await loadDungeon('coin');
    const template = gltf.scene;
    for (let i = 0; i < POOL_SIZE; i++) {
      const coin = template.clone(true);
      coin.visible = false;
      // Model coin ma 0.417 jednostki wysokosci - przy maszynie 0.776 wygladalby
      // jak kolo od wozu. 0.3 daje ~0.12 jednostki, czyli czytelna moneta.
      coin.scale.setScalar(0.3);

      const materials = [];
      coin.traverse((node) => {
        if (node.isMesh && node.material) {
          const mats = Array.isArray(node.material) ? node.material : [node.material];
          const clonedMats = mats.map((m) => {
            const clone = m.clone();
            clone.transparent = true;
            clone.opacity = 1.0;
            return clone;
          });
          node.material = Array.isArray(node.material) ? clonedMats : clonedMats[0];
          materials.push(...clonedMats);
        }
      });

      this.scene.add(coin);
      this.pool.push({
        mesh: coin,
        materials,
        vel: new THREE.Vector3(),
        spin: 0,
        life: 0,
      });
    }
    this.ready = true;
  }

  /** Wystrzeliwuje monety z pozycji origin (Vector3), ilość skalowana logarytmicznie od wartości. */
  burst(origin, value) {
    if (!this.ready) return;
    const count = Math.max(2, Math.min(10, Math.round(2 + Math.log10(Math.max(1, value)) * 3)));
    for (let i = 0; i < count; i++) {
      const slot = this.pool.pop();
      if (!slot) break;
      slot.mesh.position.copy(origin);
      slot.mesh.position.y += 0.3;
      slot.mesh.visible = true;

      for (const m of slot.materials) {
        m.opacity = 1.0;
      }

      const angle = Math.random() * Math.PI * 2;
      const speed = 0.8 + Math.random() * 1.0;
      slot.vel.set(Math.cos(angle) * speed * 0.4, 1.8 + Math.random() * 1.2, Math.sin(angle) * speed * 0.4);
      slot.spin = (Math.random() - 0.5) * 12;
      slot.life = TOTAL_LIFETIME;
      this.active.push(slot);
    }
  }

  update(delta) {
    if (!this.ready) return;
    const GRAVITY = 4.5;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const slot = this.active[i];
      slot.life -= delta;

      if (slot.life <= 0) {
        slot.mesh.visible = false;
        for (const m of slot.materials) {
          m.opacity = 1.0;
        }
        this.active.splice(i, 1);
        this.pool.push(slot);
        continue;
      }

      // Wygaszanie przezroczystości (opacity) do 0 przez ostatnią 1 sekundę
      if (slot.life < FADE_DURATION) {
        const opacity = Math.max(0, slot.life / FADE_DURATION);
        for (const m of slot.materials) {
          m.opacity = opacity;
        }
      }

      slot.vel.y -= GRAVITY * delta;
      slot.mesh.position.addScaledVector(slot.vel, delta);
      if (slot.mesh.position.y < 0.05) {
        slot.mesh.position.y = 0.05;
        slot.vel.y *= -0.35;
        slot.vel.x *= 0.7;
        slot.vel.z *= 0.7;
      }
      slot.mesh.rotation.y += slot.spin * delta;
    }
  }
}
