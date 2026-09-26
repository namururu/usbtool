# Portable Codex GUI for Windows

Windows 用 Codex CLI を、GUI・Node.js・Python と一緒に USB や任意のフォルダから起動するためのポータブルセットです。設定、ログイン状態、履歴、成果物、作業フォルダはセット内に保存されます。

## すぐ使う

Windows x64 完成版: **[usb.zip をダウンロード](https://github.com/namururu/usbtool/releases/download/auto-latest/usb.zip)**

1. ZIP を展開します。パスに空白があっても動作します。
2. 通常は `start.bat` をダブルクリックします。
3. 「ログインしてください」と表示されたら、GUI のログインボタンから ChatGPT にログインします。

PowerShell の実行ポリシーは BAT 側でプロセス単位に回避するため、通常は変更不要です。

## 起動方法

| ファイル | 用途 |
| --- | --- |
| `start.bat` | 通常のローカル GUI。まずこれを使用 |
| `start-admin.bat` | 管理者権限が必要な Windows 操作用 |
| `start-lan.bat` | 同じ LAN の別端末から共有 |
| `start-lan-admin.bat` | LAN 共有と管理者権限を併用 |
| `start-remote.bat` | `misao.local` 用の常設リモートコンソール |
| `Login-Codex.bat` | ログインだけを実行 |
| `clean.bat` | ローカル状態のクリーンアップ |

管理者版は Codex の共有デーモンへ管理者権限を引き継がせないため、自動的に `--no-daemon` を使用します。通常版で足りない作業にだけ使ってください。

GUI の既定 URL は `http://127.0.0.1:41731` です。停止は起動したコンソールを閉じるか、`Stop-CodexGui.ps1` を実行します。

## モデルと権限

モデルはチャット画面上部から変更できます。通常は `Codex既定` が推奨です。明示指定として GPT-6 Astra、GPT-6 Sol、GPT-6 Luna と従来の 5.x 系を表示します。アカウントや Codex CLI の対応状況により、選択したモデルを利用できない場合があります。

| 権限モード | 内容 |
| --- | --- |
| `workspace-write` | 作業フォルダ内を書き込み可能 |
| `danger-full-access` | ファイルシステムとネットワークへ広くアクセス |
| `bypass` | 承認とサンドボックスを迂回する全ツッパリ |
| `read-only` | 読み取り中心 |

`bypass` と管理者起動を組み合わせると、その PC 全体へ強い操作権限を持ちます。内容を理解できる作業でだけ使用してください。

## 保存場所

| パス | 内容 |
| --- | --- |
| `data/codex-home` | Codex 設定、ログイン・セッション情報 |
| `data/artifacts` | AI が作成・回収した成果物 |
| `data/generated_images` | 生成画像 |
| `data/uploads` | 添付ファイル |
| `workspaces` | 既定の作業場所 |
| `tools` | Node.js、Codex CLI、Python |

ログイン後の `data/codex-home` には認証情報が含まれます。USB 本体をパスワードと同等に扱ってください。公開 ZIP にはこのフォルダの中身を含めていません。

## LAN 共有

`start-lan.bat` を起動すると、コンソールに共有 URL とランダムな長いパスワードが表示されます。同じ LAN の端末から URL を開き、パスワードを入力すると GUI、履歴、成果物へアクセスできます。

LAN 共有は暗号化されない HTTP です。家庭内・社内など信頼できるネットワークだけで使い、インターネットへ直接ポート公開しないでください。パスワードを知る人は Codex の実行やファイル閲覧ができます。遠隔利用には VPN や認証付き HTTPS リバースプロキシを別途使用してください。

## misao.local リモートコンソール

遠隔端末として常設する場合は `start-remote.bat` を起動します。初回に強い管理パスワードを生成し、次の URL と一緒にコンソールへ表示します。

```text
http://misao.local:41731
```

設定は `data/remote-console.json` に保存され、再起動後も同じ URL とパスワードを使用します。起動後はバックグラウンドで動くため、`Remote console is running in the background.` と表示されたら黒い画面を閉じて構いません。稼働ログは `data/remote-console.log`、エラーは `data/remote-console.err.log` に保存されます。PCを再起動した場合は `start-remote.bat` をもう一度実行してください。

パスワードを作り直す場合は次を実行します。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Start-CodexRemote.ps1 -ResetPassword
```

`misao.local` が名前解決できない端末では、起動画面に表示される LAN IP を使って `http://<LAN-IP>:41731` を開いてください。Windows のコンピューター名を `misao` にし、ネットワークで mDNS が利用可能なら `misao.local` でアクセスできます。

未ログインまたはトークン失効時に「ログイン」を押すと、遠隔画面へ ChatGPT のデバイス認証 URL とワンタイムコードを表示します。認証後は同じ画面から対話でき、「ログアウト」で保存済み認証を解除できます。認証ファイルそのものをブラウザへ送信することはありません。

このモードも HTTP のため、信頼できる LAN または VPN 内だけで使用してください。インターネットへ直接公開しないでください。

## ローカル Agent API

別の Codex やツールから操作する場合は、GUI と同じサーバーの JSON API を使用できます。

```text
GET  /api/agent
POST /api/agent/run
GET  /api/agent/jobs/{id}
GET  /api/agent/jobs/{id}/events
POST /api/agent/jobs/{id}/stop
GET  /api/agent/files/artifacts
GET  /api/agent/files/images
GET  /api/agent/files/uploads
```

起動中に `http://127.0.0.1:41731/agent-api` を開くと、AI 向けの短い利用説明を確認できます。元ファイルは `AGENT_API_KISWAHILI.md` です。

## 自動更新

起動時に公開リリースを確認し、GUI・スクリプト類に更新があれば取得します。更新 ZIP はマニフェスト記載の SHA-256 と一致しない限り適用しません。`data`、`tools`、`workspaces` は上書きしません。

Codex CLI は起動時に一定間隔で npm の最新版を確認します。手動確認は次のコマンドです。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Update-Codex.ps1
```

## クリーンアップ

履歴、添付、生成画像、ログ、一時ファイルを消し、ログインは残します。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Clean-UsbCodex.ps1
```

確認だけは `-WhatIf`、ログイン情報も消す場合は `-Auth`、作業フォルダも消す場合は `-Workspaces`、すべてのローカル状態を消す場合は `-All` を付けます。

## 開発・配布

ランタイムを含むクリーンな x64 持ち出しフォルダは次のコマンドで作成します。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Build-UsbCarry.ps1 -CleanOutput -IncludeRuntime -RuntimeArch x64
```

出力先は `usb/portable-codex-usb` です。ARM64 向けは `-RuntimeArch arm64`、ビルド PC と同じ構成は `-RuntimeArch auto` を指定します。

公開配布では `-IncludeAuth` と `-IncludeWorkspaces` を絶対に付けないでください。既定ビルドは既存の出力先に残った認証情報とワークスペースを削除してから空のディレクトリを作ります。GitHub Actions は `main` 更新時にクリーンな `usb.zip` を `auto-latest` リリースへ公開します。

リポジトリに含めないもの: `data/`、`tools/`、`workspaces/`、`dist/`、`usb/`、`.tmp/`

## トラブルシューティング

- `start the Windows daemon from a non-elevated terminal` と出る: 最新版へ更新して `start-admin.bat` を再実行してください。管理者版は `--no-daemon` を使用します。
- Codex CLI がない: `Install-UsbCodex.ps1` を `-ExecutionPolicy Bypass` 付きで実行します。
- Python がない: 同様に `Install-PythonRuntime.ps1` を実行します。
- ログイン状態がおかしい: GUI からログアウトするか、`Clean-UsbCodex.ps1 -Auth` を実行して再ログインします。
- モデルが使えない: `Codex既定` に戻し、Codex CLI を更新してください。

## 公開時の注意

このリポジトリのソースには認証情報を含めません。ただし、インストーラーは公式の Node.js、Python、npm 配布元から実行ファイルを取得します。公開リリースを作る管理者は GitHub Actions のログと生成物を確認し、GitHub アカウントを多要素認証で保護してください。
