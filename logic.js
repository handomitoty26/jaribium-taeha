// 자습 자리 비움 기록의 순수 계산 — 날짜·교시 판정, 자리 비움/복귀 판단, 사유, 기록 상태 변경, 통계, 명단 해석, 백업 검증
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.RestroomLogic = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MIN = 60 * 1000;
  const DAY_BOUNDARY_HOURS = 6; // 자습일 경계 06:00 — 새벽 기록은 전날 자습일(규칙 h)
  const DUPLICATE_MS = 30 * 1000; // 같은 학번이 기록 뒤 30초 안에 또 오면 "이미 기록됨"(규칙 e, 검토 20)
  const STALE_MINUTES = 30; // 열린 기록이 이만큼 지나면 학생이 고른다(사용자 결정 12)
  const DEFAULT_PERIODS = [
    { no: 1, start: "18:30", end: "19:50" },
    { no: 2, start: "20:10", end: "21:00" },
    { no: 3, start: "21:20", end: "23:10" },
  ];
  const ROSTER_SHEETS = ["남학생방배정", "학번순방배정공지"]; // 태하관 아침점호와 같은 명렬표 시트
  const APP_ID = "restroomTaeha";
  const BACKUP_VERSION = 1;
  const STATUSES = ["open", "returned", "resolved", "canceled", "deleted"];
  const LIVE = new Set(["open", "returned", "resolved"]); // 횟수에 드는 상태(취소·삭제 제외)
  // 자리 비움 사유(사용자 결정 17)와 사유별 안전 확인 기준 분(결정 19 — 대변 15분은 사용자 지정)
  const REASONS = [
    { code: "urine", label: "소변", short: "소변" },
    { code: "stool", label: "대변", short: "대변" },
    { code: "water", label: "텀블러 물 보충", short: "물 보충" },
    { code: "other", label: "기타", short: "기타" },
  ];
  const REASON_CODES = REASONS.map((r) => r.code);
  const DEFAULT_LIMITS = { urine: 10, stool: 15, water: 5, other: 15 };
  function reasonLabel(code, short) {
    const r = REASONS.find((x) => x.code === code);
    return r ? (short ? r.short : r.label) : "-";
  }
  function limitFor(code, limits) {
    const v = limits && Number(limits[code]);
    return v >= 1 ? v : DEFAULT_LIMITS[code] || 15;
  }
  function validateLimits(limits) {
    if (!limits || typeof limits !== "object") return "사유별 기준이 없습니다";
    for (const r of REASONS) {
      const v = Number(limits[r.code]);
      if (!Number.isInteger(v) || v < 1 || v > 90) return `${r.label} 기준은 1~90분 사이로 정하세요`;
    }
    return null;
  }

  const pad2 = (n) => String(n).padStart(2, "0");

  // ── 날짜·시각(모두 로컬 시간 — toISOString 날짜 금지, 검토 8) ──
  function localDateStr(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
  function studyDay(ts) {
    const d = new Date(ts);
    d.setHours(d.getHours() - DAY_BOUNDARY_HOURS);
    return localDateStr(d);
  }
  function addDays(dayStr, n) {
    const [y, m, d] = dayStr.split("-").map(Number);
    return localDateStr(new Date(y, m - 1, d + n));
  }
  function schoolYearOfDay(dayStr) {
    const [y, m] = dayStr.split("-").map(Number);
    return m >= 3 ? y : y - 1;
  }
  function schoolYear(ts) {
    return schoolYearOfDay(studyDay(ts));
  }
  function hhmm(ts) {
    const d = new Date(ts);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }
  function stamp(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}`;
  }
  function parseHHMM(s) {
    const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(s == null ? "" : s));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }
  // 자습일 + "HH:MM" → 시각. 06:00 전 시각은 자습일 다음 날짜(새벽)로 본다.
  function tsFromDayAndTime(dayStr, time) {
    const mins = parseHHMM(time);
    if (mins == null || !/^\d{4}-\d{2}-\d{2}$/.test(dayStr)) return null;
    const [y, m, d] = dayStr.split("-").map(Number);
    const extra = mins < DAY_BOUNDARY_HOURS * 60 ? 1 : 0;
    return new Date(y, m - 1, d + extra, Math.floor(mins / 60), mins % 60).getTime();
  }

  // ── 교시 ──
  function validatePeriods(periods) {
    if (!Array.isArray(periods) || !periods.length) return "교시가 없습니다";
    let prevEnd = -1;
    for (const p of periods) {
      const s = parseHHMM(p.start);
      const e = parseHHMM(p.end);
      if (s == null || e == null) return `${p.no}교시 시각 형식이 올바르지 않습니다`;
      if (s >= e) return `${p.no}교시 끝 시각이 시작 시각보다 늦어야 합니다`;
      if (s < prevEnd) return `${p.no}교시가 앞 교시와 겹칩니다`;
      if (s < DAY_BOUNDARY_HOURS * 60) return `${p.no}교시가 새벽 6시 전에 시작할 수 없습니다`;
      prevEnd = e;
    }
    return null;
  }
  // 시작 포함·끝 제외, 분 단위. 자습 시간이 아니면 0.
  function periodAt(ts, periods) {
    const m = new Date(ts).getHours() * 60 + new Date(ts).getMinutes();
    for (const p of periods) {
      if (m >= parseHHMM(p.start) && m < parseHHMM(p.end)) return p.no;
    }
    return 0;
  }

  // ── 학번 하나가 들어왔을 때 할 일(저장은 하지 않는다) ──
  // open: 이 학번의 열린 기록(없으면 null), last: 이 학번의 가장 최근 기록(취소·삭제 제외)
  function decideEntry({ hak, now, inRoster, open, last, periods }) {
    if (!/^\d{4}$/.test(String(hak))) return { kind: "badFormat" };
    if (open) {
      // 열린 기록이 있으면 명단과 상관없이 복귀를 먼저 본다(검토 18)
      if (now - open.outAt < DUPLICATE_MS) return { kind: "duplicate", rec: open };
      const p = periodAt(now, periods);
      const stale = open.day !== studyDay(now) || (p !== 0 && p !== open.period) || now - open.outAt >= STALE_MINUTES * MIN;
      return { kind: stale ? "ask" : "return", rec: open, period: p };
    }
    if (!inRoster) return { kind: "unknown" };
    if (last && last.status === "returned" && last.inAt != null && now - last.inAt < DUPLICATE_MS) {
      return { kind: "duplicate", rec: last };
    }
    const p = periodAt(now, periods);
    if (!p) return { kind: "break" };
    return { kind: "out", period: p, day: studyDay(now), year: schoolYear(now) };
  }

  // ── 기록 만들기·바꾸기(원래 값은 trail에 남긴다, 규칙 f) ──
  function newId(now, hak) {
    return `${now.toString(36)}-${hak}-${Math.random().toString(36).slice(2, 8)}`;
  }
  // rev는 기록이 바뀔 때마다 1씩 오른다 — 저장할 때 DB의 rev가 바로 앞 값이어야 한다(다른 화면이 먼저 바꾼 것을 덮지 않게, 감사실장 P1)
  function makeOutRecord({ hak, now, period, reason }) {
    if (!REASON_CODES.includes(reason)) throw new Error("자리 비움 사유가 올바르지 않습니다");
    return { id: newId(now, hak), hak: String(hak), year: schoolYear(now), day: studyDay(now), period, reason, outAt: now, inAt: null, status: "open", rev: 0, trail: [] };
  }
  const nextRev = (rec) => (Number.isInteger(rec.rev) ? rec.rev : 0) + 1;
  function withTrail(rec, action, reason, now) {
    const prev = { status: rec.status, outAt: rec.outAt, inAt: rec.inAt, period: rec.period, day: rec.day, reason: rec.reason };
    return { ...rec, rev: nextRev(rec), trail: [...(rec.trail || []), { at: now, action, reason: reason || "", prev }] };
  }
  function applyReturn(rec, now) {
    return { ...rec, rev: nextRev(rec), inAt: now, status: "returned" };
  }
  // 복귀 누락으로 정리 — 소요 분 없음, 횟수에는 든다(검토 11)
  function resolveMissing(rec, reason, now) {
    return { ...withTrail(rec, "resolve", reason, now), status: "resolved", inAt: null };
  }
  function cancelOut(rec, now) {
    return { ...withTrail(rec, "cancel", "방금 취소", now), status: "canceled" };
  }
  function cancelReturn(rec, now) {
    return { ...withTrail(rec, "cancelReturn", "방금 취소", now), status: "open", inAt: null };
  }
  function reopenResolved(rec, now) {
    return { ...withTrail(rec, "reopen", "방금 취소", now), status: "open", inAt: null };
  }
  function deleteRecord(rec, reason, now) {
    return { ...withTrail(rec, "delete", reason, now), status: "deleted" };
  }
  // 시각 고치기 — 교시는 저장 값(사감이 고르면 그 값), 자습일·학년도는 고친 나간 시각으로 06:00 규칙만 다시(검토 12)
  // reasonCode는 자리 비움 사유(소변 등), note는 고친 까닭(흔적에 남음)
  function editRecord(rec, { outAt, inAt, period, reasonCode }, note, now) {
    if (reasonCode != null && !REASON_CODES.includes(reasonCode)) return { error: "자리 비움 사유가 올바르지 않습니다" };
    const next = { ...withTrail(rec, "edit", note, now) };
    if (reasonCode != null) next.reason = reasonCode;
    if (outAt != null) {
      next.outAt = outAt;
      next.day = studyDay(outAt);
      next.year = schoolYear(outAt);
    }
    if (inAt !== undefined) next.inAt = inAt;
    if (period != null) next.period = period;
    if (next.inAt != null && next.inAt < next.outAt) return { error: "들어온 시각이 나간 시각보다 빠릅니다" };
    if (next.status === "returned" && next.inAt == null) return { error: "복귀 기록에는 들어온 시각이 있어야 합니다" };
    return { rec: next };
  }
  function durationMin(rec) {
    if (rec.status !== "returned" || rec.inAt == null) return null;
    return Math.max(0, Math.round((rec.inAt - rec.outAt) / MIN));
  }

  // ── 통계(자습 중 외출만 기록되므로 모든 기록이 자습 중 — 현재 학년도·집계 제외·취소·삭제를 거른다, 규칙 d) ──
  function isExcluded(excluded, hak, year) {
    return (excluded || []).some((e) => e.hak === hak && e.year === year);
  }
  function summarize(list) {
    const mins = list.map(durationMin).filter((m) => m != null);
    const byReason = {};
    for (const code of REASON_CODES) byReason[code] = list.filter((r) => r.reason === code).length;
    return {
      count: list.length,
      byReason,
      avg: mins.length ? Math.round(mins.reduce((a, b) => a + b, 0) / mins.length) : null,
      max: mins.length ? Math.max(...mins) : null,
    };
  }
  function inLastDays(rec, today, days) {
    return rec.day >= addDays(today, -(days - 1)) && rec.day <= today;
  }
  function studentSummary(records, hak, now, excluded) {
    const today = studyDay(now);
    const year = schoolYear(now);
    const mine = records.filter((r) => r.hak === hak && r.year === year && LIVE.has(r.status)).sort((a, b) => b.outAt - a.outAt);
    return {
      excluded: isExcluded(excluded, hak, year),
      last7: summarize(mine.filter((r) => inLastDays(r, today, 7))),
      last30: summarize(mine.filter((r) => inLastDays(r, today, 30))),
      year: summarize(mine),
      records: mine,
    };
  }
  function topStudents(records, now, excluded, days) {
    const today = studyDay(now);
    const year = schoolYear(now);
    const by = new Map();
    for (const r of records) {
      if (r.year !== year || !LIVE.has(r.status) || !inLastDays(r, today, days) || isExcluded(excluded, r.hak, year)) continue;
      if (!by.has(r.hak)) by.set(r.hak, []);
      by.get(r.hak).push(r);
    }
    return [...by.entries()]
      .map(([hak, list]) => ({ hak, ...summarize(list) }))
      .sort((a, b) => b.count - a.count || (b.max || 0) - (a.max || 0) || a.hak.localeCompare(b.hak));
  }
  // ── 이동 자제 경고(사용자 결정 10-13) — 방금 저장한 자리 비움 기록을 넣어 센다 ──
  // 교시 시작부터 60분 안에 나갔거나, 오늘(자습일) 2번째 이상, 이번 주(자습일 기준 월~일) 5번째 이상이면 경고. 집계 제외 학생도 똑같이.
  const WARN_EARLY_MINUTES = 60;
  const WARN_DAY_COUNT = 2;
  const WARN_WEEK_COUNT = 5;
  function weekStart(dayStr) {
    const [y, m, d] = dayStr.split("-").map(Number);
    return addDays(dayStr, -((new Date(y, m - 1, d).getDay() + 6) % 7)); // 월요일
  }
  function moveWarning(records, rec, periods) {
    // 같은 학번·같은 학년도(학번이 해마다 바뀜)·살아 있는 기록만, 이번 기록은 꼭 한 번
    const mine = records.filter((r) => r.hak === rec.hak && r.year === rec.year && LIVE.has(r.status) && r.id !== rec.id).concat([rec]);
    const mon = weekStart(rec.day);
    const sun = addDays(mon, 6);
    const today = mine.filter((r) => r.day === rec.day).length;
    const week = mine.filter((r) => r.day >= mon && r.day <= sun).length;
    const p = (periods || []).find((x) => x.no === rec.period);
    const sinceStart = p ? new Date(rec.outAt).getHours() * 60 + new Date(rec.outAt).getMinutes() - parseHHMM(p.start) : null;
    const early = sinceStart != null && sinceStart >= 0 && sinceStart < WARN_EARLY_MINUTES;
    const daily = today >= WARN_DAY_COUNT;
    const weekly = week >= WARN_WEEK_COUNT;
    return { early, daily, weekly, today, week, warn: early || daily || weekly };
  }

  function dayRecords(records, day) {
    return records.filter((r) => r.day === day && LIVE.has(r.status)).sort((a, b) => a.outAt - b.outAt);
  }
  function openRecords(records) {
    return records.filter((r) => r.status === "open").sort((a, b) => a.outAt - b.outAt);
  }
  function latestLive(records, hak) {
    let best = null;
    for (const r of records) if (r.hak === hak && LIVE.has(r.status) && (!best || r.outAt > best.outAt)) best = r;
    return best;
  }
  function recordDays(records) {
    return [...new Set(records.filter((r) => LIVE.has(r.status)).map((r) => r.day))].sort();
  }
  // 이름은 현재 학년도 기록에만 현재 명단에서 붙인다(검토 14)
  function nameFor(hak, roster, recYear, currentYear) {
    return recYear === currentYear && roster && roster[hak] ? roster[hak].name : "(명단에 없음)";
  }

  // ── 명단 해석(머리글 행의 학번·이름·호실 열만 읽는다, 검토 23) ──
  // sheets: [{ name, rows: [[셀...], ...] }], grade: "1"|"2"|"3"|"all"
  function parseRoster(sheets, grade) {
    const sheet = ROSTER_SHEETS.map((n) => sheets.find((s) => s.name === n)).find(Boolean);
    if (!sheet) return { ok: false, error: "명렬표 시트(남학생방배정)를 찾지 못했습니다 — 아침점호에 넣는 명렬표 파일을 선택하세요" };
    const norm = (v) => String(v == null ? "" : v).replace(/\s+/g, "");
    let headerRow = -1;
    let groups = [];
    for (let r = 0; r < Math.min(sheet.rows.length, 30) && headerRow < 0; r++) {
      const row = sheet.rows[r] || [];
      const g = [];
      for (let c = 0; c < row.length; c++) {
        // 학번·이름·호실 세 머리글이 모두 있어야 아침점호 명렬표로 본다(감사실장 P3)
        if (norm(row[c]) === "학번" && /^(이름|성명)$/.test(norm(row[c + 1])) && norm(row[c + 2]) === "호실") {
          g.push({ hak: c, name: c + 1, room: c + 2 });
        }
      }
      if (g.length) {
        headerRow = r;
        groups = g;
      }
    }
    if (headerRow < 0) return { ok: false, error: "머리글(학번·이름·호실)을 찾지 못했습니다 — 아침점호에 넣는 명렬표 파일을 선택하세요" };
    const students = {};
    const dupes = [];
    let otherGrade = 0;
    for (let r = headerRow + 1; r < sheet.rows.length; r++) {
      const row = sheet.rows[r] || [];
      for (const g of groups) {
        const hak = norm(row[g.hak]);
        const name = String(row[g.name] == null ? "" : row[g.name]).trim();
        if (!/^\d{4}$/.test(hak) || !name) continue;
        if (grade !== "all" && hak[0] !== String(grade)) {
          otherGrade++;
          continue;
        }
        if (students[hak]) {
          dupes.push(hak);
          continue;
        }
        students[hak] = { name, room: norm(row[g.room]) };
      }
    }
    const count = Object.keys(students).length;
    if (!count) {
      return { ok: false, error: grade === "all" ? "학생을 한 명도 찾지 못했습니다" : `${grade}학년 학생을 한 명도 찾지 못했습니다 — 자습실 학년 설정을 확인하세요` };
    }
    return { ok: true, students, count, dupes, otherGrade, sheet: sheet.name };
  }
  // 명단 교체 전 확인용 — 빠지는 사람과 그중 외출 중인 사람(검토 18)
  function rosterDiff(oldStudents, newStudents, openHaks) {
    const removed = Object.keys(oldStudents || {}).filter((h) => !newStudents[h]);
    return {
      before: Object.keys(oldStudents || {}).length,
      after: Object.keys(newStudents).length,
      removed: removed.length,
      removedOpen: removed.filter((h) => openHaks.includes(h)).length,
    };
  }

  // ── 백업(이 앱 표지·허용 필드만, 명단은 넣지 않는다 — 검토 2·결정 13) ──
  function lastDay(records) {
    const days = recordDays(records);
    return days.length ? days[days.length - 1] : "-";
  }
  function buildBackup({ records, settings, excluded, drive, device, now }) {
    return {
      _app: APP_ID,
      _ver: BACKUP_VERSION,
      exportedAt: new Date(now).toISOString(),
      device,
      grade: settings && settings.grade,
      count: records.length,
      lastDay: lastDay(records),
      data: {
        records,
        settings,
        excluded: excluded || [],
        drive: drive ? { clientId: drive.clientId || "", auto: !!drive.auto, keepDays: drive.keepDays || 30 } : null,
      },
    };
  }
  // 기록 하나를 깊게 검사 — 자습일·학년도가 나간 시각과 맞고, 상태마다 들어온 시각 조건이 맞고, 흔적 구조도 온전해야 한다(감사실장 P1)
  function validTrail(t) {
    return (
      t && typeof t === "object" && Number.isFinite(t.at) && typeof t.action === "string" && typeof t.reason === "string" &&
      t.prev && typeof t.prev === "object" && STATUSES.includes(t.prev.status) && Number.isFinite(t.prev.outAt)
    );
  }
  function validRecord(r) {
    if (!r || typeof r !== "object") return false;
    const basic =
      typeof r.id === "string" && r.id.length > 0 && r.id.length < 80 &&
      /^\d{4}$/.test(r.hak) &&
      Number.isInteger(r.period) && r.period >= 1 && r.period <= 9 &&
      REASON_CODES.includes(r.reason) &&
      Number.isFinite(r.outAt) &&
      (r.inAt === null || Number.isFinite(r.inAt)) &&
      STATUSES.includes(r.status) &&
      Number.isInteger(r.rev) && r.rev >= 0 &&
      Array.isArray(r.trail) && r.trail.every(validTrail);
    if (!basic) return false;
    if (r.day !== studyDay(r.outAt) || r.year !== schoolYear(r.outAt)) return false;
    if (r.status === "returned" && r.inAt === null) return false;
    if ((r.status === "open" || r.status === "resolved") && r.inAt !== null) return false;
    return true;
  }
  // 설정 깊은 검사 — 복원하면 그대로 쓰이므로 필수 항목이 모두 맞아야 한다
  function validSettings(s) {
    return (
      s && typeof s === "object" &&
      [null, "1", "2", "3", "all"].includes(s.grade === undefined ? null : s.grade) &&
      !validatePeriods(s.periods) &&
      !validateLimits(s.limits) &&
      (s.voice === undefined || typeof s.voice === "boolean")
    );
  }
  function validateBackup(obj) {
    if (!obj || obj._app !== APP_ID) return { ok: false, error: "이 앱(태하관 자리 비움 기록)의 백업 파일이 아닙니다" };
    if (obj._ver !== BACKUP_VERSION) return { ok: false, error: `지원하지 않는 백업 버전입니다(${obj._ver})` };
    const d = obj.data;
    if (!d || !Array.isArray(d.records)) return { ok: false, error: "백업에 기록 목록이 없습니다" };
    const bad = d.records.findIndex((r) => !validRecord(r));
    if (bad >= 0) return { ok: false, error: `${bad + 1}번째 기록의 형식이 올바르지 않습니다` };
    const ids = new Set();
    const openHaks = new Set();
    for (const r of d.records) {
      if (ids.has(r.id)) return { ok: false, error: "같은 번호의 기록이 두 번 있습니다" };
      ids.add(r.id);
      if (r.status === "open") {
        if (openHaks.has(r.hak)) return { ok: false, error: `학번 ${r.hak}의 열린 기록이 둘 이상입니다` };
        openHaks.add(r.hak);
      }
    }
    if (d.excluded != null && !(Array.isArray(d.excluded) && d.excluded.every((e) => e && /^\d{4}$/.test(e.hak) && Number.isInteger(e.year)))) {
      return { ok: false, error: "집계 제외 목록 형식이 올바르지 않습니다" };
    }
    if (d.settings != null && !validSettings(d.settings)) {
      return { ok: false, error: "설정 형식이 올바르지 않습니다" };
    }
    return { ok: true };
  }
  // 자동 업로드 여부 — 기록이 0건이거나 마지막 성공보다 적으면 올리지 않는다(검토 6)
  function shouldAutoUpload(count, lastOkCount) {
    if (!count) return false;
    if (lastOkCount && count < lastOkCount) return false;
    return true;
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  return {
    LOGIC_VERSION: 3, // index.html이 기대하는 판 — 다르면 화면이 멈추지 않고 다시 열라고 안내한다
    DEFAULT_PERIODS, ROSTER_SHEETS, APP_ID, BACKUP_VERSION, STATUSES, DUPLICATE_MS, STALE_MINUTES,
    REASONS, REASON_CODES, DEFAULT_LIMITS, reasonLabel, limitFor, validateLimits,
    localDateStr, studyDay, addDays, schoolYear, schoolYearOfDay, hhmm, stamp, parseHHMM, tsFromDayAndTime,
    validatePeriods, periodAt, decideEntry,
    makeOutRecord, withTrail, applyReturn, resolveMissing, cancelOut, cancelReturn, reopenResolved, deleteRecord, editRecord, durationMin,
    isExcluded, studentSummary, topStudents, weekStart, moveWarning, dayRecords, openRecords, latestLive, recordDays, nameFor,
    parseRoster, rosterDiff, lastDay, buildBackup, validRecord, validSettings, validateBackup, shouldAutoUpload, escapeHtml,
  };
});
