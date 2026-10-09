# even-window — 内部契約 (CONTRACT)

この文書は**実装者間の唯一の整合点**。各モジュールはここに書かれた型・経路・定数だけに依存する。
変更する場合はこの文書を先に直す。

## 1. 幾何（`src/shared/geom.ts` が唯一の出典）

```
SCREEN_W = 576   SCREEN_H = 288
TILE_W   = 288   TILE_H   = 144    TILES = 4
TILE_XY  = [[0,0],[288,0],[0,144],[288,144]]   // TL, TR, BL, BR
FRAME_BYTES = 576 * 288 * 3                     // ffmpeg rgb24 1フレーム
```

左眼 = TL(0) + BL(2) / 右眼 = TR(1) + BR(3)。

## 2. グラスのコンテナ割り当て（固定・変更禁止）

| containerID | 種別 | 用途 |
|---|---|---|
| 1 | TextContainerProperty 576x288 `content:' '` `isEventCapture:1` | 透明な入力捕捉層 |
| 2 | ImageContainerProperty 288x144 @(0,0) | タイル TL |
| 3 | ImageContainerProperty 288x144 @(288,0) | タイル TR |
| 4 | ImageContainerProperty 288x144 @(0,144) | タイル BL |
| 5 | ImageContainerProperty 288x144 @(288,144) | タイル BR |

`containerTotalNum = 5`。画像コンテナは最大4なのでこれで使い切り。
**containerID = 2 + tileIndex**。

> SDK 0.0.10 では z-order フィールドが無く、画像とテキストは同一面 last-write-wins。
> 入力捕捉層(id1)が4タイルに重なるのは正常。可視内容の重畳はレイアウトで回避する。

## 3. サーバ HTTP / SSE 契約

既定ポート `8787`（`EW_PORT`）。bare `node:http`。CORS は `*` を許可（sim/devのため）。

### `GET /api/stream` — SSE
```jsonc
{"t":"tile",    "i":0, "png":"<base64 indexed PNG>"}   // 変化したタイルのみ
{"t":"avail",   "ok":true}                              // X が使える
{"t":"avail",   "ok":false, "msg":"Xephyr not found"}   // 使えない理由
{"t":"windows", "list":[WinInfo, ...]}                  // 窓集合が変化したとき
```
新規購読者には即座に `avail` → 最新 `windows` → 保持中の4タイルを配信（プライム）。

### `GET /api/health`
```jsonc
{"ok":true,"display":":100","backend":"Xephyr","pid":12345,"fps":10}
```

### `GET /api/windows`
```jsonc
{"list":[{"id":"1","xid":"0x400001","cls":"XTerm","title":"xterm","active":true,"app":"xterm"}]}
```
`WinInfo` = `{ id: string; xid: string; cls: string; title: string; active: boolean; app?: string }`
`id` は ratpoison のウィンドウ番号（**再利用されるので永続キーにしない**）。

### `POST /api/windows`
body `{"sel":"1"}` | `{"xid":"0x400001"}` → `{"ok":true}` / `{"ok":false,"msg":"..."}`

### `POST /api/windows/close`
body `{"sel":"1"}` → `{"ok":true}`（WM_DELETE_WINDOW。kill しない）

### `POST /api/spawn`
body `{"cmd":"xterm","args":[]}` → `{"ok":true}`

### `POST /api/input`
body `{"gesture":"tap"|"double"|"up"|"down","count"?:number}` → `{"handled":boolean}`
`count` は move-N 用（省略時 1、1 未満は 1 にクランプ）。

### `POST /api/x11/input` — 低レベル直接注入（デバッグ/将来用）
body `{"kind":"key"|"type"|"click"|"dblclick"|"move"|"clickat"|"down"|"up","arg":"..."}`

## 4. クライアント（WebView）側の責務

1. `waitForEvenAppBridge()` → `establishPage()`（§2 のレイアウトで `createStartUpPageContainer`、**その後必ず `rebuildPageContainer`**）
2. `GET /api/stream` を購読。`tile` を受けたら indexed PNG を decode → グレー化 → PNG 再エンコード → `frameTiles[i]` に置く
3. `pumpTiles()` が**直列**に `updateImageRawData` する。**dequeue 時に最新バイトを取得**し、`lastTiles[i]` と等しければ送らない
4. `bridge.onEvenHubEvent` → 正規化 → de-burst → ジェスチャを `POST /api/input` へ

### 絶対に守る不変条件（実機で壊れた履歴あり）

- **establish は一度だけ。以降は差分 push のみ。rebuild を重ねない。**
  ストリーミング中に `rebuildPageContainer` を呼ぶ経路を作らない。右レンズが黒落ちする。
- `updateImageRawData` は**直列**。並行呼び出し禁止。
- フレームは**キューに積まず最新で上書き**（coalesce）。
- `shutDownPageContainer(0|1)` は**アプリ終了**。ページ再確立の手段ではない。

