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
func (e *Endpoint) Name(name string) error {
	if err := e.valid(); err != nil {
		return err
	}
	if strings.ContainsRune(name, 0) {
		return &Error{"invalid"}
	}
	p := C.CString(name)
	defer C.free(unsafe.Pointer(p))
	return check(C.sc_host_name(e.handle, p))
}
func (e *Endpoint) Report(temperature int32) error {
	if err := e.valid(); err != nil {
		return err
	}
	return check(C.sc_host_report(e.handle, C.int32_t(temperature)))
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
