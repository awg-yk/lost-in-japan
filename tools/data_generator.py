#!/usr/bin/env python3
"""地点・接続データの事前生成パイプライン(§5)。

Step1: Overpass APIで地点・駅データを取得(地方ごとにbbox分割)
Step2: Wikipedia APIで記事有無・extract文字数を取得
Step3: gridKeyを算出
Step4: 接続(edge)を生成(孤立防止ルール§5.1・格安flight必須ルール§7.1.1を適用)
Step5: 発見スコアを§4の式で算出
Step6: JSON出力 (places.json / stations.json / connections.json)
Step7: blockReachability.json を生成

使い方:
    python3 tools/data_generator.py --regions kanto,kansai --out data
    python3 tools/data_generator.py --regions all --out data --merge-with-existing

    ネットワーク制限のある環境(このリポジトリのCI/開発サンドボックス等)では
    Overpass API (overpass-api.de) / Wikipedia API (ja.wikipedia.org) への
    アクセスがブロックされている場合がある。その場合は --regions を指定せず
    `python3 tools/validate_data.py` でスキーマ・孤立検証のみ行うか、
    ネットワーク制限のない環境でこのスクリプトを実行すること。

このスクリプトを実行しなくても、既存の data/*.json (手動データ)は
単独でゲームから読み込める。
"""

import argparse
import hashlib
import json
import math
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

OVERPASS_URL = 'https://overpass-api.de/api/interpreter'
WIKIPEDIA_API_URL = 'https://ja.wikipedia.org/w/api.php'
DEFAULT_CACHE_DIR = Path(__file__).parent / '.cache'

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

# データ取得を分割するための地方区分(south, west, north, east)。
# 都道府県単位まで細分化すると47回のOverpass呼び出しになりレート制限に
# かかりやすいため、初期実装では8地方単位をデフォルトとする。
# 必要なら REGION_BBOXES に都道府県キーを追加して --regions で個別指定もできる。
REGION_BBOXES = {
    'hokkaido': (41.0, 139.0, 45.7, 146.5),
    'tohoku': (36.8, 139.3, 41.6, 142.2),
    'kanto': (34.8, 138.3, 37.2, 140.9),
    'chubu': (34.5, 135.9, 37.9, 139.6),
    'kansai': (33.3, 134.7, 35.8, 136.5),
    'chugoku': (33.7, 130.8, 35.8, 134.5),
    'shikoku': (32.7, 132.0, 34.5, 134.8),
    'kyushu_okinawa': (24.0, 122.9, 34.0, 132.0),
}

# OSMタグ -> §3.1 の観光地点typeへのマッピング。
# 完全な自動分類は不可能なため、代表的なタグの組み合わせで判定する近似実装。
# 判定漏れ・誤判定は tools/validate_data.py 及び目視レビューで補正する前提。
def classify_place_type(tags):
    if tags.get('historic') == 'castle':
        return 'castle'
    if tags.get('heritage') in ('1', '2', 'yes'):
        return 'world_heritage'
    if tags.get('amenity') == 'place_of_worship':
        religion = tags.get('religion')
        if religion == 'shinto':
            return 'shrine'
        if religion == 'buddhist':
            return 'temple'
        return 'shrine'
    if tags.get('waterway') == 'waterfall':
        return 'waterfall'
    if tags.get('waterway') == 'dam' or tags.get('man_made') == 'dam':
        return 'dam'
    if tags.get('tourism') == 'viewpoint':
        return 'viewpoint'
    if tags.get('leisure') == 'park':
        return 'park'
    if tags.get('natural') == 'hot_spring' or (tags.get('amenity') == 'public_bath' and 'onsen' in tags.get('bath:type', '')):
        return 'onsen'
    if tags.get('tourism') == 'museum':
        return 'art_museum' if tags.get('museum') == 'art' else 'museum'
    if tags.get('amenity') == 'townhall':
        return 'city_hall'
    if 'michinoeki' in tags.get('name', '') or '道の駅' in tags.get('name', ''):
        return 'michinoeki'
    if tags.get('tourism') == 'attraction':
        return 'scenic_spot'
    return None


