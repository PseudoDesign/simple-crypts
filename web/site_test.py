#!/usr/bin/env python3
import importlib.util
from pathlib import Path
import json
import shutil
import tempfile
import unittest
spec=importlib.util.spec_from_file_location('demo_site',Path(__file__).with_name('site.py'))
site=importlib.util.module_from_spec(spec);spec.loader.exec_module(site)

class SiteTest(unittest.TestCase):
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
