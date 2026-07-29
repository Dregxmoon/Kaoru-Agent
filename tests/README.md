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

**Ejecución:**
```bash
node tests/test_intent_detection.js
```
