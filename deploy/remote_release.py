"""Private, dependency-free release recovery helper (Python 3.6+).

Only the CLI is a production entry point; its root is fixed at /opt/zijian.
ReleaseManager accepts a temporary root and command runner for offline drills.
"""

import argparse
import base64
from contextlib import contextmanager, closing
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sqlite3
import stat
import subprocess
import sys
import tarfile
import uuid


PRODUCTION_ROOT = Path('/opt/zijian')
FIXED_FILES = ('compose.yaml', 'nginx.conf', 'config/app.env',
               'tls/type.where.work.pem', 'tls/type.where.work.key')
REQUIRED_FILES = FIXED_FILES + ('src/index.html', 'src/translation-server.mjs')
ID_PATTERN = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$')
HASH_PATTERN = re.compile(r'^[0-9a-f]{64}$')
MAX_ARCHIVE_BYTES = 100 * 1024 * 1024


class ReleaseError(RuntimeError):
    pass


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def digest(path):
    hasher = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            hasher.update(block)
    return hasher.hexdigest()


def identifier(value):
    if not isinstance(value, str) or not ID_PATTERN.fullmatch(value):
        raise ReleaseError('Invalid release identifier.')
    return value


def relative_name(value):
    if not isinstance(value, str) or not value or '\\' in value or ':' in value:
        raise ReleaseError('Invalid relative path.')
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in ('', '.', '..') for part in value.split('/')):
        raise ReleaseError('Unsafe relative path.')
    return value


def managed_name(value):
    relative_name(value)
    if value in FIXED_FILES:
        return value
    parts = value.split('/')
    if len(parts) == 2 and parts[0] == 'src' and re.fullmatch(r'[A-Za-z0-9._-]+', parts[1]):
        if Path(parts[1]).suffix in ('.html', '.css', '.js', '.mjs') or parts[1] in ('robots.txt', 'sitemap.xml'):
            return value
    raise ReleaseError('Path is outside the managed type release files: ' + value)


def check_node(path):
    if not os.path.lexists(str(path)):
        return
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or getattr(info, 'st_file_attributes', 0) & 0x400:
        raise ReleaseError('Symbolic links and directory junctions are not allowed: ' + str(path))
    if not (stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode)):
        raise ReleaseError('Special filesystem nodes are not allowed: ' + str(path))


def safe_path(root, relative):
    relative_name(relative)
    check_node(root)
    current = root
    for part in relative.split('/'):
        current = current / part
        check_node(current)
    if os.path.commonpath([str(root), str(current.resolve())]) != str(root):
        raise ReleaseError('Path escapes the deployment root.')
    return current


def private_directory(path):
    check_node(path)
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.chmod(0o700)


def regular_files(root):
    check_node(root)
    if not root.exists():
        return []
    if not root.is_dir():
        raise ReleaseError('Expected a directory: ' + str(root))
    result = []
    for directory, folders, files in os.walk(str(root), followlinks=False):
        for name in folders + files:
            path = Path(directory) / name
            check_node(path)
            if path.is_file():
                result.append(path)
    return sorted(result)


def default_runner(command, cwd):
    try:
        result = subprocess.run(command, cwd=str(cwd), stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                universal_newlines=True, timeout=240)
    except subprocess.TimeoutExpired:
        raise ReleaseError('Command timed out: ' + ' '.join(command))
    if result.returncode:
        # Do not persist response bodies, environment values or private diagnostics.
        raise ReleaseError('Command failed (exit {}): {}'.format(result.returncode, ' '.join(command)))


