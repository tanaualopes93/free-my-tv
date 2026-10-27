#!/usr/bin/env python3
"""Checks vidaa/store/catalogo.json: the schema (jsonschema when installed, our own rules always), the icons,
and with --online the apps' addresses and the published icons. Exits 1 with one line per problem."""
import json
import os
import re
import struct
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STORE = os.environ.get('FMTV_STORE') or os.path.join(ROOT, 'vidaa', 'store')   # FMTV_STORE: for tests
SITE = 'https://tanaualopes93.github.io/free-my-tv/store/'
MAX_ICON = 40 * 1024
PAID = ('free', 'freemium', 'paid')
errors = []


def bad(msg):
    errors.append(msg)


def png_size(path):
    with open(path, 'rb') as f:
        head = f.read(24)
    if head[:8] != b'\x89PNG\r\n\x1a\n' or head[12:16] != b'IHDR':
        return None
    return struct.unpack('>II', head[16:24])


def lang_text(v, where):
    if not isinstance(v, dict) or not all(isinstance(v.get(k), str) and v[k].strip() for k in ('pt', 'en')):
        bad('%s: needs non-empty pt and en' % where)


def curl_ok(url):
    try:
        code = subprocess.check_output(['curl', '-sL', '-o', os.devnull, '-w', '%{http_code}', '--max-time', '25',
                                        '-A', 'Mozilla/5.0 (X11; Linux armv7l) Chrome/111.0.0.0', url]).decode().strip()
    except (OSError, subprocess.CalledProcessError):
        return False
    return code == '200'


def allowed_hosts(apps):
    """registry.js ALLOWED_DEFAULT must be the catalogue's https hosts plus our own site, nothing else."""
    try:
        with open(os.path.join(STORE, 'registry.js'), encoding='utf-8') as f:
            src = f.read()
    except OSError:
        return
    m = re.search(r'ALLOWED_DEFAULT\s*=\s*\[(.*?)\]', src, re.S)
    if not m:
        bad('registry.js: ALLOWED_DEFAULT not found')
        return
    allowed = set(re.findall(r"'([^']+)'", m.group(1)))
    wanted = {re.match(r'^https://([^/:\s]+)', a.get('url', '')).group(1) for a in apps if re.match(r'^https://[^/:\s]+', a.get('url', ''))}
    wanted.add(re.match(r'^https://([^/]+)', SITE).group(1))
    for h in sorted(wanted - allowed):
        bad('registry.js ALLOWED_DEFAULT is missing %s (installing would fail with "domain")' % h)
    for h in sorted(allowed - wanted):
        bad('registry.js ALLOWED_DEFAULT has %s, which no catalogue app uses' % h)


def example_config():
    """local/servidor.example.json is copied by hand, so it must stay valid JSON."""
    path = os.path.join(ROOT, 'local', 'servidor.example.json')
    if not os.path.exists(path) or os.environ.get('FMTV_STORE'):
        return
    try:
        with open(path, encoding='utf-8') as f:
            json.load(f)
    except ValueError as e:
        bad('local/servidor.example.json is not valid JSON: %s' % e)


def main():
    online = '--online' in sys.argv
    path = os.path.join(STORE, 'catalogo.json')
    try:
        with open(path, encoding='utf-8') as f:
            cat = json.load(f)
    except (OSError, ValueError) as e:
        sys.exit('catalogo.json: %s' % e)

    schema = os.path.join(STORE, 'catalogo.schema.json')
    if os.path.exists(schema):
        try:
            import jsonschema
            with open(schema, encoding='utf-8') as f:
                jsonschema.validate(cat, json.load(f))
        except ImportError:
            pass   # our own rules below cover the same fields
        except Exception as e:   # jsonschema.ValidationError and a broken schema alike
            bad('schema: %s' % str(e).splitlines()[0])

    if cat.get('schema') != 1:
        bad('schema must be 1')
    if not re.match(r'^\d{4}-\d{2}-\d{2}$', str(cat.get('updated', ''))):
        bad('updated must be AAAA-MM-DD')
    cats = {}
    for c in cat.get('categories') or []:
        cats[c.get('id')] = c
        lang_text(c.get('name'), 'category %s name' % c.get('id'))
        if not isinstance(c.get('order'), int):
            bad('category %s: order must be a number' % c.get('id'))
    if not cats:
        bad('no categories')

    seen = set()
    apps = cat.get('apps') or []
    if not apps:
        bad('no apps')
    for a in apps:
        i = a.get('id')
        w = 'app %s' % i
        if not isinstance(i, str) or not re.match(r'^[a-z0-9][a-z0-9-]{0,30}$', i):
            bad('%s: id must be lowercase letters, digits and dashes' % w)
        if i in seen:
            bad('%s: duplicated id' % w)
        seen.add(i)
        if not isinstance(a.get('name'), str) or not a['name'].strip():
            bad('%s: name' % w)
        url = a.get('url', '')
        if not isinstance(a.get('http'), bool):
            bad('%s: http must be true or false' % w)
        if not re.match(r'^https://[^\s/]+', url) and not (a.get('http') is True and re.match(r'^http://[^\s/]+', url)):
            bad('%s: url must be https (http only with "http": true)' % w)
        if not re.match(r'^#[0-9A-Fa-f]{6}$', str(a.get('color', ''))):
            bad('%s: color must be #RRGGBB' % w)
        if a.get('category') not in cats:
            bad('%s: unknown category %s' % (w, a.get('category')))
        if a.get('paid') not in PAID:
            bad('%s: paid must be one of %s' % (w, ', '.join(PAID)))
        lang_text(a.get('desc'), w + ' desc')
        if not re.match(r'^https://[^\s/]+', str(a.get('site', ''))):
            bad('%s: site must be https' % w)
        if not isinstance(a.get('needs'), list):
            bad('%s: needs must be a list' % w)
        if not isinstance(a.get('featured'), bool):
            bad('%s: featured must be true or false' % w)
        if not isinstance(a.get('order'), int):
            bad('%s: order must be a number' % w)
        icon = a.get('icon', '')
        file = os.path.join(STORE, icon)
        if not re.match(r'^icons/[a-z0-9-]+\.png$', icon):
            bad('%s: icon must be icons/<id>.png' % w)
        elif not os.path.isfile(file):
            bad('%s: icon %s is missing' % (w, icon))
        else:
            if os.path.getsize(file) > MAX_ICON:
                bad('%s: icon is over 40 KB (%d bytes)' % (w, os.path.getsize(file)))
            if png_size(file) != (400, 400):
                bad('%s: icon must be a 400 x 400 PNG' % w)
        if online:
            if not curl_ok(url):
                bad('%s: %s did not answer 200' % (w, url))
            if not curl_ok(SITE + icon):
                bad('%s: published icon %s did not answer 200' % (w, SITE + icon))

    allowed_hosts(apps)
    example_config()

    for e in errors:
        print('catalogo: ' + e, file=sys.stderr)
    if errors:
        sys.exit(1)
    print('catalogo.json ok (%d apps%s).' % (len(apps), ', online' if online else ''))


main()
