# muse-touch

Museちゃんと触れ合えるポートフォリオサイト。公開先は https://me.muse-chan.workers.dev (Cloudflare Workers) の予定。

- スタック: Svelte 5 + Vite + TypeScript (UI 層のみ)、3D は three.js + @pixiv/three-vrm の素の TypeScript モジュール
- ヒーロー画面で 3D アバターを表示し、「さわる / カメラ」のモード切替、カメラ回転・ズーム、視線追従、まばたき・呼吸などを実装
- 音なし、すべての処理はブラウザ内で完結

## 開発

```sh
npm install
npm run dev      # 開発サーバー
npm run build    # dist/ へビルド
npm run check    # 型チェック
```

## クレジット

3Dモデル「Museちゃん」© 2026 otoneko. — VRoid Studio で制作
