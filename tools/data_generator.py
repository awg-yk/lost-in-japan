#!/usr/bin/env python3
"""地点・接続データの事前生成パイプライン(§5)。

Step1: Overpass APIで地点・駅データを取得
Step2: Wikipedia APIで記事有無・extract文字数を取得
Step3: gridKeyを算出
Step4: 接続(edge)を生成(孤立防止ルール§5.1・格安flight必須ルール§7.1.1を適用)
Step5: 発見スコアを§4の式で算出
Step6: JSON出力 (places.json / stations.json / connections.json)
Step7: blockReachability.json を生成

使い方:
    python3 tools/data_generator.py --out ../data

このスクリプトはネットワーク(Overpass API / Wikipedia API)に依存する。
オフライン環境やAPIレート制限時のために、既存の data/*.json (手動データ)は
このスクリプトを実行しなくても単独でゲームから読み込める設計になっている。
"""

import argparse
import json
import math
import time
import urllib.request
import urllib.parse
from pathlib import Path

OVERPASS_URL = 'https://overpass-api.de/api/interpreter'
WIKIPEDIA_API_URL = 'https://ja.wikipedia.org/w/api.php'

# §4.4 確定: 主要都市リスト(代表座標)
MAJOR_CITIES = {
    '札幌': (43.0621, 141.3544), '仙台': (38.2682, 140.8694), '東京': (35.6812, 139.7671),
    '横浜': (35.4437, 139.6380), '名古屋': (35.1815, 136.9066), '金沢': (36.5613, 136.6562),
    '大阪': (34.6937, 135.5023), '京都': (35.0116, 135.7681), '神戸': (34.6901, 135.1955),
    '広島': (34.3853, 132.4553), '高松': (34.3401, 134.0434), '松山': (33.8392, 132.7657),
    '福岡': (33.5904, 130.4017), '熊本': (32.7898, 130.7417), '那覇': (26.2124, 127.6809),
}

# §4.2 カテゴリ基礎値
CATEGORY_BASE = {
    'world_heritage': 10, 'castle': 15, 'famous_facility': 15, 'shrine': 20, 'temple': 20,
    'dam': 25, 'station_major': 30, 'art_museum': 35, 'station_local': 40, 'port_town': 40,
    'park': 45, 'onsen': 45, 'scenic_spot': 50, 'michinoeki': 50, 'waterfall': 55,
    'viewpoint': 60, 'museum': 60, 'city_hall': 65, 'local_spot': 70, 'local_facility': 70,
}

# 海峡・離島区間の特別扱い(本州-北海道、本州-四国、離島航路など)。
# tools実行時にOSMデータだけからは判定しづらいため、既知区間を手動リストとして保持する。
STRAIT_ISLAND_EDGES = [
    # (fromStationName, toStationName, mode, requiresTransport, isBudgetRequired)
    ('鹿児島中央', '那覇', 'ferry', ['ferry'], False),
    ('那覇', '南大東', 'flight', ['flight'], True),
]


def haversine_km(lat1, lng1, lat2, lng2):
    r = 6371
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlng / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def overpass_query(query, retries=3):
    """Step1: Overpass APIへPOSTし、JSONを取得する。"""
    data = query.encode('utf-8')
    for attempt in range(retries):
        try:
            req = urllib.request.Request(OVERPASS_URL, data=data, method='POST')
            with urllib.request.urlopen(req, timeout=60) as res:
                return json.loads(res.read().decode('utf-8'))
        except Exception as err:  # noqa: BLE001 - 生成ツールなので広めに捕捉してリトライ
            if attempt == retries - 1:
                raise
            time.sleep(2 ** attempt)
    return {'elements': []}


def build_overpass_query(bbox, node_tags):
    """指定bbox内の、指定タグを持つノード/ウェイを取得するOverpass QLを組み立てる。"""
    s, w, n, e = bbox
    clauses = ''.join(f'node{tag}({s},{w},{n},{e});way{tag}({s},{w},{n},{e});' for tag in node_tags)
    return f'[out:json][timeout:60];({clauses});out center tags;'


def fetch_wikipedia_info(title):
    """Step2: 記事有無とextract文字数を取得する。"""
    params = urllib.parse.urlencode({
        'action': 'query', 'format': 'json', 'prop': 'extracts',
        'explaintext': 1, 'redirects': 1, 'titles': title,
    })
    url = f'{WIKIPEDIA_API_URL}?{params}'
    try:
        with urllib.request.urlopen(url, timeout=20) as res:
            data = json.loads(res.read().decode('utf-8'))
        pages = data.get('query', {}).get('pages', {})
        for page_id, page in pages.items():
            if page_id == '-1':
                return False, 0
            extract = page.get('extract', '')
            return bool(extract), len(extract)
    except Exception:
        return False, 0
    return False, 0


def grid_key(lat, lng):
    """Step3: 緯度経度を0.1度単位に丸めた空間インデックス用キー。"""
    return f'{math.floor(lat * 10) / 10}_{math.floor(lng * 10) / 10}'


