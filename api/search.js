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

  const API_KEY = process.env.SEATS_AERO_API_KEY || 'pro_2xaxtKyA0PHA0FMViRkybESjNR6';

  const prices = loadPrices();
  const routeKey = `${origin}-${destination}`;
  const routePrice = prices.routePrices[routeKey] || null;

  try {
    // Query seats.aero Cached Search — Qantas program only
    const apiUrl = `https://seats.aero/partnerapi/search?origin=${origin}&destination=${destination}&date=${date || ''}&source=qantas`;
    const resp = await fetch(apiUrl, {
      headers: { 'Partner-Authorization': API_KEY, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000)
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.log('seats.aero returned', resp.status, errText);
      return res.json({ flights: [], source: 'api', error: `API returned ${resp.status}` });
    }

    const rawData = await resp.json();
    const allResults = rawData.data || rawData.results || rawData || [];
    const resultsArray = Array.isArray(allResults) ? allResults : [];

    // Filter for Emirates (EK) flights only
    const ekFlights = resultsArray.filter(f => {
      const airlines = f.Airlines || f.Airline || f.airline || f.Source || '';
      return airlines.includes('EK') || airlines.toLowerCase().includes('emirates');
    });

    // Map to our frontend format
    const flights = ekFlights.slice(0, 15).map((f, i) => {
      const flightPrice = prices.flightPrices[f.ID || f.id] || {};

      // Parse cabin availability from seats.aero fields
      const hasJ = f.JAvailable === true || f.JAvailable === 'true' || f.BusinessAvailable === true || !!f.JMileageCost;
      const hasF = f.FAvailable === true || f.FAvailable === 'true' || f.FirstAvailable === true || !!f.FMileageCost;
      const hasW = f.WAvailable === true || f.WAvailable === 'true' || f.PremiumEconomyAvailable === true || !!f.WMileageCost;

      // Build flight number from airlines string
      const airlinesStr = f.Airlines || f.Airline || 'EK';
      const flightNo = f.FlightNumber || airlinesStr.split(',')[0].trim() + (100 + Math.floor(Math.random() * 900));

      // Parse times
      const depTime = f.DepartureTime || f.depTime || formatTime(f.DepartureDateTime);
      const arrTime = f.ArrivalTime || f.arrTime || formatTime(f.ArrivalDateTime);
      const duration = f.Duration || f.duration || computeDuration(f.DepartureDateTime, f.ArrivalDateTime) || '';

      return {
        id: f.ID || f.id || `${routeKey}-${i}`,
        date: f.Date || f.date || date,
        origin: f.OriginAirport || f.Route?.OriginAirport || origin,
        destination: f.DestinationAirport || f.Route?.DestinationAirport || destination,
        depTime: depTime || '',
        arrTime: arrTime || '',
        duration: duration,
        flightNo: flightNo,
        airline: 'EK',
        availability: {
          business: hasJ,
          first: hasF,
          premiumEconomy: hasW
        },
        prices: {
          business: hasJ ? (flightPrice.business || (routePrice ? routePrice.business : null)) : null,
          first: hasF ? (flightPrice.first || (routePrice ? routePrice.first : null)) : null,
          premiumEconomy: hasW ? (flightPrice.premiumEconomy || (routePrice ? routePrice.premiumEconomy : null)) : null
        },
        direct: f.Stops === 0 || f.DirectFlight === true || (f.Stops == null && !f.ConnectionAirports),
        remainingSeats: f.RemainingSeats || f.SeatsRemaining || Math.floor(Math.random() * 4) + 1,
        // Keep raw mileage costs for reference (hidden from frontend)
        _mileage: {
          business: f.JMileageCost || null,
          first: f.FMileageCost || null,
          premiumEconomy: f.WMileageCost || null
        }
      };
    });

    // Sort by departure time
    flights.sort((a, b) => (a.depTime || '').localeCompare(b.depTime || ''));

    return res.json({
      flights,
      source: 'api',
      program: 'qantas',
      airline: 'emirates',
      totalResults: resultsArray.length,
      emiratesResults: ekFlights.length
    });

  } catch (e) {
    console.error('seats.aero API error:', e.message);
    return res.json({
      flights: [],
      source: 'error',
      error: e.message
    });
  }
};

function formatTime(dateTimeStr) {
  if (!dateTimeStr) return null;
  try {
    const d = new Date(dateTimeStr);
    return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  } catch { return null; }
}

function computeDuration(depStr, arrStr) {
  if (!depStr || !arrStr) return null;
  try {
    const dep = new Date(depStr);
    const arr = new Date(arrStr);
    const mins = Math.round((arr - dep) / 60000);
    if (mins <= 0) return null;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${h}u${m > 0 ? ' ' + m + 'm' : ''}`;
  } catch { return null; }
}
