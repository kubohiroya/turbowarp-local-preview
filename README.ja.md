# turbowarp-local-preview

TurboWarp 関連の開発ツールで共有するローカルプレビュー基盤です。

このパッケージはファイル形式に依存しません。DSL4、SB3、A-Frame YAML などの形式固有処理は利用側の adapter として実装します。

## 機能

- debounce、retry、stability timeout、直列 publication、重複抑制を備えた単一ファイル watcher。
- bearer 認証、JSON route helper、イベント保持、Server-Sent Events 配信、lifecycle snapshot を備えた loopback preview host。
  route は Web `Response` を返すこともでき、その body はバッファリングせずにストリーミング配信します（クライアント切断時は元のストリームを cancel し、ストリームのエラー時はレスポンスを中断します）。
- 認証付き loopback preview URL のみを受け付ける browser launcher。

## ライセンス

MPL-2.0
