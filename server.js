const express = require('express');
const { HorseRacingAPI } = require('hkjc-api');
const mqtt = require('mqtt');
const zlib = require('zlib');

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

// ── SSE 客戶端池 ──────────────────────────────────────────────────────────────
const sseClients = new Set();

app.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  sseClients.add(res);

  const hb = setInterval(() => {
    try {
      res.write(': hb\n\n');
    } catch (e) {}
  }, 15000);

  req.on('close', () => {
    clearInterval(hb);
    sseClients.delete(res);
  });
});

function broadcastSSE(payload) {
  const str = `data: ${JSON.stringify(payload)}\n\n`;
  for (const c of sseClients) {
    try {
      c.write(str);
    } catch (e) {}
  }
}

// odd.py 呼叫此 endpoint 推送數據
app.post('/push', (req, res) => {
  broadcastSSE(req.body);
  res.json({ ok: true, clients: sseClients.size });
});

// ── MQTT 實時緩存 ─────────────────────────────────────────────────────────────
const mqttLive = {};

function getToday() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function initMqtt() {
  const today = getToday();

  const client = mqtt.connect('wss://ueb.hkjc.com:52443/', {
    username: 'jcbw2',
    password: '2Wt5tGOzRm]yp~N',
    clientId: `jcbw2_${Date.now()}`,
    protocolVersion: 5,
    rejectUnauthorized: false,
  });

  client.on('connect', () => {
    console.log('✅ MQTT Connected!');
    client.subscribe(`hk/d/prdt/wager/evt/01/upd/racing/${today}/+/+/win/+/expr/odds/full`);
    client.subscribe(`hk/d/prdt/wager/evt/01/upd/racing/${today}/+/+/pla/+/expr/odds/full`);
    client.subscribe(`hk/d/prdt/wager/evt/01/upd/racing/${today}/+/+/qin/+/expr/odds/full`);
    client.subscribe(`hk/d/prdt/wager/evt/01/upd/racing/${today}/+/+/qpl/+/expr/odds/full`);
    client.subscribe(`hk/d/prdt/wager/evt/01/upd/racing/${today}/+/+/win/inv`);
    client.subscribe(`hk/d/prdt/wager/evt/01/upd/racing/${today}/+/+/qin/inv`);
    client.subscribe(`hk/d/prdt/wager/evt/01/upd/racing/${today}/+/+/qpl/inv`);
  });

  client.on('message', (topic, payload) => {
    try {
      const raw = (payload[0] === 0x1f && payload[1] === 0x8b)
        ? zlib.gunzipSync(payload)
        : payload;

      const data = JSON.parse(raw.toString());
      const parts = topic.split('/');
      const venue = parts[9].toUpperCase();
      const raceNo = String(parseInt(parts[10]));
      const oddsType = parts[11];

      if (!mqttLive[venue]) mqttLive[venue] = {};
      if (!mqttLive[venue][raceNo]) mqttLive[venue][raceNo] = {
        win: {}, pla: {}, qin: {}, qpl: {},
        winInv: {}, qinInv: {}, qplInv: {},
        pool: 0, qinPool: 0, qplPool: 0, updAt: ''
      };

      const slot = mqttLive[venue][raceNo];

      if (data.cbs && ['win', 'pla', 'qin', 'qpl'].includes(oddsType)) {
        const odsMap = {};
        const invMap = {};

        data.cbs.forEach(cb => {
          odsMap[cb.cb] = cb.ods || '';
          invMap[cb.cb] = cb.inv || 0;
        });

        slot[oddsType] = odsMap;
        if (oddsType === 'win') slot.winInv = invMap;
        if (oddsType === 'qin') slot.qinInv = invMap;
        if (oddsType === 'qpl') slot.qplInv = invMap;
        slot.pool = data.pInv || slot.pool;
        slot.updAt = data.updAt || '';
      }

      if (topic.endsWith('/win/inv') && data.ttlInv) slot.pool = data.ttlInv.net || slot.pool;
      if (topic.endsWith('/qin/inv') && data.ttlInv) slot.qinPool = data.ttlInv.net || slot.qinPool;
      if (topic.endsWith('/qpl/inv') && data.ttlInv) slot.qplPool = data.ttlInv.net || slot.qplPool;
    } catch (e) {}
  });

  client.on('error', e => console.log('[MQTT ERROR]', e.message));
  client.on('reconnect', () => console.log('[MQTT] Reconnecting...'));
}

initMqtt();

// ── hkjc-api (馬匹資料) ────────────────────────────────────────────────────────
const api = new HorseRacingAPI();
const cardCache = {};
const cardCacheTs = {};

