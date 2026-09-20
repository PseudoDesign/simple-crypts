"""C device / Python server demonstration with packet loss and reboot."""
import argparse
from coordinator import Relay

def main():
 p=argparse.ArgumentParser();p.add_argument('--device',required=True);p.add_argument('--server',required=True);a=p.parse_args();r=Relay(a.device,a.server)
 try:
  d,s=r.pair();r.drop(r.opportunity('device'));r.exchange('device','server');r.exchange('server','device')
  s.ok('issue',total='100');r.exchange('server','device');r.exchange('device','server');r.exchange('server','device')
  d.ok('consume',amount='25');r.restart('device');assert r.opportunity('device') is None
  s.ok('request');r.exchange('server','device');r.drop(r.opportunity('device'));r.exchange('device','server');r.exchange('server','device')
  assert s.state()['credits_consumed']=='25';print('100 credits issued; 25 consumed. Requested snapshot survives loss and reboot.')
 finally:r.close()
if __name__=='__main__':main()
