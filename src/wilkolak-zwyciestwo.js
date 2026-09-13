// Pelnoekranowy ekran zwyciestwa po pokonaniu Wilkolaka (boss tieru 5,
// ostatni boss - patrz spec-wilkolak.md "ZWYCIESTWO"). W ODROZNIENIU od
// pokazGameOver() (src/gameover.js) NIE konczy sie automatycznym resetem gry
// - to koniec calej sciezki bossow, wiec gra ma po prostu stac, a wlasciciel
// dalej ma dostep do panelu deweloperskiego (przycisk "Reset gry" w HUD
// dziala niezaleznie, patrz main.js). Ekran zamyka wylacznie widz/wlasciciel
// klikajac "Zamknij".
//
// Celowo pojedynczy modul-singleton (jeden element DOM na cala karte gry),
// dokladnie jak gameover.js - ten ekran pojawia sie raz na cala rozgrywke.

let overlayEl = null;
let tabelaEl = null;

function zapewnijDOM() {
  if (overlayEl) return;
  overlayEl = document.createElement('div');
  overlayEl.id = 'wilkolak-zwyciestwo-overlay';

  const karta = document.createElement('div');
  karta.className = 'wilkolak-zwyciestwo-karta';

  const tytul = document.createElement('div');
  tytul.className = 'wilkolak-zwyciestwo-tytul';
  tytul.textContent = '🏆 MYŚLIBÓRZ URATOWANY!';
  karta.appendChild(tytul);

  const podtytul = document.createElement('div');
  podtytul.className = 'wilkolak-zwyciestwo-podtytul';
  podtytul.textContent = 'Wilkołak pokonany - czat obronił bankomat do końca. Ranking końcowy:';
  karta.appendChild(podtytul);

  tabelaEl = document.createElement('div');
  tabelaEl.className = 'wilkolak-zwyciestwo-tabela';
  karta.appendChild(tabelaEl);

  const zamknij = document.createElement('button');
  zamknij.className = 'wilkolak-zwyciestwo-zamknij';
  zamknij.textContent = 'Zamknij';
  zamknij.addEventListener('click', () => ukryjZwyciestwoWilkolaka());
  karta.appendChild(zamknij);

  overlayEl.appendChild(karta);
  document.body.appendChild(overlayEl);
}

/**
 * Pokazuje ekran zwyciestwa z tabela Top 10. `top10` - wynik
 * `kickChat.getTopEarners(10)` (lista {username, totalEarned, ...}, patrz
 * src/kick.js) - formatowanie kwoty jak w rankingu na boku (fmtShort).
 */
export function pokazZwyciestwoWilkolaka(top10, fmtShort) {
  zapewnijDOM();
  tabelaEl.innerHTML = '';
  const lista = Array.isArray(top10) ? top10 : [];
  if (lista.length === 0) {
    const pusto = document.createElement('div');
    pusto.className = 'wilkolak-zwyciestwo-pusto';
    pusto.textContent = 'Brak graczy w rankingu.';
    tabelaEl.appendChild(pusto);
  } else {
    lista.forEach((u, i) => {
      const wiersz = document.createElement('div');
      wiersz.className = 'wilkolak-zwyciestwo-wiersz';
      const miejsce = i + 1;
      const medal = miejsce === 1 ? '🥇' : miejsce === 2 ? '🥈' : miejsce === 3 ? '🥉' : `#${miejsce}`;
      wiersz.innerHTML = `<span class="miejsce">${medal}</span><span class="nick">${u.username}</span><span class="kwota">${fmtShort ? fmtShort(u.totalEarned) : Math.round(u.totalEarned)} zł</span>`;
      tabelaEl.appendChild(wiersz);
    });
  }

  void overlayEl.offsetWidth; // reflow - przejscie CSS zawsze startuje od nowa
  overlayEl.classList.add('show');
}

export function ukryjZwyciestwoWilkolaka() {
  if (overlayEl) overlayEl.classList.remove('show');
}
