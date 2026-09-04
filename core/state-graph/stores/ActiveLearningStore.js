// @ts-check
'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const REOPEN_GRACE_MS = 7 * DAY_MS;
const MAX_BACKOFF_MS = 30 * DAY_MS;
const ANSWER_WINDOW_MS = 30 * 60 * 1000;

/** @type {Readonly<Record<string,{type:string,label:string,prefix:string}>>} */
const ANSWER_MEMORY = Object.freeze({
  nombre: { type: 'User', label: 'nombre_usuario', prefix: 'Nombre: ' },
  edad: { type: 'User', label: 'edad_usuario', prefix: 'Edad: ' },
  ubicacion: { type: 'User', label: 'ubicacion_usuario', prefix: 'Vive en: ' },
  trabajo: { type: 'User', label: 'trabajo_usuario', prefix: 'Se dedica a: ' },
  musica: { type: 'Preference', label: 'musica_favorita', prefix: 'Música favorita: ' },
  anime: { type: 'Preference', label: 'preferencia_anime', prefix: 'Anime: ' },
  color: { type: 'Preference', label: 'color_favorito', prefix: 'Color favorito: ' },
  comida: { type: 'Preference', label: 'comida_favorita', prefix: 'Comida favorita: ' },
  pasatiempo: { type: 'Preference', label: 'preferencia_pasatiempo', prefix: 'Pasatiempo: ' },
  lenguaje_programacion: {
    type: 'Preference',
    label: 'preferencia_lenguaje',
    prefix: 'Lenguaje de programación favorito: ',
  },
  tono_conversacion: {
    type: 'Preference',
    label: 'preferencia_tonos',
    prefix: 'Prefiere un tono: ',
  },
});

class ActiveLearningStore {
  /** @param {any} db @param {any} graph */
  constructor(db, graph) {
    this._db = db;
    this._graph = graph;
    /** @type {Map<string, any>} */
    this._fallback = new Map();
  }

  /**
   * Sincroniza el inventario actual y devuelve únicamente huecos elegibles.
   * Que un hueco desaparezca significa que la memoria ya contiene una
   * respuesta; si reaparece más adelante, se aplica una gracia antes de volver
   * a preguntar.
   * @param {Array<{key:string,trait:string,priority?:number}>} gaps
   * @param {number} [now]
   * @returns {Array<{key:string,trait:string,priority:number,askCount:number}>}
   */
  syncAndListEligible(gaps, now = Date.now()) {
    const normalized = this._normalizeGaps(gaps);
    if (this._graph.usingFallback) return this._syncFallback(normalized, now);

    const currentKeys = new Set(normalized.map((gap) => gap.key));
    const transaction = this._db.transaction(() => {
      const previous = /** @type {any[]} */ (
        this._db.prepare('SELECT gap_key, status FROM active_learning_questions').all()
      );
      const markAnswered = this._db.prepare(
        `UPDATE active_learning_questions
         SET status='answered', answered_at=?, updated_at=? WHERE gap_key=?`
      );
      for (const row of previous) {
        if (!currentKeys.has(String(row.gap_key)) && row.status !== 'answered') {
          markAnswered.run(now, now, row.gap_key);
        }
      }

      const get = this._db.prepare('SELECT * FROM active_learning_questions WHERE gap_key=?');
      const insert = this._db.prepare(
        `INSERT INTO active_learning_questions
          (gap_key, trait, priority, status, ask_count, next_eligible_at, created_at, updated_at)
         VALUES (?, ?, ?, 'open', 0, ?, ?, ?)`
      );
      const refresh = this._db.prepare(
        `UPDATE active_learning_questions
         SET trait=?, priority=?, status='open', answered_at=NULL,
             next_eligible_at=?, updated_at=? WHERE gap_key=?`
      );
      const update = this._db.prepare(
        'UPDATE active_learning_questions SET trait=?, priority=?, updated_at=? WHERE gap_key=?'
      );
      for (const gap of normalized) {
        const row = get.get(gap.key);
        if (!row) insert.run(gap.key, gap.trait, gap.priority, now, now, now);
        else if (row.status === 'answered') {
          refresh.run(gap.trait, gap.priority, now + REOPEN_GRACE_MS, now, gap.key);
        } else update.run(gap.trait, gap.priority, now, gap.key);
      }
    });
    transaction();

    return /** @type {any[]} */ (
      this._db
        .prepare(
          `SELECT gap_key, trait, priority, ask_count FROM active_learning_questions
           WHERE status!='answered' AND next_eligible_at<=?
           ORDER BY priority DESC, ask_count ASC, updated_at ASC`
        )
        .all(now)
    ).map((row) => ({
      key: String(row.gap_key),
      trait: String(row.trait),
      priority: Number(row.priority),
      askCount: Number(row.ask_count),
    }));
  }

