'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const jsFiles = ['extension.js', ...['src', 'media'].flatMap((folder) =>
  fs.readdirSync(path.join(root, folder)).filter((name) => name.endsWith('.js')).map((name) => `${folder}/${name}`))];
for (const file of jsFiles) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
for (const language of ['', '.ru', '.zh-cn']) {
  const file = `package.nls${language}.json`;
  const strings = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  for (const key of ['extension.description', 'command.schedule', 'command.manage', 'command.bind', 'command.diagnose']) {
    if (typeof strings[key] !== 'string' || !strings[key]) throw new Error(`${file}: missing ${key}`);
  }
}
const iconFonts = Object.values(manifest.contributes.icons).map((icon) => icon.default.fontPath);
for (const file of [manifest.main, manifest.icon, ...iconFonts, 'media/scheduler.css', ...jsFiles.filter((name) => name.startsWith('media/'))]) {
  if (!fs.existsSync(path.join(root, file))) throw new Error(`Missing extension asset: ${file}`);
}
console.log(`Checked ${jsFiles.length} JavaScript files, localization files, and extension assets.`);
