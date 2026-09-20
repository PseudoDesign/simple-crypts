#!/usr/bin/env python3
import importlib.util
from pathlib import Path
import json
import re
import shutil
import tempfile
import unittest
spec=importlib.util.spec_from_file_location('demo_site',Path(__file__).with_name('site.py'))
site=importlib.util.module_from_spec(spec);spec.loader.exec_module(site)

class SiteTest(unittest.TestCase):
    def test_replace_readonly_generated_asset(self):
        with tempfile.TemporaryDirectory() as tmp:
            source=Path(tmp)/'built.wasm';destination=Path(tmp)/'published.wasm'
            source.write_bytes(b'new');source.chmod(0o444)
            destination.write_bytes(b'old');destination.chmod(0o444)
            site.copy_asset(source,destination)
            self.assertEqual(destination.read_bytes(),b'new')
            site.copy_asset(source,destination)
            self.assertEqual(destination.read_bytes(),b'new')
            self.assertFalse((Path(tmp)/'published.wasm.tmp').exists())

    def test_api_replacement_removes_stale_pages(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/'site'; api=Path(tmp)/'generated'
            (root/'api').mkdir(parents=True); (api/'html').mkdir(parents=True)
            (root/'api/obsolete.html').write_text('old')
            (api/'html/index.html').write_text('new')
            site.copy_api(api,root)
            self.assertFalse((root/'api/obsolete.html').exists())
            self.assertEqual((root/'api/index.html').read_text(),'new')

    def test_api_inventory(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/'site';shutil.copytree('web/site',root,copy_function=shutil.copyfile)
            page=root/'api/index.html'; original=page.read_bytes()
            page.write_bytes(original+b'changed')
            with self.assertRaisesRegex(ValueError,'Changed API asset'):
                site.verify(root,require_commit=False)
            page.unlink()
            with self.assertRaisesRegex(ValueError,'API asset inventory'):
                site.verify(root,require_commit=False)
            page.write_bytes(original)
            (root/'api/obsolete.html').write_text('stale')
            with self.assertRaisesRegex(ValueError,'API asset inventory'):
                site.verify(root,require_commit=False)

    def test_asset_graph_is_versioned(self):
        root=Path('web/site')
        versions=[]
        for file,asset in [('index.html','landing.css'),('index.html','demo.html'),('demo.html','style.css'),('demo.html','app.mjs'),('app.mjs','lab.mjs'),('lab.mjs','worker.mjs'),('worker.mjs','endpoint.wasm.mjs'),('endpoint.wasm.mjs','endpoint.wasm.wasm'),('index.html','examples/fleet_manager/index.html'),('examples/fleet_manager/worker.mjs','device.mjs'),('examples/fleet_manager/device.mjs','device.wasm')]:
            match=re.search(re.escape(asset)+r'\?v=([0-9a-f]{20})', (root/file).read_text())
            self.assertIsNotNone(match,(file,asset))
            versions.append(match[1])
        self.assertEqual(len(set(versions)),1)

    def test_published_assets_and_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/'site';shutil.copytree('web/site',root,copy_function=shutil.copyfile)
            with self.assertRaisesRegex(ValueError,'immutable'):site.verify(root)
            m=json.loads((root/'demo.json').read_text());m['source_commit']='a'*40;(root/'demo.json').write_text(json.dumps(m))
            site.verify(root)
            wasm=root/'endpoint.wasm.wasm';original=wasm.read_bytes();wasm.write_bytes(original+b'x')
            with self.assertRaisesRegex(ValueError,'Changed demo asset'):site.verify(root)
            wasm.write_bytes(original)
            legacy=root/'resources/cortex-m4.md';legacy.write_text('changed evidence')
            with self.assertRaisesRegex(ValueError,'Legacy evidence'):site.verify(root)
            self.assertNotIn('scw_test_', (root/'endpoint.wasm.mjs').read_text())

if __name__=='__main__':unittest.main()
