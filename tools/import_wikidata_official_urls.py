#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Wikidata + Wikipedia外部リンク節から取得した公式サイトURL一覧
(fetch_wikidata_japan_tourist_spots.py の出力CSV)を data/places.json に
統合する。

このデータの主目的は「新規の観光地を増やすこと」ではなく「既存の
観光地(神社・寺・城・博物館・公園など、既にP12国土数値情報等から
取り込み済みのものが大半)に欠けている公式URLを埋めること」である
(docs/HANDOFF.md参照、ユーザーの当初の要望「Wikidataから公式サイトURL
取得」に対応)。そのため:
  1. 既存placesと名前+近傍座標(300m以内)でマッチしたものは、
     officialUrl/wikipediaUrlが空ならそこだけ埋める(新規追加しない)。
  2. マッチしなかった行のうち、URLがある行だけを新規placeとして追加する
     (URLが無い行を大量に追加すると、既存の均衡崩壊(docs/HANDOFF.md
     §のバランス調整の経緯参照)を繰り返しかねないため見送る)。

使い方:
    python3 tools/import_wikidata_official_urls.py \
        --csv path/to/wikidata_japan_tourist_spots.csv --data data --out data
"""

import argparse
import csv
import json
import math
import random
import sys
import urllib.parse
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
NEW_ID_START = 700000

sys.path.insert(0, str(REPO_ROOT / 'tools'))
from data_generator import (  # noqa: E402
    compute_discovery_score, compute_reward, grid_key, haversine_km,
    generate_block_reachability, validate_places,
)

# import_municipal_tourism_csv.py と同じ名前キーワードによる種別判定
# (このCSVには種別情報が残っていないため名前だけで判定する)。
NAME_KEYWORD_TYPE = [
    (('神社',), 'shrine'),
    (('寺', '院', '教会'), 'temple'),
    (('城', '城跡'), 'castle'),
    (('温泉',), 'onsen'),
    (('道の駅',), 'michinoeki'),
    (('公園', '庭園'), 'park'),
    (('美術館',), 'art_museum'),
    (('博物館', '資料館', '記念館'), 'museum'),
    (('灯台', '岬', '展望台', '展望塔', '峠', '滝', '湖', '沼', '渓谷', '海岸'), 'scenic_spot'),
    (('動物園', '水族館', '遊園地'), 'local_facility'),
    (('史跡', '遺跡'), 'historic'),
]
DEFAULT_TYPE = 'famous_facility'


def classify_type(name):
    for keywords, t in NAME_KEYWORD_TYPE:
        if any(k in name for k in keywords):
            return t
    return DEFAULT_TYPE


def wikipedia_url_from_title(title):
    if not title:
        return ''
    return 'https://ja.wikipedia.org/wiki/' + urllib.parse.quote(title.replace(' ', '_'))


def load_records(csv_path):
    records = []
    with open(csv_path, encoding='utf-8-sig', newline='') as f:
        reader = csv.DictReader(f)
        for row in reader:
            name = (row.get('名称') or '').strip()
            if not name:
                continue
            try:
                lat = float(row['緯度'])
                lng = float(row['経度'])
            except (KeyError, ValueError, TypeError):
                continue
            if not (20 <= lat <= 46 and 122 <= lng <= 154):
                continue
            records.append({
                'name': name, 'lat': lat, 'lng': lng,
                'officialUrl': (row.get('URL') or '').strip(),
                'wikiTitle': (row.get('wikiTitle') or '').strip(),
            })
    return records


def build_place_lookup(places, min_distance_km=0.3):
    """gridKeyでバケット化した既存placesの近傍探索インデックスを作る。"""
    buckets = {}
    for p in places:
        buckets.setdefault(p['gridKey'], []).append(p)

    def find_match(name, lat, lng):
        gk = grid_key(lat, lng)
        gx, gy = (float(v) for v in gk.split('_'))
        best, best_dist = None, min_distance_km
        for dx in (-0.1, 0, 0.1):
            for dy in (-0.1, 0, 0.1):
                key = f'{round(gx + dx, 1)}_{round(gy + dy, 1)}'
                for p in buckets.get(key, []):
                    if p['name'] != name:
                        continue
                    d = haversine_km(lat, lng, p['lat'], p['lng'])
                    if d < best_dist:
                        best, best_dist = p, d
        return best

    return find_match


def enrich_existing(records, places):
    find_match = build_place_lookup(places)
    unmatched = []
    enriched_url, enriched_wiki = 0, 0
    for rec in records:
        match = find_match(rec['name'], rec['lat'], rec['lng'])
        if match is None:
            unmatched.append(rec)
            continue
        if rec['officialUrl'] and not match.get('officialUrl'):
            match['officialUrl'] = rec['officialUrl']
            enriched_url += 1
        wiki_url = wikipedia_url_from_title(rec['wikiTitle'])
        if wiki_url and not match.get('wikipediaUrl'):
            match['wikipediaUrl'] = wiki_url
            match['hasWikipedia'] = True
            enriched_wiki += 1
    return unmatched, enriched_url, enriched_wiki


def build_new_places(records, rng):
    """URLがある行だけを新規placeとして追加する。"""
    new_places = []
    next_id = NEW_ID_START
    seen_in_batch = set()
    for rec in records:
        if not rec['officialUrl']:
            continue
        dedupe_key = (rec['name'], round(rec['lat'], 3), round(rec['lng'], 3))
        if dedupe_key in seen_in_batch:
            continue
        seen_in_batch.add(dedupe_key)

        place_type = classify_type(rec['name'])
        score = compute_discovery_score(
            place_type, has_wikipedia=bool(rec['wikiTitle']), wikipedia_length=1000 if rec['wikiTitle'] else 0,
            lat=rec['lat'], lng=rec['lng'],
            osm_tag_count=6, has_image_tag=False, rng=rng,
        )
        new_places.append({
            'id': next_id,
            'name': rec['name'],
            'type': place_type,
            'lat': round(rec['lat'], 6),
            'lng': round(rec['lng'], 6),
            'discoveryScore': score,
            'reward': compute_reward(score),
            'officialUrl': rec['officialUrl'],
            'wikipediaUrl': wikipedia_url_from_title(rec['wikiTitle']),
            'gridKey': grid_key(rec['lat'], rec['lng']),
            'hasWikipedia': bool(rec['wikiTitle']),
            'wikipediaLength': 1000 if rec['wikiTitle'] else 0,
            'nearestStationId': None,
        })
        next_id += 1
    return new_places


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
    parser.add_argument('--csv', type=Path, required=True, help='fetch_wikidata_japan_tourist_spots.py の出力CSV')
    parser.add_argument('--data', default='data', help='既存data/*.json読み込み元')
    parser.add_argument('--out', default='data', help='出力先')
    parser.add_argument('--seed', type=int, default=42, help='discoveryScore乱数補正のシード')
    args = parser.parse_args()

    data_dir = Path(args.data)
    out_dir = Path(args.out)

    existing_places = json.loads((data_dir / 'places.json').read_text(encoding='utf-8'))['places']
    stations = json.loads((data_dir / 'stations.json').read_text(encoding='utf-8'))['nodes']
    print(f'既存places: {len(existing_places)}件 / stations: {len(stations)}件')

    records = load_records(args.csv)
    with_url = sum(1 for r in records if r['officialUrl'])
    print(f'読み込んだレコード総数: {len(records)}件(うち公式URLあり: {with_url}件)')

    unmatched, enriched_url, enriched_wiki = enrich_existing(records, existing_places)
    print(f'既存placesとのマッチによる拡充: officialUrl {enriched_url}件 / wikipediaUrl {enriched_wiki}件')
    print(f'既存にマッチしなかったレコード: {len(unmatched)}件'
          f'(うちURLあり・新規追加対象: {sum(1 for r in unmatched if r["officialUrl"])}件)')

    rng = random.Random(args.seed)
    new_places = build_new_places(unmatched, rng)
    merged_places, added, skipped = merge_new_places(new_places, existing_places)
    print(f'新規追加: {added}件 / 重複スキップ: {skipped}件 / 合計 {len(merged_places)}件')

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
