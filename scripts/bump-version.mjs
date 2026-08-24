#!/usr/bin/env node
// Поднимает версию лаунчера по количеству изменений из CHANGELOG.md.
//
//   «Новые функции»  → увеличивает второе число (minor): 1.0.0 → 1.1.0
//   «Исправления»    → увеличивает третье число (patch): 1.0.0 → 1.0.1
//
// Например: 5 функций и 4 исправления от версии 1.0.0 дадут 1.5.4.
// Первое число (major) не меняется автоматически.
//
// Запуск:  npm run bump
// Перед запуском добавь изменения в CHANGELOG.md в секцию «## Не выпущено».

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkgPath = path.join(root, 'package.json');
const lockPath = path.join(root, 'package-lock.json');
const changelogPath = path.join(root, 'CHANGELOG.md');

const UNRELEASED = '## Не выпущено';
const FEATURES = 'Новые функции';
const FIXES = 'Исправления';

let pkg;
try {
  pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
} catch {
  console.error('Не найден package.json');
  process.exit(1);
}

let changelog;
try {
  changelog = readFileSync(changelogPath, 'utf-8');
} catch {
  console.error('Не найден CHANGELOG.md — создай его и добавь изменения в секцию «## Не выпущено»');
  process.exit(1);
}

const start = changelog.indexOf(UNRELEASED);
if (start === -1) {
  console.error(`В CHANGELOG.md нет секции «${UNRELEASED}»`);
  process.exit(1);
}

// Содержимое секции «Не выпущено» (до следующего «## »-заголовка)
const contentStart = start + UNRELEASED.length;
let sectionEnd = changelog.indexOf('\n## ', contentStart);
if (sectionEnd === -1) sectionEnd = changelog.length;
const unreleased = changelog.slice(contentStart, sectionEnd);
const rest = changelog.slice(sectionEnd);

function countBullets(header) {
  // Разбиваем секцию «Не выпущено» на под-секции по заголовкам ### —
  // так пустая секция не «проглатывает» пункты следующей.
  const parts = unreleased.split(/\n###\s+/);
  for (const part of parts) {
    if (part.trimStart().startsWith(header)) {
      const body = part.slice(part.indexOf(header) + header.length);
      return (body.match(/^\s*[-*]\s+/gm) || []).length;
    }
  }
  return 0;
}

const features = countBullets(FEATURES);
const fixes = countBullets(FIXES);

if (features + fixes === 0) {
  console.log(`В секции «${UNRELEASED}» нет изменений — версия не меняется.`);
  process.exit(0);
}

const oldVersion = pkg.version;
const [maj, min, pat] = oldVersion.split('.').map(Number);
if (!Number.isFinite(maj) || !Number.isFinite(min) || !Number.isFinite(pat)) {
  console.error(`Не удалось разобрать версию «${oldVersion}» — ожидается формат X.Y.Z`);
  process.exit(1);
}
const next = `${maj}.${min + features}.${pat + fixes}`;

// Обновляем package.json и package-lock.json
pkg.version = next;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
try {
  const lock = JSON.parse(readFileSync(lockPath, 'utf-8'));
  lock.version = next;
  if (lock.packages?.['']) lock.packages[''].version = next;
  writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
} catch {
  // lock-файла нет — не страшно
}

// Обновляем CHANGELOG.md: секция «Не выпущено» становится выпущенной,
// сверху появляется новая пустая секция для следующих изменений.
const date = new Date().toISOString().slice(0, 10);
const freshSection = `${UNRELEASED}\n\n### ${FEATURES}\n\n### ${FIXES}\n`;
const releasedSection = `## ${next} — ${date}` + unreleased.replace(/\s+$/, '');
const tail = rest.trimStart();
const newChangelog = `# Changelog\n\n${freshSection}\n${releasedSection}${tail ? `\n\n${tail}` : ''}\n`;
writeFileSync(changelogPath, newChangelog);

console.log(`Функций: ${features} · Исправлений: ${fixes}`);
console.log(`Версия: ${oldVersion} → ${next} (${pkg.name})`);
console.log('CHANGELOG.md обновлён.');
