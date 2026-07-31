#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""国土数値情報の3データセット(道の駅P35・都道府県指定文化財P32・世界自然遺産A28)を
data/places.json に統合する。

出典:
  - 道の駅(P35, 2018年度版) https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-P35.html
  - 都道府県指定文化財(P32, 2014年度版) https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-P32.html
  - 世界自然遺産(A28, 2010年度版) https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-A28.html

使い方:
    python3 tools/import_kokudo_michinoeki_bunkazai_isan.py \
        [--p35-zip /path/P3518_GML.zip] [--p32-zip /path/P3214_00_GML.zip] \
        [--a28-zip /path/A2810_GML.zip] \
        [--cache-dir tools/.cache/kokudo_michinoeki_bunkazai_isan] \
        [--data data --out data]

初回実行時、各ZIPを --cache-dir 以下に展開してキャッシュする(以後はZIP省略可)。

設計判断(詳細はdocs/HANDOFF.md参照):
- P35(道の駅): type='michinoeki'固定。名称は既存P12由来のmichinoekiエントリと
  表記を揃えるため「道の駅」を前置する(例: 「三笠」→「道の駅三笠」)。
- P32(都道府県指定文化財): 種別コード(P32_004/P32_005)の対応表が同梱データに
  無いため、名称文字列からのキーワード推測でtypeを決定する
  (神社/寺・院・堂/城・館/像・仏を優先判定、それ以外はfamous_facilityデフォルト)。
- A28(世界自然遺産): フィールドがA28_001(コード'01'/'02'/'03')のみで名称が
  無いため、2015年度版データ(小笠原諸島[2011年登録]を含まない3件)を前提に
  01=知床・02=白神山地・03=屋久島と決め打ちする。ポリゴンの全頂点の単純平均を
  代表座標として使用する。
- discoveryScore/reward: tools/data_generator.py のcompute_discovery_score/
  compute_reward をそのまま踏襲(has_wikipedia=False固定、rng=random.Random(42))。
- id: 道の駅=200000番台の続き衝突を避けるため道の駅=210000、文化財=300000、
  自然遺産=400000から採番(P12由来の200000番台とは別ブロック)。
- 重複除去: 既存placesと同名、または300m未満の座標近接は除外
  (tools/import_kokudo_kanko_shigen.py のmerge_new_placesと同ロジック)。
