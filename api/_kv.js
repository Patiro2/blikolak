// Cienka warstwa dostepu do Vercel KV (Upstash Redis) po jego REST API.
//
// Celowo BEZ pakietu @vercel/kv: REST API jest i tak wystawiane przez te sama
// integracje, a dzieki temu projekt nie potrzebuje package.json, instalacji
// zaleznosci ani pilnowania wersji bibliotek. Gra to czysty statyczny frontend
// plus dwie funkcje serwerowe.
//
// Zmienne srodowiskowe (ustawiane AUTOMATYCZNIE przez integracje Storage -> KV
// w panelu Vercela):
//   KV_REST_API_URL / KV_REST_API_TOKEN            (dawne "Vercel KV")
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN  (Marketplace: Upstash for Redis)
// Obsluzone sa oba warianty nazw.
// Zmienna ustawiana RECZNIE przez wlasciciela:
//   ADMIN_TOKEN - haslo admina, bez niego nikt nie zapisze ani nie zresetuje gry.

export const KLUCZ_STANU = 'bankomat-clicker:stan';

function konfiguracja() {
  // Vercel wpina te dane pod ROZNYMI nazwami zaleznie od tego, jak zalozono
  // magazyn: dawne "Vercel KV" dawalo KV_REST_API_*, a integracja z
  // Marketplace (Upstash for Redis) daje UPSTASH_REDIS_REST_*. Akceptujemy
  // oba warianty, zeby konfiguracja dzialala niezaleznie od drogi zalozenia.
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return { url: url.replace(/\/+$/, ''), token };
}

export function kvSkonfigurowane() {
  return konfiguracja() !== null;
}

async function zapytanie(sciezka, opcje = {}) {
  const cfg = konfiguracja();
  if (!cfg) throw new Error('Brak konfiguracji KV (KV_REST_API_URL / KV_REST_API_TOKEN)');
  const odp = await fetch(`${cfg.url}${sciezka}`, {
    ...opcje,
    headers: { Authorization: `Bearer ${cfg.token}`, ...(opcje.headers || {}) },
  });
  if (!odp.ok) {
    const tresc = await odp.text().catch(() => '');
    throw new Error(`KV ${odp.status}: ${tresc.slice(0, 200)}`);
  }
  return odp.json();
}

/** Odczyt stanu gry. Zwraca obiekt albo null, gdy nic jeszcze nie zapisano. */
export async function pobierzStan() {
  const wynik = await zapytanie(`/get/${encodeURIComponent(KLUCZ_STANU)}`);
  if (!wynik || wynik.result === null || wynik.result === undefined) return null;
  try {
    return typeof wynik.result === 'string' ? JSON.parse(wynik.result) : wynik.result;
  } catch (_) {
    return null;
  }
}

/** Zapis stanu gry (nadpisuje w calosci). */
export async function zapiszStan(stan) {
  await zapytanie(`/set/${encodeURIComponent(KLUCZ_STANU)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(stan),
  });
}

/** Kasowanie stanu - uzywane przez reset gry. */
export async function usunStan() {
  await zapytanie(`/del/${encodeURIComponent(KLUCZ_STANU)}`, { method: 'POST' });
}

/**
 * Sprawdzenie hasla admina. Porownanie jest stalo-czasowe, zeby nie dalo sie
 * odgadywac tokenu po czasie odpowiedzi.
 */
export function czyAdmin(req) {
  const oczekiwany = process.env.ADMIN_TOKEN;
  if (!oczekiwany) return false;

  const naglowek = req.headers?.authorization || '';
  const podany = naglowek.startsWith('Bearer ') ? naglowek.slice(7).trim() : '';
  if (!podany || podany.length !== oczekiwany.length) return false;

  let roznica = 0;
  for (let i = 0; i < oczekiwany.length; i++) {
    roznica |= oczekiwany.charCodeAt(i) ^ podany.charCodeAt(i);
  }
  return roznica === 0;
}
