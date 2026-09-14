import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/**
 * Winieta + delikatny grading, jako propozycja estetyczna (nie decyzja).
 * Wylacznik: ?postproces=0 w URL - wtedy setupPostproces zwraca null i
 * main.js ma renderowac dokladnie jak dotychczas (renderer.render(scene, camera)).
 *
 * Kolejnosc passow: RenderPass -> ShaderPass (winieta/grading) -> OutputPass.
 * Winieta/grading siedzi PRZED OutputPass, czyli dziala na surowych,
 * liniowych wartosciach radiancji (przed ACES i przed konwersja sRGB).
 * To celowe: OutputPass jako jedyny robi tone mapping (ACESFilmic,
 * exposure z renderera) i konwersje do sRGB, wiec obraz bez winiety ma
 * wygladac dokladnie jak dzis. Przyciemnienie rogow PRZED ACES jest tez
 * dokladniej odwzorowane przez krzywa tonemappingu (bez przepaleń/ucinania
 * w przestrzeni sRGB), a mnozenie o kilka % przed ACES nie zmienia srednio
 * jasnosci obrazu bo krzywa jest w przyblizeniu liniowa w tym zakresie.
 */
const winietaGradingShader = {
  uniforms: {
    tDiffuse: { value: null },
    // sila winiety: 0 = brak, 0.25 = rogi przyciemnione max ~25%
    vinIntensity: { value: 0.25 },
    // promien od ktorego zaczyna dzialac winieta (0-1, od srodka kadru)
    vinRadius: { value: 0.55 },
    // kontrast (1.0 = bez zmian). Wylaczony: pivot 0.5 w przestrzeni LINIOWEJ
    // lezy wysoko ponad typowa radiancja sceny (ekspozycja 0.7), wiec 1.05
    // przyciemnial caly kadr - zmierzone: srednia luminancja 133.8 -> 126.7.
    contrast: { value: 1.0 },
    // delikatna nasycenie (1.0 = bez zmian)
    saturation: { value: 1.05 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float vinIntensity;
    uniform float vinRadius;
    uniform float contrast;
    uniform float saturation;
    varying vec2 vUv;

    void main() {
      vec4 texel = texture2D(tDiffuse, vUv);

      // Kontrast wokol szarego 0.5 (nie zmienia sredniej jasnosci obrazu).
      vec3 col = (texel.rgb - 0.5) * contrast + 0.5;

      // Nasycenie - mieszanie z luminancja (Rec. 709).
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(luma), col, saturation);

      // Winieta - przyciemnienie rogow, srodek kadru bez zmian.
      vec2 d = vUv - 0.5;
      float dist = length(d) * 1.4142135; // znormalizowane tak, ze rog = 1.0
      float vin = smoothstep(vinRadius, 1.0, dist);
      col *= 1.0 - vin * vinIntensity;

      gl_FragColor = vec4(col, texel.a);
    }
  `,
};

/**
 * Buduje EffectComposer z wlasnym MSAA render targetem (bo domyslny
 * EffectComposer nie zachowuje MSAA z renderer.antialias=true - patrz
 * WebGLRenderTarget nizej z samples:4). Zwraca null gdy ?postproces=0.
 */
export function setupPostproces(renderer, scene, camera) {
  const params = new URLSearchParams(window.location.search);
  if (params.get('postproces') === '0') return null;

  const size = renderer.getSize(new THREE.Vector2());
  const pixelRatio = renderer.getPixelRatio();
  const renderTarget = new THREE.WebGLRenderTarget(size.x * pixelRatio, size.y * pixelRatio, {
    samples: 4,
    type: THREE.HalfFloatType,
  });

  const composer = new EffectComposer(renderer, renderTarget);
  composer.setPixelRatio(pixelRatio);
  composer.setSize(size.x, size.y);

  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new ShaderPass(winietaGradingShader));
  composer.addPass(new OutputPass());

  function resize(width, height) {
    composer.setPixelRatio(renderer.getPixelRatio());
    composer.setSize(width, height);
  }

  return { composer, resize };
}
