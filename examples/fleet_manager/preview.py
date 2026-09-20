"""Serve the built example on loopback (a secure context for browser APIs)."""

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--port", type=int, default=8001)
args = parser.parse_args()
handler = partial(SimpleHTTPRequestHandler, directory="examples/fleet_manager/site")
server = ThreadingHTTPServer(("127.0.0.1", args.port), handler)
print(f"Fleet example: http://127.0.0.1:{args.port}/", flush=True)
server.serve_forever()