async function getCardAndRaceInfo(venue, raceNo) {
  const key = `${venue}_${raceNo}`;
  const now = Date.now();

  if (cardCache[key] && (now - cardCacheTs[key]) < 300000) {
    return { cardMap: cardCache[key], raceInfo: cardCache[`${key}_info`] || {} };
  }

  let cardMap = {};
  let raceInfo = {};

  try {
    const { raceMeetings } = await api.getRaceMeetings();
    const meeting = raceMeetings.find(m => String(m.venueCode || '').toUpperCase() === String(venue || '').toUpperCase());

    if (meeting) {
      const race = meeting.races.find(r => Number(r.no) === Number(raceNo));
      if (race) {
        const trackDesc = race.raceTrack?.description_ch || race.raceTrack?.description_en || '';
        const courseDesc = race.raceCourse?.description_ch || race.raceCourse?.description_en || '';
        const courseCode = race.raceCourse?.displayCode || '';
        const courseFull = courseDesc ? (courseCode ? `${courseDesc}(${courseCode})` : courseDesc) : courseCode;

        let raceTime = race.postTime || '';
        try {
          if (raceTime) {
            const d = new Date(raceTime);
            raceTime = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
          }
        } catch (e) {}

        raceInfo = {
          race_time: raceTime,
          distance: race.distance ? `${race.distance}m` : '',
          track: trackDesc,
          course: courseFull,
          race_class: race.raceClass_ch || race.raceClass_en || race.raceClass || '',
          going: race.go_ch || race.go_en || race.going || '',
          cla_code: race.claCode || '',
          race_name: race.raceName_ch || race.raceName_en || '',
          field_size: race.wageringFieldSize ? `${race.wageringFieldSize}匹` : '',
        };

        cardMap = {};
        for (const r of (race.runners || [])) {
          const no = String(r.no);
          cardMap[no] = {
            name: r.name_ch || r.name_en || '',
            barrier: String(r.barrierDrawNumber || ''),
            jockey: r.jockey?.name_ch || r.jockey?.name_en || '',
            trainer: r.trainer?.name_ch || r.trainer?.name_en || '',
          };
        }

        cardCache[key] = cardMap;
        cardCache[`${key}_info`] = raceInfo;
        cardCacheTs[key] = now;
      }
    }
  } catch (e) {
    console.log('[WARN] getCardAndRaceInfo:', e.message.substring(0, 200));
  }

  return { cardMap, raceInfo };
}

// ── /odds ─────────────────────────────────────────────────────────────────────
app.get('/odds', async (req, res) => {
  try {
    const { venue, raceno } = req.query;
    const raceNo = parseInt(raceno, 10) || 1;
    const raceNoStr = String(raceNo);
    const venueStr = String(venue || '').toUpperCase();

    const { cardMap, raceInfo } = await getCardAndRaceInfo(venueStr, raceNo);
    const live = mqttLive[venueStr]?.[raceNoStr];

    if (live && Object.keys(live.win).length > 0) {
      const allNos = [...new Set([...Object.keys(live.win), ...Object.keys(live.pla)])]
        .sort((a, b) => Number(a) - Number(b));

      const results = allNos.map(no => {
        const info = cardMap[no] || {};
        return {
          no,
          name: info.name || '',
          barrier: info.barrier || '',
          jockey: info.jockey || '',
          trainer: info.trainer || '',
          win: live.win[no] || 'SCR',
          place: live.pla[no] || '',
          win_investment: live.winInv[no] || 0,
          odds_drop_official: '0',
          hot_favourite: false,
        };
      });

      return res.json({
        ok: true,
        results,
        win_pool: String(live.pool || ''),
        updAt: live.updAt || '',
        race_time: raceInfo.race_time || '',
        distance: raceInfo.distance || '',
        track: raceInfo.track || '',
        course: raceInfo.course || '',
        race_class: raceInfo.race_class || '',
        going: raceInfo.going || '',
        cla_code: raceInfo.cla_code || '',
        race_name: raceInfo.race_name || '',
        field_size: raceInfo.field_size || '',
        source: 'mqtt',
      });
    }

    return res.json({ ok: false, error: `等待 MQTT 數據中 (${venueStr} R${raceNo})` });
  } catch (e) {
    console.error('[ERROR]', e.message.substring(0, 300));
    return res.status(500).json({
      ok: false,
      error: e.message,
      stack: String(e.stack || '').split('\n').slice(0, 5),
    });
  }
});

// ── /qin-qpl ──────────────────────────────────────────────────────────────────
app.get('/qin-qpl', async (req, res) => {
  try {
    const { venue, raceno } = req.query;
    const venueStr = String(venue || '').toUpperCase();
    const raceNoStr = String(parseInt(raceno, 10) || 1);
    const live = mqttLive[venueStr]?.[raceNoStr];

    if (!live || (Object.keys(live.qin || {}).length === 0 && Object.keys(live.qpl || {}).length === 0)) {
      return res.json({ ok: false, error: 'No QIN/QPL MQTT data yet' });
    }

    const toArr = (odsMap, invMap) =>
      Object.entries(odsMap || {}).map(([combo, ods]) => ({
        combo,
        odds: ods,
        investment: invMap[combo] || 0,
      }));

    res.json({
      ok: true,
      qin: {
        odds: toArr(live.qin, live.qinInv),
        pool: String(live.qinPool || ''),
        count: Object.keys(live.qin || {}).length,
      },
      qpl: {
        odds: toArr(live.qpl, live.qplInv),
        pool: String(live.qplPool || ''),
        count: Object.keys(live.qpl || {}).length,
      },
    });
  } catch (e) {
    res.json({ ok: false, error: e.message.substring(0, 300) });
  }
});

// ── /mqtt-status ──────────────────────────────────────────────────────────────
app.get('/mqtt-status', (req, res) => {
  const summary = {};
  for (const [v, races] of Object.entries(mqttLive)) {
    summary[v] = {};
    for (const [rn, slot] of Object.entries(races)) {
      summary[v][rn] = {
        win: Object.keys(slot.win).length,
        qin: Object.keys(slot.qin).length,
        qpl: Object.keys(slot.qpl).length,
        pool: slot.pool,
        updAt: slot.updAt,
      };
    }
  }
  res.json({ ok: true, summary });
});

app.get('/', (req, res) => {
  res.send('HKJC bridge is running');
});

app.listen(PORT, HOST, () => {
  console.log(`✅ HKJC bridge running on ${HOST}:${PORT}`);
  console.log('   /odds        → WIN+PLA (MQTT only)');
  console.log('   /qin-qpl     → QIN+QPL (MQTT only)');
  console.log('   /stream      → SSE 推送');
  console.log('   /push        → odd.py 推送入口');
  console.log('   /mqtt-status → 緩存狀態');
});
