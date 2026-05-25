const express = require('express');
const { GraphQLClient } = require('graphql-request');
const { HorseRacingAPI } = require('hkjc-api');

const app = express();
const gql = new GraphQLClient('https://info.cld.hkjc.com/graphql/base/');
const api = new HorseRacingAPI();

const horseOddsQuery = `
query racing($date: String, $venueCode: String, $oddsTypes: [OddsType], $raceNo: Int) {
  raceMeetings(date: $date, venueCode: $venueCode) {
    pmPools(oddsTypes: $oddsTypes, raceNo: $raceNo) {
      id
      status
      sellStatus
      oddsType
      lastUpdateTime
      guarantee
      minTicketCost
      name_en
      name_ch
      leg {
        number
        races
      }
      cWinSelections {
        composite
        name_ch
        name_en
        starters
      }
      oddsNodes {
        combString
        oddsValue
        hotFavourite
        oddsDropValue
        bankerOdds {
          combString
          oddsValue
        }
      }
    }
  }
}`;

const horsePoolQuery = `
query racing($date: String, $venueCode: String, $oddsTypes: [OddsType], $raceNo: Int) {
  raceMeetings(date: $date, venueCode: $venueCode) {
    totalInvestment
    poolInvs: pmPools(oddsTypes: $oddsTypes, raceNo: $raceNo) {
      id
      leg {
        number
        races
      }
      status
      sellStatus
      oddsType
      investment
      mergedPoolId
      lastUpdateTime
    }
  }
}`;

const cardCache = {};

async function getCardMap(venue, raceNo) {
    const key = `${venue}_${raceNo}`;
    if (cardCache[key]) return cardCache[key];
    try {
        const { raceMeetings } = await api.getRaceMeetings();
        const meeting = raceMeetings.find(m => m.venueCode === venue);
        if (meeting) {
            const race = meeting.races.find(r => Number(r.no) === raceNo);
            if (race) {
                const map = {};
                for (const r of (race.runners || [])) {
                    const no = String(r.no);
                    map[no] = {
                        name:    r.name_ch    || r.name_en    || "",
                        draw:    String(r.barrierDrawNumber   || ""),
                        jockey:  r.jockey?.name_ch  || r.jockey?.name_en  || "",
                        trainer: r.trainer?.name_ch || r.trainer?.name_en || "",
                    };
                }
                cardCache[key] = map;
                return map;
            }
        }
    } catch(e) {
        console.log('[WARN] getCardMap:', e.message.substring(0,100));
    }
    return {};
}

app.get('/odds', async (req, res) => {
    try {
        const { date, venue, raceno } = req.query;
        const raceNo = parseInt(raceno) || 1;
        console.log(`[INFO] ${venue} R${raceNo} ${date}`);

        const [oddsData, poolData, cardMap] = await Promise.all([
            gql.request(horseOddsQuery, {
                date, venueCode: venue, raceNo,
                oddsTypes: ["WIN", "PLA"]
            }),
            gql.request(horsePoolQuery, {
                date, venueCode: venue, raceNo,
                oddsTypes: ["WIN"]
            }),
            getCardMap(venue, raceNo),
        ]);

        // WIN 彩池
        let winPool = "";
        try {
            const wp = (poolData.raceMeetings?.[0]?.poolInvs || [])
                .find(p => p.oddsType === "WIN");
            winPool = wp ? String(wp.investment || "") : "";
        } catch(e) {}

        // 賠率 map
        const winOddsMap = {};
        const plaOddsMap = {};
        for (const pool of (oddsData.raceMeetings?.[0]?.pmPools || [])) {
            for (const node of (pool.oddsNodes || [])) {
                const no = node.combString.replace(/^0+/, '');
                if (pool.oddsType === "WIN") winOddsMap[no] = node.oddsValue;
                if (pool.oddsType === "PLA") plaOddsMap[no] = node.oddsValue;
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
                name:           info.name    || "",
                draw:           info.draw    || "",
                jockey:         info.jockey  || "",
                trainer:        info.trainer || "",
                win:            winOddsMap[no] || "SCR",
                place:          plaOddsMap[no] || "",
                win_investment: 0,
            };
        });

        res.json({ ok: true, results, win_pool: winPool });

    } catch(e) {
        console.error('[ERROR]', e.message.substring(0,300));
        res.json({ ok: false, error: e.message.substring(0,300) });
    }
});

app.get('/meetings', async (req, res) => {
    try {
        const meetings = await api.getActiveMeetings();
        res.json({ ok: true, meetings });
    } catch(e) {
        res.json({ ok: false, error: e.message });
    }
});

app.listen(3000, () => {
    console.log('✅ HKJC bridge running on http://localhost:3000');
});
