// logic.js 시험 — 같은 시험을 UTC·서울 두 시간대로 돌려 날짜 계산이 시간대에 흔들리지 않는지 확인한다(가짜 학번·가짜 이름만 사용)
const { describe, it, before } = require("node:test");
const assert = require("node:assert/strict");
const L = require("../logic.js");

const P = L.DEFAULT_PERIODS;
const at = (y, mo, d, h, mi, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime();

for (const tz of ["UTC", "Asia/Seoul"]) {
  describe(`시간대 ${tz}`, () => {
    before(() => {
      process.env.TZ = tz;
    });

    it("자습일은 06:00 경계 — 새벽은 전날", () => {
      assert.equal(L.studyDay(at(2026, 10, 12, 5, 59)), "2026-10-11");
      assert.equal(L.studyDay(at(2026, 10, 12, 6, 0)), "2026-10-12");
      assert.equal(L.studyDay(at(2026, 10, 12, 23, 10)), "2026-10-12");
      assert.equal(L.studyDay(at(2026, 10, 13, 0, 30)), "2026-10-12");
    });

    it("학년도는 3월 시작, 3월 1일 새벽은 전 학년도", () => {
      assert.equal(L.schoolYear(at(2027, 2, 28, 23, 59)), 2026);
      assert.equal(L.schoolYear(at(2027, 3, 1, 0, 0)), 2026);
      assert.equal(L.schoolYear(at(2027, 3, 1, 5, 59)), 2026);
      assert.equal(L.schoolYear(at(2027, 3, 1, 6, 0)), 2027);
    });

    it("교시는 시작 포함·끝 제외, 쉬는 시간과 자습 밖은 0", () => {
      assert.equal(L.periodAt(at(2026, 10, 12, 18, 29), P), 0);
      assert.equal(L.periodAt(at(2026, 10, 12, 18, 30), P), 1);
      assert.equal(L.periodAt(at(2026, 10, 12, 19, 49, 59), P), 1);
      assert.equal(L.periodAt(at(2026, 10, 12, 19, 50), P), 0);
      assert.equal(L.periodAt(at(2026, 10, 12, 20, 10), P), 2);
      assert.equal(L.periodAt(at(2026, 10, 12, 21, 5), P), 0);
      assert.equal(L.periodAt(at(2026, 10, 12, 23, 9), P), 3);
      assert.equal(L.periodAt(at(2026, 10, 12, 23, 10), P), 0);
    });

    it("교시 설정 검증 — 형식·역전·겹침·새벽 시작", () => {
      assert.equal(L.validatePeriods(P), null);
      assert.match(L.validatePeriods([{ no: 1, start: "19:00", end: "18:00" }]), /늦어야/);
      assert.match(L.validatePeriods([{ no: 1, start: "18:00", end: "19:00" }, { no: 2, start: "18:30", end: "20:00" }]), /겹칩니다/);
      assert.match(L.validatePeriods([{ no: 1, start: "1830", end: "19:00" }]), /형식/);
      assert.match(L.validatePeriods([{ no: 1, start: "05:00", end: "07:00" }]), /새벽/);
    });

    it("자습일 + 시각 → 06:00 전이면 다음 날짜", () => {
      assert.equal(L.tsFromDayAndTime("2026-10-12", "21:25"), at(2026, 10, 12, 21, 25));
      assert.equal(L.tsFromDayAndTime("2026-10-12", "00:10"), at(2026, 10, 13, 0, 10));
      assert.equal(L.tsFromDayAndTime("2026-10-12", "25:00"), null);
    });

    describe("학번 입력 판단", () => {
      const base = { inRoster: true, open: null, last: null, periods: P };

      it("자습 시간에 처음 오면 외출", () => {
        const now = at(2026, 10, 12, 19, 40);
        const d = L.decideEntry({ ...base, hak: "1101", now });
        assert.deepEqual(d, { kind: "out", period: 1, day: "2026-10-12", year: 2026 });
      });
      it("자릿수가 틀리면 badFormat, 명단에 없으면 unknown", () => {
        const now = at(2026, 10, 12, 19, 40);
        assert.equal(L.decideEntry({ ...base, hak: "110", now }).kind, "badFormat");
        assert.equal(L.decideEntry({ ...base, hak: "11011", now }).kind, "badFormat");
        assert.equal(L.decideEntry({ ...base, hak: "1101", now, inRoster: false }).kind, "unknown");
      });
      it("쉬는 시간·자습 밖에는 새 외출을 받지 않는다", () => {
        assert.equal(L.decideEntry({ ...base, hak: "1101", now: at(2026, 10, 12, 19, 55) }).kind, "break");
        assert.equal(L.decideEntry({ ...base, hak: "1101", now: at(2026, 10, 12, 23, 30) }).kind, "break");
      });
      it("열린 기록이 있으면 명단에 없어도 복귀, 쉬는 시간에도 복귀", () => {
        const open = L.makeOutRecord({ hak: "1101", now: at(2026, 10, 12, 19, 40), period: 1, reason: "urine" });
        assert.equal(L.decideEntry({ ...base, hak: "1101", now: at(2026, 10, 12, 19, 47), open, inRoster: false }).kind, "return");
        assert.equal(L.decideEntry({ ...base, hak: "1101", now: at(2026, 10, 12, 19, 55), open }).kind, "return");
      });
      it("외출 30초 안 재입력은 이미 기록됨, 30초부터 복귀", () => {
        const open = L.makeOutRecord({ hak: "1101", now: at(2026, 10, 12, 19, 40, 0), period: 1, reason: "urine" });
        assert.equal(L.decideEntry({ ...base, hak: "1101", now: at(2026, 10, 12, 19, 40, 29), open }).kind, "duplicate");
        assert.equal(L.decideEntry({ ...base, hak: "1101", now: at(2026, 10, 12, 19, 40, 30), open }).kind, "return");
      });
      it("복귀 30초 안 재입력도 이미 기록됨(새 외출 아님)", () => {
        const rec = L.applyReturn(L.makeOutRecord({ hak: "1101", now: at(2026, 10, 12, 19, 30), period: 1, reason: "urine" }), at(2026, 10, 12, 19, 40, 0));
        assert.equal(L.decideEntry({ ...base, hak: "1101", now: at(2026, 10, 12, 19, 40, 20), last: rec }).kind, "duplicate");
        assert.equal(L.decideEntry({ ...base, hak: "1101", now: at(2026, 10, 12, 19, 40, 31), last: rec }).kind, "out");
      });
      it("놓친 복귀 — 30분 이상·다른 교시·전날이면 학생이 고른다(결정 12)", () => {
        const open = L.makeOutRecord({ hak: "1101", now: at(2026, 10, 12, 19, 40), period: 1, reason: "urine" });
        assert.equal(L.decideEntry({ ...base, hak: "1101", now: at(2026, 10, 12, 20, 10), open }).kind, "ask"); // 30분
        assert.equal(L.decideEntry({ ...base, hak: "1101", now: at(2026, 10, 12, 20, 9), open }).kind, "return"); // 29분, 쉬는 시간
        const open2 = L.makeOutRecord({ hak: "1101", now: at(2026, 10, 12, 19, 45), period: 1, reason: "urine" });
        assert.equal(L.decideEntry({ ...base, hak: "1101", now: at(2026, 10, 12, 20, 12), open: open2 }).kind, "ask"); // 27분이지만 2교시
        const late = L.makeOutRecord({ hak: "1101", now: at(2026, 10, 12, 23, 5), period: 3, reason: "urine" });
        assert.equal(L.decideEntry({ ...base, hak: "1101", now: at(2026, 10, 12, 23, 20), open: late }).kind, "return"); // 3교시 끝 뒤 15분
        assert.equal(L.decideEntry({ ...base, hak: "1101", now: at(2026, 10, 13, 18, 40), open: late }).kind, "ask"); // 다음 날
        const recent = { ...L.makeOutRecord({ hak: "1101", now: at(2026, 10, 13, 18, 35), period: 1, reason: "urine" }), day: "2026-10-12" };
        assert.equal(L.decideEntry({ ...base, hak: "1101", now: at(2026, 10, 13, 18, 40), open: recent }).kind, "ask"); // 자습일만 다름(5분)
      });
    });

    describe("기록 상태 바꾸기와 흔적", () => {
      it("복귀·소요 분, 시계가 거꾸로면 0분", () => {
        const out = L.makeOutRecord({ hak: "1101", now: at(2026, 10, 12, 19, 40), period: 1, reason: "urine" });
        assert.equal(out.status, "open");
        assert.equal(L.durationMin(L.applyReturn(out, at(2026, 10, 12, 19, 47))), 7);
        assert.equal(L.durationMin(L.applyReturn(out, at(2026, 10, 12, 19, 39))), 0);
        assert.equal(L.durationMin(out), null);
      });
      it("복귀 누락 정리는 분 없음·흔적 남김", () => {
        const out = L.makeOutRecord({ hak: "1101", now: at(2026, 10, 12, 19, 40), period: 1, reason: "urine" });
        const r = L.resolveMissing(out, "학생 선택", at(2026, 10, 12, 20, 30));
        assert.equal(r.status, "resolved");
        assert.equal(L.durationMin(r), null);
        assert.equal(r.trail.length, 1);
        assert.deepEqual(r.trail[0].prev.status, "open");
        assert.equal(r.trail[0].reason, "학생 선택");
      });
      it("방금 취소 — 외출은 취소 상태, 복귀 취소는 다시 열림", () => {
        const out = L.makeOutRecord({ hak: "1101", now: at(2026, 10, 12, 19, 40), period: 1, reason: "urine" });
        assert.equal(L.cancelOut(out, at(2026, 10, 12, 19, 41)).status, "canceled");
        const back = L.applyReturn(out, at(2026, 10, 12, 19, 47));
        const reopened = L.cancelReturn(back, at(2026, 10, 12, 19, 48));
        assert.equal(reopened.status, "open");
        assert.equal(reopened.inAt, null);
        assert.equal(reopened.trail[0].prev.inAt, at(2026, 10, 12, 19, 47));
      });
      it("시각 고치기 — 교시는 그대로, 자습일은 06:00 규칙으로 다시(설정 변경 뒤에도)", () => {
        const out = L.applyReturn(L.makeOutRecord({ hak: "1101", now: at(2026, 10, 12, 21, 25), period: 3, reason: "urine" }), at(2026, 10, 12, 21, 40));
        const e1 = L.editRecord(out, { outAt: at(2026, 10, 12, 21, 35) }, "시각 착오", at(2026, 10, 13, 9, 0));
        assert.equal(e1.rec.period, 3);
        assert.equal(e1.rec.day, "2026-10-12");
        assert.equal(e1.rec.trail[0].prev.outAt, at(2026, 10, 12, 21, 25));
        const e2 = L.editRecord(out, { outAt: at(2026, 10, 13, 0, 10), inAt: at(2026, 10, 13, 0, 20) }, "x", at(2026, 10, 13, 9, 0));
        assert.equal(e2.rec.day, "2026-10-12");
        assert.match(L.editRecord(out, { inAt: at(2026, 10, 12, 21, 0) }, "x", 0).error, /빠릅니다/);
      });
    });

    describe("통계", () => {
      const now = at(2026, 10, 20, 21, 0);
      const mk = (hak, d, h, m, mins, status = "returned", reason = "urine") => {
        const r = L.makeOutRecord({ hak, now: at(2026, 10, d, h, m), period: 2, reason });
        if (status === "returned") return L.applyReturn(r, at(2026, 10, d, h, m) + mins * 60000);
        if (status === "resolved") return L.resolveMissing(r, "", 0);
        return { ...r, status };
      };
      const records = [
        mk("1101", 20, 20, 15, 5), mk("1101", 19, 20, 15, 9), mk("1101", 10, 20, 15, 20), mk("1101", 1, 20, 15, 3),
        mk("1101", 18, 20, 30, 0, "resolved"), mk("1101", 18, 20, 40, 0, "canceled"), mk("1101", 17, 20, 40, 0, "deleted"),
        mk("1102", 20, 20, 20, 4), mk("1102", 15, 20, 20, 30),
        mk("1103", 20, 20, 25, 6), mk("1103", 20, 20, 50, 6), mk("1103", 19, 20, 50, 6),
      ];

      it("학생별 — 최근 7일·30일, 정리됨은 횟수만, 취소·삭제 제외", () => {
        const s = L.studentSummary(records, "1101", now, []);
        const pick = (v) => ({ count: v.count, avg: v.avg, max: v.max });
        assert.deepEqual(pick(s.last7), { count: 3, avg: 7, max: 9 }); // 20·19일 + 18일 정리됨(분 없음)
        assert.deepEqual(pick(s.last30), { count: 5, avg: 9, max: 20 });
        assert.equal(s.last7.byReason.urine, 3);
        assert.equal(s.excluded, false);
      });
      it("최근 7일 많이 나간 학생 — 숫자순, 집계 제외는 빠짐", () => {
        const top = L.topStudents(records, now, [], 7);
        assert.deepEqual(top.map((t) => [t.hak, t.count]), [["1101", 3], ["1103", 3], ["1102", 2]]); // 같은 횟수면 최장 분 순
        const top2 = L.topStudents(records, now, [{ hak: "1101", year: 2026 }], 7);
        assert.deepEqual(top2.map((t) => t.hak), ["1103", "1102"]);
      });
      it("사유별 횟수 — 최근 7일", () => {
        const recs = [mk("1104", 20, 20, 15, 5, "returned", "urine"), mk("1104", 19, 20, 15, 12, "returned", "stool"), mk("1104", 18, 20, 15, 2, "returned", "water"), mk("1104", 18, 20, 40, 0, "resolved", "other")];
        const s = L.studentSummary(recs, "1104", now, []);
        assert.deepEqual(s.last7.byReason, { urine: 1, stool: 1, water: 1, other: 1 });
        assert.equal(L.topStudents(recs, now, [], 7)[0].byReason.stool, 1);
      });
      it("집계 제외는 학년도별 — 다음 학년도 같은 학번에는 적용 안 됨", () => {
        assert.equal(L.isExcluded([{ hak: "1101", year: 2025 }], "1101", 2026), false);
        assert.equal(L.isExcluded([{ hak: "1101", year: 2026 }], "1101", 2026), true);
      });
      it("지난 학년도 기록에는 현재 명단 이름을 붙이지 않는다", () => {
        const roster = { 1101: { name: "가짜일", room: "201" } };
        assert.equal(L.nameFor("1101", roster, 2026, 2026), "가짜일");
        assert.equal(L.nameFor("1101", roster, 2025, 2026), "(명단에 없음)");
        assert.equal(L.nameFor("1999", roster, 2026, 2026), "(명단에 없음)");
      });
    });
  });
}

describe("명단 해석", () => {
  const header = ["학번", "이름", "호실", "학번", "이름", "호실"];
  const sheet = (name, rows) => [{ name, rows }];
  it("머리글 열만 읽고 학년으로 거른다", () => {
    const rows = [["2026학년도 남학생 방배정"], header, ["1101", "가짜일", "201", 2101, "가짜이", "301"], ["1102", "가짜삼", 202, "", "", ""]];
    const r = L.parseRoster(sheet("남학생방배정", rows), "1");
    assert.equal(r.ok, true);
    assert.deepEqual(Object.keys(r.students).sort(), ["1101", "1102"]);
    assert.equal(r.students["1102"].room, "202");
    assert.equal(r.otherGrade, 1);
    assert.equal(L.parseRoster(sheet("학번순방배정공지", rows), "all").count, 3);
  });
  it("제목 줄의 4자리 숫자나 머리글 밖 칸은 학생이 되지 않는다", () => {
    const rows = [["2026", "가짜제목", "x"], header, ["1101", "가짜일", "201", "", "", "", "2027", "가짜밖"]];
    const r = L.parseRoster(sheet("남학생방배정", rows), "all");
    assert.deepEqual(Object.keys(r.students), ["1101"]);
  });
  it("시트·머리글이 없거나 그 학년이 없으면 멈춘다(기존 명단을 지키도록 ok=false)", () => {
    assert.equal(L.parseRoster(sheet("Sheet1", [header]), "1").ok, false);
    assert.match(L.parseRoster(sheet("남학생방배정", [["학생", "명단"]]), "1").error, /머리글/);
    assert.match(L.parseRoster(sheet("남학생방배정", [header, ["2101", "가짜이", "301"]]), "1").error, /1학년/);
  });
  it("호실 머리글이 없으면 명렬표로 보지 않는다", () => {
    const r = L.parseRoster(sheet("남학생방배정", [["학번", "이름", "비고"], ["1101", "가짜일", "x"]]), "1");
    assert.equal(r.ok, false);
    assert.match(r.error, /머리글/);
  });
  it("중복 학번은 첫 사람을 두고 알린다", () => {
    const r = L.parseRoster(sheet("남학생방배정", [header, ["1101", "가짜일", "201", "1101", "가짜사", "202"]]), "1");
    assert.equal(r.students["1101"].name, "가짜일");
    assert.deepEqual(r.dupes, ["1101"]);
  });
  it("교체 전 비교 — 빠지는 사람과 그중 외출 중", () => {
    const d = L.rosterDiff({ 1101: {}, 1102: {}, 1103: {} }, { 1101: {}, 1104: {} }, ["1102"]);
    assert.deepEqual(d, { before: 3, after: 2, removed: 2, removedOpen: 1 });
  });
});

describe("백업", () => {
  const now = new Date(2026, 9, 12, 21, 0).getTime();
  const rec = L.makeOutRecord({ hak: "1101", now, period: 3, reason: "urine" });
  const good = () => L.buildBackup({ records: [rec], settings: { grade: "1", periods: L.DEFAULT_PERIODS, limits: L.DEFAULT_LIMITS, voice: false }, excluded: [], drive: { clientId: "c", folderId: "f", auto: true }, device: "dev1", now });

  it("깊은 검사 — 설정 필수 항목·상태별 들어온 시각·흔적 구조·자습일 일치·변경 번호", () => {
    const bad = (mut) => { const b = JSON.parse(JSON.stringify(good())); mut(b); return L.validateBackup(b).ok; };
    assert.equal(bad(() => {}), true);
    assert.equal(bad((b) => { b.data.settings.periods = null; }), false);
    assert.equal(bad((b) => { b.data.settings.grade = "4"; }), false);
    assert.equal(bad((b) => { b.data.records[0].status = "returned"; }), false); // 복귀인데 들어온 시각 없음
    assert.equal(bad((b) => { b.data.records[0].inAt = b.data.records[0].outAt + 60000; }), false); // 열림인데 들어온 시각 있음
    assert.equal(bad((b) => { b.data.records[0].trail = [{}]; }), false);
    assert.equal(bad((b) => { b.data.records[0].day = "2026-10-11"; }), false);
    assert.equal(bad((b) => { b.data.records[0].year = 2025; }), false);
    assert.equal(bad((b) => { delete b.data.records[0].rev; }), false);
  });
  it("기록이 바뀔 때마다 변경 번호가 오른다", () => {
    assert.equal(rec.rev, 0);
    const back = L.applyReturn(rec, now + 60000);
    assert.equal(back.rev, 1);
    assert.equal(L.cancelReturn(back, now + 70000).rev, 2);
    assert.equal(L.applyReturn(L.withTrail(rec, "returnByTeacher", "x", now), now).rev, 2);
    assert.equal(L.editRecord(rec, { period: 2 }, "x", now).rec.rev, 1);
  });

  it("이 앱 표지·명단 없음·드라이브 폴더 ID 없음", () => {
    const b = good();
    assert.equal(b._app, "restroomTaeha");
    assert.equal(b.count, 1);
    assert.equal(JSON.stringify(b).includes("roster"), false);
    assert.equal(b.data.drive.folderId, undefined);
    assert.equal(L.validateBackup(JSON.parse(JSON.stringify(b))).ok, true);
  });
  it("다른 앱 백업·형식이 틀린 기록·열린 기록 둘은 거부", () => {
    assert.equal(L.validateBackup({ _app: "rollcallAttendance", _ver: 1, store: {} }).ok, false);
    const b1 = good();
    b1.data.records[0] = { ...rec, hak: "<img>" };
    assert.equal(L.validateBackup(b1).ok, false);
    const b2 = good();
    b2.data.records.push({ ...rec, id: "other" });
    assert.match(L.validateBackup(b2).error, /둘 이상/);
    const b3 = good();
    b3.data.records.push({ ...rec });
    assert.match(L.validateBackup(b3).error, /두 번/);
  });
  it("자동 업로드 — 0건이거나 마지막 성공보다 적으면 멈춤", () => {
    assert.equal(L.shouldAutoUpload(0, 0), false);
    assert.equal(L.shouldAutoUpload(5, 8), false);
    assert.equal(L.shouldAutoUpload(8, 8), true);
    assert.equal(L.shouldAutoUpload(3, 0), true);
  });
  it("화면 글자는 이스케이프", () => {
    assert.equal(L.escapeHtml(`<img src=x onerror="a">'`), "&lt;img src=x onerror=&quot;a&quot;&gt;&#39;");
  });
});

describe("자리 비움 사유", () => {
  const now = new Date(2026, 9, 12, 21, 0).getTime();
  it("사유 목록·사유별 기준(대변 15분)", () => {
    assert.deepEqual(L.REASON_CODES, ["urine", "stool", "water", "other"]);
    assert.deepEqual(L.DEFAULT_LIMITS, { urine: 10, stool: 15, water: 5, other: 15 });
    assert.equal(L.limitFor("stool", { stool: 20 }), 20);
    assert.equal(L.limitFor("water", {}), 5);
    assert.equal(L.reasonLabel("water"), "텀블러 물 보충");
    assert.equal(L.reasonLabel("water", true), "물 보충");
  });
  it("사유 없는 기록은 만들 수 없다", () => {
    assert.throws(() => L.makeOutRecord({ hak: "1101", now, period: 3 }), /사유/);
    assert.throws(() => L.makeOutRecord({ hak: "1101", now, period: 3, reason: "x" }), /사유/);
  });
  it("기준 검증 — 1~90분 정수", () => {
    assert.equal(L.validateLimits(L.DEFAULT_LIMITS), null);
    assert.match(L.validateLimits({ ...L.DEFAULT_LIMITS, stool: 0 }), /대변/);
    assert.match(L.validateLimits({ ...L.DEFAULT_LIMITS, water: 2.5 }), /텀블러/);
  });
  it("사감이 사유를 고치면 흔적에 이전 사유가 남는다", () => {
    const r = L.makeOutRecord({ hak: "1101", now, period: 3, reason: "urine" });
    const e = L.editRecord(r, { reasonCode: "stool" }, "사유 착오", now + 1000);
    assert.equal(e.rec.reason, "stool");
    assert.equal(e.rec.trail[0].prev.reason, "urine");
    assert.match(L.editRecord(r, { reasonCode: "nap" }, "x", now).error, /사유/);
  });
  it("백업의 기록에 사유가 없거나 틀리면 거부", () => {
    const rec = L.makeOutRecord({ hak: "1101", now, period: 3, reason: "water" });
    // 설정은 비워 두고(검사 생략) 사유만 틀리게 — 사유 검사만으로 거부되는지 본다
    const ok = L.buildBackup({ records: [rec], settings: null, excluded: [], drive: null, device: "d", now });
    assert.equal(L.validateBackup(JSON.parse(JSON.stringify(ok))).ok, true);
    const b = L.buildBackup({ records: [{ ...rec, reason: undefined }], settings: null, excluded: [], drive: null, device: "d", now });
    assert.match(L.validateBackup(JSON.parse(JSON.stringify(b))).error, /형식/);
    const b2 = L.buildBackup({ records: [rec], settings: { limits: { urine: 10, stool: 15, water: 5, other: 0 } }, excluded: [], drive: null, device: "d", now });
    assert.match(L.validateBackup(b2).error, /설정/);
  });
});

// 이동 자제 경고(사용자 결정 10-13) — 교시 시작 60분 안·오늘 2번째·이번 주(월~일) 5번째, 두 시간대에서
for (const tz of ["UTC", "Asia/Seoul"]) {
  describe(`이동 자제 경고 · 시간대 ${tz}`, () => {
    before(() => {
      process.env.TZ = tz;
    });
    // 2026-10-12는 월요일
    const out = (hak, d, h, m, period, extra = {}) => ({ ...L.makeOutRecord({ hak, now: at(2026, 10, d, h, m), period, reason: "urine" }), ...extra });
    const warn = (records, rec) => L.moveWarning(records, rec, P);

    it("이번 주 시작은 월요일", () => {
      assert.equal(L.weekStart("2026-10-12"), "2026-10-12");
      assert.equal(L.weekStart("2026-10-18"), "2026-10-12");
      assert.equal(L.weekStart("2026-10-11"), "2026-10-05");
    });

    it("교시 시작부터 60분 안이면 경고 — 1교시 19:29까지, 2교시 내내, 3교시 22:19까지", () => {
      for (const [h, m, p, early] of [[18, 30, 1, true], [19, 29, 1, true], [19, 30, 1, false], [20, 10, 2, true], [20, 59, 2, true], [21, 20, 3, true], [22, 19, 3, true], [22, 20, 3, false]]) {
        const r = out("1101", 13, h, m, p);
        const w = warn([], r);
        assert.equal(w.early, early, `${h}:${m}`);
        assert.equal(w.warn, early, `${h}:${m} — 첫 자리 비움은 시작 60분만 본다`);
        assert.equal(w.today, 1);
      }
      assert.equal(warn([], out("1101", 13, 19, 40, 9)).early, false, "설정에 없는 교시는 시작 경고 없음");
    });

    it("오늘(자습일) 2번째부터 경고 — 취소·삭제는 빼고, 복귀 누락 정리는 넣는다", () => {
      const first = out("1101", 13, 19, 35, 1, { status: "returned", inAt: at(2026, 10, 13, 19, 40) });
      const now = out("1101", 13, 19, 45, 1);
      assert.deepEqual([warn([first], now).today, warn([first], now).daily, warn([first], now).warn], [2, true, true]);
      for (const status of ["canceled", "deleted"]) assert.equal(warn([{ ...first, status }], now).daily, false, status);
      assert.equal(warn([{ ...first, status: "resolved", inAt: null }], now).daily, true);
      assert.equal(warn([{ ...first, hak: "1102" }], now).daily, false, "다른 학번");
      assert.equal(warn([{ ...first, year: 2025 }], now).daily, false, "다른 학년도(같은 학번이 다른 학생)");
      const night = out("1101", 12, 22, 30, 3);
      const late = { ...out("1101", 12, 22, 45, 3) };
      assert.equal(warn([night], late).today, 2, "같은 자습일 3교시");
    });

    it("이번 기록은 꼭 한 번 — 목록에 이미 있어도 두 번 세지 않는다", () => {
      const r = out("1101", 13, 19, 40, 1);
      assert.equal(warn([r], r).today, 1);
      assert.equal(warn([r], r).warn, false);
    });

    it("이번 주(월~일) 5번째부터 경고 — 지난 주 일요일·다음 주 월요일은 세지 않는다", () => {
      const days = [12, 13, 14, 15].map((d) => out("1101", d, 19, 40, 1, { status: "returned", inAt: at(2026, 10, d, 19, 45) }));
      const fri = out("1101", 16, 19, 40, 1);
      const w = warn(days, fri);
      assert.deepEqual([w.week, w.weekly, w.daily, w.early, w.warn], [5, true, false, false, true]);
      assert.equal(warn(days.slice(1), fri).weekly, false, "4번째는 아직");
      const lastSun = out("1101", 11, 19, 40, 1, { status: "returned", inAt: at(2026, 10, 11, 19, 45) });
      const nextMon = out("1101", 19, 19, 40, 1, { status: "returned", inAt: at(2026, 10, 19, 19, 45) });
      assert.equal(warn([lastSun, nextMon, ...days.slice(1)], fri).week, 4);
      assert.equal(warn(days, out("1101", 18, 19, 40, 1)).weekly, true, "일요일도 같은 주");
    });
  });
}
