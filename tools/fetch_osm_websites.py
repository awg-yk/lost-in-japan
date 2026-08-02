#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""OpenStreetMap(Overpass API)から、日本国内の観光関連POIの
「名称・座標・公式サイトURL」を収集する。ユーザーのローカル環境
(Colab等、ネットワーク制限が無い場所)で実行することを想定している。

【背景・なぜこれを作るか】
data/places.json は22,001件あるが、公式URLを持つのは1,476件だけで、
ゲーム内で徒歩の立ち寄り候補になるのはその公式URL付きの地点のみ
(js/movement.js の `!!node.officialUrl` フィルタ)。つまり残り20,525件は
「名前も座標もあるのにURLが無いせいでゲームに出てこない」状態にある。

自治体オープンデータを1つずつ手作業で集める運用(§18.5〜18.7)は、
1自治体あたり新規10〜20件程度しか増えず労力に見合わない。それよりも
既存2万件のURLを埋める方が効果がはるかに大きい。OSMには観光施設・寺社・
城・博物館等に `website` タグが広く付いているため、これを突合元に使う。

なお data.go.jp のCKAN APIは q/fq/rows がすべてサーバー側で無視され
実質使い物にならないことが実測で判明している(§18.8)。そちらは諦めた。

【重要な設計方針: 収集と突合を分離する】
本スクリプトは「OSMから素材を集めてJSONに落とす」ことだけを行い、
places.json は一切変更しない。既存地点との突合(誤マッチの危険がある処理)は
tools/apply_osm_websites.py 側で行う。こう分けることで、ネットワークが必要な
収集はユーザー環境で、判断ロジックの検証はリポジトリ側で、と役割を分けられる。

【問い合わせ範囲】
places.json が実際に地点を持つ1度メッシュ(実測100タイル)だけを対象にする。
日本全土を機械的に舐めるより問い合わせ回数が大幅に減り、かつ突合に使わない
海上・無人地帯を除ける。

使い方(リポジトリのルートで実行):
    python3 tools/fetch_osm_websites.py

    # まず数タイルだけで様子を見る(推奨)
    python3 tools/fetch_osm_websites.py --max-tiles 3

出力: tools/.cache/osm_websites.json
      (途中経過も同じファイルに逐次保存するので、中断しても再実行で続きから)

このJSONをアップロードしてもらえれば、突合はリポジトリ側で行う。
サイズが大きい場合は gzip して構わない:
    gzip -k tools/.cache/osm_websites.json
