const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'spike_survivor_data.json');

app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.static(__dirname));

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const raw = fs.readFileSync(DB_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        users: parsed.users || {},
        leaderboard: Array.isArray(parsed.leaderboard) ? parsed.leaderboard : []
      };
    }
  } catch (e) {
    console.error('DB 로드 오류, 초기화 진행:', e);
  }
  return { users: {}, leaderboard: [] };
}

function saveDB(data) {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('DB 저장 오류:', e);
  }
}

let db = loadDB();

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, status: 'online', users: Object.keys(db.users).length, records: db.leaderboard.length });
});

app.post('/api/sync/load', (req, res) => {
  try {
    let { playerId, nickname } = req.body || {};
    if (!playerId) {
      playerId = 'player_' + crypto.randomBytes(6).toString('hex');
    }
    const cleanName = String(nickname || '익명생존자').trim().slice(0, 12) || '익명생존자';

    if (!db.users[playerId]) {
      db.users[playerId] = {
        playerId,
        nickname: cleanName,
        gold: 200,
        cards: {},
        clearedStages: [],
        updatedAt: new Date().toISOString()
      };
      saveDB(db);
    }

    const user = db.users[playerId];
    res.json({
      success: true,
      playerId: user.playerId,
      nickname: user.nickname,
      gold: user.gold,
      cards: user.cards || {},
      clearedStages: user.clearedStages || []
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '데이터 로드 실패' });
  }
});

app.post('/api/sync/save', (req, res) => {
  try {
    const { playerId, nickname, gold, cards, clearedStages } = req.body || {};
    if (!playerId) {
      return res.status(400).json({ success: false, message: 'playerId가 필요합니다.' });
    }

    const safeGold = Math.max(0, Math.floor(Number(gold) || 0));
    const safeNickname = String(nickname || '익명생존자').trim().slice(0, 12) || '익명생존자';

    db.users[playerId] = {
      playerId,
      nickname: safeNickname,
      gold: safeGold,
      cards: cards && typeof cards === 'object' ? cards : {},
      clearedStages: Array.isArray(clearedStages) ? clearedStages : [],
      updatedAt: new Date().toISOString()
    };

    saveDB(db);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '데이터 저장 실패' });
  }
});

app.post('/api/ranking/submit', (req, res) => {
  try {
    const { playerId, nickname, stage, survivalSeconds, cleared, kills } = req.body || {};
    if (!playerId || !stage || typeof survivalSeconds !== 'number') {
      return res.status(400).json({ success: false, message: '잘못된 기록 데이터입니다.' });
    }

    const stageNum = Math.min(5, Math.max(1, Number(stage)));
    const maxTimeMap = { 1: 180, 2: 300, 3: 420, 4: 600, 5: 600 };
    const safeTime = Math.min(maxTimeMap[stageNum], Math.max(0, Number(survivalSeconds.toFixed(2))));
    const isCleared = cleared ? 1 : 0;
    const safeKills = Math.max(0, Math.floor(Number(kills) || 0));
    const safeName = String(nickname || '익명생존자').trim().slice(0, 12) || '익명생존자';

    const idx = db.leaderboard.findIndex(
      (item) => item.playerId === playerId && item.stage === stageNum
    );

    if (idx === -1) {
      db.leaderboard.push({
        playerId,
        nickname: safeName,
        stage: stageNum,
        survival_seconds: safeTime,
        cleared: isCleared,
        kills: safeKills,
        created_at: new Date().toISOString()
      });
    } else {
      const prev = db.leaderboard[idx];
      if (isCleared > prev.cleared || safeTime > prev.survival_seconds) {
        db.leaderboard[idx] = {
          playerId,
          nickname: safeName,
          stage: stageNum,
          survival_seconds: safeTime,
          cleared: isCleared,
          kills: safeKills,
          created_at: new Date().toISOString()
        };
      }
    }

    saveDB(db);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '랭킹 등록 실패' });
  }
});

app.get('/api/ranking/:stage', (req, res) => {
  try {
    const stageNum = Math.min(5, Math.max(1, Number(req.params.stage) || 1));

    const rankings = db.leaderboard
      .filter((item) => item.stage === stageNum)
      .sort((a, b) => {
        if (b.cleared !== a.cleared) return b.cleared - a.cleared;
        if (b.survival_seconds !== a.survival_seconds) return b.survival_seconds - a.survival_seconds;
        return b.kills - a.kills;
      })
      .slice(0, 20)
      .map(({ nickname, survival_seconds, cleared, kills, created_at }) => ({
        nickname,
        survival_seconds,
        cleared,
        kills,
        created_at
      }));

    res.json({
      success: true,
      stage: stageNum,
      rankings
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: '랭킹 조회 실패' });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Spike Survivor 통합 서버 & 게임이 포트 ${PORT} 에서 실행 중입니다.`);
});
