// @ts-check
'use strict';

/**
 * EmbedModel.js — UNA sola fuente de verdad para el modelo de embeddings.
 *
 * Todo el pipeline semántico (IntentDetector, skills, memoria, init_vectors)
 * usa este modelo. La cobertura semántica depende de sus pesos y debe
 * validarse por idioma; detectar el idioma no garantiza entender la tarea.
 *
 * Se conserva all-MiniLM-L6-v2 para que memoria e intenciones persistidas
 * sigan en el mismo espacio vectorial. Cambiar pesos exige migrar los vectores,
 * aunque el nuevo modelo también tenga 384 dimensiones.
 */
const EMBED_MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const EMBED_DIMS = 384;

module.exports = { EMBED_MODEL_ID, EMBED_DIMS };
