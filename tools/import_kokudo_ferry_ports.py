#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""国土数値情報 定期旅客航路データ(N09-12)と港湾データ(C02-06)を
data/stations.json に統合する。

出典:
  - 定期旅客航路(N09、2012年度版) https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-N09.html
  - 港湾(C02、2006年度版) https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-C02.html

このスクリプトが行うこと:
  1. N09-12_p(港点、850件)を type='port' の新規ノードとして stations.json に追加する。
  2. N09-12_l(航路線、856件)から、対応する港ノード同士の mode='ferry' 接続を
     双方向で追加する(運賃は N09_027 を45%スケールしたもの。欠損時は距離ベースの
     フォールバック式)。
  3. C02(港湾、1,070件)のうち、N09に存在しない(名称不一致かつ300m以上離れた)
     港湾のみ、type='port' ノードとして追加する(接続情報が無いため、最寄りの
     既存ノードへ低コストのrail接続を1本張って孤立を防ぐに留める)。
  4. 全ノード(既存駅+新規港)が単一連結成分になるよう、孤立した港ノードには
     最寄りノードへの橋渡し接続を追加する。
  5. blockReachability.json を再生成する。

設計判断の詳細は docs/HANDOFF.md を参照。

使い方:
    python3 tools/import_kokudo_ferry_ports.py \
        [--n09-zip PATH] [--c02-zip PATH] \
        [--data data --out data]
