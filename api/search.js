const fs = require('fs');
const path = require('path');

const PRICES_PATH = path.join(process.cwd(), 'prices.json');

function loadPrices() {
  try { return JSON.parse(fs.readFileSync(PRICES_PATH, 'utf8')); }
  catch { return { routePrices: {}, flightPrices: {} }; }
}

// Program configurations with specific filters
const PROGRAMS = {
  qantas: {
    source: 'qantas',
    carriers: 'EK',
    label: 'Qantas',
    maxStops: 0,        // direct only
    maxPoints: null      // no points limit
  },
  flying_blue: {
    source: 'flying_blue',
    carriers: 'EY,KL,AF',
    label: 'Flying Blue',
    maxStops: 1,
    maxPoints: 85000
  },
  virginatlantic: {
    source: 'virginatlantic',
    carriers: 'KL,AF',
    label: 'Virgin Atlantic',
    maxStops: 1,
    maxPoints: 100000
  },
  american: {
    source: 'american',
    carriers: 'EY',
    label: 'American Airlines',
    maxStops: null,      // no stops limit
    maxPoints: 60000
  }
};

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
    // Search all programs in parallel
    const programKeys = Object.keys(PROGRAMS);
    const apiCalls = programKeys.map(key => {
      const cfg = PROGRAMS[key];
      const params = new URLSearchParams({
        origin_airport: origin,
        destination_airport: destination,
        sources: cfg.source,
        carriers: cfg.carriers,
        include_trips: 'true',
        take: '50'
      });
      if (date) {
        params.set('start_date', date);
        params.set('end_date', date);
      }

      const apiUrl = `https://seats.aero/partnerapi/search?${params.toString()}`;
      console.log(`[${cfg.label}] Calling: ${apiUrl}`);

      return fetch(apiUrl, {
        headers: { 'Partner-Authorization': API_KEY, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(15000)
      })
      .then(async resp => {
        if (!resp.ok) {
          const errText = await resp.text().catch(() => '');
          console.log(`[${cfg.label}] API returned ${resp.status}: ${errText.substring(0, 200)}`);
          return { key, cfg, data: [], error: `${resp.status}` };
        }
        const raw = await resp.json();
        const data = raw.data || [];
        console.log(`[${cfg.label}] returned ${Array.isArray(data) ? data.length : 0} results`);
        return { key, cfg, data: Array.isArray(data) ? data : [] };
      })
      .catch(err => {
        console.log(`[${cfg.label}] error: ${err.message}`);
        return { key, cfg, data: [], error: err.message };
      });
    });

    const results = await Promise.all(apiCalls);

    // Build flights from all programs
    const allFlights = [];

    for (const { key, cfg, data } of results) {
      for (const avail of data) {
        const flightPrice = prices.flightPrices[avail.ID] || {};
        const hasJ = avail.JAvailable === true;
        const hasF = avail.FAvailable === true;

        // Skip if no Business or First available
        if (!hasJ && !hasF) continue;

        const trips = avail.AvailabilityTrips || [];

        if (trips.length === 0) {
          // No trip details — check if direct-only filter applies
          const isDirect = (hasJ && avail.JDirect === true) || (hasF && avail.FDirect === true);
          if (cfg.maxStops === 0 && !isDirect) continue;

          // Check max points
          const mileageCost = avail.JMileageCost || avail.FMileageCost || 0;
          if (cfg.maxPoints && mileageCost > cfg.maxPoints) continue;

          const jAirlines = avail.JAirlines || '';
          const fAirlines = avail.FAirlines || '';
          const primaryAirline = (jAirlines || fAirlines || '').split(',')[0].trim() || '';

          allFlights.push({
            id: avail.ID,
            date: avail.Date || date,
            origin: avail.Route?.OriginAirport || origin,
            destination: avail.Route?.DestinationAirport || destination,
            depTime: '',
            arrTime: '',
            duration: '',
            flightNo: primaryAirline + '---',
            airline: primaryAirline,
            program: cfg.label,
            programKey: key,
            source: avail.Source || cfg.source,
            segments: [],
            stops: isDirect ? 0 : null,
            availability: { business: hasJ, first: hasF },
            prices: {
              business: hasJ ? (flightPrice.business || (routePrice ? routePrice.business : null)) : null,
              first: hasF ? (flightPrice.first || (routePrice ? routePrice.first : null)) : null
            },
            direct: isDirect,
            remainingSeats: Math.max(avail.JRemainingSeats || 0, avail.FRemainingSeats || 0) || 1,
            _mileage: { business: avail.JMileageCost || null, first: avail.FMileageCost || null }
          });
          continue;
        }

        // Process individual trips
        for (const trip of trips) {
          const cabin = (trip.Cabin || '').toLowerCase();
          if (cabin === 'economy' || cabin === 'y' || cabin === 'premium_economy' || cabin === 'w') continue;

          const stops = trip.Stops || 0;
          const isDirect = stops === 0;

          // Apply maxStops filter
          if (cfg.maxStops !== null && cfg.maxStops !== undefined && stops > cfg.maxStops) continue;

          // Apply maxPoints filter
          const mileageCost = trip.MileageCost || avail.JMileageCost || avail.FMileageCost || 0;
          if (cfg.maxPoints && mileageCost > cfg.maxPoints) continue;

          const depTime = formatDateTime(trip.DepartsAt);
          const arrTime = formatDateTime(trip.ArrivesAt);
          const duration = trip.TotalDuration || computeDuration(trip.DepartsAt, trip.ArrivesAt);
          const flightNo = trip.FlightNumbers || '---';
          const carriers = trip.Carriers || '';
          const airlineCode = carriers.split(',')[0].trim() || '';

          // Build connection segments for display
          const connRaw = trip.Connections || '';
          const connections = (typeof connRaw === 'string' && connRaw) ? connRaw.split(',').map(c => c.trim()) : [];
          const segmentDetails = [];

          if (connections.length > 0 && !isDirect) {
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

          allFlights.push({
            id: trip.ID || avail.ID + '-' + (trip.Order || 0),
            date: avail.Date || date,
            origin: trip.OriginAirport || origin,
            destination: trip.DestinationAirport || destination,
            depTime: depTime,
            arrTime: arrTime,
            duration: duration,
            flightNo: flightNo,
            airline: airlineCode,
            program: cfg.label,
            programKey: key,
            source: avail.Source || cfg.source,
            segments: segmentDetails,
            stops: stops,
            availability: { business: hasJ, first: hasF },
            prices: {
              business: hasJ ? (flightPrice.business || (routePrice ? routePrice.business : null)) : null,
              first: hasF ? (flightPrice.first || (routePrice ? routePrice.first : null)) : null
            },
            direct: isDirect,
            remainingSeats: trip.RemainingSeats || Math.max(avail.JRemainingSeats || 0, avail.FRemainingSeats || 0) || 1,
            _mileage: { business: mileageCost || null, first: avail.FMileageCost || null }
          });
        }
      }
    }

    // Deduplicate: per program, keep one entry per flightNo + depTime + date
    const seen = new Set();
    const uniqueFlights = allFlights.filter(f => {
      const key = `${f.programKey}|${f.flightNo}|${f.depTime}|${f.date}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Sort by program, then date, then departure time
    const programOrder = { qantas: 0, flying_blue: 1, virginatlantic: 2, american: 3 };
    uniqueFlights.sort((a, b) => {
      const pa = programOrder[a.programKey] ?? 99;
      const pb = programOrder[b.programKey] ?? 99;
      if (pa !== pb) return pa - pb;
      if (a.date !== b.date) return (a.date || '').localeCompare(b.date || '');
      return (a.depTime || '').localeCompare(b.depTime || '');
    });

    // Count per program
    const perProgram = {};
    for (const f of uniqueFlights) {
      perProgram[f.program] = (perProgram[f.program] || 0) + 1;
    }

    return res.json({
      flights: uniqueFlights.slice(0, 100),
      source: 'api',
      programs: Object.keys(PROGRAMS).map(k => PROGRAMS[k].label),
      perProgram,
      totalDisplayed: uniqueFlights.length
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
    return d.toISOString().substring(11, 16);
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
