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

// Error represents native host failure with a stable status token.
type Error struct {
	// Status is the stable native failure token.
	Status string
}

// Error returns the stable native status token.
func (e *Error) Error() string { return e.Status }
func check(code C.int) error {
	if code == 0 {
		return nil
	}
	return &Error{C.GoString(C.sc_host_status(code))}
}

// Config represents initialization inputs copied by the native provider.
type Config struct {
	// Role is "device" or "server".
	Role string
	// Storage is a private durable store directory.
	Storage string
	// Serial is 1 through 32 printable ASCII bytes.
	Serial string
	// Secret is a required 32-byte enrollment secret.
	Secret []byte
	// ProvisionedSeed optionally supplies a trusted 32-byte identity seed.
	ProvisionedSeed []byte
	// ServerPublicKey is the required 32-byte Ed25519 server pin for a device.
	ServerPublicKey []byte
	// RandomUnavailable injects entropy failure in fixtures; applications use false.
	RandomUnavailable bool
}

// Endpoint represents an owned native handle; close it and externally synchronize concurrent calls.
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

// Initialize opens or create a durable endpoint with an exclusive store lock. Configuration
// bytes are copied by the native provider. Existing incompatible or corrupt stores fail instead
// of replacing identities.
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

// Close closes the native handle and release its exclusive store lock. Repeated closes are
// harmless; do not use the endpoint afterward.
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

// SetCreditsIssued sets the cumulative issued total on an enrolled server. The uint64 total must
// not decrease. Success commits locally and queues work; it does not deliver a frame.
func (e *Endpoint) SetCreditsIssued(total uint64) error {
	if err := e.valid(); err != nil {
		return err
	}
	return check(C.sc_host_set_credits_issued(e.handle, C.uint64_t(total)))
}

// ConsumeCredits consumes a positive uint64 amount on an enrolled device. Insufficient credits
// fail with conflict; overflow fails with exhausted. The server learns consumption through a
// later requested report.
func (e *Endpoint) ConsumeCredits(amount uint64) error {
	if err := e.valid(); err != nil {
		return err
	}
	return check(C.sc_host_consume_credits(e.handle, C.uint64_t(amount)))
}

// RequestCreditStatus persists a new credit report request on an enrolled server. Exchange the
// resulting request, response and receipt through application-owned transport.
func (e *Endpoint) RequestCreditStatus() error {
	if err := e.valid(); err != nil {
		return err
	}
	return check(C.sc_host_request_credit_status(e.handle))
}

// ResourceValue represents a schema-typed field update. Type values: 1=uint64,
// 2=int64, 3=Boolean, 4=UTF-8, 5=bytes. Only the corresponding member is used.
type ResourceValue struct {
	// FieldID identifies the field in its configured resource group.
	FieldID uint16
	// Type is the schema type tag: 1=uint64, 2=int64, 3=Boolean, 4=text, 5=bytes.
	Type uint8
	// Uint64 holds an unsigned value for type 1.
	Uint64 uint64
	// Int64 holds a signed value for type 2.
	Int64 int64
	// Boolean holds a Boolean value for type 3.
	Boolean bool
	// Text holds UTF-8 without embedded NUL for type 4.
	Text string
	// Bytes holds bounded arbitrary bytes for type 5.
	Bytes []byte
}

// UpdateGroup atomically replaces fields owned by this endpoint in id. Values must match the
// configured schema; invalid, duplicate, decreasing monotonic or wrong-owner updates fail
// without partial changes.
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

// RequestGroup queues and persists a resource-group snapshot request on an enrolled server.
// Unknown group IDs fail; no bytes are transferred automatically.
func (e *Endpoint) RequestGroup(id uint16) error {
	if err := e.valid(); err != nil {
		return err
	}
	return check(C.sc_host_request_group(e.handle, C.uint16_t(id)))
}

// InspectGroup returns a copied diagnostic snapshot of one group. Field values retain exact
// integer values; revision counters are decimal strings. Device-owned values on the server are
// last reported values.
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

// Receive authenticates one complete protocol frame without a trusted clock. Unapproved signed
// server enrollment fails closed; use ReceiveAt during enrollment.
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

// Outbound generates at most one frame within budget and capacity byte limits. An idle endpoint
// returns no frame. Bounds failures retain pending work. Generating a frame never delivers it.
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

// Inspect returns copied public-state diagnostics with uint64 counters as decimal strings. No
// private keys are exported, and this snapshot is not a restorable native context.
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

// Fail injects fixture-only failures into the next count storage, random or crypto operations.
// Zero clears the selected counter. This is not an application recovery API.
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

// FixturePublicKey derives a public key from a 32-byte fixture seed. Use independently generated
// provisioning secrets for real deployments.
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

// FixtureRevision provides fixture-only revision seeding for uint64 boundary tests. Requires an
// explicitly testing-enabled native library; production builds reject it.
func (e *Endpoint) FixtureRevision(revision uint64) error {
	if err := e.valid(); err != nil {
		return err
	}
	return check(C.sc_host_fixture_revision(e.handle, C.uint64_t(revision)))
}

// EnrollmentEnable persistently enables signed enrollment before registration. This mode cannot
// be disabled.
func (e *Endpoint) EnrollmentEnable() error { return check(C.sc_host_enrollment_enable(e.handle)) }

// EnrollmentBegin authorizes a new server enrollment session. now and expires use the same
// trusted server clock and application-defined units; expires must be greater than now. A fresh
// challenge replaces any prior candidate.
func (e *Endpoint) EnrollmentBegin(now, expires uint64) error {
	return check(C.sc_host_enrollment_begin(e.handle, C.uint64_t(now), C.uint64_t(expires)))
}

// EnrollmentApprove approves the exact 32-byte challenge and candidate Ed25519 key at trusted
// server time now. The application must authorize the serial/session/key binding. Stale or
// expired approvals fail.
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

// EnrollmentCancel cancels an unregistered server session durably. This does not revoke an
// enrolled peer.
func (e *Endpoint) EnrollmentCancel() error { return check(C.sc_host_enrollment_cancel(e.handle)) }

// ReceiveAt authenticates one complete frame using trusted server time now for enrollment
// expiry. Accepted changes are persisted; responses remain pending for outbound transport.
func (e *Endpoint) ReceiveAt(frame []byte, now uint64) error {
	if len(frame) == 0 {
		return &Error{"bounds"}
	}
	return check(C.sc_host_receive_at(e.handle, (*C.uint8_t)(unsafe.Pointer(&frame[0])), C.size_t(len(frame)), C.uint64_t(now)))
}
