<div align="center">

<img src="../../../screenshots/02-overlay-character.png" width="150" alt="Kaoru, assistente de desktop Live2D">

# Kaoru

### Uma presença inteligente no seu desktop

**Entende o contexto · lembra o que importa · pergunta antes de agir**

[Español](../../../README.md) · [日本語](../ja/README.md) · [한국어](../ko/README.md) · [English (US)](../en-US/README.md) · [English (UK)](../en-GB/README.md) · **Português**

</div>

---

Kaoru é um assistente de desktop para Windows e Linux, construído com Electron e um avatar Live2D. Combina conversa, memória semântica local, sinais do sistema operacional e um agente de ferramentas ciente de permissões. A iniciativa baseada em sensores é avaliada por uma política determinística antes de o LLM redigir a mensagem.

> O espanhol é o idioma canônico da documentação. Esta edição oferece a mesma introdução mantida ao projeto e direciona para as referências técnicas em espanhol quando ainda não existe uma tradução mantida.

![Kaoru em ação](../../../screenshots/demo.gif)

## O que diferencia Kaoru

- **Contexto real:** sensores configuráveis de sistema, Git, LSP, foco, inatividade e eventos.
- **Memória local:** o StateGraph guarda fatos, preferências, episódios e intenções com busca semântica e decaimento temporal.
- **Iniciativa auditável:** os sinais são normalizados e classificados como <code>ACT</code>, <code>QUEUE</code>, <code>DROP</code> ou <code>ESCALATE</code>.
- **Ações governadas:** proposta, política de permissões, consentimento, execução, verificação e recuperação são etapas separadas.
- **Extensibilidade:** servidores MCP, plugins locais, skills, perfis de subagente e servidores LSP.
- **Presença no desktop:** overlay Live2D, gestos, voz e chat Markdown com streaming.

## Arquitetura

O renderer não recebe módulos Node.js brutos. Bridges preload limitadas chamam handlers IPC autorizados no processo main, que delegam ao Core. O <code>AgentLoop</code> coordena ferramentas e permissões; o StateGraph persiste a memória e pode recorrer ao armazenamento em memória quando o SQLite não está disponível.

[Ler a arquitetura detalhada em espanhol →](../../arquitectura.md)

## Modelo de segurança

O LLM não é a autoridade de autorização de Kaoru. A classificação de impacto, as regras <code>allow</code>/<code>ask</code>/<code>deny</code>, as aprovações de sessão, os controles de caminho do workspace e os limites de execução são aplicados fora da saída do modelo. A confirmação depende da política: nem toda operação exibe um pedido. Checkpoints, verificação posterior e rollback fornecem evidências de recuperação, mas não formam uma transação infalível.

O sandbox de comandos depende da plataforma: Windows usa AppContainer; Linux usa <code>bubblewrap</code> quando disponível; atualmente o macOS não possui um sandbox adicional para processos OpenClaw. O sandbox do renderer Electron é um controle diferente.

## Início rápido

Requisitos: Node.js 18 ou superior, npm 9 ou superior e Windows ou Linux para os sensores de sistema implementados.

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

Os testes que usam <code>better-sqlite3</code> ou <code>sqlite-vec</code> devem rodar no Node runtime do Electron. <code>npm test</code> e <code>tests/run-all.sh</code> respeitam esse contrato.

## Documentação

- [Central de documentação](../../README.md)
- [Arquitetura — espanhol](../../arquitectura.md)
- [Core — espanhol](../../../core/README.md)
- [IPC — espanhol](../../../ipc/README.md)
- [Testes — espanhol](../../../tests/README.md)
- [Política de localização](../README.md)

---

<div align="center">Feito com cuidado para que uma IA de desktop seja útil sem esquecer de pedir permissão.</div>
