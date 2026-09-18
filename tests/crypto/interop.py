#!/usr/bin/env python3
"""Published NaCl known-answer test plus independent C/Go bidirectional checks."""
import argparse
import json
from pathlib import Path
import random
import subprocess

from coordinator import resolve


def invoke(executable, operation, secret, peer, nonce, data, valid=True):
    result = subprocess.run([executable, operation, secret, peer, nonce, data],
                            text=True, capture_output=True, timeout=20)
    if not valid:
        assert result.returncode == 2, result
        return None
    assert result.returncode == 0, result
    return result.stdout.strip()


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--sodium", required=True)
    p.add_argument("--go", required=True)
    p.add_argument("--vector", required=True)
    args = p.parse_args()
    sodium, go = resolve(args.sodium), resolve(args.go)
    vector = json.loads(Path(resolve(args.vector)).read_text())
    for executable in (sodium, go):
        assert invoke(executable, "seal", vector["alice_secret"], vector["bob_public"],
                      vector["nonce"], vector["message"]) == vector["ciphertext"]
        assert invoke(executable, "open", vector["bob_secret"], vector["alice_public"],
                      vector["nonce"], vector["ciphertext"]) == vector["message"]
    rng = random.Random(195331)
    count = 0
    for sender, receiver in (("alice", "bob"), ("bob", "alice")):
        direction = 1 if sender == "alice" else 2
        for length in (0, 1, 15, 16, 31, 32, 64, 131, 255, 434):
            message = rng.randbytes(length).hex()
            nonce = (bytes([direction]) + bytes(15) + length.to_bytes(8, "big")).hex()
            secret, peer = vector[sender + "_secret"], vector[receiver + "_public"]
            receiver_secret, sender_public = vector[receiver + "_secret"], vector[sender + "_public"]
            c = invoke(sodium, "seal", secret, peer, nonce, message)
            g = invoke(go, "seal", secret, peer, nonce, message)
            assert c == g
            assert invoke(go, "open", receiver_secret, sender_public, nonce, c) == message
            assert invoke(sodium, "open", receiver_secret, sender_public, nonce, g) == message
            bad = bytes([int(c[:2], 16) ^ 1]).hex() + c[2:]
            for executable in (sodium, go):
                invoke(executable, "open", receiver_secret, sender_public, nonce, bad, valid=False)
            count += 1
    print(f"PASS upstream NaCl known-answer vector; {count} bidirectional Go/libsodium cases")


if __name__ == "__main__":
    main()
