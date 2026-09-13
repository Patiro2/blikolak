import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { loadArcade, loadForest } from './assets.js';

const BASE_FOV = 42;
const BASE_POS = new THREE.Vector3(0, 3.2, 5.4);
const LOOK_TARGET = new THREE.Vector3(0, 0.65, 0.1);


/**
 * Wlasciciel po obejrzeniu nocnego wariantu (commit a04ec6b) zmienil zdanie:
 * "doskonale oswietlenie, ale w dzien". Ta funkcja buduje WIDOCZNA (dodawana
 * wprost do glownej sceny, nie tylko do PMREM) kopule nieba - gradient
 * canvas-free, wierzcholkowy (ten sam wzorzec co dawna
 * buildNightEnvironmentScene ponizej niej w historii tego pliku): blekit
 * zenitu u gory, jasny, prawie bialy horyzont u dolu (typowy dla sloneczmego,
 * lekko zamglonego popoludnia). Kula jest duza (promien 90) - poza FOG_FAR
 * (55, patrz city.js) i camera.far (100), wiec zawsze stoi ZA mgla/wszystkimi
 * obiektami, nigdy jej krawedz nie jest widoczna. `fog: false` na materiale
 * wylacza wplyw scene.fog na te siatke - mgla ma rozmywac ODLEGLE OBIEKTY na
 * tle nieba (budynki, patrz city.js), a nie samo niebo, ktore juz jest
 * wlasnym, dalekim tlem.
 * Tanie w wykonaniu: jeden dodatkowy draw call, zero tekstur, prosty
 * MeshBasicMaterial (bez oswietlenia).
 */
function buildDaySkyDome() {
  const geo = new THREE.SphereGeometry(90, 24, 16);
  const mat = new THREE.MeshBasicMaterial({ side: THREE.BackSide, vertexColors: true, fog: false, toneMapped: false });
  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  const colorTop = new THREE.Color(0x4c8fd9); // nasycony blekit zenitu
  const colorHorizon = new THREE.Color(0xdcecf7); // jasny, lekko cieply horyzont (zamglone popoludnie)
  const tmp = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const t = THREE.MathUtils.clamp((pos.getY(i) / 90 + 0.12) / 0.55, 0, 1);
    tmp.copy(colorHorizon).lerp(colorTop, t);
    colors[i * 3] = tmp.r;
    colors[i * 3 + 1] = tmp.g;
    colors[i * 3 + 2] = tmp.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return new THREE.Mesh(geo, mat);
}

/**
 * Przy waskim/wysokim oknie (aspect < 1.3) kadr 42mm/pozycja (0,2.7,4.6) zaweza
 * sie tak bardzo w poziomie, ze pierwszy pracownik zaslania pol ekranu, a
 * maszyna chowa sie za panelem HUD. Cofamy kamere i poszerzamy FOV proporcjonalnie
 * do tego, jak bardzo okno jest waskie.
 */
function applyCameraFraming(camera, aspect) {
  camera.aspect = aspect;
  if (aspect < 1.3) {
    const t = Math.min(1, (1.3 - aspect) / 0.9); // 0 przy 1.3, 1 przy aspect <= 0.4
    camera.fov = BASE_FOV + t * 30;
    camera.position.set(BASE_POS.x, BASE_POS.y + t * 1.6, BASE_POS.z + t * 3.4);
  } else {
    camera.fov = BASE_FOV;
    camera.position.copy(BASE_POS);
  }
  camera.updateProjectionMatrix();
}