def classify_transport_type(tags):
    if tags.get('railway') == 'station':
        return 'station'
    if tags.get('aeroway') == 'aerodrome':
        return 'airport'
    if tags.get('amenity') == 'ferry_terminal':
        return 'port'
    return None


def haversine_km(lat1, lng1, lat2, lng2):
    r = 6371
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlng / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def grid_key(lat, lng):
    """Step3: 緯度経度を0.1度単位に丸めた空間インデックス用キー。"""
    return f'{math.floor(lat * 10) / 10}_{math.floor(lng * 10) / 10}'


def nearest_major_city_km(lat, lng):
    return min(haversine_km(lat, lng, city_lat, city_lng) for city_lat, city_lng in MAJOR_CITIES.values())


# ---------------------------------------------------------------------------
# キャッシュ層(Overpass/Wikipediaの再呼び出しを避け、レート制限対策とする)
# ---------------------------------------------------------------------------

class Cache:
    def __init__(self, cache_dir):
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)

    def _path(self, namespace, key):
        digest = hashlib.sha256(key.encode('utf-8')).hexdigest()[:24]
        return self.cache_dir / f'{namespace}_{digest}.json'

    def get(self, namespace, key):
        path = self._path(namespace, key)
        if path.exists():
            try:
                return json.loads(path.read_text(encoding='utf-8'))
            except (json.JSONDecodeError, OSError):
                return None
        return None

    def set(self, namespace, key, value):
        path = self._path(namespace, key)
        path.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')


# ---------------------------------------------------------------------------
# Step1: Overpass API
# ---------------------------------------------------------------------------

def build_overpass_query(bbox):
    s, w, n, e = bbox
    place_tag_filters = [
        '["historic"="castle"]', '["heritage"]', '["amenity"="place_of_worship"]',
        '["waterway"="waterfall"]', '["waterway"="dam"]', '["man_made"="dam"]',
        '["tourism"="viewpoint"]', '["leisure"="park"]', '["natural"="hot_spring"]',
        '["tourism"="museum"]', '["amenity"="townhall"]', '["tourism"="attraction"]',
    ]
    transport_tag_filters = [
        '["railway"="station"]', '["aeroway"="aerodrome"]', '["amenity"="ferry_terminal"]',
    ]
    clauses = ''.join(f'node{tag}({s},{w},{n},{e});' for tag in place_tag_filters + transport_tag_filters)
    return f'[out:json][timeout:90];({clauses});out body;'


def fetch_region_elements(region_name, bbox, cache, retries=3):
    cache_key = f'{region_name}:{bbox}'
    cached = cache.get('overpass', cache_key)
    if cached is not None:
        print(f'[cache] {region_name}: {len(cached)} elements')
        return cached

    query = build_overpass_query(bbox)
    data = query.encode('utf-8')
    for attempt in range(retries):
        try:
            req = urllib.request.Request(OVERPASS_URL, data=data, method='POST')
            with urllib.request.urlopen(req, timeout=120) as res:
                result = json.loads(res.read().decode('utf-8'))
            elements = result.get('elements', [])
            cache.set('overpass', cache_key, elements)
            print(f'[fetch] {region_name}: {len(elements)} elements')
            return elements
        except (urllib.error.URLError, TimeoutError) as err:
            print(f'  retry {attempt + 1}/{retries} after error: {err}', file=sys.stderr)
            if attempt == retries - 1:
                raise
            time.sleep(2 ** attempt)
    return []


# ---------------------------------------------------------------------------
# Step2: Wikipedia API
# ---------------------------------------------------------------------------

