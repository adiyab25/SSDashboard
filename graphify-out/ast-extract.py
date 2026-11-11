"""Structural (AST) pass over every code file graphify detected. Free: no model."""
import json
from pathlib import Path

from graphify.extract import collect_files, extract


def main() -> None:
    detect = json.loads(Path('graphify-out/.graphify_detect.json').read_text(encoding='utf-8'))
    code_files = []
    for f in detect.get('files', {}).get('code', []):
        code_files.extend(collect_files(Path(f)) if Path(f).is_dir() else [Path(f)])
    result = extract(code_files, cache_root=Path('.'), root=Path('.'))
    Path('graphify-out/.graphify_ast.json').write_text(
        json.dumps(result, indent=2, ensure_ascii=False), encoding='utf-8')
    print(f'AST: {len(result["nodes"])} nodes, {len(result["edges"])} edges')
    sql = [n for n in result['nodes'] if str(n.get('source_file', '')).endswith('.sql')]
    print('sql nodes:', len(sql))
    print('sample node:', json.dumps(result['nodes'][5])[:400])


if __name__ == '__main__':
    main()
