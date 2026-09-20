//! Owned Rust bindings to the synchronous C core and durable host provider.
//! Each endpoint has one peer and an exclusive store lock. Drop or close releases
//! the handle. Endpoints are neither Send nor Sync; no private keys are exported.
#![deny(missing_docs)]

/// Generated schema identifiers; checked against the canonical resource schema.
#[allow(missing_docs)] // The generated file is validated by resource_schema_check.
pub mod resources;
// Safe owned Rust bindings to the common core and durable host provider.
// One Endpoint is one role and one peer; Drop closes its native handle.
// Endpoint is deliberately neither Send nor Sync. No private key is exported.
use std::ffi::{c_char, c_int, c_uint, c_void, CStr, CString};
use std::fmt;
use std::marker::PhantomData;
use std::ptr::NonNull;
use std::rc::Rc;

#[link(name = "simplecrypts")]
extern "C" {
    fn sc_host_initialize(
        role: c_int,
        storage: *const c_char,
        serial: *const c_char,
        secret: *const u8,
        seed: *const u8,
        server_key: *const u8,
        random_unavailable: c_int,
        out: *mut *mut c_void,
    ) -> c_int;
    fn sc_host_enrollment_enable(h: *mut c_void) -> c_int;
    fn sc_host_enrollment_begin(h: *mut c_void, now: u64, expires: u64) -> c_int;
    fn sc_host_enrollment_approve(
        h: *mut c_void,
        challenge: *const u8,
        key: *const u8,
        now: u64,
    ) -> c_int;
    fn sc_host_enrollment_cancel(h: *mut c_void) -> c_int;
    fn sc_host_receive_at(h: *mut c_void, frame: *const u8, size: usize, now: u64) -> c_int;
    fn sc_host_update_group(host: *mut c_void, id: u16, data: *const u8, size: usize) -> c_int;
    fn sc_host_request_group(host: *mut c_void, id: u16) -> c_int;
    fn sc_host_inspect_group(
        host: *mut c_void,
        id: u16,
        out: *mut c_char,
        capacity: usize,
    ) -> c_int;
    fn sc_host_close(host: *mut c_void);
    fn sc_host_set_credits_issued(host: *mut c_void, total: u64) -> c_int;
    fn sc_host_consume_credits(host: *mut c_void, amount: u64) -> c_int;
    fn sc_host_request_credit_status(host: *mut c_void) -> c_int;
    fn sc_host_receive(host: *mut c_void, frame: *const u8, size: usize) -> c_int;
    fn sc_host_outbound(
        host: *mut c_void,
        budget: usize,
        frame: *mut u8,
        capacity: usize,
        size: *mut usize,
    ) -> c_int;
    fn sc_host_inspect(host: *mut c_void, json: *mut c_char, capacity: usize) -> c_int;
    fn sc_host_status(status: c_int) -> *const c_char;
    fn sc_host_fail(host: *mut c_void, operation: *const c_char, count: c_uint) -> c_int;
    fn sc_host_fixture_public(seed: *const u8, key: *mut u8) -> c_int;
    fn sc_host_fixture_revision(host: *mut c_void, revision: u64) -> c_int;
}