"""

import argparse
import json
import math
import random
import sys
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_P35_ZIP = Path('/root/.claude/uploads/f5e3deee-8675-5cd8-9420-638b9be032f9/427582db-P3518_GML.zip')
DEFAULT_P32_ZIP = Path('/root/.claude/uploads/f5e3deee-8675-5cd8-9420-638b9be032f9/047c45b4-P3214_00_GML.zip')
DEFAULT_A28_ZIP = Path('/root/.claude/uploads/f5e3deee-8675-5cd8-9420-638b9be032f9/f8922320-A2810_GML.zip')
DEFAULT_CACHE_DIR = REPO_ROOT / 'tools' / '.cache' / 'kokudo_michinoeki_bunkazai_isan'

MICHINOEKI_ID_START = 210000
BUNKAZAI_ID_START = 300000
ISAN_ID_START = 400000

sys.path.insert(0, str(REPO_ROOT / 'tools'))
from data_generator import (  # noqa: E402
    compute_discovery_score, compute_reward, grid_key, haversine_km,
    generate_block_reachability, validate_places,
)

A28_NAME_MAP = {
    '01': '知床',
    '02': '白神山地',
    '03': '屋久島',
}


def ensure_extracted(zip_path, cache_dir, tag):
    extracted_dir = cache_dir / tag
    marker = extracted_dir / '.done'
    if marker.exists():
        return extracted_dir
    if not zip_path or not zip_path.exists():
        raise SystemExit(
            f'[{tag}] 展開済みキャッシュが無く、ZIPも見つかりません: {zip_path}'
        )
    extracted_dir.mkdir(parents=True, exist_ok=True)
    print(f'[{tag}][展開] {zip_path} -> {extracted_dir}')
    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(extracted_dir)
    marker.write_text('ok', encoding='utf-8')
    return extracted_dir


def find_extracted_or_prepared(prepared_dir, zip_path, cache_dir, tag):
    """既にセッションのscratchpadに展開済みのディレクトリがあればそれを使い、
    無ければcache_dirに展開する。"""
    if prepared_dir and Path(prepared_dir).exists():
        return Path(prepared_dir)
    return ensure_extracted(zip_path, cache_dir, tag)


# ---------------------------------------------------------------------------
# P35: 道の駅
# ---------------------------------------------------------------------------

def load_michinoeki(shp_dir):
    import shapefile
    shp_files = sorted(Path(shp_dir).rglob('P35-*.shp'))
    if not shp_files:
        raise SystemExit(f'P35-*.shp が見つかりません: {shp_dir}')
    records = []
    for shp in shp_files:
        r = shapefile.Reader(str(shp).rsplit('.', 1)[0], encoding='cp932')
        for sr in r.shapeRecords():
            rec = sr.record.as_dict()
            lat, lng = rec.get('P35_001'), rec.get('P35_002')
            name = (rec.get('P35_006') or '').strip()
            if not name or lat is None or lng is None:
                continue
            records.append({
                'name': f'道の駅{name}',
                'lat': lat, 'lng': lng,
                'officialUrl': (rec.get('P35_007') or '').strip(),
            })
    return records


def build_michinoeki_places(records, rng):
    places = []
    next_id = MICHINOEKI_ID_START
    for rec in records:
        score = compute_discovery_score(
            'michinoeki', has_wikipedia=False, wikipedia_length=0,
            lat=rec['lat'], lng=rec['lng'], osm_tag_count=4,
            has_image_tag=False, rng=rng,
        )
        places.append({
            'id': next_id,
            'name': rec['name'],
            'type': 'michinoeki',
            'lat': round(rec['lat'], 6),
            'lng': round(rec['lng'], 6),
            'discoveryScore': score,
            'reward': compute_reward(score),
            'officialUrl': rec['officialUrl'],
            'wikipediaUrl': '',
            'gridKey': grid_key(rec['lat'], rec['lng']),
            'hasWikipedia': False,
            'wikipediaLength': 0,
            'nearestStationId': None,
        })
        next_id += 1
    return places


# ---------------------------------------------------------------------------
# P32: 都道府県指定文化財
# ---------------------------------------------------------------------------

def classify_bunkazai_type(name):
    if '神社' in name:
        return 'shrine'
    if any(k in name for k in ('寺', '院', '堂')):
        return 'temple'
    if any(k in name for k in ('城', '館')):
        return 'castle'
    if any(k in name for k in ('像', '仏')):
        return 'famous_facility'
    return 'famous_facility'


def load_bunkazai(shp_dir):
    import shapefile
    shp_files = sorted(Path(shp_dir).rglob('P32-14_*.shp'))
    if not shp_files:
        raise SystemExit(f'P32-14_*.shp が見つかりません: {shp_dir}')
    records = []
    for shp in shp_files:
        r = shapefile.Reader(str(shp).rsplit('.', 1)[0], encoding='cp932')
        for sr in r.shapeRecords():
            rec = sr.record.as_dict()
            name = (rec.get('P32_006') or '').strip()
            if not name or not sr.shape.points:
                continue
            lng, lat = sr.shape.points[0][0], sr.shape.points[0][1]
            records.append({'name': name, 'lat': lat, 'lng': lng})
    return records


def build_bunkazai_places(records, rng):
    places = []
    next_id = BUNKAZAI_ID_START
    category_counts = {}
    for rec in records:
        place_type = classify_bunkazai_type(rec['name'])
        category_counts[place_type] = category_counts.get(place_type, 0) + 1
        score = compute_discovery_score(
            place_type, has_wikipedia=False, wikipedia_length=0,
            lat=rec['lat'], lng=rec['lng'], osm_tag_count=4,
            has_image_tag=False, rng=rng,
        )
        places.append({
            'id': next_id,
            'name': rec['name'],
            'type': place_type,
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
    return places, category_counts


# ---------------------------------------------------------------------------
# A28: 世界自然遺産
# ---------------------------------------------------------------------------

def load_isan(shp_dir):
    import shapefile
    shp_files = sorted(Path(shp_dir).rglob('A28-10-g*.shp'))
    if not shp_files:
        raise SystemExit(f'A28-10-g*.shp が見つかりません: {shp_dir}')
    records = []
    for shp in shp_files:
        r = shapefile.Reader(str(shp).rsplit('.', 1)[0], encoding='cp932')
        for sr in r.shapeRecords():
            rec = sr.record.as_dict()
            code = rec.get('A28_001')
            pts = sr.shape.points
            if not pts:
                continue
            lng = sum(p[0] for p in pts) / len(pts)
            lat = sum(p[1] for p in pts) / len(pts)
            records.append({'code': code, 'lat': lat, 'lng': lng})
    return records


def build_isan_places(records, rng):
    places = []
    next_id = ISAN_ID_START
    for rec in records:
        name = A28_NAME_MAP.get(rec['code'], f'世界自然遺産({rec["code"]})')
        score = compute_discovery_score(
            'world_heritage', has_wikipedia=False, wikipedia_length=0,
            lat=rec['lat'], lng=rec['lng'], osm_tag_count=4,
            has_image_tag=False, rng=rng,
        )
        places.append({
            'id': next_id,
            'name': name,
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


# ---------------------------------------------------------------------------
# 共通: マージ・最寄り駅割当
# ---------------------------------------------------------------------------

def merge_new_places(new_places, existing_places, min_distance_km=0.3):
    """tools/import_kokudo_kanko_shigen.py の merge_new_places と同ロジック。"""
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
    parser.add_argument('--p35-zip', type=Path, default=DEFAULT_P35_ZIP)
    parser.add_argument('--p32-zip', type=Path, default=DEFAULT_P32_ZIP)
    parser.add_argument('--a28-zip', type=Path, default=DEFAULT_A28_ZIP)
    parser.add_argument('--p35-prepared', type=Path,
                         default=Path('/tmp/claude-0/-home-user-journey-home-japan/f5e3deee-8675-5cd8-9420-638b9be032f9/scratchpad/p3518/P35-18_GML'))
    parser.add_argument('--p32-prepared', type=Path,
                         default=Path('/tmp/claude-0/-home-user-journey-home-japan/f5e3deee-8675-5cd8-9420-638b9be032f9/scratchpad/p3214/P32-14_00_GML'))
    parser.add_argument('--a28-prepared', type=Path,
                         default=Path('/tmp/claude-0/-home-user-journey-home-japan/f5e3deee-8675-5cd8-9420-638b9be032f9/scratchpad/a2810'))
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

    # --- P35 道の駅 ---
    p35_dir = find_extracted_or_prepared(args.p35_prepared, args.p35_zip, args.cache_dir, 'p35')
    michinoeki_records = load_michinoeki(p35_dir)
    print(f'[P35 道の駅] 読み込み: {len(michinoeki_records)}件')
    michinoeki_places = build_michinoeki_places(michinoeki_records, rng)

    # --- P32 都道府県指定文化財 ---
    p32_dir = find_extracted_or_prepared(args.p32_prepared, args.p32_zip, args.cache_dir, 'p32')
    bunkazai_records = load_bunkazai(p32_dir)
    print(f'[P32 文化財] 読み込み: {len(bunkazai_records)}件')
    bunkazai_places, bunkazai_counts = build_bunkazai_places(bunkazai_records, rng)
    print('[P32] type別内訳(新規候補):')
    for k, v in sorted(bunkazai_counts.items(), key=lambda x: -x[1]):
        print(f'  {k}: {v}件')

    # --- A28 世界自然遺産 ---
    a28_dir = find_extracted_or_prepared(args.a28_prepared, args.a28_zip, args.cache_dir, 'a28')
    isan_records = load_isan(a28_dir)
    print(f'[A28 世界自然遺産] 読み込み: {len(isan_records)}件')
    isan_places = build_isan_places(isan_records, rng)

    # --- マージ(P35→P32→A28の順。P35は既存michinoekiと重複しやすいので先に処理) ---
    merged = existing_places
    total_added, total_skipped = 0, 0
    for label, new_places in (
        ('道の駅(P35)', michinoeki_places),
        ('都道府県指定文化財(P32)', bunkazai_places),
        ('世界自然遺産(A28)', isan_places),
    ):
        merged, added, skipped = merge_new_places(new_places, merged)
        print(f'マージ結果[{label}]: 新規追加 {added}件 / 重複スキップ {skipped}件')
        total_added += added
        total_skipped += skipped

    print(f'合計: 新規追加 {total_added}件 / 重複スキップ {total_skipped}件 / 総計 {len(merged)}件')

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

    from collections import Counter
    type_counts = Counter(p['type'] for p in merged)
    print('type別内訳(統合後の全places):')
    for k, v in sorted(type_counts.items(), key=lambda x: -x[1]):
        print(f'  {k}: {v}件')

    print(f'書き出し完了: {out_dir}/places.json (合計{len(merged)}件), '
          f'{out_dir}/blockReachability.json を再生成しました。')


if __name__ == '__main__':
    main()
