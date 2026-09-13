// Samouczek dla nowych widzow strumienia. Modul samowystarczalny: sam buduje
// swoj DOM, sam czyta/pisze localStorage, nie dotyka main.js ani style.css,
// bo rownolegle inny agent pracuje nad boss.js/main.js/style.css i nie wolno
// mi z nim kolidowac. Tutorial nie czyta stanu gry, wiec nie ma powodu, zeby
// byl z nia spleciony.

const STORAGE_KEY = 'bankomat-clicker-tutorial-widziany';

// localStorage w trybie prywatnym (Safari itp.) potrafi rzucic wyjatkiem przy
// odczycie/zapisie - kazde uzycie owijamy w try/catch, zeby nigdy nie wywalilo
// to reszty strony.
function odczytajCzyWidziany() {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch (e) {
    return false;
  }
}

function zapiszJakoWidziany() {
  try {
    localStorage.setItem(STORAGE_KEY, '1');
  } catch (e) {
    // brak localStorage (tryb prywatny) - trudno, po prostu przy kazdej
    // wizycie tutorial pokaze sie od nowa.
  }
}

// Tresc oparta wylacznie o fakty z kodu gry - bez zgadywania liczb i bez
// jednego slowa o bossach/minigrach niespodziankach (celowe wymaganie
// wlasciciela: widzowie maja to odkryc sami na streamie).
const SEKCJE = [
  {
    tytul: 'Klikanie',
    akapity: [
      'Każda wiadomość na czacie Kicka to kliknięcie w bankomat - nieważne co napiszesz.',
      'Jedno kliknięcie to na start <b>1 zł</b> - kwota rośnie wraz z ulepszaniem bankomatu.',
      '<b>5%</b> szans na trafienie krytyczne, które daje <b>3x</b> więcej.',
      '<b>Kombo</b>: kliknięcia z czatu w odstępie do 0,7 s nabijają mnożnik - +4% za stopień, maksymalnie +100%.',
    ],
  },
  {
    tytul: 'Bankomat',
    akapity: [
      'Im więcej kliknięć uzbiera cały czat, tym bankomat awansuje na lepszy model, a każde kolejne kliknięcie jest warte więcej.',
    ],
  },
  {
    tytul: 'Złota moneta',
    akapity: [
      'Co jakiś czas na losowym polu areny pojawia się złota moneta warta <b>25 zł</b>.',
      'Zgarnia ją pierwsza postać z Top 10, która do niej dobiegnie.',
    ],
  },
  {
    tytul: 'Poruszanie się',
    akapity: [
      'Tylko gracze z <b>Top 10</b> mają swoją postać na arenie i tylko oni mogą nią ruszać.',
      'Ruch o jedno pole komenda na czacie: <code>w</code>/<code>a</code>/<code>s</code>/<code>d</code>, <code>gora</code>/<code>dol</code>/<code>lewo</code>/<code>prawo</code>, <code>up</code>/<code>down</code>/<code>left</code>/<code>right</code>, <code>przod</code>/<code>tyl</code>, a także dłuższe formy jak "w lewo" czy "krok w gore".',
    ],
  },
  {
    tytul: 'Top 10',
    akapity: [
      'Ranking układa się według sumy zarobionych złotówek, nie liczby kliknięć.',
      'Wejście do Top 10 daje własną postać-pracownika na arenie, z plakietką z nickiem - przypisaną na stałe, aż ktoś wypadnie poza dziesiątkę.',
    ],
  },
  {
    tytul: 'Vanessa',
    akapity: [
      'Czasem na arenę zakrada się złodziejka i podkrada złotówki jednemu z graczy z Top 10.',
      'Nad ekranem widać wtedy hasło - kto pierwszy napisze je na czacie, przegania ją i dostaje nagrodę. Może to zrobić każdy z czatu, nie tylko gracze z Top 10.',
    ],
  },
];

