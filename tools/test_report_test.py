#!/usr/bin/env python3
"""Report failures must stay visible; incomplete evidence must not become green."""

import json
from pathlib import Path
import tempfile
import unittest

import test_report


class ReportTest(unittest.TestCase):
    def test_complete_bep_required(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "events.json"
            configured = {
                "id": {"targetConfigured": {"label": "//tests:example"}},
                "configured": {"testSize": "SMALL"},
            }
            summary = {
                "id": {"testSummary": {"label": "//tests:example"}},
                "testSummary": {"overallStatus": "PASSED"},
            }
            finish = {"finished": {"overallSuccess": True}}

            def write(events):
                path.write_text("\n".join(json.dumps(e) for e in events))

            for events in ([configured], [configured, finish], [summary, finish]):
                write(events)
                with self.assertRaises(ValueError):
                    test_report.read_results(path)
            write([configured, summary, finish])
            self.assertEqual(
                test_report.read_results(path)[0]["//tests:example"]["overallStatus"], "PASSED"
            )
            write([configured, summary, {"finished": {"overallSuccess": False}}])
            with self.assertRaisesRegex(ValueError, "did not finish"):
                test_report.read_results(path)

    def test_safe_embedding_and_paths(self):
        report = {"message": "</script><script>alert(1)</script>"}
        html = test_report.render(
            '<script id="report-data" type="application/json">__REPORT_JSON__</script>', report
        )
        self.assertEqual(html.count("</script>"), 1)
        self.assertIn("\\u003c", html)
        with self.assertRaises(ValueError):
            test_report.target_path("//tests/../../etc:passwd")
        self.assertEqual(
            str(test_report.target_path("//tests/crypto:interop")), "tests/crypto/interop"
        )
        self.assertEqual(
            test_report.SCENARIO.findall("PASS exact_uint64 seed=73821\n"),
            [("exact_uint64", "73821")],
        )

    def test_evidence_manifest_and_counts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            logs = root / "logs"
            labels = [
                f"//tests:conformance_{d}_{s}"
                for d in test_report.LANGUAGES
                for s in test_report.LANGUAGES
            ]
            labels += ["//tests/crypto:interop", "//tests:sanitizers", "//tests:core_fuzz_smoke"]
            events = []
            for label in labels:
                events += [
                    {
                        "id": {"targetConfigured": {"label": label}},
                        "configured": {"testSize": "SMALL"},
                    },
                    {
                        "id": {"testSummary": {"label": label}},
                        "testSummary": {"overallStatus": "PASSED", "totalRunDurationMillis": "100"},
                    },
                ]
                path = logs / test_report.target_path(label) / "test.log"
                path.parent.mkdir(parents=True)
                path.write_text("PASS first_exchange seed=7\n")
            events.append({"finished": {"overallSuccess": True}})
            (root / "bep.json").write_text("\n".join(json.dumps(e) for e in events))
            (root / "resource.json").write_text(
                json.dumps(
                    {
                        "flash_sections_bytes": 99,
                        "static_ram_bytes": 55,
                        "compiler": "fixture",
                        "data_symbols": [{"symbol": "endpoint", "bytes": 22}],
                    }
                )
            )
            (root / "resource.md").write_text("Fixture measurement")
            (root / "template.html").write_text(
                '<script id="report-data" type="application/json">__REPORT_JSON__</script>'
            )
            site = root / "site"
            report = test_report.build_report(
                root / "bep.json",
                logs,
                root / "resource.json",
                root / "resource.md",
                root / "template.html",
                site,
                "owner/repo",
                "a" * 40,
            )
            self.assertEqual(report["summary"]["targets"], 19)
            self.assertEqual(report["summary"]["scenario_runs"], 16)
            target_log = site / report["targets"][0]["log_url"]
            target_log.write_text("changed evidence")
            with self.assertRaisesRegex(ValueError, "changed evidence"):
                test_report.verify_site(site)


if __name__ == "__main__":
    unittest.main()