"""

import argparse
import json
import math
import sys
import zipfile
from collections import defaultdict
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / 'tools'))
from data_generator import (  # noqa: E402
    compute_discovery_score, compute_reward, grid_key, haversine_km,
    generate_block_reachability, UnionFind,
)

SCRATCH = Path('/tmp/claude-0/-home-user-journey-home-japan/f5e3deee-8675-5cd8-9420-638b9be032f9/scratchpad')
DEFAULT_N09_ZIP = Path('/root/.claude/uploads/f5e3deee-8675-5cd8-9420-638b9be032f9/58533357-N0912_GML.zip')
DEFAULT_C02_ZIP = Path('/root/.claude/uploads/f5e3deee-8675-5cd8-9420-638b9be032f9/a51b4e68-C0206_GML.zip')
DEFAULT_N09_PREPARED = SCRATCH / 'n0912'
DEFAULT_C02_PREPARED = SCRATCH / 'c0206'
DEFAULT_CACHE_DIR = REPO_ROOT / 'tools' / '.cache' / 'kokudo_ferry_ports'

PORT_ID_START = 900000
RAIL_COST_PER_KM = 12       # 既存の鉄道コスト式(dist*12)を踏襲
FERRY_FALLBACK_PER_KM = 15  # フェリーは鉄道よりやや高め、という指示に基づく
FERRY_FARE_SCALE = 0.45     # Phase3で確定した「鉄道45%」スケールをフェリーにも適用


def ensure_extracted(zip_path, cache_dir, tag):
    extracted_dir = cache_dir / tag
    marker = extracted_dir / '.done'
    if marker.exists():
        return extracted_dir
    if not zip_path or not zip_path.exists():
        raise SystemExit(f'[{tag}] 展開済みキャッシュが無く、ZIPも見つかりません: {zip_path}')
    extracted_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(extracted_dir)
    marker.write_text('ok', encoding='utf-8')
    return extracted_dir


def find_dir(prepared_dir, zip_path, cache_dir, tag):
    if prepared_dir and Path(prepared_dir).exists():
        return Path(prepared_dir)
    return ensure_extracted(zip_path, cache_dir, tag)


# ---------------------------------------------------------------------------
# N09: 定期旅客航路(港点+航路線)
# ---------------------------------------------------------------------------

def load_n09_ports(shp_dir):
    import shapefile
    shp = next(Path(shp_dir).rglob('N09-12_p.shp'))
    r = shapefile.Reader(str(shp).rsplit('.', 1)[0], encoding='cp932')
    ports = {}
    for sr in r.shapeRecords():
        rec = sr.record.as_dict()
        code = (rec.get('N09_001') or '').strip()
        if not code or not sr.shape.points:
            continue
        lng, lat = sr.shape.points[0][0], sr.shape.points[0][1]
        name = (rec.get('N09_004') or '').strip()
        district = (rec.get('N09_003') or '').strip()
        pref = (rec.get('N09_002') or '').strip()
        full_name = f'{district}{name}港' if district and district not in name else (
            name if name.endswith(('港', 'ターミナル', '桟橋')) else f'{name}港'
        )
        ports[code] = {
            'code': code, 'name': full_name, 'prefecture': pref,
            'lat': lat, 'lng': lng,
        }
    return ports


def load_n09_routes(shp_dir):
    import shapefile
    shp = next(Path(shp_dir).rglob('N09-12_l.shp'))
    r = shapefile.Reader(str(shp).rsplit('.', 1)[0], encoding='cp932')
    routes = []
    for sr in r.shapeRecords():
        rec = sr.record.as_dict()
        from_code = (rec.get('N09_011') or '').strip()
        to_code = (rec.get('N09_014') or '').strip()
        if not from_code or not to_code or from_code == to_code:
            continue
        dist_km = rec.get('N09_024')
        dist_km = dist_km if isinstance(dist_km, (int, float)) and dist_km > 0 else None
        fare = rec.get('N09_027')
        fare = fare if isinstance(fare, (int, float)) and fare > 0 else None
        routes.append({
            'fromCode': from_code, 'toCode': to_code,
            'distKm': dist_km, 'fare': fare,
            'name': (rec.get('N09_006') or '').strip(),
        })
    return routes


def build_port_nodes(ports, rng):
    nodes = []
    code_to_id = {}
    next_id = PORT_ID_START
    for code, p in sorted(ports.items()):
        score = compute_discovery_score(
            'station_local', has_wikipedia=True, wikipedia_length=3000,
            lat=p['lat'], lng=p['lng'], osm_tag_count=4, has_image_tag=False, rng=rng,
        )
        node = {
            'id': next_id,
            'name': p['name'],
            'type': 'port',
            'lat': round(p['lat'], 6),
            'lng': round(p['lng'], 6),
            'prefecture': p['prefecture'],
            'lines': [],
            'discoveryScore': score,
            'reward': compute_reward(score),
            'gridKey': grid_key(p['lat'], p['lng']),
            'connections': [],
        }
        nodes.append(node)
        code_to_id[code] = next_id
        next_id += 1
    return nodes, code_to_id


FERRY_MIN_COST = 300  # 鉄道の最低運賃(200円)よりやや高めに設定(タスク仕様の指示に基づく)


def ferry_cost(route):
    if route['fare'] is not None:
        return max(FERRY_MIN_COST, round(route['fare'] * FERRY_FARE_SCALE, -2))
    dist = route['distKm']
    if dist is None:
        return None  # 呼び出し側でhaversineフォールバックする
    return max(FERRY_MIN_COST, round(dist * FERRY_FALLBACK_PER_KM, -2))


def build_ferry_edges(routes, code_to_id, ports_by_code):
    edges = []  # (fromId, toId, cost)
    seen_pairs = {}
    skipped_unknown = 0
    for route in routes:
        from_id = code_to_id.get(route['fromCode'])
        to_id = code_to_id.get(route['toCode'])
        if from_id is None or to_id is None:
            skipped_unknown += 1
            continue
        cost = ferry_cost(route)
        if cost is None:
            p1, p2 = ports_by_code[route['fromCode']], ports_by_code[route['toCode']]
            dist = haversine_km(p1['lat'], p1['lng'], p2['lat'], p2['lng'])
            cost = max(FERRY_MIN_COST, round(dist * FERRY_FALLBACK_PER_KM, -2))
        key = frozenset({from_id, to_id})
        # 同区間で複数航路がある場合は最安値を採用(重複辺を作らない)
        if key not in seen_pairs or cost < seen_pairs[key]:
            seen_pairs[key] = cost
    for key, cost in seen_pairs.items():
        a, b = tuple(key)
        edges.append((a, b, cost))
    return edges, skipped_unknown


# ---------------------------------------------------------------------------
# C02: 港湾(N09の補完)
# ---------------------------------------------------------------------------

def load_c02_ports(shp_dir):
    import shapefile
    shp = next(Path(shp_dir).rglob('C02-06-g_PortAndHarbor.shp'))
    r = shapefile.Reader(str(shp).rsplit('.', 1)[0], encoding='cp932')
    records = []
    for sr in r.shapeRecords():
        rec = sr.record.as_dict()
        name = (rec.get('C02_005') or '').strip()
        pref_code = (rec.get('C02_003') or '').strip()
        if not name or not sr.shape.points:
            continue
        lng, lat = sr.shape.points[0][0], sr.shape.points[0][1]
        records.append({'name': name, 'lat': lat, 'lng': lng})
    return records


def find_nearest(lat, lng, nodes, max_km=math.inf):
    best_id, best_dist = None, math.inf
    for n in nodes:
        d = haversine_km(lat, lng, n['lat'], n['lng'])
        if d < best_dist:
            best_dist, best_id = d, n['id']
    if best_dist > max_km:
        return None, best_dist
    return best_id, best_dist


def build_c02_supplement_nodes(c02_records, existing_port_nodes, rng, next_id_start):
    """N09に無い港湾のみ追加。同名 or 300m未満近接は重複とみなす。"""
    existing_names = {n['name'] for n in existing_port_nodes}
    existing_names |= {n['name'].rstrip('港') for n in existing_port_nodes}
    buckets = defaultdict(list)
    for n in existing_port_nodes:
        buckets[n['gridKey']].append((n['lat'], n['lng']))

    def is_near_existing(lat, lng):
        gk = grid_key(lat, lng)
        gx, gy = (float(v) for v in gk.split('_'))
        for dx in (-0.1, 0, 0.1):
            for dy in (-0.1, 0, 0.1):
                key = f'{round(gx + dx, 1)}_{round(gy + dy, 1)}'
                for (elat, elng) in buckets.get(key, []):
                    if haversine_km(lat, lng, elat, elng) < 0.3:
                        return True
        return False

    added_nodes = []
    next_id = next_id_start
    skipped = 0
    for rec in c02_records:
        bare_name = rec['name']
        if bare_name in existing_names or f'{bare_name}港' in existing_names:
            skipped += 1
            continue
        if is_near_existing(rec['lat'], rec['lng']):
            skipped += 1
            continue
        score = compute_discovery_score(
            'station_local', has_wikipedia=True, wikipedia_length=3000,
            lat=rec['lat'], lng=rec['lng'], osm_tag_count=4, has_image_tag=False, rng=rng,
        )
        node = {
            'id': next_id,
            'name': f'{bare_name}港' if not bare_name.endswith('港') else bare_name,
            'type': 'port',
            'lat': round(rec['lat'], 6),
            'lng': round(rec['lng'], 6),
            'prefecture': '',
            'lines': [],
            'discoveryScore': score,
            'reward': compute_reward(score),
            'gridKey': grid_key(rec['lat'], rec['lng']),
            'connections': [],
        }
        added_nodes.append(node)
        existing_names.add(node['name'])
        buckets[node['gridKey']].append((node['lat'], node['lng']))
        next_id += 1
    return added_nodes, skipped


# ---------------------------------------------------------------------------
# 連結性: 孤立ノードの橋渡し
# ---------------------------------------------------------------------------

def bridge_disconnected(stations_by_id, extra_edges):
    """UnionFindで連結成分を確認し、孤立成分があれば最近傍ノードへrail接続を追加する。
    既存stations.jsonの接続 + 今回追加したextra_edges(id,id,mode,cost)を対象に判定。"""
    ids = list(stations_by_id.keys())
    uf = UnionFind(ids)
    for sid, s in stations_by_id.items():
        for conn in s.get('connections', []):
            if conn['toId'] in stations_by_id:
                uf.union(sid, conn['toId'])
    for (a, b, *_rest) in extra_edges:
        uf.union(a, b)

    bridges = []
    while True:
        components = uf.components()
        if len(components) <= 1:
            break
        comp_a, comp_b = components[0], components[1]
        best = None
        for a in comp_a:
            na = stations_by_id[a]
            for b in comp_b:
                nb = stations_by_id[b]
                d = haversine_km(na['lat'], na['lng'], nb['lat'], nb['lng'])
                if best is None or d < best[0]:
                    best = (d, a, b)
        dist_km, a, b = best
        cost = max(200, round(dist_km * RAIL_COST_PER_KM, -2))
        bridges.append((a, b, 'rail', cost))
        uf.union(a, b)
    return bridges


def add_bidirectional(stations_by_id, a, b, mode, cost, requires_transport=None):
    stations_by_id[a]['connections'].append({
        'toId': b, 'mode': mode, 'requiresTransport': requires_transport or [], 'cost': cost,
    })
    stations_by_id[b]['connections'].append({
        'toId': a, 'mode': mode, 'requiresTransport': requires_transport or [], 'cost': cost,
    })


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--n09-zip', type=Path, default=DEFAULT_N09_ZIP)
    parser.add_argument('--c02-zip', type=Path, default=DEFAULT_C02_ZIP)
    parser.add_argument('--n09-prepared', type=Path, default=DEFAULT_N09_PREPARED)
    parser.add_argument('--c02-prepared', type=Path, default=DEFAULT_C02_PREPARED)
    parser.add_argument('--cache-dir', type=Path, default=DEFAULT_CACHE_DIR)
    parser.add_argument('--data', default='data')
    parser.add_argument('--out', default='data')
    parser.add_argument('--seed', type=int, default=42)
    parser.add_argument('--skip-c02', action='store_true', help='C02港湾の補完追加をスキップ')
    args = parser.parse_args()

    import random
    rng = random.Random(args.seed)

    data_dir = Path(args.data)
    out_dir = Path(args.out)

    stations = json.loads((data_dir / 'stations.json').read_text(encoding='utf-8'))['nodes']
    print(f'既存stations: {len(stations)}件')
    max_existing_id = max(s['id'] for s in stations)
    print(f'既存最大id: {max_existing_id}')

    # --- N09 港点 ---
    n09_dir = find_dir(args.n09_prepared, args.n09_zip, args.cache_dir, 'n09')
    ports_by_code = load_n09_ports(n09_dir)
    print(f'[N09 港点] 読み込み: {len(ports_by_code)}件')
    port_nodes, code_to_id = build_port_nodes(ports_by_code, rng)
    print(f'  港ノード生成: {len(port_nodes)}件 (id {PORT_ID_START}~{PORT_ID_START + len(port_nodes) - 1})')

    # --- N09 航路線 ---
    routes = load_n09_routes(n09_dir)
    print(f'[N09 航路線] 読み込み: {len(routes)}件')
    ferry_edges, skipped_unknown = build_ferry_edges(routes, code_to_id, ports_by_code)
    print(f'  フェリー接続(重複区間を最安値に統合後): {len(ferry_edges)}件 / 港コード不明でスキップ: {skipped_unknown}件')

    stations_by_id = {s['id']: s for s in stations}
    for node in port_nodes:
        stations_by_id[node['id']] = node

    for a, b, cost in ferry_edges:
        add_bidirectional(stations_by_id, a, b, 'ferry', cost, requires_transport=['ferry'])

    # --- C02 港湾(N09の補完のみ) ---
    c02_added_count = 0
    c02_skipped = 0
    if not args.skip_c02:
        c02_dir = find_dir(args.c02_prepared, args.c02_zip, args.cache_dir, 'c02')
        c02_records = load_c02_ports(c02_dir)
        print(f'[C02 港湾] 読み込み: {len(c02_records)}件')
        next_c02_id = max(n['id'] for n in port_nodes) + 1
        c02_nodes, c02_skipped = build_c02_supplement_nodes(c02_records, port_nodes, rng, next_c02_id)
        print(f'  N09に無い港湾として新規追加: {len(c02_nodes)}件 / 重複スキップ: {c02_skipped}件')
        for node in c02_nodes:
            stations_by_id[node['id']] = node
        # C02単独ノードは接続情報が無いため、最寄りの既存ノード(駅 or 港)へ
        # 低コストのrail接続を1本張って孤立を防ぐ(タスク仕様: 詳細な理由をHANDOFFへ)。
        other_nodes = [n for n in stations_by_id.values() if n['id'] not in {c['id'] for c in c02_nodes}]
        for node in c02_nodes:
            nearest_id, dist = find_nearest(node['lat'], node['lng'], other_nodes)
            if nearest_id is not None:
                cost = max(200, round(dist * RAIL_COST_PER_KM, -2))
                add_bidirectional(stations_by_id, node['id'], nearest_id, 'rail', cost)
        c02_added_count = len(c02_nodes)

    # --- 孤立ノードの橋渡し(念のための最終防御) ---
    bridges = bridge_disconnected(stations_by_id, [])
    for a, b, mode, cost in bridges:
        add_bidirectional(stations_by_id, a, b, mode, cost)
    if bridges:
        print(f'孤立成分の橋渡し接続を{len(bridges)}本追加しました')

    merged_stations = list(stations_by_id.values())
    merged_stations.sort(key=lambda s: s['id'])

    # --- 単一連結成分の最終検証(BFS) ---
    adj = defaultdict(list)
    for s in merged_stations:
        for conn in s['connections']:
            adj[s['id']].append(conn['toId'])
    start = merged_stations[0]['id']
    visited = {start}
    frontier = [start]
    while frontier:
        cur = frontier.pop()
        for nxt in adj[cur]:
            if nxt not in visited:
                visited.add(nxt)
                frontier.append(nxt)
    unreachable = len(merged_stations) - len(visited)
    print(f'連結性検証(BFS): 全{len(merged_stations)}ノード中 到達{len(visited)}件 / 未到達{unreachable}件')
    if unreachable:
        print('警告: 依然として孤立ノードが存在します', file=sys.stderr)

    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / 'stations.json').write_text(
        json.dumps({'nodes': merged_stations}, ensure_ascii=False, indent=2), encoding='utf-8')

    from collections import Counter
    type_counts = Counter(s['type'] for s in merged_stations)
    print('type別内訳(統合後の全stations):')
    for k, v in sorted(type_counts.items(), key=lambda x: -x[1]):
        print(f'  {k}: {v}件')

    total_edges = sum(len(s['connections']) for s in merged_stations) // 2
    print(f'書き出し完了: {out_dir}/stations.json (合計{len(merged_stations)}ノード, '
          f'双方向接続{total_edges}本)')
    print(f'港ノード追加: N09由来{len(port_nodes)}件 + C02由来{c02_added_count}件 = '
          f'{len(port_nodes) + c02_added_count}件')

    # places.json/blockReachabilityはmain側で別途再生成する


if __name__ == '__main__':
    main()
