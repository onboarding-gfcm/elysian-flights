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

      // Each trip is a separate bookable flight option — trip data is FLAT (not nested segments)
      // Trip keys: ID, TotalDuration, Stops, Carriers, FlightNumbers, DepartsAt, ArrivesAt,
      //            OriginAirport, DestinationAirport, Connections, Cabin, RemainingSeats, MileageCost
      for (const trip of trips) {
        const depTime = formatDateTime(trip.DepartsAt);
        const arrTime = formatDateTime(trip.ArrivesAt);
        const duration = trip.TotalDuration || computeDuration(trip.DepartsAt, trip.ArrivesAt);
        const flightNo = trip.FlightNumbers || 'EK---';
        const stops = trip.Stops || 0;
        const isDirect = stops === 0;
        const carriers = trip.Carriers || 'EK';
        const airlineCode = carriers.split(',')[0].trim() || 'EK';

        // Build connection segments for display
        const connections = trip.Connections ? trip.Connections.split(',').map(c => c.trim()) : [];
        const segmentDetails = [];

        if (connections.length > 0 && !isDirect) {
          // Multi-segment: origin -> connection1 -> connection2 -> destination
          const allPoints = [trip.OriginAirport, ...connections, trip.DestinationAirport];
          const flightNos = flightNo.split(',').map(f => f.trim());
          for (let i = 0; i < allPoints.length - 1; i++) {
            segmentDetails.push({
              flightNo: flightNos[i] || flightNo,
              origin: allPoints[i] || '',
              destination: allPoints[i + 1] || '',
              depTime: i === 0 ? depTime : '',
              arrTime: i === allPoints.length - 2 ? arrTime : '',
              duration: '',
              aircraft: '',
              fareClass: trip.Cabin || ''
            });
          }
        } else {
          // Direct flight — single segment
          segmentDetails.push({
            flightNo: flightNo,
            origin: trip.OriginAirport || origin,
            destination: trip.DestinationAirport || destination,
            depTime: depTime,
            arrTime: arrTime,
            duration: duration,
            aircraft: '',
            fareClass: trip.Cabin || ''
          });
        }

        flights.push({
          id: trip.ID || avail.ID + '-' + (trip.Order || 0),
          date: avail.Date || date,
          origin: trip.OriginAirport || origin,
          destination: trip.DestinationAirport || destination,
          depTime: depTime,
          arrTime: arrTime,
          duration: duration,
          flightNo: flightNo,
          airline: airlineCode || 'EK',
          source: avail.Source || 'qantas',
          segments: segmentDetails,
          stops: stops,
          availability: { business: hasJ, first: hasF, premiumEconomy: hasW },
          prices: {
            business: hasJ ? (flightPrice.business || (routePrice ? routePrice.business : null)) : null,
            first: hasF ? (flightPrice.first || (routePrice ? routePrice.first : null)) : null,
            premiumEconomy: hasW ? (flightPrice.premiumEconomy || (routePrice ? routePrice.premiumEconomy : null)) : null
          },
          direct: isDirect,
          remainingSeats: trip.RemainingSeats || Math.max(avail.JRemainingSeats || 0, avail.FRemainingSeats || 0, avail.WRemainingSeats || 0) || 1,
          _mileage: { business: trip.MileageCost || avail.JMileageCost || null, first: avail.FMileageCost || null, premiumEconomy: avail.WMileageCost || null }
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
      displayedResults: flights.length
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
