"""Build a compact known-reactions index from an ORD Parquet snapshot.

Per reaction:
  * exact key      — unmapped, canonical, order-independent (sorted reactants > sorted products), hashed
  * retro template — RDChiral reaction-center SMARTS, where the source is atom-mapped
  * reaction DRFP  — differential reaction fingerprint for similarity search
  * product key    — canonical product, for a product -> reactions reverse map

Checkpointed per row group under <out>/parts, so a re-run skips finished work.
Progress prints every few seconds and mirrors to <out>/progress.json.

Artifacts (in --out):
  exact.tsv.zst          "<hash>\t<count>\t<sample ids>"
  templates.tsv.zst      "<count>\t<sample ids>\t<retro_smarts>"
  products.tsv.zst       "<product_key>\t<count>\t<sample reaction hashes>"
  reactions.faiss.zst    faiss binary HNSW over reaction DRFPs (Hamming)
  reaction-keys.txt.zst  row -> exact hash, aligned with the faiss index
  manifest.json          source revision, licence, counts, sizes, sha256
"""

import argparse, contextlib, glob, hashlib, io, json, os, re, sys, time
from collections import Counter, defaultdict

import multiprocessing as mp

from rdkit import Chem, RDLogger

RDLogger.DisableLog('rdApp.*')

SAMPLE_PER_TEMPLATE = 5
SAMPLE_PER_EXACT = 3
SAMPLE_KEYS_PER_PRODUCT = 20
REACTION_SMILES = 2
REACTION_CXSMILES = 6
ID_SMILES = 2
ID_CXSMILES = 10
ROLE_REACTANT = 1
ROLE_REAGENT = 2
ROLE_SOLVENT = 3
ROLE_CATALYST = 4
ATOM_MAP = re.compile(r'\[\w+:\d+\]')
DRFP_BITS = 1024
DRFP_BYTES = DRFP_BITS // 8

_PARTS_DIR = None
_TEMPLATE_THRESHOLD = 150  # <= this many atoms: RDChiral; above: the fast centre extractor
_FAST = None


def _strip_and_canon(smiles):
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        return None
    for atom in mol.GetAtoms():
        atom.SetAtomMapNum(0)
    return Chem.MolToSmiles(mol)


def _side_key(side):
    cans = []
    for frag in side.split('.'):
        if not frag:
            continue
        c = _strip_and_canon(frag)
        if c is None:
            return None
        if c in ('[H]', '[H+]'):
            continue
        cans.append(c)
    return '.'.join(sorted(cans)) if cans else None


def _split_cxsmiles(cx):
    parts = cx.split('>')
    if len(parts) == 2:
        return parts[0], '', parts[1]
    if len(parts) >= 3:
        return parts[0], parts[1], '>'.join(parts[2:])
    return None, None, None


def _reaction_level_smiles(rxn):
    candidates = []
    for ident in rxn.identifiers:
        value = ident.value or ''
        if '>>' not in value:
            continue
        mapped = bool(ident.is_mapped) or bool(ATOM_MAP.search(value))
        rank = 0 if ident.type == REACTION_CXSMILES else (1 if ident.type == REACTION_SMILES else 2)
        candidates.append((0 if mapped else 1, rank, value, mapped))
    if not candidates:
        return None
    candidates.sort(key=lambda c: (c[0], c[1]))
    _, _, value, mapped = candidates[0]
    r, a, p = _split_cxsmiles(value)
    if not r or not p:
        return None
    return r, a, p, mapped


def _component_smiles(component):
    for wanted in (ID_CXSMILES, ID_SMILES):
        for ident in component.identifiers:
            if ident.type == wanted and ident.value:
                return ident.value
    return None


