#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""data.go.jp(政府データカタログ、CKAN API)の全データセットをページングで
走査し、観光施設っぽいCSV/XLSXを一括ダウンロードして
import_municipal_tourism_csv.py にそのまま渡せる1つのzipにまとめる。

【2026-08-02判明】data.go.jpのこのAPI(package_search)は q(全文検索)も
fq(filter query)もサーバー側で一切効かず、常に全データセット(実測約18189件)
をそのまま返すだけと判明した(ユーザー環境での実機検証で確認: q='観光'、
q='zzzzznonsense12345'、fq='title:*観光*'、fq='res_format:CSV' がすべて
同一件数・同一結果になった)。そのため検索語は使わず、全件をページングして
タイトルの絞り込みはクライアント側(title_is_interesting、下記)で行う設計に
している。全件走査になる分、素朴な検索より時間はかかる。

【このスクリプトが存在する理由】
Claude Code のサンドボックスからは data.go.jp・各自治体のオープンデータ
ポータル・Overpass(OSM)・Wikidata SPARQL 等がすべてネットワーク遮断されて
おり(到達できるのは raw.githubusercontent.com 程度)、エージェント側から
自動収集ができない。そのため従来は「ユーザーが1自治体ずつ手作業でダウン
ロードしてアップロードする」運用になっていた(docs/HANDOFF.md §18.5〜)。

一方ユーザーのローカル環境にはその制約が無いため、収集だけをローカルで
一括実行し、成果物のzipを1回アップロードすれば済むようにするのが本
スクリプト。数十回の手作業が1コマンドになる。

【重要】ダウンロードした全ファイルを闇雲に同梱するのではなく、
import_municipal_tourism_csv.py のパーサ(parse_csv_bytes/parse_xlsx_bytes)を
そのまま呼んで「実際に1件以上の観光地レコードを取り出せたファイル」だけを
zipに入れる。取り込み時とまったく同じ判定を使うので、
「アップロードしたのに0件だった」を事前に排除できる。
自治体データは緯度経度が空欄のものが非常に多く(飯能市38件・富士見市4件・
入間市8件・志木市1件などが実際に全滅)、この事前フィルタの効果は大きい。

使い方(ユーザーのPC、リポジトリのルートで実行):
    python3 tools/collect_tourism_opendata.py

    # 件数を絞って試す(まず動作確認したいとき。全件は約18000件あるので
    # 最初は必ずこれで様子を見ることを推奨)
    python3 tools/collect_tourism_opendata.py --max-datasets 300

    # 途中で打ち切った/失敗した続きから再開する(--startはデータセットの
    # 通し番号。実行中のログに出る「[走査] N〜M / 全T件」のNを指定する)
    python3 tools/collect_tourism_opendata.py --start 3000

完了すると tools/.cache/tourism_bundle.zip ができるので、それを1つ
アップロードすればよい。取り込み側は従来どおり:
    python3 tools/import_municipal_tourism_csv.py --zip tools/.cache/tourism_bundle.zip \
        --data data --out data