  /** @param {{key:string,trait:string,proposalId?:string|null,now?:number}} input */
  recordAsked(input) {
    const key = this._safeKey(input?.key);
    if (!key) return false;
    const now = Number(input.now) || Date.now();
    const proposalId = input.proposalId ? String(input.proposalId).slice(0, 100) : null;
    if (this._graph.usingFallback) {
      const row = this._fallback.get(key) || this._newRow(key, input.trait, 0.5, now);
      row.askCount += 1;
      row.status = 'asked';
      row.askedAt = now;
      row.nextEligibleAt = now + this._backoff(row.askCount);
      row.lastProposalId = proposalId;
      row.updatedAt = now;
      this._fallback.set(key, row);
      return true;
    }
    const row = this._db
      .prepare('SELECT ask_count FROM active_learning_questions WHERE gap_key=?')
      .get(key);
    const askCount = Number(row?.ask_count || 0) + 1;
    const result = this._db
      .prepare(
        `UPDATE active_learning_questions
         SET status='asked', ask_count=?, asked_at=?, next_eligible_at=?,
             last_proposal_id=?, updated_at=? WHERE gap_key=?`
      )
      .run(askCount, now, now + this._backoff(askCount), proposalId, now, key);
    return result.changes === 1;
  }

  /** @param {{key:string,outcome:'accepted'|'rejected'|'ignored',now?:number}} input */
  recordOutcome(input) {
    const key = this._safeKey(input?.key);
    if (!key || !['accepted', 'rejected', 'ignored'].includes(input.outcome)) return false;
    const now = Number(input.now) || Date.now();
    const extraDelay = input.outcome === 'rejected' ? 30 * DAY_MS : 14 * DAY_MS;
    if (this._graph.usingFallback) {
      const row = this._fallback.get(key);
      if (!row) return false;
      row.lastOutcome = input.outcome;
      if (input.outcome === 'accepted') {
        row.status = 'awaiting_answer';
        row.pendingUntil = now + ANSWER_WINDOW_MS;
      }
      row.nextEligibleAt = Math.max(row.nextEligibleAt, now + extraDelay);
      row.updatedAt = now;
      return true;
    }
    const result = this._db
      .prepare(
        `UPDATE active_learning_questions
         SET last_outcome=?,
             status=CASE WHEN ?='accepted' THEN 'awaiting_answer' ELSE status END,
             pending_until=CASE WHEN ?='accepted' THEN ? ELSE NULL END,
             next_eligible_at=MAX(next_eligible_at, ?), updated_at=?
         WHERE gap_key=?`
      )
      .run(
        input.outcome,
        input.outcome,
        input.outcome,
        now + ANSWER_WINDOW_MS,
        now + extraDelay,
        now,
        key
      );
    return result.changes === 1;
  }

