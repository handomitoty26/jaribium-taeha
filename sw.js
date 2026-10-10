// 자리 비움 기록 앱의 오프라인 캐시 — 이 앱 접두어 캐시만 지우고, 화면·계산 파일은 네트워크 우선, 라이브러리·아이콘은 캐시 우선(없으면 받아서 다시 채움)
const PREFIX = "restroom-taeha-";
const CACHE_NAME = PREFIX + "v1";
const ASSETS = [
  "./",
  "./index.html",
  "./logic.js",
  "./vendor/xlsx.full.min.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

// 같은 주소의 다른 기숙사 앱 캐시는 건드리지 않는다(설계 검토 1)
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return;

  // 화면·계산·설정 파일은 네트워크 우선 — 캐시 우선이면 새 화면이 옛 logic.js와 섞여 앱이 멈춘다(10-10 실측).
  // 바뀌지 않는 큰 파일(엑셀 라이브러리·아이콘)만 캐시 우선.
  const isStatic = url.pathname.includes("/vendor/") || url.pathname.includes("/icons/");
  // 캐시 저장이 끝난 뒤에 응답한다 — 워커가 응답 직후 멈춰도 캐시가 반쯤 바뀐 채로 남지 않게(감사실장 P1).
  // 찾을 때도 이 앱의 지금 캐시에서만 찾는다.
  const fetchAndStore = (init) =>
    fetch(req, init).then(async (res) => {
      if (res.ok) {
        const copy = res.clone();
        const cache = await caches.open(CACHE_NAME);
        await cache.put(req, copy);
      }
      return res;
    });
  const fromCache = (key) => caches.open(CACHE_NAME).then((c) => c.match(key));
  if (!isStatic) {
    const isPage = req.mode === "navigate" || url.pathname.endsWith(".html") || url.pathname === scope.pathname;
    event.respondWith(
      fetchAndStore({ cache: "no-cache" }) // 브라우저 HTTP 캐시(GitHub Pages 10분)도 거치지 않고 서버에 확인 — 바뀌지 않았으면 304로 가볍다
        .catch(() => fromCache(req).then((hit) => hit || (isPage ? fromCache("./index.html") : null)).then((hit) => hit || Response.error()))
    );
    return;
  }
  event.respondWith(fromCache(req).then((hit) => hit || fetchAndStore())); // 다른 앱이 지웠어도 다시 채운다
});
