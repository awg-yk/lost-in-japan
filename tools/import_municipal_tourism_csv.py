#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""市区町村オープンデータ(観光庁「標準観光情報」フォーマットのCSV/Excel)を
data/places.json に統合する。

ユーザーが北海道内の市区町村(札幌市・函館市・北斗市・恵庭市・苫小牧市・
古平町・秩父別町・初山別村・富良野市・新篠津村・別海町・新冠町)から
個別に収集したオープンデータを想定している。全国の自治体オープンデータ
ポータル(CKAN等)で同一フォーマットが広く使われているため、今後別の
都道府県分が集まった場合もこのスクリプトでそのまま取り込める。

このフォーマットには他の統合済みデータ(国土数値情報等)には無い
「URL（公式）」列が高い割合で埋まっており、公式URLの拡充を主目的とする
(docs/HANDOFF.md §18.5参照)。

フォーマットは自治体・年度によって微妙に列名が異なる(例: 「URL」/
「URL（公式）」、「緯度」/「緯度（10進法）」、「名称」列のみ/
「地方公共団体名」を含む拡張版 等)ため、列名の完全一致ではなく前方一致・
部分一致で位置を特定する(find_column系関数)。エンコーディングも
UTF-8(BOM付き)とCP932(Shift-JIS)が混在するため両方試す。

使い方:
    python3 tools/import_municipal_tourism_csv.py \
        --input-dir tools/.cache/municipal_tourism/extracted \
        --data data --out data

    (初回は --zip / --csv で元データを指定すると --cache-dir に展開・コピーして
    キャッシュする。以後は --input-dir 省略時、キャッシュから自動的に読む)
