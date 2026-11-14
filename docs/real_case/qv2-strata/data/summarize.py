"""Summarise the Commit records saved by fetch-commits.py.

Usage: python3 summarize.py [commits.json | commits.csv]
A .json input (from fetch-commits.py) also writes commits.csv beside it.

Groups Commits by how they were made (`via`): fs = file edits, exec =
`workspace exec` (builds and tests), merge = Branch merges. Records with no
`via` (Publication Layers and similar) carry no storage counters and are
counted separately.
"""
import csv, json, os, statistics, sys

src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), 'commits.csv')
NUMS = ('time', 'logical', 'new_canonical', 'new_stored', 'new_metadata')
fields = ['id', 'branch', 'parent', 'second_parent', 'time', 'via', 'logical',
          'new_canonical', 'new_stored', 'new_metadata', 'message']
if src.endswith('.csv'):
    cs = [{k: (int(v) if k in NUMS and v else (v or None)) for k, v in r.items()}
          for r in csv.DictReader(open(src))]
    out = src
else:
    cs = json.load(open(src))
    out = os.path.join(os.path.dirname(os.path.abspath(src)), 'commits.csv')
    with open(out, 'w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction='ignore')
        w.writeheader()
        for c in sorted(cs, key=lambda c: c.get('time') or 0):
            w.writerow(c)

branches = {c.get('branch') for c in cs if c.get('branch')}
print(f'{len(cs)} distinct Commits on {len(branches)} Branches with records ({out})')
print(f'{"via":<8}{"count":>7}{"med new canonical":>20}{"med new stored":>17}{"sum new stored GB":>20}')
for via in ('fs', 'exec', 'merge'):
    g = [c for c in cs if c.get('via') == via]
    print(f'{via:<8}{len(g):>7}'
          f'{statistics.median(c["new_canonical"] for c in g) / 1e3:>17.1f} KB'
          f'{statistics.median(c["new_stored"] for c in g) / 1e3:>14.1f} KB'
          f'{sum(c["new_stored"] for c in g) / 1e9:>20.3f}')
rest = [c for c in cs if c.get('via') not in ('fs', 'exec', 'merge')]
print(f'other   {len(rest):>7}  (no storage counters)')
tot = sum(c.get('logical') or 0 for c in cs)
print(f'sum of logical tree sizes over all Commits: {tot / 1e12:.1f} TB')