function zbudujDom() {
  const panel = document.createElement('div');
  panel.id = 'tutorial-panel';

  const header = document.createElement('div');
  header.id = 'tutorial-header';

  const title = document.createElement('div');
  title.id = 'tutorial-title';
  title.textContent = '📖 Jak grać?';

  const toggleBtn = document.createElement('button');
  toggleBtn.id = 'tutorial-toggle-btn';
  toggleBtn.type = 'button';

  header.appendChild(title);
  header.appendChild(toggleBtn);

  const body = document.createElement('div');
  body.id = 'tutorial-body';

  for (const sekcja of SEKCJE) {
    const sec = document.createElement('div');
    sec.className = 'tutorial-section';

    const h3 = document.createElement('h3');
    h3.textContent = sekcja.tytul;
    sec.appendChild(h3);

    for (const akapit of sekcja.akapity) {
      const p = document.createElement('p');
      // Tresc jest stala, wpisana w kodzie wyzej (nie pochodzi od uzytkownika
      // ani z sieci) - innerHTML tylko po to, by wyroznic <b>/<code>.
      p.innerHTML = akapit;
      sec.appendChild(p);
    }

    body.appendChild(sec);
  }

  panel.appendChild(header);
  panel.appendChild(body);
  document.body.appendChild(panel);

  return { panel, toggleBtn };
}

function ustawStanZwiniecia(panel, toggleBtn, collapsed) {
  panel.classList.toggle('collapsed', collapsed);
  toggleBtn.textContent = collapsed ? '+' : '–';
  toggleBtn.title = collapsed ? 'Rozwiń samouczek' : 'Zwiń samouczek';
}

// Panel stoi poza #hud (wlasny <div>, position:fixed), wiec nie zalezy od
// pointer-events HUD-u, ale wciaz musi isc DOKLADNIE pod #hud-top-left (okno
// wspolnej puli) - ta sama lewa krawedz, ta sama szerokosc. #hud-top-left
// potrafi zmieniac szerokosc/wysokosc (tryb widza chowa przyciski admina),
// wiec zamiast sztywnych pikseli mierzymy jego realny prostokat w przegladarce.
//
// #leaderboard-panel (ranking Top 10) idzie z kolei zaraz pod samouczkiem -
// to samouczek nim tu steruje (przesunRanking), a nie odwrotnie jak dawniej.
// Wyjatek: jesli w localStorage jest zapisana pozycja rankingu (uzytkownik go
// recznie przeciagnal - patrz makeDraggable w ui.js), nie ruszamy go wcale.
function przelicznikPozycji(panel, body, header) {
  const MARGIN = 8; // ten sam odstep, co miedzy elementami samego HUD-u (#hud-top-left-buttons)
  const DEFAULT_TOP = 16;
  const MIN_WIDOCZNE = 120; // minimalna wysokosc panelu widoczna na niskim ekranie
  const LEADERBOARD_POS_KEY = 'bankomat-clicker-leaderboard-pos';

  // #tutorial-panel ma "transition: top/left" (plynne przesuwanie przy zmianie
  // roli widz/admin) - w trakcie tej animacji getBoundingClientRect().top/left
  // zwraca wartosc POSREDNIA, nie docelowa. Gdyby przesunRanking() liczyl
  // pozycje rankingu z takiego posredniego odczytu, ranking zatrzymalby sie
  // w zlym miejscu (ranking sam nie ma tej animacji, wiec nie ma szans nadgonic
  // pozniej). Dlatego trzymamy tu DOCELOWE top/left, ustawione przez ostatnie
  // wywolanie przelicz() - to jedyne wiarygodne zrodlo prawdy o pozycji.
  // Wysokosc NIE jest animowana, wiec jej biezacy odczyt jest zawsze OK.
  let docelowyTop = DEFAULT_TOP;
  let docelowyLeft = 16;

  function czyRankingPrzeciagniety() {
    try {
      return !!localStorage.getItem(LEADERBOARD_POS_KEY);
    } catch (e) {
      return false;
    }
  }

  function przesunRanking() {
    const leaderboard = document.getElementById('leaderboard-panel');
    if (!leaderboard || czyRankingPrzeciagniety()) return;
    const h = panel.getBoundingClientRect().height;
    if (h <= 0) return;
    leaderboard.style.top = `${docelowyTop + h + MARGIN}px`;
    leaderboard.style.left = `${docelowyLeft}px`;
  }

  function przelicz() {
    const hudTopLeft = document.getElementById('hud-top-left');
    let left = window.innerWidth <= 700 ? 8 : 16;
    let top = DEFAULT_TOP;
    let width = null;

    if (hudTopLeft) {
      const r = hudTopLeft.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        top = r.bottom + MARGIN;
        left = r.left;
        width = r.width;
      }
    }

    // Na niskim ekranie samo "top" moze wyleciec poza widoczny obszar -
    // przycinamy je tak, zeby nagłowek zawsze zostal widoczny, a reszta
    // tresci ma wlasny scroll w #tutorial-body.
    const maxTop = Math.max(DEFAULT_TOP, window.innerHeight - MIN_WIDOCZNE);
    top = Math.min(top, maxTop);

    docelowyTop = top;
    docelowyLeft = left;

    panel.style.top = top + 'px';
    panel.style.left = left + 'px';
    // Szerokosc = szerokosc #hud-top-left (border-box, box-sizing globalny w
    // style.css) - wpisujemy ja jako inline styl, ktory zawsze bije regule
    // "width: auto" z media query na waskim ekranie w tutorial.css.
    if (width !== null) panel.style.width = width + 'px';

    const headerH = header.getBoundingClientRect().height || 0;
    const dostepneNaBody = window.innerHeight - top - headerH - MARGIN;
    body.style.maxHeight = Math.max(80, dostepneNaBody) + 'px';

    przesunRanking();
  }

  // ResizeObserver zamiast recznego wpinania sie w kazde miejsce, ktore moze
  // zmienic wysokosc/szerokosc obserwowanych elementow (zwiniecie/rozwiniecie
  // samouczka, zmiana roli widz/admin, doladowana tresc):
  // - zmiana rozmiaru #hud-top-left przelicza cala pozycje samouczka,
  // - zmiana rozmiaru samego panelu samouczka (np. zwiniecie) przesuwa ranking.
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(() => przesunRanking()).observe(panel);
    const hudTopLeft = document.getElementById('hud-top-left');
    if (hudTopLeft) new ResizeObserver(() => przelicz()).observe(hudTopLeft);
  }

  return przelicz;
}

