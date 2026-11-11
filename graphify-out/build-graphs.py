"""Build the three SSDashboard knowledge graphs from one shared extraction.

Variants (see graphify-out/README.md for when to use which):
  product  graphify-out/graph.json       code + docs, without the vendored .claude folder
  code     graphify-out/code/graph.json  every code file, structure only (no docs)
  all      graphify-out/all/graph.json   every file, including .claude skills and agents

Usage:
  python graphify-out/build-graphs.py build   cluster each variant, write graph.json + placeholder report
  python graphify-out/build-graphs.py label   apply graphify-out/<variant>/labels.json, rewrite report + graph.html
"""
import glob
import json
import os
import sys
from collections import Counter
from pathlib import Path

from graphify.analyze import god_nodes, suggest_questions, surprising_connections
from graphify.build import build_from_json
from graphify.cluster import cluster, score_all
from graphify.export import to_html, to_json
from graphify.report import generate

ROOT = Path('.').resolve()
OUT = Path('graphify-out')
VARIANTS = {'product': OUT, 'code': OUT / 'code', 'all': OUT / 'all'}


def rel(path: str) -> str:
    """Repo-relative posix path for an absolute or relative source_file."""
    if not path:
        return ''
    p = Path(path)
    if p.is_absolute():
        try:
            return p.resolve().relative_to(ROOT).as_posix()
        except ValueError:
            return p.as_posix()
    return p.as_posix()


def in_scope(variant: str, source_file: str, origin: str) -> bool:
    """Whether a node or edge from this file belongs in the variant."""
    r = rel(source_file)
    vendored = r.startswith('.claude/')
    if variant == 'all':
        return True
    if variant == 'code':
        return origin == 'ast'
    return not vendored  # product


def load_semantic() -> dict:
    """Merge every chunk; a later chunk that re-read a file replaces that file's earlier output."""
    chunks = []
    for c in sorted(glob.glob(str(OUT / '.graphify_chunk_*.json'))):
        chunks.append(json.loads(Path(c).read_text(encoding='utf-8')))
    owner: dict[str, int] = {}  # file -> index of the last chunk that read it
    for i, d in enumerate(chunks):
        for src in (d.get('coverage') or {}):
            owner[rel(src)] = i

    def current(i: int, item: dict) -> bool:
        return owner.get(rel(item.get('source_file', '') or ''), i) == i

    nodes, edges, hyper, seen = [], [], [], set()
    for i, d in reversed(list(enumerate(chunks))):  # newest first, so re-reads win on id
        d = {'nodes': [n for n in d.get('nodes', []) if current(i, n)],
             'edges': [e for e in d.get('edges', []) if current(i, e)],
             'hyperedges': [h for h in d.get('hyperedges', []) if current(i, h)]}
        for n in d.get('nodes', []):
            if n['id'] not in seen:
                seen.add(n['id'])
                n.setdefault('_origin', 'semantic')
                nodes.append(n)
        for e in d.get('edges', []):
            e.setdefault('_origin', 'semantic')
            edges.append(e)
        hyper += d.get('hyperedges', [])
    return {'nodes': nodes, 'edges': edges, 'hyperedges': hyper}


def extraction_for(variant: str, ast: dict, sem: dict) -> dict:
    nodes, ids = [], set()
    for n in ast['nodes'] + sem['nodes']:
        origin = n.get('_origin', 'semantic')
        if n['id'] not in ids and in_scope(variant, n.get('source_file', ''), origin):
            ids.add(n['id'])
            nodes.append(n)
    edges = [e for e in ast['edges'] + sem['edges']
             if e['source'] in ids and e['target'] in ids
             and in_scope(variant, e.get('source_file', ''), e.get('_origin', 'semantic'))]
    hyper = [h for h in sem['hyperedges']
             if variant != 'code' and all(x in ids for x in h.get('nodes', []))]
    return {'nodes': nodes, 'edges': edges, 'hyperedges': hyper, 'input_tokens': 0, 'output_tokens': 0}


def detection_for(variant: str, detect: dict) -> dict:
    files = {}
    for cat, fl in detect['files'].items():
        keep = []
        for f in fl:
            r = rel(f)
            if variant == 'code' and cat != 'code':
                continue
            if variant == 'product' and r.startswith('.claude/'):
                continue
            keep.append(f)
        files[cat] = keep
    words = 0
    for fl in files.values():
        for f in fl:
            try:
                words += len(Path(f).read_text(encoding='utf-8', errors='replace').split())
            except OSError:
                pass
    return {**detect, 'files': files, 'total_files': sum(len(v) for v in files.values()), 'total_words': words}


