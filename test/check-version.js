'use strict';
// 版本号一致性校验：版本号以 CHANGELOG.md 的最新版本标题为准，
// 应用内软件详情与最新 git tag 必须与之一致。
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const APP_HTML = path.join(ROOT, 'APPs', 'Weave.html');
const CHANGELOG = path.join(ROOT, 'CHANGELOG.md');

let failed = 0;
function check(cond, msg) {
  console.log((cond ? '  ✅ ' : '  ❌ ') + msg);
  if (!cond) failed++;
}

// 应用内版本号取软件详情面板的版本行，非 I18N 字典中的标签键。
function appVersion() {
  const html = fs.readFileSync(APP_HTML, 'utf8');
  const m = html.match(/data-i18n="about\.version"[^>]*>[^<]*<\/label>\s*<span>(v[\d.]+)<\/span>/);
  return m ? m[1] : null;
}

function changelogVersion() {
  const md = fs.readFileSync(CHANGELOG, 'utf8');
  const m = md.match(/^##\s+(v[\d.]+)\s*$/m);
  return m ? m[1] : null;
}

// 无 git、无 tag 或不在仓库中时返回 null，该比对跳过。
function latestTag() {
  try {
    const out = execFileSync('git', ['describe', '--tags', '--abbrev=0'], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    return /^v?[\d.]+$/.test(out) ? out : null;
  } catch (e) {
    return null;
  }
}

const log = changelogVersion();
const app = appVersion();
const tag = latestTag();

check(!!log, 'CHANGELOG.md 最新版本: ' + (log || '未找到'));
check(!!app, 'APPs/Weave.html 软件详情版本号: ' + (app || '未找到'));
check(app === log, '应用内版本号与 CHANGELOG 一致' + (app === log ? '（' + app + '）' : ': ' + app + ' ≠ ' + log));
if (tag) {
  check(tag === log, '最新 git tag 与 CHANGELOG 一致' + (tag === log ? '（' + tag + '）' : ': ' + tag + ' ≠ ' + log));
} else {
  console.log('  ⏭  未找到 git tag，跳过 tag 比对');
}

if (failed) {
  console.log('\n❌ 版本号校验失败: ' + failed + ' 项');
  process.exit(1);
}
console.log('\n✅ 版本号校验通过');
