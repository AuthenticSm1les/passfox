#!/usr/bin/env python3
"""Serve the mock login pages in test/pages for trying passfox in Firefox.

  python3 -I test/serve.py [port] [directory]   then open http://localhost:8766/

The directory defaults to test/pages; pass the project root to serve the
harness pages (/test/harness.html) as well.

Form posts are accepted (and discarded) and answered with a redirect to
welcome.html, so the save doorhanger has a real navigation to survive.
"""

import functools
import http.server
import pathlib
import sys
import urllib.parse

PAGES = pathlib.Path(__file__).resolve().parent / "pages"


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Always serve the current files while iterating on them.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        # /delay?ms=N answers after N ms: a page can hold its load event
        # (and so a headless screenshot) until it has finished setting up.
        if self.path.startswith("/delay"):
            import time
            ms = int(urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get("ms", ["1000"])[0])
            time.sleep(min(ms, 10000) / 1000)
            self.send_response(204)
            self.end_headers()
            return
        # /__test/... serves test/ whatever the root, and ?stub=NAME injects
        # /__test/NAME ahead of an HTML page's own scripts (a fake extension
        # API for extension pages served from extension/).
        url = urllib.parse.urlparse(self.path)
        if url.path.startswith("/__test/"):
            self.path = url.path
            return self.serve_file(PAGES.parent / url.path[len("/__test/"):])
        stub = urllib.parse.parse_qs(url.query).get("stub")
        if stub and url.path.endswith(".html"):
            html = (pathlib.Path(self.directory) / url.path.lstrip("/")).read_text()
            tag = f'<script src="/__test/{stub[0]}"></script>'
            html = html.replace("<head>", "<head>\n    " + tag, 1)
            return self.send_body(html.encode(), "text/html; charset=utf-8")
        super().do_GET()

    def serve_file(self, path):
        if not path.is_file():
            self.send_error(404)
            return
        kind = "text/javascript" if path.suffix in (".js", ".mjs") else "text/html" if path.suffix == ".html" else "application/octet-stream"
        self.send_body(path.read_bytes(), kind)

    def send_body(self, body, kind):
        self.send_response(200)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        self.rfile.read(length)  # never logged or stored
        self.send_response(303)
        self.send_header("Location", "/welcome.html")
        self.end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write(f"{self.command} {self.path}\n")


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8766
    directory = sys.argv[2] if len(sys.argv) > 2 else str(PAGES)
    handler = functools.partial(Handler, directory=directory)
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as server:
        print(f"passfox test pages on http://localhost:{port}/", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
