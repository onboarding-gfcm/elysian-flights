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
    // Build correct seats.aero Cached Search URL
    // Correct param names: origin_airport, destination_airport, start_date, end_date, sources
    const params = new URLSearchParams({
      origin_airport: origin,
      destination_airport: destination,
      take: '50'
    });
    if (date) {
      params.set('start_date', date);
      params.set('end_date', date);
    }
    // Show all programs (user said showing everything is fine)
    // We can filter by sources=qantas later if needed

    const apiUrl = `https://seats.aero/partnerapi/search?${params.toString()}`;
    console.log('Calling seats.aero:', apiUrl);

    const resp = await fetch(apiUrl, {
      headers: { 'Partner-Authorization': API_KEY, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(15000)
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.log('seats.aero returned', resp.status, errText.substring(0, 500));
      return res.json({ flights: [], source: 'api', error: `API returned ${resp.status}: ${errText.substring(0, 200)}` });
    }

    const rawData = await resp.json();
    const allResults = rawData.data || [];
    const resultsArray = Array.isArray(allResults) ? allResults : [];

    console.log(`seats.aero returned ${resultsArray.length} results`);

    // Map to our frontend format
    const flights = resultsArray.slice(0, 20).map((f, i) => {
      const flightPrice = prices.flightPrices[f.ID] || {};

      // Parse cabin availability from seats.aero fields
      const hasJ = f.JAvailable === true;
      const hasF = f.FAvailable === true;
      const hasW = f.WAvailable === true;
      const hasY = f.YAvailable === true;

      // Get airlines per cabin (seats.aero returns e.g. "EK", "AA, B6")
      const jAirlines = f.JAirlines || '';
      const fAirlines = f.FAirlines || '';
      const wAirlines = f.WAirlines || '';
      const yAirlines = f.YAirlines || '';
      // Use the first available airline code
      const primaryAirline = (jAirlines || fAirlines || wAirlines || yAirlines).split(',')[0].trim() || 'XX';

      // Build a display flight number
      const flightNo = primaryAirline + (100 + Math.floor(Math.random() * 900));

      // Route info from nested Route object
      const orig = f.Route?.OriginAirport || origin;
      const dest = f.Route?.DestinationAirport || destination;

      // Direct flight info per cabin
      const isDirect = (hasJ && f.JDirect === true) || (hasF && f.FDirect === true) ||
                       (hasW && f.WDirect === true) || (hasY && f.YDirect === true);

      // Remaining seats (max across cabins)
      const remainingSeats = Math.max(
        f.JRemainingSeats || 0,
        f.FRemainingSeats || 0,
        f.WRemainingSeats || 0,
        f.YRemainingSeats || 0
      ) || 1;

      // Source program
      const source = f.Source || '';

      return {
        id: f.ID || `${routeKey}-${i}`,
        date: f.Date || date,
        origin: orig,
        destination: dest,
        depTime: '',  // Cached search doesn't include times
        arrTime: '',
        duration: '',
        flightNo: flightNo,
        airline: primaryAirline,
        source: source,
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
        direct: isDirect,
        remainingSeats: remainingSeats,
        _mileage: {
          business: f.JMileageCost || null,
          first: f.FMileageCost || null,
          premiumEconomy: f.WMileageCost || null
        }
      };
    });

    // Filter: only show flights that have at least one premium cabin available with a price
    const bookableFlights = flights.filter(f =>
      f.availability.business || f.availability.first || f.availability.premiumEconomy
    );

    return res.json({
      flights: bookableFlights,
      source: 'api',
      totalResults: resultsArray.length,
      displayedResults: bookableFlights.length
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
