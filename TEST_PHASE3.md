# Phase 3: My Unlocks Page - テストガイド

## ✅ 完成した機能

### 新しいページとAPI
- **`/account/unlocks`** - My Unlocks ページ
- **`/account`** - Account Dashboard
- **`GET /api/account/unlocks`** - ユーザーのアンロック履歴取得API

### NavBar統合
- **Account Dashboard** - ユーザーメニューに追加
- **My Unlocks** - ユーザーメニューに追加

## 🧪 テスト手順

### 1. 認証機能のテスト
1. `http://localhost:3000` にアクセス
2. 右上の「Sign Up」をクリック
3. テストアカウントを作成（例：`test@example.com` / `password123`）
4. 自動的に3クレジットが付与されることを確認

### 2. ユーザーメニューの確認
1. ログイン後、右上のユーザーアバターをクリック
2. メニューに「Account Dashboard」と「My Unlocks」があることを確認

### 3. Account Dashboardのテスト
1. 「Account Dashboard」をクリック
2. ユーザー情報とクレジット残高が表示されることを確認
3. 「My Unlocks」カードがクリック可能であることを確認

### 4. My Unlocksページのテスト（初回）
1. 「My Unlocks」をクリック
2. 「No Unlocks Yet」状態が表示されることを確認
3. 「Start Exploring」ボタンがホームページに遷移することを確認

### 5. 発掘機能でアンロック履歴を作成
1. ホームページに戻る
2. 任意の公開Xアカウント名を入力（例：`jack`, `elonmusk`, `sundarpichai`など）
3. 「Search」→「Excavate Earliest Posts」で発掘実行
4. 発掘完了後、クレジットが1減っていることを確認

### 6. My Unlocksページの確認（データあり）
1. 再度「My Unlocks」ページにアクセス
2. アンロックしたアカウントが表示されることを確認
3. フィルタ・ソート機能をテスト：
   - 「Sort by」で日付・ユーザー名・ステージ選択
   - 「Order」で昇順・降順切り替え
   - 「Stage」フィルター

### 7. 統計表示の確認
1. 複数のアカウントを発掘後
2. ページ下部の「Your Exploration Stats」セクション
3. 総アンロック数、発見投稿数などが正しく集計されることを確認

## 🎯 期待される動作

### 正常ケース
- ✅ 認証が必要なページで未ログインユーザーは`/login`にリダイレクト
- ✅ My Unlocksページでユーザーのアンロック履歴を表示
- ✅ フィルタ・ソート機能が正常動作
- ✅ 「View Results」リンクで該当アカウントページに遷移
- ✅ 統計情報の正確な集計

### エラーハンドリング
- ✅ API認証エラー時の適切なエラー表示
- ✅ ネットワークエラー時のフォールバック
- ✅ 空状態（No unlocks）の適切な表示

## 🔧 開発者向けメモ

### API認証
- `/api/account/unlocks` は認証必須
- `getUserId()` でJWT認証 → dev header → anonymous の順で確認
- 認証されたユーザーのunlock履歴のみ返却

### データ構造
```typescript
interface UnlockEntry {
  account_id: string;
  stage: number;
  job_id: string;
  unlocked_at: string;
  username: string | null;
  account_created_at: string | null;
  cap: number | null;
  unlocked_count: number;
}
```

### UI/UX特徴
- **レスポンシブグリッド** (1→2→3カラム)
- **リアルタイムフィルタ・ソート**
- **統計ダッシュボード**
- **適切なローディング状態**

## 🚀 Phase 4で実装予定
- User-state rendering の完全対応
- Billing/Account entry points
- より詳細なアカウント管理機能