const express = require('express');
const { GraphQLClient } = require('graphql-request');
const { HorseRacingAPI } = require('hkjc-api');

const app = express();
const PORT = process.env.PORT || 3000;

const gql = new GraphQLClient('https://info.cld.hkjc.com/graphql/base/', {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    'Referer': 'https://bet.hkjc.com/',
    'Origin': 'https://bet.hkjc.com',
    'Accept': 'application/json',
    'Content-Type': 'application/json'
  }
});

const api = new HorseRacingAPI();

const horseOddsQuery = `
query racing($date: String, $venueCode: String, $oddsTypes: [OddsType], $raceNo: Int) {
  raceMeetings(date: $date, venueCode: $venueCode) {
    pmPools(oddsTypes: $oddsTypes, raceNo: $raceNo) {
      oddsType
      oddsNodes {
        combString
        oddsValue
      }
    }
  }
}
`;

const horsePoolQuery = `
query racing($date: String, $venueCode: String, $oddsTypes: [OddsType], $raceNo: Int) {
  raceMeetings(date: $date, venueCode: $venueCode) {
    pmPools(oddsTypes: $oddsTypes, raceNo: $raceNo) {
      oddsType
      investment
    }
  }
}
`;

const cardCache = {};

async function getCardMap(venue, raceNo) {
  const key = `${venue}_${raceNo}`;
  if (cardCache[key]) return cardCache[key];

  try {
    const { raceMeetings } = await api.getRaceMeetings();
    const meeting = raceMeetings.find(m => m.venueCode === venue);
    if (!meeting) return {};

    const race = meeting.races.find(r => Number(r.no) === Number(raceNo));
    if (!race) return {};

    const map = {};
    for (const r of (race.runners || [])) {
      const no = String(r.no);
      map[no] = {
        name: r.name_ch || r.name_en || '',
        draw: String(r.barrierDrawNumber || ''),
        jockey: r.jockey?.name_ch || r.jockey?.name_en || '',
        trainer: r.trainer?.name_ch || r.trainer?.name_en || '',
      };
    }

    cardCache[key] = map;
    return map;
  } catch (e) {
    console.log('[WARN] getCardMap:', e.message.substring(0, 200));
    return {};
  }
}

app.get('/', (req, res) => {
  res.send('HKJC bridge is running');
});

app.get('/odds', async (req, res) => {
  try {
    const { date, venue, raceno } = req.query;
    const raceNo = parseInt(raceno, 10) || 1;

    const [oddsData, poolData, cardMap] = await Promise.all([
      gql.request(horseOddsQuery, {
        date,
        venueCode: venue,
        raceNo,
        oddsTypes: ['WIN', 'PLA']
      }),
      gql.request(horsePoolQuery, {
        date,
        venueCode: venue,
        raceNo,
        oddsTypes: ['WIN']
      }),
      getCardMap(venue, raceNo),
    ]);

    let winPool = '';
    try {
      const wp = (poolData.raceMeetings?.[0]?.pmPools || [])
        .find(p => p.oddsType === 'WIN');
      winPool = wp ? String(wp.investment || '') : '';
    } catch (e) {}

    const winOddsMap = {};
    const plaOddsMap = {};

    for (const pool of (oddsData.raceMeetings?.[0]?.pmPools || [])) {
      for (const node of (pool.oddsNodes || [])) {
        const no = String(node.combString || '').replace(/^0+/, '');
        if (!no) continue;
        if (pool.oddsType === 'WIN') winOddsMap[no] = node.oddsValue;
        if (pool.oddsType === 'PLA') plaOddsMap[no] = node.oddsValue;
      }
    }

    if (Object.keys(winOddsMap).length === 0) {
      return res.json({ ok: false, error: `無賠率數據 ${venue} R${raceNo}` });
    }

    const allNos = [...new Set([
      ...Object.keys(winOddsMap),
      ...Object.keys(plaOddsMap),
    ])].sort((a, b) => Number(a) - Number(b));

    const results = allNos.map(no => {
      const info = cardMap[no] || {};
      return {
        no,
        name: info.name || '',
        draw: info.draw || '',
        jockey: info.jockey || '',
        trainer: info.trainer || '',
        win: winOddsMap[no] || 'SCR',
        place: plaOddsMap[no] || '',
        win_investment: 0,
      };
    });

    return res.json({ ok: true, results, win_pool: winPool });
  } catch (e) {
    console.error('[ERROR]', e.message.substring(0, 300));
    return res.status(500).json({
      ok: false,
      error: e.message,
      stack: String(e.stack || '').split('\n').slice(0, 5)
    });
  }
});

app.get('/meetings', async (req, res) => {
  try {
    const meetings = await api.getActiveMeetings();
    return res.json({ ok: true, meetings });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ HKJC bridge running on port ${PORT}`);
});
