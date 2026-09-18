#!/usr/bin/env python3
"""Assemble and verify the static demo plus previously recorded test evidence."""
import argparse, hashlib, json, re, shutil, sys, tempfile
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools'))
from test_report import verify_site as verify_report
FILES=('index.html','style.css','app.mjs','lab.mjs','endpoint.mjs','worker.mjs','THIRD_PARTY_NOTICES.txt')

def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def verify(root,require_commit=True):
    root=Path(root).resolve();m=json.loads((root/'demo.json').read_text())
    if require_commit and not re.fullmatch('[0-9a-f]{40}',m['source_commit']):raise ValueError('Demo needs an immutable source commit')
    expected=set(FILES)|{'endpoint.wasm.mjs','endpoint.wasm.wasm'}
    if set(m['assets'])!=expected:raise ValueError('Unexpected or missing demo asset inventory')
    for name,sha in m['assets'].items():
        p=(root/name).resolve()
        if not p.is_relative_to(root) or digest(p)!=sha:raise ValueError('Changed demo asset: '+name)
    if (root/'endpoint.wasm.wasm').read_bytes()[:4]!=b'\0asm':raise ValueError('Missing WebAssembly module')
    if 'scw_test_' in (root/'endpoint.wasm.mjs').read_text():raise ValueError('Test exports in production module')
    verify_report(root/'report')
    # Previously published evidence URLs must continue to serve the same bytes.
    report=json.loads((root/'report/report.json').read_text())
    for name,sha in report['assets'].items():
        if digest(root/name)!=sha:raise ValueError('Legacy evidence asset differs: '+name)
    print('Verified live demo assets and preserved report')

def assemble(output,module,source_commit):
    root=Path(output);module=Path(module);root.mkdir(parents=True,exist_ok=True)
    # Snapshot inputs before writing so regeneration can target site/ itself.
    with tempfile.TemporaryDirectory() as tmp:
        snapshot=Path(tmp)/'report';shutil.copytree('site/report',snapshot)
        shutil.copytree(snapshot,root/'report',dirs_exist_ok=True)
        for directory in ('logs','resources'):
            shutil.copytree(snapshot/directory,root/directory,dirs_exist_ok=True)
        shutil.copy2(snapshot/'report.json',root/'report.json')
    for name in FILES:shutil.copy2(Path('web')/name,root/name)
    shutil.copy2(module,root/'endpoint.wasm.mjs')
    shutil.copy2(module.with_suffix('.wasm'),root/'endpoint.wasm.wasm')
    (root/'.nojekyll').write_text('')
    manifest={'source_commit':source_commit,'runtime':'C core + nanopb + libsodium 1.0.20 / Emscripten 4.0.10','storage':'temporary; simulated durable storage across reboot control only','assets':{name:digest(root/name) for name in (*FILES,'endpoint.wasm.mjs','endpoint.wasm.wasm')}}
    (root/'demo.json').write_text(json.dumps(manifest,indent=2)+'\n')
    verify(root,require_commit=source_commit!='working-tree')

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--verify-site');p.add_argument('--output');p.add_argument('--module',default='bazel-bin/web/endpoint.wasm.mjs');p.add_argument('--source-commit',default='working-tree');a=p.parse_args()
    if a.verify_site:verify(a.verify_site)
    elif a.output:assemble(a.output,a.module,a.source_commit)
    else:p.error('Specify --output or --verify-site')