export function createScene(canvas) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Kinowy Tone Mapping ACESFilmic - żywe, bogate kolory bez przepaleń bieli.
  // Ekspozycja wraca do wartosci dziennej (1.05, w okolicy domyslnej 1.0) -
  // rig ponizej (slonce + niebo) jest teraz sam w sobie jasny, wiec nie
  // potrzebujemy juz sztucznego przygaszenia, ktore sluzylo tylko nocnemu
  // nastrojowi z poprzedniej wersji (0.92).
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  // Obnizone z 1.05 - przy pelnym rigu (slonce+niebo+IBL) 1.05 przepalalo
  // arene/trawe/bankomat; 0.85 to nadal jasny dzien, bez przepaleń.
  renderer.toneMappingExposure = 0.85;

  const scene = new THREE.Scene();
  // Plaski fallback w kolorze horyzontu - widoczny tylko, gdyby kopula nieba
  // (buildDaySkyDome, dodawana ponizej) z jakiegos powodu nie pokryla calego
  // kadru (np. pierwsza klatka przed jej dodaniem do sceny).
  scene.background = new THREE.Color(0xdcecf7);
  scene.add(buildDaySkyDome());

  // Environment map (IBL) - generowana RAZ, przy starcie (PMREMGenerator,
  // jednorazowy koszt rzedu ~20ms, zmierzone; zero kosztu per-klatke pozniej).
  // Modele Kenney (MeshStandardMaterial z GLB) bez tego maja wylacznie
  // oswietlenie kierunkowe/punktowe - plaskie, matowe powierzchnie bez
  // zadnego odbicia otoczenia. Zrodlo PMREM to teraz domyslny RoomEnvironment
  // z three/addons (NIE wlasna ciemna "kapsula" jak w poprzedniej, nocnej
  // wersji tego pliku) - RoomEnvironment to jasne, neutralne "studio" z
  // kilkoma kolorowymi softboxami, zaprojektowane wlasnie pod jasne/dzienne
  // sceny (patrz historia tego pliku - przy nocnym rigu jego wplyw byl
  // niezauwazalny z dokladnie tego powodu). scene.environment (NIE
  // scene.background/kopula nieba powyzej) - tlo/mgla/miasto (city.js)
  // zostaja bez zmian.
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
  pmremGenerator.dispose();
  // RoomEnvironment to jasne studio - w pelnej sile (1.0) dokladalo sie do
  // slonca/hemi i przepalalo powierzchnie; przycięte jako subtelny odblask.
  scene.environmentIntensity = 0.35;

  // Zwiększenie near z 0.05 do 0.1 podwaja precyzję bufora głębokości (eliminacja Z-fightingu kamery)
  const camera = new THREE.PerspectiveCamera(BASE_FOV, window.innerWidth / window.innerHeight, 0.1, 100);
  applyCameraFraming(camera, window.innerWidth / window.innerHeight);
  camera.lookAt(LOOK_TARGET);

  // 1. Otoczenie dziennego nieba (Hemisphere) - blekit zenitu u gory (pasuje
  // do buildDaySkyDome), cieply, przygaszony odblask ziemi/trawy u dolu.
  // Intensywnosc 0.65 (podniesiona z nocnego 0.22) - w dzien niebo samo w
  // sobie jest silnym, rozproszonym zrodlem swiatla wypelniajacego (nie tylko
  // kontrastowym akcentem jak noca).
  const hemi = new THREE.HemisphereLight(0xbfe0ff, 0x8a7256, 0.5); // obnizone z 0.65 - dublowalo sie z IBL
  scene.add(hemi);

  // 2. Slonce (Key Light) - cieply, biały kierunkowy key z twardymi cieniami
  // (kat ~55 stopni elewacji, "popoludniowe" swiatlo: cienie wyraznie
  // widoczne na arenie, ale nie tak dlugie/plaskie, zeby zaslanialy postacie
  // - patrz raport zadania, zweryfikowane zrzutem z domyslnej kamery).
  // TYLKO ten swiatlo (nie dirWide ponizej) definiuje tesny, wysokiej
  // rozdzielczosci cien areny - mapSize/bias/normalBias/radius/frustum
  // ponizej to DOKLADNIE ten sam, zmierzony i udokumentowany tuning co w
  // poprzedniej (nocnej) wersji tego pliku, bez zadnych zmian - zmiana
  // koloru/intensywnosci/kata swiatla go nie uniewaznia, bo dotyczy tylko
  // tego, JAK teksel mapy cieni jest probkowany, nie tego, co go oswietla.
  // Intensywnosc 0.8 (nie 2.6): glowne slonce to dirWide ponizej. Swiatlo bez
  // cienia poza swoim frustum (+-5) i tak oswietla caly teren, wiec gdyby to
  // ono bylo glowne, cien dirWide przyciemnialby otoczenie areny o ledwie
  // ~16% i rekwizyty poza arena wygladalyby jak bez cienia (sprawdzone
  // zrzutem). Tutaj tylko doostrza cienie na samej arenie.
  const dir = new THREE.DirectionalLight(0xfff2d9, 0.8);
  dir.position.set(5, 8, 3);
  dir.castShadow = true;
  dir.shadow.mapSize.set(4096, 4096);
  dir.shadow.bias = -0.0002;
  dir.shadow.normalBias = 0.015;
  dir.shadow.radius = 1.4;
  dir.shadow.camera.near = 0.5;
  dir.shadow.camera.far = 20;
  // Frustum +-5 - obejmuje arene (siega do 3.5) i najblizsze otoczenie
  // (plotek/boss/Vanessa), NIE cala strefe z cieniami (patrz dirWide nizej) -
  // to jest swiadomy wybor: zaciesniony frustum na WYSOKIEJ rozdzielczosci
  // mapy (4096) daje maksymalna ostrosc cienia dokladnie tam, gdzie kamera
  // patrzy najczesciej i z najblizsza (arena/postacie), bez rozmywania tego
  // budzetu tekseli na caly plac.
  dir.shadow.camera.left = -5;
  dir.shadow.camera.right = 5;
  dir.shadow.camera.top = 5;
  dir.shadow.camera.bottom = -5;
  scene.add(dir);

  // 2b. To samo slonce (IDENTYCZNY kierunek - ta sama proporcja pozycji, wiec
  // ten sam znormalizowany wektor kierunku), ale DRUGIE zrodlo swiatla
  // dedykowane WYLACZNIE poszerzeniu zasiegu cieni na otoczenie areny (plac,
  // plotek ozdobny, kepki trawy/gruntu, rekwizyty klastrow, latarnie przy
  // obwodnicy - promien r <= ok. 13, patrz wymagania zadania), bez utraty
  // ostrosci cienia na samej arenie (dir powyzej, nietkniety).
  //
  // Dlaczego DWA swiatla kierunkowe zamiast jednego z duzym frustum: jeden
  // dir o frustum +-13.5 przy tym samym mapSize=4096 dawalby teksel ~2.7x
  // wiekszy niz obecny (+-5) - w izolowanym tescie (patrz notatka przy dir
  // powyzej) taki skok wielkosci teksela byl GLOWNA przyczyna widocznego
  // shadow acne. Podniesienie mapSize do ~8192 zamiast tego kosztowaloby ~4x
  // wiecej pamieci/przepustowosci tylko dla jednego swiatla. Dwa swiatla o
  // mapach 4096 (tesny obszar areny + szeroki obszar otoczenia) to mniej
  // tekseli lacznie (16M+16M=32M) niz jedno duze (8192^2=64M), przy
  // zachowaniu ostrosci tam, gdzie sie liczy najbardziej.
  //
  // "Podwojny cien" (dwa przesuniete odbicia tego samego obiektu), przed
  // ktorym trzeba sie chronic przy takim podejsciu: NIE wystepuje tutaj,
  // bo obie mapy cienia rzutuja z DOKLADNIE tego samego kierunku (ten sam
  // znormalizowany wektor, wspolny cel w (0,0,0)) - kazdy okludent blokuje
  // swiatlo w IDENTYCZNYM miejscu na posadzce w obu mapach, wiec cienie
  // pokrywaja sie geometrycznie, a nie duplikuja pod innym katem. Jedyny
  // efekt nakladania (w promieniu <=5, gdzie obie mapy dzialaja naraz) to
  // PROPORCJONALNIE wieksze przyciemnienie (bo blokowane jest wiecej
  // laczengo swiatla slonca), co jest fizycznie poprawne i spojne z reszta
  // areny. To swiatlo niesie wiekszosc jasnosci slonca (2.3 z 3.1), zeby
  // cienie rekwizytow poza arena byly rownie wyrazne jak na arenie; mapa
  // 4096, bo przy 2048 na +-13.5 cienie drobnych kepek sie rozmywaly.
  const dirWide = new THREE.DirectionalLight(0xfff2d9, 1.6); // obnizone z 2.3 - glowne zrodlo przepalen
  dirWide.position.set(15, 24, 9); // ten sam kierunek co dir (x3), dalej od sceny
  dirWide.castShadow = true;
  dirWide.shadow.mapSize.set(4096, 4096);
  dirWide.shadow.bias = -0.00035;
  dirWide.shadow.normalBias = 0.025;
  dirWide.shadow.radius = 1.6;
  dirWide.shadow.camera.near = 1;
  dirWide.shadow.camera.far = 45;
  // Frustum +-13.5 - z marginesem obejmuje wymagane w zadaniu r<=13 (kepki
  // trawy/gruntu na placu i apronie, klastry rekwizytow do r=7.65+ok.1 na
  // sam rekwizyt, latarnie na obwodnicy r=12.5). Rogi kwadratowego frustum
  // siegaja dalej (13.5*sqrt(2)=~19.1) niz sama "okragla" strefa r<=13, ale to
  // nieszkodliwe - obiekty tam (wysoka zielen/zabudowa, patrz city.js) maja
  // celowo castShadow=false, wiec i tak nie rzucaja cienia, niezaleznie od
  // tego, czy geometrycznie mieszcza sie w tym frustum.
  dirWide.shadow.camera.left = -13.5;
  dirWide.shadow.camera.right = 13.5;
  dirWide.shadow.camera.top = 13.5;
  dirWide.shadow.camera.bottom = -13.5;
  scene.add(dirWide);

  // 3. Zloty reflektor sufitowy (Spotlight) na bankomacie - w nocnej wersji
  // byl GLOWNYM punktem skupienia w ciemnej scenie (intensywnosc 6.5); w
  // dzien slonce+niebo juz same w sobie dobrze oswietlaja automat, wiec to
  // zostaje jako SUBTELNY, cieply akcent (jak wymaga zadanie), nie jako
  // dominujace zrodlo swiatla - stad duzo nizsza intensywnosc.
  const spot = new THREE.SpotLight(0xffd9a0, 0.9, 6.0, Math.PI / 5, 0.5, 1.25); // obnizone z 1.3 - przepalal bankomat
  spot.position.set(0, 4.2, 1.2);
  spot.target.position.copy(LOOK_TARGET);
  scene.add(spot);
  scene.add(spot.target);

  // 4. Neonowy blask Kicka przy posadzce (PointLight) - podobnie jak spot,
  // zostaje jako drobny, kolorowy akcent marki (widoczny z bliska przy
  // automacie), ale mocno przygaszony wzgledem nocnej wersji (2.6 -> 0.5),
  // zeby nie wygladal jak wlaczony neon w pelnym sloncu.
  const neon = new THREE.PointLight(0x53fc18, 0.5, 3.2, 1.4);
  neon.position.set(0, 0.18, 0.45);
  scene.add(neon);

  // Usuniete wzgledem nocnej wersji: chlodne swiatlo kontrowe (rim) i cieple
  // swiatlo wypelniajace bez cieni (fill) - obydwa istnialy WYLACZNIE po to,
  // zeby podniesc dolna granice jasnosci i wydobyc sylwetki z ciemnego,
  // kontrastowego nocnego rigu. W dzien hemi (0.65) + slonce (2.6+0.5) same
  // w sobie oswietlaja arene rownomiernie ze wszystkich stron - dodatkowe
  // swiatla wypelniajace nie wnosilyby nic widocznego, a kazde to kolejny
  // realtime light do policzenia na materialach sceny (patrz raport zadania,
  // sekcja wydajnosc: mniej swiatel = szybszy fragment shader).

  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.target.copy(LOOK_TARGET);
  controls.minDistance = 2.2;
  // Podniesione z 8.5 do 17 (2x) - wlasciciel chcial wyraznie wieksze oddalenie.
  // Geometria tla w city.js (FOREGROUND_TALL_*, BUILDING_KEEPOUT_RADIUS,
  // CITY_HALF, FOG_NEAR/FAR) jest przeliczona pod ta wartosc - patrz komentarze
  // tam, punkt wyjscia to teoretyczny najdalszy promien kamery od (0,0,0):
  // maxDistance + |LOOK_TARGET| = 17 + 0.658 = ~17.66.
  controls.maxDistance = 17;
  controls.minPolarAngle = 0.25;
  controls.maxPolarAngle = Math.PI / 2 - 0.04;
  controls.enablePan = false;
  controls.update();

  window.addEventListener('resize', () => {
    const aspect = window.innerWidth / window.innerHeight;
    applyCameraFraming(camera, aspect);
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  return { renderer, scene, camera, controls, spot, neon };
}

/** Zwraca pierwszy THREE.Mesh znaleziony w scenie GLTF (fence.glb ma dokladnie jeden). */
function firstMesh(gltf) {
  let found = null;
  gltf.scene.traverse((o) => {
    if (!found && o.isMesh) found = o;
  });
  return found;
}

/** Buduje pokój 7x7 ze starannie spasowanymi kafelkami (zero Z-fightingu). */
export async function buildRoom(scene) {
  const SIZE = 7;
  const HALF = Math.floor(SIZE / 2); // 3 (kafle od -3 do +3)

  const [floorGltf, fenceGltf] = await Promise.all([
    loadArcade('floor'), loadForest('fence'),
  ]);

  const group = new THREE.Group();

  // Kafelki podłogi (y = 0, ich wierzch ma grubość y = 0.025) - jasno-
  // brazowa/ciemno-brazowa szachownica (drewno/terakota) zamiast dawnej
  // czarno-bialej (wlasciciel po obejrzeniu areny zmienil zdanie - patrz
  // raport zadania). Oryginalny material floor.glb probkuje WSPOLDZIELONY
  // atlas kolorow mini-arcade (patrz CLAUDE.md - "NIE modyfikuj tej
  // wspoldzielonej tekstury/materialu w miejscu") i to WLASNIE ten atlas byl
  // zrodlem dotychczasowego czarno-bialego wzoru (kazdy kafel probkowal ta
  // sama, drobna, dwutonowa czarno-biala "kratke" z tekstury). Zamiast
  // klonowac ten material (i tak trzeba by nadpisac jego kolor/mape, a
  // czarne pola atlasu * dowolny odcien brazu daja z powrotem czern - proste
  // tonowanie nie dziala), kafelki dostaja DWA NOWE, WLASNE materialy (bez
  // mapy, plaski, cieply kolor + szorstkosc jak reszta modeli Kenney) -
  // atlas/tekstura arcade zostaje kompletnie nietknieta, a kolor areny nie
  // zalezy juz od tego, co jest wypalone w tym pikselu atlasu.
  //
  // Wydajnosc: zamiast 49 osobnych Mesh (49 draw calls, jak w poprzedniej
  // wersji tego pliku - kazdy floorGltf.scene.clone(true) to nowy Object3D
  // niepoddany batchowaniu), kafle to TERAZ dwa InstancedMesh (jasne/ciemne
  // pole) - 2 draw calle zamiast 49 (zmierzone w raporcie zadania).
  const floorMesh = firstMesh(floorGltf);
  const FLOOR_LIGHT = 0xc79a66; // jasny brąz (jasne drewno/terakota)
  const FLOOR_DARK = 0x6b4226; // ciemny brąz (orzech/spieczona terakota)
  const floorLightMat = new THREE.MeshStandardMaterial({ color: FLOOR_LIGHT, roughness: 0.85, metalness: 0.04 });
  const floorDarkMat = new THREE.MeshStandardMaterial({ color: FLOOR_DARK, roughness: 0.85, metalness: 0.04 });

  const floorLightPlacements = [];
  const floorDarkPlacements = [];
  for (let x = -HALF; x <= HALF; x++) {
    for (let z = -HALF; z <= HALF; z++) {
      // Parzystosc na przesunietych do zera wspolrzednych (x+HALF, z+HALF),
      // zeby wzor byl prawdziwa szachownica (naprzemienne pola w obu osiach),
      // a nie pasy.
      const isLight = ((x + HALF) + (z + HALF)) % 2 === 0;
      (isLight ? floorLightPlacements : floorDarkPlacements).push([x, z]);
    }
  }
  const floorDummy = new THREE.Object3D();
  const makeFloorInstanced = (mat, placements) => {
    const inst = new THREE.InstancedMesh(floorMesh.geometry, mat, placements.length);
    inst.castShadow = true;
    inst.receiveShadow = true;
    inst.frustumCulled = false;
    placements.forEach(([x, z], i) => {
      floorDummy.position.set(x, 0, z);
      floorDummy.updateMatrix();
      inst.setMatrixAt(i, floorDummy.matrix);
    });
    inst.instanceMatrix.needsUpdate = true;
    group.add(inst);
    return inst;
  };
  makeFloorInstanced(floorLightMat, floorLightPlacements);
  makeFloorInstanced(floorDarkMat, floorDarkPlacements);

  // Granica areny: plotek kenney_mini-forest (assets/forest/fence.glb) zamiast
  // dawnych scian/naroznikow z mini-arcade (wall.glb/wall-corner.glb).
  //
  // Zmierzony bbox fence.glb (skrypt z CLAUDE.md): x[-0.548,0.548] (dlugosc
  // wzdluz lokalnej osi X), y[0,0.4] (wysokosc), z[-0.1229,0.1229] (grubosc
  // panelu, 0.2458 lacznie). Segment jest szerszy (1.096) niz siatka areny
  // (1.0), wiec 7 segmentow na bok (centra -3..3, jak kafle podlogi) zachodzi
  // na siebie po ok. 0.048 z kazdej strony styku i laczy sie bez szczelin.
  //
  // Granica NIE stoi dokladnie na krawedzi siatki (3.5) tylko w odsunieciu
  // FENCE_OFFSET na zewnatrz. Powod: minigry flagbattle.js/tlumaczenia.js (nie
  // ruszane w tym zadaniu) stawiaja WLASNE plotki z tego samego modelu wokol
  // kontestowanego pola na pozycjach tile+-0.5 - dla pola przy krawedzi areny
  // (np. x=3,z=0) ich plotek wypada dokladnie na x=3.5 z tym samym rot=PI/2,
  // czyli ta sama orientacja i os co nasz rzad wschodni.
  // Zmierzone (przeliczenie transformacji rot.y=PI/2, ta sama metoda co dla
  // minigry): przy sugerowanym w planie odsunieciu 0.12-0.15 (fenceEdge~3.62-
  // 3.65) plotek granicy i plotek minigry NADAL SIE PRZENIKAJA - wewnetrzna
  // (blizsza arenie) sciana naszego plotka wypada na fenceEdge-0.1229, a
  // zewnetrzna sciana plotka minigry na 3.5+0.1229=3.623; przy fenceEdge=3.63
  // to 3.507 < 3.623, czyli zakladanie siatek na ~0.12 j. Dopiero odsuniecie
  // >= ~0.2458+0.03 marginesu (czyli fenceEdge >= 3.78) daje realny przeswit.
  // Uzyte FENCE_OFFSET=0.3 (fenceEdge=3.8) daje ok. 5.4 cm czystego odstepu -
  // zweryfikowane w raporcie zadania (zblizenie + zmierzone wspolrzedne).
  // To ODSTEPSTWO od zaproponowanej w planie wartosci 0.12-0.15 - potrzebne,
  // bo plotek ma realna grubosc (0.2458 j.), nie jest plaskim dekalem.
  const FENCE_OFFSET = 0.3;
  const FENCE_EDGE = HALF + 0.5; // 3.5 - krawedz siatki areny/plotkow minigry
  const fenceEdge = FENCE_EDGE + FENCE_OFFSET; // 3.8
  // Granica lezy poza kaflami podlogi (te siegaja tylko do 3.5), a wiec nad
  // plazą z city.js (CityBackground._buildPlaza). Plac ma tam DWIE
  // powierzchnie: betonowy cokol (PLAZA_TOP_Y=-0.02) i cienka nakladke z
  // trawa/sciezkami tuz nad nim (plazaTopY+0.005 = -0.015, patrz
  // createPlazaGroundTexture w city.js). Podpieramy plotek 0.007 j. NAD TA
  // NAKLADKA (nie dokladnie na niej), zeby nie byc wspolplaszczyznowym z jej
  // gorna powierzchnia, a jednoczesnie nie "wisiec" w powietrzu (odstep
  // niezauwazalny wizualnie).
  const FENCE_Y = -0.008;
  const fenceCenters = [-3, -2, -1, 0, 1, 2, 3];

  // Cala granica (28 segmentow + 4 rogi = 32 instancje) to JEDEN InstancedMesh
  // zamiast 32 osobnych klonow gltf.scene - kazdy klon byl wlasnym draw call,
  // co mierzalnie podbijalo renderer.info.render.calls (zmierzone w raporcie
  // zadania: ~28 dodatkowych wywolan tylko na sam plotek). Ta sama geometria
  // i material (fence.glb ma dokladnie jeden mesh) wiec instancing jest
  // bezpieczny - zero roznicy wizualnej, jeden draw call zamiast 32.
  const fenceMesh = firstMesh(fenceGltf);
  const FENCE_INSTANCE_COUNT = fenceCenters.length * 4 + 4;
  const fenceInst = new THREE.InstancedMesh(fenceMesh.geometry, fenceMesh.material, FENCE_INSTANCE_COUNT);
  fenceInst.castShadow = true;
  fenceInst.receiveShadow = true;
  fenceInst.frustumCulled = false;

  const fenceDummy = new THREE.Object3D();
  let fenceIdx = 0;
  const placeFence = (x, z, ry, scaleX = 1) => {
    fenceDummy.position.set(x, FENCE_Y, z);
    fenceDummy.rotation.set(0, ry, 0);
    fenceDummy.scale.set(scaleX, 1, 1);
    fenceDummy.updateMatrix();
    fenceInst.setMatrixAt(fenceIdx++, fenceDummy.matrix);
  };

  // Rotacje zgodne z konwencja flagbattle.js/tlumaczenia.js (boki wokol pola:
  // dz=+0.5 -> rot=0, dz=-0.5 -> rot=PI, dx=+0.5 -> rot=PI/2, dx=-0.5 ->
  // rot=-PI/2), zeby orientacja tekstury plotka byla spojna w calej grze.
  for (const c of fenceCenters) {
    placeFence(c, fenceEdge, 0); // +Z
    placeFence(c, -fenceEdge, Math.PI); // -Z
    placeFence(fenceEdge, c, Math.PI / 2); // +X
    placeFence(-fenceEdge, c, -Math.PI / 2); // -X
  }

  // Rogi: ostatnie slupki rzedow (koniec segmentu na +-3.548) nie stykaja sie
  // w rogu (+-3.8,+-3.8) - dzieli je ok. 0.36 j. po przekatnej. Domykamy to
  // krotkim segmentem tego samego fence.glb, polozonym STYCZNIE do rogu (po
  // przekatnej miedzy tymi dwoma slupkami) i scisnietym wzdluz lokalnej osi X.
  // Segment ustawiony wzdluz dwusiecznej (atan2(-sz, sx), bez +PI/2) sterczal
  // z rogu na zewnatrz jak ostroga - sprawdzone zrzutem z bliska.
  const FENCE_LEN = 1.096; // zmierzona dlugosc fence.glb wzdluz lokalnej osi X
  const fenceRowEnd = fenceCenters[fenceCenters.length - 1] + FENCE_LEN / 2; // 3.548
  const cornerMid = (fenceEdge + fenceRowEnd) / 2;
  const cornerScaleX = (Math.SQRT2 * (fenceEdge - fenceRowEnd)) / FENCE_LEN + 0.15;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      placeFence(sx * cornerMid, sz * cornerMid, Math.atan2(-sz, sx) + Math.PI / 2, cornerScaleX);
    }
  }

  fenceInst.instanceMatrix.needsUpdate = true;
  group.add(fenceInst);

  // Wizualna siatka 2D na podłodze areny (7x7 pól, każde pole 1.0 x 1.0 m)
  const gridMesh = createFloorGridMesh(SIZE, SIZE);
  // Decyzja estetyczna (wraz z przejsciem podlogi na dzienna, brazowa
  // szachownice powyzej): dawny jaskrawo-zielony NEON (z blurem/glow,
  // pomyslany jako nocny rave-akcent) na cieplym drewnie/terakocie w PELNYM
  // SLONCU wygladalby jak przypadkowa plama farby, nie jak swiadomy element
  // designu - i tak juz nie ma blooma, ktory by go "sprzedal" jako swiatlo
  // (patrz usuniecie UnrealBloomPass w main.js, uzasadnienie w raporcie
  // zadania). Siatka zostaje WIDOCZNA (linie pol nadal pomagaja czytac
  // rozstaw 1x1 pod karty/etykiety minigier), ale STONOWANA i PRZEBARWIONA na
  // cieply, przygaszony zloty - ten sam odcien co akcent bankomatu (spot w
  // scene.js, 0xffd9a0) - zeby czytala sie jako delikatna inkrustacja/fuga w
  // podlodze, a nie jako odrebne, "wlaczone" swiatlo. Bez shadowBlur (glow
  // bez blooma i tak jest tylko rozmytym kwadratem, nie realnym swieceniem).
  group.add(gridMesh);

  scene.add(group);
  return group;
}

