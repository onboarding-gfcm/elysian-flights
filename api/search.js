const fs = require('fs');
const path = require('path');

const PRICES_PATH = path.join(process.cwd(), 'prices.json');

function loadPrices() {
  try { return JSON.parse(fs.readFileSync(PRICES_PATH, 'utf8')); }
  catch { return { routePrices: {}, flightPrices: {} }; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const { origin, destination, date } = req.query;
  if (!origin || !destination) {
    return res.status(400).json({ error: 'origin and destination required' });
  }

  const API_KEY = process.env.SEATS_AERO_API_KEY || '';
  let rawData = null;

  // Try seats.aero API
  if (API_KEY && API_KEY !== 'YOUR_API_KEY_HERE') {
    try {
      const params = new URLSearchParams({
        origin_airport: origin,
        destination_airport: destination,
        cabin: 'business,first',
        take: '50',
        include_trips: 'true',
      });
      if (date) params.set('start_date', date);

      const apiRes = await fetch(`https://seats.aero/partnerapi/search?${params}`, {
        headers: { 'accept': 'application/json', 'Partner-Authorization': API_KEY }
      });
      if (apiRes.ok) rawData = await apiRes.json();
      else console.warn('seats.aero returned', apiRes.status);
    } catch (err) {
      console.warn('seats.aero unreachable:', err.message);
    }
  }

  // Demo fallback
  if (!rawData) {
    const airlines = {
      'DXB': ['EK','QR','TK'], 'SIN': ['SQ','TG','CX'], 'BKK': ['TG','EK','SQ'],
      'JFK': ['BA','VS','DL'], 'NRT': ['NH','JL','KL'], 'LHR': ['BA','KL','VS'],
      'CDG': ['AF','KL'], 'IST': ['TK'], 'DOH': ['QR','EK'], 'HND': ['NH','JL'],
      'MLE': ['EK','SQ','WB'], 'CPT': ['KL','EK'], 'SYD': ['SQ','QF','EK'],
    };
    const times = ['01:15','07:30','09:45','10:20','13:55','14:40','16:10','19:25','21:50','23:30'];
    const durs = ['6h 45m','7h 10m','7h 30m','8h 15m','10h 30m','12h 45m','13h 20m'];
    const base = date ? new Date(date) : new Date(Date.now() + 7*864e5);
    const pool = airlines[destination] || airlines[origin] || ['EK','QR'];
    rawData = { data: [] };

    for (let i = 0; i < 8; i++) {
      const d = new Date(base); d.setDate(d.getDate() + Math.floor(i / 2));
      const al = pool[i % pool.length];
      const depTime = times[(i * 3) % times.length];
      const dur = durs[i % durs.length];
      const depH = parseInt(depTime); const durH = parseInt(dur);
      const arrH = (depH + durH + Math.floor(Math.random()*3)) % 24;
      const arrTime = `${String(arrH).padStart(2,'0')}:${String(Math.floor(Math.random()*60)).padStart(2,'0')}`;

      rawData.data.push({
        ID: `demo-${i}-${origin}-${destination}`,
        Date: d.toISOString().split('T')[0],
        Route: { OriginAirport: origin, DestinationAirport: destination, Distance: 5000 },
        JAvailable: true, FAvailable: i % 3 === 0, WAvailable: true,
        JAirlines: al, FAirlines: al, WAirlines: al,
        JDirect: i % 4 !== 3, FDirect: i % 3 === 0, WDirect: i % 2 === 0,
        JRemainingSeats: 2 + (i % 5), FRemainingSeats: 1 + (i % 3), WRemainingSeats: 3 + (i % 4),
        Source: 'demo',
        _depTime: depTime, _arrTime: arrTime, _duration: dur, _flightNo: `${al}${100 + i * 7}`
      });
    }
  }

  const prices = loadPrices();
  const flights = (rawData.data || []).map(a => {
    const rk = `${a.Route?.OriginAirport}-${a.Route?.DestinationAirport}`;
    const rp = prices.routePrices[rk] || {};
    const fp = prices.flightPrices[a.ID] || {};
    return {
      id: a.ID, date: a.Date,
      origin: a.Route?.OriginAirport || '', destination: a.Route?.DestinationAirport || '',
      depTime: a._depTime || null, arrTime: a._arrTime || null,
      duration: a._duration || null, flightNo: a._flightNo || null,
      business: a.JAvailable || false, first: a.FAvailable || false, premEco: a.WAvailable || false,
      airline: a.JAirlines || a.FAirlines || '',
      directBiz: a.JDirect || false, directFirst: a.FDirect || false, directPremEco: a.WDirect || false,
      seatsBiz: a.JRemainingSeats || 0, seatsFirst: a.FRemainingSeats || 0, seatsPremEco: a.WRemainingSeats || 0,
      priceBiz: fp.business || rp.business || null,
      priceFirst: fp.first || rp.first || null,
      pricePremEco: fp.premiumEconomy || rp.premiumEconomy || null,
      source: a.Source,
    };
  });

  res.json({ flights, count: flights.length });
};
