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
    # RFC 8032 section 7.1, test 1: Ed25519 signature of an empty message.
    seed="9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"
    pub="d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a"
    signature="e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"
    for executable in (sodium,go):
        assert invoke(executable,"sign",seed,pub,"00"*24,"")==signature
        invoke(executable,"verify",seed,pub,"00"*24,signature)
        invoke(executable,"verify",seed,pub,"00"*24,signature[:-2]+"01",valid=False)
    for i in range(10):
        a=bytes([i+1]*32).hex();b=bytes([i+21]*32).hex()
        keys=[]
        for identity in (a,b):
            c=invoke(sodium,"edkeys",identity,pub,"00"*24,"")
            assert c==invoke(go,"edkeys",identity,pub,"00"*24,"")
            keys.append((c[:64],c[64:128],c[128:]))
        msg=(b"SCE2"+bytes([i])*104).hex()
        sig=invoke(sodium,"sign",a,pub,"00"*24,msg)
        assert sig==invoke(go,"sign",a,pub,"00"*24,msg)
        invoke(go,"verify",b,keys[0][0],"00"*24,sig+msg)
        c=invoke(sodium,"seal",keys[0][2],keys[1][1],"00"*24,msg)
        assert invoke(go,"open",keys[1][2],keys[0][1],"00"*24,c)==msg
    print("PASS RFC 8032 signature vector; independent Ed25519/X25519 conversion, signatures and derived-key boxes")
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
