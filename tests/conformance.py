"""Cross-language resource and credit contract with a hostile deterministic relay."""
import argparse,base64,random
from coordinator import Relay,replay

def number(state,key):
 value=state[key];assert isinstance(value,str);return int(value)
def accepted(r):assert r['status']=='ok',r
def rejected(r):assert r['status'] not in ('ok','idle'),r
def enrolled(r):
 d,s=r.pair();r.exchange('device','server');r.exchange('server','device');assert d.state()['registered'];return d,s
def settle(r):
 r.exchange('server','device');r.exchange('device','server');r.exchange('server','device')
def first_exchange(r):
 d,s=enrolled(r);s.ok('issue',total='100');settle(r)
 d.ok('consume',amount='25');assert r.opportunity('device') is None
 assert number(d.state(),'credits_consumed')==25 and number(s.state(),'credits_consumed')==0
 s.ok('request');settle(r);assert number(s.state(),'credits_consumed')==25
 assert r.opportunity('device') is None and r.opportunity('server') is None
 rejected(d.command('consume',amount='76'));rejected(s.command('issue',total='99'))
 rejected(d.command('issue',total='200'));rejected(s.command('consume',amount='1'));rejected(d.command('consume',amount='0'))
def lost_initial(r):
 d,s=r.pair();r.drop(r.opportunity('device'));r.exchange('device','server');r.drop(r.opportunity('server'))
 r.exchange('device','server');r.exchange('server','device');assert d.state()['registered']
def authorization(r):
 d,s=r.pair(secret='44'*32);rejected(r.deliver(r.opportunity('device'),'server'));assert not s.state()['registered']
 legitimate, result = r.spawn('legitimate', 'device', key_seed='66'*32);accepted(result)
 r.exchange('legitimate','server');r.exchange('server','legitimate');before=s.state()
 for name, config in [('conflicting_key', {'key_seed':'55'*32}), ('conflicting_serial', {'serial':'different-device','key_seed':'77'*32})]:
  endpoint,result=r.spawn(name,'device',**config);accepted(result)
  rejected(r.deliver(r.opportunity(name),'server'));assert s.state()==before
def snapshots(r):
 d,s=enrolled(r);s.ok('issue',total='100');grant=r.exchange('server','device');d.ok('consume',amount='25')
 response=r.exchange('device','server');assert number(s.state(),'credits_consumed')==0
 r.drop(r.opportunity('server'));accepted(r.deliver(response,'server'));r.exchange('server','device')
 accepted(r.deliver(grant,'device'));r.exchange('device','server');assert number(s.state(),'credits_consumed')==0;r.exchange('server','device')
 s.ok('request');old=r.opportunity('server');s.ok('request');settle(r);accepted(r.deliver(old,'device'));assert not d.state()['pending']
 accepted(r.deliver(response,'server'));assert number(s.state(),'credits_consumed')==25
 s.ok('issue',total='200');new=r.exchange('server','device');accepted(r.deliver(grant,'device'));assert number(d.state(),'credits_issued')==200
 r.exchange('device','server');r.exchange('server','device');accepted(r.deliver(new,'device'));r.exchange('device','server');r.exchange('server','device')
def tamper_and_reflect(r):
 d,s=enrolled(r);s.ok('issue',total='100');f=r.opportunity('server');before=d.state()
 rejected(r.deliver(r.mutate(f,len(r.queue[f])-1),'device'));assert before==d.state()
 rejected(r.deliver(f,'server'));accepted(r.deliver(f,'device'));r.exchange('device','server');r.exchange('server','device')
 old=r.mutate(f,2,1);rejected(r.deliver(old,'device'))
def reboot(r):
 d,s=enrolled(r);key=d.state()['public_key'];s.ok('issue',total='100');r.exchange('server','device');d.ok('consume',amount='25')
 r.restart('device');assert d.state()['public_key']==key;r.exchange('device','server');assert number(s.state(),'credits_consumed')==0
 r.restart('server');r.exchange('server','device');s.ok('request');r.exchange('server','device');r.restart('device');r.exchange('device','server');r.exchange('server','device');assert number(s.state(),'credits_consumed')==25
 r.restart('device');assert r.opportunity('device') is None

