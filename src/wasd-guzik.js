// Guzik "Wlacz chodzenie wsadem" - zastepcze rozwiazanie dla sterowania WASD.
//
// Docelowo widzowie steruja postacia, pisząc w/a/s/d na czacie Kicka. Jest
// gotowy skrypt (SKRYPT_WASD nizej), ktory po wklejeniu do konsoli w OKNIE
// CZATU KICKA zamienia lewy Shift + W/A/S/D na wpisy na czacie. Automatyczne
// wstrzykniecie tego skryptu z tej strony do okna Kicka jest niemozliwe -
// to inna domena i same-origin policy blokuje dostep do cudzej karty/konsoli.
// Ten modul wiec tylko: kopiuje gotowy skrypt do schowka i pokazuje okienko
// z instrukcja, gdzie go wkleic.
//
// Plik zaladowany osobnym <script type="module"> w index.html, celowo BEZ
// importu w main.js.

// Tresc skryptu jest wlasnoscia uzytkownika - zapisana znak w znak. Zeby
// miec pewnosc identycznosci (skrypt zawiera template literaty z backtickami
// i ${...}), tekst jest zakodowany jako pojedynczy literal stringowy
// wygenerowany programowo przez JSON.stringify(oryginal) - to gwarantuje, ze
// po sparsowaniu przez silnik JS odtworzy sie dokladnie oryginalny tekst,
// bez recznego escapowania.
const SKRYPT_WASD = "(() => {\n    const KEYS = ['W', 'A', 'S', 'D', 'Q', 'E', 'Z', 'C'];\n\n    let leftShiftPressed = false;\n    const pressed = new Set();\n\n    // =========================\n    // UI\n    // =========================\n\n    const style = document.createElement('style');\n    style.textContent = `\n        #wasd-overlay {\n            position: fixed;\n            top: 40px;\n            left: 40px;\n            z-index: 999999;\n            display: grid;\n            grid-template-columns: repeat(3, 60px);\n            grid-template-rows: repeat(3, 60px);\n            gap: 8px;\n            user-select: none;\n            pointer-events: none;\n        }\n\n        .wasd-key {\n            width: 60px;\n            height: 60px;\n            display: flex;\n            align-items: center;\n            justify-content: center;\n            background: rgba(20,20,20,.85);\n            border: 2px solid #53fc18;\n            border-radius: 10px;\n            color: white;\n            font-size: 26px;\n            font-weight: bold;\n        }\n\n        .wasd-key.active {\n            transform: scale(.88);\n            background: #53fc18;\n            color: black;\n            box-shadow: 0 0 10px #53fc18, 0 0 25px #53fc18;\n        }\n\n        #wasd-Q { grid-column: 1; grid-row: 1; }\n        #wasd-W { grid-column: 2; grid-row: 1; }\n        #wasd-E { grid-column: 3; grid-row: 1; }\n        #wasd-A { grid-column: 1; grid-row: 2; }\n        #wasd-S { grid-column: 2; grid-row: 2; }\n        #wasd-D { grid-column: 3; grid-row: 2; }\n        #wasd-Z { grid-column: 1; grid-row: 3; }\n        #wasd-C { grid-column: 3; grid-row: 3; }\n    `;\n\n    document.head.appendChild(style);\n\n    const overlay = document.createElement('div');\n    overlay.id = 'wasd-overlay';\n\n    KEYS.forEach(key => {\n        const button = document.createElement('div');\n        button.className = 'wasd-key';\n        button.id = `wasd-${key}`;\n        button.textContent = key;\n\n        overlay.appendChild(button);\n    });\n\n    document.body.appendChild(overlay);\n\n    // =========================\n    // CHAT\n    // =========================\n\n    function findChatInput() {\n        const selectors = [\n            '.chat-input-wrapper [contenteditable=\"true\"]',\n            '.chat-input [contenteditable=\"true\"]',\n            '[data-chat-input]',\n            'div[contenteditable=\"true\"]',\n            'textarea'\n        ];\n\n        for (const selector of selectors) {\n            const elements = document.querySelectorAll(selector);\n\n            for (const element of elements) {\n                const rect = element.getBoundingClientRect();\n\n                if (\n                    rect.width > 0 &&\n                    rect.height > 0 &&\n                    element.offsetParent !== null\n                ) {\n                    return element;\n                }\n            }\n        }\n\n        return null;\n    }\n\n    function sendToChat(letter) {\n        const input = findChatInput();\n\n        if (!input) {\n            console.warn('Nie znaleziono pola czatu.');\n            return;\n        }\n\n        input.focus();\n\n        // Zamiast manipulować innerHTML używamy execCommand,\n        // żeby React/Kick dostał normalne zdarzenie wpisania tekstu.\n        // Zaznaczamy zawartość KONKRETNEGO elementu (Selection API dla\n        // contenteditable), bo execCommand('selectAll') działa na cały\n        // editing host i po przerysowaniu pola przez React selekcja\n        // potrafi w nim nie siedzieć - wtedy insertText tylko dopisuje.\n        if (typeof input.select === 'function') {\n            input.select();\n        } else {\n            const zakres = document.createRange();\n            zakres.selectNodeContents(input);\n            const zaznaczenie = window.getSelection();\n            zaznaczenie.removeAllRanges();\n            zaznaczenie.addRange(zakres);\n        }\n\n        document.execCommand(\n            'insertText',\n            false,\n            letter.toLowerCase()\n        );\n\n        // Enter\n        input.dispatchEvent(\n            new KeyboardEvent('keydown', {\n                key: 'Enter',\n                code: 'Enter',\n                keyCode: 13,\n                which: 13,\n                bubbles: true,\n                cancelable: true\n            })\n        );\n\n        // Czyścimy pole, żeby żadna resztka nie przeszła na następną wysyłkę.\n        try {\n            if (typeof input.select === 'function') {\n                input.value = '';\n                input.dispatchEvent(new Event('input', { bubbles: true }));\n            } else {\n                const zakres = document.createRange();\n                zakres.selectNodeContents(input);\n                const zaznaczenie = window.getSelection();\n                zaznaczenie.removeAllRanges();\n                zaznaczenie.addRange(zakres);\n                document.execCommand('delete', false, null);\n            }\n        } catch (blad) {}\n    }\n\n    // =========================\n    // KEYBOARD\n    // =========================\n\n    document.addEventListener('keydown', event => {\n\n        // TYLKO lewy Shift\n        if (event.code === 'ShiftLeft') {\n            leftShiftPressed = true;\n            return;\n        }\n\n        const key = event.key.toUpperCase();\n\n        // Bez lewego Shifta nic nie robimy\n        if (!leftShiftPressed) {\n            return;\n        }\n\n        if (!KEYS.includes(key)) {\n            return;\n        }\n\n        // blokujemy normalne Shift+W itd.\n        event.preventDefault();\n        event.stopPropagation();\n\n        if (pressed.has(key)) {\n            return;\n        }\n\n        pressed.add(key);\n\n        document\n            .getElementById(`wasd-${key}`)\n            ?.classList.add('active');\n\n        sendToChat(key);\n\n    }, true);\n\n\n    document.addEventListener('keyup', event => {\n\n        if (event.code === 'ShiftLeft') {\n            leftShiftPressed = false;\n\n            pressed.clear();\n\n            document\n                .querySelectorAll('.wasd-key')\n                .forEach(el => el.classList.remove('active'));\n\n            return;\n        }\n\n        const key = event.key.toUpperCase();\n\n        if (!KEYS.includes(key)) {\n            return;\n        }\n\n        pressed.delete(key);\n\n        document\n            .getElementById(`wasd-${key}`)\n            ?.classList.remove('active');\n\n    }, true);\n\n    console.log('WASD uruchomione — trzymaj LEWY SHIFT + WASD (i skosy QEZC)');\n})();";

