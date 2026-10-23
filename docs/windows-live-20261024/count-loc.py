"""Usage: python count-loc.py REPO TREE PINNED_LAYERFS_COUNTER
Counts exact git blobs; prints production total and per-file counts.
"""
import pathlib, subprocess, sys, runpy, re, json
repo, tree, counter = sys.argv[1:]
blank_js = runpy.run_path(counter)['blank_js']
def git(*args):
    return subprocess.check_output(['git','-C',repo,*args],timeout=20).decode('utf-8')
counts={}
for name in git('ls-tree','-r','--name-only',tree,'packages').splitlines():
    p=pathlib.PurePosixPath(name)
    if 'tests' in p.parts: continue
    kind=None
    if 'src' in p.parts and p.suffix in ('.js','.ts','.tsx'): kind='js'
    if name=='packages/dsh-layerfs/index.js': kind='js'
    if p.suffix=='.yml': kind='yaml'
    if name.startswith('packages/dsh-layerfs/locale/'): kind='json'
    if name=='packages/host/src/bin/layerfs': kind='shell'
    if name=='packages/host/src/bin/layerfs.cmd': kind='cmd'
    if not kind: continue
    text=git('show',tree+':'+name)
    if kind=='js': n=sum(bool(x.strip()) for x in blank_js(text).splitlines())
    elif kind=='yaml':
        n=0; block=None
        for line in text.splitlines():
            if not line.strip(): continue
            indent=len(line)-len(line.lstrip())
            if block is not None and indent<=block: block=None
            if block is None and line.lstrip().startswith('#'): continue
            n+=1
            if re.search(r':\s*[|>][-+]?\s*$',line): block=indent
    else:
        n=sum(bool(x.strip()) and not x.lstrip().startswith('#') and not (kind=='cmd' and x.strip().lower().startswith(('rem ','::'))) for x in text.splitlines())
    counts[name]=n
print(json.dumps({'tree':git('rev-parse',tree).strip(),'total':sum(counts.values()),'files':counts},indent=2))
