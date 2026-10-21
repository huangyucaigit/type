// Model content only. Never pass provider HTTP bodies or diagnostic envelopes here.
const MAX_CONTENT = 60000;
const MAX_FALLBACK = 16000;

function objectCandidates(text) {
  const candidates = [];
  let start = -1, depth = 0, quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (start < 0) {
      if (char === '{') { start = i; depth = 1; }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      candidates.push(text.slice(start, i + 1));
      start = -1;
      if (candidates.length === 8) break;
    }
  }
  return candidates;
}

function plainText(value, limit = MAX_FALLBACK) {
  if (typeof value !== 'string' || value.length > limit) return '';
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
}

function readableObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  const translation = plainText(value.translation, 12000);
  if (!translation) return '';
  const lines = [translation];
  for (const field of ['brief', 'details']) {
    if (!Array.isArray(value[field])) continue;
    for (const row of value[field].slice(0, 12)) {
      const text = plainText(row?.text, 6000);
      const label = plainText(row?.label, 40);
      if (text) lines.push(label ? `${label}：${text}` : text);
    }
  }
  // Keep a complete translation even if optional explanations exceed the display limit.
  let result = lines.shift();
  for (const line of lines) if (result.length + line.length + 2 <= MAX_FALLBACK) result += `\n\n${line}`;
  return result;
}

export function recoverAnalysis(content, validate) {
  if (typeof content !== 'string' || content.length > MAX_CONTENT) return {};
  const text = content.trim();
  const candidates = [text, ...objectCandidates(text)];
  let fallbackText = '';
  for (const candidate of new Set(candidates)) {
    try { return { analysis: validate(candidate) }; } catch { /* Try bounded object extraction next. */ }
    try { fallbackText ||= readableObject(JSON.parse(candidate)); } catch { /* Not a JSON object. */ }
  }
  if (!fallbackText) {
    const prose = text.replace(/^```(?:text|markdown)?\s*\n([\s\S]*?)\n```$/i, '$1').trim();
    // Do not dump broken JSON, scalar JSON, or code fences into the learning panel.
    if (!/^[\[{"`]/.test(prose) && !/^(?:null|true|false)$/i.test(prose)
        && !/[{}]/.test(prose) && /[\p{L}]/u.test(prose)) fallbackText = plainText(prose);
  }
  return fallbackText ? { fallbackText } : {};
}