"""

import argparse
import csv
import io
import json
import math
import random
import sys
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CACHE_DIR = REPO_ROOT / 'tools' / '.cache' / 'municipal_tourism'
NEW_ID_START = 600000

sys.path.insert(0, str(REPO_ROOT / 'tools'))
from data_generator import (  # noqa: E402
    compute_discovery_score, compute_reward, grid_key, haversine_km,
    generate_block_reachability, validate_places,
)

# カテゴリ(「分類」列、セミコロン区切りタグ)や名称のキーワードから
# ゲーム内typeへ振り分ける簡易ヒューリスティック。判定順は上から優先。
NAME_KEYWORD_TYPE = [
    (('神社',), 'shrine'),
    (('寺', '院', '教会'), 'temple'),
    (('城', '城跡'), 'castle'),
    (('温泉',), 'onsen'),
    (('道の駅',), 'michinoeki'),
    (('公園', '庭園'), 'park'),
    (('美術館',), 'art_museum'),
    (('博物館', '資料館', '記念館'), 'museum'),
    (('灯台', '岬', '展望台', '峠', '滝', '湖', '沼', '渓谷', '海岸'), 'scenic_spot'),
]
CATEGORY_TAG_TYPE = [
    (('歴史', '文化財', '史跡'), 'famous_facility'),
    (('自然', '公園'), 'scenic_spot'),
    (('温泉',), 'onsen'),
    (('飲食', 'カフェ', 'ランチ', 'ディナー', '朝食'), 'local_facility'),
    (('体験', '人', '生活', '雑貨'), 'local_spot'),
]
DEFAULT_TYPE = 'local_spot'


def classify_type(name, category_tags):
    for keywords, t in NAME_KEYWORD_TYPE:
        if any(k in name for k in keywords):
            return t
    for keywords, t in CATEGORY_TAG_TYPE:
        if any(k in category_tags for k in keywords):
            return t
    return DEFAULT_TYPE


def find_col(header, *, exact=None, prefix=None, contains=None):
    """header(列名リスト)から該当する列のインデックスを探す。
    exact: 完全一致優先。prefix: 前方一致(ただし '_' で始まる別名列は除外)。
    contains: 部分一致。優先順は exact > prefix > contains。"""
    if exact:
        for i, h in enumerate(header):
            if h == exact:
                return i
    if prefix:
        for i, h in enumerate(header):
            if h.startswith(prefix) and not h[len(prefix):].startswith('_'):
                return i
    if contains:
        for i, h in enumerate(header):
            if contains in h:
                return i
    return None


def parse_csv_bytes(data, source_label):
    """CSVバイト列をUTF-8(BOM可)→CP932の順で試してパースする。"""
    text = None
    for enc in ('utf-8-sig', 'cp932'):
        try:
            text = data.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    if text is None:
        print(f'[警告] {source_label}: エンコーディングを判定できず読み飛ばし', file=sys.stderr)
        return []
    reader = csv.reader(io.StringIO(text))
    rows = list(reader)
    if not rows:
        return []
    return rows_to_records(rows, source_label)


def parse_xlsx_bytes(data, source_label):
    import openpyxl
    wb = openpyxl.load_workbook(io.BytesIO(data), data_only=True, read_only=True)
    ws = wb.worksheets[0]
    rows = []
    for row in ws.iter_rows(values_only=True):
        rows.append(['' if v is None else str(v) for v in row])
    return rows_to_records(rows, source_label)


def rows_to_records(rows, source_label):
    header = rows[0]
    name_col = find_col(header, exact='名称')
    lat_col = find_col(header, exact='緯度', prefix='緯度')
    lng_col = find_col(header, exact='経度', prefix='経度')
    url_col = find_col(header, exact='URL', contains='URL')
    category_col = find_col(header, exact='分類')
    address_col = find_col(header, contains='住所') or find_col(header, contains='所在地_連結表記')

    if name_col is None or lat_col is None or lng_col is None:
        print(f'[警告] {source_label}: 名称/緯度/経度列が見つからず読み飛ばし (header={header[:6]}...)', file=sys.stderr)
        return []

    records = []
    for row in rows[1:]:
        if len(row) <= max(name_col, lat_col, lng_col):
            continue
        name = (row[name_col] or '').strip()
        if not name:
            continue
        try:
            lat = float(row[lat_col])
            lng = float(row[lng_col])
        except (ValueError, TypeError):
            continue
        if not (20 <= lat <= 46 and 122 <= lng <= 154):
            continue  # 日本の緯度経度範囲外は不正データとみなす
        url = (row[url_col].strip() if url_col is not None and url_col < len(row) else '')
        category = (row[category_col].strip() if category_col is not None and category_col < len(row) else '')
        address = (row[address_col].strip() if address_col is not None and address_col < len(row) else '')
        records.append({
            'name': name, 'lat': lat, 'lng': lng,
            'officialUrl': url, 'category': category, 'address': address,
            'source': source_label,
        })
    return records


def load_all_records(input_dir):
    all_records = []
    for path in sorted(Path(input_dir).rglob('*')):
        if path.suffix.lower() == '.csv':
            data = path.read_bytes()
            recs = parse_csv_bytes(data, path.name)
        elif path.suffix.lower() == '.xlsx':
            data = path.read_bytes()
            recs = parse_xlsx_bytes(data, path.name)
        else:
            continue
        print(f'[読込] {path.name}: {len(recs)}件')
        all_records.extend(recs)
    return all_records


def build_new_places(records, rng):
    new_places = []
    next_id = NEW_ID_START
    category_counts = {}
    seen_in_batch = set()  # (name, 0.001度丸め座標) で同一ファイル間の完全重複を除去
    for rec in records:
        dedupe_key = (rec['name'], round(rec['lat'], 3), round(rec['lng'], 3))
        if dedupe_key in seen_in_batch:
            continue
        seen_in_batch.add(dedupe_key)

        place_type = classify_type(rec['name'], rec['category'])
        category_counts[place_type] = category_counts.get(place_type, 0) + 1
        has_url = bool(rec['officialUrl'])
        score = compute_discovery_score(
            place_type, has_wikipedia=False, wikipedia_length=0,
            lat=rec['lat'], lng=rec['lng'],
            osm_tag_count=6 if has_url else 4,
            has_image_tag=False, rng=rng,
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
            'wikipediaUrl': '',
            'gridKey': grid_key(rec['lat'], rec['lng']),
            'hasWikipedia': False,
            'wikipediaLength': 0,
            'nearestStationId': None,
        })
        next_id += 1
    return new_places, category_counts


def merge_new_places(new_places, existing_places, min_distance_km=0.3):
    """既存placesと同名、または300m未満の座標近接は重複として除外する
    (他のimport_*.pyスクリプトと同じ閾値・ロジック)。"""
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
    added, skipped, url_added = 0, 0, 0
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
        if p['officialUrl']:
            url_added += 1
    return merged, added, skipped, url_added


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


def ensure_input_dir(args):
    if args.input_dir:
        return Path(args.input_dir)
    cache_dir = args.cache_dir
    extracted_dir = cache_dir / 'extracted'
    extracted_dir.mkdir(parents=True, exist_ok=True)

    copied_any = False
    if args.csv:
        for csv_path in args.csv:
            dest = extracted_dir / Path(csv_path).name
            dest.write_bytes(Path(csv_path).read_bytes())
            copied_any = True
    if args.zip:
        for zip_path in args.zip:
            with zipfile.ZipFile(zip_path) as zf:
                for info in zf.infolist():
                    if info.filename.endswith('/'):
                        continue
                    try:
                        name = info.filename.encode('cp437').decode('cp932')
                    except (UnicodeDecodeError, UnicodeEncodeError):
                        name = info.filename
                    if name.lower().endswith('.zip'):
                        # ネストしたzip(自治体ごとの個別ダウンロードzip)を再帰的に展開
                        nested = zf.read(info)
                        with zipfile.ZipFile(io.BytesIO(nested)) as nzf:
                            for ninfo in nzf.infolist():
                                if ninfo.filename.endswith('/'):
                                    continue
                                try:
                                    nname = ninfo.filename.encode('cp437').decode('cp932')
                                except (UnicodeDecodeError, UnicodeEncodeError):
                                    nname = ninfo.filename
                                if nname.lower().endswith(('.csv', '.xlsx')):
                                    (extracted_dir / Path(nname).name).write_bytes(nzf.read(ninfo))
                        copied_any = True
                    elif name.lower().endswith(('.csv', '.xlsx')):
                        (extracted_dir / Path(name).name).write_bytes(zf.read(info))
                        copied_any = True

    if not copied_any and not any(extracted_dir.iterdir()):
        raise SystemExit(
            f'入力データが見つかりません。--input-dir、または --zip/--csv で元データを指定してください。'
        )
    return extracted_dir


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--zip', type=Path, action='append', default=[], help='市区町村オープンデータのzip(複数可、ネストしたzipも展開する)')
    parser.add_argument('--csv', type=Path, action='append', default=[], help='単体のCSVファイル(複数可)')
    parser.add_argument('--input-dir', type=Path, default=None, help='既に展開済みのCSV/XLSXが入ったディレクトリ(指定時は--zip/--csvより優先)')
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

    input_dir = ensure_input_dir(args)
    records = load_all_records(input_dir)
    print(f'読み込んだレコード総数: {len(records)}件 (うち公式URLあり: {sum(1 for r in records if r["officialUrl"])}件)')

    rng = random.Random(args.seed)
    new_places, category_counts = build_new_places(records, rng)
    print(f'変換後の新規候補: {len(new_places)}件')
    print('カテゴリ別内訳(新規候補):')
    for k, v in sorted(category_counts.items(), key=lambda x: -x[1]):
        print(f'  {k}: {v}件')

    merged_places, added, skipped, url_added = merge_new_places(new_places, existing_places)
    print(f'マージ結果: 新規追加 {added}件(うち公式URLあり {url_added}件) / 重複スキップ {skipped}件 / 合計 {len(merged_places)}件')

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
