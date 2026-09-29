'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { ConfigManager } = require('../core/config/ConfigManager.js');

async function main() {
  const html = fs.readFileSync(path.join(__dirname, '../src/chat.html'), 'utf8');
  const keys = [...html.matchAll(/data-i18n(?:-title|-label|-placeholder)?="([^"]+)"/g)].map(
    (match) => match[1]
  );
  const nodes = keys.map((key) => ({
    dataset: { i18n: key },
    textContent: '',
    attributes: { 'data-i18n': key },
    getAttribute(name) {
      return this.attributes[name];
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
  }));
  const languagePicker = { value: '', addEventListener() {} };
  const languageStatus = { textContent: '' };
  const saved = [];
  const indexedLanguages = [];
  let resolveConfig;
  const document = {
    documentElement: { lang: '' },
    querySelectorAll(selector) {
      if (selector === '[data-i18n]') return nodes;
      const attribute = selector.slice(1, -1);
      return nodes.filter((node) => node.attributes[attribute]);
    },
    getElementById(id) {
      return id === 'prefs-language' ? languagePicker : languageStatus;
    },
    dispatchEvent() {},
  };
  const window = {
    assistant: {
      invoke(channel, patch) {
        if (channel === 'get-config')
          return new Promise((resolve) => {
            resolveConfig = resolve;
          });
        saved.push(patch);
        return Promise.resolve({ ok: true });
      },
      refreshCapabilities: async (language) => indexedLanguages.push(language),
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/chat/i18n.js'), 'utf8'), {
    document,
    navigator: { languages: ['ja-JP', 'en-US'] },
    window,
    CustomEvent: class {},
  });
  assert.equal(document.documentElement.lang, 'ja', 'detects Japanese from the system');
  assert.equal(indexedLanguages.at(-1), 'ja', 'command index follows the active language');
  assert(
    keys.every((key) => window.kaoruI18n.has(key)),
    'all annotated keys are translated'
  );
  const dynamicKeys = ['settings.js', 'permissions.js'].flatMap((file) => {
    const source = fs.readFileSync(path.join(__dirname, '../src/chat', file), 'utf8');
    return [...source.matchAll(/(?:settingsText|settingsFormat|permissionsText)\('([^']+)'/g)].map(
      (match) => match[1]
    );
  });
  const allChatSources = fs
    .readdirSync(path.join(__dirname, '../src/chat'))
    .filter((file) => file.endsWith('.js') && file !== 'i18n.js')
    .map((file) => fs.readFileSync(path.join(__dirname, '../src/chat', file), 'utf8'));
  const referencedKeys = allChatSources.flatMap((source) =>
    [
      ...source.matchAll(
        /(?:kaoruI18n\.(?:t|format)|memoryLabel|memoryFormat|inputText|inputFormat)\('([^']+)'/g
      ),
    ].map((match) => match[1])
  );
  assert(
    [...dynamicKeys, ...referencedKeys].every((key) => window.kaoruI18n.has(key)),
    'all literal renderer translation keys exist'
  );
  resolveConfig({ ui: { language: 'es' } });
  await Promise.resolve();
  assert.equal(document.documentElement.lang, 'es', 'saved preference overrides the system');
  assert.equal(indexedLanguages.at(-1), 'es');
  assert(dynamicKeys.every((key) => window.kaoruI18n.has(key)));
  assert.equal(await window.kaoruI18n.setLanguage('en'), true);
  assert.equal(document.documentElement.lang, 'en', 'manual change applies immediately');
  assert.equal(indexedLanguages.at(-1), 'en');
  assert(dynamicKeys.every((key) => window.kaoruI18n.has(key)));
  assert.equal(saved.at(-1).ui.language, 'en');
  assert.equal(await window.kaoruI18n.setLanguage('invalid'), false);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kaoru-i18n-'));
  try {
    const file = path.join(dir, 'config.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        ui: { language: 'ja' },
        llm: { primary: 'groq', providers: { groq: { model: 'existing-model' } } },
        onboarding: { completed: true, version: 1 },
        unknownFutureField: { keep: true },
      })
    );
    const config = new ConfigManager(file, { verbose: false });
    const before = config.load();
    assert.equal(before.ui.language, 'ja');
    config.save({ ui: { language: 'en' } });
    const after = new ConfigManager(file, { verbose: false }).load();
    assert.equal(after.ui.language, 'en');
    assert.equal(after.llm.providers.groq.model, 'existing-model');
    assert.equal(after.onboarding.completed, true);
    assert.deepEqual(after.unknownFutureField, { keep: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('UI language: detection, preference, catalog, and config preservation OK');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
