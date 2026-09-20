// Package simplecrypts binds the shared C core and host provider through cgo.
// An Endpoint owns one native handle and must be closed. It is single-owner;
// callers synchronize concurrent access. No API exports a private key.
package simplecrypts

/*
#cgo CFLAGS: -I${SRCDIR}/../..
#cgo LDFLAGS: -L${SRCDIR}/../../build -lsimplecrypts
#include <stdlib.h>
#include "providers/host/sc_host.h"
*/
import "C"
import (
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"unsafe"
)

type Error struct{ Status string }

func (e *Error) Error() string { return e.Status }
func check(code C.int) error {
	if code == 0 {
		return nil
	}
	return &Error{C.GoString(C.sc_host_status(code))}
}

type Config struct {
	Role, Storage, Serial                    string
	Secret, ProvisionedSeed, ServerPublicKey []byte
	RandomUnavailable                        bool
}
type Endpoint struct{ handle *C.sc_host }

func ptr32(value []byte, optional bool) (*C.uint8_t, error) {
	if optional && value == nil {
		return nil, nil
	}
	if len(value) != 32 {
		return nil, errors.New("expected 32-byte key, seed or enrollment secret")
	}
	return (*C.uint8_t)(unsafe.Pointer(&value[0])), nil
}
func Initialize(config Config) (*Endpoint, error) {
	role := C.int(0)
	if config.Role == "device" {
		role = 1
	} else if config.Role == "server" {
		role = 2
	}
	if role == 0 || strings.ContainsRune(config.Storage, 0) || strings.ContainsRune(config.Serial, 0) {
		return nil, &Error{"invalid"}
	}
	secret, err := ptr32(config.Secret, false)
	if err != nil {
		return nil, err
	}
	seed, err := ptr32(config.ProvisionedSeed, true)
	if err != nil {
		return nil, err
	}
	peer, err := ptr32(config.ServerPublicKey, true)
	if err != nil {
		return nil, err
	}
	storage, serial := C.CString(config.Storage), C.CString(config.Serial)
	defer C.free(unsafe.Pointer(storage))
	defer C.free(unsafe.Pointer(serial))
	random := C.int(0)
	if config.RandomUnavailable {
		random = 1
	}
	endpoint := &Endpoint{}
	if err = check(C.sc_host_initialize(role, storage, serial, secret, seed, peer, random, &endpoint.handle)); err != nil {
		return nil, err
	}
	return endpoint, nil
}
func (e *Endpoint) Close() {
	if e != nil && e.handle != nil {
		C.sc_host_close(e.handle)
		e.handle = nil
	}
}
func (e *Endpoint) valid() error {
	if e == nil || e.handle == nil {
		return &Error{"invalid"}
	}
	return nil
}
func (e *Endpoint) SetCreditsIssued(total uint64) error {
	if err := e.valid(); err != nil {
		return err
	}
	return check(C.sc_host_set_credits_issued(e.handle, C.uint64_t(total)))
}
func (e *Endpoint) ConsumeCredits(amount uint64) error {
	if err := e.valid(); err != nil {
		return err
	}
	return check(C.sc_host_consume_credits(e.handle, C.uint64_t(amount)))
}
func (e *Endpoint) RequestCreditStatus() error {
	if err := e.valid(); err != nil {
		return err
	}
	return check(C.sc_host_request_credit_status(e.handle))
}

// ResourceValue represents a schema-typed field update. Type values: 1=uint64,
// 2=int64, 3=Boolean, 4=UTF-8, 5=bytes. Only the corresponding member is used.
type ResourceValue struct {
	FieldID uint16
	Type    uint8
	Uint64  uint64
	Int64   int64
	Boolean bool
	Text    string
	Bytes   []byte
}

func (e *Endpoint) UpdateGroup(id uint16, updates []ResourceValue) error {
	if err := e.valid(); err != nil {
		return err
	}
	var data []byte
	for _, v := range updates {
		var raw []byte
		switch v.Type {
		case 1, 2:
			raw = make([]byte, 8)
			n := v.Uint64
			if v.Type == 2 {
				n = uint64(v.Int64)
			}
			binary.BigEndian.PutUint64(raw, n)
		case 3:
			raw = []byte{0}
			if v.Boolean {
				raw[0] = 1
			}
		case 4:
			raw = []byte(v.Text)
		case 5:
			raw = append([]byte(nil), v.Bytes...)
		default:
			return &Error{"invalid"}
		}
		if len(raw) > 64 {
			return &Error{"buffer"}
		}
		data = append(data, byte(v.FieldID>>8), byte(v.FieldID), v.Type, byte(len(raw)))
		data = append(data, raw...)
	}
	if len(data) == 0 {
		return &Error{"invalid"}
	}
	return check(C.sc_host_update_group(e.handle, C.uint16_t(id), (*C.uint8_t)(unsafe.Pointer(&data[0])), C.size_t(len(data))))
}
func (e *Endpoint) RequestGroup(id uint16) error {
	if err := e.valid(); err != nil {
		return err
	}
	return check(C.sc_host_request_group(e.handle, C.uint16_t(id)))
}

