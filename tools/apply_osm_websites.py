#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""fetch_osm_websites.py が集めたOSMデータを data/places.json に突合し、
公式URL(officialUrl)が空の地点にだけURLを補う。

【なぜ突合を収集と分けているか】
収集はネットワークが必要なのでユーザー環境(Colab等)でしか動かせないが、
突合は「誤ったURLを地点に貼り付けてしまう」危険がある処理なので、
リポジトリ側で実データを使って検証できるようにしてある。

【誤マッチを防ぐための方針】
過去に自治体データの取り込みで、「300m以内にある」だけを根拠にURLを移植
しようとして酷い誤マッチを大量に出した実績がある(イベント「おのえ花と
植木まつり」に、たまたま近くにあった別施設「さるか荘」のURLが付くなど。
docs/HANDOFF.md §18.7参照)。そのため本スクリプトでは:

  1. 名前の正規化後の完全一致のみを根拠にする(近接だけでは絶対に採らない)
  2. さらに距離が --radius-km 以内であることを要求する
     (「中央公園」「郷土資料館」「道の駅」等の同名施設は全国に多数あるため、
      名前一致だけでも足りない)
  3. **1対1で一意に決まる場合だけ採用する**。1つの地点に対してOSM候補が
     複数ある場合、あるいは1つのOSM要素が複数の地点に一致する場合は、
     どちらが正しいか判断できないので両方とも捨てる
  4. 既に officialUrl を持つ地点には一切触れない

使い方:
    # まず何が起きるか確認(places.jsonは変更しない)
    python3 tools/apply_osm_websites.py --osm tools/.cache/osm_websites.json --dry-run

    # 実際に反映
    python3 tools/apply_osm_websites.py --osm tools/.cache/osm_websites.json

