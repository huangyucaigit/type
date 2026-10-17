"""Offline release/recovery drills; no Docker, SSH, real keys, or network.

Run: python -m unittest discover -s tests -p test_deploy_release.py -v
"""

import ast
from contextlib import closing
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import sqlite3
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest import mock


HELPER_PATH = Path(__file__).resolve().parent.parent / "deploy" / "remote_release.py"
SPEC = importlib.util.spec_from_file_location("remote_release_under_test", str(HELPER_PATH))
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)


def digest(content):
    return hashlib.sha256(content).hexdigest()


class ReleaseRecoveryTests(unittest.TestCase):
    def sqlite_fixture(self):
        source = self.root / 'data/auth.sqlite'
        live = sqlite3.connect(str(source))
        self.addCleanup(live.close)
        live.execute('PRAGMA journal_mode=WAL')
        live.execute('PRAGMA wal_autocheckpoint=0')
        live.execute('CREATE TABLE payments (id INTEGER PRIMARY KEY, amount INTEGER)')
        live.execute('INSERT INTO payments VALUES (1, 990)')
        live.commit()
        return source, live

    def assert_sqlite_snapshot(self, name):
        manifest = self.manager.backup_data(name)
        paths = [item['path'] for item in manifest['files']]
        self.assertIn('auth.sqlite', paths)
        self.assertFalse(any(item.endswith(('-wal', '-shm', '-journal')) for item in paths))
        backup = self.root / '.data-backups' / name / 'files/auth.sqlite'
        with closing(sqlite3.connect(str(backup))) as restored:
            self.assertEqual(restored.execute('PRAGMA integrity_check').fetchone(), ('ok',))
            self.assertEqual(restored.execute('SELECT * FROM payments').fetchall(), [(1, 990)])
        return backup

    def test_sqlite_backup_includes_committed_wal_and_survives_checkpoint(self):
        source, live = self.sqlite_fixture()
        backup = self.assert_sqlite_snapshot('sqlite-consistent')
        live.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        live.execute('INSERT INTO payments VALUES (2, 1990)')
        live.commit()
        with closing(sqlite3.connect(str(backup))) as restored:
            self.assertEqual(restored.execute('SELECT * FROM payments').fetchall(), [(1, 990)])

    def test_python36_fallback_runs_real_node_online_backup(self):
        self.sqlite_fixture()
        def node_runner(command, cwd):
            self.assertEqual(command[:7], ['docker', 'compose', 'exec', '-T', 'app', 'node', '--input-type=module'])
            args = command[5:]
            args[-2:] = [str(self.root / 'data' / Path(item).name) for item in args[-2:]]
            subprocess.run(args, check=True, capture_output=True, timeout=30)
        self.manager.runner = node_runner
        with mock.patch.object(release.sqlite3, 'Connection', object):
            self.assert_sqlite_snapshot('node-consistent')
        self.assertEqual(list((self.root / 'data').glob('.sqlite-backup-*')), [])

    def test_corrupt_sqlite_stops_data_backup(self):
        self.write('data/auth.sqlite', b'not a database')
        with self.assertRaises(sqlite3.DatabaseError):
            self.manager.backup_data('corrupt-db')
        self.assertFalse((self.root / '.data-backups/corrupt-db').exists())

    def setUp(self):
        self.sandbox = tempfile.TemporaryDirectory(prefix="type-release-test-")
        self.addCleanup(self.sandbox.cleanup)
        self.root = Path(self.sandbox.name) / "live"
        self.root.mkdir()
        self.root = self.root.resolve()
        self.old_files = {
            "src/index.html": b"old index",
            "src/app.js": b"old app",
            "src/translation-server.mjs": b"old server",
            "compose.yaml": b"old compose",
            "nginx.conf": b"old shared nginx route",
            "config/app.env": b"DEEPSEEK_API_KEY=fake-test-key\n",
            "tls/type.where.work.pem": b"fake type certificate",
            "tls/type.where.work.key": b"fake type key",
        }
        for name, content in self.old_files.items():
            self.write(name, content)
        self.write("data/feedback.json", b"old feedback")
        self.write("tls/pay.where.work.key", b"external payment key")
        self.write("tls/pay.where.work.fullchain.pem", b"external payment cert")
        self.calls = []
        self.manager = release.ReleaseManager(self.root, runner=self.successful_runner)

    def write(self, name, content):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)

    def successful_runner(self, command, cwd):
        self.assertEqual(Path(cwd), self.root)
        self.calls.append(list(command))

    def baseline(self):
        return {name: digest((self.root / name).read_bytes()) for name in self.old_files}

    def archive(self, changes=None, name="upload.tar", baseline=None, extra_members=None, omit_baseline=False):
        changes = {"src/index.html": b"new index"} if changes is None else changes
        path = self.root / ".incoming" / name
        path.parent.mkdir(parents=True, exist_ok=True)
        if baseline is None:
            baseline = self.baseline()
            for changed_path in changes:
                baseline.setdefault(changed_path, None)
        manifest = {
            "version": 1,
            "files": [{"path": key, "sha256": digest(value)} for key, value in changes.items()],
            "baseline": baseline,
        }
        if omit_baseline:
            del manifest["baseline"]
        with tarfile.open(str(path), "w") as bundle:
            content = json.dumps(manifest).encode("utf-8")
            info = tarfile.TarInfo("manifest.json")
            info.size = len(content)
            bundle.addfile(info, io.BytesIO(content))
            for key, value in changes.items():
                info = tarfile.TarInfo(key)
                info.size = len(value)
                bundle.addfile(info, io.BytesIO(value))
            for info, content in extra_members or []:
                bundle.addfile(info, io.BytesIO(content) if content is not None else None)
        return path

    def assert_old_files(self):
        for name, content in self.old_files.items():
            with self.subTest(file=name):
                self.assertEqual((self.root / name).read_bytes(), content)

    def record(self, release_id):
        return json.loads((self.root / ".releases" / (release_id + ".json")).read_text("utf-8"))

    def test_snapshot_records_verified_code_config_and_type_certificate(self):
        self.manager.snapshot("before-deploy")
        manifest = self.manager.validate_snapshot("before-deploy")
        self.assertEqual(manifest["id"], "before-deploy")
        self.assertTrue(manifest["restorable"])
        recorded = {item["path"] for item in manifest["files"]}
        self.assertEqual(recorded, set(self.old_files))
        for item in manifest["files"]:
            content = (self.root / ".backups" / "before-deploy" / "files" / item["path"]).read_bytes()
            self.assertEqual(item["sha256"], digest(content))
            self.assertEqual(item["size"], len(content))
        self.assertNotIn("data/feedback.json", recorded)
        self.assertNotIn("tls/pay.where.work.key", recorded)

    def test_apply_snapshots_previous_version_before_service_commands(self):
        upload = self.archive({"src/index.html": b"new index", "src/new.js": b"new module"})

        def runner(command, cwd):
            self.successful_runner(command, cwd)
            if "docker" in Path(command[0]).name:
                self.manager.validate_snapshot("release-one")
                self.assertEqual(
                    (self.root / ".backups/release-one/files/src/index.html").read_bytes(), b"old index")

        self.manager.runner = runner
        result = self.manager.apply(upload, "release-one", "abc123", recreate=False)
        self.assertEqual(result["status"], "deployed")
        self.assertEqual(self.record("release-one")["status"], "deployed")
        self.assertEqual((self.root / "src/index.html").read_bytes(), b"new index")
        self.assertEqual((self.root / "src/new.js").read_bytes(), b"new module")
        self.assertEqual((self.root / "src/app.js").read_bytes(), b"old app")
        self.assertTrue(self.calls)
        self.assertFalse(any("up" in command or "run" in command for command in self.calls))

    def test_backup_failure_never_changes_live_files_or_runs_services(self):
        upload = self.archive()
        with mock.patch.object(self.manager, "snapshot", side_effect=OSError("simulated disk full")):
            with self.assertRaises(release.ReleaseError):
                self.manager.apply(upload, "disk-full", "abc123")
        self.assert_old_files()
        self.assertFalse(any("docker" in Path(command[0]).name for command in self.calls))

    def test_data_backup_failure_stops_before_code_change(self):
        upload = self.archive()
        with mock.patch.object(self.manager, "backup_data", side_effect=OSError("simulated data backup disk full")):
            with self.assertRaises(release.ReleaseError):
                self.manager.apply(upload, "data-backup-failed", "abc123")
        self.assert_old_files()
        self.assertEqual((self.root / "data/feedback.json").read_bytes(), b"old feedback")
        self.assertEqual(self.record("data-backup-failed")["status"], "failed_preflight")
        self.assertFalse(any("docker" in Path(command[0]).name for command in self.calls))

    def test_failed_deploy_restores_code_removes_new_source_and_keeps_new_user_data(self):
        upload = self.archive({"src/index.html": b"new index", "src/new.js": b"new module"})
        failed = [False]

        def runner(command, cwd):
            self.successful_runner(command, cwd)
            if not failed[0] and (self.root / "src/index.html").read_bytes() == b"new index":
                failed[0] = True
                self.write("data/feedback.json", b"feedback added during deployment")
                self.write("data/new-entry.json", b"new feedback entry")
                self.write("tls/pay.where.work.key", b"rotated external payment key")
                self.write("tls/pay.where.work.fullchain.pem", b"rotated external payment cert")
                raise RuntimeError("simulated service startup failure")

        self.manager.runner = runner
        with self.assertRaises(release.ReleaseError):
            self.manager.apply(upload, "bad-release", "abc123")
        self.assertTrue(failed[0])
        self.assert_old_files()
        self.assertFalse((self.root / "src/new.js").exists())
        self.assertEqual((self.root / "data/feedback.json").read_bytes(), b"feedback added during deployment")
        self.assertEqual((self.root / "data/new-entry.json").read_bytes(), b"new feedback entry")
        self.assertEqual((self.root / "tls/pay.where.work.key").read_bytes(), b"rotated external payment key")
        self.assertEqual((self.root / "tls/pay.where.work.fullchain.pem").read_bytes(), b"rotated external payment cert")
        self.assertEqual(self.record("bad-release")["status"], "failed_rolled_back")
        self.assertEqual(self.record("bad-release")["dataBackupId"], "bad-release")
        self.assertEqual((self.root / ".data-backups/bad-release/files/feedback.json").read_bytes(), b"old feedback")
        manifest = json.loads((self.root / ".data-backups/bad-release/manifest.json").read_text("utf-8"))
        entries = {entry["path"]: entry for entry in manifest["files"]}
        self.assertEqual(entries["feedback.json"]["sha256"], digest(b"old feedback"))
        self.assertEqual(entries["feedback.json"]["size"], len(b"old feedback"))

    def test_failed_recovery_retains_snapshot_and_failure_record(self):
        def runner(command, cwd):
            self.successful_runner(command, cwd)
            if "docker" in Path(command[0]).name:
                raise RuntimeError("simulated service unavailable")

        self.manager.runner = runner
        with self.assertRaises(release.ReleaseError):
            self.manager.apply(self.archive(), "broken-recovery", "abc123")
        self.assertEqual(self.record("broken-recovery")["status"], "failed_recovery")
        self.assertTrue(self.manager.validate_snapshot("broken-recovery")["restorable"])
        self.assert_old_files()

    def test_manual_rollback_snapshots_current_state_and_preserves_data(self):
        self.manager.snapshot("prior")
        self.write("src/index.html", b"current index")
        self.write("src/current.js", b"current-only file")
        self.write("data/feedback.json", b"latest feedback")
        result = self.manager.rollback("prior", "manual-rollback")
        self.assertEqual(result["status"], "rolled_back")
        self.assertEqual(self.record("manual-rollback")["rollbackOf"], "prior")
        self.assertEqual(
            (self.root / ".backups/manual-rollback/files/src/index.html").read_bytes(), b"current index")
        self.assert_old_files()
        self.assertFalse((self.root / "src/current.js").exists())
        self.assertEqual((self.root / "data/feedback.json").read_bytes(), b"latest feedback")
        self.assertEqual((self.root / ".data-backups/manual-rollback/files/feedback.json").read_bytes(), b"latest feedback")

    def test_failed_manual_rollback_recovers_pre_attempt_code(self):
        self.manager.snapshot("prior")
        self.write("src/index.html", b"current index")
        self.write("src/current.js", b"current-only file")
        failed = [False]

        def runner(command, cwd):
            self.successful_runner(command, cwd)
            if not failed[0]:
                failed[0] = True
                self.write("data/feedback.json", b"feedback during rollback")
                raise RuntimeError("simulated older version startup failure")

        self.manager.runner = runner
        with self.assertRaises(release.ReleaseError):
            self.manager.rollback("prior", "failed-manual")
        self.assertEqual((self.root / "src/index.html").read_bytes(), b"current index")
        self.assertEqual((self.root / "src/current.js").read_bytes(), b"current-only file")
        self.assertEqual((self.root / "data/feedback.json").read_bytes(), b"feedback during rollback")
        self.assertEqual(self.record("failed-manual")["status"], "failed_rolled_back")

    def test_tampered_snapshot_is_rejected_before_manual_rollback(self):
        self.manager.snapshot("tampered")
        (self.root / ".backups/tampered/files/src/index.html").write_bytes(b"changed after backup")
        self.write("src/index.html", b"current index")
        with self.assertRaises(release.ReleaseError):
            self.manager.rollback("tampered", "refuse-corruption")
        self.assertEqual((self.root / "src/index.html").read_bytes(), b"current index")
        self.assertEqual(self.calls, [])

    def test_missing_snapshot_file_is_rejected(self):
        self.manager.snapshot("incomplete")
        (self.root / ".backups/incomplete/files/src/app.js").unlink()
        with self.assertRaises(release.ReleaseError):
            self.manager.validate_snapshot("incomplete")

    def test_invalid_snapshot_ids_cannot_escape_backup_directory(self):
        for snapshot_id in ("../outside", "/tmp/outside", "..", "one/two", "one\\two", "a" * 97):
            with self.subTest(snapshot_id=snapshot_id):
                with self.assertRaises(release.ReleaseError):
                    self.manager.snapshot(snapshot_id)

    def test_snapshot_manifest_cannot_restore_outside_managed_files(self):
        self.manager.snapshot("bad-manifest")
        path = self.root / ".backups/bad-manifest/manifest.json"
        manifest = json.loads(path.read_text("utf-8"))
        manifest["files"][0]["path"] = "../outside"
        path.write_text(json.dumps(manifest), "utf-8")
        path.with_name("manifest.sha256").write_text(digest(path.read_bytes()) + "\n", "ascii")
        with self.assertRaises(release.ReleaseError):
            self.manager.restore("bad-manifest")
        self.assert_old_files()

    def test_upload_cannot_write_data_payment_certificate_or_escape_root(self):
        for index, path in enumerate(("../outside", "/tmp/outside", "src/../outside", "data/feedback.json", "tls/pay.where.work.key")):
            with self.subTest(path=path):
                with self.assertRaises(release.ReleaseError):
                    self.manager.apply(self.archive({path: b"must not be written"}), "bad-upload-" + str(index), "abc123")
                self.assert_old_files()
                self.assertEqual((self.root / "data/feedback.json").read_bytes(), b"old feedback")
                self.assertEqual((self.root / "tls/pay.where.work.key").read_bytes(), b"external payment key")
        self.assertEqual(self.calls, [])

    def test_upload_symlink_and_hardlink_entries_are_rejected(self):
        for index, link_type in enumerate((tarfile.SYMTYPE, tarfile.LNKTYPE)):
            with self.subTest(link_type=link_type):
                member = tarfile.TarInfo("src/link.js")
                member.type = link_type
                member.linkname = "../../outside"
                upload = self.archive(extra_members=[(member, None)])
                with self.assertRaises(release.ReleaseError):
                    self.manager.apply(upload, "link-upload-" + str(index), "abc123")
                self.assert_old_files()
        self.assertEqual(self.calls, [])

    def test_upload_checksum_mismatch_is_rejected_without_writing_live_files(self):
        upload = self.archive()
        manifest = {"version": 1, "files": [{"path": "src/index.html", "sha256": "0" * 64}], "baseline": self.baseline()}
        with tarfile.open(str(upload), "w") as bundle:
            for name, content in (("manifest.json", json.dumps(manifest).encode("utf-8")), ("src/index.html", b"new index")):
                member = tarfile.TarInfo(name)
                member.size = len(content)
                bundle.addfile(member, io.BytesIO(content))
        with self.assertRaises(release.ReleaseError):
            self.manager.apply(upload, "bad-checksum", "abc123")
        self.assert_old_files()
        self.assertEqual(self.calls, [])

    def test_duplicate_archive_paths_are_rejected(self):
        member = tarfile.TarInfo("src/index.html")
        member.size = len(b"duplicate value")
        upload = self.archive(extra_members=[(member, b"duplicate value")])
        with self.assertRaises(release.ReleaseError):
            self.manager.apply(upload, "duplicate-path", "abc123")
        self.assert_old_files()
        self.assertEqual(self.calls, [])

    def test_unlisted_archive_file_is_rejected(self):
        member = tarfile.TarInfo("src/unlisted.js")
        member.size = len(b"unlisted value")
        upload = self.archive(extra_members=[(member, b"unlisted value")])
        with self.assertRaises(release.ReleaseError):
            self.manager.apply(upload, "unlisted-path", "abc123")
        self.assert_old_files()
        self.assertFalse((self.root / "src/unlisted.js").exists())
        self.assertEqual(self.calls, [])

    def test_stale_baseline_rejects_concurrent_release(self):
        upload = self.archive()
        self.write("src/index.html", b"another release arrived first")
        with self.assertRaises(release.ReleaseError):
            self.manager.apply(upload, "stale-release", "abc123")
        self.assertEqual((self.root / "src/index.html").read_bytes(), b"another release arrived first")
        self.assertEqual(self.calls, [])

    def test_upload_without_baseline_is_rejected_before_deployment(self):
        with self.assertRaises(release.ReleaseError):
            self.manager.apply(self.archive(omit_baseline=True), "missing-baseline", "abc123")
        self.assert_old_files()
        self.assertEqual(self.calls, [])

    def test_baseline_must_cover_every_changed_file(self):
        with self.assertRaises(release.ReleaseError):
            self.manager.apply(self.archive(baseline={"src/app.js": digest(b"old app")}),
                               "partial-baseline", "abc123")
        self.assert_old_files()
        self.assertEqual(self.calls, [])

    def test_shared_nginx_route_change_requires_explicit_opt_in(self):
        upload = self.archive({"nginx.conf": b"new shared nginx route"})
        with self.assertRaises(release.ReleaseError):
            self.manager.apply(upload, "refuse-shared-change", "abc123")
        self.assert_old_files()
        self.assertEqual(self.record("refuse-shared-change")["status"], "failed_preflight")
        self.assertEqual(self.calls, [])

    def test_shared_nginx_route_change_with_opt_in_is_recorded(self):
        result = self.manager.apply(
            self.archive({"nginx.conf": b"new shared nginx route"}),
            "allow-shared-change", "abc123", allow_proxy_update=True)
        self.assertEqual(result["status"], "deployed")
        self.assertTrue(self.record("allow-shared-change")["allowProxyUpdate"])
        self.assertEqual((self.root / "nginx.conf").read_bytes(), b"new shared nginx route")
        self.assertEqual((self.root / "tls/pay.where.work.key").read_bytes(), b"external payment key")

    def test_shared_nginx_line_endings_are_equivalent(self):
        self.write("nginx.conf", b"route line one\nroute line two\n")
        result = self.manager.apply(
            self.archive({"nginx.conf": b"route line one\r\nroute line two\r\n"}),
            "line-endings", "abc123")
        self.assertEqual(result["status"], "deployed")
        self.assertFalse(self.record("line-endings")["allowProxyUpdate"])

    def test_manual_rollback_does_not_revert_external_route_changes_by_default(self):
        self.manager.snapshot("older-routes")
        self.write("nginx.conf", b"new shared nginx route from another repository")
        self.write("src/index.html", b"current code")
        with self.assertRaises(release.ReleaseError):
            self.manager.rollback("older-routes", "refuse-old-routes")
        self.assertEqual((self.root / "nginx.conf").read_bytes(), b"new shared nginx route from another repository")
        self.assertEqual((self.root / "src/index.html").read_bytes(), b"current code")
        self.assertEqual(self.calls, [])

    def test_manual_rollback_can_explicitly_restore_older_proxy_configuration(self):
        self.manager.snapshot("older-routes")
        self.write("nginx.conf", b"new shared nginx route")
        self.write("src/index.html", b"current code")
        result = self.manager.rollback("older-routes", "restore-old-routes", allow_proxy_update=True)
        self.assertEqual(result["status"], "rolled_back")
        self.assertTrue(self.record("restore-old-routes")["allowProxyUpdate"])
        self.assert_old_files()

    def test_automatic_failure_recovery_restores_same_attempt_proxy_change(self):
        failed = [False]

        def runner(command, cwd):
            self.successful_runner(command, cwd)
            if not failed[0] and (self.root / "nginx.conf").read_bytes() == b"broken new route":
                failed[0] = True
                raise RuntimeError("new proxy syntax rejected")

        self.manager.runner = runner
        with self.assertRaises(release.ReleaseError):
            self.manager.apply(self.archive({"nginx.conf": b"broken new route"}),
                               "proxy-auto-recovery", "abc123", allow_proxy_update=True)
        self.assertTrue(failed[0])
        self.assert_old_files()
        self.assertEqual(self.record("proxy-auto-recovery")["status"], "failed_rolled_back")

    def test_active_lock_blocks_second_manager(self):
        other = release.ReleaseManager(self.root, runner=self.successful_runner)
        upload = self.archive()
        with self.manager.lock():
            with self.assertRaises(release.ReleaseError):
                other.apply(upload, "locked-release", "abc123")
        self.assert_old_files()
        self.assertEqual(self.calls, [])

    def test_live_source_symlink_is_refused(self):
        outside = Path(self.sandbox.name) / "outside.js"
        outside.write_bytes(b"outside file")
        link = self.root / "src/linked.js"
        try:
            link.symlink_to(outside)
        except OSError as error:
            self.skipTest("OS does not allow creating symlinks: {0}".format(error))
        with self.assertRaises(release.ReleaseError):
            self.manager.snapshot("source-link")
        self.assertEqual(outside.read_bytes(), b"outside file")

    def test_backup_symlink_is_rejected_without_reading_or_modifying_external_file(self):
        self.manager.snapshot("backup-link")
        outside = Path(self.sandbox.name) / "outside-env"
        outside.write_bytes(b"external data")
        path = self.root / ".backups/backup-link/files/config/app.env"
        path.unlink()
        try:
            path.symlink_to(outside)
        except OSError as error:
            self.skipTest("OS does not allow creating symlinks: {0}".format(error))
        with self.assertRaises(release.ReleaseError):
            self.manager.restore("backup-link")
        self.assertEqual(outside.read_bytes(), b"external data")
        self.assert_old_files()

    def test_reusing_release_id_cannot_overwrite_recovery_evidence(self):
        self.manager.snapshot("existing-evidence")
        before = (self.root / ".backups/existing-evidence/manifest.json").read_bytes()
        with self.assertRaises(release.ReleaseError):
            self.manager.apply(self.archive(), "existing-evidence", "abc123")
        self.assertEqual((self.root / ".backups/existing-evidence/manifest.json").read_bytes(), before)
        self.assert_old_files()

    def test_no_change_upload_preserves_files_and_does_not_restart_services(self):
        self.manager.apply(self.archive({}), "no-change", "abc123")
        self.assert_old_files()
        self.assertFalse(any("up" in command or "restart" in command or "run" in command for command in self.calls))

    def test_payment_checks_are_read_only_get_requests(self):
        self.manager.apply(self.archive(), "safe-probes", "abc123")
        curl_calls = [command for command in self.calls if Path(command[0]).name in ("curl", "curl.exe")]
        self.assertTrue(curl_calls)
        external = [command for command in curl_calls if any("pay.where.work" in arg for arg in command)]
        self.assertTrue(external, "Release verification must include the retained external payment route.")
        for command in curl_calls:
            with self.subTest(command=command):
                for arg in command:
                    self.assertNotIn(arg, ("--data", "--data-raw", "--data-binary", "-d", "POST", "PUT", "PATCH", "DELETE"))
                if "-X" in command:
                    self.assertEqual(command[command.index("-X") + 1], "GET")
                if "--request" in command:
                    self.assertEqual(command[command.index("--request") + 1], "GET")

    def test_container_activation_is_scoped_to_type_services(self):
        self.manager.apply(self.archive(), "service-scope", "abc123", recreate=True)
        docker_calls = [command for command in self.calls if Path(command[0]).name == "docker"]
        activations = [command for command in docker_calls if "up" in command]
        self.assertTrue(activations)
        for command in docker_calls:
            self.assertNotIn("down", command)
            self.assertNotIn("--remove-orphans", command)
            self.assertNotIn("wechat-pay-service", command)
            self.assertNotIn("wechat-pay-demo", command)
        for command in activations:
            self.assertEqual(command[-2:], ["app", "web"])

    def test_backend_change_automatically_recreates_type_services(self):
        self.manager.apply(self.archive({"src/translation-server.mjs": b"new backend"}),
                           "backend-update", "abc123", recreate=False)
        activations = [command for command in self.calls if "up" in command]
        self.assertEqual(len(activations), 1)
        self.assertIn("--force-recreate", activations[0])
        self.assertEqual(activations[0][-2:], ["app", "web"])

    @unittest.skipIf(os.name == "nt", "POSIX private file modes are checked on Linux.")
    def test_backup_secrets_and_release_records_remain_private(self):
        self.manager.apply(self.archive(), "private-evidence", "abc123")
        for name in (".backups", ".backups/private-evidence", ".releases", ".data-backups", ".data-backups/private-evidence"):
            with self.subTest(path=name):
                self.assertEqual(stat.S_IMODE((self.root / name).stat().st_mode), 0o700)
        for name in (".backups/private-evidence/manifest.json",
                     ".backups/private-evidence/files/config/app.env",
                     ".backups/private-evidence/files/tls/type.where.work.key",
                     ".data-backups/private-evidence/files/feedback.json",
                     ".releases/private-evidence.json"):
            with self.subTest(path=name):
                self.assertEqual(stat.S_IMODE((self.root / name).stat().st_mode), 0o600)

    def test_helper_uses_python36_compatible_syntax(self):
        if sys.version_info < (3, 8):
            self.skipTest("Grammar compatibility check needs a newer local parser.")
        ast.parse(HELPER_PATH.read_text("utf-8"), feature_version=(3, 6))


if __name__ == "__main__":
    unittest.main()
