#!/usr/bin/env python3
"""Test actual CFFI ownership and argument conversions, outside JSON adapters."""
import tempfile
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "bindings" / "python"))
from simplecrypts import Endpoint, Error, fixture_public_key


def fails(operation):
    try:
        operation()
    except (Error, ValueError, OverflowError):
        return
    raise AssertionError("invalid operation succeeded")


def main():
    with tempfile.TemporaryDirectory() as directory:
        with Endpoint("server",Path(directory)/"s","python-test",bytes(32)) as server:
            device=Endpoint("device",Path(directory)/"d","python-test",bytes(32),server_public_key=bytes.fromhex(server.inspect()['public_key']))
            with device:
                server.receive(device.outbound());device.receive(server.outbound())
                server.set_credits_issued(2**64-1);frame=server.outbound();saved=bytes(frame);state=device.inspect()
                device.receive(frame);server.receive(device.outbound());device.receive(server.outbound())
                device.consume_credits(2**53+9);assert device.outbound() is None
                assert frame==saved and state['credits_consumed']=='0'
                assert device.inspect()['credits_consumed']==str(2**53+9)
                group=device.inspect_group(1);assert group['values'][2]==2**53+9
                fails(lambda:device.update_group(1,[(1,'uint64',100)]))
                fails(lambda:device.update_group(1,[(2,'uint64',2**53)]))
                server.request_group(1);device.receive(server.outbound());server.receive(device.outbound());device.receive(server.outbound())
                assert server.inspect()['credits_consumed']==str(2**53+9)
                for value in [2**64,True,1.5,-1]:fails(lambda:device.consume_credits(value))
                fails(lambda:device.outbound(capacity=-1));fails(lambda:device.receive(bytearray(frame)));fails(lambda:device.receive(bytes(513)))
            device.close();fails(lambda:device.consume_credits(1));fails(device.inspect)
        old=Path(directory)/'old';old.mkdir(mode=0o700)
        (old/'state.bin').write_bytes(b'SCSTORE2'+bytes(128));(old/'state.bin').chmod(0o600)
        saved=(old/'state.bin').read_bytes()
        fails(lambda:Endpoint('server',old,'python-test',bytes(32)))
        assert (old/'state.bin').read_bytes()==saved
    print("PASS Python ownership, generic resources, errors, close, and exact uint64")
if __name__=='__main__':main()
