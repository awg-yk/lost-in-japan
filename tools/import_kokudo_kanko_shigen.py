#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""国土数値情報 観光資源データ(P12、2015年度版)を data/places.json に統合する。

出典: 国土数値情報 観光資源データ(P12) https://nlftp.mlit.go.jp/ksj/gml/datalist/KsjTmplt-P12.html
      2015年度版、点データ(P12a-14_XX.shp、XX=都道府県コード)を使用。
      面・線レイヤー(P12c-14_XX.*)は今回対象外。

使い方:
    python3 tools/import_kokudo_kanko_shigen.py \
        [--zip /root/.claude/uploads/.../P1214_GML.zip] \
        [--cache-dir tools/.cache/kokudo_kanko_shigen] \
        [--data data --out data]

初回実行時、--zip を tools/.cache/kokudo_kanko_shigen/extracted/ に展開してキャッシュする
(以後は --zip を省略してもキャッシュから読み込む)。

設計判断(要点。詳細は docs/HANDOFF.md 参照):
- P12_005(観光資源区分名)は約97%が「‐」(未分類)。カテゴリマッピングは
  CATEGORY_MAP(名称からの補正込み)を参照。
- discoveryScore/reward は tools/data_generator.py の compute_discovery_score/
  compute_reward をそのまま踏襲(has_wikipedia=False固定、rng=random.Random(42))。
- 重複除去: 既存placesと同名、または300m未満の座標近接は除外
  (tools/data_generator.py の merge_new_places と同じ閾値)。
- id: 200000番以降を新規に採番(既存94件はid 101〜、station_database取り込み後の
  駅idは1〜9000番台なのでplaceのid空間としても十分離れている)。
