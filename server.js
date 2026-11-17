const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// 미들웨어 설정
app.use(cors());
app.use(express.json());

// SQLite 데이터베이스 초기화 (자동 파일 생성)
const db = new Database('spike_survivor.db');

// 테이블 생성
db.exec(`
  -- 유저 세이브 데이터 (골드, 인벤토리 카드, 스테이지 클리어 기록)
  CREATE TABLE IF NOT EXISTS users (
    player_id TEXT PRIMARY KEY,
    nickname TEXT NOT NULL,
    gold INTEGER DEFAULT 200,
    cards_json TEXT DEFAULT '{}',
    cleared_stages_json TEXT DEFAULT '[]',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- 스테이지별 랭킹 테이블
  CREATE TABLE IF NOT EXISTS leaderboard (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id TEXT NOT NULL,
    nickname TEXT NOT NULL,
    stage INTEGER NOT NULL,
    survival_seconds REAL NOT NULL,
    cleared INTEGER DEFAULT 0,
    kills INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_leaderboard_stage ON leaderboard(stage, cleared DESC, survival_seconds DESC);
`);

// ==========================================
// 1. 유저 세이브 데이터 불러오기 (없으면 신규 생성)
// ==========================================
app.post('/api/sync/load', (req, res) => {
  try {
    let { playerId, nickname } = req.body;

    if (!playerId) {
      playerId = 'player_' + crypto.randomBytes(6).toString('hex');
    }
    const cleanName = (nickname || '익명생존자').trim().slice(0, 12);

    let user = db.prepare('SELECT * FROM users WHERE player_id = ?').get(playerId);

    if (!user) {
      db.prepare(`
        INSERT INTO users (player_id, nickname, gold, cards_json, cleared_stages_json)
        VALUES (?, ?, 200, '{}', '[]')
      `).run(playerId, cleanName);

      user = db.prepare('SELECT * FROM users WHERE player_id = ?').get(playerId);
    }

    res.json({
      success: true,
      playerId: user.player_id,
      nickname: user.nickname,
      gold: user.gold,
      cards: JSON.parse(user.cards_json || '{}'),
      clearedStages: JSON.parse(user.cleared_stages_json || '[]')
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '데이터 로드 실패' });
  }
});

// ==========================================
// 2. 유저 세이브 데이터 저장 (상점 뽑기/합성/스테이지 클리어 후 호출)
// ==========================================
app.post('/api/sync/save', (req, res) => {
  try {
    const { playerId, nickname, gold, cards, clearedStages } = req.body;

    if (!playerId) {
      return res.status(400).json({ success: false, message: 'playerId가 필요합니다.' });
    }

    const safeGold = Math.max(0, Math.floor(Number(gold) || 0));
    const safeNickname = (nickname || '익명생존자').trim().slice(0, 12);
    const cardsJson = JSON.stringify(cards || {});
    const clearedJson = JSON.stringify(Array.isArray(clearedStages) ? clearedStages : []);

    const stmt = db.prepare(`
      INSERT INTO users (player_id, nickname, gold, cards_json, cleared_stages_json, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(player_id) DO UPDATE SET
        nickname = excluded.nickname,
        gold = excluded.gold,
        cards_json = excluded.cards_json,
        cleared_stages_json = excluded.cleared_stages_json,
        updated_at = CURRENT_TIMESTAMP
    `);

    stmt.run(playerId, safeNickname, safeGold, cardsJson, clearedJson);

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '데이터 저장 실패' });
  }
});

// ==========================================
// 3. 게임 종료 / 클리어 시 랭킹 기록 제출
// ==========================================
app.post('/api/ranking/submit', (req, res) => {
  try {
    const { playerId, nickname, stage, survivalSeconds, cleared, kills } = req.body;

    if (!playerId || !stage || typeof survivalSeconds !== 'number') {
      return res.status(400).json({ success: false, message: '잘못된 기록 데이터입니다.' });
    }

    const stageNum = Math.min(5, Math.max(1, Number(stage)));
    const maxTimeMap = { 1: 180, 2: 300, 3: 420, 4: 600, 5: 600 };
    const safeTime = Math.min(maxTimeMap[stageNum], Math.max(0, Number(survivalSeconds.toFixed(2))));
    const isCleared = cleared ? 1 : 0;
    const safeKills = Math.max(0, Math.floor(Number(kills) || 0));
    const safeName = (nickname || '익명생존자').trim().slice(0, 12);

    const prev = db.prepare(`
      SELECT id, survival_seconds, cleared FROM leaderboard
      WHERE player_id = ? AND stage = ?
    `).get(playerId, stageNum);

    if (!prev) {
      db.prepare(`
        INSERT INTO leaderboard (player_id, nickname, stage, survival_seconds, cleared, kills)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(playerId, safeName, stageNum, safeTime, isCleared, safeKills);
    } else if (isCleared > prev.cleared || safeTime > prev.survival_seconds) {
      db.prepare(`
        UPDATE leaderboard
        SET nickname = ?, survival_seconds = ?, cleared = ?, kills = ?, created_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(safeName, safeTime, isCleared, safeKills, prev.id);
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '랭킹 등록 실패' });
  }
});

// ==========================================
// 4. 스테이지별 TOP 20 랭킹 조회
// ==========================================
app.get('/api/ranking/:stage', (req, res) => {
  try {
    const stageNum = Math.min(5, Math.max(1, Number(req.params.stage) || 1));

    const rows = db.prepare(`
      SELECT nickname, survival_seconds, cleared, kills, created_at
      FROM leaderboard
      WHERE stage = ?
      ORDER BY cleared DESC, survival_seconds DESC, kills DESC
      LIMIT 20
    `).all(stageNum);

    res.json({
      success: true,
      stage: stageNum,
      rankings: rows
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '랭킹 조회 실패' });
  }
});

// 서버 실행
app.listen(PORT, () => {
  console.log(`🚀 Spike Survivor 서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
});
