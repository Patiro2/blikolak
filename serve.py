"""Serwer deweloperski dla Bankomat Clickera.

Zwykly `python -m http.server` odsyla Last-Modified i przegladarka trzyma
moduly ES w cache - po edycji pliku w src/ gra dalej chodzi na starym kodzie.
Ten serwer dokleja no-cache, wiec F5 zawsze laduje aktualna wersje.

Uruchomienie:  python serve.py [port]
"""

import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


# Cache wylaczamy tylko dla kodu. Assety musza sie cache'owac: kazdy z 23 modeli
# GLB ciagnie za soba Textures/colormap.png, wiec bez cache jeden odswiez to
# ~350 rownoleglych zadan i http.server zaczyna zrywac polaczenia (ERR_ABORTED).
CODE_SUFFIXES = ('.js', '.html', '.css', '/')


class NoCacheHandler(SimpleHTTPRequestHandler):
    # Domyslne HTTP/1.0 zamyka polaczenie po kazdej odpowiedzi, wiec przegladarka
    # otwiera nowe gniazdo na kazdy plik. Przy ~30 modelach GLB + teksturach
    # przepelnia to kolejke accept i Windows odsyla RST (ERR_CONNECTION_RESET).
    # HTTP/1.1 wlacza keep-alive - te same polaczenia obsluguja wiele plikow.
    protocol_version = 'HTTP/1.1'

    def _api_niedostepne(self):
        """Lokalnie nie ma Vercel KV - odpowiadamy tak, jak zrobilby to serwer
        z nieskonfigurowanym magazynem. Dzieki temu gra schodzi na localStorage
        i pelne uprawnienia (patrz src/remote.js), a konsola zostaje czysta."""
        import json
        tresc = json.dumps({'ok': False, 'blad': 'Magazyn KV niedostepny lokalnie'}).encode('utf-8')
        self.send_response(503)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(tresc)))
        self.end_headers()
        self.wfile.write(tresc)

    def do_POST(self):
        if self.path.startswith('/api/'):
            self._api_niedostepne()
            return
        self.send_error(405)

    def do_DELETE(self):
        if self.path.startswith('/api/'):
            self._api_niedostepne()
            return
        self.send_error(405)

    def do_GET(self):
        if self.path in ('/api/state', '/api/login'):
            self._api_niedostepne()
            return
        if self.path.startswith('/api/kick/channel/'):
            channel = self.path.split('/api/kick/channel/')[1].split('?')[0].strip()
            import urllib.request, json
            try:
                req = urllib.request.Request(
                    f'https://kick.com/api/v2/channels/{channel}',
                    headers={'User-Agent': 'Mozilla/5.0'}
                )
                with urllib.request.urlopen(req, timeout=5) as res:
                    body = res.read()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Cache-Control', 'max-age=60')
                # HTTP/1.1 wymaga Content-Length, inaczej klient czeka w nieskonczonosc.
                self.send_header('Content-Length', str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except Exception as err:
                payload = json.dumps({'error': str(err)}).encode('utf-8')
                self.send_response(502)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
            return

        super().do_GET()

    def end_headers(self):
        if self.path.split('?')[0].endswith(CODE_SUFFIXES):
            self.send_header('Cache-Control', 'no-store, must-revalidate')
            self.send_header('Expires', '0')
        else:
            self.send_header('Cache-Control', 'max-age=3600')
        super().end_headers()

    def log_message(self, fmt, *args):
        if '404' in (fmt % args):
            super().log_message(fmt, *args)


class DevServer(ThreadingHTTPServer):
    # Domyslny backlog socketserver to 5. Przy rownoleglym ladowaniu modeli
    # nadmiarowe polaczenia nie miescily sie w kolejce accept i byly odrzucane
    # przez system resetem TCP - stad ERR_CONNECTION_RESET w konsoli gry.
    request_queue_size = 128
    daemon_threads = True


if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print(f'Bankomat Clicker: http://localhost:{port}  (Ctrl+C konczy)')
    DevServer(('127.0.0.1', port), NoCacheHandler).serve_forever()