def failed_commits(r):
 d,s=enrolled(r);s.ok('issue',total='100');settle(r);before=d.state();d.ok('fail',operation='storage');rejected(d.command('consume',amount='1'));assert before==d.state()
 d.ok('consume',amount='1');s.ok('request');f=r.opportunity('server');before=d.state();d.ok('fail',operation='storage');rejected(r.deliver(f,'device'));assert before==d.state();accepted(r.deliver(f,'device'))
 reply=r.opportunity('device');before=s.state();s.ok('fail',operation='storage');rejected(r.deliver(reply,'server'));assert before==s.state();accepted(r.deliver(reply,'server'));r.exchange('server','device')
def buffer_and_provider_failures(r):
 d,s=enrolled(r);s.ok('issue',total='100');before=s.state();rejected(s.command('tx',budget=1));rejected(s.command('tx',capacity=1));assert before==s.state()
 s.ok('fail',operation='crypto');rejected(s.command('tx'));settle(r)
def unavailable_randomness(r):
 d,s=r.pair(random_unavailable=True);r.exchange('device','server');r.exchange('server','device');s.ok('issue',total='100');settle(r)
 d2,res=r.spawn('no_rng','device',key_seed=None,random_unavailable=True);rejected(res)
def exact_uint64(r):
 d,s=enrolled(r);n=2**64-1;s.ok('issue',total=str(n));settle(r);d.ok('consume',amount=str(n));s.ok('request');settle(r)
 assert number(s.state(),'credits_consumed')==n;rejected(d.command('consume',amount='1'));rejected(s.command('issue',total=str(n+1)))
def bounded_withholding(r):
 d,s=enrolled(r)
 for total in range(1,40):s.ok('issue',total=str(total));r.drop(r.opportunity('server'))
 settle(r);assert number(d.state(),'credits_issued')==39
 for _ in range(20):d.ok('consume',amount='1');assert r.opportunity('device') is None
 s.ok('request');settle(r);assert number(s.state(),'credits_consumed')==20

def signed_enrollment(r):
 d,s=r.pair()
 for e in (d,s):e.ok('enrollment_enable')
 s.ok('enrollment_begin',now=100,expires=700);invite=r.opportunity('server');rejected(r.deliver(r.mutate(invite,171),'device'));accepted(r.deliver(invite,'device'))
 claim=r.opportunity('device');frame=base64.b64encode(r.queue[claim]).decode();rejected(s.command('rx_at',frame=frame,now=701));assert not s.state()['registered']
 s.ok('rx_at',frame=frame,now=101);assert not s.state()['registered'];rejected(s.command('issue',total='100'))
 r.restart('server');s.ok('enrollment_approve',challenge=s.state()['challenge'],key=d.state()['public_key'],now=102)
 r.exchange('server','device');s.ok('issue',total='100');settle(r)

def generated_schedule(r):
 d,s=enrolled(r);rng=random.Random(r.seed);s.ok('issue',total='1000');settle(r);consumed=0;history=[]
 for i in range(35):
  d.ok('consume',amount='1');consumed+=1
  if rng.randrange(3)==0:r.restart('device')
  s.ok('request');f=r.opportunity('server');history.append(f)
  if rng.randrange(2):r.drop(f);history.pop();continue
  accepted(r.deliver(f,'device'))
  if history:accepted(r.deliver(rng.choice(history),'device'))
  r.exchange('device','server');r.exchange('server','device')
 s.ok('request');settle(r);assert number(s.state(),'credits_consumed')==consumed
SCENARIOS=[first_exchange,lost_initial,authorization,snapshots,tamper_and_reflect,reboot,failed_commits,buffer_and_provider_failures,unavailable_randomness,exact_uint64,bounded_withholding,signed_enrollment,generated_schedule]

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", required=True)
    parser.add_argument("--server", required=True)
    parser.add_argument("--seed", type=int, default=73821)
    parser.add_argument("--scenario", default="all")
    parser.add_argument("--replay")
    args = parser.parse_args()
    if args.replay:
        replay(args.replay, args.device, args.server)
        return
    selected = [s for s in SCENARIOS if args.scenario in ("all", s.__name__)]
    assert selected, f"unknown scenario: {args.scenario}"
    for scenario in selected:
        seeds = [args.seed, args.seed + 1, args.seed + 2] if scenario is generated_schedule else [args.seed]
        for seed in seeds:
            relay = Relay(args.device, args.server, seed)
            try:
                scenario(relay)
                print(f"PASS {scenario.__name__} seed={seed}", flush=True)
            except BaseException as error:
                relay.save(scenario.__name__ + f"-{seed}", error)
                raise
            finally:
                relay.close()


if __name__ == "__main__":
    main()