  /**
   * Vincula el siguiente mensaje con la pregunta aceptada. Una negativa cierra
   * el turno sin crear memoria; texto que parece una petición no relacionada
   * queda intacto para que el chat lo procese normalmente.
   * @param {{content:string,now?:number}} input
   * @returns {{status:'none'|'unrelated'|'declined'|'captured',key?:string,nodeId?:number|string|null}}
   */
  captureAnswer(input) {
    const now = Number(input?.now) || Date.now();
    const content = String(input?.content || '').trim();
    if (!content) return { status: 'none' };
    const row = this._pending(now);
    if (!row) return { status: 'none' };
    const key = String(row.gap_key ?? row.key);
    if (/\b(?:prefiero no|no quiero|ahora no|paso|no te (?:quiero|voy a) decir)\b/i.test(content)) {
      this._finish(key, 'declined', null, null, now);
      return { status: 'declined', key };
    }
    const value = this._answerValue(key, content);
    if (!value) return { status: 'unrelated', key };
    const memory = ANSWER_MEMORY[key];
    if (!memory) return { status: 'unrelated', key };
    const observationId = this._graph.recordObservation?.({
      source: 'active_learning',
      kind: 'user_answer',
      content,
      metadata: { gapKey: key, trait: row.trait, proposalId: row.last_proposal_id || null },
      sensitivity: 'private',
      occurredAt: now,
      dedupeKey: `active-learning:${key}:${row.last_proposal_id || now}`,
    });
    const nodeId = this._graph._resolver?.resolve({
      type: memory.type,
      label: memory.label,
      content: `${memory.prefix}${value}`,
      importance: 0.8,
      tags: ['respuesta_directa', 'aprendizaje_activo'],
      revision: {
        source: 'active_learning_answer',
        reason: 'respuesta directa a una pregunta de Kaoru',
        evidenceIds: observationId ? [Number(observationId)] : [],
      },
    });
    if (nodeId && observationId) {
      this._graph.linkMemoryEvidence?.(Number(nodeId), [Number(observationId)], 1);
    }
    this._finish(key, 'answered', content.slice(0, 2000), observationId, now);
    return { status: 'captured', key, nodeId };
  }

  /** @returns {{total:number,open:number,asked:number,awaitingAnswer:number,answered:number,declined:number}} */
  getStats() {
    const counts = { total: 0, open: 0, asked: 0, awaitingAnswer: 0, answered: 0, declined: 0 };
    const rows = this._graph.usingFallback
      ? [...this._fallback.values()].map((row) => ({ status: row.status, count: 1 }))
      : this._db
          .prepare(
            'SELECT status, COUNT(*) AS count FROM active_learning_questions GROUP BY status'
          )
          .all();
    for (const row of rows) {
      const count = Number(row.count) || 0;
      counts.total += count;
      if (row.status === 'open') counts.open += count;
      else if (row.status === 'asked') counts.asked += count;
      else if (row.status === 'awaiting_answer') counts.awaitingAnswer += count;
      else if (row.status === 'answered') counts.answered += count;
      else if (row.status === 'declined') counts.declined += count;
    }
    return counts;
  }

  /** @param {number} now */
  _pending(now) {
    if (this._graph.usingFallback) {
      return (
        [...this._fallback.values()]
          .filter((row) => row.status === 'awaiting_answer' && row.pendingUntil >= now)
          .sort((a, b) => b.updatedAt - a.updatedAt)[0] || null
      );
    }
    this._db
      .prepare(
        `UPDATE active_learning_questions SET status='asked', pending_until=NULL, updated_at=?
         WHERE status='awaiting_answer' AND pending_until<?`
      )
      .run(now, now);
    return (
      this._db
        .prepare(
          `SELECT * FROM active_learning_questions
           WHERE status='awaiting_answer' AND pending_until>=?
           ORDER BY updated_at DESC LIMIT 1`
        )
        .get(now) || null
    );
  }

  /** @param {string} key @param {string} status @param {string|null} text @param {number|null} observationId @param {number} now */
  _finish(key, status, text, observationId, now) {
    if (this._graph.usingFallback) {
      const row = this._fallback.get(key);
      if (!row) return;
      row.status = status;
      row.answerText = text;
      row.answerObservationId = observationId;
      row.pendingUntil = null;
      row.answeredAt = status === 'answered' ? now : null;
      row.updatedAt = now;
      return;
    }
    this._db
      .prepare(
        `UPDATE active_learning_questions
         SET status=?, answer_text=?, answer_observation_id=?, pending_until=NULL,
             answered_at=CASE WHEN ?='answered' THEN ? ELSE answered_at END, updated_at=?
         WHERE gap_key=?`
      )
      .run(status, text, observationId, status, now, now, key);
  }

