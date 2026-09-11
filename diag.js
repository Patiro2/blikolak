// Diagnostyka migotania podlogi - uruchamiana RECZNIE z konsoli przegladarki:
//
//     import('/diag.js')
//
// Skrypt mierzy na TWOJEJ karcie graficznej to samo, co dalo sie zmierzyc na
// nagraniu ekranu: jak bardzo "sypie sie" obraz podlogi miedzy kolejnymi
// klatkami przy powolnym ruchu kamery. Miara to wariancja Laplace'a (ilosc
// wysokich czestotliwosci) liczona w wycinku kadru z posadzka; wskaznik
// koncowy to odchylenie standardowe tej wariancji podzielone przez jej
// srednia - im wyzszy, tym silniejsze migotanie.
//
// Pomiar leci na PRAWDZIWYM plotnie gry (z MSAA i Twoim pixel ratio), a nie
// w buforze pomocniczym - wlasnie dlatego, ze w buforze pomocniczym problemu
// nie da sie odtworzyc.
//
// Skrypt niczego nie zapisuje i po zakonczeniu przywraca wszystkie ustawienia.

const g = window.__game;
if (!g) {
  console.error('[diag] Brak window.__game - odpal to na karcie z gra.');
} else {
  const renderer = g.renderer;
  const gl = renderer.getContext();
  const canvas = renderer.domElement;

  // --- 1. Srodowisko ---
  let gpu = 'nieznane';
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (ext) gpu = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
  } catch (_) {}

  const odswiezanie = await new Promise((res) => {
    let n = 0;
    const t0 = performance.now();
    const f = () => {
      n++;
      if (performance.now() - t0 < 1000) requestAnimationFrame(f);
      else res(Math.round(n / ((performance.now() - t0) / 1000)));
    };
    requestAnimationFrame(f);
  });

  // --- 2. Przygotowanie pomiaru ---
  const cam = g.camera;
  const zapisPos = cam.position.clone();
  const zapisQuat = cam.quaternion.clone();

  const W = canvas.width;
  const H = canvas.height;
  // Wycinek z posadzka: srodek kadru, dolna polowa (readPixels liczy od dolu).
  const CW = Math.min(700, Math.floor(W * 0.45));
  const CH = Math.min(420, Math.floor(H * 0.35));
  const CX = Math.floor((W - CW) / 2);
  const CY = Math.floor(H * 0.22);
  const buf = new Uint8Array(CW * CH * 4);

  function wariancjaLaplace() {
    let s = 0;
    let s2 = 0;
    let n = 0;
    for (let y = 1; y < CH - 1; y++) {
      for (let x = 1; x < CW - 1; x++) {
        const i = (y * CW + x) * 4;
        const v = 4 * buf[i] - buf[i - 4] - buf[i + 4] - buf[i - CW * 4] - buf[i + CW * 4];
        s += v;
        s2 += v * v;
        n++;
      }
    }
    const m = s / n;
    return s2 / n - m * m;
  }

  // Kadr jak na nagraniu: blisko posadzki, plaski kat, powolny luk.
  function seria() {
    const próbki = [];
    for (let k = 0; k < 24; k++) {
      const a = k * 0.004;
      const r = 2.1;
      cam.position.set(Math.sin(a) * r + 0.4, 1.05, Math.cos(a) * r);
      cam.lookAt(-0.3, 0, -1.2);
      cam.updateMatrixWorld();
      renderer.render(g.scene, cam);
      gl.readPixels(CX, CY, CW, CH, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      próbki.push(wariancjaLaplace());
    }
    const m = próbki.reduce((a, b) => a + b, 0) / próbki.length;
    const sd = Math.sqrt(próbki.reduce((a, b) => a + (b - m) * (b - m), 0) / próbki.length);
    return { srednia: +m.toFixed(1), oscylacja: +(sd / m).toFixed(4) };
  }

  // --- 3. Warianty do porownania ---
  let swiatlo = null;
  g.scene.traverse((o) => {
    if (o.isDirectionalLight && o.castShadow) swiatlo = o;
  });
  let siatka = null;
  let teksturaPodlogi = null;
  g.scene.traverse((o) => {
    if (!o.isMesh) return;
    if (!siatka && o.geometry.type === 'PlaneGeometry' && o.material && o.material.depthWrite === false) siatka = o;
    if (!teksturaPodlogi && o.name === 'floor_1') teksturaPodlogi = o.material.map;
  });

  const wynik = {};
  wynik.obecne = seria();

  if (swiatlo) {
    const nb = swiatlo.shadow.normalBias;
    const b = swiatlo.shadow.bias;
    swiatlo.shadow.normalBias = 0;
    swiatlo.shadow.bias = 0;
    swiatlo.shadow.needsUpdate = true;
    wynik.bezBiasu = seria();
    swiatlo.shadow.normalBias = nb;
    swiatlo.shadow.bias = b;
    swiatlo.shadow.needsUpdate = true;
  }

  const cienie = renderer.shadowMap.enabled;
  renderer.shadowMap.enabled = false;
  g.scene.traverse((o) => {
    if (o.isMesh && o.material) o.material.needsUpdate = true;
  });
  wynik.bezCieni = seria();
  renderer.shadowMap.enabled = cienie;
  g.scene.traverse((o) => {
    if (o.isMesh && o.material) o.material.needsUpdate = true;
  });

  if (siatka) {
    siatka.visible = false;
    wynik.bezSiatki = seria();
    siatka.visible = true;
  }

  if (teksturaPodlogi) {
    const zapisAniz = teksturaPodlogi.anisotropy;
    teksturaPodlogi.anisotropy = 1;
    teksturaPodlogi.needsUpdate = true;
    wynik.bezAnizotropii = seria();
    teksturaPodlogi.anisotropy = zapisAniz;
    teksturaPodlogi.needsUpdate = true;
  }

  if (g.city && g.city.plazaMesh) {
    g.city.plazaMesh.visible = false;
    wynik.bezPlacu = seria();
    g.city.plazaMesh.visible = true;
  }

  // --- 4. Przywrocenie kamery ---
  cam.position.copy(zapisPos);
  cam.quaternion.copy(zapisQuat);
  cam.updateMatrixWorld();

  const raport = {
    gpu,
    odswiezanieHz: odswiezanie,
    devicePixelRatio,
    pixelRatioRenderera: renderer.getPixelRatio(),
    plotno: [W, H],
    css: [Math.round(canvas.getBoundingClientRect().width), Math.round(canvas.getBoundingClientRect().height)],
    msaa: gl.getParameter(gl.SAMPLES),
    wynik,
  };

  console.log('%c[diag] SKOPIUJ CALA LINIE PONIZEJ I WKLEJ CLAUDE:', 'color:#53fc18;font-weight:bold');
  console.log(JSON.stringify(raport));
}
