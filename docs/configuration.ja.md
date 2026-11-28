# 設定

[English](configuration.md) | 日本語

pinhole-window は `PINHOLE_*` 環境変数（env ファイルに置くこともできます）と、状態ディレクトリ内の
3 つのファイルで設定します。

## 優先順位

環境変数、env ファイル、組み込みの既定値の順です。env ファイルは未設定の変数だけを埋め、
起動時のバナーはファイルから取った設定をすべて名指しします。変更はサーバの再起動で
反映されます。

## 環境変数

### ネットワークと認証

| 変数 | 既定 | 意味 |
| --- | --- | --- |
| `PINHOLE_HOST` | `127.0.0.1` | バインドするアドレス。サーバは TLS を終端しないので、ループバックのままにして前段に TLS プロキシを置いてください。ほかのアドレスにバインドすると起動のたびに警告します。 |
| `PINHOLE_PORT` | `8787` | HTTP ポート。 |
| `PINHOLE_AUTH` | 強制 | 認証を無効にするのは `0`、`off`、`false`、`no` だけです。それ以外の値は、タイプミスを含めてすべて強制のままです。 |
| `PINHOLE_ORIGIN` | 未設定 | 端末がダイヤルする URL。例: `https://host.ts.net:8443`。設定すると、サーバはほかのオリジン宛てに作られたセッション署名を拒否します。未設定の場合、署名は検証しますがオリジンは比較しません。`*` やホスト名だけのように絶対 URL でない値は使えず、比較は行われないままになります。どの状態かはバナーが表示します。 |
| `PINHOLE_MAX_CLIENTS` | `1` | 登録できる端末鍵の最大数。`0`、`unlimited`、`off`、`none` で上限なし。10 進の整数でない値は `1` として扱います。上限より多くの鍵が登録されていると、サーバは起動を拒否します。 |
| `PINHOLE_ORIGINS` | 未設定 | CORS で許可するオリジン（カンマ区切り）。`*` ですべて許可。未設定の場合、認証が有効ならすべてのオリジンを許可し、`PINHOLE_AUTH=0` ならループバックのオリジンとサーバ自身のホストだけを許可します。リストを指定すると、その 2 つと指定したオリジンだけに絞られます。`PINHOLE_ORIGIN` とは無関係です。[security.md](security.md#cors) を参照。 |

### ミラーデスクトップ（Linux バックエンド）

| 変数 | 既定 | 意味 |
| --- | --- | --- |
| `PINHOLE_X11_DISPLAY` | `:100` | ネストした X サーバのディスプレイ番号。 |
| `PINHOLE_X11_RUNTIME_DIR` | `<チェックアウト>/.pw-x11` | ネストした X セッションのランタイムファイル。 |
| `PINHOLE_BACKEND` | `auto` | `auto`、`xephyr`、`xvfb`。`auto` はホストのディスプレイがあれば Xephyr を先に、なければ Xvfb を先に試し、だめならもう一方に切り替えます。バックエンドを固定した場合は切り替えません。 |
| `PINHOLE_HOST_DISPLAY` | 自動検出 | Xephyr がウィンドウを出すホストのディスプレイ。`DISPLAY`、次に `/tmp/.X11-unix` の最小番号のソケットから検出します。空にすると「ホストのデスクトップは無い」という指定になり、Xvfb を優先します。 |
| `PINHOLE_SPAWN` | 暗い背景の xterm | 空のミラーデスクトップで起動するプログラム。空にすると何も起動しません。`;` で区切って複数のコマンドを書くと、すべて起動し、先頭のものが表示された状態になります。先頭のコマンドは **New terminal** が開くものでもあります。コマンドの中に `;` は書けません。既定は、黒背景・白文字・9×18 の太字ビットマップフォント・枠なし・スクロールバーなしの `xterm` です。 |
| `PINHOLE_SPAWN_CWD` | `$HOME` | 起動するプログラムの作業ディレクトリ。先頭の `~` は展開され、相対パスは `$HOME` から解釈されます。ディレクトリでないパスは、警告を出して `$HOME` に切り替えます。 |
| `PINHOLE_FPS` | `10` | キャプチャのレート。1〜30。 |
| `PINHOLE_AA` | `0` | `1` でミラーデスクトップのフォントのアンチエイリアスを許可します。灰色のにじみは 16 階調への量子化と相性が悪いため、既定では無効です。 |

既定のクライアントは暗い背景のままにしてください。グラスは光学シースルーなので、黒は
透明になり、明るい背景はレンズ全体を光らせます。

### 状態と診断

| 変数 | 既定 | 意味 |
| --- | --- | --- |
| `PINHOLE_STATE_DIR` | `~/.pinhole-window` | 状態ディレクトリ。絶対パスで指定します。 |
| `PINHOLE_ENV_FILE` | 未設定 | env ファイルの明示指定。空は「ファイルを読まない」という意味です。 |
| `PINHOLE_QUIET` | 未設定 | `1` でリクエストごとのアクセスログを止めます。 |

### 音声入力

| 変数 | 既定 | 意味 |
| --- | --- | --- |
| `PINHOLE_STT_URL` | 未設定 | OpenAI 互換の `POST /v1/audio/transcriptions` エンドポイントの URL。未設定なら音声入力は無効です。 |
| `PINHOLE_STT_MODEL` | `Qwen3-ASR-0.6B` | 認識サービスに送るモデル ID。認識サービスの `/v1/models` が返す ID でなければなりません。 |
| `PINHOLE_STT_LANG` | 未設定 | 言語のヒント。例: `en`。未設定なら送りません。 |
| `PINHOLE_STT_PROMPT` | 未設定 | `prompt` として渡す語彙のヒント。言っていないときにその語が聞き取られやすくなる副作用もあります。 |
| `PINHOLE_STT_OPTIONS` | 未設定 | 認識サービスに追加で送るフォーム項目。`名前=値` を `&` でつなぎます（URL のクエリと同じ書式）。既定では何も足しません。使える項目は認識サービスごとに違います（[voice.md](voice.md#recogniser-options)）。400 を返す認識サービスには、これらの項目なしで送り直します。 |
| `PINHOLE_STT_API_KEY` | 未設定 | OpenAI などホスト型の認識サービスの API キー。`Authorization: Bearer` として送ります。ローカルの認識サービスには不要です。秘密情報なので env ファイル（モード 600）に置いてください。設定した場合、`PINHOLE_STT_URL` はこのマシン宛て以外では `https` でなければなりません。[voice.md](voice.md#a-hosted-recogniser) を参照。 |
| `PINHOLE_STT_DUMP_DIR` | 未設定 | 調査用。発話ごとに、認識サービスへ送った WAV と、返ってきた文字列の `.txt` を置くディレクトリ。新しい 20 件だけ残します。自分の声の録音なので、普段は未設定のままにしてください。[voice.md](voice.md#keeping-the-audio-for-diagnosis) を参照。 |

### クライアントの開発サーバ（Vite）

サーバではなく `vite.config.ts` が読みます。env ファイルからは読まれません。

| 変数 | 既定 | 意味 |
| --- | --- | --- |
| `PINHOLE_ALLOWED_HOSTS` | 未設定 | Vite が追加で受け付ける `Host` 名（カンマ区切り）。`.ts.net` は常に受け付けます。 |
| `PINHOLE_HMR_HOST` | 未設定 | ページを TLS プロキシ越しに配信するとき、ホットリロードのクライアントが接続し直す先のホスト。 |
| `PINHOLE_HMR_PORT` | `443` | 同じくポート。`PINHOLE_HMR_HOST` を設定したときだけ使われます。 |

### スクリプト

| 変数 | 読むもの | 既定 | 意味 |
| --- | --- | --- | --- |
| `PINHOLE_APP_URL` | `pw-auth.mjs` | 未設定 | `pair` と `open` で、引数に URL を渡さなかったときに使うアプリの URL。 |
| `PINHOLE_PAIR_TTL_MS` | `pw-auth.mjs open` | `300000` | `open` で開くペアリング窓の有効時間。`pair` は常に 2 分です。 |
| `PINHOLE_FIREFOX_PROFILE` | `pw-firefox.sh` | `~/.local/share/pinhole-window/firefox` | Firefox のランタイムプロファイルのディレクトリ。 |
| `PINHOLE_FIREFOX_URL` | `pw-firefox.sh` | 未設定 | プロファイルのホームページの代わりに開く URL。 |
| `PINHOLE_FIREFOX_BIN` | `pw-firefox.sh` | `firefox` | Firefox のバイナリ。 |
| `PINHOLE_SIM_DISPLAY`、`PINHOLE_SIM_SCREEN`、`PINHOLE_AUTOMATION_PORT`、`PINHOLE_SETTLE_MS`、`PINHOLE_APP_QUERY` | `sim.sh` | `:180`、`608x1150`、`9899`、`6000`、未設定 | シミュレータのハーネスの設定。[development.md](development.md) を参照。 |

`pw-auth.mjs` は `PINHOLE_STATE_DIR`、`PINHOLE_MAX_CLIENTS`、`PINHOLE_ENV_FILE` にも従うので、サーバと同じ
レジストリを同じ上限で編集します。`PINHOLE_X11_DISPLAY_ENV` はサーバが子プロセスのために
設定する変数です。自分では設定しないでください。

## env ファイル

`PINHOLE_ENV_FILE` を設定すると、サーバはそのファイルだけを読みます。設定しない場合は次の
2 つを両方読み、両方にあるキーは先のファイルの値を使います。

1. `~/.pinhole-window/env`
2. `$XDG_CONFIG_HOME/pinhole-window/env`（既定では `~/.config/pinhole-window/env`）

systemd のユニットも同じ 2 つのファイルを指定していて、結果は同じです。サーバの起動方法で
設定が変わることはありません。

この場所は `PINHOLE_STATE_DIR` には追従しません。`systemd/env.example` を出発点にしてください。

```bash
install -m 600 systemd/env.example ~/.pinhole-window/env
```

書式は systemd の `EnvironmentFile=` の厳密なサブセットなので、同じファイルが手動起動でも
systemd ユニットでも使えます。

```
# コメントは # か ; で始める
PINHOLE_ORIGIN=https://host.ts.net:8443
PINHOLE_MAX_CLIENTS=1
PINHOLE_SPAWN="xterm -bg black -fg white"
```

| 規則 | 詳細 |
| --- | --- |
| 1 行に 1 つの `KEY=VALUE` | `=` の前後に空白を置かない、`export` を付けない、行を継続しない。規則に反する行は、理由を示すメッセージとともに拒否されます。 |
| `PINHOLE_*` のキーだけ | `PATH` などほかのキーは拒否されます。 |
| 値はリテラル | `$VAR` も `~` も展開しません。対応する引用符を 1 層だけ外します。 |
| パーミッション | グループやその他のユーザが書き込めるファイルは、警告を出して丸ごと無視します。モードは `600` にしてください。 |
| source しない | ファイルは解析されるだけで、実行されません。シェルから `source` するのも避けてください。 |

背景: [the env file format](decisions/env-file-format.md)。

## 状態ディレクトリ

`~/.pinhole-window`、または `PINHOLE_STATE_DIR`。モード `700` で作られます。既存のディレクトリが
ほかのユーザから読める場合、サーバは警告しますが、モードを勝手には変えません。

| ファイル | 書き手 | 内容 |
| --- | --- | --- |
| `env` | 利用者 | 設定（上記） |
| `clients.json` | `pw-auth.mjs`、サーバ | 登録済みの端末鍵 |
| `server-secret` | サーバ | トークン署名用の秘密。`pw-auth.mjs rotate` が置き換えます |
| `pending.json`、`pairing.json` | サーバ、`pw-auth.mjs` | 進行中のペアリング |
| `apps.conf` | 利用者 | アプリケーション一覧の上書き |
| `apps-recent.json` | サーバ | 最近起動したアプリケーション |
| `bindings.json` | サーバ | アプリケーションごとの割り当て |

このディレクトリのコピーは資格情報として扱ってください。`server-secret` があれば、
登録済みのどの端末のトークンでも偽造できます。[security.md](security.md) を参照してください。

Linux バックエンドは、ランタイムファイル（`session.json`、生成したウィンドウマネージャと
フォントの設定）をチェックアウト内の `.pw-x11/`（`PINHOLE_X11_RUNTIME_DIR`）に置きます。

## `apps.conf`

ランチャには、サーバがそのマシンで見つけたアプリケーションが並びます。`apps.conf` は
その一覧を調整するファイルです。手で書くファイルで、1 行に 1 ディレクティブ、`#` で
始まる行はコメントです。サーバは更新時刻が変わると読み直すので、再起動は不要です。

| ディレクティブ | 効果 |
| --- | --- |
| `hide <id \| コマンド \| 名前>` | 走査で見つかった項目を外す |
| `show <コマンド>` | 組み込みの除外リストが外しているコマンドを戻す |
| `app <名前> = <コマンドライン>` | 項目を追加する |
| `term <名前> = <コマンドライン>` | ターミナルの中で動かす項目を追加する |

```
# pinhole-window application overrides
hide xeyes
show xdpyinfo
app Clock = xclock -digital
term Top = top
app Firefox (G2) = /home/you/src/pinhole-window/scripts/pw-firefox.sh
```

コマンドラインは引数に分割され、シェルを通さず直接実行されます。文法エラーは起動時の
バナーと `GET /api/apps` の `errors` フィールドに出ます。スマホの **apps** パレットの
**rescan** ボタンは、パッケージの走査もやり直します。一覧の作り方は
[platform.md](platform.md) にあります。

## `bindings.json`

アプリケーションごとの割り当てです。スワイプが何を送るか、**Submit** が本文のあとに何を
押すか、改行が何になるか、**font −/+** が何を押すかを決めます。このファイルはスマホの
**app** パネルが書きます（[usage.ja.md](usage.ja.md#アプリケーションごとの割り当て)）。
手で編集してサーバを再起動することもできます。

```json
{
  "bindings": {
    "comm:less": {
      "up": { "mods": [], "key": "Page_Up" },
      "down": { "mods": [], "key": "Page_Down" }
    },
    "comm:firefox": {
      "up": { "mods": [], "key": "WheelUp" },
      "down": { "mods": [], "key": "WheelDown" },
      "submit": "ctrl+Return",
      "newline": "shift+Return",
      "fontsize": "ctrl+equal"
    }
  }
}
```

| フィールド | 値 |
| --- | --- |
| `up`、`down`（必須） | `{ "mods": [...], "key": ... }`。`mods` は `ctrl`、`alt`、`shift` の任意の組み合わせ。`key` は `src/shared/keys.ts` のカタログにある名前で、`WheelUp` と `WheelDown` も使えます。 |
| `submit` | `off`、`Return`、`ctrl+Return`、`shift+Return`、`alt+Return`、`Tab`、`ctrl+s`、`ctrl+d` |
| `newline` | `Return`、`ctrl+Return`、`shift+Return`、`alt+Return` |
| `fontsize` | `shift+KP`、`ctrl+equal`、`ctrl+plus`、`ctrl+shift+equal`、`ctrl+shift+Page`、`emacs`、`ctrl+wheel` |

任意のフィールドを省略すると「指定なし」という意味になり、より一般的なエントリの値を
継承します。不正なエントリはそれだけが捨てられ、起動時と `GET /api/bindings` で報告
されます。ファイルの残りは読み込まれます。

### 割り当てのキー

| キーの形式 | 一致する対象 |
| --- | --- |
| `app:<ランチャの id>` | pinhole-window のランチャで、その id の項目から起動したウィンドウ。例: `app:desktop:xmountains`。サーバは起動をメモリ上で覚えているので、再起動するとこの対応は失われます。 |
| `exe:<絶対パス>` | ウィンドウのプロセスの実行ファイル。例: `exe:/usr/bin/xterm` |
| `comm:<名前>` | プロセス名。例: `comm:vim` |
| `cls:<クラス>` | ウィンドウクラス（小文字）。例: `cls:firefox` |
| `title:<タイトル>` | ウィンドウのタイトル。ほかに身元を持たないウィンドウでだけ候補になります。 |
| `*` | すべてのアプリケーション |

各フィールドは別々に解決されます。順序は `app:`、`exe:`、`comm:`、`cls:`、`title:`、`*`、
そして組み込みの既定値（スワイプは `Up` と `Down`、`submit` は `off`、`newline` は
`Return`、`fontsize` は `shift+KP`）です。`electron`、`java`、`python3` のようなラッパーの
ランタイムには `comm:` や `exe:` を使わないでください。同じランタイムで動くすべての
プログラムに一致してしまうので、その場合は `cls:` を使います。
