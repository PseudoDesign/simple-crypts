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
int sc_host_update_group(sc_host*,unsigned short,const unsigned char*,size_t);
int sc_host_request_group(sc_host*,unsigned short);
int sc_host_inspect_group(sc_host*,unsigned short,char*,size_t);
void sc_host_close(sc_host*);
int sc_host_enrollment_enable(sc_host*);
int sc_host_enrollment_begin(sc_host*,unsigned long long,unsigned long long);
int sc_host_enrollment_approve(sc_host*,const unsigned char*,const unsigned char*,unsigned long long);
int sc_host_enrollment_cancel(sc_host*);
int sc_host_receive_at(sc_host*,const unsigned char*,size_t,unsigned long long);
int sc_host_set_credits_issued(sc_host*,unsigned long long);
int sc_host_consume_credits(sc_host*,unsigned long long);
int sc_host_request_credit_status(sc_host*);
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

    def enrollment_enable(self):
        _check(_lib.sc_host_enrollment_enable(self._open()))

    def enrollment_begin(self, now, expires):
        _check(_lib.sc_host_enrollment_begin(self._open(), now, expires))

    def enrollment_approve(self, challenge, key, now):
        _check(_lib.sc_host_enrollment_approve(self._open(), _bytes32(challenge), _bytes32(key), now))

    def enrollment_cancel(self):
        _check(_lib.sc_host_enrollment_cancel(self._open()))

    def receive_at(self, frame, now):
        if not isinstance(frame, bytes):
            raise ValueError("frame must be bytes")
        _check(_lib.sc_host_receive_at(self._open(), frame, len(frame), now))

    @staticmethod
    def _uint64(value):
        if isinstance(value,bool) or not isinstance(value,int) or not 0<=value<2**64:
            raise ValueError("value must be a uint64")
        return value

    def set_credits_issued(self, total):
        _check(_lib.sc_host_set_credits_issued(self._open(), self._uint64(total)))

    def consume_credits(self, amount):
        _check(_lib.sc_host_consume_credits(self._open(), self._uint64(amount)))

    def request_credit_status(self):
        _check(_lib.sc_host_request_credit_status(self._open()))

    def update_group(self, group_id, updates):
        """Atomically apply [(field_id, type, value)], validated by the schema."""
        types={"uint64":1,"int64":2,"bool":3,"text":4,"bytes":5}
        data=bytearray()
        for field,kind,value in updates:
            tag=types[kind]
            if tag in (1,2):
                if isinstance(value,bool) or not isinstance(value,int):raise ValueError("integer required")
                raw=value.to_bytes(8,"big",signed=tag==2)
            elif tag==3:
                if not isinstance(value,bool):raise ValueError("Boolean required")
                raw=bytes([value])
            elif tag==4:raw=value.encode("utf-8")
            else:
                if not isinstance(value,bytes):raise ValueError("bytes required")
                raw=value
            if len(raw)>64:raise ValueError("resource exceeds value bound")
            data+=int(field).to_bytes(2,"big")+bytes([tag,len(raw)])+raw
        if not 0<group_id<65536:raise ValueError("invalid group")
        _check(_lib.sc_host_update_group(self._open(),group_id,bytes(data),len(data)))

    def request_group(self, group_id):
        if not 0<group_id<65536:raise ValueError("invalid group")
        _check(_lib.sc_host_request_group(self._open(),group_id))

    def inspect_group(self, group_id):
        if not 0<group_id<65536:raise ValueError("invalid group")
        out=_ffi.new("char[1024]");_check(_lib.sc_host_inspect_group(self._open(),group_id,out,1024))
        result=json.loads(_ffi.string(out));data=bytes.fromhex(result.pop("data"));values={}
        while data:
            field=int.from_bytes(data[:2],"big");tag,n=data[2:4];raw=data[4:4+n];data=data[4+n:]
            values[field]=int.from_bytes(raw,"big",signed=tag==2) if tag in (1,2) else bool(raw[0]) if tag==3 else raw.decode("utf-8") if tag==4 else raw
        result["values"]=values
        return result

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
