#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""国土数値情報 世界文化遺産データ(A34、150302版)を data/places.json に統合する。

出典: 世界文化遺産(A34) https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-A34.html

対象: 構成資産の点データ A34b-150302.shp(99件)。
  A34b_003 = 遺産グループ名(例: '法隆寺地域の仏教建造物')
  A34b_007 = 構成資産名(例: '法隆寺') ※これをnameのベースに使う
  遺産グループ名と構成資産名が異なる場合は "構成資産名(遺産グループ名)" とする
  (例: "法起寺(法隆寺地域の仏教建造物)")。同じ場合はそのまま構成資産名のみ。

type='world_heritage' 固定。id は 500000番台から新規採番(既存の手動/P12/P32等の
id範囲と衝突しない領域)。discoveryScore/reward・重複除去・nearestStationIdの
考え方は tools/import_kokudo_kanko_shigen.py / import_kokudo_michinoeki_bunkazai_isan.py
と同一ロジックを踏襲する。

使い方:
    python3 tools/import_kokudo_world_heritage.py [--a34-zip PATH] [--data data --out data]
"""

import argparse
import json
import math
import random
import sys
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / 'tools'))
from data_generator import (  # noqa: E402
    compute_discovery_score, compute_reward, grid_key, haversine_km,
    generate_block_reachability, validate_places,
)

SCRATCH = Path('/tmp/claude-0/-home-user-journey-home-japan/f5e3deee-8675-5cd8-9420-638b9be032f9/scratchpad')
DEFAULT_A34_ZIP = Path('/root/.claude/uploads/f5e3deee-8675-5cd8-9420-638b9be032f9/d7791c8f-A34150302_GML.zip')
DEFAULT_A34_PREPARED = SCRATCH / 'a34150302' / 'A34-150302_GML'
DEFAULT_CACHE_DIR = REPO_ROOT / 'tools' / '.cache' / 'kokudo_world_heritage'

WORLD_HERITAGE_ID_START = 500000


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


def load_world_heritage(shp_dir):
    import shapefile
    shp = next(Path(shp_dir).rglob('A34b-150302.shp'))
    r = shapefile.Reader(str(shp).rsplit('.', 1)[0], encoding='cp932')
    records = []
    for sr in r.shapeRecords():
        rec = sr.record.as_dict()
        group_name = (rec.get('A34b_003') or '').strip()
        component_name = (rec.get('A34b_007') or '').strip()
        pref = (rec.get('A34b_005') or '').strip()
        year_month = rec.get('A34b_009')
        if not component_name or not sr.shape.points:
            continue
        lng, lat = sr.shape.points[0][0], sr.shape.points[0][1]
        if component_name == group_name or not group_name:
            name = component_name
        else:
            name = f'{component_name}({group_name})'
        records.append({
            'name': name, 'lat': lat, 'lng': lng, 'prefecture': pref, 'yearMonth': year_month,
        })
    return records


def build_places(records, rng):
    places = []
    next_id = WORLD_HERITAGE_ID_START
    for rec in records:
        score = compute_discovery_score(
            'world_heritage', has_wikipedia=False, wikipedia_length=0,
            lat=rec['lat'], lng=rec['lng'], osm_tag_count=4, has_image_tag=False, rng=rng,
        )
        places.append({
            'id': next_id,
            'name': rec['name'],
            'type': 'world_heritage',
            'lat': round(rec['lat'], 6),
            'lng': round(rec['lng'], 6),
            'discoveryScore': score,
            'reward': compute_reward(score),
            'officialUrl': '',
            'wikipediaUrl': '',
            'gridKey': grid_key(rec['lat'], rec['lng']),
            'hasWikipedia': False,
            'wikipediaLength': 0,
            'nearestStationId': None,
        })
        next_id += 1
    return places


def merge_new_places(new_places, existing_places, min_distance_km=0.3):
    existing_ids = {p['id'] for p in existing_places}
    existing_names = {p['name'] for p in existing_places}
    buckets = {}
    for p in existing_places:
        buckets.setdefault(p['gridKey'], []).append((p['lat'], p['lng']))

    def nearby_existing(lat, lng):
        gk = grid_key(lat, lng)
        gx, gy = (float(v) for v in gk.split('_'))
        for dx in (-0.1, 0, 0.1):
            for dy in (-0.1, 0, 0.1):
                key = f'{round(gx + dx, 1)}_{round(gy + dy, 1)}'
                for coord in buckets.get(key, []):
                    yield coord

    merged = list(existing_places)
    added, skipped = 0, 0
    for p in new_places:
        is_duplicate = (
            p['id'] in existing_ids
            or p['name'] in existing_names
            or any(haversine_km(p['lat'], p['lng'], lat, lng) < min_distance_km
                   for lat, lng in nearby_existing(p['lat'], p['lng']))
        )
        if is_duplicate:
            skipped += 1
            continue
        merged.append(p)
        existing_ids.add(p['id'])
        existing_names.add(p['name'])
        buckets.setdefault(p['gridKey'], []).append((p['lat'], p['lng']))
        added += 1
    return merged, added, skipped


def assign_nearest_stations(places, stations):
    station_buckets = {}
    for s in stations:
        station_buckets.setdefault(grid_key(s['lat'], s['lng']), []).append(s)

    unassigned = 0
    for p in places:
        if p.get('nearestStationId') is not None:
            continue
        gx, gy = (float(v) for v in p['gridKey'].split('_'))
        best_id, best_dist = None, math.inf
        radius = 0.1
        while best_id is None and radius <= 5.0:
            candidates = []
            steps = int(round(radius / 0.1))
            for dx in range(-steps, steps + 1):
                for dy in range(-steps, steps + 1):
                    key = f'{round(gx + dx * 0.1, 1)}_{round(gy + dy * 0.1, 1)}'
                    candidates.extend(station_buckets.get(key, []))
            for s in candidates:
                d = haversine_km(p['lat'], p['lng'], s['lat'], s['lng'])
                if d < best_dist:
                    best_dist, best_id = d, s['id']
            radius *= 2
        if best_id is None:
            for s in stations:
                d = haversine_km(p['lat'], p['lng'], s['lat'], s['lng'])
                if d < best_dist:
                    best_dist, best_id = d, s['id']
        if best_id is None:
            unassigned += 1
        p['nearestStationId'] = best_id
    return unassigned


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--a34-zip', type=Path, default=DEFAULT_A34_ZIP)
    parser.add_argument('--a34-prepared', type=Path, default=DEFAULT_A34_PREPARED)
    parser.add_argument('--cache-dir', type=Path, default=DEFAULT_CACHE_DIR)
    parser.add_argument('--data', default='data')
    parser.add_argument('--out', default='data')
    parser.add_argument('--seed', type=int, default=42)
    args = parser.parse_args()

    data_dir = Path(args.data)
    out_dir = Path(args.out)

    existing_places = json.loads((data_dir / 'places.json').read_text(encoding='utf-8'))['places']
    stations = json.loads((data_dir / 'stations.json').read_text(encoding='utf-8'))['nodes']
    print(f'既存places: {len(existing_places)}件 / stations: {len(stations)}件')

    rng = random.Random(args.seed)

    a34_dir = find_dir(args.a34_prepared, args.a34_zip, args.cache_dir, 'a34')
    records = load_world_heritage(a34_dir)
    print(f'[A34 世界文化遺産] 読み込み: {len(records)}件')
    new_places = build_places(records, rng)

    merged, added, skipped = merge_new_places(new_places, existing_places)
    print(f'マージ結果: 新規追加 {added}件 / 重複スキップ {skipped}件 / 総計 {len(merged)}件')

    unassigned = assign_nearest_stations(merged, stations)
    print(f'nearestStationId未割当: {unassigned}件')

    errors = validate_places(merged)
    if errors:
        print('検証エラーのため出力を中止しました:', file=sys.stderr)
        for e in errors[:20]:
            print(f'  - {e}', file=sys.stderr)
        raise SystemExit(1)

    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / 'places.json').write_text(
        json.dumps({'places': merged}, ensure_ascii=False, indent=2), encoding='utf-8')

    all_latlngs = [(p['lat'], p['lng']) for p in merged] + [(s['lat'], s['lng']) for s in stations]
    block_reach = generate_block_reachability(all_latlngs)
    (out_dir / 'blockReachability.json').write_text(
        json.dumps(block_reach, ensure_ascii=False, indent=2), encoding='utf-8')

    print(f'書き出し完了: {out_dir}/places.json (合計{len(merged)}件), '
          f'{out_dir}/blockReachability.json を再生成しました。')


if __name__ == '__main__':
    main()
