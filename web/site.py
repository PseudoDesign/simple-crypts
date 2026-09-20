#!/usr/bin/env python3
"""Assemble and verify the static demo plus previously recorded test evidence."""
import argparse, hashlib, json, re, shutil, sys, tempfile
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'tools'))
from test_report import verify_site as verify_report
WEB_FILES=('index.html','landing.css','demo.html','style.css','app.mjs','lab.mjs','endpoint.mjs','worker.mjs','resources.mjs','THIRD_PARTY_NOTICES.txt')

FLEET_V2_NAMES = ('index.html', 'style.css', 'app.mjs', 'worker.mjs', 'endpoint.mjs',
               'storage.mjs', 'server.mjs', 'server.wasm', 'device.mjs', 'device.wasm')
FLEET_NAMES = (*FLEET_V2_NAMES, 'transport.mjs')
FILES = WEB_FILES + tuple('examples/fleet_manager/' + name for name in FLEET_NAMES)

def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def copy_asset(source,destination):
    # Bazel outputs are read-only. Copy bytes to a fresh sibling and replace,
    # so assembling into the previously published site works repeatedly.
    destination=Path(destination)
    temporary=destination.with_name(destination.name+'.tmp')
    try:
        shutil.copyfile(source,temporary)
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)
def version_assets(root):
    # One content-derived version for the entire graph, including workers/Wasm.
    # Stable between a tested preview and publication; independent of commit metadata.
    names=(*FILES,'endpoint.wasm.mjs','endpoint.wasm.wasm')
    version=hashlib.sha256(''.join(digest(root/name) for name in names).encode()).hexdigest()[:20]
    pattern=re.compile(r"(['\"])(\./)?("+'|'.join(re.escape(n) for n in sorted(set(names) | set(FLEET_NAMES), key=len, reverse=True) if n!='index.html')+r")\1")
    for name in names:
        if name.endswith(('.html','.mjs')):
            path=root/name
            path.write_text(pattern.sub(lambda m:m[1]+(m[2] or '')+m[3]+'?v='+version+m[1],path.read_text()))
    return version

def verify(root,require_commit=True):
    root=Path(root).resolve();m=json.loads((root/'demo.json').read_text())
    if require_commit and not re.fullmatch('[0-9a-f]{40}',m['source_commit']):raise ValueError('Demo needs an immutable source commit')
    # Previously committed sites remain verifiable until the next deliberate
    # publication. New manifests must inventory the complete fleet bundle.
    version=m.get('format_version',1)
    if version not in (1,2,3,4):raise ValueError('Unsupported demo manifest version')
    legacy_fleet = WEB_FILES + tuple('examples/fleet_manager/' + name for name in FLEET_V2_NAMES)
    expected=set(FILES if version>=3 else legacy_fleet if version==2 else WEB_FILES)|{'endpoint.wasm.mjs','endpoint.wasm.wasm'}
    if set(m['assets'])!=expected:raise ValueError('Unexpected or missing demo asset inventory')
    for name,sha in m['assets'].items():
        p=(root/name).resolve()
        if not p.is_relative_to(root) or digest(p)!=sha:raise ValueError('Changed demo asset: '+name)
    if version >= 4:
        api_assets = m.get('api_assets', {})
        actual = {p.relative_to(root).as_posix() for p in (root/'api').rglob('*') if p.is_file()}
        if not {'api/index.html', 'api/search/search.js'} <= set(api_assets) or set(api_assets) != actual:
            raise ValueError('Unexpected or missing API asset inventory')
        for name, sha in api_assets.items():
            path = (root/name).resolve()
            if not name.startswith('api/') or not path.is_relative_to(root/'api') or digest(path) != sha:
                raise ValueError('Changed API asset: ' + name)
    if (root/'endpoint.wasm.wasm').read_bytes()[:4]!=b'\0asm':raise ValueError('Missing WebAssembly module')
    if 'scw_test_' in (root/'endpoint.wasm.mjs').read_text():raise ValueError('Test exports in production module')
    if version>=2:
        for module in ('server','device'):
            prefix=root/'examples/fleet_manager'/module
            if prefix.with_suffix('.wasm').read_bytes()[:4]!=b'\0asm':raise ValueError('Missing fleet Wasm module')
            if 'scw_test_' in prefix.with_suffix('.mjs').read_text():raise ValueError('Test exports in fleet module')
    verify_report(root/'report')
    # Previously published evidence URLs must continue to serve the same bytes.
    report=json.loads((root/'report/report.json').read_text())
    for name,sha in report['assets'].items():
        if digest(root/name)!=sha:raise ValueError('Legacy evidence asset differs: '+name)
    print('Verified live demo assets and preserved report')

def copy_api(api, root):
    """Replace the generated subtree so removed declarations leave no stale pages."""
    destination = Path(root)/'api'
    if destination.exists():
        shutil.rmtree(destination)
    shutil.copytree(Path(api)/'html', destination, copy_function=shutil.copyfile)


def assemble(output,module,source_commit,fleet="bazel-bin/examples/fleet_manager/site",api="bazel-bin/docs/api"):
    root=Path(output);module=Path(module);root.mkdir(parents=True,exist_ok=True)
    # Snapshot inputs before writing so regeneration can target site/ itself.
    with tempfile.TemporaryDirectory() as tmp:
        snapshot=Path(tmp)/'report';shutil.copytree('site/report',snapshot)
        shutil.copytree(snapshot,root/'report',dirs_exist_ok=True)
        for directory in ('logs','resources'):
            shutil.copytree(snapshot/directory,root/directory,dirs_exist_ok=True)
        shutil.copy2(snapshot/'report.json',root/'report.json')
    for name in WEB_FILES:copy_asset(Path('web')/name,root/name)
    fleet_output=root/'examples/fleet_manager'
    fleet_output.mkdir(parents=True,exist_ok=True)
    for name in FLEET_NAMES:copy_asset(Path(fleet)/name,fleet_output/name)
    copy_asset(module,root/'endpoint.wasm.mjs')
    copy_asset(module.with_suffix('.wasm'),root/'endpoint.wasm.wasm')
    copy_api(api, root)
    version_assets(root)
    (root/'.nojekyll').write_text('')
    manifest={'format_version':4,'source_commit':source_commit,'runtime':'C core + nanopb + libsodium 1.0.20 / Ed25519 identities + NaCl box / Emscripten 4.0.10','storage':'guided demo: temporary; fleet example: browser-local IndexedDB','assets':{name:digest(root/name) for name in (*FILES,'endpoint.wasm.mjs','endpoint.wasm.wasm')}}
    manifest['api_assets'] = {p.relative_to(root).as_posix(): digest(p) for p in sorted((root/'api').rglob('*')) if p.is_file()}
    (root/'demo.json').write_text(json.dumps(manifest,indent=2)+'\n')
    verify(root,require_commit=source_commit!='working-tree')

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--verify-site');p.add_argument('--output');p.add_argument('--module',default='bazel-bin/web/endpoint.wasm.mjs');p.add_argument('--source-commit',default='working-tree');p.add_argument('--fleet',default='bazel-bin/examples/fleet_manager/site');p.add_argument('--api',default='bazel-bin/docs/api');a=p.parse_args()
    if a.verify_site:verify(a.verify_site)
    elif a.output:assemble(a.output,a.module,a.source_commit,a.fleet,a.api)
    else:p.error('Specify --output or --verify-site')