const ADRES_CZATU_KICKA = 'https://kick.com/popout/patiro/chat';
const NAZWA_OKNA_CZATU = 'kick-czat-patiro';

// Kopiuje tekst do schowka. Probuje najpierw Clipboard API, potem fallback
// przez tymczasowy textarea + execCommand('copy'). Zwraca true tylko gdy
// kopiowanie realnie sie udalo - nigdy nie zglaszamy sukcesu na sile.
async function skopiujDoSchowka(tekst) {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function' && window.isSecureContext) {
      await navigator.clipboard.writeText(tekst);
      return true;
    }
  } catch (blad) {
    console.warn('navigator.clipboard.writeText nie powiodlo sie, probuje fallback execCommand', blad);
  }

  let pole;
  try {
    pole = document.createElement('textarea');
    pole.value = tekst;
    pole.setAttribute('readonly', '');
    pole.style.position = 'fixed';
    pole.style.top = '-9999px';
    pole.style.left = '-9999px';
    document.body.appendChild(pole);
    pole.focus();
    pole.select();
    pole.setSelectionRange(0, tekst.length);
    const udalo = document.execCommand('copy');
    document.body.removeChild(pole);
    return !!udalo;
  } catch (blad) {
    console.warn('Fallback execCommand(copy) tez nie powiodl sie', blad);
    if (pole && pole.parentNode) pole.parentNode.removeChild(pole);
    return false;
  }
}

