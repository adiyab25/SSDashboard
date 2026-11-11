"""Compare each chunk's self-reported line coverage against the real file length.

A chunk file that parses is not proof the agent read every file to its end, so
this lists every file read short, plus files a chunk was given but never reported.
"""
import glob
import json
from pathlib import Path


def main() -> None:
    plan = json.loads(Path('graphify-out/.graphify_chunks_plan.json').read_text(encoding='utf-8'))
    imgs = {f for chunk in plan for f in chunk if f.lower().endswith(('.png', '.jpg', '.jpeg', '.gif', '.webp'))}
    covered: dict[str, int] = {}
    chunk_of: dict[str, int] = {}
    for c in sorted(glob.glob('graphify-out/.graphify_chunk_*.json')):
        n = int(Path(c).stem.split('_')[-1])
        d = json.loads(Path(c).read_text(encoding='utf-8'))
        for src, lines in (d.get('coverage') or {}).items():
            key = str(Path(src).resolve()).lower()
            covered[key] = max(covered.get(key, 0), int(lines))
            chunk_of[key] = n
    partial, unreported = [], []
    for i, chunk in enumerate(plan, 1):
        if not Path(f'graphify-out/.graphify_chunk_{i:02d}.json').exists():
            continue
        for f in chunk:
            if f in imgs:
                continue
            key = str(Path(f).resolve()).lower()
            total = sum(1 for _ in open(f, encoding='utf-8', errors='replace'))
            if key not in covered:
                unreported.append((i, f))
            elif total and covered[key] < total:
                partial.append((i, f, covered[key], total))
    Path('graphify-out/.graphify_partial.txt').write_text(
        '\n'.join(f for _, f, _, _ in partial), encoding='utf-8')
    print(f'partial: {len(partial)}  unreported: {len(unreported)}')
    for i, f, n, t in partial:
        print(f'  chunk {i}: {f} read {n} of {t}')
    for i, f in unreported[:30]:
        print(f'  chunk {i}: not reported: {f}')


if __name__ == '__main__':
    main()
