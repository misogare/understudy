import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

const MAX_LINES_DEFAULT = 2000;
const MAX_LINE_CHARS = 2000;

export function toolRead({ file_path, offset, limit }) {
  if (!existsSync(file_path)) return { error: `file not found: ${file_path}` };
  const st = statSync(file_path);
  if (st.isDirectory()) return { error: `${file_path} is a directory` };
  const raw = readFileSync(file_path, 'utf8');
  const lines = raw.split(/\r?\n/);
  const start = Math.max(0, (offset ? offset - 1 : 0));
  const count = Math.min(limit || MAX_LINES_DEFAULT, MAX_LINES_DEFAULT);
  const slice = lines.slice(start, start + count);
  const numbered = slice
    .map((l, i) => `${String(start + i + 1).padStart(6)}\t${l.length > MAX_LINE_CHARS ? l.slice(0, MAX_LINE_CHARS) + '…[line truncated]' : l}`)
    .join('\n');
  const suffix = start + count < lines.length
    ? `\n[showing lines ${start + 1}-${start + slice.length} of ${lines.length}; pass offset/limit to read more]`
    : '';
  return { result: (numbered || '[empty file]') + suffix };
}

export function toolWrite({ file_path, content }) {
  mkdirSync(dirname(file_path), { recursive: true });
  writeFileSync(file_path, content ?? '', 'utf8');
  return { result: `wrote ${Buffer.byteLength(content ?? '', 'utf8')} bytes to ${file_path}` };
}

export function toolEdit({ file_path, old_string, new_string, replace_all }) {
  if (!existsSync(file_path)) return { error: `file not found: ${file_path}` };
  if (old_string == null || old_string === '') return { error: 'old_string must be a non-empty string' };
  if (old_string === new_string) return { error: 'old_string and new_string are identical' };
  const raw = readFileSync(file_path, 'utf8');
  const isCrlf = raw.includes('\r\n');

  // Read normalizes line endings to LF, so the model's old_string carries
  // bare \n even for CRLF files. Match verbatim first; if that misses and the
  // file is CRLF, retry with CRLF-adapted strings.
  let oldS = old_string;
  let newS = new_string ?? '';
  let occurrences = raw.split(oldS).length - 1;
  if (occurrences === 0 && isCrlf && /(?<!\r)\n/.test(oldS)) {
    const oldCrlf = oldS.replace(/\r?\n/g, '\r\n');
    const crlfHits = raw.split(oldCrlf).length - 1;
    if (crlfHits > 0) {
      oldS = oldCrlf;
      newS = newS.replace(/\r?\n/g, '\r\n');
      occurrences = crlfHits;
    }
  }
  // A verbatim match in a CRLF file: keep the replacement's line endings
  // consistent with the file so we don't splice in mixed EOLs.
  if (occurrences > 0 && isCrlf && !oldS.includes('\n') && /(?<!\r)\n/.test(newS)) {
    newS = newS.replace(/\r?\n/g, '\r\n');
  }

  if (occurrences === 0) return { error: `old_string not found in ${file_path}` };
  if (occurrences > 1 && !replace_all) {
    return { error: `old_string occurs ${occurrences} times in ${file_path}; make it unique or pass replace_all: true` };
  }
  const next = replace_all
    ? raw.split(oldS).join(newS)
    : raw.replace(oldS, () => newS); // function form: no $-pattern expansion
  writeFileSync(file_path, next, 'utf8');
  return { result: `replaced ${replace_all ? occurrences : 1} occurrence(s) in ${file_path}` };
}