let oknoInstrukcji = null;

function zbudujOknoInstrukcji() {
  const dialog = document.createElement('dialog');
  dialog.id = 'wasd-instrukcja-dialog';

  dialog.innerHTML = `
    <div id="wasd-instrukcja-tresc">
      <h2 id="wasd-instrukcja-tytul">Włącz chodzenie wsadem</h2>
      <p id="wasd-status-kopiowania"></p>
      <ol id="wasd-instrukcja-lista">
        <li>
          Otwórz czat Kicka:
          <a id="wasd-instrukcja-czat-link" href="${ADRES_CZATU_KICKA}" target="${NAZWA_OKNA_CZATU}" rel="noopener">💬 Czat Kicka</a>
        </li>
        <li>W oknie czatu naciśnij <strong>F12</strong> i przejdź do zakładki „Console”.</li>
        <li>Jeśli Chrome blokuje wklejanie, wpisz <code>allow pasting</code> i naciśnij Enter.</li>
        <li>Wklej skrypt (<strong>Ctrl+V</strong>) i naciśnij Enter.</li>
        <li>Trzymaj <strong>Lewy Shift</strong> i naciskaj W/A/S/D. Każdy klawisz wysyła literę na czat.</li>
      </ol>
      <p id="wasd-instrukcja-kombinacje">Kombinacje działają też z ręcznie wpisanych liter: <code>ww</code> = 2 pola do przodu, <code>wd</code> = przód i w prawo, maks. 5 liter na wiadomość. Skrypt powyżej wysyła też <code>q</code>/<code>e</code> (skos do przodu, bez obrotu postaci) i <code>z</code>/<code>c</code> (skos do tyłu, bez obrotu postaci).</p>
      <p id="wasd-ostrzezenie">⚠️ Wklejaj do konsoli tylko ten kod z tej strony — nigdy kodu od obcych, bo w ten sposób kradnie się konta.</p>
      <textarea id="wasd-reczna-kopia" readonly hidden></textarea>
      <div id="wasd-dialog-akcje">
        <button id="wasd-dialog-zamknij" type="button">Zamknij</button>
      </div>
    </div>
  `;

  document.body.appendChild(dialog);

  const zamknijBtn = dialog.querySelector('#wasd-dialog-zamknij');
  if (zamknijBtn) {
    zamknijBtn.addEventListener('click', () => dialog.close());
  }

  return dialog;
}

function pokazOknoInstrukcji(skopiowano) {
  if (!oknoInstrukcji) {
    oknoInstrukcji = zbudujOknoInstrukcji();
  }

  const status = oknoInstrukcji.querySelector('#wasd-status-kopiowania');
  const reczniePole = oknoInstrukcji.querySelector('#wasd-reczna-kopia');

  if (skopiowano) {
    if (status) {
      status.textContent = '✅ Skrypt skopiowany do schowka — wklej go w konsoli czatu (krok 4).';
      status.className = 'wasd-status-ok';
    }
    if (reczniePole) reczniePole.hidden = true;
  } else {
    if (status) {
      status.textContent = '⚠️ Automatyczne kopiowanie się nie udało. Zaznacz i skopiuj skrypt ręcznie z pola poniżej (Ctrl+A, Ctrl+C).';
      status.className = 'wasd-status-blad';
    }
    if (reczniePole) {
      reczniePole.value = SKRYPT_WASD;
      reczniePole.hidden = false;
    }
  }

  if (typeof oknoInstrukcji.showModal === 'function') {
    if (!oknoInstrukcji.open) oknoInstrukcji.showModal();
  } else {
    // Bardzo stare przegladarki bez <dialog> - awaryjnie pokazujemy jako zwykly blok.
    oknoInstrukcji.setAttribute('open', '');
  }

  if (!skopiowano && reczniePole) {
    reczniePole.focus();
    reczniePole.select();
  }
}

function zainicjalizujGuzik() {
  const guzik = document.getElementById('wasd-guzik-btn');
  if (!guzik) return;

  guzik.addEventListener('click', async () => {
    const skopiowano = await skopiujDoSchowka(SKRYPT_WASD);
    pokazOknoInstrukcji(skopiowano);
  });
}

zainicjalizujGuzik();
