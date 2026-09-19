//! Safe owned Rust bindings to the common core and durable host provider.
//! One Endpoint is one role and one peer; Drop closes its native handle.
//! Endpoint is deliberately neither Send nor Sync. No private key is exported.
use std::ffi::{c_char,c_int,c_uint,c_void,CStr,CString};
use std::fmt;
use std::marker::PhantomData;
use std::ptr::NonNull;
use std::rc::Rc;

#[link(name="simplecrypts")]
extern "C" {
    fn sc_host_initialize(role:c_int,storage:*const c_char,serial:*const c_char,secret:*const u8,seed:*const u8,server_key:*const u8,random_unavailable:c_int,out:*mut *mut c_void)->c_int;
    fn sc_host_enrollment_enable(h:*mut c_void)->c_int;
    fn sc_host_enrollment_begin(h:*mut c_void,now:u64,expires:u64)->c_int;
    fn sc_host_enrollment_approve(h:*mut c_void,challenge:*const u8,key:*const u8,now:u64)->c_int;
    fn sc_host_enrollment_cancel(h:*mut c_void)->c_int;
    fn sc_host_receive_at(h:*mut c_void,frame:*const u8,size:usize,now:u64)->c_int;
    fn sc_host_close(host:*mut c_void);
    fn sc_host_name(host:*mut c_void,name:*const c_char)->c_int;
    fn sc_host_report(host:*mut c_void,temperature:i32)->c_int;
    fn sc_host_receive(host:*mut c_void,frame:*const u8,size:usize)->c_int;
    fn sc_host_outbound(host:*mut c_void,budget:usize,frame:*mut u8,capacity:usize,size:*mut usize)->c_int;
    fn sc_host_inspect(host:*mut c_void,json:*mut c_char,capacity:usize)->c_int;
    fn sc_host_status(status:c_int)->*const c_char;
    fn sc_host_fail(host:*mut c_void,operation:*const c_char,count:c_uint)->c_int;
    fn sc_host_fixture_public(seed:*const u8,key:*mut u8)->c_int;
    fn sc_host_fixture_revision(host:*mut c_void,revision:u64)->c_int;
}