def _from_components(rxn):
    reactants, agents, products = [], [], []
    for inp in rxn.inputs.values():
        for c in inp.components:
            smi = _component_smiles(c)
            if not smi:
                continue
            if c.reaction_role == ROLE_REACTANT:
                reactants.append(smi)
            elif c.reaction_role in (ROLE_REAGENT, ROLE_SOLVENT, ROLE_CATALYST):
                agents.append(smi)
    if rxn.outcomes:
        for c in rxn.outcomes[0].products:
            smi = _component_smiles(c)
            if smi:
                products.append(smi)
    if not reactants or not products:
        return None
    return '.'.join(reactants), '.'.join(agents), '.'.join(products), False


def _template(reactants, agents, products, rid):
    from rdchiral.template_extractor import extract_from_reaction
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            out = extract_from_reaction({'_id': rid, '_smiles': f'{reactants}>>{products}',
                                         'reactants': reactants, 'reagents': agents, 'products': products})
    except Exception:
        return None
    return (out or {}).get('reaction_smarts') or None


def _atoms(side):
    m = Chem.MolFromSmiles(side)
    return m.GetNumAtoms() if m else 0


def _template_for(reactants, agents, products, rid, force_fast=False):
    """RDChiral for small/moderate reactions, the fast centre extractor above the threshold.
    `force_fast` (used by the watchdog retry) bypasses RDChiral entirely.
    Returns (template_or_None, 'rdchiral'|'fast')."""
    if not force_fast and _atoms(reactants) + _atoms(products) <= _TEMPLATE_THRESHOLD:
        return _template(reactants, agents, products, rid), 'rdchiral'
    from template_fast import extract_template
    return extract_template(reactants, products), 'fast'


def _part_path(path, group):
    key = hashlib.sha1(f'{path}::{group}'.encode()).hexdigest()[:24]
    return os.path.join(_PARTS_DIR, f'{key}.json')


def init_worker(parts_dir, threshold):
    global _PARTS_DIR, _TEMPLATE_THRESHOLD
    _PARTS_DIR = parts_dir
    _TEMPLATE_THRESHOLD = threshold


def process_row_group(args):
    from ord_schema.datasets import load_dataset
    path, group, force_fast = args
    out = _part_path(path, group)
    if os.path.exists(out):
        return ('skip', path, group)
    started = time.time()
    exact, templates = Counter(), Counter()
    exact_samples, template_samples = defaultdict(list), defaultdict(list)
    fast_templates = rdchiral_templates = 0
    # representative canonical reaction "r>>p" and product key per exact hash, for later fingerprints
    reaction_meta = {}          # key -> [reaction_smiles, product_key]
    products = {}               # product_key -> {n, s, k}
    n = 0
    view = load_dataset(path)
    for rid, rxn in view.iter_reactions(row_group=group):
        n += 1
        parsed = _reaction_level_smiles(rxn) or _from_components(rxn)
        if not parsed:
            continue
        reactants, agents, products_s, mapped = parsed
        r_key = _side_key(reactants)
        p_key = _side_key(products_s)
        if not r_key or not p_key:
            continue
        key = hashlib.sha1(f'{r_key}>>{p_key}'.encode()).hexdigest()[:32]
        exact[key] += 1
        if len(exact_samples[key]) < SAMPLE_PER_EXACT:
            exact_samples[key].append(rid)
        if key not in reaction_meta:
            reaction_meta[key] = [f'{r_key}>>{p_key}', p_key]
        entry = products.get(p_key)
        if entry is None:
            products[p_key] = {'n': 1, 's': products_s, 'k': [key]}
        else:
            entry['n'] += 1
            if len(entry['k']) < SAMPLE_KEYS_PER_PRODUCT and key not in entry['k']:
                entry['k'].append(key)
        if mapped:
            t, who = _template_for(reactants, agents, products_s, rid, force_fast)
            if who == 'fast':
                fast_templates += 1
            else:
                rdchiral_templates += 1
            if t:
                templates[t] += 1
                if len(template_samples[t]) < SAMPLE_PER_TEMPLATE:
                    template_samples[t].append(rid)
    payload = {'reactions': n, 'exact': dict(exact), 'templates': dict(templates),
               'exactSamples': dict(exact_samples), 'templateSamples': dict(template_samples),
               'reactionMeta': reaction_meta, 'products': products,
               'fastTemplates': fast_templates, 'rdchiralTemplates': rdchiral_templates,
               'forcedFast': 1 if force_fast else 0}
    tmp = out + '.tmp'
    with open(tmp, 'w') as fh:
        json.dump(payload, fh)
    os.replace(tmp, out)
    if time.time() - started > 60:
        with open(os.path.join(os.path.dirname(out), '..', 'slow.jsonl'), 'a') as fh:
            fh.write(json.dumps({'file': os.path.basename(path), 'group': group, 'seconds': round(time.time() - started, 1)}) + '\n')
    return ('done', path, group)