"""

import argparse
import json
import math
import random
import sys
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_ZIP = Path('/root/.claude/uploads/f5e3deee-8675-5cd8-9420-638b9be032f9/7d7c4c90-P1214_GML.zip')
DEFAULT_CACHE_DIR = REPO_ROOT / 'tools' / '.cache' / 'kokudo_kanko_shigen'
NEW_ID_START = 200000

sys.path.insert(0, str(REPO_ROOT / 'tools'))
from data_generator import (  # noqa: E402
    compute_discovery_score, compute_reward, grid_key, haversine_km,
    generate_block_reachability, validate_places,
)

# P12_005(観光資源区分名) -> ゲーム内type へのマッピング。
# 「‐」(未分類、約97%)はデフォルトで local_spot。
CATEGORY_MAP = {
    '神社・寺院・教会': 'shrine',  # 名称ベースの補正あり(下記 refine_type 参照)
    '山岳': 'scenic_spot', '高原・湿原・原野': 'scenic_spot', '河川・峡谷': 'scenic_spot',
    '海岸・岬': 'scenic_spot', '郷土景観': 'scenic_spot', '自然現象': 'scenic_spot',
    '湖沼': 'scenic_spot', '岩石・洞窟': 'scenic_spot',
    '温泉': 'onsen',
    '城跡・城郭・宮殿': 'castle',
    '博物館・美術館': 'art_museum',
    '動植物園・水族館': 'museum',
    '庭園・公園': 'park', 'テーマ・公園テーマ施設': 'park',
    '建造物': 'famous_facility', '史跡': 'famous_facility',
    '動物': 'local_spot', '植物': 'local_spot',
    '集落・街': 'local_spot', '食': 'local_spot', '年中行事': 'local_spot',
    '芸能・興行・イベント': 'local_spot',
    '‐': 'local_spot',
}
DEFAULT_TYPE = 'local_spot'


def refine_type(base_type, name):
    """名称ベースの補正。神社・寺院・教会区分は寺/院/教会をtempleへ寄せる。"""
    if base_type == 'shrine':
        if ('寺' in name or '院' in name) and '神社' not in name:
            return 'temple'
        if '教会' in name:
            return 'temple'
    return base_type


def ensure_extracted(zip_path, cache_dir):
    extracted_dir = cache_dir / 'extracted'
    marker = extracted_dir / '.done'
    if marker.exists():
        return extracted_dir
    if not zip_path or not zip_path.exists():
        raise SystemExit(
            f'展開済みキャッシュが無く、ZIPも見つかりません: {zip_path}\n'
            f'--zip でP1214_GML.zipのパスを指定してください。'
        )
    extracted_dir.mkdir(parents=True, exist_ok=True)
    print(f'[展開] {zip_path} -> {extracted_dir}')
    with zipfile.ZipFile(zip_path) as zf:
        zf.extractall(extracted_dir)
    # ZIP内に更にネストしたzip/ディレクトリがある場合の吸収
    marker.write_text('ok', encoding='utf-8')
    return extracted_dir


def find_shp_files(extracted_dir):
    """P12a-14_XX.shp (点データ、XX=01〜47)を再帰的に探す。P12c-14は除外。"""
    shp_files = sorted(extracted_dir.rglob('P12a-14_*.shp'))
    return shp_files


def read_points(shp_path):
    import shapefile
    r = shapefile.Reader(str(shp_path).rsplit('.', 1)[0], encoding='cp932')
    records = []
    for sr in r.shapeRecords():
        rec = sr.record.as_dict()
        if not sr.shape.points:
            continue
        lng, lat = sr.shape.points[0][0], sr.shape.points[0][1]
        records.append({
            'raw_id': rec.get('P12_001'),
            'name': (rec.get('P12_002') or '').strip(),
            'pref_code': rec.get('P12_003'),
            'category': (rec.get('P12_005') or '').strip(),
            'lat': lat, 'lng': lng,
        })
    return records


def load_all_points(extracted_dir):
    shp_files = find_shp_files(extracted_dir)
    if not shp_files:
        raise SystemExit(f'P12a-14_*.shp が見つかりません: {extracted_dir}')
    all_points = []
    for shp in shp_files:
        pts = read_points(shp)
        all_points.append((shp.name, pts))
    return all_points


def build_new_places(all_points, rng):
    new_places = []
    next_id = NEW_ID_START
    category_counts = {}
    for fname, pts in all_points:
        for p in pts:
            if not p['name']:
                continue
            base_type = CATEGORY_MAP.get(p['category'], DEFAULT_TYPE)
            place_type = refine_type(base_type, p['name'])
            category_counts[place_type] = category_counts.get(place_type, 0) + 1

            score = compute_discovery_score(
                place_type, has_wikipedia=False, wikipedia_length=0,
                lat=p['lat'], lng=p['lng'],
                osm_tag_count=4,  # 出典データにOSMタグは無いため中庸な固定値
                has_image_tag=False, rng=rng,
            )
            new_places.append({
                'id': next_id,
                'name': p['name'],
                'type': place_type,
                'lat': round(p['lat'], 6),
                'lng': round(p['lng'], 6),
                'discoveryScore': score,
                'reward': compute_reward(score),
                'officialUrl': '',
                'wikipediaUrl': '',
                'gridKey': grid_key(p['lat'], p['lng']),
                'hasWikipedia': False,
                'wikipediaLength': 0,
                'nearestStationId': None,
            })
            next_id += 1
    return new_places, category_counts


def merge_new_places(new_places, existing_places, min_distance_km=0.3):
    """tools/data_generator.py の merge_new_places と同ロジック(コピー・流用)。
    件数が大きい(約1.7万件)ため、gridKeyベースの粗い空間バケットで
    近接判定を高速化する(単純なO(n*m)だと発見スコア計算より遅くなるため)。"""
    existing_ids = {p['id'] for p in existing_places}
    existing_names = {p['name'] for p in existing_places}

    # 0.1度グリッドのバケットに既存地点を配置(gridKeyそのまま流用)
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
    """gridKey近傍バケットでhaversine距離の最寄り駅を割り当てる(8988駅 x 1.7万件を
    素朴なO(n*m)で行うと時間がかかるため、空間バケットで候補を絞る)。"""
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
            # 離島等、粗い空間バケットの探索半径(5度)内に駅が無いレアケース。
            # 全駅を素朴に走査してフォールバックする(件数は僅少)。
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
    parser.add_argument('--zip', type=Path, default=DEFAULT_ZIP, help='P1214_GML.zip のパス(初回のみ使用、以降はキャッシュから読む)')
    parser.add_argument('--cache-dir', type=Path, default=DEFAULT_CACHE_DIR, help='展開先キャッシュディレクトリ')
    parser.add_argument('--data', default='data', help='既存data/*.json読み込み元')
    parser.add_argument('--out', default='data', help='出力先')
    parser.add_argument('--seed', type=int, default=42, help='discoveryScore乱数補正のシード')
    args = parser.parse_args()

    data_dir = Path(args.data)
    out_dir = Path(args.out)

    existing_places = json.loads((data_dir / 'places.json').read_text(encoding='utf-8'))['places']
    stations = json.loads((data_dir / 'stations.json').read_text(encoding='utf-8'))['nodes']
    print(f'既存places: {len(existing_places)}件 / stations: {len(stations)}件')

    extracted_dir = ensure_extracted(args.zip, args.cache_dir)
    all_points = load_all_points(extracted_dir)
    total_raw = sum(len(pts) for _, pts in all_points)
    print(f'Shapefile読み込み: {len(all_points)}都道府県ぶん、計{total_raw}件')

    rng = random.Random(args.seed)
    new_places, category_counts = build_new_places(all_points, rng)
    print(f'変換後の新規候補: {len(new_places)}件')
    print('カテゴリ別内訳(新規候補):')
    for k, v in sorted(category_counts.items(), key=lambda x: -x[1]):
        print(f'  {k}: {v}件')

    merged_places, added, skipped = merge_new_places(new_places, existing_places)
    print(f'マージ結果: 新規追加 {added}件 / 重複スキップ {skipped}件 / 合計 {len(merged_places)}件')

    unassigned = assign_nearest_stations(merged_places, stations)
    print(f'nearestStationId未割当: {unassigned}件')

    errors = validate_places(merged_places)
    if errors:
        print('検証エラーのため出力を中止しました:', file=sys.stderr)
        for e in errors[:20]:
            print(f'  - {e}', file=sys.stderr)
        raise SystemExit(1)

    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / 'places.json').write_text(
        json.dumps({'places': merged_places}, ensure_ascii=False, indent=2), encoding='utf-8')

    all_latlngs = [(p['lat'], p['lng']) for p in merged_places] + [(s['lat'], s['lng']) for s in stations]
    block_reach = generate_block_reachability(all_latlngs)
    (out_dir / 'blockReachability.json').write_text(
        json.dumps(block_reach, ensure_ascii=False, indent=2), encoding='utf-8')

    print(f'書き出し完了: {out_dir}/places.json (合計{len(merged_places)}件), '
          f'{out_dir}/blockReachability.json を再生成しました。')


if __name__ == '__main__':
    main()