#[derive(Debug,Clone,PartialEq,Eq)]
pub struct Error { pub status:String }
impl Error { pub fn invalid()->Self { Self{status:"invalid".into()} } }
impl fmt::Display for Error { fn fmt(&self,f:&mut fmt::Formatter<'_>)->fmt::Result { self.status.fmt(f) } }
impl std::error::Error for Error {}
fn check(code:c_int)->Result<(),Error> {
    if code==0 {Ok(())} else {
        // The provider returns a static, NUL-terminated status string.
        let status=unsafe{CStr::from_ptr(sc_host_status(code))}.to_string_lossy().into_owned();
        Err(Error{status})
    }
}
fn cstr(value:&str)->Result<CString,Error>{CString::new(value).map_err(|_|Error::invalid())}
#[derive(Clone,Copy)]
pub enum Role { Device,Server }
pub struct Config<'a> {
    pub role:Role,pub storage:&'a str,pub serial:&'a str,pub secret:&'a [u8;32],
    pub provisioned_seed:Option<&'a [u8;32]>,pub server_public_key:Option<&'a [u8;32]>,pub random_unavailable:bool,
}
pub struct Endpoint { handle:NonNull<c_void>,_single_owner:PhantomData<Rc<()>> }
impl Endpoint {
    /// Explicitly closes the endpoint by consuming it. Rust ownership prevents
    /// a second close or use after close; dropping an Endpoint also closes it.
    pub fn close(self) { drop(self) }
    pub fn initialize(config:Config<'_>)->Result<Self,Error>{
        let storage=cstr(config.storage)?;let serial=cstr(config.serial)?;
        let mut handle=std::ptr::null_mut();
        // All buffers remain alive across this synchronous call. The native
        // implementation copies inputs and returns an independently owned handle.
        check(unsafe{sc_host_initialize(match config.role{Role::Device=>1,Role::Server=>2},storage.as_ptr(),serial.as_ptr(),config.secret.as_ptr(),config.provisioned_seed.map_or(std::ptr::null(),|v|v.as_ptr()),config.server_public_key.map_or(std::ptr::null(),|v|v.as_ptr()),config.random_unavailable as c_int,&mut handle)})?;
        Ok(Self{handle:NonNull::new(handle).ok_or_else(Error::invalid)?,_single_owner:PhantomData})
    }
    pub fn enrollment_enable(&mut self)->Result<(),Error>{check(unsafe{sc_host_enrollment_enable(self.handle.as_ptr())})}
    pub fn enrollment_begin(&mut self,now:u64,expires:u64)->Result<(),Error>{check(unsafe{sc_host_enrollment_begin(self.handle.as_ptr(),now,expires)})}
    pub fn enrollment_approve(&mut self,challenge:&[u8;32],key:&[u8;32],now:u64)->Result<(),Error>{check(unsafe{sc_host_enrollment_approve(self.handle.as_ptr(),challenge.as_ptr(),key.as_ptr(),now)})}
    pub fn enrollment_cancel(&mut self)->Result<(),Error>{check(unsafe{sc_host_enrollment_cancel(self.handle.as_ptr())})}
    pub fn receive_at(&mut self,frame:&[u8],now:u64)->Result<(),Error>{check(unsafe{sc_host_receive_at(self.handle.as_ptr(),frame.as_ptr(),frame.len(),now)})}
    pub fn name(&mut self,value:&str)->Result<(),Error>{let value=cstr(value)?;check(unsafe{sc_host_name(self.handle.as_ptr(),value.as_ptr())})}
    pub fn report(&mut self,temperature_millidegrees:i32)->Result<(),Error>{check(unsafe{sc_host_report(self.handle.as_ptr(),temperature_millidegrees)})}
    pub fn receive(&mut self,frame:&[u8])->Result<(),Error>{check(unsafe{sc_host_receive(self.handle.as_ptr(),frame.as_ptr(),frame.len())})}
    /// None means idle. Failed budget or capacity checks retain pending work.
    pub fn outbound(&mut self,budget:usize,capacity:usize)->Result<Option<Vec<u8>>,Error>{
        if capacity>65536{return Err(Error::invalid())}
        let mut frame=vec![0u8;capacity.max(1)];let mut length=0usize;
        let code=unsafe{sc_host_outbound(self.handle.as_ptr(),budget,frame.as_mut_ptr(),capacity,&mut length)};
        if code==1{return Ok(None)};check(code)?;
        if length>capacity{return Err(Error{status:"internal".into()})}
        frame.truncate(length);Ok(Some(frame))
    }
    /// Diagnostics retain all 64-bit counters as exact decimal strings.
    pub fn inspect(&self)->Result<serde_json::Value,Error>{
        let mut buffer=[0u8;4096];check(unsafe{sc_host_inspect(self.handle.as_ptr(),buffer.as_mut_ptr().cast(),buffer.len())})?;
        let length=buffer.iter().position(|&v|v==0).ok_or_else(Error::invalid)?;
        serde_json::from_slice(&buffer[..length]).map_err(|_|Error{status:"internal".into()})
    }
    pub fn fail(&mut self,operation:&str,count:u32)->Result<(),Error>{let operation=cstr(operation)?;check(unsafe{sc_host_fail(self.handle.as_ptr(),operation.as_ptr(),count)})}
    /// Fixture-only counter boundary testing; absent from production builds.
    pub fn fixture_revision(&mut self,revision:u64)->Result<(),Error>{check(unsafe{sc_host_fixture_revision(self.handle.as_ptr(),revision)})}
}
impl Drop for Endpoint {fn drop(&mut self){unsafe{sc_host_close(self.handle.as_ptr())}}}
/// Test provisioning helper. Production devices receive the server public key.
pub fn fixture_public_key(seed:&[u8;32])->Result<[u8;32],Error>{let mut key=[0u8;32];check(unsafe{sc_host_fixture_public(seed.as_ptr(),key.as_mut_ptr())})?;Ok(key)}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64,Ordering};
    static NEXT:AtomicU64=AtomicU64::new(0);
    fn fixture(role:Role)->(Endpoint,std::path::PathBuf){
        let root=std::env::var_os("TEST_TMPDIR").map(std::path::PathBuf::from).unwrap_or_else(std::env::temp_dir);
        let path=root.join(format!("simplecrypts-rust-sdk-{}-{}",std::process::id(),NEXT.fetch_add(1,Ordering::Relaxed)));
        let peer=fixture_public_key(&[0x22;32]).unwrap();
        let seed=match role{Role::Device=>[0x11;32],Role::Server=>[0x22;32]};
        let endpoint=Endpoint::initialize(Config{role,storage:path.to_str().unwrap(),serial:"sdk-rust",secret:&[0x33;32],provisioned_seed:Some(&seed),server_public_key:Some(&peer),random_unavailable:true}).unwrap();
        (endpoint,path)
    }
    #[test]
    fn owned_buffers_and_state(){
        let(mut endpoint,path)=fixture(Role::Device);
        endpoint.report(1).unwrap();let first=endpoint.outbound(512,512).unwrap().unwrap();let saved=first.clone();let state=endpoint.inspect().unwrap();
        endpoint.report(2).unwrap();let second=endpoint.outbound(512,512).unwrap().unwrap();
        assert_eq!(first,saved);assert_ne!(first,second);assert_eq!(state["reported_revision"],"1");
        endpoint.close();std::fs::remove_dir_all(path).unwrap();
    }
    #[test]
    fn exact_counters_and_errors(){
        let(mut endpoint,path)=fixture(Role::Device);let revision=(1u64<<53)+19;
        endpoint.fixture_revision(revision).unwrap();endpoint.report(i32::MIN).unwrap();
        assert_eq!(endpoint.inspect().unwrap()["reported_revision"],(revision+1).to_string());
        assert!(endpoint.receive(&[1,2,3]).is_err());assert!(endpoint.outbound(1,1).is_err());
        endpoint.close();std::fs::remove_dir_all(path).unwrap();
        let(mut server,path)=fixture(Role::Server);
        assert!(server.name(&"x".repeat(65)).is_err());assert!(server.name("bad\0name").is_err());
        server.close();std::fs::remove_dir_all(path).unwrap();
    }
    #[test]
    fn exhaustion_does_not_wrap(){
        let(mut endpoint,path)=fixture(Role::Device);endpoint.fixture_revision(u64::MAX-1).unwrap();endpoint.report(1).unwrap();
        assert_eq!(endpoint.report(2).unwrap_err().status,"exhausted");let state=endpoint.inspect().unwrap();
        assert_eq!(state["reported_revision"],u64::MAX.to_string());assert_eq!(state["temperature"],1);
        endpoint.close();std::fs::remove_dir_all(path).unwrap();
    }
}
