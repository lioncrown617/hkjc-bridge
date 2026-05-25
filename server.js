const express = require('express');
const { HorseRacingAPI } = require('hkjc-api');

const app = express();
const api = new HorseRacingAPI();
const PORT = process.env.PORT || 3000;

function normalizeRunner(r) {
  return {
    no: String(r.no ?? ''),
    name: r.name_ch || r.name_en || '',
    draw: String(r.barrierDrawNumber || ''),
    jockey: r.jockey?.name_ch || r.jockey?.name_en || '',
    trainer: r.trainer?.name_ch || r.trainer?.name_en || '',
  };
}

function getMeetingByVenue(meetings, venue) {
  if (!Array.isArray(meetings)) return null;
  return meetings.find(m => String(m.venueCode || '').toUpperCase() === String(venue || '').toUpperCase()) || null;
}

function getRaceByNo(meeting, raceNo) {
  if (!meeting || !Array.isArray(meeting.races)) return null;
  return meeting.races.find(r => Number(r.no) === Number(raceNo)) || null;
}

function buildOddsMap(oddsPayload, oddsType) {
  const map = {};
  const pools = oddsPayload?.raceMeetings?.[0]?.pmPools || oddsPayload?.pmPools || [];

  for (const pool of pools) {
    if (pool.oddsType !== oddsType) continue;
    for (const node of (pool.oddsNodes || [])) {
      const no = String(node.combString || '').replace(/^0+/, '');
      if (!no) continue;
      map[no] = node.oddsValue;
    }
  }
  return map;
}

async function fetchRaceData(date, venue, raceNo) {
  const meetingsResp = await api.getRaceMeetings();
  const meetings = meetingsResp?.raceMeetings || meetingsResp || [];
  const meeting = getMeetingByVenue(meetings, venue);

  if (!meeting) {
    throw new Error(`找不到場地 ${venue}`);
  }

  const race = getRaceByNo(meeting, raceNo);
  if (!race) {
    throw new Error(`找不到場次 R${raceNo}`);
  }

  const runners = (race.runners || []).map(normalizeRunner);

  let winOddsMap = {};
  let plaOddsMap = {};
  let winPool = '';

  try {
    if (typeof api.getOdds === 'function') {
      const winOddsResp = await api.getOdds({
        date,
        venue,
        raceNo: Number(raceNo),
        oddsType: 'WIN',
      });

      const plaOddsResp = await api.getOdds({
        date,
        venue,
        raceNo: Number(raceNo),
        oddsType: 'PLA',
      });

      winOddsMap = buildOddsMap(winOddsResp, 'WIN');
      plaOddsMap = buildOddsMap(plaOddsResp, 'PLA');

      const pools = winOddsResp?.raceMeetings?.[0]?.pmPools || winOddsResp?.pmPools || [];
      const winPoolObj = pools.find(p => p.oddsType === 'WIN');
      winPool = winPoolObj ? String(winPoolObj.investment || '') : '';
    }
  } catch (e) {
    console.log('[WARN] getOdds failed:', e.message.substring(0, 200));
  }

  const results = runners.map(r => ({
    no: r.no,
    name: r.name,
    draw: r.draw,
    jockey: r.jockey,
    trainer: r.trainer,
    win: winOddsMap[r.no] || 'SCR',
    place: plaOddsMap[r.no] || '',
    win_investment: 0,
  }));

  return { results, win_pool: winPool };
}

app.get('/', (req, res) => {
  res.send('HKJC bridge is running');
});

app.get('/meetings', async (req, res) => {
  try {
    const meetings = await api.getActiveMeetings();
    res.json({ ok: true, meetings });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/odds', async (req, res) => {
  try {
    const { date, venue, raceno } = req.query;
    const raceNo = parseInt(raceno, 10) || 1;

    if (!date || !venue) {
      return res.status(400).json({
        ok: false,
        error: '缺少必要參數 date 或 venue'
      });
    }

    const data = await fetchRaceData(date, venue, raceNo);

    if (!data.results || data.results.length === 0) {
      return res.json({ ok: false, error: `無賽馬數據 ${venue} R${raceNo}` });
    }

    const hasAnyOdds = data.results.some(r => r.win && r.win !== 'SCR');
    if (!hasAnyOdds) {
      return res.json({ ok: false, error: `無賠率數據 ${venue} R${raceNo}` });
    }

    return res.json({
      ok: true,
      results: data.results,
      win_pool: data.win_pool || ''
    });
  } catch (e) {
    console.error('[ERROR]', e.message.substring(0, 300));
    return res.status(500).json({
      ok: false,
      error: e.message,
      stack: String(e.stack || '').split('\n').slice(0, 5)
    });
  }
});


app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ HKJC bridge running on port ${PORT}`);
});

