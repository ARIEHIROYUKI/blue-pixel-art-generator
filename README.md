# Blue Pixel Art Generator

React + TypeScript + Viteで作った、画像を青いドット/四角の生成的ピクセルアートに変換するWebアプリです。

## 機能

- 画像アップロード
- Canvasプレビュー
- 明るい背景を自動推定して除去
- シルエット部分を円、四角、小ドットで再構成
- エッジ周辺の密度を自動的に少し高める描画
- 密度、崩壊/ノイズ量、ドットサイズの調整
- ドット色、背景色の変更
- ランダムSeed変更
- PNG / SVG書き出し
- Reset

## 使い方

```bash
npm install
npm run dev
```

ブラウザで表示されたローカルURLを開き、左パネルの「Upload image」から画像を選びます。

## 書き出し

- PNG: 現在のCanvas表示を書き出します。
- SVG: 生成された各ドットを`circle`/`rect`として書き出します。

## ビルド

```bash
npm run build
```