def fetch_wikipedia_info(title, cache):
    cached = cache.get('wikipedia', title)
    if cached is not None:
        return cached['has'], cached['length']

    params = urllib.parse.urlencode({
        'action': 'query', 'format': 'json', 'prop': 'extracts',
        'explaintext': 1, 'redirects': 1, 'titles': title,
    })
    url = f'{WIKIPEDIA_API_URL}?{params}'
    has, length = False, 0
    try:
        with urllib.request.urlopen(url, timeout=20) as res:
            data = json.loads(res.read().decode('utf-8'))
        pages = data.get('query', {}).get('pages', {})
        for page_id, page in pages.items():
            if page_id == '-1':
                break
            extract = page.get('extract', '')
            has, length = bool(extract), len(extract)
            break
    except (urllib.error.URLError, TimeoutError):
        pass
    cache.set('wikipedia', title, {'has': has, 'length': length})
    return has, length


# ---------------------------------------------------------------------------
# Step4: 接続(edge)生成 — 孤立防止・連結性の保証
# ---------------------------------------------------------------------------

class UnionFind:
    def __init__(self, ids):
        self.parent = {i: i for i in ids}

    def find(self, x):
        while self.parent[x] != x:
            self.parent[x] = self.parent[self.parent[x]]
            x = self.parent[x]
        return x

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[ra] = rb

    def components(self):
        groups = {}
        for i in self.parent:
            groups.setdefault(self.find(i), []).append(i)
        return list(groups.values())


def build_nearest_neighbor_edges(stations, k=2):
    """路線関係(OSM route relation)の解析は本実装のスコープ外とし、
    近傍k駅を結ぶ近似グラフで代替する(§実装時の裁量)。
    将来的にはOSMのrouteリレーションから実路線を復元する形に置き換え可能。"""
    edges = []
    ids = list(stations.keys())
    for a in ids:
        dists = sorted(
            ((haversine_km(stations[a]['lat'], stations[a]['lng'], stations[b]['lat'], stations[b]['lng']), b)
             for b in ids if b != a),
            key=lambda x: x[0],
        )
        for dist_km, b in dists[:k]:
            cost = max(200, round(dist_km * 25, -2))
            edges.append({'fromId': a, 'toId': b, 'mode': 'rail', 'requiresTransport': [], 'cost': cost})
    return edges


def dedupe_edges(edges):
    seen = set()
    result = []
    for e in edges:
        key = (min(e['fromId'], e['toId']), max(e['fromId'], e['toId']), e['mode'])
        if key in seen:
            continue
        seen.add(key)
        result.append(e)
    return result


def bridge_disconnected_components(stations, edges):
    """孤立防止ルール(§5.1)の要: 連結成分が複数ある場合、最も近い駅同士を
    railで接続し、単一の連結成分になるまで繰り返す。"""
    ids = list(stations.keys())
    uf = UnionFind(ids)
    for e in edges:
        uf.union(e['fromId'], e['toId'])

    added = []
    while True:
        components = uf.components()
        if len(components) <= 1:
            break
        comp_a, comp_b = components[0], components[1]
        best = None
        for a in comp_a:
            for b in comp_b:
                d = haversine_km(stations[a]['lat'], stations[a]['lng'], stations[b]['lat'], stations[b]['lng'])
                if best is None or d < best[0]:
                    best = (d, a, b)
        dist_km, a, b = best
        cost = max(200, round(dist_km * 25, -2))
        bridge = {'fromId': a, 'toId': b, 'mode': 'rail', 'requiresTransport': [], 'cost': cost}
        edges.append(bridge)
        added.append(bridge)
        uf.union(a, b)
    return added


def is_bridge_edge(edges, node_ids, edge):
    """指定edgeを取り除くとグラフが非連結になるか(=単一障害点か)を判定する。
    双方向接続は fromId/toId を入れ替えた2本の有向edgeとして別々に保持されるため、
    対象と同じノード対・同じmodeの接続は往復とも併せて除外する(片方向だけ除いても、
    逆方向の複製edgeが残っていれば connectivity 上は繋がったままになるため)。
    ノード対が同じでもmodeが異なる接続(例: 同区間のflightとferry)は別の経路として
    扱い、除外しない(冗長経路があれば単一障害点ではないと正しく判定するため)。"""
    target_key = (frozenset({edge['fromId'], edge['toId']}), edge['mode'])
    uf = UnionFind(node_ids)
    for e in edges:
        if (frozenset({e['fromId'], e['toId']}), e['mode']) == target_key:
            continue
        uf.union(e['fromId'], e['toId'])
    return uf.find(edge['fromId']) != uf.find(edge['toId'])


