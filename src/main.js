import * as THREE from 'three';
import { createScene, buildRoom } from './scene.js';
import { preloadAll, setTextureQuality } from './assets.js';
import { Machine } from './machine.js';
import { WorkerManager, parseMovementDirection } from './workers.js';
import { CoinPool } from './coins.js';
import { GoldenCoinManager } from './goldcoin.js';
import { Economy, WORKER_TYPE_DEFS, MACHINE_TIERS, SAVE_KEY } from './economy.js';
import { remote, czyLokalnie } from './remote.js';
import { LEADERBOARD_KEY, ASSIGNMENTS_KEY } from './kick.js';
import { UI, KickUI, LeaderboardUI, WorkerOverlayManager, VanessaLogUI } from './ui.js';
import { KickChatClient } from './kick.js';
import { VanessaManager, showTopAnnouncement } from './vanessa.js';
import { BossManager, BOSS_DEFS } from './boss.js';
import { fmtShort } from './format.js';
import { CityBackground } from './city.js';
import { audio } from './audio.js';

async function main() {
  const canvas = document.getElementById('scene');
  const { renderer, scene, camera, controls } = createScene(canvas);

  // Stan gry z serwera (Vercel KV) ma pierwszenstwo przed localStorage.
  // Economy i KickChatClient czytaja localStorage w konstruktorach, wiec
  // najpierw wsiewamy tam to, co przyszlo z serwera. Gdy API nie odpowiada
  // (np. lokalne serve.py), zostaje dotychczasowe zachowanie z localStorage.
  const stanZdalny = await remote.zainicjuj().catch(() => null);
  // Sekcja "boss" nie idzie przez localStorage (economy/leaderboard/assignments
  // wystarcza to zrobic, bo Economy/KickChatClient czytaja je w konstruktorach) -
  // walka z bossem jest aplikowana rownolegle po zbudowaniu BossManager nizej.
  const poczatkowyStanBossa = stanZdalny ? stanZdalny.boss : null;
  if (stanZdalny) {
    try {
      if (stanZdalny.economy) localStorage.setItem(SAVE_KEY, JSON.stringify(stanZdalny.economy));
      if (stanZdalny.leaderboard) localStorage.setItem(LEADERBOARD_KEY, JSON.stringify(stanZdalny.leaderboard));
      if (stanZdalny.assignments) localStorage.setItem(ASSIGNMENTS_KEY, JSON.stringify(stanZdalny.assignments));
      console.info('[stan] Wczytano stan gry z serwera');
    } catch (err) {
      console.warn('[stan] Nie udalo sie wsiac stanu z serwera do localStorage:', err);
    }
  }

  const economy = new Economy();

  // Preload dzwiekow leci w tle - main() NIE czeka na niego (patrz audio.js).
  // Ewentualny blad pojedynczego pliku jest tam obslugiwany osobno i nie moze
  // przerwac reszty preloadu ani startu gry.
  audio.preload().catch((err) => console.warn('[audio] Blad preloadu dzwiekow:', err));

  // Jakosc filtrowania tekstur musi byc znana PRZED zaladowaniem modeli -
  // fixMaterials nadaje anizotropie w chwili ladowania (patrz assets.js).
  setTextureQuality(renderer);

  await preloadAll();
  await buildRoom(scene);

  // Miasto w tle - wokol i ponizej areny (patrz src/city.js). Zbudowane
  // WYLACZNIE z prymitywow Three.js (InstancedMesh), bo zaden z pakietow
  // Kenney w projekcie nie ma modeli budynkow/ulic/samochodow. Arena
  // pozostaje bez zmian - miasto tylko dobudowuje otoczenie wokol niej.
  const city = new CityBackground();
  city.build(scene, renderer);

  const machine = new Machine(scene, camera, renderer.domElement);
  await machine.setTier(economy.state.machineTier);

  const workerManager = new WorkerManager(scene);

  // Kazdy z 10 slotow rankingu Top 10 ma stala "role" (patrz WORKER_TYPE_DEFS).
  // Awatar pojawia sie w scenie dokladnie raz, gdy ktos zajmie dany slot.
  async function ensureWorkerType(slotIndex) {
    const def = WORKER_TYPE_DEFS[slotIndex];
    if (!def) return;
    await workerManager.addWorkerType(slotIndex, def.modelKey);
  }

  const coinPool = new CoinPool(scene);
  await coinPool.init();

  const goldCoin = new GoldenCoinManager(scene);
  await goldCoin.init();

  const vanessa = new VanessaManager(
    scene,
    camera,
    machine,
    economy,
    coinPool,
    (point, text, opts) => {
      projectAndFloat(point, text, opts);
    },
    (username, reward, color) => {
      // Nagroda za przepedzenie Vanessy to odzyskana kwota, NIE swiezy
      // zarobek - inaczej dodrukowalibysmy pieniadze (patrz kickChat).
      kickChat.creditRecoveredMoney(username, reward, color);
    }
  );
  await vanessa.init();

  // Panel z logiem zdarzen Vanessy - kazde zdarzenie dopisuje sie na biezaco.
  const vanessaLogUI = new VanessaLogUI(vanessa);
  vanessa.onLog = (entry) => {
    if (entry === null) vanessaLogUI.renderAll([]);
    else vanessaLogUI.append(entry);
  };

  // Dzwiek "ui-klik" dla kazdego przycisku w pasku HUD (delegacja zdarzen -
  // obejmuje tez przyszle przyciski, np. wyciszenie/glosnosc, bez dopisywania
  // osobnego listenera do kazdego z osobna).
  const hudButtonsBar = document.getElementById('hud-top-left-buttons');
  if (hudButtonsBar) {
    hudButtonsBar.addEventListener('click', (e) => {
      if (e.target.closest('button')) audio.play('ui-klik');
    });
  }

  // Sterowanie dzwiekiem: przycisk wyciszenia + suwak glosnosci. Stan (glosnosc,
  // wyciszenie) zyje w AudioManager i zapisuje sie sam do localStorage (patrz audio.js).
  const muteBtn = document.getElementById('btn-mute');
  const volumeSlider = document.getElementById('volume-slider');
  if (volumeSlider) {
    volumeSlider.value = String(Math.round(audio.getVolume() * 100));
  }
  function refreshAudioUI() {
    if (muteBtn) muteBtn.textContent = audio.isMuted() ? '🔇' : '🔊';
  }
  refreshAudioUI();
  if (muteBtn) {
    muteBtn.addEventListener('click', () => {
      audio.toggleMuted();
      refreshAudioUI();
    });
  }
  if (volumeSlider) {
    volumeSlider.addEventListener('input', () => {
      audio.setVolume(Number(volumeSlider.value) / 100);
      // Ruszanie suwakiem przy wyciszeniu ma sens tylko jesli od razu odciszamy -
      // inaczej uzytkownik przesuwa suwak i nic nie slyszy, myslac ze suwak nie dziala.
      if (audio.isMuted()) {
        audio.setMuted(false);
        refreshAudioUI();
      }
    });
  }

  const spawnVanessaBtn = document.getElementById('btn-spawn-vanessa');
  if (spawnVanessaBtn) {
    spawnVanessaBtn.addEventListener('click', () => {
      // Straz niezalezna od ukrycia przycisku w CSS - ukrycie jest kosmetyka,
      // a to jest faktyczny warunek wykonania akcji.
      if (!remote.czyAdmin()) return;
      vanessa.spawn(true);
    });
  }

  // Zapis na serwer leci tylko z sesji admina i nie czesciej niz co
  // ZAPIS_ZDALNY_MS - lokalny zapis do localStorage zostaje bez zmian, wiec
  // nawet przy padnietym API nic sie nie gubi.
  const ZAPIS_ZDALNY_MS = 5000;
  let ostatniZapisZdalny = 0;
  let zapisZdalnyWToku = false;

  function zbierzStan() {
    return {
      economy: economy.state,
      leaderboard: kickChat.leaderboard,
      assignments: kickChat.assignments,
      boss: boss.getSyncState(),
    };
  }

  async function zapiszNaSerwer(wymus = false) {
    if (!remote.czyOnline() || !remote.czyAdmin()) return;
    const teraz = Date.now();
    if (!wymus && teraz - ostatniZapisZdalny < ZAPIS_ZDALNY_MS) return;
    if (zapisZdalnyWToku) return;
    zapisZdalnyWToku = true;
    ostatniZapisZdalny = teraz;
    try {
      await remote.zapisz(zbierzStan());
    } catch (err) {
      console.warn('[stan] Nie udalo sie zapisac stanu na serwerze:', err);
    } finally {
      zapisZdalnyWToku = false;
    }
  }

  function save() {
    economy.save();
    kickChat.flush();
    zapiszNaSerwer();
  }

  /**
   * Tryb widza: stan na serwerze prowadzi admin, wiec co jakis czas dociagamy
   * go i nadpisujemy to, co lokalnie nasymulowala ta karta.
   */
  async function synchronizujZSerwera() {
    if (!remote.czyOnline() || remote.czyAdmin()) return;
    const stan = await remote.pobierz();
    if (!stan) return;
    if (stan.economy) Object.assign(economy.state, stan.economy);
    if (stan.leaderboard) kickChat.leaderboard = stan.leaderboard;
    if (stan.assignments) kickChat.assignments = stan.assignments;
    kickChat.updateAssignments();
    if (machine.currentTier !== economy.state.machineTier) {
      await machine.setTier(economy.state.machineTier);
    }
    // Stan walki z bossem - widz, ktory wchodzi w trakcie walki, podejmuje ja
    // bez cutscenki z tym samym hp i tym samym rownaniem (patrz boss.applySync).
    if (stan.boss) {
      boss.applySync(stan.boss);
    }
    try {
      await syncLeaderboardAndOverlays();
    } catch (err) {
      console.error('[stan] Blad odswiezania po synchronizacji:', err);
    }
  }

  const clock = new THREE.Clock();
  const machineBurstOrigin = new THREE.Vector3(0, 0.6, 0.3);

  // Dzwiek kombo ma grac TYLKO na progach co 5 stopni ("kombo x10", "x15"...),
  // nie przy kazdym klikniecu - inaczej przy zywym czacie zlewaloby sie w szum.
  // Sledzimy ostatni osiagniety prog (podloga combo/5) i gramy tylko przy zmianie.
  let lastComboTier = 0;
  function maybePlayComboSound(combo) {
    if (combo <= 0) {
      lastComboTier = 0;
      return;
    }
    const tier = Math.floor(combo / 5);
    if (tier > 0 && tier !== lastComboTier) {
      lastComboTier = tier;
      audio.play('kombo');
    }
  }

  // Wspolny baner awansu bankomatu - uzywany zarowno przy zwyklym awansie,
  // jak i po pokonaniu bossa (patrz onDefeated ponizej), zeby tekst zyl w JEDNYM miejscu.
  function announceTierAdvance(tier) {
    const def = MACHINE_TIERS[tier];
    audio.play('awans-bankomatu');
    showTopAnnouncement(
      '🎰 AWANS BANKOMATU!',
      `Czat wbił już <strong>${economy.state.totalChatClicks}</strong> klików - bankomat awansuje na <strong>${def.name}</strong> (×${def.mult} zarobku)!`,
      3400,
    );
  }

  const boss = new BossManager(
    scene,
    camera,
    controls,
    machine,
    economy,
    coinPool,
    (point, text, opts) => {
      projectAndFloat(point, text, opts);
    },
  );
  await boss.init();

  // --- Tryb admina -------------------------------------------------------
  // Offline (brak API) gra dziala jak dotad, z pelnymi uprawnieniami. Na
  // Vercelu przyciski resetu i spawnowania widzi tylko zalogowany wlasciciel,
  // a kazdy zapis i tak jest sprawdzany po stronie serwera.
  const adminBtn = document.getElementById('btn-admin');

  function zastosujTrybAdmina() {
    const admin = remote.czyAdmin();
    document.body.classList.toggle('tryb-widza', !admin);
    if (!adminBtn) return;
    if (czyLokalnie()) {
      // Lokalnie nie ma sie gdzie logowac - chowamy przycisk.
      adminBtn.style.display = 'none';
      return;
    }
    adminBtn.style.display = '';
    adminBtn.classList.toggle('zalogowany', admin);
    adminBtn.textContent = admin ? '🔓 Wyloguj' : '🔑 Zaloguj';
    adminBtn.title = admin
      ? 'Jesteś zalogowany jako właściciel - kliknij, żeby się wylogować'
      : 'Zaloguj się hasłem właściciela, żeby móc resetować grę i spawnować';
  }

  if (adminBtn) {
    adminBtn.addEventListener('click', async () => {
      if (remote.czyAdmin()) {
        remote.wyloguj();
        zastosujTrybAdmina();
        return;
      }
      const haslo = window.prompt('Hasło właściciela gry:');
      if (haslo === null) return;
      const ok = await remote.zaloguj(haslo);
      if (!ok) {
        window.alert('Błędne hasło.');
        return;
      }
      zastosujTrybAdmina();
      zapiszNaSerwer(true);
    });
  }
  zastosujTrybAdmina();

  const spawnBossBtn = document.getElementById('btn-spawn-boss');
  if (spawnBossBtn) {
    spawnBossBtn.addEventListener('click', () => {
      if (!remote.czyAdmin()) return;
      boss.start(1, { force: true });
    });
  }

  const kickUI = new KickUI();
  const leaderboardUI = new LeaderboardUI();
  const workerOverlays = new WorkerOverlayManager();
  let ui;

  let isSyncingLeaderboard = false;
  let hasQueuedSync = false;

  // Uwaga (naprawa deadlocka): flaga isSyncingLeaderboard NIGDY nie moze
  // zostac zablokowana na true. Caly korpus idzie przez try/catch/finally,
  // blad pojedynczego slotu (np. chwilowy blad sieci przy ladowaniu modelu)
  // jest lapany osobno i tylko logowany, a kolejne zapytania o sync sa
  // obslugiwane petla `while`, NIE rekurencyjnym wywolaniem z `finally`
  // (rekurencja pod nieudanym promise'em uciekala jako unhandled rejection
  // i zostawiala flage zablokowana).
  async function syncLeaderboardAndOverlays() {
    if (isSyncingLeaderboard) {
      hasQueuedSync = true;
      return;
    }
    isSyncingLeaderboard = true;
    try {
      do {
        hasQueuedSync = false;
        try {
          kickChat.updateAssignments();
          for (let slot = 0; slot < 10; slot++) {
            try {
              const user = kickChat.getUserForWorker(slot);
              workerOverlays.updateWorkerUser(slot, user);
              if (user) {
                await ensureWorkerType(slot);
              }
            } catch (slotErr) {
              // Blad pojedynczego slotu (np. zerwane polaczenie przy ladowaniu
              // modelu postaci) nie moze przerwac przetwarzania pozostalych slotow.
              console.error(`[sync] Blad przy synchronizacji slotu ${slot}:`, slotErr);
            }
          }
          leaderboardUI.render(kickChat.getTopEarners(10), (s) => WORKER_TYPE_DEFS[s]?.name, kickChat);
        } catch (err) {
          console.error('[sync] Blad synchronizacji rankingu i awatarow:', err);
        }
      } while (hasQueuedSync);
    } finally {
      isSyncingLeaderboard = false;
    }
  }

  const kickChat = new KickChatClient({
    chatroomId: 37663,
    channelName: 'patiro',
    onStatusChange: ({ status, message, stats }) => {
      kickUI.updateStatus(status, message);
      kickUI.updateKliksCount(stats.kliksReceived);
    },
    onMessage: (msg) => {
      kickUI.addMessage(msg);
      // Sprawdzenie czy widz na czacie napisał sekretne hasło Vanessy
      vanessa.checkChatWord(msg.content, msg.username, msg.color);
      // Odpowiedzi na dzialania matematyczne bossa oraz komenda "pomoc" (omdlenia)
      boss.onChatMessage(msg.username, msg.content, msg.color);
      // Chodzenie po siatce 2D areny - tylko dla aktywnych graczy w grze (Top 10)
      const moveDir = parseMovementDirection(msg.content);
      if (moveDir) {
        const slot = kickChat.getWorkerForUser(msg.username);
        if (
          slot !== null &&
          (!boss.isFainted || !boss.isFainted(msg.username)) &&
          (!vanessa.isStealingFrom || !vanessa.isStealingFrom(msg.username))
        ) {
          workerManager.moveWorker(slot, moveDir);
        }
      }
    },
    onTopWorkerChat: ({ workerIndex, content }) => {
      // Komendy ruchu nie powinny wyzwalać animacji uderzenia w bankomat ani dymków
      if (parseMovementDirection(content)) return;

      const clean = (content || '')
        .replace(/(?:^|\s)[!/]*klik+[!.,?*~]*(?=\s|$)/gi, '')
        .replace(/(?:^|\s)[!/]*click+[!.,?*~]*(?=\s|$)/gi, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
      if (!clean) return;

      workerOverlays.showSpeechBubble(workerIndex, clean);
      const entry = workerManager.getWorkerType(workerIndex);
      if (entry && !entry.isFainted && !entry.isMoving) {
        workerManager.triggerInteract(entry);
      }
    },
    onKlik: async (sender, chatItem) => {
      const nick = sender.username || 'Widz';

      // Omdlony przez bossa widz nie moze klikac - jego komenda jest w calosci
      // ignorowana (bez kasy, bez licznika klikow, bez wplywu na prog tieru).
      if (boss.isFainted(nick)) {
        return;
      }

      // id wiadomosci czatu, ktora wywolala klik - zakotwicza losowanie krytyka
      // (patrz economy.performClick), zeby kazda otwarta karta gry, widzac ta
      // sama wiadomosc z tego samego kanalu Kicka, wylosowala ten sam wynik.
      const { value, isCrit, combo, tierAdvanced } = economy.performClick(
        performance.now(),
        true,
        chatItem && chatItem.id,
      );
      machine.triggerClickAnim();
      audio.play('klik');
      if (isCrit) audio.play('kryt');
      maybePlayComboSound(combo);
      coinPool.burst(machineBurstOrigin, value);
      const text = isCrit ? `KRYT! +${fmtShort(value)} (@${nick})` : `+${fmtShort(value)} (@${nick})`;
      projectAndFloat(machineBurstOrigin, text, { crit: isCrit, kick: true });
      kickUI.updateKliksCount(kickChat.stats.kliksReceived);

      // Rejestracja wygenerowanego zarobku w rankingu widzów (automatycznie wywołuje onLeaderboardUpdate)
      kickChat.recordEarned(nick, value, sender.identity?.color);

      // Jeśli klikający widz ma przypisanego pracownika, wywołujemy również jego animację uderzenia w bankomat
      const assignedSlot = kickChat.getWorkerForUser(nick);
      if (assignedSlot !== null) {
        const entry = workerManager.getWorkerType(assignedSlot);
        if (entry) {
          workerManager.triggerInteract(entry);
        }
      }

      // Automatyczny awans tieru automatu - gdy laczna liczba klikniec z czatu
      // przekroczy kolejny prog (patrz MACHINE_TIER_CLICK_THRESHOLDS w economy.js).
      if (tierAdvanced !== null) {
        const def_ = BOSS_DEFS[tierAdvanced];
        const alreadyDefeated = economy.state.bossesDefeated.includes(tierAdvanced);
        if (def_ && !alreadyDefeated) {
          // Boss przejmuje kontrole - awans bankomatu i baner wykonaja sie
          // dopiero po pokonaniu go (patrz onDefeated w setContext powyzej).
          boss.start(tierAdvanced);
        } else {
          await machine.setTier(tierAdvanced);
          announceTierAdvance(tierAdvanced);
          save();
        }
      }
    },
    onLeaderboardUpdate: () => {
      syncLeaderboardAndOverlays().catch((err) => {
        console.error('[sync] Nieobsluzony blad w syncLeaderboardAndOverlays (onLeaderboardUpdate):', err);
      });
    },
  });
  workerManager.setContext({ boss, vanessa });
  vanessa.setContext({ workerManager, kickChat });
  boss.setContext({
    workerManager,
    workerOverlays,
    kickChat,
    vanessa,
    onDefeated: async (tier) => {
      await machine.setTier(tier);
      announceTierAdvance(tier);
      showTopAnnouncement(
        '🏆 KAMIL KOVALENKO POKONANY!',
        `Boss <strong>${boss.def ? boss.def.name : 'Kamil Kovalenko'}</strong> został pokonany przez czat! Bankomat wraca do gry na nowym tierze.`,
        3200,
      );
      if (!economy.state.bossesDefeated.includes(tier)) {
        economy.state.bossesDefeated.push(tier);
      }
      save();
    },
  });
  goldCoin.setContext({
    workerManager,
    kickChat,
    economy,
    coinPool,
    projectAndFloat,
    save,
  });

  // Widz otwierajacy karte w trakcie walki z bossem podejmuje ja od razu, bez
  // cutscenki, z tym samym hp/licznikami co u admina (patrz boss.applySync).
  // Admin sam prowadzi walke lokalnie - u niego to by ja nadpisalo.
  if (!remote.czyAdmin() && poczatkowyStanBossa) {
    boss.applySync(poczatkowyStanBossa);
  }

  try {
    await syncLeaderboardAndOverlays();
  } catch (err) {
    console.error('[sync] Nieobsluzony blad w syncLeaderboardAndOverlays (start):', err);
  }
  kickChat.connect();

  ui = new UI(economy, {
    onReset: async () => {
      if (!remote.czyAdmin()) return;
      economy.reset();
      kickChat.reset();
      kickUI.updateKliksCount(0);
      workerOverlays.clear();
      workerManager.clear();
      vanessa.reset();
      boss.reset();
      await machine.setTier(0);
      try {
        await syncLeaderboardAndOverlays();
      } catch (err) {
        console.error('[sync] Nieobsluzony blad w syncLeaderboardAndOverlays (onReset):', err);
      }
      // Reset kasuje takze stan na serwerze - inaczej po odswiezeniu strony
      // wrocilby stary zapis z KV.
      if (remote.czyOnline() && remote.czyAdmin()) {
        await remote.wyczysc();
      }
      save();
      zapiszNaSerwer(true);
    },
  });

  const projected = new THREE.Vector3();
  function projectAndFloat(point, text, opts) {
    projected.copy(point);
    projected.project(camera);
    const rect = canvas.getBoundingClientRect();
    const sx = rect.left + (projected.x * 0.5 + 0.5) * rect.width;
    const sy = rect.top + (-projected.y * 0.5 + 0.5) * rect.height;
    ui.spawnFloater(text, sx, sy, opts);
  }

  machine.onClickHit = (point) => {
    // Klik streamera bezposrednio w model 3D - dolicza kase do wspolnej puli,
    // ale NIE liczy sie do progu awansu tieru (ten napedza wylacznie czat).
    const { value, isCrit } = economy.performClick(performance.now(), false);
    audio.play('klik-gracz');
    if (isCrit) audio.play('kryt');
    coinPool.burst(point, value);
    const text = isCrit ? `KRYT! +${fmtShort(value)}` : `+${fmtShort(value)}`;
    projectAndFloat(point, text, { crit: isCrit });
  };

  // Ekspozycja do debugowania/weryfikacji w konsoli przeglądarki.
  window.__game = {
    audio,
    economy,
    machine,
    workerManager,
    coinPool,
    goldCoin,
    vanessa,
    boss,
    ui,
    kickChat,
    kickUI,
    leaderboardUI,
    workerOverlays,
    vanessaLogUI,
    syncLeaderboardAndOverlays,
    save,
    scene,
    camera,
    renderer,
    city,
  };

  function animate() {
    requestAnimationFrame(animate);
    const delta = Math.min(0.1, clock.getDelta());

    // W trakcie cutscenki bossa kamera jest w pelni pod jego kontrola -
    // controls.update() nadpisalby recznie ustawiona pozycje (OrbitControls
    // zawsze przelicza kamere z wewnetrznego stanu sferycznego, ignorujac
    // reczne zmiany camera.position).
    if (!boss.isCameraLocked()) {
      controls.update();
    }
    vanessa.paused = boss.isActive();
    machine.update(delta);
    workerManager.update(delta);
    coinPool.update(delta);
    goldCoin.update(delta);
    city.update(delta);

    // Brak dochodu pasywnego - zl powstaja WYLACZNIE z klikniec.
    // Awatary Top 10 animuja sie tylko wtedy, gdy ich widz naprawde napisze
    // "klik" na czacie (obsluga w onKlik ponizej), wiec animacja zawsze
    // odpowiada realnemu klikniecu, a nie tyka sama z siebie.

    // Ceny i wyszarzenie przyciskow odswiezaja sie w refreshNumbers (co 100 ms)
    // bez przebudowy DOM.
    ui.refreshNumbers(performance.now());

    const canvasRect = canvas.getBoundingClientRect();

    // Aktualizacja złodziejki Vanessy (ruch, animacja, kradzież, rzutowanie dymków i plakietki)
    vanessa.update(delta, camera, canvasRect);

    // Aktualizacja bossa (cutscenka, walka matematyczna, omdlenia, rzutowanie plakietki i dymka)
    boss.update(delta, camera, canvasRect);

    // Aktualizacja pozycji plakietek z nickami i dymków czatu nad głowami pracowników w rzucie 3D -> 2D
    workerOverlays.updatePositions(workerManager.entries, camera, canvasRect);

    renderer.render(scene, camera);
  }
  animate();

  setInterval(save, 5000);
  // Widzowie (bez hasla admina) co 10 s dociagaja stan prowadzony przez admina.
  setInterval(() => {
    synchronizujZSerwera().catch((err) => console.warn('[stan] Blad synchronizacji:', err));
  }, 10000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') save();
  });
  window.addEventListener('beforeunload', save);
}

main().catch((err) => {
  console.error('Blad startu gry:', err);
});