// InspectGroup returns copied typed values and exact decimal-string counters.
func (e *Endpoint) InspectGroup(id uint16) (map[string]any, error) {
	if err := e.valid(); err != nil {
		return nil, err
	}
	out := make([]byte, 1024)
	if err := check(C.sc_host_inspect_group(e.handle, C.uint16_t(id), (*C.char)(unsafe.Pointer(&out[0])), C.size_t(len(out)))); err != nil {
		return nil, err
	}
	var result map[string]any
	for i, v := range out {
		if v == 0 {
			err := json.Unmarshal(out[:i], &result)
			if err != nil {
				return nil, err
			}
			data, err := hex.DecodeString(result["data"].(string))
			if err != nil {
				return nil, err
			}
			values := make(map[uint16]any)
			for len(data) > 0 {
				if len(data) < 4 || int(data[3])+4 > len(data) {
					return nil, &Error{"invalid"}
				}
				id := binary.BigEndian.Uint16(data[:2])
				tag, n := data[2], int(data[3])
				raw := data[4 : 4+n]
				switch tag {
				case 1:
					if n != 8 {
						return nil, &Error{"invalid"}
					}
					values[id] = binary.BigEndian.Uint64(raw)
				case 2:
					if n != 8 {
						return nil, &Error{"invalid"}
					}
					values[id] = int64(binary.BigEndian.Uint64(raw))
				case 3:
					if n != 1 {
						return nil, &Error{"invalid"}
					}
					values[id] = raw[0] != 0
				case 4:
					values[id] = string(raw)
				case 5:
					values[id] = append([]byte(nil), raw...)
				default:
					return nil, &Error{"invalid"}
				}
				data = data[4+n:]
			}
			delete(result, "data")
			result["values"] = values
			return result, nil
		}
	}
	return nil, &Error{"invalid"}
}
func (e *Endpoint) Receive(frame []byte) error {
	if err := e.valid(); err != nil {
		return err
	}
	var p *C.uint8_t
	if len(frame) != 0 {
		p = (*C.uint8_t)(unsafe.Pointer(&frame[0]))
	}
	return check(C.sc_host_receive(e.handle, p, C.size_t(len(frame))))
}

// Outbound returns nil,nil when idle. Buffer and budget failures retain work.
func (e *Endpoint) Outbound(budget, capacity int) ([]byte, error) {
	if err := e.valid(); err != nil {
		return nil, err
	}
	if budget < 0 || capacity < 0 || capacity > 65536 {
		return nil, &Error{"invalid"}
	}
	buffer := make([]byte, max(1, capacity))
	var size C.size_t
	code := C.sc_host_outbound(e.handle, C.size_t(budget), (*C.uint8_t)(unsafe.Pointer(&buffer[0])), C.size_t(capacity), &size)
	if code == 1 {
		return nil, nil
	}
	if err := check(code); err != nil {
		return nil, err
	}
	return buffer[:int(size)], nil
}

// Inspect returns exact decimal strings for 64-bit counters.
func (e *Endpoint) Inspect() (map[string]any, error) {
	if err := e.valid(); err != nil {
		return nil, err
	}
	buffer := make([]byte, 4096)
	if err := check(C.sc_host_inspect(e.handle, (*C.char)(unsafe.Pointer(&buffer[0])), C.size_t(len(buffer)))); err != nil {
		return nil, err
	}
	var state map[string]any
	err := json.Unmarshal([]byte(C.GoString((*C.char)(unsafe.Pointer(&buffer[0])))), &state)
	return state, err
}
func (e *Endpoint) Fail(operation string, count uint32) error {
	if err := e.valid(); err != nil {
		return err
	}
	if strings.ContainsRune(operation, 0) {
		return &Error{"invalid"}
	}
	p := C.CString(operation)
	defer C.free(unsafe.Pointer(p))
	return check(C.sc_host_fail(e.handle, p, C.uint(count)))
}

// FixturePublicKey derives a public key from a TEST provisioning seed.
func FixturePublicKey(seed []byte) ([]byte, error) {
	p, err := ptr32(seed, false)
	if err != nil {
		return nil, err
	}
	result := make([]byte, 32)
	if err = check(C.sc_host_fixture_public(p, (*C.uint8_t)(unsafe.Pointer(&result[0])))); err != nil {
		return nil, err
	}
	return result, nil
}
func (e *Endpoint) FixtureRevision(revision uint64) error {
	if err := e.valid(); err != nil {
		return err
	}
	return check(C.sc_host_fixture_revision(e.handle, C.uint64_t(revision)))
}

// Enrollment methods are trusted application operations, never relay commands.
func (e *Endpoint) EnrollmentEnable() error { return check(C.sc_host_enrollment_enable(e.handle)) }
func (e *Endpoint) EnrollmentBegin(now, expires uint64) error {
	return check(C.sc_host_enrollment_begin(e.handle, C.uint64_t(now), C.uint64_t(expires)))
}
func (e *Endpoint) EnrollmentApprove(challenge, key []byte, now uint64) error {
	c, err := ptr32(challenge, false)
	if err != nil {
		return err
	}
	k, err := ptr32(key, false)
	if err != nil {
		return err
	}
	return check(C.sc_host_enrollment_approve(e.handle, c, k, C.uint64_t(now)))
}
func (e *Endpoint) EnrollmentCancel() error { return check(C.sc_host_enrollment_cancel(e.handle)) }
func (e *Endpoint) ReceiveAt(frame []byte, now uint64) error {
	if len(frame) == 0 {
		return &Error{"bounds"}
	}
	return check(C.sc_host_receive_at(e.handle, (*C.uint8_t)(unsafe.Pointer(&frame[0])), C.size_t(len(frame)), C.uint64_t(now)))
}