#[derive(Debug, Clone, PartialEq, Eq)]
/// Native host failure represented by its stable status token.
pub struct Error {
    /// Stable native status token.
    pub status: String,
}
impl Error {
    /// Construct an invalid-argument error without entering native code.
    pub fn invalid() -> Self {
        Self {
            status: "invalid".into(),
        }
    }
}
impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.status.fmt(f)
    }
}
impl std::error::Error for Error {}
fn check(code: c_int) -> Result<(), Error> {
    if code == 0 {
        Ok(())
    } else {
        // The provider returns a static, NUL-terminated status string.
        let status = unsafe { CStr::from_ptr(sc_host_status(code)) }
            .to_string_lossy()
            .into_owned();
        Err(Error { status })
    }
}
fn cstr(value: &str) -> Result<CString, Error> {
    CString::new(value).map_err(|_| Error::invalid())
}
#[derive(Clone, Copy)]
/// Endpoint role; every handle represents one device/server peer.
pub enum Role {
    /// Device role; owns consumption.
    Device,
    /// Server role; owns credit issuance.
    Server,
}
/// Borrowed initialization inputs copied by the native provider.
pub struct Config<'a> {
    /// Device or server role.
    pub role: Role,
    /// Private persistent store directory.
    pub storage: &'a str,
    /// Printable ASCII serial of 1 through 32 bytes.
    pub serial: &'a str,
    /// 32-byte enrollment secret; must match an existing store.
    pub secret: &'a [u8; 32],
    /// Optional trusted 32-byte identity seed; None creates fresh keys for a new store.
    pub provisioned_seed: Option<&'a [u8; 32]>,
    /// 32-byte pinned server Ed25519 key, required on a device.
    pub server_public_key: Option<&'a [u8; 32]>,
    /// Fixture-only entropy failure switch; use false in applications.
    pub random_unavailable: bool,
}
#[derive(Debug, Clone, PartialEq)]
/// Owned typed resource value; strings are UTF-8 and byte arrays are bounded.
pub enum ResourceValue {
    /// Unsigned 64-bit integer.
    Uint64(u64),
    /// Signed 64-bit integer.
    Int64(i64),
    /// Boolean value.
    Boolean(bool),
    /// UTF-8 text without embedded NUL.
    Text(String),
    /// Arbitrary bytes.
    Bytes(Vec<u8>),
}
/// Owned durable native endpoint; dropping it closes and wipes the native handle.
pub struct Endpoint {
    handle: NonNull<c_void>,
    _single_owner: PhantomData<Rc<()>>,
}
impl Endpoint {
    /// Explicitly closes the endpoint by consuming it. Rust ownership prevents
    /// a second close or use after close; dropping an Endpoint also closes it.
    pub fn close(self) {
        drop(self)
    }
    /// Open or create a durable endpoint with an exclusive store lock. Configuration bytes are
    /// copied by the native provider. Existing incompatible or corrupt stores fail instead of
    /// replacing identities.
    pub fn initialize(config: Config<'_>) -> Result<Self, Error> {
        let storage = cstr(config.storage)?;
        let serial = cstr(config.serial)?;
        let mut handle = std::ptr::null_mut();
        // All buffers remain alive across this synchronous call. The native
        // implementation copies inputs and returns an independently owned handle.
        check(unsafe {
            sc_host_initialize(
                match config.role {
                    Role::Device => 1,
                    Role::Server => 2,
                },
                storage.as_ptr(),
                serial.as_ptr(),
                config.secret.as_ptr(),
                config
                    .provisioned_seed
                    .map_or(std::ptr::null(), |v| v.as_ptr()),
                config
                    .server_public_key
                    .map_or(std::ptr::null(), |v| v.as_ptr()),
                config.random_unavailable as c_int,
                &mut handle,
            )
        })?;
        Ok(Self {
            handle: NonNull::new(handle).ok_or_else(Error::invalid)?,
            _single_owner: PhantomData,
        })
    }
    /// Persistently enable signed enrollment before registration. This mode cannot be disabled.
    pub fn enrollment_enable(&mut self) -> Result<(), Error> {
        check(unsafe { sc_host_enrollment_enable(self.handle.as_ptr()) })
    }
    /// Authorize a new server enrollment session. now and expires use the same trusted server clock
    /// and application-defined units; expires must be greater than now. A fresh challenge replaces
    /// any prior candidate.
    pub fn enrollment_begin(&mut self, now: u64, expires: u64) -> Result<(), Error> {
        check(unsafe { sc_host_enrollment_begin(self.handle.as_ptr(), now, expires) })
    }
    /// Approve the exact 32-byte challenge and candidate Ed25519 key at trusted server time now.
    /// The application must authorize the serial/session/key binding. Stale or expired approvals
    /// fail.
    pub fn enrollment_approve(
        &mut self,
        challenge: &[u8; 32],
        key: &[u8; 32],
        now: u64,
    ) -> Result<(), Error> {
        check(unsafe {
            sc_host_enrollment_approve(self.handle.as_ptr(), challenge.as_ptr(), key.as_ptr(), now)
        })
    }
    /// Cancel an unregistered server session durably. This does not revoke an enrolled peer.
    pub fn enrollment_cancel(&mut self) -> Result<(), Error> {
        check(unsafe { sc_host_enrollment_cancel(self.handle.as_ptr()) })
    }
    /// Authenticate one complete frame using trusted server time now for enrollment expiry.
    /// Accepted changes are persisted; responses remain pending for outbound transport.
    pub fn receive_at(&mut self, frame: &[u8], now: u64) -> Result<(), Error> {
        check(unsafe { sc_host_receive_at(self.handle.as_ptr(), frame.as_ptr(), frame.len(), now) })
    }
    /// Set the cumulative issued total on an enrolled server. The uint64 total must not decrease.
    /// Success commits locally and queues work; it does not deliver a frame.
    pub fn set_credits_issued(&mut self, total: u64) -> Result<(), Error> {
        check(unsafe { sc_host_set_credits_issued(self.handle.as_ptr(), total) })
    }
    /// Consume a positive uint64 amount on an enrolled device. Insufficient credits fail with
    /// conflict; overflow fails with exhausted. The server learns consumption through a later
    /// requested report.
    pub fn consume_credits(&mut self, amount: u64) -> Result<(), Error> {
        check(unsafe { sc_host_consume_credits(self.handle.as_ptr(), amount) })
    }
    /// Persist a new credit report request on an enrolled server. Exchange the resulting request,
    /// response and receipt through application-owned transport.
    pub fn request_credit_status(&mut self) -> Result<(), Error> {
        check(unsafe { sc_host_request_credit_status(self.handle.as_ptr()) })
    }
    /// Atomically replace fields owned by this endpoint in id. Values must match the configured
    /// schema; invalid, duplicate, decreasing monotonic or wrong-owner updates fail without partial
    /// changes.
    pub fn update_group(&mut self, id: u16, updates: &[(u16, ResourceValue)]) -> Result<(), Error> {
        let mut data = Vec::new();
        for (field, value) in updates {
            let (tag, raw) = match value {
                ResourceValue::Uint64(v) => (1, v.to_be_bytes().to_vec()),
                ResourceValue::Int64(v) => (2, v.to_be_bytes().to_vec()),
                ResourceValue::Boolean(v) => (3, vec![*v as u8]),
                ResourceValue::Text(v) => (4, v.as_bytes().to_vec()),
                ResourceValue::Bytes(v) => (5, v.clone()),
            };
            if raw.len() > 64 {
                return Err(Error::invalid());
            }
            data.extend(field.to_be_bytes());
            data.push(tag);
            data.push(raw.len() as u8);
            data.extend(raw);
        }
        check(unsafe { sc_host_update_group(self.handle.as_ptr(), id, data.as_ptr(), data.len()) })
    }
    /// Queue and persist a resource-group snapshot request on an enrolled server. Unknown group IDs
    /// fail; no bytes are transferred automatically.
    pub fn request_group(&mut self, id: u16) -> Result<(), Error> {
        check(unsafe { sc_host_request_group(self.handle.as_ptr(), id) })
    }
    /// Return a copied diagnostic snapshot of one group. Field values retain exact integer values;
    /// revision counters are decimal strings. Device-owned values on the server are last reported
    /// values.
    pub fn inspect_group(&self, id: u16) -> Result<serde_json::Value, Error> {
        let mut out = [0u8; 1024];
        check(unsafe {
            sc_host_inspect_group(self.handle.as_ptr(), id, out.as_mut_ptr().cast(), out.len())
        })?;
        let n = out
            .iter()
            .position(|v| *v == 0)
            .ok_or_else(Error::invalid)?;
        let mut result: serde_json::Value =
            serde_json::from_slice(&out[..n]).map_err(|_| Error::invalid())?;
        let hex = result["data"].as_str().ok_or_else(Error::invalid)?;
        let mut data = Vec::new();
        for pair in hex.as_bytes().chunks(2) {
            let text = std::str::from_utf8(pair).map_err(|_| Error::invalid())?;
            data.push(u8::from_str_radix(text, 16).map_err(|_| Error::invalid())?);
        }
        let mut values = serde_json::Map::new();
        let mut at = 0;
        while at < data.len() {
            if data.len() - at < 4 {
                return Err(Error::invalid());
            }
            let id = u16::from_be_bytes([data[at], data[at + 1]]);
            let tag = data[at + 2];
            let len = data[at + 3] as usize;
            at += 4;
            if data.len() - at < len {
                return Err(Error::invalid());
            }
            let raw = &data[at..at + len];
            let value = match tag {
                1 => serde_json::json!(u64::from_be_bytes(
                    raw.try_into().map_err(|_| Error::invalid())?
                )),
                2 => serde_json::json!(i64::from_be_bytes(
                    raw.try_into().map_err(|_| Error::invalid())?
                )),
                3 if len == 1 => serde_json::json!(raw[0] != 0),
                4 => serde_json::json!(std::str::from_utf8(raw).map_err(|_| Error::invalid())?),
                5 => serde_json::json!(raw),
                _ => return Err(Error::invalid()),
            };
            values.insert(id.to_string(), value);
            at += len;
        }
        result
            .as_object_mut()
            .ok_or_else(Error::invalid)?
            .remove("data");
        result["values"] = values.into();
        Ok(result)
    }
    /// Authenticate one complete protocol frame without a trusted clock. Unapproved signed server
    /// enrollment fails closed; use receive_at during enrollment.
    pub fn receive(&mut self, frame: &[u8]) -> Result<(), Error> {
        check(unsafe { sc_host_receive(self.handle.as_ptr(), frame.as_ptr(), frame.len()) })
    }
    /// Generate at most one frame within budget and capacity byte limits. An idle endpoint returns
    /// no frame. Bounds failures retain pending work. Generating a frame never delivers it.
    pub fn outbound(&mut self, budget: usize, capacity: usize) -> Result<Option<Vec<u8>>, Error> {
        if capacity > 65536 {
            return Err(Error::invalid());
        }
        let mut frame = vec![0u8; capacity.max(1)];
        let mut length = 0usize;
        let code = unsafe {
            sc_host_outbound(
                self.handle.as_ptr(),
                budget,
                frame.as_mut_ptr(),
                capacity,
                &mut length,
            )
        };
        if code == 1 {
            return Ok(None);
        };
        check(code)?;
        if length > capacity {
            return Err(Error {
                status: "internal".into(),
            });
        }
        frame.truncate(length);
        Ok(Some(frame))
    }
    /// Return copied public-state diagnostics with uint64 counters as decimal strings. No private
    /// keys are exported, and this snapshot is not a restorable native context.
    pub fn inspect(&self) -> Result<serde_json::Value, Error> {
        let mut buffer = [0u8; 4096];
        check(unsafe {
            sc_host_inspect(
                self.handle.as_ptr(),
                buffer.as_mut_ptr().cast(),
                buffer.len(),
            )
        })?;
        let length = buffer
            .iter()
            .position(|&v| v == 0)
            .ok_or_else(Error::invalid)?;
        serde_json::from_slice(&buffer[..length]).map_err(|_| Error {
            status: "internal".into(),
        })
    }
    /// Fixture-only injection: fail the next count storage, random or crypto operations. Zero
    /// clears the selected counter. This is not an application recovery API.
    pub fn fail(&mut self, operation: &str, count: u32) -> Result<(), Error> {
        let operation = cstr(operation)?;
        check(unsafe { sc_host_fail(self.handle.as_ptr(), operation.as_ptr(), count) })
    }
    /// Fixture-only revision seeding for uint64 boundary tests. Requires an explicitly testing-
    /// enabled native library; production builds reject it.
    pub fn fixture_revision(&mut self, revision: u64) -> Result<(), Error> {
        check(unsafe { sc_host_fixture_revision(self.handle.as_ptr(), revision) })
    }
}
impl Drop for Endpoint {
    fn drop(&mut self) {
        unsafe { sc_host_close(self.handle.as_ptr()) }
    }
}
/// Derive a public key from a 32-byte fixture seed. Use independently generated provisioning
/// secrets for real deployments.
pub fn fixture_public_key(seed: &[u8; 32]) -> Result<[u8; 32], Error> {
    let mut key = [0u8; 32];
    check(unsafe { sc_host_fixture_public(seed.as_ptr(), key.as_mut_ptr()) })?;
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    fn fixture(role: Role) -> (Endpoint, std::path::PathBuf) {
        let root = std::env::var_os("TEST_TMPDIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let path = root.join(format!(
            "simplecrypts-rust-sdk-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let peer = fixture_public_key(&[0x22; 32]).unwrap();
        let seed = match role {
            Role::Device => [0x11; 32],
            Role::Server => [0x22; 32],
        };
        let endpoint = Endpoint::initialize(Config {
            role,
            storage: path.to_str().unwrap(),
            serial: "sdk-rust",
            secret: &[0x33; 32],
            provisioned_seed: Some(&seed),
            server_public_key: match role {
                Role::Device => Some(&peer),
                Role::Server => None,
            },
            random_unavailable: true,
        })
        .unwrap();
        (endpoint, path)
    }
    #[test]
    fn credits_and_generic_resources() {
        let (mut d, dp) = fixture(Role::Device);
        let (mut s, sp) = fixture(Role::Server);
        let claim = d.outbound(512, 512).unwrap().unwrap();
        s.receive(&claim).unwrap();
        d.receive(&s.outbound(512, 512).unwrap().unwrap()).unwrap();
        s.set_credits_issued(u64::MAX).unwrap();
        let frame = s.outbound(512, 512).unwrap().unwrap();
        let saved = frame.clone();
        let old = d.inspect().unwrap();
        d.receive(&frame).unwrap();
        s.receive(&d.outbound(512, 512).unwrap().unwrap()).unwrap();
        d.receive(&s.outbound(512, 512).unwrap().unwrap()).unwrap();
        d.consume_credits((1 << 53) + 19).unwrap();
        assert!(d.outbound(512, 512).unwrap().is_none());
        assert_eq!(frame, saved);
        assert_eq!(old["credits_consumed"], "0");
        assert_eq!(
            d.inspect().unwrap()["credits_consumed"],
            ((1u64 << 53) + 19).to_string()
        );
        assert!(d
            .update_group(1, &[(1, ResourceValue::Uint64(10))])
            .is_err());
        assert!(d.update_group(1, &[(2, ResourceValue::Uint64(1))]).is_err());
        s.request_group(1).unwrap();
        d.receive(&s.outbound(512, 512).unwrap().unwrap()).unwrap();
        s.receive(&d.outbound(512, 512).unwrap().unwrap()).unwrap();
        d.receive(&s.outbound(512, 512).unwrap().unwrap()).unwrap();
        assert_eq!(s.inspect_group(1).unwrap()["snapshot_id"], "2");
        assert_eq!(
            s.inspect_group(1).unwrap()["values"]["2"].as_u64(),
            Some((1u64 << 53) + 19)
        );
        assert!(d.receive(&[1, 2, 3]).is_err());
        d.consume_credits(u64::MAX - ((1 << 53) + 19)).unwrap();
        assert!(d.consume_credits(1).is_err());
        d.close();
        s.close();
        std::fs::remove_dir_all(dp).unwrap();
        std::fs::remove_dir_all(sp).unwrap();
    }
}
