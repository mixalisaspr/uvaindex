import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LANGS, translator, normalizeLang, langPath, bandLabel, stringKeys } from '../js/i18n.js';
import { BANDS } from '../js/uva.js';

test('every language defines every interface string', () => {
  const en = stringKeys('en');
  for (const lang of LANGS) {
    const keys = new Set(stringKeys(lang));
    const missing = en.filter((k) => !keys.has(k));
    assert.deepEqual(missing, [], `${lang} is missing strings`);
    assert.equal(translator(lang)('bands').length, BANDS.length, `${lang} band names`);
  }
});

test('placeholders survive translation', () => {
  const en = translator('en');
  for (const lang of LANGS) {
    const t = translator(lang);
    for (const key of stringKeys('en')) {
      const want = String(en(key)).match(/\{\w+\}/g)?.sort() ?? [];
      const got = String(t(key)).match(/\{\w+\}/g)?.sort() ?? [];
      assert.deepEqual(got, want, `${lang}: ${key}`);
    }
  }
});

test('lookup, substitution and fallbacks', () => {
  const t = translator('de');
  assert.equal(t('refresh'), 'Aktualisieren');
  assert.equal(t('rows.zenith'), 'Sonnenzenitwinkel');
  assert.equal(t('locationFailed', { msg: 'x' }), 'Standort nicht verfügbar: x');
  assert.equal(t('no.such.key'), 'no.such.key');
  assert.equal(normalizeLang('zh-Hans'), 'zh');
  assert.equal(normalizeLang('pt-BR'), 'en');
  assert.equal(langPath('en'), '');
  assert.equal(langPath('ja'), 'ja/');
  assert.equal(bandLabel(3, 'es'), 'Muy alto');
  assert.equal(bandLabel(BANDS[0].level, 'en'), BANDS[0].label);
});
