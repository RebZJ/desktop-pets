#!/usr/bin/env python3
"""Collect locked Apple Silicon Cargo runtime and production npm notices."""
import hashlib
import json
from pathlib import Path
import stat
import subprocess
import sys
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'native/licenses/app-dependencies'
TARGET = 'aarch64-apple-darwin'
PREFIXES = ('license', 'licence', 'notice', 'copying', 'copyright', 'authors', 'unlicense')
UPSTREAM_CACHE = {}


def notice_name(name):
    return name.lower().startswith(PREFIXES)


def fetch(url):
    if url not in UPSTREAM_CACHE:
        with urlopen(Request(url, headers={'User-Agent': 'Desktop-Pets-license-collector'}), timeout=30) as response:
            UPSTREAM_CACHE[url] = response.read()
    return UPSTREAM_CACHE[url]


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        path.chmod(path.stat().st_mode | stat.S_IWUSR)
    path.write_bytes(data)


def collect(ecosystem, name, version, directory, license, source, declared=None, upstream=None):
    files = set()
    for entry in directory.iterdir():
        if notice_name(entry.name):
            files.update([entry] if entry.is_file() else (p for p in entry.rglob('*') if p.is_file()))
    if declared:
        candidate = (directory / declared).resolve()
        if candidate.is_relative_to(directory.resolve()) and candidate.is_file():
            files.add(candidate)
    assert all(p.resolve().is_relative_to(directory.resolve()) for p in files), f'Notice links outside {name}@{version}'
    contents = {str(p.relative_to(directory)): (p.read_bytes(), None) for p in files}
    if not contents and upstream:
        repository = urlparse(upstream['repository'])
        assert repository.hostname == 'github.com', f'Inspect missing notices for {name}@{version}'
        repo = repository.path.strip('/').removesuffix('.git')
        revision = upstream['revision']
        tree = json.loads(fetch(f'https://api.github.com/repos/{repo}/git/trees/{revision}'))
        for entry in tree['tree']:
            if entry['type'] == 'blob' and notice_name(entry['path']):
                url = f"https://raw.githubusercontent.com/{repo}/{revision}/{quote(entry['path'])}"
                contents[entry['path']] = (fetch(url), url)
    if not contents and license == 'MPL-2.0':
        url = 'https://www.mozilla.org/MPL/2.0/index.txt'
        contents['LICENSE-MPL-2.0.txt'] = (fetch(url), url)
    assert contents, f'No upstream license/notice files for {name}@{version}; inspect before distributing.'
    copied = []
    for relative, (data, url) in sorted(contents.items()):
        destination = OUTPUT / ecosystem / f"{name.replace('/', '__')}@{version}" / relative
        assert destination.resolve().is_relative_to(OUTPUT.resolve())
        write(destination, data)
        item = {'path': str(destination.relative_to(OUTPUT)), 'sha256': hashlib.sha256(data).hexdigest()}
        if url:
            item['upstream'] = url
        copied.append(item)
    return {'ecosystem': ecosystem, 'name': name, 'version': version, 'license': license, 'source': source, 'files': copied}


def cargo_packages():
    metadata = json.loads(subprocess.check_output([
        'cargo', 'metadata', '--manifest-path', str(ROOT / 'src-tauri/Cargo.toml'),
        '--format-version', '1', '--locked', '--offline', '--filter-platform', TARGET,
        '--features', 'tauri/custom-protocol',
    ], cwd=ROOT))
    nodes = {node['id']: node for node in metadata['resolve']['nodes']}
    pending, included = [metadata['resolve']['root']], set()
    while pending:
        package_id = pending.pop()
        if package_id in included:
            continue
        included.add(package_id)
        pending.extend(dep['pkg'] for dep in nodes[package_id]['deps'] if any(kind['kind'] is None for kind in dep['dep_kinds']))
    return sorted((package for package in metadata['packages'] if package['id'] in included and package['id'] != metadata['resolve']['root']), key=lambda p: (p['name'], p['version']))


def npm_packages():
    lock = json.loads((ROOT / 'package-lock.json').read_text())
    return [(relative, entry) for relative, entry in sorted(lock['packages'].items()) if relative and not entry.get('dev') and not entry.get('devOptional')]


def main():
    packages = []
    for package in cargo_packages():
        directory = Path(package['manifest_path']).parent
        vcs_file = directory / '.cargo_vcs_info.json'
        upstream = None
        if package.get('repository') and vcs_file.exists():
            upstream = {'repository': package['repository'], 'revision': json.loads(vcs_file.read_text())['git']['sha1']}
        packages.append(collect('cargo', package['name'], package['version'], directory,
                                package['license'], f"https://crates.io/crates/{package['name']}/{package['version']}",
                                package.get('license_file'), upstream))
    for relative, entry in npm_packages():
        directory = ROOT / relative
        assert directory.resolve().is_relative_to((ROOT / 'node_modules').resolve())
        package = json.loads((directory / 'package.json').read_text())
        assert package['version'] == entry['version'], f'Run npm ci for {relative}'
        packages.append(collect('npm', package['name'], package['version'], directory,
                                package.get('license', entry.get('license')),
                                f"https://www.npmjs.com/package/{package['name']}/v/{package['version']}"))
    index = {'target': TARGET, 'scope': 'Cargo normal-dependency closure and production npm lockfile entries; proc-macro notices may be included.', 'packages': packages}
    write(OUTPUT / 'index.json', (json.dumps(index, indent=2, sort_keys=True) + '\n').encode())
    check()


def check():
    raw = (OUTPUT / 'index.json').read_text()
    assert str(ROOT) not in raw and '/Users/' not in raw and 'file://' not in raw
    packages = json.loads(raw)['packages']
    assert packages
    expected = {('cargo', p['name'], p['version']) for p in cargo_packages()}
    expected.update(('npm', entry.get('name', relative.rsplit('node_modules/', 1)[-1]), entry['version']) for relative, entry in npm_packages())
    actual = {(p['ecosystem'], p['name'], p['version']) for p in packages}
    assert actual == expected, 'Dependency graph changed: regenerate the runtime notices.'
    for package in packages:
        assert package['files']
        for item in package['files']:
            path = (OUTPUT / item['path']).resolve()
            assert path.is_relative_to(OUTPUT.resolve())
            assert hashlib.sha256(path.read_bytes()).hexdigest() == item['sha256'], item['path']
            path.chmod(path.stat().st_mode | stat.S_IWUSR)
    print(f"Verified {len(packages)} dependency entries and {sum(len(p['files']) for p in packages)} exact upstream notice files.")


if __name__ == '__main__':
    assert sys.argv[1:] in ([], ['--check']), 'Usage: collect-runtime-licenses.py [--check]'
    check() if sys.argv[1:] == ['--check'] else main()