ダウンロード済みのURLは manifest.json に記録している(再実行してもDL済みの
ファイルは飛ばす)が、全件走査そのものは --start を使わない限り毎回最初から
やり直しになる点に注意(rows/startのページ送り自体は絞り込みが効かない
ことの確認以前の設計のままなので、途中終了時は上記の--startで明示的に
再開すること)。
"""

import argparse
import io
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / 'tools'))

# 取り込み時とまったく同じパーサを使う(判定のズレを防ぐため必ず再利用する)
from import_municipal_tourism_csv import (  # noqa: E402
    parse_csv_bytes, parse_xlsx_bytes,
)

DEFAULT_CACHE_DIR = REPO_ROOT / 'tools' / '.cache'
DEFAULT_OUT_DIR = DEFAULT_CACHE_DIR / 'collected'
DEFAULT_BUNDLE = DEFAULT_CACHE_DIR / 'tourism_bundle.zip'

# data.go.jp の CKAN エンドポイント。サイト構成の変更に備えて複数試す。
CKAN_SEARCH_ENDPOINTS = [
    'https://www.data.go.jp/data/api/3/action/package_search',
    'https://www.data.go.jp/api/3/action/package_search',
]

# 「観光」で拾うと観光「客数」等の統計データも大量に混ざる。名称に以下を
# 含むデータセット/リソースだけを対象にして無駄なダウンロードを減らす。
TITLE_HINTS = ('観光', '施設', 'スポット', '名所', '見所', '文化財', '公園')
# 逆に、明らかに位置情報を持たない統計系は名称段階で落とす。
TITLE_EXCLUDES = ('入込', '客数', '統計', '推移', 'アンケート', '消費', '宿泊者',
                  '経済波及', '動態', '実態調査')

WANTED_EXT = ('.csv', '.xlsx', '.zip')
USER_AGENT = 'journey-home-japan tourism opendata collector (+local use)'
MAX_BYTES = 30 * 1024 * 1024  # 1ファイル30MB上限(観光施設CSVは通常数十KB)


def http_get(url, timeout=60, retries=3):
    """GETしてバイト列を返す。失敗時はNone(収集は続行する)。"""
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': USER_AGENT})
            with urllib.request.urlopen(req, timeout=timeout) as res:
                data = res.read(MAX_BYTES + 1)
                if len(data) > MAX_BYTES:
                    return None  # 巨大ファイルは観光施設一覧ではないとみなす
                return data
        except (urllib.error.URLError, urllib.error.HTTPError, OSError) as e:
            last = e
            time.sleep(2 ** attempt)
    print(f'  [取得失敗] {url} ({last})', file=sys.stderr)
    return None


def ckan_search(rows, start):
    """CKAN package_search を叩く。エンドポイントは順に試す。

    2026-08-02判明: data.go.jpのこのエンドポイントは q/fq を渡しても
    サーバー側で一切絞り込まず、常に全データセットをそのまま返す
    (q='観光'・q='zzzzznonsense'・fq='title:*観光*' 等すべて同一件数・
    同一結果になることをユーザー環境で実測確認済み)。そのため検索語は
    送らず、全件をページングしてクライアント側(title_is_interesting)で
    絞り込む方式に倒している。"""
    params = urllib.parse.urlencode({'rows': rows, 'start': start})
    for base in CKAN_SEARCH_ENDPOINTS:
        data = http_get(f'{base}?{params}', timeout=60, retries=2)
        if not data:
            continue
        try:
            payload = json.loads(data.decode('utf-8'))
        except (ValueError, UnicodeDecodeError):
            continue
        result = payload.get('result')
        if isinstance(result, dict) and 'results' in result:
            return result
    return None


def title_is_interesting(title):
    t = title or ''
    if any(x in t for x in TITLE_EXCLUDES):
        return False
    return any(x in t for x in TITLE_HINTS)


def sanitize(name, fallback='data'):
    """zip内・ファイル名として安全な名前にする(日本語は残す)。"""
    name = re.sub(r'[\\/:*?"<>|\r\n\t]', '_', name or '')
    name = name.strip().strip('.')[:80]
    return name or fallback


def usable_records(data, filename, label):
    """取り込み時と同じパーサで、実際に取り出せるレコード数を返す。
    zipの場合は中のCSV/XLSXを見て合計する。"""
    lower = filename.lower()
    try:
        if lower.endswith('.csv'):
            return len(parse_csv_bytes(data, label))
        if lower.endswith('.xlsx'):
            return len(parse_xlsx_bytes(data, label))
        if lower.endswith('.zip'):
            total = 0
            with zipfile.ZipFile(io.BytesIO(data)) as zf:
                for info in zf.infolist():
                    if info.filename.endswith('/'):
                        continue
                    try:
                        inner = info.filename.encode('cp437').decode('cp932')
                    except (UnicodeDecodeError, UnicodeEncodeError):
                        inner = info.filename
                    il = inner.lower()
                    body = zf.read(info)
                    if il.endswith('.csv'):
                        total += len(parse_csv_bytes(body, inner))
                    elif il.endswith('.xlsx'):
                        total += len(parse_xlsx_bytes(body, inner))
            return total
    except ImportError:
        # openpyxl 未導入の環境。xlsxだけ判定できないので通す(取り込み側で処理)。
        print(f'  [注意] {label}: openpyxl が無いためxlsxを検証せず同梱します', file=sys.stderr)
        return 1
    except Exception as e:  # 壊れたzip/CSV等は捨てる
        print(f'  [解析不可] {label}: {e}', file=sys.stderr)
        return 0
    return 0


def iter_resources(dataset):
    org = ''
    if isinstance(dataset.get('organization'), dict):
        org = dataset['organization'].get('title') or ''
    ds_title = dataset.get('title') or ''
    for res in dataset.get('resources') or []:
        url = res.get('url') or ''
        if not url:
            continue
        res_name = res.get('name') or ''
        path = urllib.parse.urlparse(url).path
        ext = Path(path).suffix.lower()
        fmt = (res.get('format') or '').lower()
        if ext not in WANTED_EXT:
            # 拡張子が無くてもformat欄がcsv/xlsxなら拾う
            if fmt in ('csv', 'xlsx', 'zip'):
                ext = '.' + fmt
            else:
                continue
        # データセット名かリソース名のどちらかが観光っぽければ対象
        if not (title_is_interesting(ds_title) or title_is_interesting(res_name)):
            continue
        yield org, ds_title, res_name, url, ext


def load_manifest(path):
    if path.exists():
        try:
            return json.loads(path.read_text(encoding='utf-8'))
        except ValueError:
            pass
    return {'fetched': {}}


def report_expected_new(out_dir, data_dir):
    """収集済みファイルが既存placesに対して何件の新規になりそうか概算する。
    (取り込み側と同じ 同名 or 300m未満 の重複判定を使う)"""
    places_path = Path(data_dir) / 'places.json'
    if not places_path.exists():
        return
    try:
        from data_generator import grid_key, haversine_km
    except ImportError:
        return

    places = json.loads(places_path.read_text(encoding='utf-8'))['places']
    names = {p['name'] for p in places}
    buckets = {}
    for p in places:
        buckets.setdefault(p['gridKey'], []).append((p['lat'], p['lng']))

    def near(lat, lng):
        gx, gy = (float(v) for v in grid_key(lat, lng).split('_'))
        for dx in (-0.1, 0, 0.1):
            for dy in (-0.1, 0, 0.1):
                for c in buckets.get(f'{round(gx + dx, 1)}_{round(gy + dy, 1)}', []):
                    yield c

    total = new = url_new = 0
    seen = set()
    for path in sorted(Path(out_dir).rglob('*')):
        if path.suffix.lower() not in ('.csv', '.xlsx'):
            continue
        body = path.read_bytes()
        try:
            recs = (parse_csv_bytes(body, path.name) if path.suffix.lower() == '.csv'
                    else parse_xlsx_bytes(body, path.name))
        except Exception:
            continue
        for r in recs:
            total += 1
            key = (r['name'], round(r['lat'], 3), round(r['lng'], 3))
            if key in seen:
                continue
            seen.add(key)
            if r['name'] in names:
                continue
            if any(haversine_km(r['lat'], r['lng'], la, ln) < 0.3
                   for la, ln in near(r['lat'], r['lng'])):
                continue
            new += 1
            if r['officialUrl']:
                url_new += 1
    print(f'\n[見込み] 収集レコード {total}件 → 新規になりそうなもの 約{new}件'
          f'(うち公式URLあり 約{url_new}件)')
    print('  ※取り込み時に再計算されるため、あくまで目安です。')


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--out-dir', type=Path, default=DEFAULT_OUT_DIR,
                        help='ダウンロード先ディレクトリ')
    parser.add_argument('--bundle', type=Path, default=DEFAULT_BUNDLE,
                        help='まとめる先のzipパス(これをアップロードする)')
    parser.add_argument('--max-datasets', type=int, default=0,
                        help='走査するデータセット数の上限(0で無制限、全約18000件を舐める)')
    parser.add_argument('--start', type=int, default=0,
                        help='途中から再開する場合の開始位置(データセット通し番号)')
    parser.add_argument('--page-size', type=int, default=1000,
                        help='CKANの1回の取得件数(qによる絞り込みが効かないため大きめが既定)')
    parser.add_argument('--sleep', type=float, default=0.3,
                        help='ダウンロード間隔の秒数(相手サーバへの配慮)')
    parser.add_argument('--data', default='data', help='新規見込みの計算に使う既存データ')
    parser.add_argument('--no-report', action='store_true', help='新規見込みの計算を省く')
    args = parser.parse_args()

    out_dir = args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = out_dir / 'manifest.json'
    manifest = load_manifest(manifest_path)
    fetched = manifest['fetched']

    print('data.go.jpの全データセットをページングして走査します'
          '(q/fqによる絞り込みはサーバー側で効かないため、タイトル判定は'
          'ローカル側で行います)。')
    kept = skipped_empty = already = 0
    processed_datasets = 0
    start = args.start

    while True:
        result = ckan_search(args.page_size, start)
        if result is None:
            print(f'[警告] CKAN取得に失敗しました(start={start})。'
                  f'ネットワークかAPI仕様の変更が原因かもしれません。'
                  f'--start {start} で再開できます。', file=sys.stderr)
            break
        datasets = result.get('results') or []
        if not datasets:
            break
        count = result.get('count', 0)
        print(f'\n[走査] {start + 1}〜{start + len(datasets)} / 全{count}件'
              f'  (採用{kept} / 空{skipped_empty} / 既取得skip{already})')

        stop = False
        for ds in datasets:
            processed_datasets += 1
            if args.max_datasets and processed_datasets > args.max_datasets:
                stop = True
                break
            for org, ds_title, res_name, url, ext in iter_resources(ds):
                if url in fetched:
                    already += 1
                    continue
                time.sleep(args.sleep)
                data = http_get(url)
                fetched[url] = True
                if not data:
                    continue
                label = f'{org}/{ds_title}/{res_name}'
                fname = sanitize(f'{org}_{res_name or ds_title}') + ext
                n = usable_records(data, fname, label)
                if n <= 0:
                    skipped_empty += 1
                    continue
                dest = out_dir / fname
                i = 2
                while dest.exists():
                    dest = out_dir / (sanitize(f'{org}_{res_name or ds_title}') + f'_{i}' + ext)
                    i += 1
                dest.write_bytes(data)
                kept += 1
                print(f'  [採用] {dest.name} ({n}件) <- {ds_title}')

        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2),
                                 encoding='utf-8')
        start += len(datasets)
        if stop or start >= count:
            break

    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2),
                             encoding='utf-8')

    print(f'\n採用 {kept}件 / 中身が使えず不採用 {skipped_empty}件 / 取得済みskip {already}件')

    targets = [p for p in sorted(out_dir.rglob('*'))
               if p.suffix.lower() in ('.csv', '.xlsx', '.zip')]
    if not targets:
        print('同梱できるファイルがありませんでした。'
              'CKAN検索が失敗している場合はネットワーク(社内プロキシ等)を確認してください。',
              file=sys.stderr)
        raise SystemExit(1)

    args.bundle.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(args.bundle, 'w', zipfile.ZIP_DEFLATED) as zf:
        for p in targets:
            zf.write(p, p.name)
    size_mb = args.bundle.stat().st_size / 1024 / 1024
    print(f'\n書き出し完了: {args.bundle} ({len(targets)}ファイル, {size_mb:.1f}MB)')

    if not args.no_report:
        report_expected_new(out_dir, args.data)

    print(f'\nこのzipをアップロードしてください。取り込み側のコマンドは:\n'
          f'  python3 tools/import_municipal_tourism_csv.py '
          f'--zip {args.bundle} --data data --out data')


if __name__ == '__main__':
    main()
