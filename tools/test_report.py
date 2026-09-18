#!/usr/bin/env python3
"""Render a static Pages report from a complete Bazel Build Event Protocol run.

The report is a snapshot of an explicitly identified source commit. Reading the
BEP target inventory prevents stale test-log directories from inventing passes.
Only report assets are published, never the full checkout or raw BEP environment.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import shutil

LANGUAGES = ("c", "python", "rust", "go")
LABEL = re.compile(r"^//([A-Za-z0-9_./-]+):([A-Za-z0-9_.-]+)$")
SCENARIO = re.compile(r"^PASS ([a-z][a-z0-9_]*?) seed=(\d+)$", re.MULTILINE)


def read_results(path):
    configured, summaries, finished = set(), {}, None
    for line in Path(path).read_text().splitlines():
        event = json.loads(line)
        if event.get("configured", {}).get("testSize"):
            configured.add(event["id"]["targetConfigured"]["label"])
        if "testSummary" in event:
            label = event["id"]["testSummary"]["label"]
            if label in summaries:
                raise ValueError("Multiple configurations for a test target: " + label)
            summaries[label] = event["testSummary"]
        if "finished" in event:
            finished = event["finished"]
    if finished is None or not configured or configured != set(summaries):
        raise ValueError("Incomplete BEP: every configured test must have a summary and build finish")
    if not finished.get("overallSuccess"):
        raise ValueError("Bazel did not finish successfully; do not replace the last verified snapshot")
    return summaries, finished


def target_path(label):
    match = LABEL.fullmatch(label)
    if not match or ".." in match[1].split("/"):
        raise ValueError("Unsupported target label: " + label)
    return Path(match[1]) / match[2]


def render(template, report):
    # JSON is embedded in an inert script element; escape HTML terminators.
    payload = json.dumps(report, ensure_ascii=True).replace("<", "\\u003c").replace(">", "\\u003e").replace("&", "\\u0026")
    if template.count("__REPORT_JSON__") != 1:
        raise ValueError("Template must have exactly one report placeholder")
    return template.replace("__REPORT_JSON__", payload)


def build_report(bep, logs, resource_json, resource_markdown, template, output,
                 repository, source_commit):
    if not re.fullmatch(r"[a-zA-Z0-9_.-]+/[a-zA-Z0-9_.-]+", repository):
        raise ValueError("repository must be owner/name")
    if not re.fullmatch(r"[0-9a-f]{40}", source_commit):
        raise ValueError("source commit must be a full Git SHA")
    summaries, finished = read_results(bep)
    expected_matrix = {f"//tests:conformance_{d}_{s}" for d in LANGUAGES for s in LANGUAGES}
    if not expected_matrix.issubset(summaries):
        raise ValueError("BEP does not contain all sixteen language pairings")
    required = {"//tests/crypto:interop", "//tests:sanitizers", "//tests:core_fuzz_smoke"}
    if not required.issubset(summaries):
        raise ValueError("BEP is missing independent crypto, sanitizer, or fuzz evidence")
    assets, targets = {}, []
    for label, result in sorted(summaries.items()):
        relative = target_path(label)
        log = (Path(logs) / relative / "test.log").read_text()
        log_url = "logs/" + str(relative).replace("/", "--") + ".txt"
        # Successful public test output is fixture-only; raw BEP includes
        # machine paths and invocation environment and is intentionally omitted.
        assets[log_url] = log.encode()
        cases = [{"name": name, "seed": int(seed)} for name, seed in SCENARIO.findall(log)]
        targets.append({
            "label": label, "status": result["overallStatus"],
            "duration_seconds": int(result.get("totalRunDurationMillis", 0)) / 1000,
            "cached": bool(result.get("totalNumCached", 0)),
            "started_at": result.get("firstStartTime"),
            "finished_at": result.get("lastStopTime"),
            "scenarios": cases, "log_url": log_url,
        })
    by_label = {t["label"]: t for t in targets}
    matrix = []
    for device in LANGUAGES:
        for server in LANGUAGES:
            label = f"//tests:conformance_{device}_{server}"
            result = by_label[label]
            if result["status"] == "PASSED" and not result["scenarios"]:
                raise ValueError("Passing matrix target has no scenario evidence: " + label)
            matrix.append({"device": device, "server": server, "label": label,
                           "status": result["status"], "duration_seconds": result["duration_seconds"],
                           "scenario_runs": len(result["scenarios"])})
    resources = json.loads(Path(resource_json).read_text())
    context_bytes = next(v["bytes"] for v in resources["data_symbols"] if v["symbol"] == "endpoint")
    passed = sum(t["status"] == "PASSED" for t in targets)
    report = {
        "format": 1, "project": "Simple Crypts", "repository_url": "https://github.com/" + repository,
        "source_commit": source_commit, "source_url": f"https://github.com/{repository}/commit/{source_commit}",
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "captured_at": finished.get("finishTime"), "command": "bazel test //...",
        "evidence_origin": "Local Bazel execution; cached results are identified per target.",
        "build_success": bool(finished.get("overallSuccess")),
        "summary": {"targets": len(targets), "passed": passed, "failed": len(targets) - passed,
                    "scenario_runs": sum(t["scenario_runs"] for t in matrix),
                    "cached_targets": sum(t["cached"] for t in targets)},
        "targets": targets, "matrix": matrix,
        "resources": {"flash_bytes": resources["flash_sections_bytes"],
                      "static_ram_bytes": resources["static_ram_bytes"], "context_bytes": context_bytes,
                      "compiler": resources["compiler"], "report_url": "resources/cortex-m4.md"},
        "limitations": [
            "Results identify a tested source commit; this is a published snapshot, not a claim that later commits have passed.",
            "Bazel cache hits reuse successful results for unchanged inputs. Per-target logs retain the recorded execution output.",
            "The sixteen pairings share one C core. The Go NaCl oracle supplies a separate cryptographic compatibility check.",
            "Cortex-M4 figures are linked static resources including probe and runtime support, not peak RAM, timing, or board qualification.",
        ],
    }
    assets["resources/cortex-m4.json"] = Path(resource_json).read_bytes()
    assets["resources/cortex-m4.md"] = Path(resource_markdown).read_bytes()
    report["assets"] = {p: hashlib.sha256(data).hexdigest() for p, data in assets.items()}
    root = Path(output)
    # Only replace managed report directories. Never remove arbitrary siblings.
    root.mkdir(parents=True, exist_ok=True)
    for name in ("logs", "resources"):
        directory = root / name
        if directory.exists():
            shutil.rmtree(directory)
    for name, content in assets.items():
        destination = root / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(content)
    (root / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    (root / "index.html").write_text(render(Path(template).read_text(), report))
    (root / ".nojekyll").write_text("")
    verify_site(root)
    return report


def verify_site(directory):
    root = Path(directory).resolve()
    report = json.loads((root / "report.json").read_text())
    expected = {(d, s) for d in LANGUAGES for s in LANGUAGES}
    if {(row["device"], row["server"]) for row in report["matrix"]} != expected or len(report["matrix"]) != 16:
        raise ValueError("Incomplete matrix")
    targets = report["targets"]
    if len({t["label"] for t in targets}) != len(targets):
        raise ValueError("Duplicate target")
    summary = report["summary"]
    if summary["targets"] != len(targets) or summary["passed"] != sum(t["status"] == "PASSED" for t in targets):
        raise ValueError("Result counts disagree")
    if summary["failed"] != len(targets) - summary["passed"]:
        raise ValueError("Failure counts disagree")
    if summary["scenario_runs"] != sum(row["scenario_runs"] for row in report["matrix"]):
        raise ValueError("Scenario counts disagree")
    by_label = {t["label"]: t for t in targets}
    for row in report["matrix"]:
        expected_label = f"//tests:conformance_{row['device']}_{row['server']}"
        target = by_label.get(expected_label)
        if row["label"] != expected_label or not target or row["status"] != target["status"] or row["scenario_runs"] != len(target["scenarios"]):
            raise ValueError("Matrix does not agree with target results")
    for name, expected_hash in report["assets"].items():
        path = (root / name).resolve()
        if not path.is_relative_to(root) or hashlib.sha256(path.read_bytes()).hexdigest() != expected_hash:
            raise ValueError("Missing or changed evidence asset: " + name)
    for target in targets:
        if target["log_url"] not in report["assets"]:
            raise ValueError("Missing target log: " + target["label"])
    html = (root / "index.html").read_text()
    embedded = re.search(r'<script[^>]*\bid=["\']report-data["\'][^>]*>(.*?)</script>', html, re.S)
    if not embedded or json.loads(embedded.group(1)) != report:
        raise ValueError("Rendered report does not match report.json")
    print(f"Verified report: {summary['passed']}/{summary['targets']} targets; {len(report['matrix'])} pairings")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify-site")
    parser.add_argument("--bep")
    parser.add_argument("--logs", default="bazel-testlogs")
    parser.add_argument("--resources", default="bazel-bin/platforms/cortex_m4/resource_report.json")
    parser.add_argument("--resource-markdown", default="bazel-bin/platforms/cortex_m4/resource_report.md")
    parser.add_argument("--template", default=str(Path(__file__).with_name("report_template.html")))
    parser.add_argument("--output", default="site/report")
    parser.add_argument("--repository", default="PseudoDesign/simple-crypts")
    parser.add_argument("--source-commit")
    args = parser.parse_args()
    if args.verify_site:
        verify_site(args.verify_site)
    elif args.bep and args.source_commit:
        build_report(args.bep, args.logs, args.resources, args.resource_markdown,
                     args.template, args.output, args.repository, args.source_commit)
    else:
        parser.error("provide --verify-site, or both --bep and --source-commit")


if __name__ == "__main__":
    main()
