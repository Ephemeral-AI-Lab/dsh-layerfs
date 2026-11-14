"""Save every Commit record of a LayerFS project, deduplicated by id.

Usage: LAYERFS_CLI=<pinned layerfs> LAYERFS_BUNDLE=<pinned linux bundle> \
       python3 fetch-commits.py <store/project> [out.json]

Run with the same pinned runtime the project was built with (here
2.0.0-8134bc02b50f); a bare `layerfs` from another build is refused.
Then run summarize.py on the output.
"""
import json, os, subprocess, sys

cli = os.environ['LAYERFS_CLI']
project = sys.argv[1]
out = sys.argv[2] if len(sys.argv) > 2 else 'commits.json'


def call(*args):
    r = subprocess.run([cli, *args], capture_output=True, text=True, timeout=120)
    return json.loads(r.stdout)


def pages(*args):
    items, pos = [], 0
    while True:
        d = call(*args, '--page-size', '1000', '--page-pos', str(pos))
        items += d.get('items', [])
        nxt = d.get('next') or d.get('next_page_pos') or d.get('page', {}).get('next')
        if not nxt or not d.get('items'):
            return items
        pos = nxt if isinstance(nxt, int) else pos + len(d['items'])


branches = [b['name'] for b in pages('branch', 'list', project)]
seen = {}
for b in branches:
    for c in pages('commit', 'list', project, b):
        seen.setdefault(c['id'], c)
json.dump(list(seen.values()), open(out, 'w'))
print(f'{len(branches)} Branches, {len(seen)} distinct Commits -> {out}')
