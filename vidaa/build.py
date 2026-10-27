#!/usr/bin/env python3
"""Builds Free My TV for Hisense VIDAA TVs: out/vidaa/, a static site to host (GitHub Pages) and install from.

    python3 vidaa/build.py --generic       # without config.properties (what a public site should carry: no TMDB key)
    python3 vidaa/build.py                 # with config.properties
    python3 vidaa/build.py --config other.properties

The same home screen as on LG and Samsung (web/), with vidaa/icon.png (400 × 400, the size VIDAA's launcher takes).
VIDAA has no app packages: an app is a web address the TV's launcher opens full-screen, added with
Hisense_installApp from a page on vidaahub.com (the local store in github.com/trialuser/vidaa-appstore does that).
"""
import datetime
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
import webapp  # noqa: E402

OUT = os.path.join(ROOT, 'out', 'vidaa')


def build_version():
    """'<short git sha>-<YYYYMMDD-HHMM>', so a published site says which build it is."""
    try:
        sha = subprocess.check_output(['git', 'rev-parse', '--short', 'HEAD'], cwd=ROOT,
                                      stderr=subprocess.DEVNULL).decode().strip()
    except (OSError, subprocess.CalledProcessError):
        sha = 'nogit'
    return '%s-%s' % (sha, datetime.datetime.now().strftime('%Y%m%d-%H%M'))


def store_files():
    """vidaa/store/ as it is, under store/ in the package: the catalogue, its icons, the Store and the registry code."""
    root = os.path.join(ROOT, 'vidaa', 'store')
    out = {}
    for folder, dirs, names in os.walk(root):
        dirs[:] = sorted(d for d in dirs if d != '__pycache__')
        for name in sorted(names):
            path = os.path.join(folder, name)
            with open(path, 'rb') as f:
                out['store/' + os.path.relpath(path, root).replace(os.sep, '/')] = f.read()
    return out


def build(config):
    with open(os.path.join(ROOT, 'webos', 'appinfo.json'), encoding='utf-8') as f:
        version = json.load(f)['version']
    stamp = build_version()
    app = webapp.files(dict(config, appVersion=version, buildVersion=stamp), 'vidaa/build.py')
    app.update(store_files())
    with open(os.path.join(ROOT, 'LICENSE'), 'rb') as f:
        app['LICENSE'] = f.read()
    with open(os.path.join(ROOT, 'vidaa', 'icon.png'), 'rb') as f:
        app['icon.png'] = f.read()
    app['.nojekyll'] = b''   # GitHub Pages serves the files as they are
    webapp.preview(app, OUT)
    print('Built out/vidaa/ (Free My TV %s, build %s, %d files): host it, then install its address on the TV.' % (version, stamp, len(app)))
    if not config['tmdbKey']:
        print('No TMDB key: the picks stay off (everything else works).')


if __name__ == '__main__':
    build(webapp.config_from_args(sys.argv[1:]))
