// Small helpers for the extension pages (popup and settings).
(() => {
  'use strict';

  const { t } = globalThis.Perde;

  // Fills in every element that names a message key: text, placeholder or aria-label.
  function applyI18n(scope = document) {
    document.documentElement.lang = chrome.i18n.getUILanguage();
    for (const el of scope.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    for (const el of scope.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
    for (const el of scope.querySelectorAll('[data-i18n-aria-label]')) el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel));
  }

  // h('li', { class: 'row' }, child, 'text')
  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === false || value == null) continue;
      if (key === 'class') el.className = value;
      else if (key in el && typeof value !== 'string') el[key] = value;
      else el.setAttribute(key, value === true ? '' : value);
    }
    el.append(...children.filter((child) => child != null));
    return el;
  }

  globalThis.Perde.ui = { applyI18n, h };
})();
