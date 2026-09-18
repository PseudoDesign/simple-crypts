"""Python CFFI binding to the shared Simple Crypts core and host provider.

Each Endpoint owns one native handle; use it as a context manager or close it.
Endpoint methods are synchronous and require external synchronization if shared
between threads. Encryption, enrollment and persistence run in the shared core.
"""
import json
import os
from pathlib import Path
from cffi import FFI

_ffi = FFI()
_ffi.cdef("""
typedef struct sc_host sc_host;
int sc_host_initialize(int,const char*,const char*,const unsigned char*,
 const unsigned char*,const unsigned char*,int,sc_host**);
void sc_host_close(sc_host*);
int sc_host_name(sc_host*,const char*);
int sc_host_report(sc_host*,int);
int sc_host_receive(sc_host*,const unsigned char*,size_t);
int sc_host_outbound(sc_host*,size_t,unsigned char*,size_t,size_t*);
int sc_host_inspect(sc_host*,char*,size_t);
const char* sc_host_status(int);
int sc_host_fail(sc_host*,const char*,unsigned);
int sc_host_fixture_public(const unsigned char*,unsigned char*);
int sc_host_fixture_revision(sc_host*,unsigned long long);
""")
_default = Path(__file__).resolve().parents[2] / "build" / "libsimplecrypts.so"
_lib = _ffi.dlopen(os.environ.get("SIMPLECRYPTS_LIB", str(_default)))


class Error(Exception):
    def __init__(self, code):
        self.code = code
        self.status = _ffi.string(_lib.sc_host_status(code)).decode("ascii")
        super().__init__(self.status)


def _check(code):
    if code != 0:
        raise Error(code)


def _bytes32(value, optional=False):
    if value is None and optional:
        return _ffi.NULL
    if not isinstance(value, bytes) or len(value) != 32:
        raise ValueError("key, seed and enrollment secret must be 32 bytes")
    return value


def fixture_public_key(seed):
    """Test provisioning helper; never derive a server secret on a real device."""
    result = _ffi.new("unsigned char[32]")
    _check(_lib.sc_host_fixture_public(_bytes32(seed), result))
    return bytes(_ffi.buffer(result, 32))


class Endpoint:
    def __init__(self, role, storage, serial, secret, *, server_public_key=None,
                 provisioned_seed=None, random_unavailable=False):
        if role not in ("device", "server"):
            raise ValueError("role must be device or server")
        if "\0" in str(storage) or "\0" in serial:
            raise ValueError("NUL in storage or serial")
        self._handle = _ffi.NULL
        result = _ffi.new("sc_host **")
        _check(_lib.sc_host_initialize(
            1 if role == "device" else 2, os.fsencode(storage), serial.encode(),
            _bytes32(secret), _bytes32(provisioned_seed, True),
            _bytes32(server_public_key, True), bool(random_unavailable), result))
        self._handle = result[0]

    def _open(self):
        if self._handle == _ffi.NULL:
            raise ValueError("endpoint is closed")
        return self._handle

    def close(self):
        if self._handle != _ffi.NULL:
            _lib.sc_host_close(self._handle)
            self._handle = _ffi.NULL

    def __enter__(self):
        self._open()
        return self

    def __exit__(self, *_):
        self.close()

    def __del__(self):
        if hasattr(self, "_handle"):
            self.close()

    def name(self, value):
        if "\0" in value:
            raise ValueError("NUL in name")
        _check(_lib.sc_host_name(self._open(), value.encode()))

    def report(self, temperature_mC):
        if isinstance(temperature_mC, bool) or not isinstance(temperature_mC, int) or not -2**31 <= temperature_mC < 2**31:
            raise ValueError("temperature must be an int32 millidegree value")
        _check(_lib.sc_host_report(self._open(), temperature_mC))

    def receive(self, frame):
        if not isinstance(frame, bytes):
            raise ValueError("frame must be bytes")
        _check(_lib.sc_host_receive(self._open(), frame, len(frame)))

    def outbound(self, budget=512, capacity=512):
        if not 0 <= capacity <= 65536 or not 0 <= budget <= 2**32-1:
            raise ValueError("invalid buffer or byte budget")
        output = _ffi.new("unsigned char[]", max(1, capacity))
        length = _ffi.new("size_t *")
        code = _lib.sc_host_outbound(self._open(), budget, output, capacity, length)
        if code == 1:
            return None
        _check(code)
        return bytes(_ffi.buffer(output, length[0]))

    def inspect(self):
        output = _ffi.new("char[4096]")
        _check(_lib.sc_host_inspect(self._open(), output, 4096))
        return json.loads(_ffi.string(output))

    def fail(self, operation, count=1):
        if not 0 <= count <= 2**32-1 or "\0" in operation:
            raise ValueError("invalid fault request")
        _check(_lib.sc_host_fail(self._open(), operation.encode(), count))

    def fixture_revision(self, revision):
        if not 0 <= revision <= 2**64-1:
            raise ValueError("revision out of range")
        _check(_lib.sc_host_fixture_revision(self._open(), revision))
