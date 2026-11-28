# ミラーデスクトップで Firefox を使う

[English](firefox.md) | 日本語

576×288・16 階調の表示で Firefox を実用的に使うには、専用のプロファイルが必要です。
既定のプロファイルでは、ウィンドウが画面より広くレイアウトされて右端が切れます。
ツールバーは灰色で、グラスの上では常に光る帯になります。スクロールバーも消えます。
`scripts/pw-firefox.sh` は、これらを直したプロファイルで Firefox を起動します。

影響を受けるのは、このスクリプトが起動した Firefox だけです。デスクトップの Firefox と
プロファイルやプロセスを共有することはありません。

## セットアップ

`~/.pinhole-window/apps.conf`（[configuration.ja.md](configuration.ja.md#appsconf)）に、
チェックアウトの絶対パスを使って 1 行追加します。

```
app Firefox (G2) = /home/you/src/pinhole-window/scripts/pw-firefox.sh
```

再起動は不要です。`Firefox (G2)` がスマホの **apps** パレットに現れ、一度起動したあとは
グラスのメニューにも出ます。

Firefox は `.deb` パッケージか公式の tarball からインストールしたものを使ってください。
WSL2 では、snap パッケージはミラーデスクトップに接続できません
（[troubleshooting.ja.md](troubleshooting.ja.md#wsl2-で-firefox-が起動しない)）。

## ランチャがすること

1. `scripts/firefox-profile/` にあるプロファイルのテンプレートを、起動のたびにランタイム
   プロファイル（`~/.local/share/pinhole-window/firefox`）へコピーします。編集するのは
   テンプレートで、ランタイム側のコピーではありません。cookie、履歴、ログイン状態は
   ランタイムプロファイルにあり、消えません。
2. `<profile>/user-local.js` をプロファイルの `user.js` の末尾に追記します。このファイルは
   スクリプトが一度だけ作り、以後は上書きしません。トークンを含むホームページのように、
   このマシンに固有の設定はここに書きます。
3. Firefox を独立したインスタンスとして（`--no-remote --new-instance`、
   `MOZ_DBUS_REMOTE=0`）、X11 で、ウィンドウクラス `pinhole-window-firefox` で起動します。

| 変数 | 既定 | 意味 |
| --- | --- | --- |
| `PINHOLE_FIREFOX_PROFILE` | `~/.local/share/pinhole-window/firefox` | ランタイムプロファイルのディレクトリ |
| `PINHOLE_FIREFOX_URL` | 未設定 | ホームページの代わりに開く URL |
| `PINHOLE_FIREFOX_BIN` | `firefox` | Firefox のバイナリ |

### 起動時のページを決める

アプリケーション一覧からの起動では、ランチャに引数が渡されません。ホームページは
`<profile>/user-local.js` で設定します。

```js
user_pref("browser.startup.homepage", "https://<host>:<port>/?token=<token>");
```

シェルから 1 回だけ別の URL で起動するには:
`PINHOLE_FIREFOX_URL=https://example.org scripts/pw-firefox.sh`。

## プロファイルが変えるもの

| ファイル | 変更 | 理由 |
| --- | --- | --- |
| `userChrome.css` | ブラウザのクロームの最小幅を外す | そのままだと Firefox は最小ウィンドウ幅を 638 px と申告し、576 px の画面より広くなります。ほかの変更はすべてこれが前提です。 |
| `userChrome.css` | クローム、メニュー、URL バー、通知バーを純黒にし、緑のアクセントを付ける | 組み込みのダークテーマは濃い灰色で、発光型の表示では光り続けます |
| `user.js`、`userChrome.css` | タブをサイドバーのレールに置く（`sidebar.verticalTabs`）。横のタブストリップは畳む | 288 px では高さのほうが貴重です。タブが見えていれば、新しいタブで開いたリンクから戻れます |
| `user.js` | 初回起動のページ、確認、催促を無効にする | モーダルダイアログはジェスチャでは閉じにくい |
| `user.js` | 細く、常に表示されるスクロールバー | スクロールはスワイプで行うので、バーは現在位置を知る唯一の手がかりです |
| `user.js` | デスクトップのユーザエージェント。`meta viewport` の処理は無効 | 576 px では、ほとんどのレスポンシブなサイトがすでに 1 カラムのレイアウトになります。モバイル版は固定ヘッダが加わり、高さを消費します。 |
| `userContent.css` | 3 px の緑のフォーカスリング、テキスト欄に破線の枠 | 既定の細いリングは 16 階調では消えます |
| `userContent.css` | 空白ページを黒にする | 白いフラッシュはレンズ全体を光らせます |
| `pw-firefox.sh` | `GTK_THEME=Adwaita:dark` | ファイル選択などのネイティブのダイアログには CSS が届きません |

アンチエイリアスは、ミラーデスクトップ上のすべてのアプリケーションですでに無効なので、
ランチャはフォントについては何もしません。

ページに画面全体を使わせるには `F11` を押します。全画面モードではタブのレールと
ツールバーが隠れます。タブを選ぶときはもう一度押します。

## うまくいったか確かめる

ミラーデスクトップ（既定ではディスプレイ `:100`。サーバのログが `127.0.0.1:100` と
表示している場合はそのアドレス）で:

```bash
win=$(DISPLAY=:100 xdotool search --onlyvisible --class pinhole-window-firefox | head -1)
DISPLAY=:100 xprop -id "$win" WM_NORMAL_HINTS WM_CLASS
DISPLAY=:100 xwininfo -id "$win" | grep -E 'Width|Height'
```

`program specified minimum size` が 576 未満（同梱のテンプレートでは 387 by 1）で、
ウィンドウが 576×288、ページの右端が見えていれば成功です。ミラーデスクトップに触れずに
試すには、使い捨てのサーバで同じ確認をします。

```bash
export DISPLAY=:199
Xvfb :199 -screen 0 576x288x24 -nolisten tcp &
until xdpyinfo >/dev/null 2>&1; do sleep 0.2; done
PINHOLE_FIREFOX_URL=about:blank scripts/pw-firefox.sh &
```

## それでもウィンドウが広すぎるとき

最小幅はツールバーの中身で変わるので、拡張機能によって再び 576 を超えることがあります。
`<profile>/user-local.js` で、次の順に試してください。

1. `user_pref("layout.css.devPixelsPerPx", "0.9");` — 文字列の設定です。すべての CSS
   ピクセルが縮むので、最小幅も縮みます。文字は小さくなります。
2. それでも足りなければ `"0.85"`。
3. `--kiosk` で起動してクロームを完全に消す。URL バーもタブ一覧も無くなるので、行き先は
   ホームページだけになります。

## テンプレートを変更する

- `user.js` から設定を消しても、一度起動したプロファイルでは解除されません。Firefox が
  `user.js` の値を `prefs.js` に書き写すためです。設定名を `pw-firefox.sh` の
  `RETIRED_PREFS` に追加すると、ランチャがそれを取り除きます。
- モバイルのユーザエージェントを使うには、`user-local.js` で
  `general.useragent.override` を設定します。すべてのサイトに適用されます。Firefox は
  サイトごとの上書きをもうサポートしていません。

背景: [Firefox minimum width investigation](notes/2026-10-firefox-minimum-width.md)。
