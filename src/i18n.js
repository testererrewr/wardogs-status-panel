export function normalizeLang(value) { return value === 'en' ? 'en' : 'de'; }
export function tr(lang, de, en) { return normalizeLang(lang) === 'en' ? en : de; }
export function localeCode(lang) { return normalizeLang(lang) === 'en' ? 'en-GB' : 'de-DE'; }
