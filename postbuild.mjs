// postbuild.mjs - 构建后拷贝静态资源
import { cpSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const root = process.cwd();
const dist = resolve(root, 'dist');

const copies = [
  { src: 'manifest.json', dest: 'manifest.json' },
  { src: 'src/devtools/index.html', dest: 'devtools/index.html' },
  { src: 'src/panel/index.html', dest: 'panel/index.html' },
  { src: 'src/panel/styles/panel.css', dest: 'panel/styles/panel.css' },
];

// 拷贝 icons
if (existsSync(resolve(root, 'public'))) {
  copies.push({ src: 'public', dest: '.' });
} else if (existsSync(resolve(root, 'src/icons'))) {
  copies.push({ src: 'src/icons', dest: '.' });
}

for (const { src, dest } of copies) {
  const from = resolve(root, src);
  const to = resolve(dist, dest);
  const destDir = resolve(to, '..');
  if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
  if (existsSync(from)) {
    cpSync(from, to, { recursive: true });
    console.log(`  ✓ ${src} → dist/${dest}`);
  } else {
    console.warn(`  ⚠ ${src} not found, skipping`);
  }
}

console.log('\nPostbuild done.');
