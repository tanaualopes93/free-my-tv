#!/usr/bin/env python3
"""Builds Free My TV for Hisense VIDAA TVs: out/vidaa/, a static site to host (GitHub Pages) and install from.

    python3 vidaa/build.py --generic       # without config.properties (what a public site should carry: no TMDB key)
    python3 vidaa/build.py                 # with config.properties
    python3 vidaa/build.py --config other.properties

The same home screen as on LG and Samsung (web/), with vidaa/icon.png (400 × 400, the size VIDAA's launcher takes).
VIDAA has no app packages: an app is a web address the TV's launcher opens full-screen, added with
Hisense_installApp from a page on vidaahub.com (the local store in github.com/trialuser/vidaa-appstore does that).
"""
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))
import webapp  # noqa: E402

OUT = os.path.join(ROOT, 'out', 'vidaa')


def build(config):
    with open(os.path.join(ROOT, 'webos', 'appinfo.json'), encoding='utf-8') as f:
        version = json.load(f)['version']
    app = webapp.files(dict(config, appVersion=version), 'vidaa/build.py')
    with open(os.path.join(ROOT, 'vidaa', 'icon.png'), 'rb') as f:
        app['icon.png'] = f.read()
    app['.nojekyll'] = b''   # GitHub Pages serves the files as they are
    webapp.preview(app, OUT)
    print('Built out/vidaa/ (Free My TV %s, %d files): host it, then install its address on the TV.' % (version, len(app)))
    if not config['tmdbKey']:
        print('No TMDB key: the picks stay off (everything else works).')


if __name__ == '__main__':
    build(webapp.config_from_args(sys.argv[1:]))