## 5. 入力の正規化（`src/shared/evenEvent.ts`）

`evenGestureType(event)` が返す: `'tap' | 'double' | 'up' | 'down' | null`

- `CLICK_EVENT` は protobuf enum 0 なので**ワイヤから省略される**。`eventType` が `undefined` でも
  envelope が存在すれば tap として扱う。envelope 自体が無ければ `null`。
- Hub は **CLICK を DOUBLE_CLICK より先に出す**ので、tap は 180ms 遅延させ、
  その間に double が来たらキャンセルする。
- de-burst: 同種連打を swipe 140ms / tap・double 90ms で間引く。
- `SCROLL_TOP_EVENT` → `'up'`、`SCROLL_BOTTOM_EVENT` → `'down'`。

## 6. スワイプ・デバウンス（`NAV_SETTLE_MS = 600`）

leading-edge: 1発目は即時 `count=1` で送る。以後 600ms 以内の**同方向**の追随だけ溜め、
settle 後に **1回の move-N** で送る。方向転換・アイドル後は新たな leading edge。
`tap`/`double` は送信前に `flushNav()` を await する（位置ズレ防止）。

## 7. ジェスチャの割り当て（PoC）

| ジェスチャ | 動作 |
|---|---|
| swipe up / down | ネストXへ `Up`/`Down` キー送出（move-N 対応） |
| tap | ネストXへ `Return` 送出 |
| double | **ウィンドウ切替メニューを開く**（グラスのネイティブ context menu） |

### ウィンドウ切替 UI

`menuObject.menuItems` に窓リストを載せる。**最大10項目**、`itemID` は非0で一意、
`itemName` は 32 UTF-8 バイトまで。選択は `menuItemClickEvent.itemID` で届く。

> ⚠ SDK 0.0.10 では `listObject` が `rebuildPageContainer` で拒否されることが heimterm で
> 実測されている。`menuObject` は別APIだが**未検証**。動かなければタイルに直接描くか、
> テキストコンテナのオーバーレイにフォールバックする。
>
> menuObject は `createStartUpPageContainer` / `rebuildPageContainer` の引数なので、
> 「メニューを出すために rebuild する」のは §4 の不変条件に抵触する。
> **起動時に一度だけメニューを登録し、中身の更新が必要なときだけ再登録する**こと。
> 窓リストが変わる頻度は低いので実用上問題にならない。

## 8. ネストX のライフサイクル

- `Xephyr :N -screen 576x288x24 -resizeable -ac -listen tcp`、失敗したら `Xvfb :N -screen 0 576x288x24`
- WM は `ratpoison`（monocle・装飾なし・白地黒文字・`unmanage ratmenu`）
- **X スタックは detached で起動し、node プロセスより長生きする。** 死ぬのは ffmpeg だけ。
  再起動時は状態ファイルから再アタッチする（新しい X を立て直さない）
- display 番号は `EW_X11_DISPLAY`（既定 `:100`）、ランタイム dir は `EW_X11_RUNTIME_DIR`
  （既定 `<repo>/.ew-x11`）。**heimterm と衝突させない**
- 子プロセスには必ず: `delete WAYLAND_DISPLAY`, `GDK_BACKEND=x11`, `MOZ_ENABLE_WAYLAND=0`,
  `FONTCONFIG_FILE=<generated>`（`antialias=false` 強制）

## 9. キャプチャ

```
ffmpeg -f x11grab -draw_mouse 0 -video_size 576x288 -framerate $EW_FPS \
       -i $DISPLAY -pix_fmt rgb24 -f rawvideo -
```
`-draw_mouse 0` はネストXが xcb のポインタ問い合わせに失敗するため。カーソルは
クライアント側で合成する。stdout を `FRAME_BYTES` 単位で厳密にフレーミングし、
ズレたら desync ガードで再同期する。

タイル分割後、**`Buffer.equals` で前フレームと比較し変化したタイルだけ**エンコード・配信。

## 10. 環境変数一覧

| 変数 | 既定 | 意味 |
|---|---|---|
| `EW_PORT` | `8787` | HTTP ポート |
| `EW_X11_DISPLAY` | `:100` | ネスト X の display |
| `EW_X11_RUNTIME_DIR` | `<repo>/.ew-x11` | 状態ファイル/ソケット/fonts.conf |
| `EW_FPS` | `10` | ffmpeg の framerate |
| `EW_BACKEND` | `auto` | `auto` \| `xephyr` \| `xvfb` |
| `EW_SPAWN` | `xterm` | 起動時に投入するクライアント（空なら何も出さない） |
| `EW_AA` | `0` | `1` でアンチエイリアスを許可（比較実験用） |

## 11. 出典

`src/` の各ファイル先頭に、heimterm から逐語コピーした範囲を
`// Derived from heimterm <path>:<lines> (MIT, (c) 2026 Suna.S)` の形で明記する。
