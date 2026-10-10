// 화면이 불러오는 로컬 파일이 모두 서비스 워커 캐시 목록에 있는지 확인한다(빠지면 인터넷 없을 때 앱이 깨짐)
const { it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const sw = fs.readFileSync(path.join(root, "sw.js"), "utf8");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));

it("index.html의 로컬 script·link와 manifest 아이콘이 ASSETS에 있고 실제 파일이 있다", () => {
  const assets = [...sw.matchAll(/"\.\/([^"]*)"/g)].map((m) => m[1]).filter(Boolean);
  const used = new Set();
  for (const m of html.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"]+)"/g)) {
    if (!/^https?:/.test(m[1])) used.add(m[1].replace(/^\.\//, ""));
  }
  manifest.icons.forEach((i) => used.add(i.src));
  for (const u of used) {
    assert.ok(assets.includes(u), `${u}가 sw.js ASSETS에 없습니다`);
    assert.ok(fs.existsSync(path.join(root, u)), `${u} 파일이 없습니다`);
  }
  for (const a of assets) assert.ok(fs.existsSync(path.join(root, a)), `ASSETS의 ${a} 파일이 없습니다`);
});

it("서비스 워커는 자기 접두어 캐시만 지운다", () => {
  assert.match(sw, /k\.startsWith\(PREFIX\) && k !== CACHE_NAME/);
  assert.match(sw, /CACHE_NAME = PREFIX \+/);
});

it("캐시 우선은 바뀌지 않는 라이브러리·아이콘뿐 — 화면과 logic.js가 섞이지 않게", () => {
  assert.match(sw, /const isStatic = url\.pathname\.includes\("\/vendor\/"\) \|\| url\.pathname\.includes\("\/icons\/"\);/);
  assert.match(sw, /if \(!isStatic\) \{[\s\S]*?fetchAndStore\(\{ cache: "no-cache" \}\)/);
});

it("캐시 저장을 기다린 뒤 응답하고, 이 앱 캐시에서만 찾는다", () => {
  assert.match(sw, /await cache\.put\(req, copy\);\s*\}\s*return res;/);
  assert.doesNotMatch(sw, /caches\.match\(/);
});
