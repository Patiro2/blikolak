import * as THREE from 'three';

// Krotkie iskry przy trafieniu w bankomat - jeden draw call (THREE.Points),
// pierscieniowa pula o stalej pojemnosci, zero alokacji na klatke.
const CAPACITY = 256;
const LIFE_MIN = 0.3;
const LIFE_MAX = 0.5;
const GRAVITY = 6.0;
const HIDDEN_Y = -9999; // tu chowamy nieaktywne czastki (bez zmiany rozmiaru per-vertex)

// Okragla tekstura iskry z miekkim brzegiem, generowana raz z canvas 2D
// (radialny gradient: biały srodek -> przezroczysty brzeg). PointsMaterial
// bez tekstury renderuje kwadratowe piksele - to jest fix na to.
function makeSparkTexture() {
  const size = 32;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const grad = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.4, 'rgba(255,255,255,1)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class SparkPool {
  constructor(scene) {
    this.enabled = new URLSearchParams(location.search).get('iskry') !== '0';
    this.scene = scene;
    this.cursor = 0;

    this.positions = new Float32Array(CAPACITY * 3);
    this.velocities = new Float32Array(CAPACITY * 3);
    this.life = new Float32Array(CAPACITY);
    for (let i = 0; i < CAPACITY; i++) {
      this.positions[i * 3 + 1] = HIDDEN_Y;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geometry.setDrawRange(0, CAPACITY);

    const material = new THREE.PointsMaterial({
      color: 0xffe7a0,
      // 0.08 -> 0.12: miekki brzeg gradientu "zjada" krawedz kwadratu,
      // wiec optycznie iskra wychodzi mniejsza - podbite o ok. 50%, zeby wizualny rozmiar zostal taki sam.
      size: 0.12,
      map: makeSparkTexture(),
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false, // inaczej ACES + exposure 0.7 gasi kolor do szarosci
    });

    this.points = new THREE.Points(geometry, material);
    this.points.castShadow = false;
    this.points.frustumCulled = false;
    if (this.enabled) scene.add(this.points);
  }

  /** Wystrzeliwuje iskry z pozycji origin (Vector3). Przy krytyku wiekszy wybuch. */
  burst(origin, isCrit) {
    if (!this.enabled) return;
    const count = isCrit ? 20 : 9;
    for (let n = 0; n < count; n++) {
      const i = this.cursor;
      this.cursor = (this.cursor + 1) % CAPACITY;

      const angle = Math.random() * Math.PI * 2;
      const speed = (isCrit ? 2.0 : 1.2) + Math.random() * 1.5;
      const up = (isCrit ? 2.5 : 1.5) + Math.random() * 1.5;

      this.positions[i * 3] = origin.x;
      this.positions[i * 3 + 1] = origin.y;
      this.positions[i * 3 + 2] = origin.z;

      this.velocities[i * 3] = Math.cos(angle) * speed;
      this.velocities[i * 3 + 1] = up;
      this.velocities[i * 3 + 2] = Math.sin(angle) * speed;

      this.life[i] = LIFE_MIN + Math.random() * (LIFE_MAX - LIFE_MIN);
    }
  }

  update(delta) {
    if (!this.enabled) return;
    let anyActive = false;
    for (let i = 0; i < CAPACITY; i++) {
      if (this.life[i] <= 0) continue;
      anyActive = true;
      this.life[i] -= delta;
      if (this.life[i] <= 0) {
        this.positions[i * 3 + 1] = HIDDEN_Y;
        continue;
      }
      this.velocities[i * 3 + 1] -= GRAVITY * delta;
      this.positions[i * 3] += this.velocities[i * 3] * delta;
      this.positions[i * 3 + 1] += this.velocities[i * 3 + 1] * delta;
      this.positions[i * 3 + 2] += this.velocities[i * 3 + 2] * delta;
    }
    if (anyActive) {
      this.points.geometry.attributes.position.needsUpdate = true;
    }
    // Bez aktywnych iskier nie rysujemy wcale - inaczej Points kosztuje stale +1 draw call.
    this.points.visible = anyActive;
  }
}