/** Tworzy stonowaną, ciepłą siatkę 2D na posadzce z wyrysowanymi kwadratami pól. */
function createFloorGridMesh(size, divisions) {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d');

  ctx.clearRect(0, 0, 1024, 1024);

  const cellSize = 1024 / divisions;

  // Cienka, ciepla zlota ramka pola - fuga/inkrustacja, nie neon (patrz
  // uzasadnienie w buildRoom powyzej). Bez shadowBlur/shadowColor.
  ctx.strokeStyle = 'rgba(255, 217, 160, 0.4)';
  ctx.lineWidth = 3;

  for (let x = 0; x < divisions; x++) {
    for (let y = 0; y < divisions; y++) {
      const rx = x * cellSize;
      const ry = y * cellSize;

      ctx.strokeRect(rx + 2, ry + 2, cellSize - 4, cellSize - 4);
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;

  const geo = new THREE.PlaneGeometry(size, size);
  // polygonOffset przesuwa siatke w buforze glebi w strone kamery niezaleznie od
  // jej fizycznej wysokosci - to samo zabezpieczenie, co przy wskazniku pod zlota
  // moneta (patrz goldcoin.js). Bez niego siatka leżała 0.003 j. nad wierzchem
  // kafla podlogi (0.025) - margines zbyt cienki, zeby bezpiecznie przetrwac
  // na kazdej karcie graficznej przy ruchu kamery.
  const mat = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = -Math.PI / 2;
  // 0.035 zamiast 0.028: wyrazniejszy odstep od wierzchu kafla (0.025), wciaz
  // ponizej wskaznika monety (0.048).
  mesh.position.set(0, 0.035, 0);
  return mesh;
}