def ensure_budget_flight_edges(stations, edges):
    """§7.1.1: flightのみで隔てられ、ヒッチハイクも船便もない区間には
    isBudget:true の格安flight接続を必ず1本以上追加する。
    「flightのみで隔てられている」= その接続を取り除くと非連結になる(単一障害点)、
    かつ requiresTransport が ['flight'] のみの接続、と機械的に定義する。"""
    node_ids = list(stations.keys())
    added = []
    flight_only_edges = [
        e for e in edges
        if e['mode'] == 'flight' and e.get('requiresTransport') == ['flight'] and not e.get('isBudget')
    ]
    for e in flight_only_edges:
        has_budget = any(
            other.get('isBudget') and {other['fromId'], other['toId']} == {e['fromId'], e['toId']}
            for other in edges
        )
        if has_budget:
            continue  # 既に格安便があるので、この対の単一障害点性は問題にならない
        if not is_bridge_edge(edges, node_ids, e):
            continue  # 他に迂回路があるので格安便は必須ではない
        budget_edge = {
            'fromId': e['fromId'], 'toId': e['toId'], 'mode': 'flight',
            'requiresTransport': ['flight'], 'cost': max(2000, round(e['cost'] * 0.35, -2)), 'isBudget': True,
        }
        edges.append(budget_edge)
        added.append(budget_edge)
    return added


def ensure_place_station_coverage(places, stations, max_distance_km=60):
    """§5.1 Step2: 各観光地点の最寄り駅を必ず割り当てる。遠すぎる場合は警告を出す
    (自動生成だけでは駅を新設できないため、人手でのデータ補完を促す)。"""
    warnings = []
    for place in places:
        best_id, best_dist = None, math.inf
        for sid, s in stations.items():
            d = haversine_km(place['lat'], place['lng'], s['lat'], s['lng'])
            if d < best_dist:
                best_dist, best_id = d, sid
        place['nearestStationId'] = best_id
        if best_dist > max_distance_km:
            warnings.append(f"{place['name']}: 最寄り駅({stations[best_id]['name'] if best_id else 'なし'})まで{best_dist:.1f}km")
    return warnings


# ---------------------------------------------------------------------------
# Step5: 発見スコア(§4.1)
# ---------------------------------------------------------------------------

def compute_discovery_score(category_key, has_wikipedia, wikipedia_length, lat, lng, osm_tag_count, has_image_tag, rng):
    base = CATEGORY_BASE.get(category_key, 50)

    fame_adjustment = 30 if not has_wikipedia else -min(30, wikipedia_length / 500)
    geo_adjustment = min(25, nearest_major_city_km(lat, lng) / 10)

    osm_secondary = 0
    if osm_tag_count > 15:
        osm_secondary -= 5
    elif osm_tag_count > 8:
        osm_secondary -= 2
    if has_image_tag:
        osm_secondary -= 3

    random_adjustment = rng.uniform(-3, 3)
    score = base + fame_adjustment + geo_adjustment + osm_secondary + random_adjustment
    return max(0, min(100, round(score)))


def compute_reward(discovery_score):
    return round(50 + discovery_score * 1.5)


# ---------------------------------------------------------------------------
# Step7: blockReachability.json
# ---------------------------------------------------------------------------

def generate_block_reachability(all_latlngs, block_size_deg=0.5):
    blocks = {}
    for lat, lng in all_latlngs:
        bx = math.floor(lat / block_size_deg) * block_size_deg
        by = math.floor(lng / block_size_deg) * block_size_deg
        blocks.setdefault(f'{bx}_{by}', set())

    for key in list(blocks.keys()):
        bx, by = (float(v) for v in key.split('_'))
        for dx in (-block_size_deg, 0, block_size_deg):
            for dy in (-block_size_deg, 0, block_size_deg):
                if dx == 0 and dy == 0:
                    continue
                neighbor_key = f'{bx + dx}_{by + dy}'
                if neighbor_key in blocks:
                    blocks[key].add(neighbor_key)

    return {'blocks': {k: {'neighbors': sorted(v)} for k, v in blocks.items()}}


