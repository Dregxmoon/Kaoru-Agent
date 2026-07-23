# Suite de pruebas

Pruebas unitarias y de integración para los subsistemas principales.

## Archivos

### test_intent_detection.js 
Prueba el pipeline completo de detección semántica de intenciones:
- Frases directas de acción (alta confianza)
- Intención narrativa/implícita (confianza media)
- Umbrales: preguntas conversacionales NO deben disparar herramientas
- Frases multilingüe
- Parseo de bloques estructurados desde la respuesta del LLM
- Fallback de LLM cuando embeddings no son suficientes

Dependencias: IntentDetector, sqlite-vec, base de datos vectorial poblada.

### test_prompt_composer.js  
Prueba el subsistema PromptComposer:
- Asignación de presupuesto de tokens
- Ordenamiento de bloques por prioridad
- Adaptadores de proveedor (Claude, OpenAI, Gemini, Groq)
- Formatos de serialización (markdown, xml, json-sections)
- Modo debug (inspección de bloques individuales)
- Compatibilidad con el formato legacy de ContextAssembler

**Ejecución:**
```bash
node tests/test_intent_detection.js
node tests/test_prompt_composer.js
```