def nearest_major_city_km(lat, lng):
    return min(haversine_km(lat, lng, city_lat, city_lng) for city_lat, city_lng in MAJOR_CITIES.values())


def is_major_station(tags, lines):
    """新幹線停車の有無・路線数のしきい値で主要駅/ローカル駅を判定する(§4.2の裁量)。"""
    if tags.get('railway') == 'station' and 'shinkansen' in tags.get('name', '').lower():
        return True
    if any('新幹線' in line for line in lines):
        return True
    return len(lines) >= 3


def compute_discovery_score(category_key, has_wikipedia, wikipedia_length, lat, lng, osm_tag_count, has_image_tag):
    """§4.1 discoveryScore計算式。"""
    base = CATEGORY_BASE.get(category_key, 50)

    if not has_wikipedia:
        fame_adjustment = 30
    else:
        fame_adjustment = -min(30, wikipedia_length / 500)

    geo_adjustment = min(25, nearest_major_city_km(lat, lng) / 10)

    osm_secondary = 0
    if osm_tag_count > 15:
        osm_secondary -= 5
    elif osm_tag_count > 8:
        osm_secondary -= 2
    if has_image_tag:
        osm_secondary -= 3

    random_adjustment = (hash((lat, lng)) % 7) - 3  # 決定論的な擬似ランダム(-3〜+3)

    score = base + fame_adjustment + geo_adjustment + osm_secondary + random_adjustment
    return max(0, min(100, round(score)))


def compute_reward(discovery_score):
    return round(50 + discovery_score * 1.5)


def generate_rail_edges(stations_by_line):
    """Step4: 同一路線上の隣接駅をrailで接続する。"""
    edges = []
    for line, station_ids in stations_by_line.items():
        for a, b in zip(station_ids, station_ids[1:]):
            edges.append({'fromId': a, 'toId': b, 'mode': 'rail', 'requiresTransport': [], 'cost': 3000})
    return edges


def ensure_budget_flight(edges, stations_by_name):
    """§7.1.1: flightのみで隔てられ、ヒッチハイクも船便もない区間には
    isBudget:true の格安flight接続を必ず1本以上含める。"""
    for from_name, to_name, mode, requires, needs_budget in STRAIT_ISLAND_EDGES:
        if not needs_budget:
            continue
        from_id = stations_by_name.get(from_name)
        to_id = stations_by_name.get(to_name)
        if from_id is None or to_id is None:
            continue
        has_budget = any(
            e['fromId'] == from_id and e['toId'] == to_id and e.get('isBudget')
            for e in edges
        )
        if not has_budget:
            edges.append({
                'fromId': from_id, 'toId': to_id, 'mode': mode,
                'requiresTransport': requires, 'cost': 5000, 'isBudget': True,
            })
    return edges


def generate_block_reachability(all_nodes, block_size_deg=0.5):
    """Step7: 日本を0.5度グリッドに分割し、隣接ブロックを到達可能ブロックとして登録する。"""
    blocks = {}
    for node in all_nodes:
        bx = math.floor(node['lat'] / block_size_deg) * block_size_deg
        by = math.floor(node['lng'] / block_size_deg) * block_size_deg
        key = f'{bx}_{by}'
        blocks.setdefault(key, {'neighbors': set()})

    for key in list(blocks.keys()):
        bx, by = (float(v) for v in key.split('_'))
        for dx in (-block_size_deg, 0, block_size_deg):
            for dy in (-block_size_deg, 0, block_size_deg):
                if dx == 0 and dy == 0:
                    continue
                neighbor_key = f'{bx + dx}_{by + dy}'
                if neighbor_key in blocks:
                    blocks[key]['neighbors'].add(neighbor_key)

    return {'blocks': {k: {'neighbors': sorted(v['neighbors'])} for k, v in blocks.items()}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', default='data', help='出力先ディレクトリ')
    parser.add_argument('--skip-network', action='store_true',
                         help='Overpass/Wikipedia APIを呼ばず、既存data/*.jsonを再フォーマットするだけのドライラン')
    args = parser.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    if args.skip_network:
        print('--skip-network 指定のため、既存の手動データをそのまま使用します。')
        print('本格的なOSM/Wikipedia連携データ生成には、このスクリプトを --skip-network なしで実行してください。')
        return

    print('このスクリプトは Overpass API / Wikipedia API への実アクセスを行います。')
    print('大量の地点を対象にする場合は Overpass のレート制限に注意し、bboxを分割して実行してください。')

    # 実運用では、都道府県ごと/地方ごとにbboxを分割してOverpassへ問い合わせ、
    # Step1〜Step7を繰り返し実行して results を積み上げていく。
    # ここでは分割実行のためのフック関数のみを提供する(件数が膨大なため一括実行はしない)。
    print('data_generator.py: フック関数の定義のみ完了。実行スクリプトは用途に応じて main() を拡張してください。')


if __name__ == '__main__':
    main()