  /** @param {string} key @param {string} content */
  _answerValue(key, content) {
    if (content.length > 300 || /https?:\/\/|```|\n/.test(content)) return null;
    if (
      /^(?:haz|busca|abre|crea|ejecuta|explica|ay[uú]dame|puedes|podr[ií]as|contin[uú]a|sigue)\b/i.test(
        content
      )
    ) {
      return null;
    }
    if (/^(?:s[ií]|no|ok(?:ay)?|vale|gracias|contin[uú]a|sigue|listo|hecho)$/i.test(content)) {
      return null;
    }
    let value = content
      .replace(
        /^(?:me llamo|mi nombre es|soy|tengo|vivo en|soy de|trabajo (?:en|como)|me dedico a|mi favou?rit[oa] es|prefiero)\s+/i,
        ''
      )
      .replace(/[.!]+$/, '')
      .trim();
    if (key === 'edad') {
      const age = content.match(/\b(\d{1,3})\b/);
      const number = age ? Number(age[1]) : 0;
      return number >= 5 && number <= 120 ? String(number) : null;
    }
    if (content.includes('?') || value.split(/\s+/).length > 25) return null;
    if (key === 'nombre' && !/^[\p{L}][\p{L}\s'.-]{1,49}$/u.test(value)) return null;
    return value.length >= 2 ? value : null;
  }

  /** @param {Array<{key:string,trait:string,priority?:number}>} gaps @param {number} now */
  _syncFallback(gaps, now) {
    const currentKeys = new Set(gaps.map((gap) => gap.key));
    for (const row of this._fallback.values()) {
      if (!currentKeys.has(row.key)) {
        row.status = 'answered';
        row.answeredAt = now;
      }
    }
    for (const gap of gaps) {
      let row = this._fallback.get(gap.key);
      if (!row) {
        row = this._newRow(gap.key, gap.trait, Number(gap.priority) || 0.5, now);
        this._fallback.set(gap.key, row);
      } else if (row.status === 'answered') {
        row.status = 'open';
        row.answeredAt = null;
        row.nextEligibleAt = now + REOPEN_GRACE_MS;
      }
      row.trait = gap.trait;
      row.priority = gap.priority;
      row.updatedAt = now;
    }
    return [...this._fallback.values()]
      .filter((row) => row.status !== 'answered' && row.nextEligibleAt <= now)
      .sort((a, b) => b.priority - a.priority || a.askCount - b.askCount)
      .map((row) => ({
        key: row.key,
        trait: row.trait,
        priority: row.priority,
        askCount: row.askCount,
      }));
  }

  /** @param {Array<{key:string,trait:string,priority?:number}>} gaps */
  _normalizeGaps(gaps) {
    const found = new Map();
    for (const gap of gaps || []) {
      const key = this._safeKey(gap?.key);
      const trait = String(gap?.trait || '')
        .trim()
        .slice(0, 200);
      if (!key || !trait) continue;
      found.set(key, {
        key,
        trait,
        priority: Math.max(0, Math.min(1, Number(gap.priority) || 0.5)),
      });
    }
    return [...found.values()];
  }

  /** @param {number} askCount */
  _backoff(askCount) {
    return Math.min(MAX_BACKOFF_MS, REOPEN_GRACE_MS * Math.max(1, 2 ** (askCount - 1)));
  }

  /** @param {unknown} value */
  _safeKey(value) {
    const key = String(value || '')
      .trim()
      .slice(0, 80);
    return /^[a-z0-9_-]+$/i.test(key) ? key : '';
  }

  /** @param {string} key @param {string} trait @param {number} priority @param {number} now */
  _newRow(key, trait, priority, now) {
    return {
      key,
      trait: String(trait || '').slice(0, 200),
      priority,
      status: 'open',
      askCount: 0,
      askedAt: null,
      answeredAt: null,
      nextEligibleAt: now,
      lastProposalId: null,
      lastOutcome: null,
      pendingUntil: null,
      answerText: null,
      answerObservationId: null,
      createdAt: now,
      updatedAt: now,
    };
  }
}

module.exports = { ActiveLearningStore };