入力JSONは .gz でもそのまま読める。
"""

import argparse
import gzip
import json
import re
import sys
import unicodedata
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / 'tools'))

from data_generator import grid_key, haversine_km  # noqa: E402

# 名前の正規化で落とす装飾。全角/半角の揺れは NFKC が吸収する。
DECORATION_RE = re.compile(r'[\s　「」『』（）\(\)【】\[\]〔〕・･,，、。\.]')
# 施設名によく付く接尾の説明。これらは付いていても同一施設とみなしたい。
TRAILING_NOISE = ('(旧)', '旧', '跡地')


def normalize_url(url):
    """同一施設の重複ノード(入口・建物本体など)が別々のURL表記(末尾スラッシュ
    やhttp/httpsの違いだけ)で登録されているケースを、比較のためだけに揃える。
    実際に採用するURLは元の表記(候補中の最短)をそのまま使う。"""
    u = (url or '').strip().lower()
    u = re.sub(r'^https?://', '', u)
    u = re.sub(r'^www\.', '', u)
    return u.rstrip('/')


def normalize_name(name):
    """突合用に名前を正規化する。全角半角・空白・括弧類の揺れを吸収するが、
    語そのものは変えない(「城跡」と「城」を同一視する等はしない。別施設の
    可能性があるため)。"""
    s = unicodedata.normalize('NFKC', name or '')
    s = DECORATION_RE.sub('', s)
    return s.casefold()


def load_osm(path):
    p = Path(path)
    raw = p.read_bytes()
    if p.suffix == '.gz' or raw[:2] == b'\x1f\x8b':
        raw = gzip.decompress(raw)
    data = json.loads(raw.decode('utf-8'))
    recs = data.get('records')
    if isinstance(recs, dict):
        return list(recs.values())
    if isinstance(recs, list):
        return recs
    raise SystemExit('OSM JSONの形式が想定と違います(records が見つかりません)')


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--osm', required=True, help='fetch_osm_websites.py の出力JSON(.gz可)')
    parser.add_argument('--data', default='data', help='places.json のあるディレクトリ')
    parser.add_argument('--out', default=None, help='出力先(既定は --data と同じ場所)')
    parser.add_argument('--radius-km', type=float, default=1.5,
                        help='名前一致に加えて要求する最大距離(km)')
    parser.add_argument('--dry-run', action='store_true', help='書き込まずに結果だけ表示')
    parser.add_argument('--samples', type=int, default=20, help='表示する例の件数')
    args = parser.parse_args()

    data_dir = Path(args.data)
    out_dir = Path(args.out) if args.out else data_dir
    places = json.loads((data_dir / 'places.json').read_text(encoding='utf-8'))['places']
    osm = load_osm(args.osm)

    targets = [p for p in places if not p.get('officialUrl')]
    print(f'places: 全{len(places)}件 / URL未設定{len(targets)}件')
    print(f'OSM: {len(osm)}件')

    # OSM側を正規化名 → レコード群 でまとめる
    osm_by_name = {}
    for r in osm:
        key = normalize_name(r.get('name'))
        if not key:
            continue
        osm_by_name.setdefault(key, []).append(r)

    # 地点側から候補を探す。名前完全一致かつ radius 以内のものだけ。
    # place_index -> [osm_record...] / osm_id -> [place_index...] の両方を作り、
    # 1対1に決まるものだけ後で採用する。
    cand_for_place = {}
    places_for_osm = {}
    for pi, p in enumerate(places):
        if p.get('officialUrl'):
            continue
        key = normalize_name(p['name'])
        if not key:
            continue
        for r in osm_by_name.get(key, ()):
            d = haversine_km(p['lat'], p['lng'], r['lat'], r['lng'])
            if d > args.radius_km:
                continue
            cand_for_place.setdefault(pi, []).append((d, r))
            places_for_osm.setdefault(id(r), []).append(pi)

    applied = []
    ambiguous_place = ambiguous_osm = 0
    for pi, cands in cand_for_place.items():
        if len(cands) > 1:
            # 同一施設の重複ノード(入口・建物本体など)がURLも実質同じなら
            # 曖昧とはみなさず、最も近い候補を採用する。URLが食い違う場合
            # (例: 新旧ドメインが混在)は判断できないので従来どおり捨てる。
            urls = {normalize_url(r['website']) for _, r in cands}
            if len(urls) > 1:
                ambiguous_place += 1
                continue
            d, r = min(cands, key=lambda x: x[0])
        else:
            d, r = cands[0]
        if len(places_for_osm.get(id(r), ())) > 1:
            ambiguous_osm += 1
            continue
        applied.append((pi, d, r))

    print(f'\n名前一致({args.radius_km}km以内)した地点: {len(cand_for_place)}件')
    print(f'  - 候補が複数あり曖昧なため不採用: {ambiguous_place}件')
    print(f'  - 同じOSM要素が複数地点に一致し曖昧なため不採用: {ambiguous_osm}件')
    print(f'  → 1対1で確定し採用: {len(applied)}件')

    if applied:
        ds = sorted(d for _, d, _ in applied)
        print(f'\n採用分の距離: 中央値{ds[len(ds) // 2]:.3f}km / '
              f'最大{ds[-1]:.3f}km / 1km超{sum(1 for d in ds if d > 1.0)}件')
        print(f'\n--- 採用例(距離が大きい順に{args.samples}件。誤マッチが出るならここに出る) ---')
        for pi, d, r in sorted(applied, key=lambda x: -x[1])[:args.samples]:
            print(f'  {d:.2f}km  {places[pi]["name"]}  [{places[pi]["type"]}]'
                  f'  <- {r.get("kind", "?")}  {r["website"][:60]}')

    if args.dry_run:
        print('\n--dry-run のため書き込みませんでした。')
        return

    for pi, _, r in applied:
        places[pi]['officialUrl'] = r['website']

    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / 'places.json').write_text(
        json.dumps({'places': places}, ensure_ascii=False, indent=2), encoding='utf-8')
    total_url = sum(1 for p in places if p.get('officialUrl'))
    print(f'\n書き出し完了: {out_dir}/places.json')
    print(f'公式URL付き地点: {total_url}件 (+{len(applied)})')


if __name__ == '__main__':
    main()
