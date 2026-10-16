import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';

const directory = dirname(fileURLToPath(import.meta.url));
const script = readFileSync(resolve(directory, '../public/managed.js'), 'utf8');
const start = script.indexOf("(() => {\n  const modal = document.querySelector('[data-managed-ban-modal]');");
const end = script.indexOf('\n\n(() => {', start + 1);
assert.ok(start >= 0 && end > start, 'Managed BAN script must exist');
const banScript = script.slice(start, end);

function createEnvironment({ embedded = true, sameOrigin = true } = {}) {
  const listened = (name = 'node') => ({
    name, events: new Map(), hidden: false, disabled: false, value: '', dataset: {},
    addEventListener(type, listener) { this.events.set(type, listener); },
    removeEventListener(type, listener) { if (this.events.get(type) === listener) this.events.delete(type); },
    dispatch(type, event) { this.events.get(type)?.(event); },
    focus(options) { this.focusOptions = options; },
    querySelector(selector) { return this.descendants?.[selector] || null; },
    reset() {},
  });
  const classList = () => ({
    entries: new Set(),
    add(value) { this.entries.add(value); },
    remove(value) { this.entries.delete(value); },
    contains(value) { return this.entries.has(value); },
  });
  const childDoc = { events: new Map(), body: { classList: classList() },
    querySelector(selector) { return selector === '[data-managed-ban-modal]' ? modal : null; },
    addEventListener(type, listener) { this.events.set(type, listener); },
    dispatch(type, event) { this.events.get(type)?.(event); },
  };
  const parentDoc = { events: new Map(), body: { classList: classList(), appendChild(node) { node.ownerDocument = parentDoc; } },
    addEventListener(type, listener) { this.events.set(type, listener); },
    removeEventListener(type, listener) { if (this.events.get(type) === listener) this.events.delete(type); },
    dispatch(type, event) { this.events.get(type)?.(event); },
  };
  const originalParent = { appendChild(node) { node.ownerDocument = childDoc; } };
  const modal = listened('modal'); modal.parentNode = originalParent; modal.ownerDocument = childDoc;
  const form = listened('form');
  const steamInput = listened('steam');
  const reason = listened('reason');
  const reasonCount = listened('count');
  const template = listened('template');
  const targetLabel = listened('label');
  const duration = listened('duration');
  const durationUnit = listened('durationUnit'); durationUnit.value = 'permanent';
  const durationValue = listened('durationValue');
  duration.descendants = { '[data-duration-unit]': durationUnit, '[data-duration-value]': durationValue };
  const submit = listened('submit');
  modal.descendants = {
    '[data-managed-ban-form]': form, '[data-ban-steam-id]': steamInput,
    '[data-ban-reason]': reason, '[data-ban-reason-count]': reasonCount,
    '[data-ban-template]': template, '[data-ban-target-label]': targetLabel,
    '[data-ban-duration]': duration, '.managed-ban-confirm': submit,
  };
  const window = { location: { origin: 'https://panel.example' }, setTimeout(callback) { callback(); } };
  window.self = window;
  window.parent = embedded ? { document: parentDoc, location: { origin: sameOrigin ? 'https://panel.example' : 'https://example.org' } } : window;
  vm.runInNewContext(banScript, { document: childDoc, window });
  const opener = listened('button');
  opener.dataset = { steamId: '76561197960287930', playerName: 'Testspieler' };
  opener.closest = (selector) => selector === '[data-open-managed-ban]' ? opener : null;
  return { childDoc, parentDoc, modal, form, steamInput, targetLabel, opener, durationUnit, reason, childBody: childDoc.body };
}

test('BAN from embedded live player list opens in top viewport and closes with Escape', () => {
  const env = createEnvironment();
  env.childDoc.dispatch('click', { target: env.opener });
  assert.equal(env.modal.ownerDocument, env.parentDoc);
  assert.equal(env.modal.hidden, false);
  assert.equal(env.parentDoc.body.classList.contains('modal-open'), true);
  assert.equal(env.steamInput.value, '76561197960287930');
  assert.match(env.targetLabel.textContent, /Testspieler/);
  assert.equal(env.form.target, '_top');
  assert.equal(env.reason.focusOptions?.preventScroll, true);
  env.parentDoc.dispatch('keydown', { key: 'Escape' });
  assert.equal(env.modal.hidden, true);
  assert.equal(env.modal.ownerDocument, env.childDoc);
  assert.equal(env.parentDoc.body.classList.contains('modal-open'), false);
  assert.equal(env.parentDoc.events.has('keydown'), false);
});

test('BAN backdrop closes the portaled modal and restores the original document', () => {
  const env = createEnvironment();
  env.childDoc.dispatch('click', { target: env.opener });
  env.modal.dispatch('click', { target: env.modal });
  assert.equal(env.modal.ownerDocument, env.childDoc);
  assert.equal(env.modal.hidden, true);
  assert.equal(env.opener.focusOptions?.preventScroll, true);
});

test('BAN remains functional without same-origin parent or when opened standalone', () => {
  for (const options of [{ embedded: false }, { embedded: true, sameOrigin: false }]) {
    const env = createEnvironment(options);
    env.childDoc.dispatch('click', { target: env.opener });
    assert.equal(env.modal.ownerDocument, env.childDoc);
    assert.equal(env.childBody.classList.contains('modal-open'), true);
    env.childDoc.dispatch('keydown', { key: 'Escape' });
    assert.equal(env.modal.hidden, true);
    assert.equal(env.childBody.classList.contains('modal-open'), false);
  }
});

test('embedded live-management auto-refresh checks the parent for the BAN dialog', () => {
  const refreshScript = readFileSync(resolve(directory, '../public/managed-live-refresh.js'), 'utf8');
  assert.match(refreshScript, /window\.parent\.document\.querySelector\('\[data-managed-ban-modal\]:not\(\[hidden\]\)'\)/);
});
