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
    // seats.aero Cached Search — Qantas program, Emirates only, with trip details
    const params = new URLSearchParams({
      origin_airport: origin,
      destination_airport: destination,
      sources: 'qantas',
      carriers: 'EK',
      include_trips: 'true',
      take: '50'
    });
    if (date) {
      params.set('start_date', date);
      params.set('end_date', date);
    }

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

    // Build individual flights from trip segments
    const flights = [];

    for (const avail of resultsArray) {
      const flightPrice = prices.flightPrices[avail.ID] || {};
      const hasJ = avail.JAvailable === true;
      const hasF = avail.FAvailable === true;
      const hasW = avail.WAvailable === true;

      // Skip if no premium cabin available
      if (!hasJ && !hasF && !hasW) continue;

      // Get trips (individual flight options) from AvailabilityTrips
      const trips = avail.AvailabilityTrips || [];

      if (trips.length === 0) {
        // No trip details — show as single entry without times
        const jAirlines = avail.JAirlines || '';
        const fAirlines = avail.FAirlines || '';
        const primaryAirline = (jAirlines || fAirlines || avail.WAirlines || '').split(',')[0].trim() || 'EK';

        flights.push({
          id: avail.ID,
          date: avail.Date || date,
          origin: avail.Route?.OriginAirport || origin,
          destination: avail.Route?.DestinationAirport || destination,
          depTime: '',
          arrTime: '',
          duration: '',
          flightNo: primaryAirline + '---',
          airline: 'EK',
          source: avail.Source || 'qantas',
          segments: [],
          availability: { business: hasJ, first: hasF, premiumEconomy: hasW },
          prices: {
            business: hasJ ? (flightPrice.business || (routePrice ? routePrice.business : null)) : null,
            first: hasF ? (flightPrice.first || (routePrice ? routePrice.first : null)) : null,
            premiumEconomy: hasW ? (flightPrice.premiumEconomy || (routePrice ? routePrice.premiumEconomy : null)) : null
          },
          direct: (hasJ && avail.JDirect === true) || (hasF && avail.FDirect === true) || (hasW && avail.WDirect === true),
          remainingSeats: Math.max(avail.JRemainingSeats || 0, avail.FRemainingSeats || 0, avail.WRemainingSeats || 0) || 1,
          _mileage: { business: avail.JMileageCost || null, first: avail.FMileageCost || null, premiumEconomy: avail.WMileageCost || null }
        });
        continue;
      }

      // Each trip is a separate bookable flight option (different routing/times)
      for (const trip of trips) {
        const segments = trip.AvailabilitySegments || [];
        if (segments.length === 0) continue;

        // Sort segments by order
        segments.sort((a, b) => (a.Order || 0) - (b.Order || 0));

        const firstSeg = segments[0];
        const lastSeg = segments[segments.length - 1];

        // Parse departure and arrival times
        const depTime = formatDateTime(firstSeg.DepartsAt);
        const arrTime = formatDateTime(lastSeg.ArrivesAt);
        const duration = computeDuration(firstSeg.DepartsAt, lastSeg.ArrivesAt);

        // Build flight number from segments
        const flightNumbers = segments.map(s => s.FlightNumber).filter(Boolean);
        const flightNo = flightNumbers.join(' / ') || 'EK---';

        // Direct = only 1 segment
        const isDirect = segments.length === 1;

        // Get the airline from the first segment's flight number
        const airlineCode = firstSeg.FlightNumber ? firstSeg.FlightNumber.replace(/[0-9]/g, '') : 'EK';

        // Build segment details for frontend
        const segmentDetails = segments.map(s => ({
          flightNo: s.FlightNumber || '',
          origin: s.OriginAirport || '',
          destination: s.DestinationAirport || '',
          depTime: formatDateTime(s.DepartsAt),
          arrTime: formatDateTime(s.ArrivesAt),
          duration: computeDuration(s.DepartsAt, s.ArrivesAt),
          aircraft: s.AircraftName || s.AircraftCode || '',
          fareClass: s.FareClass || ''
        }));

        flights.push({
          id: trip.ID || avail.ID + '-' + (trip.Order || 0),
          date: avail.Date || date,
          origin: firstSeg.OriginAirport || origin,
          destination: lastSeg.DestinationAirport || destination,
          depTime: depTime,
          arrTime: arrTime,
          duration: duration,
          flightNo: flightNo,
          airline: airlineCode || 'EK',
          source: avail.Source || 'qantas',
          segments: segmentDetails,
          stops: segments.length - 1,
          availability: { business: hasJ, first: hasF, premiumEconomy: hasW },
          prices: {
            business: hasJ ? (flightPrice.business || (routePrice ? routePrice.business : null)) : null,
            first: hasF ? (flightPrice.first || (routePrice ? routePrice.first : null)) : null,
            premiumEconomy: hasW ? (flightPrice.premiumEconomy || (routePrice ? routePrice.premiumEconomy : null)) : null
          },
          direct: isDirect,
          remainingSeats: Math.max(avail.JRemainingSeats || 0, avail.FRemainingSeats || 0, avail.WRemainingSeats || 0) || 1,
          _mileage: { business: avail.JMileageCost || null, first: avail.FMileageCost || null, premiumEconomy: avail.WMileageCost || null }
        });
      }
    }

    // Sort by departure time, then by date
    flights.sort((a, b) => {
      if (a.date !== b.date) return (a.date || '').localeCompare(b.date || '');
      return (a.depTime || '').localeCompare(b.depTime || '');
    });

    return res.json({
      flights: flights.slice(0, 30),
      source: 'api',
      program: 'qantas',
      airline: 'emirates',
      totalResults: resultsArray.length,
      displayedResults: flights.length,
      _debug: resultsArray.length > 0 ? { firstResult: { JAvailable: resultsArray[0].JAvailable, FAvailable: resultsArray[0].FAvailable, WAvailable: resultsArray[0].WAvailable, YAvailable: resultsArray[0].YAvailable, JAirlines: resultsArray[0].JAirlines, FAirlines: resultsArray[0].FAirlines, WAirlines: resultsArray[0].WAirlines, Source: resultsArray[0].Source, RawKeys: Object.keys(resultsArray[0]).filter(k => k.includes('vail') || k.includes('irect') || k.includes('irline')).join(',') } } : null
    });

  } catch (e) {
    console.error('seats.aero API error:', e.message);
    return res.json({ flights: [], source: 'error', error: e.message });
  }
};

function formatDateTime(isoStr) {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr);
    return d.toISOString().substring(11, 16); // HH:MM in UTC
  } catch { return ''; }
}

function computeDuration(depStr, arrStr) {
  if (!depStr || !arrStr) return '';
  try {
    const dep = new Date(depStr);
    const arr = new Date(arrStr);
    const diffMs = arr - dep;
    if (diffMs < 0) return '';
    const hours = Math.floor(diffMs / 3600000);
    const mins = Math.floor((diffMs % 3600000) / 60000);
    return `${hours}u ${mins.toString().padStart(2, '0')}m`;
  } catch { return ''; }
}
