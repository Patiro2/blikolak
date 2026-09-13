// Nakladka "game over" - pokazywana WYLACZNIE gdy pula gracza spadnie do
// zera (lub ponizej) po przegranej rundzie blackjacka z bossem 3 (Dzordzo,
// patrz src/boss-blackjack.js). Ekran plynnie ciemnieje (~1.5 s), potem
// POWOLI (~3 s) pojawia sie duzy czerwony napis "game over dżordżo",
// trzyma sie kilka sekund, na koniec nakladka zanika. Zwraca Promise
// rozwiazywane po pelnym ściemnieniu + napisie - to jest moment, w ktorym
// wolajacy (main.js) ma wykonac reset gry (patrz onGameOver w main.js).
//
// Celowo pojedyncza funkcja bez stanu modulu - kazde wywolanie tworzy (albo
// ponownie uzywa) ten sam DOM element, wiec wywolanie w trakcie poprzedniej
// animacji po prostu ja przerywa i zaczyna od nowa (nie powinno sie zdarzyc
// w praktyce - game over konczy walke, ale zabezpieczenie jest tanie).

let overlayEl = null;
let textEl = null;

function zapewnijDOM() {
  if (overlayEl) return;
  overlayEl = document.createElement('div');
  overlayEl.id = 'game-over-overlay';
  textEl = document.createElement('div');
  textEl.id = 'game-over-tekst';
  textEl.textContent = 'game over dżordżo';
  overlayEl.appendChild(textEl);
  document.body.appendChild(overlayEl);
}

/**
 * Pokazuje pelny cykl game over. Rozwiazuje Promise DOKLADNIE w momencie, gdy
 * ekran jest juz w calosci czarny i napis w pelni widoczny - main.js wykonuje
 * reset gry dopiero PO tym momencie (widz nie ma zobaczyc migniecia resetu
 * na jasnym tle). Nakladka sama zanika po kilku sekundach, niezaleznie od
 * tego, co wolajacy zrobi z rozwiazanym Promise.
 */
export function pokazGameOver() {
  zapewnijDOM();

  // reflow, zeby przejscia CSS zawsze wystartowaly od nowa (dokladnie jak
  // przy letterboxie/karcie tytulowej bossa w boss.js)
  overlayEl.classList.remove('zanika');
  void overlayEl.offsetWidth;
  overlayEl.classList.add('ciemno');
  textEl.classList.remove('show');

  return new Promise((resolve) => {
    // Ekran ciemnieje ~1.5s (patrz transition w style.css) - dopiero potem
    // zaczyna sie pojawiac napis.
    setTimeout(() => {
      void textEl.offsetWidth;
      textEl.classList.add('show');
      // Napis pojawia sie powoli (~3s, patrz transition #game-over-tekst.show)
      setTimeout(() => {
        resolve();
        // Napis trzyma sie kilka sekund w pelni widoczny, potem cala
        // nakladka zanika i znika calkowicie.
        setTimeout(() => {
          overlayEl.classList.remove('ciemno');
          overlayEl.classList.add('zanika');
          textEl.classList.remove('show');
        }, 3500);
      }, 3000);
    }, 1500);
  });
}
