<div align="center">

<img src="../../../screenshots/02-overlay-character.png" width="150" alt="Live2Dデスクトップアシスタント Kaoru">

# Kaoru

### デスクトップに寄り添う、知的な存在

**状況を理解する · 大切なことを覚える · 行動する前に確認する**

[Español](../../../README.md) · **日本語** · [한국어](../ko/README.md) · [English (US)](../en-US/README.md) · [English (UK)](../en-GB/README.md) · [Português](../pt/README.md)

</div>

---

Kaoru は Electron と Live2D アバターで構築された Windows／Linux 向けデスクトップアシスタントです。会話、ローカルの意味記憶、OS のシグナル、権限を考慮したツールエージェントを統合しています。センサー起点の働きかけは、LLM が文章を生成する前に決定論的なポリシーで評価されます。

> 正式な文書はスペイン語版です。この日本語版は、保守されているプロジェクト概要と同等の入口を提供し、翻訳が維持されていない技術詳細についてはスペイン語の原文へ案内します。

![Kaoru のデモ](../../../screenshots/demo.gif)

## Kaoru の特徴

- **実際の状況を把握:** OS、Git、LSP、集中時間、アイドル状態、予定のセンサーを設定できます。
- **ローカル記憶:** StateGraph が事実、好み、エピソード、意図を保存し、意味検索と時間減衰を行います。
- **監査可能な自発性:** センサー信号を正規化し、<code>ACT</code>、<code>QUEUE</code>、<code>DROP</code>、<code>ESCALATE</code> に分類します。
- **統制された操作:** 提案、権限ポリシー、同意、実行、検証、復旧を別々の段階として扱います。
- **拡張性:** MCP、ローカルプラグイン、skills、サブエージェント、LSP に対応します。
- **デスクトップ上の存在感:** Live2D オーバーレイ、ジェスチャー、音声、Markdown ストリーミングチャットを備えます。

## アーキテクチャ

renderer に生の Node.js モジュールは公開されません。制限された preload bridge が main process の許可済み IPC handler を呼び出し、Core へ委譲します。<code>AgentLoop</code> はツールと権限を調整し、StateGraph は記憶を永続化します。SQLite が利用できない場合はメモリ内ストレージへ縮退できます。

[詳細アーキテクチャ（スペイン語）→](../../arquitectura.md)

## セキュリティモデル

LLM は Kaoru の認可主体ではありません。ツールの影響分類、<code>allow</code>／<code>ask</code>／<code>deny</code> ルール、セッション承認、workspace のパス制御、実行境界はモデル出力の外側で強制されます。承認の要否はポリシーによって決まり、すべての操作で確認画面が出るわけではありません。checkpoint、実行後の検証、rollback は復旧の根拠を提供しますが、完全なトランザクションではありません。

コマンド sandbox は OS ごとに異なります。Windows は AppContainer、Linux は利用可能な場合に <code>bubblewrap</code> を使用します。macOS には現在 OpenClaw 用の追加 process sandbox はありません。Electron renderer の sandbox は別の制御です。

## クイックスタート

要件: Node.js 18 以上、npm 9 以上。実装済み OS センサーは Windows と Linux 向けです。

```bash
git clone https://github.com/Dregxmoon/Kaoru-Agent.git
cd Kaoru-Agent
npm install
npm run rebuild
npm start
```

```bash
npm run lint
npm run typecheck
npm run format:check
npm test
```

<code>better-sqlite3</code>／<code>sqlite-vec</code> を使うテストは Electron の Node runtime が必要です。<code>npm test</code> と <code>tests/run-all.sh</code> がこの条件を処理します。

## ドキュメント

- [ドキュメントセンター](../../README.md)
- [アーキテクチャ（スペイン語）](../../arquitectura.md)
- [Core（スペイン語）](../../../core/README.md)
- [IPC（スペイン語）](../../../ipc/README.md)
- [テスト（スペイン語）](../../../tests/README.md)
- [翻訳ポリシー](../README.md)

---

<div align="center">デスクトップ AI が、確認することを忘れずに役立てるよう、丁寧に作られています。</div>