class ReleaseManager:
    def __init__(self, root, runner=None):
        self.root = Path(os.path.abspath(str(root)))
        current = self.root
        while True:
            check_node(current)
            if current.parent == current:
                break
            current = current.parent
        if self.root.resolve() != self.root:
            raise ReleaseError('Deployment root must be canonical.')
        self.root.mkdir(parents=True, exist_ok=True)
        self.runner = runner or default_runner
        self._lock_held = False
        for name in ('.incoming', '.backups', '.data-backups', '.releases'):
            private_directory(safe_path(self.root, name))

    @contextmanager
    def lock(self):
        if self._lock_held:
            raise ReleaseError('A release operation is already running.')
        lock_path = safe_path(self.root, '.release.lock')
        handle = lock_path.open('a+b')
        lock_path.chmod(0o600)
        try:
            try:
                if os.name == 'nt':
                    import msvcrt
                    handle.seek(0)
                    if not handle.read(1):
                        handle.write(b'0')
                        handle.flush()
                    handle.seek(0)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except (OSError, IOError):
                raise ReleaseError('Another deployment or rollback holds the release lock.')
            self._lock_held = True
            yield
        finally:
            if self._lock_held:
                if os.name == 'nt':
                    import msvcrt
                    handle.seek(0)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
                self._lock_held = False
            handle.close()

    def _files(self):
        paths = []
        for path in regular_files(safe_path(self.root, 'src')):
            name = path.relative_to(self.root).as_posix()
            managed_name(name)
            paths.append(name)
        for name in FIXED_FILES:
            path = safe_path(self.root, name)
            if path.exists():
                if not path.is_file():
                    raise ReleaseError('Managed file is not a regular file: ' + name)
                paths.append(name)
        return sorted(paths)

    def _hash(self, name):
        path = safe_path(self.root, managed_name(name))
        if not path.exists():
            return None
        if not path.is_file():
            raise ReleaseError('Expected a regular managed file: ' + name)
        return digest(path)

    def inspect(self, paths):
        with self.lock():
            names = sorted(set([managed_name(name) for name in paths] + ['config/app.env']))
            hashes = {name: self._hash(name) for name in names}
            proxy = safe_path(self.root, 'nginx.conf')
            normalized = hashlib.sha256(proxy.read_bytes().replace(b'\r\n', b'\n')).hexdigest() if proxy.is_file() else None
            return {'hashes': hashes, 'hasConfig': hashes['config/app.env'] is not None,
                    'proxyNormalizedHash': normalized}

    def snapshot(self, release_id):
        identifier(release_id)
        destination = safe_path(self.root, '.backups/' + release_id)
        if destination.exists():
            raise ReleaseError('Backup identifier already exists.')
        temporary = safe_path(self.root, '.backups/.tmp-' + release_id + '-' + uuid.uuid4().hex)
        private_directory(temporary)
        try:
            private_directory(temporary / 'files')
            names = self._files()
            entries = []
            for name in names:
                source = safe_path(self.root, name)
                target = safe_path(temporary / 'files', name)
                private_directory(target.parent)
                shutil.copyfile(str(source), str(target))
                target.chmod(0o600)
                entries.append({'path': name, 'sha256': digest(target), 'size': target.stat().st_size})
            manifest = {'version': 1, 'id': release_id, 'createdAt': timestamp(),
                        'restorable': all(name in names for name in REQUIRED_FILES),
                        'files': entries, 'absent': [name for name in FIXED_FILES if name not in names],
                        'scope': 'type-code-config-only; data and pay certificates excluded'}
            data = (json.dumps(manifest, ensure_ascii=True, sort_keys=True, indent=2) + '\n').encode('utf-8')
            (temporary / 'manifest.json').write_bytes(data)
            (temporary / 'manifest.sha256').write_text(hashlib.sha256(data).hexdigest() + '\n', encoding='ascii')
            for path in regular_files(temporary):
                path.chmod(0o600)
            temporary.rename(destination)
            self.validate_snapshot(release_id)
            return manifest
        except Exception:
            if temporary.exists():
                shutil.rmtree(str(temporary))
            raise

    def backup_sqlite(self, source, target):
        """Online backup includes committed WAL frames in one consistent database."""
        if hasattr(sqlite3.Connection, 'backup'):
            import time
            started = time.monotonic()

            def progress(status, remaining, total):
                if time.monotonic() - started > 120:
                    raise ReleaseError('SQLite backup timed out; release stopped.')

            with closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)) as live:
                with closing(sqlite3.connect(str(target))) as copy:
                    live.backup(copy, pages=256, progress=progress)
                    copy.execute('PRAGMA journal_mode=DELETE')
                    if copy.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
                        raise ReleaseError('SQLite backup integrity check failed.')
        else:
            # Production Python 3.6 lacks Connection.backup. Use the running
            # app's Node 24 SQLite backup API, with a private mounted temp file.
            data_root = safe_path(self.root, 'data')
            temporary = safe_path(data_root, '.sqlite-backup-' + uuid.uuid4().hex)
            script = """import { DatabaseSync, backup } from 'node:sqlite';
import { chmodSync } from 'node:fs';
process.umask(0o077);
const db = new DatabaseSync(process.argv[1], { readOnly: true });
try { await backup(db, process.argv[2]); } finally { db.close(); }
chmodSync(process.argv[2], 0o600);
const copy = new DatabaseSync(process.argv[2]);
try { copy.exec('PRAGMA journal_mode=DELETE'); if (JSON.stringify(copy.prepare('PRAGMA integrity_check').all()) !== '[{"integrity_check":"ok"}]') throw new Error('Invalid SQLite backup'); }
finally { copy.close(); }
"""
            try:
                self.runner(['docker', 'compose', 'exec', '-T', 'app', 'node', '--input-type=module', '-e', script,
                             '/data/' + source.relative_to(data_root).as_posix(), '/data/' + temporary.name], self.root)
                check_node(temporary)
                if not temporary.is_file():
                    raise ReleaseError('SQLite snapshot was not produced.')
                shutil.copyfile(str(temporary), str(target))
            finally:
                for suffix in ('', '-wal', '-shm', '-journal'):
                    extra = safe_path(data_root, temporary.name + suffix)
                    if extra.exists():
                        extra.unlink()
        target.chmod(0o600)

    def backup_data(self, release_id):
        """Separate private safety copy. No restore path ever reads this directory."""
        identifier(release_id)
        destination = safe_path(self.root, '.data-backups/' + release_id)
        if destination.exists():
            raise ReleaseError('Data backup identifier already exists.')
        temporary = safe_path(self.root, '.data-backups/.tmp-' + release_id + '-' + uuid.uuid4().hex)
        private_directory(temporary)
        try:
            private_directory(temporary / 'files')
            data_root = safe_path(self.root, 'data')
            entries = []
            sources = regular_files(data_root)
            databases = set()
            for source in sources:
                with source.open('rb') as stream:
                    if stream.read(16) == b'SQLite format 3\x00' or source.suffix in ('.sqlite', '.db'):
                        databases.add(source)
            journals = set(Path(str(source) + suffix) for source in databases for suffix in ('-wal', '-shm', '-journal'))
            sources = [source for source in sources if source not in journals]
            for source in sources:
                name = source.relative_to(data_root).as_posix()
                target = safe_path(temporary / 'files', name)
                private_directory(target.parent)
                if source in databases:
                    self.backup_sqlite(source, target)
                    before = digest(target)
                else:
                    before = digest(source)
                    shutil.copyfile(str(source), str(target))
                    target.chmod(0o600)
                    if digest(target) != before or digest(source) != before:
                        raise ReleaseError('Data changed during backup; retry the release without restoring data.')
                entries.append({'path': name, 'sha256': before, 'size': target.stat().st_size})
            if sources != [source for source in regular_files(data_root) if source not in journals]:
                raise ReleaseError('Data file list changed during backup; retry the release.')
            manifest = {'version': 1, 'id': release_id, 'createdAt': timestamp(),
                        'files': entries, 'dataExisted': data_root.exists(),
                        'scope': 'type data only; backup only, no automatic restore'}
            encoded = (json.dumps(manifest, ensure_ascii=True, sort_keys=True, indent=2) + '\n').encode('utf-8')
            (temporary / 'manifest.json').write_bytes(encoded)
            (temporary / 'manifest.sha256').write_text(hashlib.sha256(encoded).hexdigest() + '\n', encoding='ascii')
            for path in regular_files(temporary):
                path.chmod(0o600)
            temporary.rename(destination)
            return manifest
        except Exception:
            if temporary.exists():
                shutil.rmtree(str(temporary))
            raise

    def validate_snapshot(self, snapshot_id):
        identifier(snapshot_id)
        directory = safe_path(self.root, '.backups/' + snapshot_id)
        actual_files = regular_files(directory)
        manifest_file = safe_path(directory, 'manifest.json')
        checksum_file = safe_path(directory, 'manifest.sha256')
        try:
            if checksum_file.read_text(encoding='ascii').strip() != digest(manifest_file):
                raise ReleaseError('Backup manifest checksum mismatch.')
            manifest = json.loads(manifest_file.read_text(encoding='utf-8'))
        except (OSError, ValueError, UnicodeError) as error:
            raise ReleaseError('Cannot read a valid backup manifest: ' + type(error).__name__)
        if not isinstance(manifest, dict) or manifest.get('version') != 1 or manifest.get('id') != snapshot_id:
            raise ReleaseError('Invalid backup manifest identity/version.')
        files = manifest.get('files')
        absent = manifest.get('absent')
        if not isinstance(files, list) or not isinstance(absent, list) or any(name not in FIXED_FILES for name in absent):
            raise ReleaseError('Invalid backup file list.')
        names = set()
        for entry in files:
            if not isinstance(entry, dict):
                raise ReleaseError('Invalid backup entry.')
            name = managed_name(entry.get('path'))
            if name in names or not HASH_PATTERN.fullmatch(str(entry.get('sha256', ''))):
                raise ReleaseError('Duplicate or malformed backup entry.')
            names.add(name)
            path = safe_path(directory, 'files/' + name)
            if not path.is_file() or path.stat().st_size != entry.get('size') or digest(path) != entry['sha256']:
                raise ReleaseError('Backup contents failed checksum verification: ' + name)
        if len(set(absent)) != len(absent) or set(absent) & names or set(absent) != set(FIXED_FILES) - names:
            raise ReleaseError('Backup missing-file list is inconsistent.')
        expected = set(['manifest.json', 'manifest.sha256'] + ['files/' + name for name in names])
        if set(path.relative_to(directory).as_posix() for path in actual_files) != expected:
            raise ReleaseError('Backup contains undeclared files.')
        if manifest.get('restorable') is not all(name in names for name in REQUIRED_FILES):
            raise ReleaseError('Backup recovery status is inconsistent.')
        return manifest

    def _install(self, source, name):
        target = safe_path(self.root, managed_name(name))
        parent = target.parent
        if not parent.exists():
            parent.mkdir(parents=True, mode=0o700)
        temporary = safe_path(self.root, name + '.release-' + uuid.uuid4().hex)
        try:
            shutil.copyfile(str(source), str(temporary))
            temporary.chmod(0o600 if name in ('config/app.env', 'tls/type.where.work.key') else 0o644)
            os.replace(str(temporary), str(target))
        finally:
            if temporary.exists():
                temporary.unlink()
        if name.startswith('src/'):
            parent.chmod(0o755)
        elif name.startswith(('config/', 'tls/')):
            parent.chmod(0o700)

    def restore(self, snapshot_id):
        manifest = self.validate_snapshot(snapshot_id)
        if not manifest['restorable']:
            raise ReleaseError('Backup has no previous complete release to restore.')
        names = set(entry['path'] for entry in manifest['files'])
        # Validate all current paths before the first mutation.
        current = self._files()
        for name in names:
            safe_path(self.root, name)
        directory = safe_path(self.root, '.backups/' + snapshot_id + '/files')
        for entry in manifest['files']:
            self._install(safe_path(directory, entry['path']), entry['path'])
        for name in current:
            if name not in names:
                safe_path(self.root, name).unlink()
        return manifest

    def _upload(self, archive, release_id):
        archive = Path(os.path.abspath(str(archive)))
        incoming = safe_path(self.root, '.incoming')
        if archive.parent != incoming:
            raise ReleaseError('Upload must be a direct file in the private incoming directory.')
        safe_path(self.root, '.incoming/' + archive.name)
        if not archive.is_file() or archive.stat().st_size > MAX_ARCHIVE_BYTES:
            raise ReleaseError('Invalid or oversized deployment archive.')
        stage = safe_path(self.root, '.incoming/stage-' + release_id)
        if stage.exists():
            raise ReleaseError('Staging identifier already exists.')
        private_directory(stage)
        try:
            with tarfile.open(str(archive), 'r:*') as bundle:
                entries = {}
                total = 0
                for member in bundle.getmembers():
                    name = member.name
                    while name.startswith('./'):
                        name = name[2:]
                    if name in ('', '.') and member.isdir():
                        continue
                    name = name.rstrip('/') if member.isdir() else name
                    relative_name(name)
                    if member.isdir():
                        if name not in ('src', 'config', 'tls'):
                            raise ReleaseError('Unexpected archive directory.')
                        continue
                    if not member.isfile() or name in entries:
                        raise ReleaseError('Archive links, special nodes and duplicate files are forbidden.')
                    if name != 'manifest.json':
                        managed_name(name)
                    total += member.size
                    if total > MAX_ARCHIVE_BYTES:
                        raise ReleaseError('Expanded upload is too large.')
                    target = safe_path(stage, name)
                    private_directory(target.parent)
                    with bundle.extractfile(member) as source, target.open('xb') as output:
                        shutil.copyfileobj(source, output)
                    target.chmod(0o600)
                    entries[name] = target
            manifest = json.loads(entries['manifest.json'].read_text(encoding='utf-8-sig'))
            if not isinstance(manifest, dict) or manifest.get('version') != 1 or not isinstance(manifest.get('files'), list):
                raise ReleaseError('Invalid upload manifest.')
            expected = set()
            for entry in manifest['files']:
                if not isinstance(entry, dict):
                    raise ReleaseError('Invalid upload entry.')
                name = managed_name(entry.get('path'))
                if name in expected or not HASH_PATTERN.fullmatch(str(entry.get('sha256', ''))):
                    raise ReleaseError('Duplicate or invalid upload entry.')
                if name not in entries or digest(entries[name]) != entry['sha256']:
                    raise ReleaseError('Upload checksum mismatch: ' + name)
                expected.add(name)
            if set(entries) != expected | {'manifest.json'}:
                raise ReleaseError('Upload contains undeclared files.')
            baseline = manifest.get('baseline')
            if not isinstance(baseline, dict):
                raise ReleaseError('Invalid deployment baseline.')
            if not expected.issubset(set(baseline)):
                raise ReleaseError('Deployment baseline must cover every changed file.')
            for name, expected_hash in baseline.items():
                managed_name(name)
                if expected_hash is not None and not HASH_PATTERN.fullmatch(str(expected_hash)):
                    raise ReleaseError('Invalid baseline hash.')
                if self._hash(name) != expected_hash:
                    raise ReleaseError('Remote files changed since inspection; inspect and deploy again: ' + name)
            return stage, manifest
        except Exception:
            shutil.rmtree(str(stage))
            raise

    def _proxy_guard(self, candidate, allowed):
        live = safe_path(self.root, 'nginx.conf')
        if candidate.is_file() and live.is_file() and not allowed:
            if candidate.read_bytes().replace(b'\r\n', b'\n') != live.read_bytes().replace(b'\r\n', b'\n'):
                raise ReleaseError('Shared nginx routes differ. Review pay routes and explicitly enable UpdateProxyRoutes.')

    def _route_checks(self):
        for domain, path in (('pay.where.work', '/health'), ('type.where.work', '/payments/')):
            self.runner(['curl', '--fail', '--silent', '--show-error', '--max-time', '20',
                         '--location', '--max-redirs', '3', '--noproxy', '*',
                         '--resolve', 'pay.where.work:443:127.0.0.1',
                         '--resolve', 'type.where.work:443:127.0.0.1',
                         'https://' + domain + path], self.root)

    def _activate(self, recreate):
        self.runner(['docker', 'compose', 'config', '--quiet'], self.root)
        if recreate:
            self.runner(['docker', 'compose', 'run', '--rm', '--no-deps', '-T', 'web', 'nginx', '-t'], self.root)
            # Explicit service scope: never remove or start unrelated payment containers.
            self.runner(['docker', 'compose', 'up', '-d', '--force-recreate', '--wait',
                         '--wait-timeout', '180', 'app', 'web'], self.root)
        self.runner(['docker', 'compose', 'exec', '-T', 'web', 'nginx', '-t'], self.root)
        for path in ('/api/status', '/'):
            self.runner(['curl', '--fail', '--silent', '--show-error', '--max-time', '20',
                         '--noproxy', '*', '--resolve', 'type.where.work:443:127.0.0.1',
                         'https://type.where.work' + path], self.root)
        self._route_checks()

    def _record(self, record):
        path = safe_path(self.root, '.releases/' + identifier(record['id']) + '.json')
        temporary = safe_path(self.root, '.releases/record-' + uuid.uuid4().hex + '.tmp')
        temporary.write_text(json.dumps(record, ensure_ascii=True, sort_keys=True, indent=2) + '\n', encoding='utf-8')
        temporary.chmod(0o600)
        os.replace(str(temporary), str(path))

    def _begin(self, release_id, commit, operation, allow_proxy_update):
        identifier(release_id)
        if not re.fullmatch(r'[A-Za-z0-9._+-]{1,96}', commit):
            raise ReleaseError('Invalid commit label.')
        if safe_path(self.root, '.releases/' + release_id + '.json').exists():
            raise ReleaseError('Release identifier already used.')
        record = {'version': 1, 'id': release_id, 'commit': commit, 'operation': operation,
                  'startedAt': timestamp(), 'status': 'preflight', 'backupId': None,
                  'dataBackupId': None,
                  'allowProxyUpdate': bool(allow_proxy_update)}
        self._record(record)
        return record

    def _failure(self, record, error, backup, mutated):
        record['error'] = str(error)
        if mutated and backup and backup['restorable']:
            try:
                self.restore(backup['id'])
                self._activate(True)
                record['status'] = 'failed_rolled_back'
            except Exception as recovery_error:
                record['status'] = 'failed_recovery'
                record['recoveryError'] = str(recovery_error)
        elif mutated:
            record['status'] = 'failed_no_previous'
        else:
            record['status'] = 'failed_preflight'
        record['finishedAt'] = timestamp()
        self._record(record)
        raise ReleaseError('{}; release {} status {} (see private .releases record).'.format(
            str(error), record['id'], record['status']))

    def apply(self, upload, release_id, commit, recreate=False, allow_proxy_update=False):
        with self.lock():
            record = self._begin(release_id, commit, 'deploy', allow_proxy_update)
            stage = None
            backup = None
            mutated = False
            try:
                stage, manifest = self._upload(upload, release_id)
                self._proxy_guard(stage / 'nginx.conf', allow_proxy_update)
                if all(safe_path(self.root, name).is_file() for name in REQUIRED_FILES):
                    self._route_checks()
                self.backup_data(release_id)
                record['dataBackupId'] = release_id
                self._record(record)
                backup = self.snapshot(release_id)
                record.update({'backupId': release_id, 'hasPreviousRelease': backup['restorable'],
                               'files': [entry['path'] for entry in manifest['files']], 'status': 'applying'})
                self._record(record)
                for entry in manifest['files']:
                    safe_path(self.root, entry['path'])
                data_dir = safe_path(self.root, 'data')
                if not data_dir.exists():
                    private_directory(data_dir)
                    if os.name != 'nt':
                        os.chown(str(data_dir), 1000, 1000)
                mutated = bool(manifest['files'])
                for entry in manifest['files']:
                    self._install(stage / entry['path'], entry['path'])
                requires_restart = recreate or any(
                    entry['path'] in FIXED_FILES or entry['path'].endswith('.mjs') for entry in manifest['files'])
                self._activate(requires_restart)
                record['status'] = 'deployed'
                record['finishedAt'] = timestamp()
                self._record(record)
                return record
            except Exception as error:
                self._failure(record, error, backup, mutated)
            finally:
                if stage and stage.exists():
                    shutil.rmtree(str(stage))
                archive = Path(os.path.abspath(str(upload)))
                if archive.parent == self.root / '.incoming':
                    safe_path(self.root, '.incoming/' + archive.name)
                    if archive.is_file():
                        archive.unlink()

    def rollback(self, snapshot_id, release_id, commit='manual', allow_proxy_update=False):
        with self.lock():
            record = self._begin(release_id, commit, 'rollback', allow_proxy_update)
            record['rollbackOf'] = snapshot_id
            backup = None
            mutated = False
            try:
                target = self.validate_snapshot(snapshot_id)
                if not target['restorable']:
                    raise ReleaseError('Selected backup has no previous complete release.')
                self._proxy_guard(safe_path(self.root, '.backups/' + snapshot_id + '/files/nginx.conf'), allow_proxy_update)
                self.backup_data(release_id)
                record['dataBackupId'] = release_id
                self._record(record)
                backup = self.snapshot(release_id)
                record.update({'backupId': release_id, 'hasPreviousRelease': backup['restorable'], 'status': 'restoring'})
                self._record(record)
                mutated = True
                self.restore(snapshot_id)
                self._activate(True)
                record['status'] = 'rolled_back'
                record['finishedAt'] = timestamp()
                self._record(record)
                return record
            except Exception as error:
                self._failure(record, error, backup, mutated)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=('inspect', 'apply', 'rollback'))
    parser.add_argument('--paths-base64')
    parser.add_argument('--release-id')
    parser.add_argument('--commit', default='manual')
    parser.add_argument('--upload')
    parser.add_argument('--snapshot-id')
    parser.add_argument('--recreate', action='store_true')
    parser.add_argument('--allow-proxy-update', action='store_true')
    args = parser.parse_args()
    os.umask(0o077)
    try:
        if PRODUCTION_ROOT != Path('/opt/zijian') or PRODUCTION_ROOT.resolve() != PRODUCTION_ROOT:
            raise ReleaseError('Unexpected production deployment directory.')
        manager = ReleaseManager(PRODUCTION_ROOT)
        if args.operation == 'inspect':
            paths = json.loads(base64.b64decode(args.paths_base64).decode('utf-8'))
            if not isinstance(paths, list):
                raise ReleaseError('Inspection paths must be a list.')
            result = manager.inspect(paths)
        elif args.operation == 'apply':
            result = manager.apply(args.upload, args.release_id, args.commit, args.recreate, args.allow_proxy_update)
        else:
            result = manager.rollback(args.snapshot_id, args.release_id, args.commit, args.allow_proxy_update)
        print(json.dumps(result, ensure_ascii=True, sort_keys=True))
        return 0
    except Exception as error:
        print('Release operation failed: ' + str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