function inicjalizuj() {
  const { panel, toggleBtn } = zbudujDom();

  const czyWidziany = odczytajCzyWidziany();
  ustawStanZwiniecia(panel, toggleBtn, czyWidziany);
  if (!czyWidziany) {
    // Pierwsza wizyta: pokazujemy okno automatycznie i od razu zapisujemy
    // fakt pokazania, zeby kolejne wejscia startowaly juz zwiniete.
    zapiszJakoWidziany();
  }

  const header = panel.querySelector('#tutorial-header');
  const body = panel.querySelector('#tutorial-body');
  const przelicz = przelicznikPozycji(panel, body, header);

  toggleBtn.addEventListener('click', () => {
    const bedzieZwiniety = !panel.classList.contains('collapsed');
    ustawStanZwiniecia(panel, toggleBtn, bedzieZwiniety);
    // Zwiniecie/rozwiniecie zmienia wysokosc panelu natychmiast (bez animacji
    // wysokosci - tylko top/left maja transition), a ranking musi za nim
    // podazyc od razu, a nie dopiero gdy przegladarka zdazy wywolac
    // ResizeObserver (w tle bywa to zauwazalnie opoznione).
    przelicz();
  });

  przelicz();
  window.addEventListener('resize', przelicz);

  // Hud-top-left doladowuje tresc asynchronicznie (stan gry z API) i moze
  // zmienic szerokosc (tryb widza/admina) - ResizeObserver (patrz
  // przelicznikPozycji) lapie wiekszosc takich zmian na biezaco, a ponizsze
  // przeliczenia sa dodatkowa siatka bezpieczenstwa na pierwsze sekundy gry.
  const timery = [200, 600, 1200, 2500, 4000];
  for (const ms of timery) {
    setTimeout(przelicz, ms);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', inicjalizuj);
} else {
  inicjalizuj();
}
