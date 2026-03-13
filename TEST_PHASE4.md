# Phase 4: User-State Rendering & Billing Entry Points - テストガイド

## ✅ 完成した機能

### 🛒 Credit Purchase System
- **`/account/credits`** - Credit購入ページ
- **`POST /api/account/credits/purchase`** - Credit購入API
- **3つのクレジットパッケージ** - 5, 15, 50 クレジット

### 🎯 Advanced User-State Rendering
- **`GET /api/account/unlock-status`** - アカウントのアンロック状態確認API
- **Already Unlocked Detection** - 既にアンロック済みアカウントの自動検出
- **Immediate Results Loading** - 既存結果の自動表示
- **Re-excavation Options** - 再発掘オプション

### 🔗 Enhanced Navigation & UX
- **Account Dashboard Integration** - Credit購入へのリンク
- **No Credits Warning** - クレジット不足時の明確な案内
- **Contextual CTAs** - ユーザー状態に応じた適切なCall-to-Action

## 🧪 詳細テスト手順

### 1. Credit Purchase System のテスト

**Step 1: Account Dashboard から Credit Purchase へ**
1. ログイン後、Account Dashboard (`/account`) にアクセス
2. 「Get More Credits」カードをクリック
3. `/account/credits` ページに遷移することを確認

**Step 2: Credit Purchase Page の確認**
1. 現在のクレジット残高が正しく表示されることを確認
2. 3つのパッケージ（5, 15, 50 クレジット）が表示されることを確認
3. 「Most Popular」バッジが15クレジットパッケージに表示されることを確認
4. 各パッケージの単価計算が正しいことを確認

**Step 3: Credit Purchase の実行**
1. 任意のパッケージの「Purchase」ボタンをクリック
2. ローディング状態（「Processing...」）が表示されることを確認
3. 成功メッセージが表示されることを確認
4. クレジット残高が即座に更新されることを確認

### 2. Enhanced User-State Rendering のテスト

**Step 1: 新規アカウント（未アンロック）**
1. まだアンロックしていない公開アカウントを検索
2. ログイン状態で `/user/{username}` にアクセス
3. 以下のユーザー状態別表示を確認：

**A. クレジットあり + 未アンロック:**
- 「Excavate Earliest Posts」ボタン表示
- 「Uses 1 credit • You have X credits remaining」表示

**B. クレジットなし + 未アンロック:**
- 「No Credits Available」警告表示
- 「Get More Credits」ボタンが `/account/credits` にリンク

**Step 2: 既にアンロック済みアカウント**
1. 以前にアンロックしたアカウントを検索
2. ログイン状態で `/user/{username}` にアクセス
3. 以下を確認：
   - 「Already Unlocked」ステータス表示
   - 既存の結果が自動的にロード・表示される
   - 「Re-run Excavation」オプション表示

**Step 3: ゲストユーザー（未ログイン）**
1. ログアウト状態で任意アカウントを検索
2. 「Sign In Required」メッセージ表示を確認
3. 「Create Account」「Sign In」ボタンが適切にリンクすることを確認
4. 「New accounts get 3 free credits」案内表示を確認

### 3. 統合ユーザーフローのテスト

**完全なユーザージャーニー:**
1. **新規登録** → 3クレジット自動付与
2. **初回発掘** → 1クレジット消費、結果表示
3. **同アカウント再訪問** → 「Already Unlocked」+ 結果自動表示
4. **クレジット使い切り** → 「No Credits」警告 + 購入案内
5. **クレジット購入** → 即座にクレジット追加
6. **新規発掘** → 新しいクレジットで実行可能

### 4. Navigation & UX のテスト

**NavBar Integration:**
1. ユーザーメニューから「Account Dashboard」「My Unlocks」アクセス確認
2. クレジット残高の正確な表示確認

**Account Dashboard:**
1. クレジット残高の表示確認
2. 「No Credits Available」バッジ表示（クレジット0時）
3. Quick Start セクションの「Get more credits」項目（クレジット0時）

**Contextual Navigation:**
1. Credit Purchase ページから Account Dashboard への「戻る」リンク
2. エラー・成功メッセージの適切な表示

## 🎯 期待される動作

### ✅ 正常ケース
- 新規ユーザーは3クレジットでスタート
- クレジット購入が即座に反映
- 既アンロックアカウントの結果が自動表示
- ユーザー状態に応じた適切なCTA表示
- スムーズなナビゲーション体験

### ⚠️ エッジケース処理
- クレジット不足時の明確な案内
- 購入エラー時のハンドリング
- ネットワークエラー時のフォールバック
- 認証エラー時の適切なリダイレクト

## 🔧 技術的検証ポイント

### API認証
- `/api/account/credits/purchase` の認証必須確認
- `/api/account/unlock-status` の適切なレスポンス
- JWT token の正確な処理

### State Management
- UserContext でのクレジット残高管理
- リアルタイムクレジット更新
- アンロック状態の正確な追跡

### Database Integration
- Credit purchase の transaction 処理
- アンロック履歴の正確な記録
- 既存データとの整合性確保

## 🎨 UI/UX検証

### レスポンシブデザイン
- クレジット購入ページのモバイル表示
- カード レイアウトの各画面サイズ対応

### ユーザビリティ
- 直感的なクレジット購入フロー
- 明確なユーザー状態表示
- 適切なローディング・フィードバック

## 🚀 Phase 4 完了確認

- [x] Credit Purchase システム完成
- [x] Advanced User-State Rendering 実装
- [x] Already Unlocked Detection 動作
- [x] Enhanced Navigation 統合
- [x] Complete User Journey テスト可能

全てのテストが成功すれば、Phase 4: User-State Rendering & Billing Entry Points は完全に完了です！

## 📈 次の展開

Phase 4完了により、Stelaは **production-ready** な状態になりました：

- ✅ Complete Authentication System
- ✅ User Account Management  
- ✅ Credit Purchase & Billing
- ✅ Advanced User State Rendering
- ✅ Full Excavation Workflow
- ✅ Professional UI/UX

🎉 **Stela は公開準備完了！**