def compute_reaction_fps(items):
    from drfp import DrfpEncoder
    import numpy as np
    keys, smiles = zip(*items) if items else ((), ())
    fps = DrfpEncoder.encode(list(smiles), n_folded_length=DRFP_BITS)
    packed = [np.packbits(np.asarray(fp, dtype=np.uint8)).tobytes() for fp in fps]
    return list(zip(keys, packed))


def list_tasks(root, files, limit):
    from ord_schema.datasets import load_dataset
    paths = files or sorted(glob.glob(os.path.join(root, 'data', '*', '*.parquet')))
    tasks = []
    for path in paths:
        try:
            view = load_dataset(path)
            for g in range(view.num_row_groups):
                tasks.append((path, g))
        except Exception as e:
            print(f'  skip {path}: {e}', file=sys.stderr, flush=True)
    tasks.sort(key=lambda t: -os.path.getsize(t[0]))
    return tasks[:limit] if limit else tasks


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', default='/Users/avijit/Code/NodusResearch/ord-data')
    ap.add_argument('--out', required=True)
    ap.add_argument('--files', nargs='*')
    ap.add_argument('--workers', type=int, default=max(1, (os.cpu_count() or 4) - 1))
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--interval', type=float, default=5.0)
    ap.add_argument('--no-fp', action='store_true', help='skip the DRFP/faiss step (exact+templates+products only)')
    ap.add_argument('--template-threshold', type=int, default=150,
                    help='<= this many atoms: RDChiral; above: the fast centre extractor (no cap on data)')
    ap.add_argument('--task-timeout', type=float, default=90.0,
                    help='seconds without progress before the watchdog requeues a stuck group with the fast extractor')
    ap.add_argument('--fresh', action='store_true', help='delete existing checkpoints and rebuild from scratch')
    ap.add_argument('--revision', default='93475c46949f9218e1dfb6624096025135db2add')
    args = ap.parse_args()

    parts_dir = os.path.join(args.out, 'parts')
    if args.fresh and os.path.isdir(parts_dir):
        import shutil
        shutil.rmtree(parts_dir)
    os.makedirs(parts_dir, exist_ok=True)
    progress_path = os.path.join(args.out, 'progress.json')

    tasks = list_tasks(args.root, args.files, args.limit)
    total_tasks = len(tasks)
    print(f'tasks: {total_tasks} row groups | workers={args.workers} | out={args.out}', flush=True)

    done = skipped = 0
    last = 0.0
    t0 = time.time()

    def report(final=False):
        elapsed = time.time() - t0
        rate = done / elapsed if elapsed else 0
        eta = (total_tasks - done) / rate if rate else 0
        snap = {'phase': 'scan', 'done': done, 'total': total_tasks, 'skipped': skipped,
                'elapsedMin': round(elapsed / 60, 1), 'etaMin': round(eta / 60, 1), 'finished': final}
        tmp = progress_path + '.tmp'
        with open(tmp, 'w') as fh:
            json.dump(snap, fh)
        os.replace(tmp, progress_path)
        print(f"  [{done}/{total_tasks}] {rate:.1f} grp/s elapsed {elapsed/60:.1f}m ETA {eta/60:.1f}m"
              f"{'  DONE' if final else ''}", flush=True)

    # Batched scan with a watchdog: a batch that makes no progress within `task_timeout` means
    # a worker is stuck inside RDChiral (a C++ call a signal cannot interrupt). We terminate the
    # pool, requeue the unfinished groups once forcing the fast centre extractor, and continue.
    # Nothing is dropped: worst case a group is templated by the fast extractor.
    tasks = [(p, g, False) for (p, g) in tasks]
    batch_size = max(args.workers, args.workers * 2)
    remaining = list(tasks)
    requeued = set()
    forced_fast = 0
    timed_out = 0

    def new_pool():
        return mp.Pool(args.workers, initializer=init_worker, initargs=(parts_dir, args.template_threshold))

    pool = new_pool()
    try:
        while remaining:
            batch = remaining[:batch_size]
            remaining = remaining[batch_size:]
            results = [pool.apply_async(process_row_group, (t,)) for t in batch]
            start = time.time()
            finished = set()
            while len(finished) < len(batch) and time.time() - start < args.task_timeout:
                for i, r in enumerate(results):
                    if i not in finished and r.ready():
                        try:
                            if r.get()[0] == 'skip':
                                skipped += 1
                        except Exception as e:
                            print(f'  task error {batch[i][:2]}: {e}', flush=True)
                        finished.add(i)
                        done += 1
                if len(finished) < len(batch):
                    if time.time() - last >= args.interval:
                        last = time.time()
                        report()
                    time.sleep(0.1)
            hung = [i for i in range(len(batch)) if i not in finished]
            if hung:
                pool.terminate()
                pool.join()
                pool = new_pool()
                for i in hung:
                    key = (batch[i][0], batch[i][1])
                    print(f'  WATCHDOG: group {key} stuck >{args.task_timeout}s', flush=True)
                    if key in requeued:
                        timed_out += 1
                        done += 1
                    else:
                        requeued.add(key)
                        forced_fast += 1
                        remaining.insert(0, (key[0], key[1], True))
            report(final=(done == total_tasks))
    finally:
        pool.terminate()
        pool.join()

    print(f'scan done: forced-fast retries={forced_fast} timed-out-and-skipped={timed_out}', flush=True)
    print('merging checkpoints...', flush=True)
    exact, templates = Counter(), Counter()
    exact_samples, template_samples = {}, {}
    reaction_meta, products = {}, {}
    fast_templates = rdchiral_templates = forced_fast_parts = 0
    for part in sorted(glob.glob(os.path.join(parts_dir, '*.json'))):
        with open(part) as fh:
            p = json.load(fh)
        forced_fast_parts += p.get('forcedFast', 0)
        exact.update(p['exact'])
        templates.update(p['templates'])
        fast_templates += p.get('fastTemplates', 0)
        rdchiral_templates += p.get('rdchiralTemplates', 0)
        for k, v in p['exactSamples'].items():
            if k not in exact_samples:
                exact_samples[k] = v[:SAMPLE_PER_EXACT]
        for k, v in p['templateSamples'].items():
            if k not in template_samples:
                template_samples[k] = v[:SAMPLE_PER_TEMPLATE]
        for k, v in p['reactionMeta'].items():
            reaction_meta.setdefault(k, v)
        for k, v in p['products'].items():
            e = products.get(k)
            if e is None:
                products[k] = {'n': v['n'], 's': v['s'], 'k': list(v['k'])}
            else:
                e['n'] += v['n']
                for key in v['k']:
                    if len(e['k']) < SAMPLE_KEYS_PER_PRODUCT:
                        e['k'].append(key)
    print(f'merged: {len(exact)} exact keys, {len(templates)} templates, {len(products)} products', flush=True)

    import zstandard as zstd
    cctx = zstd.ZstdCompressor(level=14)

    def write_zst(path, text):
        with open(path, 'wb') as fh:
            with cctx.stream_writer(fh) as w:
                w.write(text.encode())

    write_zst(os.path.join(args.out, 'exact.tsv.zst'),
              '\n'.join(f'{k}\t{exact[k]}\t{",".join(exact_samples.get(k, []))}' for k in sorted(exact)))
    write_zst(os.path.join(args.out, 'templates.tsv.zst'),
              '\n'.join(f'{templates[t]}\t{",".join(template_samples.get(t, []))}\t{t}' for t in sorted(templates)))
    write_zst(os.path.join(args.out, 'products.tsv.zst'),
              '\n'.join(f'{k}\t{products[k]["n"]}\t{",".join(products[k]["k"])}' for k in sorted(products)))

    files_meta = {}

    def record(name, path):
        files_meta[name] = {'bytes': os.path.getsize(path), 'sha256': digest(path)}

    def digest(path):
        h = hashlib.sha256()
        with open(path, 'rb') as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b''):
                h.update(chunk)
        return h.hexdigest()

    for name in ('exact.tsv.zst', 'templates.tsv.zst', 'products.tsv.zst'):
        record(name, os.path.join(args.out, name))

    if not args.no_fp:
        print('computing reaction fingerprints (DRFP)...', flush=True)
        items = sorted((k, reaction_meta[k][0]) for k in reaction_meta)
        chunk = max(1, len(items) // (args.workers * 4))
        batches = [items[i:i + chunk] for i in range(0, len(items), chunk)]
        t1 = time.time()
        with mp.Pool(args.workers, initializer=init_worker, initargs=(parts_dir, args.template_threshold)) as pool:
            results = []
            for i, part in enumerate(pool.imap_unordered(compute_reaction_fps, batches)):
                results.append(part)
                if i % 5 == 0 or i == len(batches) - 1:
                    with open(progress_path + '.tmp', 'w') as fh:
                        json.dump({'phase': 'fingerprints', 'batches': i + 1, 'totalBatches': len(batches)}, fh)
                    os.replace(progress_path + '.tmp', progress_path)
                    print(f'  fp batches {i+1}/{len(batches)}', flush=True)
        fps = {k: b for part in results for k, b in part}
        keys = [k for k, _ in items]
        import numpy as np
        import faiss
        matrix = np.frombuffer(b''.join(fps[k] for k in keys), dtype=np.uint8).reshape(len(keys), DRFP_BYTES)
        index = faiss.IndexBinaryHNSW(DRFP_BITS, 32)
        index.add(matrix)
        fp_path = os.path.join(args.out, 'reactions.faiss.zst')
        with open(fp_path, 'wb') as fh:
            with cctx.stream_writer(fh) as w:
                w.write(faiss.serialize_index_binary(index))
        write_zst(os.path.join(args.out, 'reaction-keys.txt.zst'), '\n'.join(keys))
        record('reactions.faiss.zst', fp_path)
        record('reaction-keys.txt.zst', os.path.join(args.out, 'reaction-keys.txt.zst'))
        print(f'faiss index: {len(keys)} vectors in {time.time()-t1:.1f}s', flush=True)

    manifest = {
        'format': 'nodus.reaction-index',
        'version': 1,
        'source': 'open-reaction-database/ord-data',
        'revision': args.revision,
        'licence': 'CC-BY-SA-4.0',
        'citation': 'Kearnes et al., JACS 2021, doi:10.1021/jacs.1c09820',
        'fingerprint': {'kind': 'drfp', 'bits': DRFP_BITS, 'space': 'hamming'},
        'templateExtractor': {'thresholdAtoms': args.template_threshold,
                              'rdchiral': rdchiral_templates, 'fast': fast_templates,
                              'watchdogForcedFast': forced_fast, 'watchdogSkipped': timed_out,
                              'forcedFastParts': forced_fast_parts},
        'exactKeys': len(exact),
        'templates': len(templates),
        'products': len(products),
        'files': files_meta,
        'builtAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
    }
    with open(os.path.join(args.out, 'manifest.json'), 'w') as fh:
        json.dump(manifest, fh, indent=2)
    print('DONE', json.dumps({k: v['bytes'] for k, v in files_meta.items()}), flush=True)


if __name__ == '__main__':
    main()
