const fs = require('fs');
const path = require('path');

const PRICES_PATH = path.join(process.cwd(), 'prices.json');

function loadPrices() {
  try { return JSON.parse(fs.readFileSync(PRICES_PATH, 'utf8')); }
  catch { return { routePrices: {}, flightPrices: {} }; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const { origin, destination, date } = req.query;
  if (!origin || !destination) {
    return res.status(400).json({ error: 'origin and destination required' });
  }

  const API_KEY = process.env.SEATS_AERO_API_KEY || '';
  let rawData = null;

  // Try seats.aero API
  if (API_KEY) {
    try {
      const apiUrl = `https://seats.aero/partnerapi/search?origin=${origin}&destination=${destination}&date=${date || ''}&cabin=business,first,premium`;
      const resp = await fetch(apiUrl, {
        headers: { 'Partner-Authorization': API_KEY, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(8000)
      });
      if (resp.ok) {
        rawData = await resp.json();
      }
    } catch (e) {
      console.log('seats.aero error, using demo data:', e.message);
    }
  }

  const prices = loadPrices();
  const routeKey = `${origin}-${destination}`;
  const routePrice = prices.routePrices[routeKey] || null;

  // If API returned data, map it
  if (rawData && rawData.data && rawData.data.length > 0) {
    const flights = rawData.data.slice(0, 12).map((f, i) => {
      const flightPrice = prices.flightPrices[f.id] || {};
      return {
        id: f.id || `${routeKey}-${i}`,
        date: f.Date || date,
        origin: f.Route?.OriginAirport || origin,
        destination: f.Route?.DestinationAirport || destination,
        depTime: f.DepartureTime || randomTime(),
        arrTime: f.ArrivalTime || randomTime(),
        duration: f.Duration || randomDuration(),
        flightNo: f.FlightNumber || `${randomAirline(destination)}${100 + Math.floor(Math.random() * 900)}`,
        airline: f.Airline || f.Source || randomAirline(destination),
        availability: {
          business: f.BusinessAvailable !== false,
          first: f.FirstAvailable !== false,
          premiumEconomy: f.PremiumEconomyAvailable !== false
        },
        prices: {
          business: flightPrice.business || (routePrice ? routePrice.business : null),
          first: flightPrice.first || (routePrice ? routePrice.first : null),
          premiumEconomy: flightPrice.premiumEconomy || (routePrice ? routePrice.premiumEconomy : null)
        },
        direct: f.Stops === 0 || Math.random() > 0.3,
        remainingSeats: f.RemainingSeats || Math.floor(Math.random() * 6) + 1
      };
    });
    return res.json({ flights, source: 'api' });
  }

  // Demo fallback
  const demoFlights = generateDemoFlights(origin, destination, date, routePrice);
  return res.json({ flights: demoFlights, source: 'demo' });
};

function randomAirline(dest) {
  const map = {
    DXB: ['EK','QR','TK','LH'], BKK: ['TG','SQ','CX','EK'], SIN: ['SQ','TG','CX','EK'],
    JFK: ['KL','DL','UA','BA'], NRT: ['NH','JL','KL','SQ'], DOH: ['QR','EK','TK','LH'],
    LHR: ['BA','KL','VS','LH'], CDG: ['AF','KL','LH'], IST: ['TK','PC'],
    HND: ['NH','JL'], MLE: ['EK','SQ','UL'], CPT: ['KL','SA','EK'],
    SYD: ['QF','SQ','EK','CX'], MIA: ['KL','AA','DL'], LAX: ['KL','DL','UA','SQ'],
    HKG: ['CX','SQ','EK','KL'], FCO: ['AZ','KL','LH'], BCN: ['VY','KL','LH']
  };
  const airlines = map[dest] || ['KL','LH','EK','QR'];
  return airlines[Math.floor(Math.random() * airlines.length)];
}

function randomTime() {
  const h = Math.floor(Math.random() * 24);
  const m = Math.floor(Math.random() * 4) * 15;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`;
}

function randomDuration() {
  const h = 5 + Math.floor(Math.random() * 10);
  const m = Math.floor(Math.random() * 4) * 15;
  return `${h}u ${m > 0 ? m + 'm' : ''}`.trim();
}

function generateDemoFlights(origin, destination, date, routePrice) {
  const flights = [];
  const usedAirlines = new Set();
  for (let i = 0; i < 8; i++) {
    let al;
    do { al = randomAirline(destination); } while (usedAirlines.has(al) && usedAirlines.size < 4);
    usedAirlines.add(al);

    const depH = 6 + Math.floor(Math.random() * 16);
    const depM = Math.floor(Math.random() * 4) * 15;
    const durH = 5 + Math.floor(Math.random() * 10);
    const durM = Math.floor(Math.random() * 4) * 15;
    const arrH = (depH + durH + (depM + durM >= 60 ? 1 : 0)) % 24;
    const arrM = (depM + durM) % 60;

    const direct = Math.random() > 0.35;
    flights.push({
      id: `${origin}-${destination}-${i}`,
      date: date || '2026-04-15',
      origin, destination,
      depTime: `${String(depH).padStart(2,'0')}:${String(depM).padStart(2,'0')}`,
      arrTime: `${String(arrH).padStart(2,'0')}:${String(arrM).padStart(2,'0')}`,
      duration: `${durH}u${durM > 0 ? ' ' + durM + 'm' : ''}`,
      flightNo: `${al}${100 + Math.floor(Math.random() * 900)}`,
      airline: al,
      availability: {
        business: Math.random() > 0.15,
        first: Math.random() > 0.35,
        premiumEconomy: Math.random() > 0.1
      },
      prices: {
        business: routePrice ? routePrice.business : (1500 + Math.floor(Math.random() * 1500)),
        first: routePrice ? routePrice.first : (3000 + Math.floor(Math.random() * 3000)),
        premiumEconomy: routePrice ? routePrice.premiumEconomy : (800 + Math.floor(Math.random() * 600))
      },
      direct,
      remainingSeats: Math.floor(Math.random() * 6) + 1
    });
  }
  // Sort by departure time
  flights.sort((a, b) => a.depTime.localeCompare(b.depTime));
  return flights;
}