def auto_labels(G, communities: dict) -> dict:
    """Name each community after its dominant folder and its most connected node.

    Hundreds of communities make hand naming impractical; folder plus hub is
    deterministic and tells a reader where to look.
    """
    short = {'apps/api/src/': 'api/', 'apps/web/src/': 'web/', 'packages/': 'pkg/', '.claude/skills/': 'skill/'}
    labels = {}
    for cid, members in communities.items():
        dirs = Counter()
        for m in members:
            r = rel(G.nodes[m].get('source_file', '') or '')
            parts = r.split('/')[:-1]
            dirs['/'.join(parts[:4]) or '(root)'] += 1
        top = dirs.most_common(1)[0][0] if dirs else 'misc'
        for long, s in short.items():
            if top.startswith(long):
                top = s + top[len(long):]
                break
        hub = max(members, key=G.degree)
        hub_label = str(G.nodes[hub].get('label', hub))[:40]
        labels[cid] = f'{top} · {hub_label}'
    return labels


def build() -> None:
    ast = json.loads((OUT / '.graphify_ast.json').read_text(encoding='utf-8'))
    sem = load_semantic()
    detect = json.loads((OUT / '.graphify_detect.json').read_text(encoding='utf-8'))
    for variant, out in VARIANTS.items():
        out.mkdir(parents=True, exist_ok=True)
        ext = extraction_for(variant, ast, sem)
        det = detection_for(variant, detect)
        G = build_from_json(ext, root='.', directed=False)
        communities = cluster(G)
        cohesion = score_all(G, communities)
        gods = god_nodes(G)
        surprises = surprising_connections(G, communities)
        labels = auto_labels(G, communities)
        questions = suggest_questions(G, communities, labels)
        if not to_json(G, communities, str(out / 'graph.json'), force=True, community_labels=labels):
            raise SystemExit(f'{variant}: graph.json refused')
        # Per-variant names: the product variant lives in graphify-out/ itself,
        # beside the shared .graphify_detect.json it must never overwrite.
        (out / '.variant_extract.json').write_text(json.dumps(ext, ensure_ascii=False), encoding='utf-8')
        (out / '.variant_detect.json').write_text(json.dumps(det, ensure_ascii=False), encoding='utf-8')
        (out / '.variant_analysis.json').write_text(json.dumps({
            'communities': {str(k): v for k, v in communities.items()},
            'cohesion': {str(k): v for k, v in cohesion.items()},
            'gods': gods, 'surprises': surprises, 'questions': questions,
        }, indent=1, ensure_ascii=False), encoding='utf-8')
        (out / 'labels.json').write_text(json.dumps({str(k): v for k, v in labels.items()}, indent=1, ensure_ascii=False), encoding='utf-8')
        sizes = sorted((len(v) for v in communities.values()), reverse=True)
        print(f'{variant}: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges, '
              f'{len(communities)} communities (largest {sizes[:8]}), {det["total_files"]} files')


def label() -> None:
    for variant, out in VARIANTS.items():
        ext = json.loads((out / '.variant_extract.json').read_text(encoding='utf-8'))
        det = json.loads((out / '.variant_detect.json').read_text(encoding='utf-8'))
        analysis = json.loads((out / '.variant_analysis.json').read_text(encoding='utf-8'))
        labels = {int(k): v for k, v in json.loads((out / 'labels.json').read_text(encoding='utf-8')).items()}
        G = build_from_json(ext, root='.', directed=False)
        communities = {int(k): v for k, v in analysis['communities'].items()}
        cohesion = {int(k): v for k, v in analysis['cohesion'].items()}
        questions = suggest_questions(G, communities, labels)
        tokens = {'input': 0, 'output': 0}
        report = generate(G, communities, cohesion, labels, analysis['gods'], analysis['surprises'],
                          det, tokens, '.', suggested_questions=questions)
        (out / 'GRAPH_REPORT.md').write_text(report, encoding='utf-8')
        to_json(G, communities, str(out / 'graph.json'), force=True, community_labels=labels)
        # Over 5,000 nodes a browser cannot draw every node, so node_limit makes
        # graphify draw one node per community with weighted links between them.
        to_html(G, communities, str(out / 'graph.html'), community_labels=labels, node_limit=5000)
        print(f'{variant}: report, graph.json, graph.html written to {out}')


if __name__ == '__main__':
    {'build': build, 'label': label}[sys.argv[1]]()
