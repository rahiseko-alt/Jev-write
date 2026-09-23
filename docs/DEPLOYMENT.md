# クラウドデプロイガイド (Cloud Deployment Guide)

Jev-write は、主要なクラウド環境（Google Cloud Run, Railway, Render, Vercel, AWS等）へワンコマンドで完全クラウド稼働させることができます。

---

## 方式 1: Google Cloud Run（推奨・最も手軽で安価）

Google Cloud CLI (`gcloud`) をお使いの場合、ディレクトリ直下で以下を実行するだけで自動ビルド・デプロイされます。

```bash
gcloud run deploy jev-write \
  --source . \
  --platform managed \
  --region asia-northeast1 \
  --allow-unauthenticated \
  --set-env-vars="OPENAI_MODEL=gpt-4o-mini"
```
※ APIキー（`OPENAI_API_KEY`, `JEV_API_KEY` 等）は Cloud Run の環境変数または Secret Manager に設定可能です。

---

## 方式 2: Vercel（GitHub 連携で 1 クリック）

1. GitHub リポジトリを Vercel にインポート
2. Settings > Environment Variables で必要な環境変数（`OPENAI_API_KEY` 等）を設定
3. `Deploy` をクリック（`vercel.json` により API 実行時間は最大 300 秒に自動設定されます。300 秒には Vercel Pro 以上の契約が必要です）

または CLI から：
```bash
npx vercel --prod
```

---

## 方式 3: Railway / Render（Docker 自動検知）

1. [Railway](https://railway.app/) または [Render](https://render.com/) で新規プロジェクト作成
2. リポジトリを接続（ルートの `Dockerfile` が自動認識されます）
3. 環境変数を入力してデプロイ

---

## 方式 4: 任意のクラウド VM / サーバー（Docker Compose）

```bash
# コンテナ起動
docker compose up -d --build
```
`http://<サーバーのIPまたはドメイン>:3000` で直ちに利用可能です。
ヘルスチェックエンドポイント: `/api/health`
