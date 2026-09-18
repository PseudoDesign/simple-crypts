//! JSONL fixture adapter exercising the public Rust SDK.
use simplecrypts::{Config,Endpoint,Error,Role,fixture_public_key};
use serde_json::{Value,json};
use std::io::{self,BufRead,Write};
fn text<'a>(v:&'a Value,key:&str,default:&'a str)->&'a str {v.get(key).and_then(Value::as_str).unwrap_or(default)}
fn number(v:&Value,key:&str,default:u64)->Result<u64,Error>{match v.get(key){None=>Ok(default),Some(n)=>n.as_u64().ok_or_else(Error::invalid)}}
fn hex32(s:&str)->Result<[u8;32],Error>{
    if s.len()!=64 || !s.is_ascii(){return Err(Error::invalid())}let mut out=[0;32];
    for(i,b)in out.iter_mut().enumerate(){*b=u8::from_str_radix(&s[i*2..i*2+2],16).map_err(|_|Error::invalid())?}Ok(out)
}
const B64:&[u8;64]=b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
fn encode(bytes:&[u8])->String{
    let mut out=String::new();for part in bytes.chunks(3){let a=part[0]as usize;let b=*part.get(1).unwrap_or(&0)as usize;let c=*part.get(2).unwrap_or(&0)as usize;out.push(B64[a>>2]as char);out.push(B64[((a&3)<<4)|(b>>4)]as char);out.push(if part.len()>1{B64[((b&15)<<2)|(c>>6)]as char}else{'='});out.push(if part.len()>2{B64[c&63]as char}else{'='});}out
}
fn decode(s:&str)->Result<Vec<u8>,Error>{
    if s.len()%4!=0{return Err(Error::invalid())}let mut out=Vec::new();
    for(i,p)in s.as_bytes().chunks(4).enumerate(){let mut n=[0u8;4];let mut padding=0;for j in 0..4{if p[j]==b'='{padding+=1;if j<2||i+1!=s.len()/4{return Err(Error::invalid())}}else{if padding>0{return Err(Error::invalid())}n[j]=B64.iter().position(|&x|x==p[j]).ok_or_else(Error::invalid)?as u8;}}if padding>2||(padding==2&&n[1]&15!=0)||(padding==1&&n[2]&3!=0){return Err(Error::invalid())}out.push((n[0]<<2)|(n[1]>>4));if padding<2{out.push((n[1]<<4)|(n[2]>>2))}if padding<1{out.push((n[2]<<6)|n[3])}}
    Ok(out)
}
fn perform(endpoint:&mut Option<Endpoint>,v:&Value,out:&mut Value)->Result<(),Error>{
    let command=text(v,"command",text(v,"cmd",text(v,"op","")));
    if command=="init"{
        if endpoint.is_some(){return Err(Error::invalid())}
        let role=match text(v,"role",""){"device"=>Role::Device,"server"=>Role::Server,_=>return Err(Error::invalid())};
        let secret=hex32(text(v,"secret","3333333333333333333333333333333333333333333333333333333333333333"))?;
        let seed=match v.get("key_seed"){None|Some(Value::Null)=>None,Some(x)=>Some(hex32(x.as_str().ok_or_else(Error::invalid)?)?)};
        let server=if let Some(p)=v.get("server_public_key"){hex32(p.as_str().ok_or_else(Error::invalid)?)?}else{fixture_public_key(&hex32(text(v,"server_seed","2222222222222222222222222222222222222222222222222222222222222222"))?)?};
        *endpoint=Some(Endpoint::initialize(Config{role,storage:text(v,"storage",""),serial:text(v,"serial","SAMPLE-001"),secret:&secret,provisioned_seed:seed.as_ref(),server_public_key:Some(&server),random_unavailable:v.get("random_unavailable").and_then(Value::as_bool).unwrap_or(false)||v.get("provision_without_random").and_then(Value::as_bool).unwrap_or(false)})?);
        if let Some(rev)=v.get("initial_revision"){let revision=rev.as_str().ok_or_else(Error::invalid)?.parse::<u64>().map_err(|_|Error::invalid())?;endpoint.as_mut().unwrap().fixture_revision(revision)?}return Ok(())
    }
    if command=="close"{if endpoint.take().is_none(){return Err(Error::invalid())}return Ok(())}
    let e=endpoint.as_mut().ok_or_else(Error::invalid)?;
    match command{
        "state"=>Ok(()),"name"=>e.name(text(v,"name","")),
        "report"=>{let temp=v.get("temperature").or_else(||v.get("temperature_mC")).and_then(Value::as_i64).ok_or_else(Error::invalid)?;e.report(i32::try_from(temp).map_err(|_|Error::invalid())?)},
        "rx"=>e.receive(&decode(text(v,"frame",""))?),
        "tx"=>{let frame=e.outbound(number(v,"budget",512)?as usize,number(v,"capacity",512)?as usize)?;if let Some(frame)=frame{out["frame"]=json!(encode(&frame))}else{out["status"]=json!("idle")}Ok(())},
        "fail"=>e.fail(text(v,"operation",""),u32::try_from(number(v,"count",1)?).map_err(|_|Error::invalid())?),
        _=>Err(Error::invalid()),
    }
}
fn main(){
    let mut endpoint=None;let input=io::stdin();let mut output=io::stdout().lock();
    for line in input.lock().lines(){let Ok(line)=line else{break};let mut out=json!({"status":"ok"});
        let result=serde_json::from_str::<Value>(&line).map_err(|_|Error::invalid()).and_then(|v|perform(&mut endpoint,&v,&mut out));
        if let Err(error)=result{out["status"]=json!(error.status)}
        if let Some(ref e)=endpoint{if let Ok(state)=e.inspect(){out["state"]=state}}
        if writeln!(output,"{}",out).is_err(){break}let _=output.flush();
    }
}