"""

import argparse
import gzip
import json
import math
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = REPO_ROOT / 'tools' / '.cache' / 'osm_websites.json'

# 複数用意し、混雑・レート制限時に切り替える。
OVERPASS_ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
]

USER_AGENT = 'journey-home-japan OSM website collector (+github.com/awg-yk/journey-home-japan)'

# 収集対象のカテゴリ。places.json の type(temple/shrine/castle/onsen/park/
# scenic_spot/museum/art_museum/viewpoint/michinoeki 等)に対応させている。
# 全POI(単に website があるもの全部)にすると都市部でコンビニ・歯科医院等が
# 大量に混ざり、応答が巨大になりすぎるためカテゴリで絞る。
CATEGORY_SELECTORS = [
    '["tourism"]',
    '["historic"]',
    '["leisure"]',
    '["natural"]',
    '["amenity"~"^(place_of_worship|museum|theatre|arts_centre|public_bath|'
    'community_centre|marketplace|spa)$"]',
    '["highway"="rest_area"]',
    '["shop"~"^(farm|craft)$"]',
]
# website / contact:website / url のいずれかが入っているものを対象にする
# (キー側の正規表現。値は「何か入っていること」だけを条件にする)
URL_KEY_SELECTOR = '[~"^(website|contact:website|url)$"~"."]'

TILE_DEG = 1.0


def build_query(south, west, north, east, timeout):
    bbox = f'{south},{west},{north},{east}'
    parts = []
    for sel in CATEGORY_SELECTORS:
        parts.append(f'  nwr["name"]{sel}{URL_KEY_SELECTOR}({bbox});')
    body = '\n'.join(parts)
    # out center: way/relation は代表点(重心)だけあれば突合には十分
    return f'[out:json][timeout:{timeout}];\n(\n{body}\n);\nout center tags;'


def overpass_post(query, timeout_sec, endpoint):
    data = urllib.parse.urlencode({'data': query}).encode('utf-8')
    req = urllib.request.Request(
        endpoint, data=data,
        headers={'User-Agent': USER_AGENT,
                 'Content-Type': 'application/x-www-form-urlencoded'})
    with urllib.request.urlopen(req, timeout=timeout_sec) as res:
        return json.loads(res.read().decode('utf-8'))


def fetch_tile(south, west, north, east, args, depth=0):
    """1タイル分を取得する。混雑・タイムアウト時は4分割して再帰する
    (東京都心のような高密度タイルは1度四方だと応答しきれないことがある)。"""
    query = build_query(south, west, north, east, args.overpass_timeout)
    indent = '  ' * depth
    for attempt in range(args.retries):
        endpoint = OVERPASS_ENDPOINTS[(attempt) % len(OVERPASS_ENDPOINTS)]
        try:
            payload = overpass_post(query, args.overpass_timeout + 30, endpoint)
            return payload.get('elements') or []
        except urllib.error.HTTPError as e:
            # 429(レート制限)/504(混雑)は待って再試行、または分割
            wait = min(60, 5 * (2 ** attempt))
            print(f'{indent}  [{e.code}] {endpoint} 待機{wait}s', file=sys.stderr)
            time.sleep(wait)
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as e:
            wait = min(60, 5 * (2 ** attempt))
            print(f'{indent}  [失敗] {type(e).__name__} 待機{wait}s', file=sys.stderr)
            time.sleep(wait)

    # 再試行しても駄目なら4分割(密度が高すぎる可能性)
    if depth < args.max_split_depth:
        print(f'{indent}  → 4分割して再取得します', file=sys.stderr)
        mid_lat = (south + north) / 2
        mid_lng = (west + east) / 2
        out = []
        for s, w, n, e in ((south, west, mid_lat, mid_lng),
                           (south, mid_lng, mid_lat, east),
                           (mid_lat, west, north, mid_lng),
                           (mid_lat, mid_lng, north, east)):
            out.extend(fetch_tile(s, w, n, e, args, depth + 1))
            time.sleep(args.sleep)
        return out

    print(f'{indent}  [断念] {south},{west},{north},{east}', file=sys.stderr)
    return []


def pick_url(tags):
    for key in ('website', 'contact:website', 'url'):
        v = (tags.get(key) or '').strip()
        if not v:
            continue
        if v.startswith('//'):
            v = 'https:' + v
        if not v.startswith(('http://', 'https://')):
            # 「www.example.com」のようなスキーム無しも救う
            if '.' in v and ' ' not in v:
                v = 'https://' + v
            else:
                continue
        if len(v) > 500:
            continue
        return v
    return ''


def element_to_record(el):
    tags = el.get('tags') or {}
    name = (tags.get('name') or '').strip()
    if not name:
        return None
    url = pick_url(tags)
    if not url:
        return None
    if el.get('type') == 'node':
        lat, lng = el.get('lat'), el.get('lon')
    else:
        center = el.get('center') or {}
        lat, lng = center.get('lat'), center.get('lon')
    if lat is None or lng is None:
        return None
    # 突合に使う最小限だけ持つ(アップロードサイズを抑える)
    rec = {
        'name': name,
        'lat': round(float(lat), 6),
        'lng': round(float(lng), 6),
        'website': url,
    }
    # 種別の手掛かりを1つだけ残す(突合時の参考・デバッグ用)
    for k in ('tourism', 'historic', 'amenity', 'leisure', 'natural', 'highway', 'shop'):
        if tags.get(k):
            rec['kind'] = f'{k}={tags[k]}'
            break
    if tags.get('name:en'):
        rec['name_en'] = tags['name:en'].strip()
    return rec


def tiles_from_places(places_path):
    """places.json が実際に地点を持つ1度メッシュだけを返す。"""
    places = json.loads(Path(places_path).read_text(encoding='utf-8'))['places']
    tiles = set()
    for p in places:
        tiles.add((math.floor(p['lat'] / TILE_DEG), math.floor(p['lng'] / TILE_DEG)))
    return sorted(tiles)


def load_progress(out_path):
    if out_path.exists():
        try:
            d = json.loads(out_path.read_text(encoding='utf-8'))
            return d.get('records', {}), set(tuple(t) for t in d.get('done_tiles', []))
        except (ValueError, KeyError):
            pass
    return {}, set()


def save(out_path, records, done_tiles):
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps({
        'source': 'OpenStreetMap via Overpass API (ODbL)',
        'done_tiles': sorted(done_tiles),
        'records': records,
    }, ensure_ascii=False), encoding='utf-8')


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--data', default='data', help='places.json のあるディレクトリ')
    parser.add_argument('--out', type=Path, default=DEFAULT_OUT, help='出力JSON')
    parser.add_argument('--max-tiles', type=int, default=0,
                        help='処理するタイル数の上限(0で全部。まずは3程度で試すこと)')
    parser.add_argument('--sleep', type=float, default=2.0,
                        help='タイル間の待機秒数(Overpassへの配慮。短くしすぎない)')
    parser.add_argument('--retries', type=int, default=3, help='1タイルあたりの再試行回数')
    parser.add_argument('--overpass-timeout', type=int, default=180,
                        help='Overpass側のtimeout秒')
    parser.add_argument('--max-split-depth', type=int, default=2,
                        help='高密度タイルを4分割で細かくする最大段数')
    parser.add_argument('--gzip', action='store_true', help='完了後に .gz も作る')
    args = parser.parse_args()

    tiles = tiles_from_places(Path(args.data) / 'places.json')
    records, done = load_progress(args.out)
    todo = [t for t in tiles if t not in done]
    if args.max_tiles:
        todo = todo[:args.max_tiles]

    print(f'対象タイル(1度メッシュ): 全{len(tiles)} / 未処理{len(tiles) - len(done)} '
          f'/ 今回処理{len(todo)}')
    print(f'既に収集済みのレコード: {len(records)}件\n')

    for i, (ty, tx) in enumerate(todo, 1):
        south, west = ty * TILE_DEG, tx * TILE_DEG
        north, east = south + TILE_DEG, west + TILE_DEG
        print(f'[{i}/{len(todo)}] タイル lat{south:.0f}〜{north:.0f} '
              f'lng{west:.0f}〜{east:.0f} …', end='', flush=True)
        elements = fetch_tile(south, west, north, east, args)
        added = 0
        for el in elements:
            rec = element_to_record(el)
            if not rec:
                continue
            key = f"{el.get('type')}/{el.get('id')}"
            if key not in records:
                records[key] = rec
                added += 1
        done.add((ty, tx))
        save(args.out, records, done)
        print(f' 取得{len(elements)}要素 → 新規{added}件 (累計{len(records)}件)')
        time.sleep(args.sleep)

    size_mb = args.out.stat().st_size / 1024 / 1024 if args.out.exists() else 0
    print(f'\n完了: {args.out} に {len(records)}件 ({size_mb:.1f}MB)')

    if args.gzip and args.out.exists():
        gz = Path(str(args.out) + '.gz')
        gz.write_bytes(gzip.compress(args.out.read_bytes()))
        print(f'      {gz} ({gz.stat().st_size / 1024 / 1024:.1f}MB)')

    remaining = len(tiles) - len(done)
    if remaining:
        print(f'\n未処理タイルが{remaining}件あります。同じコマンドを再実行すると続きから処理します。')
    else:
        print('\n全タイル完了。このJSON(または.gz)をアップロードしてください。')


if __name__ == '__main__':
    main()
