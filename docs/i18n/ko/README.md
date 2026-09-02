<div align="center">

<img src="../../../screenshots/02-overlay-character.png" width="150" alt="Live2D 데스크톱 어시스턴트 Kaoru">

# Kaoru

### 데스크톱에 함께하는 지능적인 존재

**상황을 이해하고 · 중요한 것을 기억하며 · 행동하기 전에 묻습니다**

[Español](../../../README.md) · [日本語](../ja/README.md) · **한국어** · [English (US)](../en-US/README.md) · [English (UK)](../en-GB/README.md) · [Português](../pt/README.md)

</div>

---

Kaoru는 Electron과 Live2D 아바타로 만든 Windows 및 Linux용 데스크톱 어시스턴트입니다. 대화, 로컬 의미 기억, 운영체제 신호, 권한을 인식하는 도구 에이전트를 하나로 결합합니다. 센서 기반의 능동적 개입은 LLM이 메시지를 작성하기 전에 결정론적 정책으로 평가됩니다.

> 스페인어 문서가 공식 원본입니다. 이 한국어판은 유지 관리되는 프로젝트 개요와 같은 출발점을 제공하며, 번역이 관리되지 않는 기술 세부 정보는 스페인어 원문으로 연결합니다.

![Kaoru 실행 화면](../../../screenshots/demo.gif)

## Kaoru의 특징

- **실제 상황 인식:** OS, Git, LSP, 집중 시간, 유휴 상태, 일정 센서를 설정할 수 있습니다.
- **로컬 기억:** StateGraph가 사실, 선호, 에피소드, 의도를 저장하고 의미 검색과 시간 감쇠를 적용합니다.
- **감사 가능한 능동성:** 센서 신호를 정규화하고 <code>ACT</code>, <code>QUEUE</code>, <code>DROP</code>, <code>ESCALATE</code>로 분류합니다.
- **통제된 작업:** 제안, 권한 정책, 동의, 실행, 검증, 복구를 서로 다른 단계로 유지합니다.
- **확장성:** MCP 서버, 로컬 플러그인, skills, 하위 에이전트 프로필, LSP 서버를 지원합니다.
- **데스크톱의 존재감:** Live2D 오버레이, 제스처, 음성, Markdown 스트리밍 채팅을 제공합니다.

## 아키텍처

renderer에는 원시 Node.js 모듈이 노출되지 않습니다. 제한된 preload bridge가 main process의 허용된 IPC handler를 호출하고, handler는 Core에 위임합니다. <code>AgentLoop</code>는 도구와 권한을 조정하며 StateGraph는 기억을 영구 저장합니다. SQLite를 사용할 수 없으면 메모리 저장소로 저하될 수 있습니다.

[상세 아키텍처 — 스페인어 →](../../arquitectura.md)

## 보안 모델

LLM은 Kaoru의 권한 부여 주체가 아닙니다. 도구 영향 분류, <code>allow</code>/<code>ask</code>/<code>deny</code> 규칙, 세션 승인, workspace 경로 제어, 실행 경계는 모델 출력 외부에서 강제됩니다. 승인 여부는 정책에 따라 달라지므로 모든 작업이 확인을 요구하지는 않습니다. checkpoint, 실행 후 검증, rollback은 복구 근거를 제공하지만 완전한 트랜잭션은 아닙니다.

명령 sandbox는 플랫폼별로 다릅니다. Windows는 AppContainer를 사용하고 Linux는 사용 가능한 경우 <code>bubblewrap</code>을 사용합니다. macOS에는 현재 OpenClaw를 위한 추가 process sandbox가 없습니다. Electron renderer sandbox는 별도의 제어입니다.

## 빠른 시작

요구 사항: Node.js 18 이상, npm 9 이상. 구현된 OS 센서는 Windows와 Linux를 지원합니다.

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

<code>better-sqlite3</code> 또는 <code>sqlite-vec</code>를 사용하는 테스트는 Electron의 Node runtime으로 실행해야 합니다. <code>npm test</code>와 <code>tests/run-all.sh</code>가 이 조건을 처리합니다.

## 문서

- [문서 센터](../../README.md)
- [아키텍처 — 스페인어](../../arquitectura.md)
- [Core — 스페인어](../../../core/README.md)
- [IPC — 스페인어](../../../ipc/README.md)
- [테스트 — 스페인어](../../../tests/README.md)
- [현지화 정책](../README.md)

---

<div align="center">데스크톱 AI가 허락을 구하는 일을 잊지 않으면서 유용하도록 세심하게 만들었습니다.</div>