# ---------------------------------------------------------------------------
# Step6: バリデーション + JSON出力
# ---------------------------------------------------------------------------

REQUIRED_PLACE_FIELDS = {
    'id', 'name', 'type', 'lat', 'lng', 'discoveryScore', 'reward', 'gridKey',
    'hasWikipedia', 'wikipediaLength', 'nearestStationId',
}
REQUIRED_STATION_FIELDS = {'id', 'name', 'type', 'lat', 'lng', 'connections', 'discoveryScore', 'reward', 'gridKey'}


def validate_places(places):
    errors = []
    for p in places:
        missing = REQUIRED_PLACE_FIELDS - p.keys()
        if missing:
            errors.append(f"place {p.get('id')}: missing fields {missing}")
        if not (0 <= p.get('discoveryScore', -1) <= 100):
            errors.append(f"place {p.get('id')}: discoveryScore out of range")
    return errors


def validate_stations(stations):
    errors = []
    for s in stations:
        missing = REQUIRED_STATION_FIELDS - s.keys()
        if missing:
            errors.append(f"station {s.get('id')}: missing fields {missing}")
        if not (0 <= s.get('discoveryScore', -1) <= 100):
            errors.append(f"station {s.get('id')}: discoveryScore out of range")
    return errors


def write_outputs(places, stations, edges, out_dir):
    errors = validate_places(places) + validate_stations(stations)
    if errors:
        print('検証エラーのため出力を中止しました:', file=sys.stderr)
        for e in errors:
            print(f'  - {e}', file=sys.stderr)
        raise SystemExit(1)

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / 'places.json').write_text(json.dumps({'places': places}, ensure_ascii=False, indent=2), encoding='utf-8')
    (out_dir / 'stations.json').write_text(json.dumps({'nodes': stations}, ensure_ascii=False, indent=2), encoding='utf-8')
    (out_dir / 'connections.json').write_text(
        json.dumps({'comment': '生成物。stations.json埋め込み済みconnectionsが正。', 'edges': edges}, ensure_ascii=False, indent=2),
        encoding='utf-8',
    )
    all_latlngs = [(p['lat'], p['lng']) for p in places] + [(s['lat'], s['lng']) for s in stations]
    block_reach = generate_block_reachability(all_latlngs)
    (out_dir / 'blockReachability.json').write_text(json.dumps(block_reach, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'書き出し完了: {out_dir}/ (places={len(places)}, stations={len(stations)}, edges={len(edges)})')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--regions', default='', help='カンマ区切りの地方名(REGION_BBOXESのキー)。"all"で全地方')
    parser.add_argument('--out', default='data', help='出力先ディレクトリ')
    parser.add_argument('--cache-dir', default=str(DEFAULT_CACHE_DIR), help='Overpass/Wikipediaレスポンスのキャッシュ先')
    parser.add_argument('--seed', type=int, default=42, help='discoveryScoreのランダム補正用シード(再現性確保)')
    args = parser.parse_args()

    if not args.regions:
        print('--regions が指定されていません。実行例:')
        print('  python3 tools/data_generator.py --regions kanto,kansai --out data')
        print('  python3 tools/data_generator.py --regions all --out data')
        print('地方一覧:', ', '.join(REGION_BBOXES.keys()))
        print()
        print('このサンドボックス環境では overpass-api.de / ja.wikipedia.org への')
        print('アクセスがネットワークポリシーでブロックされているため、実データ生成は')
        print('ネットワーク制限のない環境で実行してください。')
        return

    import random
    rng = random.Random(args.seed)

    region_names = list(REGION_BBOXES.keys()) if args.regions == 'all' else [r.strip() for r in args.regions.split(',')]
    cache = Cache(args.cache_dir)

    all_elements = []
    for region in region_names:
        if region not in REGION_BBOXES:
            print(f'未知の地方名: {region} (利用可能: {", ".join(REGION_BBOXES.keys())})', file=sys.stderr)
            continue
        all_elements.extend(fetch_region_elements(region, REGION_BBOXES[region], cache))

    stations = {}
    place_candidates = []
    for el in all_elements:
        tags = el.get('tags', {})
        if 'lat' not in el or 'lon' not in el:
            continue
        transport_type = classify_transport_type(tags)
        if transport_type:
            sid = el['id']
            lines = [tags[k] for k in ('line', 'network') if k in tags]
            stations[sid] = {
                'id': sid, 'name': tags.get('name', f'station_{sid}'), 'type': transport_type,
                'lat': el['lat'], 'lng': el['lon'], 'lines': lines, 'connections': [],
            }
            continue
        place_type = classify_place_type(tags)
        if place_type:
            place_candidates.append((el, place_type))

    print(f'抽出: 交通ノード {len(stations)}件 / 観光地点候補 {len(place_candidates)}件')

    edges = build_nearest_neighbor_edges(stations, k=2)
    edges = dedupe_edges(edges)
    bridged = bridge_disconnected_components(stations, edges)
    if bridged:
        print(f'連結性確保のため {len(bridged)} 本の橋渡し接続を追加しました。')
    budget_added = ensure_budget_flight_edges(stations, edges)
    if budget_added:
        print(f'§7.1.1に基づき格安flight接続を {len(budget_added)} 本追加しました。')

    places = []
    for el, place_type in place_candidates:
        tags = el.get('tags', {})
        name = tags.get('name', f"place_{el['id']}")
        has_wiki, wiki_len = fetch_wikipedia_info(name, cache)
        score = compute_discovery_score(
            place_type, has_wiki, wiki_len, el['lat'], el['lon'],
            osm_tag_count=len(tags), has_image_tag=('image' in tags or 'wikimedia_commons' in tags), rng=rng,
        )
        places.append({
            'id': el['id'], 'name': name, 'type': place_type, 'lat': el['lat'], 'lng': el['lon'],
            'discoveryScore': score, 'reward': compute_reward(score),
            'officialUrl': tags.get('website', ''), 'wikipediaUrl': f'https://ja.wikipedia.org/wiki/{urllib.parse.quote(name)}' if has_wiki else '',
            'gridKey': grid_key(el['lat'], el['lon']), 'hasWikipedia': has_wiki, 'wikipediaLength': wiki_len,
            'nearestStationId': None,
        })

    warnings = ensure_place_station_coverage(places, stations)
    for w in warnings:
        print(f'[警告] {w}', file=sys.stderr)

    station_id_to_edges = {}
    for e in edges:
        station_id_to_edges.setdefault(e['fromId'], []).append(e)
        reverse_exists = any(
            r['toId'] == e['fromId'] and r['mode'] == e['mode'] for r in station_id_to_edges.get(e['toId'], [])
        )
        if not reverse_exists:
            station_id_to_edges.setdefault(e['toId'], []).append({
                'toId': e['fromId'], 'mode': e['mode'], 'requiresTransport': e['requiresTransport'],
                'cost': e['cost'], **({'isBudget': True} if e.get('isBudget') else {}),
            })

    station_list = []
    for sid, s in stations.items():
        conns = [{'toId': e['toId'], 'mode': e['mode'], 'requiresTransport': e['requiresTransport'], 'cost': e['cost'], **({'isBudget': True} if e.get('isBudget') else {})}
                 for e in station_id_to_edges.get(sid, [])]
        score = compute_discovery_score(
            'station_major' if len(s['lines']) >= 3 else 'station_local',
            has_wikipedia=True, wikipedia_length=5000, lat=s['lat'], lng=s['lng'],
            osm_tag_count=6, has_image_tag=False, rng=rng,
        )
        station_list.append({**s, 'connections': conns, 'discoveryScore': score, 'reward': compute_reward(score),
                              'gridKey': grid_key(s['lat'], s['lng']), 'prefecture': ''})

    write_outputs(places, station_list, edges, args.out)


if __name__ == '__main__':
    main()
