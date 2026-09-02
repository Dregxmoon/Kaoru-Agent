<div align="center">

<img src="../../../screenshots/02-overlay-character.png" width="150" alt="Kaoru Live2D desktop assistant">

# Kaoru

### An intelligent presence on your desktop

**Understands context · remembers what matters · asks before acting**

[Español](../../../README.md) · [日本語](../ja/README.md) · [한국어](../ko/README.md) · [English (US)](../en-US/README.md) · **English (UK)** · [Português](../pt/README.md)

</div>

---

Kaoru is a Windows and Linux desktop assistant built with Electron and a Live2D avatar. It combines conversation, local semantic memory, operating-system signals and a permission-aware tool agent. Sensor-driven initiative is evaluated by a deterministic policy before an LLM writes the message.

> Spanish is the canonical documentation language. This edition mirrors the maintained project overview and links to Spanish technical references where no maintained translation exists.

![Kaoru in action](../../../screenshots/demo.gif)

## What makes Kaoru different

- **Context-aware:** configurable OS, Git, LSP, focus, idle and event sensors.
- **Local memory:** StateGraph stores facts, preferences, episodes and intentions with semantic retrieval and temporal decay.
- **Auditable initiative:** sensor signals are normalised and classified as <code>ACT</code>, <code>QUEUE</code>, <code>DROP</code> or <code>ESCALATE</code>.
- **Governed actions:** proposals, permission policy, consent, execution, verification and recovery remain separate stages.
- **Extensible:** MCP servers, local plug-ins, skills, subagent profiles and LSP servers.
- **A real desktop presence:** Live2D overlay, gestures, voice and a streaming Markdown chat.

## Architecture

The renderer receives no raw Node.js modules. Narrow preload bridges call allowlisted IPC handlers in the main process, which delegate to Core. <code>AgentLoop</code> coordinates tools and permissions; StateGraph persists memory and can fall back to in-memory storage when SQLite is unavailable.

[Read the detailed architecture in Spanish →](../../arquitectura.md)

## Security model

The LLM is not Kaoru's authorisation authority. Tool-impact classification, <code>allow</code>/<code>ask</code>/<code>deny</code> rules, session approvals, workspace path controls and execution boundaries are enforced outside model output. Approval is policy-dependent—not every operation prompts. Checkpoints, post-run verification and rollback provide recovery evidence, but they are not an infallible transaction.

Command sandboxing is platform-specific: Windows uses AppContainer; Linux uses <code>bubblewrap</code> when available; macOS currently has no additional OpenClaw process sandbox. Electron renderer sandboxing is a separate control.

## Quick start

Requirements: Node.js 18+, npm 9+, and Windows or Linux for implemented OS sensors.

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

Tests that touch <code>better-sqlite3</code> or <code>sqlite-vec</code> must run through Electron's Node runtime; <code>npm test</code> and <code>tests/run-all.sh</code> handle that contract.

## Documentation

- [Documentation centre](../../README.md)
- [Architecture — Spanish](../../arquitectura.md)
- [Core — Spanish](../../../core/README.md)
- [IPC — Spanish](../../../ipc/README.md)
- [Testing — Spanish](../../../tests/README.md)
- [Localisation policy](../README.md)

---

<div align="center">Built with care so a desktop AI can be useful without forgetting to ask.</div>
