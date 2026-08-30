<div align="center">

# Asistente Personal

**Un compañero de escritorio con IA que observa el sistema operativo, recuerda con contexto y actúa solo cuando tiene permiso — con un motor de decisión determinista y auditable.**

<br>

[![CI](https://img.shields.io/github/actions/workflow/status/Dregxmoon/Asistente-Vtuber/ci.yml?branch=produccion&style=for-the-badge&logo=githubactions&logoColor=white)](https://github.com/Dregxmoon/Asistente-Vtuber/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg?style=for-the-badge)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A518-339933?style=for-the-badge&logo=node.js&logoColor=white)](https://nodejs.org)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20Linux-lightgrey?style=for-the-badge)]()
[![Status](https://img.shields.io/badge/status-active%20development-success?style=for-the-badge)]()
[![PRs](https://img.shields.io/badge/PRs-welcome-brightgreen.svg?style=for-the-badge)](./CONTRIBUTING.md)

<br>

[**Demo**](#-el-asistente-en-accion) · [**Quick Start**](#-quick-start) · [**Arquitectura**](#-arquitectura) · [**Docs**](./docs/) · [**Roadmap**](./ROADMAP.md)

</div>

---

## Tabla de contenidos

- [¿Qué es?](#-qué-es)
- [Highlights](#-highlights)
- [Arquitectura](#-arquitectura)
- [Capacidades técnicas](#-capacidades-técnicas)
- [Stack tecnológico](#-stack-tecnológico)
- [Estructura del proyecto](#-estructura-del-proyecto)
- [Quick start](#-quick-start)
- [Configuración](#-configuración)
- [Estado del proyecto](#-estado-del-proyecto)
- [Documentación](#-documentación)
- [Pruebas y capturas](#-pruebas-y-capturas)
- [Licencia y atribuciones](#-licencia-y-atribuciones)

---

## ¿Qué es?

Una plataforma de asistencia personal que vive en el escritorio del usuario. Combina un avatar Live2D, un modelo de lenguaje conversacional, memoria semántica persistente con decaimiento temporal, percepción en tiempo real del sistema operativo y un motor de proactividad que decide _cuándo_ hablar, _cuándo_ callar y _cómo_ entregar su ayuda — sin depender de un chatbot reactivo ni de temporizadores ciegos.

A diferencia de los asistentes tradicionales que esperan a que escribas, este observa tu sistema en silencio, aprende de tu contexto y propone ayuda justo cuando tiene sentido — siempre con consentimiento explícito.

---

## Highlights

<table>
<tr>
<td width="50%">

### Proactividad responsable
Motor de iniciativa en dos niveles: pre-filtros baratos + núcleo determinista de decisión con score, gate de contexto y razón auditable. El LLM **produce contenido, nunca decide** cuándo hablar.

</td>
<td width="50%">

### Memoria con decaimiento
Grafo semántico en SQLite + `sqlite-vec`, embeddings locales (`all-MiniLM-L6-v2`), búsqueda por similitud ponderada por recencia. Lo de ayer pesa más que lo de hace tres semanas.

</td>
</tr>
<tr>
<td width="50%">

### Sandbox de proceso
Comandos aislados con `bubblewrap` (Linux): namespaces propios, filesystem read-only salvo workspace, `.ssh` y credenciales fuera de alcance. Verificación post-mutación con rollback automático.

</td>
<td width="50%">

### Multi-proveedor LLM
Groq · Gemini · OpenAI con fallback automático, reintento exponencial y modo rate-limit accionable. Sin vendor lock-in.

</td>
</tr>
<tr>
<td width="50%">

### Agente de código profundo
Detección de errores vía **LSP real** (typescript-language-server), propuestas de parche con diff, verificación post-ejecución y rollback si rompe algo.

</td>
<td width="50%">

### Extensible por MCP
Cliente Model Context Protocol propio: cualquier servidor de herramientas del ecosistema se conecta sin tocar el núcleo.

</td>
</tr>
<tr>
<td width="50%">

### Privacidad por diseño
Memoria, embeddings, telemetría y preferencias viven en tu máquina. No se sube nada por defecto.

</td>
<td width="50%">

### Streaming en vivo
Respuesta del LLM con `stream: true`, render de Markdown incremental en la burbuja del chat, tool-calling nativo + fallback textual.

</td>
</tr>
</table>

---

## Arquitectura