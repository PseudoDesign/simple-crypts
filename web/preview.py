#!/usr/bin/env python3
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

p = argparse.ArgumentParser()
p.add_argument("--port", type=int, default=8000)
a = p.parse_args()
server = ThreadingHTTPServer(
    ("127.0.0.1", a.port), partial(SimpleHTTPRequestHandler, directory="web/site")
)
print(f"Preview: http://127.0.0.1:{a.port}/", flush=True)
server.serve_forever()
